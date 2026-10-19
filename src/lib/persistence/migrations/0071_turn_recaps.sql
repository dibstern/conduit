CREATE TABLE IF NOT EXISTS turn_recaps (
	turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	version INTEGER NOT NULL CHECK (version > 0),
	scope TEXT NOT NULL CHECK (scope IN ('whole', 'new')),
	first_ordinal INTEGER NOT NULL CHECK (first_ordinal > 0),
	last_ordinal INTEGER NOT NULL CHECK (last_ordinal >= first_ordinal),
	text TEXT NOT NULL,
	model TEXT NOT NULL,
	duration_ms INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (turn_id, version)
);
CREATE INDEX IF NOT EXISTS idx_turn_recaps_session ON turn_recaps(session_id);
