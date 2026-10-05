// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import { NodeFileSystem } from "@effect/platform-node";
import {
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	Layer,
	PubSub,
	Ref,
	Runtime,
	Stream,
} from "effect";
import {
	closeHttpServer,
	closeOnboardingServer,
	type DaemonLifecycleContext,
	type HttpServerStartConfig,
	type OnboardingServerDeps,
	type OnboardingServerStartConfig,
	startHttpServer,
	startOnboardingServer,
} from "../../../daemon/daemon-lifecycle.js";
import { makeDaemonRpcSocketLayer } from "../../../daemon/daemon-rpc-server.js";
import { resolveTraceConfig } from "../../../env.js";
import { migrateForkLineage } from "../../../persistence/migrations/fork-lineage-import.js";
import { migrateProjectStorage } from "../../../persistence/migrations/project-storage-migration.js";
import { ServerBuildUpdateLive } from "../../../server/build-update.js";
import { makeRoutedWsRpcServerLayer } from "../../../server/ws-rpc.js";
import { AuthManagerFromConfigLive } from "../../server/Layers/auth-middleware.js";
import {
	DaemonHttpRequestHandlerTag,
	makeDaemonHttpRouterLive,
} from "../../server/Layers/http-router-layer.js";
import {
	resolveProjectRpcContext,
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
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
import {
	DaemonStateTag,
	emptyDaemonState,
	makeDaemonStateLive,
} from "../Services/daemon-state.js";
import { DaemonWsClientRegistryLive } from "../Services/daemon-ws-client-registry.js";
import {
	InstanceHealthCheckLive,
	type InstanceHealthCheckTag,
} from "../Services/instance-health-service.js";
import {
	getInstances as getEffectInstances,
	getInstanceUrl,
	InstanceManagerStateTag,
	ManagedOpenCodeLifecycleLive,
	makeInstanceManagerStateFromDaemonStateLive,
	makeInstanceManagerStateLive,
	type PollerFibersTag,
	startInitialUnmanagedInstanceHealthPollers,
} from "../Services/instance-manager-service.js";
import {
	broadcastProjectList,
	getProject,
	makeProjectRegistryFromDaemonStateLive,
	makeProjectRegistryLive,
	ProjectRegistryTag,
	ProjectSaveLockTag,
	removeProjectFromEffectRegistry,
	replaceRelay as replaceEffectRelay,
	saveProject,
	updateProject as updateEffectProject,
} from "../Services/project-registry-service.js";
import {
	makeRelayCacheService,
	type RelayCache,
	RelayCacheTag,
} from "../Services/relay-cache.js";
import { AutoSettleLive } from "./auto-settle-layer.js";
import {
	ConfigPersistenceLive,
	ConfigPersistenceTag,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "./config-persistence-layer.js";
import {
	DaemonWsRpcHandlersLive,
	DaemonWsRpcHandlersTag,
} from "./daemon-ws-rpc-layer.js";
import { KeepAwakeLive, KeepAwakeTag } from "./keep-awake-layer.js";
import { OpenCodeInstancesLive } from "./opencode-instances-layer.js";
import { PinoLoggerLive } from "./pino-logger-layer.js";
import { PortScannerLive, PortScannerTag } from "./port-scanner-layer.js";
import {
	makeProjectShellEnvLive,
	ProjectShellEnvWiringLive,
} from "./project-shell-env-layer.js";
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
import {
	TailscaleCliLive,
	TailscaleServeLive,
} from "./tailscale-serve-layer.js";
import { EnsureCertsLive, TlsCertLive, TlsCertTag } from "./tls-cert-layer.js";
import { makeDaemonTracingLive } from "./tracing.js";
import {
	VersionCheckerLive,
	VersionCheckerTag,
} from "./version-checker-layer.js";

/** Shutdown signal — Deferred that completes when SIGTERM/SIGINT received. */
export class ShutdownSignalTag extends Context.Tag("ShutdownSignal")<
	ShutdownSignalTag,
	Deferred.Deferred<"restart" | "stop">
>() {}

export class DaemonLifecycleLayerError extends Data.TaggedError(
	"DaemonLifecycleLayerError",
)<{
	operation: string;
	cause: unknown;
}> {
	get message(): string {
		let inner: string;
		if (this.cause instanceof Error) inner = this.cause.message;
		else if (Cause.isCause(this.cause)) inner = Cause.pretty(this.cause);
		else {
			try {
				inner = String(this.cause);
			} catch {
				inner = "unknown error";
			}
		}
		return `${this.operation} failed: ${inner}`;
	}
}

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
		const deferred = yield* Deferred.make<"restart" | "stop">();
		let shuttingDown = false;
		yield* Deferred.await(deferred).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					shuttingDown = true;
				}),
			),
			Effect.forkScoped,
		);

		const onShutdown = () => {
			shuttingDown = true;
			Deferred.unsafeDone(deferred, Effect.succeed("restart"));
		};
		const onInterrupt = () => {
			if (shuttingDown) process.exit(0);
			onShutdown();
		};
		const onReload = () => {
			// SIGHUP — config reload placeholder
		};

		process.on("SIGTERM", onShutdown);
		process.on("SIGINT", onInterrupt);
		process.on("SIGHUP", onReload);

		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.removeListener("SIGTERM", onShutdown);
				process.removeListener("SIGINT", onInterrupt);
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

