import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Grep summarizer", () => {
	it("returns pattern as subtitle with filter tags", () => {
		const s = lookupSummarizer("Grep");
		const result = s.summarize(
			{
				tool: "Grep",
				pattern: "TODO",
				path: "/src",
				include: "*.ts",
				fileType: "ts",
			} as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("TODO");
		expect(result.tags).toContain("*.ts");
		expect(result.tags).toContain("ts");
		expect(result.tags).toContain("src");
	});
});

describe("Glob summarizer", () => {
	it("returns pattern as subtitle", () => {
		const s = lookupSummarizer("Glob");
		const result = s.summarize(
			{ tool: "Glob", pattern: "**/*.ts", path: "/src" } as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("**/*.ts");
	});
});

describe("WebFetch summarizer", () => {
	it("returns hostname as subtitle", () => {
		const s = lookupSummarizer("WebFetch");
		const result = s.summarize(
			{ tool: "WebFetch", url: "https://docs.example.com/page" } as never,
			{},
		);
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("returns link expandedContent", () => {
		const s = lookupSummarizer("WebFetch");
		const result = s.summarize(
			{ tool: "WebFetch", url: "https://example.com" } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "link",
			url: "https://example.com",
			label: "example.com",
		});
	});
});

describe("WebSearch summarizer", () => {
	it("returns query as subtitle", () => {
		const s = lookupSummarizer("WebSearch");
		const result = s.summarize(
			{ tool: "WebSearch", query: "typescript generics" } as never,
			{},
		);
		expect(result.subtitle).toBe("typescript generics");
	});
});

describe("Task summarizer", () => {
	it("returns description as subtitle with subagentType tag", () => {
		const s = lookupSummarizer("Task");
		const result = s.summarize(
			{
				tool: "Task",
				description: "find bugs",
				prompt: "look",
				subagentType: "review",
			} as never,
			{},
		);
		expect(result.subtitle).toBe("find bugs");
		expect(result.tags).toContain("review");
	});
});

describe("LSP summarizer", () => {
	it("returns operation as subtitle with filePath tag", () => {
		const s = lookupSummarizer("LSP");
		const result = s.summarize(
			{ tool: "LSP", operation: "hover", filePath: "/src/main.ts" } as never,
			{ repoRoot: "/" },
		);
		expect(result.subtitle).toBe("hover");
		expect(result.tags).toContain("src/main.ts");
	});
});

describe("Skill summarizer", () => {
	it("returns skill name as subtitle", () => {
		const s = lookupSummarizer("Skill");
		const result = s.summarize({ tool: "Skill", name: "commit" } as never, {});
		expect(result.subtitle).toBe("commit");
	});
});

describe("AskUserQuestion summarizer", () => {
	it("returns first question header as subtitle", () => {
		const s = lookupSummarizer("AskUserQuestion");
		const result = s.summarize(
			{
				tool: "AskUserQuestion",
				questions: [{ header: "Confirm action", question: "Continue?" }],
			} as never,
			{},
		);
		expect(result.subtitle).toBe("Confirm action");
	});

	it("returns 'Question' when no questions provided", () => {
		const s = lookupSummarizer("AskUserQuestion");
		const result = s.summarize(
			{ tool: "AskUserQuestion", questions: null } as never,
			{},
		);
		expect(result.subtitle).toBe("Question");
	});
});
