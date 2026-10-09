-- The sidebar read model (conduit-test-y7eo.2): each session's top-level
-- parent, and one row per top-level session holding what the sidebar shows
-- for its family. Rows are filled by the migration's backfill and kept by the
-- projectors; the version only moves when what the sidebar shows changes.
ALTER TABLE sessions ADD COLUMN root_id TEXT;

WITH RECURSIVE family(id, root_id) AS (
	SELECT id, id FROM sessions WHERE parent_id IS NULL
	UNION
	SELECT child.id, family.root_id FROM sessions child
	JOIN family ON child.parent_id = family.id
)
UPDATE sessions SET root_id = family.root_id FROM family
WHERE family.id = sessions.id;

CREATE INDEX idx_sessions_root ON sessions(root_id);

CREATE TABLE session_sidebar (
	session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
	version INTEGER NOT NULL,
	last_activity INTEGER NOT NULL,
	row TEXT NOT NULL
);

CREATE INDEX idx_session_sidebar_version ON session_sidebar(version);
