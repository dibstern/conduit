// test/unit/persistence/diagnostics.test.ts
// ─── PersistenceDiagnostics Tests (Task 22.5) ───────────────────────────────

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistenceDiagnostics } from "../../../src/lib/persistence/diagnostics.js";
import type { EventStore } from "../../../src/lib/persistence/event-store.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import type { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import {
	createTestHarness,
	FIXED_TEST_TIMESTAMP,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("PersistenceDiagnostics", () => {
	let harness: TestHarness;
	let db: SqliteClient;
	let eventStore: EventStore;
	let diagnostics: PersistenceDiagnostics;

	beforeEach(() => {
		harness = createTestHarness();
		db = harness.db;
		eventStore = harness.eventStore;
		diagnostics = new PersistenceDiagnostics(db);
	});

	afterEach(() => {
		harness.close();
	});

	describe("health()", () => {
		it("returns zeros on an empty database", () => {
			const health = diagnostics.health();

			expect(health.eventCount).toBe(0);
			expect(health.sessionCount).toBe(0);
			expect(health.projectorCursors).toHaveLength(0);
			expect(health.oldestEventSeq).toBeNull();
			expect(health.newestEventSeq).toBeNull();
		});

		it("returns correct event count and session count", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");

			eventStore.append(
				canonicalEvent(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Session 1",
						provider: "opencode",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP },
				),
			);

			eventStore.append(
				canonicalEvent(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP + 100 },
				),
			);

			eventStore.append(
				canonicalEvent(
					"session.created",
					"s2",
					{
						sessionId: "s2",
						title: "Session 2",
						provider: "opencode",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP + 200 },
				),
			);

			const health = diagnostics.health();
			expect(health.eventCount).toBe(3);
			expect(health.sessionCount).toBe(2);
		});

		it("returns correct event sequence range", () => {
			harness.seedSession("s1");

			eventStore.append(
				canonicalEvent(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP },
				),
			);

			eventStore.append(
				canonicalEvent(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP + 100 },
				),
			);

			eventStore.append(
				canonicalEvent(
					"message.created",
					"s1",
					{
						messageId: "m2",
						role: "user",
						sessionId: "s1",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP + 200 },
				),
			);

			const health = diagnostics.health();
			expect(health.oldestEventSeq).toBe(1);
			expect(health.newestEventSeq).toBe(3);
		});

		it("returns projector cursors when they exist", () => {
			const cursorRepo = new ProjectorCursorRepository(db);
			cursorRepo.upsert("session", 5);
			cursorRepo.upsert("message", 3);
			cursorRepo.upsert("activity", 5);

			const health = diagnostics.health();
			expect(health.projectorCursors).toHaveLength(3);

			// Sorted by name (ORDER BY projector_name)
			expect(health.projectorCursors[0]?.name).toBe("activity");
			expect(health.projectorCursors[0]?.lastAppliedSeq).toBe(5);
			expect(health.projectorCursors[1]?.name).toBe("message");
			expect(health.projectorCursors[1]?.lastAppliedSeq).toBe(3);
			expect(health.projectorCursors[2]?.name).toBe("session");
			expect(health.projectorCursors[2]?.lastAppliedSeq).toBe(5);
		});
	});

	describe("checkIntegrity()", () => {
		it("returns ok:true on a clean database", () => {
			const result = diagnostics.checkIntegrity();
			expect(result.ok).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("returns ok:true when data has valid foreign keys", () => {
			harness.seedSession("s1");

			eventStore.append(
				canonicalEvent(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					},
					{ createdAt: FIXED_TEST_TIMESTAMP },
				),
			);

			const result = diagnostics.checkIntegrity();
			expect(result.ok).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("detects foreign key violations", () => {
			// Temporarily disable FK enforcement to create an orphaned event
			db.execute("PRAGMA foreign_keys = OFF");
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
				 VALUES ('evt_orphan', 'nonexistent_session', 0, 'session.created', '{}', '{}', 'opencode', ${FIXED_TEST_TIMESTAMP})`,
			);
			db.execute("PRAGMA foreign_keys = ON");

			const result = diagnostics.checkIntegrity();
			expect(result.ok).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("foreign key violation");
		});
	});
});
