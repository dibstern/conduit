// ─── Regression: Server-Side Cache Pipeline ──────────────────────────────────
// Tests the translator → cache pipeline to verify that events for session A
// are correctly cached even after a session switch resets the translator.
//
// Reproduces: "switch away from a session that has received messages from
// opencode, then switch back — history is gone"
//
// Root cause hypothesis: After translator.reset() on session switch, some
// events for the old session may translate to null and be silently dropped
// from the cache pipeline.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldCache } from "../../../src/lib/relay/event-pipeline.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import { MessageCache } from "../../../src/lib/relay/message-cache.js";
import {
	countUniqueMessages,
	resolveSessionHistory,
} from "../../../src/lib/session/session-switch.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Simulate the SSE event → translate → cache pipeline from relay-stack.ts */
function processEvent(
	event: OpenCodeEvent,
	translator: ReturnType<typeof createTranslator>,
	cache: MessageCache,
	activeSessionId: string,
	extractSessionId: (e: OpenCodeEvent) => string | undefined,
): RelayMessage[] {
	const result = translator.translate(event);
	if (!result.ok) return [];

	const eventSessionId = extractSessionId(event);
	const toSend = result.messages;
	const recorded: RelayMessage[] = [];

	for (const msg of toSend) {
		const recordId = eventSessionId ?? activeSessionId;
		if (recordId && shouldCache(msg.type)) {
			cache.recordEvent(recordId, msg);
			recorded.push(msg);
		}
	}

	return recorded;
}

/** Simple sessionID extractor matching relay-stack.ts */
function extractSessionId(event: OpenCodeEvent): string | undefined {
	const props = event.properties as Record<string, unknown>;
	if (typeof props["sessionID"] === "string" && props["sessionID"]) {
		return props["sessionID"];
	}
	if (props["part"] && typeof props["part"] === "object") {
		const part = props["part"] as Record<string, unknown>;
		if (typeof part["sessionID"] === "string" && part["sessionID"]) {
			return part["sessionID"];
		}
	}
	if (props["info"] && typeof props["info"] === "object") {
		const info = props["info"] as Record<string, unknown>;
		if (typeof info["sessionID"] === "string" && info["sessionID"]) {
			return info["sessionID"];
		}
	}
	return undefined;
}

// ─── SSE Event Factories ────────────────────────────────────────────────────

function makePartDelta(
	sessionID: string,
	partID: string,
	delta: string,
	field = "text",
): OpenCodeEvent {
	return {
		type: "message.part.delta",
		properties: { sessionID, partID, delta, field, messageID: "msg1" },
	};
}

function makePartUpdated(
	sessionID: string,
	partID: string,
	partType: string,
	status?: string,
	extra?: Record<string, unknown>,
): OpenCodeEvent {
	return {
		type: "message.part.updated",
		properties: {
			messageID: "msg1",
			partID,
			part: {
				id: partID,
				type: partType,
				sessionID,
				state: status ? { status, ...extra } : undefined,
				...(extra ?? {}),
			},
		},
	};
}

function makeSessionStatus(
	sessionID: string,
	statusType: string,
): OpenCodeEvent {
	return {
		type: "session.status",
		properties: { sessionID, status: { type: statusType } },
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let cacheDir: string;
let cache: MessageCache;
let translator: ReturnType<typeof createTranslator>;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "relay-cache-test-"));
	cache = new MessageCache(cacheDir);
	translator = createTranslator();
});

