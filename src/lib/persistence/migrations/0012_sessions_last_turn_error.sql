-- Deliberately no backfill: NULL means no failure, and a historical failure is not news.
ALTER TABLE sessions ADD COLUMN last_turn_error_at INTEGER;
