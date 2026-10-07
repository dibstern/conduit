import type {
	HandoffSummary,
	LimitRecovery,
	QuotaCheckResult,
} from "../../contracts/limit-recovery.js";
import { formatSnoozeTime } from "./format.js";

/** A quota check as a QuotaMeter shows it; `undefined` is a check still running. */
export function quotaReading(quota: QuotaCheckResult | undefined): {
	used: number | "checking" | "unknown";
	caption?: string;
} {
	if (quota === undefined) return { used: "checking" };
	switch (quota._tag) {
		case "Available":
			return quota.utilization === undefined
				? { used: "unknown", caption: "available" }
				: { used: quota.utilization };
		case "Limited":
			return {
				used: 100,
				caption:
					quota.resetsAt === undefined
						? "limited"
						: `limited · ${formatSnoozeTime(quota.resetsAt * 1000)}`,
			};
		case "Unavailable":
			return { used: "unknown", caption: "unavailable" };
		case "Unknown":
			return { used: "unknown" };
	}
}

/** An account's quota from a finished check, unknown when the check left it out; undefined while it runs. */
export function accountQuota(
	quotas: ReadonlyMap<string, QuotaCheckResult> | undefined,
	instanceId: string,
): QuotaCheckResult | undefined {
	return quotas === undefined
		? undefined
		: (quotas.get(instanceId) ?? { _tag: "Unknown" });
}

/** The quota an open limit already proves, without waiting on a check. */
export function limitedQuota(limit: LimitRecovery): QuotaCheckResult {
	return { _tag: "Limited", rateLimitType: limit.rateLimitType };
}

/** A limited account can't take the session; one whose quota can't be read can. */
export function quotaBlocksSwitch(
	quota: QuotaCheckResult | undefined,
): boolean {
	return quota?._tag === "Limited";
}

/**
 * How much an account has left, for choosing the one to pre-select: a measured
 * share outranks an unmeasured "available", which outranks a check that could
 * not tell, which outranks an account the daemon says it cannot use.
 */
export function quotaHeadroom(quota: QuotaCheckResult | undefined): number {
	if (quota === undefined || quota._tag === "Unknown") return -1;
	if (quota._tag === "Available")
		return quota.utilization === undefined ? 0 : 100 - quota.utilization;
	return quota._tag === "Unavailable" ? -2 : -3;
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
