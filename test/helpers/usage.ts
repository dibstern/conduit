import type { UsageReading } from "../../src/lib/contracts/limit-recovery.js";

export function usageReading(
	accountId: string,
	reading: Partial<UsageReading> = {},
): UsageReading {
	return {
		accountId,
		harness: "claude",
		status: "unknown",
		windows: [],
		readAt: 0,
		stale: false,
		...reading,
	};
}
