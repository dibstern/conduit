CREATE TABLE IF NOT EXISTS session_pick_backfill (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    retry_reason TEXT NOT NULL DEFAULT 'pending'
        CHECK (retry_reason IN ('pending', 'driver_unresolved'))
);

CREATE TABLE IF NOT EXISTS session_pick_backfill_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    initialized INTEGER NOT NULL CHECK (initialized IN (0, 1))
);

-- Legacy events may still need projecting; startup takes the snapshot after recovery.
INSERT OR IGNORE INTO session_pick_backfill_state (singleton, initialized)
SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM sessions LIMIT 1)
    OR EXISTS (SELECT 1 FROM events LIMIT 1) THEN 0 ELSE 1 END;
