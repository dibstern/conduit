CREATE INDEX IF NOT EXISTS idx_message_parts_result_event_seq
ON message_parts (result_event_seq)
WHERE result_event_seq IS NOT NULL;
