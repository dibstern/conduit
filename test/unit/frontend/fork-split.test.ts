import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";

function user(uuid: string): ChatMessage {
	return { type: "user", uuid, text: "hello" };
}

function assistant(uuid: string, messageId?: string): ChatMessage {
	return {
		type: "assistant",
		uuid,
		rawText: "hi",
		html: "hi",
		finalized: true,
		...(messageId != null && { messageId }),
	};
}

function result(uuid: string): ChatMessage {
	return { type: "result", uuid };
}

function tool(uuid: string, messageId?: string): ChatMessage {
	return {
		type: "tool",
		uuid,
		id: "t1",
		name: "Bash",
		status: "completed",
		messageId,
	} as ChatMessage;
}

describe("splitAtForkPoint", () => {
	it("splits at the matching assistant messageId", () => {
		const msgs = [
			user("u1"),
			assistant("a1", "msg_1"),
			user("u2"),
			assistant("a2", "msg_2"),
		];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2", "a2"]);
	});

	it("includes trailing result/tool messages in the same turn", () => {
		const msgs = [
			user("u1"),
			assistant("a1", "msg_1"),
			result("r1"),
			user("u2"),
		];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "a1", "r1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("treats all as inherited when forkMessageId not found", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1")];
		const split = splitAtForkPoint(msgs, "msg_unknown");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});

	it("handles empty messages array", () => {
		const split = splitAtForkPoint([], "msg_1");
		expect(split.inherited).toEqual([]);
		expect(split.current).toEqual([]);
	});

	it("matches on tool messageId too", () => {
		const msgs = [user("u1"), tool("t1", "msg_1"), user("u2")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited.map((m) => m.uuid)).toEqual(["u1", "t1"]);
		expect(split.current.map((m) => m.uuid)).toEqual(["u2"]);
	});

	it("splits at end when fork point is the last message", () => {
		const msgs = [user("u1"), assistant("a1", "msg_1")];
		const split = splitAtForkPoint(msgs, "msg_1");
		expect(split.inherited).toEqual(msgs);
		expect(split.current).toEqual([]);
	});
});
