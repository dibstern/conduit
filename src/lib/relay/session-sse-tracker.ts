import type { SSECoverage } from "./monitoring-types.js";

export interface SessionSSETracker {
	recordEvent(sessionId: string, now: number): void;
	getLastEventAt(sessionId: string): number | undefined;
	remove(sessionId: string): void;
}

export function createSessionSSETracker(): SessionSSETracker {
	const timestamps = new Map<string, number>();
	return {
		recordEvent(sessionId, now) {
			timestamps.set(sessionId, now);
		},
		getLastEventAt(sessionId) {
			return timestamps.get(sessionId);
		},
		remove(sessionId) {
			timestamps.delete(sessionId);
		},
	};
}

export function deriveSSECoverage(
	globalConnected: boolean,
	lastSessionEventAt: number | undefined,
	now: number,
	activeThresholdMs: number,
): SSECoverage {
	if (!globalConnected) return { kind: "disconnected" };
	if (lastSessionEventAt === undefined) return { kind: "never-seen" };
	if (now - lastSessionEventAt < activeThresholdMs)
		return { kind: "active", lastEventAt: lastSessionEventAt };
	return { kind: "stale", lastEventAt: lastSessionEventAt };
}
