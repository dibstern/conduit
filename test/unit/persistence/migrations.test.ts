import { afterEach, describe, expect, it } from "vitest";
import {
	type Migration,
	runMigrations,
} from "../../../src/lib/persistence/migrations.js";
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
		const migrations: Migration[] = [
			{
				id: 1,
				name: "create_users",
				up: (db) => {
					db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
				},
			},
			{
				id: 2,
				name: "create_posts",
				up: (db) => {
					db.execute(
						"CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))",
					);
				},
			},
		];
		const applied = runMigrations(client, migrations);
		expect(applied).toEqual([
			{ id: 1, name: "create_users" },
			{ id: 2, name: "create_posts" },
		]);
		const tables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts') ORDER BY name",
			)
			.map((r) => r.name);
		expect(tables).toEqual(["posts", "users"]);
	});

	it("skips already-applied migrations", () => {
		client = SqliteClient.memory();
		const migration: Migration = {
			id: 1,
			name: "create_users",
			up: (db) => {
				db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)");
			},
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
			up: (db) => {
				db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)");
			},
		};
		const m2: Migration = {
			id: 2,
			name: "second",
			up: (db) => {
				db.execute("CREATE TABLE t2 (id INTEGER PRIMARY KEY)");
			},
		};
		runMigrations(client, [m1]);
		const applied = runMigrations(client, [m1, m2]);
		expect(applied).toEqual([{ id: 2, name: "second" }]);
	});

	it("rolls back a failed migration without affecting prior ones", () => {
		client = SqliteClient.memory();
		const m1: Migration = {
			id: 1,
			name: "good",
			up: (db) => {
				db.execute("CREATE TABLE good_table (id INTEGER PRIMARY KEY)");
			},
		};
		const m2: Migration = {
			id: 2,
			name: "bad",
			up: () => {
				throw new Error("migration failed");
			},
		};
		expect(() => runMigrations(client, [m1, m2])).toThrow("migration failed");
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
				up: (db) => {
					db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
				},
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
});
