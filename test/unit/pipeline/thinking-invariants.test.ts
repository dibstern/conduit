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

describe("Error → recovery cycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearMessages();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("error mid-thinking, then new turn — old thinking finalized", () => {
		// Turn 1: thinking starts, no stop
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "old thought" }));
		// Error arrives — handleDone finalizes everything
		handleDone(msg("done", { code: 1 }));

		// Turn 2: new thinking
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "new thought" }));
		handleThinkingStop(msg("thinking_stop"));
		handleDone(msg("done", { code: 0 }));

		const thinkingBlocks = chatState.messages.filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// All thinking blocks (old and new) must be done
		for (const block of thinkingBlocks) {
			expect(block.done).toBe(true);
		}
		expect(thinkingBlocks.length).toBeGreaterThanOrEqual(2);
	});

	it("multiple handleDone calls in sequence — no error, no double-finalization artifacts", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "content" }));
		handleThinkingStop(msg("thinking_stop"));

		// First done
		handleDone(msg("done", { code: 0 }));
		const countAfterFirst = chatState.messages.filter(
			(m) => m.type === "thinking",
		).length;

		// Second done — should not create new messages or crash
		handleDone(msg("done", { code: 0 }));
		const countAfterSecond = chatState.messages.filter(
			(m) => m.type === "thinking",
		).length;

		expect(countAfterSecond).toBe(countAfterFirst);
	});

	it("thinking blocks without handleDone — remain done=false (zombie state)", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "zombie thought" }));
		// NO handleDone — simulates process killed or WS disconnect

		const thinking = chatState.messages.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		// Without handleDone, thinking blocks remain done=false
		// This documents the zombie state — frontend should handle reconnect
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.done).toBe(false);
	});
});

describe("clearMessages + active thinking race", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearMessages();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clearMessages mid-thinking — subsequent delta silently dropped, no crash", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "part 1" }));

		// Mid-stream clear (simulates session switch)
		clearMessages();

		// Delta arrives after clear — no target message exists
		handleThinkingDelta(msg("thinking_delta", { text: "part 2" }));

		// No crash, no orphan thinking block
		expect(chatState.messages).toHaveLength(0);
	});

	it("clearMessages mid-thinking — subsequent stop silently dropped, no crash", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "content" }));

		clearMessages();

		// Stop arrives after clear
		handleThinkingStop(msg("thinking_stop"));

		expect(chatState.messages).toHaveLength(0);
	});

	it("clearMessages mid-thinking — subsequent handleDone is clean no-op", () => {
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "active" }));

		clearMessages();

		// handleDone after clear — should not crash or create zombie thinking
		handleDone(msg("done", { code: 0 }));

		// No orphan thinking blocks with done=false
		const zombies = chatState.messages.filter(
			(m): m is ThinkingMessage => m.type === "thinking" && !m.done,
		);
		expect(zombies).toHaveLength(0);
	});

	it("new thinking after clearMessages — fresh lifecycle works correctly", () => {
		// First thinking
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "old" }));

		clearMessages();

		// New thinking after clear
		handleThinkingStart(msg("thinking_start"));
		handleThinkingDelta(msg("thinking_delta", { text: "fresh" }));
		handleThinkingStop(msg("thinking_stop"));
		handleDone(msg("done", { code: 0 }));

		const thinkingBlocks = chatState.messages.filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		// Only the fresh thinking block — old one was cleared
		expect(thinkingBlocks).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[0]!.text).toBe("fresh");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[0]!.done).toBe(true);
	});
});

// ─── Future feature specs: Rewind / Fork ─────────────────────────────
// These document expected invariants for features not yet implemented.
// Replace it.todo with real tests when implementing.

describe("Rewind feature invariants (TODO)", () => {
	it.todo(
		"rewinding to mid-thinking-block produces valid state — thinking block should be truncated or removed, not left with done=false",
	);

	it.todo(
		"checkpoint at thinking boundary — rewind to just after thinking.end should preserve complete thinking block",
	);

	it.todo(
		"checkpoint mid-thinking — rewind to between thinking.start and thinking.end should discard incomplete thinking",
	);

	it.todo(
		"rewind + replay does not double thinking text — replayed thinking.delta events should be deduplicated via alreadyApplied()",
	);

	it.todo(
		"rewind across tool/permission boundary — approved permission state should be reverted or preserved based on checkpoint policy",
	);

	it.todo(
		"forked session inherits only complete thinking blocks — incomplete thinking at fork point should be excluded from inherited partition",
	);

	it.todo(
		"revert/unrevert round-trip — reverting a rewind should restore the original state exactly, including thinking text and done status",
	);
});
