ALTER TABLE command_receipts ADD COLUMN command_type TEXT;
ALTER TABLE command_receipts ADD COLUMN project_key TEXT;
ALTER TABLE command_receipts ADD COLUMN fingerprint_hash TEXT;
ALTER TABLE command_receipts ADD COLUMN fingerprint_version INTEGER;
ALTER TABLE command_receipts ADD COLUMN accepted_sequence INTEGER;
ALTER TABLE command_receipts ADD COLUMN side_effect_sequence INTEGER;
ALTER TABLE command_receipts ADD COLUMN error_code TEXT;
ALTER TABLE command_receipts ADD COLUMN updated_at INTEGER;

CREATE TABLE provider_command_sessions (
	project_key       TEXT    NOT NULL,
	session_id        TEXT    NOT NULL,
	provider_id       TEXT    NOT NULL,
	provider_kind     TEXT    NOT NULL,
	provider_session_id TEXT,
	status            TEXT    NOT NULL,
	active_turn_id    TEXT,
	last_sequence     INTEGER,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	tombstoned_at     INTEGER,
	tombstone_reason  TEXT,
	retain_until      INTEGER,
	PRIMARY KEY (project_key, session_id)
);

CREATE TABLE provider_command_turns (
	project_key       TEXT    NOT NULL,
	session_id        TEXT    NOT NULL,
	turn_id           TEXT    NOT NULL,
	command_id        TEXT    NOT NULL,
	status            TEXT    NOT NULL,
	user_message_id   TEXT,
	assistant_message_id TEXT,
	side_effect_sequence INTEGER,
	result_sequence   INTEGER,
	error_code        TEXT,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	tombstoned_at     INTEGER,
	tombstone_reason  TEXT,
	retain_until      INTEGER,
	PRIMARY KEY (project_key, turn_id)
);

CREATE TABLE provider_command_interactions (
	project_key       TEXT    NOT NULL,
	session_id        TEXT    NOT NULL,
	interaction_id    TEXT    NOT NULL,
	turn_id           TEXT,
	kind              TEXT    NOT NULL,
	status            TEXT    NOT NULL,
	request_sequence  INTEGER,
	result_sequence   INTEGER,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	tombstoned_at     INTEGER,
	tombstone_reason  TEXT,
	retain_until      INTEGER,
	PRIMARY KEY (project_key, interaction_id)
);

CREATE TABLE provider_command_tombstones (
	project_key       TEXT    NOT NULL,
	scope_kind        TEXT    NOT NULL,
	scope_id          TEXT    NOT NULL,
	session_id        TEXT,
	turn_id           TEXT,
	causation_command_id TEXT,
	event_sequence    INTEGER NOT NULL,
	reason_code       TEXT    NOT NULL,
	tombstoned_at     INTEGER NOT NULL,
	retain_until      INTEGER,
	details_json      TEXT,
	PRIMARY KEY (project_key, scope_kind, scope_id)
);

CREATE TABLE provider_command_outbox (
	request_sequence  INTEGER PRIMARY KEY,
	command_id        TEXT    NOT NULL,
	project_key       TEXT    NOT NULL,
	session_id        TEXT    NOT NULL,
	provider_id       TEXT    NOT NULL,
	effect_type       TEXT    NOT NULL,
	payload_json      TEXT    NOT NULL,
	status            TEXT    NOT NULL DEFAULT 'pending',
	attempt_count     INTEGER NOT NULL DEFAULT 0,
	result_sequence   INTEGER,
	error_code        TEXT,
	next_attempt_at   INTEGER,
	requested_at      INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL
);

CREATE TABLE provider_command_meta (
	project_key       TEXT    PRIMARY KEY,
	last_applied_sequence INTEGER NOT NULL,
	schema_version    INTEGER NOT NULL,
	rebuilt_at        INTEGER NOT NULL
);

CREATE INDEX idx_command_receipts_project ON command_receipts (project_key, session_id);
CREATE INDEX idx_provider_command_outbox_status ON provider_command_outbox (status, request_sequence);
CREATE INDEX idx_provider_command_turns_session ON provider_command_turns (project_key, session_id);
CREATE INDEX idx_provider_command_tombstones_session ON provider_command_tombstones (project_key, session_id);
