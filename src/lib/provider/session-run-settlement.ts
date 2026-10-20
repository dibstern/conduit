import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import { runTerminalStatus } from "../persistence/effect/projectors-effect.js";
import { createEventId } from "../persistence/events.js";

export interface RunSettlementOwner {
	readonly runId: string;
}

export const sessionRunOwnersQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	options: {
		readonly confirmedStop?: boolean;
		readonly owners?: readonly RunSettlementOwner[];
	} = {},
) => sql<{ id: string }>`SELECT run.id FROM provider_runs run
	WHERE run.session_id = ${sessionId} AND run.status IN ('pending', 'running')
	AND ${
		options.owners
			? sql`run.id IN ${sql.in(options.owners.map(({ runId }) => runId))}`
			: sql`(
		run.status = 'running' OR NOT EXISTS (SELECT 1 FROM provider_command_outbox
			WHERE session_id = run.session_id AND effect_type = 'send_turn'
			AND run_id = run.id)
		OR (${options.confirmedStop ? 1 : 0} = 1 AND EXISTS (SELECT 1 FROM provider_command_outbox
			WHERE session_id = run.session_id AND effect_type = 'send_turn'
			AND run_id = run.id AND status = 'running')))`
	}
	ORDER BY run.id`;

/** Only call after the provider confirms that this session or exact cohort cannot still run.
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
		/** A stopped instance or process also ends sends claimed before intake. */
		readonly confirmedStop?: boolean;
		/** Exact failed command cohort; absent for a confirmed session-wide end. */
		readonly owners?: readonly RunSettlementOwner[];
	} = {},
) {
	return Effect.gen(function* () {
		const runs = yield* sessionRunOwnersQuery(sql, sessionId, options);
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
				?.filter((event) => runTerminalStatus(event, event.providerId))
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
				return options.errorCode
					? event(
							"turn.error",
							{
								messageId: "",
								error: reason,
								code: options.errorCode,
								retryable: false,
							},
							id,
						)
					: event("turn.interrupted", { messageId: "", reason }, id);
			}),
			// A cohort confirmation cannot idle work admitted after that cohort.
			...(options.owners ?? [{ runId: undefined }]).map(({ runId }) =>
				event("session.status", { sessionId, status: "idle" }, runId),
			),
		]);
	});
}
