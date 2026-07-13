import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
// ─── Relay Stack ─────────────────────────────────────────────────────────────
// The complete relay wiring: OpenCode client, SSE consumer, event translator,
// WebSocket handler, session manager, and Effect-owned relay services.
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
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Data, Effect, Layer, ManagedRuntime } from "effect";
import { AuthManager } from "../auth.js";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	makeProjectRelayConfigLive,
	OpenCodeAPILive,
	ProjectRelayLoggerLive,
} from "../domain/relay/Layers/relay-core-layers.js";
import { RelayStateLive } from "../domain/relay/Layers/relay-layer.js";
import { StatusPollerLive } from "../domain/relay/Layers/status-poller-layer.js";
import { WebSocketHandlerLive } from "../domain/relay/Layers/websocket-handler-layer.js";
import { makeWsTransportLive } from "../domain/relay/Layers/ws-transport-layer.js";
import { AgentServiceLive } from "../domain/relay/Services/agent-service.js";
import { DirectoryListingServiceLive } from "../domain/relay/Services/directory-listing-service.js";
import {
	hasInstanceManagementConfig,
	InstanceManagementServiceFromConfigLive,
} from "../domain/relay/Services/instance-management-service.js";
import { makeEffectOpenCodeRuntimeIngress } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import { PendingInteractionServiceLive } from "../domain/relay/Services/pending-interaction-service.js";
import { ProjectManagementServiceLive } from "../domain/relay/Services/project-management-service.js";
import { makeProviderRuntimeIngestionLive } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../domain/relay/Services/provider-turn-service.js";
import {
	makeRelayCommandGateLive,
	RelayCommandGateTag,
} from "../domain/relay/Services/relay-command-gate.js";
import {
	type RelayStatusSnapshotService,
	RelayStatusSnapshotTag,
} from "../domain/relay/Services/relay-status-snapshot.js";
import { ScanServiceLive } from "../domain/relay/Services/scan-service.js";
import {
	type ConfigTag,
	type LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	type OpenCodeModelServiceTag,
	OpenCodeSettingsServiceLive,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	type OverridesStateTag,
	setDefaultAgent,
	setDefaultModel,
	setDefaultVariant,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	PollerPubSubTag,
	PollerStateTag,
} from "../domain/relay/Services/session-status-poller.js";
import {
	SSEStreamLive,
	SSEStreamTag,
} from "../domain/relay/Services/sse-stream-service.js";
import {
	LocalPtyServiceLive,
	OpenCodeTerminalServiceLive,
} from "../domain/relay/Services/terminal-service.js";
import {
	ToolContentServiceLive,
	ToolContentServiceNoop,
} from "../domain/relay/Services/tool-content-service.js";
import {
	makeStandaloneHttpRouterRequestHandler,
	type RouterProjectInfo,
} from "../domain/server/Layers/http-router-layer.js";
import { ENV } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import { setDefaultModelForRelay } from "../handlers/model.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import { createLogger, type Logger } from "../logger.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectError,
} from "../persistence/effect/live.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	getOrchestrationLayer,
	makeOrchestrationRuntimeLayer,
	type OrchestrationLayer,
} from "../provider/orchestration-wiring.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationSender } from "../server/push.js";
import { loadThemeFiles } from "../server/theme-loader.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import {
	makeWsRpcWebSocketHandler,
	type RpcWebSocketHandlerShape,
} from "../server/ws-rpc-handler.js";
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
import {
	createMonitoringWiringState,
	wireMonitoringEffect,
} from "./monitoring-wiring.js";
import { wirePollersEffect } from "./poller-wiring.js";
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";
import { makeSessionLifecycleWiringLive } from "./session-lifecycle-wiring.js";
import type { SSEStreamPort } from "./sse-stream.js";
import { wireSSEConsumerEffect } from "./sse-wiring.js";
import { PermissionTimeoutLive } from "./timer-wiring.js";
import { wireRelayWebSocketCallbacksEffect } from "./websocket-callback-wiring.js";

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
			removeProject: (slug) => this.removeProject(slug),
			getPort: () => this.actualPort,
			getIsTls: () => this.protocol === "https",
			loadThemes: loadThemeFiles,
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
	wsHandler: WebSocketHandlerShape;
	rpcWsHandler: RpcWebSocketHandlerShape;
	sseStream: SSEStreamPort;
	client: OpenCodeAPI;
	translator: ReturnType<typeof createTranslator>;
	/** Phase 5: Orchestration layer: provider registry, instances, and engine. */
	orchestration: OrchestrationLayer;
	/** Effect ManagedRuntime for dispatching through the Effect handler pipeline. */
	effectRuntime: RelayRuntime;
	/** Current read-only relay status snapshot for daemon/router status views. */
	getStatusSnapshot(): ProjectRelayStatusSnapshot;
	/** True when at least one session in this project is busy or retrying. */
	isAnySessionProcessing(): boolean;
	/** Set the relay-wide default agent through the relay-owned Effect runtime. */
	setDefaultAgent(agent: string): Promise<void>;
	/** Set the relay-wide default model through the relay-owned Effect runtime. */
	setDefaultModel(model: {
		readonly providerID: string;
		readonly modelID: string;
	}): Promise<void>;
	/** Session selected during relay startup. */
	readonly initialSessionId: string;
	/** Gracefully stop relay components (SSE + WebSocket). Does NOT stop the HTTP server. */
	stop(): Promise<void>;
}

