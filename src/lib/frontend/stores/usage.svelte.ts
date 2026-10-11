import type {
	UsageLimitsSetting,
	UsageReading,
} from "../../contracts/limit-recovery.js";
import { DEFAULT_USAGE_LIMITS } from "../../contracts/limit-recovery.js";
import type { Immutable, SessionInfo } from "../types.js";
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
			return (
				reading.harness !== "claude" ||
				(!instance.env?.["ANTHROPIC_API_KEY"] &&
					!instance.env?.["ANTHROPIC_AUTH_TOKEN"])
			);
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
