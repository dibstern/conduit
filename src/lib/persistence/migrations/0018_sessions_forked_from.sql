ALTER TABLE sessions ADD COLUMN forked_from TEXT;

UPDATE sessions
SET forked_from = parent_id, parent_id = NULL
WHERE fork_point_event IS NOT NULL AND parent_id IS NOT NULL;