class RelayDefaultCommandQueueClosed extends Data.TaggedError(
	"RelayDefaultCommandQueueClosed",
)<Record<never, never>> {}

type RelayDefaultCommand =
	| {
			readonly _tag: "SetDefaultAgent";
			readonly agent: string;
			readonly resolve: () => void;
			readonly reject: (cause: unknown) => void;
	  }
	| {
			readonly _tag: "SetDefaultModel";
			readonly model: {
				readonly providerID: string;
				readonly modelID: string;
			};
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

	setDefaultModel(model: {
		readonly providerID: string;
		readonly modelID: string;
	}): Promise<void> {
		return this.enqueue((resolve, reject) => ({
			_tag: "SetDefaultModel",
			model,
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
): Layer.Layer<
	never,
	never,
	| ConfigTag
	| LoggerTag
	| OpenCodeModelServiceTag
	| OverridesStateTag
	| WebSocketHandlerTag
> =>
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

			const runCommand = (command: RelayDefaultCommand) => {
				switch (command._tag) {
					case "SetDefaultAgent":
						return settle(command, setDefaultAgent(command.agent));
					case "SetDefaultModel":
						return settle(
							command,
							setDefaultModelForRelay({
								clientId: "ipc",
								provider: command.model.providerID,
								model: command.model.modelID,
							}).pipe(Effect.asVoid),
						);
				}
			};

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
}

// ─── Stack ───────────────────────────────────────────────────────────────────

export interface RelayStack {
	server: EffectRelayServer;
	wsHandler: WebSocketHandlerShape;
	rpcWsHandler: RpcWebSocketHandlerShape;
	sseStream: SSEStreamPort;
	client: OpenCodeAPI;
	translator: ReturnType<typeof createTranslator>;
	/** Session selected during relay startup. */
	readonly initialSessionId: string;

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
	const wsLog = log.child("ws");
	const sseLog = log.child("sse");
	const statusLog = log.child("status-poller");
	const pollerLog = log.child("msg-poller");
	const pipelineLog = log.child("pipeline");

	// ── Components ──────────────────────────────────────────────────────────

	// ── Orchestration runtime layer (provider instance routing) ─────────────
	const orchestrationRuntimeLayer = makeOrchestrationRuntimeLayer({
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
		...(config.persistenceDbPath != null
			? { persistenceDbPath: config.persistenceDbPath }
			: {}),
		...(config.slug != null ? { projectKey: config.slug } : {}),
	});

	const translator = createTranslator();
	let relayManagedRuntime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeContext,
		PersistenceEffectError
	>;
	// Load persisted default model and variant from relay settings
	const relaySettings = loadRelaySettings(config.configDir);
	const initialDefaultModel = parseDefaultModel(relaySettings.defaultModel);
	let initialDefaultVariant = "";
	if (initialDefaultModel) {
		log.info(`✓ Default model from settings: ${relaySettings.defaultModel}`);

		// Load persisted variant for the default model
		const modelKey = relaySettings.defaultModel;
		initialDefaultVariant = modelKey
			? (relaySettings.defaultVariants?.[modelKey] ?? "")
			: "";
		if (initialDefaultVariant) {
			log.info(`✓ Default variant from settings: ${initialDefaultVariant}`);
		}
	}

	// ── WebSocket handler ───────────────────────────────────────────────────

	let wsHandler: WebSocketHandlerShape;

	const hasInstanceManagement = hasInstanceManagementConfig(config);

	// ── Effect ManagedRuntime (Layer-based composition) ─────────────────────
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Imperative edge objects are provided as ports and merged into one Layer tree.

	const configLayer = makeProjectRelayConfigLive(config);
	const loggerLayer = ProjectRelayLoggerLive.pipe(Layer.provide(configLayer));
	const openCodeApiLayer = OpenCodeAPILive.pipe(Layer.provide(configLayer));
	const persistenceEffectLayer =
		config.persistenceDbPath != null
			? makePersistenceEffectLayer(config.persistenceDbPath)
			: undefined;
	const providerRuntimeIngestionLayer =
		persistenceEffectLayer != null
			? makeProviderRuntimeIngestionLive({
					relayPublisher: {
						publish: (msg) =>
							Effect.sync(() => {
								wsHandler.sendToSession(
									"sessionId" in msg &&
										typeof msg.sessionId === "string" &&
										msg.sessionId.length > 0
										? msg.sessionId
										: "",
									msg,
								);
							}),
					},
				}).pipe(Layer.provide(persistenceEffectLayer))
			: undefined;
	const providerOrchestrationDeps =
		persistenceEffectLayer != null
			? Layer.merge(openCodeApiLayer, persistenceEffectLayer)
			: openCodeApiLayer;
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		Layer.provide(providerOrchestrationDeps),
	);
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeModelServiceLayer = OpenCodeModelServiceLive.pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, configLayer, loggerLayer)),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const sseStreamLayer = SSEStreamLive.pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, loggerLayer)),
	);
	const projectManagementServiceLayer = ProjectManagementServiceLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, openCodeSettingsServiceLayer)),
	);
	const scanServiceLayer = ScanServiceLive.pipe(Layer.provide(configLayer));
	const webSocketHandlerLayer = WebSocketHandlerLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, loggerLayer)),
	);
	const messagePollerManagerLayer = makeMessagePollerManagerLive({
		hasViewers: (sid) => wsHandler.getClientsForSession(sid).length > 0,
	}).pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, configLayer, loggerLayer)),
	);
	const ptyRuntimeLayer = makePtyRuntimeLive().pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeApiLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
			),
		),
	);
	const openCodeTerminalServiceLayer = OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeApiLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
				ptyRuntimeLayer,
				LocalPtyServiceLive,
			),
		),
	);
	const pendingInteractionServiceLayer = PendingInteractionServiceLive;
	const toolContentServiceLayer =
		persistenceEffectLayer != null
			? ToolContentServiceLive.pipe(Layer.provideMerge(persistenceEffectLayer))
			: ToolContentServiceNoop;

	const coreBridgeLayers = Layer.mergeAll(
		openCodeApiLayer,
		openCodeFileServiceLayer,
		openCodeModelServiceLayer,
		openCodeSettingsServiceLayer,
		sseStreamLayer,
		projectManagementServiceLayer,
		DirectoryListingServiceLive,
		scanServiceLayer,
		openCodeTerminalServiceLayer,
		pendingInteractionServiceLayer,
		toolContentServiceLayer,
		webSocketHandlerLayer,
		messagePollerManagerLayer,
		ptyRuntimeLayer,
		configLayer,
		loggerLayer,
		providerOrchestrationLayer,
		...(persistenceEffectLayer != null ? [persistenceEffectLayer] : []),
		...(providerRuntimeIngestionLayer != null
			? [providerRuntimeIngestionLayer]
			: []),
	);

	// Optional bridge layers (only included when deps are present)
	// biome-ignore lint/suspicious/noExplicitAny: Layer output union is broad; callers infer correctly.
	let bridgeLayers: Layer.Layer<any, PersistenceEffectError, never> =
		coreBridgeLayers;
	if (hasInstanceManagement) {
		bridgeLayers = Layer.merge(
			bridgeLayers,
			InstanceManagementServiceFromConfigLive.pipe(Layer.provide(configLayer)),
		);
	}
	// Compose: self-constructing state layers + imperative bridge layers.
	// baseLayers are defined here; wiringLayers (PermissionTimeoutLive,
	// SessionLifecycleWiringLive) are added after monitoring state exists
	// (provides sseTracker, getMonitoringState).
	const relayStateAndBridges = Layer.provideMerge(RelayStateLive, bridgeLayers);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		StatusPollerLive,
		relayStateAndBridges,
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateBridgesAndStatus,
	);
	const baseLayers = relayStateServicesAndBridges;
	const fullBaseLayers = Layer.provideMerge(
		ProviderTurnServiceLive,
		Layer.merge(baseLayers, makeWsTransportLive({ noServer: true })),
	);

	const effectRuntime: RelayRuntime = {
		get runtime() {
			return relayManagedRuntime;
		},
		dispose: () => relayManagedRuntime.dispose(),
	};

	// ── Build ManagedRuntime with all wiring Layers ─────────────────────────
	// Monitoring state is created before the runtime so lifecycle wiring and
	// monitoring wiring share one view, while the poller manager itself remains
	// runtime-owned by MessagePollerManagerLive.
	const monitoringStateAccess = createMonitoringWiringState();
	const defaultCommandQueue = new RelayDefaultCommandQueue();
	const sessionLifecycleWiringLayer = makeSessionLifecycleWiringLive({
		translator,
		sseTracker: monitoringStateAccess.sseTracker,
		getMonitoringState: monitoringStateAccess.getMonitoringState,
		setMonitoringState: monitoringStateAccess.setMonitoringState,
	});
	const wiringLayers = Layer.mergeAll(
		PermissionTimeoutLive,
		sessionLifecycleWiringLayer,
		makeRelayDefaultCommandQueueLive(defaultCommandQueue),
		makeRelayCommandGateLive(config.slug),
	).pipe(Layer.provide(baseLayers));
	const fullLayer = Layer.provideMerge(wiringLayers, fullBaseLayers);
	relayManagedRuntime = ManagedRuntime.make(fullLayer);
	let stopMonitoring = () => {};
	let startup: {
		api: OpenCodeAPI;
		wsHandler: WebSocketHandlerShape;
		rpcWsHandler: RpcWebSocketHandlerShape;
		sseStream: SSEStreamPort;
		sessionId: string;
		orchestration: OrchestrationLayer;
		statusSnapshot: RelayStatusSnapshotService;
	};
	try {
		if (config.signal?.aborted) {
			throw new RelayCreationAbortedError({ slug: config.slug });
		}
		// External startup boundary for createProjectRelay()'s Promise API.
		// The startup Effect owns relay acquisition, wiring, and readiness.
		startup = await relayManagedRuntime.runPromise(
			Effect.gen(function* () {
				const api = yield* OpenCodeAPITag;
				const wsHandler = yield* WebSocketHandlerTag;
				const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
					runtime: relayManagedRuntime,
				});
				const statusSnapshot = yield* RelayStatusSnapshotTag;
				const sseStream = yield* SSEStreamTag;
				const opencodePathCheck = yield* Effect.either(
					Effect.tryPromise({
						try: () => api.app.path(),
						catch: (cause) => cause,
					}),
				);
				const opencodeAvailable = opencodePathCheck._tag === "Right";
				if (opencodeAvailable) {
					yield* Effect.sync(() =>
						log.info(`✓ OpenCode is reachable at ${config.opencodeUrl}`),
					);
				} else {
					yield* Effect.sync(() =>
						log.warn(
							`OpenCode is unavailable at ${config.opencodeUrl}: ${
								opencodePathCheck.left instanceof Error
									? opencodePathCheck.left.message
									: String(opencodePathCheck.left)
							}; continuing so other providers can load`,
						),
					);
				}

				let defaultModel = initialDefaultModel;
				if (!defaultModel) {
					const configResult = yield* Effect.either(
						Effect.tryPromise(() => api.config.get()),
					);
					if (configResult._tag === "Right") {
						const configModel =
							typeof configResult.right?.["model"] === "string"
								? configResult.right["model"]
								: "";
						if (configModel) {
							const slashIdx = configModel.indexOf("/");
							const provider =
								slashIdx > 0 ? configModel.slice(0, slashIdx) : "";
							const modelId =
								slashIdx > 0 ? configModel.slice(slashIdx + 1) : configModel;
							if (provider && modelId) {
								defaultModel = {
									providerID: provider,
									modelID: modelId,
								};
								yield* Effect.sync(() =>
									log.info(
										`✓ Default model from project config: ${configModel}`,
									),
								);
							}
						}
					} else {
						yield* Effect.sync(() =>
							log.warn(
								`Config API unavailable: ${formatErrorDetail(configResult.left)}`,
							),
						);
					}
				}

				const sessionManagerService = yield* SessionManagerServiceTag;
				const sessionId = opencodeAvailable
					? yield* sessionManagerService.initialize(config.sessionTitle)
					: yield* Effect.gen(function* () {
							const readQueryEffectOption =
								yield* Effect.serviceOption(ReadQueryEffectTag);
							if (readQueryEffectOption._tag === "None") {
								return "";
							}
							const sessionsResult = yield* Effect.either(
								readQueryEffectOption.value.listSessions(),
							);
							if (
								sessionsResult._tag === "Right" &&
								sessionsResult.right.length > 0
							) {
								yield* statusSnapshot.setSessionCount(
									sessionsResult.right.length,
								);
								const topLevel = sessionsResult.right.find(
									(session) => !session.parent_id,
								);
								return (topLevel ?? sessionsResult.right[0])?.id ?? "";
							}
							if (sessionsResult._tag === "Left") {
								yield* Effect.sync(() =>
									log.warn(
										`Session list unavailable while OpenCode is down: ${formatErrorDetail(sessionsResult.left)}`,
									),
								);
							}
							return "";
						});
				const orchestration = yield* getOrchestrationLayer;
				yield* PollerStateTag;
				yield* PollerPubSubTag;
				if (defaultModel) {
					yield* setDefaultModel(defaultModel);
				}
				if (initialDefaultVariant) {
					yield* setDefaultVariant(initialDefaultVariant);
				}
				const statusPoller = yield* StatusPollerTag;
				const pollerManager = yield* PollerManagerTag;
				const opencodeRuntimeIngress =
					persistenceEffectLayer != null
						? yield* makeEffectOpenCodeRuntimeIngress(
								log.child("opencode-runtime-ingress"),
							)
						: undefined;
				if (config.signal?.aborted) {
					return yield* Effect.fail(
						new RelayCreationAbortedError({ slug: config.slug }),
					);
				}
				yield* Effect.sync(() => {
					orchestration.wireSSEToInstance((event, handler) => {
						sseStream.on(event, handler);
					});
				});
				yield* wireRelayWebSocketCallbacksEffect({
					wsHandler,
					log: wsLog,
					clientInitOptions: {
						...(config.getInstances != null && {
							getInstances: config.getInstances,
						}),
						...(config.getCachedUpdate != null && {
							getCachedUpdate: config.getCachedUpdate,
						}),
					},
				});
				if (opencodeAvailable) {
					const monitoring = yield* wireMonitoringEffect({
						client: api,
						wsHandler,
						pollerManager,
						sseStream,
						config: {
							...(config.pollerGatingConfig != null && {
								pollerGatingConfig: config.pollerGatingConfig,
							}),
							...(config.pushManager != null && {
								pushManager: config.pushManager,
							}),
							slug: config.slug,
						},
						statusLog,
						sseLog,
						pipelineLog,
						state: monitoringStateAccess,
					});
					yield* Effect.sync(() => {
						stopMonitoring = monitoring.stopMonitoring;
					});
					yield* wirePollersEffect({
						pollerManager,
						sseStream,
						wsHandler,
						pipelineDeps: monitoring.pipelineDeps,
						sseTracker: monitoringStateAccess.sseTracker,
						config: {
							...(config.pushManager != null && {
								pushManager: config.pushManager,
							}),
							slug: config.slug,
						},
						pollerLog,
						onDoneProcessed: monitoring.recordDoneDelivered,
					});
					yield* wireSSEConsumerEffect(
						{
							translator,
							wsHandler,
							...(config.pushManager != null && {
								pushManager: config.pushManager,
							}),
							log: sseLog,
							pipelineLog,
							getSessionStatuses: () => statusPoller.getCurrentStatuses(),
							listPendingQuestions: () => api.question.list(),
							listPendingPermissions: () => api.permission.list(),
							statusPoller,
							slug: config.slug,
							onDoneProcessed: monitoring.recordDoneDelivered,
							...(opencodeRuntimeIngress != null && {
								opencodeRuntimeIngress,
							}),
						},
						sseStream,
					);
					yield* sseStream.connectEffect();
				}
				const gate = yield* RelayCommandGateTag;
				yield* gate.markReady();
				return {
					api,
					wsHandler,
					rpcWsHandler,
					sseStream,
					sessionId,
					orchestration,
					statusSnapshot,
				};
			}),
		);
	} catch (err) {
		stopMonitoring();
		await relayManagedRuntime.dispose();
		throw err;
	}
	const api = startup.api;
	wsHandler = startup.wsHandler;
	const { rpcWsHandler, sessionId, orchestration, sseStream, statusSnapshot } =
		startup;
	log.info(`✓ Using session: ${sessionId}`);

	// ── Timer wiring (G5: permission timeouts) ─────────────────────────────
	// PermissionTimeoutLive is composed into RelayStateLive — no imperative wiring.
	// Rate limiter cleanup is handled by the Effect RateLimiterLive scoped fiber.

	// ── Return project relay ────────────────────────────────────────────────
	const getProjectRelayStatusSnapshot = (): ProjectRelayStatusSnapshot => {
		return {
			...statusSnapshot.getSnapshot(),
			clients: wsHandler.getClientCount(),
		};
	};

	return {
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

		setDefaultModel(model) {
			return defaultCommandQueue.setDefaultModel(model);
		},

		async stop() {
			// Quiesce monitoring before runtime disposal so late status changes
			// cannot restart message pollers during scoped shutdown.
			stopMonitoring();
			await rpcWsHandler.drain();
			// Scoped finalizers own SSE drain, command-gate stop, provider instance
			// shutdown, status-poller drain, and other Effect-managed resources.
			await effectRuntime.dispose();
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

	let pushMgr: PushNotificationSender | undefined = config.pushManager;
	if (!pushMgr) {
		try {
			const { PushNotificationManager } = await import("../server/push.js");
			const manager = new PushNotificationManager();
			await manager.init();
			pushMgr = manager;
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
		throw new RelayHttpServerUnavailableError();
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
	server.addProject({
		slug: config.slug,
		directory: config.projectDir,
		title: config.slug,
		getClientCount: () => relay.getStatusSnapshot().clients,
		getSessionCount: () => relay.getStatusSnapshot().sessionCount,
		getIsProcessing: () => relay.getStatusSnapshot().isProcessing,
	});

	// ── WebSocket upgrade handler ───────────────────────────────────────────
	// Routes connections by URL: /p/{slug}/ws → project relay, /p/{slug}/rpc
	// → project RPC, /ws → initial relay, /rpc → initial RPC.
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

		// Route /p/{slug}/ws or /p/{slug}/rpc → project relay endpoint
		const projectMatch = req.url?.match(/^\/p\/([^/]+)\/(ws|rpc)(?:\?|$)/);
		if (projectMatch) {
			// biome-ignore lint/style/noNonNullAssertion: safe — regex match guarantees capture group
			const target = relays.get(projectMatch[1]!);
			if (target) {
				if (projectMatch[2] === "rpc") {
					target.rpcWsHandler.handleUpgrade(req, socket, head);
				} else {
					target.wsHandler.handleUpgrade(req, socket, head);
				}
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
		if (req.url === "/rpc" || req.url?.startsWith("/rpc?")) {
			relay.rpcWsHandler.handleUpgrade(req, socket, head);
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
