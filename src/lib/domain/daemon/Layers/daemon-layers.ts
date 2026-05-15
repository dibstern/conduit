// ─── Daemon Lifecycle Layers ────────────────────────────────────────────────
// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import type { Rpc, RpcGroup } from "@effect/rpc";
import {
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Ref,
	Runtime,
	Stream,
} from "effect";
import {
	closeHttpServer,
	closeIPCServer,
	closeOnboardingServer,
	type DaemonLifecycleContext,
	dispatchTaggedRequestEffect,
	type HttpServerStartConfig,
	type IpcPostResponseActions,
	type OnboardingServerDeps,
	type OnboardingServerStartConfig,
	startHttpServer,
	startIPCServer,
	startOnboardingServer,
	type TaggedIpcDispatcher,
} from "../../../daemon/daemon-lifecycle.js";
import {
	removePidFile,
	removeSocketFile,
	writePidFile,
} from "../../../daemon/pid-manager.js";
import type { StoredProject } from "../../../types.js";
import { generateSlug } from "../../../utils.js";
import { AuthManagerFromConfigLive } from "../../server/Layers/auth-middleware.js";
import {
	DaemonHttpRequestHandlerTag,
	makeDaemonHttpRouterLive,
} from "../../server/Layers/http-router-layer.js";
import {
	WebSocketRelayRouterLive,
	WebSocketRoutingLive,
} from "../../server/Layers/ws-routing-layer.js";
import { PushNotificationManagerLive } from "../../server/Services/push-service.js";
import {
	loadConfig,
	PersistencePathTag,
} from "../Services/daemon-config-persistence.js";
import {
	commitDaemonRuntimeConfig,
	type DaemonConfigMirror,
	DaemonConfigMirrorLive,
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../Services/daemon-config-ref.js";
import { DaemonHandleLive } from "../Services/daemon-handle.js";
import {
	DaemonLifecycleContextLive,
	DaemonLifecycleContextTag,
} from "../Services/daemon-lifecycle-context.js";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
} from "../Services/daemon-pubsub.js";
import { CrashCounterLive } from "../Services/daemon-startup.js";
import {
	DaemonStateTag,
	emptyDaemonState,
	makeDaemonStateLive,
} from "../Services/daemon-state.js";
import {
	getInstances as getEffectInstances,
	getInstanceUrl,
	InstanceManagerStateTag,
	makeInstanceManagerStateFromDaemonStateLive,
	makeInstanceManagerStateLive,
	type PollerFibersTag,
	startInitialUnmanagedInstanceHealthPollers,
} from "../Services/instance-manager-service.js";
import {
	IpcHandlersLayer,
	type IpcRpcGroup,
} from "../Services/ipc-rpc-group.js";
import {
	addWithoutRelay as addEffectProjectWithoutRelay,
	findByDirectory,
	allProjects as getAllEffectProjects,
	getProject,
	makeProjectRegistryFromDaemonStateLive,
	makeProjectRegistryLive,
	ProjectRegistryTag,
	remove as removeEffectProject,
	replaceRelay as replaceEffectRelay,
	updateProject as updateEffectProject,
} from "../Services/project-registry-service.js";
import {
	makeRelayCacheService,
	type RelayCache,
	RelayCacheTag,
} from "../Services/relay-cache.js";
import {
	ConfigPersistenceLive,
	ConfigPersistenceTag,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "./config-persistence-layer.js";
import { KeepAwakeLive, KeepAwakeTag } from "./keep-awake-layer.js";
import { PinoLoggerLive } from "./pino-logger-layer.js";
import { PortScannerLive, PortScannerTag } from "./port-scanner-layer.js";
import { ProjectDiscoveryLive } from "./project-discovery-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryError,
	RelayFactoryLive,
	RelayFactoryTag,
} from "./relay-factory-layer.js";
import { SessionPrefetchLive } from "./session-prefetch-layer.js";
import {
	StorageMonitorLive,
	StorageMonitorTag,
} from "./storage-monitor-layer.js";
import { EnsureCertsLive, TlsCertLive, TlsCertTag } from "./tls-cert-layer.js";
import {
	VersionCheckerLive,
	VersionCheckerTag,
} from "./version-checker-layer.js";

