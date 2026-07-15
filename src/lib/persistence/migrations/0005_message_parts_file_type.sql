CREATE TABLE message_parts_new (
	id          TEXT    PRIMARY KEY,
	message_id  TEXT    NOT NULL,
	type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool', 'file')),
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

-- Orphan parts (message_id with no messages row — FK-outage era leftovers)
-- are unreadable through every query path, which joins via messages. They
-- would violate the rebuilt table's FK, so the copy drops them.
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
