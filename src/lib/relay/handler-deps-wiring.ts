// ─── Handler Deps Wiring (G1) ────────────────────────────────────────────────
// Constructs HandlerDeps, ClientInitDeps, ClientMessageQueue, RateLimiter,
// and wires wsHandler client_connected / client_disconnected / message events.
//
// Extracted from createProjectRelay() — all closure captures are explicit params.

import {
	type ClientInitDeps,
	handleClientConnected,
} from "../bridges/client-init.js";
import type { PermissionBridge } from "../bridges/permission-bridge.js";
import { QuestionBridge } from "../bridges/question-bridge.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { dispatchMessage, type HandlerDeps } from "../handlers/index.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Logger } from "../logger.js";
import { type LogLevel, setLogLevel } from "../logger.js";
import type { ProviderStateService } from "../persistence/provider-state-service.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { OrchestrationLayer } from "../provider/orchestration-wiring.js";
import type { RelayEventSinkPersist } from "../provider/relay-event-sink.js";
import { ClientMessageQueue } from "../server/client-message-queue.js";
import { RateLimiter } from "../server/rate-limiter.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import type { ProjectRelayConfig } from "../types.js";
import type { MessagePollerManager } from "./message-poller-manager.js";
import type { PtyManager } from "./pty-manager.js";
import type { PtyUpstreamDeps } from "./pty-upstream.js";
import { connectPtyUpstream as connectPtyUpstreamImpl } from "./pty-upstream.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface HandlerDepsWiringDeps {
	wsHandler: WebSocketHandler;
	client: OpenCodeAPI;
	sessionMgr: SessionManager;
	permissionBridge: PermissionBridge;
	overrides: SessionOverrides;
	ptyManager: PtyManager;
	config: ProjectRelayConfig;
	log: Logger;
	wsLog: Logger;
	statusPoller: SessionStatusPoller;
	registry: SessionRegistry;
	pollerManager: MessagePollerManager;
	ptyDeps: PtyUpstreamDeps;
	/** SQLite read query service (optional — only when persistence is configured). */
	readQuery?: ReadQueryService;
	/** Phase 5: Orchestration layer for provider adapter routing (optional). */
	orchestrationLayer?: OrchestrationLayer;
	/** Claude event persistence deps (optional — only when persistence configured). */
	claudeEventPersist?: RelayEventSinkPersist;
	/** Provider state service for resume cursor persistence (optional). */
	providerStateService?: ProviderStateService;
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface HandlerDepsWiringResult {
	handlerDeps: HandlerDeps;
	clientQueue: ClientMessageQueue;
	rateLimiter: RateLimiter;
}

// ─── Wiring function ─────────────────────────────────────────────────────────

export function wireHandlerDeps(
	deps: HandlerDepsWiringDeps,
): HandlerDepsWiringResult {
	const {
		wsHandler,
		client,
		sessionMgr,
		permissionBridge,
		overrides,
		ptyManager,
		config,
		log,
		wsLog,
		statusPoller,
		registry,
		pollerManager,
		ptyDeps,
		readQuery,
		orchestrationLayer,
		claudeEventPersist,
		providerStateService,
	} = deps;

	// Per-client sliding-window rate limiter for chat messages
	const rateLimiter = new RateLimiter();

	// Question bridge for tracking pending questions (enables replay on session switch)
	const questionBridge = new QuestionBridge();

	const clientInitDeps: ClientInitDeps = {
		wsHandler,
		client,
		sessionMgr,
		overrides,
		ptyManager,
		permissionBridge,
		statusPoller,
		...(config.getInstances != null && { getInstances: config.getInstances }),
		...(config.getCachedUpdate != null && {
			getCachedUpdate: config.getCachedUpdate,
		}),
		...(orchestrationLayer != null && {
			orchestrationEngine: orchestrationLayer.engine,
		}),
		...(readQuery != null && { readQuery }),
		log: wsLog,
	};

	wsHandler.on("client_connected", ({ clientId, requestedSessionId }) => {
		wsLog.info(
			`Client connected: ${clientId}${requestedSessionId ? ` (requested session: ${requestedSessionId})` : ""}`,
		);
		handleClientConnected(clientInitDeps, clientId, requestedSessionId).catch(
			(err) =>
				wsLog.error(
					`Client init failed for ${clientId}: ${formatErrorDetail(err)}`,
				),
		);
	});

	wsHandler.on("client_disconnected", ({ clientId, sessionId: _sessionId }) => {
		// Clean up per-client message queue on disconnect
		clientQueue.removeClient(clientId);
		wsLog.info(`Client disconnected: ${clientId}`);
	});

	const handlerDeps: HandlerDeps = {
		wsHandler,
		client,
		sessionMgr,
		permissionBridge,
		questionBridge,
		overrides,
		ptyManager,
		config,
		log,
		connectPtyUpstream: (ptyId: string, cursor?: number) =>
			connectPtyUpstreamImpl(ptyDeps, ptyId, cursor),
		statusPoller,
		registry,
		pollerManager,
		forkMeta: {
			setForkEntry: (sid, entry) => sessionMgr.setForkEntry(sid, entry),
			getForkEntry: (sid) => sessionMgr.getForkEntry(sid),
		},
		...(config.getInstances != null &&
			config.addInstance != null &&
			config.removeInstance != null &&
			config.startInstance != null &&
			config.stopInstance != null &&
			config.updateInstance != null &&
			config.persistConfig != null && {
				instanceMgmt: {
					getInstances: config.getInstances,
					addInstance: config.addInstance,
					removeInstance: config.removeInstance,
					startInstance: config.startInstance,
					stopInstance: config.stopInstance,
					updateInstance: config.updateInstance,
					persistConfig: config.persistConfig,
				},
			}),
		...(config.getProjects != null &&
			config.setProjectInstance != null && {
				projectMgmt: {
					getProjects: config.getProjects,
					setProjectInstance: config.setProjectInstance,
				},
			}),
		...(config.triggerScan != null && {
			scanDeps: { triggerScan: config.triggerScan },
		}),
		...(readQuery != null && { readQuery }),
		...(orchestrationLayer != null && {
			orchestrationEngine: orchestrationLayer.engine,
		}),
		...(claudeEventPersist != null && { claudeEventPersist }),
		...(providerStateService != null && { providerStateService }),
	};

	const clientQueue = new ClientMessageQueue({
		onError: (cid, err) => {
			wsLog.error(`Error handling message for ${cid}:`, formatErrorDetail(err));
			wsHandler.sendTo(
				cid,
				RelayError.fromCaught(err, "HANDLER_ERROR").toSystemError(),
			);
		},
	});

	wsHandler.on("message", ({ clientId, handler, payload }) => {
		// Rate-limit check stays outside the queue (it's synchronous)
		if (handler === "message") {
			const result = rateLimiter.check(clientId);
			if (!result.allowed) {
				wsHandler.sendTo(clientId, {
					type: "system_error",
					code: "RATE_LIMITED",
					message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
				});
				return;
			}
		}

		// Handle log level changes directly (no queue needed, synchronous)
		if (handler === "set_log_level") {
			const level = payload["level"];
			const validLevels = new Set([
				"debug",
				"verbose",
				"info",
				"warn",
				"error",
			]);
			if (typeof level === "string" && validLevels.has(level)) {
				setLogLevel(level as LogLevel);
				wsLog.info(`Log level changed to ${level} by client ${clientId}`);
			}
			return;
		}

		clientQueue.enqueue(clientId, async () => {
			await dispatchMessage(handlerDeps, clientId, handler, payload);
		});
	});

	return { handlerDeps, clientQueue, rateLimiter };
}
