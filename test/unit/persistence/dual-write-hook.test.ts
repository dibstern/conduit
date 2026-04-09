import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DualWriteLog } from "../../../src/lib/persistence/dual-write-hook.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import {
	makeSSEEvent,
	makeUnknownSSEEvent,
} from "../../helpers/sse-factories.js";

const SESSION_ID = "sess-dw-001";

function makeLogger(): DualWriteLog & {
	warn: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	verbose: ReturnType<typeof vi.fn>;
} {
	return {
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		verbose: vi.fn(),
	};
}

describe("DualWriteHook", () => {
	let layer: PersistenceLayer;
	let log: ReturnType<typeof makeLogger>;
	let hook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		log = makeLogger();
		hook = new DualWriteHook({ persistence: layer, log });
	});

	afterEach(() => {
		hook.stopStatsLogging();
		layer.close();
	});

	// ─── 1. Translates SSE event and appends to event store ───────────────

	it("translates an SSE event and appends to event store", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const result = hook.onSSEEvent(event, SESSION_ID);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// New session: 1 synthetic session.created + 1 message.created
		expect(result.eventsWritten).toBe(2);
		expect(result.sessionSeeded).toBe(true);

		// Verify events were persisted
		const stored = layer.eventStore.readBySession(SESSION_ID);
		expect(stored).toHaveLength(2);
		expect(stored[0]?.type).toBe("session.created");
		expect(stored[1]?.type).toBe("message.created");
		expect(stored[1]?.data).toMatchObject({
			messageId: "msg-001",
			role: "assistant",
		});
	});

	// ─── 2. Seeds session row before appending events ─────────────────────

	it("seeds session row before appending events", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		hook.onSSEEvent(event, SESSION_ID);

		const row = layer.db.queryOne<{ id: string; provider: string }>(
			"SELECT id, provider FROM sessions WHERE id = ?",
			[SESSION_ID],
		);
		expect(row).toBeDefined();
		expect(row?.id).toBe(SESSION_ID);
		expect(row?.provider).toBe("opencode");
	});

	// ─── 3. Handles multiple events for same session ──────────────────────

	it("handles multiple events for the same session", () => {
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const deltaEvent = makeSSEEvent("message.part.delta", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-001",
			field: "text",
			delta: "Hello world",
		});

		const r1 = hook.onSSEEvent(createEvent, SESSION_ID);
		const r2 = hook.onSSEEvent(deltaEvent, SESSION_ID);

		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);

		if (!r1.ok || !r2.ok) return;

		// First event: 1 synthetic session.created + 1 message.created = 2
		expect(r1.eventsWritten).toBe(2);
		expect(r1.sessionSeeded).toBe(true);

		// Second event: session already seeded, just the text.delta
		expect(r2.eventsWritten).toBe(1);
		expect(r2.sessionSeeded).toBe(false);

		const stored = layer.eventStore.readBySession(SESSION_ID);
		expect(stored).toHaveLength(3);
		expect(stored[0]?.type).toBe("session.created");
		expect(stored[1]?.type).toBe("message.created");
		expect(stored[2]?.type).toBe("text.delta");
	});

	// ─── 4. Does nothing when sessionId is undefined ──────────────────────

	it("does nothing when sessionId is undefined", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const result = hook.onSSEEvent(event, undefined);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("no-session");

		const stored = layer.eventStore.readFromSequence(0);
		expect(stored).toHaveLength(0);
	});

	// ─── 5. Does nothing for non-translatable events ──────────────────────

	it("does nothing for non-translatable events (pty, file)", () => {
		const ptyEvent = makeUnknownSSEEvent("pty.data", {
			sessionID: SESSION_ID,
			data: "some terminal output",
		});

		const result = hook.onSSEEvent(ptyEvent, SESSION_ID);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not-translatable");

		const stored = layer.eventStore.readFromSequence(0);
		expect(stored).toHaveLength(0);
	});

	// ─── 6. Catches and logs errors without throwing ──────────────────────

	it("catches and logs errors without throwing", () => {
		// Send one event to seed the session and write to the store
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(event, SESSION_ID);

		// Close the DB to force an error
		layer.close();

		const event2 = makeSSEEvent("message.created", {
			sessionID: "sess-dw-002",
			messageID: "msg-002",
			info: { role: "assistant", parts: [] },
		});

		// Should not throw
		const result = hook.onSSEEvent(event2, "sess-dw-002");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("error");
		expect(result.error).toBeDefined();

		// Verify warn was called with a message containing "dual-write"
		expect(log.warn).toHaveBeenCalled();
		expect(log.warn.mock.calls[0]?.[0]).toContain("dual-write");
	});

	// ─── 7. Returns disabled when enabled=false ───────────────────────────

	it("returns { ok: false, reason: 'disabled' } when enabled=false", () => {
		hook.enabled = false;

		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const result = hook.onSSEEvent(event, SESSION_ID);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("disabled");

		const stored = layer.eventStore.readFromSequence(0);
		expect(stored).toHaveLength(0);
	});

	// ─── 8. Tool lifecycle events across updates ──────────────────────────

	it("handles tool lifecycle: started -> running -> completed", () => {
		// First, create a message
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(createEvent, SESSION_ID);

		// Tool pending (started)
		const toolPending = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Read",
				callID: "call-001",
				state: { status: "pending", input: { file: "test.ts" } },
			},
		});
		const r1 = hook.onSSEEvent(toolPending, SESSION_ID);
		expect(r1.ok).toBe(true);
		if (r1.ok) expect(r1.eventsWritten).toBe(1);

		// Tool running
		const toolRunning = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Read",
				callID: "call-001",
				state: { status: "running", input: { file: "test.ts" } },
			},
		});
		const r2 = hook.onSSEEvent(toolRunning, SESSION_ID);
		expect(r2.ok).toBe(true);
		if (r2.ok) expect(r2.eventsWritten).toBe(1);

		// Tool completed
		const toolCompleted = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Read",
				callID: "call-001",
				state: { status: "completed", output: "file contents" },
				time: { start: 1000, end: 1500 },
			},
		});
		const r3 = hook.onSSEEvent(toolCompleted, SESSION_ID);
		expect(r3.ok).toBe(true);
		if (r3.ok) expect(r3.eventsWritten).toBe(1);

		// Verify the full sequence
		const stored = layer.eventStore.readBySession(SESSION_ID);
		const types = stored.map((e) => e.type);
		expect(types).toContain("tool.started");
		expect(types).toContain("tool.running");
		expect(types).toContain("tool.completed");
	});

	// ─── 9. Single SSE event producing multiple canonical events ──────────

	it("handles a single SSE event producing multiple canonical events", () => {
		// A tool that goes directly to "running" without "pending" first
		// produces both tool.started + tool.running
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(createEvent, SESSION_ID);

		const toolRunning = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-002",
			part: {
				type: "tool",
				id: "part-tool-002",
				tool: "Write",
				callID: "call-002",
				state: { status: "running", input: { file: "out.ts" } },
			},
		});

		const result = hook.onSSEEvent(toolRunning, SESSION_ID);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Should have both tool.started and tool.running = 2
		expect(result.eventsWritten).toBe(2);

		const stored = layer.eventStore.readBySession(SESSION_ID);
		const toolEvents = stored.filter(
			(e) => e.type === "tool.started" || e.type === "tool.running",
		);
		expect(toolEvents).toHaveLength(2);
		expect(toolEvents[0]?.type).toBe("tool.started");
		expect(toolEvents[1]?.type).toBe("tool.running");
	});

	// ─── 10. Statistics tracking ──────────────────────────────────────────

	describe("statistics tracking", () => {
		it("tracks eventsReceived for all events", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			hook.onSSEEvent(event, SESSION_ID);
			hook.onSSEEvent(event, SESSION_ID);
			hook.onSSEEvent(event, undefined);

			expect(hook.getStats().eventsReceived).toBe(3);
		});

		it("tracks eventsWritten including synthetic events", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			// New session: 1 synthetic session.created + 1 message.created = 2
			hook.onSSEEvent(event, SESSION_ID);
			expect(hook.getStats().eventsWritten).toBe(2);

			// Same session again: just 1 message.created (no synthetic)
			hook.onSSEEvent(event, SESSION_ID);
			expect(hook.getStats().eventsWritten).toBe(3);
		});

		it("tracks eventsSkipped for non-translatable events", () => {
			const ptyEvent = makeUnknownSSEEvent("pty.data", {
				sessionID: SESSION_ID,
			});

			hook.onSSEEvent(ptyEvent, SESSION_ID);
			hook.onSSEEvent(ptyEvent, SESSION_ID);

			expect(hook.getStats().eventsSkipped).toBe(2);
		});

		it("tracks eventsSkipped for disabled and no-session", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			hook.enabled = false;
			hook.onSSEEvent(event, SESSION_ID);
			hook.enabled = true;
			hook.onSSEEvent(event, undefined);

			expect(hook.getStats().eventsSkipped).toBe(2);
		});

		it("tracks errors", () => {
			// Close DB to force errors
			layer.close();

			const event = makeSSEEvent("message.created", {
				sessionID: "sess-err-001",
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			hook.onSSEEvent(event, "sess-err-001");
			hook.onSSEEvent(event, "sess-err-002");

			expect(hook.getStats().errors).toBe(2);
		});
	});

	// ─── 11. Failure injection: SQLITE_BUSY mock, reconnect recovery ──────

	describe("failure injection and reconnect", () => {
		it("handles SQLITE_BUSY-like errors gracefully", () => {
			// Simulate SQLITE_BUSY by mocking appendBatch to throw
			const originalAppendBatch = layer.eventStore.appendBatch.bind(
				layer.eventStore,
			);
			let callCount = 0;
			vi.spyOn(layer.eventStore, "appendBatch").mockImplementation((events) => {
				callCount++;
				if (callCount === 1) {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalAppendBatch(events);
			});

			const event = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			// First call: SQLITE_BUSY
			const r1 = hook.onSSEEvent(event, SESSION_ID);
			expect(r1.ok).toBe(false);
			if (!r1.ok) {
				expect(r1.reason).toBe("error");
				expect(r1.error).toContain("SQLITE_BUSY");
			}

			// Second call: succeeds (session was already seeded in-memory,
			// but the DB insert used INSERT OR IGNORE so it's fine to re-seed)
			const r2 = hook.onSSEEvent(event, SESSION_ID);
			expect(r2.ok).toBe(true);

			expect(hook.getStats().errors).toBe(1);
		});

		it("onReconnect resets translator state", () => {
			// Send a tool event to build up translator state
			const createEvent = makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});
			hook.onSSEEvent(createEvent, SESSION_ID);

			const toolPending = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-tool-001",
				part: {
					type: "tool",
					id: "part-tool-001",
					tool: "Read",
					callID: "call-001",
					state: { status: "pending", input: {} },
				},
			});
			hook.onSSEEvent(toolPending, SESSION_ID);

			// Reconnect resets translator
			hook.onReconnect();
			expect(log.info).toHaveBeenCalledWith(
				"dual-write: translator reset on reconnect",
			);

			// After reconnect, a "running" event for the same part should
			// produce tool.started + tool.running (as if first-seen)
			const toolRunning = makeSSEEvent("message.part.updated", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-tool-001",
				part: {
					type: "tool",
					id: "part-tool-001",
					tool: "Read",
					callID: "call-001",
					state: { status: "running", input: {} },
				},
			});

			const result = hook.onSSEEvent(toolRunning, SESSION_ID);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// tool.started + tool.running = 2
				expect(result.eventsWritten).toBe(2);
			}
		});
	});

	// ─── Synthetic session.created metadata ───────────────────────────────

	it("emits synthetic session.created with correct metadata", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		hook.onSSEEvent(event, SESSION_ID);

		const stored = layer.eventStore.readBySession(SESSION_ID);
		const sessionCreated = stored.find((e) => e.type === "session.created");
		expect(sessionCreated).toBeDefined();
		expect(sessionCreated?.metadata).toMatchObject({
			synthetic: true,
			source: "session-seeder",
		});
		expect(sessionCreated?.data).toMatchObject({
			sessionId: SESSION_ID,
			title: "Untitled",
			provider: "opencode",
		});
	});

	// ─── Stats logging lifecycle ──────────────────────────────────────────

	it("startStatsLogging and stopStatsLogging manage interval", () => {
		// Should not throw
		hook.startStatsLogging(100);
		hook.stopStatsLogging();

		// Double stop should not throw
		hook.stopStatsLogging();
	});
});
