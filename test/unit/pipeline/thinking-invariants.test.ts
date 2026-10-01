import { describe, expect, it, vi } from "vitest";

// Mock dompurify — required for chat.svelte.ts imports
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import type {
	SessionActivity,
	SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import type {
	AssistantMessage,
	ChatMessage,
	RelayMessage,
	ThinkingMessage,
} from "../../../src/lib/frontend/types.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";

let _ta: SessionActivity;
let _tm: SessionMessages;

// Helper to create typed relay messages
function _msg<T extends RelayMessage["type"]>(
	type: T,
	data?: Partial<Extract<RelayMessage, { type: T }>>,
): Extract<RelayMessage, { type: T }> {
	return { type, ...data } as Extract<RelayMessage, { type: T }>;
}

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
