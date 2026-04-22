// test/unit/persistence/canonical-event-translator.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { CanonicalEventTranslator } from "../../../src/lib/persistence/canonical-event-translator.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeSSEEvent,
	makeUnknownSSEEvent,
} from "../../helpers/sse-factories.js";

const SESSION_ID = "sess-test-001";

/** Assert result is non-null and return the array for further assertions. */
function assertEvents(result: CanonicalEvent[] | null): CanonicalEvent[] {
	expect(result).not.toBeNull();
	return result as CanonicalEvent[];
}

describe("CanonicalEventTranslator", () => {
	let translator: CanonicalEventTranslator;

	beforeEach(() => {
		translator = new CanonicalEventTranslator();
	});

	// ─── message.created ─────────────────────────────────────────────────────

	describe("message.created", () => {
		it("translates to canonical message.created for assistant role", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("message.created");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				role: "assistant",
				sessionId: SESSION_ID,
			});
		});

		it("translates to canonical message.created for user role", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-002",
				message: { role: "user", parts: [{ type: "text", text: "Hello" }] },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("message.created");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-002",
				role: "user",
				sessionId: SESSION_ID,
			});
		});

		it("returns null for message.created without a valid role", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-003",
				info: { role: "system", parts: [] },
			});

			const result = translator.translate(event, SESSION_ID);
			expect(result).toBeNull();
		});
	});

	// ─── message.part.delta (text) ───────────────────────────────────────────

	describe("message.part.delta (text)", () => {
		it("translates text delta to canonical text.delta", () => {
			const event = makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-001",
				field: "text",
				delta: "Hello world",
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("text.delta");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-001",
				text: "Hello world",
			});
		});
	});

	// ─── message.part.delta (reasoning) ──────────────────────────────────────

	describe("message.part.delta (reasoning)", () => {
		it("translates reasoning delta to thinking.delta when part is tracked as reasoning", () => {
			// First, register the part as reasoning via a part.updated event
			const updatedEvent = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r1",
				part: { id: "part-r1", type: "reasoning" },
			});
			translator.translate(updatedEvent, SESSION_ID);

			// Now send a delta for that tracked reasoning part
			const deltaEvent = makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r1",
				field: "reasoning",
				delta: "Let me think...",
			});

			const events = assertEvents(translator.translate(deltaEvent, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("thinking.delta");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-r1",
				text: "Let me think...",
			});
		});

		it("falls back to text.delta for untracked reasoning delta", () => {
			const event = makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-unknown",
				field: "reasoning",
				delta: "thinking text",
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("text.delta");
		});
	});

	// ─── message.part.updated (tool pending) ─────────────────────────────────

	describe("message.part.updated (tool pending)", () => {
		it("translates tool pending to tool.started", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t1",
				part: {
					id: "part-t1",
					type: "tool",
					callID: "call-001",
					tool: "read",
					state: { status: "pending", input: { file: "test.ts" } },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool.started");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-t1",
				toolName: "Read",
				callId: "call-001",
				input: { file: "test.ts" },
			});
		});
	});

	// ─── message.part.updated (tool running) ─────────────────────────────────

	describe("message.part.updated (tool running)", () => {
		it("translates tool running to tool.running when part was already seen", () => {
			// First mark the part as pending
			const pendingEvent = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t2",
				part: {
					id: "part-t2",
					type: "tool",
					callID: "call-002",
					tool: "bash",
					state: { status: "pending" },
				},
			});
			translator.translate(pendingEvent, SESSION_ID);

			// Now transition to running
			const runningEvent = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t2",
				part: {
					id: "part-t2",
					type: "tool",
					callID: "call-002",
					tool: "bash",
					state: { status: "running", input: { command: "ls" } },
				},
			});

			const events = assertEvents(
				translator.translate(runningEvent, SESSION_ID),
			);
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool.running");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-t2",
			});
		});

		it("emits both tool.started and tool.running when first seen as running", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t3",
				part: {
					id: "part-t3",
					type: "tool",
					callID: "call-003",
					tool: "edit",
					state: { status: "running", input: { path: "foo.ts" } },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(2);
			expect(events[0]?.type).toBe("tool.started");
			expect(events[0]?.data).toMatchObject({
				toolName: "Edit",
				callId: "call-003",
			});
			expect(events[1]?.type).toBe("tool.running");
		});
	});

	// ─── message.part.updated (tool completed) ───────────────────────────────

	describe("message.part.updated (tool completed)", () => {
		it("translates tool completed to tool.completed", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t4",
				part: {
					id: "part-t4",
					type: "tool",
					callID: "call-004",
					tool: "grep",
					state: { status: "completed", output: "match found" },
					time: { start: 1000, end: 2500 },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool.completed");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-t4",
				result: "match found",
				duration: 1500,
			});
		});

		it("translates tool error to tool.completed with error as result", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-t5",
				part: {
					id: "part-t5",
					type: "tool",
					callID: "call-005",
					tool: "bash",
					state: { status: "error", error: "Command failed" },
					time: { start: 1000, end: 1200 },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool.completed");
			expect(events[0]?.data).toMatchObject({
				result: "Command failed",
				duration: 200,
			});
		});
	});

	// ─── message.part.updated (reasoning first seen) ─────────────────────────

	describe("message.part.updated (reasoning)", () => {
		it("emits thinking.start on first encounter", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r2",
				part: { id: "part-r2", type: "reasoning" },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("thinking.start");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-r2",
			});
		});

		it("does not emit thinking.start again for the same part", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r3",
				part: { id: "part-r3", type: "reasoning" },
			});

			// First encounter
			translator.translate(event, SESSION_ID);

			// Second encounter (same partID, no end time) -> no new events
			const result = translator.translate(event, SESSION_ID);
			expect(result).toBeNull();
		});

		it("emits thinking.end when time.end is set", () => {
			// First encounter -> thinking.start
			const startEvent = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r4",
				part: { id: "part-r4", type: "reasoning" },
			});
			translator.translate(startEvent, SESSION_ID);

			// Updated with end time -> thinking.end
			const endEvent = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r4",
				part: {
					id: "part-r4",
					type: "reasoning",
					time: { start: 100, end: 500 },
				},
			});

			const events = assertEvents(translator.translate(endEvent, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("thinking.end");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-001",
				partId: "part-r4",
			});
		});

		it("emits both thinking.start and thinking.end on first encounter with end time", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r5",
				part: {
					id: "part-r5",
					type: "reasoning",
					time: { start: 100, end: 500 },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(2);
			expect(events[0]?.type).toBe("thinking.start");
			expect(events[1]?.type).toBe("thinking.end");
		});
	});

	// ─── message.updated -> turn.completed ────────────────────────────────────

	describe("message.updated", () => {
		it("translates assistant message.updated to turn.completed", () => {
			const event = makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "msg-100",
					role: "assistant",
					cost: 0.0042,
					tokens: {
						input: 1000,
						output: 500,
						cache: { read: 200, write: 50 },
					},
					time: { created: 1000, completed: 3000 },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("turn.completed");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-100",
				cost: 0.0042,
				tokens: {
					input: 1000,
					output: 500,
					cacheRead: 200,
					cacheWrite: 50,
				},
				duration: 2000,
			});
		});

		it("returns null for user message.updated", () => {
			const event = makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				info: {
					id: "msg-101",
					role: "user",
				},
			});

			const result = translator.translate(event, SESSION_ID);
			expect(result).toBeNull();
		});

		it("uses the message property as fallback when info is absent", () => {
			const event = makeSSEEvent("message.updated", {
				sessionID: SESSION_ID,
				message: {
					id: "msg-102",
					role: "assistant",
					cost: 0.001,
					tokens: { input: 100, output: 50 },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("turn.completed");
			expect(events[0]?.data).toMatchObject({
				messageId: "msg-102",
				cost: 0.001,
			});
		});
	});

	// ─── session.status ──────────────────────────────────────────────────────

	describe("session.status", () => {
		it("translates idle status", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("session.status");
			expect(events[0]?.data).toMatchObject({
				sessionId: SESSION_ID,
				status: "idle",
			});
		});

		it("translates busy status", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "busy" },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.data).toMatchObject({ status: "busy" });
		});

		it("translates retry status", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "retry", attempt: 2, message: "Rate limited" },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.data).toMatchObject({ status: "retry" });
		});

		it("returns null for unknown status types", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "unknown-status" },
			});

			const result = translator.translate(event, SESSION_ID);
			expect(result).toBeNull();
		});
	});

	// ─── session.error -> turn.error ──────────────────────────────────────────

	describe("session.error", () => {
		it("translates to turn.error", () => {
			const event = makeSSEEvent("session.error", {
				sessionID: SESSION_ID,
				error: {
					name: "QuotaExhausted",
					data: { message: "Rate limit exceeded" },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("turn.error");
			expect(events[0]?.data).toMatchObject({
				messageId: "",
				error: "Rate limit exceeded",
				code: "QuotaExhausted",
			});
		});

		it("uses defaults when error fields are missing", () => {
			const event = makeSSEEvent("session.error", {
				sessionID: SESSION_ID,
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.data).toMatchObject({
				error: "An error occurred",
				code: "Unknown",
			});
		});
	});

	// ─── permission.asked ────────────────────────────────────────────────────

	describe("permission.asked", () => {
		it("translates to canonical permission.asked", () => {
			const event = makeSSEEvent("permission.asked", {
				id: "perm-001",
				permission: "bash",
				patterns: ["rm -rf"],
				metadata: { dangerous: true },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("permission.asked");
			expect(events[0]?.data).toMatchObject({
				id: "perm-001",
				sessionId: SESSION_ID,
				toolName: "bash",
				input: {
					patterns: ["rm -rf"],
					metadata: { dangerous: true },
				},
			});
		});
	});

	// ─── permission.replied -> permission.resolved ────────────────────────────

	describe("permission.replied", () => {
		it("translates to canonical permission.resolved", () => {
			const event = makeSSEEvent("permission.replied", {
				id: "perm-001",
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("permission.resolved");
			expect(events[0]?.data).toMatchObject({
				id: "perm-001",
				decision: "once",
			});
		});
	});

	// ─── question.asked ──────────────────────────────────────────────────────

	describe("question.asked", () => {
		it("translates to canonical question.asked", () => {
			const event = makeSSEEvent("question.asked", {
				id: "q-001",
				questions: [
					{
						question: "Which file?",
						header: "Select a file",
						options: [{ label: "a.ts" }, { label: "b.ts" }],
					},
				],
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("question.asked");
			expect(events[0]?.data).toMatchObject({
				id: "q-001",
				sessionId: SESSION_ID,
			});
			// questions should be preserved
			const data = events[0]?.data as { questions: unknown[] };
			expect(data.questions).toHaveLength(1);
		});
	});

	// ─── session.updated -> session.renamed ───────────────────────────────────

	describe("session.updated", () => {
		it("translates to session.renamed when title is present", () => {
			const event = makeSSEEvent("session.updated", {
				info: {
					sessionID: SESSION_ID,
					title: "New Title",
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("session.renamed");
			expect(events[0]?.data).toMatchObject({
				sessionId: SESSION_ID,
				title: "New Title",
			});
		});

		it("returns null when no title in session.updated", () => {
			const event = makeSSEEvent("session.updated", {
				info: { sessionID: SESSION_ID },
			});

			const result = translator.translate(event, SESSION_ID);
			expect(result).toBeNull();
		});
	});

	// ─── PTY / file events -> null ────────────────────────────────────────────

	describe("non-persisted events", () => {
		it("returns null for pty.created", () => {
			const event = makeSSEEvent("pty.created", {
				info: { id: "pty-1", title: "bash" },
			});
			expect(translator.translate(event, SESSION_ID)).toBeNull();
		});

		it("returns null for pty.exited", () => {
			const event = makeSSEEvent("pty.exited", { id: "pty-1", exitCode: 0 });
			expect(translator.translate(event, SESSION_ID)).toBeNull();
		});

		it("returns null for pty.deleted", () => {
			const event = makeSSEEvent("pty.deleted", { id: "pty-1" });
			expect(translator.translate(event, SESSION_ID)).toBeNull();
		});

		it("returns null for file.edited", () => {
			const event = makeSSEEvent("file.edited", { file: "test.ts" });
			expect(translator.translate(event, SESSION_ID)).toBeNull();
		});

		it("returns null for unknown event types", () => {
			const event = makeUnknownSSEEvent("some.future.event", { data: 123 });
			expect(translator.translate(event, SESSION_ID)).toBeNull();
		});
	});

	// ─── No sessionId -> null ─────────────────────────────────────────────────

	describe("missing sessionId", () => {
		it("returns null when sessionId is undefined", () => {
			const event = makeSSEEvent("message.created", {
				messageID: "msg-001",
				info: { role: "assistant" },
			});
			expect(translator.translate(event, undefined)).toBeNull();
		});

		it("returns null when sessionId is empty string", () => {
			const event = makeSSEEvent("message.created", {
				messageID: "msg-001",
				info: { role: "assistant" },
			});
			// Empty string is falsy, so it should be treated as missing
			expect(translator.translate(event, "")).toBeNull();
		});
	});

	// ─── reset() ─────────────────────────────────────────────────────────────

	describe("reset()", () => {
		it("clears all tracked parts when called without sessionId", () => {
			// Track a reasoning part
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-r10",
				part: { id: "part-r10", type: "reasoning" },
			});
			translator.translate(event, SESSION_ID);

			expect(translator.getTrackedParts(SESSION_ID)?.size).toBeGreaterThan(0);

			translator.reset();

			expect(translator.getTrackedParts(SESSION_ID)).toBeUndefined();
		});

		it("clears only the specified session when sessionId is provided", () => {
			const sessionA = "sess-A";
			const sessionB = "sess-B";

			// Track parts in two sessions
			const eventA = makeSSEEvent("message.part.updated", {
				sessionID: sessionA,
				messageID: "msg-001",
				partID: "part-a",
				part: { id: "part-a", type: "reasoning" },
			});
			translator.translate(eventA, sessionA);

			const eventB = makeSSEEvent("message.part.updated", {
				sessionID: sessionB,
				messageID: "msg-002",
				partID: "part-b",
				part: { id: "part-b", type: "reasoning" },
			});
			translator.translate(eventB, sessionB);

			// Reset only session A
			translator.reset(sessionA);

			expect(translator.getTrackedParts(sessionA)).toBeUndefined();
			expect(translator.getTrackedParts(sessionB)?.size).toBeGreaterThan(0);
		});
	});

	// ─── Tool name mapping ───────────────────────────────────────────────────

	describe("tool name mapping", () => {
		it("maps known tool names to display names", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-glob",
				part: {
					id: "part-glob",
					type: "tool",
					callID: "call-glob",
					tool: "glob",
					state: { status: "pending" },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.data).toMatchObject({
				toolName: "Glob",
			});
		});

		it("passes through unknown tool names unchanged", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-custom",
				part: {
					id: "part-custom",
					type: "tool",
					callID: "call-custom",
					tool: "my_custom_tool",
					state: { status: "pending" },
				},
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			expect(events[0]?.data).toMatchObject({
				toolName: "my_custom_tool",
			});
		});
	});

	// ─── Event envelope fields ───────────────────────────────────────────────

	describe("event envelope", () => {
		it("includes required envelope fields on every emitted event", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: SESSION_ID,
				status: { type: "idle" },
			});

			const events = assertEvents(translator.translate(event, SESSION_ID));
			expect(events).toHaveLength(1);
			const evt = events[0];
			expect(evt?.eventId).toMatch(/^evt_/);
			expect(evt?.sessionId).toBe(SESSION_ID);
			expect(evt?.provider).toBe("opencode");
			expect(evt?.createdAt).toBeGreaterThan(0);
			expect(evt?.metadata).toBeDefined();
		});
	});
});
