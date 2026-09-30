CREATE TABLE message_tombstones (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	message_id TEXT NOT NULL PRIMARY KEY,
	version INTEGER NOT NULL
);

CREATE INDEX idx_message_tombstones_session_version
	ON message_tombstones (session_id, version);
