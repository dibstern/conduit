// ─── Group Tools — Unit Tests ─────────────────────────────────────────────────
// Tests getToolCategory and groupMessages.

import { describe, expect, it } from "vitest";
import type {
	ChatMessage,
	ToolMessage,
} from "../../../src/lib/frontend/types.js";
import {
	getToolCategory,
	groupMessages,
	type ToolGroup,
} from "../../../src/lib/frontend/utils/group-tools.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tool(
	name: string,
	id: string,
	input?: Record<string, unknown>,
	status: ToolMessage["status"] = "completed",
): ToolMessage {
	return { type: "tool", uuid: `uuid-${id}`, id, name, status, input };
}

function assistantMsg(text: string): ChatMessage {
	return {
		type: "assistant",
		uuid: "a1",
		rawText: text,
		html: text,
		finalized: true,
	};
}

// ─── getToolCategory ─────────────────────────────────────────────────────────

describe("getToolCategory", () => {
	it("maps Read to explore", () => {
		expect(getToolCategory("Read")).toBe("explore");
	});

	it("maps Glob to explore", () => {
		expect(getToolCategory("Glob")).toBe("explore");
	});

	it("maps Grep to explore", () => {
		expect(getToolCategory("Grep")).toBe("explore");
	});

	it("maps LSP to explore", () => {
		expect(getToolCategory("LSP")).toBe("explore");
	});

	it("maps Edit to edit", () => {
		expect(getToolCategory("Edit")).toBe("edit");
	});

	it("maps Write to edit", () => {
		expect(getToolCategory("Write")).toBe("edit");
	});

	it("maps Bash to shell", () => {
		expect(getToolCategory("Bash")).toBe("shell");
	});

	it("maps WebFetch to fetch", () => {
		expect(getToolCategory("WebFetch")).toBe("fetch");
	});

	it("maps WebSearch to fetch", () => {
		expect(getToolCategory("WebSearch")).toBe("fetch");
	});

	it("maps Task to task", () => {
		expect(getToolCategory("Task")).toBe("task");
	});

	it("maps unknown tool names to other", () => {
		expect(getToolCategory("SomethingNew")).toBe("other");
	});
});

// ─── groupMessages ───────────────────────────────────────────────────────────

