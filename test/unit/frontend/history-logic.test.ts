// ─── Svelte History Logic — Unit Tests ───────────────────────────────────────
// Tests groupIntoTurns, findPageBoundary, historyToChatMessages, applyHistoryQueuedFlag.

import { describe, expect, test } from "vitest";
import type { HistoryMessage } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	findPageBoundary,
	groupIntoTurns,
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
