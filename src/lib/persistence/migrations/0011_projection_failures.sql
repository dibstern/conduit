CREATE TABLE projection_failures (
	id               INTEGER PRIMARY KEY AUTOINCREMENT,
	projector_name   TEXT    NOT NULL,
	event_sequence   INTEGER NOT NULL,
	event_type       TEXT    NOT NULL,
	session_id       TEXT    NOT NULL,
	error            TEXT    NOT NULL,
	failed_at        INTEGER NOT NULL
);
