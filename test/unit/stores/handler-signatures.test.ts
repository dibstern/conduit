// ─── Handler Signatures Tests ────────────────────────────────────────────────
// Asserts the adapter generic preserves type narrowing; routes through
// getOrCreateSessionSlot(currentId).

import { beforeEach, describe, expect, it, vi } from "vitest";

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
	_resetLRU,
	clearSessionChatState,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	getOrCreateSessionSlot,
	type SessionActivity,
	type SessionMessages,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

const TEST_ID = "test-handler-sig";

beforeEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = TEST_ID;
});

describe("getOrCreateSessionSlot", () => {
	it("returns both activity and messages for a new session", () => {
		const slot = getOrCreateSessionSlot(TEST_ID);
		expect(slot.activity).toBeDefined();
		expect(slot.messages).toBeDefined();
		expect(slot.activity.phase).toBe("idle");
		expect(slot.messages.messages).toEqual([]);
	});

	it("returns the same references on subsequent calls", () => {
		const slot1 = getOrCreateSessionSlot(TEST_ID);
		const slot2 = getOrCreateSessionSlot(TEST_ID);
		expect(slot1.activity).toBe(slot2.activity);
		expect(slot1.messages).toBe(slot2.messages);
	});

	it("routes through getOrCreateSessionActivity + getOrCreateSessionMessages", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		const messages = getOrCreateSessionMessages(TEST_ID);
		const slot = getOrCreateSessionSlot(TEST_ID);

		expect(slot.activity).toBe(activity);
		expect(slot.messages).toBe(messages);
	});

	it("preserves type narrowing — activity has SessionActivity shape", () => {
		const slot = getOrCreateSessionSlot(TEST_ID);
		const activity: SessionActivity = slot.activity;
		expect(activity.phase).toBe("idle");
		expect(activity.turnEpoch).toBe(0);
		expect(activity.doneMessageIds.size).toBe(0);
		expect(activity.seenMessageIds.size).toBe(0);
		expect(activity.liveEventBuffer).toBeNull();
		expect(activity.eventsHasMore).toBe(false);
		expect(activity.renderTimer).toBeNull();
		expect(activity.thinkingStartTime).toBe(0);
	});

	it("preserves type narrowing — messages has SessionMessages shape", () => {
		const slot = getOrCreateSessionSlot(TEST_ID);
		const messages: SessionMessages = slot.messages;
		expect(messages.currentAssistantText).toBe("");
		expect(messages.loadLifecycle).toBe("empty");
		expect(messages.contextPercent).toBe(0);
		expect(messages.historyHasMore).toBe(false);
		expect(messages.historyMessageCount).toBe(0);
		expect(messages.historyLoading).toBe(false);
		expect(messages.toolRegistry).toBeDefined();
	});
});

describe("clearSessionChatState", () => {
	it("removes both tiers for a session", () => {
		getOrCreateSessionSlot(TEST_ID);
		expect(sessionActivity.has(TEST_ID)).toBe(true);
		expect(sessionMessages.has(TEST_ID)).toBe(true);

		clearSessionChatState(TEST_ID);

		expect(sessionActivity.has(TEST_ID)).toBe(false);
		expect(sessionMessages.has(TEST_ID)).toBe(false);
	});

	it("bumps replayGeneration before deletion", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		const originalGen = activity.replayGeneration;

		clearSessionChatState(TEST_ID);

		// The original reference should have the bumped generation
		expect(activity.replayGeneration).toBe(originalGen + 1);
	});

	it("clears renderTimer before deletion", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
		activity.renderTimer = setTimeout(() => {}, 1000);

		clearSessionChatState(TEST_ID);

		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});

	it("is safe to call for nonexistent session", () => {
		expect(() => clearSessionChatState("nonexistent")).not.toThrow();
	});

	it("does not affect other sessions", () => {
		const other = "other-session";
		getOrCreateSessionSlot(TEST_ID);
		getOrCreateSessionSlot(other);

		clearSessionChatState(TEST_ID);

		expect(sessionActivity.has(other)).toBe(true);
		expect(sessionMessages.has(other)).toBe(true);
	});
});

describe("LRU cap enforcement", () => {
	it("evicts oldest Tier 2 entries beyond cap 20", () => {
		// Create 21 sessions — the first should be evicted
		for (let i = 0; i < 21; i++) {
			getOrCreateSessionMessages(`session-${i}`);
		}

		// Session-0 (oldest, not current) should have been evicted
		expect(sessionMessages.has("session-0")).toBe(false);
		// Most recent should still exist
		expect(sessionMessages.has("session-20")).toBe(true);
	});

	it("never evicts the current session", () => {
		sessionState.currentId = "session-0";

		// Create sessions 0..20 (21 total)
		for (let i = 0; i < 21; i++) {
			getOrCreateSessionMessages(`session-${i}`);
		}

		// Session-0 is current — must NOT be evicted
		expect(sessionMessages.has("session-0")).toBe(true);
		// session-1 (next oldest non-current) should have been evicted
		expect(sessionMessages.has("session-1")).toBe(false);
	});
});