// Leaf Service Layers (Effect-native)
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
	| DaemonEventBusTag
	| InstanceHealthCheckTag
	| InstanceManagerStateTag
	| PollerFibersTag
> = Layer.scopedDiscard(startInitialUnmanagedInstanceHealthPollers);

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
		const instances = Array.from(yield* getEffectInstances);
		if (project.instanceId != null) {
			const selected = instances.find(
				(instance) => instance.id === project.instanceId,
			);
			if ((selected?.driver ?? "opencode") === "opencode") {
				return yield* getInstanceUrl(project.instanceId);
			}
		}

		const first = instances.find(
			(instance) => (instance.driver ?? "opencode") === "opencode",
		);
		if (first == null) return null;
		return yield* getInstanceUrl(first.id);
	});

export const makeRelayCacheLayer = (): Layer.Layer<
	RelayCacheTag,
	never,
	| RelayFactoryTag
	| ProjectRegistryTag
	| ProjectSaveLockTag
	| InstanceManagerStateTag
	| DaemonConfigRefTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| DaemonStateTag
> =>
	Layer.scoped(
		RelayCacheTag,
		Effect.gen(function* () {
			const relayFactory = yield* RelayFactoryTag;
			const projectRegistry = yield* ProjectRegistryTag;
			const projectSaveLock = yield* ProjectSaveLockTag;
			const instanceState = yield* InstanceManagerStateTag;
			const configRef = yield* DaemonConfigRefTag;
			const eventBus = yield* DaemonEventBusTag;
			const configPersistence = yield* ConfigPersistenceTag;
			const daemonState = yield* DaemonStateTag;
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
					| ProjectSaveLockTag
					| DaemonConfigRefTag
					| DaemonEventBusTag
					| ConfigPersistenceTag
					| RelayCacheTag
					| DaemonStateTag
				>,
			) => {
				if (relayCache === undefined) {
					return Effect.dieMessage("Relay cache not initialized");
				}
				return effect.pipe(
					Effect.provideService(ProjectRegistryTag, projectRegistry),
					Effect.provideService(ProjectSaveLockTag, projectSaveLock),
					Effect.provideService(DaemonConfigRefTag, configRef),
					Effect.provideService(DaemonEventBusTag, eventBus),
					Effect.provideService(ConfigPersistenceTag, configPersistence),
					Effect.provideService(RelayCacheTag, relayCache),
					Effect.provideService(DaemonStateTag, daemonState),
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
						saveProject: (
							input: import("../../../contracts/ws-rpc.js").SaveProjectInput,
						) =>
							runCallback(
								provideProjectMutationDeps(
									saveProject(input).pipe(
										Effect.tap(() => broadcastProjectList),
									),
								),
							),
						removeProject: (projectSlug: string) =>
							runCallback(
								provideProjectMutationDeps(
									removeProjectFromEffectRegistry(projectSlug).pipe(
										Effect.tap(() => broadcastProjectList),
									),
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
						settleIdleSessions: (idleWindowMs: number, now: number) =>
							relay.settleIdleSessions(idleWindowMs, now),
						attach: (ws, options) => relay.wsHandler.attach(ws, options),
						wsHandler: relay.wsHandler,
						rpcWsHandler: relay.rpcWsHandler,
						getStatusSnapshot: () => relay.getStatusSnapshot(),
						setDefaultAgent: (agent: string) => relay.setDefaultAgent(agent),
						stop: () => relay.stop(),
					};
				}),
			);
			relayCache = relayCacheService;
			return relayCacheService;
		}),
	);

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

