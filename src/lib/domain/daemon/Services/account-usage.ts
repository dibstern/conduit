import type { Deferred } from "effect";
import type {
	UsageReading,
	UsageWindow,
} from "../../../contracts/limit-recovery.js";
import type { UsageHarness } from "../../../contracts/provider-instance.js";
import type { UsageRead } from "../../../provider/usage-reader.js";
import { type ForecastSeries, withForecasts } from "./usage-forecast.js";

/** One account's usage. Its published reading and saved history are projections of it. */
export type AccountUsage = {
	readonly reading?: UsageReading;
	readonly lastAttemptAt?: number;
	readonly inFlight?:
		| {
				readonly result: Deferred.Deferred<UsageReading>;
				/** A live update landed during the read, so the read can't replace it. */
				readonly overtaken: boolean;
		  }
		| undefined;
	/** When the account is next read, if someone is viewing or a plan window is full then. */
	readonly wakeAt?: number | undefined;
	/** Failed reads in a row; they space out the next read. */
	readonly failures?: number | undefined;
	readonly five_hour?: ForecastSeries | undefined;
	readonly seven_day?: ForecastSeries | undefined;
};

export type SavedUsage = {
	readonly five_hour?: ForecastSeries | undefined;
	readonly seven_day?: ForecastSeries | undefined;
	readonly reading?: UsageReading | undefined;
};

export const emptyAccountUsage: AccountUsage = {};

/** Whose reading this is and when it was taken. */
type ReadingOrigin = {
	readonly accountId: string;
	readonly harness: UsageHarness;
	readonly readAt: number;
};

const succeeded = (reading: UsageRead) =>
	reading.status === "available" || reading.status === "limited";

type Decision =
	| { readonly kind: "reuse"; readonly reading: UsageReading }
	| { readonly kind: "join"; readonly result: Deferred.Deferred<UsageReading> }
	| {
			readonly kind: "start";
			readonly result: Deferred.Deferred<UsageReading>;
			readonly record: AccountUsage;
	  };

/** Reuse a reading attempted within maxAge, join the read in progress, or start one. */
export const decide = (
	record: AccountUsage,
	now: number,
	maxAge: number,
	result: Deferred.Deferred<UsageReading>,
): Decision => {
	if (record.inFlight) return { kind: "join", result: record.inFlight.result };
	if (
		record.reading &&
		record.lastAttemptAt !== undefined &&
		now - record.lastAttemptAt < maxAge
	)
		return { kind: "reuse", reading: record.reading };
	return {
		kind: "start",
		result,
		record: {
			...record,
			lastAttemptAt: now,
			inFlight: { result, overtaken: false },
		},
	};
};

// A failed attempt returns unknown to its caller. The record keeps the last
// reading, marked stale.
const keptReading = (record: AccountUsage, reading: UsageReading) =>
	reading.status === "unknown" && record.reading
		? { ...record.reading, stale: true }
		: reading;

// A wake still to come, or Infinity. One already past was carried out or skipped.
const comingWake = ({ wakeAt }: AccountUsage, now: number) =>
	wakeAt !== undefined && wakeAt > now ? wakeAt : Infinity;

// The next read after one that began at startedAt settled at readAt. Failed
// reads in a row wait 30s, doubling to 2m, then 5m like any other read. A wake
// set for after the read began still stands: the read can't answer for it.
const nextRead = (
	record: AccountUsage,
	{ status }: UsageRead,
	{
		readAt,
		startedAt,
	}: { readonly readAt: number; readonly startedAt: number },
) => {
	const { failures: before = 0 } = record;
	const failures = status === "unknown" ? before + 1 : 0;
	return {
		failures,
		wakeAt: Math.min(
			readAt +
				(failures > 0 && failures < 4 ? 15_000 * 2 ** failures : 300_000),
			comingWake(record, startedAt),
		),
	};
};

/**
 * Apply a finished read: the reading its callers get and the record it leaves,
 * with the account's next read scheduled from when this one settled, or
 * sooner if a wake was set since it began.
 * A read whose account was retired or read again since it started leaves the
 * record as it is.
 */
export const settle = (
	record: AccountUsage,
	result: Deferred.Deferred<UsageReading>,
	read: UsageRead,
	{
		accountId,
		harness,
		readAt,
		startedAt,
	}: ReadingOrigin & { readonly startedAt: number },
): { readonly reading: UsageReading; readonly record: AccountUsage } => {
	const { windows, series } =
		harness === "codex" || !succeeded(read)
			? { windows: read.windows, series: {} }
			: withForecasts(record, read.windows, readAt);
	const reading: UsageReading =
		record.inFlight?.overtaken && record.reading
			? record.reading
			: { ...read, windows, accountId, harness, readAt, stale: false };
	if (record.inFlight?.result !== result) return { reading, record };
	// During a read only a live reading with every window moves lastAttemptAt
	// off the read's start, and then it answers for the account. Otherwise the
	// read's own outcome sets the backoff, even under a partial live reading.
	const outcome = record.lastAttemptAt === startedAt ? read : reading;
	return {
		reading,
		record: {
			...record,
			...series,
			inFlight: undefined,
			reading: keptReading(record, reading),
			...nextRead(record, outcome, { readAt, startedAt }),
		},
	};
};

