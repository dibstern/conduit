import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { type CanonicalEvent, canonicalEvent } from "../events.js";

/** Requeue unplaced handoffs after failure or confirmed loss of a removed runner. */
export const requeueFailedSteers = <E>(
	sql: SqlClient.SqlClient,
	persist: {
		readonly persistEvents: (
			events: readonly CanonicalEvent[],
		) => Effect.Effect<void, E>;
	},
	sessionId?: string,
	inputId?: string,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			session_id: string;
			input_id: string;
			sent_sequence: number;
			error_code: string | null;
		}>`
			SELECT pending.session_id, pending.input_id,
				(SELECT MAX(sequence) FROM events WHERE session_id = pending.session_id
					AND type = 'input.sent' AND json_extract(data, '$.inputId') = pending.input_id) AS sent_sequence,
				(SELECT error_code FROM provider_command_outbox
					WHERE command_id = pending.input_id AND session_id = pending.session_id
					AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1) AS error_code
			FROM pending_inputs pending
			WHERE pending.state = 'steering'
				AND (${sessionId ?? null} IS NULL OR pending.session_id = ${sessionId ?? null})
				AND (${inputId ?? null} IS NULL OR pending.input_id = ${inputId ?? null})
				AND NOT EXISTS (SELECT 1 FROM messages WHERE input_id = pending.input_id)
				AND (SELECT command.status = 'failed' OR (
						command.status = 'cancelled' AND command.error_code = 'project_inactive'
						AND EXISTS (SELECT 1 FROM provider_runs run
							WHERE run.id = command.run_id AND run.session_id = command.session_id AND run.status = 'error'))
					FROM provider_command_outbox command
					WHERE command.command_id = pending.input_id AND command.session_id = pending.session_id
					AND command.effect_type = 'send_turn' ORDER BY command.request_sequence DESC LIMIT 1)
			ORDER BY pending.admitted_at DESC, pending.rowid DESC`;
		if (rows.length === 0) return;
		yield* persist.persistEvents(
			rows.map((row) =>
				canonicalEvent("input.requeued", row.session_id, {
					sessionId: row.session_id,
					inputId: row.input_id,
					sentSequence: row.sent_sequence,
					reason: row.error_code === "steer-declined" ? "declined" : "failed",
				}),
			),
		);
	});
