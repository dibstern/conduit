import type {
	UsageLimitsSetting,
	UsageReading,
} from "../../contracts/limit-recovery.js";

export const usageState = $state<{
	readings: readonly UsageReading[];
	order: readonly string[];
}>({ readings: [], order: [] });

export function applyUsageReadings(readings: readonly UsageReading[]): void {
	usageState.readings = readings;
}

export function applyUsageLimitsSetting(setting: UsageLimitsSetting): void {
	usageState.order = setting.order;
}
