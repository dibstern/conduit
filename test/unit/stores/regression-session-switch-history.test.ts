import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { seedSessions } from "./session-fixtures.js";
// ─── Regression: Session Switch History ──────────────────────────────────────
// Verifies that switching sessions properly clears messages and that
// the ws.svelte.ts handleMessage dispatches session_switched correctly.
//
// Root cause: The relay fetches from OpenCode's REST API on every session
// switch, and the client had a race condition between two separate WS messages
// (session_switched → history_page) with Svelte's $effect microtask scheduling.
//
// Fix: Combined protocol — events/history are included inline in the
// session_switched message itself. The client replays raw events through
// existing handlers (zero conversion, full fidelity) or dispatches structured
// history to HistoryView (REST API fallback).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
// vi.hoisted runs before any imports are resolved.
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
	addUserMessage,
	chatState,
	clearMessages,
	clearSessionChatState,
	getOrCreateSessionMessages,
	getOrCreateSessionSlot,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Reset state before each test ───────────────────────────────────────────

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	sessionState.currentId = "test-session";
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	clearSessionState();
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	// Register sessions so routePerSession's unknown-session guard passes.
	const knownSessionIds = [
		"test-session",
		"s1",
		"s2",
		"s3",
		"session-a",
		"session-b",
		"session-c",
		"session-d",
		"session-e",
		"session-w",
		"session-x",
		"session-y",
		"session-z",
		"new-session",
		"after",
		"parent-with-subagents",
	];
	for (const id of knownSessionIds) {
		clearSessionChatState(id);
		seedSessions([
			...sessionState.sessions.values(),
			{ id, title: "", status: "idle" },
		]);
	}
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── session_switched clears messages ────────────────────────────────────────

describe("Regression: session switch clears messages", () => {
	it("session_switched updates currentId before clearing messages", () => {
		sessionState.currentId = "old-session";
		addUserMessage(ta, tm, "some message");

		routerState.path = "/s/new-session";
		handleMessage({
			type: "session_switched",
			id: "new-session",
			sessionId: "new-session",
		});

		// Both should be updated atomically
		expect(sessionState.currentId).toBe("new-session");
		expect(chatState.messages).toHaveLength(0);
	});
});

// ─── handleMessage dispatches correctly ──────────────────────────────────────

describe("Regression: handleMessage session_switched dispatch", () => {
	it("accepts an initial server switch when the URL names a different session", () => {
		vi.stubGlobal("window", {
			history: { state: null, replaceState: vi.fn() },
		});
		try {
			routerState.path = "/s/recording-session";
			handleMessage({
				type: "session_switched",
				id: "session-a",
				sessionId: "session-a",
				events: [
					{ type: "user_message", sessionId: "session-a", text: "long replay" },
				],
			});
			expect(sessionState.currentId).toBe("session-a");
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("dispatches session_switched to both session and chat stores", () => {
		sessionState.currentId = "before";
		addUserMessage(ta, tm, "will be cleared");

		routerState.path = "/s/after";
		handleMessage({
			type: "session_switched",
			id: "after",
			sessionId: "after",
		});

		expect(sessionState.currentId).toBe("after");
		expect(chatState.messages).toHaveLength(0);
	});

	it("ignores session_switched with missing id", () => {
		sessionState.currentId = "existing";
		addUserMessage(ta, tm, "kept");

		// Deliberately malformed: missing required `id` field — tests defensive handling
		handleMessage({ type: "session_switched" } as unknown as RelayMessage);

		// currentId should NOT change (handleSessionSwitched ignores missing id)
		expect(sessionState.currentId).toBe("existing");
		// Messages ARE still cleared since clearMessages() is always called
		expect(chatState.messages).toHaveLength(0);
	});
});

// ─── Combined protocol: session_switched with events ─────────────────────────

describe("history_page for history pagination", () => {
	it("history_page converts and prepends to chatState.messages", async () => {
		sessionState.currentId = "test-session";
		const slot = getOrCreateSessionSlot("test-session");
		// Seed with a live message so we can verify prepend ordering
		addUserMessage(slot.activity, slot.messages, "live message");

		handleMessage({
			type: "history_page",
			sessionId: sessionState.currentId ?? "test-session",
			messages: [
				{
					id: "m1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "older" }],
				},
			],
			hasMore: false,
		});
		await vi.runAllTimersAsync();

		// Older message should be prepended before live message
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(2);
		expect((userMsgs[0] as { text: string }).text).toBe("older");
		expect((userMsgs[1] as { text: string }).text).toBe("live message");
	});

	it("history_page clears per-session loading and advances pagination state", async () => {
		sessionState.currentId = "session-c";
		const messages = getOrCreateSessionMessages("session-c");
		messages.historyLoading = true;
		messages.historyHasMore = true;

		handleMessage({
			type: "history_page",
			sessionId: "session-c",
			messages: [
				{
					id: "mc1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "from C" }],
				},
			],
			hasMore: false,
		});
		await vi.runAllTimersAsync();

		expect(messages.historyLoading).toBe(false);
		expect(messages.historyHasMore).toBe(false);
		expect(chatState.messages).toHaveLength(1);
	});

	it("multiple rapid session switches only keep last session's state", async () => {
		// Rapid switches: A → B → C
		routerState.path = "/s/session-a";
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
		});
		routerState.path = "/s/session-b";
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});
		routerState.path = "/s/session-c";
		handleMessage({
			type: "session_switched",
			id: "session-c",
			sessionId: "session-c",
		});

		// Only session C should be active
		expect(sessionState.currentId).toBe("session-c");
		expect(chatState.messages).toHaveLength(0);

		// Send history for session C
		handleMessage({
			type: "history_page",
			sessionId: "session-c",
			messages: [
				{
					id: "mc1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "from C" }],
				},
			],
			hasMore: false,
		});
		await vi.runAllTimersAsync();

		// Should have the history page message in chatState.messages
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("from C");
	});
});
