import { describe, expect, it } from "vitest";
import { lookupSummarizer } from "../../../../src/lib/frontend/utils/tool-summarizers/index.js";

describe("Patch summarizer", () => {
	const patch = [
		"*** Begin Patch",
		"*** Update File: /repo/first.ts",
		"@@",
		"-old content",
		"+new content",
		"*** Delete File: /repo/second.ts",
		"*** End Patch",
	].join("\n");
	const input = {
		tool: "Patch",
		patch,
		filePaths: ["/repo/first.ts", "/repo/second.ts"],
	} as const;

	it.each([
		"Patch",
		"ApplyPatch",
		"apply_patch",
	])("summarizes canonical patch files when the event name is %s", (name) => {
		const summary = lookupSummarizer(name).summarize(input, {});
		expect(summary).toEqual({ subtitle: "/repo/first.ts, /repo/second.ts" });
	});

	it("does not repeat the repo root in the patch file subtitle", () => {
		const summary = lookupSummarizer("Patch").summarize(input, {
			repoRoot: "/repo/",
		});
		expect(summary.subtitle).toBe("first.ts, second.ts");
	});

	it("omits a subtitle when no path header is recognized", () => {
		const unrecognizedPatch = "--- a/file.ts\n+++ b/file.ts\n-old\n+new";
		const summary = lookupSummarizer("Patch").summarize(
			{ tool: "Patch", patch: unrecognizedPatch, filePaths: [] },
			{},
		);
		expect(summary).toEqual({});
	});

	it.each([
		"ApplyPatch",
		"apply_patch",
	])("does not regress previously stored Unknown patch calls named %s", (name) => {
		const raw = { patch: "old patch input" };
		const summary = lookupSummarizer(name).summarize(
			{ tool: "Unknown", name, raw },
			{},
		);
		expect(summary.subtitle).toBe(JSON.stringify(raw));
		expect(summary.expandedContent).toEqual({
			kind: "text",
			body: JSON.stringify(raw, null, 2),
		});
	});
});
