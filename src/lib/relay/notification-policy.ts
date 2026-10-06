// Pure policy: given a relay message, its route decision, and whether the
// session is a subagent, decide what notifications to fire.
//
// Rules:
// - Only "done" and "error" events are notification-worthy.
// - Subagent "done" events are completely suppressed (parent emits its own).
// - Subagent "error" events still fire notifications (errors are always important).
// - Push fires for all notification-worthy events (unless suppressed).
// - The in-app alert (SubscribeAlerts) fires only when route dropped (no
//   viewers on session).

import type { Alert } from "../contracts/ws-rpc.js";
import type { RelayMessage } from "../shared-types.js";
import type { RouteDecision } from "./event-pipeline.js";

export interface NotificationResolution {
	readonly sendPush: boolean;
	readonly broadcastCrossSession: boolean;
	/** Published to the project's SubscribeAlerts feed. */
	readonly alert?: Alert;
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
	/** In-app identity when no durable completion origin is available. */
	syntheticAlertId?: string,
): NotificationResolution {
	if (msg.type !== "done" && msg.type !== "error") {
		return { sendPush: false, broadcastCrossSession: false };
	}
	const alertId =
		msg.alertId ?? (msg.type === "done" ? syntheticAlertId : undefined);
	if (!alertId) return { sendPush: false, broadcastCrossSession: false };

	// Subagent "done" is suppressed — parent session emits its own done
	if (isSubagent && msg.type === "done") {
		return { sendPush: false, broadcastCrossSession: false };
	}

	// Only an originating ID can claim a durable push receipt. Anonymous poller
	// transitions retain their in-app notification without claiming a push.
	const sendPush = msg.alertId !== undefined;
	const broadcastCrossSession = route.action === "drop";

	if (broadcastCrossSession) {
		const errorMessage =
			msg.type === "error" ? (msg as { message: string }).message : undefined;
		const alert: Alert = {
			_tag: "alert",
			kind: msg.type,
			alertId,
			...(errorMessage !== undefined ? { message: errorMessage } : {}),
			...(sessionId != null ? { sessionId } : {}),
		};
		return { sendPush, broadcastCrossSession, alert };
	}

	return { sendPush, broadcastCrossSession };
}
