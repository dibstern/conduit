CREATE INDEX IF NOT EXISTS idx_events_message_created_identity
ON events (session_id, json_extract(data, '$.messageId'))
WHERE type = 'message.created' AND json_valid(data);

CREATE INDEX IF NOT EXISTS idx_events_run_started_identity
ON events (session_id, json_extract(metadata, '$.runId'))
WHERE type = 'run.started' AND json_valid(metadata);
