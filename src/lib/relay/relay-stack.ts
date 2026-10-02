// The complete relay wiring: OpenCode client, SSE consumer, event translator,
// WebSocket handler, session manager, and Effect-owned relay services.
//
// Extracted from skeleton.ts so integration tests exercise the exact same
// wiring as production. skeleton.ts is now a thin CLI wrapper around this.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Cause, Data, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { WebSocketServer } from "ws";
import { AuthManager } from "../auth.js";
import { WsRpcError } from "../contracts/ws-rpc.js";
import type { SessionManagerError } from "../domain/relay/Services/session-manager-error.js";
import {
	type OverridesStateTag,
	setDefaultAgent,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	makeStandaloneHttpRouterRequestHandler,
	type RouterProjectInfo,
} from "../domain/server/Layers/http-router-layer.js";
import { ENV } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger, type Logger } from "../logger.js";
import type { OrchestrationLayer } from "../provider/orchestration-wiring.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationSender } from "../server/push.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import {
	makeRoutedWsRpcWebSocketHandler,
	RoutedWsRpcWebSocketHandlerTag,
	type RpcWebSocketHandlerShape,
} from "../server/ws-rpc-handler.js";
import { settleIdleSessions } from "../session/auto-settle-sweep.js";
import { makeSessionBackgroundLiveness } from "../session/background-liveness.js";
import type { ConnectionHealth, ProjectRelayConfig } from "../types.js";
import { generateSlug } from "../utils.js";

import type { createTranslator } from "./event-translator.js";

export { publishProviderRelayMessage } from "./project-relay-publisher.js";

import {
	createProjectRelayLayers,
	type RelayRuntime,
} from "./project-relay-layers.js";
import { startProjectRelay } from "./project-relay-startup.js";
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";
import type { SSEStreamPort } from "./sse-stream.js";

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

export class RelayCreationAbortedError extends Data.TaggedError(
	"RelayCreationAbortedError",
)<{
	readonly slug: string;
}> {
	override get message(): string {
		return `Relay creation aborted for ${this.slug}`;
	}
}

export class RelayHttpServerUnavailableError extends Data.TaggedError(
	"RelayHttpServerUnavailableError",
)<Record<never, never>> {
	override get message(): string {
		return "HTTP server not available after start()";
	}
}

export class RelayProjectDirectoryError extends Data.TaggedError(
	"RelayProjectDirectoryError",
)<{
	readonly directory: string;
	readonly reason: "missing" | "not-directory";
}> {
	override get message(): string {
		return this.reason === "not-directory"
			? `Not a directory: ${this.directory}`
			: `Directory does not exist: ${this.directory}`;
	}
}

