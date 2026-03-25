// ─── Relay Stack ─────────────────────────────────────────────────────────────
// The complete relay wiring: OpenCode client, SSE consumer, event translator,
// WebSocket handler, session manager, permission/question bridges.
//
// Extracted from skeleton.ts so integration tests exercise the exact same
// wiring as production. skeleton.ts is now a thin CLI wrapper around this.

import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../bridges/client-init.js";
import { PermissionBridge } from "../bridges/permission-bridge.js";
import { ServiceRegistry } from "../daemon/service-registry.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { dispatchMessage, type HandlerDeps } from "../handlers/index.js";
import { OpenCodeClient } from "../instance/opencode-client.js";
import {
	createLogger,
	type Logger,
	type LogLevel,
	setLogLevel,
} from "../logger.js";
import { ClientMessageQueue } from "../server/client-message-queue.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationManager } from "../server/push.js";
import { RateLimiter } from "../server/rate-limiter.js";
import { RelayServer } from "../server/server.js";
import { WebSocketHandler } from "../server/ws-handler.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionOverrides } from "../session/session-overrides.js";
import { SessionRegistry } from "../session/session-registry.js";
import { SessionStatusPoller } from "../session/session-status-poller.js";
import type { PermissionId } from "../shared-types.js";
import type { OpenCodeEvent, ProjectRelayConfig } from "../types.js";
import { generateSlug } from "../utils.js";
import { type EffectDeps, executeEffects } from "./effect-executor.js";
import {
	applyPipelineResult,
	isNotificationWorthy,
	type PipelineDeps,
	processEvent,
} from "./event-pipeline.js";
import {
	createTranslator,
	rebuildTranslatorFromHistory,
} from "./event-translator.js";
import { MessageCache } from "./message-cache.js";
import { MessagePollerManager } from "./message-poller-manager.js";
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
import { PendingUserMessages } from "./pending-user-messages.js";
import { classifyPollerBatch } from "./poller-pre-filter.js";
import { PtyManager } from "./pty-manager.js";
import {
	connectPtyUpstream as connectPtyUpstreamImpl,
	type PtyUpstreamDeps,
} from "./pty-upstream.js";
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";
import { RelayTimers } from "./relay-timers.js";
import { createSessionSSETracker } from "./session-sse-tracker.js";
import { SSEConsumer } from "./sse-consumer.js";
import {
	extractSessionId,
	sendPushForEvent,
	wireSSEConsumer,
} from "./sse-wiring.js";
import { ToolContentStore } from "./tool-content-store.js";

// ─── WebSocket library for upstream PTY connections ─────────────────────────
const requireWs = createRequire(import.meta.url);
const wsLib = requireWs("ws");
const WebSocketClass = wsLib.WebSocket as typeof import("ws").WebSocket;

/** Per-project relay: all relay components attached to a shared server. */
export interface ProjectRelay {
	wsHandler: WebSocketHandler;
	sseConsumer: SSEConsumer;
	client: OpenCodeClient;
	sessionMgr: SessionManager;
	translator: ReturnType<typeof createTranslator>;
	permissionBridge: PermissionBridge;
	messageCache: MessageCache;
	/** True when at least one session in this project is busy or retrying. */
	isAnySessionProcessing(): boolean;
	/** Gracefully stop relay components (SSE + WebSocket). Does NOT stop the HTTP server. */
	stop(): Promise<void>;
}

// ─── Full Stack Config ──────────────────────────────────────────────────────

