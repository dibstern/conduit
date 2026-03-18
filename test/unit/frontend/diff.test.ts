// ─── Svelte Diff Utilities — Unit Tests ──────────────────────────────────────
// Tests computeDiff, renderUnifiedDiff, renderSplitDiff, buildSplitRows, diffStats.

import { describe, expect, test } from "vitest";
import type { DiffOp } from "../../../src/lib/frontend/utils/diff.js";
import {
	buildSplitRows,
	computeDiff,
	diffStats,
	renderSplitDiff,
	renderUnifiedDiff,
} from "../../../src/lib/frontend/utils/diff.js";

// ─── computeDiff ─────────────────────────────────────────────────────────────

describe("computeDiff", () => {
	test("returns empty array for two empty arrays", () => {
		expect(computeDiff([], [])).toEqual([]);
	});

	test("all equal for identical lines", () => {
		const lines = ["alpha", "beta", "gamma"];
		const result = computeDiff(lines, lines);
		expect(result).toHaveLength(3);
		for (const op of result) {
			expect(op.type).toBe("equal");
		}
		expect(result[0]).toEqual({
			type: "equal",
			line: "alpha",
			oldLineNo: 1,
			newLineNo: 1,
		});
	});

	test("all additions when old is empty", () => {
		const result = computeDiff([], ["a", "b"]);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: "add", line: "a", newLineNo: 1 });
		expect(result[1]).toEqual({ type: "add", line: "b", newLineNo: 2 });
	});

	test("all removals when new is empty", () => {
		const result = computeDiff(["a", "b"], []);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ type: "remove", line: "a", oldLineNo: 1 });
		expect(result[1]).toEqual({ type: "remove", line: "b", oldLineNo: 2 });
	});

	test("detects single line change", () => {
		const result = computeDiff(["hello"], ["world"]);
		expect(result).toEqual([
			{ type: "remove", line: "hello", oldLineNo: 1 },
			{ type: "add", line: "world", newLineNo: 1 },
		]);
	});

	test("detects insertion in the middle", () => {
		const result = computeDiff(["a", "c"], ["a", "b", "c"]);
		const types = result.map((op) => op.type);
		expect(types).toContain("equal");
		expect(types).toContain("add");
		// "a" and "c" should be equal
		const equalOps = result.filter((op) => op.type === "equal");
		expect(equalOps).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(equalOps[0]!.line).toBe("a");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(equalOps[1]!.line).toBe("c");
		// "b" is added
		const addOps = result.filter((op) => op.type === "add");
		expect(addOps).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(addOps[0]!.line).toBe("b");
	});

	test("detects deletion in the middle", () => {
		const result = computeDiff(["a", "b", "c"], ["a", "c"]);
		const removeOps = result.filter((op) => op.type === "remove");
		expect(removeOps).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(removeOps[0]!.line).toBe("b");
	});

	test("handles multi-line diff with mixed operations", () => {
		const oldLines = ["line1", "line2", "line3", "line4"];
		const newLines = ["line1", "modified", "line3", "line4", "line5"];
		const result = computeDiff(oldLines, newLines);

		const adds = result.filter((op) => op.type === "add");
		const removes = result.filter((op) => op.type === "remove");
		const equals = result.filter((op) => op.type === "equal");
		expect(equals.length).toBeGreaterThanOrEqual(3); // line1, line3, line4
		expect(adds.length).toBeGreaterThanOrEqual(1);
		expect(removes.length).toBeGreaterThanOrEqual(1);
	});

	test("assigns correct line numbers", () => {
		const result = computeDiff(["a", "b"], ["a", "c"]);
		// "a" is equal -> oldLineNo=1, newLineNo=1
		const equalOp = result.find((op) => op.type === "equal");
		expect(equalOp?.oldLineNo).toBe(1);
		expect(equalOp?.newLineNo).toBe(1);
	});

	test("handles single empty line in both", () => {
		const result = computeDiff([""], [""]);
		expect(result).toEqual([
			{ type: "equal", line: "", oldLineNo: 1, newLineNo: 1 },
		]);
	});
});

// ─── renderUnifiedDiff ───────────────────────────────────────────────────────

