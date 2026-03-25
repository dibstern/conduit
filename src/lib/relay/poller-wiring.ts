// ─── Poller Wiring (G3) ──────────────────────────────────────────────────────
// Wires pollerManager "events" handler and sseConsumer "event" → poller bridge.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { Logger } from "../logger.js";
import type { PushNotificationManager } from "../server/push.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import type { RelayMessage } from "../shared-types.js";
import type { OpenCodeEvent } from "../types.js";
import {
	applyPipelineResult,
	type PipelineDeps,
	processEvent,
} from "./event-pipeline.js";
import type { MessagePollerManager } from "./message-poller-manager.js";
import { resolveNotifications } from "./notification-policy.js";
import type { PendingUserMessages } from "./pending-user-messages.js";
import { classifyPollerBatch } from "./poller-pre-filter.js";
import type { createSessionSSETracker } from "./session-sse-tracker.js";
import type { SSEConsumer } from "./sse-consumer.js";
import { extractSessionId, sendPushForEvent } from "./sse-wiring.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface PollerWiringDeps {
	pollerManager: MessagePollerManager;
	sseConsumer: SSEConsumer;
	statusPoller: SessionStatusPoller;
	pendingUserMessages: PendingUserMessages;
	wsHandler: WebSocketHandler;
	sessionMgr: SessionManager;
	pipelineDeps: PipelineDeps;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	config: {
		pushManager?: PushNotificationManager;
		slug: string;
	};
	pollerLog: Logger;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wirePollers(deps: PollerWiringDeps): void {
	const {
		pollerManager,
		sseConsumer,
		statusPoller,
		pendingUserMessages,
		wsHandler,
		sessionMgr,
		pipelineDeps,
		sseTracker,
		config,
		pollerLog,
	} = deps;

	// ── Message poller manager wiring (REST fallback → cache + per-session routing) ──

	pollerManager.on("events", (events, polledSessionId) => {
		// If message poller found new content, signal that the session is
		// actively processing. This covers CLI sessions where /session/status
		// doesn't report busy but message content is changing.
		//
		// Only mark activity for content events (delta, tool_*, thinking_*,
		// user_message), NOT for completion signals (result, done). The
		// `result` event means an assistant turn finished (has cost/tokens) —
		// refreshing activity on it would keep the session artificially busy
		// after processing is done. Similarly, `done` is a termination signal
		// from emitDone() — marking activity on it would create a circular
		// dependency where emitDone → markActivity → busy → emitDone…
		if (events.length > 0 && polledSessionId) {
			if (classifyPollerBatch(events).hasContentActivity) {
				statusPoller.markMessageActivity(polledSessionId);
			}
		}

		for (const msg of events) {
			// Suppress relay-originated user messages from poller (same as SSE path)
			if (
				msg.type === "user_message" &&
				polledSessionId &&
				pendingUserMessages.consume(polledSessionId, msg.text)
			) {
				pollerLog.debug(
					`Suppressed relay-originated user_message echo for session=${polledSessionId}`,
				);
				continue;
			}
			const pollerViewers = polledSessionId
				? wsHandler.getClientsForSession(polledSessionId)
				: [];
			const pollerResult = processEvent(
				msg,
				polledSessionId,
				pollerViewers,
				"message-poller",
			);
			applyPipelineResult(pollerResult, polledSessionId, pipelineDeps);

			// Notification routing: push + cross-session broadcast
			const isSubagentPoller =
				polledSessionId != null &&
				sessionMgr.getSessionParentMap().has(polledSessionId);
			const pollerNotification = resolveNotifications(
				msg,
				pollerResult.route,
				isSubagentPoller,
				polledSessionId ?? undefined,
			);
			if (pollerNotification.sendPush && config.pushManager) {
				sendPushForEvent(config.pushManager, msg, pollerLog, {
					slug: config.slug,
					sessionId: polledSessionId ?? undefined,
				});
			}
			if (
				pollerNotification.broadcastCrossSession &&
				pollerNotification.crossSessionPayload
			) {
				wsHandler.broadcast(
					pollerNotification.crossSessionPayload as RelayMessage,
				);
			}
		}
	});

	// ── Notify poller manager of SSE events (to suppress REST polling) ────
	sseConsumer.on("event", (event: OpenCodeEvent) => {
		const sid = extractSessionId(event);
		if (sid) {
			sseTracker.recordEvent(sid, Date.now());
			pollerManager.notifySSEEvent(sid);
		}
	});
}
