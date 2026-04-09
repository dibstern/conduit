// ─── Dual-Write Projection Integration Test (Task 22) ──────────────────────
// End-to-end: SSE event → DualWriteHook → translate → append → project →
// verify read model tables are populated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DualWriteLog } from "../../../src/lib/persistence/dual-write-hook.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

const SESSION_ID = "sess-proj-001";

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

describe("Dual-Write Projection (SSE → append → project → read model)", () => {
	let layer: PersistenceLayer;
	let log: ReturnType<typeof makeLogger>;
	let hook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		// Run recovery on the empty store to set _recovered = true,
		// which is required before projectEvent/projectBatch can be called.
		layer.projectionRunner.recover();
		log = makeLogger();
		hook = new DualWriteHook({ persistence: layer, log });
	});

	afterEach(() => {
		hook.stopStatsLogging();
		layer.close();
	});

	// ─── 1. message.created creates both event AND message row ──────────

	it("message.created SSE event creates event in store AND row in messages table", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const result = hook.onSSEEvent(event, SESSION_ID);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Event store should have session.created + message.created
		const stored = layer.eventStore.readBySession(SESSION_ID);
		expect(stored).toHaveLength(2);
		expect(stored[0]?.type).toBe("session.created");
		expect(stored[1]?.type).toBe("message.created");

		// Read model: sessions table should be populated via SessionProjector
		const session = layer.db.queryOne<{
			id: string;
			title: string;
			provider: string;
		}>("SELECT id, title, provider FROM sessions WHERE id = ?", [SESSION_ID]);
		expect(session).toBeDefined();
		expect(session?.id).toBe(SESSION_ID);

		// Read model: messages table should have the message
		const messages = layer.db.query<{
			id: string;
			session_id: string;
			role: string;
		}>("SELECT id, session_id, role FROM messages WHERE session_id = ?", [
			SESSION_ID,
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.id).toBe("msg-001");
		expect(messages[0]?.role).toBe("assistant");
	});

	// ─── 2. session.created projection via synthetic event ──────────────

	it("session is seeded and session.created event creates session projection", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		const result = hook.onSSEEvent(event, SESSION_ID);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sessionSeeded).toBe(true);

		// The session projection should exist (set by SessionProjector
		// from the synthetic session.created event)
		const session = layer.db.queryOne<{
			id: string;
			title: string;
			provider: string;
			status: string;
		}>("SELECT id, title, provider, status FROM sessions WHERE id = ?", [
			SESSION_ID,
		]);
		expect(session).toBeDefined();
		expect(session?.provider).toBe("opencode");

		// Provider projection should exist (ProviderProjector handles session.created)
		const providers = layer.db.query<{
			session_id: string;
			provider: string;
		}>(
			"SELECT session_id, provider FROM session_providers WHERE session_id = ?",
			[SESSION_ID],
		);
		expect(providers).toHaveLength(1);
		expect(providers[0]?.provider).toBe("opencode");
	});

	// ─── 3. tool lifecycle events create message_parts rows ─────────────

	it("tool lifecycle events create message_parts rows", () => {
		// Step 1: Create the message
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(createEvent, SESSION_ID);

		// Step 2: Tool started
		const toolPending = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Bash",
				callID: "call-001",
				state: { status: "pending", input: { command: "ls" } },
			},
		});
		hook.onSSEEvent(toolPending, SESSION_ID);

		// Verify message_parts has a tool row
		const parts = layer.db.query<{
			id: string;
			message_id: string;
			type: string;
			tool_name: string;
		}>(
			"SELECT id, message_id, type, tool_name FROM message_parts WHERE message_id = ? AND type = 'tool'",
			["msg-001"],
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.tool_name).toBe("Bash");

		// Step 3: Tool completed
		const toolCompleted = makeSSEEvent("message.part.updated", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-tool-001",
			part: {
				type: "tool",
				id: "part-tool-001",
				tool: "Bash",
				callID: "call-001",
				state: { status: "completed", output: "file list" },
				time: { start: 1000, end: 1500 },
			},
		});
		hook.onSSEEvent(toolCompleted, SESSION_ID);

		// Verify the tool part was updated with status
		const updatedParts = layer.db.query<{
			id: string;
			status: string;
		}>(
			"SELECT id, status FROM message_parts WHERE message_id = ? AND type = 'tool'",
			["msg-001"],
		);
		expect(updatedParts).toHaveLength(1);
		expect(updatedParts[0]?.status).toBe("completed");
	});

	// ─── 4. turn.completed updates messages with cost/tokens ────────────

	it("turn.completed updates turn with cost/tokens", () => {
		// Step 1: Create user message (creates a turn via TurnProjector)
		const userEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "user-msg-001",
			info: { role: "user", parts: [] },
		});
		hook.onSSEEvent(userEvent, SESSION_ID);

		// Step 2: Create assistant message (attaches to the turn)
		const assistantEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "asst-msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(assistantEvent, SESSION_ID);

		// Step 3: Text delta (to have some content)
		const deltaEvent = makeSSEEvent("message.part.delta", {
			sessionID: SESSION_ID,
			messageID: "asst-msg-001",
			partID: "part-text-001",
			field: "text",
			delta: "Hello world",
		});
		hook.onSSEEvent(deltaEvent, SESSION_ID);

		// Step 4: Turn completed with cost info (message.updated SSE event
		// with assistant role maps to turn.completed canonical event)
		const turnEvent = makeSSEEvent("message.updated", {
			sessionID: SESSION_ID,
			info: {
				id: "asst-msg-001",
				role: "assistant",
				cost: 0.05,
				tokens: { input: 1000, output: 500 },
				time: { created: 1000, completed: 2000 },
			},
		});
		hook.onSSEEvent(turnEvent, SESSION_ID);

		// Check that turn.completed event is in the store
		const stored = layer.eventStore.readBySession(SESSION_ID);
		const turnCompleted = stored.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();

		// Check that the turn projection was updated
		const turns = layer.db.query<{
			id: string;
			state: string;
			cost: number | null;
			tokens_in: number | null;
			tokens_out: number | null;
		}>(
			"SELECT id, state, cost, tokens_in, tokens_out FROM turns WHERE session_id = ?",
			[SESSION_ID],
		);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.state).toBe("completed");
		expect(turns[0]?.cost).toBe(0.05);
		expect(turns[0]?.tokens_in).toBe(1000);
		expect(turns[0]?.tokens_out).toBe(500);
	});

	// ─── 5. projection errors are caught and do not break the hook ──────

	it("projection errors do not break the dual-write hook", () => {
		// First event to seed and recover
		const event1 = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(event1, SESSION_ID);

		// Mock projectEvent to throw
		vi.spyOn(layer.projectionRunner, "projectEvent").mockImplementation(() => {
			throw new Error("simulated projection failure");
		});
		vi.spyOn(layer.projectionRunner, "projectBatch").mockImplementation(() => {
			throw new Error("simulated projection failure");
		});

		// Second event: projection will fail, but event store should still work
		const event2 = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-002",
			info: { role: "user", parts: [] },
		});
		const result = hook.onSSEEvent(event2, SESSION_ID);

		// The hook should still report success (event was stored)
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.eventsWritten).toBe(1);

		// Event should be in the store
		const stored = layer.eventStore.readBySession(SESSION_ID);
		const msgCreated = stored.filter((e) => e.type === "message.created");
		expect(msgCreated.length).toBeGreaterThanOrEqual(2);

		// The projection error should have been logged
		expect(log.warn).toHaveBeenCalledWith(
			"dual-write: projection failed (non-fatal)",
			expect.objectContaining({
				error: expect.stringContaining("simulated projection failure"),
			}),
		);
	});

	// ─── 6. projector cursors advance after successful projection ───────

	it("projector cursors advance after successful projection", () => {
		const event = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});

		hook.onSSEEvent(event, SESSION_ID);

		// Check cursors have advanced
		const cursors = layer.cursorRepo.listAll();
		expect(cursors.length).toBeGreaterThan(0);

		// At least the session and message projectors should have cursor > 0
		const sessionCursor = cursors.find((c) => c.projectorName === "session");
		expect(sessionCursor).toBeDefined();
		expect(sessionCursor?.lastAppliedSeq).toBeGreaterThan(0);
	});

	// ─── 7. text.delta creates a message_parts text row ─────────────────

	it("text.delta creates a text part in message_parts", () => {
		// Create message first
		const createEvent = makeSSEEvent("message.created", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			info: { role: "assistant", parts: [] },
		});
		hook.onSSEEvent(createEvent, SESSION_ID);

		// Send text delta
		const deltaEvent = makeSSEEvent("message.part.delta", {
			sessionID: SESSION_ID,
			messageID: "msg-001",
			partID: "part-text-001",
			field: "text",
			delta: "Hello world",
		});
		hook.onSSEEvent(deltaEvent, SESSION_ID);

		// Verify the text part was created
		const parts = layer.db.query<{
			id: string;
			message_id: string;
			type: string;
			text: string;
		}>(
			"SELECT id, message_id, type, text FROM message_parts WHERE message_id = ? AND type = 'text'",
			["msg-001"],
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.text).toBe("Hello world");
	});

	// ─── 8. multiple SSE events in sequence build correct projections ───

	it("multiple SSE events build correct read model state", () => {
		// Create assistant message
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
			SESSION_ID,
		);

		// Text delta
		hook.onSSEEvent(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "Here is the result: ",
			}),
			SESSION_ID,
		);

		// Another text delta (appends)
		hook.onSSEEvent(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "success",
			}),
			SESSION_ID,
		);

		// Verify accumulated text
		const parts = layer.db.query<{ text: string }>(
			"SELECT text FROM message_parts WHERE message_id = ? AND type = 'text'",
			["msg-001"],
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.text).toBe("Here is the result: success");
	});

	// ─── 9. without recover(), projection is caught but event still stored

	it("without recover(), projection error is caught and event still stored", () => {
		// Create a fresh layer WITHOUT calling recover()
		const freshLayer = PersistenceLayer.memory();
		const freshLog = makeLogger();
		const freshHook = new DualWriteHook({
			persistence: freshLayer,
			log: freshLog,
		});

		try {
			const event = makeSSEEvent("message.created", {
				sessionID: "sess-no-recover",
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			});

			const result = freshHook.onSSEEvent(event, "sess-no-recover");

			// Event should still be stored (appendBatch succeeds before projection)
			expect(result.ok).toBe(true);

			const stored = freshLayer.eventStore.readBySession("sess-no-recover");
			expect(stored.length).toBeGreaterThan(0);

			// Projection error should be logged (recover() not called)
			expect(freshLog.warn).toHaveBeenCalledWith(
				"dual-write: projection failed (non-fatal)",
				expect.objectContaining({
					error: expect.stringContaining("recover()"),
				}),
			);
		} finally {
			freshHook.stopStatsLogging();
			freshLayer.close();
		}
	});
});
