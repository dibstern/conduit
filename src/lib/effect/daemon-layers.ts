// ─── Daemon Lifecycle Layers ────────────────────────────────────────────────
// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import { NodeFileSystem } from "@effect/platform-node";
import { Context, Data, Deferred, Effect, Layer, Ref } from "effect";
import type { DaemonIPCContext } from "../daemon/daemon-ipc.js";
import {
	closeHttpServer,
	closeIPCServer,
	closeOnboardingServer,
	type DaemonLifecycleContext,
	type OnboardingServerDeps,
	startHttpServer,
	startIPCServer,
	startOnboardingServer,
} from "../daemon/daemon-lifecycle.js";
import type { DaemonStatus } from "../daemon/daemon-types.js";
import {
	removePidFile,
	removeSocketFile,
	writePidFile,
} from "../daemon/pid-manager.js";
import { SessionOverrides } from "../session/session-overrides.js";
import { AuthManagerFromConfigLive } from "./auth-middleware.js";
import { loadConfig, PersistencePathTag } from "./daemon-config-persistence.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "./daemon-config-ref.js";
import { DaemonEventBusLive } from "./daemon-pubsub.js";
import { CrashCounterLive } from "./daemon-startup.js";
import {
	DaemonStateTag,
	emptyDaemonState,
	makeDaemonStateLive,
} from "./daemon-state.js";
import { makeInstanceManagerStateLive } from "./instance-manager-service.js";
import { KeepAwakeLive } from "./keep-awake-layer.js";
import { PinoLoggerLive } from "./pino-logger-layer.js";
import { PortScannerLive } from "./port-scanner-layer.js";
import { ProjectDiscoveryLive } from "./project-discovery-layer.js";
import { makeProjectRegistryLive } from "./project-registry-service.js";
import { makeRelayCacheLive, type RelayFactory } from "./relay-cache.js";
import { RelayFactoryLive } from "./relay-factory-layer.js";
import { SessionOverridesTag } from "./services.js";
import { SessionPrefetchLive } from "./session-prefetch-layer.js";
import { StorageMonitorLive } from "./storage-monitor-layer.js";
import { EnsureCertsLive, TlsCertLive } from "./tls-cert-layer.js";
import { VersionCheckerLive } from "./version-checker-layer.js";
import { WebSocketRoutingLive } from "./ws-routing-layer.js";

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

// close* lifecycle helpers resolve on no-op, normal close, or shutdown timeout;
// they do not reject, so defects here indicate a bug in the close helper itself.
const closeLifecycleServer = (close: () => Promise<void>) =>
	Effect.promise(close);

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

/**
 * SessionOverrides layer — manages per-session state (model, agent, timeout),
 * drains (clears all timers) on scope close.
 */
export const makeSessionOverridesLive = () =>
	Layer.scoped(
		SessionOverridesTag,
		Effect.gen(function* () {
			const instance = new SessionOverrides();
			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
			return instance;
		}),
	);

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

/**
 * RelayCache layer — wraps makeRelayCacheLive with a factory function.
 * Re-exported for convenience in makeDaemonLive composition.
 */
export const makeRelayCacheLayer = (factory: RelayFactory) =>
	makeRelayCacheLive(factory);

// ─── Server Lifecycle Layers ──────────────────────────────────────────────

/**
 * HTTP(S) server layer — starts the HTTP (or TLS protocol-detection) server
 * and tears it down gracefully on scope close.
 */
export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			yield* startLifecycleServer("startHttpServer", () =>
				startHttpServer(ctx),
			);
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer(() => closeHttpServer(ctx)),
			);
		}),
	);

/**
 * IPC (Unix socket) server layer — starts the IPC server with command routing
 * and closes it on scope close.
 */
export const makeIpcServerLive = (
	ctx: DaemonLifecycleContext,
	ipcContext: DaemonIPCContext,
	getStatus: () => DaemonStatus,
) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			yield* startLifecycleServer("startIPCServer", () =>
				startIPCServer(ctx, ipcContext, getStatus),
			);
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer(() => closeIPCServer(ctx)),
			);
		}),
	);

/**
 * Onboarding server layer — starts an HTTP-only onboarding server on port+1
 * when TLS is active (ctx.tls is present). No-ops gracefully when TLS is not
 * configured because startOnboardingServer already returns Promise.resolve().
 */
