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
});