describe("groupMessages", () => {
	it("passes non-tool messages through unchanged", () => {
		const msgs: ChatMessage[] = [
			assistantMsg("Hello"),
			{ type: "user", uuid: "u1", text: "Hi" },
		];
		const result = groupMessages(msgs);
		expect(result).toEqual(msgs);
	});

	it("does not group a single tool message", () => {
		const t = tool("Read", "1");
		const msgs: ChatMessage[] = [assistantMsg("Hello"), t];
		const result = groupMessages(msgs);
		expect(result).toEqual(msgs);
	});

	it("groups 2+ consecutive same-category tool messages", () => {
		const t1 = tool("Read", "1");
		const t2 = tool("Grep", "2");
		const msgs: ChatMessage[] = [t1, t2];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);

		const group = result[0] as ToolGroup;
		expect(group.type).toBe("tool-group");
		expect(group.category).toBe("explore");
		expect(group.tools).toEqual([t1, t2]);
		expect(group.uuid).toBe("group-uuid-1");
	});

	it("generates correct summary with tool counts", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1"),
			tool("Read", "2"),
			tool("Read", "3"),
			tool("Grep", "4"),
			tool("Grep", "5"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);

		const group = result[0] as ToolGroup;
		expect(group.summary).toBe("3 reads, 2 greps");
	});

	it("uses correct label for each category", () => {
		// explore
		const exploreGroup = groupMessages([tool("Read", "1"), tool("Glob", "2")]);
		expect((exploreGroup[0] as ToolGroup).label).toBe("Explored");

		// edit
		const editGroup = groupMessages([tool("Edit", "1"), tool("Write", "2")]);
		expect((editGroup[0] as ToolGroup).label).toBe("Edited");

		// shell
		const shellGroup = groupMessages([tool("Bash", "1"), tool("Bash", "2")]);
		expect((shellGroup[0] as ToolGroup).label).toBe("Shell");

		// fetch
		const fetchGroup = groupMessages([
			tool("WebFetch", "1"),
			tool("WebSearch", "2"),
		]);
		expect((fetchGroup[0] as ToolGroup).label).toBe("Fetched");

		// task — Task tools are excluded from grouping (need subagent card UI),
		// so two consecutive Task tools stay as individual ToolMessages.
		const taskGroup = groupMessages([tool("Task", "1"), tool("Task", "2")]);
		expect(taskGroup).toHaveLength(2);
		expect(taskGroup[0]?.type).toBe("tool");
		expect(taskGroup[1]?.type).toBe("tool");

		// other
		const otherGroup = groupMessages([
			tool("Custom1", "1"),
			tool("Custom1", "2"),
		]);
		expect((otherGroup[0] as ToolGroup).label).toBe("Used");
	});

	it("groups mixed tools in same category", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1"),
			tool("Glob", "2"),
			tool("Grep", "3"),
			tool("LSP", "4"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);

		const group = result[0] as ToolGroup;
		expect(group.category).toBe("explore");
		expect(group.tools).toHaveLength(4);
		expect(group.summary).toBe("1 read, 1 glob, 1 grep, 1 lsp");
	});

	it("breaks groups on non-tool messages", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1"),
			tool("Grep", "2"),
			assistantMsg("Thinking..."),
			tool("Read", "3"),
			tool("Glob", "4"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);
		expect((result[0] as ToolGroup).type).toBe("tool-group");
		expect(result[1]).toEqual(assistantMsg("Thinking..."));
		expect((result[2] as ToolGroup).type).toBe("tool-group");
	});

	it("breaks groups on different categories", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1"),
			tool("Grep", "2"),
			tool("Edit", "3"),
			tool("Write", "4"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(2);

		const g1 = result[0] as ToolGroup;
		expect(g1.category).toBe("explore");
		expect(g1.tools).toHaveLength(2);

		const g2 = result[1] as ToolGroup;
		expect(g2.category).toBe("edit");
		expect(g2.tools).toHaveLength(2);
	});

	it("does not group a solo tool between category changes", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1"),
			tool("Read", "2"),
			tool("Bash", "3"), // solo shell — should NOT be grouped
			tool("Edit", "4"),
			tool("Edit", "5"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);

		expect((result[0] as ToolGroup).type).toBe("tool-group");
		expect((result[0] as ToolGroup).category).toBe("explore");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[1]!.type).toBe("tool"); // solo Bash stays as ToolMessage
		expect((result[2] as ToolGroup).type).toBe("tool-group");
		expect((result[2] as ToolGroup).category).toBe("edit");
	});

	it("sets status to running when any tool is pending", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1", undefined, "completed"),
			tool("Read", "2", undefined, "pending"),
		];
		const result = groupMessages(msgs);
		expect((result[0] as ToolGroup).status).toBe("running");
	});

	it("sets status to running when any tool is running", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1", undefined, "completed"),
			tool("Read", "2", undefined, "running"),
		];
		const result = groupMessages(msgs);
		expect((result[0] as ToolGroup).status).toBe("running");
	});

	it("sets status to error when any tool errored", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1", undefined, "completed"),
			tool("Read", "2", undefined, "error"),
		];
		const result = groupMessages(msgs);
		expect((result[0] as ToolGroup).status).toBe("error");
	});

	it("sets status to completed when all tools completed", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1", undefined, "completed"),
			tool("Read", "2", undefined, "completed"),
		];
		const result = groupMessages(msgs);
		expect((result[0] as ToolGroup).status).toBe("completed");
	});

	it("running takes precedence over error", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "1", undefined, "error"),
			tool("Read", "2", undefined, "running"),
		];
		const result = groupMessages(msgs);
		expect((result[0] as ToolGroup).status).toBe("running");
	});

	it("AskUserQuestion tools are never grouped — they need interactive QuestionCard", () => {
		const msgs: ChatMessage[] = [
			tool("AskUserQuestion", "q1"),
			tool("AskUserQuestion", "q2"),
		];
		const result = groupMessages(msgs);
		// Each AskUserQuestion should be a standalone ToolMessage (not grouped)
		expect(result).toHaveLength(2);
		expect(result[0]?.type).toBe("tool");
		expect(result[1]?.type).toBe("tool");
	});

	it("AskUserQuestion breaks grouping of surrounding other-category tools", () => {
		const msgs: ChatMessage[] = [
			tool("SomeOtherTool", "1"),
			tool("AskUserQuestion", "q1"),
			tool("SomeOtherTool", "2"),
		];
		const result = groupMessages(msgs);
		// All three should be standalone (AskUserQuestion breaks the group)
		expect(result).toHaveLength(3);
		expect(result.every((m) => m.type === "tool")).toBe(true);
	});

	it("AskUserQuestion between grouped tools preserves the groups", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "r1"),
			tool("Read", "r2"),
			tool("AskUserQuestion", "q1"),
			tool("Bash", "b1"),
			tool("Bash", "b2"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);
		expect((result[0] as ToolGroup).type).toBe("tool-group"); // Read group
		expect(result[1]?.type).toBe("tool"); // AskUserQuestion standalone
		expect((result[2] as ToolGroup).type).toBe("tool-group"); // Bash group
	});

	it("Task tools are never grouped — they need subagent card UI", () => {
		const msgs: ChatMessage[] = [tool("Task", "t1"), tool("Task", "t2")];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(2);
		expect(result[0]?.type).toBe("tool");
		expect(result[1]?.type).toBe("tool");
	});

	it("Task breaks grouping of surrounding other-category tools", () => {
		const msgs: ChatMessage[] = [
			tool("SomeOtherTool", "1"),
			tool("Task", "t1"),
			tool("SomeOtherTool", "2"),
		];
		const result = groupMessages(msgs);
		// All three should be standalone (Task breaks the group)
		expect(result).toHaveLength(3);
		expect(result.every((m) => m.type === "tool")).toBe(true);
	});

	it("Task between grouped tools preserves the groups", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "r1"),
			tool("Read", "r2"),
			tool("Task", "t1"),
			tool("Bash", "b1"),
			tool("Bash", "b2"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);
		expect((result[0] as ToolGroup).type).toBe("tool-group"); // Read group
		expect(result[1]?.type).toBe("tool"); // Task standalone
		expect((result[2] as ToolGroup).type).toBe("tool-group"); // Bash group
	});

	it("lowercase 'task' is also excluded from grouping", () => {
		const msgs: ChatMessage[] = [tool("task", "t1"), tool("task", "t2")];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(2);
		expect(result[0]?.type).toBe("tool");
		expect(result[1]?.type).toBe("tool");
	});

	it("Skill tools are never grouped — they need dedicated SkillItem", () => {
		const msgs: ChatMessage[] = [tool("Skill", "s1"), tool("Skill", "s2")];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(2);
		expect(result[0]?.type).toBe("tool");
		expect(result[1]?.type).toBe("tool");
	});

	it("Skill breaks grouping of surrounding explore tools", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "r1"),
			tool("Skill", "s1"),
			tool("Read", "r2"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);
		expect(result.every((m) => m.type === "tool")).toBe(true);
	});

	it("Skill between grouped tools preserves the groups", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "r1"),
			tool("Read", "r2"),
			tool("Skill", "s1"),
			tool("Bash", "b1"),
			tool("Bash", "b2"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3);
		expect((result[0] as ToolGroup).type).toBe("tool-group"); // Read group
		expect(result[1]?.type).toBe("tool"); // Skill standalone
		expect((result[2] as ToolGroup).type).toBe("tool-group"); // Bash group
	});
});
