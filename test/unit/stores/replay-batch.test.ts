// ─── Replay Batch Infrastructure ─────────────────────────────────────────────
// Verifies that the replay batch accumulates mutations in a working array
// instead of replacing chatState.messages on every event (O(N) vs O(N²)).

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
	discardReplayBatch,
	getMessages,
	handleDelta,
	handleDone,
	handleError,
	isProcessing,
	isReplaying,
	isStreaming,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Reset state before each test ───────────────────────────────────────────

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

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

describe("Replay batch infrastructure", () => {
	it("handleDelta during batch does not update chatState.messages", () => {
		beginReplayBatch(ta, tm);

		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "Hello from batch",
		});
		vi.advanceTimersByTime(100);

		// chatState.messages should still be empty — mutations go to the batch
		expect(chatState.messages).toHaveLength(0);

		// But getMessages(tm) should show the accumulated message
		const msgs = getMessages(tm);
		expect(msgs.length).toBeGreaterThan(0);
		const assistant = msgs.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();

		// Clean up
		discardReplayBatch(ta, tm);
	});

	it("commitReplayFinal flushes accumulated messages to chatState", () => {
		beginReplayBatch(ta, tm);

		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "Batched response",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });

		// Before commit: chatState.messages is empty
		expect(chatState.messages).toHaveLength(0);

		// Commit via the production path
		commitReplayFinal(ta, tm, "test-session");

		// After commit: chatState.messages has the accumulated messages
		expect(chatState.messages.length).toBeGreaterThan(0);
		const assistant = chatState.messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { rawText: string }).rawText).toBe("Batched response");
		// loadLifecycle should be "committed"
		expect(chatState.loadLifecycle).toBe("committed");
	});

	it("multiple events accumulate in batch with single commitReplayFinal", () => {
		beginReplayBatch(ta, tm);

		// Simulate a multi-turn conversation replay
		// Turn 1: user + assistant + done
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "First response",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });

		// chatState.messages stays empty the whole time
		expect(chatState.messages).toHaveLength(0);

		// All messages accumulated in the batch
		const batchMsgs = getMessages(tm);
		expect(batchMsgs.length).toBeGreaterThan(0);

		// Single commit flushes everything
		commitReplayFinal(ta, tm, "test-session");
		expect(chatState.messages.length).toBe(batchMsgs.length);
	});

	it("discardReplayBatch throws away accumulated mutations", () => {
		beginReplayBatch(ta, tm);

		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "This will be discarded",
		});
		vi.advanceTimersByTime(100);
		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });

		// Batch has messages
		expect(getMessages(tm).length).toBeGreaterThan(0);
		// chatState is empty
		expect(chatState.messages).toHaveLength(0);

		// Discard
		discardReplayBatch(ta, tm);

		// After discard: getMessages(tm) falls through to chatState.messages (empty)
		expect(getMessages(tm)).toHaveLength(0);
		expect(chatState.messages).toHaveLength(0);
	});

	it("without batch, mutations update chatState.messages immediately (normal path unchanged)", () => {
		// No beginReplayBatch — normal path
		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "Direct update",
		});
		vi.advanceTimersByTime(100);

		// chatState.messages should be updated directly
		expect(chatState.messages.length).toBeGreaterThan(0);
		const assistant = chatState.messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { rawText: string }).rawText).toBe("Direct update");

		handleDone(ta, tm, { type: "done", sessionId: "s1", code: 0 });
	});

	it("handleError during batch accumulates system message in batch", () => {
		beginReplayBatch(ta, tm);

		handleError(ta, tm, {
			type: "error",
			sessionId: "s1",
			code: "ERROR",
			message: "Something failed",
		});

		// chatState.messages stays empty
		expect(chatState.messages).toHaveLength(0);

		// Batch has the system message
		const msgs = getMessages(tm);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.type).toBe("system");
		expect((msgs[0] as { text: string }).text).toBe("Something failed");

		// Commit and verify
		commitReplayFinal(ta, tm, "test-session");
		expect(chatState.messages).toHaveLength(1);
		expect(chatState.messages[0]?.type).toBe("system");
	});

	it("clearMessages during active batch discards batch and resets state", () => {
		beginReplayBatch(ta, tm);

		handleDelta(ta, tm, {
			type: "delta",
			sessionId: "s1",
			text: "In-progress batch",
		});
		vi.advanceTimersByTime(100);

		// Batch has messages
		expect(getMessages(tm).length).toBeGreaterThan(0);

		// clearMessages should discard the batch
		clearMessages();
		ta = testActivity();
		tm = testMessages();

		// Everything is reset
		expect(chatState.messages).toHaveLength(0);
		expect(getMessages(tm)).toHaveLength(0);
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
		expect(isReplaying()).toBe(false);
	});
});
