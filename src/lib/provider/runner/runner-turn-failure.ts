import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import { createEventId } from "../../persistence/events.js";
import { isRecord } from "../../utils.js";
import { providerRefsFromRuntimeData } from "../provider-runtime-refs.js";
import type {
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "./session-runner.js";

export function observeRunnerTurn(
	output: SessionOutput,
	turn:
		| {
				sessionId: string;
				runId?: string | undefined;
				messageId: string;
				terminal: boolean;
		  }
		| undefined,
): void {
	if (
		output.type !== "event" ||
		!turn ||
		output.event.sessionId !== turn.sessionId
	)
		return;
	if (output.event.type === "run.started" && output.event.runId)
		turn.runId = output.event.runId;
	if (turn.runId && output.event.runId !== turn.runId) return;
	if (
		output.event.type === "message.created" &&
		isRecord(output.event.data) &&
		output.event.data["role"] === "assistant" &&
		!turn.messageId
	)
		turn.messageId = String(output.event.data["messageId"]);
	if (
		output.event.type === "turn.completed" ||
		output.event.type === "turn.error" ||
		output.event.type === "turn.interrupted"
	)
		turn.terminal = true;
}

/** The same adapter error event, followed by interaction and busy-lease cleanup. */
export function failRunnerTurn(
	emit: (
		output: SessionOutput,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
	sinkId: string,
	turn: {
		sessionId: string;
		runId?: string | undefined;
		userMessageId?: string;
		placement?: { inputId: string; text: string };
		messageId: string;
		terminal: boolean;
	},
	failure: SessionFailure,
	driverKind = "claude",
) {
	return Effect.gen(function* () {
		if (process.env["NODE_ENV"] === "test")
			yield* Effect.sleep(
				Number(process.env["CONDUIT_TEST_RUNNER_FAILURE_DELAY_MS"] ?? 0),
			);
		yield* emit({
			type: "background-task",
			transition: { sessionId: turn.sessionId, kind: "session-ended" },
		});
		yield* emit({
			type: "cancel-interactions",
			sinkId,
			reason: failure.message,
			recoverQuestions: false,
		});
		const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
		const [run] =
			turn.runId && Option.isSome(sql)
				? yield* sql.value<{
						status: string;
					}>`SELECT status FROM provider_runs WHERE id = ${turn.runId} AND session_id = ${turn.sessionId}`
				: [];
		const terminal = run
			? !["pending", "running"].includes(run.status)
			: turn.terminal;
		if (!terminal) {
			const inputId = turn.userMessageId ?? turn.placement?.inputId;
			const pendingSteer =
				inputId && Option.isSome(sql)
					? (yield* sql.value`SELECT 1 FROM pending_inputs
					WHERE session_id = ${turn.sessionId} AND input_id = ${inputId}
					AND state IN ('steering', 'queued')
					AND NOT EXISTS (SELECT 1 FROM messages WHERE input_id = ${inputId})`)
							.length > 0
					: false;
			// An unstarted steer belongs to the inbox. Failure settlement will
			// return it to the queue; a synthetic message would consume it.
			if (turn.placement && !pendingSteer)
				yield* emit({
					type: "place-user-message",
					sinkId,
					input: { sessionId: turn.sessionId, ...turn.placement },
				});
			if (!pendingSteer || turn.runId)
				yield* emit({
					type: "event",
					sinkId,
					event: {
						eventId: createEventId(),
						type: "turn.error",
						providerId: driverKind,
						sessionId: turn.sessionId,
						...(turn.runId ? { runId: turn.runId } : {}),
						providerRefs: providerRefsFromRuntimeData("turn.error", {
							messageId: turn.messageId,
						}),
						rawSource: { kind: `${driverKind}.sdk.translator` },
						createdAt: Date.now(),
						data: {
							messageId: turn.messageId,
							error: failure.message,
							code: "provider_error",
							...(turn.userMessageId
								? { userMessageId: turn.userMessageId }
								: {}),
						},
					} satisfies ProviderRuntimeEvent,
				});
		}
		// A terminal event may have arrived just before the socket closed,
		// without its following idle event. Always release the busy lease.
		yield* emit({
			type: "event",
			sinkId,
			event: {
				eventId: createEventId(),
				type: "session.status",
				providerId: driverKind,
				sessionId: turn.sessionId,
				...(turn.runId ? { runId: turn.runId } : {}),
				providerRefs: providerRefsFromRuntimeData("session.status", {
					sessionId: turn.sessionId,
					status: "idle",
				}),
				rawSource: { kind: `${driverKind}.provider-runtime` },
				createdAt: Date.now(),
				data: { sessionId: turn.sessionId, status: "idle" },
			},
		});
	}).pipe(
		Effect.ensuring(emit({ type: "release-sink", sinkId }).pipe(Effect.ignore)),
		Effect.catch((error) =>
			Effect.logError("Failed to persist runner turn failure", error),
		),
	);
}
