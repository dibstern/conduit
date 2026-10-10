import { Effect } from "effect";
import { isRecord } from "../../utils.js";
import { claudeTurnErrorEvent } from "./claude-event-translator.js";
import { claudeRuntimeEvent } from "./claude-runtime-event.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
} from "./claude-session-runner.js";

export function observeClaudeRunnerTurn(
	output: ClaudeSessionOutput,
	turn: { sessionId: string; messageId: string; terminal: boolean } | undefined,
): void {
	if (
		output.type !== "event" ||
		!turn ||
		output.event.sessionId !== turn.sessionId
	)
		return;
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
export function failClaudeRunnerTurn(
	emit: (
		output: ClaudeSessionOutput,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
	sinkId: string,
	turn: {
		sessionId: string;
		userMessageId?: string;
		placement?: { inputId: string; text: string };
		messageId: string;
		terminal: boolean;
	},
	failure: ClaudeSessionFailure,
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
		if (!turn.terminal) {
			// A held send the SDK never started has no message yet, and an error
			// naming it would end no turn. Placing is a no-op once it is placed.
			if (turn.placement)
				yield* emit({
					type: "place-user-message",
					sinkId,
					input: { sessionId: turn.sessionId, ...turn.placement },
				});
			yield* emit({
				type: "event",
				sinkId,
				event: claudeTurnErrorEvent(
					turn.sessionId,
					turn.messageId,
					new Error(failure.message),
					turn.userMessageId,
				),
			});
		}
		// A terminal event may have arrived just before the socket closed,
		// without its following idle event. Always release the busy lease.
		yield* emit({
			type: "event",
			sinkId,
			event: claudeRuntimeEvent("session.status", turn.sessionId, {
				sessionId: turn.sessionId,
				status: "idle",
			}),
		});
	}).pipe(
		Effect.ensuring(emit({ type: "release-sink", sinkId }).pipe(Effect.ignore)),
		Effect.catchAll((error) =>
			Effect.logError("Failed to persist Claude runner turn failure", error),
		),
	);
}