export interface RelayStackConfig {
	port: number;
	host?: string;
	opencodeUrl: string;
	pin?: string;
	projectDir: string;
	slug: string;
	staticDir?: string;
	/** TLS certificate and key for HTTPS mode */
	tls?: { key: Buffer; cert: Buffer; caRoot?: string };
	/** Session title for the initial session */
	sessionTitle?: string;
	/** Logger instance — defaults to a console-backed root logger */
	log?: Logger;
	/** Optional pre-initialized push notification manager */
	pushManager?: PushNotificationManager;
	/** Config directory for cache storage (default: projectDir/.conduit) */
	configDir?: string;
	/**
	 * Override the default poller gating config (SSE grace period, staleness
	 * threshold, max concurrent pollers). Forwarded to createProjectRelay.
	 */
	pollerGatingConfig?: import("./monitoring-types.js").PollerGatingConfig;
	/** Override the session-status polling interval in milliseconds (default: 500). */
	statusPollerInterval?: number;
	/** Override the message polling interval in milliseconds (default: 750). */
	messagePollerInterval?: number;
}

// ─── Stack ───────────────────────────────────────────────────────────────────

export interface RelayStack {
	server: RelayServer;
	wsHandler: WebSocketHandler;
	sseConsumer: SSEConsumer;
	client: OpenCodeClient;
	sessionMgr: SessionManager;
	translator: ReturnType<typeof createTranslator>;
	permissionBridge: PermissionBridge;
	/** Exposed for test access (clear cache to force REST fallback). */
	messageCache: MessageCache;

	/** The port the HTTP server is actually listening on (useful when port=0) */
	getPort(): number;
	/** The base URL of the relay server */
	getBaseUrl(): string;
	/** Stop all components */
	stop(): Promise<void>;
}

// ─── Create Per-Project Relay ────────────────────────────────────────────────

/**
 * Create a per-project relay that attaches to an existing HTTP server.
 *
 * Sets up all relay components (OpenCode client, SSE consumer, translator,
 * session manager, bridges, WebSocket handler) and wires the full event
 * pipeline. Does NOT create or manage an HTTP server — the caller owns it.
 *
 * Used by both `createRelayStack()` (for standalone/skeleton mode) and the
 * daemon (which has its own HTTP server).
 */
