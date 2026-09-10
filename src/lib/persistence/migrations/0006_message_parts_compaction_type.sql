-- Extend message_parts.type CHECK to allow 'compaction' marker parts.
-- Compaction boundaries (Claude Agent SDK /compact) are persisted as a
-- synthetic assistant message carrying a single 'compaction' part so the
-- "Context compacted" divider survives a page reload. SQLite can't ALTER a
-- CHECK constraint, so rebuild the table like 0005 did.

CREATE TABLE message_parts_new (
	id          TEXT    PRIMARY KEY,
	message_id  TEXT    NOT NULL,
	type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool', 'file', 'compaction')),
	text        TEXT    NOT NULL DEFAULT '',
	tool_name   TEXT,
	call_id     TEXT,
	input       TEXT,
	result      TEXT,
	duration    REAL,
	status      TEXT,
	sort_order  INTEGER NOT NULL,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	metadata    TEXT,
	FOREIGN KEY (message_id) REFERENCES messages(id)
);

INSERT INTO message_parts_new (
	id, message_id, type, text, tool_name, call_id, input, result,
	duration, status, sort_order, created_at, updated_at, metadata
)
SELECT
	id, message_id, type, text, tool_name, call_id, input, result,
	duration, status, sort_order, created_at, updated_at, metadata
FROM message_parts
WHERE message_id IN (SELECT id FROM messages);

DROP TABLE message_parts;
ALTER TABLE message_parts_new RENAME TO message_parts;

CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order);
