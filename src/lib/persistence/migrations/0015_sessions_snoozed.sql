ALTER TABLE sessions ADD COLUMN snoozed_at INTEGER;
ALTER TABLE sessions ADD COLUMN snoozed_until INTEGER;
ALTER TABLE sessions ADD COLUMN woken_at INTEGER;
ALTER TABLE sessions ADD COLUMN woken_reason TEXT;
