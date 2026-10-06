ALTER TABLE sessions ADD COLUMN side_thread INTEGER NOT NULL DEFAULT 0 CHECK (side_thread IN (0, 1));
