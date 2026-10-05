-- Relay startup restores open Claude questions and each session's latest
-- effort and context window. Without these indexes both reads walk the
-- store's largest rows (tool output, prompt payloads with images).
CREATE INDEX IF NOT EXISTS idx_message_parts_open_questions
	ON message_parts (message_id)
	WHERE type = 'tool'
		AND tool_name = 'AskUserQuestion'
		AND status IN ('started', 'running', 'pending');

CREATE INDEX IF NOT EXISTS idx_provider_command_outbox_turn_settings
	ON provider_command_outbox (
		request_sequence,
		json_extract(payload_json, '$.variant'),
		json_extract(payload_json, '$.contextWindow')
	)
	-- json_extract throws on malformed JSON, which would fail the insert (or
	-- this migration) instead of leaving the row for the reactor to reject.
	WHERE effect_type = 'send_turn' AND json_valid(payload_json);
