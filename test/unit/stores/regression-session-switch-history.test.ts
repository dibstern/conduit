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
	handleDelta,
	handleDone,
	historyState,
	isProcessing,
	isReplaying,
	isStreaming,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
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
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
	// Register sessions so routePerSession's unknown-session guard passes.
	for (const id of [
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
	]) {
		sessionState.sessions.set(id, { id, title: "" });
	}
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── session_switched clears messages ────────────────────────────────────────

describe("Regression: session switch clears messages", () => {
	it("session_switched via handleMessage clears all chat messages", () => {
		// Simulate a conversation with agent output
		sessionState.currentId = "session-a";
		addUserMessage(ta, tm, "hello agent");
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "I am the agent response",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.messages.length).toBeGreaterThan(0);

		// Switch to a different session
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});

		// Messages must be cleared
		expect(chatState.messages).toHaveLength(0);
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
		expect(chatState.currentAssistantText).toBe("");
		expect(sessionState.currentId).toBe("session-b");
	});

	it("switching back to a session also clears stale messages", () => {
		// Start in session A
		sessionState.currentId = "session-a";
		addUserMessage(ta, tm, "first message in A");
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "response in A",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		const msgCountA = chatState.messages.length;
		expect(msgCountA).toBeGreaterThan(0);

		// Switch to session B
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});
		expect(chatState.messages).toHaveLength(0);

		// Add messages in session B
		addUserMessage(ta, tm, "message in B");
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "response in B",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
		expect(chatState.messages.length).toBeGreaterThan(0);

		// Switch back to session A — must clear B's messages
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
		});
		expect(chatState.messages).toHaveLength(0);
		expect(sessionState.currentId).toBe("session-a");
	});

	it("session_switched updates currentId before clearing messages", () => {
		sessionState.currentId = "old-session";
		addUserMessage(ta, tm, "some message");

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
	it("dispatches session_switched to both session and chat stores", () => {
		sessionState.currentId = "before";
		addUserMessage(ta, tm, "will be cleared");

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

describe("Combined protocol: session_switched with inline events", () => {
	it("replays raw events through chat handlers (full fidelity)", async () => {
		sessionState.currentId = "session-a";
		addUserMessage(ta, tm, "message in A");

		// Switch to session B with cached events
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
			events: [
				{ type: "user_message", sessionId: "s1", text: "hello from B" },
				{ type: "delta", sessionId: "s1", text: "Agent response" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		expect(sessionState.currentId).toBe("session-b");
		// Should have replayed events: user message + assistant message + result
		expect(chatState.messages.length).toBeGreaterThan(0);

		// Find user message
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("hello from B");

		// Find assistant message
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as { rawText: string }).rawText).toBe(
			"Agent response",
		);
	});

	it("replays mid-stream events (no done in events)", async () => {
		// Switch to session B that was mid-stream when we switched away
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
			events: [
				{ type: "user_message", sessionId: "s1", text: "question" },
				{ type: "status", sessionId: "s1", status: "processing" },
				{ type: "delta", sessionId: "s1", text: "Partial respon" },
			],
		});
		await vi.runAllTimersAsync();

		// Should show partial assistant message
		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0] as { rawText: string }).rawText).toBe(
			"Partial respon",
		);
		// Streaming should still be active (no done event)
		expect(isStreaming()).toBe(true);
		expect(isProcessing()).toBe(true);
	});

	it("replays tool events correctly", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-c",
			sessionId: "session-c",
			events: [
				{ type: "user_message", sessionId: "s1", text: "read foo.ts" },
				{ type: "tool_start", sessionId: "s1", id: "t1", name: "Read" },
				{
					type: "tool_executing",
					sessionId: "s1",
					id: "t1",
					name: "Read",
					input: { path: "foo.ts" },
				},
				{
					type: "tool_result",
					sessionId: "s1",
					id: "t1",
					content: "file contents",
					is_error: false,
				},
				{ type: "delta", sessionId: "s1", text: "Here is the file" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		const toolMsgs = chatState.messages.filter((m) => m.type === "tool");
		expect(toolMsgs).toHaveLength(1);
		expect((toolMsgs[0] as { name: string }).name).toBe("Read");
		expect((toolMsgs[0] as { status: string }).status).toBe("completed");
	});

	it("replays thinking events correctly", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-d",
			sessionId: "session-d",
			events: [
				{ type: "user_message", sessionId: "s1", text: "complex question" },
				{ type: "thinking_start", sessionId: "s1" },
				{
					type: "thinking_delta",
					sessionId: "s1",
					text: "Let me think about this...",
				},
				{ type: "thinking_stop", sessionId: "s1" },
				{ type: "delta", sessionId: "s1", text: "Here is my answer" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		const thinkingMsgs = chatState.messages.filter(
			(m) => m.type === "thinking",
		);
		expect(thinkingMsgs).toHaveLength(1);
		expect((thinkingMsgs[0] as { text: string }).text).toBe(
			"Let me think about this...",
		);
		expect((thinkingMsgs[0] as { done: boolean }).done).toBe(true);
	});

	it("replaying flag is set during replay and cleared after", async () => {
		// Before replay
		expect(isReplaying()).toBe(false);

		// Replay is async but with small event arrays (< REPLAY_CHUNK_SIZE)
		// the entire replay completes synchronously (no yield point hit).
		handleMessage({
			type: "session_switched",
			id: "session-e",
			sessionId: "session-e",
			events: [
				{ type: "user_message", sessionId: "s1", text: "hi" },
				{ type: "delta", sessionId: "s1", text: "hello" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		expect(isReplaying()).toBe(false);
	});

	it("rapid session switches: only last session's events are displayed", async () => {
		// Simulate rapid switches
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
			events: [
				{ type: "user_message", sessionId: "s1", text: "message A" },
				{ type: "delta", sessionId: "s1", text: "response A" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});

		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
			events: [
				{ type: "user_message", sessionId: "s1", text: "message B" },
				{ type: "delta", sessionId: "s1", text: "response B" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		// Only session B's events should be present
		expect(sessionState.currentId).toBe("session-b");
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("message B");
	});

	it("session_switched without events or history just clears messages", () => {
		sessionState.currentId = "session-a";
		addUserMessage(ta, tm, "old message");

		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});

		expect(sessionState.currentId).toBe("session-b");
		expect(chatState.messages).toHaveLength(0);
	});
});

// ─── REST API fallback: session_switched with history ────────────────────────

describe("Combined protocol: REST API fallback (history in session_switched)", () => {
	it("converts REST history into chatState.messages", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-x",
			sessionId: "session-x",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "hello" }],
					},
					{
						id: "m2",
						role: "assistant",
						parts: [{ id: "p2", type: "text", text: "hi" }],
					},
				],
				hasMore: false,
				total: 2,
			},
		});
		await vi.runAllTimersAsync();

		// Messages should be in chatState.messages, not dispatched to listeners
		expect(chatState.messages.length).toBeGreaterThan(0);
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
		expect((userMsgs[0] as { text: string }).text).toBe("hello");

		const assistantMsgs = chatState.messages.filter(
			(m) => m.type === "assistant",
		);
		expect(assistantMsgs).toHaveLength(1);
	});

	it("REST fallback populates chatState.messages (not empty)", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-y",
			sessionId: "session-y",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "msg" }],
					},
				],
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		// REST path now puts messages in chatState.messages
		const userMsgs = chatState.messages.filter((m) => m.type === "user");
		expect(userMsgs).toHaveLength(1);
	});

	it("events cache path sets historyState.hasMore to false", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-z",
			sessionId: "session-z",
			events: [
				{ type: "user_message", sessionId: "s1", text: "cached" },
				{ type: "delta", sessionId: "s1", text: "response" },
				{ type: "done", sessionId: "s1", code: 0 },
			],
		});
		await vi.runAllTimersAsync();

		expect(historyState.hasMore).toBe(false);
	});

	it("REST fallback sets historyState.hasMore from server response", async () => {
		handleMessage({
			type: "session_switched",
			id: "session-w",
			sessionId: "session-w",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "msg" }],
					},
				],
				hasMore: true,
			},
		});
		await vi.runAllTimersAsync();

		expect(historyState.hasMore).toBe(true);
	});
});

