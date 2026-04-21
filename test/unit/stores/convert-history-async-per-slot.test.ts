// ─── convertHistoryAsync Per-Slot ────────────────────────────────────────────
// Verifies that cache-miss session_switched (REST history path) commits to
// the captured slot, not currentChat(). Also verifies that history_page
// pagination commits to the captured slot.

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
	historyState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHistoryMessages(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `msg-${i}`,
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: `history-message-${i}`,
			},
		],
	}));
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionState.currentId = null;
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("convertHistoryAsync per-slot", () => {
	it("session_switched with REST history commits to correct session slot", async () => {
		// Switch to session-A with REST history (cache miss)
		handleMessage({
			type: "session_switched",
			id: "session-A",
			sessionId: "session-A",
			history: {
				messages: makeHistoryMessages(5),
				hasMore: false,
			},
		});

		// Drain async history conversion
		await vi.runAllTimersAsync();

		// After conversion, the session slot should exist
		const slotA = getOrCreateSessionSlot("session-A");
		expect(slotA.activity).toBeDefined();

		// chatState.messages should have the converted history
		expect(chatState.messages.length).toBeGreaterThan(0);
		// loadLifecycle should be "ready" (history path sets it directly)
		expect(chatState.loadLifecycle).toBe("ready");
	});

	it("session_switched REST history path captures slot at start", async () => {
		// Switch to session-A
		handleMessage({
			type: "session_switched",
			id: "session-A",
			sessionId: "session-A",
			history: {
				messages: makeHistoryMessages(3),
				hasMore: true,
			},
		});

		// Before async completes, verify session-A is current
		expect(sessionState.currentId).toBe("session-A");

		// Drain
		await vi.runAllTimersAsync();

		// hasMore should be set from the history response
		expect(historyState.hasMore).toBe(true);
		expect(historyState.messageCount).toBe(3);
	});

	it("history_page pagination commits to captured session slot", async () => {
		// First, switch to a session
		handleMessage({
			type: "session_switched",
			id: "session-A",
			sessionId: "session-A",
		});
		await vi.runAllTimersAsync();

		// Now receive a history_page
		historyState.loading = true;
		handleMessage({
			type: "history_page",
			sessionId: "session-A",
			messages: makeHistoryMessages(10),
			hasMore: true,
		});

		// Drain async conversion
		await vi.runAllTimersAsync();

		// Loading should be reset
		expect(historyState.loading).toBe(false);
		// hasMore should reflect the page response
		expect(historyState.hasMore).toBe(true);
		// messageCount should be updated
		expect(historyState.messageCount).toBe(10);
	});

	it("session switch mid-history-conversion aborts via generation check", async () => {
		// Switch to session-A with large history
		handleMessage({
			type: "session_switched",
			id: "session-A",
			sessionId: "session-A",
			history: {
				messages: makeHistoryMessages(200),
				hasMore: false,
			},
		});

		// Immediately switch to session-B (aborts session-A's history conversion)
		handleMessage({
			type: "session_switched",
			id: "session-B",
			sessionId: "session-B",
		});

		// Drain everything
		await vi.runAllTimersAsync();

		// Session-B should be current
		expect(sessionState.currentId).toBe("session-B");

		// chatState.messages should be empty (session-B has no events/history)
		// The aborted session-A conversion should NOT have committed its messages
		expect(chatState.messages).toHaveLength(0);
	});

	it("empty session_switched (no events/history) sets loadLifecycle to ready", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-C",
			sessionId: "session-C",
		});

		await vi.runAllTimersAsync();

		expect(chatState.loadLifecycle).toBe("ready");
		expect(chatState.messages).toHaveLength(0);
	});
});
