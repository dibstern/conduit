ALTER TABLE sessions ADD COLUMN fork_point_timestamp INTEGER;
ALTER TABLE sessions ADD COLUMN fork_point_message_id TEXT;

-- One-time recovery for existing lineage. Missing parent messages remain NULL.
UPDATE sessions SET fork_point_timestamp = (
    SELECT created_at FROM messages
    WHERE messages.session_id = sessions.parent_id
      AND messages.id = sessions.fork_point_event
) WHERE fork_point_event IS NOT NULL;
UPDATE sessions SET fork_point_message_id = fork_point_event
WHERE fork_point_timestamp IS NOT NULL;

UPDATE read_model_counter SET value = value + 1 WHERE id = 1;
UPDATE sessions SET version = (SELECT value FROM read_model_counter WHERE id = 1)
WHERE fork_point_timestamp IS NOT NULL;
