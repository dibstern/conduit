// ─── Svelte History Logic — Unit Tests ───────────────────────────────────────
// Tests groupIntoTurns, findPageBoundary, historyToChatMessages, applyHistoryQueuedFlag.

import { describe, expect, test } from "vitest";
import { splitAtForkPoint } from "../../../src/lib/frontend/utils/fork-split.js";
import type { HistoryMessage } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	findPageBoundary,
	groupIntoTurns,
	historyToChatMessages,
} from "../../../src/lib/frontend/utils/history-logic.js";

// ─── Helper factories ────────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", id: string): HistoryMessage {
	return { id, role };
}

function userMsg(id: string): HistoryMessage {
	return makeMsg("user", id);
}

function assistantMsg(id: string): HistoryMessage {
	return makeMsg("assistant", id);
}

// ─── groupIntoTurns ──────────────────────────────────────────────────────────

describe("groupIntoTurns", () => {
	test("returns empty array for empty messages", () => {
		expect(groupIntoTurns([])).toEqual([]);
	});

	test("groups a user+assistant pair into one turn", () => {
		const msgs = [userMsg("u1"), assistantMsg("a1")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.id).toBe("a1");
	});

	test("groups multiple user+assistant pairs", () => {
		const msgs = [
			userMsg("u1"),
			assistantMsg("a1"),
			userMsg("u2"),
			assistantMsg("a2"),
		];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.id).toBe("a1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user?.id).toBe("u2");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant?.id).toBe("a2");
	});

	test("handles user message without assistant response", () => {
		const msgs = [userMsg("u1")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant).toBeUndefined();
	});

	test("handles orphan assistant message (no preceding user)", () => {
		const msgs = [assistantMsg("a1")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.id).toBe("a1");
	});

	test("handles orphan assistant followed by user+assistant pair", () => {
		const msgs = [assistantMsg("a0"), userMsg("u1"), assistantMsg("a1")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.id).toBe("a0");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant?.id).toBe("a1");
	});

	test("handles user, user (back to back user messages)", () => {
		const msgs = [userMsg("u1"), userMsg("u2")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user?.id).toBe("u2");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant).toBeUndefined();
	});

	test("handles user, user, assistant (second user gets the assistant)", () => {
		const msgs = [userMsg("u1"), userMsg("u2"), assistantMsg("a2")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.id).toBe("u1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user?.id).toBe("u2");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant?.id).toBe("a2");
	});

	test("handles assistant, assistant (both orphan)", () => {
		const msgs = [assistantMsg("a1"), assistantMsg("a2")];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.id).toBe("a1");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant?.id).toBe("a2");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user).toBeUndefined();
	});

	test("preserves message content through grouping", () => {
		const u: HistoryMessage = {
			id: "u1",
			role: "user",
			parts: [{ id: "p1", type: "text", text: "hello" }],
			time: { created: 1000 },
		};
		const a: HistoryMessage = {
			id: "a1",
			role: "assistant",
			parts: [{ id: "p2", type: "text", text: "hi" }],
			time: { created: 1001, completed: 1002 },
		};
		const turns = groupIntoTurns([u, a]);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user).toBe(u);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant).toBe(a);
	});
});

// ─── findPageBoundary ────────────────────────────────────────────────────────

describe("findPageBoundary", () => {
	test("returns 0 for targetCount 0", () => {
		const msgs = [userMsg("u1"), assistantMsg("a1")];
		expect(findPageBoundary(msgs, 0)).toBe(0);
	});

	test("returns messages.length when targetCount >= length", () => {
		const msgs = [userMsg("u1"), assistantMsg("a1")];
		expect(findPageBoundary(msgs, 10)).toBe(2);
		expect(findPageBoundary(msgs, 2)).toBe(2);
	});

	test("extends boundary when it would split a user+assistant pair", () => {
		// Messages: [user, assistant, user, assistant]
		// targetCount = 1: boundary is on user at index 0, next is assistant -> extend to 2
		const msgs = [
			userMsg("u1"),
			assistantMsg("a1"),
			userMsg("u2"),
			assistantMsg("a2"),
		];
		expect(findPageBoundary(msgs, 1)).toBe(2);
	});

	test("does not extend when boundary is on assistant", () => {
		const msgs = [
			userMsg("u1"),
			assistantMsg("a1"),
			userMsg("u2"),
			assistantMsg("a2"),
		];
		// targetCount = 2: boundary is on assistant at index 1, no extension needed
		expect(findPageBoundary(msgs, 2)).toBe(2);
	});

	test("does not extend when user is followed by user", () => {
		const msgs = [userMsg("u1"), userMsg("u2"), assistantMsg("a2")];
		// targetCount = 1: boundary is user at index 0, next is user (not assistant) -> no extension
		expect(findPageBoundary(msgs, 1)).toBe(1);
	});

	test("extends when user at boundary is last before assistant", () => {
		const msgs = [
			userMsg("u1"),
			assistantMsg("a1"),
			userMsg("u2"),
			assistantMsg("a2"),
		];
		// targetCount = 3: boundary is on user "u2" at index 2, next is assistant -> extend to 4
		expect(findPageBoundary(msgs, 3)).toBe(4);
	});

	test("handles empty messages array", () => {
		expect(findPageBoundary([], 5)).toBe(0);
	});

	test("handles single message", () => {
		expect(findPageBoundary([userMsg("u1")], 1)).toBe(1);
	});

	test("does not extend past array length", () => {
		const msgs = [userMsg("u1")];
		// targetCount = 1, boundary is user, but no next message -> no extension
		expect(findPageBoundary(msgs, 1)).toBe(1);
	});
});

