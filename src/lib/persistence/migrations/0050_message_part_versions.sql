-- Each message part carries the read-model version it last moved at
-- (conduit-test-y7eo.8), so a live update sends the part that changed instead
-- of the whole message. Existing parts take their message's version; a part
-- whose message is gone keeps 0 rather than failing NOT NULL. A removed part
-- leaves a tombstone so a resume can report it.
ALTER TABLE message_parts ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

UPDATE message_parts SET version = COALESCE((
	SELECT messages.version FROM messages WHERE messages.id = message_parts.message_id
), 0);

CREATE INDEX idx_message_parts_version ON message_parts(version);

CREATE TABLE message_part_tombstones (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	message_id TEXT NOT NULL,
	part_id TEXT NOT NULL PRIMARY KEY,
	version INTEGER NOT NULL
);

CREATE INDEX idx_message_part_tombstones_session_version
	ON message_part_tombstones (session_id, version);
