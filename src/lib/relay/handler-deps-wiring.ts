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
import { formatErrorDetail, RelayError } from "../errors.js";
import { dispatchMessage, type HandlerDeps } from "../handlers/index.js";
import type { OpenCodeClient } from "../instance/opencode-client.js";
import type { Logger } from "../logger.js";
import { type LogLevel, setLogLevel } from "../logger.js";
import type { ReadAdapter } from "../persistence/read-adapter.js";
import { ClientMessageQueue } from "../server/client-message-queue.js";
import { RateLimiter } from "../server/rate-limiter.js";
import type { WebSocketHandler } from "../server/ws-handler.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { SessionStatusPoller } from "../session/session-status-poller.js";
import type { ProjectRelayConfig } from "../types.js";
import type { MessageCache } from "./message-cache.js";
import type { MessagePollerManager } from "./message-poller-manager.js";
import type { PendingUserMessages } from "./pending-user-messages.js";
import type { PtyManager } from "./pty-manager.js";
import type { PtyUpstreamDeps } from "./pty-upstream.js";
import { connectPtyUpstream as connectPtyUpstreamImpl } from "./pty-upstream.js";
import type { ToolContentStore } from "./tool-content-store.js";

// ─── Deps interface ──────────────────────────────────────────────────────────

export interface HandlerDepsWiringDeps {
	wsHandler: WebSocketHandler;
	client: OpenCodeClient;
	sessionMgr: SessionManager;
	messageCache: MessageCache;
	pendingUserMessages: PendingUserMessages;
	permissionBridge: PermissionBridge;
	overrides: SessionOverrides;
	ptyManager: PtyManager;
	toolContentStore: ToolContentStore;
	config: ProjectRelayConfig;
	log: Logger;
	wsLog: Logger;
	statusPoller: SessionStatusPoller;
	registry: SessionRegistry;
	pollerManager: MessagePollerManager;
	ptyDeps: PtyUpstreamDeps;
	/** Phase 4: Read adapter for SQLite read switchover (optional). */
	readAdapter?: ReadAdapter;
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
		messageCache,
		pendingUserMessages,
		permissionBridge,
		overrides,
		ptyManager,
		toolContentStore,
		config,
		log,
		wsLog,
		statusPoller,
		registry,
		pollerManager,
		ptyDeps,
		readAdapter,
	} = deps;

	// Per-client sliding-window rate limiter for chat messages
	const rateLimiter = new RateLimiter();

	const clientInitDeps: ClientInitDeps = {
		wsHandler,
		client,
		sessionMgr,
		messageCache,
		overrides,
		ptyManager,
		permissionBridge,
		statusPoller,
		...(config.getInstances != null && { getInstances: config.getInstances }),
		...(config.getCachedUpdate != null && {
			getCachedUpdate: config.getCachedUpdate,
		}),
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
		messageCache,
		pendingUserMessages,
		permissionBridge,
		overrides,
		ptyManager,
		toolContentStore,
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
		...(readAdapter != null && { readAdapter }),
	};

	const clientQueue = new ClientMessageQueue({
		onError: (cid, err) => {
			wsLog.error(`Error handling message for ${cid}:`, formatErrorDetail(err));
			wsHandler.sendTo(
				cid,
				RelayError.fromCaught(err, "HANDLER_ERROR").toMessage(),
			);
		},
	});

	wsHandler.on("message", ({ clientId, handler, payload }) => {
		// Rate-limit check stays outside the queue (it's synchronous)
		if (handler === "message") {
			const result = rateLimiter.check(clientId);
			if (!result.allowed) {
				wsHandler.sendTo(clientId, {
					type: "error",
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
