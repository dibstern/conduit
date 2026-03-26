// ─── Chunked Replay ──────────────────────────────────────────────────────────
// Verifies the async chunked replayEvents implementation:
// - Returns a promise
// - Manages the replaying flag correctly
// - Processes all events
// - Aborts on rapid replay (clearMessages between replays)
// - Clears replaying flag on abort

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	isReplaying,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function drainReplay(promise: Promise<void>): Promise<void> {
	await vi.runAllTimersAsync();
	await promise;
}

beforeEach(() => {
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Async chunked replayEvents", () => {
	it("replayEvents returns a promise", () => {
		const result = replayEvents([], "test-session");
		expect(result).toBeInstanceOf(Promise);
		// Drain to avoid unhandled rejection
		return drainReplay(result);
	});

	it("replaying flag is true during replay, false after", async () => {
		expect(isReplaying()).toBe(false);

		// Generate enough events to exceed REPLAY_CHUNK_SIZE (80) so there's
		// an actual yield point where replaying is still true mid-flight.
		const events: RelayMessage[] = [];
		for (let i = 0; i < 100; i++) {
			events.push({ type: "user_message", text: `msg-${i}` } as RelayMessage);
		}

		const promise = replayEvents(events, "test-session");

		// Replaying is set synchronously before any awaits
		expect(isReplaying()).toBe(true);

		await drainReplay(promise);

		expect(isReplaying()).toBe(false);
	});

	it("all events are processed after replay completes", async () => {
		const promise = replayEvents(
			[
				{ type: "user_message", text: "first" },
				{ type: "delta", text: "response one" },
				{ type: "done", code: 0 },
				{ type: "user_message", text: "second" },
				{ type: "delta", text: "response two" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		await drainReplay(promise);

		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(2);
		expect((userMsgs[0] as { text: string }).text).toBe("first");
		expect((userMsgs[1] as { text: string }).text).toBe("second");

		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(2);
	});

	it("rapid replay aborts the first replay (clearMessages between replays)", async () => {
		// Start first replay
		const firstPromise = replayEvents(
			[
				{ type: "user_message", text: "from session A" },
				{ type: "delta", text: "response A" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		// Simulate session switch: clearMessages aborts first, then start second
		clearMessages();

		const secondPromise = replayEvents(
			[
				{ type: "user_message", text: "from session B" },
				{ type: "delta", text: "response B" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		await drainReplay(firstPromise);
		await drainReplay(secondPromise);

		// Only session B's events should be present
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("from session B");
	});

	it("replaying is cleared on abort (not left stale)", async () => {
		// Start replay
		const promise = replayEvents(
			[
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "world" },
				{ type: "done", code: 0 },
			] as RelayMessage[],
			"test-session",
		);

		// Abort via clearMessages — sets replaying=false immediately
		clearMessages();
		expect(isReplaying()).toBe(false);

		await drainReplay(promise);

		// Should still be false after drain
		expect(isReplaying()).toBe(false);
	});
});
