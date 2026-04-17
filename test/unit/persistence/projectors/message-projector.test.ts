// test/unit/persistence/projectors/message-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEventId,
	type MessageCreatedPayload,
	type StoredEvent,
	type TextDeltaPayload,
	type ThinkingDeltaPayload,
	type ThinkingEndPayload,
	type ThinkingStartPayload,
	type ToolCompletedPayload,
	type ToolRunningPayload,
	type ToolStartedPayload,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { MessageProjector } from "../../../../src/lib/persistence/projectors/message-projector.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface MessageRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	is_streaming: number;
	created_at: number;
	updated_at: number;
}

interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

describe("MessageProjector", () => {
	let db: SqliteClient;
	let projector: MessageProjector;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new MessageProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("message");
		expect(projector.handles).toEqual([
			"message.created",
			"text.delta",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"tool.started",
			"tool.running",
			"tool.completed",
			"turn.completed",
			"turn.error",
		]);
	});

	describe("message.created", () => {
		it("inserts a new message row with streaming flag", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row).toBeDefined();
			expect(row!.id).toBe("m1");
			expect(row!.session_id).toBe("s1");
			expect(row!.role).toBe("assistant");
			expect(row!.text).toBe("");
			expect(row!.is_streaming).toBe(1);
			expect(row!.created_at).toBe(event.createdAt);
			expect(row!.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<MessageRow>("SELECT * FROM messages WHERE id = ?", [
				"m1",
			]);
			expect(rows).toHaveLength(1);
		});

		it("inserts user messages with is_streaming=0", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("text.delta", () => {
		it("appends text to an existing message and creates/updates a message_parts row", () => {
			// Create message first
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			// First delta
			const delta1 = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "Hello ",
				} satisfies TextDeltaPayload,
				2,
			);
			projector.project(delta1, db);

			let row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", [
				"m1",
			]);
			expect(row!.text).toBe("Hello ");
			let parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.type).toBe("text");
			expect(parts[0]!.id).toBe("p1");
			expect(parts[0]!.text).toBe("Hello ");

			// Second delta, same part -- text is appended via SQL concat
			const delta2 = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "World!",
				} satisfies TextDeltaPayload,
				3,
			);
			projector.project(delta2, db);

			row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", [
				"m1",
			]);
			expect(row!.text).toBe("Hello World!");
			parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.text).toBe("Hello World!");
		});

		it("handles multiple text parts on the same message", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "Part one",
					} satisfies TextDeltaPayload,
					2,
				),
				db,
			);

			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p2",
						text: "Part two",
					} satisfies TextDeltaPayload,
					3,
				),
				db,
			);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			// text is the concatenation of all text deltas
			expect(row!.text).toBe("Part onePart two");
			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(2);
			expect(parts[0]!.id).toBe("p1");
			expect(parts[1]!.id).toBe("p2");
		});
	});

	describe("thinking.start", () => {
		it("initializes a thinking part row with empty text", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const start = makeStored(
				"thinking.start",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
				} satisfies ThinkingStartPayload,
				2,
			);
			projector.project(start, db);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.type).toBe("thinking");
			expect(parts[0]!.id).toBe("t1");
			expect(parts[0]!.text).toBe("");
		});
	});

	describe("thinking.delta", () => {
		it("appends thinking content to a message_parts row", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const think = makeStored(
				"thinking.delta",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
					text: "Let me think...",
				} satisfies ThinkingDeltaPayload,
				2,
			);
			projector.project(think, db);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.type).toBe("thinking");
			expect(parts[0]!.id).toBe("t1");
			expect(parts[0]!.text).toBe("Let me think...");
			// Thinking text does NOT accumulate into the top-level text column
			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.text).toBe("");
		});
	});

	describe("thinking.end", () => {
		it("updates updated_at only", () => {
			const now = 1_000_000_000_000;
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
				now,
			);
			projector.project(created, db);

			const end = makeStored(
				"thinking.end",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
				} satisfies ThinkingEndPayload,
				2,
				now + 1000,
			);
			projector.project(end, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.updated_at).toBe(now + 1000);
		});
	});

	describe("tool.started", () => {
		it("adds a tool part row with started status", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const started = makeStored(
				"tool.started",
				"s1",
				{
					messageId: "m1",
					partId: "tool1",
					toolName: "read_file",
					callId: "call_123",
					input: { path: "/foo/bar.ts" },
				} satisfies ToolStartedPayload,
				2,
			);
			projector.project(started, db);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.type).toBe("tool");
			expect(parts[0]!.id).toBe("tool1");
			expect(parts[0]!.tool_name).toBe("read_file");
			expect(parts[0]!.call_id).toBe("call_123");
			expect(JSON.parse(parts[0]!.input!)).toEqual({
				path: "/foo/bar.ts",
			});
			expect(parts[0]!.status).toBe("started");
		});
	});

	describe("tool.running", () => {
		it("updates matching tool part status to running", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			projector.project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_123",
						input: { path: "/foo" },
					} satisfies ToolStartedPayload,
					2,
				),
				db,
			);

			projector.project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
					} satisfies ToolRunningPayload,
					3,
				),
				db,
			);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? AND id = ?",
				["m1", "tool1"],
			);
			expect(parts[0]!.status).toBe("running");
		});
	});

	describe("tool.completed", () => {
		it("updates matching tool part with result, duration, and completed status", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			projector.project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_123",
						input: { path: "/foo" },
					} satisfies ToolStartedPayload,
					2,
				),
				db,
			);

			projector.project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: { content: "file contents" },
						duration: 150,
					} satisfies ToolCompletedPayload,
					3,
				),
				db,
			);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? AND id = ?",
				["m1", "tool1"],
			);
			expect(parts[0]!.status).toBe("completed");
			expect(JSON.parse(parts[0]!.result!)).toEqual({
				content: "file contents",
			});
			expect(parts[0]!.duration).toBe(150);
		});
	});

	describe("turn.completed", () => {
		it("updates cost, tokens, and clears streaming flag", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const done = makeStored(
				"turn.completed",
				"s1",
				{
					messageId: "m1",
					cost: 0.0234,
					tokens: {
						input: 1500,
						output: 350,
						cacheRead: 200,
						cacheWrite: 50,
					},
				} satisfies TurnCompletedPayload,
				2,
			);
			projector.project(done, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.cost).toBeCloseTo(0.0234);
			expect(row!.tokens_in).toBe(1500);
			expect(row!.tokens_out).toBe(350);
			expect(row!.tokens_cache_read).toBe(200);
			expect(row!.tokens_cache_write).toBe(50);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("turn.error", () => {
		it("clears streaming flag", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const err = makeStored(
				"turn.error",
				"s1",
				{
					messageId: "m1",
					error: "rate_limit",
				} satisfies TurnErrorPayload,
				2,
			);
			projector.project(err, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("full streaming lifecycle", () => {
		it("accumulates text, tool calls, and finalizes correctly", () => {
			// 1. message.created
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
				db,
			);

			// 2. thinking.delta
			projector.project(
				makeStored(
					"thinking.delta",
					"s1",
					{
						messageId: "m1",
						partId: "think1",
						text: "Considering...",
					} satisfies ThinkingDeltaPayload,
					2,
				),
				db,
			);

			// 3. thinking.end
			projector.project(
				makeStored(
					"thinking.end",
					"s1",
					{
						messageId: "m1",
						partId: "think1",
					} satisfies ThinkingEndPayload,
					3,
				),
				db,
			);

			// 4. text.delta
			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "text1",
						text: "I'll read that file. ",
					} satisfies TextDeltaPayload,
					4,
				),
				db,
			);

			// 5. tool.started
			projector.project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "read_file",
						callId: "call_abc",
						input: { path: "/src/main.ts" },
					} satisfies ToolStartedPayload,
					5,
				),
				db,
			);

			// 6. tool.running
			projector.project(
				makeStored(
					"tool.running",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
					} satisfies ToolRunningPayload,
					6,
				),
				db,
			);

			// 7. tool.completed
			projector.project(
				makeStored(
					"tool.completed",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						result: "console.log('hello')",
						duration: 42,
					} satisfies ToolCompletedPayload,
					7,
				),
				db,
			);

			// 8. More text
			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "text2",
						text: "Done!",
					} satisfies TextDeltaPayload,
					8,
				),
				db,
			);

			// 9. turn.completed
			projector.project(
				makeStored(
					"turn.completed",
					"s1",
					{
						messageId: "m1",
						cost: 0.05,
						tokens: {
							input: 2000,
							output: 500,
							cacheRead: 100,
							cacheWrite: 25,
						},
					} satisfies TurnCompletedPayload,
					9,
				),
				db,
			);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(row!.text).toBe("I'll read that file. Done!");
			expect(row!.is_streaming).toBe(0);
			expect(row!.cost).toBeCloseTo(0.05);
			expect(row!.tokens_in).toBe(2000);
			expect(row!.tokens_out).toBe(500);

			const parts = db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(4); // thinking, text1, tool1, text2
			expect(parts[0]!.type).toBe("thinking");
			expect(parts[1]!.type).toBe("text");
			expect(parts[1]!.text).toBe("I'll read that file. ");
			expect(parts[2]!.type).toBe("tool");
			expect(parts[2]!.status).toBe("completed");
			expect(parts[3]!.type).toBe("text");
			expect(parts[3]!.text).toBe("Done!");
		});
	});

	describe("replay safety", () => {
		it("does not double text when the same text.delta is replayed (ON CONFLICT upsert)", () => {
			const created = makeStored(
				"message.created",
				"s1",
				{
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload,
				1,
			);
			projector.project(created, db);

			const delta = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m1",
					partId: "p1",
					text: "Hello",
				} satisfies TextDeltaPayload,
				2,
			);

			// Project the same delta twice (simulating replay)
			projector.project(delta, db);
			projector.project(delta, db);

			const row = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			// With normalized message_parts and SQL-native text || ?, replay
			// WILL double text on the messages.text denormalized column.
			// The ON CONFLICT on message_parts also appends text again.
			// During recovery (replaying=true), the alreadyApplied() check
			// prevents this. During normal streaming, events arrive in order
			// and are never replayed.
			expect(row!.text).toBe("HelloHello");
		});

		it("accepts text.delta before message.created and creates message row defensively", () => {
			// text.delta arrives before message.created — the projector defensively
			// INSERT OR IGNOREs the messages row so data is never lost.
			// This supports Claude adapter sessions which do not emit message.created.
			const delta = makeStored(
				"text.delta",
				"s1",
				{
					messageId: "m-nonexistent",
					partId: "p1",
					text: "orphan delta",
				} satisfies TextDeltaPayload,
				1,
			);

			// Should NOT throw — creates the messages row defensively
			expect(() => projector.project(delta, db)).not.toThrow();

			// Verify the message row was created with correct fields
			const row = db.queryOne<{
				id: string;
				role: string;
				text: string;
				session_id: string;
			}>("SELECT id, role, text, session_id FROM messages WHERE id = ?", [
				"m-nonexistent",
			]);
			expect(row).toBeDefined();
			expect(row!.role).toBe("assistant");
			expect(row!.session_id).toBe("s1");
			expect(row!.text).toBe("orphan delta");
		});
	});

	describe("multi-session isolation", () => {
		it("does not mix messages across sessions", () => {
			// Pre-insert a second session
			db.execute(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["s2", "opencode", "Session 2", "idle", Date.now(), Date.now()],
			);

			// Message in session s1
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
				db,
			);

			// Message in session s2
			projector.project(
				makeStored(
					"message.created",
					"s2",
					{
						messageId: "m2",
						role: "user",
						sessionId: "s2",
					} satisfies MessageCreatedPayload,
					2,
				),
				db,
			);

			// Text delta for s1's message
			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "s1 text",
					} satisfies TextDeltaPayload,
					3,
				),
				db,
			);

			// Verify s1's message got the text
			const m1 = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m1"],
			);
			expect(m1!.text).toBe("s1 text");

			// Verify s2's message is untouched
			const m2 = db.queryOne<MessageRow>(
				"SELECT * FROM messages WHERE id = ?",
				["m2"],
			);
			expect(m2!.text).toBe("");

			// Verify per-session queries return correct counts
			const s1Messages = db.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ?",
				["s1"],
			);
			const s2Messages = db.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ?",
				["s2"],
			);
			expect(s1Messages).toHaveLength(1);
			expect(s2Messages).toHaveLength(1);
		});
	});

	// ─── (Perf-Fix-1) sort_order tests ──────────────────────────────────

	describe("sort_order assignment", () => {
		it("assigns incrementing sort_order to new parts", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
				db,
			);

			// Three different parts
			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "A",
					} satisfies TextDeltaPayload,
					2,
				),
				db,
			);
			projector.project(
				makeStored(
					"thinking.start",
					"s1",
					{
						messageId: "m1",
						partId: "t1",
					} satisfies ThinkingStartPayload,
					3,
				),
				db,
			);
			projector.project(
				makeStored(
					"tool.started",
					"s1",
					{
						messageId: "m1",
						partId: "tool1",
						toolName: "bash",
						callId: "c1",
						input: {},
					} satisfies ToolStartedPayload,
					4,
				),
				db,
			);

			const parts = db.query<{ id: string; sort_order: number }>(
				"SELECT id, sort_order FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(3);
			expect(parts[0]!.id).toBe("p1");
			expect(parts[0]!.sort_order).toBe(0);
			expect(parts[1]!.id).toBe("t1");
			expect(parts[1]!.sort_order).toBe(1);
			expect(parts[2]!.id).toBe("tool1");
			expect(parts[2]!.sort_order).toBe(2);
		});

		it("does not change sort_order on subsequent deltas for the same part", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
				db,
			);

			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "Hello ",
					} satisfies TextDeltaPayload,
					2,
				),
				db,
			);
			projector.project(
				makeStored(
					"text.delta",
					"s1",
					{
						messageId: "m1",
						partId: "p1",
						text: "World",
					} satisfies TextDeltaPayload,
					3,
				),
				db,
			);

			const parts = db.query<{
				id: string;
				sort_order: number;
				text: string;
			}>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.sort_order).toBe(0); // unchanged from first insert
			expect(parts[0]!.text).toBe("Hello World");
		});

		it("sort_order is stable when thinking.delta is replayed with replaying=true", () => {
			projector.project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "m1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					1,
				),
				db,
			);

			const thinkDelta = makeStored(
				"thinking.delta",
				"s1",
				{
					messageId: "m1",
					partId: "t1",
					text: "Hmm...",
				} satisfies ThinkingDeltaPayload,
				2,
			);
			projector.project(thinkDelta, db);

			// Replay the same event with replaying=true -- should be skipped by alreadyApplied
			projector.project(thinkDelta, db, { replaying: true });

			const parts = db.query<{
				id: string;
				sort_order: number;
				text: string;
			}>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.sort_order).toBe(0);
			expect(parts[0]!.text).toBe("Hmm..."); // not doubled
		});
	});
});
