ALTER TABLE sessions ADD COLUMN read_at INTEGER;

-- Backfill existing sessions so an upgrade does not present a fake unread backlog.
UPDATE sessions SET read_at = updated_at;