describe("Server cache pipeline: events survive session switch", () => {
	it("text deltas for session A are cached after translator reset (switch to B)", async () => {
		// Phase 1: Events arrive for session A while viewing session A
		let activeSession = "session-a";

		// Register the text part first (message.part.updated)
		processEvent(
			makePartUpdated("session-a", "part-text-1", "text"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Text deltas arrive
		processEvent(
			makePartDelta("session-a", "part-text-1", "Hello "),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartDelta("session-a", "part-text-1", "world"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Verify 2 deltas cached
		let events = await cache.getEvents("session-a");
		const deltasBeforeSwitch = events?.filter((e) => e.type === "delta") ?? [];
		expect(deltasBeforeSwitch).toHaveLength(2);

		// Phase 2: Switch to session B — translator is RESET
		translator.reset();
		activeSession = "session-b";

		// Phase 3: More text deltas arrive for session A (agent still working)
		processEvent(
			makePartDelta("session-a", "part-text-1", ", how are "),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartDelta("session-a", "part-text-1", "you?"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Verify: ALL 4 deltas should be in session A's cache
		events = await cache.getEvents("session-a");
		const allDeltas = events?.filter((e) => e.type === "delta") ?? [];
		expect(allDeltas).toHaveLength(4);
		expect((allDeltas[0] as { text: string }).text).toBe("Hello ");
		expect((allDeltas[1] as { text: string }).text).toBe("world");
		expect((allDeltas[2] as { text: string }).text).toBe(", how are ");
		expect((allDeltas[3] as { text: string }).text).toBe("you?");
	});

	it("tool lifecycle events for session A are cached after translator reset", async () => {
		let activeSession = "session-a";

		// Phase 1: Tool starts on session A
		processEvent(
			makePartUpdated("session-a", "part-tool-1", "tool", "pending", {
				tool: "read",
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		let events = await cache.getEvents("session-a");
		expect(events?.some((e) => e.type === "tool_start")).toBe(true);

		// Phase 2: Switch to session B
		translator.reset();
		activeSession = "session-b";

		// Phase 3: Tool completes on session A while viewing B
		processEvent(
			makePartUpdated("session-a", "part-tool-1", "tool", "running", {
				tool: "read",
				state: { status: "running", input: { path: "foo.ts" } },
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartUpdated("session-a", "part-tool-1", "tool", "completed", {
				tool: "read",
				state: { status: "completed", output: "file contents" },
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Verify: tool_start, tool_executing, and tool_result should all be cached
		events = await cache.getEvents("session-a");
		const toolEvents = events?.filter((e) =>
			["tool_start", "tool_executing", "tool_result"].includes(e.type),
		);
		expect(toolEvents?.length).toBeGreaterThanOrEqual(2);

		// Should have at least tool_start and tool_result
		expect(toolEvents?.some((e) => e.type === "tool_start")).toBe(true);
		expect(toolEvents?.some((e) => e.type === "tool_result")).toBe(true);
	});

	it("reasoning deltas after translator reset are misclassified but not lost", () => {
		// OpenCode ALWAYS uses field: "text" for ALL deltas, including reasoning.
		// The part type is distinguished by seenParts, not by the field value.
		let activeSession = "session-a";

		// Phase 1: Reasoning starts on session A (translator knows it's reasoning)
		processEvent(
			makePartUpdated("session-a", "part-reason-1", "reasoning"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Reasoning deltas arrive — translator correctly classifies as thinking_delta
		const recorded1 = processEvent(
			makePartDelta("session-a", "part-reason-1", "Let me think", "text"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		expect(recorded1).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(recorded1[0]!.type).toBe("thinking_delta");

		// Phase 2: Switch to session B — translator RESET
		translator.reset();
		activeSession = "session-b";

		// Phase 3: More reasoning deltas arrive for session A
		// After reset, seenParts is empty. Since field is "text" (always in OpenCode),
		// the fallback path classifies this as a regular "delta" instead of "thinking_delta".
		// Content is NOT lost — but it's misclassified.
		const recorded2 = processEvent(
			makePartDelta("session-a", "part-reason-1", " about this more", "text"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Content IS cached (field "text" fallback works), but as wrong type
		expect(recorded2).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(recorded2[0]!.type).toBe("delta"); // Should be thinking_delta, but it's delta
	});

	it("REGRESSION: stale cache falls back to REST when message count diverges", async () => {
		// Previously: cache with partial history preempted REST API full history.
		// Now: resolveSessionHistory validates cache against upstream message count.
		const activeSession = "session-a";

		// Simulate: relay only captured turn 6 (the bug scenario from the original test)
		cache.recordEvent("session-a", { type: "user_message", text: "Turn 6" });
		processEvent(
			makePartDelta("session-a", "p1", "Response to turn 6"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// classifyHistorySource still says "cached-events" (has chat content)
		const events = await cache.getEvents("session-a");
		const hasChatContent =
			events?.some((e) => e.type === "user_message" || e.type === "delta") ??
			false;
		expect(hasChatContent).toBe(true);

		// Independently verify countUniqueMessages — cache has 1 user_message +
		// 1 delta with messageId "msg1" (from makePartDelta) = 2 unique messages
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by hasChatContent assertion above
		expect(countUniqueMessages(events!)).toBe(2);

		// But OpenCode has 12 messages (turns 1-6, each with user + assistant)
		const fullHistory = {
			messages: Array.from({ length: 12 }, (_, i) => ({
				id: `m${i}`,
				role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			})),
			hasMore: false,
			total: 12,
		};

		// Use the real cache, only mock network-bound calls.
		// getMessages returns 12 messages — more than the 7 unique in cache —
		// so resolveSessionHistory detects staleness and uses the fetched data
		// via buildPreRenderedHistoryFromMessages (single-fetch path).
		const result = await resolveSessionHistory("session-a", {
			messageCache: cache,
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(fullHistory),
				buildPreRenderedHistoryFromMessages: vi
					.fn()
					.mockReturnValue(fullHistory),
			},
			client: {
				getMessages: vi.fn().mockResolvedValue(
					Array.from({ length: 12 }, (_, i) => ({
						id: `m${i}`,
						role: i % 2 === 0 ? "user" : "assistant",
						sessionID: "session-a",
					})),
				),
			},
			log: { info: vi.fn(), warn: vi.fn() },
		});

		// Fix: falls back to REST — all 12 messages visible
		expect(result.source.kind).toBe("rest-history");
		if (result.source.kind === "rest-history") {
			expect(result.source.history.total).toBe(12);
		}
	});

	it("session.status busy/idle no longer produce cached events (handled by status poller)", async () => {
		let activeSession = "session-a";

		// Processing status — now returns null from translator
		const busyResult = processEvent(
			makeSessionStatus("session-a", "busy"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		expect(busyResult).toHaveLength(0); // busy no longer translated

		// Switch to B
		translator.reset();
		activeSession = "session-b";

		// Session A completes (idle) — also returns null from translator
		const idleResult = processEvent(
			makeSessionStatus("session-a", "idle"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		expect(idleResult).toHaveLength(0); // idle no longer translated

		// Verify: no status or done events in cache (handled by status poller now)
		const events = await cache.getEvents("session-a");
		expect(events?.some((e) => e.type === "status")).toBeFalsy();
		expect(events?.some((e) => e.type === "done")).toBeFalsy();
	});

	it("events with missing sessionID fall back to activeSession (recorded to wrong session)", async () => {
		let activeSession = "session-a";

		// Event WITH sessionID → recorded to correct session
		processEvent(
			makePartDelta("session-a", "part1", "correct"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Switch to B
		translator.reset();
		activeSession = "session-b";

		// Event WITHOUT sessionID (hypothetical edge case)
		const noSessionEvent: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {
				partID: "part1",
				delta: "orphaned",
				field: "text",
				// No sessionID!
			},
		};
		processEvent(
			noSessionEvent,
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// BUG: Without sessionID, event is cached under activeSession (session-b)
		// instead of session-a where it belongs
		const sessionAEvents = await cache.getEvents("session-a");
		const sessionBEvents = await cache.getEvents("session-b");

		// The "orphaned" delta should be in session A, but it ends up in session B
		const sessionADeltas =
			sessionAEvents?.filter((e) => e.type === "delta") ?? [];
		const sessionBDeltas =
			sessionBEvents?.filter((e) => e.type === "delta") ?? [];

		// This documents the current behavior: orphaned events go to active session
		expect(sessionADeltas).toHaveLength(1); // Only "correct"
		expect(sessionBDeltas).toHaveLength(1); // "orphaned" ended up here (BUG)
	});

	it("full conversation pipeline: events before AND after switch are all cached", async () => {
		let activeSession = "session-a";

		// Manually add user_message (relay does this directly, not via SSE)
		cache.recordEvent("session-a", { type: "user_message", text: "Hello" });

		// Session A: processing starts — busy no longer produces cached events
		processEvent(
			makeSessionStatus("session-a", "busy"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Session A: text part registered + deltas
		processEvent(
			makePartUpdated("session-a", "p1", "text"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartDelta("session-a", "p1", "Hello! "),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartDelta("session-a", "p1", "I can "),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// ── USER SWITCHES TO SESSION B ──
		translator.reset();
		activeSession = "session-b";

		// Session A continues (agent still working)
		processEvent(
			makePartDelta("session-a", "p1", "help you."),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Tool starts on session A
		processEvent(
			makePartUpdated("session-a", "t1", "tool", "pending", {
				tool: "read",
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartUpdated("session-a", "t1", "tool", "running", {
				tool: "read",
				state: { status: "running", input: { path: "file.ts" } },
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);
		processEvent(
			makePartUpdated("session-a", "t1", "tool", "completed", {
				tool: "read",
				state: { status: "completed", output: "contents" },
			}),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// More text after tool
		processEvent(
			makePartDelta("session-a", "p1", " Here is the file."),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// Session A completes — idle no longer produces cached events
		processEvent(
			makeSessionStatus("session-a", "idle"),
			translator,
			cache,
			activeSession,
			extractSessionId,
		);

		// ── VERIFY: Cache should have conversation events (no status/done from translator) ──
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const events = (await cache.getEvents("session-a"))!;
		expect(events).not.toBeNull();

		const byType = (type: string) => events.filter((e) => e.type === type);

		// user_message (manually recorded)
		expect(byType("user_message")).toHaveLength(1);

		// status/done no longer come from the translator (handled by status poller)
		expect(byType("status")).toHaveLength(0);
		expect(byType("done")).toHaveLength(0);

		// deltas: "Hello! " + "I can " + "help you." + " Here is the file."
		const deltas = byType("delta");
		expect(deltas).toHaveLength(4);
		expect((deltas[0] as { text: string }).text).toBe("Hello! ");
		expect((deltas[1] as { text: string }).text).toBe("I can ");
		expect((deltas[2] as { text: string }).text).toBe("help you.");
		expect((deltas[3] as { text: string }).text).toBe(" Here is the file.");

		// tool events
		expect(byType("tool_start").length).toBeGreaterThanOrEqual(1);
	});
});

// Cleanup
import { afterEach } from "vitest";

afterEach(() => {
	try {
		rmSync(cacheDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});