/** Local clients use the browser RPC contract and handler layer. */
export const DaemonRpcServerLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const ctx = yield* DaemonLifecycleContextTag;
		const handlers = yield* DaemonWsRpcHandlersTag;
		const relayRouter = yield* WebSocketRelayRouterTag;
		const shutdownSignal = yield* ShutdownSignalTag;
		const server = makeDaemonRpcSocketLayer(
			ctx.socketPath,
			makeRoutedWsRpcServerLayer(
				(slug) => resolveProjectRpcContext(relayRouter, slug),
				handlers,
			),
			{
				onSuccessfulShutdownResponse: (tag) =>
					Deferred.succeed(
						shutdownSignal,
						tag === "Shutdown" ? "stop" : "restart",
					).pipe(Effect.asVoid),
				onClientCountChange: (count) => {
					ctx.clientCount = count;
				},
			},
		);
		yield* Layer.build(server).pipe(
			Effect.mapError(
				(cause) =>
					new DaemonLifecycleLayerError({ operation: "startRpcServer", cause }),
			),
		);
	}),
);

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
	smartDefaultUrl?: string;

	// DaemonOptions-derived values (computed by caller from DaemonOptions)
	configDir: string;
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
	const { configDir, socketPath } = options;

	// Tier 0: Foundation (no inter-dependencies)
	// These Layers have zero dependencies on other Tags. They form the base
	// of the Layer stack that all subsequent tiers build on.
	const foundation = Layer.mergeAll(
		Layer.effectDiscard(
			migrateProjectStorage(configDir).pipe(
				Effect.andThen(migrateForkLineage(configDir)),
			),
		),
		DaemonEventBusLive,
		DaemonWsClientRegistryLive,
		PinoLoggerLive,
		makeDaemonTracingLive(resolveTraceConfig(configDir)),
		DaemonConfigRefLive(options.initialConfig),
		options.configMirror
			? DaemonConfigMirrorLive(options.configMirror)
			: Layer.empty,
		DaemonLifecycleContextLive(socketPath),
		InstanceHealthCheckLive,
		SignalHandlerLayer,
		ProcessErrorHandlerLayer,
		makeConfigWriterLive(configDir),
	);

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
		makeProjectShellEnvLive(),
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

	// State containers and factories. ProjectRegistryLive and
	// InstanceManagerStateLive have no construction deps but are logically
	// grouped here. RelayFactoryLive needs DaemonConfigRefTag (from Tier 0,
	// available via Tier 1's provideMerge passthrough).
	//
	// DaemonState from disk (with real FS) or empty defaults.
	const stateLayer = (
		options.configPath
			? makeDaemonStateFromDiskNode(options.configPath)
			: makeDaemonStateLive()
	).pipe(
		Layer.tap((context) =>
			Ref.update(Context.get(context, DaemonStateTag), (current) => ({
				...current,
				configDir,
				socketPath,
			})),
		),
	);

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
		...(options.smartDefaultUrl !== undefined && {
			smartDefaultUrl: options.smartDefaultUrl,
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
	const withManagedOpenCodeServers = ManagedOpenCodeLifecycleLive(
		configDir,
	).pipe(Layer.provideMerge(withConfigPersistence));

	const withOpenCodeInstances = OpenCodeInstancesLive.pipe(
		Layer.provideMerge(withManagedOpenCodeServers),
	);
	const registries = RelayFactoryLive(configDir).pipe(
		Layer.provideMerge(withOpenCodeInstances),
	);

	const withRelayCache = makeRelayCacheLayer().pipe(
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

	// Tier 3: Servers (imperative lifecycle)
	const httpRequestHandler = makeDaemonHttpRouterLive(options.staticDir);
	const http = HttpServerLive.pipe(Layer.provideMerge(httpRequestHandler));

	const tailscale = TailscaleServeLive.pipe(
		Layer.provide(TailscaleCliLive),
		Layer.provideMerge(http),
		Layer.provideMerge(withDaemonControl),
	);
	const servers = OnboardingServerLive(options.staticDir).pipe(
		Layer.provideMerge(tailscale),
	);

	const withDaemonWiring = Layer.merge(
		DaemonWiringLive,
		ProjectShellEnvWiringLive,
	).pipe(Layer.provideMerge(servers));

	// Tier 4: Background services (optional)
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

	const withWsRelayRouter = Layer.merge(
		WebSocketRelayRouterLive,
		DaemonWsRpcHandlersLive,
	).pipe(Layer.provideMerge(withBackground));

	// Tier 5: Scoped fiber Layers (need registries + config)
	// Side-effect-only Layers (scopedDiscard) that fork background fibers.
	// They read Tags from upstream tiers via Layer.provideMerge passthrough.
	const scopedFibers = Layer.mergeAll(
		DaemonRpcServerLive,
		AutoSettleLive(configDir),
		WebSocketRoutingLive,
		SessionPrefetchLive,
		InstanceHealthPollingLive,
		ServerBuildUpdateLive,
	).pipe(Layer.provideMerge(withWsRelayRouter));

	return scopedFibers;
};
