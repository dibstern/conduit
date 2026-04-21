// ─── Replay Paging ───────────────────────────────────────────────────────────
// Verifies that commitReplayFinal pages large replays: only the last 50
// messages are committed to chatState.messages, with the rest stored in a
// replay buffer that can be consumed page-by-page.

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
	beginReplayBatch,
	chatState,
	clearMessages,
	commitReplayFinal,
	consumeReplayBuffer,
	getMessages,
	getReplayBuffer,
	historyState,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

/** Create N user messages for test fixtures. */
function makeUserMessages(count: number): ChatMessage[] {
	return Array.from({ length: count }, (_, i) => ({
		type: "user" as const,
		uuid: `uuid-${i}`,
		text: `message-${i}`,
	}));
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("commitReplayFinal paging", () => {
	it("commits all messages when <= 50", () => {
		beginReplayBatch(ta, tm);

		// Manually populate the replay batch with 30 messages
		const msgs = makeUserMessages(30);
		for (const m of msgs) {
			// Use getMessages + setMessages pattern via direct batch manipulation
			const current = getMessages(tm);
			current.push(m);
		}

		commitReplayFinal(ta, tm, "session-1");

		expect(chatState.messages).toHaveLength(30);
		expect(chatState.loadLifecycle).toBe("committed");
		expect(getReplayBuffer(ta, tm, "session-1")).toBeUndefined();
		expect(historyState.hasMore).toBe(false);
	});

	it("commits only last 50 messages when > 50, stores rest in buffer", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(120);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-2");

		// chatState.messages should have the last 50
		expect(chatState.messages).toHaveLength(50);
		expect((chatState.messages[0] as { text: string }).text).toBe("message-70");
		expect((chatState.messages[49] as { text: string }).text).toBe(
			"message-119",
		);

		// Buffer should have the first 70
		const buffer = getReplayBuffer(ta, tm, "session-2");
		expect(buffer).toBeDefined();
		expect(buffer).toHaveLength(70);
		expect((buffer?.[0] as { text: string }).text).toBe("message-0");
		expect((buffer?.[69] as { text: string }).text).toBe("message-69");

		expect(chatState.loadLifecycle).toBe("committed");
		expect(historyState.hasMore).toBe(true);
	});

	it("exactly 50 messages commits all without buffer", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(50);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-exact");

		expect(chatState.messages).toHaveLength(50);
		expect(getReplayBuffer(ta, tm, "session-exact")).toBeUndefined();
		expect(historyState.hasMore).toBe(false);
	});

	it("no-ops when replay batch is null", () => {
		// No beginReplayBatch — batch is null
		commitReplayFinal(ta, tm, "session-noop");

		expect(chatState.messages).toHaveLength(0);
		expect(getReplayBuffer(ta, tm, "session-noop")).toBeUndefined();
	});
});

describe("getReplayBuffer", () => {
	it("returns undefined for unknown session", () => {
		expect(getReplayBuffer(ta, tm, "unknown-session")).toBeUndefined();
	});

	it("returns the stored buffer", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(80);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-buf");

		const buffer = getReplayBuffer(ta, tm, "session-buf");
		expect(buffer).toBeDefined();
		expect(buffer).toHaveLength(30); // 80 - 50 = 30
	});
});

describe("consumeReplayBuffer", () => {
	it("returns messages from the end (most recent) and reduces buffer", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(100);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-consume");

		// Buffer has 50 messages (100 - 50 = 50), messages 0..49
		const buffer = getReplayBuffer(ta, tm, "session-consume");
		expect(buffer).toHaveLength(50);

		// Consume 20 from the end of the buffer
		const page = consumeReplayBuffer(ta, tm, "session-consume", 20);
		expect(page).toHaveLength(20);
		// Should be the most recent 20 from the buffer (messages 30..49)
		expect((page[0] as { text: string }).text).toBe("message-30");
		expect((page[19] as { text: string }).text).toBe("message-49");

		// Buffer should now have 30 remaining
		const remaining = getReplayBuffer(ta, tm, "session-consume");
		expect(remaining).toHaveLength(30);
		expect((remaining?.[0] as { text: string }).text).toBe("message-0");
		expect((remaining?.[29] as { text: string }).text).toBe("message-29");
	});

	it("deletes buffer when fully consumed", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(60);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-full");

		// Buffer has 10 messages (60 - 50 = 10)
		expect(getReplayBuffer(ta, tm, "session-full")).toHaveLength(10);

		// Consume all 10
		const page = consumeReplayBuffer(ta, tm, "session-full", 10);
		expect(page).toHaveLength(10);

		// Buffer should be deleted
		expect(getReplayBuffer(ta, tm, "session-full")).toBeUndefined();
	});

	it("returns empty array for unknown session", () => {
		const page = consumeReplayBuffer(ta, tm, "nonexistent", 10);
		expect(page).toHaveLength(0);
	});

	it("returns empty array when buffer is empty", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(60);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-empty");

		// Consume all
		consumeReplayBuffer(ta, tm, "session-empty", 10);
		expect(getReplayBuffer(ta, tm, "session-empty")).toBeUndefined();

		// Try consuming again
		const page = consumeReplayBuffer(ta, tm, "session-empty", 5);
		expect(page).toHaveLength(0);
	});

	it("clearMessages clears the replay buffer for the current session", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(80);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-clear");

		// Buffer exists
		expect(getReplayBuffer(ta, tm, "session-clear")).toBeDefined();

		// clearMessages should clean up
		clearMessages();

		// Buffer should be gone (clearMessages clears all buffers)
		expect(getReplayBuffer(ta, tm, "session-clear")).toBeUndefined();
	});
});