/** Shutdown signal — Deferred that completes when SIGTERM/SIGINT received. */
export class ShutdownSignalTag extends Context.Tag("ShutdownSignal")<
	ShutdownSignalTag,
	Deferred.Deferred<void>
>() {}

export class DaemonLifecycleLayerError extends Data.TaggedError(
	"DaemonLifecycleLayerError",
)<{
	operation: string;
	cause: unknown;
}> {
	get message(): string {
		const inner =
			this.cause instanceof Error ? this.cause.message : String(this.cause);
		return `${this.operation} failed: ${inner}`;
	}
}

const startLifecycleServer = (operation: string, start: () => Promise<void>) =>
	Effect.tryPromise({
		try: start,
		catch: (cause) => new DaemonLifecycleLayerError({ operation, cause }),
	});

const loggedFinalizerPromise = (operation: string, run: () => Promise<void>) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new DaemonLifecycleLayerError({ operation, cause }),
	}).pipe(
		Effect.catchAll((error) =>
			Effect.logError(`${operation} failed during shutdown`, error),
		),
	);

const closeLifecycleServer = (operation: string, close: () => Promise<void>) =>
	loggedFinalizerPromise(operation, close);

/**
 * Installs SIGTERM/SIGINT handlers. Completes a Deferred on signal.
 * Finalizer removes handlers to prevent leaks in tests.
 */
export const SignalHandlerLayer = Layer.scoped(
	ShutdownSignalTag,
	Effect.gen(function* () {
		const deferred = yield* Deferred.make<void>();

		const onShutdown = () => {
			Deferred.unsafeDone(deferred, Effect.void);
		};
		const onReload = () => {
			// SIGHUP — config reload placeholder
		};

		process.on("SIGTERM", onShutdown);
		process.on("SIGINT", onShutdown);
		process.on("SIGHUP", onReload);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.removeListener("SIGTERM", onShutdown);
				process.removeListener("SIGINT", onShutdown);
				process.removeListener("SIGHUP", onReload);
			}),
		);

		return deferred;
	}),
);

/**
 * Attaches unhandledRejection/uncaughtException handlers.
 * Finalizer removes them to prevent listener leaks.
 */
export const ProcessErrorHandlerLayer = Layer.scopedDiscard(
	Effect.gen(function* () {
		const onUnhandled = (reason: unknown) => {
			console.error("[daemon] Unhandled rejection:", reason);
		};
		const onUncaught = (err: Error) => {
			console.error("[daemon] Uncaught exception:", err);
		};

		process.on("unhandledRejection", onUnhandled);
		process.on("uncaughtException", onUncaught);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.removeListener("unhandledRejection", onUnhandled);
				process.removeListener("uncaughtException", onUncaught);
			}),
		);
	}),
);

// ─── Leaf Service Layers (Effect-native) ─────────────────────────────────────
// These delegate to the pure Effect Layer factories defined in the *-layer.ts
// modules. The old imperative-class bridge layers have been removed.

/**
 * KeepAwake layer — uses the pure Effect KeepAwakeLive layer.
 * Background fiber is fork-scoped; interrupted automatically on scope close.
 */
export const makeKeepAwakeLive = (options?: {
	command?: string;
	args?: string[];
}) => KeepAwakeLive(options);

/**
 * VersionChecker layer — uses the pure Effect VersionCheckerLive layer.
 * Background fiber checks periodically and broadcasts updates.
 */
export const makeVersionCheckerLive = (
	config: Parameters<typeof VersionCheckerLive>[0],
) => VersionCheckerLive(config);

/**
 * StorageMonitor layer — uses the pure Effect StorageMonitorLive layer.
 * Background fiber checks disk usage and evicts when above high-water mark.
 */
export const makeStorageMonitorLive = (
	config: Parameters<typeof StorageMonitorLive>[0],
) => StorageMonitorLive(config);

/**
 * PortScanner layer — uses the pure Effect PortScannerLive layer.
 * Background fiber scans ports with hysteresis-based removal.
 */
