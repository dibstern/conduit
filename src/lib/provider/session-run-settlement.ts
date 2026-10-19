import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import { createEventId } from "../persistence/events.js";
import { isRecord } from "../utils.js";

export interface RunSettlementOwner {
	readonly runId: string;
	readonly userMessageId?: string;
}

/** Only call after the provider confirms that this session cannot still run.
 * Guard publication against a changed session or process generation when the
 * confirmation came from an asynchronous probe. Never infer ownership by age.
 */
export function settleSessionRuns<A, E, R>(
	sql: SqlClient.SqlClient,
	sessionId: string,
	reason: string,
	publish: (events: readonly ProviderRuntimeEvent[]) => Effect.Effect<A, E, R>,
	options: {
		readonly errorCode?: string;
		readonly knownEnds?: readonly ProviderRuntimeEvent[];
		/** Exact failed command cohort; absent for a confirmed session-wide end. */
		readonly owners?: readonly RunSettlementOwner[];
	} = {},
) {
	return Effect.gen(function* () {
		const runs = yield* sql<{ id: string }>`SELECT run.id FROM provider_runs run
			WHERE run.session_id = ${sessionId} AND run.status IN ('pending', 'running')
			AND ${
				options.owners
					? sql`run.id IN ${sql.in(options.owners.map(({ runId }) => runId))}`
					: sql`(
				run.status = 'running' OR NOT EXISTS (SELECT 1 FROM provider_command_outbox
					WHERE session_id = run.session_id AND effect_type = 'send_turn'
					AND json_extract(payload_json, '$.runId') = run.id))`
			}
			ORDER BY run.id`;
		const event = (
			type: "turn.interrupted" | "turn.error" | "session.status",
			data: Record<string, unknown>,
			runId?: string,
		): ProviderRuntimeEvent => ({
			eventId: createEventId(),
			type,
			providerId: "conduit",
			sessionId,
			...(runId ? { runId } : {}),
			providerRefs: {},
			rawSource: { kind: "conduit.session-run-settlement" },
			createdAt: Date.now(),
			data,
		});
		const known = new Set(
			options.knownEnds
				?.filter(
					(event) =>
						event.type === "turn.completed" ||
						event.type === "turn.error" ||
						event.type === "turn.interrupted" ||
						(event.type === "session.status" &&
							isRecord(event.data) &&
							event.data["status"] === "idle"),
				)
				.map((event) => event.runId),
		);
		return yield* publish([
			...(options.knownEnds ?? []),
			...(runs.length
				? runs.filter(({ id }) => !known.has(id))
				: options.errorCode && options.owners === undefined
					? [{ id: undefined }]
					: []
			).map(({ id }) => {
				const userMessageId = options.owners?.find(
					({ runId }) => runId === id,
				)?.userMessageId;
				const input = userMessageId ? { userMessageId } : {};
				return options.errorCode
					? event(
							"turn.error",
							{
								messageId: "",
								error: reason,
								code: options.errorCode,
								...input,
							},
							id,
						)
					: event("turn.interrupted", { messageId: "", reason, ...input }, id);
			}),
			event("session.status", { sessionId, status: "idle" }),
		]);
	});
}
