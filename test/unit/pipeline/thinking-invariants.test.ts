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
	AssistantMessage,
	ChatMessage,
	RelayMessage,
	ThinkingMessage,
} from "../../../src/lib/frontend/types.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";

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

describe("Fork-split thinking invariants", () => {
	function thinking(
		uuid: string,
		opts?: { createdAt?: number; done?: boolean },
	): ThinkingMessage {
		const base: ThinkingMessage = {
			type: "thinking",
			uuid,
			text: `thinking ${uuid}`,
			done: opts?.done ?? true,
		};
		if (opts?.createdAt !== undefined) base.createdAt = opts.createdAt;
		return base;
	}

	function assistant(
		uuid: string,
		opts?: { createdAt?: number; messageId?: string },
	): ChatMessage {
		const base: AssistantMessage = {
			type: "assistant",
			uuid,
			rawText: `response ${uuid}`,
			html: `response ${uuid}`,
			finalized: true,
			messageId: opts?.messageId ?? uuid,
		};
		if (opts?.createdAt !== undefined) base.createdAt = opts.createdAt;
		return base as ChatMessage;
	}

	it("KNOWN LIMITATION: fork-split can separate thinking from its assistant at fork boundary", () => {
		// splitAtForkPoint splits purely on timestamp — it doesn't know
		// that thinking and assistant messages are part of the same turn.
		// When a turn straddles the fork timestamp, thinking (before) and
		// assistant (after) end up in different partitions.
		// This documents the current behavior.
		const forkTs = 2000;
		const messages: ChatMessage[] = [
			// Turn 1 (before fork)
			thinking("t1", { createdAt: 1000 }),
			assistant("a1", { createdAt: 1100 }),
			// Turn 2 (straddles fork — thinking before, assistant after)
			thinking("t2", { createdAt: 1900 }),
			assistant("a2", { createdAt: 2100 }),
			// Turn 3 (after fork)
			thinking("t3", { createdAt: 3000 }),
			assistant("a3", { createdAt: 3100 }),
		];

		const { inherited, current } = splitAtForkPoint(
			messages,
			undefined,
			forkTs,
		);

		// Turn 1: both thinking and assistant in inherited (before fork)
		expect(inherited.some((m) => m.uuid === "t1")).toBe(true);
		expect(inherited.some((m) => m.uuid === "a1")).toBe(true);

		// Turn 3: both in current (after fork)
		expect(current.some((m) => m.uuid === "t3")).toBe(true);
		expect(current.some((m) => m.uuid === "a3")).toBe(true);

		// Turn 2: known limitation — thinking t2 (1900) goes to inherited,
		// assistant a2 (2100) goes to current. They're separated.
		expect(inherited.some((m) => m.uuid === "t2")).toBe(true);
		expect(current.some((m) => m.uuid === "a2")).toBe(true);
	});

	it("INVARIANT: all thinking blocks in both partitions have done=true", () => {
		const messages: ChatMessage[] = [
			thinking("t1", { createdAt: 1000, done: true }),
			assistant("a1", { createdAt: 1100 }),
			thinking("t2", { createdAt: 2000, done: true }),
			assistant("a2", { createdAt: 2100 }),
		];

		const { inherited, current } = splitAtForkPoint(messages, undefined, 1500);

		const allThinking = [...inherited, ...current].filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		for (const t of allThinking) {
			expect(t.done).toBe(true);
		}
	});
});