export const makePortScannerLive = (
	config: Parameters<typeof PortScannerLive>[0],
) => PortScannerLive(config);

// ─── Cross-service Wiring ─────────────────────────────────────────────────

/**
 * Central daemon event subscriptions. Business services expose direct methods;
 * this layer owns transitional bus bridges so subscriptions do not hide inside
 * unrelated service layers.
 */
export const DaemonWiringLive: Layer.Layer<
	never,
	never,
	DaemonEventBusTag | ConfigPersistenceTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		const persistence = yield* ConfigPersistenceTag;
		const sub = yield* PubSub.subscribe(bus);

		yield* Effect.forkScoped(
			Stream.fromQueue(sub).pipe(
				Stream.filter((event) => event._tag === "ConfigChanged"),
				Stream.runForEach(() => persistence.requestSave),
			),
		);
	}),
);

const InstanceHealthPollingLive: Layer.Layer<
	never,
	never,
	DaemonEventBusTag | InstanceManagerStateTag | PollerFibersTag
> = Layer.scopedDiscard(startInitialUnmanagedInstanceHealthPollers);

// ─── DaemonState & RelayCache Layers ──────────────────────────────────────

/**
 * DaemonState layer — loads config from disk, seeds Ref.
 * Requires FileSystem.FileSystem in the environment (for testability).
 * Provides PersistencePathTag internally.
 */
export const makeDaemonStateFromDisk = (configPath: string) =>
	Layer.effect(
		DaemonStateTag,
		Effect.gen(function* () {
			const initial = yield* loadConfig;
			return yield* Ref.make({ ...emptyDaemonState(), ...initial });
		}),
	).pipe(Layer.provide(Layer.succeed(PersistencePathTag, configPath)));

/**
 * DaemonState layer with NodeFileSystem — convenience for production use.
 * Loads config from disk using the real filesystem.
 */
export const makeDaemonStateFromDiskNode = (configPath: string) =>
	makeDaemonStateFromDisk(configPath).pipe(Layer.provide(NodeFileSystem.layer));

const resolveProjectOpencodeUrl = (project: {
	readonly slug: string;
	readonly instanceId?: string;
}) =>
	Effect.gen(function* () {
		if (project.instanceId != null) {
			return yield* getInstanceUrl(project.instanceId);
		}

		const instances = Array.from(yield* getEffectInstances);
		const first = instances[0];
		if (first == null) return null;
		return yield* getInstanceUrl(first.id);
	});

const normalizeProjectDirectory = (directory: string): string => {
	const expanded =
		directory === "~" || directory.startsWith("~/")
			? directory.replace(/^~/, homedir())
			: directory;
	return resolve(expanded);
};

const titleForDirectory = (directory: string): string =>
	basename(directory) || "project";

const addProjectToEffectRegistry = (
	directory: string,
	instanceId?: string | undefined,
) =>
	Effect.gen(function* () {
		const normalizedDirectory = normalizeProjectDirectory(directory);
		yield* commitDaemonRuntimeConfig((config) => {
			if (!config.dismissedPaths.has(normalizedDirectory)) return config;
			const dismissedPaths = new Set(config.dismissedPaths);
			dismissedPaths.delete(normalizedDirectory);
			return {
				...config,
				dismissedPaths,
			};
		});

		const existing = yield* findByDirectory(normalizedDirectory);
		if (Option.isSome(existing)) {
			return existing.value.project;
		}

		const projects = yield* getAllEffectProjects;
		const existingSlugs = new Set(projects.map((project) => project.slug));
		const project: StoredProject = {
			slug: generateSlug(normalizedDirectory, existingSlugs),
			directory: normalizedDirectory,
			title: titleForDirectory(normalizedDirectory),
			lastUsed: Date.now(),
			...(instanceId !== undefined && { instanceId }),
		};
		yield* addEffectProjectWithoutRelay(project);
		return project;
	}).pipe(Effect.withSpan("relayCache.addProjectCallback"));

export const makeRelayCacheLayer: Layer.Layer<
	RelayCacheTag,
	never,
	| RelayFactoryTag
	| ProjectRegistryTag
	| InstanceManagerStateTag
	| DaemonConfigRefTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