export class RelayCreationInProgressError extends Data.TaggedError(
	"RelayCreationInProgressError",
)<{
	readonly directory: string;
}> {
	override get message(): string {
		return `Relay for ${this.directory} is still being created`;
	}
}

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
		pushManager?: PushNotificationSender;
	};

	constructor(
		options: {
			port?: number;
			host?: string;
			staticDir?: string;
			pin?: string;
			tls?: { key: Buffer; cert: Buffer; caRoot?: string };
			pushManager?: PushNotificationSender;
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

		const requestHandler = makeStandaloneHttpRouterRequestHandler({
			auth: this.auth,
			staticDir: this.staticDir,
			getProjects,
			getPort: () => this.actualPort,
			getIsTls: () => this.protocol === "https",
			pushManager: this.options.pushManager,
			caRootPath: this.options.tls?.caRoot,
		});

		await new Promise<void>((resolveStart, rejectStart) => {
			const handler = (req: IncomingMessage, res: ServerResponse) =>
				void requestHandler.handleRequest(req, res);

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
	settleIdleSessions(
		idleWindowMs: number,
		now: number,
	): Effect.Effect<number, SqlError | SessionManagerError>;
	wsHandler: WebSocketHandlerShape;
	rpcWsHandler: RpcWebSocketHandlerShape;
	sseStream: SSEStreamPort;
	client: OpenCodeAPI;
	translator: ReturnType<typeof createTranslator>;
	/** Orchestration layer: provider registry, instances, and engine. */
	orchestration: OrchestrationLayer;
	/** Effect ManagedRuntime for dispatching through the Effect handler pipeline. */
	effectRuntime: RelayRuntime;
	/** Current read-only relay status snapshot for daemon/router status views. */
	getStatusSnapshot(): ProjectRelayStatusSnapshot;
	/** True when at least one session in this project is busy or retrying. */
	isAnySessionProcessing(): boolean;
	/** Set the relay-wide default agent through the relay-owned Effect runtime. */
	setDefaultAgent(agent: string): Promise<void>;
	/** Session selected during relay startup. */
	readonly initialSessionId: string;
	/** Gracefully stop relay components (SSE + WebSocket). Does NOT stop the HTTP server. */
	stop(): Promise<void>;
}

class RelayDefaultCommandQueueClosed extends Data.TaggedError(
	"RelayDefaultCommandQueueClosed",
)<Record<never, never>> {}

type RelayDefaultCommand = {
	readonly _tag: "SetDefaultAgent";
	readonly agent: string;
	readonly resolve: () => void;
	readonly reject: (cause: unknown) => void;
};

type RelayDefaultCommandResume = (
	effect: Effect.Effect<RelayDefaultCommand, RelayDefaultCommandQueueClosed>,
) => void;

class RelayDefaultCommandQueue {
	private pending: RelayDefaultCommand[] = [];
	private takers: RelayDefaultCommandResume[] = [];
	private closed = false;

	setDefaultAgent(agent: string): Promise<void> {
		return this.enqueue((resolve, reject) => ({
			_tag: "SetDefaultAgent",
			agent,
			resolve,
			reject,
		}));
	}

	take(): Effect.Effect<RelayDefaultCommand, RelayDefaultCommandQueueClosed> {
		return Effect.async<RelayDefaultCommand, RelayDefaultCommandQueueClosed>(
			(resume) => {
				const command = this.pending.shift();
				if (command) {
					resume(Effect.succeed(command));
					return;
				}
				if (this.closed) {
					resume(Effect.fail(new RelayDefaultCommandQueueClosed()));
					return;
				}
				this.takers.push(resume);
				return Effect.sync(() => {
					this.takers = this.takers.filter((taker) => taker !== resume);
				});
			},
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const error = new RelayDefaultCommandQueueClosed();
		for (const command of this.pending.splice(0)) {
			command.reject(error);
		}
		for (const taker of this.takers.splice(0)) {
			taker(Effect.fail(error));
		}
	}

	private enqueue(
		makeCommand: (
			resolve: () => void,
			reject: (cause: unknown) => void,
		) => RelayDefaultCommand,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.closed) {
				reject(new RelayDefaultCommandQueueClosed());
				return;
			}
			const command = makeCommand(resolve, reject);
			const taker = this.takers.shift();
			if (taker) {
				taker(Effect.succeed(command));
				return;
			}
			this.pending.push(command);
		});
	}
}

const makeRelayDefaultCommandQueueLive = (
	queue: RelayDefaultCommandQueue,
): Layer.Layer<never, never, OverridesStateTag> =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const settle = <R>(
				command: RelayDefaultCommand,
				effect: Effect.Effect<void, unknown, R>,
			) =>
				effect.pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) =>
							Effect.sync(() => command.reject(Cause.squash(cause))),
						onSuccess: () => Effect.sync(() => command.resolve()),
					}),
				);

			const runCommand = (command: RelayDefaultCommand) =>
				settle(command, setDefaultAgent(command.agent));

			yield* Effect.addFinalizer(() => Effect.sync(() => queue.close()));
			yield* Effect.forkScoped(
				Effect.forever(
					queue.take().pipe(
						Effect.flatMap(runCommand),
						Effect.catchTag(
							"RelayDefaultCommandQueueClosed",
							() => Effect.interrupt,
						),
					),
				),
			);
		}),
	);

export interface ProjectRelayStatusSnapshot {
	readonly sessionCount: number;
	readonly clients: number;
	readonly isProcessing: boolean;
	/** Health of this project's default OpenCode SSE stream. */
	readonly sse: ConnectionHealth;
}

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
	pushManager?: PushNotificationSender;
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
	/** SQLite event-store path for the durable persistence pipeline. */
	persistenceDbPath: string;
	/** Test seam forwarded to createProjectRelay. */
	claudeSdk?: ProjectRelayConfig["claudeSdk"];
}

export interface RelayStack {
	server: EffectRelayServer;
	wsHandler: WebSocketHandlerShape;
	rpcWsHandler: RpcWebSocketHandlerShape;
	sseStream: SSEStreamPort;
	client: OpenCodeAPI;
	translator: ReturnType<typeof createTranslator>;
	/** Initial project relay's orchestration view (provider instances/engine). */
	orchestration: OrchestrationLayer;
	/** Session selected during relay startup. */
	readonly initialSessionId: string;

	/** The port the HTTP server is actually listening on (useful when port=0) */
	getPort(): number;
	/** The base URL of the relay server */
	getBaseUrl(): string;
	/** Stop all components */
	stop(): Promise<void>;
}

/**
 * Create a per-project relay that attaches to an existing HTTP server.
 *
 * Sets up all relay components (OpenCode client, SSE consumer, translator,
 * session manager, WebSocket handler, and Effect-owned services) and wires the full event
 * pipeline. Does NOT create or manage an HTTP server — the caller owns it.
 *
 * Used by both `createRelayStack()` (for standalone/skeleton mode) and the
 * daemon (which has its own HTTP server).
 */
