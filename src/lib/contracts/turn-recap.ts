import { Schema } from "effect";

export const RecapScopeSchema = Schema.Literals(["whole", "new"]);
export type RecapScope = typeof RecapScopeSchema.Type;

export const TurnRecapSchema = Schema.Struct({
	sessionId: Schema.String,
	turnId: Schema.String,
	version: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
	scope: RecapScopeSchema,
	firstOrdinal: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
	lastOrdinal: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
	text: Schema.String,
	model: Schema.String,
	durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	createdAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TurnRecap = typeof TurnRecapSchema.Type;

export const RecapSnapshotSchema = Schema.Struct({
	versions: Schema.Array(TurnRecapSchema),
	generating: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	retry: Schema.optional(
		Schema.Struct({
			scope: RecapScopeSchema,
			sourceVersion: Schema.optional(
				Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
			),
		}),
	),
});
export type RecapSnapshot = typeof RecapSnapshotSchema.Type;