> = Layer.scoped(
	RelayCacheTag,
	Effect.gen(function* () {
		const relayFactory = yield* RelayFactoryTag;
		const projectRegistry = yield* ProjectRegistryTag;
		const instanceState = yield* InstanceManagerStateTag;
		const configRef = yield* DaemonConfigRefTag;
		const eventBus = yield* DaemonEventBusTag;
		const configPersistence = yield* ConfigPersistenceTag;
		const runtime = yield* Effect.runtime<never>();
		let relayCache: RelayCache | undefined;

		const runCallback = <A>(effect: Effect.Effect<A, unknown>) =>
			new Promise<A>((resolve, reject) => {
				Runtime.runCallback(runtime)(effect, {
					onExit: (exit) => {
						if (Exit.isSuccess(exit)) {
							resolve(exit.value);
							return;
						}
						reject(Cause.squash(exit.cause));
					},
				});
			});

		const provideProjectMutationDeps = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				| ProjectRegistryTag
				| DaemonConfigRefTag
				| DaemonEventBusTag
				| ConfigPersistenceTag
				| RelayCacheTag
			>,
		) => {
			if (relayCache === undefined) {
				return Effect.dieMessage("Relay cache not initialized");
			}
			return effect.pipe(
				Effect.provideService(ProjectRegistryTag, projectRegistry),
				Effect.provideService(DaemonConfigRefTag, configRef),
				Effect.provideService(DaemonEventBusTag, eventBus),
				Effect.provideService(ConfigPersistenceTag, configPersistence),
				Effect.provideService(RelayCacheTag, relayCache),
			);
		};

		const relayCacheService = yield* makeRelayCacheService((slug) =>
			Effect.gen(function* () {
				const project = yield* getProject(slug).pipe(
					Effect.provideService(ProjectRegistryTag, projectRegistry),
				);
				const opencodeUrl = yield* resolveProjectOpencodeUrl(project).pipe(
					Effect.provideService(InstanceManagerStateTag, instanceState),
				);
				if (opencodeUrl == null) {
					return yield* new RelayFactoryError({
						reason: `No OpenCode instance URL available for project "${slug}"`,
					});
				}
				const projectControls = {
					addProject: (directory: string, instanceId?: string) =>
						runCallback(
							provideProjectMutationDeps(
								addProjectToEffectRegistry(directory, instanceId),
							),
						),
					removeProject: (projectSlug: string) =>
						runCallback(
							provideProjectMutationDeps(removeEffectProject(projectSlug)),
						),
					setProjectTitle: (projectSlug: string, title: string) =>
						runCallback(
							provideProjectMutationDeps(
								updateEffectProject(projectSlug, { title }),
							),
						),
					setProjectInstance: (projectSlug: string, instanceId: string) =>
						runCallback(
							provideProjectMutationDeps(
								updateEffectProject(projectSlug, { instanceId }).pipe(
									Effect.zipRight(replaceEffectRelay(projectSlug)),
								),
							),
						),
				};
				const relay = yield* relayFactory.create(
					project,
					opencodeUrl,
					projectControls,
				);
				return {
					slug,
					wsHandler: relay.wsHandler,
					rpcWsHandler: relay.rpcWsHandler,
					getStatusSnapshot: () => relay.getStatusSnapshot(),
					setDefaultAgent: (agent: string) => relay.setDefaultAgent(agent),
					setDefaultModel: (model: {
						readonly providerID: string;
						readonly modelID: string;
					}) => relay.setDefaultModel(model),
					stop: () => relay.stop(),
				};
			}),
		);
		relayCache = relayCacheService;
		return relayCacheService;
	}),
);

// ─── Server Lifecycle Layers ──────────────────────────────────────────────

/**
 * HTTP(S) server layer — starts the HTTP (or TLS protocol-detection) server
 * and tears it down gracefully on scope close.
 */
