// ─── handleDone — thinking block finalization safety net ─────────────────────
// Verifies that handleDone finalizes any unclosed thinking blocks (done=false)
// so they don't spin forever if thinking_stop is lost.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (browser-only) before importing the store
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	chatState,
	clearMessages,
	handleDone,
	handleThinkingDelta,
	handleThinkingStart,
	handleThinkingStop,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import type {
	RelayMessage,
	ThinkingMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Helper: cast incomplete test data to the expected type ─────────────────
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearMessages();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("handleDone — thinking block finalization", () => {
	it("marks unclosed thinking blocks as done when handleDone fires", () => {
		// Simulate a thinking block that started but never got thinking_stop
		handleThinkingStart(msg({ type: "thinking_start" }));
		handleThinkingDelta(msg({ type: "thinking_delta", text: "reasoning..." }));

		// Verify thinking block is open
		const before = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(before).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(before!.done).toBe(false);

		// Fire done without thinking_stop
		handleDone(msg({ type: "done", code: 0 }));

		// Thinking block should now be finalized
		const after = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(after).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(after!.done).toBe(true);
	});

	it("preserves thinking text content after finalization", () => {
		handleThinkingStart(msg({ type: "thinking_start" }));
		handleThinkingDelta(
			msg({ type: "thinking_delta", text: "important reasoning" }),
		);

		handleDone(msg({ type: "done", code: 0 }));

		const m = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by find result
		expect(m!.text).toBe("important reasoning");
	});

	it("does not re-mutate already-done thinking blocks", () => {
		vi.setSystemTime(new Date(1000));
		handleThinkingStart(msg({ type: "thinking_start" }));
		vi.setSystemTime(new Date(3500));
		handleThinkingStop(msg({ type: "thinking_stop" }));

		const beforeDone = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by find result
		expect(beforeDone!.done).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by find result
		const originalDuration = beforeDone!.duration;
		expect(originalDuration).toBe(2500);

		handleDone(msg({ type: "done", code: 0 }));

		const afterDone = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// Duration should be preserved (not reset to 0)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by find result
		expect(afterDone!.duration).toBe(originalDuration);
	});

	it("is a no-op when there are no thinking blocks", () => {
		// handleDone with no messages should not throw
		handleDone(msg({ type: "done", code: 0 }));
		expect(chatState.messages.length).toBe(0);
	});
});
