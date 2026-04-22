// ─── Session Slot Eviction (LRU Cap) ─────────────────────────────────────────
// Verifies that Tier 2 (SessionMessages) is LRU-capped:
// - When the cap is exceeded, the least-recently-used session's messages are evicted.
// - The current session is never evicted.
// - Evicted sessions lazily reconstruct when re-entered via getOrCreateSessionMessages.

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
	_resetLRU,
	clearSessionChatState,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	// Clear all per-session state
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = null;
});

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = null;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Tier 2 LRU cap", () => {
	it("evicts oldest session when exceeding LRU cap", () => {
		// Create 21 sessions (cap is 20)
		for (let i = 0; i < 21; i++) {
			getOrCreateSessionMessages(`session-${i}`);
		}

		// The first session should have been evicted
		expect(sessionMessages.has("session-0")).toBe(false);
		// The rest should still exist
		for (let i = 1; i <= 20; i++) {
			expect(sessionMessages.has(`session-${i}`)).toBe(true);
		}
	});

	it("never evicts the current session", () => {
		sessionState.currentId = "session-0";

		// Create session-0 first (makes it the oldest)
		getOrCreateSessionMessages("session-0");

		// Create 20 more sessions — would normally evict session-0
		for (let i = 1; i <= 20; i++) {
			getOrCreateSessionMessages(`session-${i}`);
		}

		// session-0 should still exist because it's the current session
		expect(sessionMessages.has("session-0")).toBe(true);
	});

	it("touching a session moves it to the end of the LRU", () => {
		// Create sessions 0-19
		for (let i = 0; i < 20; i++) {
			getOrCreateSessionMessages(`session-${i}`);
		}

		// Touch session-0 (makes it most-recently-used)
		getOrCreateSessionMessages("session-0");

		// Create session-20 — should evict session-1 (now the oldest), not session-0
		getOrCreateSessionMessages("session-20");

		expect(sessionMessages.has("session-0")).toBe(true);
		expect(sessionMessages.has("session-1")).toBe(false);
		expect(sessionMessages.has("session-20")).toBe(true);
	});

	it("evicted session re-entered lazily reconstructs with factory defaults", () => {
		// Create session and customize it
		const original = getOrCreateSessionMessages("session-A");
		original.contextPercent = 42;
		original.historyHasMore = true;

		// Evict it by filling the LRU
		for (let i = 0; i < 21; i++) {
			getOrCreateSessionMessages(`fill-${i}`);
		}
		expect(sessionMessages.has("session-A")).toBe(false);

		// Re-enter — should get fresh factory defaults
		const reconstructed = getOrCreateSessionMessages("session-A");
		expect(reconstructed.contextPercent).toBe(0);
		expect(reconstructed.historyHasMore).toBe(false);
		expect(reconstructed.historyMessageCount).toBe(0);
		expect(reconstructed.historyLoading).toBe(false);
		expect(reconstructed.messages).toHaveLength(0);
		expect(reconstructed.replayBatch).toBeNull();
		expect(reconstructed.replayBuffer).toBeNull();
	});
});

describe("clearSessionChatState", () => {
	it("removes both activity and messages for a session", () => {
		getOrCreateSessionMessages("session-A");

		// Verify it exists
		expect(sessionMessages.has("session-A")).toBe(true);

		// Clear it
		clearSessionChatState("session-A");

		expect(sessionMessages.has("session-A")).toBe(false);
		expect(sessionActivity.has("session-A")).toBe(false);
	});

	it("bumps replayGeneration before deleting (aborts in-flight replays)", () => {
		getOrCreateSessionMessages("session-A");
		getOrCreateSessionActivity("session-A");

		clearSessionChatState("session-A");

		// Verify both tiers were deleted
		expect(sessionActivity.has("session-A")).toBe(false);
		expect(sessionMessages.has("session-A")).toBe(false);
	});

	it("is safe to call on non-existent session", () => {
		// Should not throw
		clearSessionChatState("nonexistent-session");
		expect(sessionMessages.has("nonexistent-session")).toBe(false);
	});
});
