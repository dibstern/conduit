// ─── Diff Algorithm ──────────────────────────────────────────────────────────
// LCS-based diff with unified and split rendering.
// Pure functions — no DOM or framework dependencies.

import { assertNever } from "../../utils.js";
import type { DiffOp, SplitRow } from "../types.js";
import { escapeHtml } from "./format.js";

// Re-export types for convenience
export type { DiffOp, SplitRow };

/** Compute LCS-based diff between two arrays of lines. */
export function computeDiff(oldLines: string[], newLines: string[]): DiffOp[] {
	const m = oldLines.length;
	const n = newLines.length;

	// Build LCS table
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}

	// Backtrack to build diff
	const ops: DiffOp[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			ops.unshift({
				type: "equal",
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				line: oldLines[i - 1]!,
				oldLineNo: i,
				newLineNo: j,
			});
			i--;
			j--;
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		} else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			ops.unshift({ type: "add", line: newLines[j - 1]!, newLineNo: j });
			j--;
		} else {
			ops.unshift({
				type: "remove",
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				line: oldLines[i - 1]!,
				oldLineNo: i,
			});
			i--;
		}
	}

	return ops;
}

/** Render unified diff as HTML string. */
export function renderUnifiedDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const ops = computeDiff(oldLines, newLines);

	const lines: string[] = [];

	for (const op of ops) {
		const escapedLine = escapeHtml(op.line || "");
		const oldNo = op.oldLineNo ?? "";
		const newNo = op.newLineNo ?? "";

		const gutterOld =
			"diff-gutter diff-gutter-old min-w-[40px] px-2 text-right text-text-dimmer select-none shrink-0 text-[11px]";
		const gutterNew =
			"diff-gutter diff-gutter-new min-w-[40px] px-2 text-right text-text-dimmer select-none shrink-0 text-[11px]";
		const gutterOldBorder = `${gutterOld} border-r border-border-subtle`;

		switch (op.type) {
			case "equal":
				lines.push(
					`<div class="diff-line diff-equal flex min-h-[20px] whitespace-pre"><span class="${gutterOldBorder}">${oldNo}</span><span class="${gutterNew}">${newNo}</span><span class="diff-marker min-w-[20px] text-center shrink-0 font-semibold select-none">&nbsp;</span><span class="diff-text flex-1 pr-3 text-text-secondary">${escapedLine}</span></div>`,
				);
				break;
			case "add":
				lines.push(
					`<div class="diff-line diff-add flex min-h-[20px] whitespace-pre bg-[rgba(26,127,35,0.08)]"><span class="${gutterOldBorder}"></span><span class="${gutterNew}">${newNo}</span><span class="diff-marker min-w-[20px] text-center shrink-0 font-semibold select-none text-success">+</span><span class="diff-text flex-1 pr-3 text-success">${escapedLine}</span></div>`,
				);
				break;
			case "remove":
				lines.push(
					`<div class="diff-line diff-remove flex min-h-[20px] whitespace-pre bg-[rgba(192,57,43,0.08)]"><span class="${gutterOldBorder}">${oldNo}</span><span class="${gutterNew}"></span><span class="diff-marker min-w-[20px] text-center shrink-0 font-semibold select-none text-error">-</span><span class="diff-text flex-1 pr-3 text-error">${escapedLine}</span></div>`,
				);
				break;
			default:
				assertNever(op.type);
		}
	}

	return `<div class="diff-viewer font-mono text-xs leading-normal overflow-x-auto bg-code-bg border border-border-subtle rounded-lg">${lines.join("")}</div>`;
}

/** Build aligned rows for a split diff, pairing adjacent remove+add ops. */
export function buildSplitRows(ops: DiffOp[]): SplitRow[] {
	const rows: SplitRow[] = [];
	let i = 0;
	while (i < ops.length) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const op = ops[i]!;
		if (op.type === "equal") {
			rows.push({
				type: "equal",
				oldLineNo: op.oldLineNo ?? null,
				oldLine: op.line,
				newLineNo: op.newLineNo ?? null,
				newLine: op.line,
			});
			i++;
		} else if (
			op.type === "remove" &&
			i + 1 < ops.length &&
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			ops[i + 1]!.type === "add"
		) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			const next = ops[i + 1]!;
			rows.push({
				type: "change",
				oldLineNo: op.oldLineNo ?? null,
				oldLine: op.line,
				newLineNo: next.newLineNo ?? null,
				newLine: next.line,
			});
			i += 2;
		} else if (op.type === "remove") {
			rows.push({
				type: "remove",
				oldLineNo: op.oldLineNo ?? null,
				oldLine: op.line,
				newLineNo: null,
				newLine: null,
			});
			i++;
		} else {
			rows.push({
				type: "add",
				oldLineNo: null,
				oldLine: null,
				newLineNo: op.newLineNo ?? null,
				newLine: op.line,
			});
			i++;
		}
	}
	return rows;
}

/** Render split (side-by-side) diff as HTML string. */
export function renderSplitDiff(oldText: string, newText: string): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const ops = computeDiff(oldLines, newLines);
	const rows = buildSplitRows(ops);

	const htmlRows: string[] = [];
	for (const row of rows) {
		const oldNo = row.oldLineNo ?? "";
		const newNo = row.newLineNo ?? "";
		const oldMarker =
			row.type === "remove" || row.type === "change" ? "-" : "&nbsp;";
		const newMarker =
			row.type === "add" || row.type === "change" ? "+" : "&nbsp;";
		const oldCode = row.oldLine !== null ? escapeHtml(row.oldLine) : "&nbsp;";
		const newCode = row.newLine !== null ? escapeHtml(row.newLine) : "&nbsp;";

		const rowClass =
			row.type === "change"
				? "diff-row diff-change"
				: `diff-row diff-${row.type}`;

		htmlRows.push(
			`<tr class="${rowClass}">` +
				`<td class="diff-ln diff-ln-old">${oldNo}</td>` +
				`<td class="diff-marker diff-marker-old">${oldMarker}</td>` +
				`<td class="diff-code diff-code-old">${oldCode}</td>` +
				`<td class="diff-ln diff-ln-new">${newNo}</td>` +
				`<td class="diff-marker diff-marker-new">${newMarker}</td>` +
				`<td class="diff-code diff-code-new">${newCode}</td>` +
				"</tr>",
		);
	}

	return (
		'<div class="diff-split-view">' +
		'<table class="diff-table">' +
		htmlRows.join("") +
		"</table>" +
		"</div>"
	);
}

/** Compute diff stats (additions and deletions). */
export function diffStats(
	oldText: string,
	newText: string,
): { additions: number; deletions: number } {
	const ops = computeDiff(oldText.split("\n"), newText.split("\n"));
	let additions = 0;
	let deletions = 0;
	for (const op of ops) {
		if (op.type === "add") additions++;
		if (op.type === "remove") deletions++;
	}
	return { additions, deletions };
}
