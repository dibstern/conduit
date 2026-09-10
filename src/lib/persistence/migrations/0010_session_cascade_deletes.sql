-- Move the session-delete cascade out of application code and into the
-- schema. SQLite cannot ALTER a foreign key, so every table that references
-- sessions(id) or turns(id) -- directly or (for message_parts) via messages
-- -- is rebuilt with ON DELETE CASCADE. sessions.parent_id also becomes a
-- self-referential ON DELETE CASCADE so deleting a parent session removes
-- its subagent children (and, transitively, everything that references
-- those children) in one statement: DELETE FROM sessions WHERE id = ?.
--
-- events is deliberately NOT touched here: 0004_drop_events_session_fk.sql
-- removed its FK to sessions on purpose so the event log outlives session
-- read-model rows. Adding a cascade back would delete event history.
--
-- Each INSERT...SELECT defensively drops or nulls out any already-dangling
-- foreign key value it finds (legacy databases may carry rows written before
-- FK enforcement covered every path) so the new constraints don't reject
-- data that was already unreachable through every real query path:
--   - a session with a dangling parent_id keeps its row; parent_id is nulled
--   - a turn/session_providers/pending_approval/activity/tool_content/
--     provider_state row with a dangling session_id is dropped (unreachable)
--   - a message with a dangling turn_id keeps its row; turn_id is nulled
--   - a message with a dangling session_id is dropped (unreachable)
--   - a message_part with a dangling message_id is dropped (unreachable)
--   - a pending_approval/activity with a dangling turn_id keeps its row,
--     with turn_id nulled
--
-- This file must run with foreign key enforcement OFF for the duration of
-- the rebuild (DROP TABLE on a table with live FK-referencing child rows is
-- itself rejected while enforcement is ON, not just DML) -- the migration
-- runner is responsible for toggling the pragma around this file, not this
-- file itself. No BEGIN/COMMIT/PRAGMA statements appear here, matching every
-- other migration in this directory.

-- ── sessions (self-referential parent_id) ──────────────────────────────────
CREATE TABLE sessions_new (
	id              TEXT    PRIMARY KEY,
	provider        TEXT    NOT NULL,
	provider_sid    TEXT,
	title           TEXT    NOT NULL DEFAULT 'Untitled',
	status          TEXT    NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'retry', 'error')),
	parent_id       TEXT,
	fork_point_event TEXT,
	last_message_at INTEGER,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL,
	permission_mode TEXT,
	-- Named against the FINAL table name ("sessions"), not "sessions_new".
	-- SQLite's ALTER TABLE ... RENAME TO rewrites references to the OLD name
	-- inside a table's own DDL, but that rewrite is gated by the
	-- legacy_alter_table pragma: with it OFF (better-sqlite3's default) the
	-- rename would rewrite "sessions_new" to "sessions" anyway, but with it ON
	-- (e.g. the sqlite3 CLI's default) no rewrite happens and a self-FK
	-- written against "sessions_new" would permanently reference a dropped
	-- table, breaking every future INSERT INTO sessions. Naming "sessions"
	-- directly is correct under both settings: foreign_keys is OFF for the
	-- whole rebuild, so this FK target is not resolved at CREATE TABLE time.
	FOREIGN KEY (parent_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO sessions_new (
	id, provider, provider_sid, title, status, parent_id, fork_point_event,
	last_message_at, created_at, updated_at, permission_mode
)
SELECT
	id, provider, provider_sid, title, status,
	CASE
		WHEN parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM sessions)
			THEN NULL
		ELSE parent_id
	END,
	fork_point_event, last_message_at, created_at, updated_at, permission_mode
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC);
CREATE INDEX idx_sessions_parent ON sessions (parent_id);
CREATE INDEX idx_sessions_provider ON sessions (provider, provider_sid);

-- ── turns (session_id) ──────────────────────────────────────────────────────
CREATE TABLE turns_new (
	id              TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	state           TEXT    NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'completed', 'interrupted', 'error')),
	user_message_id TEXT,
	assistant_message_id TEXT,
	cost            REAL,
	tokens_in       INTEGER,
	tokens_out      INTEGER,
	requested_at    INTEGER NOT NULL,
	started_at      INTEGER,
	completed_at    INTEGER,
	requested_model TEXT,
	expected_model  TEXT,
	actual_model    TEXT,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO turns_new (
	id, session_id, state, user_message_id, assistant_message_id, cost,
	tokens_in, tokens_out, requested_at, started_at, completed_at,
	requested_model, expected_model, actual_model
)
SELECT
	id, session_id, state, user_message_id, assistant_message_id, cost,
	tokens_in, tokens_out, requested_at, started_at, completed_at,
	requested_model, expected_model, actual_model