export const HttpServerLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const ctx = yield* DaemonLifecycleContextTag;
		const configRef = yield* DaemonConfigRefTag;
		const httpServerRef = yield* HttpServerRefTag;
		const requestHandler = yield* DaemonHttpRequestHandlerTag;
		const tls = yield* TlsCertTag;
		const config = yield* Ref.get(configRef);

		const startConfig: HttpServerStartConfig = {
			port: config.port,
			host: config.host,
		};
		if (tls.certs) {
			startConfig.tls = {
				key: tls.certs.key,
				cert: tls.certs.caCertPem
					? Buffer.concat([
							tls.certs.cert,
							Buffer.from("\n"),
							tls.certs.caCertPem,
						])
					: tls.certs.cert,
			};
		}

		ctx.router = requestHandler;
		const actualPort = yield* Effect.tryPromise({
			try: () => startHttpServer(ctx, startConfig),
			catch: (cause) =>
				new DaemonLifecycleLayerError({
					operation: "startHttpServer",
					cause,
				}),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.sync(() => {
					ctx.router = null;
				}).pipe(Effect.zipRight(Effect.fail(error))),
			),
		);
		yield* Ref.set(httpServerRef, ctx.upgradeServer ?? ctx.httpServer);
		yield* commitDaemonRuntimeConfig((c) => ({ ...c, port: actualPort }));
		yield* Effect.addFinalizer(() =>
			closeLifecycleServer("closeHttpServer", () => closeHttpServer(ctx)).pipe(
				Effect.zipRight(Ref.set(httpServerRef, null)),
				Effect.zipRight(
					Effect.sync(() => {
						ctx.router = null;
					}),
				),
			),
		);
	}),
);

export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
	HttpServerLive.pipe(
		Layer.provide(Layer.succeed(DaemonLifecycleContextTag, ctx)),
	);

/**
 * IPC (Unix socket) server layer — starts the IPC server with command routing
 * and closes it on scope close.
 */
export const makeIpcServerLive = (
	postResponseActions?: IpcPostResponseActions,
) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const ctx = yield* DaemonLifecycleContextTag;
			const runtime = yield* Effect.runtime<IpcDispatchServices>();
			const shutdownSignal = yield* ShutdownSignalTag;
			const resolvedPostResponseActions = postResponseActions ?? {
				scheduleShutdown: () => {
					Deferred.unsafeDone(shutdownSignal, Effect.void);
				},
			};
			yield* startLifecycleServer("startIPCServer", () =>
				startIPCServer(
					ctx,
					makeTaggedIpcDispatcher(runtime),
					resolvedPostResponseActions,
				),
			);
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer("closeIPCServer", () => closeIPCServer(ctx)),
			);
		}),
	);

type IpcDispatchServices = Rpc.ToHandler<RpcGroup.Rpcs<typeof IpcRpcGroup>>;

function makeTaggedIpcDispatcher(
	runtime: Runtime.Runtime<IpcDispatchServices>,
): TaggedIpcDispatcher {
	return (request) =>
		new Promise((resolve, reject) => {
			Runtime.runCallback(runtime)(dispatchTaggedRequestEffect(request), {
				onExit: (exit) => {
					if (Exit.isSuccess(exit)) {
						resolve(exit.value);
						return;
					}
					reject(Cause.squash(exit.cause));
				},
			});
		});
}

/**
 * Onboarding server layer — starts an HTTP-only onboarding server when TLS is
 * active and tears it down gracefully on scope close.
 */
export const OnboardingServerLive = (staticDir: string) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const ctx = yield* DaemonLifecycleContextTag;
			const configRef = yield* DaemonConfigRefTag;
			const tls = yield* TlsCertTag;
			const config = yield* Ref.get(configRef);

			if (!tls.certs) return;

			const startConfig: OnboardingServerStartConfig = {
				httpsPort: config.port,
				listenPort: config.port === 0 ? 0 : config.port + 1,
				host: config.host,
			};
			const effectiveDeps: OnboardingServerDeps = {
				staticDir,
				caRootPath: tls.caRootPath,
				caCertDer: tls.caCertDer,
			};

			yield* Effect.tryPromise({
				try: () => startOnboardingServer(ctx, effectiveDeps, startConfig),
				catch: (cause) =>
					new DaemonLifecycleLayerError({
						operation: "startOnboardingServer",
						cause,
					}),
			});
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer("closeOnboardingServer", () =>
					closeOnboardingServer(ctx),
				),
			);
		}),
	);

