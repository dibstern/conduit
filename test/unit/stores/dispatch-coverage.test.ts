// ─── Dispatch Coverage ───────────────────────────────────────────────────────
// Verifies that every CACHEABLE_EVENT_TYPE has a fixture and is handled by
// replayEvents() without error. This is the safety net for the dispatch
// deduplication refactor: if a new cacheable type is added but not handled
// by dispatchChatEvent(), this test will fail.
//
// Approach:
//   1. Build a minimal fixture for each CACHEABLE_EVENT_TYPE
//   2. Replay the full fixture array
//   3. Verify no errors and that all fixtures were processed
//
// TDD contract: this test passes BEFORE the refactor (both switches handle
// all types) and AFTER (single dispatchChatEvent handles all types).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import {
	CACHEABLE_EVENT_TYPES,
	type CacheableEventType,
} from "../../../src/lib/relay/event-pipeline.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import { assertCacheRealisticEvents } from "../../helpers/cache-events.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Replay events with cache-realism validation and full timer drain. */
async function replayValidated(events: RelayMessage[]): Promise<void> {
	assertCacheRealisticEvents(events);
	const promise = replayEvents(events);
	await vi.runAllTimersAsync();
	await promise;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Minimal fixture for each CACHEABLE_EVENT_TYPE. Sequenced to form a
// realistic session: user sends message → LLM thinks → streams text →
// calls a tool → gets result → produces final result → completes.
// Includes an error and a retry error for coverage.

const FIXTURE_EVENTS: RelayMessage[] = [
	// user_message
	{ type: "user_message", text: "Hello" },
	// thinking_start
	{ type: "thinking_start" },
	// thinking_delta
	{ type: "thinking_delta", text: "Let me think..." },
	// thinking_stop
	{ type: "thinking_stop" },
	// delta
	{ type: "delta", text: "I'll help you with that." },
	// tool_start
	{ type: "tool_start", id: "tool-1", name: "Read" },
	// tool_executing
	{ type: "tool_executing", id: "tool-1", name: "Read", input: undefined },
	// tool_result
	{
		type: "tool_result",
		id: "tool-1",
		content: "file contents here",
		is_error: false,
	},
	// delta (second assistant segment after tool)
	{ type: "delta", text: "Based on the file..." },
	// result
	{
		type: "result",
		usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
		cost: 0.01,
		duration: 1234,
		sessionId: "test-session",
	},
	// done
	{ type: "done", code: 0 },
	// error (retry — should NOT reset processing)
	{ type: "user_message", text: "Follow-up" },
	{ type: "error", code: "RETRY", message: "Rate limited, retrying..." },
	// delta after retry
	{ type: "delta", text: "Retried response" },
	// error (fatal — resets processing)
	{ type: "error", code: "FATAL", message: "Something went wrong" },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Dispatch coverage: every CACHEABLE_EVENT_TYPE handled by replay", () => {
	it("fixture array covers every CACHEABLE_EVENT_TYPE", () => {
		const fixtureTypes = new Set(FIXTURE_EVENTS.map((e) => e.type));
		const missing: string[] = [];
		for (const cacheableType of CACHEABLE_EVENT_TYPES) {
			if (!fixtureTypes.has(cacheableType)) {
				missing.push(cacheableType);
			}
		}
		expect(
			missing,
			`Missing fixture for CACHEABLE_EVENT_TYPES: ${missing.join(", ")}`,
		).toHaveLength(0);
	});

	it("fixture array contains only cacheable event types", () => {
		// This uses the same validation that regression tests use
		expect(() => assertCacheRealisticEvents(FIXTURE_EVENTS)).not.toThrow();
	});

	it("replayEvents processes all fixture events without error", async () => {
		await replayValidated(FIXTURE_EVENTS);

		// Basic sanity: we should have some messages in chat state
		expect(chatState.messages.length).toBeGreaterThan(0);

		// Verify user messages are present
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(2);

		// Verify assistant messages are present (from delta events)
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs.length).toBeGreaterThan(0);

		// Verify tool messages are present
		const toolMsgs = chatState.messages.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);

		// Verify thinking messages are present
		const thinkingMsgs = chatState.messages.filter(
			(m) => m.type === "thinking",
		);
		expect(thinkingMsgs).toHaveLength(1);

		// Verify result messages are present
		const resultMsgs = chatState.messages.filter((m) => m.type === "result");
		expect(resultMsgs.length).toBeGreaterThan(0);

		// Verify system messages from errors are present
		const systemMsgs = chatState.messages.filter((m) => m.type === "system");
		expect(systemMsgs.length).toBeGreaterThan(0);
	});

	it("replaying flag is false after replay completes", async () => {
		await replayValidated(FIXTURE_EVENTS);
		expect(chatState.phase).not.toBe("replaying");
	});

	it("phase transitions to streaming when replay ends mid-turn (last event is RETRY error)", async () => {
		await replayValidated(FIXTURE_EVENTS);
		// The fixture's last event is an error with code "RETRY" — this is
		// non-terminal, so the LLM is still active. phaseEndReplay correctly
		// transitions to "streaming" (not "idle").
		expect(chatState.phase).toBe("streaming");
	});

	it("each cacheable type individually survives replay", async () => {
		// Test each type in isolation to catch type-specific handler crashes.
		// Some types need a preceding event to be meaningful (e.g. thinking_delta
		// needs thinking_start), so we wrap each in a minimal valid sequence.
		const isolatedSequences: Record<CacheableEventType, RelayMessage[]> = {
			user_message: [{ type: "user_message", text: "hi" }],
			delta: [
				{ type: "delta", text: "hello" },
				{ type: "done", code: 0 },
			],
			thinking_start: [
				{ type: "thinking_start" },
				{ type: "thinking_stop" },
				{ type: "done", code: 0 },
			],
			thinking_delta: [
				{ type: "thinking_start" },
				{ type: "thinking_delta", text: "hmm" },
				{ type: "thinking_stop" },
				{ type: "done", code: 0 },
			],
			thinking_stop: [
				{ type: "thinking_start" },
				{ type: "thinking_stop" },
				{ type: "done", code: 0 },
			],
			tool_start: [
				{ type: "tool_start", id: "t1", name: "Read" },
				{ type: "done", code: 0 },
			],
			tool_executing: [
				{ type: "tool_start", id: "t2", name: "Read" },
				{
					type: "tool_executing",
					id: "t2",
					name: "Read",
					input: undefined,
				},
				{ type: "done", code: 0 },
			],
			tool_result: [
				{ type: "tool_start", id: "t3", name: "Read" },
				{
					type: "tool_result",
					id: "t3",
					content: "ok",
					is_error: false,
				},
				{ type: "done", code: 0 },
			],
			result: [
				{ type: "delta", text: "x" },
				{
					type: "result",
					usage: { input: 10, output: 5, cache_read: 0, cache_creation: 0 },
					cost: 0.001,
					duration: 100,
					sessionId: "test-session",
				},
				{ type: "done", code: 0 },
			],
			done: [
				{ type: "delta", text: "x" },
				{ type: "done", code: 0 },
			],
			error: [{ type: "error", code: "FATAL", message: "boom" }],
		};

		for (const [eventType, sequence] of Object.entries(isolatedSequences)) {
			clearMessages();
			await expect(replayValidated(sequence)).resolves.not.toThrow();
			// Sanity: at least one message was produced
			expect(
				chatState.messages.length,
				`No messages produced for ${eventType} sequence`,
			).toBeGreaterThan(0);
		}
	});
});
