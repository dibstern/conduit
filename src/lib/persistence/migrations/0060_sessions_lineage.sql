ALTER TABLE sessions ADD COLUMN forked_from TEXT REFERENCES sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_forked_from ON sessions(forked_from);
