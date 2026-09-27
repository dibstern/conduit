-- At-least-once alert delivery. Pending claims can be retried after abandonment.
-- delivered receipts suppress successful replays. Recipients deduplicate retries
-- after a crash between send success and recording that success.
-- No session foreign key: receipts must not prevent deletion of a session.
CREATE TABLE sent_alerts (
	session_id TEXT    NOT NULL,
	alert_key  TEXT    NOT NULL,
	anchor     TEXT    NOT NULL,
	sent_at    INTEGER NOT NULL,
	state      TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered')),
	claim_id   TEXT,
	PRIMARY KEY (session_id, alert_key, anchor)
);
