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
import { KeepAwakeLive } from "./keep-awake-layer.js";
import { PinoLoggerLive } from "./pino-logger-layer.js";
import { PortScannerLive } from "./port-scanner-layer.js";
import { makeRelayCacheLive, type RelayFactory } from "./relay-cache.js";
import { SessionOverridesTag } from "./services.js";
import { StorageMonitorLive } from "./storage-monitor-layer.js";
import { EnsureCertsLive, TlsCertLive } from "./tls-cert-layer.js";
import { VersionCheckerLive } from "./version-checker-layer.js";

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
 * Each field corresponds to the parameters needed by the individual layer
 * factories. All runtime-resolved values (lifecycle context, IPC context, etc.)
 * are passed in so the composition remains a pure Layer expression.
 */
export interface DaemonLiveOptions {
	// PID file management
	configDir: string;
	pidPath: string;
	socketPath: string;

	// Server lifecycle
	ctx: DaemonLifecycleContext;
	ipcContext: DaemonIPCContext;
	getStatus: () => DaemonStatus;
	onboarding: OnboardingServerDeps;

	// Background services — Effect-native config types (all optional for phased migration)
	keepAwake?: Parameters<typeof KeepAwakeLive>[0];
	versionCheck?: Parameters<typeof VersionCheckerLive>[0];
	storageMon?: Parameters<typeof StorageMonitorLive>[0];
	portScanner?: Parameters<typeof PortScannerLive>[0];

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
 * Compose all daemon lifecycle Layers into a single Layer.
 *
 * Layer ordering expresses startup dependencies:
 *   1. Signal handlers + error handlers + PID file (infrastructure)
 *   2. Servers: HTTP, IPC, onboarding (sequential: HTTP first)
 *   3. Background services: keep-awake, version checker, storage monitor, port scanner
 *
 * Scope finalizers run in reverse order on shutdown, ensuring servers close
 * before PID file removal and signal handler cleanup.
 */
export const makeDaemonLive = (options: DaemonLiveOptions) => {
	// Infrastructure layers (no inter-dependencies)
	const signalLayer = SignalHandlerLayer;
	const errorLayer = ProcessErrorHandlerLayer;
	const pidLayer = makePidFileLive(
		options.configDir,
		options.pidPath,
		options.socketPath,
	);

	// Server layers (sequential: HTTP first, then IPC, then onboarding)
	const serversLayer = makeHttpServerLive(options.ctx).pipe(
		Layer.provideMerge(
			makeIpcServerLive(options.ctx, options.ipcContext, options.getStatus),
		),
		Layer.provideMerge(
			makeOnboardingServerLive(options.ctx, options.onboarding),
		),
	);

	// Background services — all optional for phased migration.
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
	// biome-ignore lint/suspicious/noExplicitAny: mergeAll requires at least 1 element; skip if empty
	const backgroundLayer: Layer.Layer<any, any, never> | null =
		bgParts.length > 0 ? bgParts.reduce((acc, l) => Layer.merge(acc, l)) : null;

	// State layer — DaemonState from disk (with real FS) or empty defaults
	const stateLayer = options.configPath
		? makeDaemonStateFromDiskNode(options.configPath)
		: makeDaemonStateLive();

	// DaemonConfigRef — typed Ref for mutable daemon config (port, host, tls, etc.)
	const configRefLayer = DaemonConfigRefLive(
		makeDaemonConfigFromOptions({
			port: options.ctx.port,
			host: options.ctx.host,
			...(options.pinHash != null && { pinHash: options.pinHash }),
		}),
	);

	// Compose: PinoLoggerLive (bottom) → infrastructure → servers → background → state → relay cache
	// PinoLoggerLive is the foundation: all Effect.log* calls route to Pino.
	// Use Layer.mergeAll for independent layers, Layer.provideMerge for sequential deps.
	const infraLayer = Layer.mergeAll(signalLayer, errorLayer, pidLayer);

	// TLS cert layer — loads certs, updates configRef on success/failure.
	// Depends on configRefLayer + EnsureCertsLive. Placed AFTER configRefLayer
	// and BEFORE serversLayer (AP-16) so servers see the updated host/tls config.
	const tlsCertLayer = TlsCertLive(options.configDir).pipe(
		Layer.provide(configRefLayer),
		Layer.provide(EnsureCertsLive),
	);

	// AuthManagerFromConfigLive needs DaemonConfigRefTag — satisfy it with configRefLayer
	const authManagerLayer = AuthManagerFromConfigLive.pipe(
		Layer.provide(configRefLayer),
	);

	let composed = infraLayer.pipe(
		Layer.provideMerge(serversLayer),
		Layer.provideMerge(stateLayer),
		Layer.provideMerge(configRefLayer),
		// TLS cert loading — after configRef, before servers consume the config
		Layer.provideMerge(tlsCertLayer),
		// CrashCounterLive has no deps — independent of configRefLayer
		Layer.provideMerge(CrashCounterLive),
		// AuthManager — pre-satisfied dependency on DaemonConfigRefTag
		Layer.provideMerge(authManagerLayer),
		Layer.provideMerge(DaemonEventBusLive),
		Layer.provideMerge(PinoLoggerLive),
	);

	// Background services — only include if configs were provided
	if (backgroundLayer) {
		composed = composed.pipe(Layer.provideMerge(backgroundLayer));
	}

	// RelayCache layer — only include if a factory is provided
	if (options.relayFactory) {
		composed = composed.pipe(
			Layer.provideMerge(makeRelayCacheLayer(options.relayFactory)),
		);
	}

	return composed;
};
