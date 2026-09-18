-- Which alerts have already been fired.
--
-- A badge is state: it can be re-derived from the log and the read model on
-- every reload, and a wrong one corrects itself. A ding is an alert: it happens
-- once, out in the world, and nothing afterwards records whether it arrived. So
-- the only place the fire-once guarantee can live is a durable claim taken
-- before the send — in memory it would be empty after a restart, which is
-- exactly when a reconnect re-observes turns that ended while the daemon was
-- down and would ding for all of them.
--
-- Two columns, two different jobs:
--
--   alert_key  WHICH alert this row is about — "done", "error:disk full",
--              "permission_request:<request id>". Alerts that can be live
--              several at a time (questions, permissions) carry their own
--              stable id, so a reconnect that replays all of them finds every
--              claim already taken. Alerts that are about the session as a
--              whole (done) have one key and supersede each other.
--   anchor     WHEN it was about — the session's latest turn id, falling back
--              to its last message time. A claim is only given up for a
--              different anchor, so a second pipeline observing the same
--              completed turn loses, and the next turn wins.
--
-- Growth is one row per distinct alert the user was actually shown, which is a
-- human-scale number per session, so the table never needs pruning.
--
-- Deliberately no foreign key to sessions: this is a record of something that
-- already happened to the user, and it must not be able to fail a session
-- delete or a cascade. Rows for deleted sessions are inert.
CREATE TABLE sent_alerts (
	session_id TEXT    NOT NULL,
	alert_key  TEXT    NOT NULL,
	anchor     TEXT    NOT NULL,
	sent_at    INTEGER NOT NULL,
	PRIMARY KEY (session_id, alert_key)
);
