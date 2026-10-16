-- Detach legacy Forks from containment, retaining their Source as lineage.
-- Side Threads keep containment and gain the same lineage. The Effect entry
-- stamps these rows and rerooted descendants, then refreshes affected families.
UPDATE sessions SET
	forked_from = parent_id,
	parent_id = CASE WHEN side_thread = 0 THEN NULL ELSE parent_id END
WHERE parent_id IS NOT NULL AND forked_from IS NULL
	AND (side_thread = 1 OR (side_thread = 0 AND (
		fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL
		OR EXISTS (SELECT 1 FROM events
			WHERE session_id = sessions.id AND type = 'session.forked')
	)))
RETURNING id, side_thread;