// Model windows are told apart by their model.
const windowKey = (window: UsageWindow) =>
	window.kind === "seven_day_model"
		? `${window.kind}:${window.model}`
		: window.kind;

/** Windows that were full before this reading and are free before that reset. */
export const freedBeforeReset = (
	previous: UsageReading | undefined,
	reading: UsageReading,
) =>
	succeeded(reading)
		? reading.windows.flatMap((window) => {
				const prior = previous?.windows.find(
					(candidate) => windowKey(candidate) === windowKey(window),
				);
				return window.utilization < 100 &&
					prior?.resetsAt &&
					prior.utilization >= 100 &&
					Date.parse(prior.resetsAt) > reading.readAt
					? [
							{
								window: window.kind,
								...(window.kind === "seven_day_model"
									? { model: window.model }
									: {}),
								resetsAt: prior.resetsAt,
							},
						]
					: [];
			})
		: [];

const sameWindow = (update: UsageWindow, window: UsageWindow) =>
	update.id ? window.id === update.id : window.kind === update.kind;

const mergeWindows = (
	updates: readonly UsageWindow[],
	windows: readonly UsageWindow[] = [],
) => {
	const merged = [...windows];
	for (const window of updates) {
		const index = merged.findIndex((value) => sameWindow(window, value));
		const prior = merged[index];
		if (!prior) merged.push(window);
		else
			merged[index] = {
				...prior,
				...window,
				...(window.kind === "custom" && !window.label
					? { kind: prior.kind }
					: {}),
			};
	}
	return merged;
};

/**
 * Merge a reading pushed by a running turn. One that carries every window the
 * merged reading shows counts as a successful read taken now; one with only
 * some leaves the rest to be read.
 */
export const live = (
	record: AccountUsage,
	read: UsageRead,
	{ accountId, harness, readAt }: ReadingOrigin,
): AccountUsage => {
	const windows = mergeWindows(read.windows, record.reading?.windows);
	const reading: UsageReading = {
		...record.reading,
		...read,
		accountId,
		harness,
		windows,
		readAt,
		stale: false,
		status: windows.some((window) => window.utilization >= 100)
			? "limited"
			: windows.length
				? "available"
				: read.status,
	};
	const merged = {
		...record,
		reading,
		inFlight: record.inFlight && { ...record.inFlight, overtaken: true },
	};
	const complete =
		read.windows.length > 0 &&
		windows.every((window) =>
			read.windows.some((update) => sameWindow(update, window)),
		);
	return complete
		? {
				...merged,
				lastAttemptAt: readAt,
				...nextRead(record, reading, { readAt, startedAt: readAt }),
			}
		: merged;
};

/** A finished turn's usage is read again in ten seconds, unless a wake to come is sooner. */
export const afterTurn = (record: AccountUsage, now: number): AccountUsage => ({
	...record,
	wakeAt: Math.min(now + 10_000, comingWake(record, now)),
});

/** An account whose wake has come, or was never set, is read while someone is viewing or a plan window is full. */
export const shouldWake = (
	record: AccountUsage,
	now: number,
	viewers: number,
) => {
	if (comingWake(record, now) < Infinity) return false;
	const full =
		record.reading?.windows.some(
			(window) =>
				(window.kind === "five_hour" || window.kind === "seven_day") &&
				window.utilization >= 100,
		) === true;
	return full || viewers > 0;
};

/**
 * The Usage Reading published for an account: marked checking while a read is
 * in progress, and with the next read's time after failed reads.
 */
export const publishedReading = ({
	reading,
	inFlight,
	failures,
	wakeAt,
}: AccountUsage): UsageReading | undefined =>
	reading && {
		...reading,
		...(inFlight ? { checking: true } : {}),
		...(failures && wakeAt !== undefined ? { retryAt: wakeAt } : {}),
	};

/** What a caller whose wait ran out gets: the published reading, or unknown before the first one. */
export const waitedOut = (
	record: AccountUsage,
	{ accountId, harness, readAt }: ReadingOrigin,
): UsageReading => {
	const reading = publishedReading(record);
	if (reading) return reading;
	return {
		accountId,
		harness,
		status: "unknown",
		windows: [],
		readAt,
		stale: false,
		checking: true,
	};
};

/** A record whose account is no longer configured keeps only its saved history. */
export const retired = ({
	reading,
	lastAttemptAt,
	inFlight,
	wakeAt,
	failures,
	...kept
}: AccountUsage): AccountUsage => kept;

export const savedHistory = (
	accounts: ReadonlyMap<string, AccountUsage>,
): Readonly<Record<string, SavedUsage>> =>
	Object.fromEntries(
		[...accounts].map(([accountId, record]) => [
			accountId,
			{
				...(record.five_hour ? { five_hour: record.five_hour } : {}),
				...(record.seven_day ? { seven_day: record.seven_day } : {}),
				...(record.reading && succeeded(record.reading)
					? { reading: { ...record.reading, stale: false } }
					: {}),
			},
		]),
	);

// Restored readings keep their read time and stay stale until a read lands.
export const restored = ({ reading, ...series }: SavedUsage): AccountUsage => ({
	...series,
	...(reading ? { reading: { ...reading, stale: true } } : {}),
});
