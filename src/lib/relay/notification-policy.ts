// ─── Notification Policy ─────────────────────────────────────────────────────
// Pure policy: given a relay message, its route decision, and whether the
// session is a subagent, decide what notifications to fire.
//
// Rules:
// - Only "done" and "error" events are notification-worthy.
// - Subagent "done" events are completely suppressed (parent emits its own).
// - Subagent "error" events still fire notifications (errors are always important).
// - Push fires for all notification-worthy events (unless suppressed).
// - Cross-session broadcast fires only when route dropped (no viewers on session).

import type { RelayMessage } from "../shared-types.js";
import type { RouteDecision } from "./event-pipeline.js";

export interface NotificationResolution {
	readonly sendPush: boolean;
	readonly broadcastCrossSession: boolean;
	readonly crossSessionPayload?: {
		readonly type: "notification_event";
		readonly eventType: string;
		readonly message?: string;
		readonly sessionId?: string;
		readonly alertId: string;
	};
}

/**
 * Pure policy: given a relay message, its route decision, and whether the
 * session is a subagent, decide what notifications to fire.
 */
export function resolveNotifications(
	msg: RelayMessage,
	route: RouteDecision,
	isSubagent: boolean,
	sessionId?: string,
): NotificationResolution {
	// Anonymous status observations update the UI; only identified originating
	// events can safely own a durable alert receipt.
	if ((msg.type !== "done" && msg.type !== "error") || !msg.alertId) {
		return { sendPush: false, broadcastCrossSession: false };
	}

	// Subagent "done" is suppressed — parent session emits its own done
	if (isSubagent && msg.type === "done") {
		return { sendPush: false, broadcastCrossSession: false };
	}

	const sendPush = true;
	const broadcastCrossSession = route.action === "drop";

	if (broadcastCrossSession) {
		const errorMessage =
			msg.type === "error" ? (msg as { message: string }).message : undefined;
		const payload: NotificationResolution["crossSessionPayload"] = {
			type: "notification_event",
			eventType: msg.type,
			alertId: msg.alertId,
			...(errorMessage !== undefined ? { message: errorMessage } : {}),
			...(sessionId != null ? { sessionId } : {}),
		};
		return { sendPush, broadcastCrossSession, crossSessionPayload: payload };
	}

	return { sendPush, broadcastCrossSession };
}
