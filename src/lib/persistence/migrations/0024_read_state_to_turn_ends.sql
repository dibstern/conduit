-- Move read state from main's timestamps (read_at, marked_unread_at) to turn-end
-- positions (conduit-test-hk9m.7, ADR-0004).
--
-- 1. Backfill last_turn_end_version exactly as the projector would have: the
--    highest stream_version of a turn.completed or turn.error (not
--    turn.interrupted), never lowering a value already projected.
UPDATE sessions SET last_turn_end_version = ends.version
FROM (
	SELECT session_id, MAX(stream_version) AS version
	FROM events
	WHERE type IN ('turn.completed', 'turn.error')
	GROUP BY session_id
) AS ends
WHERE sessions.id = ends.session_id
	AND ends.version > COALESCE(sessions.last_turn_end_version, -1);

-- 2. Seed seen_version from what main showed. Main's rule: unread when marked
--    unread, or when there is a message not yet read (read_at NULL or before it).
--    Read: seen up to the last turn end. Unread: one before it, where a session
--    with no turn end sits at a virtual turn end of -1. A seen_version already
--    written by SessionAttention is kept.
UPDATE sessions SET seen_version = CASE
	WHEN marked_unread_at IS NULL
		AND (last_message_at IS NULL OR read_at >= last_message_at)
	THEN last_turn_end_version
	ELSE COALESCE(last_turn_end_version, -1) - 1
END
WHERE seen_version IS NULL;

-- 3. The virtual turn end of -1 lets a session with no turn end be marked
--    unread (seen_version -2) and seen again (-1).
ALTER TABLE sessions DROP COLUMN unread;
ALTER TABLE sessions ADD COLUMN unread INTEGER GENERATED ALWAYS AS (
	CASE
		WHEN (parent_id IS NULL OR fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL)
			AND COALESCE(last_turn_end_version, -1) > COALESCE(seen_version, -1)
		THEN 1
		ELSE 0
	END
) VIRTUAL;

-- 4. Nothing reads the timestamps any more.
ALTER TABLE sessions DROP COLUMN read_at;
ALTER TABLE sessions DROP COLUMN marked_unread_at;
