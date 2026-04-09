import type { Migration } from "./migrations.js";
import type { SqliteClient } from "./sqlite-client.js";

function createEventStoreTables(db: SqliteClient): void {
	db.execute(`
		CREATE TABLE sessions (
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
			FOREIGN KEY (parent_id) REFERENCES sessions(id)
		)
	`);
	db.execute("CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC)");
	db.execute("CREATE INDEX idx_sessions_parent ON sessions (parent_id)");
	db.execute(
		"CREATE INDEX idx_sessions_provider ON sessions (provider, provider_sid)",
	);

	db.execute(`
		CREATE TABLE events (
			sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id        TEXT    NOT NULL UNIQUE,
			session_id      TEXT    NOT NULL,
			stream_version  INTEGER NOT NULL,
			type            TEXT    NOT NULL,
			data            TEXT    NOT NULL,
			metadata        TEXT    NOT NULL DEFAULT '{}',
			provider        TEXT    NOT NULL,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE UNIQUE INDEX idx_events_session_version ON events (session_id, stream_version)",
	);
	db.execute(
		"CREATE INDEX idx_events_session_seq ON events (session_id, sequence)",
	);
	db.execute("CREATE INDEX idx_events_type ON events (type)");

	db.execute(`
		CREATE TABLE command_receipts (
			command_id      TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			status          TEXT    NOT NULL,
			result_sequence INTEGER,
			error           TEXT,
			created_at      INTEGER NOT NULL
		)
	`);
	db.execute(
		"CREATE INDEX idx_command_receipts_session ON command_receipts (session_id)",
	);

	db.execute(`
		CREATE TABLE turns (
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
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_turns_session_requested ON turns (session_id, requested_at)",
	);
	db.execute(
		"CREATE INDEX idx_turns_assistant_message ON turns (assistant_message_id)",
	);

	db.execute(`
		CREATE TABLE messages (
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
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_messages_session_created ON messages (session_id, created_at DESC, id DESC)",
	);
	db.execute("CREATE INDEX idx_messages_turn ON messages (turn_id)");

	db.execute(`
		CREATE TABLE message_parts (
			id          TEXT    PRIMARY KEY,
			message_id  TEXT    NOT NULL,
			type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool')),
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
			FOREIGN KEY (message_id) REFERENCES messages(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order)",
	);

	db.execute(`
		CREATE TABLE session_providers (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			provider        TEXT    NOT NULL,
			provider_sid    TEXT,
			status          TEXT    NOT NULL DEFAULT 'active',
			activated_at    INTEGER NOT NULL,
			deactivated_at  INTEGER,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_session_providers_session ON session_providers (session_id, activated_at DESC)",
	);
	db.execute(
		"CREATE INDEX idx_session_providers_active ON session_providers (session_id, status) WHERE status = 'active'",
	);

	db.execute(`
		CREATE TABLE pending_approvals (
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
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_pending_approvals_session_status ON pending_approvals (session_id, status)",
	);
	db.execute(
		"CREATE INDEX idx_pending_approvals_pending ON pending_approvals (status) WHERE status = 'pending'",
	);

	db.execute(`
		CREATE TABLE activities (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			turn_id         TEXT,
			tone            TEXT    NOT NULL,
			kind            TEXT    NOT NULL,
			summary         TEXT    NOT NULL,
			payload         TEXT    NOT NULL DEFAULT '{}',
			sequence        INTEGER,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_activities_session_created ON activities (session_id, created_at)",
	);
	db.execute("CREATE INDEX idx_activities_turn ON activities (turn_id)");
	db.execute(
		"CREATE INDEX idx_activities_tone ON activities (session_id, tone)",
	);
	db.execute(
		"CREATE INDEX idx_activities_session_kind ON activities (session_id, kind, created_at)",
	);

	db.execute(`
		CREATE TABLE projector_cursors (
			projector_name      TEXT    PRIMARY KEY,
			last_applied_seq    INTEGER NOT NULL,
			updated_at          INTEGER NOT NULL
		)
	`);

	db.execute(`
		CREATE TABLE tool_content (
			tool_id         TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			content         TEXT    NOT NULL,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_tool_content_session ON tool_content (session_id)",
	);

	db.execute(`
		CREATE TABLE provider_state (
			session_id      TEXT    NOT NULL,
			key             TEXT    NOT NULL,
			value           TEXT    NOT NULL,
			PRIMARY KEY (session_id, key),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
}

export const schemaMigrations: readonly Migration[] = [
	{
		id: 1,
		name: "create_event_store_tables",
		up: createEventStoreTables,
	},
];
