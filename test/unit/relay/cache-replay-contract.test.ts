// ─── Contract: cache contents ⊆ CACHEABLE_EVENT_TYPES ────────────────────────
// Integration test that verifies the event pipeline's shouldCache() decisions
// produce cache contents that are compatible with the frontend's replayEvents().
//
// The contract:
//   1. Every event the pipeline stores in the cache has a type in CACHEABLE_EVENT_TYPES.
//   2. No "status" events ever reach the cache (they bypass the pipeline entirely).
//   3. The cache contents can be passed to replayEvents() without fabricating
//      events that wouldn't exist in production.
//
// Why this test exists:
// The original queued-message bug was caused by tests that included
// `{ type: "status", status: "processing" }` in replay event arrays.
// Those events never exist in the real cache — the prompt handler sends them
// via sendToSession(), not recordEvent(). Tests passed against fabricated data,
// hiding the bug for months. This contract test prevents that class of error
// by running events through the REAL pipeline and verifying the output.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CACHEABLE_EVENT_TYPES,
	processEvent,
	shouldCache,
} from "../../../src/lib/relay/event-pipeline.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import { MessageCache } from "../../../src/lib/relay/message-cache.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { assertCacheRealisticEvents } from "../../helpers/cache-events.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

let cacheDir: string;
let cache: MessageCache;
let translator: ReturnType<typeof createTranslator>;

const SESSION = "ses_contract_test";

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "cache-replay-contract-"));
	cache = new MessageCache(cacheDir);
	translator = createTranslator();
});

