-- When the session was last looked at. The first read-model column that is not
-- derived from the event log: viewing a session does not change the session, so
-- ADR-0004 (which governs session mutations) does not reach it, and appending a
-- session_viewed event would write to the log on the highest-frequency user
-- action in the app for an entry no projector would ever replay.
--
-- The badge reads it: a session whose last message arrived after the last look
-- has something the user has not seen. NULL means never looked at.
--
-- Written ONLY through the commit-and-signal seam's `stamp`, which takes the
-- same read-model counter value a projection would and stamps `version` in the
-- same statement. A write that moved this column without moving `version` would
-- be invisible to every subscriber and would fail silently — see ni8.23 C2.
ALTER TABLE sessions ADD COLUMN last_viewed_at INTEGER;

-- Existing rows are treated as already seen. The alternative — NULL everywhere —
-- would light up a badge on every session in the sidebar the first time the user
-- loads the app after upgrading, for activity they have already read.
UPDATE sessions SET last_viewed_at = last_message_at;