// shouldLoadMore and getOldestMessageId tests removed — functions deleted
// as dead code after the unified rendering migration (HistoryView removed).

// ─── OpenCode normalized format ─────────────────────────────────────────────

describe("groupIntoTurns with OpenCode normalized messages", () => {
	test("works with full normalized message format (role + parts + time)", () => {
		const msgs: HistoryMessage[] = [
			{
				id: "m1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
				time: { created: 1000 },
			},
			{
				id: "m2",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "hi there" }],
				time: { created: 1001, completed: 1002 },
			},
		];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.role).toBe("user");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.parts?.[0]?.text).toBe("hello");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.role).toBe("assistant");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.parts?.[0]?.text).toBe("hi there");
	});

	test("correctly groups multi-turn conversation from OpenCode", () => {
		const msgs: HistoryMessage[] = [
			{
				id: "u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "What is 2+2?" }],
			},
			{
				id: "a1",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "4" }],
			},
			{
				id: "u2",
				role: "user",
				parts: [{ id: "p3", type: "text", text: "And 3+3?" }],
			},
			{
				id: "a2",
				role: "assistant",
				parts: [{ id: "p4", type: "text", text: "6" }],
			},
		];
		const turns = groupIntoTurns(msgs);
		expect(turns).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.user?.parts?.[0]?.text).toBe("What is 2+2?");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[0]!.assistant?.parts?.[0]?.text).toBe("4");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.user?.parts?.[0]?.text).toBe("And 3+3?");
		// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
		expect(turns[1]!.assistant?.parts?.[0]?.text).toBe("6");
	});
});

// ─── Tool status mapping ─────────────────────────────────────────────────────

describe("historyToChatMessages — tool status mapping", () => {
	test("Task tools preserve running status from REST API", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_asst",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						callID: "toolu_123",
						tool: "task",
						state: {
							status: "running",
							input: {
								description: "do stuff",
								subagent_type: "general",
							},
						},
					},
				],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("running");
	});

	test("Task tools preserve pending status from REST API", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_asst",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						callID: "toolu_456",
						tool: "task",
						state: { status: "pending" },
					},
				],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("pending");
	});

	test("completed Task tools stay completed", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_asst",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						callID: "toolu_789",
						tool: "task",
						state: { status: "completed", output: "done" },
					},
				],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("completed");
	});

	test("regular tools are forced to completed even if running", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_asst",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						callID: "toolu_abc",
						tool: "read",
						state: { status: "running" },
					},
				],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const toolMsg = chatMsgs.find((m) => m.type === "tool");
		expect(toolMsg).toBeDefined();
		expect(toolMsg?.type === "tool" && toolMsg.status).toBe("completed");
	});
});

// ─── messageId propagation (fork-split dependency) ───────────────────────────

