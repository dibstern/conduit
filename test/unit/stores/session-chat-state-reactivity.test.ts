// @vitest-environment jsdom
// Mutates getOrCreateSessionActivity(id) fields; asserts currentChat() reads them. Validates that SvelteMap + $state proxy reactivity propagates
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
import {
	openSessionForSetup,
	setSessionWorkingForSetup,
} from "../../../src/lib/frontend/stories/session-setup.js";
import { applySessionUpsert } from "./session-fixtures.js";

const TEST_ID = "test-reactivity-session";

beforeEach(() => {
	// Clear maps
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	openSessionForSetup(null);
});

describe("two-tier reactivity", () => {
	it("getOrCreateSessionActivity creates a new activity slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		expect(activity.turnGeneration).toBe(0);
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

	it("mutating activity.turnGeneration is observable via the slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		expect(activity.turnGeneration).toBe(0);

		activity.turnGeneration = 1;
		expect(getOrCreateSessionActivity(TEST_ID).turnGeneration).toBe(1);
	});

	it("currentChat() returns EMPTY_STATE when currentId is null", () => {
		openSessionForSetup(null);
		const chat = currentChat();
		expect(chat.turnGeneration).toBe(0);
		expect(chat.messages).toEqual([]);
	});

	it("currentChat() returns EMPTY_STATE when activity slot does not exist", () => {
		openSessionForSetup("nonexistent", "project-a");
		const chat = currentChat();
		expect(chat.turnGeneration).toBe(0);
		expect(chat.messages).toEqual([]);
	});

	it("currentChat() reads from the correct activity slot", () => {
		const activity = getOrCreateSessionActivity(TEST_ID);
		getOrCreateSessionMessages(TEST_ID);
		openSessionForSetup(TEST_ID, "project-a");

		activity.turnGeneration = 7;
		const chat = currentChat();
		expect(chat.turnGeneration).toBe(7);
	});

	it("getSessionPhase reads the row's activity, not its status", () => {
		getOrCreateSessionActivity(TEST_ID);
		applySessionUpsert({ id: TEST_ID, title: TEST_ID, status: "busy" });
		expect(getSessionPhase(TEST_ID)).toBe("idle");
		setSessionWorkingForSetup(TEST_ID, true);
		expect(getSessionPhase(TEST_ID)).toBe("processing");
		setSessionWorkingForSetup(TEST_ID, false);
		expect(getSessionPhase(TEST_ID)).toBe("idle");
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
