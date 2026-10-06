-- A user message that closed another open turn when it was placed: a steer the
-- provider read mid-turn. Drives the transcript's "Steered" label.
ALTER TABLE messages ADD COLUMN steered INTEGER NOT NULL DEFAULT 0;
