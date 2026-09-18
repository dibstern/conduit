-- One monotone counter for the read model, independent of event sequence.
--
-- 0012 stamped rows from the sequence of the event that changed them. That
-- cannot survive replay: recovery re-applies an event whose sequence is lower
-- than the row's current version, the payload write lands, and the stamp does
-- not — so a subscriber holding the pre-replay version never learns the row
-- changed. A counter that only ever goes up has no such ordering to lose.
--
-- Bumped once per projection batch with
--   UPDATE read_model_counter SET value = value + 1 RETURNING value
-- which takes SQLite's write lock at that statement. Two batches on separate
-- connections therefore serialize: the second reads the first's committed
-- value and cannot reissue it.
CREATE TABLE read_model_counter (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	value INTEGER NOT NULL
);

-- Start above every version 0012 backfilled, so the switch from sequence space
-- to counter space never hands out a value a row already carries.
INSERT INTO read_model_counter (id, value)
SELECT 1, MAX(
	COALESCE((SELECT MAX(version) FROM sessions), 0),
	COALESCE((SELECT MAX(version) FROM messages), 0)
);
