import {
	isSessionSnoozed,
	sessionAttention,
} from "../stores/session.svelte.js";
import type { SessionInfo } from "../types.js";

export const LONG_PRESS_DELAY_MS = 500;
export const MOVEMENT_SLOP_PX = 10;

export type SwipeStage = "none" | "reveal" | "commit";

export function getSwipeStage(dx: number, width: number): SwipeStage {
	if (width <= 0 || Math.abs(dx) / width < 0.25) return "none";
	return Math.abs(dx) / width < 0.55 ? "reveal" : "commit";
}

/** The menu and both row affordances must agree about disabled actions. */
export function getSessionActionState(session: SessionInfo, now: number) {
	const pinned = session.pinnedAt != null;
	const settled = session.settledAt != null;
	const snoozed = isSessionSnoozed(session, now);
	const attention = sessionAttention(session);
	return {
		pinned,
		settled,
		snoozed,
		settleDisabledReason: pinned ? "Unpin to settle" : null,
		snoozeVisible: !settled,
		snoozeDisabledReason: pinned
			? "Unpin to snooze"
			: attention === "needs-approval" || attention === "needs-reply"
				? "Waiting on you"
				: null,
	};
}
