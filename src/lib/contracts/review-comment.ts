// A review comment on Session Diff lines, as it travels in an input draft.
import { Schema } from "effect";

/** Caps from t3code's composer review context. */
export const REVIEW_TEXT_MAX_CHARS = 16_000;
export const REVIEW_EXCERPT_MAX_CHARS = 32_000;
const ReviewLine = Schema.Number.pipe(
	Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
);

/** A comment on selected lines of one Session Diff file, quoting their excerpt. */
export const DraftReviewSchema = Schema.Struct({
	folder: Schema.NonEmptyString,
	path: Schema.NonEmptyString,
	side: Schema.Literals(["deletions", "additions"]),
	lines: Schema.Struct({ start: ReviewLine, end: ReviewLine }),
	excerpt: Schema.String.pipe(
		Schema.check(Schema.isMaxLength(REVIEW_EXCERPT_MAX_CHARS)),
	),
	text: Schema.NonEmptyString.pipe(
		Schema.check(Schema.isMaxLength(REVIEW_TEXT_MAX_CHARS)),
	),
});
export type DraftReview = typeof DraftReviewSchema.Type;
