import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";

function user(
	uuid: string,
	opts?: { messageId?: string; createdAt?: number },
): ChatMessage {
	return { type: "user", uuid, text: "hello", ...opts };
}

function assistant(
	uuid: string,
	opts?: { messageId?: string; createdAt?: number },
): ChatMessage {
	return {
		type: "assistant",
		uuid,
		rawText: "hi",
		html: "hi",
		finalized: true,
		...opts,
	};
}

function result(uuid: string, opts?: { createdAt?: number }): ChatMessage {
	return { type: "result", uuid, ...opts };
}

function tool(
	uuid: string,
	opts?: { messageId?: string; createdAt?: number },
): ChatMessage {
	return {
		type: "tool",
		uuid,
		id: "t1",
		name: "Bash",
		status: "completed",
		...opts,
	} as ChatMessage;
}

// ─── Timestamp-based splitting ──────────────────────────────────────────────

describe("splitAtForkPoint — timestamp-based", () => {
	it("splits by timestamp: inherited < forkPointTimestamp, current >= forkPointTimestamp", () => {
		const messages: ChatMessage[] = [
			user("u1", { createdAt: 1000 }),
			assistant("a1", { createdAt: 1000 }),
			user("u2", { createdAt: 2000 }),
			assistant("a2", { createdAt: 2000 }),
		];
		const result = splitAtForkPoint(messages, undefined, 1500);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(2);
	});

	it("messages without createdAt (live SSE) are always current", () => {
		const messages: ChatMessage[] = [
			user("u1", { createdAt: 1000 }),
			assistant("a1", { createdAt: 1000 }),
			user("u2"), // no createdAt
			assistant("a2"), // no createdAt
		];
		const result = splitAtForkPoint(messages, undefined, 1500);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(2);
	});

	it("all messages inherited when all have createdAt < forkPointTimestamp", () => {
		const messages: ChatMessage[] = [
			user("u1", { createdAt: 500 }),
			assistant("a1", { createdAt: 500 }),
		];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(0);
	});

	it("all messages current when none have createdAt < forkPointTimestamp", () => {
		const messages: ChatMessage[] = [user("u1", { createdAt: 2000 })];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(0);
		expect(result.current).toHaveLength(1);
	});

	it("works with pagination (older inherited messages prepended)", () => {
		const messages: ChatMessage[] = [
			user("u0", { createdAt: 100 }),
			assistant("a0", { createdAt: 100 }),
			user("u1", { createdAt: 900 }),
			assistant("a1", { createdAt: 900 }),
			user("u2", { createdAt: 2000 }),
		];
		const result = splitAtForkPoint(messages, undefined, 1000);
		expect(result.inherited).toHaveLength(4);
		expect(result.current).toHaveLength(1);
	});

	it("empty messages array returns empty split", () => {
		const result = splitAtForkPoint([], undefined, 1000);
		expect(result.inherited).toHaveLength(0);
		expect(result.current).toHaveLength(0);
	});
});

// ─── ID-based fallback ──────────────────────────────────────────────────────

describe("splitAtForkPoint — ID-based fallback", () => {
	it("falls back to ID matching when forkPointTimestamp is undefined", () => {
		const messages: ChatMessage[] = [
			assistant("a1", { messageId: "msg_fork" }),
			user("u1"),
		];
		const result = splitAtForkPoint(messages, "msg_fork", undefined);
		expect(result.inherited).toHaveLength(1);
		expect(result.current).toHaveLength(1);
	});

	it("splits at the matching assistant messageId", () => {
		const msgs = [
			user("u1"),
			assistant("a1", { messageId: "msg_1" }),
			user("u2"),
			assistant("a2", { messageId: "msg_2" }),
		];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2", "a2"]);
	});

	it("includes trailing result/tool messages in the same turn", () => {
		const msgs = [
			user("u1"),
			assistant("a1", { messageId: "msg_1" }),
			result("r1"),
			user("u2"),
		];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1", "r1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("treats all as inherited when forkMessageId not found", () => {
		const msgs = [user("u1"), assistant("a1", { messageId: "msg_1" })];
		const split = splitAtForkPoint(msgs, "msg_unknown");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});

	it("treats all as inherited when no forkMessageId provided", () => {
		const msgs = [user("u1"), assistant("a1")];
		const split = splitAtForkPoint(msgs);
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});

	it("handles empty messages array", () => {
		const split = splitAtForkPoint([], "msg_1");
		expect(split.inherited).toEqual([]);
		expect(split.current).toEqual([]);
	});

	it("matches on tool messageId too", () => {
		const msgs = [user("u1"), tool("t1", { messageId: "msg_1" }), user("u2")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "t1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("splits at end when fork point is the last message", () => {
		const msgs = [user("u1"), assistant("a1", { messageId: "msg_1" })];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});
});

// ─── Timestamp takes priority ───────────────────────────────────────────────

describe("splitAtForkPoint — timestamp priority", () => {
	it("uses timestamp when both forkMessageId and forkPointTimestamp are provided", () => {
		const messages: ChatMessage[] = [
			user("u1", { createdAt: 1000 }),
			assistant("a1", { messageId: "msg_1", createdAt: 1000 }),
			user("u2", { createdAt: 2000 }),
			assistant("a2", { messageId: "msg_2", createdAt: 2000 }),
		];
		// Timestamp says split at 1500 (between the two pairs)
		// ID "msg_2" would split at a2 (different result)
		const result = splitAtForkPoint(messages, "msg_2", 1500);
		expect(result.inherited).toHaveLength(2);
		expect(result.current).toHaveLength(2);
	});
});
