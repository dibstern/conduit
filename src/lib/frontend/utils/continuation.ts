import type {
	HandoffSummary,
	LimitRecovery,
	UsageReading,
	UsageWindow,
} from "../../contracts/limit-recovery.js";
import { formatSnoozeTime } from "./format.js";

export const DEFAULT_USAGE_WARN_AT = 80;

/** One display rule for the plan windows; other kinds do not bind yet. */
export function usageDisplay(
	reading: UsageReading | undefined,
	warnAt: number | "off" = DEFAULT_USAGE_WARN_AT,
): {
	level: "ok" | "warn" | "limited" | "unknown";
	binding?: UsageWindow;
	colour: string;
	label: string;
} {
	if (
		!reading ||
		reading.status === "unknown" ||
		reading.status === "unavailable"
	)
		return { level: "unknown", colour: "bg-border-chip", label: "—" };
	const fiveHour = reading.windows.find(
		(window) => window.kind === "five_hour",
	);
	const sevenDay = reading.windows.find(
		(window) => window.kind === "seven_day",
	);
	const threshold = warnAt === "off" ? Number.POSITIVE_INFINITY : warnAt;
	const binding =
		fiveHour &&
		sevenDay &&
		fiveHour.utilization >= threshold &&
		sevenDay.utilization >= threshold
			? sevenDay
			: fiveHour && (!sevenDay || fiveHour.utilization >= sevenDay.utilization)
				? fiveHour
				: sevenDay;
	const used = binding?.utilization;
	const limited =
		reading.status === "limited" || (used !== undefined && used >= 100);
	return {
		level: limited
			? "limited"
			: used !== undefined && used >= threshold
				? "warn"
				: "ok",
		...(binding ? { binding } : {}),
		colour: limited
			? "bg-fill-red"
			: used !== undefined &&
					used >= (warnAt === "off" ? DEFAULT_USAGE_WARN_AT : warnAt)
				? "bg-fill-amber"
				: "bg-text-secondary",
		label: limited
			? binding?.resetsAt === undefined
				? "limited"
				: formatSnoozeTime(Date.parse(binding.resetsAt))
			: used === undefined
				? "—"
				: `${Math.round(used)}%`,
	};
}

/** Keep the existing meter's captions and highest-window headroom display. */
export function quotaReading(reading: UsageReading | undefined): {
	used: number | "checking" | "unknown";
	caption?: string;
} {
	const display = usageDisplay(reading, "off");
	if (reading === undefined) return { used: "checking" };
	if (display.level === "limited")
		return {
			used: 100,
			caption:
				display.binding?.resetsAt === undefined
					? "limited"
					: `limited · ${display.label}`,
		};
	if (reading.status === "available")
		return display.binding === undefined
			? { used: "unknown", caption: "available" }
			: { used: display.binding.utilization };
	return reading.status === "unavailable"
		? { used: "unknown", caption: "unavailable" }
		: { used: "unknown" };
}

/** Missing readings are unknown after refresh and undefined while it runs. */
export function accountQuota(
	readings: ReadonlyMap<string, UsageReading> | undefined,
	accountId: string,
): UsageReading | undefined {
	return readings === undefined
		? undefined
		: (readings.get(accountId) ?? {
				accountId,
				harness: "claude",
				status: "unknown",
				windows: [],
				readAt: 0,
				stale: false,
			});
}

/** The session's open limit already proves this account is limited. */
export function limitedQuota(limit: LimitRecovery): UsageReading {
	return {
		accountId: limit.instanceId,
		harness: "claude",
		status: "limited",
		readAt: 0,
		stale: false,
		windows:
			limit.rateLimitType === "five_hour" || limit.rateLimitType === "seven_day"
				? [{ kind: limit.rateLimitType, utilization: 100 }]
				: [],
	};
}

/** A limited account cannot take the session; an unreadable account can. */
export function quotaBlocksSwitch(reading: UsageReading | undefined): boolean {
	return reading?.status === "limited";
}

/** Measured headroom outranks unmeasured available, unknown, then unavailable. */
export function quotaHeadroom(reading: UsageReading | undefined): number {
	if (reading === undefined || reading.status === "unknown") return -1;
	if (reading.status === "available") {
		const { binding } = usageDisplay(reading, "off");
		return binding === undefined ? 0 : 100 - binding.utilization;
	}
	return reading.status === "unavailable" ? -2 : -3;
}

/**
 * The first "carries over" row: how many messages go across word for word, from
 * the same budget the handoff itself uses. `compact` is the phone wording.
 */
export function handoffMessagesLine(
	summary: HandoffSummary,
	compact: boolean,
): string {
	const recent = summary.included - (summary.firstMessageIncluded ? 1 : 0);
	const line =
		summary.included === 0
			? "No earlier messages"
			: summary.omitted === 0
				? summary.included === 1
					? "Your first message"
					: `All ${summary.included} messages`
				: recent === 0
					? "Your first message"
					: `${recent === 1 ? "Last message" : `Last ${recent} messages`}${summary.firstMessageIncluded ? " and your first one" : ""}`;
	return compact || summary.included === 0 ? line : `${line}, word for word`;
}

/** The limit window a rate limit type names, lower case: "weekly limit", "5-hour limit" or "usage limit". */
export function limitWindowName(rateLimitType: string | undefined): string {
	if (rateLimitType?.startsWith("seven_day")) return "weekly limit";
	return rateLimitType === "five_hour" ? "5-hour limit" : "usage limit";
}
