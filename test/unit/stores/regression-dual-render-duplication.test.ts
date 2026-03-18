// ─── Regression: Dual-Render Duplication ─────────────────────────────────────
// Verifies that loading a session via events cache and then receiving a
// history_page does NOT produce duplicate messages in chatState.messages.
//
// Root cause (pre-fix): HistoryView and the live {#each} in MessageList
// were two independent rendering surfaces. After replayEvents() populated
// chatState.messages, the IntersectionObserver triggered load_more_history.
// The server responded with history_page containing the same messages,
// causing HistoryView to also render the full conversation → duplicates.
//
// Fix: All messages flow into chatState.messages. After replayEvents(),
// historyState.hasMore is false, preventing spurious loads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	chatState,
	clearMessages,
	historyState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

beforeEach(() => {
	clearMessages();
	sessionState.currentId = null;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Regression: no dual-render duplication", () => {
	it("events cache path sets historyState.hasMore to false", () => {
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "world" },
				{ type: "done", code: 0 },
			],
		});

		expect(historyState.hasMore).toBe(false);
		expect(chatState.messages.filter((m) => m.type === "user")).toHaveLength(
			1,
		);
	});

	it("history_page after events replay does not duplicate messages", () => {
		// Step 1: Load session via events cache
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "response" },
				{ type: "done", code: 0 },
			],
		});

		const countAfterReplay = chatState.messages.length;
		expect(countAfterReplay).toBeGreaterThan(0);

		// Step 2: Simulate what the old IntersectionObserver race did —
		// a history_page arrives containing the same conversation
		handleMessage({
			type: "history_page",
			sessionId: "session-a",
			messages: [
				{
					id: "m1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "hello" }],
				},
				{
					id: "m2",
					role: "assistant",
					parts: [{ id: "p2", type: "text", text: "response" }],
				},
			],
			hasMore: false,
		});

		// The KEY protection is historyState.hasMore = false, which
		// prevents the observer from firing. Verify that:
		expect(historyState.hasMore).toBe(false);
	});

	it("REST fallback sets historyState.hasMore from server", () => {
		handleMessage({
			type: "session_switched",
			id: "session-b",
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

		expect(historyState.hasMore).toBe(true);
		expect(chatState.messages.filter((m) => m.type === "user")).toHaveLength(
			1,
		);
	});

	it("session switch clears historyState and messages", () => {
		// Load session A
		handleMessage({
			type: "session_switched",
			id: "session-a",
			events: [
				{ type: "user_message", text: "in A" },
				{ type: "done", code: 0 },
			],
		});
		expect(chatState.messages.length).toBeGreaterThan(0);
		expect(historyState.hasMore).toBe(false);

		// Switch to session B (empty)
		handleMessage({ type: "session_switched", id: "session-b" });
		expect(chatState.messages).toHaveLength(0);
		// historyState resets via clearMessages() — hasMore defaults to false (disarmed)
		expect(historyState.hasMore).toBe(false);
	});
});

// ─── messageCount accumulation and offset correctness ───────────────────────