describe("historyToChatMessages — messageId propagation", () => {
	test("assistant messages carry the HistoryMessage id as messageId", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_user1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
			},
			{
				id: "msg_asst1",
				role: "assistant",
				parts: [{ id: "pt101", type: "text", text: "hi there" }],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const assistantMsg = chatMsgs.find((m) => m.type === "assistant");
		expect(assistantMsg).toBeDefined();
		expect(assistantMsg && "messageId" in assistantMsg).toBe(true);
		expect((assistantMsg as { messageId?: string }).messageId).toBe(
			"msg_asst1",
		);
	});

	test("only first text part of an assistant message gets messageId", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_multi",
				role: "assistant",
				parts: [
					{ id: "p1", type: "text", text: "part one" },
					{ id: "p2", type: "text", text: "part two" },
				],
			},
		];
		const chatMsgs = historyToChatMessages(history);
		const assistants = chatMsgs.filter((m) => m.type === "assistant");
		expect(assistants).toHaveLength(2);
		expect((assistants[0] as { messageId?: string }).messageId).toBe(
			"msg_multi",
		);
		expect(assistants[1] && "messageId" in assistants[1]).toBe(false);
	});
});

// ─── createdAt propagation ───────────────────────────────────────────────────

describe("historyToChatMessages — createdAt propagation", () => {
	test("user messages carry time.created as createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
				time: { created: 1000 },
			},
		];
		const result = historyToChatMessages(history);
		expect(result[0]).toHaveProperty("createdAt", 1000);
	});

	test("assistant text messages carry createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "p1", type: "text", text: "hi" }],
				time: { created: 2000, completed: 2500 },
				cost: 0.01,
				tokens: { input: 10, output: 5 },
			},
		];
		const result = historyToChatMessages(history);
		const assistantMsg = result.find((m) => m.type === "assistant");
		expect(assistantMsg).toHaveProperty("createdAt", 2000);
	});

	test("thinking messages carry createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "p1", type: "reasoning", text: "thinking..." }],
				time: { created: 3000 },
			},
		];
		const result = historyToChatMessages(history);
		const thinkingMsg = result.find((m) => m.type === "thinking");
		expect(thinkingMsg).toHaveProperty("createdAt", 3000);
	});

	test("tool messages carry createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_a1",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						callID: "toolu_1",
						tool: "read",
						state: { status: "completed", output: "file contents" },
					},
				],
				time: { created: 4000 },
			},
		];
		const result = historyToChatMessages(history);
		const toolMsg = result.find((m) => m.type === "tool");
		expect(toolMsg).toHaveProperty("createdAt", 4000);
	});

	test("result messages carry createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "p1", type: "text", text: "done" }],
				time: { created: 5000, completed: 5500 },
				cost: 0.02,
				tokens: { input: 20, output: 10 },
			},
		];
		const result = historyToChatMessages(history);
		const resultMsg = result.find((m) => m.type === "result");
		expect(resultMsg).toHaveProperty("createdAt", 5000);
	});

	test("messages without time.created do not have createdAt", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
			},
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "hi" }],
			},
		];
		const result = historyToChatMessages(history);
		for (const msg of result) {
			expect(msg).not.toHaveProperty("createdAt");
		}
	});
});

describe("fork split with history-loaded messages", () => {
	test("splitAtForkPoint finds fork point in history-converted messages", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_u1",
				role: "user",
				parts: [{ id: "pt102", type: "text", text: "remember alpha" }],
			},
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "pt103", type: "text", text: "ok" }],
			},
			{
				id: "msg_u2",
				role: "user",
				parts: [{ id: "pt104", type: "text", text: "remember beta" }],
			},
			{
				id: "msg_a2",
				role: "assistant",
				parts: [{ id: "pt105", type: "text", text: "ok" }],
			},
		];
		const chatMsgs = historyToChatMessages(history);

		// Fork at msg_a1 — first two messages are inherited, last two are current
		const split = splitAtForkPoint(chatMsgs, "msg_a1");
		expect(split.inherited.length).toBeGreaterThan(0);
		expect(split.current.length).toBeGreaterThan(0);

		// The current messages should include the second user message
		const currentUserMsg = split.current.find((m) => m.type === "user");
		expect(currentUserMsg).toBeDefined();
	});

	test("new messages appended after history are in current, not inherited", () => {
		const history: HistoryMessage[] = [
			{
				id: "msg_u1",
				role: "user",
				parts: [{ id: "p1", type: "text", text: "hello" }],
			},
			{
				id: "msg_a1",
				role: "assistant",
				parts: [{ id: "p2", type: "text", text: "hi" }],
			},
		];
		const chatMsgs = historyToChatMessages(history);

		// Simulate a new user message sent after the fork
		chatMsgs.push({ type: "user", uuid: "new-user-msg", text: "new question" });

		const split = splitAtForkPoint(chatMsgs, "msg_a1");
		expect(split.current).toHaveLength(1);
		expect(split.current[0]?.type).toBe("user");
	});
});
