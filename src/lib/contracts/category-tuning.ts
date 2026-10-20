import { Schema } from "effect";
import { CategorySchema, SurfacingLevelSchema } from "./category-set.js";

/** Complete before/after categories keep proposal application in the browser. */
export const CategoryTuningHunkSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	categoryId: Schema.NonEmptyString,
	before: Schema.NullOr(CategorySchema),
	after: CategorySchema,
	rationale: Schema.String,
	/** Required hunk ids, assigned when the proposal is validated. */
	dependsOn: Schema.optional(Schema.Array(Schema.NonEmptyString)),
});
export type CategoryTuningHunk = typeof CategoryTuningHunkSchema.Type;

export const CategoryTuningProposalSchema = Schema.Struct({
	hunks: Schema.Array(CategoryTuningHunkSchema),
	rationale: Schema.String,
	baseVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type CategoryTuningProposal = typeof CategoryTuningProposalSchema.Type;

export const CategoryTuningScoreSchema = Schema.Struct({
	agree: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	levels: Schema.Array(
		Schema.Struct({
			partId: Schema.String,
			sessionId: Schema.String,
			level: Schema.NullOr(SurfacingLevelSchema),
			category: Schema.NullOr(Schema.String),
		}),
	),
	/** Calls still needed. Estimation never submits a Jev request. */
	requiredCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	jevCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	/** Partial/missing verdicts must never be displayed as accurate agreement. */
	complete: Schema.Boolean,
	canTest: Schema.Boolean,
	unavailableReason: Schema.optional(Schema.String),
});
export type CategoryTuningScore = typeof CategoryTuningScoreSchema.Type;
