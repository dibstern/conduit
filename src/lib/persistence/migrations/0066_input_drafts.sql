-- Composer drafts are mutable side-table state, outside the event log.
-- No foreign key: draft keys also reserve standalone drafts for later use.
CREATE TABLE input_drafts (
	draft_key TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('session', 'draft')),
	text TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	promoted_session_id TEXT
);

CREATE INDEX idx_input_drafts_project ON input_drafts(project_id);