export async function createProjectRelay(
	config: ProjectRelayConfig,
): Promise<ProjectRelay> {
	const log = config.log ?? createLogger("relay");
	const wsLog = log.child("ws");
	const sessionLog = log.child("session");
	const sseLog = log.child("sse");
	const statusLog = log.child("status-poller");
	const pollerLog = log.child("msg-poller");
	const pollerMgrLog = log.child("poller-mgr");
	const ptyLog = log.child("pty");
	const pipelineLog = log.child("pipeline");

	// ── Service registry (optional — used by daemon for coordinated drain) ──
	// Stored locally so Tasks 8-15 can pass it to service constructors as
	// they are migrated to TrackedService.
	const serviceRegistry = config.registry ?? new ServiceRegistry();

	// ── Components ──────────────────────────────────────────────────────────

	const client = new OpenCodeClient({
		baseUrl: config.opencodeUrl,
		...(config.noServer &&
			config.projectDir != null && {
				directory: config.projectDir,
			}),
	});
	const translator = createTranslator();
	const permissionBridge = new PermissionBridge();
	const sessionMgr: SessionManager = new SessionManager({
		client,
		log: sessionLog,
		directory: config.projectDir,
		// Lazy getter — statusPoller is created below but the getter is only
		// called at runtime when listSessions() runs, so ordering is fine.
		getStatuses: (): Record<
			string,
			import("../instance/opencode-client.js").SessionStatus
		> => statusPoller.getCurrentStatuses(),
		...(config.configDir != null && { configDir: config.configDir }),
	});

	// ── Per-session event cache ──
	const cacheDir = config.configDir
		? join(config.configDir, "cache", config.slug, "sessions")
		: join(config.projectDir ?? process.cwd(), ".conduit", "sessions");
	const messageCache = new MessageCache(cacheDir);
	messageCache.loadFromDisk();

	const toolContentStore = new ToolContentStore();

	// Per-client sliding-window rate limiter for chat messages
	const rateLimiter = new RateLimiter();

	// Per-session overrides (agent, model, processing timeout)
	const overrides = new SessionOverrides(serviceRegistry);

	// Load persisted default model and variant from relay settings
	const relaySettings = loadRelaySettings(config.configDir);
	const defaultModel = parseDefaultModel(relaySettings.defaultModel);
	if (defaultModel) {
		overrides.setDefaultModel(defaultModel);
		log.info(`✓ Default model from settings: ${relaySettings.defaultModel}`);

		// Load persisted variant for the default model
		const modelKey = relaySettings.defaultModel;
		const defaultVariant = modelKey
			? (relaySettings.defaultVariants?.[modelKey] ?? "")
			: "";
		if (defaultVariant) {
			overrides.defaultVariant = defaultVariant;
			log.info(`✓ Default variant from settings: ${defaultVariant}`);
		}
	}

	// ── Session status poller (polls GET /session/status for processing indicators) ──
	const statusPoller: SessionStatusPoller = new SessionStatusPoller(
		serviceRegistry,
		{
			client,
			interval: config.statusPollerInterval ?? 500,
			log: statusLog,
			getSessionParentMap: (): Map<string, string> =>
				sessionMgr.getSessionParentMap(),
		},
	);

	// ── Shared session registry (single source of truth for client→session tracking) ──
	const registry = new SessionRegistry();

	// ── Message poller manager (REST fallback for CLI sessions without SSE events) ──
	// Manages multiple pollers concurrently — one per busy session.
	const pollerManager = new MessagePollerManager(serviceRegistry, {
		client,
		log: pollerMgrLog,
		hasViewers: (sid) => registry.hasViewers(sid),
		...(config.messagePollerInterval != null && {
			interval: config.messagePollerInterval,
		}),
	});

	// ── PTY sessions with server-side scrollback (claude-relay architecture) ──
	// Each active PTY gets one upstream WebSocket to OpenCode's /pty/:id/connect.
	// Output is buffered server-side (50 KB FIFO per terminal) and broadcast to
	// ALL browser clients. New clients get scrollback replayed on connect.
	// Input from any browser client is forwarded to the shared upstream WS.
	// PTYs persist across browser show/hide toggles — only closed on explicit
	// pty_close (tab X button) or upstream disconnect.

	const ptyManager = new PtyManager({ log: ptyLog });
	const pendingUserMessages = new PendingUserMessages();

	// ── Monitoring reducer state ──────────────────────────────────────────────
	const sseTracker = createSessionSSETracker();
	let monitoringState: MonitoringState = initialMonitoringState();
	const pollerGatingCfg: PollerGatingConfig = {
		...DEFAULT_POLLER_GATING_CONFIG,
		...config.pollerGatingConfig,
	};

	// ── Health check ────────────────────────────────────────────────────────

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	await client.getHealth();
	log.info(`✓ OpenCode is reachable at ${config.opencodeUrl}`);

	// Seed defaultModel from OpenCode's project config (opencode.jsonc) if no
	// relay-persisted default was loaded.  This ensures the UI shows the correct
	// model (e.g. Opus) on first startup rather than falling back to the
	// provider-level default (e.g. Sonnet).
	if (!overrides.defaultModel) {
		try {
			if (config.signal?.aborted) throw new Error("Relay creation aborted");
			const ocConfig = await client.getConfig();
			const configModel =
				typeof ocConfig?.["model"] === "string" ? ocConfig["model"] : "";
			if (configModel) {
				const slashIdx = configModel.indexOf("/");
				const provider = slashIdx > 0 ? configModel.slice(0, slashIdx) : "";
				const modelId =
					slashIdx > 0 ? configModel.slice(slashIdx + 1) : configModel;
				if (provider && modelId) {
					overrides.setDefaultModel({
						providerID: provider,
						modelID: modelId,
					});
					log.info(`✓ Default model from project config: ${configModel}`);
				}
			}
		} catch (err) {
			log.warn(
				`Config API unavailable: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	// ── Session ─────────────────────────────────────────────────────────────

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	const sessionId = await sessionMgr.initialize(config.sessionTitle);
	log.info(`✓ Using session: ${sessionId}`);

	// ── WebSocket handler ───────────────────────────────────────────────────

	const wsHandler = new WebSocketHandler(
		serviceRegistry,
		config.noServer ? null : config.httpServer,
		{
			registry,
			// In noServer mode, the daemon's upgrade handler checks auth before
			// calling handleUpgrade(). Skip verifyClient to avoid double auth.
			...(!config.noServer &&
				config.verifyClient != null && { verifyClient: config.verifyClient }),
		},
	);

	// ── PTY upstream deps (constructed after wsHandler is available) ────────
	const ptyDeps: PtyUpstreamDeps = {
		ptyManager,
		wsHandler,
		client,
		opencodeUrl: config.opencodeUrl,
		log: ptyLog,
		WebSocketClass,
	};

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
		log: wsLog,
	};

	wsHandler.on("client_connected", ({ clientId, requestedSessionId }) => {
		wsLog.info(
			`Client connected: ${clientId}${requestedSessionId ? ` (requested session: ${requestedSessionId})` : ""}`,
		);
		// Viewer tracking is now handled by the shared SessionRegistry via
		// wsHandler.setClientSession() (called by handleClientConnected / view_session).
		// No manual addViewer needed — the registry IS the source of truth.
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
		// Viewer tracking cleanup is handled by ws-handler's onClose which
		// calls registry.removeClient(). No manual removeViewer needed.
		wsLog.info(`Client disconnected: ${clientId}`);
	});

	// ── SSE consumer ────────────────────────────────────────────────────────

	const sseConsumer = new SSEConsumer(serviceRegistry, {
		baseUrl: config.opencodeUrl,
		authHeaders: client.getAuthHeaders(),
		log: sseLog,
	});

	// ── Wire session manager → WebSocket ────────────────────────────────────

	sessionMgr.on("broadcast", (msg) => {
		// Augment session_switched with cached events (combined protocol)
		if (msg.type === "session_switched") {
			const switchId = (msg as { id?: string }).id;
			if (switchId) {
				const events = messageCache.getEvents(switchId);
				const hasChatContent =
					events?.some(
						(e) => e.type === "user_message" || e.type === "delta",
					) ?? false;
				if (events && hasChatContent) {
					wsHandler.broadcast({ ...msg, events });
					return;
				}
			}
		}
		wsHandler.broadcast(msg);
	});
	sessionMgr.on("session_lifecycle", async (ev) => {
		const sid = ev.sessionId;
		translator.reset(sid);

		if (ev.type === "created") {
			const existingMessages = await rebuildTranslatorFromHistory(
				translator,
				(id) => client.getMessages(id),
				sid,
				sessionLog,
			);

			if (existingMessages) {
				pollerManager.startPolling(sid, existingMessages);
			} else {
				sessionLog.debug(
					`Skipping poller start for ${sid.slice(0, 12)} — no seed messages`,
				);
			}
		} else {
			// deleted — clean up poller, activity, SSE tracker, and monitoring state
			pollerManager.stopPolling(sid);
			statusPoller.clearMessageActivity(sid);
			sseTracker.remove(sid);

			// Remove from monitoring state to prevent the reducer from
			// generating spurious notify-idle effects for already-deleted sessions
			const sessions = new Map(monitoringState.sessions);
			sessions.delete(sid);
			monitoringState = { sessions };
		}
	});

	// ── Handle incoming messages from browser ───────────────────────────────
	// Messages are serialized: each handler completes before the next starts.
	// Without this, concurrent async handlers (e.g. new_session + switch_session)
	// race — createSession's broadcast can arrive on the client AFTER
	// a switch_session reply, clearing messages the user just switched to.

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
		},
		...(config.getInstances != null && { getInstances: config.getInstances }),
		...(config.addInstance != null && { addInstance: config.addInstance }),
		...(config.removeInstance != null && {
			removeInstance: config.removeInstance,
		}),
		...(config.startInstance != null && {
			startInstance: config.startInstance,
		}),
		...(config.stopInstance != null && { stopInstance: config.stopInstance }),
		...(config.updateInstance != null && {
			updateInstance: config.updateInstance,
		}),
		...(config.persistConfig != null && {
			persistConfig: config.persistConfig,
		}),
		...(config.setProjectInstance != null && {
			setProjectInstance: config.setProjectInstance,
		}),
		...(config.getProjects != null && { getProjects: config.getProjects }),
		...(config.triggerScan != null && { triggerScan: config.triggerScan }),
		...(config.removeProject != null && {
			removeProject: config.removeProject,
		}),
		...(config.setProjectTitle != null && {
			setProjectTitle: config.setProjectTitle,
		}),
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

	// ── SSE event wiring (translate → filter → cache → broadcast) ──────────

	wireSSEConsumer(
		{
			translator,
			sessionMgr,
			messageCache,
			pendingUserMessages,
			permissionBridge,
			overrides,
			toolContentStore,
			wsHandler,
			...(config.pushManager != null && { pushManager: config.pushManager }),
			log: sseLog,
			pipelineLog,
			getSessionStatuses: () => statusPoller.getCurrentStatuses(),
			listPendingQuestions: () => client.listPendingQuestions(),
			listPendingPermissions: () => client.listPendingPermissions(),
			statusPoller,
			slug: config.slug,
		},
		sseConsumer,
	);

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	await sseConsumer.connect();

	// ── Shared pipeline deps (used by status poller + message poller) ──────
	const pipelineDeps: PipelineDeps = {
		toolContentStore,
		overrides,
		messageCache,
		wsHandler,
		log: pipelineLog,
	};

	// ── Effect executor deps (used by monitoring reducer effects) ─────────
	const effectDeps: EffectDeps = {
		startPoller: (sessionId) => {
			client
				.getMessages(sessionId)
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
				wsHandler.broadcast(
					notification.crossSessionPayload as import("../shared-types.js").RelayMessage,
				);
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
					{ connected: sseConsumer.isConnected() },
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

			// Push notification for done/error from message poller.
			// Skip done notifications for subagent sessions — only root agent
			// completions should fire push/browser alerts.
			const isSubagentPoller =
				msg.type === "done" &&
				polledSessionId != null &&
				sessionMgr.getSessionParentMap().has(polledSessionId);

			if (config.pushManager && !isSubagentPoller) {
				sendPushForEvent(config.pushManager, msg, pollerLog, {
					slug: config.slug,
					sessionId: polledSessionId ?? undefined,
				});
			}

			// Cross-session browser notification for dropped notification-worthy events
			if (
				pollerResult.route.action === "drop" &&
				isNotificationWorthy(msg.type) &&
				!isSubagentPoller
			) {
				wsHandler.broadcast({
					type: "notification_event",
					eventType: msg.type,
					...(msg.type === "error"
						? {
								message:
									(msg as { message?: string }).message ?? "An error occurred",
							}
						: {}),
					...(polledSessionId != null ? { sessionId: polledSessionId } : {}),
				});
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

	// ── Permission/question timeout checks + rate-limiter cleanup ──────────
	// Wrapped in a TrackedService so they are cancelled on registry drain.

	const relayTimers = new RelayTimers(
		serviceRegistry,
		permissionBridge,
		rateLimiter,
		(id) => {
			wsHandler.broadcast({
				type: "permission_resolved",
				requestId: id as PermissionId,
				decision: "timeout",
			});
		},
	);
	relayTimers.start();

	// ── Return project relay ────────────────────────────────────────────────

	return {
		wsHandler,
		sseConsumer,
		client,
		sessionMgr,
		translator,
		permissionBridge,
		messageCache,

		isAnySessionProcessing() {
			const statuses = statusPoller.getCurrentStatuses();
			return Object.values(statuses).some(
				(s) => s.type === "busy" || s.type === "retry",
			);
		},

		async stop() {
			await relayTimers.drain();
			statusPoller.stop();
			pollerManager.stopAll();
			overrides.dispose();
			ptyManager.closeAll();
			await sseConsumer.disconnect();
			wsHandler.close();
		},
	};
}

// ─── Create Full Stack (Server + Relay) ─────────────────────────────────────

/**
 * Create a full relay stack with its own HTTP server.
 *
 * Creates a RelayServer, registers the project, starts the server, then
 * delegates to `createProjectRelay()` for all relay wiring. Used by
 * skeleton.ts for standalone operation.
 */
export async function createRelayStack(
	config: RelayStackConfig,
): Promise<RelayStack> {
	const log = config.log ?? createLogger("relay");

	// ── Push notification manager ────────────────────────────────────────────

	let pushMgr: PushNotificationManager | undefined = config.pushManager;
	if (!pushMgr) {
		try {
			const { PushNotificationManager } = await import("../server/push.js");
			pushMgr = new PushNotificationManager();
			await pushMgr.init();
		} catch {
			pushMgr = undefined;
		}
	}

	// ── HTTP server ─────────────────────────────────────────────────────────

	const server = new RelayServer({
		port: config.port,
		...(config.host != null && { host: config.host }),
		...(config.pin && { pin: config.pin }),
		...(config.staticDir != null && { staticDir: config.staticDir }),
		...(config.tls != null && { tls: config.tls }),
		...(pushMgr != null && { pushManager: pushMgr }),
	});

	server.addProject({
		slug: config.slug,
		directory: config.projectDir,
		title: config.slug,
	});

	await server.start();

	const maybeServer = server.getHttpServer();
	if (!maybeServer) {
		throw new Error("HTTP server not available after start()");
	}
	// Assign to a fresh const so TypeScript narrows to non-null in closures.
	const httpServer = maybeServer;

	// ── Multi-project relay management ──────────────────────────────────────
	// All relays use noServer mode. A single upgrade handler routes WebSocket
	// connections to the correct relay by URL path (/ws → initial, /p/{slug}/ws → project).
	// This matches the daemon pattern and allows dynamic project addition.

	const relays = new Map<string, ProjectRelay>();
	const pendingSlugs = new Set<string>();

	const getProjectList = () =>
		server.getProjects().map((p) => ({
			slug: p.slug,
			title: p.title,
			directory: p.directory,
		}));

	/** Create a new project relay and register it. */
	async function addProjectRelay(
		directory: string,
	): Promise<{ slug: string; title: string; directory: string }> {
		// Expand ~ and resolve to absolute path
		if (directory.startsWith("~/") || directory === "~") {
			directory = directory.replace("~", homedir());
		}
		directory = resolve(directory);

		// Check if directory is already registered
		for (const p of server.getProjects()) {
			if (p.directory === directory) {
				return { slug: p.slug, title: p.title, directory: p.directory };
			}
		}

		// Validate directory exists on disk
		const dirStat = await stat(directory).catch(() => null);
		if (!dirStat?.isDirectory()) {
			throw new Error(
				dirStat
					? `Not a directory: ${directory}`
					: `Directory does not exist: ${directory}`,
			);
		}

		const existingSlugs = new Set(relays.keys());
		const slug = generateSlug(directory, existingSlugs);
		const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
		const title = parts[parts.length - 1] ?? "project";

		// Guard against concurrent creation for the same slug
		if (relays.has(slug) || pendingSlugs.has(slug)) {
			const existing = relays.get(slug);
			if (existing) return { slug, title, directory };
			throw new Error(`Relay for ${directory} is still being created`);
		}

		pendingSlugs.add(slug);
		try {
			// Create relay FIRST — if this throws, nothing is registered
			const newRelay = await createProjectRelay({
				httpServer,
				opencodeUrl: config.opencodeUrl,
				projectDir: directory,
				slug,
				noServer: true,
				...(config.sessionTitle != null && {
					sessionTitle: config.sessionTitle,
				}),
				log,
				getProjects: getProjectList,
				addProject: addProjectRelay,
				...(pushMgr != null && { pushManager: pushMgr }),
				...(config.configDir != null && { configDir: config.configDir }),
			});

			// Only register AFTER relay is successfully created
			relays.set(slug, newRelay);
			server.addProject({ slug, directory, title });

			log.info(`Added project: ${title} (${slug}) → ${directory}`);
		} catch (err) {
			// Clean up on failure — no zombie entries
			relays.delete(slug);
			log.error(
				`Failed to add project ${directory}: ${formatErrorDetail(err)}`,
			);
			throw err;
		} finally {
			pendingSlugs.delete(slug);
		}

		return { slug, title, directory };
	}

	// ── Initial project relay ───────────────────────────────────────────────

	const relay = await createProjectRelay({
		httpServer,
		opencodeUrl: config.opencodeUrl,
		projectDir: config.projectDir,
		slug: config.slug,
		...(config.sessionTitle != null && { sessionTitle: config.sessionTitle }),
		log,
		noServer: true,
		getProjects: getProjectList,
		addProject: addProjectRelay,
		...(pushMgr != null && { pushManager: pushMgr }),
		...(config.configDir != null && { configDir: config.configDir }),
		...(config.pollerGatingConfig != null && {
			pollerGatingConfig: config.pollerGatingConfig,
		}),
		...(config.statusPollerInterval != null && {
			statusPollerInterval: config.statusPollerInterval,
		}),
		...(config.messagePollerInterval != null && {
			messagePollerInterval: config.messagePollerInterval,
		}),
	});
	relays.set(config.slug, relay);

	// ── WebSocket upgrade handler ───────────────────────────────────────────
	// Routes connections by URL: /p/{slug}/ws → project relay, /ws → initial relay.
	// Also checks auth when a PIN is configured (fixes pre-existing gap where
	// standalone WS connections bypassed PIN auth).

	httpServer.on("upgrade", (req, socket, head) => {
		// Auth check (mirrors server.ts private checkAuth)
		const auth = server.getAuth();
		if (auth.hasPin()) {
			const cookies = parseCookies(req.headers.cookie ?? "");
			const sessionCookie = cookies["relay_session"];
			const cookieOk = sessionCookie
				? auth.validateCookie(sessionCookie)
				: false;
			if (!cookieOk) {
				const pinHeader = req.headers["x-relay-pin"];
				const pinOk =
					typeof pinHeader === "string" &&
					auth.authenticate(pinHeader, getClientIp(req)).ok;
				if (!pinOk) {
					socket.destroy();
					return;
				}
			}
		}

		// Route /p/{slug}/ws → project relay
		const projectMatch = req.url?.match(/^\/p\/([^/]+)\/ws(?:\?|$)/);
		if (projectMatch) {
			// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
			const target = relays.get(projectMatch[1]!);
			if (target) {
				target.wsHandler.handleUpgrade(req, socket, head);
			} else {
				socket.destroy();
			}
			return;
		}

		// Route /ws → initial relay
		if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
			relay.wsHandler.handleUpgrade(req, socket, head);
			return;
		}

		socket.destroy();
	});

	const urls = server.getUrls();
	log.info(`✓ Server listening: ${urls.local}`);

	return {
		server,
		wsHandler: relay.wsHandler,
		sseConsumer: relay.sseConsumer,
		client: relay.client,
		sessionMgr: relay.sessionMgr,
		translator: relay.translator,
		permissionBridge: relay.permissionBridge,
		messageCache: relay.messageCache,

		getPort() {
			const addr = httpServer.address();
			if (typeof addr === "object" && addr) return addr.port;
			return config.port;
		},

		getBaseUrl() {
			const addr = httpServer.address();
			const port = typeof addr === "object" && addr ? addr.port : config.port;
			const protocol = config.tls ? "https" : "http";
			return `${protocol}://127.0.0.1:${port}`;
		},

		async stop() {
			for (const r of relays.values()) {
				try {
					await r.stop();
				} catch (err) {
					// Best-effort shutdown — log but don't fail
					log.error(
						`Error stopping relay: ${err instanceof Error ? err.message : err}`,
					);
				}
			}
			relays.clear();
			await server.stop();
		},
	};
}
