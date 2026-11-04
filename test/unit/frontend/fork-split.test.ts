import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";

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

describe("splitAtForkPoint — timestamp-based", () => {
	it("uses message IDs to break timestamp ties even when the boundary is paginated out", () => {
		const before = assistant("before", { messageId: "a", createdAt: 1000 });
		const after = user("after", { messageId: "z", createdAt: 1000 });
		expect(splitAtForkPoint([before, after], "m", 1000)).toEqual({
			inherited: [before],
			current: [after],
		});
		const boundary = assistant("boundary", { messageId: "m", createdAt: 1000 });
		expect(splitAtForkPoint([boundary, after], "m", 1000)).toEqual({
			inherited: [boundary],
			current: [after],
		});
	});
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

// Failure modes (conduit-test-lczrn.1): with equal times whose write order
// differs from id order, a time/id split puts the point's neighbours on the
// wrong side of the divider. The point's row, in the loaded page, carries its
// ordinal; a paged-out point or an older server without ordinals keeps the
// time/id split.
describe("splitAtForkPoint — write order", () => {
	// The child's copies of z and y (written z, y at one time) and its own reply a.
	const history = (ordinals: boolean): ChatMessage[] =>
		historyToChatMessages(
			(
				[
					["z_child", "user", 1],
					["y_child", "assistant", 2],
					["a", "user", 3],
				] as const
			).map(
				([id, role, ordinal]): HistoryMessage => ({
					id,
					role,
					...(ordinals ? { ordinal } : {}),
					time: { created: 10 },
					parts: [{ id: `${id}-p`, type: "text", text: id }],
				}),
			),
		);
	const ids = (messages: ChatMessage[]) =>
		messages.map((message) => message.messageOrder?.id);

	it("cuts at the point's place in write order", () => {
		const atFirst = splitAtForkPoint(history(true), "z", 10, "child");
		expect(ids(atFirst.inherited)).toEqual(["z_child"]);
		expect(ids(atFirst.current)).toEqual(["y_child", "a"]);
		const atSecond = splitAtForkPoint(history(true), "y", 10, "child");
		expect(ids(atSecond.inherited)).toEqual(["z_child", "y_child"]);
		expect(ids(atSecond.current)).toEqual(["a"]);
	});

	it("keeps the time/id split without the point's ordinal", () => {
		const legacy = splitAtForkPoint(history(false), "y", 10, "child");
		expect(ids(legacy.inherited)).toEqual(["y_child", "a"]);
		const pagedOut = splitAtForkPoint(history(true).slice(2), "y", 10, "child");
		expect(ids(pagedOut.inherited)).toEqual(["a"]);
	});
});

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
