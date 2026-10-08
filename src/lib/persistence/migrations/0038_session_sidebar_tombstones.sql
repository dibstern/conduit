-- Sidebar tombstones (conduit-test-y7eo.3): a family that leaves the sidebar
-- keeps its row, with no content, at the version it left, so a reconnecting
-- device catches up on removals instead of re-reading the whole list. The row
-- no longer goes with its session's delete: the projector writes the
-- tombstone, which needs the row still there.
--
-- A deleted session, child included, leaves one too, so a device away while
-- it went is told. Whether a tombstone's session is gone is read from
-- `sessions`, not stored, so it stays true when the session is re-created.
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

-- Removals before this point left nothing behind, so a device whose cursor is
-- older cannot be caught up and is sent the whole list instead.
CREATE TABLE session_sidebar_horizon (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	version INTEGER NOT NULL
);

INSERT INTO session_sidebar_horizon (id, version)
SELECT 1, COALESCE((SELECT value FROM read_model_counter WHERE id = 1), 0);