export async function createProjectRelay(
	config: ProjectRelayConfig,
): Promise<ProjectRelay> {
	const log = config.log ?? createLogger("relay");
	// Background liveness is created before startup supplies its broadcaster.
	let broadcastBackgroundSessionLists: (() => void) | undefined;
	const backgroundLiveness = makeSessionBackgroundLiveness(() =>
		broadcastBackgroundSessionLists?.(),
	);
	const wsLog = log.child("ws");
	const sseLog = log.child("sse");
	const statusLog = log.child("status-poller");
	const pollerLog = log.child("msg-poller");
	const pipelineLog = log.child("pipeline");

	// Load persisted default model and variant from relay settings
	const relaySettings = loadRelaySettings(config.configDir);
	const initialDefaultModel = parseDefaultModel(relaySettings.defaultModel);
	const initialDefaultVariant =
		initialDefaultModel && relaySettings.defaultModel
			? (relaySettings.defaultVariants?.[relaySettings.defaultModel] ?? "")
			: "";
	if (initialDefaultModel) {
		log.info(`✓ Default model from settings: ${relaySettings.defaultModel}`);
		if (initialDefaultVariant) {
			log.info(`✓ Default variant from settings: ${initialDefaultVariant}`);
		}
	}

	// Publisher and viewer callbacks in the Layer graph run after startup supplies the handler.
	let wsHandler: WebSocketHandlerShape;

	const defaultCommandQueue = new RelayDefaultCommandQueue();
	const layers = createProjectRelayLayers({
		config,
		backgroundLiveness,
		getWsHandler: () => wsHandler,
		defaultCommandQueueLayer:
			makeRelayDefaultCommandQueueLive(defaultCommandQueue),
	});
	const { effectRuntime } = layers;
	const startup = await startProjectRelay({
		config,
		log,
		wsLog,
		sseLog,
		statusLog,
		pollerLog,
		pipelineLog,
		relaySettings,
		initialDefaultModel,
		initialDefaultVariant,
		layers,
	});
	broadcastBackgroundSessionLists = startup.broadcastBackgroundSessionLists;
	const api = startup.api;
	wsHandler = startup.wsHandler;
	const {
		rpcWsHandler,
		sessionId,
		orchestration,
		sseStream,
		statusSnapshot,
		translator,
	} = startup;
	log.info(`✓ Using session: ${sessionId}`);

	// Timer wiring (G5: permission timeouts)
	// PermissionTimeoutLive is composed into RelayStateLive — no imperative wiring.
	// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.

	const getProjectRelayStatusSnapshot = (): ProjectRelayStatusSnapshot => {
		return {
			...statusSnapshot.getSnapshot(),
			clients: wsHandler.getClientCount(),
			sse: sseStream.getHealth(),
		};
	};

	return {
		settleIdleSessions: (idleWindowMs, now) =>
			settleIdleSessions(
				{
					hasViewer: (id) => wsHandler.getClientsForSession(id).length > 0,
					hasLiveBackgroundWork: backgroundLiveness.hasLiveWork,
					setSettled: (id) =>
						startup.sessionManagerService.setSessionSettled(id, {
							settled: true,
							automatic: true,
						}),
					broadcastSessionList: () =>
						startup.sessionManagerService.pushViewerFamilies(),
				},
				idleWindowMs,
				now,
			).pipe(Effect.provideService(SqlClient.SqlClient, startup.sql)),
		wsHandler,
		rpcWsHandler,
		sseStream,
		client: api,
		translator,
		orchestration,
		effectRuntime,
		initialSessionId: sessionId,

		getStatusSnapshot: getProjectRelayStatusSnapshot,

		isAnySessionProcessing() {
			return getProjectRelayStatusSnapshot().isProcessing;
		},

		setDefaultAgent(agent: string) {
			return defaultCommandQueue.setDefaultAgent(agent);
		},

		async stop() {
			// Quiesce monitoring before runtime disposal so late status changes
			// cannot restart message pollers during scoped shutdown.
			startup.stopMonitoring();
			startup.opencodeRuntimeIngress.shutdown();
			await rpcWsHandler.drain();
			// Scoped finalizers own SSE drain, command-gate stop, provider instance
			// shutdown, status-poller drain, and other Effect-managed resources.
			await effectRuntime.dispose();
		},
	};
}

