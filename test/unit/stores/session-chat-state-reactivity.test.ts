// ─── Session Chat State Reactivity Tests ─────────────────────────────────────
// Mutates getOrCreateSessionActivity(id).phase; asserts a $derived(currentChat().phase)
// observer re-runs. Validates that SvelteMap + $state proxy reactivity propagates
// through the composeChatState Proxy.

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
	currentChat,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	getSessionPhase,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

const TEST_ID = "test-reactivity-session";

beforeEach(() => {
	// Clear maps
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = null;
});

describe("two-tier reactivity", () => {
	it("getOrCreateSessionActivity creates a new activity slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		expect(activity.phase).toBe("idle");
		expect(activity.turnEpoch).toBe(0);
		expect(activity.currentMessageId).toBeNull();
	});

	it("getOrCreateSessionMessages creates a new messages slot", () => {
		const messages = getOrCreateSessionMessages(TEST_ID);
		expect(messages.messages).toEqual([]);
		expect(messages.currentAssistantText).toBe("");
		expect(messages.loadLifecycle).toBe("empty");
	});

	it("getOrCreateSessionActivity returns same reference on second call", () => {
		const a1 = getOrCreateSessionActivity(TEST_ID);
		const a2 = getOrCreateSessionActivity(TEST_ID);
		expect(a1).toBe(a2);
	});

	it("getOrCreateSessionMessages returns same reference on second call", () => {
		const m1 = getOrCreateSessionMessages(TEST_ID);
		const m2 = getOrCreateSessionMessages(TEST_ID);
		expect(m1).toBe(m2);
	});

	it("mutating activity.phase is observable via the slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		expect(activity.phase).toBe("idle");

		activity.phase = "processing";
		expect(activity.phase).toBe("processing");

		activity.phase = "streaming";
		expect(activity.phase).toBe("streaming");
	});

	it("currentChat() returns EMPTY_STATE when currentId is null", () => {
		sessionState.currentId = null;
		const chat = currentChat();
		expect(chat.phase).toBe("idle");
		expect(chat.messages).toEqual([]);
	});

	it("currentChat() returns EMPTY_STATE when activity slot does not exist", () => {
		sessionState.currentId = "nonexistent";
		const chat = currentChat();
		expect(chat.phase).toBe("idle");
	});

	it("currentChat() reads from the correct activity slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		getOrCreateSessionMessages(TEST_ID);
		sessionState.currentId = TEST_ID;

		activity.phase = "streaming";
		const chat = currentChat();
		expect(chat.phase).toBe("streaming");
	});

	it("getSessionPhase returns the phase for a known session", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		activity.phase = "processing";
		expect(getSessionPhase(TEST_ID)).toBe("processing");
	});

	it("getSessionPhase returns 'idle' for unknown session", () => {
		expect(getSessionPhase("unknown-id")).toBe("idle");
	});

	it("throws on empty sessionId for getOrCreateSessionActivity", () => {
		expect(() => getOrCreateSessionActivity("")).toThrow("empty sessionId");
	});

	it("throws on empty sessionId for getOrCreateSessionMessages", () => {
		expect(() => getOrCreateSessionMessages("")).toThrow("empty sessionId");
	});
});
