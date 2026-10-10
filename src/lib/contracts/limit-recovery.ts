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
		return "Continue this session on another Claude account.";
	}
}

export class HandoffTooLarge extends Schema.TaggedError<HandoffTooLarge>()(
	"HandoffTooLarge",
	{ budget: Schema.Number },
) {
	get message() {
		return "The conversation handoff does not fit this session's context window. Shorten the request or choose a larger context window before switching.";
	}
}

export const ContinuationErrorSchema = Schema.Union(
	SessionBusy,
	StaleSwitch,
	AccountUnavailable,
	DriverMismatch,
	HandoffTooLarge,
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
	/** The session moved to another account: the strip leaves, the cut-off tag stays. */
	switched: Schema.optional(Schema.Boolean),
});

export type LimitRecovery = typeof LimitRecoverySchema.Type;

/** One continuation of a cut-off session; the transcript keeps a divider for each. */
export const SessionResumeSchema = Schema.Struct({
	/** Unix ms, from the session.resumed event. */
	at: Schema.Number,
	instanceId: Schema.String,
	reason: ContinuationReasonSchema,
	/** The account it switched from; absent when it continued on the same one. */
	from: Schema.optional(Schema.String),
});

export type SessionResume = typeof SessionResumeSchema.Type;

/** What the daemon does when a Claude account reaches its usage limit. */
export const UsageLimitsSettingSchema = Schema.Struct({
	autoResume: Schema.Boolean,
	autoSwitch: Schema.Boolean,
	warnAt: Schema.optionalWith(Schema.Literal(70, 80, 90, "off"), {
		default: () => 80 as const,
	}),
	/** Claude instance IDs, in the order auto-switch tries them. */
	order: Schema.Array(Schema.String),
});

export type UsageLimitsSetting = typeof UsageLimitsSettingSchema.Type;

export const DEFAULT_USAGE_LIMITS: UsageLimitsSetting = {
	autoResume: false,
	autoSwitch: false,
	warnAt: 80,
	order: [],
};

export const HandoffSummarySchema = Schema.Struct({
	included: Schema.NonNegativeInt,
	omitted: Schema.NonNegativeInt,
	firstMessageIncluded: Schema.Boolean,
	tokens: Schema.NonNegativeInt,
});
export type HandoffSummary = typeof HandoffSummarySchema.Type;

const usageWindowFields = {
	utilization: Schema.Number.pipe(Schema.finite(), Schema.between(0, 100)),
	/** ISO timestamp from the usage reader. */
	resetsAt: Schema.optional(Schema.String),
};

export const UsageHistoryPointSchema = Schema.Struct({
	/** Epoch milliseconds. */
	at: Schema.Number.pipe(Schema.finite()),
	utilization: usageWindowFields.utilization,
});
export type UsageHistoryPoint = typeof UsageHistoryPointSchema.Type;

export const UsageForecastSchema = Schema.Union(
	Schema.Struct({
		kind: Schema.Literal("under"),
		atReset: usageWindowFields.utilization,
	}),
	Schema.Struct({
		kind: Schema.Literal("runs_out"),
		/** Epoch milliseconds. */
		at: Schema.Number.pipe(Schema.finite()),
	}),
);
export type UsageForecast = typeof UsageForecastSchema.Type;

export const UsageWindowSchema = Schema.Union(
	Schema.Struct({
		kind: Schema.Literal("five_hour", "seven_day", "month"),
		...usageWindowFields,
		history: Schema.optional(Schema.Array(UsageHistoryPointSchema)),
		forecast: Schema.optional(UsageForecastSchema),
	}),
	Schema.Struct({
		kind: Schema.Literal("seven_day_model"),
		model: Schema.optional(Schema.String),
		...usageWindowFields,
	}),
);
export type UsageWindow = typeof UsageWindowSchema.Type;

export const UsageReadingSchema = Schema.Struct({
	accountId: Schema.String,
	harness: Schema.Literal("claude", "codex", "cursor"),
	status: Schema.Literal("available", "limited", "unavailable", "unknown"),
	planLabel: Schema.optional(Schema.String),
	windows: Schema.Array(UsageWindowSchema),
	/** Epoch milliseconds. */
	readAt: Schema.Number,
	stale: Schema.Boolean,
	reason: Schema.optional(Schema.String),
});
export type UsageReading = typeof UsageReadingSchema.Type;
