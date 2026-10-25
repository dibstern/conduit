// Single source of truth for notification title/body/tag per event type.
// Used by both server-side push (sse-wiring.ts) and browser Notification API
// (ws-notifications.ts) so the copy stays consistent.

import type { Approval, RelayMessage } from "./shared-types.js";

export interface NotificationContent {
	title: string;
	body: string;
	tag: string;
}

/** Push-only notification; this is not part of the browser WebSocket protocol. */
export interface GoalStuckNotification {
	readonly _tag: "goal_stuck";
	readonly sessionId: string;
	readonly originId: string;
	readonly reason: string;
}

/**
 * Derive notification content from a relay message or a pending approval.
 * Returns `null` for message types that don't warrant a notification.
 */
export function notificationContent(
	msg: RelayMessage | Approval | GoalStuckNotification,
): NotificationContent | null {
	if ("_tag" in msg && msg._tag === "goal_stuck") {
		const reason = msg.reason.trim();
		return {
			title: "Goal waiting on you",
			body: reason
				? reason.length > 140
					? `${reason.slice(0, 139)}…`
					: reason
				: "The goal keeps asking to continue. Reply to resume.",
			tag: "opencode-done",
		};
	}
	if ("_tag" in msg)
		return msg._tag === "permission"
			? {
					title: "Permission Needed",
					body: `${msg.toolName || "A tool"} needs approval`,
					tag: `perm-${msg.requestId}`,
				}
			: {
					title: "Question from Agent",
					body: "Agent has a question for you.",
					tag: "opencode-ask",
				};
	switch (msg.type) {
		case "done":
			return msg.error === undefined
				? {
						title: "Response complete",
						body: "Agent finished its response.",
						tag: "opencode-done",
					}
				: {
						title: "Error",
						body: msg.error || "An error occurred",
						tag: "opencode-error",
					};
		default:
			return null;
	}
}
