-- Expanding a cut-short tool output looks the part up by its call id, which
-- for OpenCode tools differs from the part id. Partial on call_id rather than
-- type = 'tool', so queries over all tool parts never mistake it for theirs.
CREATE INDEX IF NOT EXISTS idx_message_parts_tool_call
	ON message_parts (call_id)
	WHERE call_id IS NOT NULL;
