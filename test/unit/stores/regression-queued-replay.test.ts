// ─── Regression: Queued flag preserved during replay / session switch ────────
// Bug: The `queued` visual state on user messages was lost during replay
// because `status: "processing"` events are NEVER cached by the server.
// The prompt handler (prompt.ts:71-74) sends status:processing via
// wsHandler.sendToSession() directly — it never calls recordEvent().
// So during replayEvents(), isProcessing stays false, and
// addUserMessage(text, undefined, isProcessing) never sets queued.
//
// Root cause: replayEvents relied on isProcessing (set by status
// events) to decide if a user_message is queued. But status events aren't
// in the message cache, so processing is always false during replay.
//
// Fix: Use a local `llmActive` tracker in replayEvents() that infers
// queued state from the event structure (delta/thinking/tool = active,
// done/error = inactive) instead of relying on status events.
//
// IMPORTANT: These test event arrays intentionally contain NO status events,
// matching what the real message cache stores (see event-pipeline.ts
// CACHEABLE_TYPES and prompt.ts recordEvent calls).

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
	default: {
		sanitize: (html: string) => html,
	},
}));

import {
	chatState,
	clearMessages,
	clearQueuedFlags,
	phaseToProcessing,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	handleMessage,
	replayEvents,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { UserMessage } from "../../../src/lib/frontend/types.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import { assertCacheRealisticEvents } from "../../helpers/cache-events.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function userMessages(): UserMessage[] {
	return chatState.messages.filter((m): m is UserMessage => m.type === "user");
}

/** Replay events with cache-realism validation.
 *  Fails the test if any event has a type that wouldn't exist in the real cache.
 *  Async: drains the event loop so chunked replay completes before assertions. */
async function replayValidated(events: RelayMessage[]): Promise<void> {
	assertCacheRealisticEvents(events);
	replayEvents(events);
	await vi.runAllTimersAsync();
}

// ─── Tests ──────────────────────────────────────────────────────────────────
// NOTE: No status events in any event array — they're never in the real cache.

describe("Regression: queued flag preserved during replayEvents", () => {
	it("marks user message as queued when replayed mid-stream", async () => {
		// Real cache contents: user_message is recorded by prompt.ts,
		// delta comes from SSE pipeline. No status events are recorded.
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Responding to first..." },
			{ type: "user_message", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100); // flush debounced render

		const users = userMessages();
		expect(users).toHaveLength(2);
		expect(users[0]?.queued).toBeFalsy();
		expect(users[1]?.queued).toBe(true);
	});

	it("clears queued flag when assistant content follows during replay", async () => {
		// LLM finished "first", then started responding to "second"
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Response to first" },
			{ type: "user_message", text: "second" },
			{ type: "done", code: 0 },
			// LLM starts responding to "second"
			{ type: "delta", text: "Response to second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		// "second" was briefly queued but should be cleared when delta arrived
		expect(users[1]?.queued).toBeFalsy();
	});

	it("clears queued flag on thinking_start during replay", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Response" },
			{ type: "user_message", text: "second" },
			{ type: "done", code: 0 },
			// LLM starts thinking about "second"
			{ type: "thinking_start" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.queued).toBeFalsy();
	});

	it("clears queued flag on tool_start during replay", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Response" },
			{ type: "user_message", text: "second" },
			{ type: "done", code: 0 },
			// LLM starts a tool call for "second"
			{ type: "tool_start", id: "t1", name: "Read" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.queued).toBeFalsy();
	});

	it("preserves queued flag across session switch round-trip", async () => {
		// Real cache: no status events, just user_message + delta
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Partial response" },
			{ type: "user_message", text: "second" },
		];

		// First replay (initial load)
		await replayValidated(events);
		vi.advanceTimersByTime(100);
		expect(userMessages()[1]?.queued).toBe(true);

		// Switch away (clears everything)
		clearMessages();
		expect(chatState.messages).toHaveLength(0);

		// Switch back (replay same events)
		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		expect(users[0]?.queued).toBeFalsy();
		expect(users[1]?.queued).toBe(true);
	});

	it("does not mark user message as queued when no prior content", async () => {
		// Message sent while idle — no preceding delta/thinking/tool events
		const events: RelayMessage[] = [{ type: "user_message", text: "hello" }];

		await replayValidated(events);

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.queued).toBeFalsy();
	});

	it("does not mark user message as queued after done clears llm activity", async () => {
		// A completed (done), then user sent B during idle
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Response" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		// "second" was sent after done — LLM was idle, not queued
		expect(users[1]?.queued).toBeFalsy();
	});

	it("marks queued when user_message follows thinking events (no delta)", async () => {
		// LLM thinking (not streaming text) when second message arrives
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "Hmm..." },
			{ type: "user_message", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.queued).toBe(true);
	});

	it("marks queued when user_message follows tool events (no delta)", async () => {
		// LLM executing a tool when second message arrives
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "tool_start", id: "t1", name: "Read" },
			{ type: "tool_executing", id: "t1", name: "Read", input: undefined },
			{ type: "user_message", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.queued).toBe(true);
	});

	it("resets llm activity on non-retry error", async () => {
		// LLM was active, then errored out — next message should NOT be queued
		const events: RelayMessage[] = [
			{ type: "user_message", text: "first" },
			{ type: "delta", text: "Partial..." },
			{ type: "error", code: "FATAL", message: "Something broke" },
			{ type: "user_message", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		// "second" was briefly queued but should be cleared when delta arrived
		expect(users[1]?.queued).toBeFalsy();
	});
});

// ─── Multi-tab: live user_message from another client ───────────────────────

describe("Multi-tab: live user_message queued flag", () => {
	it("marks live user_message as queued when session is processing", () => {
		// Another tab sent a message; this client's session is already processing
		phaseToProcessing();
		handleMessage({ type: "user_message", text: "from other tab" });

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.queued).toBe(true);
	});

	it("does not mark live user_message as queued when idle", () => {
		// Session is idle — message from another tab shouldn't be queued
		handleMessage({ type: "user_message", text: "from other tab" });

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.queued).toBeFalsy();
	});
});

// ─── queuedFlagsCleared state tracking ──────────────────────────────────────

describe("chatState.queuedFlagsCleared tracking", () => {
	it("is false initially", () => {
		expect(chatState.queuedFlagsCleared).toBe(false);
	});

	it("becomes true when clearQueuedFlags is called", () => {
		phaseToProcessing();
		clearQueuedFlags();
		expect(chatState.queuedFlagsCleared).toBe(true);
	});

	it("resets to false when processing starts", () => {
		chatState.queuedFlagsCleared = true;
		handleMessage({ type: "status", status: "processing" });
		expect(chatState.queuedFlagsCleared).toBe(false);
	});

	it("resets to false on clearMessages", () => {
		chatState.queuedFlagsCleared = true;
		clearMessages();
		expect(chatState.queuedFlagsCleared).toBe(false);
	});
});
