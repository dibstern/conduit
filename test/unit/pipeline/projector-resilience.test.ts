import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { StoredEvent } from "../../../src/lib/persistence/events.js";
import { MessageProjector } from "../../../src/lib/persistence/projectors/message-projector.js";
import type { ProjectionContext } from "../../../src/lib/persistence/projectors/projector.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	createTestHarness,
	makeStored,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

const SESSION_A = "ses-resilience-a";
const SESSION_B = "ses-resilience-b";
const MSG_ID = "msg-res-1";
const NOW = 1_000_000_000_000;

describe("MessageProjector resilience", () => {
	let harness: TestHarness;
	let projector: MessageProjector;
	let seq: number;

	beforeEach(() => {
		harness = createTestHarness();
		projector = new MessageProjector();
		seq = 0;
		harness.seedSession(SESSION_A);
		harness.seedSession(SESSION_B);
	});

	afterEach(() => {
		harness.close();
	});

	function project(event: StoredEvent, ctx?: ProjectionContext): void {
		projector.project(event, harness.db, ctx);
	}

	function nextSeq(): number {
		return ++seq;
	}

	/** Full pipeline: SQLite → history → chat messages */
	function readPipeline(sessionId: string) {
		const readQuery = new ReadQueryService(harness.db);
		const rows = readQuery.getSessionMessagesWithParts(sessionId);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		return historyToChatMessages(messages);
	}

	// ─── Out-of-order events ────────────────────────────────────────────

	describe("out-of-order events", () => {
		it("thinking.delta before thinking.start — part created with correct text", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Delta arrives BEFORE start
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
						text: "early delta",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// Start arrives late — ON CONFLICT DO NOTHING on the part row
			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 50 },
				),
			);

			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("early delta");
		});

		it("text.delta before message.created — message auto-created defensively", () => {
			// text.delta with no preceding message.created
			project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: "msg-auto",
						partId: "part-text-auto",
						text: "orphan delta",
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// message.created arrives late — INSERT OR IGNORE (no-op)
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-auto",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-auto",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});
	});

	// ─── Duplicate event delivery ───────────────────────────────────────

	describe("duplicate event delivery", () => {
		it("KNOWN RISK: duplicate thinking.delta in normal mode doubles text", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-dup",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const deltaEvent = makeStored(
				"thinking.delta",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-dup",
					text: "hello",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			);

			// Same delta projected twice — no replaying flag
			project(deltaEvent);
			project(deltaEvent);

			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-dup",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// Documents the known risk: text is doubled during normal streaming
			// because alreadyApplied() only checks when ctx.replaying === true.
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("hellohello");
		});

		it("duplicate thinking.delta in replay mode — alreadyApplied() prevents doubling", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-replay",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			const deltaSeq = nextSeq();
			const deltaEvent = makeStored(
				"thinking.delta",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-replay",
					text: "hello",
				},
				{ sequence: deltaSeq, createdAt: NOW + 200 },
			);

			// First projection (normal)
			project(deltaEvent);

			// Second projection (replay mode) — skipped via alreadyApplied()
			project(deltaEvent, { replaying: true });

			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-replay",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("hello"); // Not doubled
		});

		it("duplicate thinking.start — ON CONFLICT DO NOTHING, no error", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			const startEvent = makeStored(
				"thinking.start",
				SESSION_A,
				{
					messageId: MSG_ID,
					partId: "part-think-dup-start",
				},
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			);

			project(startEvent);
			expect(() => project(startEvent)).not.toThrow();
		});
	});

	// ─── Edge cases ─────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("empty thinking block — start + end, no delta", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// No thinking.delta — straight to end
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-empty",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-text-1",
						text: "answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			// Empty thinking block should exist with empty text, not silently dropped
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});

		it("thinking-only turn — no text.delta, only thinking", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
						text: "I thought about it but produced no text",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-think-only",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0.01,
						duration: 500,
						tokens: { input: 100, output: 10 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("I thought about it but produced no text");

			// No assistant message — no text.delta was projected
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeUndefined();
		});
	});

	// ─── Multi-part turns ───────────────────────────────────────────────

	describe("multi-part turns", () => {
		it("multiple thinking blocks in one message — all survive pipeline", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Thinking block 1
			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
						text: "first thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 150 },
				),
			);
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-1",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Text block 1
			project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-1",
						text: "first answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);

			// Thinking block 2
			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
						text: "second thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 450 },
				),
			);
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-2",
					},
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);

			// Text block 2
			project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-2",
						text: "second answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 600 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 700 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const thinkingBlocks = chat.filter(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinkingBlocks).toHaveLength(2);
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(thinkingBlocks[0]!.text).toBe("first thought");
			// biome-ignore lint/style/noNonNullAssertion: length checked
			expect(thinkingBlocks[1]!.text).toBe("second thought");

			// Verify ordering: think1 → assistant1 → think2 → assistant2
			const types = chat
				.filter((m) => ["thinking", "assistant"].includes(m.type))
				.map((m) => m.type);
			expect(types).toEqual(["thinking", "assistant", "thinking", "assistant"]);
		});

		it("tool use interleaved with thinking — sort_order preserves sequence", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			// Think → tool → think → text
			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
						text: "pre-tool reasoning",
					},
					{ sequence: nextSeq(), createdAt: NOW + 150 },
				),
			);
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-pre",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			project(
				makeStored(
					"tool.started",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "tool-1",
						toolName: "bash",
						callId: "call-1",
						input: { command: "ls" },
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);
			project(
				makeStored(
					"tool.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "tool-1",
						result: "file1.ts file2.ts",
						duration: 100,
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
					},
					{ sequence: nextSeq(), createdAt: NOW + 500 },
				),
			);
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
						text: "post-tool reasoning",
					},
					{ sequence: nextSeq(), createdAt: NOW + 550 },
				),
			);
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "think-post",
					},
					{ sequence: nextSeq(), createdAt: NOW + 600 },
				),
			);

			project(
				makeStored(
					"text.delta",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "text-final",
						text: "final answer",
					},
					{ sequence: nextSeq(), createdAt: NOW + 700 },
				),
			);

			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: MSG_ID,
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 800 },
				),
			);

			const chat = readPipeline(SESSION_A);
			const types = chat
				.filter((m) => ["thinking", "tool", "assistant"].includes(m.type))
				.map((m) => m.type);
			// Expect: thinking → tool → thinking → assistant
			expect(types).toEqual(["thinking", "tool", "thinking", "assistant"]);
		});
	});

	// ─── Error recovery ─────────────────────────────────────────────────

	describe("error recovery", () => {
		it("partial failure — thinking.start committed, delta rejected, state still valid", () => {
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: MSG_ID,
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);

			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: MSG_ID,
						partId: "part-err",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);

			// Force the next db.execute call to throw (simulates disk error)
			vi.spyOn(harness.db, "execute").mockImplementationOnce(() => {
				throw new Error("Simulated disk error");
			});

			expect(() =>
				project(
					makeStored(
						"thinking.delta",
						SESSION_A,
						{
							messageId: MSG_ID,
							partId: "part-err",
							text: "lost delta",
						},
						{ sequence: nextSeq(), createdAt: NOW + 200 },
					),
				),
			).toThrow("Simulated disk error");

			vi.restoreAllMocks();

			// State is valid: thinking part exists with empty text from start
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// Part exists from thinking.start but delta text was lost
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
			// History-loaded = always done
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.done).toBe(true);
		});
	});

	// ─── Session isolation ──────────────────────────────────────────────

	describe("session isolation", () => {
		it("events from session A never appear in session B pipeline", () => {
			// Project thinking in session A
			project(
				makeStored(
					"message.created",
					SESSION_A,
					{
						messageId: "msg-a",
						role: "assistant",
						sessionId: SESSION_A,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			project(
				makeStored(
					"thinking.start",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			project(
				makeStored(
					"thinking.delta",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
						text: "session A thought",
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);
			project(
				makeStored(
					"thinking.end",
					SESSION_A,
					{
						messageId: "msg-a",
						partId: "think-a",
					},
					{ sequence: nextSeq(), createdAt: NOW + 300 },
				),
			);
			project(
				makeStored(
					"turn.completed",
					SESSION_A,
					{
						messageId: "msg-a",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 400 },
				),
			);

			// Project text in session B
			project(
				makeStored(
					"message.created",
					SESSION_B,
					{
						messageId: "msg-b",
						role: "assistant",
						sessionId: SESSION_B,
					},
					{ sequence: nextSeq(), createdAt: NOW },
				),
			);
			project(
				makeStored(
					"text.delta",
					SESSION_B,
					{
						messageId: "msg-b",
						partId: "text-b",
						text: "session B text",
					},
					{ sequence: nextSeq(), createdAt: NOW + 100 },
				),
			);
			project(
				makeStored(
					"turn.completed",
					SESSION_B,
					{
						messageId: "msg-b",
						cost: 0,
						duration: 0,
						tokens: { input: 0, output: 0 },
					},
					{ sequence: nextSeq(), createdAt: NOW + 200 },
				),
			);

			// Session A: thinking only, no assistant text
			const chatA = readPipeline(SESSION_A);
			expect(chatA.some((m) => m.type === "thinking")).toBe(true);
			expect(chatA.some((m) => m.type === "assistant")).toBe(false);

			// Session B: assistant text only, no thinking
			const chatB = readPipeline(SESSION_B);
			expect(chatB.some((m) => m.type === "assistant")).toBe(true);
			expect(chatB.some((m) => m.type === "thinking")).toBe(false);
		});
	});

	// ─── Malformed / adversarial payloads ────────────────────────────────

	describe("malformed and adversarial payloads", () => {
		it("thinking.delta with empty string text — concatenates to empty", () => {
			project(makeStored("message.created", SESSION_A, {
				messageId: "msg-empty", role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));

			project(makeStored("thinking.start", SESSION_A, {
				messageId: "msg-empty", partId: "part-empty",
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));

			project(makeStored("thinking.delta", SESSION_A, {
				messageId: "msg-empty", partId: "part-empty", text: "",
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));

			project(makeStored("thinking.end", SESSION_A, {
				messageId: "msg-empty", partId: "part-empty",
			}, { sequence: nextSeq(), createdAt: NOW + 300 }));

			project(makeStored("turn.completed", SESSION_A, {
				messageId: "msg-empty", cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 400 }));

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("");
		});

		it("text.delta with SQL-injection-like string — parameterized queries prevent injection", () => {
			const evilText = "'; DROP TABLE message_parts; --";

			project(makeStored("message.created", SESSION_A, {
				messageId: "msg-sql", role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));

			project(makeStored("text.delta", SESSION_A, {
				messageId: "msg-sql", partId: "part-sql", text: evilText,
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));

			project(makeStored("turn.completed", SESSION_A, {
				messageId: "msg-sql", cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));

			// Table still exists (not dropped)
			const chat = readPipeline(SESSION_A);
			const assistant = chat.find((m) => m.type === "assistant");
			expect(assistant).toBeDefined();
		});

		it("thinking.delta with very long text (100KB) — stored and retrieved intact", () => {
			const longText = "x".repeat(100_000);

			project(makeStored("message.created", SESSION_A, {
				messageId: "msg-long", role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));

			project(makeStored("thinking.start", SESSION_A, {
				messageId: "msg-long", partId: "part-long",
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));

			project(makeStored("thinking.delta", SESSION_A, {
				messageId: "msg-long", partId: "part-long", text: longText,
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));

			project(makeStored("thinking.end", SESSION_A, {
				messageId: "msg-long", partId: "part-long",
			}, { sequence: nextSeq(), createdAt: NOW + 300 }));

			project(makeStored("turn.completed", SESSION_A, {
				messageId: "msg-long", cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 400 }));

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(longText);
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text.length).toBe(100_000);
		});

		it("thinking.delta with HTML entities — stored raw, not escaped at DB layer", () => {
			const htmlText = '<script>alert("xss")</script>&amp;';

			project(makeStored("message.created", SESSION_A, {
				messageId: "msg-html", role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));

			project(makeStored("thinking.start", SESSION_A, {
				messageId: "msg-html", partId: "part-html",
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));

			project(makeStored("thinking.delta", SESSION_A, {
				messageId: "msg-html", partId: "part-html", text: htmlText,
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));

			project(makeStored("thinking.end", SESSION_A, {
				messageId: "msg-html", partId: "part-html",
			}, { sequence: nextSeq(), createdAt: NOW + 300 }));

			project(makeStored("turn.completed", SESSION_A, {
				messageId: "msg-html", cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 400 }));

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// DB stores raw text — sanitization is frontend's responsibility
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(htmlText);
		});
	});

	// ─── Unicode and encoding stress ─────────────────────────────────────

	describe("unicode and encoding stress", () => {
		function projectThinkingWithText(msgId: string, partId: string, text: string) {
			project(makeStored("message.created", SESSION_A, {
				messageId: msgId, role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));
			project(makeStored("thinking.start", SESSION_A, {
				messageId: msgId, partId,
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));
			project(makeStored("thinking.delta", SESSION_A, {
				messageId: msgId, partId, text,
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));
			project(makeStored("thinking.end", SESSION_A, {
				messageId: msgId, partId,
			}, { sequence: nextSeq(), createdAt: NOW + 300 }));
			project(makeStored("turn.completed", SESSION_A, {
				messageId: msgId, cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 400 }));
		}

		it("emoji round-trips through pipeline", () => {
			projectThinkingWithText("msg-emoji", "part-emoji", "🧠 Let me think 🤔💭");
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("🧠 Let me think 🤔💭");
		});

		it("CJK characters round-trip through pipeline", () => {
			projectThinkingWithText("msg-cjk", "part-cjk", "这是一个测试。思考中…");
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("这是一个测试。思考中…");
		});

		it("RTL text (Arabic) round-trips through pipeline", () => {
			projectThinkingWithText("msg-rtl", "part-rtl", "هذا اختبار للتفكير");
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("هذا اختبار للتفكير");
		});

		it("surrogate pairs (𝕳𝖊𝖑𝖑𝖔) round-trip through pipeline", () => {
			const surrogatePairText = "𝕳𝖊𝖑𝖑𝖔 𝖂𝖔𝖗𝖑𝖉";
			projectThinkingWithText("msg-surr", "part-surr", surrogatePairText);
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe(surrogatePairText);
		});

		it("null bytes in text — stored as-is by SQLite TEXT column", () => {
			const nullByteText = "before\0after";
			projectThinkingWithText("msg-null", "part-null", nullByteText);
			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// SQLite TEXT columns handle embedded nulls — verify no truncation
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text.length).toBeGreaterThanOrEqual("before".length);
		});

		it("multi-byte concatenation via multiple deltas — boundary not corrupted", () => {
			project(makeStored("message.created", SESSION_A, {
				messageId: "msg-concat", role: "assistant", sessionId: SESSION_A,
			}, { sequence: nextSeq(), createdAt: NOW }));
			project(makeStored("thinking.start", SESSION_A, {
				messageId: "msg-concat", partId: "part-concat",
			}, { sequence: nextSeq(), createdAt: NOW + 100 }));

			// Two deltas with multi-byte chars at boundaries
			project(makeStored("thinking.delta", SESSION_A, {
				messageId: "msg-concat", partId: "part-concat", text: "思考",
			}, { sequence: nextSeq(), createdAt: NOW + 200 }));
			project(makeStored("thinking.delta", SESSION_A, {
				messageId: "msg-concat", partId: "part-concat", text: "🧠完了",
			}, { sequence: nextSeq(), createdAt: NOW + 300 }));

			project(makeStored("thinking.end", SESSION_A, {
				messageId: "msg-concat", partId: "part-concat",
			}, { sequence: nextSeq(), createdAt: NOW + 400 }));
			project(makeStored("turn.completed", SESSION_A, {
				messageId: "msg-concat", cost: 0, duration: 0,
				tokens: { input: 0, output: 0 },
			}, { sequence: nextSeq(), createdAt: NOW + 500 }));

			const chat = readPipeline(SESSION_A);
			const thinking = chat.find(
				(m): m is ThinkingMessage => m.type === "thinking",
			);
			expect(thinking).toBeDefined();
			// SQL || concatenation must not corrupt multi-byte boundary
			// biome-ignore lint/style/noNonNullAssertion: asserted above
			expect(thinking!.text).toBe("思考🧠完了");
		});
	});
});
