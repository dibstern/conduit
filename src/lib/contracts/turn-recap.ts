import { Schema } from "effect";

export const RecapScopeSchema = Schema.Literal("whole", "new");
export type RecapScope = typeof RecapScopeSchema.Type;

export const TurnRecapSchema = Schema.Struct({
	sessionId: Schema.String,
	turnId: Schema.String,
	version: Schema.Int.pipe(Schema.positive()),
	scope: RecapScopeSchema,
	firstOrdinal: Schema.Int.pipe(Schema.positive()),
	lastOrdinal: Schema.Int.pipe(Schema.positive()),
	text: Schema.String,
	model: Schema.String,
	durationMs: Schema.NonNegativeInt,
	createdAt: Schema.NonNegativeInt,
});
export type TurnRecap = typeof TurnRecapSchema.Type;

export const RecapSnapshotSchema = Schema.Struct({
	versions: Schema.Array(TurnRecapSchema),
	generating: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	retry: Schema.optional(
		Schema.Struct({
			scope: RecapScopeSchema,
			sourceVersion: Schema.optional(Schema.Int.pipe(Schema.positive())),
		}),
	),
});
export type RecapSnapshot = typeof RecapSnapshotSchema.Type;
