-- Speed up per-session event-type lookups without scanning unrelated history.
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events (session_id, type);
