// ─── Poller Wiring (G3) ──────────────────────────────────────────────────────
// Wires pollerManager "events" handler and sseStream "event" → poller bridge.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { SessionStatusPollerService } from "../domain/relay/Services/session-status-poller.js";
import type { Logger } from "../logger.js";
import type { PushNotificationManager } from "../server/push.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage } from "../shared-types.js";
import {
	applyPipelineResult,
	type PipelineDeps,
	processEvent,
} from "./event-pipeline.js";
import { resolveNotifications } from "./notification-policy.js";
import type { SSEEvent } from "./opencode-events.js";
import { classifyPollerBatch } from "./poller-pre-filter.js";
import type { createSessionSSETracker } from "./session-sse-tracker.js";
import type { SSEStreamEvents } from "./sse-stream.js";
import { extractSessionId, sendPushForEvent } from "./sse-wiring.js";

/** Structural interface for the message poller manager's capabilities needed by poller wiring. */
interface PollerManagerLike {
	on(
		event: "events",
		callback: (messages: RelayMessage[], sessionId: string) => void,
	): void;
	notifySSEEvent(sessionId: string): void;
}

// ─── Deps interface ──────────────────────────────────────────────────────────

/** Narrowed Effect session service capabilities needed by poller wiring. */
interface SessionServiceLike {
	getSessionParentMap(): Map<string, string>;
}

export interface PollerWiringDeps {
	pollerManager: PollerManagerLike;
	sseStream: SSEStreamEvents;
	statusPoller: SessionStatusPollerService;
	wsHandler: WebSocketHandlerShape;
	sessionService: SessionServiceLike;
	pipelineDeps: PipelineDeps;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	config: {
		pushManager?: PushNotificationManager;
		slug: string;
	};
	pollerLog: Logger;
	/** Optional: record that a "done" was delivered via poller (for dedup with status-poller) */
	onDoneProcessed?: (sessionId: string) => void;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wirePollers(deps: PollerWiringDeps): void {
	const {
		pollerManager,
		sseStream,
		statusPoller,
		wsHandler,
		sessionService,
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

			// Record done delivery for dedup with status-poller synthetic done
			if (msg.type === "done" && polledSessionId) {
				deps.onDoneProcessed?.(polledSessionId);
			}

			// Notification routing: push + cross-session broadcast
			const isSubagentPoller =
				polledSessionId != null &&
				sessionService.getSessionParentMap().has(polledSessionId);
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
	sseStream.on("event", (event: unknown) => {
		const sid = extractSessionId(event as SSEEvent);
		if (sid) {
			sseTracker.recordEvent(sid, Date.now());
			pollerManager.notifySSEEvent(sid);
		}
	});
}
