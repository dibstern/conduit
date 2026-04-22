import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { SessionSeeder } from "../../../src/lib/persistence/session-seeder.js";

describe("SessionSeeder", () => {
	let layer: PersistenceLayer;
	let seeder: SessionSeeder;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		seeder = new SessionSeeder(layer.db);
	});

	afterEach(() => {
		layer.close();
	});

	it("creates a session row that doesn't exist", () => {
		seeder.ensureSession("sess-1", "opencode");
		const row = layer.db.queryOne<{
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
		const rows = layer.db.query<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(rows).toHaveLength(1);
	});

	it("does not overwrite existing session data", () => {
		seeder.ensureSession("sess-1", "opencode");
		layer.db.execute("UPDATE sessions SET title = ? WHERE id = ?", [
			"Custom Title",
			"sess-1",
		]);
		seeder.ensureSession("sess-1", "opencode");
		const row = layer.db.queryOne<{ title: string }>(
			"SELECT title FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row?.title).toBe("Custom Title");
	});

	it("creates sessions with different providers", () => {
		seeder.ensureSession("sess-1", "opencode");
		seeder.ensureSession("sess-2", "claude");
		const rows = layer.db.query<{ id: string; provider: string }>(
			"SELECT id, provider FROM sessions ORDER BY id",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.provider).toBe("opencode");
		expect(rows[1]?.provider).toBe("claude");
	});

	it("sets created_at and updated_at to current time", () => {
		const before = Date.now();
		seeder.ensureSession("sess-1", "opencode");
		const after = Date.now();
		const row = layer.db.queryOne<{
			created_at: number;
			updated_at: number;
		}>("SELECT created_at, updated_at FROM sessions WHERE id = ?", ["sess-1"]);
		expect(row?.created_at).toBeGreaterThanOrEqual(before);
		expect(row?.created_at).toBeLessThanOrEqual(after);
	});

	it("uses in-memory cache to skip redundant SQL", () => {
		seeder.ensureSession("sess-1", "opencode");
		layer.db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);
		seeder.ensureSession("sess-1", "opencode");
		const row = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeUndefined();
	});

	it("reset() clears the in-memory cache", () => {
		seeder.ensureSession("sess-1", "opencode");
		layer.db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);
		seeder.reset();
		seeder.ensureSession("sess-1", "opencode");
		const row = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeDefined();
	});
});