export const makeOnboardingServerLive = (
	ctx: DaemonLifecycleContext,
	staticDir: string,
) =>
	OnboardingServerLive(staticDir).pipe(
		Layer.provide(Layer.succeed(DaemonLifecycleContextTag, ctx)),
	);

/**
 * PID/socket file layer — writes the PID file on acquisition,
 * removes PID and socket files on scope close.
 */
export const makePidFileLive = (
	configDir: string,
	pidPath: string,
	socketPath: string,
) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			yield* Effect.try({
				try: () => writePidFile(configDir, pidPath),
				catch: (cause) =>
					new DaemonLifecycleLayerError({
						operation: "writePidFile",
						cause,
					}),
			});
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					removePidFile(pidPath);
					removeSocketFile(socketPath);
				}),
			);
		}),
	);

// ─── Composed DaemonLive Layer ──────────────────────────────────────────────

/**
 * Options for composing the full DaemonLive layer.
 *
 * Simplified from the original DaemonLiveOptions — fields that are now
 * provided by Layers (keepAwake config, versionCheck config, storageMon
 * config, configPath) have been moved to DaemonOptions or
 * are derived internally. Only server lifecycle context (still imperative)
 * and optional background service configs remain.
 */
export interface DaemonLiveOptions {
	// Server lifecycle (still partially imperative — AP-38 deferred)
	ipcPostResponseActions?: IpcPostResponseActions;
	staticDir: string;

	/** Full runtime config snapshot used to seed DaemonConfigRef. */
	initialConfig: DaemonRuntimeConfig;
	/** Optional mirror for sync legacy DaemonHandle reads during migration. */
	configMirror?: DaemonConfigMirror;

	// Background services — Effect-native config types (all optional for phased migration)
	keepAwake?: Parameters<typeof KeepAwakeLive>[0];
	versionCheck?: Parameters<typeof VersionCheckerLive>[0];
	storageMon?: Parameters<typeof StorageMonitorLive>[0];
	portScanner?: Parameters<typeof PortScannerLive>[0];
	defaultOpencodeUrl?: string;
	smartDefault?: boolean;

	// DaemonOptions-derived values (computed by caller from DaemonOptions)
	configDir: string;
	pidPath: string;
	socketPath: string;

	// DaemonState + RelayCache (Tasks 1-4 integration)
	/** Path to daemon.json config file. When set, loads config from disk. */
	configPath?: string;
}

/**
 * Compose all daemon lifecycle Layers into a single Layer using tiered
 * `Layer.provideMerge` composition.
 *
 * Tiers (AP-37 / AP-R2-16):
 *   Tier 0 — Foundation: independent Layers with no inter-dependencies
 *   Tier 1 — Services: Layers that depend on foundation Tags
 *   Tier 2 — Registries: state containers and factories
 *   Tier 3 — Servers: imperative server lifecycle (still takes DaemonLifecycleContext)
 *   Tier 4 — Background: optional background service fibers
 *   Tier 5 — Scoped fibers: discovery, prefetch, WS routing (need registries + config)
 *
 * Each tier uses `Layer.provideMerge` so downstream tiers can access
 * upstream Tags without re-providing them. Scope finalizers run in
 * reverse order on shutdown.
 */
