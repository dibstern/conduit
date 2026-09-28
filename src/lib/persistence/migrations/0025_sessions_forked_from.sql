-- A local build briefly marked forks with sessions.forked_from and a NULL
-- parent_id (conduit-test-l4ek). Fold those rows back into the fork model the
-- rest of the store uses: parent_id plus a fork point. An origin that no longer
-- exists stays NULL, because parent_id is a foreign key, so the fork becomes a root.
UPDATE sessions SET parent_id = forked_from
WHERE forked_from IS NOT NULL
	AND parent_id IS NULL
	AND EXISTS (SELECT 1 FROM sessions origin WHERE origin.id = sessions.forked_from);

-- Recover the boundary exactly as 0021_fork_point_timestamp did for rows that
-- already carried parent_id then.
UPDATE sessions SET fork_point_timestamp = (
	SELECT created_at FROM messages
	WHERE messages.session_id = sessions.parent_id
		AND messages.id = sessions.fork_point_event
) WHERE forked_from IS NOT NULL
	AND fork_point_event IS NOT NULL
	AND fork_point_timestamp IS NULL;
UPDATE sessions SET fork_point_message_id = fork_point_event
WHERE forked_from IS NOT NULL
	AND fork_point_timestamp IS NOT NULL
	AND fork_point_message_id IS NULL;

-- Restamp only when a row moved, so a store without forks keeps its versions.
UPDATE read_model_counter SET value = value + 1
WHERE id = 1
	AND EXISTS (SELECT 1 FROM sessions WHERE forked_from IS NOT NULL);
UPDATE sessions SET version = (SELECT value FROM read_model_counter WHERE id = 1)
WHERE forked_from IS NOT NULL;

ALTER TABLE sessions DROP COLUMN forked_from;
