// ─── Relay Stack ─────────────────────────────────────────────────────────────
// The complete relay wiring: OpenCode client, SSE consumer, event translator,
// WebSocket handler, session manager, permission/question bridges.
//
// Extracted from skeleton.ts so integration tests exercise the exact same
// wiring as production. skeleton.ts is now a thin CLI wrapper around this.

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NodeFileSystem,
	NodeHttpServer,
	NodePath,
} from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { AuthManager } from "../auth.js";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../bridges/client-init.js";
import { PermissionBridge } from "../bridges/permission-bridge.js";
import { QuestionBridge } from "../bridges/question-bridge.js";
import { AuthManagerTag } from "../effect/auth-middleware.js";
import { ClientMessageSerializationTag } from "../effect/client-message-serialization.js";
import { RelayStateLive } from "../effect/relay-layer.js";
import {
	ClaudeEventPersistTag,
	ConfigTag,
	ConnectPtyUpstreamTag,
	InstanceMgmtTag,
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	PollerManagerTag,
	ProjectMgmtTag,
	ProviderStateServiceTag,
	PtyManagerTag,
	QuestionBridgeTag,
	ReadQueryTag,
	ScanDepsTag,
	type SessionManagerShape,
	SessionManagerTag,
	SessionOverridesTag,
	SessionRegistryTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import {
	createStatusPollerService,
	makeDeferredStatusPollerRuntime,
	type PollDeps,
	PollerPubSubTag,
	PollerStateTag,
	type SessionStatusPollerService,
} from "../effect/session-status-poller.js";
import { StaticDirTag } from "../effect/static-file-handler.js";
import { ENV } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import { GapEndpoints } from "../instance/gap-endpoints.js";
import { OpenCodeAPI } from "../instance/opencode-api.js";
// OpenCodeClient import removed — SSEStream uses the SDK-based api object directly.
import { createSdkClientEffect } from "../instance/sdk-factory.js";
import { createLogger, type Logger } from "../logger.js";
import {
	DualWriteHook,
	type DualWriteHookPort,
} from "../persistence/dual-write-hook.js";
import { EffectDualWriteHook } from "../persistence/effect/dual-write-hook-effect.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectError,
	type PersistenceEffectRuntime,
} from "../persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type SessionStatusValue,
} from "../persistence/events.js";
import type { PersistenceLayer } from "../persistence/persistence-layer.js";
import { ProviderStateService } from "../persistence/provider-state-service.js";
import { ReadQueryService } from "../persistence/read-query-service.js";
import { SessionSeeder } from "../persistence/session-seeder.js";
import {
	createOrchestrationLayer,
	type OrchestrationLayer,
} from "../provider/orchestration-wiring.js";
import {
	CaCertProvider,
	effectRouterWithCors,
	ProjectApiDelegateProvider,
	ProjectsProvider,
	PushProvider,
	RemoveProjectProvider,
	type RouterProjectInfo,
	SetupInfoProvider,
	ThemeProvider,
} from "../server/effect-http-router.js";
import { EffectWsHandler } from "../server/effect-ws-handler.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationManager } from "../server/push.js";
import { loadThemeFiles } from "../server/theme-loader.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import { SessionManager } from "../session/session-manager.js";
import { SessionOverrides } from "../session/session-overrides.js";
import { SessionRegistry } from "../session/session-registry.js";
import { readSessionStatusesFromEffect } from "../session/session-status-effect.js";
import { SessionStatusSqliteReader } from "../session/session-status-sqlite.js";
import type { ProjectRelayConfig } from "../types.js";
import { generateSlug } from "../utils.js";

/** Runtime bridge between imperative relay-stack and Effect handler pipeline. */
// biome-ignore lint/suspicious/noExplicitAny: ManagedRuntime context is the full relay Layer graph.
type RelayRuntimeContext = any;

interface RelayRuntime {
	runtime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeContext,
		PersistenceEffectError
	>;
	dispose: () => Promise<void>;
}

