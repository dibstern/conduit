// ─── Relay Stack ─────────────────────────────────────────────────────────────
// The complete relay wiring: OpenCode client, SSE consumer, event translator,
// WebSocket handler, session manager, permission/question bridges.
//
// Extracted from skeleton.ts so integration tests exercise the exact same
// wiring as production. skeleton.ts is now a thin CLI wrapper around this.

import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PermissionBridge } from "../bridges/permission-bridge.js";
import { ServiceRegistry } from "../daemon/service-registry.js";
import { formatErrorDetail } from "../errors.js";
import { GapEndpoints } from "../instance/gap-endpoints.js";
import { OpenCodeAPI } from "../instance/opencode-api.js";
// OpenCodeClient import removed — SSEStream uses the SDK-based api object directly.
import { createSdkClient } from "../instance/sdk-factory.js";
import { createLogger, type Logger } from "../logger.js";
import { DualWriteHook } from "../persistence/dual-write-hook.js";
import type { PersistenceLayer } from "../persistence/persistence-layer.js";
import { ProviderStateService } from "../persistence/provider-state-service.js";
import { ReadQueryService } from "../persistence/read-query-service.js";
import { SessionSeeder } from "../persistence/session-seeder.js";
import {
	createOrchestrationLayer,
	type OrchestrationLayer,
} from "../provider/orchestration-wiring.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationManager } from "../server/push.js";
import { RelayServer } from "../server/server.js";
import { WebSocketHandler } from "../server/ws-handler.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionOverrides } from "../session/session-overrides.js";
import { SessionRegistry } from "../session/session-registry.js";
import { SessionStatusPoller } from "../session/session-status-poller.js";
import { SessionStatusSqliteReader } from "../session/session-status-sqlite.js";
import type { ProjectRelayConfig } from "../types.js";
import { generateSlug } from "../utils.js";
import { createTranslator } from "./event-translator.js";
import { wireHandlerDeps } from "./handler-deps-wiring.js";
import { MessagePollerManager } from "./message-poller-manager.js";
import { wireMonitoring } from "./monitoring-wiring.js";
import { wirePollers } from "./poller-wiring.js";
import { PtyManager } from "./pty-manager.js";
import type { PtyUpstreamDeps } from "./pty-upstream.js";
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";
import { wireSessionLifecycle } from "./session-lifecycle-wiring.js";
import { SSEStream } from "./sse-stream.js";
import { wireSSEConsumer } from "./sse-wiring.js";
import { wireTimers } from "./timer-wiring.js";

// ─── WebSocket library for upstream PTY connections ─────────────────────────
const requireWs = createRequire(import.meta.url);
const wsLib = requireWs("ws");
const WebSocketClass = wsLib.WebSocket as typeof import("ws").WebSocket;

/** Per-project relay: all relay components attached to a shared server. */
export interface ProjectRelay {
	wsHandler: WebSocketHandler;
	sseStream: SSEStream;
	client: OpenCodeAPI;
	sessionMgr: SessionManager;
	translator: ReturnType<typeof createTranslator>;
	permissionBridge: PermissionBridge;
	/** Phase 5: Orchestration layer — provider registry, adapter, and engine. */
	orchestration: OrchestrationLayer;
	/** SQLite persistence layer — present when the relay was configured with a db path. */
	persistence?: PersistenceLayer;
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
	sseStream: SSEStream;
	client: OpenCodeAPI;
	sessionMgr: SessionManager;
	translator: ReturnType<typeof createTranslator>;
	permissionBridge: PermissionBridge;

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
	const serviceRegistry = config.registry ?? new ServiceRegistry();

	// ── Components ──────────────────────────────────────────────────────────

	// ── SDK-based client (Tasks 3–6) ─────────────────────────────────────────
	const {
		client: sdkClient,
		fetch: sdkFetch,
		authHeaders,
	} = createSdkClient({
		baseUrl: config.opencodeUrl,
		...(config.noServer &&
			config.projectDir != null && {
				directory: config.projectDir,
			}),
	});

	const gapEndpoints = new GapEndpoints({
		baseUrl: config.opencodeUrl,
		fetch: sdkFetch,
		headers: authHeaders,
	});

	const api = new OpenCodeAPI({
		sdk: sdkClient,
		gapEndpoints,
		baseUrl: config.opencodeUrl,
		authHeaders,
	});

	// ── Orchestration layer (Phase 5: provider adapter routing) ─────────────
	const orchestration = createOrchestrationLayer({
		client: api,
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
	});

