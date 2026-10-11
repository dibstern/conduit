import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "../../../../src/lib/provider/claude/normalize-tool-input.js";

describe("Claude normalizeToolInput", () => {
	it("normalizes Read with snake_case input", () => {
		const result = normalizeToolInput("Read", {
			file_path: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("normalizes Read with camelCase input (passthrough)", () => {
		const result = normalizeToolInput("Read", {
			filePath: "/src/main.ts",
		});
		expect(result).toEqual({ tool: "Read", filePath: "/src/main.ts" });
	});

	it("normalizes Edit with snake_case input", () => {
		const result = normalizeToolInput("Edit", {
			file_path: "/f.ts",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		});
		expect(result).toEqual({
			tool: "Edit",
			filePath: "/f.ts",
			oldString: "a",
			newString: "b",
			replaceAll: true,
		});
	});

	it("normalizes Write with snake_case input", () => {
		const result = normalizeToolInput("Write", {
			file_path: "/f.ts",
			content: "hello",
		});
		expect(result).toEqual({
			tool: "Write",
			filePath: "/f.ts",
			content: "hello",
		});
	});

	it("normalizes Bash with snake_case input", () => {
		const result = normalizeToolInput("Bash", {
			command: "ls -la",
			description: "list files",
			timeout: 5000,
		});
		expect(result).toEqual({
			tool: "Bash",
			command: "ls -la",
			description: "list files",
			timeoutMs: 5000,
		});
	});

	it.each([
		"workingDirectory",
		"working_directory",
		"cwd",
		"workdir",
	])("does not discard Bash's explicit %s working directory", (field) => {
		expect(
			normalizeToolInput("Bash", {
				command: "touch changed.ts",
				[field]: "/src/other-worktree",
			}),
		).toEqual({
			tool: "Bash",
			command: "touch changed.ts",
			workingDirectory: "/src/other-worktree",
		});
	});

	it.each([
		42,
		true,
		{},
		[],
		null,
		undefined,
		"",
	])("does not invent a Bash working directory from invalid input %j", (value) => {
		expect(normalizeToolInput("Bash", { command: "pwd", cwd: value })).toEqual({
			tool: "Bash",
			command: "pwd",
		});
	});

	it("does not lose a valid Bash alias behind a non-string canonical field", () => {
		expect(
			normalizeToolInput("Bash", {
				command: "pwd",
				workingDirectory: {},
				cwd: "/src/other-worktree",
			}),
		).toEqual({
			tool: "Bash",
			command: "pwd",
			workingDirectory: "/src/other-worktree",
		});
	});

	it("does not leave ApplyPatch write paths hidden in an Unknown input", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: ../other-worktree/added.ts",
			"+new content",
			"*** Update File: ../other-worktree/original.ts",
			"*** Move to: ../other-worktree/renamed.ts",
			"@@",
			"-old content",
			"+new content",
			"*** Delete File: ../other-worktree/deleted.ts",
			"*** End Patch",
		].join("\n");
		expect(normalizeToolInput("ApplyPatch", { patch })).toEqual({
			tool: "Patch",
			patch,
			filePaths: [
				"../other-worktree/added.ts",
				"../other-worktree/original.ts",
				"../other-worktree/renamed.ts",
				"../other-worktree/deleted.ts",
			],
		});
	});

	it.each([
		"--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new",
		"*** Update File: /src/file.ts\n@@\n-old\n+new",
		"*** Begin Patch\n*** Add File: /src/file.ts\n+content",
	])("does not guess ApplyPatch paths from unrecognized patch text", (patch) => {
		expect(normalizeToolInput("ApplyPatch", { patch })).toEqual({
			tool: "Patch",
			patch,
			filePaths: [],
		});
	});

	it("does not count patch content that resembles a file header", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: /src/real.ts",
			"+*** Add File: /src/not-a-write.ts",
			"*** End Patch",
		].join("\n");
		expect(normalizeToolInput("ApplyPatch", { patch })).toEqual({
			tool: "Patch",
			patch,
			filePaths: ["/src/real.ts"],
		});
	});

	it("does not trim or discard ApplyPatch text needed by the tool display", () => {
		const patch =
			"\n*** Begin Patch\n*** Add File: /src/file.ts\n+content\n*** End Patch\n";
		expect(normalizeToolInput("ApplyPatch", { patch })).toEqual({
			tool: "Patch",
			patch,
			filePaths: ["/src/file.ts"],
		});
	});

	it("normalizes Grep with Claude SDK field names", () => {
		const result = normalizeToolInput("Grep", {
			pattern: "TODO",
			path: "/src",
			glob: "*.ts",
			type: "ts",
		});
		expect(result).toEqual({
			tool: "Grep",
			pattern: "TODO",
			path: "/src",
			include: "*.ts",
			fileType: "ts",
		});
	});

	it("normalizes Glob", () => {
		const result = normalizeToolInput("Glob", {
			pattern: "**/*.ts",
			path: "/src",
		});
		expect(result).toEqual({
			tool: "Glob",
			pattern: "**/*.ts",
			path: "/src",
		});
	});

	it("normalizes WebFetch", () => {
		const result = normalizeToolInput("WebFetch", {
			url: "https://example.com",
			prompt: "summarize",
		});
		expect(result).toEqual({
			tool: "WebFetch",
			url: "https://example.com",
			prompt: "summarize",
		});
	});

	it("normalizes WebSearch", () => {
		const result = normalizeToolInput("WebSearch", {
			query: "typescript generics",
		});
		expect(result).toEqual({ tool: "WebSearch", query: "typescript generics" });
	});

	it("normalizes Task with snake_case subagent_type", () => {
		const result = normalizeToolInput("Task", {
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagent_type: "code-review",
		});
		expect(result).toEqual({
			tool: "Task",
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagentType: "code-review",
		});
	});

	it("normalizes Claude Agent as a Task subagent", () => {
		const result = normalizeToolInput("Agent", {
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagent_type: "code-review",
		});
		expect(result).toEqual({
			tool: "Task",
			description: "find bugs",
			prompt: "look for bugs in main.ts",
			subagentType: "code-review",
		});
	});

	it("normalizes LSP with snake_case file_path", () => {
		const result = normalizeToolInput("LSP", {
			operation: "hover",
			file_path: "/src/main.ts",
		});
		expect(result).toEqual({
			tool: "LSP",
			operation: "hover",
			filePath: "/src/main.ts",
		});
	});

	it("normalizes Skill", () => {
		const result = normalizeToolInput("Skill", { name: "commit" });
		expect(result).toEqual({ tool: "Skill", name: "commit" });
	});

	it("normalizes Skill from the SDK's skill key", () => {
		// Claude Agent SDK Skill input is { skill: string, args?: string }
		const result = normalizeToolInput("Skill", {
			skill: "diagnose",
			args: "",
		});
		expect(result).toEqual({ tool: "Skill", name: "diagnose" });
	});

	it("normalizes AskUserQuestion", () => {
		const questions = [{ question: "Continue?", header: "Confirm" }];
		const result = normalizeToolInput("AskUserQuestion", { questions });
		expect(result).toEqual({ tool: "AskUserQuestion", questions });
	});

	it("collapses unknown tool to Unknown variant", () => {
		const result = normalizeToolInput("FutureTool", { foo: "bar", baz: 42 });
		expect(result).toEqual({
			tool: "Unknown",
			name: "FutureTool",
			raw: { foo: "bar", baz: 42 },
		});
	});

	it("handles null/undefined input gracefully", () => {
		const result = normalizeToolInput("Read", null);
		// null coerces to {} via toRecord — known tool name still produces typed shape
		expect(result).toEqual({ tool: "Read", filePath: "" });
	});

	it("handles empty object input", () => {
		const result = normalizeToolInput("Read", {});
		// Missing filePath — should still produce a Read with empty string
		expect(result.tool).toBe("Read");
	});
});
