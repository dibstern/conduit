// The diff lines a review comment quotes, cut from one file's unified patch.
import type { SelectedLineRange } from "@pierre/diffs";

type Side = NonNullable<SelectedLineRange["side"]>;
type Row = { readonly line: string } & Partial<Record<Side, number>>;

/** The selected rows, each kept with its `+`, `-` or space marker; empty when a bound is not in the patch. */
export function reviewExcerpt(patch: string, range: SelectedLineRange): string {
	const rows: Row[] = [];
	const next = { deletions: 0, additions: 0 };
	let inHunk = false;
	for (const line of patch.split("\n")) {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			next.deletions = Number(hunk[1]);
			next.additions = Number(hunk[2]);
			inHunk = true;
		} else if (
			inHunk &&
			(line[0] === " " || line[0] === "-" || line[0] === "+")
		)
			rows.push({
				line,
				...(line[0] === "+" ? {} : { deletions: next.deletions++ }),
				...(line[0] === "-" ? {} : { additions: next.additions++ }),
			});
	}
	const side = range.side ?? "additions";
	const from = rows.findIndex((row) => row[side] === range.start);
	const to = rows.findIndex((row) => row[range.endSide ?? side] === range.end);
	if (from < 0 || to < 0) return "";
	return rows
		.slice(Math.min(from, to), Math.max(from, to) + 1)
		.map(({ line }) => line)
		.join("\n");
}
