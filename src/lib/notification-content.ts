// ─── Notification Content ────────────────────────────────────────────────────
// Single source of truth for notification title/body/tag per event type.
// Used by both server-side push (sse-wiring.ts) and browser Notification API
// (ws-notifications.ts) so the copy stays consistent.

import type { RelayMessage } from "./shared-types.js";

export interface NotificationContent {
	title: string;
	body: string;
	tag: string;
}

/**
 * Derive notification content from a relay message.
 * Returns `null` for message types that don't warrant a notification.
 */
export function notificationContent(
	msg: RelayMessage,
): NotificationContent | null {
	switch (msg.type) {
		case "done":
			return {
				title: "Task Complete",
				body: "Agent has finished processing.",
				tag: "opencode-done",
			};
		case "error":
			return {
				title: "Error",
				body: msg.message || "An error occurred",
				tag: "opencode-error",
			};
		case "permission_request":
			return {
				title: "Permission Needed",
				body: `${msg.toolName ?? "A tool"} needs approval`,
				tag: `perm-${msg.requestId ?? "unknown"}`,
			};
		case "ask_user":
			return {
				title: "Question from Agent",
				body: "Agent has a question for you.",
				tag: "opencode-ask",
			};
		default:
			return null;
	}
}
