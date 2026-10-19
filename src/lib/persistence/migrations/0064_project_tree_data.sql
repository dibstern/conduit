ALTER TABLE sessions ADD COLUMN last_user_message_at INTEGER;
ALTER TABLE messages ADD COLUMN is_human_sent INTEGER NOT NULL DEFAULT 0;

-- Legacy fork copies retained input_id without is_inherited. Resolve their
-- inclusive boundary once, including Claude's suffixed copied message ids.
UPDATE messages AS m SET is_inherited = 1 WHERE EXISTS (
	SELECT 1 FROM sessions s WHERE s.id = m.session_id AND s.fork_point_timestamp IS NOT NULL
	AND (m.created_at, m.id) <= (s.fork_point_timestamp, COALESCE(
		(SELECT boundary.id FROM messages boundary WHERE boundary.session_id = s.id
			AND boundary.id = COALESCE(s.fork_point_message_id, s.fork_point_event) || '_' || s.id),
		s.fork_point_message_id, s.fork_point_event, '')));

-- Retain header-only synthetic provenance for subsequent streamed parts.
UPDATE messages AS m
SET rest_payload = json_set(COALESCE(m.rest_payload, '{}'), '$.isSynthetic', json('true'))
WHERE (m.session_id, m.id) IN (
	SELECT e.session_id, json_extract(e.data, '$.messageId') FROM events e
	WHERE e.type = 'message.created'
	AND json_extract(e.metadata, '$.synthetic') = 1);

-- Match isHumanSentMessage: delivered inputs, ordinary text/file parts, or
-- legacy text without parts; exclude provider-generated and inherited context.
UPDATE messages SET is_human_sent = (
	messages.role = 'user' AND messages.is_inherited = 0 AND (
		messages.input_id IS NOT NULL OR (
			COALESCE(json_extract(messages.rest_payload, '$.isSynthetic'), 0) = 0
			AND COALESCE(json_extract(messages.rest_payload, '$.isCompactSummary'), 0) = 0
			AND (
				(messages.text <> '' AND messages.rest_payload IS NULL
					AND NOT EXISTS (SELECT 1 FROM message_parts WHERE message_id = messages.id))
				OR EXISTS (SELECT 1 FROM (
					SELECT type, metadata, rest_payload FROM message_parts WHERE message_id = messages.id
					UNION ALL SELECT json_extract(value, '$.type'), NULL, value
						FROM json_each(messages.rest_payload, '$.parts')
				) p WHERE p.type IN ('text', 'file')
					AND COALESCE(json_extract(p.metadata, '$.synthetic'), 0) = 0
					AND COALESCE(json_extract(p.rest_payload, '$.synthetic'), 0) = 0
					AND COALESCE(json_extract(p.rest_payload, '$.ignored'), 0) = 0)
			)
		)
	)
);

UPDATE sessions SET last_user_message_at = (
	SELECT MAX(messages.created_at) FROM messages
	WHERE messages.session_id = sessions.id AND messages.is_human_sent = 1
		AND messages.role = 'user' AND messages.is_inherited = 0
);
