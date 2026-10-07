import { Schema } from "effect";

export const LimitRecoverySchema = Schema.Struct({
	instanceId: Schema.String,
	rateLimitType: Schema.String,
	/** Unix seconds, as reported by the Claude SDK. */
	resetsAt: Schema.optional(Schema.Number),
	cutOffMessageId: Schema.optional(Schema.String),
	scheduledAt: Schema.optional(Schema.Number),
	rearms: Schema.NonNegativeInt,
	continued: Schema.Boolean,
});

export type LimitRecovery = typeof LimitRecoverySchema.Type;
