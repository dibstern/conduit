// ─── Status Transition Detection ─────────────────────────────────────────────
// Pure functions that compute session status transitions (idle↔busy).
// Extracted from relay-stack.ts for testability.

import type { SessionStatus } from "../instance/opencode-client.js";

export interface StatusTransitions {
	/** Sessions that just became busy (need "processing" status sent). */
	becameBusy: string[];
	/** Sessions that just became idle (need "done" sent through pipeline). */
	becameIdle: string[];
	/** Updated set of busy sessions (replaces previousBusy). */
	currentBusy: Set<string>;
}

export function computeStatusTransitions(
	previousBusy: ReadonlySet<string>,
	statuses: Record<string, SessionStatus | undefined>,
): StatusTransitions {
	const currentBusy = new Set<string>();
	for (const [sessionId, status] of Object.entries(statuses)) {
		if (status?.type === "busy" || status?.type === "retry") {
			currentBusy.add(sessionId);
		}
	}

	const becameBusy: string[] = [];
	for (const sessionId of currentBusy) {
		if (!previousBusy.has(sessionId)) {
			becameBusy.push(sessionId);
		}
	}

	const becameIdle: string[] = [];
	for (const sessionId of previousBusy) {
		if (!currentBusy.has(sessionId)) {
			becameIdle.push(sessionId);
		}
	}

	return { becameBusy, becameIdle, currentBusy };
}

export interface PollerDecision {
	toStop: string[];
	toClearActivity: string[];
	toStart: string[];
}

export function computePollerDecisions(
	statuses: Record<string, SessionStatus | undefined>,
	pollingSessionIds: string[],
	hasViewers: (sessionId: string) => boolean,
	isPolling: (sessionId: string) => boolean,
): PollerDecision {
	const toStop: string[] = [];
	const toClearActivity: string[] = [];
	const toStart: string[] = [];

	for (const polledId of pollingSessionIds) {
		const status = statuses[polledId];
		const isBusy = status?.type === "busy" || status?.type === "retry";
		if (!isBusy) {
			if (hasViewers(polledId)) {
				toClearActivity.push(polledId);
			} else {
				toStop.push(polledId);
			}
		}
	}

	for (const [sessionId, status] of Object.entries(statuses)) {
		const isBusy = status?.type === "busy" || status?.type === "retry";
		if (isBusy && !isPolling(sessionId)) {
			toStart.push(sessionId);
		}
	}

	return { toStop, toClearActivity, toStart };
}