export const makeDaemonLive = (options: DaemonLiveOptions) => {
	const { configDir, pidPath, socketPath } = options;

	// ── Tier 0: Foundation (no inter-dependencies) ─────────────────────────
	// These Layers have zero dependencies on other Tags. They form the base
	// of the Layer stack that all subsequent tiers build on.
	const foundation = Layer.mergeAll(
		DaemonEventBusLive,
		PinoLoggerLive,
		DaemonConfigRefLive(options.initialConfig),
		options.configMirror
			? DaemonConfigMirrorLive(options.configMirror)
			: Layer.empty,
		DaemonLifecycleContextLive(socketPath),
		SignalHandlerLayer,
		ProcessErrorHandlerLayer,
		makePidFileLive(configDir, pidPath, socketPath),
		CrashCounterLive,
		makeConfigWriterLive(configDir),
	);

	// ── Tier 1: Services needing foundation ────────────────────────────────
	// These Layers depend on Tags from Tier 0 (primarily DaemonConfigRefTag).
	// Layer.provideMerge makes Tier 0 Tags available AND passes them through.
	//
	// TlsCertLive depends on both DaemonConfigRefTag (Tier 0) and EnsureCertsTag.
	// EnsureCertsLive is provided to TlsCertLive directly (intra-tier dependency).
	const tlsCertWithDeps = TlsCertLive(configDir).pipe(
		Layer.provide(EnsureCertsLive),
	);
	const services = Layer.mergeAll(
		AuthManagerFromConfigLive,
		tlsCertWithDeps,
		EnsureCertsLive,
		PushNotificationManagerLive(configDir),
	).pipe(Layer.provideMerge(foundation));

	const versionCheckLayer = options.versionCheck
		? makeVersionCheckerLive(options.versionCheck)
		: Layer.succeed(VersionCheckerTag, {
				getLatestKnown: () => Effect.succeed(null),
				getCurrentVersion: () => Effect.succeed("unknown"),
			});
	const portScannerLayer = options.portScanner
		? makePortScannerLive(options.portScanner)
		: Layer.succeed(PortScannerTag, {
				getKnownPorts: () => Effect.succeed(new Set<number>()),
				scanNow: () => Effect.succeed({ discovered: [], lost: [], active: [] }),
			});
	const auxiliaryServices = Layer.mergeAll(
		versionCheckLayer,
		portScannerLayer,
	).pipe(Layer.provideMerge(services));

	// ── Tier 2: Registries + state containers ──────────────────────────────
	// State containers and factories. ProjectRegistryLive and
	// InstanceManagerStateLive have no construction deps but are logically
	// grouped here. RelayFactoryLive needs DaemonConfigRefTag (from Tier 0,
	// available via Tier 1's provideMerge passthrough).
	//
	// DaemonState from disk (with real FS) or empty defaults.
	const stateLayer = options.configPath
		? makeDaemonStateFromDiskNode(options.configPath)
		: makeDaemonStateLive();

	// Compose registry layers explicitly to preserve type information.
	// RelayFactoryLive has R = DaemonConfigRefTag, which is satisfied by
	// the services tier (via provideMerge passthrough from foundation).
	const projectRegistryLayer = options.configPath
		? makeProjectRegistryFromDaemonStateLive
		: makeProjectRegistryLive();
	const instanceManagerOptions = {
		...(options.defaultOpencodeUrl !== undefined && {
			defaultOpencodeUrl: options.defaultOpencodeUrl,
		}),
		...(options.smartDefault !== undefined && {
			smartDefault: options.smartDefault,
		}),
	};
	const instanceManagerLayer = options.configPath
		? makeInstanceManagerStateFromDaemonStateLive(
				undefined,
				instanceManagerOptions,
			)
		: makeInstanceManagerStateLive(undefined, [], instanceManagerOptions);

	const registryState = Layer.mergeAll(
		projectRegistryLayer,
		instanceManagerLayer,
	)
		.pipe(Layer.provideMerge(stateLayer))
		.pipe(Layer.provideMerge(auxiliaryServices));

	const effectSnapshotLayer = ConfigSnapshotFromEffectStateLive.pipe(
		Layer.provideMerge(registryState),
	);

	const withConfigPersistence = ConfigPersistenceLive.pipe(
		Layer.provideMerge(effectSnapshotLayer),
	);

	const registries = RelayFactoryLive(configDir).pipe(
		Layer.provideMerge(withConfigPersistence),
	);

	const withRelayCache = makeRelayCacheLayer.pipe(
		Layer.provideMerge(registries),
	);

	const withDaemonHandle = DaemonHandleLive.pipe(
		Layer.provideMerge(withRelayCache),
	);

	const keepAwakeLayer =
		options.keepAwake !== undefined
			? makeKeepAwakeLive(options.keepAwake)
			: Layer.succeed(KeepAwakeTag, {
					activate: () => Effect.void,
					deactivate: () => Effect.void,
					isActive: () => Effect.succeed(false),
					isSupported: () => Effect.succeed(false),
				});
	const withDaemonControl = keepAwakeLayer.pipe(
		Layer.provideMerge(withDaemonHandle),
	);

	// ── Tier 3: Servers (imperative lifecycle) ───────────────────────────
	const httpRequestHandler = makeDaemonHttpRouterLive(options.staticDir);
	const httpAndIpc = Layer.mergeAll(
		HttpServerLive,
		makeIpcServerLive(options.ipcPostResponseActions),
	)
		.pipe(Layer.provideMerge(httpRequestHandler))
		.pipe(Layer.provideMerge(IpcHandlersLayer));

	const servers = OnboardingServerLive(options.staticDir).pipe(
		Layer.provideMerge(httpAndIpc),
		Layer.provideMerge(withDaemonControl),
	);

	const withDaemonWiring = DaemonWiringLive.pipe(Layer.provideMerge(servers));

	// ── Tier 4: Background services (optional) ────────────────────────────
	// When a config is not provided, a no-op stub Layer provides the Tag
	// so the service is always resolvable. This avoids type erasure and
	// ensures wiring tests can verify all Tags without any casts.
	const storageMonLayer = options.storageMon
		? makeStorageMonitorLive(options.storageMon)
		: Layer.succeed(StorageMonitorTag, {
				getUsage: () => Effect.succeed(0),
				getLastCheck: () => Effect.succeed(0),
			});
	const withBackground = storageMonLayer.pipe(
		Layer.provideMerge(withDaemonWiring),
	);

	const withWsRelayRouter = WebSocketRelayRouterLive.pipe(
		Layer.provideMerge(withBackground),
	);

	// ── Tier 5: Scoped fiber Layers (need registries + config) ────────────
	// Side-effect-only Layers (scopedDiscard) that fork background fibers.
	// They read Tags from upstream tiers via Layer.provideMerge passthrough.
	const scopedFibers = Layer.mergeAll(
		WebSocketRoutingLive,
		ProjectDiscoveryLive,
		SessionPrefetchLive,
		InstanceHealthPollingLive,
	).pipe(Layer.provideMerge(withWsRelayRouter));

	return scopedFibers;
};