// Create Full Stack (Server + Relay)

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

	const pushMgr =
		config.pushManager ??
		(await import("../server/push.js")
			.then(async ({ PushNotificationManager }) => {
				const manager = new PushNotificationManager();
				await manager.init();
				return manager;
			})
			.catch(() => undefined));

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
		throw new RelayHttpServerUnavailableError();
	}
	// Assign to a fresh const so TypeScript narrows to non-null in closures.
	const httpServer = maybeServer;

	// The server owns browser upgrades and attaches /ws sockets to the initial relay.
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
			throw new RelayProjectDirectoryError({
				directory,
				reason: dirStat ? "not-directory" : "missing",
			});
		}

		const existingSlugs = new Set(relays.keys());
		const slug = generateSlug(directory, existingSlugs);
		const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
		const title = parts[parts.length - 1] ?? "project";

		// Guard against concurrent creation for the same slug
		if (relays.has(slug) || pendingSlugs.has(slug)) {
			const existing = relays.get(slug);
			if (existing) return { slug, title, directory };
			throw new RelayCreationInProgressError({ directory });
		}

		pendingSlugs.add(slug);
		try {
			// Create relay FIRST — if this throws, nothing is registered
			// Beside the stack's own store, so a caller's temp-dir cleanup covers it.
			const persistenceDbPath = join(
				dirname(config.persistenceDbPath),
				`${slug}.events.db`,
			);
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
				persistenceDbPath,
				...(pushMgr != null && { pushManager: pushMgr }),
				...(config.configDir != null && { configDir: config.configDir }),
			});

			// Only register AFTER relay is successfully created
			relays.set(slug, newRelay);
			server.addProject({
				slug,
				directory,
				title,
				getClientCount: () => newRelay.getStatusSnapshot().clients,
				getSessionCount: () => newRelay.getStatusSnapshot().sessionCount,
				getIsProcessing: () => newRelay.getStatusSnapshot().isProcessing,
			});

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
		persistenceDbPath: config.persistenceDbPath,
		...(config.claudeSdk != null && { claudeSdk: config.claudeSdk }),
	});
	relays.set(config.slug, relay);
	server.addProject({
		slug: config.slug,
		directory: config.projectDir,
		title: config.slug,
		getClientCount: () => relay.getStatusSnapshot().clients,
		getSessionCount: () => relay.getStatusSnapshot().sessionCount,
		getIsProcessing: () => relay.getStatusSnapshot().isProcessing,
	});

	// Owns /ws upgrades and attaches sockets to the initial relay.
	// /rpc uses per-request project routing.
	// Also checks auth when a PIN is configured (fixes pre-existing gap where
	// standalone WS connections bypassed PIN auth).

	const rpcRuntime = ManagedRuntime.make(
		Layer.scoped(
			RoutedWsRpcWebSocketHandlerTag,
			makeRoutedWsRpcWebSocketHandler(
				(slug) =>
					Effect.suspend(() => {
						const context = relays.get(slug)?.rpcWsHandler.context;
						const unavailable = () =>
							new WsRpcError({ message: `Project "${slug}" unavailable` });
						return context
							? context.pipe(
									Effect.mapError(unavailable),
									Effect.catchAllDefect(() => Effect.fail(unavailable())),
								)
							: Effect.fail(unavailable());
					}),
				undefined,
				config.slug,
			),
		),
	);

	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 50 * 1024 * 1024,
		perMessageDeflate: {
			serverMaxWindowBits: 10,
			zlibDeflateOptions: { level: 1 },
		},
	});
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

		// Route /ws → initial relay
		if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
			wss.handleUpgrade(req, socket, head, (ws) => {
				const params = new URL(req.url ?? "/ws", "http://localhost")
					.searchParams;
				const requestedClientId = params.get("client") ?? "";
				const clientId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestedClientId)
					? requestedClientId
					: randomBytes(8).toString("hex");
				const requestedSessionId = params.get("session") || undefined;
				ws.send(
					JSON.stringify({ type: "project_attached", slug: config.slug }),
				);
				relay.wsHandler.attach(ws, {
					clientId,
					...(requestedSessionId != null && { requestedSessionId }),
				});
			});
			return;
		}
		if (req.url === "/rpc" || req.url?.startsWith("/rpc?")) {
			rpcRuntime
				.runFork(
					Effect.gen(function* () {
						const handler = yield* RoutedWsRpcWebSocketHandlerTag;
						handler.handleUpgrade(req, socket, head);
					}),
				)
				.addObserver((exit) => {
					if (Exit.isFailure(exit) && !socket.destroyed) socket.destroy();
				});
			return;
		}

		socket.destroy();
	});

	const urls = server.getUrls();
	log.info(`✓ Server listening: ${urls.local}`);

	return {
		server,
		wsHandler: relay.wsHandler,
		rpcWsHandler: relay.rpcWsHandler,
		sseStream: relay.sseStream,
		client: relay.client,
		translator: relay.translator,
		orchestration: relay.orchestration,
		initialSessionId: relay.initialSessionId,

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
			await rpcRuntime.dispose();
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
			for (const ws of wss.clients) ws.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await server.stop();
		},
	};
}
