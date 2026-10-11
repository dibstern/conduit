import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "../../../../src/lib/provider/opencode/normalize-tool-input.js";

describe("OpenCode normalizeToolInput", () => {
	it("passes through camelCase Read input", () => {
		const result = normalizeToolInput("Read", {
			filePath: "/src/main.ts",
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

	it("normalizes Bash", () => {
		const result = normalizeToolInput("Bash", {
			command: "ls",
			description: "list",
		});
		expect(result).toEqual({
			tool: "Bash",
			command: "ls",
			description: "list",
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
		expect(
			normalizeToolInput("Bash", { command: "pwd", workdir: value }),
		).toEqual({ tool: "Bash", command: "pwd" });
	});

	it("does not override a canonical Bash working directory with an alias", () => {
		expect(
			normalizeToolInput("Bash", {
				command: "pwd",
				workingDirectory: "/src/canonical-worktree",
				cwd: "/src/alias-worktree",
			}),
		).toEqual({
			tool: "Bash",
			command: "pwd",
			workingDirectory: "/src/canonical-worktree",
		});
	});

	it("does not leave apply_patch write paths hidden in an Unknown input", () => {
		const patchText = [
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
		expect(normalizeToolInput("apply_patch", { patchText })).toEqual({
			tool: "Patch",
			patch: patchText,
			filePaths: [
				"../other-worktree/added.ts",
				"../other-worktree/original.ts",
				"../other-worktree/renamed.ts",
				"../other-worktree/deleted.ts",
			],
		});
	});

	it.each([
		42,
		{},
		undefined,
		"--- a/file.ts\n+++ b/file.ts",
	])("does not guess apply_patch paths from invalid or unrecognized input %j", (patchText) => {
		expect(normalizeToolInput("apply_patch", { patchText })).toEqual({
			tool: "Patch",
			patch: typeof patchText === "string" ? patchText : "",
			filePaths: [],
		});
	});

	it("does not multiply patch writes for repeated headers of one file", () => {
		const patchText = [
			"*** Begin Patch",
			"*** Update File: /src/file.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: /src/file.ts",
			"@@",
			"-more old",
			"+more new",
			"*** End Patch",
		].join("\n");
		expect(normalizeToolInput("apply_patch", { patchText })).toEqual({
			tool: "Patch",
			patch: patchText,
			filePaths: ["/src/file.ts"],
		});
	});

	it("does not trim or discard apply_patch text needed by the tool display", () => {
		const patchText =
			"\n*** Begin Patch\n*** Add File: /src/file.ts\n+content\n*** End Patch\n";
		expect(normalizeToolInput("apply_patch", { patchText })).toEqual({
			tool: "Patch",
			patch: patchText,
			filePaths: ["/src/file.ts"],
		});
	});

	it("normalizes WebSearch with url → hostname-based query fallback", () => {
		const result = normalizeToolInput("WebSearch", {
			url: "https://docs.example.com/search?q=test",
		});
		expect(result).toEqual({
			tool: "WebSearch",
			query: "docs.example.com",
		});
	});

	it("normalizes WebSearch with query (passthrough)", () => {
		const result = normalizeToolInput("WebSearch", {
			query: "typescript generics",
		});
		expect(result).toEqual({ tool: "WebSearch", query: "typescript generics" });
	});

	it("collapses unknown tool to Unknown variant", () => {
		const result = normalizeToolInput("CustomTool", { x: 1 });
		expect(result).toEqual({
			tool: "Unknown",
			name: "CustomTool",
			raw: { x: 1 },
		});
	});

	it("handles null input", () => {
		const result = normalizeToolInput("Read", null);
		// null coerces to {} via toRecord — known tool name still produces typed shape
		expect(result).toEqual({ tool: "Read", filePath: "" });
	});
});
