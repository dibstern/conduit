import {
	applySessionChange,
	seedFamilySessions,
	seedSearchResults,
	seedSessions,
} from "./session-fixtures.js";
// Verifies that clearSessionChatState is wired to:
// 1. shell feed removal
// 2. shell snapshot omission and its chat cleanup
// 3. Search query results never trigger cleanup
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
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = "current-session";
	clearSessionState();
	sessionState.searchQuery = "";
	clearSessionState();
	clearMessages();
});

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	_resetLRU();
	sessionState.currentId = null;
	clearSessionState();
});

describe("clearSessionChatState wired to the shell feed", () => {
	it("feed removal cleans up per-session chat state", () => {
		// Pre-populate a session slot
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "deleted-session",
				title: "To Delete",
				status: "idle",
			},
		]);
		getOrCreateSessionSlot("deleted-session");

		expect(sessionActivity.has("deleted-session")).toBe(true);
		expect(sessionMessages.has("deleted-session")).toBe(true);

		applySessionChange({ _tag: "remove", id: "deleted-session" });
		// Per-session state should be cleaned up
		expect(sessionActivity.has("deleted-session")).toBe(false);
		expect(sessionMessages.has("deleted-session")).toBe(false);
		// Session should be removed from the sessions map
		expect(sessionState.sessions.has("deleted-session")).toBe(false);
	});

	it("feed removal of an unknown session is a no-op", () => {
		const activitySizeBefore = sessionActivity.size;
		const messagesSizeBefore = sessionMessages.size;

		applySessionChange({ _tag: "remove", id: "nonexistent" });

		expect(sessionActivity.size).toBe(activitySizeBefore);
		expect(sessionMessages.size).toBe(messagesSizeBefore);
	});
});

describe("shell snapshot omission", () => {
	it("removes membership and evicts cached chat state", () => {
		// Pre-populate sessions map with sessions A, B, C
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-A",
				title: "A",
				status: "idle",
			},
		]);
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-B",
				title: "B",
				status: "idle",
			},
		]);
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-C",
				title: "C",
				status: "idle",
			},
		]);
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");
		getOrCreateSessionSlot("session-C");

		applySessionChange({
			_tag: "snapshot",
			rows: [
				{ id: "session-A", title: "A", status: "idle" },
				{ id: "session-C", title: "C", status: "idle" },
			],
		});

		expect(sessionActivity.has("session-B")).toBe(false);
		expect(sessionMessages.has("session-B")).toBe(false);
		expect(sessionState.sessions.has("session-B")).toBe(false);
		expect(
			sessionState.rootSessions.some((session) => session.id === "session-B"),
		).toBe(false);

		// session-A and session-C should still exist
		expect(sessionState.sessions.has("session-A")).toBe(true);
		expect(sessionState.sessions.has("session-C")).toBe(true);
	});

	it("search query results do not trigger cleanup", () => {
		// Pre-populate sessions map
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-A",
				title: "A",
				status: "idle",
			},
		]);
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-B",
				title: "B",
				status: "idle",
			},
		]);
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");

		// Search results only contain session-A — session-B should NOT be cleaned up
		seedSearchResults([{ id: "session-A", title: "A" }]);

		// session-B should still exist (search results are filtered, not authoritative)
		expect(sessionActivity.has("session-B")).toBe(true);
		expect(sessionMessages.has("session-B")).toBe(true);
		expect(sessionState.sessions.has("session-B")).toBe(true);

		expect(sessionState.searchResults?.map((row) => row.id)).toEqual([
			"session-A",
		]);
	});

	it("an authoritative snapshot triggers cleanup", () => {
		// Pre-populate
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-A",
				title: "A",
				status: "idle",
			},
		]);
		seedSessions([
			...sessionState.sessions.values(),
			{
				id: "session-B",
				title: "B",
				status: "idle",
			},
		]);
		getOrCreateSessionSlot("session-A");
		getOrCreateSessionSlot("session-B");

		applySessionChange({
			_tag: "snapshot",
			rows: [{ id: "session-A", title: "A", status: "idle" }],
		});

		expect(sessionActivity.has("session-B")).toBe(false);
		expect(sessionMessages.has("session-B")).toBe(false);
	});
});

describe("active-session teardown", () => {
	it("feed removal for the active session cleans up state", () => {
		const activeId = "active-session";
		sessionState.currentId = activeId;
		seedSessions([
			...sessionState.sessions.values(),
			{ id: activeId, title: "Active", status: "idle" },
		]);
		getOrCreateSessionSlot(activeId);

		applySessionChange({ _tag: "remove", id: activeId });

		// Per-session state should be cleaned up
		expect(sessionActivity.has(activeId)).toBe(false);
		expect(sessionMessages.has(activeId)).toBe(false);
	});
});

it("switching families preserves the target transcript and removes old family membership", () => {
	seedFamilySessions([
		{ id: "old-root", title: "Old", status: "idle" },
		{ id: "old-child", title: "Child", status: "idle", parentID: "old-root" },
	]);
	const target = getOrCreateSessionSlot("new-child");
	target.messages.messages = [
		{ type: "user", uuid: "cached", text: "Keep this transcript" },
	];
	sessionState.currentId = "new-child";
	seedFamilySessions([
		{ id: "new-root", title: "New", status: "idle" },
		{
			id: "new-child",
			title: "Target",
			status: "idle",
			parentID: "new-root",
		},
	]);
	expect(getOrCreateSessionSlot("new-child").messages.messages).toEqual(
		target.messages.messages,
	);
	expect(getOrCreateSessionSlot("new-child").messages.messages).toHaveLength(1);
	expect(
		sessionState.familySessions.some((session) => session.id === "old-child"),
	).toBe(false);
	expect(sessionState.sessions.has("old-child")).toBe(false);
	expect(sessionState.sessions.has("new-child")).toBe(false);
	expect(
		sessionState.familySessions.find((row) => row.id === "new-child")?.title,
	).toBe("Target");
});
