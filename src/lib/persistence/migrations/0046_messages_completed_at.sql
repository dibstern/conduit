-- Existing rows stay null; history falls back to updated_at as on main; a projection rebuild fills completed_at.
ALTER TABLE messages ADD COLUMN completed_at INTEGER;
