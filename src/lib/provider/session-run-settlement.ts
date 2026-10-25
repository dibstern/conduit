import { Effect, Schema } from "effect";
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
		readonly excludeRetainedSteers?: boolean;
		readonly owners?: readonly RunSettlementOwner[];
	} = {},
) =>
	Effect.gen(function* () {
		const [row] = yield* sql<{ owners: string; retained: number | null }>`
	WITH candidates AS (
		SELECT run.id, (${options.excludeRetainedSteers ? 1 : 0} = 1
			AND run.status = 'pending'
			AND EXISTS (SELECT 1 FROM provider_command_outbox command JOIN pending_inputs pending
				ON pending.session_id = command.session_id AND pending.input_id = command.command_id
				WHERE command.run_id = run.id AND command.session_id = run.session_id
					AND command.effect_type = 'send_turn' AND command.status = 'running' AND pending.state = 'steering')
			AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id = run.session_id AND run_id = run.id)
			AND NOT EXISTS (SELECT 1 FROM provider_command_outbox command JOIN provider_runs owner
				ON owner.id = command.run_id AND owner.session_id = command.session_id
				WHERE command.session_id = run.session_id AND command.effect_type = 'send_turn'
					AND command.status = 'running' AND command.error_code = 'delivery_indeterminate'
					AND owner.status IN ('pending', 'running'))) AS retained
		FROM provider_runs run
		WHERE run.session_id = ${sessionId} AND run.status IN ('pending', 'running')
		AND ${
			options.owners
				? sql`run.id IN ${sql.in(options.owners.map(({ runId }) => runId))}`
				: sql`(run.status = 'running' OR NOT EXISTS (SELECT 1 FROM provider_command_outbox
				WHERE session_id = run.session_id AND effect_type = 'send_turn' AND run_id = run.id)
				OR (${options.confirmedStop ? 1 : 0} = 1 AND EXISTS (SELECT 1 FROM provider_command_outbox
				WHERE session_id = run.session_id AND effect_type = 'send_turn' AND run_id = run.id AND status = 'running')))`
		}
		ORDER BY run.id
	)
	SELECT json_group_array(json_object('runId', id)) FILTER (WHERE NOT retained) AS owners,
		MAX(retained) AS retained FROM candidates`;
		return {
			owners: Schema.decodeSync(
				Schema.fromJsonString(
					Schema.Array(Schema.Struct({ runId: Schema.String })),
				),
			)(row?.owners ?? "[]"),
			retainedSteers: row?.retained === 1,
		};
	});

/** Recover a predecessor Stop's cohort without altering its committed payload. */
export const legacyStopOwnersQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
) => sql<{ runId: string }>`
	SELECT DISTINCT owner.id AS runId FROM provider_command_outbox control
	JOIN provider_command_outbox command ON command.session_id = control.session_id
		AND command.provider_id = control.provider_id AND command.effect_type = 'send_turn'
		AND command.request_sequence < control.request_sequence
	JOIN provider_runs requested ON requested.id = command.run_id AND requested.session_id = command.session_id
	JOIN provider_runs owner ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = command.session_id
	LEFT JOIN turns turn ON turn.run_id = owner.id AND turn.session_id = command.session_id
	LEFT JOIN messages message ON message.id = turn.user_message_id AND message.session_id = turn.session_id
	WHERE control.command_id = ${commandId} AND control.session_id = ${sessionId}
		AND (control.effect_type = 'end_session' OR
			COALESCE(json_extract(command.payload_json, '$.continuation.cutOffMessageId'), json_extract(command.payload_json, '$.inputId'), command.command_id)
				IN (SELECT value FROM json_each(control.payload_json, '$.turnIds'))
			OR COALESCE(message.input_id, turn.user_message_id)
				IN (SELECT value FROM json_each(control.payload_json, '$.turnIds')))`;

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
		const { owners: runs } = yield* sessionRunOwnersQuery(
			sql,
			sessionId,
			options,
		);
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
				? runs.filter(({ runId }) => !known.has(runId))
				: options.errorCode && options.owners === undefined
					? [{ runId: undefined }]
					: []
			).map(({ runId }) => {
				return options.errorCode
					? event(
							"turn.error",
							{
								messageId: "",
								error: reason,
								code: options.errorCode,
								retryable: false,
							},
							runId,
						)
					: event("turn.interrupted", { messageId: "", reason }, runId);
			}),
			// A cohort confirmation cannot idle work admitted after that cohort.
			...(options.owners ?? [{ runId: undefined }]).map(({ runId }) =>
				event("session.status", { sessionId, status: "idle" }, runId),
			),
		]);
	});
}
