ALTER TABLE sessions ADD COLUMN jev TEXT CHECK (jev IN ('on', 'off'));
