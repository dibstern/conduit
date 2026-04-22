// ─── Ghost Session Cleanup ────────────────────────────────────────────────────
// Verifies that clearSessionChatState is wired to:
// 1. session_deleted relay events
// 2. handleSessionList drop path (diff logic)
// 3. Search-payload guard (search results don't trigger cleanup)
// 4. Active-session teardown

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
	clearMessages,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	handleSessionList,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = "current-session";
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.searchQuery = "";
	sessionState.sessions.clear();
	clearMessages();
});

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = null;
	sessionState.sessions.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("clearSessionChatState wired to session_deleted", () => {
	it("session_deleted event cleans up per-session chat state", () => {
		// Pre-populate a session slot
		sessionState.sessions.set("deleted-session", {
			id: "deleted-session",
			title: "To Delete",
		});
		getOrCreateSessionSlot("deleted-session");

		expect(sessionActivity.has("deleted-session")).toBe(true);
		expect(sessionMessages.has("deleted-session")).toBe(true);

		// Dispatch session_deleted
		handleMessage({
			type: "session_deleted",
			sessionId: "deleted-session",
		} as RelayMessage);

		// Per-session state should be cleaned up
		expect(sessionActivity.has("deleted-session")).toBe(false);
		expect(sessionMessages.has("deleted-session")).toBe(false);
		// Session should be removed from the sessions map
		expect(sessionState.sessions.has("deleted-session")).toBe(false);
	});

	it("session_deleted for unknown session is a no-op", () => {
		const activitySizeBefore = sessionActivity.size;
		const messagesSizeBefore = sessionMessages.size;

		handleMessage({
			type: "session_deleted",
			sessionId: "nonexistent",
		} as RelayMessage);

		expect(sessionActivity.size).toBe(activitySizeBefore);
		expect(sessionMessages.size).toBe(messagesSizeBefore);
	});
});

describe("handleSessionList drop path", () => {
	it("cleans up chat state for sessions removed from session list", () => {
		// Pre-populate sessions map with sessions A, B, C
		sessionState.sessions.set("session-A", {
			id: "session-A",
			title: "A",
		});
		sessionState.sessions.set("session-B", {
			id: "session-B",
			title: "B",
		});
		sessionState.sessions.set("session-C", {
			id: "session-C",
			title: "C",
		});
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");
		getOrCreateSessionSlot("session-C");

		// Incoming session_list with only A and C (B was deleted)
		// roots=undefined means untagged list (backward-compat), triggers diff
		handleSessionList({
			type: "session_list",
			sessions: [
				{ id: "session-A", title: "A" },
				{ id: "session-C", title: "C" },
			],
		} as Extract<RelayMessage, { type: "session_list" }>);

		// session-B should be cleaned up
		expect(sessionActivity.has("session-B")).toBe(false);
		expect(sessionMessages.has("session-B")).toBe(false);
		expect(sessionState.sessions.has("session-B")).toBe(false);

		// session-A and session-C should still exist
		expect(sessionState.sessions.has("session-A")).toBe(true);
		expect(sessionState.sessions.has("session-C")).toBe(true);
	});

	it("search-payload guard: search results do not trigger cleanup", () => {
		// Pre-populate sessions map
		sessionState.sessions.set("session-A", {
			id: "session-A",
			title: "A",
		});
		sessionState.sessions.set("session-B", {
			id: "session-B",
			title: "B",
		});
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");

		// Search results only contain session-A — session-B should NOT be cleaned up
		handleSessionList({
			type: "session_list",
			sessions: [{ id: "session-A", title: "A" }],
			search: true,
		} as Extract<RelayMessage, { type: "session_list" }>);

		// session-B should still exist (search results are filtered, not authoritative)
		expect(sessionActivity.has("session-B")).toBe(true);
		expect(sessionMessages.has("session-B")).toBe(true);
		expect(sessionState.sessions.has("session-B")).toBe(true);

		// Search results should be set
		expect(sessionState.searchResults).toHaveLength(1);
	});

	it("roots=true session_list does not trigger diff cleanup", () => {
		// Pre-populate
		sessionState.sessions.set("session-A", {
			id: "session-A",
			title: "A",
		});
		sessionState.sessions.set("session-B", {
			id: "session-B",
			title: "B",
		});
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");

		// roots=true list with only session-A — should NOT clean up session-B
		// because roots=true is a partial list (only root sessions)
		handleSessionList({
			type: "session_list",
			sessions: [{ id: "session-A", title: "A" }],
			roots: true,
		} as Extract<RelayMessage, { type: "session_list" }>);

		// session-B should still exist
		expect(sessionActivity.has("session-B")).toBe(true);
		expect(sessionMessages.has("session-B")).toBe(true);
	});
});

describe("active-session teardown", () => {
	it("session_deleted for the active session cleans up state", () => {
		const activeId = "active-session";
		sessionState.currentId = activeId;
		sessionState.sessions.set(activeId, { id: activeId, title: "Active" });
		getOrCreateSessionSlot(activeId);

		handleMessage({
			type: "session_deleted",
			sessionId: activeId,
		} as RelayMessage);

		// Per-session state should be cleaned up
		expect(sessionActivity.has(activeId)).toBe(false);
		expect(sessionMessages.has(activeId)).toBe(false);
	});
});
