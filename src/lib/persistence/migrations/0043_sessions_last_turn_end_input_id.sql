-- The send whose turn last ended, beside last_turn_end_version, so a browser
-- can tell a late end of an earlier turn from the end of its current one.
ALTER TABLE sessions ADD COLUMN last_turn_end_input_id TEXT;
