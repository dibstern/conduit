import { afterEach, describe, expect, it } from "vitest";
import {
	calculateMigrationChecksum,
	type Migration,
	runMigrations,
} from "../../../src/lib/persistence/migrations.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { sessionRowsToSessionInfoList } from "../../../src/lib/persistence/session-list-adapter.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("Migration Runner", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("creates the _migrations table on first run", () => {
		client = SqliteClient.memory();
		runMigrations(client, []);
		const rows = client.query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
		);
		expect(rows).toHaveLength(1);
	});

	it("runs migrations in order", () => {
		client = SqliteClient.memory();
		const createUsers: Migration = {
			id: 1,
			name: "create_users",
			sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
		};
		const createPosts: Migration = {
			id: 2,
			name: "create_posts",
			sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))",
		};
		const migrations: Migration[] = [createUsers, createPosts];
		const applied = runMigrations(client, migrations);
		expect(applied).toEqual([
			{
				id: 1,
				name: "create_users",
				checksum: calculateMigrationChecksum(createUsers),
			},
			{
				id: 2,
				name: "create_posts",
				checksum: calculateMigrationChecksum(createPosts),
			},
		]);
		const tables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts') ORDER BY name",
			)
			.map((r) => r.name);
		expect(tables).toEqual(["posts", "users"]);
	});

	it("refuses migration id gaps", () => {
		client = SqliteClient.memory();
		const migrations: Migration[] = [
			{
				id: 1,
				name: "first",
				sql: "CREATE TABLE first_table (id INTEGER PRIMARY KEY)",
			},
			{
				id: 3,
				name: "third",
				sql: "CREATE TABLE third_table (id INTEGER PRIMARY KEY)",
			},
		];

		expect(() => runMigrations(client, migrations)).toThrow(/contiguous/i);
	});

	it("skips already-applied migrations", () => {
		client = SqliteClient.memory();
		const migration: Migration = {
			id: 1,
			name: "create_users",
			sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)",
		};
		runMigrations(client, [migration]);
		const applied = runMigrations(client, [migration]);
		expect(applied).toEqual([]);
	});

	it("only runs new migrations when new ones are added", () => {
		client = SqliteClient.memory();
		const m1: Migration = {
			id: 1,
			name: "first",
			sql: "CREATE TABLE t1 (id INTEGER PRIMARY KEY)",
		};
		const m2: Migration = {
			id: 2,
			name: "second",
			sql: "CREATE TABLE t2 (id INTEGER PRIMARY KEY)",
		};
		runMigrations(client, [m1]);
		const applied = runMigrations(client, [m1, m2]);
		expect(applied).toEqual([
			{ id: 2, name: "second", checksum: calculateMigrationChecksum(m2) },
		]);
	});

	it("adds message part metadata to databases with only the event-store baseline", () => {
		client = SqliteClient.memory();
		const baseline = schemaMigrations[0];
		const metadataMigration = schemaMigrations[1];
		const durableCommandMigration = schemaMigrations[2];
		const dropEventsSessionFkMigration = schemaMigrations[3];
		const messagePartsFileTypeMigration = schemaMigrations[4];
		const messagePartsCompactionTypeMigration = schemaMigrations[5];
		const messagesContextWindowMigration = schemaMigrations[6];
		const turnModelExecutionMigration = schemaMigrations[7];
		const sessionsPermissionModeMigration = schemaMigrations[8];
		const sessionCascadeDeletesMigration = schemaMigrations[9];
		const sessionsReadAtMigration = schemaMigrations[10];
		const sessionsLastTurnErrorMigration = schemaMigrations[11];
		const compactionBackfillMigration = schemaMigrations[12];
		const sessionsSettledPinnedMigration = schemaMigrations[13];
		if (
			!baseline ||
			!metadataMigration ||
			!durableCommandMigration ||
			!dropEventsSessionFkMigration ||
			!messagePartsFileTypeMigration ||
			!messagePartsCompactionTypeMigration ||
			!messagesContextWindowMigration ||
			!turnModelExecutionMigration ||
			!sessionsPermissionModeMigration ||
			!sessionCascadeDeletesMigration ||
			!sessionsReadAtMigration ||
			!sessionsLastTurnErrorMigration ||
			!compactionBackfillMigration ||
			!sessionsSettledPinnedMigration
		) {
			throw new Error("Expected all event-store schema migrations");
		}

		runMigrations(client, [baseline]);
		let columns = client
			.query<{ name: string }>("PRAGMA table_info(message_parts)")
			.map((column) => column.name);
		expect(columns).not.toContain("metadata");

		const applied = runMigrations(client, schemaMigrations);

		expect(applied).toEqual([
			{
				id: 2,
				name: "add_message_part_metadata",
				checksum: calculateMigrationChecksum(metadataMigration),
			},
			{
				id: 3,
				name: "add_durable_provider_commands",
				checksum: calculateMigrationChecksum(durableCommandMigration),
			},
			{
				id: 4,
				name: "drop_events_session_fk",
				checksum: calculateMigrationChecksum(dropEventsSessionFkMigration),
			},
			{
				id: 5,
				name: "message_parts_file_type",
				checksum: calculateMigrationChecksum(messagePartsFileTypeMigration),
			},
			{
				id: 6,
				name: "message_parts_compaction_type",
				checksum: calculateMigrationChecksum(
					messagePartsCompactionTypeMigration,
				),
			},
			{
				id: 7,
				name: "messages_context_window",
				checksum: calculateMigrationChecksum(messagesContextWindowMigration),
			},
			{
				id: 8,
				name: "turn_model_execution",
				checksum: calculateMigrationChecksum(turnModelExecutionMigration),
			},
			{
				id: 9,
				name: "sessions_permission_mode",
				checksum: calculateMigrationChecksum(sessionsPermissionModeMigration),
			},
			{
				id: 10,
				name: "session_cascade_deletes",
				checksum: calculateMigrationChecksum(sessionCascadeDeletesMigration),
			},
			{
				id: 11,
				name: "sessions_read_at",
				checksum: calculateMigrationChecksum(sessionsReadAtMigration),
			},
			{
				id: 12,
				name: "sessions_last_turn_error",
				checksum: calculateMigrationChecksum(sessionsLastTurnErrorMigration),
			},
			{
				id: 13,
				name: "backfill_compaction_messages",
				checksum: calculateMigrationChecksum(compactionBackfillMigration),
			},
			{
				id: 14,
				name: "sessions_settled_pinned",
				checksum: calculateMigrationChecksum(sessionsSettledPinnedMigration),
			},
		]);
		columns = client
			.query<{ name: string }>("PRAGMA table_info(message_parts)")
			.map((column) => column.name);
		expect(columns).toContain("metadata");
		columns = client
			.query<{ name: string }>("PRAGMA table_info(command_receipts)")
			.map((column) => column.name);
		expect(columns).toContain("fingerprint_hash");
		columns = client
			.query<{ name: string }>("PRAGMA table_info(messages)")
			.map((column) => column.name);
		expect(columns).toContain("context_window");
		columns = client
			.query<{ name: string }>("PRAGMA table_info(turns)")
			.map((column) => column.name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"requested_model",
				"expected_model",
				"actual_model",
			]),
		);
	});

	it("upgrades a migration-7 database with turn model execution columns once", () => {
		client = SqliteClient.memory();
		const migrationsThrough7 = schemaMigrations.slice(0, 7);
		const turnModelExecutionMigration = schemaMigrations[7];
		const sessionsPermissionModeMigration = schemaMigrations[8];
		const sessionCascadeDeletesMigration = schemaMigrations[9];
		const sessionsReadAtMigration = schemaMigrations[10];
		const sessionsLastTurnErrorMigration = schemaMigrations[11];
		const compactionBackfillMigration = schemaMigrations[12];
		const sessionsSettledPinnedMigration = schemaMigrations[13];
		if (
			!turnModelExecutionMigration ||
			!sessionsPermissionModeMigration ||
			!sessionCascadeDeletesMigration ||
			!sessionsReadAtMigration ||
			!sessionsLastTurnErrorMigration ||
			!compactionBackfillMigration ||
			!sessionsSettledPinnedMigration
		) {
			throw new Error("Expected remaining event-store migrations");
		}
		runMigrations(client, migrationsThrough7);

		let columns = client
			.query<{ name: string }>("PRAGMA table_info(turns)")
			.map((column) => column.name);
		expect(columns).not.toContain("actual_model");

		expect(runMigrations(client, schemaMigrations)).toEqual([
			{
				id: 8,
				name: "turn_model_execution",
				checksum: calculateMigrationChecksum(turnModelExecutionMigration),
			},
			{
				id: 9,
				name: "sessions_permission_mode",
				checksum: calculateMigrationChecksum(sessionsPermissionModeMigration),
			},
			{
				id: 10,
				name: "session_cascade_deletes",
				checksum: calculateMigrationChecksum(sessionCascadeDeletesMigration),
			},
			{
				id: 11,
				name: "sessions_read_at",
				checksum: calculateMigrationChecksum(sessionsReadAtMigration),
			},
			{
				id: 12,
				name: "sessions_last_turn_error",
				checksum: calculateMigrationChecksum(sessionsLastTurnErrorMigration),
			},
			{
				id: 13,
				name: "backfill_compaction_messages",
				checksum: calculateMigrationChecksum(compactionBackfillMigration),
			},
			{
				id: 14,
				name: "sessions_settled_pinned",
				checksum: calculateMigrationChecksum(sessionsSettledPinnedMigration),
			},
		]);
		expect(runMigrations(client, schemaMigrations)).toEqual([]);

		columns = client
			.query<{ name: string }>("PRAGMA table_info(turns)")
			.map((column) => column.name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"requested_model",
				"expected_model",
				"actual_model",
			]),
		);
	});

	it("adds settled_at and pinned_at once without backfilling existing sessions", () => {
		client = SqliteClient.memory();
		const migrationsBeforeTriage = schemaMigrations.slice(0, 13);
		const migrationsThroughTriage = schemaMigrations;
		runMigrations(client, migrationsBeforeTriage);
		client.execute(
			`INSERT INTO sessions (id, provider, title, status, last_message_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["existing", "opencode", "Existing", "idle", 456, 100, 456],
		);

		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.map((column) => column.name),
		).not.toContain("settled_at");

		expect(runMigrations(client, migrationsThroughTriage)).toHaveLength(1);

		const rows = client.query<SessionRow>("SELECT * FROM sessions");
		expect(rows[0]).toMatchObject({
			settled_at: null,
			pinned_at: null,
			updated_at: 456,
		});
		const [session] = sessionRowsToSessionInfoList(rows);
		expect(session).not.toHaveProperty("settledAt");
		expect(session).not.toHaveProperty("pinnedAt");

		expect(runMigrations(client, migrationsThroughTriage)).toEqual([]);
		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.filter(
					(column) =>
						column.name === "settled_at" || column.name === "pinned_at",
				),
		).toHaveLength(2);
	});

	it("adds read_at once and backfills existing sessions as already read", () => {
		client = SqliteClient.memory();
		const migrationsBeforeReadAt = schemaMigrations.slice(0, 10);
		const migrationsThroughReadAt = schemaMigrations.slice(0, 11);
		runMigrations(client, migrationsBeforeReadAt);
		// last_message_at matters: without activity a session is never unread, so a
		// row that has none cannot tell a working backfill from a missing one.
		client.execute(
			`INSERT INTO sessions (id, provider, title, status, last_message_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["existing", "opencode", "Existing", "idle", 456, 100, 456],
		);

		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.map((column) => column.name),
		).not.toContain("read_at");

		expect(runMigrations(client, migrationsThroughReadAt)).toHaveLength(1);

		// The criterion is that upgrading does not invent a backlog, so assert on
		// the derived flag the product actually shows rather than on read_at alone.
		const rows = client.query<SessionRow>("SELECT * FROM sessions");
		expect(rows[0]?.read_at).toBe(456);
		expect(sessionRowsToSessionInfoList(rows)[0]).not.toHaveProperty("unread");

		expect(runMigrations(client, migrationsThroughReadAt)).toEqual([]);
		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.filter((column) => column.name === "read_at"),
		).toHaveLength(1);
	});

	it("adds last_turn_error_at once without backfilling historical failures", () => {
		client = SqliteClient.memory();
		const migrationsBeforeLastTurnError = schemaMigrations.slice(0, 11);
		runMigrations(client, migrationsBeforeLastTurnError);
		client.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			["existing", "opencode", "Existing", "idle", 100, 456],
		);

		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.map((column) => column.name),
		).not.toContain("last_turn_error_at");

		expect(runMigrations(client, schemaMigrations)).toHaveLength(3);
		const rows = client.query<SessionRow>("SELECT * FROM sessions");
		expect(rows[0]?.last_turn_error_at).toBeNull();
		expect(sessionRowsToSessionInfoList(rows)[0]?.attention).toBe("idle");

		expect(runMigrations(client, schemaMigrations)).toEqual([]);
		expect(
			client
				.query<{ name: string }>("PRAGMA table_info(sessions)")
				.filter((column) => column.name === "last_turn_error_at"),
		).toHaveLength(1);
	});

	it("rolls back a failed migration without affecting prior ones", () => {
		client = SqliteClient.memory();
		const m1: Migration = {
			id: 1,
			name: "good",
			sql: "CREATE TABLE good_table (id INTEGER PRIMARY KEY)",
		};
		const m2: Migration = {
			id: 2,
			name: "bad",
			sql: "CREATE TABLE broken_table (id INTEGER PRIMARY KEY",
		};
		expect(() => runMigrations(client, [m1, m2])).toThrow();
		const tables = client.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'",
		);
		expect(tables).toHaveLength(1);
		const recorded = client.query<{ id: number }>(
			"SELECT id FROM _migrations ORDER BY id",
		);
		expect(recorded).toEqual([{ id: 1 }]);
	});

	it("records applied_at timestamp", () => {
		client = SqliteClient.memory();
		const before = Date.now();
		runMigrations(client, [
			{
				id: 1,
				name: "test",
				sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)",
			},
		]);
		const after = Date.now();
		const row = client.queryOne<{ applied_at: number }>(
			"SELECT applied_at FROM _migrations WHERE id = 1",
		);
		expect(row).toBeDefined();
		expect(row?.applied_at).toBeGreaterThanOrEqual(before);
		expect(row?.applied_at).toBeLessThanOrEqual(after);
	});

	it("records migration checksums", () => {
		client = SqliteClient.memory();
		const migration: Migration = {
			id: 1,
			name: "checksummed",
			sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)",
		};
		runMigrations(client, [migration]);
		const row = client.queryOne<{ checksum: string }>(
			"SELECT checksum FROM _migrations WHERE id = 1",
		);
		expect(row?.checksum).toBe(calculateMigrationChecksum(migration));
	});

	it("refuses to start when an applied migration checksum changes", () => {
		client = SqliteClient.memory();
		const original: Migration = {
			id: 1,
			name: "create_users",
			sql: "CREATE TABLE users (id INTEGER PRIMARY KEY)",
		};
		const edited: Migration = {
			...original,
			sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
		};
		runMigrations(client, [original]);
		expect(() => runMigrations(client, [edited])).toThrow(/checksum/i);
	});

	it("backfills checksums for legacy migration rows without one", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE already_existed (id INTEGER PRIMARY KEY)");
		client.execute(`
			CREATE TABLE _migrations (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			)
		`);
		client.execute(
			"INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
			[1, "legacy", 123],
		);
		const migration: Migration = {
			id: 1,
			name: "legacy",
			sql: "CREATE TABLE already_existed (id INTEGER PRIMARY KEY)",
		};
		const applied = runMigrations(client, [migration]);
		expect(applied).toEqual([]);
		const row = client.queryOne<{ checksum: string }>(
			"SELECT checksum FROM _migrations WHERE id = 1",
		);
		expect(row?.checksum).toBe(calculateMigrationChecksum(migration));
	});

	it("refuses to backfill a legacy checksum when the schema object is missing", () => {
		client = SqliteClient.memory();
		client.execute(`
			CREATE TABLE _migrations (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at INTEGER NOT NULL
			)
		`);
		client.execute(
			"INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
			[1, "legacy", 123],
		);
		const migration: Migration = {
			id: 1,
			name: "legacy",
			sql: "CREATE TABLE missing_table (id INTEGER PRIMARY KEY)",
		};
		expect(() => runMigrations(client, [migration])).toThrow(/schema object/i);
	});

	it("refuses to start when an applied migration was renamed", () => {
		client = SqliteClient.memory();
		const migration: Migration = {
			id: 1,
			name: "original_name",
			sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)",
		};
		runMigrations(client, [migration]);
		expect(() =>
			runMigrations(client, [{ ...migration, name: "renamed" }]),
		).toThrow(/name/i);
	});
});
