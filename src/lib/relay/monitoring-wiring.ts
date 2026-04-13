// ─── Monitoring Wiring (G2) ──────────────────────────────────────────────────
// Constructs PipelineDeps, EffectDeps, monitoring reducer state, SSE tracker,
// poller gating config, and wires the statusPoller "changed" handler.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Logger } from "../logger.js";
import type { PushNotificationManager } from "../server/push.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import type { RelayMessage } from "../shared-types.js";
import { type EffectDeps, executeEffects } from "./effect-executor.js";
import {
	applyPipelineResult,
	type PipelineDeps,
	processEvent,
} from "./event-pipeline.js";
import type { MessagePollerManager } from "./message-poller-manager.js";
import {
	assembleContext,
	evaluateAll,
	initialMonitoringState,
} from "./monitoring-reducer.js";
import type {
	MonitoringState,
	PollerGatingConfig,
	SessionEvalContext,
} from "./monitoring-types.js";
import { DEFAULT_POLLER_GATING_CONFIG } from "./monitoring-types.js";
import { resolveNotifications } from "./notification-policy.js";
import { createSessionSSETracker } from "./session-sse-tracker.js";
import type { SSEStream } from "./sse-stream.js";
import { sendPushForEvent } from "./sse-wiring.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface MonitoringWiringDeps {
	client: OpenCodeAPI;
	wsHandler: WebSocketHandler;
	sessionMgr: SessionManager;
	overrides: SessionOverrides;
	statusPoller: SessionStatusPoller;
	pollerManager: MessagePollerManager;
	registry: SessionRegistry;
	sseStream: SSEStream;
	config: {
		pollerGatingConfig?: Partial<PollerGatingConfig>;
		pushManager?: PushNotificationManager;
		slug: string;
	};
	statusLog: Logger;
	sseLog: Logger;
	pipelineLog: Logger;
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface MonitoringWiringResult {
	pipelineDeps: PipelineDeps;
	sseTracker: ReturnType<typeof createSessionSSETracker>;
	pollerGatingCfg: PollerGatingConfig;
	getMonitoringState: () => MonitoringState;
	setMonitoringState: (state: MonitoringState) => void;
	/**
	 * Record that a "done" event was delivered via SSE or message poller.
	 * Prevents the status-poller's processAndApplyDone from synthesizing
	 * a duplicate "done" for the same busy→idle cycle.
	 */
	recordDoneDelivered: (sessionId: string) => void;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wireMonitoring(
	deps: MonitoringWiringDeps,
): MonitoringWiringResult {
	const {
		client,
		wsHandler,
		sessionMgr,
		overrides,
		statusPoller,
		pollerManager,
		registry,
		sseStream,
		config,
		statusLog,
		sseLog,
		pipelineLog,
	} = deps;

	// ── Monitoring reducer state ──────────────────────────────────────────────
	const sseTracker = createSessionSSETracker();
	let monitoringState: MonitoringState = initialMonitoringState();
	const pollerGatingCfg: PollerGatingConfig = {
		...DEFAULT_POLLER_GATING_CONFIG,
		...config.pollerGatingConfig,
	};

	// ── Done dedup tracking ──────────────────────────────────────────────────
	// Tracks sessions that received a "done" via SSE or message poller in the
	// current busy cycle. processAndApplyDone consumes (check + delete) entries
	// to avoid synthesizing a duplicate "done" when SSE already delivered one.
	const doneDeliveredByPrimary = new Set<string>();

	// ── Shared pipeline deps (used by status poller + message poller) ──────
	const pipelineDeps: PipelineDeps = {
		overrides,
		wsHandler,
		log: pipelineLog,
	};

	// ── Effect executor deps (used by monitoring reducer effects) ─────────
	const effectDeps: EffectDeps = {
		startPoller: (sessionId) => {
			client.session
				.messages(sessionId)
				.then((msgs) => pollerManager.startPolling(sessionId, msgs))
				.catch((err) =>
					statusLog.warn(
						`Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
					),
				);
		},
		stopPoller: (sessionId) => pollerManager.stopPolling(sessionId),
		sendStatusToSession: (sessionId, msg) =>
			wsHandler.sendToSession(sessionId, msg),
		processAndApplyDone: (sessionId, isSubagent) => {
			// Dedup: if SSE or message poller already delivered a "done" for
			// this session in the current busy cycle, skip the synthetic
			// safety-net done. Consume the entry so the next cycle works.
			if (doneDeliveredByPrimary.has(sessionId)) {
				doneDeliveredByPrimary.delete(sessionId);
				statusLog.info(
					`Skipping synthetic done for ${sessionId.slice(0, 12)} — already delivered by primary path`,
				);
				return;
			}

			const doneMsg = { type: "done" as const, code: 0 };
			const doneViewers = wsHandler.getClientsForSession(sessionId);
			const doneResult = processEvent(
				doneMsg,
				sessionId,
				doneViewers,
				"status-poller",
			);
			applyPipelineResult(doneResult, sessionId, pipelineDeps);

			const notification = resolveNotifications(
				doneMsg,
				doneResult.route,
				isSubagent,
				sessionId,
			);
			if (notification.sendPush && config.pushManager) {
				sendPushForEvent(config.pushManager, doneMsg, sseLog, {
					slug: config.slug,
					sessionId,
				});
			}
			if (
				notification.broadcastCrossSession &&
				notification.crossSessionPayload
			) {
				wsHandler.broadcast(notification.crossSessionPayload as RelayMessage);
			}
		},
		clearProcessingTimeout: (sessionId) =>
			overrides.clearProcessingTimeout(sessionId),
		clearMessageActivity: (sessionId) =>
			statusPoller.clearMessageActivity(sessionId),
		log: statusLog,
	};

	// ── Session status poller wiring ────────────────────────────────────────

	statusPoller.on("changed", async (statuses, statusesChanged) => {
		// ── Session list broadcast (only when statuses actually changed) ────
		if (statusesChanged) {
			try {
				await sessionMgr.sendDualSessionLists(
					(msg) => wsHandler.broadcast(msg),
					{ statuses },
				);
			} catch (err) {
				statusLog.warn(
					`Failed to broadcast session list: ${err instanceof Error ? err.message : err}`,
				);
			}
		}

		// ── Monitoring reducer: evaluate all sessions ──────────────────────
		const parentMap = sessionMgr.getSessionParentMap();
		const now = Date.now();
		const contexts = new Map<string, SessionEvalContext>();
		for (const [sessionId, status] of Object.entries(statuses)) {
			if (status == null) continue;
			contexts.set(
				sessionId,
				assembleContext(
					sessionId,
					status,
					{ connected: sseStream.isConnected() },
					sseTracker,
					parentMap,
					(sid) => registry.hasViewers(sid),
					now,
				),
			);
		}

		const prevState = monitoringState;
		const result = evaluateAll(prevState, contexts, pollerGatingCfg);
		monitoringState = result.state;

		if (result.effects.length > 0) {
			executeEffects(result.effects, effectDeps);
		}

		// Log sessions that newly hit the safety cap
		for (const [sessionId, phase] of result.state.sessions) {
			if (
				phase.phase === "busy-capped" &&
				prevState.sessions.get(sessionId)?.phase !== "busy-capped"
			) {
				statusLog.warn(
					`Session ${sessionId.slice(0, 12)} capped — max ${DEFAULT_POLLER_GATING_CONFIG.maxPollers} concurrent pollers reached`,
				);
			}
		}
	});

	statusPoller.start();

	return {
		pipelineDeps,
		sseTracker,
		pollerGatingCfg,
		getMonitoringState: () => monitoringState,
		setMonitoringState: (state: MonitoringState) => {
			monitoringState = state;
		},
		recordDoneDelivered: (sessionId: string) => {
			doneDeliveredByPrimary.add(sessionId);
		},
	};
}
