// ─── Group Tools — Unit Tests ─────────────────────────────────────────────────
// Tests getToolCategory, extractToolSummary, and groupMessages.

import { describe, expect, it } from "vitest";
import type {
	ChatMessage,
	ToolMessage,
} from "../../../src/lib/frontend/types.js";
import {
	extractToolSummary,
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

// ─── extractToolSummary ──────────────────────────────────────────────────────

describe("extractToolSummary", () => {
	it("extracts relative path for Read", () => {
		const result = extractToolSummary(
			"Read",
			{ filePath: "/home/user/project/src/main.ts" },
			"/home/user/project",
		);
		expect(result.subtitle).toBe("src/main.ts");
	});

	it("adds offset/limit tags for Read", () => {
		const result = extractToolSummary(
			"Read",
			{
				filePath: "/home/user/project/src/main.ts",
				offset: 10,
				limit: 50,
			},
			"/home/user/project",
		);
		expect(result.tags).toContain("offset:10");
		expect(result.tags).toContain("limit:50");
	});

	it("extracts relative path for Edit", () => {
		const result = extractToolSummary(
			"Edit",
			{ filePath: "/home/user/project/src/main.ts" },
			"/home/user/project",
		);
		expect(result.subtitle).toBe("src/main.ts");
	});

	it("extracts relative path for Write", () => {
		const result = extractToolSummary(
			"Write",
			{ filePath: "/home/user/project/src/main.ts" },
			"/home/user/project",
		);
		expect(result.subtitle).toBe("src/main.ts");
	});

	it("shows full path when repoRoot is not provided", () => {
		const result = extractToolSummary("Read", {
			filePath: "/home/user/project/src/main.ts",
		});
		expect(result.subtitle).toBe("/home/user/project/src/main.ts");
	});

	it("extracts description for Bash", () => {
		const result = extractToolSummary("Bash", {
			description: "List all files",
			command: "ls -la",
		});
		expect(result.subtitle).toBe("List all files");
	});

	it("falls back to command for Bash when no description", () => {
		const result = extractToolSummary("Bash", {
			command: "ls -la",
		});
		expect(result.subtitle).toBe("ls -la");
	});

	it("truncates long Bash command to 40 chars", () => {
		const longCmd =
			"find /usr/local/lib -name '*.so' -exec ls -la {} \\; | sort -k5 -rn";
		const result = extractToolSummary("Bash", { command: longCmd });
		expect(result.subtitle).toBe(`${longCmd.slice(0, 40)}…`);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.subtitle!.length).toBe(41); // 40 chars + ellipsis
	});

	it("extracts pattern for Grep", () => {
		const result = extractToolSummary("Grep", {
			pattern: "TODO",
		});
		expect(result.subtitle).toBe("TODO");
	});

	it("includes include as tag for Grep", () => {
		const result = extractToolSummary("Grep", {
			pattern: "TODO",
			include: "*.ts",
		});
		expect(result.subtitle).toBe("TODO");
		expect(result.tags).toContain("*.ts");
	});

	it("extracts pattern for Glob", () => {
		const result = extractToolSummary("Glob", {
			pattern: "**/*.ts",
		});
		expect(result.subtitle).toBe("**/*.ts");
	});

	it("extracts hostname for WebFetch", () => {
		const result = extractToolSummary("WebFetch", {
			url: "https://docs.example.com/api/v2/reference",
		});
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("extracts hostname for WebSearch", () => {
		const result = extractToolSummary("WebSearch", {
			url: "https://www.google.com/search?q=test",
		});
		expect(result.subtitle).toBe("www.google.com");
	});

	it("extracts description for Task", () => {
		const result = extractToolSummary("Task", {
			description: "Run linter on all files",
			subagent_type: "code_review",
		});
		expect(result.subtitle).toBe("Run linter on all files");
		expect(result.tags).toContain("code_review");
	});

	it("extracts operation for LSP", () => {
		const result = extractToolSummary(
			"LSP",
			{
				operation: "goToDefinition",
				filePath: "/home/user/project/src/index.ts",
			},
			"/home/user/project",
		);
		expect(result.subtitle).toBe("goToDefinition");
		expect(result.tags).toContain("src/index.ts");
	});

	it("returns empty for unknown tool with no input", () => {
		const result = extractToolSummary("UnknownTool");
		expect(result.subtitle).toBeUndefined();
		expect(result.tags).toBeUndefined();
	});

	it("returns empty for unknown tool with input", () => {
		const result = extractToolSummary("UnknownTool", { foo: "bar" });
		expect(result.subtitle).toBeUndefined();
		expect(result.tags).toBeUndefined();
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
