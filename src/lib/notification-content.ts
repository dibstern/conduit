// Single source of truth for notification title/body/tag per event type.
// Used by both server-side push (sse-wiring.ts) and browser Notification API
// (ws-notifications.ts) so the copy stays consistent.

import type { Approval, RelayMessage } from "./shared-types.js";

export interface NotificationContent {
	title: string;
	body: string;
	tag: string;
}

/**
 * Derive notification content from a relay message or a pending approval.
 * Returns `null` for message types that don't warrant a notification.
 */
export function notificationContent(
	msg: RelayMessage | Approval,
): NotificationContent | null {
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
			return {
				title: "Response complete",
				body: "Agent finished its response.",
				tag: "opencode-done",
			};
		case "error":
			return {
				title: "Error",
				body: msg.message || "An error occurred",
				tag: "opencode-error",
			};
		default:
			return null;
	}
}
