import { Effect, Schema } from "effect";
import { AccountRefSchema } from "./account.js";

export class AccountUnroutable extends Schema.TaggedError<AccountUnroutable>()(
	"AccountUnroutable",
	{
		ref: Schema.suspend(() => AccountRefSchema),
	},
) {
	get message() {
		const name = this.ref._tag === "Id" ? this.ref.id : this.ref.driver;
		return `Cannot route account reference "${name}".`;
	}
}

export const ContinuationReasonSchema = Schema.Literals([
	"user",
	"auto-switch",
	"reset",
]);
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

export class AccountStillLimited extends Schema.TaggedError<AccountStillLimited>()(
	"AccountStillLimited",
	{
		label: Schema.String,
		/** Epoch milliseconds. */
		until: Schema.Number,
	},
) {
	get message() {
		return `Claude still shows the ${this.label} until ${new Date(this.until).toUTCString()}.`;
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

export const ContinuationErrorSchema = Schema.Union([
	AccountUnroutable,
	SessionBusy,
	StaleSwitch,
	AccountUnavailable,
	AccountStillLimited,
	DriverMismatch,
	HandoffTooLarge,
]);
export type ContinuationError = typeof ContinuationErrorSchema.Type;

export const LimitRecoverySchema = Schema.Struct({
	instanceId: Schema.String,
	rateLimitType: Schema.String,
	/** Unix seconds, as reported by the Claude SDK. */
	resetsAt: Schema.optional(Schema.Number),
	/** Epoch milliseconds, from the session.usage_limited event's creation time. */
	limitedAt: Schema.optional(Schema.Number),
	/** Wait for the reset time even when a Usage Reading appears free. */
	timeOnly: Schema.optional(Schema.Boolean),
	cutOffMessageId: Schema.optional(Schema.String),
	scheduledAt: Schema.optional(Schema.Number),
	/** The limit policy scheduled the resume, not the user. */
	auto: Schema.optional(Schema.Boolean),
	rearms: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
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
	warnAt: Schema.Literals([70, 80, 90, "off"]).pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => 80 as const)),
		Schema.withConstructorDefault(Effect.sync(() => 80 as const)),
	),
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
	included: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
	omitted: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
	firstMessageIncluded: Schema.Boolean,
	tokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type HandoffSummary = typeof HandoffSummarySchema.Type;

const usageWindowFields = {
	utilization: Schema.Number.pipe(
		Schema.check(Schema.isFinite()),
		Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
	),
	/** ISO timestamp from the usage reader. */
	resetsAt: Schema.optional(Schema.String),
};

export const UsageHistoryPointSchema = Schema.Struct({
	/** Epoch milliseconds. */
	at: Schema.Number.pipe(Schema.check(Schema.isFinite())),
	utilization: usageWindowFields.utilization,
});
export type UsageHistoryPoint = typeof UsageHistoryPointSchema.Type;

export const UsageForecastSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("under"),
		atReset: usageWindowFields.utilization,
	}),
	Schema.Struct({
		kind: Schema.Literal("runs_out"),
		/** Epoch milliseconds. */
		at: Schema.Number.pipe(Schema.check(Schema.isFinite())),
	}),
]);
export type UsageForecast = typeof UsageForecastSchema.Type;

export const UsageWindowSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literals(["five_hour", "seven_day", "month"]),
		...usageWindowFields,
		history: Schema.optional(Schema.Array(UsageHistoryPointSchema)),
		forecast: Schema.optional(UsageForecastSchema),
	}),
	Schema.Struct({
		kind: Schema.Literal("seven_day_model"),
		model: Schema.optional(Schema.String),
		...usageWindowFields,
	}),
]);
export type UsageWindow = typeof UsageWindowSchema.Type;

export const UsageReadingSchema = Schema.Struct({
	accountId: Schema.String,
	harness: Schema.Literals(["claude", "codex", "cursor"]),
	status: Schema.Literals(["available", "limited", "unavailable", "unknown"]),
	planLabel: Schema.optional(Schema.String),
	windows: Schema.Array(UsageWindowSchema),
	/** Epoch milliseconds. */
	readAt: Schema.Number,
	stale: Schema.Boolean,
	reason: Schema.optional(Schema.String),
});
export type UsageReading = typeof UsageReadingSchema.Type;
