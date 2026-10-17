CREATE TABLE IF NOT EXISTS surfacing_marks (
	part_id TEXT NOT NULL,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	message_id TEXT NOT NULL,
	level TEXT NOT NULL CHECK(level IN ('hidden', 'all', 'balanced', 'key')),
	category TEXT,
	reason TEXT,
	direction TEXT CHECK(direction IN ('raise', 'lower', 'retype')),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (session_id, part_id)
);