// ─── history_page handling (load_more_history) ──────────────────────────────

describe("history_page for load_more_history pagination", () => {
	it("history_page converts and prepends to chatState.messages", async () => {
		sessionState.currentId = "test-session";
		// Seed with a live message so we can verify prepend ordering
		addUserMessage(ta, tm, "live message");

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

	it("multiple rapid session switches only keep last session's state", async () => {
		// Rapid switches: A → B → C
		handleMessage({
			type: "session_switched",
			id: "session-a",
			sessionId: "session-a",
		});
		handleMessage({
			type: "session_switched",
			id: "session-b",
			sessionId: "session-b",
		});
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

// ─── Queued state timing (Task 5) ───────────────────────────────────────────
// The queued-state fallback (ensureSentDuringEpochOnLastUnrespondedUser) ONLY
// fires after REST history loads, because that's the one path where messages
// don't go through addUserMessage and sentDuringEpoch can't be set from event
// ordering.  Events replay and live sends both use addUserMessage, which sets
// the correct sentDuringEpoch already.

describe("Queued state timing with REST history", () => {
	it("status:processing sets sentDuringEpoch on unresponded user message from REST history", async () => {
		handleMessage({
			type: "session_switched",
			id: "s1",
			sessionId: "s1",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "waiting" }],
					},
				],
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		// Before status — no sentDuringEpoch
		const usersBefore = chatState.messages.filter((m) => m.type === "user");
		expect(usersBefore[0]?.sentDuringEpoch).toBeUndefined();

		// Status arrives — REST history fallback sets sentDuringEpoch
		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		const usersAfter = chatState.messages.filter((m) => m.type === "user");
		expect(usersAfter[usersAfter.length - 1]?.sentDuringEpoch).toBe(
			chatState.turnEpoch,
		);
	});

	it("status:processing does NOT apply fallback after events replay (only REST history)", async () => {
		// Events replay — addUserMessage sets correct sentDuringEpoch via llmActive
		handleMessage({
			type: "session_switched",
			id: "s2",
			sessionId: "s2",
			events: [
				{ type: "user_message", sessionId: "s1", text: "first" },
				{ type: "delta", sessionId: "s1", text: "responding..." },
				{ type: "user_message", sessionId: "s1", text: "queued" },
			],
		});
		await vi.runAllTimersAsync();

		const usersBefore = chatState.messages.filter((m) => m.type === "user");
		const epochBefore = usersBefore[usersBefore.length - 1]?.sentDuringEpoch;
		expect(epochBefore).toBe(0); // set by replay

		// status:processing arrives — fallback flag NOT set for events replay
		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		const usersAfter = chatState.messages.filter((m) => m.type === "user");
		expect(usersAfter[usersAfter.length - 1]?.sentDuringEpoch).toBe(
			epochBefore,
		);
	});

	it("status:processing does NOT apply fallback for normal live sends", () => {
		// User sends a message to an idle session — NOT queued
		addUserMessage(ta, tm, "hello");
		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		const users = chatState.messages.filter((m) => m.type === "user");
		// sentDuringEpoch should NOT be set — message was sent to idle session
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
	});

	it("status:processing skips messages that already have an assistant response", async () => {
		handleMessage({
			type: "session_switched",
			id: "s3",
			sessionId: "s3",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "hello" }],
					},
					{
						id: "m2",
						role: "assistant",
						parts: [{ id: "p2", type: "text", text: "hi" }],
					},
				],
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		// User message has a response after it — fallback should NOT set sentDuringEpoch
		const users = chatState.messages.filter((m) => m.type === "user");
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
	});

	it("status:processing does NOT overwrite existing sentDuringEpoch (write-once)", async () => {
		// Simulate replay that already set sentDuringEpoch
		handleMessage({
			type: "session_switched",
			id: "s2",
			sessionId: "s2",
			events: [
				{ type: "user_message", sessionId: "s1", text: "first" },
				{ type: "delta", sessionId: "s1", text: "responding..." },
				{ type: "user_message", sessionId: "s1", text: "queued" },
			],
		});
		await vi.runAllTimersAsync();

		const usersBefore = chatState.messages.filter((m) => m.type === "user");
		const epochBefore = usersBefore[usersBefore.length - 1]?.sentDuringEpoch;
		expect(epochBefore).toBe(0); // set by replay

		// status:processing arrives — should NOT change the existing value
		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		const usersAfter = chatState.messages.filter((m) => m.type === "user");
		expect(usersAfter[usersAfter.length - 1]?.sentDuringEpoch).toBe(
			epochBefore,
		);
	});

	it("status:processing skips messages that already have an assistant response", async () => {
		handleMessage({
			type: "session_switched",
			id: "s3",
			sessionId: "s3",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "hello" }],
					},
					{
						id: "m2",
						role: "assistant",
						parts: [{ id: "p2", type: "text", text: "hi" }],
					},
				],
				hasMore: false,
			},
		});
		await vi.runAllTimersAsync();

		handleMessage({ type: "status", sessionId: "s1", status: "processing" });

		// User message has a response — should NOT get sentDuringEpoch
		const users = chatState.messages.filter((m) => m.type === "user");
		expect(users[0]?.sentDuringEpoch).toBeUndefined();
	});
});