export const makeOnboardingServerLive = (
	ctx: DaemonLifecycleContext,
	deps: OnboardingServerDeps,
) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			yield* startLifecycleServer("startOnboardingServer", () =>
				startOnboardingServer(ctx, deps),
			);
			yield* Effect.addFinalizer(() =>
				closeLifecycleServer(() => closeOnboardingServer(ctx)),
			);
		}),
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
			yield* Effect.sync(() => writePidFile(configDir, pidPath));
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
 * config, configPath, relayFactory) have been moved to DaemonOptions or
 * are derived internally. Only server lifecycle context (still imperative)
 * and optional background service configs remain.
 */
export interface DaemonLiveOptions {
	// Server lifecycle (still imperative — AP-38 deferred)
	ctx: DaemonLifecycleContext;
	ipcContext: DaemonIPCContext;
	getStatus: () => DaemonStatus;
	onboarding: OnboardingServerDeps;

	// Background services — Effect-native config types (all optional for phased migration)
	keepAwake?: Parameters<typeof KeepAwakeLive>[0];
	versionCheck?: Parameters<typeof VersionCheckerLive>[0];
	storageMon?: Parameters<typeof StorageMonitorLive>[0];
	portScanner?: Parameters<typeof PortScannerLive>[0];

	// DaemonOptions-derived values (computed by caller from DaemonOptions)
	configDir: string;
	pidPath: string;
	socketPath: string;

	// DaemonState + RelayCache (Tasks 1-4 integration)
	/** Path to daemon.json config file. When set, loads config from disk. */
	configPath?: string;
	/** Factory for creating relay instances per slug. */
	relayFactory?: RelayFactory;

	// AuthManager — initial pinHash for DaemonConfigRef (read reactively by AuthManager)
	/** Pre-hashed PIN for authentication, or null if no PIN is set. */
	pinHash?: string | null;
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
		DaemonConfigRefLive(
			makeDaemonConfigFromOptions({
				port: options.ctx.port,
				host: options.ctx.host,
				...(options.pinHash != null && { pinHash: options.pinHash }),
			}),
		),
		SignalHandlerLayer,
		ProcessErrorHandlerLayer,
		makePidFileLive(configDir, pidPath, socketPath),
		CrashCounterLive,
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
	).pipe(Layer.provideMerge(foundation));

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
	let registries = Layer.mergeAll(
		makeProjectRegistryLive(),
		makeInstanceManagerStateLive(),
		RelayFactoryLive(configDir),
		stateLayer,
	).pipe(Layer.provideMerge(services));

	// RelayCache layer — only include if a factory is provided
	if (options.relayFactory) {
		registries = Layer.merge(
			registries,
			makeRelayCacheLayer(options.relayFactory),
		);
	}

	// ── Tier 3: Servers (imperative lifecycle — AP-38 deferred) ────────────
	// Server Layers still take DaemonLifecycleContext params. Converting them
	// to read from Context Tags is deferred to AP-38.
	const servers = Layer.mergeAll(
		makeHttpServerLive(options.ctx),
		makeIpcServerLive(options.ctx, options.ipcContext, options.getStatus),
		makeOnboardingServerLive(options.ctx, options.onboarding),
	).pipe(Layer.provideMerge(registries));

	// ── Tier 4: Background services (optional) ────────────────────────────
	// All optional for phased migration. Each is independent.
	// biome-ignore lint/suspicious/noExplicitAny: Layer generics complex during conditional composition
	const bgParts: Array<Layer.Layer<any, any, never>> = [];
	if (options.keepAwake !== undefined) {
		bgParts.push(makeKeepAwakeLive(options.keepAwake));
	}
	if (options.versionCheck) {
		bgParts.push(makeVersionCheckerLive(options.versionCheck));
	}
	if (options.storageMon) {
		bgParts.push(makeStorageMonitorLive(options.storageMon));
	}
	if (options.portScanner) {
		bgParts.push(makePortScannerLive(options.portScanner));
	}
	const withBackground =
		bgParts.length > 0
			? bgParts
					.reduce((acc, l) => Layer.merge(acc, l))
					.pipe(Layer.provideMerge(servers))
			: servers;

	// ── Tier 5: Scoped fiber Layers (need registries + config) ────────────
	// Side-effect-only Layers (scopedDiscard) that fork background fibers.
	// They read Tags from upstream tiers via Layer.provideMerge passthrough.
	const scopedFibers = Layer.mergeAll(
		WebSocketRoutingLive,
		ProjectDiscoveryLive,
		SessionPrefetchLive,
	).pipe(Layer.provideMerge(withBackground));

	return scopedFibers;
};
