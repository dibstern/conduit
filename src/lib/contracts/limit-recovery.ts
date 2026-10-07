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
	/** The limit policy scheduled the resume, not the user. */
	auto: Schema.optional(Schema.Boolean),
	rearms: Schema.NonNegativeInt,
	continued: Schema.Boolean,
});

export type LimitRecovery = typeof LimitRecoverySchema.Type;

/** One continuation of a cut-off session; the transcript keeps a divider for each. */
export const SessionResumeSchema = Schema.Struct({
	/** Unix ms, from the session.resumed event. */
	at: Schema.Number,
	instanceId: Schema.String,
	reason: ContinuationReasonSchema,
});

export type SessionResume = typeof SessionResumeSchema.Type;

/** What the daemon does when a Claude account reaches its usage limit. */
export const UsageLimitsSettingSchema = Schema.Struct({
	autoResume: Schema.Boolean,
	autoSwitch: Schema.Boolean,
	/** Claude instance IDs, in the order auto-switch tries them. */
	order: Schema.Array(Schema.String),
});

export type UsageLimitsSetting = typeof UsageLimitsSettingSchema.Type;

export const DEFAULT_USAGE_LIMITS: UsageLimitsSetting = {
	autoResume: false,
	autoSwitch: false,
	order: [],
};