// ─── ShutdownAwaiterLive ──────────────────────────────────────────────────
// Side-effect-only Layer that awaits the ShutdownSignalTag Deferred. When the
// Deferred completes (from SIGINT/SIGTERM via SignalHandlerLayer, or from IPC
// shutdown), it sends SIGTERM to the current process, which triggers
// NodeRuntime.runMain's signal handler to interrupt the main fiber and tear
// down the Layer tree.
//
// Why process.kill instead of Effect.interrupt?
// Layer.launch blocks on Effect.never in the main fiber. A forkScoped child
// calling Effect.interrupt only interrupts itself — it cannot reach the parent
// fiber running Effect.never. The correct way to stop the process is via
// the same signal mechanism that runMain already handles (SIGTERM/SIGINT).
// For the signal-originated shutdown path (user presses Ctrl+C), runMain
// handles it directly and this Layer is a no-op (the Deferred was already
// completed by SignalHandlerLayer, and the process is already shutting down).
//
// Used by startDaemonEffect (in daemon-main.ts) to bridge IPC-based shutdown
// into process termination that NodeRuntime.runMain understands.

export const ShutdownAwaiterLive: Layer.Layer<never, never, ShutdownSignalTag> =
	Layer.scopedDiscard(
		Effect.gen(function* () {
			const shutdown = yield* ShutdownSignalTag;
			yield* Effect.forkScoped(
				Deferred.await(shutdown).pipe(
					Effect.flatMap(() =>
						Effect.sync(() => {
							// Send SIGTERM to self — NodeRuntime.runMain intercepts this
							// and interrupts the main fiber, triggering graceful teardown.
							process.kill(process.pid, "SIGTERM");
						}),
					),
				),
			);
		}),
	);
