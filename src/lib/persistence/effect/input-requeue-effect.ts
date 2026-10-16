import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { canonicalEvent } from "../events.js";
import type { ClaudeEventPersistEffect } from "./claude-event-persist-effect.js";

/** A failed receipt proves the provider can no longer deliver this handoff. */
export const requeueFailedSteers = (
	sql: SqlClient.SqlClient,
	persist: ClaudeEventPersistEffect,
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
				AND (SELECT status FROM provider_command_outbox
					WHERE command_id = pending.input_id AND session_id = pending.session_id
					AND effect_type = 'send_turn' ORDER BY request_sequence DESC LIMIT 1) = 'failed'
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
