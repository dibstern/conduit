import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dompurify — required for chat.svelte.ts imports
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

// Helper to create typed relay messages
function msg<T extends RelayMessage["type"]>(
	type: T,
	data?: Partial<Extract<RelayMessage, { type: T }>>,
): Extract<RelayMessage, { type: T }> {
	return { type, ...data } as Extract<RelayMessage, { type: T }>;
}

describe("Thinking block invariants", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearMessages();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("INVARIANT: every ThinkingMessage has done=true after handleDone", () => {
		// Create multiple thinking blocks in various states
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "block 1" }));
		// Block 1: NOT explicitly stopped

		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "block 2" }));
		handleThinkingStop(msg("thinking_stop"));
		// Block 2: properly stopped

		handleThinkingStart(msg("thinking_start"));
		// Block 3: started but no delta or stop

		// Fire handleDone
		handleDone(msg("done", { code: 0 }));

		// INVARIANT: every thinking block is done
		const thinkingBlocks = chatState.messages.filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinkingBlocks.length).toBeGreaterThanOrEqual(1);
		for (const block of thinkingBlocks) {
			expect(block.done).toBe(true);
		}
	});

	it("INVARIANT: thinking text preserved through handleDone finalization", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "important" }));
		handleThinkingDelta(msg("thinking_delta", { text: " reasoning" }));
		// No explicit stop

		handleDone(msg("done", { code: 0 }));

		const thinking = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.text).toContain("important");
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.text).toContain("reasoning");
	});

	it("INVARIANT: handleDone is idempotent for already-done thinking blocks", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "done block" }));
		handleThinkingStop(msg("thinking_stop"));

		const before = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// biome-ignore lint/style/noNonNullAssertion: asserted
		const durationBefore = before!.duration;

		handleDone(msg("done", { code: 0 }));

		const after = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// biome-ignore lint/style/noNonNullAssertion: asserted
		expect(after!.duration).toBe(durationBefore);
	});
});