import { createTranslator } from "./event-translator.js";
import { MessagePollerManager } from "./message-poller-impl.js";
import { wireMonitoring } from "./monitoring-wiring.js";
import { wirePollers } from "./poller-wiring.js";
import { PtyManager } from "./pty-manager.js";
import type { PtyUpstreamDeps } from "./pty-upstream.js";
import { connectPtyUpstream as connectPtyUpstreamImpl } from "./pty-upstream.js";
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";
import { SessionEventBridgeLive } from "./session-event-bridge.js";
import { makeSessionLifecycleWiringLive } from "./session-lifecycle-wiring.js";
import { SSEStream } from "./sse-stream.js";
import { wireSSEConsumer } from "./sse-wiring.js";
import { PermissionTimeoutLive } from "./timer-wiring.js";
import { handleRelayWsMessage } from "./ws-message-dispatch-effect.js";

// ─── WebSocket library for upstream PTY connections ─────────────────────────
const requireWs = createRequire(import.meta.url);
const wsLib = requireWs("ws");
const WebSocketClass = wsLib.WebSocket as typeof import("ws").WebSocket;

const _staticCandidate = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"frontend",
);
const DEFAULT_STATIC_DIR = existsSync(_staticCandidate)
	? _staticCandidate
	: join(process.cwd(), "dist", "frontend");

interface StandaloneProjectEntry {
	slug: string;
	directory: string;
	title: string;
	getClientCount?: () => number;
	getSessionCount?: () => number;
	getIsProcessing?: () => boolean;
}

interface StandaloneServerUrls {
	local: string;
	network: string[];
}

export class EffectRelayServer {
	private server: Server | null = null;
	private readonly port: number;
	private actualPort: number;
	private readonly host: string;
	private readonly auth = new AuthManager();
	private readonly projects = new Map<string, StandaloneProjectEntry>();
	private readonly staticDir: string;
	private readonly protocol: "https" | "http";
	private readonly options: {
		port?: number;
		host?: string;
		staticDir?: string;
		pin?: string;
		tls?: { key: Buffer; cert: Buffer; caRoot?: string };
		pushManager?: PushNotificationManager;
	};

	constructor(
		options: {
			port?: number;
			host?: string;
			staticDir?: string;
			pin?: string;
			tls?: { key: Buffer; cert: Buffer; caRoot?: string };
			pushManager?: PushNotificationManager;
		} = {},
	) {
		this.options = options;
		this.port = options.port ?? 2633;
		this.actualPort = this.port;
		this.host = options.host ?? ENV.host;
		this.staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
		this.protocol = options.tls ? "https" : "http";
		if (options.pin) this.auth.setPin(options.pin);
	}

	addProject(project: StandaloneProjectEntry): void {
		this.projects.set(project.slug, project);
	}

	removeProject(slug: string): boolean {
		return this.projects.delete(slug);
	}

	getProjects(): StandaloneProjectEntry[] {
		return Array.from(this.projects.values());
	}

	getAuth(): AuthManager {
		return this.auth;
	}

	getHttpServer(): Server | null {
		return this.server;
	}

	getUrls(): StandaloneServerUrls {
		const local = `${this.protocol}://localhost:${this.actualPort}`;
		const network: string[] = [];
		for (const entries of Object.values(networkInterfaces())) {
			if (!entries) continue;
			for (const entry of entries) {
				if (entry.family === "IPv4" && !entry.internal) {
					network.push(
						`${this.protocol}://${entry.address}:${this.actualPort}`,
					);
				}
			}
		}
		return { local, network };
	}

