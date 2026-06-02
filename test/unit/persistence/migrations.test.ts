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
		if (!baseline || !metadataMigration || !durableCommandMigration) {
			throw new Error(
				"Expected event-store baseline, metadata, and durable command migrations",
			);
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
		]);
		columns = client
			.query<{ name: string }>("PRAGMA table_info(message_parts)")
			.map((column) => column.name);
		expect(columns).toContain("metadata");
		columns = client
			.query<{ name: string }>("PRAGMA table_info(command_receipts)")
			.map((column) => column.name);
		expect(columns).toContain("fingerprint_hash");
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