	const translator = createTranslator();
	const permissionBridge = new PermissionBridge();
	const sessionMgr: SessionManager = new SessionManager({
		client: api,
		log: sessionLog,
		directory: config.projectDir,
		// Lazy getter — statusPoller is created below but the getter is only
		// called at runtime when listSessions() runs, so ordering is fine.
		getStatuses: (): Record<
			string,
			import("../instance/sdk-types.js").SessionStatus
		> => statusPoller.getCurrentStatuses(),
		...(config.configDir != null && { configDir: config.configDir }),
	});

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

	// ── SQLite read query service (reads from projected tables) ──
	// Created early so it can be shared with the status poller and handler deps.
	const readQuery = config.persistence
		? new ReadQueryService(config.persistence.db)
		: undefined;

	// ── Provider state service (resume cursor persistence) ──
	const providerStateService = config.persistence
		? new ProviderStateService(config.persistence.db)
		: undefined;

	// ── Session status reconciliation loop ──────────────────────────────────
	// Background job that detects and corrects status mismatches between
	// the projected SQLite state and OpenCode's REST API. Default interval
	// is 7s (was 500ms when this was a real-time polling source).
	const statusPoller: SessionStatusPoller = new SessionStatusPoller(
		serviceRegistry,
		{
			client: api,
			...(config.statusPollerInterval != null && {
				interval: config.statusPollerInterval,
			}),
			log: statusLog,
			getSessionParentMap: (): Map<string, string> =>
				sessionMgr.getSessionParentMap(),
			...(readQuery != null && {
				readQuery,
				sqliteReader: new SessionStatusSqliteReader(readQuery),
			}),
			...(config.persistence != null && {
				persistence: {
					eventStore: config.persistence.eventStore,
					projectionRunner: config.persistence.projectionRunner,
				},
			}),
		},
	);

	// ── Shared session registry (single source of truth for client→session tracking) ──
	const registry = new SessionRegistry(log.child("session-registry"));

