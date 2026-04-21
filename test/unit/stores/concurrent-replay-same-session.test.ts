// ─── Concurrent Replay Same Session ─────────────────────────────────────────
// Verifies that two replayEvents(X) calls for the same session handle
// concurrent access correctly: second call bumps generation and first
// aborts; no cross-pollution; buffer preserved.

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
	getOrCreateSessionSlot,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type {
	AssistantMessage,
	RelayMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionState.currentId = "session-X";
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Concurrent replay same session", () => {
	/** Generate N delta events to exceed REPLAY_CHUNK_SIZE (80) and force yields. */
	function makeLargeReplay(label: string, count: number): RelayMessage[] {
		const events: RelayMessage[] = [
			{ type: "user_message", sessionId: "sX", text: `Question ${label}` },
		];
		for (let i = 0; i < count; i++) {
			events.push({
				type: "delta",
				sessionId: "sX",
				text: `${label}-chunk-${i} `,
			} as RelayMessage);
		}
		events.push({ type: "done", sessionId: "sX", code: 0 } as RelayMessage);
		return events;
	}

	it("second replay aborts first via generation bump when first hits yield point", async () => {
		// First replay: large enough to yield (>80 events)
		const events1 = makeLargeReplay("FIRST", 100);

		// Second replay: small (completes synchronously)
		const events2: RelayMessage[] = [
			{ type: "user_message", sessionId: "sX", text: "Second question" },
			{ type: "delta", sessionId: "sX", text: "Second answer" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		// Start first replay (will yield after 80 events)
		const promise1 = replayEvents(events1, "session-X");

		// Advance to the first yield point
		await vi.advanceTimersByTimeAsync(1);

		// Clear messages between replays to simulate a real session switch
		// (in production, handleMessage("session_switched") calls clearMessages)
		clearMessages();

		// Start second replay — bumps generation, first should abort
		const promise2 = replayEvents(events2, "session-X");

		// Drain both
		await vi.runAllTimersAsync();
		await Promise.allSettled([promise1, promise2]);
		await vi.runAllTimersAsync();

		// The second replay's content should win
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);

		// Should have only the second replay's messages
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("Second question");
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as AssistantMessage).rawText).toBe(
			"Second answer",
		);
	});

	it("generation bump is tracked on per-session activity", async () => {
		const slot = getOrCreateSessionSlot("session-X");
		const genBefore = slot.activity.replayGeneration;

		// First replay
		const events1: RelayMessage[] = [
			{ type: "delta", sessionId: "sX", text: "Content" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		const promise1 = replayEvents(events1, "session-X");

		// Generation should have been bumped by the first replay
		expect(slot.activity.replayGeneration).toBeGreaterThan(genBefore);
		const genAfterFirst = slot.activity.replayGeneration;

		// Drain first replay
		await vi.runAllTimersAsync();
		await promise1;

		// Second replay bumps generation again
		const events2: RelayMessage[] = [
			{ type: "delta", sessionId: "sX", text: "Fresh content" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		const promise2 = replayEvents(events2, "session-X");

		// Generation should have been bumped again
		expect(slot.activity.replayGeneration).toBeGreaterThan(genAfterFirst);

		await vi.runAllTimersAsync();
		await promise2;
		await vi.runAllTimersAsync();

		// Last replay's content should be visible
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
	});

	it("large first replay aborts when second replay starts after clearMessages", async () => {
		// First replay: large enough to require multiple chunks
		const events1 = makeLargeReplay("STALE", 90);

		// Second replay: small
		const events2: RelayMessage[] = [
			{ type: "user_message", sessionId: "sX", text: "Q2" },
			{ type: "delta", sessionId: "sX", text: "A2" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		// Start first (will process 80 events, then yield)
		const promise1 = replayEvents(events1, "session-X");

		// Let first replay reach its yield point
		await vi.advanceTimersByTimeAsync(1);

		// Clear messages (simulating session switch) then start second replay
		clearMessages();
		const promise2 = replayEvents(events2, "session-X");

		// Drain
		await vi.runAllTimersAsync();
		await Promise.allSettled([promise1, promise2]);
		await vi.runAllTimersAsync();

		// Second replay should win — no stale content
		const userTexts = chatState.messages
			.filter((m) => m.type === "user")
			.map((m) => (m as { text: string }).text);

		expect(userTexts).toContain("Q2");
		// No stale content from first replay
		expect(userTexts).not.toContain("Question STALE");
	});

	it("liveEventBuffer is preserved after concurrent replay resolution", async () => {
		const slot = getOrCreateSessionSlot("session-X");

		const events1: RelayMessage[] = [
			{ type: "delta", sessionId: "sX", text: "First" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		const events2: RelayMessage[] = [
			{ type: "delta", sessionId: "sX", text: "Second" },
			{ type: "done", sessionId: "sX", code: 0 },
		];

		const promise1 = replayEvents(events1, "session-X");
		const promise2 = replayEvents(events2, "session-X");

		await vi.runAllTimersAsync();
		await Promise.allSettled([promise1, promise2]);
		await vi.runAllTimersAsync();

		// After both resolve, liveEventBuffer should be null (drained/cleared)
		expect(slot.activity.liveEventBuffer).toBeNull();
	});
});