describe("renderUnifiedDiff", () => {
	test("returns HTML string wrapping a diff viewer", () => {
		const html = renderUnifiedDiff("a", "a");
		expect(html).toContain("diff-viewer");
		expect(html).toContain("diff-line");
	});

	test("marks equal lines with diff-equal class", () => {
		const html = renderUnifiedDiff("hello", "hello");
		expect(html).toContain("diff-equal");
	});

	test("marks added lines with diff-add class and + marker", () => {
		const html = renderUnifiedDiff("", "new line");
		expect(html).toContain("diff-add");
		expect(html).toContain("+");
	});

	test("marks removed lines with diff-remove class and - marker", () => {
		const html = renderUnifiedDiff("old line", "");
		expect(html).toContain("diff-remove");
		expect(html).toContain("-");
	});

	test("escapes HTML in diff content", () => {
		const html = renderUnifiedDiff("<script>", "<div>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;div&gt;");
		// Should not contain raw HTML tags from content
		expect(html).not.toContain("<script>");
	});

	test("handles multi-line diffs", () => {
		const old = "line1\nline2\nline3";
		const new_ = "line1\nmodified\nline3";
		const html = renderUnifiedDiff(old, new_);
		expect(html).toContain("diff-equal");
		expect(html).toContain("diff-add");
		expect(html).toContain("diff-remove");
	});

	test("includes line numbers in gutter", () => {
		const html = renderUnifiedDiff("a\nb", "a\nb");
		expect(html).toContain(">1<");
		expect(html).toContain(">2<");
	});

	test("returns empty diff viewer for two empty strings", () => {
		const html = renderUnifiedDiff("", "");
		expect(html).toContain("diff-viewer");
		expect(html).toContain("diff-equal");
	});
});

// ─── buildSplitRows ──────────────────────────────────────────────────────────

describe("buildSplitRows", () => {
	test("returns empty array for empty ops", () => {
		expect(buildSplitRows([])).toEqual([]);
	});

	test("builds equal rows for equal ops", () => {
		const ops: DiffOp[] = [
			{ type: "equal", line: "hello", oldLineNo: 1, newLineNo: 1 },
		];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			type: "equal",
			oldLineNo: 1,
			oldLine: "hello",
			newLineNo: 1,
			newLine: "hello",
		});
	});

	test("pairs adjacent remove+add into a change row", () => {
		const ops: DiffOp[] = [
			{ type: "remove", line: "old", oldLineNo: 1 },
			{ type: "add", line: "new", newLineNo: 1 },
		];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			type: "change",
			oldLineNo: 1,
			oldLine: "old",
			newLineNo: 1,
			newLine: "new",
		});
	});

	test("standalone remove becomes remove row", () => {
		const ops: DiffOp[] = [{ type: "remove", line: "deleted", oldLineNo: 3 }];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			type: "remove",
			oldLineNo: 3,
			oldLine: "deleted",
			newLineNo: null,
			newLine: null,
		});
	});

	test("standalone add becomes add row", () => {
		const ops: DiffOp[] = [{ type: "add", line: "added", newLineNo: 5 }];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			type: "add",
			oldLineNo: null,
			oldLine: null,
			newLineNo: 5,
			newLine: "added",
		});
	});

	test("remove followed by equal is not paired as change", () => {
		const ops: DiffOp[] = [
			{ type: "remove", line: "old", oldLineNo: 1 },
			{ type: "equal", line: "same", oldLineNo: 2, newLineNo: 1 },
		];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[0]!.type).toBe("remove");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.type).toBe("equal");
	});

	test("handles complex sequence: equal, remove+add, equal", () => {
		const ops: DiffOp[] = [
			{ type: "equal", line: "a", oldLineNo: 1, newLineNo: 1 },
			{ type: "remove", line: "b", oldLineNo: 2 },
			{ type: "add", line: "B", newLineNo: 2 },
			{ type: "equal", line: "c", oldLineNo: 3, newLineNo: 3 },
		];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[0]!.type).toBe("equal");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.type).toBe("change");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.oldLine).toBe("b");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.newLine).toBe("B");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[2]!.type).toBe("equal");
	});

	test("handles multiple consecutive removes", () => {
		const ops: DiffOp[] = [
			{ type: "remove", line: "a", oldLineNo: 1 },
			{ type: "remove", line: "b", oldLineNo: 2 },
		];
		const rows = buildSplitRows(ops);
		expect(rows).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[0]!.type).toBe("remove");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.type).toBe("remove");
	});

	test("handles remove then remove then add (only first remove+? check applies per iteration)", () => {
		const ops: DiffOp[] = [
			{ type: "remove", line: "a", oldLineNo: 1 },
			{ type: "remove", line: "b", oldLineNo: 2 },
			{ type: "add", line: "c", newLineNo: 1 },
		];
		const rows = buildSplitRows(ops);
		// First remove is followed by another remove, not add, so it's standalone remove.
		// Second remove is followed by add, so it pairs as change.
		expect(rows).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[0]!.type).toBe("remove");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[0]!.oldLine).toBe("a");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.type).toBe("change");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.oldLine).toBe("b");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(rows[1]!.newLine).toBe("c");
	});
});