FROM turns
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;

CREATE INDEX idx_turns_session_requested ON turns (session_id, requested_at);
CREATE INDEX idx_turns_assistant_message ON turns (assistant_message_id);

-- ── messages (session_id, turn_id) ─────────────────────────────────────────
CREATE TABLE messages_new (
	id              TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	turn_id         TEXT,
	role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
	text            TEXT    NOT NULL DEFAULT '',
	cost            REAL,
	tokens_in       INTEGER,
	tokens_out      INTEGER,
	tokens_cache_read  INTEGER,
	tokens_cache_write INTEGER,
	is_streaming    INTEGER NOT NULL DEFAULT 0,
	is_inherited    INTEGER NOT NULL DEFAULT 0,
	last_applied_seq INTEGER,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL,
	context_window  INTEGER,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

INSERT INTO messages_new (
	id, session_id, turn_id, role, text, cost, tokens_in, tokens_out,
	tokens_cache_read, tokens_cache_write, is_streaming, is_inherited,
	last_applied_seq, created_at, updated_at, context_window
)
SELECT
	id, session_id,
	CASE
		WHEN turn_id IS NOT NULL AND turn_id NOT IN (SELECT id FROM turns)
			THEN NULL
		ELSE turn_id
	END,
	role, text, cost, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write,
	is_streaming, is_inherited, last_applied_seq, created_at, updated_at, context_window
FROM messages
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

CREATE INDEX idx_messages_session_created ON messages (session_id, created_at DESC, id DESC);
CREATE INDEX idx_messages_turn ON messages (turn_id);

-- ── message_parts (message_id, via messages) ───────────────────────────────
CREATE TABLE message_parts_new (
	id          TEXT    PRIMARY KEY,
	message_id  TEXT    NOT NULL,
	type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool', 'file', 'compaction')),
	text        TEXT    NOT NULL DEFAULT '',
	tool_name   TEXT,
	call_id     TEXT,
	input       TEXT,
	result      TEXT,
	duration    REAL,
	status      TEXT,
	sort_order  INTEGER NOT NULL,
	created_at  INTEGER NOT NULL,
	updated_at  INTEGER NOT NULL,
	metadata    TEXT,
	FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

INSERT INTO message_parts_new (
	id, message_id, type, text, tool_name, call_id, input, result,
	duration, status, sort_order, created_at, updated_at, metadata
)
SELECT
	id, message_id, type, text, tool_name, call_id, input, result,
	duration, status, sort_order, created_at, updated_at, metadata
FROM message_parts
WHERE message_id IN (SELECT id FROM messages);

DROP TABLE message_parts;
ALTER TABLE message_parts_new RENAME TO message_parts;

CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order);

-- ── session_providers (session_id) ─────────────────────────────────────────
CREATE TABLE session_providers_new (
	id              TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	provider        TEXT    NOT NULL,
	provider_sid    TEXT,
	status          TEXT    NOT NULL DEFAULT 'active',
	activated_at    INTEGER NOT NULL,
	deactivated_at  INTEGER,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO session_providers_new (
	id, session_id, provider, provider_sid, status, activated_at, deactivated_at
)
SELECT
	id, session_id, provider, provider_sid, status, activated_at, deactivated_at
FROM session_providers
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE session_providers;
ALTER TABLE session_providers_new RENAME TO session_providers;

CREATE INDEX idx_session_providers_session ON session_providers (session_id, activated_at DESC);
CREATE INDEX idx_session_providers_active ON session_providers (session_id, status) WHERE status = 'active';

-- ── pending_approvals (session_id, turn_id) ────────────────────────────────
CREATE TABLE pending_approvals_new (
	id              TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	turn_id         TEXT,
	type            TEXT    NOT NULL CHECK(type IN ('permission', 'question')),
	status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
	tool_name       TEXT,
	input           TEXT,
	decision        TEXT,
	always          TEXT,
	created_at      INTEGER NOT NULL,
	resolved_at     INTEGER,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

INSERT INTO pending_approvals_new (
	id, session_id, turn_id, type, status, tool_name, input, decision,
	always, created_at, resolved_at
)
SELECT
	id, session_id,
	CASE
		WHEN turn_id IS NOT NULL AND turn_id NOT IN (SELECT id FROM turns)
			THEN NULL
		ELSE turn_id
	END,
	type, status, tool_name, input, decision, always, created_at, resolved_at
FROM pending_approvals
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE pending_approvals;
ALTER TABLE pending_approvals_new RENAME TO pending_approvals;

CREATE INDEX idx_pending_approvals_session_status ON pending_approvals (session_id, status);
CREATE INDEX idx_pending_approvals_pending ON pending_approvals (status) WHERE status = 'pending';

-- ── activities (session_id, turn_id) ───────────────────────────────────────
CREATE TABLE activities_new (
	id              TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	turn_id         TEXT,
	tone            TEXT    NOT NULL,
	kind            TEXT    NOT NULL,
	summary         TEXT    NOT NULL,
	payload         TEXT    NOT NULL DEFAULT '{}',
	sequence        INTEGER,
	created_at      INTEGER NOT NULL,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (turn_id) REFERENCES turns(id) ON DELETE CASCADE
);

INSERT INTO activities_new (
	id, session_id, turn_id, tone, kind, summary, payload, sequence, created_at
)
SELECT
	id, session_id,
	CASE
		WHEN turn_id IS NOT NULL AND turn_id NOT IN (SELECT id FROM turns)
			THEN NULL
		ELSE turn_id
	END,
	tone, kind, summary, payload, sequence, created_at
FROM activities
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE activities;
ALTER TABLE activities_new RENAME TO activities;

CREATE INDEX idx_activities_session_created ON activities (session_id, created_at);
CREATE INDEX idx_activities_turn ON activities (turn_id);
CREATE INDEX idx_activities_tone ON activities (session_id, tone);
CREATE INDEX idx_activities_session_kind ON activities (session_id, kind, created_at);

-- ── tool_content (session_id) ──────────────────────────────────────────────
CREATE TABLE tool_content_new (
	tool_id         TEXT    PRIMARY KEY,
	session_id      TEXT    NOT NULL,
	content         TEXT    NOT NULL,
	created_at      INTEGER NOT NULL,
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO tool_content_new (tool_id, session_id, content, created_at)
SELECT tool_id, session_id, content, created_at
FROM tool_content
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE tool_content;
ALTER TABLE tool_content_new RENAME TO tool_content;

CREATE INDEX idx_tool_content_session ON tool_content (session_id);

-- ── provider_state (session_id) ────────────────────────────────────────────
CREATE TABLE provider_state_new (
	session_id      TEXT    NOT NULL,
	key             TEXT    NOT NULL,
	value           TEXT    NOT NULL,
	PRIMARY KEY (session_id, key),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO provider_state_new (session_id, key, value)
SELECT session_id, key, value
FROM provider_state
WHERE session_id IN (SELECT id FROM sessions);

DROP TABLE provider_state;
ALTER TABLE provider_state_new RENAME TO provider_state;