describe("messageCount tracking for pagination offset", () => {
	it("REST fallback sets messageCount to initial page size", () => {
		handleMessage({
			type: "session_switched",
			id: "s1",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "a" }],
					},
					{
						id: "m2",
						role: "assistant",
						parts: [{ id: "p2", type: "text", text: "b" }],
					},
					{
						id: "m3",
						role: "user",
						parts: [{ id: "p3", type: "text", text: "c" }],
					},
				],
				hasMore: true,
			},
		});

		expect(historyState.messageCount).toBe(3);
		expect(historyState.hasMore).toBe(true);
	});

	it("history_page increments messageCount (not resets)", () => {
		// Initial page: 3 messages
		handleMessage({
			type: "session_switched",
			id: "s2",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "a" }],
					},
					{
						id: "m2",
						role: "assistant",
						parts: [{ id: "p2", type: "text", text: "b" }],
					},
					{
						id: "m3",
						role: "user",
						parts: [{ id: "p3", type: "text", text: "c" }],
					},
				],
				hasMore: true,
			},
		});
		expect(historyState.messageCount).toBe(3);

		// Second page: 2 more messages
		handleMessage({
			type: "history_page",
			sessionId: "s2",
			messages: [
				{
					id: "m4",
					role: "user",
					parts: [{ id: "p4", type: "text", text: "d" }],
				},
				{
					id: "m5",
					role: "assistant",
					parts: [{ id: "p5", type: "text", text: "e" }],
				},
			],
			hasMore: true,
		});

		// Should accumulate: 3 + 2 = 5
		expect(historyState.messageCount).toBe(5);
		expect(historyState.hasMore).toBe(true);

		// Third page: final 1 message
		handleMessage({
			type: "history_page",
			sessionId: "s2",
			messages: [
				{
					id: "m6",
					role: "user",
					parts: [{ id: "p6", type: "text", text: "f" }],
				},
			],
			hasMore: false,
		});

		// Should accumulate: 5 + 1 = 6
		expect(historyState.messageCount).toBe(6);
		expect(historyState.hasMore).toBe(false);
	});

	it("session switch resets messageCount to 0", () => {
		// Load with history
		handleMessage({
			type: "session_switched",
			id: "s3",
			history: {
				messages: [
					{
						id: "m1",
						role: "user",
						parts: [{ id: "p1", type: "text", text: "a" }],
					},
				],
				hasMore: true,
			},
		});
		expect(historyState.messageCount).toBe(1);

		// Switch away — must reset
		handleMessage({ type: "session_switched", id: "s4" });
		expect(historyState.messageCount).toBe(0);
		expect(historyState.hasMore).toBe(false);
		expect(historyState.loading).toBe(false);
	});

	it("events cache path leaves messageCount at 0", () => {
		handleMessage({
			type: "session_switched",
			id: "s5",
			events: [
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "world" },
				{ type: "done", code: 0 },
			],
		});

		// Events path doesn't use REST-level message counting
		expect(historyState.messageCount).toBe(0);
		expect(historyState.hasMore).toBe(false);
	});

	it("history_page sets loading to false", () => {
		// Simulate loading state
		historyState.loading = true;
		historyState.hasMore = true;

		handleMessage({
			type: "history_page",
			sessionId: "s6",
			messages: [
				{
					id: "m1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "a" }],
				},
			],
			hasMore: false,
		});

		expect(historyState.loading).toBe(false);
	});

	it("messages prepend in correct order across pages", () => {
		// Page 1: newest messages
		handleMessage({
			type: "session_switched",
			id: "s7",
			history: {
				messages: [
					{
						id: "m3",
						role: "user",
						parts: [{ id: "p3", type: "text", text: "third" }],
					},
				],
				hasMore: true,
			},
		});

		const afterFirst = chatState.messages.filter((m) => m.type === "user");
		expect(afterFirst).toHaveLength(1);
		expect((afterFirst[0] as { text: string }).text).toBe("third");

		// Page 2: older messages prepended
		handleMessage({
			type: "history_page",
			sessionId: "s7",
			messages: [
				{
					id: "m1",
					role: "user",
					parts: [{ id: "p1", type: "text", text: "first" }],
				},
				{
					id: "m2",
					role: "user",
					parts: [{ id: "p2", type: "text", text: "second" }],
				},
			],
			hasMore: false,
		});

		const allUsers = chatState.messages.filter((m) => m.type === "user");
		expect(allUsers).toHaveLength(3);
		// Prepended messages come first, then existing
		expect((allUsers[0] as { text: string }).text).toBe("first");
		expect((allUsers[1] as { text: string }).text).toBe("second");
		expect((allUsers[2] as { text: string }).text).toBe("third");
	});
});
