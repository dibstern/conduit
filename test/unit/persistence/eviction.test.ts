import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStoreEviction } from "../../../src/lib/persistence/eviction.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("EventStoreEviction", () => {
	let db: SqliteClient;
	let eviction: EventStoreEviction;
	const now = Date.now();
	const oneWeekAgo = now - 8 * 24 * 60 * 60 * 1000;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eviction = new EventStoreEviction(db);
	});

	afterEach(() => {
		db?.close();
	});

	function seedSession(id: string, status: string, updatedAt: number): void {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[id, "opencode", "Test", status, updatedAt, updatedAt],
		);
	}

	function seedEvents(sessionId: string, count: number): void {
		for (let i = 0; i < count; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, ?, ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${sessionId}-${i}`, sessionId, i, now],
			);
		}
	}

	// ─── evictSync ───────────────────────────────────────────────────────────

	it("evicts events from idle sessions older than retention period", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedSession("recent-idle", "idle", now);
		seedEvents("old-idle", 100);
		seedEvents("recent-idle", 50);

		const result = eviction.evictSync();

		expect(result.eventsDeleted).toBe(100);
		const remaining = db.query(
			"SELECT * FROM events WHERE session_id = 'recent-idle'",
		);
		expect(remaining).toHaveLength(50);
	});

	it("does not evict events from busy sessions", () => {
		seedSession("old-busy", "busy", oneWeekAgo);
		seedEvents("old-busy", 100);

		const result = eviction.evictSync();
		expect(result.eventsDeleted).toBe(0);
	});

	it("batches large deletes across multiple passes", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 12000);

		const result = eviction.evictSync({ batchSize: 5000 });

		expect(result.eventsDeleted).toBe(12000);
		expect(result.batchesExecuted).toBeGreaterThan(1);
	});

	it("returns zero eventsDeleted when there is nothing to evict", () => {
		seedSession("recent-idle", "idle", now);
		seedEvents("recent-idle", 50);

		const result = eviction.evictSync();
		expect(result.eventsDeleted).toBe(0);
		expect(result.receiptsDeleted).toBe(0);
	});

	// ─── evictAsync ──────────────────────────────────────────────────────────

	it("evictAsync yields between full batches", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 190);

		let yieldCount = 0;
		const result = await eviction.evictAsync({
			batchSize: 50,
			onYield: () => {
				yieldCount++;
			},
		});

		// 3 full batches of 50 (each triggers a yield), then 1 partial batch of 40
		expect(result.eventsDeleted).toBe(190);
		expect(result.batchesExecuted).toBe(4);
		expect(yieldCount).toBe(3);
	});

	it("handles exactly-divisible batch counts correctly", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 100);

		const result = await eviction.evictAsync({ batchSize: 50 });

		// 2 full batches + 1 empty batch to confirm no more rows
		expect(result.eventsDeleted).toBe(100);
		expect(result.batchesExecuted).toBe(3);
	});

	// ─── command_receipts ────────────────────────────────────────────────────

	it("cleans up command_receipts older than retention period", () => {
		seedSession("s1", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old", "s1", "accepted", oneWeekAgo],
		);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent", "s1", "accepted", now],
		);

		const result = eviction.evictSync();

		const remaining = db.query("SELECT * FROM command_receipts");
		expect(remaining).toHaveLength(1);
		expect(result.receiptsDeleted).toBe(1);
	});

	it("receipt eviction is time-based, independent of event eviction", () => {
		// old session with a recent receipt
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 10);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent-for-old", "old-idle", "accepted", now],
		);

		// recent session with an old receipt
		seedSession("recent", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old-for-recent", "recent", "accepted", oneWeekAgo],
		);

		eviction.evictSync();

		// old session events evicted; old receipt evicted; recent receipt kept
		const receipts = db.query<{ command_id: string }>(
			"SELECT command_id FROM command_receipts",
		);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]!.command_id).toBe("cmd-recent-for-old");
	});

	// ─── cascadeProjections ──────────────────────────────────────────────────

	it("cascades projection rows for sessions with zero remaining events", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		// No events seeded — already zero

		const cascaded = eviction.cascadeProjections();

		expect(cascaded).toBe(1);
		const sessions = db.query("SELECT * FROM sessions WHERE id = 'old-idle'");
		expect(sessions).toHaveLength(0);
	});

	it("does not cascade sessions that still have events", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 5);

		const cascaded = eviction.cascadeProjections();

		// Events remain, so session is NOT cascaded
		expect(cascaded).toBe(0);
		const sessions = db.query("SELECT * FROM sessions WHERE id = 'old-idle'");
		expect(sessions).toHaveLength(1);
	});

	it("does not cascade recent sessions even if they have zero events", () => {
		seedSession("recent-idle", "idle", now);
		// No events seeded

		const cascaded = eviction.cascadeProjections();

		// Session is too new (< 7 days)
		expect(cascaded).toBe(0);
		const sessions = db.query(
			"SELECT * FROM sessions WHERE id = 'recent-idle'",
		);
		expect(sessions).toHaveLength(1);
	});

	it("cascadeProjections after evictSync removes fully-evicted sessions", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 20);

		// Step 1: evict events
		const evictResult = eviction.evictSync();
		expect(evictResult.eventsDeleted).toBe(20);

		// Step 2: cascade projections
		const cascaded = eviction.cascadeProjections();
		expect(cascaded).toBe(1);

		const sessions = db.query("SELECT * FROM sessions WHERE id = 'old-idle'");
		expect(sessions).toHaveLength(0);
	});
});
