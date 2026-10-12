import type {
	UsageLimitsSetting,
	UsageReading,
} from "../../contracts/limit-recovery.js";
import { DEFAULT_USAGE_LIMITS } from "../../contracts/limit-recovery.js";
import type { Immutable, SessionInfo } from "../types.js";
import {
	type PlanUsageWindow,
	planUsageWindows,
	usageDisplay,
} from "../utils/continuation.js";
import { discoveryState, getEffectiveInstanceId } from "./discovery.svelte.js";
import { getInstanceById, instanceState } from "./instance.svelte.js";

export const usageState = $state<{
	readings: readonly UsageReading[];
	limits: UsageLimitsSetting;
}>({ readings: [], limits: DEFAULT_USAGE_LIMITS });

export function applyUsageReadings(readings: readonly UsageReading[]): void {
	usageState.readings = readings;
}

export function applyUsageLimitsSetting(setting: UsageLimitsSetting): void {
	usageState.limits = setting;
}

/** A resumed session uses its latest account; a draft uses its effective instance. */
export function composerAccountId(
	session: Immutable<SessionInfo> | undefined,
): string | undefined {
	return session
		? (session.resumes?.at(-1)?.instanceId ??
				discoveryState.sessionInstanceIds[session.id])
		: getEffectiveInstanceId();
}

/** Include eligible Claude accounts even before their first usage reading. */
export function orderedSettingsUsageAccounts(): UsageReading[] {
	const order = usageState.limits.order;
	const rank = (id: string) => {
		const index = order.indexOf(id);
		return index === -1 ? order.length : index;
	};
	return instanceState.instances
		.filter(
			(instance) => instance.driver === "claude" && instance.usageEligible,
		)
		.sort((a, b) => rank(a.id) - rank(b.id))
		.map(
			(instance) =>
				usageState.readings.find(
					(reading) => reading.accountId === instance.id,
				) ?? {
					accountId: instance.id,
					harness: "claude",
					status: "unknown",
					windows: [],
					readAt: 0,
					stale: false,
				},
		);
}

/** The Usage rail dot and headline share the same ordered warning. */
export function usageAlert(
	accounts: readonly UsageReading[],
	warnAt: UsageLimitsSetting["warnAt"],
):
	| { level: "limited"; account: UsageReading }
	| { level: "runs_out"; account: UsageReading; window: PlanUsageWindow }
	| null {
	const limited = accounts.find(
		(account) => usageDisplay(account, warnAt).level === "limited",
	);
	if (limited) return { level: "limited", account: limited };
	for (const kind of ["seven_day", "five_hour"] as const) {
		for (const account of accounts) {
			const window = planUsageWindows(account).find(
				(window) =>
					window.kind === kind && window.forecast?.kind === "runs_out",
			);
			if (window) return { level: "runs_out", account, window };
		}
	}
	return null;
}

/** The footer and Usage settings show the same accounts in switch order. */
export function orderedUsageAccounts(): UsageReading[] {
	const order = usageState.limits.order;
	const rank = (id: string) => {
		const index = order.indexOf(id);
		return index === -1 ? order.length : index;
	};
	return usageState.readings
		.filter((reading) => {
			const instance = getInstanceById(reading.accountId);
			if (!instance) return false;
			return reading.harness !== "claude" || instance.usageEligible === true;
		})
		.sort(
			(a, b) =>
				rank(a.accountId) - rank(b.accountId) ||
				instanceState.instances.findIndex(
					(instance) => instance.id === a.accountId,
				) -
					instanceState.instances.findIndex(
						(instance) => instance.id === b.accountId,
					),
		);
}
