// test/unit/persistence/sqlite-client.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("SqliteClient", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("opens an in-memory database with memory journal mode", () => {
		client = SqliteClient.memory();
		const rows = client.query<{ journal_mode: string }>("PRAGMA journal_mode");
		expect(rows[0]?.journal_mode).toBe("memory");
	});

	it("executes a simple query", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
		client.execute("INSERT INTO test (name) VALUES (?)", ["alice"]);
		const rows = client.query<{ id: number; name: string }>(
			"SELECT * FROM test",
		);
		expect(rows).toEqual([{ id: 1, name: "alice" }]);
	});

	it("caches prepared statements", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)");
		client.query("SELECT * FROM test");
		client.query("SELECT * FROM test");
		expect(client.statementCacheSize).toBe(2);
	});

	it("evicts least-recently-used statement, not least-recently-inserted", () => {
		client = SqliteClient.memory({ maxCacheSize: 3 });
		client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");

		const qA = "SELECT 1";
		const qB = "SELECT 2";
		const qC = "SELECT 3";
		client.query(qA);
		client.query(qB);
		client.query(qC);
		expect(client.statementCacheSize).toBe(3);
		expect(
			client.hasCachedStatement("CREATE TABLE t (id INTEGER PRIMARY KEY)"),
		).toBe(false);

		// Access qA — LRU should move it to "most recently used"
		client.query(qA);

		// Insert qD — should evict qB (LRU), NOT qA
		const qD = "SELECT 4";
		client.query(qD);
		expect(client.statementCacheSize).toBe(3);
		expect(client.hasCachedStatement(qB)).toBe(false);
		expect(client.hasCachedStatement(qA)).toBe(true);
		expect(client.hasCachedStatement(qC)).toBe(true);
		expect(client.hasCachedStatement(qD)).toBe(true);
	});

	it("executes within a transaction that commits on success", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["a"]);
			client.execute("INSERT INTO test (val) VALUES (?)", ["b"]);
		});
		const rows = client.query<{ val: string }>(
			"SELECT val FROM test ORDER BY id",
		);
		expect(rows).toEqual([{ val: "a" }, { val: "b" }]);
	});

	it("rolls back transaction on error", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		expect(() => {
			client.runInTransaction(() => {
				client.execute("INSERT INTO test (val) VALUES (?)", ["a"]);
				throw new Error("boom");
			});
		}).toThrow("boom");
		const rows = client.query("SELECT * FROM test");
		expect(rows).toEqual([]);
	});

	it("supports nested runInTransaction via savepoints", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
			client.runInTransaction(() => {
				client.execute("INSERT INTO test (val) VALUES (?)", ["inner"]);
			});
		});
		const rows = client.query<{ val: string }>(
			"SELECT val FROM test ORDER BY id",
		);
		expect(rows).toEqual([{ val: "outer" }, { val: "inner" }]);
	});

	it("rolls back only inner savepoint on nested error when outer catches", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
			try {
				client.runInTransaction(() => {
					client.execute("INSERT INTO test (val) VALUES (?)", ["inner"]);
					throw new Error("inner boom");
				});
			} catch {
				// swallow — outer transaction continues
			}
		});
		const rows = client.query<{ val: string }>(
			"SELECT val FROM test ORDER BY id",
		);
		expect(rows).toEqual([{ val: "outer" }]);
	});

	it("queryOne returns the first row or undefined", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.execute("INSERT INTO test (val) VALUES (?)", ["x"]);
		const row = client.queryOne<{ val: string }>("SELECT val FROM test");
		expect(row).toEqual({ val: "x" });
		const missing = client.queryOne("SELECT * FROM test WHERE id = 999");
		expect(missing).toBeUndefined();
	});

	it("opens a file-backed database", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-test-"));
		const dbPath = path.join(tmpDir, "test.db");
		try {
			client = SqliteClient.open(dbPath);
			client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			client.execute("INSERT INTO t VALUES (1)");
			client.close();

			// Re-open and verify persistence
			client = SqliteClient.open(dbPath);
			const rows = client.query<{ id: number }>("SELECT id FROM t");
			expect(rows).toEqual([{ id: 1 }]);
		} finally {
			client?.close();
			fs.rmSync(tmpDir, { recursive: true });
		}
	});
});
