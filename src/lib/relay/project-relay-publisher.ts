import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { publishAlert } from "../domain/relay/Services/alerts.js";
import type { Logger } from "../logger.js";
import type { PushNotificationSender } from "../server/push.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage, SessionActivityView } from "../shared-types.js";
import { resolveNotifications } from "./notification-policy.js";
import { sendPushForEventEffect } from "./sse-wiring.js";

export const publishProviderRelayMessage = (
	msg: Extract<RelayMessage, { type: "done" }>,
	deps: {
		wsHandler: Pick<WebSocketHandlerShape, "getClientsForSession">;
		pushManager?: Pick<PushNotificationSender, "sendToAll">;
		log: Logger;
		slug: string;
		/** 8.1: the session's activity, the one answer the done ding reads. */
		activityOf: (sessionId: string) => SessionActivityView;
	},
) =>
	Effect.gen(function* () {
		const sessionId = msg.sessionId;
		if (!sessionId) return;
		// The turn ended but its tasks still run: the session is not done until they finish.
		if (
			msg.error === undefined &&
			deps.activityOf(sessionId).background === "work"
		)
			return;
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{
			parent_id: string | null;
		}>`SELECT parent_id FROM sessions WHERE id = ${sessionId}`.pipe(
			Effect.orDie,
		);
		const notification = resolveNotifications(
			msg,
			deps.wsHandler.getClientsForSession(sessionId).length > 0
				? { action: "send", sessionId }
				: { action: "drop", reason: "no viewers" },
			rows[0]?.parent_id != null,
			sessionId,
		);
		if (notification.alert) yield* publishAlert(notification.alert);
		if (notification.sendPush && deps.pushManager)
			yield* sendPushForEventEffect(deps.pushManager, msg, deps.log, {
				slug: deps.slug,
				sessionId,
			});
	});
