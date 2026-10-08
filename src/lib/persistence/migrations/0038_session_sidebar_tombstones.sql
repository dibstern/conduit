-- Sidebar tombstones (conduit-test-y7eo.3): a family that leaves the sidebar
-- keeps its row, with no content, at the version it left, so a reconnecting
-- device catches up on removals instead of re-reading the whole list. The row
-- no longer goes with its session's delete: the projector writes the
-- tombstone, which needs the row still there.
CREATE TABLE session_sidebar_next (
	session_id TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	last_activity INTEGER NOT NULL,
	row TEXT
);

INSERT INTO session_sidebar_next (session_id, version, last_activity, row)
SELECT session_id, version, last_activity, row FROM session_sidebar;

DROP TABLE session_sidebar;

ALTER TABLE session_sidebar_next RENAME TO session_sidebar;

CREATE INDEX idx_session_sidebar_version ON session_sidebar(version);
