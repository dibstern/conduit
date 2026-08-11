import { afterEach, describe, expect, it } from "vitest";
import {
	calculateMigrationChecksum,
	type Migration,
	runMigrations,
} from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
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
		const projectionFailuresMigration = schemaMigrations[9];
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
			!projectionFailuresMigration
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
				name: "create_projection_failures",
				checksum: calculateMigrationChecksum(projectionFailuresMigration),
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

	it("upgrades a migration-9 database with durable projection failures once", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations.slice(0, 9));
		const beforeTables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='projection_failures'",
			)
			.map((row) => row.name);

		const applied = runMigrations(client, schemaMigrations).map(
			({ id, name }) => ({ id, name }),
		);
		const columns = client.query<{
			cid: number;
			name: string;
			type: string;
			notnull: number;
			dflt_value: string | null;
			pk: number;
		}>("PRAGMA table_info(projection_failures)");
		const foreignKeys = client.query(
			"PRAGMA foreign_key_list(projection_failures)",
		);
		const createTable = client.queryOne<{ sql: string }>(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_failures'",
		);

		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["session-deleted", "opencode", "Deleted", "idle", 1_000, 1_000],
		);
		client.execute(
			"INSERT INTO events (sequence, event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				42,
				"event-deleted",
				"session-deleted",
				0,
				"session.created",
				"{}",
				"opencode",
				1_000,
			],
		);
		client.execute(
			"INSERT INTO projection_failures (projector_name, event_sequence, event_type, session_id, error, failed_at) VALUES (?, ?, ?, ?, ?, ?)",
			[
				"session",
				42,
				"session.created",
				"session-deleted",
				"projection failed",
				2_000,
			],
		);
		client.execute("DELETE FROM events WHERE sequence = ?", [42]);
		client.execute("DELETE FROM sessions WHERE id = ?", ["session-deleted"]);

		expect({
			beforeTables,
			applied,
			columns,
			foreignKeys,
			usesAutoincrement: createTable?.sql.includes("AUTOINCREMENT"),
			remainingFailures: client.query(
				"SELECT id, projector_name, event_sequence, event_type, session_id, error, failed_at FROM projection_failures",
			),
			secondRun: runMigrations(client, schemaMigrations),
		}).toEqual({
			beforeTables: [],
			applied: [{ id: 10, name: "create_projection_failures" }],
			columns: [
				{
					cid: 0,
					name: "id",
					type: "INTEGER",
					notnull: 0,
					dflt_value: null,
					pk: 1,
				},
				{
					cid: 1,
					name: "projector_name",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
				{
					cid: 2,
					name: "event_sequence",
					type: "INTEGER",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
				{
					cid: 3,
					name: "event_type",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
				{
					cid: 4,
					name: "session_id",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
				{
					cid: 5,
					name: "error",
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
				{
					cid: 6,
					name: "failed_at",
					type: "INTEGER",
					notnull: 1,
					dflt_value: null,
					pk: 0,
				},
			],
			foreignKeys: [],
			usesAutoincrement: true,
			remainingFailures: [
				{
					id: 1,
					projector_name: "session",
					event_sequence: 42,
					event_type: "session.created",
					session_id: "session-deleted",
					error: "projection failed",
					failed_at: 2_000,
				},
			],
			secondRun: [],
		});
	});

	it("upgrades a migration-7 database with turn model execution columns once", () => {
		client = SqliteClient.memory();
		const migrationsThrough7 = schemaMigrations.slice(0, 7);
		const turnModelExecutionMigration = schemaMigrations[7];
		const sessionsPermissionModeMigration = schemaMigrations[8];
		const projectionFailuresMigration = schemaMigrations[9];
		if (
			!turnModelExecutionMigration ||
			!sessionsPermissionModeMigration ||
			!projectionFailuresMigration
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
				name: "create_projection_failures",
				checksum: calculateMigrationChecksum(projectionFailuresMigration),
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