	// ── Message poller manager (REST fallback for CLI sessions without SSE events) ──
	// Manages multiple pollers concurrently — one per busy session.
	const pollerManager = new MessagePollerManager(serviceRegistry, {
		client: api,
		log: pollerMgrLog,
		hasViewers: (sid: string) => registry.hasViewers(sid),
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

	// ── Health check ────────────────────────────────────────────────────────

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	// Health check — use /path endpoint as a lightweight reachability probe
	await api.app.path();
	log.info(`✓ OpenCode is reachable at ${config.opencodeUrl}`);

	// Seed defaultModel from OpenCode's project config (opencode.jsonc) if no
	// relay-persisted default was loaded.  This ensures the UI shows the correct
	// model (e.g. Opus) on first startup rather than falling back to the
	// provider-level default (e.g. Sonnet).
	if (!overrides.defaultModel) {
		try {
			if (config.signal?.aborted) throw new Error("Relay creation aborted");
			const ocConfig = await api.config.get();
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
		client: api,
		opencodeUrl: config.opencodeUrl,
		log: ptyLog,
		WebSocketClass,
	};

	// ── Claude event persistence (reuses existing persistence layer) ──────
	const claudeEventPersist = config.persistence
		? (() => {
				const seeder = new SessionSeeder(config.persistence.db);
				return {
					eventStore: config.persistence.eventStore,
					projectionRunner: config.persistence.projectionRunner,
					ensureSession: (sid: string) => seeder.ensureSession(sid, "claude"),
				};
			})()
		: undefined;

	// ── Handler deps wiring (G1: client init, message queue, rate limiter) ──
	const { rateLimiter } = wireHandlerDeps({
		wsHandler,
		client: api,
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
		...(readQuery != null && { readQuery }),
		orchestrationLayer: orchestration,
		...(claudeEventPersist != null && { claudeEventPersist }),
		...(providerStateService != null && { providerStateService }),
	});

	// ── SSE stream (SDK-backed, replaces legacy SSEConsumer) ────────────────

	const sseStream = new SSEStream(serviceRegistry, {
		api,
		log: sseLog,
	});

	// ── Run projector recovery (required before projectEvent works) ──────
	// ProjectionRunner guards projectEvent() behind a recovery check.
	// Without this call, all projections silently fail (caught by try/catch
	// in DualWriteHook and RelayEventSink) and the messages table stays empty.
	if (config.persistence) {
		config.persistence.projectionRunner.recover();
	}

	// ── Dual-write hook (SSE → SQLite event store) ──────────────────────
	let dualWriteHook: DualWriteHook | undefined;
	if (config.persistence) {
		dualWriteHook = new DualWriteHook({
			persistence: config.persistence,
			log: log.child("dual-write"),
		});
	}

	// ── SSE event wiring (translate → filter → cache → broadcast) ──────────

	// Late-binding: SSE wiring is set up before monitoring wiring, but SSE
	// events arrive asynchronously (after connect). The ref is bound after
	// wireMonitoring completes.
	const doneDeliveredRef = { fn: (_sid: string) => {} };

	wireSSEConsumer(
		{
			translator,
			sessionMgr,
			permissionBridge,
			overrides,
			wsHandler,
			...(config.pushManager != null && { pushManager: config.pushManager }),
			log: sseLog,
			pipelineLog,
			getSessionStatuses: () => statusPoller.getCurrentStatuses(),
			getSessionParentMap: () => sessionMgr.getSessionParentMap(),
			listPendingQuestions: () => api.question.list(),
			listPendingPermissions: () => api.permission.list(),
			statusPoller,
			slug: config.slug,
			onDoneProcessed: (sid) => doneDeliveredRef.fn(sid),
			...(dualWriteHook != null && { dualWriteHook }),
		},
		sseStream,
	);

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	await sseStream.connect();

	// ── Wire SSE idle events → OpenCodeAdapter.notifyTurnCompleted() ────────
	// Resolves the deferred promise in OpenCodeAdapter.sendTurn() when a
	// session transitions to idle, allowing the engine dispatch to complete.
	orchestration.wireSSEToAdapter((event, handler) => {
		sseStream.on(event, handler);
	});

	// ── Monitoring wiring (G2: pipeline deps, effect deps, status poller) ──
	const {
		pipelineDeps,
		sseTracker,
		getMonitoringState,
		setMonitoringState,
		recordDoneDelivered: bindDoneDelivered,
	} = wireMonitoring({
		client: api,
		wsHandler,
		sessionMgr,
		overrides,
		statusPoller,
		pollerManager,
		registry,
		sseStream,
		config: {
			...(config.pollerGatingConfig != null && {
				pollerGatingConfig: config.pollerGatingConfig,
			}),
			...(config.pushManager != null && { pushManager: config.pushManager }),
			slug: config.slug,
		},
		statusLog,
		sseLog,
		pipelineLog,
	});

	// Bind the late-binding done-dedup callback now that monitoring wiring exists.
	doneDeliveredRef.fn = bindDoneDelivered;

	// ── Session lifecycle wiring (G4: broadcast + session_lifecycle) ─────────
	wireSessionLifecycle({
		sessionMgr,
		wsHandler,
		client: api,
		translator,
		pollerManager,
		statusPoller,
		sseTracker,
		getMonitoringState,
		setMonitoringState,
		sessionLog,
	});

	// ── Poller wiring (G3: message poller events + SSE→poller bridge) ────────
	wirePollers({
		pollerManager,
		sseStream,
		statusPoller,
		wsHandler,
		sessionMgr,
		pipelineDeps,
		sseTracker,
		config: {
			...(config.pushManager != null && { pushManager: config.pushManager }),
			slug: config.slug,
		},
		pollerLog,
		onDoneProcessed: (sid) => doneDeliveredRef.fn(sid),
	});

	// ── Timer wiring (G5: permission timeouts + rate limiter cleanup) ────────
	const { timeoutTimer, rateLimitCleanupTimer } = wireTimers({
		permissionBridge,
		rateLimiter,
		wsHandler,
	});

	// ── Return project relay ────────────────────────────────────────────────

	return {
		wsHandler,
		sseStream,
		client: api,
		sessionMgr,
		translator,
		permissionBridge,
		orchestration,
		...(config.persistence ? { persistence: config.persistence } : {}),

		isAnySessionProcessing() {
			const statuses = statusPoller.getCurrentStatuses();
			return Object.values(statuses).some(
				(s) => s.type === "busy" || s.type === "retry",
			);
		},

		async stop() {
			// 1. Stop event sources
			await sseStream.disconnect();
			pollerManager.stopAll();
			statusPoller.stop();
			// 2. Shut down orchestration engine (rejects pending turns)
			await orchestration.engine.shutdown();
			// 3. Clean up remaining resources
			clearInterval(timeoutTimer);
			clearInterval(rateLimitCleanupTimer);
			overrides.dispose();
			ptyManager.closeAll();
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
		sseStream: relay.sseStream,
		client: relay.client,
		sessionMgr: relay.sessionMgr,
		translator: relay.translator,
		permissionBridge: relay.permissionBridge,

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
