import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SessionSeeder } from "../../../src/lib/persistence/session-seeder.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("SessionSeeder", () => {
	let db: SqliteClient;
	let seeder: SessionSeeder;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		seeder = new SessionSeeder(db);
	});

	afterEach(() => {
		db.close();
	});

	it("creates a session row that doesn't exist", () => {
		seeder.ensureSession("sess-1", "opencode");
		const row = db.queryOne<{
			id: string;
			provider: string;
			status: string;
		}>("SELECT id, provider, status FROM sessions WHERE id = ?", ["sess-1"]);
		expect(row).toBeDefined();
		expect(row?.id).toBe("sess-1");
		expect(row?.provider).toBe("opencode");
		expect(row?.status).toBe("idle");
	});

	it("is idempotent — second call for same session is a no-op", () => {
		seeder.ensureSession("sess-1", "opencode");
		seeder.ensureSession("sess-1", "opencode");
		const rows = db.query<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(rows).toHaveLength(1);
	});

	it("does not overwrite existing session data", () => {
		seeder.ensureSession("sess-1", "opencode");
		db.execute("UPDATE sessions SET title = ? WHERE id = ?", [
			"Custom Title",
			"sess-1",
		]);
		seeder.ensureSession("sess-1", "opencode");
		const row = db.queryOne<{ title: string }>(
			"SELECT title FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row?.title).toBe("Custom Title");
	});

	it("creates sessions with different providers", () => {
		seeder.ensureSession("sess-1", "opencode");
		seeder.ensureSession("sess-2", "claude");
		const rows = db.query<{ id: string; provider: string }>(
			"SELECT id, provider FROM sessions ORDER BY id",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.provider).toBe("opencode");
		expect(rows[1]?.provider).toBe("claude");
	});

	it("stores optional parent and provider session ids", () => {
		seeder.ensureSession("parent-session", "claude");
		seeder.ensureSession("claude-subagent-abc", "claude", {
			parentId: "parent-session",
			providerSessionId: "sdk-subagent-1",
		});

		const row = db.queryOne<{
			parent_id: string | null;
			provider_sid: string | null;
		}>("SELECT parent_id, provider_sid FROM sessions WHERE id = ?", [
			"claude-subagent-abc",
		]);
		expect(row).toEqual({
			parent_id: "parent-session",
			provider_sid: "sdk-subagent-1",
		});
	});

	it("sets created_at and updated_at to current time", () => {
		const before = Date.now();
		seeder.ensureSession("sess-1", "opencode");
		const after = Date.now();
		const row = db.queryOne<{
			created_at: number;
			updated_at: number;
		}>("SELECT created_at, updated_at FROM sessions WHERE id = ?", ["sess-1"]);
		expect(row?.created_at).toBeGreaterThanOrEqual(before);
		expect(row?.created_at).toBeLessThanOrEqual(after);
	});

	it("uses in-memory cache to skip redundant SQL", () => {
		seeder.ensureSession("sess-1", "opencode");
		db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);
		seeder.ensureSession("sess-1", "opencode");
		const row = db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeUndefined();
	});

	it("reset() clears the in-memory cache", () => {
		seeder.ensureSession("sess-1", "opencode");
		db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);
		seeder.reset();
		seeder.ensureSession("sess-1", "opencode");
		const row = db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeDefined();
	});
});
