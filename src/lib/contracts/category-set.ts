import { Schema } from "effect";

const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const characterCount = (text: string) => [...characters.segment(text)].length;

export const CategorySchema = Schema.Struct({
	id: Schema.String.pipe(Schema.pattern(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u)),
	origin: Schema.Literal("builtin", "custom"),
	label: Schema.String.pipe(
		Schema.filter(
			(label) => label.trim().length > 0 && characterCount(label) <= 24,
		),
	),
	glyph: Schema.String.pipe(
		Schema.filter(
			(glyph) => glyph.trim().length > 0 && characterCount(glyph) === 1,
		),
	),
	colour: Schema.String.pipe(Schema.pattern(/^#(?:[\da-f]{3}|[\da-f]{6})$/i)),
	weight: Schema.Number.pipe(Schema.between(0, 100)),
	retired: Schema.Boolean,
	criteria: Schema.Struct({
		what: Schema.String,
		not_for: Schema.optional(Schema.String),
		examples: Schema.optional(Schema.Array(Schema.String)),
	}),
});
export type Category = typeof CategorySchema.Type;

export const CategorySetContentsSchema = Schema.Struct({
	categories: Schema.Array(CategorySchema),
});
export type CategorySetContents = typeof CategorySetContentsSchema.Type;

/** Verdict identity excludes weights, presentation and retirement state. */
export const categoryCriteriaKey = (set: CategorySetContents): string =>
	JSON.stringify(
		set.categories
			.map(({ id, criteria }) => [
				id,
				criteria.what,
				criteria.not_for ?? "",
				criteria.examples ?? [],
			])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	);

export const CategorySetSchema = Schema.Struct({
	version: Schema.NonNegativeInt.pipe(
		Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
	),
	categories: Schema.Array(CategorySchema),
});
export type CategorySet = typeof CategorySetSchema.Type;

export const DEFAULT_CUSTOM_CATEGORY_WEIGHT = 50;

/** Choice keys are derived once. Editing a label preserves its existing key. */
export const categoryIdFromLabel = (label: string): string =>
	label
		.normalize("NFKD")
		.toLowerCase()
		.replace(/\p{M}/gu, "")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-|-$/g, "");

// Final prototype taxonomy and dark-theme colours. Routine stays implicit.
export const BUILTIN_CATEGORIES: readonly Category[] = [
	{
		id: "ask",
		origin: "builtin",
		label: "Ask",
		glyph: "?",
		colour: "#ff9f0a",
		weight: 100,
		retired: false,
		criteria: { what: "asks the user for a choice, fact, approval or action" },
	},
	{
		id: "blocked",
		origin: "builtin",
		label: "Blocked",
		glyph: "✕",
		colour: "#ff6369",
		weight: 80,
		retired: false,
		criteria: {
			what: "reports a failed gate, missing access or stop condition that prevents the next step",
		},
	},
	{
		id: "risk",
		origin: "builtin",
		label: "Risk",
		glyph: "!",
		colour: "#f469c4",
		weight: 80,
		retired: false,
		criteria: {
			what: "names an unresolved plausible harm, regression or hazard",
		},
	},
	{
		id: "scope",
		origin: "builtin",
		label: "Scope",
		glyph: "±",
		colour: "#6b6b74",
		weight: 80,
		retired: false,
		criteria: { what: "says the agreed deliverables must grow or shrink" },
	},
	{
		id: "replan",
		origin: "builtin",
		label: "Replan",
		glyph: "↻",
		colour: "#6b6b74",
		weight: 60,
		retired: false,
		criteria: { what: "changes method or order because of new evidence" },
	},
	{
		id: "correction",
		origin: "builtin",
		label: "Correction",
		glyph: "↶",
		colour: "#6b6b74",
		weight: 60,
		retired: false,
		criteria: { what: "retracts or materially revises an earlier claim" },
	},
	{
		id: "decision",
		origin: "builtin",
		label: "Decision",
		glyph: "◆",
		colour: "#6b6b74",
		weight: 60,
		retired: false,
		criteria: {
			what: "commits to a consequential choice or trade-off on the user's behalf",
		},
	},
	{
		id: "finding",
		origin: "builtin",
		label: "Finding",
		glyph: "●",
		colour: "#6b6b74",
		weight: 40,
		retired: false,
		criteria: { what: "establishes a new fact or root cause" },
	},
	{
		id: "milestone",
		origin: "builtin",
		label: "Milestone",
		glyph: "✓",
		colour: "#3ecf8e",
		weight: 40,
		retired: false,
		criteria: { what: "reports a completed deliverable or full gate" },
	},
];

export const DEFAULT_CATEGORY_SET: CategorySet = {
	version: 1,
	categories: BUILTIN_CATEGORIES,
};

export class CategorySetRejected extends Schema.TaggedError<CategorySetRejected>()(
	"CategorySetRejected",
	{
		reason: Schema.Literal("stale_version", "invalid_set"),
		message: Schema.String,
		currentVersion: Schema.NonNegativeInt,
	},
) {}

export const SurfacingLevelSchema = Schema.Literal(
	"hidden",
	"all",
	"balanced",
	"key",
);
export type SurfacingLevel = typeof SurfacingLevelSchema.Type;
export const SurfacingMarkSchema = Schema.Struct({
	level: SurfacingLevelSchema,
	category: Schema.optional(Schema.String),
	reason: Schema.optional(Schema.String),
	direction: Schema.optional(Schema.Literal("raise", "lower", "retype")),
});
export type SurfacingMark = typeof SurfacingMarkSchema.Type;

export const SurfacingFeedbackEntrySchema = Schema.Struct({
	projectId: Schema.String,
	sessionId: Schema.String,
	sessionTitle: Schema.String,
	requestExcerpt: Schema.String,
	partId: Schema.String,
	messageId: Schema.String,
	turnId: Schema.NullOr(Schema.String),
	ordinal: Schema.NullOr(Schema.Number),
	text: Schema.String,
	probabilities: Schema.NullOr(
		Schema.Record({ key: Schema.String, value: Schema.Number }),
	),
	mark: SurfacingMarkSchema,
	createdAt: Schema.Number,
});
export type SurfacingFeedbackEntry = typeof SurfacingFeedbackEntrySchema.Type;

/** No provider calls or stored levels: every consumer scores against today's set. */
export function surfacingLevel(
	verdict: { readonly probabilities: Readonly<Record<string, number>> | null },
	categorySet: CategorySetContents,
	mark?: SurfacingMark,
): { level: SurfacingLevel; category: string | null } {
	let category: string | null = null;
	let prominence = -1;
	let highestProbability = 0;
	if (verdict.probabilities !== null) {
		for (const candidate of categorySet.categories) {
			if (candidate.retired) continue;
			if (!Object.hasOwn(verdict.probabilities, candidate.id)) continue;
			const probability = verdict.probabilities[candidate.id];
			if (probability === undefined) continue;
			highestProbability = Math.max(highestProbability, probability);
			const score = candidate.weight * probability;
			if (score > prominence) {
				prominence = score;
				category = candidate.id;
			}
		}
	}
	const hidden =
		category === null ||
		(verdict.probabilities?.["routine"] ?? 0) > highestProbability;
	const level = hidden
		? "hidden"
		: prominence >= 70
			? "key"
			: prominence >= 40
				? "balanced"
				: "all";
	return {
		level: mark?.level ?? level,
		category:
			mark?.category &&
			categorySet.categories.some(({ id }) => id === mark.category)
				? mark.category
				: category,
	};
}
