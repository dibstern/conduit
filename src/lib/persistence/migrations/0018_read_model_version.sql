-- Subscription rows are sessions and messages. Message parts are nested in a
-- message, so future part writes must advance the owning message's version.
ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Seed a conservative per-session watermark from retained events, bounded by
-- the relevant projector cursor so unprojected events cannot advance a row.
-- This can over-report changes to individual rows in the same session. It is
-- not an exact historical last-write sequence. Message replay markers survive
-- event eviction and are preserved when they exceed the retained watermark.
-- The event log is bounded by 7-day eviction. Without retained evidence a
-- session starts at zero and a message uses its replay marker or zero. This
-- cannot recover evicted changes, deleted rows, or cross-session propagation.
-- Existing read-model content and monotonic projector cursors stay intact.
-- No event replay, cursor reset, or rebuild-from-zero is performed.
UPDATE sessions
SET version = COALESCE((
	SELECT MAX(events.sequence) FROM events
	WHERE events.session_id = sessions.id
		AND events.sequence <= (
			SELECT last_applied_seq FROM projector_cursors WHERE projector_name = 'session'
		)
), 0);

UPDATE messages
SET version = MAX(COALESCE(last_applied_seq, 0), COALESCE((
	SELECT MAX(events.sequence) FROM events
	WHERE events.session_id = messages.session_id
		AND events.sequence <= (
			SELECT last_applied_seq FROM projector_cursors WHERE projector_name = 'message'
		)
), 0));

CREATE INDEX idx_sessions_version ON sessions (version);
CREATE INDEX idx_messages_version ON messages (session_id, version);
