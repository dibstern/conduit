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

export const accountSwitchBusyMessage = (
	fromAccount: string,
	toAccount: string,
): string =>
	`Background work is still running on ${fromAccount}. Stop it or wait for it to finish, then resend to switch to ${toAccount}.`;

export class AccountSwitchBusy extends Schema.TaggedError<AccountSwitchBusy>()(
	"AccountSwitchBusy",
	{
		sessionId: Schema.String,
		fromAccountId: Schema.String,
		toAccountId: Schema.String,
		message: Schema.String,
	},
) {}

export const ContinuationReasonSchema = Schema.Literals([
	"user",
	"auto-switch",
	"reset",
]);
export type ContinuationReason = typeof ContinuationReasonSchema.Type;

/** The commands the ledger does not own: a head move (rewind, undo), a fork, a provider switch (82tn.49). */
export const SessionCommandSchema = Schema.Literals([
	"head_move",
	"fork",
	"provider_switch",
]);
export type SessionCommand = typeof SessionCommandSchema.Type;

/** Why the session refused one, read from the Run Ledger and SessionActivity (82tn.49). */
export const SessionRefusalSchema = Schema.Literals([
	"head_move_in_progress",
	"run_active",
	"interaction_pending",
	"inputs_queued",
	"limit_recovery",
	"head_move_stale",
	"history_unavailable",
]);
export type SessionRefusal = typeof SessionRefusalSchema.Type;

const refusalCopy: Record<SessionRefusal, string> = {
	head_move_in_progress:
		"The conversation is still moving to another point. Try again in a moment.",
	run_active: "Stop the current turn first.",
	interaction_pending: "Answer the pending question or permission first.",
	inputs_queued: "Send or remove the queued messages first.",
	limit_recovery: "Resume or dismiss the usage-limit continuation first.",
	head_move_stale:
		"The conversation changed since this was proposed. Review it again.",
	history_unavailable: "That part of the conversation is no longer kept.",
};

export class SessionBusy extends Schema.TaggedError<SessionBusy>()(
	"SessionBusy",
	{
		sessionId: Schema.String,
		command: Schema.optionalKey(SessionCommandSchema),
		reason: Schema.optionalKey(SessionRefusalSchema),
	},
) {
	get message() {
		return this.reason === undefined
			? "Wait for the current turn to finish before continuing."
			: refusalCopy[this.reason];
	}
}

/**
 * Why a head move cannot take its files (82tn.53); moving the conversation alone still can.
 * `other` names the session that ran in, or restored, the folder after the target, or has a
 * run open there now.
 */
export class FilesRefused extends Schema.TaggedError<FilesRefused>()(
	"FilesRefused",
	{
		sessionId: Schema.String,
		reason: Schema.Literals([
			"pruned",
			"not_available",
			"other_session",
			"folder_missing",
			"changed",
			"failed",
		]),
		directory: Schema.optionalKey(Schema.String),
		/** Folder-relative paths that changed since the plan. */
		paths: Schema.optionalKey(Schema.Array(Schema.String)),
		other: Schema.optionalKey(
			Schema.Struct({
				sessionId: Schema.String,
				title: Schema.String,
				running: Schema.Boolean,
			}),
		),
	},
) {
	get message() {
		const name = this.other?.title || "Another session";
		switch (this.reason) {
			case "pruned":
				return "Files from this point were pruned.";
			case "not_available":
				return "Files from this point are not available.";
			case "other_session":
				return this.other?.running
					? `${name} is running in ${this.directory}.`
					: `${name} changed files in ${this.directory} since this point.`;
			case "folder_missing":
				return `${this.directory} is gone.`;
			case "changed":
				return `Files in ${this.directory} changed. Review it again.`;
			default:
				return "The files could not be restored.";
		}
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

/**
 * ad4c: how a switch's handoff reached its account. `resume` resumed the
 * account's own native thread and caught it up after `afterSequence`; `fresh`
 * started a new thread with the full kept history (`afterSequence` 0).
 * `throughSequence` is the last event the handoff covers; `inputId` the send.
 */
export const handoffDeliveryFields = {
	strategy: Schema.optionalKey(Schema.Literals(["resume", "fresh"])),
	afterSequence: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	),
	throughSequence: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	),
	inputId: Schema.optionalKey(Schema.String),
	/** Why a resume became a fresh handoff: the provider refused it, or the catch-up did not fit. */
	fallback: Schema.optionalKey(
		Schema.Literals(["resume_rejected", "catch_up_too_long"]),
	),
};

export const HandoffSummarySchema = Schema.Struct({
	continuationKind: Schema.optional(
		Schema.Literals(["native-thread", "transcript-digest"]),
	),
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
	...handoffDeliveryFields,
});
export type HandoffSummary = typeof HandoffSummarySchema.Type;

const usageWindowFields = {
	/** Stable identity and display label for providers with multiple allowances. */
	id: Schema.optional(Schema.String),
	label: Schema.optional(Schema.String),
	limitId: Schema.optional(Schema.String),
	modelId: Schema.optional(Schema.String),
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
		kind: Schema.Literals(["five_hour", "seven_day", "month", "custom"]),
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
	/** A read of this account is in progress. */
	checking: Schema.optional(Schema.Boolean),
	/** Epoch milliseconds of the next read after failed reads. */
	retryAt: Schema.optional(Schema.Number),
	reason: Schema.optional(Schema.String),
});
export type UsageReading = typeof UsageReadingSchema.Type;
