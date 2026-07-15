CREATE TABLE events_new (
	sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
	event_id        TEXT    NOT NULL UNIQUE,
	session_id      TEXT    NOT NULL,
	stream_version  INTEGER NOT NULL,
	type            TEXT    NOT NULL,
	data            TEXT    NOT NULL,
	metadata        TEXT    NOT NULL DEFAULT '{}',
	provider        TEXT    NOT NULL,
	created_at      INTEGER NOT NULL
);

INSERT INTO events_new (
	sequence, event_id, session_id, stream_version, type,
	data, metadata, provider, created_at
)
SELECT
	sequence, event_id, session_id, stream_version, type,
	data, metadata, provider, created_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE UNIQUE INDEX idx_events_session_version ON events (session_id, stream_version);
CREATE INDEX idx_events_session_seq ON events (session_id, sequence);
CREATE INDEX idx_events_type ON events (type);
