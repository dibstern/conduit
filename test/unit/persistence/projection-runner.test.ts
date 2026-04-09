// test/unit/persistence/projection-runner.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "../../../src/lib/persistence/event-store.js";
import {
	createEventId,
	type MessageCreatedPayload,
	type PermissionAskedPayload,
	type SessionCreatedPayload,
	type SessionProviderChangedPayload,
	type StoredEvent,
	type TextDeltaPayload,
	type ToolStartedPayload,
	type TurnCompletedPayload,
} from "../../../src/lib/persistence/events.js";
import {
	createAllProjectors,
	ProjectionRunner,
} from "../../../src/lib/persistence/projection-runner.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import type { Projector } from "../../../src/lib/persistence/projectors/projector.js";
import type { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import {
	createTestHarness,
	FIXED_TEST_TIMESTAMP,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

function makeCanonical<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	createdAt: number = Date.now(),
): {
	eventId: string;
	sessionId: string;
	type: T;
	data: typeof data;
	metadata: Record<string, never>;
	provider: string;
	createdAt: number;
} {
	return {
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	};
}

describe("ProjectionRunner", () => {
	let harness: TestHarness;
	let db: SqliteClient;
	let eventStore: EventStore;
	let cursorRepo: ProjectorCursorRepository;
	let runner: ProjectionRunner;
	const now = FIXED_TEST_TIMESTAMP;

	beforeEach(() => {
		harness = createTestHarness();
		db = harness.db;
		eventStore = harness.eventStore;
		cursorRepo = new ProjectorCursorRepository(db);
		runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});
	});

	afterEach(() => {
		harness.close();
	});

	describe("createAllProjectors", () => {
		it("returns all 6 projectors", () => {
			const projectors = createAllProjectors();
			expect(projectors).toHaveLength(6);

			const names = projectors.map((p) => p.name);
			expect(names).toContain("session");
			expect(names).toContain("message");
			expect(names).toContain("turn");
			expect(names).toContain("provider");
			expect(names).toContain("approval");
			expect(names).toContain("activity");
		});

		it("returns projectors implementing the Projector interface", () => {
			const projectors = createAllProjectors();
			for (const p of projectors) {
				expect(p.name).toBeDefined();
				expect(p.handles).toBeDefined();
				expect(typeof p.project).toBe("function");
			}
		});
	});

	describe("projectEvent", () => {
		it("throws if called before recover()", () => {
			harness.seedSession("s1");
			const sessionEvent = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test Session",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			expect(() => runner.projectEvent(sessionEvent)).toThrow(/recover/);
		});

		it("runs matching projectors for an event and updates cursors", () => {
			// Call recover on empty store to set _recovered = true
			runner.recover();

			harness.seedSession("s1");
			const sessionEvent = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test Session",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			runner.projectEvent(sessionEvent);

			// Verify session projection was written (UPSERT updates the seeded row)
			const session = db.queryOne<{ id: string; title: string }>(
				"SELECT id, title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session).toBeDefined();
			expect(session?.title).toBe("Test Session");

			// Verify provider projection was written (session.created also handled by provider projector)
			const providers = db.query<{
				session_id: string;
				provider: string;
			}>(
				"SELECT session_id, provider FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(providers).toHaveLength(1);
			expect(providers[0]?.provider).toBe("opencode");

			// Verify cursors were updated for projectors that handled the event
			const cursors = cursorRepo.listAll();
			const sessionCursor = cursors.find((c) => c.projectorName === "session");
			const providerCursor = cursors.find(
				(c) => c.projectorName === "provider",
			);
			expect(sessionCursor).toBeDefined();
			expect(sessionCursor?.lastAppliedSeq).toBe(sessionEvent.sequence);
			expect(providerCursor).toBeDefined();
			expect(providerCursor?.lastAppliedSeq).toBe(sessionEvent.sequence);
		});

		it("only runs projectors that handle the event type", () => {
			runner.recover();

			harness.seedSession("s1");
			const sessionEvent = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);
			runner.projectEvent(sessionEvent);

			// text.delta — handled by message projector, not approval projector
			const msgEvent = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);
			runner.projectEvent(msgEvent);

			const deltaEvent = eventStore.append(
				makeCanonical(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "Hello",
					} satisfies TextDeltaPayload,
					now + 200,
				),
			);
			runner.projectEvent(deltaEvent);

			// Message projector cursor should have advanced (it handles text.delta)
			const messageCursor = cursorRepo
				.listAll()
				.find((c) => c.projectorName === "message");
			expect(messageCursor?.lastAppliedSeq).toBe(deltaEvent.sequence);

			// Verify the text was written to the message_parts table
			const parts = db.query<{ id: string; text: string }>(
				"SELECT id, text FROM message_parts WHERE message_id = ? AND type = 'text'",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]?.text).toBe("Hello");
		});

		it("fault-isolates projectors — one failure does not block others (A4)", () => {
			runner.recover();

			harness.seedSession("s1");
			const sessionEvent = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);
			runner.projectEvent(sessionEvent);

			// Create a runner that includes a failing projector
			const failingProjector: Projector = {
				name: "failing",
				handles: ["tool.started"],
				project: () => {
					throw new Error("projector explosion");
				},
			};

			const failingRunner = new ProjectionRunner({
				db,
				eventStore,
				cursorRepo,
				projectors: [...createAllProjectors(), failingProjector],
			});
			failingRunner.markRecovered();

			// Seed a message so the tool event has context
			const msgEvent = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);
			failingRunner.projectEvent(msgEvent);

			// tool.started is handled by the failing projector AND other projectors
			// (message, activity). With A4 fault isolation, the failing projector
			// should not block the message/activity projectors.
			const toolEvent = eventStore.append(
				makeCanonical(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						toolName: "bash",
						callId: "c1",
						input: { command: "ls" },
					} satisfies ToolStartedPayload,
					now + 200,
				),
			);

			// Should NOT throw (fault isolation catches the error)
			failingRunner.projectEvent(toolEvent);

			// The message projector should have still projected the tool part
			const parts = db.query<{ id: string; type: string }>(
				"SELECT id, type FROM message_parts WHERE message_id = ? AND type = 'tool'",
				["m1"],
			);
			expect(parts).toHaveLength(1);

			// Activity projector should have still projected
			const activities = db.query<{ kind: string }>(
				"SELECT kind FROM activities WHERE kind = 'tool.started'",
				[],
			);
			expect(activities).toHaveLength(1);

			// The failure should be recorded
			const failures = failingRunner.getFailures();
			expect(failures).toHaveLength(1);
			expect(failures[0]?.projectorName).toBe("failing");
			expect(failures[0]?.error).toBe("projector explosion");
		});
	});

	describe("projectBatch", () => {
		it("throws if called before recover()", () => {
			harness.seedSession("s1");
			const ev = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);
			expect(() => runner.projectBatch([ev])).toThrow(/recover/);
		});

		it("projects multiple events atomically", () => {
			runner.recover();

			harness.seedSession("s1");
			const ev1 = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Batch Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			const ev2 = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);

			runner.projectBatch([ev1, ev2]);

			// Both projections should be written
			const session = db.queryOne<{ title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session?.title).toBe("Batch Test");

			const messages = db.query<{ id: string }>(
				"SELECT id FROM messages WHERE session_id = ?",
				["s1"],
			);
			expect(messages).toHaveLength(1);

			// All cursors should be at the last event's sequence
			const cursors = cursorRepo.listAll();
			for (const cursor of cursors) {
				expect(cursor.lastAppliedSeq).toBe(ev2.sequence);
			}
		});

		it("rolls back all projections on failure (atomicity)", () => {
			runner.recover();

			harness.seedSession("s1");
			// Seed the session via projection
			const seedEvent = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);
			runner.projectEvent(seedEvent);

			// Create a runner with a failing projector that handles tool.started
			const failingProjector: Projector = {
				name: "failing",
				handles: ["tool.started"],
				project: () => {
					throw new Error("batch explosion");
				},
			};

			const failingRunner = new ProjectionRunner({
				db,
				eventStore,
				cursorRepo,
				projectors: [...createAllProjectors(), failingProjector],
			});
			failingRunner.markRecovered();

			// Seed a message via the failing runner
			const msgEvent = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);
			failingRunner.projectEvent(msgEvent);

			// Now batch: message.created + tool.started — the tool.started triggers
			// the failing projector, which should roll back the ENTIRE batch
			const ev1 = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m2",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 200,
				),
			);

			const ev2 = eventStore.append(
				makeCanonical(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						toolName: "bash",
						callId: "c1",
						input: { command: "ls" },
					} satisfies ToolStartedPayload,
					now + 300,
				),
			);

			expect(() => failingRunner.projectBatch([ev1, ev2])).toThrow(
				"batch explosion",
			);

			// m2 should NOT exist (transaction rolled back)
			const m2 = db.queryOne<{ id: string }>(
				"SELECT id FROM messages WHERE id = ?",
				["m2"],
			);
			expect(m2).toBeUndefined();
		});

		it("is a no-op for empty events array", () => {
			// Should not throw even before recovery
			runner.projectBatch([]);
		});
	});

	describe("recover", () => {
		it("replays events from the minimum cursor position", () => {
			harness.seedSession("s1");

			// Manually append events to the store (simulate previous session)
			eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Recovery Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);

			eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m2",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 200,
				),
			);

			// No cursors exist — recover should replay all events
			const result = runner.recover();
			expect(result.totalReplayed).toBeGreaterThan(0);
			expect(result.batchCount).toBeGreaterThanOrEqual(1);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.projectorCursors.length).toBeGreaterThan(0);

			// Verify projections are populated
			const session = db.queryOne<{ title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session?.title).toBe("Recovery Test");

			const messages = db.query<{ id: string }>(
				"SELECT id FROM messages WHERE session_id = ?",
				["s1"],
			);
			expect(messages).toHaveLength(2);
		});

		it("replays only events after the minimum cursor", () => {
			harness.seedSession("s1");

			// Append first event and project it via recover
			eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			// Recover to project ev1 and set all cursors to seq 1
			runner.recover();

			// Now append a second event AFTER recovery
			eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);

			// Create a NEW runner to simulate restart — cursors are at seq 1
			// but event store has seq 1 and seq 2
			const runner2 = new ProjectionRunner({
				db,
				eventStore,
				cursorRepo,
				projectors: createAllProjectors(),
			});

			// Now recover — should only replay ev2 (since cursors are at ev1)
			const result = runner2.recover();
			// message.created is handled by session, message, and turn projectors
			expect(result.totalReplayed).toBeGreaterThan(0);
		});

		it("returns 0 when all events are already projected", () => {
			harness.seedSession("s1");

			eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			// Recover once to project all events
			runner.recover();

			// Create a new runner and recover again — should be 0
			const runner2 = new ProjectionRunner({
				db,
				eventStore,
				cursorRepo,
				projectors: createAllProjectors(),
			});
			const result = runner2.recover();
			expect(result.totalReplayed).toBe(0);
		});

		it("returns 0 when the event store is empty", () => {
			const result = runner.recover();
			expect(result.totalReplayed).toBe(0);
		});

		it("sets isRecovered to true after recovery", () => {
			expect(runner.isRecovered).toBe(false);
			runner.recover();
			expect(runner.isRecovered).toBe(true);
		});
	});

	describe("per-projector recovery", () => {
		it("only replays events for lagging projectors via recoverLagging", () => {
			harness.seedSession("s1");

			eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			eventStore.append(
				makeCanonical(
					"permission.asked",
					"s1",
					{
						id: "perm-1",
						sessionId: "s1",
						toolName: "bash",
						input: { command: "ls" },
					} satisfies PermissionAskedPayload,
					now + 100,
				),
			);

			// Recover — all projectors should catch up
			runner.recover();

			// Now add more events
			eventStore.append(
				makeCanonical(
					"permission.asked",
					"s1",
					{
						id: "perm-2",
						sessionId: "s1",
						toolName: "edit",
						input: { file: "test.ts" },
					} satisfies PermissionAskedPayload,
					now + 200,
				),
			);

			// Use recoverLagging to only recover the approval projector
			const result = runner.recoverLagging(["approval"]);
			expect(result.totalReplayed).toBeGreaterThan(0);

			// The new approval should be projected
			const approvals = db.query<{ id: string }>(
				"SELECT id FROM pending_approvals WHERE session_id = ?",
				["s1"],
			);
			expect(approvals).toHaveLength(2);
		});
	});

	describe("markRecovered", () => {
		it("allows projectEvent to work without calling recover()", () => {
			runner.markRecovered();

			harness.seedSession("s1");
			const ev = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Test",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);

			expect(() => runner.projectEvent(ev)).not.toThrow();
		});
	});

	describe("full integration lifecycle", () => {
		it("projects a complete session lifecycle through all projectors", () => {
			runner.recover();

			harness.seedSession("s1");

			// 1. Session created
			const ev1 = eventStore.append(
				makeCanonical(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Full Lifecycle",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					now,
				),
			);
			runner.projectEvent(ev1);

			// 2. User message (creates turn)
			const ev2 = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "user_m1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 100,
				),
			);
			runner.projectEvent(ev2);

			// 3. Assistant message
			const ev3 = eventStore.append(
				makeCanonical(
					"message.created",
					"s1",
					{
						messageId: "asst_m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					now + 200,
				),
			);
			runner.projectEvent(ev3);

			// 4. Tool started
			const ev4 = eventStore.append(
				makeCanonical(
					"tool.started",
					"s1",
					{
						messageId: "asst_m1",
						partId: "tool_p1",
						toolName: "bash",
						callId: "c1",
						input: { command: "ls" },
					} satisfies ToolStartedPayload,
					now + 300,
				),
			);
			runner.projectEvent(ev4);

			// 5. Permission asked
			const ev5 = eventStore.append(
				makeCanonical(
					"permission.asked",
					"s1",
					{
						id: "perm-1",
						sessionId: "s1",
						toolName: "bash",
						input: { command: "ls" },
					} satisfies PermissionAskedPayload,
					now + 400,
				),
			);
			runner.projectEvent(ev5);

			// 6. Turn completed
			const ev6 = eventStore.append(
				makeCanonical(
					"turn.completed",
					"s1",
					{
						messageId: "asst_m1",
						cost: 0.05,
						tokens: { input: 1000, output: 500 },
					} satisfies TurnCompletedPayload,
					now + 5000,
				),
			);
			runner.projectEvent(ev6);

			// 7. Provider changed
			const ev7 = eventStore.append(
				makeCanonical(
					"session.provider_changed",
					"s1",
					{
						sessionId: "s1",
						oldProvider: "opencode",
						newProvider: "claude-sdk",
					} satisfies SessionProviderChangedPayload,
					now + 6000,
				),
			);
			runner.projectEvent(ev7);

			// ── Verify all projections ──

			// Sessions
			const session = db.queryOne<{ title: string; provider: string }>(
				"SELECT title, provider FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session?.title).toBe("Full Lifecycle");
			expect(session?.provider).toBe("claude-sdk");

			// Messages
			const messages = db.query<{ id: string; role: string }>(
				"SELECT id, role FROM messages WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			expect(messages).toHaveLength(2);
			expect(messages[0]?.role).toBe("user");
			expect(messages[1]?.role).toBe("assistant");

			// Turns
			const turns = db.query<{ id: string; state: string }>(
				"SELECT id, state FROM turns WHERE session_id = ?",
				["s1"],
			);
			expect(turns).toHaveLength(1);
			expect(turns[0]?.state).toBe("completed");

			// Providers
			const providers = db.query<{ provider: string; status: string }>(
				"SELECT provider, status FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(providers).toHaveLength(2);
			expect(providers[0]?.provider).toBe("opencode");
			expect(providers[0]?.status).toBe("stopped");
			expect(providers[1]?.provider).toBe("claude-sdk");
			expect(providers[1]?.status).toBe("active");

			// Approvals
			const approvals = db.query<{ type: string; status: string }>(
				"SELECT type, status FROM pending_approvals WHERE session_id = ?",
				["s1"],
			);
			expect(approvals).toHaveLength(1);
			expect(approvals[0]?.type).toBe("permission");

			// Activities
			const activities = db.query<{ kind: string }>(
				"SELECT kind FROM activities WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			// ActivityProjector handles: tool.started, tool.running, tool.completed,
			// permission.asked, permission.resolved, question.asked, question.resolved, turn.error.
			// In our lifecycle: tool.started + permission.asked = 2 activities.
			expect(activities.length).toBeGreaterThanOrEqual(2);
			const kinds = activities.map((a) => a.kind);
			expect(kinds).toContain("tool.started");
			expect(kinds).toContain("permission.asked");

			// Cursors — all projectors that handled at least one event should have a cursor
			const cursors = cursorRepo.listAll();
			expect(cursors.length).toBeGreaterThan(0);
			for (const cursor of cursors) {
				expect(cursor.lastAppliedSeq).toBeGreaterThan(0);
			}
		});
	});
});