// ─── renderSplitDiff ─────────────────────────────────────────────────────────

describe("renderSplitDiff", () => {
	test("returns HTML with split-view wrapper and table", () => {
		const html = renderSplitDiff("a", "a");
		expect(html).toContain("diff-split-view");
		expect(html).toContain("<table");
		expect(html).toContain("</table>");
	});

	test("renders equal rows", () => {
		const html = renderSplitDiff("hello", "hello");
		expect(html).toContain("diff-equal");
	});

	test("renders add rows for pure insertions", () => {
		// Use multi-line to get a genuine add (not paired with a remove)
		const html = renderSplitDiff("a\nc", "a\nb\nc");
		expect(html).toContain("diff-add");
		expect(html).toContain("+");
	});

	test("renders remove rows for pure deletions", () => {
		// Use multi-line to get a genuine remove (not paired with an add)
		const html = renderSplitDiff("a\nb\nc", "a\nc");
		expect(html).toContain("diff-remove");
		expect(html).toContain("-");
	});

	test("renders change rows when old and new differ on a single line", () => {
		// Single-line old vs single-line new produces remove+add -> change
		const html = renderSplitDiff("old", "new");
		expect(html).toContain("diff-change");
	});

	test("escapes HTML in content", () => {
		const html = renderSplitDiff("<b>bold</b>", "<i>italic</i>");
		expect(html).toContain("&lt;b&gt;");
		expect(html).toContain("&lt;i&gt;");
	});

	test("includes line numbers", () => {
		const html = renderSplitDiff("a\nb", "a\nb");
		expect(html).toContain(">1<");
		expect(html).toContain(">2<");
	});

	test("renders old and new columns in table cells", () => {
		const html = renderSplitDiff("left", "right");
		expect(html).toContain("diff-code-old");
		expect(html).toContain("diff-code-new");
		expect(html).toContain("diff-ln-old");
		expect(html).toContain("diff-ln-new");
	});
});

// ─── diffStats ───────────────────────────────────────────────────────────────

describe("diffStats", () => {
	test("returns zero for identical texts", () => {
		expect(diffStats("abc", "abc")).toEqual({ additions: 0, deletions: 0 });
	});

	test("counts additions from empty text", () => {
		// "" splits to [""], so diffing [""] vs ["a","b","c"] yields:
		// 1 removal (the empty line) + 3 additions
		const result = diffStats("", "a\nb\nc");
		expect(result.additions).toBe(3);
		expect(result.deletions).toBe(1);
	});

	test("counts deletions to empty text", () => {
		// ["a","b","c"] vs [""] yields 3 removals + 1 addition (the empty line)
		const result = diffStats("a\nb\nc", "");
		expect(result.deletions).toBe(3);
		expect(result.additions).toBe(1);
	});

	test("counts pure additions (no empty-line artifact)", () => {
		// Using [] vs ["a","b","c"] via computeDiff directly avoids the empty line issue
		// But diffStats splits on \n, so use multi-line that share no common lines
		const result = diffStats("x", "x\na\nb");
		// "x" is equal, "a" and "b" are added
		expect(result.additions).toBe(2);
		expect(result.deletions).toBe(0);
	});

	test("counts pure deletions", () => {
		const result = diffStats("x\na\nb", "x");
		expect(result.additions).toBe(0);
		expect(result.deletions).toBe(2);
	});

	test("counts mixed additions and deletions", () => {
		const result = diffStats("a\nb\nc", "a\nB\nc");
		expect(result.additions).toBe(1);
		expect(result.deletions).toBe(1);
	});

	test("handles empty strings (both empty)", () => {
		expect(diffStats("", "")).toEqual({ additions: 0, deletions: 0 });
	});

	test("handles multi-line insertion", () => {
		const old = "line1\nline3";
		const new_ = "line1\nline2\nline3";
		const result = diffStats(old, new_);
		expect(result.additions).toBe(1);
		expect(result.deletions).toBe(0);
	});

	test("handles complete replacement", () => {
		const result = diffStats("a\nb\nc", "x\ny\nz");
		expect(result.additions).toBe(3);
		expect(result.deletions).toBe(3);
	});
});
