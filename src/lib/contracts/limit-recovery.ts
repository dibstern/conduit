import { Schema } from "effect";

export const ContinuationReasonSchema = Schema.Literal(
	"user",
	"auto-switch",
	"reset",
);
export type ContinuationReason = typeof ContinuationReasonSchema.Type;

export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
	"SessionBusy",
	{
		sessionId: Schema.String,
	},
) {
	get message() {
		return "Wait for the current turn to finish before continuing.";
	}
}

export class StaleSwitch extends Schema.TaggedError<StaleSwitch>()(
	"StaleSwitch",
	{
		sessionId: Schema.String,
		expectedInstanceId: Schema.String,
		actualInstanceId: Schema.optional(Schema.String),
	},
) {
	get message() {
		return "The session's account changed. Refresh before continuing.";
	}
}

export class AccountUnavailable extends Schema.TaggedError<AccountUnavailable>()(
	"AccountUnavailable",
	{
		instanceId: Schema.String,
		reason: Schema.String,
	},
) {
	get message() {
		return this.reason;
	}
}

export class DriverMismatch extends Schema.TaggedError<DriverMismatch>()(
	"DriverMismatch",
	{
		sessionId: Schema.String,
		instanceId: Schema.String,
	},
) {
	get message() {
		return "Continuation requires the session's Claude account.";
	}
}

export const ContinuationErrorSchema = Schema.Union(
	SessionBusy,
	StaleSwitch,
	AccountUnavailable,
	DriverMismatch,
);
export type ContinuationError = typeof ContinuationErrorSchema.Type;

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
