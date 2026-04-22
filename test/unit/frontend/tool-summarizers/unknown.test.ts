import { describe, expect, it } from "vitest";
import { unknownSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/unknown.js";

describe("Unknown summarizer", () => {
	it("renders JSON preview subtitle truncated to 60 chars", () => {
		const result = unknownSummarizer.summarize(
			{
				tool: "Unknown",
				name: "FutureTool",
				raw: { longKey: "x".repeat(100) },
			},
			{},
		);
		expect(result.subtitle).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after toBeDefined
		expect(result.subtitle!.length).toBeLessThanOrEqual(63); // 60 + "..."
	});

	it("renders expanded text content as formatted JSON", () => {
		const result = unknownSummarizer.summarize(
			{ tool: "Unknown", name: "FutureTool", raw: { key: "val" } },
			{},
		);
		expect(result.expandedContent).toEqual({
			kind: "text",
			body: JSON.stringify({ key: "val" }, null, 2),
		});
	});

	it("never returns empty subtitle", () => {
		const result = unknownSummarizer.summarize(
			{ tool: "Unknown", name: "X", raw: {} },
			{},
		);
		expect(result.subtitle).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after toBeDefined
		expect(result.subtitle!.length).toBeGreaterThan(0);
	});
});
