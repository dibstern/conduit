import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Bash summarizer", () => {
	it("prefers command over description for subtitle", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{
				tool: "Bash",
				command: "ls -la",
				description: "list files",
			} as never,
			{},
		);
		expect(result.subtitle).toBe("ls -la");
	});

	it("truncates long commands at 40 chars", () => {
		const s = lookupSummarizer("Bash");
		const long = "x".repeat(60);
		const result = s.summarize({ tool: "Bash", command: long } as never, {});
		// biome-ignore lint/style/noNonNullAssertion: test assertion
		expect(result.subtitle!.length).toBeLessThanOrEqual(41);
	});

	it("falls back to description when command is empty", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{
				tool: "Bash",
				command: "",
				description: "install deps",
			} as never,
			{},
		);
		expect(result.subtitle).toBe("install deps");
	});

	it("returns code expandedContent with shell language", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize(
			{ tool: "Bash", command: "npm install" } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "code",
			language: "shell",
			content: "$ npm install",
		});
	});

	it("handles no command and no description", () => {
		const s = lookupSummarizer("Bash");
		const result = s.summarize({ tool: "Bash", command: "" } as never, {});
		expect(result.subtitle).toBeUndefined();
	});
});

describe("Edit summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{
				tool: "Edit",
				filePath: "/src/main.ts",
				oldString: "a",
				newString: "b",
			} as never,
			{},
		);
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("returns diff expandedContent when old and new strings present", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{
				tool: "Edit",
				filePath: "/f.ts",
				oldString: "foo",
				newString: "bar",
			} as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "diff",
			before: "foo",
			after: "bar",
		});
	});

	it("strips repoRoot from filePath", () => {
		const s = lookupSummarizer("Edit");
		const result = s.summarize(
			{
				tool: "Edit",
				filePath: "/home/user/project/f.ts",
				oldString: "a",
				newString: "b",
			} as never,
			{ repoRoot: "/home/user/project" },
		);
		expect(result.subtitle).toBe("f.ts");
	});
});

describe("Write summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Write");
		const result = s.summarize(
			{ tool: "Write", filePath: "/src/new.ts", content: "hello" } as never,
			{},
		);
		expect(result.subtitle).toBe("/src/new.ts");
	});

	it("handles empty filePath", () => {
		const s = lookupSummarizer("Write");
		const result = s.summarize(
			{ tool: "Write", filePath: "", content: "hello" } as never,
			{},
		);
		expect(result.subtitle).toBeUndefined();
	});
});
