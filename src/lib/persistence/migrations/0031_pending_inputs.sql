-- Admitted inputs that have not started, projected from input.admitted and
-- input.sent. A started, sent-on-idle or cancelled input keeps its row as a
-- 'removed' tombstone, so catch-up can report it and a retried submit with the
-- same input id stays a no-op.
CREATE TABLE pending_inputs (
	input_id TEXT NOT NULL PRIMARY KEY,
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	text TEXT NOT NULL,
	images TEXT,
	request TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('queued', 'steering', 'removed')),
	admitted_at INTEGER NOT NULL,
	version INTEGER NOT NULL
);
CREATE INDEX idx_pending_inputs_session_version ON pending_inputs (session_id, version);
