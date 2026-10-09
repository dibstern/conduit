import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { publishAlert } from "../domain/relay/Services/alerts.js";
import type { Logger } from "../logger.js";
import type { PushNotificationSender } from "../server/push.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage } from "../shared-types.js";
import { resolveNotifications } from "./notification-policy.js";
import { sendPushForEventEffect } from "./sse-wiring.js";

export const publishProviderRelayMessage = (
	msg: RelayMessage,
	deps: {
		wsHandler: Pick<WebSocketHandlerShape, "getClientsForSession">;
		pushManager?: Pick<PushNotificationSender, "sendToAll">;
		log: Logger;
		slug: string;
	},
) =>
	Effect.gen(function* () {
		const sessionId = "sessionId" in msg ? msg.sessionId : undefined;
		if (msg.type !== "done" || !sessionId) return;
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
