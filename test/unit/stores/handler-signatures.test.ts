// @vitest-environment jsdom
// Checks the combined session slot and cleanup of in-flight work.

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
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

const TEST_ID = "test-handler-sig";

beforeEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	openSessionForSetup(TEST_ID, "project-a");
});

describe("getOrCreateSessionSlot", () => {
	it("returns both activity and messages for a new session", () => {
		const slot = getOrCreateSessionSlot(TEST_ID);
		expect(slot.activity).toBeDefined();
		expect(slot.messages).toBeDefined();
		expect(slot.activity.phase).toBe("idle");
		expect(slot.activity.turnGeneration).toBe(0);
		expect(slot.activity.doneMessageIds.size).toBe(0);
		expect(slot.activity.seenMessageIds.size).toBe(0);
		expect(slot.activity.renderTimer).toBeNull();
		expect(slot.messages.messages).toEqual([]);
		expect(slot.messages.currentAssistantText).toBe("");
		expect(slot.messages.loadLifecycle).toBe("empty");
		expect(slot.messages.contextPercent).toBe(0);
		expect(slot.messages.historyHasMore).toBe(false);
		expect(slot.messages.historyLoading).toBe(false);
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
});

describe("clearSessionChatState", () => {
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

	it("does not affect other sessions", () => {
		const other = "other-session";
		getOrCreateSessionSlot(TEST_ID);
		getOrCreateSessionSlot(other);

		clearSessionChatState(TEST_ID);

		expect(sessionActivity.has(other)).toBe(true);
		expect(sessionMessages.has(other)).toBe(true);
	});
});
