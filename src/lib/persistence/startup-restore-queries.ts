// Relay startup runs these reads synchronously before the first session can
// open. They live here as text so tests can check their query plans.

/** Claude AskUserQuestion tools still waiting for an answer. */
export const pendingClaudeQuestionToolsQuery = `
	SELECT mp.id, mp.call_id, mp.message_id, mp.input, mp.created_at, m.session_id
	-- CROSS JOIN pins the join order: start from the few open questions in
	-- idx_message_parts_open_questions, never from every Claude message's parts.
	FROM message_parts mp
	CROSS JOIN messages m ON m.id = mp.message_id
	CROSS JOIN sessions s ON s.id = m.session_id
	WHERE s.provider = 'claude'
		AND mp.type = 'tool'
		AND mp.tool_name = 'AskUserQuestion'
		AND mp.status IN ('started', 'running', 'pending')
		-- A later user message means the conversation moved on (e.g. after a
		-- crash), so the question is abandoned rather than still pending.
		AND NOT EXISTS (
			SELECT 1 FROM messages later
			WHERE later.session_id = m.session_id
				AND later.role = 'user'
				AND later.created_at > m.created_at
		)`;

/** Each session's effort and context window from its latest sent turn. */
export const latestTurnSettingsQuery = `
	SELECT latest.session_id,
		json_extract(outbox.payload_json, '$.variant') AS variant,
		json_extract(outbox.payload_json, '$.contextWindow') AS context_window
	FROM (
		SELECT session_id, MAX(side_effect_sequence) AS request_sequence
		FROM command_receipts
		WHERE command_type = 'send_turn' AND side_effect_sequence IS NOT NULL
		GROUP BY session_id
	) latest
	-- The index holds both settings, so multi-MB payloads (images) stay unread.
	JOIN provider_command_outbox outbox
		INDEXED BY idx_provider_command_outbox_turn_settings
		ON outbox.request_sequence = latest.request_sequence
	WHERE outbox.effect_type = 'send_turn' AND json_valid(outbox.payload_json)`;
