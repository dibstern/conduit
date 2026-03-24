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
	commitReplayBatch,
	discardReplayBatch,
	getMessages,
	handleDelta,
	handleDone,
	handleError,
	isProcessing,
	isReplaying,
	isStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Replay batch infrastructure", () => {
	it("handleDelta during batch does not update chatState.messages", () => {
		beginReplayBatch();

		handleDelta({ type: "delta", text: "Hello from batch" });
		vi.advanceTimersByTime(100);

		// chatState.messages should still be empty — mutations go to the batch
		expect(chatState.messages).toHaveLength(0);

		// But getMessages() should show the accumulated message
		const msgs = getMessages();
		expect(msgs.length).toBeGreaterThan(0);
		const assistant = msgs.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();

		// Clean up
		discardReplayBatch();
	});

	it("commitReplayBatch flushes accumulated messages to chatState", () => {
		beginReplayBatch();

		handleDelta({ type: "delta", text: "Batched response" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		// Before commit: chatState.messages is empty
		expect(chatState.messages).toHaveLength(0);

		// Commit
		commitReplayBatch();

		// After commit: chatState.messages has the accumulated messages
		expect(chatState.messages.length).toBeGreaterThan(0);
		const assistant = chatState.messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { rawText: string }).rawText).toBe("Batched response");
	});

	it("multiple events accumulate in batch with single commitReplayBatch", () => {
		beginReplayBatch();

		// Simulate a multi-turn conversation replay
		// Turn 1: user + assistant + done
		handleDelta({ type: "delta", text: "First response" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		// chatState.messages stays empty the whole time
		expect(chatState.messages).toHaveLength(0);

		// All messages accumulated in the batch
		const batchMsgs = getMessages();
		expect(batchMsgs.length).toBeGreaterThan(0);

		// Single commit flushes everything
		commitReplayBatch();
		expect(chatState.messages.length).toBe(batchMsgs.length);
	});

	it("discardReplayBatch throws away accumulated mutations", () => {
		beginReplayBatch();

		handleDelta({ type: "delta", text: "This will be discarded" });
		vi.advanceTimersByTime(100);
		handleDone({ type: "done", code: 0 });

		// Batch has messages
		expect(getMessages().length).toBeGreaterThan(0);
		// chatState is empty
		expect(chatState.messages).toHaveLength(0);

		// Discard
		discardReplayBatch();

		// After discard: getMessages() falls through to chatState.messages (empty)
		expect(getMessages()).toHaveLength(0);
		expect(chatState.messages).toHaveLength(0);
	});

	it("without batch, mutations update chatState.messages immediately (normal path unchanged)", () => {
		// No beginReplayBatch — normal path
		handleDelta({ type: "delta", text: "Direct update" });
		vi.advanceTimersByTime(100);

		// chatState.messages should be updated directly
		expect(chatState.messages.length).toBeGreaterThan(0);
		const assistant = chatState.messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		expect((assistant as { rawText: string }).rawText).toBe("Direct update");

		handleDone({ type: "done", code: 0 });
	});

	it("handleError during batch accumulates system message in batch", () => {
		beginReplayBatch();

		handleError({ type: "error", code: "ERROR", message: "Something failed" });

		// chatState.messages stays empty
		expect(chatState.messages).toHaveLength(0);

		// Batch has the system message
		const msgs = getMessages();
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.type).toBe("system");
		expect((msgs[0] as { text: string }).text).toBe("Something failed");

		// Commit and verify
		commitReplayBatch();
		expect(chatState.messages).toHaveLength(1);
		expect(chatState.messages[0]?.type).toBe("system");
	});

	it("clearMessages during active batch discards batch and resets state", () => {
		beginReplayBatch();

		handleDelta({ type: "delta", text: "In-progress batch" });
		vi.advanceTimersByTime(100);

		// Batch has messages
		expect(getMessages().length).toBeGreaterThan(0);

		// clearMessages should discard the batch
		clearMessages();

		// Everything is reset
		expect(chatState.messages).toHaveLength(0);
		expect(getMessages()).toHaveLength(0);
		expect(isStreaming()).toBe(false);
		expect(isProcessing()).toBe(false);
		expect(isReplaying()).toBe(false);
	});
});
