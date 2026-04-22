import { describe, expect, it } from "vitest";
import type {
	ChatMessage,
	ToolMessage,
} from "../../../src/lib/frontend/types.js";
import {
	groupMessages,
	type ToolGroup,
} from "../../../src/lib/frontend/utils/group-tools.js";

function toolMsg(
	id: string,
	name: string,
	status: "completed" | "running" = "completed",
): ToolMessage {
	return {
		type: "tool",
		id,
		uuid: `uuid-${id}`,
		name,
		status,
		input: { tool: name, filePath: `/src/${id}.ts` },
	} as ToolMessage;
}

describe("groupMessages — regression", () => {
	it("consecutive same-category tools collapse into a ToolGroup", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "Grep"),
			toolMsg("3", "Glob"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(1);
		expect((grouped[0] as ToolGroup).type).toBe("tool-group");
		expect((grouped[0] as ToolGroup).tools).toHaveLength(3);
		expect((grouped[0] as ToolGroup).label).toBe("Explored");
	});

	it("AskUserQuestion is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "AskUserQuestion"),
			toolMsg("3", "Read"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
		expect((grouped[1] as ToolMessage).name).toBe("AskUserQuestion");
	});

	it("Task is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Task"),
			toolMsg("2", "Task"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(2); // Two solo ToolMessages, not a group
	});

	it("Skill is never grouped", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Skill"),
			toolMsg("2", "Skill"),
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(2);
	});

	it("solo tool stays as ToolMessage", () => {
		const messages: ChatMessage[] = [toolMsg("1", "Bash")];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(1);
		expect((grouped[0] as ToolMessage).type).toBe("tool");
	});

	it("different categories are not grouped together", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"), // explore
			toolMsg("2", "Edit"), // edit
			toolMsg("3", "Bash"), // shell
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
	});

	it("mixed category->group transitions work", () => {
		const messages: ChatMessage[] = [
			toolMsg("1", "Read"),
			toolMsg("2", "Grep"), // same category as Read -> group
			toolMsg("3", "Bash"), // different -> solo
			toolMsg("4", "Edit"),
			toolMsg("5", "Write"), // same category as Edit -> group
		];
		const grouped = groupMessages(messages);
		expect(grouped).toHaveLength(3);
		expect((grouped[0] as ToolGroup).type).toBe("tool-group");
		expect((grouped[0] as ToolGroup).tools).toHaveLength(2);
		expect((grouped[1] as ToolMessage).name).toBe("Bash");
		expect((grouped[2] as ToolGroup).type).toBe("tool-group");
		expect((grouped[2] as ToolGroup).tools).toHaveLength(2);
	});
});
