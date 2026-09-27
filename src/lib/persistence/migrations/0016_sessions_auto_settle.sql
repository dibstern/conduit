ALTER TABLE sessions ADD COLUMN unsettled_at INTEGER;
ALTER TABLE sessions ADD COLUMN auto_settle_disabled_at INTEGER;
ALTER TABLE sessions ADD COLUMN settled_automatically INTEGER NOT NULL DEFAULT 0;