	async start(): Promise<void> {
		const getProjects = (): RouterProjectInfo[] =>
			Array.from(this.projects.values()).map((p) => ({
				slug: p.slug,
				directory: p.directory,
				title: p.title,
				clients: p.getClientCount?.() ?? 0,
				sessions: p.getSessionCount?.() ?? 0,
				isProcessing: p.getIsProcessing?.() ?? false,
			}));

		// biome-ignore lint/suspicious/noExplicitAny: optional standalone providers are merged conditionally.
		let routerLayer: Layer.Layer<any, never, never> = Layer.mergeAll(
			Layer.succeed(AuthManagerTag, this.auth),
			Layer.succeed(StaticDirTag, this.staticDir),
			Layer.succeed(ProjectsProvider, { getProjects }),
			Layer.succeed(RemoveProjectProvider, {
				removeProject: (slug: string) =>
					Effect.sync(() => {
						if (!this.removeProject(slug)) throw new Error("Project not found");
					}),
			}),
			Layer.succeed(ProjectApiDelegateProvider, {
				delegateApiRequest: () =>
					Effect.fail(new Error("Project API route not found")),
			}),
			Layer.succeed(SetupInfoProvider, {
				getPort: () => this.actualPort,
				getIsTls: () => this.protocol === "https",
			}),
			Layer.succeed(ThemeProvider, { loadThemes: loadThemeFiles }),
			NodeFileSystem.layer,
			NodePath.layer,
		);
		if (this.options.pushManager != null) {
			routerLayer = Layer.merge(
				routerLayer,
				Layer.succeed(PushProvider, {
					getPublicKey: () =>
						this.options.pushManager?.getPublicKey() ?? undefined,
					addSubscription: (endpoint, subscription) =>
						this.options.pushManager?.addSubscription(
							endpoint,
							subscription as Parameters<
								PushNotificationManager["addSubscription"]
							>[1],
						),
					removeSubscription: (endpoint) =>
						this.options.pushManager?.removeSubscription(endpoint),
				}),
			);
		}
		if (this.options.tls?.caRoot != null) {
			routerLayer = Layer.merge(
				routerLayer,
				Layer.succeed(CaCertProvider, {
					caCertDer: undefined,
					caRootPath: this.options.tls.caRoot,
				}),
			);
		}

		const effectHandler = Effect.runSync(
			NodeHttpServer.makeHandler(
				effectRouterWithCors.pipe(Effect.provide(routerLayer)),
			),
		);

		await new Promise<void>((resolveStart, rejectStart) => {
			const handler = (req: IncomingMessage, res: ServerResponse) =>
				effectHandler(req, res);

			this.server = this.options.tls
				? createHttpsServer(
						{ key: this.options.tls.key, cert: this.options.tls.cert },
						handler,
					)
				: createServer(handler);

			this.server.on("error", rejectStart);
			this.server.listen(this.port, this.host, () => {
				const addr = this.server?.address();
				if (addr && typeof addr !== "string") this.actualPort = addr.port;
				resolveStart();
			});
		});
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolveStop) => {
			const server = this.server;
			if (!server) {
				resolveStop();
				return;
			}
			server.close(() => {
				this.server = null;
				resolveStop();
			});
			server.closeIdleConnections?.();
			server.closeAllConnections?.();
		});
	}
}

/** Per-project relay: all relay components attached to a shared server. */
export interface ProjectRelay {
	wsHandler: WebSocketHandlerShape;
	sseStream: SSEStream;
	client: OpenCodeAPI;
	sessionMgr: SessionManagerShape;
	translator: ReturnType<typeof createTranslator>;
	permissionBridge: PermissionBridge;
	/** Phase 5: Orchestration layer — provider registry, adapter, and engine. */
	orchestration: OrchestrationLayer;
	/** Effect ManagedRuntime for dispatching through the Effect handler pipeline. */
	effectRuntime: RelayRuntime;
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
	server: EffectRelayServer;
	wsHandler: WebSocketHandlerShape;
	sseStream: SSEStream;
	client: OpenCodeAPI;
	sessionMgr: SessionManagerShape;
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

	// ── Components ──────────────────────────────────────────────────────────

