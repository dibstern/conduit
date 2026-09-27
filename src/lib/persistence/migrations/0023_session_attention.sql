-- Per-session read state (ADR-0004, Scope). The projector raises
-- last_turn_end_version to the stream version of each turn end; only
-- SessionAttention writes seen_version. A root or a fork is unread while a
-- turn end is newer than what was seen; a sub-agent (a child with no fork
-- point) never is.
ALTER TABLE sessions ADD COLUMN last_turn_end_version INTEGER;
ALTER TABLE sessions ADD COLUMN seen_version INTEGER;
ALTER TABLE sessions ADD COLUMN unread INTEGER GENERATED ALWAYS AS (
	CASE
		WHEN (parent_id IS NULL OR fork_point_event IS NOT NULL OR fork_point_timestamp IS NOT NULL)
			AND last_turn_end_version > COALESCE(seen_version, -1)
		THEN 1
		ELSE 0
	END
) VIRTUAL;
