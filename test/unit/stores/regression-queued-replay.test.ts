// ─── Regression: sentDuringEpoch preserved during replay / session switch ────
// The queued visual is now DERIVED from write-once `sentDuringEpoch` and
// live `turnEpoch`. During replay, `addUserMessage` is called with
// `sentWhileProcessing=true` when the local `llmActive` tracker in
// replayEvents() is true, which sets `sentDuringEpoch` to the current
// `turnEpoch`. The visual clears automatically when `handleDone` increments
// `turnEpoch` past the recorded epoch — no mutation or clearing needed.
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
	// Register sessions so routePerSession's unknown-session guard passes.
	sessionState.sessions.set("test-session", { id: "test-session", title: "" });
	sessionState.sessions.set("s1", { id: "s1", title: "" });
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

/** Mirrors the derived visual logic in UserMessage.svelte. */
function isVisuallyQueued(msg: UserMessage): boolean {
	return (
		msg.sentDuringEpoch != null && chatState.turnEpoch <= msg.sentDuringEpoch
	);
}

/** Replay events with cache-realism validation.
 *  Fails the test if any event has a type that wouldn't exist in the real cache.
 *  Async: drains the event loop so chunked replay completes before assertions. */
async function replayValidated(events: RelayMessage[]): Promise<void> {
	assertCacheRealisticEvents(events);
	replayEvents(events, "test-session");
	await vi.runAllTimersAsync();
}

// ─── Tests ──────────────────────────────────────────────────────────────────
// NOTE: No status events in any event array — they're never in the real cache.

describe("Regression: sentDuringEpoch preserved during replayEvents", () => {
	it("sets sentDuringEpoch when replayed mid-stream", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Responding to first..." },
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(true);
	});

	it("visual clears when done advances turnEpoch during replay", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Response to first" },
			{ type: "user_message", sessionId: "s1", text: "second" },
			{ type: "done", sessionId: "s1", code: 0 },
			{ type: "delta", sessionId: "s1", text: "Response to second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		// sentDuringEpoch is still set (write-once), but turnEpoch advanced past it
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(false);
	});

	it("visual clears when done fires (thinking_start is irrelevant)", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Response" },
			{ type: "user_message", sessionId: "s1", text: "second" },
			{ type: "done", sessionId: "s1", code: 0 },
			{ type: "thinking_start", sessionId: "s1" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(false);
	});

	it("visual clears when done fires (tool_start is irrelevant)", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Response" },
			{ type: "user_message", sessionId: "s1", text: "second" },
			{ type: "done", sessionId: "s1", code: 0 },
			{ type: "tool_start", sessionId: "s1", id: "t1", name: "Read" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(false);
	});

	it("preserves sentDuringEpoch across session switch round-trip", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Partial response" },
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		// First replay
		await replayValidated(events);
		vi.advanceTimersByTime(100);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(userMessages()[1]!)).toBe(true);

		// Switch away
		clearMessages();
		expect(chatState.messages).toHaveLength(0);

		// Switch back
		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(true);
	});

	it("does not set sentDuringEpoch when no prior content", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "hello" },
		];

		await replayValidated(events);

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
	});

	it("does not set sentDuringEpoch after done clears llm activity", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Response" },
			{ type: "done", sessionId: "s1", code: 0 },
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		expect(users[1]?.sentDuringEpoch).toBeUndefined();
	});

	it("sets sentDuringEpoch when user_message follows thinking events", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "thinking_start", sessionId: "s1" },
			{ type: "thinking_delta", sessionId: "s1", text: "Hmm..." },
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(true);
	});

	it("sets sentDuringEpoch when user_message follows tool events", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "tool_start", sessionId: "s1", id: "t1", name: "Read" },
			{
				type: "tool_executing",
				sessionId: "s1",
				id: "t1",
				name: "Read",
				input: undefined,
			},
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users[1]?.sentDuringEpoch).toBe(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[1]!)).toBe(true);
	});

	it("resets llm activity on non-retry error", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "s1", text: "first" },
			{ type: "delta", sessionId: "s1", text: "Partial..." },
			{
				type: "error",
				sessionId: "s1",
				code: "FATAL",
				message: "Something broke",
			},
			{ type: "user_message", sessionId: "s1", text: "second" },
		];

		await replayValidated(events);
		vi.advanceTimersByTime(100);

		const users = userMessages();
		expect(users).toHaveLength(2);
		// Error resets llm activity → second message not queued
		expect(users[1]?.sentDuringEpoch).toBeUndefined();
	});
});

// ─── Multi-tab: live user_message from another client ───────────────────────

describe("Multi-tab: live user_message sentDuringEpoch", () => {
	it("sets sentDuringEpoch on live user_message when session is processing", () => {
		phaseToProcessing();
		handleMessage({
			type: "user_message",
			sessionId: "s1",
			text: "from other tab",
		});

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.sentDuringEpoch).toBe(chatState.turnEpoch);
		// biome-ignore lint/style/noNonNullAssertion: safe — test setup guarantees element
		expect(isVisuallyQueued(users[0]!)).toBe(true);
	});

	it("does not set sentDuringEpoch on live user_message when idle", () => {
		handleMessage({
			type: "user_message",
			sessionId: "s1",
			text: "from other tab",
		});

		const users = userMessages();
		expect(users).toHaveLength(1);
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
	});
});
