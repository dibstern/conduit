import type {
	HandoffSummary,
	LimitRecovery,
	UsageReading,
	UsageWindow,
} from "../../contracts/limit-recovery.js";
import { formatSnoozeTime } from "./format.js";

export const DEFAULT_USAGE_WARN_AT = 80;

export type PlanUsageWindow = UsageWindow & {
	kind: "five_hour" | "seven_day";
};

export function planUsageWindows(reading: UsageReading): PlanUsageWindow[] {
	if (reading.status === "unknown" || reading.status === "unavailable")
		return [];
	return reading.windows.filter(
		(window): window is PlanUsageWindow =>
			window.kind === "five_hour" || window.kind === "seven_day",
	);
}

/** Preserve the Usage rows' clock and weekly reset labels. */
export function usageResetTime(
	at: string | number | undefined,
	weekday = false,
): string {
	if (at === undefined) return "";
	const date = new Date(at);
	if (!Number.isFinite(date.getTime())) return "";
	const time = date.toLocaleTimeString("en-GB", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
	return weekday
		? `${date.toLocaleDateString("en-GB", { weekday: "short" })} ${time.replace(":00", "")}`
		: time;
}

export function usageForecastTime(
	at: string | number | undefined,
	now: number,
): string {
	return usageResetTime(
		at,
		at !== undefined &&
			new Date(at).toDateString() !== new Date(now).toDateString(),
	);
}

export function usageForecastDuration(milliseconds: number): string {
	const minutes = Math.max(0, Math.round(milliseconds / 60_000));
	if (minutes >= 1440) {
		const days = Math.floor(minutes / 1440);
		return `${days} ${days === 1 ? "day" : "days"}`;
	}
	return minutes >= 60
		? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
		: `${minutes}m`;
}

export function usageForecastLevel(
	reading: UsageReading,
): "neutral" | "amber" | "red" {
	if (usageDisplay(reading, "off").level === "limited") return "red";
	return planUsageWindows(reading).some(
		(window) => window.forecast?.kind === "runs_out",
	)
		? "amber"
		: "neutral";
}

export function usageWindowLimited(
	reading: UsageReading,
	window: PlanUsageWindow,
): boolean {
	return (
		window.utilization >= 100 ||
		(reading.status === "limited" &&
			!planUsageWindows(reading).some((item) => item.utilization >= 100) &&
			usageDisplay(reading, "off").binding?.kind === window.kind)
	);
}

/** Legacy readings without forecast metadata keep their bars-only layout. */
export function usageForecastWindow(
	reading: UsageReading,
): PlanUsageWindow | undefined {
	const windows = planUsageWindows(reading);
	if (
		!windows.some(
			(window) =>
				window.forecast !== undefined ||
				(window.history !== undefined && usageWindowLimited(reading, window)),
		)
	)
		return undefined;
	const runsOut = windows
		.filter((window) => window.forecast?.kind === "runs_out")
		.sort((a, b) =>
			a.forecast?.kind === "runs_out" && b.forecast?.kind === "runs_out"
				? a.forecast.at - b.forecast.at
				: 0,
		)[0];
	return (
		runsOut ??
		windows.find((window) => usageWindowLimited(reading, window)) ??
		windows.find((window) => window.kind === "five_hour" && window.forecast) ??
		windows.find((window) => window.forecast)
	);
}

/** Text fragments keep the emphasized value escaped by the Svelte template. */
export function usageForecastCopy(
	reading: UsageReading,
	window: PlanUsageWindow,
	now: number,
): { before: string; highlight: string; after: string } | undefined {
	const weekly = window.kind === "seven_day";
	const reset = usageForecastTime(window.resetsAt, now);
	if (usageWindowLimited(reading, window))
		return {
			before: `Limit reached.${reset ? ` The ${weekly ? "weekly" : "5h"} window resets at ` : ""}`,
			highlight: reset,
			after: reset ? "." : "",
		};
	if (window.forecast?.kind === "under")
		return {
			before: `On pace to finish this ${weekly ? "week" : "5h window"} at `,
			highlight: `~${Math.round(window.forecast.atReset)}%`,
			after: `${reset ? ` (resets ${reset})` : ""}.`,
		};
	if (window.forecast?.kind === "runs_out")
		return {
			before: `At this pace the ${weekly ? "weekly" : "5h"} limit runs out ≈ `,
			highlight: usageForecastTime(window.forecast.at, now),
			after: `${reset ? `, ${usageForecastDuration(Date.parse(window.resetsAt ?? "") - window.forecast.at)} before it resets` : ""}.`,
		};
	return undefined;
}

export function usageOtherForecast(
	window: PlanUsageWindow | undefined,
	now: number,
): string | undefined {
	if (!window?.forecast) return undefined;
	const label = window.kind === "seven_day" ? "Week" : "5h window";
	const reset = usageForecastTime(window.resetsAt, now);
	return window.forecast.kind === "under"
		? `${label}: on pace for ~${Math.round(window.forecast.atReset)}%${reset ? ` by ${reset}` : ""}.`
		: `${label}: runs out ≈ ${usageForecastTime(window.forecast.at, now)}${reset ? `, ${usageForecastDuration(Date.parse(window.resetsAt ?? "") - window.forecast.at)} before it resets` : ""}.`;
}

export function usagePaceLine(
	reading: UsageReading,
	now: number,
): string | undefined {
	const windows = planUsageWindows(reading);
	const fiveHour = windows.find((window) => window.kind === "five_hour");
	const week = windows.find((window) => window.kind === "seven_day");
	const parts = [fiveHour, week].flatMap((window) => {
		if (!window?.forecast) return [];
		const label = window.kind === "five_hour" ? "5h" : "week";
		if (window.forecast.kind === "runs_out")
			return [
				`${label} runs out ≈ ${usageForecastTime(window.forecast.at, now)}`,
			];
		const day = usageResetTime(window.resetsAt, true).split(" ")[0];
		return [
			`${label}${window.kind === "five_hour" ? " on pace for" : ""} ~${Math.round(window.forecast.atReset)}%${window.kind === "seven_day" && day ? ` by ${day}` : ""}`,
		];
	});
	if (parts.length === 0) return undefined;
	if (!fiveHour || (fiveHour.utilization === 0 && !fiveHour.resetsAt))
		parts.unshift("No 5h window open");
	return parts.join(" · ");
}

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
	const month = reading.windows.find((window) => window.kind === "month");
	const threshold = warnAt === "off" ? Number.POSITIVE_INFINITY : warnAt;
	const binding =
		reading.harness === "codex"
			? reading.windows.reduce<UsageWindow | undefined>(
					(best, window) =>
						!best || window.utilization > best.utilization ? window : best,
					undefined,
				)
			: fiveHour &&
					sevenDay &&
					fiveHour.utilization >= threshold &&
					sevenDay.utilization >= threshold
				? sevenDay
				: fiveHour &&
						(!sevenDay || fiveHour.utilization >= sevenDay.utilization)
					? fiveHour
					: (sevenDay ?? month);
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

/** Weekly warnings take priority; a reached plan limit takes over entirely. */
export function usageWarning(
	reading: UsageReading | undefined,
	warnAt: number | "off",
	accountName: string,
	showAccount: boolean,
	now: number,
): { window: PlanUsageWindow; title: string; detail?: string } | undefined {
	if (
		!reading ||
		// driver-dispatch-ok: narrows the usage reading's harness, not a driver.
		reading.harness !== "claude" ||
		reading.status !== "available" ||
		warnAt === "off"
	)
		return undefined;
	const windows = planUsageWindows(reading);
	if (windows.some((window) => window.utilization >= 100)) return undefined;
	const window =
		windows.find(
			(window) => window.kind === "seven_day" && window.utilization >= warnAt,
		) ??
		windows.find(
			(window) => window.kind === "five_hour" && window.utilization >= warnAt,
		);
	if (!window) return undefined;
	const reset =
		window.kind === "seven_day"
			? usageResetTime(window.resetsAt, true)
			: window.resetsAt !== undefined &&
					Number.isFinite(Date.parse(window.resetsAt))
				? `in ${usageForecastDuration(Date.parse(window.resetsAt) - now)}`
				: "";
	return {
		window,
		title: `${showAccount ? `${accountName}: ` : ""}${window.kind === "seven_day" ? "Weekly" : "5h"} limit ${Math.round(window.utilization)}% used.`,
		...(reset ? { detail: `Resets ${reset}.` } : {}),
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
