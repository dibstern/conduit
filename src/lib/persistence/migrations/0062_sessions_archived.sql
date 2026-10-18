ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
ALTER TABLE sessions ADD COLUMN archived_automatically INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN unarchived_at INTEGER;
