// ─── Poller Wiring (G3) ──────────────────────────────────────────────────────
// Wires pollerManager "events" handler and sseStream "event" → poller bridge.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import { Cause, Effect, Runtime } from "effect";
import { StatusPollerTag } from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { OverridesStateTag } from "../domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../logger.js";
import type { PushNotificationManager } from "../server/push.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { RelayMessage } from "../shared-types.js";
import {
	applyPipelineResult,
	applyPipelineResultEffect,
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

interface LegacyStatusPollerPort {
	markMessageActivity(sessionId: string): void;
}

export interface PollerWiringDeps {
	pollerManager: PollerManagerLike;
	sseStream: SSEStreamEvents;
	statusPoller: LegacyStatusPollerPort;
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

export type EffectPollerWiringDeps = Omit<
	PollerWiringDeps,
	"sessionService" | "pipelineDeps" | "statusPoller"
> & {
	pipelineDeps: Omit<PipelineDeps, "processingTimeouts">;
};

const handlePollerEventsEffect = (
	deps: EffectPollerWiringDeps,
	events: RelayMessage[],
	polledSessionId: string,
) =>
	Effect.gen(function* () {
		const statusPoller = yield* StatusPollerTag;
		const sessionService = yield* SessionManagerServiceTag;
		const { wsHandler, pipelineDeps, config, pollerLog } = deps;

		if (events.length > 0 && polledSessionId) {
			if (classifyPollerBatch(events).hasContentActivity) {
				yield* statusPoller.markMessageActivity(polledSessionId);
			}
		}

		const parentMap = yield* sessionService.getSessionParentMap();
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
			yield* applyPipelineResultEffect(
				pollerResult,
				polledSessionId,
				pipelineDeps,
			);

			// Record done delivery for dedup with status-poller synthetic done
			if (msg.type === "done" && polledSessionId) {
				yield* Effect.sync(() => deps.onDoneProcessed?.(polledSessionId));
			}

			// Notification routing: push + cross-session broadcast
			const isSubagentPoller =
				polledSessionId != null && parentMap.has(polledSessionId);
			const pollerNotification = resolveNotifications(
				msg,
				pollerResult.route,
				isSubagentPoller,
				polledSessionId ?? undefined,
			);
			const pushManager = config.pushManager;
			if (pollerNotification.sendPush && pushManager) {
				yield* Effect.sync(() =>
					sendPushForEvent(pushManager, msg, pollerLog, {
						slug: config.slug,
						sessionId: polledSessionId ?? undefined,
					}),
				);
			}
			if (
				pollerNotification.broadcastCrossSession &&
				pollerNotification.crossSessionPayload
			) {
				yield* Effect.sync(() =>
					wsHandler.broadcast(
						pollerNotification.crossSessionPayload as RelayMessage,
					),
				);
			}
		}
	});

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

export const wirePollersEffect = (deps: EffectPollerWiringDeps) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<
			SessionManagerServiceTag | StatusPollerTag | OverridesStateTag
		>();
		yield* Effect.sync(() => {
			const runFork = Runtime.runFork(runtime);
			deps.pollerManager.on("events", (events, polledSessionId) => {
				runFork(
					handlePollerEventsEffect(deps, events, polledSessionId).pipe(
						Effect.catchAllCause((cause) =>
							Effect.sync(() =>
								deps.pollerLog.warn(
									`Message poller event handling failed: ${Cause.pretty(cause)}`,
								),
							),
						),
					),
				);
			});

			deps.sseStream.on("event", (event: unknown) => {
				const sid = extractSessionId(event as SSEEvent);
				if (sid) {
					deps.sseTracker.recordEvent(sid, Date.now());
					deps.pollerManager.notifySSEEvent(sid);
				}
			});
		});
	});