	// ── SDK-based client (Tasks 3–6, Effect-based from Task 4) ──────────────
	const {
		client: sdkClient,
		fetch: sdkFetch,
		authHeaders,
	} = Effect.runSync(
		createSdkClientEffect({
			baseUrl: config.opencodeUrl,
			...(config.noServer &&
				config.projectDir != null && {
					directory: config.projectDir,
				}),
		}),
	);

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
	const sessionMgr = new SessionManager({
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
	const overrides = new SessionOverrides();

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

	// ── Session status reconciliation loop (Effect-native) ─────────────────
	// Background job that detects and corrects status mismatches between
	// the projected SQLite state and OpenCode's REST API. Default interval
	// is 7s (was 500ms when this was a real-time polling source).
	//
	// Uses the Effect-native PollerStateTag + PollerPubSubTag for state and
	// event broadcasting, with a thin imperative facade for wiring code.

	const sqliteReader = readQuery
		? new SessionStatusSqliteReader(readQuery)
		: undefined;

	const pollerPollDeps: PollDeps = {
		getRawStatuses: () =>
			config.persistenceDbPath != null
				? readSessionStatusesFromEffect
				: sqliteReader
					? Effect.sync(() => sqliteReader.getSessionStatuses())
					: Effect.tryPromise(() => api.session.statuses()),
		getSessionParentMap: (): Map<string, string> =>
			sessionMgr.getSessionParentMap(),
		resolveParent: (sessionId: string) =>
			Effect.tryPromise(async () => {
				const session = await api.session.get(sessionId);
				return session.parentID;
			}).pipe(Effect.catchAll(() => Effect.succeed(undefined))),
		...(config.persistenceDbPath != null
			? {
					reconciliation: {
						getRestStatuses: () =>
							Effect.tryPromise(() => api.session.statuses()),
						getProjectedSessions: () =>
							Effect.gen(function* () {
								const readQueryEffect = yield* ReadQueryEffectTag;
								return yield* readQueryEffect.listSessions();
							}),
						injectCorrectiveEvent: (sessionId: string, status: string) =>
							Effect.gen(function* () {
								const eventStore = yield* EventStoreEffectTag;
								const projectionRunner = yield* ProjectionRunnerEffectTag;
								const event = canonicalEvent(
									"session.status",
									sessionId,
									{
										sessionId,
										status: status as SessionStatusValue,
									},
									{
										metadata: {
											synthetic: true,
											source: "reconciliation-loop",
										},
									},
								);
								const stored = yield* eventStore.append(event);
								yield* projectionRunner.projectEvent(stored);
							}),
					},
				}
			: config.persistence != null && readQuery != null
				? {
						reconciliation: {
							getRestStatuses: () =>
								Effect.tryPromise(() => api.session.statuses()),
							getProjectedSessions: () =>
								Effect.sync(() => readQuery.listSessions()),
							injectCorrectiveEvent: (sessionId: string, status: string) =>
								Effect.sync(() => {
									const event = canonicalEvent(
										"session.status",
										sessionId,
										{
											sessionId,
											status: status as SessionStatusValue,
										},
										{
											metadata: {
												synthetic: true,
												source: "reconciliation-loop",
											},
										},
									);
									// biome-ignore lint/style/noNonNullAssertion: persistence checked above
									const stored = config.persistence!.eventStore.append(event);
									// biome-ignore lint/style/noNonNullAssertion: persistence checked above
									config.persistence!.projectionRunner.projectEvent(stored);
								}),
						},
					}
				: {}),
	};

	const statusPollerRuntime = makeDeferredStatusPollerRuntime();

	const statusPoller: SessionStatusPollerService = createStatusPollerService({
		pollDeps: pollerPollDeps,
		...(config.persistence != null &&
			readQuery != null &&
			pollerPollDeps.reconciliation != null && {
				reconciliationDeps: pollerPollDeps.reconciliation,
			}),
		...(config.statusPollerInterval != null && {
			interval: config.statusPollerInterval,
		}),
		runtime: statusPollerRuntime,
		onSubscriptionFailure: (error) =>
			statusLog.warn(
				`Status poller subscription failed: ${formatErrorDetail(error)}`,
			),
	});

	// ── Shared session registry (single source of truth for client→session tracking) ──
	const registry = new SessionRegistry(log.child("session-registry"));

	// ── Message poller manager (REST fallback for CLI sessions without SSE events) ──
	// Manages multiple pollers concurrently — one per busy session.
	const pollerManager = new MessagePollerManager({
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

	// ws-handler-service effects must remain synchronous for bridge read calls
	// (`getClientCount`, `getClientsForSession`, etc.); mutations run as
	// promises at the transport edge.
	const wsHandler = new EffectWsHandler({
		registry,
		...(!config.noServer && {
			server: config.httpServer,
			...(config.verifyClient != null && { verifyClient: config.verifyClient }),
		}),
	});

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

	// ── Question bridge ────────────────────────────────────────────────────
	const questionBridge = new QuestionBridge();

	// ── Client init deps + connection handlers ──────────────────────────────
	const clientInitDeps: ClientInitDeps = {
		wsHandler,
		client: api,
		sessionMgr,
		overrides,
		ptyManager,
		permissionBridge,
		statusPoller,
		...(config.getInstances != null && { getInstances: config.getInstances }),
		...(config.getCachedUpdate != null && {
			getCachedUpdate: config.getCachedUpdate,
		}),
		...(orchestration != null && {
			orchestrationEngine: orchestration.engine,
		}),
		...(readQuery != null && { readQuery }),
		log: wsLog,
	};

	// Late-binding runtime: callbacks fire after full relay initialization, but
	// registering them here keeps the external WebSocket boundary thin.
	let relayManagedRuntime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeContext,
		PersistenceEffectError
	>;

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

	wsHandler.on("client_disconnected", ({ clientId }) => {
		relayManagedRuntime.runFork(
			Effect.gen(function* () {
				const serialization = yield* ClientMessageSerializationTag;
				yield* serialization.removeClient(clientId);
			}),
		);
		wsLog.info(`Client disconnected: ${clientId}`);
	});

	// ── Derived deps for Effect runtime ─────────────────────────────────────
	const connectPtyUpstream = (ptyId: string, cursor?: number) =>
		connectPtyUpstreamImpl(ptyDeps, ptyId, cursor);

	const instanceMgmt =
		config.getInstances != null &&
		config.addInstance != null &&
		config.removeInstance != null &&
		config.startInstance != null &&
		config.stopInstance != null &&
		config.updateInstance != null &&
		config.persistConfig != null
			? {
					getInstances: config.getInstances,
					addInstance: config.addInstance,
					removeInstance: config.removeInstance,
					startInstance: config.startInstance,
					stopInstance: config.stopInstance,
					updateInstance: config.updateInstance,
					persistConfig: config.persistConfig,
				}
			: undefined;

	const projectMgmt =
		config.getProjects != null && config.setProjectInstance != null
			? {
					getProjects: config.getProjects,
					setProjectInstance: config.setProjectInstance,
				}
			: undefined;

	const scanDeps =
		config.triggerScan != null
			? { triggerScan: config.triggerScan }
			: undefined;

	// ── Effect ManagedRuntime (Layer-based composition) ─────────────────────
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Bridge layers wrap already-constructed imperative instances via
	// Layer.succeed(Tag, instance). Both are merged into a single Layer tree.

	// Required bridge layers (imperative instances → Effect Tags)
	const openCodeApiLayer = Layer.succeed(OpenCodeAPITag, api);
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeModelServiceLayer = OpenCodeModelServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);

	const coreBridgeLayers = Layer.mergeAll(
		openCodeApiLayer,
		openCodeFileServiceLayer,
		openCodeModelServiceLayer,
		openCodeSettingsServiceLayer,
		Layer.succeed(SessionManagerTag, sessionMgr),
		Layer.succeed(WebSocketHandlerTag, wsHandler),
		Layer.succeed(PermissionBridgeTag, permissionBridge),
		Layer.succeed(QuestionBridgeTag, questionBridge),
		Layer.succeed(SessionOverridesTag, overrides),
		Layer.succeed(PtyManagerTag, ptyManager),
		Layer.succeed(ConfigTag, config),
		Layer.succeed(LoggerTag, log),
		Layer.succeed(StatusPollerTag, statusPoller),
		Layer.succeed(SessionRegistryTag, registry),
		Layer.succeed(PollerManagerTag, pollerManager),
		Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
		Layer.succeed(OrchestrationEngineTag, orchestration.engine),
		orchestration.registryLayer,
	);

	// Optional bridge layers (only included when deps are present)
	// biome-ignore lint/suspicious/noExplicitAny: Layer generics complex; callers infer correctly
	let bridgeLayers: Layer.Layer<any, never, never> = coreBridgeLayers;
	if (readQuery != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(ReadQueryTag, readQuery),
		);
	}
	if (claudeEventPersist != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(ClaudeEventPersistTag, claudeEventPersist),
		);
	}
	if (providerStateService != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(ProviderStateServiceTag, providerStateService),
		);
	}
	if (instanceMgmt != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(InstanceMgmtTag, instanceMgmt),
		);
	}
	if (projectMgmt != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(ProjectMgmtTag, projectMgmt),
		);
	}
	if (scanDeps != null) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			Layer.succeed(ScanDepsTag, scanDeps),
		);
	}

	const persistenceEffectLayer =
		config.persistenceDbPath != null
			? makePersistenceEffectLayer(config.persistenceDbPath)
			: undefined;

	// Compose: self-constructing state layers + imperative bridge layers.
	// baseLayers are defined here; wiringLayers (PermissionTimeoutLive,
	// SessionEventBridgeLive, SessionLifecycleWiringLive) are added after
	// wireMonitoring() returns (provides sseTracker, getMonitoringState).
	const relayStateAndBridges = Layer.merge(RelayStateLive, bridgeLayers);
	const baseLayers =
		persistenceEffectLayer != null
			? Layer.merge(relayStateAndBridges, persistenceEffectLayer)
			: relayStateAndBridges;

	const effectRuntime: RelayRuntime = {
		get runtime() {
			return relayManagedRuntime;
		},
		dispose: () => relayManagedRuntime.dispose(),
	};

	// ── WebSocket message handler ───────────────────────────────────────────
	wsHandler.on("message", ({ clientId, handler, payload }) => {
		relayManagedRuntime.runFork(
			handleRelayWsMessage({
				clientId,
				handler,
				payload,
				sendTo: (targetClientId, message) =>
					wsHandler.sendTo(targetClientId, message),
				log: wsLog,
			}),
		);
	});

	// ── SSE stream (SDK-backed, replaces legacy SSEConsumer) ────────────────

	const sseStream = new SSEStream({
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
	let effectPersistenceRuntime: PersistenceEffectRuntime | undefined;
	let dualWriteHook: DualWriteHookPort | undefined;
	if (persistenceEffectLayer != null) {
		const persistenceRuntime = ManagedRuntime.make(persistenceEffectLayer);
		try {
			dualWriteHook = new EffectDualWriteHook({
				runtime: persistenceRuntime,
				log: log.child("dual-write"),
			});
			effectPersistenceRuntime = persistenceRuntime;
		} catch (err) {
			await persistenceRuntime.dispose();
			throw err;
		}
	} else if (config.persistence) {
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

	// ── Wire SSE idle events → OpenCodeAdapter.notifyTurnCompleted() ────────
	// Resolves the deferred promise in OpenCodeAdapter.sendTurnEffect() when a
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
		stopMonitoring,
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

	// ── Build ManagedRuntime with all wiring Layers ─────────────────────────
	// Deferred until after wireMonitoring() because SessionLifecycleWiringLive
	// needs sseTracker, getMonitoringState, setMonitoringState from its output.
	const sessionLifecycleWiringLayer = makeSessionLifecycleWiringLive({
		translator,
		sseTracker,
		getMonitoringState,
		setMonitoringState,
	});
	const wiringLayers = Layer.mergeAll(
		PermissionTimeoutLive,
		SessionEventBridgeLive,
		sessionLifecycleWiringLayer,
	).pipe(Layer.provide(baseLayers));
	const fullLayer = Layer.provideMerge(wiringLayers, baseLayers);
	relayManagedRuntime = ManagedRuntime.make(fullLayer);
	await relayManagedRuntime.runPromise(
		Effect.gen(function* () {
			yield* PollerStateTag;
			yield* PollerPubSubTag;
		}),
	);
	statusPollerRuntime.attach(relayManagedRuntime);

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

	if (config.signal?.aborted) throw new Error("Relay creation aborted");
	try {
		await sseStream.connect();
	} catch (err) {
		await effectPersistenceRuntime?.dispose();
		throw err;
	}

	// ── Timer wiring (G5: permission timeouts) ─────────────────────────────
	// PermissionTimeoutLive is composed into RelayStateLive — no imperative wiring.
	// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.

	// ── Return project relay ────────────────────────────────────────────────

	return {
		wsHandler,
		sseStream,
		client: api,
		sessionMgr,
		translator,
		permissionBridge,
		orchestration,
		effectRuntime,
		...(config.persistence ? { persistence: config.persistence } : {}),

		isAnySessionProcessing() {
			const statuses = statusPoller.getCurrentStatuses();
			return Object.values(statuses).some(
				(s) => s.type === "busy" || s.type === "retry",
			);
		},

		async stop() {
			// 1. Quiesce monitoring before draining sources so late status changes
			// cannot restart message pollers during shutdown.
			stopMonitoring();
			// 2. Drain event sources (stop + await pending work)
			await sseStream.drain();
			await statusPoller.drain();
			await pollerManager.drain();
			// 3. Shut down orchestration engine (rejects pending turns)
			await orchestration.engine.shutdown();
			// 4. Dispose Effect ManagedRuntimes
			await effectRuntime.dispose();
			await effectPersistenceRuntime?.dispose();
			// 5. Clean up remaining resources
			// Permission timeout timer is managed by PermissionTimeoutLive (auto-interrupted on dispose).
			await overrides.drain();
			ptyManager.closeAll();
			await wsHandler.drain();
		},
	};
}

// ─── Create Full Stack (Server + Relay) ─────────────────────────────────────

/**
 * Create a full relay stack with its own HTTP server.
 *
 * Creates an Effect-backed HTTP server, registers the project, starts the server, then
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

	const server = new EffectRelayServer({
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
