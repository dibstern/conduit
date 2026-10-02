ALTER TABLE sessions ADD COLUMN goal_state TEXT;

CREATE TABLE IF NOT EXISTS session_goal_checks (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    condition TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    iterations INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_goal_checks_session_created
    ON session_goal_checks(session_id, created_at);