describe("HistoryLoader buffer integration", () => {
	it("consumeReplayBuffer returns messages from end of buffer (most recent first)", () => {
		// Setup: populate buffer manually via commitReplayFinal, then consume from it.
		// The buffer stores OLDER messages (index 0 = oldest).
		// consumeReplayBuffer(sessionId, count) should return the `count` most-recent
		// messages (from the end of the buffer) and remove them.
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(100);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-hl-1");

		// Buffer has messages 0..49 (the 50 oldest), chatState has messages 50..99
		const buffer = getReplayBuffer(ta, tm, "session-hl-1");
		expect(buffer).toHaveLength(50);

		// Consume 15 — should get the 15 most recent from the buffer (messages 35..49)
		const page = consumeReplayBuffer(ta, tm, "session-hl-1", 15);
		expect(page).toHaveLength(15);
		expect((page[0] as { text: string }).text).toBe("message-35");
		expect((page[14] as { text: string }).text).toBe("message-49");

		// Prepending these to chatState.messages should produce correct order
		chatState.messages = [...page, ...chatState.messages];
		expect(chatState.messages).toHaveLength(65); // 15 + 50
		expect((chatState.messages[0] as { text: string }).text).toBe("message-35");
		expect((chatState.messages[14] as { text: string }).text).toBe(
			"message-49",
		);
		expect((chatState.messages[15] as { text: string }).text).toBe(
			"message-50",
		);

		// Buffer should still have 35 remaining
		const remaining = getReplayBuffer(ta, tm, "session-hl-1");
		expect(remaining).toHaveLength(35);
	});

	it("consumeReplayBuffer empties and deletes buffer when fully consumed", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(70);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-hl-2");

		// Buffer has 20 messages (70 - 50 = 20)
		expect(getReplayBuffer(ta, tm, "session-hl-2")).toHaveLength(20);

		// Consume all 20
		const page = consumeReplayBuffer(ta, tm, "session-hl-2", 20);
		expect(page).toHaveLength(20);

		// Buffer should be fully deleted (not just empty)
		expect(getReplayBuffer(ta, tm, "session-hl-2")).toBeUndefined();

		// Consuming again returns empty array
		const empty = consumeReplayBuffer(ta, tm, "session-hl-2", 10);
		expect(empty).toHaveLength(0);
	});

	it("consuming more than buffer size returns only available messages", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(60);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-hl-3");

		// Buffer has 10 messages (60 - 50 = 10)
		expect(getReplayBuffer(ta, tm, "session-hl-3")).toHaveLength(10);

		// Request 50 but only 10 available
		const page = consumeReplayBuffer(ta, tm, "session-hl-3", 50);
		expect(page).toHaveLength(10);

		// Buffer should be deleted after full consumption
		expect(getReplayBuffer(ta, tm, "session-hl-3")).toBeUndefined();
	});

	it("hasMore reflects remaining buffer state after consumption", () => {
		beginReplayBatch(ta, tm);

		const msgs = makeUserMessages(120);
		for (const m of msgs) {
			getMessages(tm).push(m);
		}

		commitReplayFinal(ta, tm, "session-hl-4");

		// historyState.hasMore should be true (buffer has 70 messages)
		expect(historyState.hasMore).toBe(true);
		expect(getReplayBuffer(ta, tm, "session-hl-4")).toHaveLength(70);

		// Consume 50
		consumeReplayBuffer(ta, tm, "session-hl-4", 50);
		const remaining = getReplayBuffer(ta, tm, "session-hl-4");
		expect(remaining).toHaveLength(20);
		// hasMore should still be true (caller is responsible for updating it)
		// — the store function doesn't mutate historyState

		// Consume remaining 20
		consumeReplayBuffer(ta, tm, "session-hl-4", 20);
		expect(getReplayBuffer(ta, tm, "session-hl-4")).toBeUndefined();
		// After buffer is fully consumed, caller sets hasMore = false
	});
});