afterEach(() => {
	try {
		rmSync(cacheDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract sessionID from OpenCode SSE event properties. */
function extractSessionId(event: OpenCodeEvent): string | undefined {
	const props = event.properties as Record<string, unknown>;
	if (typeof props["sessionID"] === "string") return props["sessionID"];
	if (props["part"] && typeof props["part"] === "object") {
		const part = props["part"] as Record<string, unknown>;
		if (typeof part["sessionID"] === "string") return part["sessionID"];
	}
	return undefined;
}

/**
 * Run an OpenCode SSE event through the full pipeline:
 *   translate → processEvent → record to cache (if shouldCache)
 * This mirrors the real relay-stack.ts flow.
 */
function pipelineProcess(event: OpenCodeEvent): RelayMessage[] {
	const result = translator.translate(event);
	if (!result.ok) return [];

	const recorded: RelayMessage[] = [];
	for (const msg of result.messages) {
		const sessionId = extractSessionId(event) ?? SESSION;
		const pipelineResult = processEvent(msg, sessionId, ["viewer-1"]);

		if (pipelineResult.cache) {
			cache.recordEvent(sessionId, pipelineResult.msg);
			recorded.push(pipelineResult.msg);
		}
	}
	return recorded;
}

/** Record a user_message directly (prompt handler pattern, not via SSE). */
function recordUserMessage(text: string): void {
	cache.recordEvent(SESSION, { type: "user_message", text });
}

/** Simulate the status:processing broadcast (prompt handler pattern). */
function broadcastProcessing(): RelayMessage {
	// This is what prompt.ts does at line 71-74:
	// deps.wsHandler.sendToSession(activeId, { type: "status", status: "processing" });
	// Note: it does NOT call recordEvent(). The event is sent directly to clients.
	const msg: RelayMessage = { type: "status", status: "processing" };
	// Intentionally NOT recorded to cache — this is the point of the test.
	return msg;
}

// ─── OpenCode SSE Event Factories ───────────────────────────────────────────

function makePartUpdated(
	partID: string,
	partType: string,
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
				sessionID: SESSION,
				...(extra ?? {}),
			},
		},
	};
}

function makePartDelta(
	partID: string,
	delta: string,
	field = "text",
): OpenCodeEvent {
	return {
		type: "message.part.delta",
		properties: {
			sessionID: SESSION,
			messageID: "msg1",
			partID,
			delta,
			field,
		},
	};
}

/**
 * Record a `done` event directly through the pipeline.
 * In production, done events come from the status poller's `became_idle`
 * emission (relay-stack.ts:537), not from SSE translation. The status poller
 * calls processEvent() → applyPipelineResult() which records to the cache.
 */
function recordDone(): void {
	const doneMsg: RelayMessage = { type: "done", code: 0 };
	const result = processEvent(doneMsg, SESSION, ["viewer-1"], "status-poller");
	if (result.cache) {
		cache.recordEvent(SESSION, result.msg);
	}
}

// ─── Contract Tests ─────────────────────────────────────────────────────────

describe("Contract: pipeline cache contents match CACHEABLE_EVENT_TYPES", () => {
	it("shouldCache rejects status events", () => {
		expect(shouldCache("status")).toBe(false);
	});

	it("shouldCache accepts all CACHEABLE_EVENT_TYPES", () => {
		for (const type of CACHEABLE_EVENT_TYPES) {
			expect(shouldCache(type)).toBe(true);
		}
	});

	it("full conversation: cache contains only cacheable event types", () => {
		// ── Simulate the full prompt handler + SSE pipeline flow ──

		// 1. User sends a message (prompt handler records it directly)
		recordUserMessage("What is 2+2?");

		// 2. Prompt handler broadcasts status:processing (NOT cached)
		broadcastProcessing();

		// 3. SSE events arrive from OpenCode
		// Text part registered
		pipelineProcess(makePartUpdated("p-text-1", "text"));

		// Reasoning part (thinking)
		pipelineProcess(makePartUpdated("p-reason-1", "reasoning"));
		pipelineProcess(makePartDelta("p-reason-1", "Let me think..."));

		// Text deltas
		pipelineProcess(makePartDelta("p-text-1", "2+2 equals "));
		pipelineProcess(makePartDelta("p-text-1", "4."));

		// Tool use
		pipelineProcess(
			makePartUpdated("p-tool-1", "tool", {
				tool: "calculator",
				state: { status: "pending" },
			}),
		);
		pipelineProcess(
			makePartUpdated("p-tool-1", "tool", {
				tool: "calculator",
				state: { status: "running", input: { expr: "2+2" } },
			}),
		);
		pipelineProcess(
			makePartUpdated("p-tool-1", "tool", {
				tool: "calculator",
				state: { status: "completed", output: "4" },
			}),
		);

		// Session completed → done event (from status poller, not SSE)
		recordDone();

		// ── Verify the contract ──
		const events = cache.getEvents(SESSION);
		expect(events).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		expect(events!.length).toBeGreaterThan(0);

		// Core contract: every cached event has a cacheable type
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		assertCacheRealisticEvents(events!);

		// Specifically: NO status events in the cache
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		expect(events!.some((e) => e.type === "status")).toBe(false);

		// Verify we got the expected event types
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		const types = new Set(events!.map((e) => e.type));
		expect(types.has("user_message")).toBe(true);
		expect(types.has("delta")).toBe(true);
		expect(types.has("tool_start")).toBe(true);
		expect(types.has("done")).toBe(true);
	});

	it("multi-turn conversation: all cache contents are cacheable", () => {
		// Turn 1
		recordUserMessage("Hello");
		broadcastProcessing();
		pipelineProcess(makePartUpdated("p1", "text"));
		pipelineProcess(makePartDelta("p1", "Hi there!"));
		recordDone();

		// Turn 2 (queued behind turn 1 in the real system)
		recordUserMessage("What's your name?");
		broadcastProcessing();
		pipelineProcess(makePartUpdated("p2", "text"));
		pipelineProcess(makePartDelta("p2", "I'm Claude."));
		recordDone();

		const events = cache.getEvents(SESSION);
		expect(events).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		assertCacheRealisticEvents(events!);

		// Verify both user messages and both responses are present
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		const userMsgs = events!.filter((e) => e.type === "user_message");
		expect(userMsgs).toHaveLength(2);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		const deltas = events!.filter((e) => e.type === "delta");
		expect(deltas).toHaveLength(2);
	});

	it("mid-stream cache (no done event): contents are still cacheable", () => {
		// User sent a message, LLM is still responding (no done event yet)
		recordUserMessage("Think step by step");
		broadcastProcessing();
		pipelineProcess(makePartUpdated("p1", "reasoning"));
		pipelineProcess(makePartDelta("p1", "Step 1: ..."));
		pipelineProcess(makePartUpdated("p2", "text"));
		pipelineProcess(makePartDelta("p2", "Let me explain..."));
		// No done event — session is still processing

		const events = cache.getEvents(SESSION);
		expect(events).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		assertCacheRealisticEvents(events!);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		expect(events!.some((e) => e.type === "done")).toBe(false);
	});

	it("queued message scenario: second user_message while LLM active produces cache-valid events", () => {
		// First message + response starts
		recordUserMessage("First question");
		broadcastProcessing();
		pipelineProcess(makePartUpdated("p1", "text"));
		pipelineProcess(makePartDelta("p1", "Responding..."));

		// Second message arrives while LLM is still active
		// (prompt handler records it directly, broadcasts status again)
		recordUserMessage("Second question");
		broadcastProcessing(); // Also NOT cached

		const events = cache.getEvents(SESSION);
		expect(events).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		assertCacheRealisticEvents(events!);

		// Should have: user_message, delta, user_message (no status events)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		const userMsgs = events!.filter((e) => e.type === "user_message");
		expect(userMsgs).toHaveLength(2);

		// The cache has exactly what replayEvents() needs to infer queued state:
		// user_message → delta → user_message (llmActive=true when second message appears)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by assertion
		expect(events!.some((e) => e.type === "status")).toBe(false);
	});
});

describe("Contract: non-cacheable event types are exhaustively excluded", () => {
	it("status events bypass the pipeline (sent directly by prompt handler)", () => {
		// The prompt handler pattern:
		// 1. recordEvent(sessionId, { type: "user_message", text })  ← cached
		// 2. sendToSession(sessionId, { type: "status", status: "processing" }) ← NOT cached
		//
		// shouldCache("status") must be false
		expect(shouldCache("status" as const)).toBe(false);

		// Verify the pipeline would NOT cache a status event
		const result = processEvent(
			{ type: "status", status: "processing" },
			SESSION,
			["viewer-1"],
		);
		expect(result.cache).toBe(false);
	});

	it("session_list and other non-chat events are not cacheable", () => {
		const nonCacheable = [
			"session_list",
			"session_switched",
			"session_forked",
			"permission_request",
			"permission_resolved",
			"ask_user",
			"ask_user_resolved",
			"ask_user_error",
			"client_count",
			"connection_status",
			"model_list",
			"model_info",
			"agent_list",
			"status",
			"pty_list",
			"pty_output",
			"pty_created",
			"banner",
		] as const;

		for (const type of nonCacheable) {
			expect(shouldCache(type)).toBe(false);
		}
	});

	it("CACHEABLE_EVENT_TYPES is the authoritative list", () => {
		// This test documents exactly what's cacheable.
		// If you add a new cacheable type, this test forces you to update it.
		expect([...CACHEABLE_EVENT_TYPES].sort()).toEqual(
			[
				"delta",
				"done",
				"error",
				"result",
				"thinking_delta",
				"thinking_start",
				"thinking_stop",
				"tool_executing",
				"tool_result",
				"tool_start",
				"user_message",
			].sort(),
		);
	});
});
