import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("lookupSummarizer", () => {
	it("returns Unknown summarizer for unregistered tool names", () => {
		const summarizer = lookupSummarizer("NonexistentTool");
		expect(summarizer.tool).toBe("Unknown");
	});

	it("never returns undefined", () => {
		const summarizer = lookupSummarizer("AnythingAtAll");
		expect(summarizer).toBeDefined();
		expect(typeof summarizer.summarize).toBe("function");
	});

	it("does not route a canonical patch through the Unknown summarizer", () => {
		const input = {
			tool: "Patch",
			patch: "*** Begin Patch\n*** Delete File: /src/changed.ts\n*** End Patch",
			filePaths: ["/src/changed.ts"],
		} as const;
		expect(lookupSummarizer(input.tool).tool).toBe("Patch");
		const result = lookupSummarizer(input.tool).summarize(input, {});
		expect(result.subtitle).toBe("/src/changed.ts");
		expect(result.expandedContent).toEqual({
			kind: "code",
			language: "diff",
			content: input.patch,
		});
	});
});
