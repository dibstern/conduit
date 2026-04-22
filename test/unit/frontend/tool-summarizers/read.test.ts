import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Read summarizer", () => {
	it("returns filePath as subtitle", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/src/main.ts" } as never,
			{},
		);
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("strips repoRoot from filePath", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{
				tool: "Read",
				filePath: "/home/user/project/src/main.ts",
			} as never,
			{ repoRoot: "/home/user/project" },
		);
		expect(result.subtitle).toBe("src/main.ts");
	});

	it("includes offset and limit as tags", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/f.ts", offset: 10, limit: 50 } as never,
			{},
		);
		expect(result.tags).toContain("offset:10");
		expect(result.tags).toContain("limit:50");
	});

	it("returns path expandedContent", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize(
			{ tool: "Read", filePath: "/f.ts", offset: 10, limit: 50 } as never,
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "path",
			filePath: "/f.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("handles empty filePath", () => {
		const s = lookupSummarizer("Read");
		const result = s.summarize({ tool: "Read", filePath: "" } as never, {});
		expect(result.subtitle).toBeUndefined();
	});
});
