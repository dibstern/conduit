import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("ProjectorCursorRepository", () => {
	let db: SqliteClient;
	let repo: ProjectorCursorRepository;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		repo = new ProjectorCursorRepository(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("get", () => {
		it("returns undefined for a non-existent projector", () => {
			expect(repo.get("unknown")).toBeUndefined();
		});

		it("returns the cursor after upsert", () => {
			repo.upsert("messages", 42);
			const cursor = repo.get("messages");
			expect(cursor).toBeDefined();
			expect(cursor?.projectorName).toBe("messages");
			expect(cursor?.lastAppliedSeq).toBe(42);
			expect(cursor?.updatedAt).toBeGreaterThan(0);
		});
	});

	describe("upsert", () => {
		it("inserts a new cursor row", () => {
			repo.upsert("sessions", 10);
			const cursor = repo.get("sessions");
			expect(cursor).toBeDefined();
			expect(cursor?.lastAppliedSeq).toBe(10);
		});

		it("advances the cursor when new seq is higher", () => {
			repo.upsert("sessions", 5);
			repo.upsert("sessions", 15);
			const cursor = repo.get("sessions");
			expect(cursor?.lastAppliedSeq).toBe(15);
		});

		it("does not regress the cursor when new seq is lower", () => {
			repo.upsert("sessions", 20);
			repo.upsert("sessions", 10);
			const cursor = repo.get("sessions");
			expect(cursor?.lastAppliedSeq).toBe(20);
		});
	});

	describe("listAll", () => {
		it("returns empty array when no cursors exist", () => {
			expect(repo.listAll()).toEqual([]);
		});

		it("returns all cursors sorted by name", () => {
			repo.upsert("turns", 3);
			repo.upsert("messages", 7);
			repo.upsert("sessions", 1);
			const all = repo.listAll();
			expect(all).toHaveLength(3);
			expect(all.map((c) => c.projectorName)).toEqual([
				"messages",
				"sessions",
				"turns",
			]);
		});
	});

	describe("minCursor", () => {
		it("returns 0 when no cursors exist", () => {
			expect(repo.minCursor()).toBe(0);
		});

		it("returns the minimum last_applied_seq across all projectors", () => {
			repo.upsert("sessions", 100);
			repo.upsert("messages", 50);
			repo.upsert("turns", 75);
			expect(repo.minCursor()).toBe(50);
		});
	});
});
