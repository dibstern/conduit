import type {
	CategorySetContents,
	SurfacingFeedbackEntry,
} from "../../contracts/category-set.js";
import type {
	CategoryTuningHunk,
	CategoryTuningScore,
} from "../../contracts/category-tuning.js";

export function withTuningHunks(
	set: CategorySetContents,
	hunks: readonly CategoryTuningHunk[],
): CategorySetContents {
	const replacements = new Map(
		hunks.map((hunk) => [hunk.categoryId, hunk.after]),
	);
	return {
		categories: [
			...set.categories.map(
				(category) => replacements.get(category.id) ?? category,
			),
			...hunks
				.filter(
					(hunk) =>
						!set.categories.some((category) => category.id === hunk.categoryId),
				)
				.map((hunk) => hunk.after),
		],
	};
}

/** Resolve the proposal's required hunks for scoring, selection and application. */
export function hunkDependencies(
	hunks: readonly CategoryTuningHunk[],
	hunk: CategoryTuningHunk,
): readonly CategoryTuningHunk[] {
	return hunks.filter((other) => hunk.dependsOn?.includes(other.id));
}

export function movedMessages(
	before: CategoryTuningScore,
	after: CategoryTuningScore,
): number {
	return after.levels.filter(
		(next) =>
			next.level !== null &&
			before.levels.some(
				(previous) =>
					previous.sessionId === next.sessionId &&
					previous.partId === next.partId &&
					previous.level !== null &&
					previous.level !== next.level,
			),
	).length;
}

export function changedAgreement(
	entries: readonly SurfacingFeedbackEntry[],
	before: CategoryTuningScore,
	after: CategoryTuningScore,
): { entry: SurfacingFeedbackEntry; fixed: boolean }[] {
	return entries.flatMap((entry) => {
		const previous = before.levels.find(
			(level) =>
				level.sessionId === entry.sessionId && level.partId === entry.partId,
		)?.level;
		const next = after.levels.find(
			(level) =>
				level.sessionId === entry.sessionId && level.partId === entry.partId,
		)?.level;
		if (
			previous == null ||
			next == null ||
			(previous === entry.mark.level) === (next === entry.mark.level)
		)
			return [];
		return [{ entry, fixed: next === entry.mark.level }];
	});
}

export function hunkDiff(
	hunk: CategoryTuningHunk,
): { field: string; before: string; after: string }[] {
	const { before, after } = hunk;
	if (!before)
		return [
			{
				field: "Add category",
				before: "",
				after: `${after.glyph} ${after.label}`,
			},
			{ field: "colour", before: "", after: after.colour },
			{ field: "weight", before: "", after: String(after.weight) },
			{ field: "what", before: "", after: after.criteria.what },
			{ field: "not_for", before: "", after: after.criteria.not_for ?? "" },
			{
				field: "examples",
				before: "",
				after: (after.criteria.examples ?? []).join("\n"),
			},
		].filter((change) => change.after !== "");
	return [
		{
			field: "weight",
			before: String(before.weight),
			after: String(after.weight),
		},
		{ field: "what", before: before.criteria.what, after: after.criteria.what },
		{
			field: "not_for",
			before: before.criteria.not_for ?? "",
			after: after.criteria.not_for ?? "",
		},
		{
			field: "examples",
			before: (before.criteria.examples ?? []).join("\n"),
			after: (after.criteria.examples ?? []).join("\n"),
		},
		{
			field: "active",
			before: before.retired ? "retired" : "active",
			after: after.retired ? "retired" : "active",
		},
	].filter((change) => change.before !== change.after);
}
