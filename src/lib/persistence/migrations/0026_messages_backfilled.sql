-- OpenCode REST snapshots replace settled message state through the event log.
-- is_backfilled records only whether the first message row came from REST.
ALTER TABLE messages ADD COLUMN is_backfilled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN rest_digest TEXT;
ALTER TABLE messages ADD COLUMN rest_event_id TEXT;
ALTER TABLE messages ADD COLUMN rest_payload TEXT;
ALTER TABLE messages ADD COLUMN parent_id TEXT;
ALTER TABLE messages ADD COLUMN finish TEXT;
ALTER TABLE messages ADD COLUMN error TEXT;

-- Snapshot parts keep their provider type and full payload. Earlier schemas
-- allowed only the five part kinds translated from SSE.
CREATE TABLE message_parts_snapshot (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	type TEXT NOT NULL,
	text TEXT NOT NULL DEFAULT '',
	tool_name TEXT,
	call_id TEXT,
	input TEXT,
	result TEXT,
	duration REAL,
	status TEXT,
	sort_order INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	metadata TEXT,
	rest_payload TEXT,
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
INSERT INTO message_parts_snapshot
	(id, message_id, type, text, tool_name, call_id, input, result,
	 duration, status, sort_order, created_at, updated_at, metadata)
SELECT id, message_id, type, text, tool_name, call_id, input, result,
	 duration, status, sort_order, created_at, updated_at, metadata
FROM message_parts;
DROP TABLE message_parts;
ALTER TABLE message_parts_snapshot RENAME TO message_parts;
CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order);
