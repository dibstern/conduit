// The diff lines a review comment quotes, cut from one file's unified patch.
import type { SelectedLineRange } from "@pierre/diffs";

type Side = NonNullable<SelectedLineRange["side"]>;
type Row = { readonly line: string } & Partial<Record<Side, number>>;

/** Each hunk row with its line number on the side or sides it appears on. */
function patchRows(patch: string): Row[] {
	const rows: Row[] = [];
	// Unset until the first hunk header, so the `---`/`+++` file header is skipped.
	let next: Record<Side, number> | undefined;
	for (const line of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) next = { deletions: Number(hunk[1]), additions: Number(hunk[2]) };
		else if (next && /^[ +-]/.test(line))
			rows.push({
				line,
				...(line[0] === "+" ? {} : { deletions: next.deletions++ }),
				...(line[0] === "-" ? {} : { additions: next.additions++ }),
			});
	}
	return rows;
}

/** The selected rows, each kept with its `+`, `-` or space marker; empty when a bound is not in the patch. */
export function reviewExcerpt(patch: string, range: SelectedLineRange): string {
	const rows = patchRows(patch);
	const side = range.side ?? "additions";
	const from = rows.findIndex((row) => row[side] === range.start);
	const to = rows.findIndex((row) => row[range.endSide ?? side] === range.end);
	if (from < 0 || to < 0) return "";
	return rows
		.slice(Math.min(from, to), Math.max(from, to) + 1)
		.map(({ line }) => line)
		.join("\n");
}
