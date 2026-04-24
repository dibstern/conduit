// ─── Daemon Lifecycle Layers ────────────────────────────────────────────────
// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import { Deferred, Effect, Layer } from "effect";
import type { DaemonStatus } from "../daemon/daemon.js";
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
import type { KeepAwakeOptions } from "../daemon/keep-awake.js";
import { KeepAwake } from "../daemon/keep-awake.js";
import {
	removePidFile,
	removeSocketFile,
	writePidFile,
} from "../daemon/pid-manager.js";
import { PortScanner, type PortScannerConfig } from "../daemon/port-scanner.js";
import type { StorageMonitorOptions } from "../daemon/storage-monitor.js";
import { StorageMonitor } from "../daemon/storage-monitor.js";
import type { VersionCheckOptions } from "../daemon/version-check.js";
import { VersionChecker } from "../daemon/version-check.js";
import { SessionOverrides } from "../session/session-overrides.js";
import {
	KeepAwakeTag,
	PortScannerTag,
	SessionOverridesTag,
	ShutdownSignalTag,
	StorageMonitorTag,
	VersionCheckerTag,
} from "./services.js";

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

// ─── Leaf Drainable Service Layers ──────────────────────────────────────────

/**
 * KeepAwake layer — spawns platform-appropriate keep-awake process, activates it,
 * and drains (kills child process) on scope close.
 */
export const makeKeepAwakeLive = (options?: KeepAwakeOptions) =>
	Layer.scoped(
		KeepAwakeTag,
		Effect.gen(function* () {
			const instance = new KeepAwake(options);
			instance.activate();
			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
			return instance;
		}),
	);

/**
 * VersionChecker layer — starts periodic npm version checks,
 * drains (stops interval, aborts fetches) on scope close.
 */
export const makeVersionCheckerLive = (options?: VersionCheckOptions) =>
	Layer.scoped(
		VersionCheckerTag,
		Effect.gen(function* () {
			const instance = new VersionChecker(options);
			instance.start();
			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
			return instance;
		}),
	);

/**
 * StorageMonitor layer — starts periodic disk space polling,
 * drains (stops interval, awaits pending checks) on scope close.
 */
export const makeStorageMonitorLive = (options: StorageMonitorOptions) =>
	Layer.scoped(
		StorageMonitorTag,
		Effect.gen(function* () {
			const instance = new StorageMonitor(options);
			instance.start();
			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
			return instance;
		}),
	);

/**
 * PortScanner layer — starts periodic port scanning for OpenCode instances,
 * drains (stops interval, awaits pending scans) on scope close.
 */
export const makePortScannerLive = (
	config: PortScannerConfig,
	probeFn: (port: number) => Promise<boolean>,
) =>
	Layer.scoped(
		PortScannerTag,
		Effect.gen(function* () {
			const instance = new PortScanner(config, probeFn);
			instance.start();
			yield* Effect.addFinalizer(() => Effect.promise(() => instance.drain()));
			return instance;
		}),
	);

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

// ─── Server Lifecycle Layers ──────────────────────────────────────────────

/**
 * HTTP(S) server layer — starts the HTTP (or TLS protocol-detection) server
 * and tears it down gracefully on scope close.
 */
export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			yield* Effect.promise(() => startHttpServer(ctx));
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => closeHttpServer(ctx)),
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
			yield* Effect.promise(() => startIPCServer(ctx, ipcContext, getStatus));
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => closeIPCServer(ctx)),
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
			yield* Effect.promise(() => startOnboardingServer(ctx, deps));
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => closeOnboardingServer(ctx)),
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

	// Background services
	keepAwake?: KeepAwakeOptions;
	versionCheck?: VersionCheckOptions;
	storageMon: StorageMonitorOptions;
	portScanner?: {
		config: PortScannerConfig;
		probeFn: (port: number) => Promise<boolean>;
	};
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

	// Background services — only include those that are configured
	const backgroundLayers: Layer.Layer<any, never, never>[] = [];
	backgroundLayers.push(makeKeepAwakeLive(options.keepAwake));
	backgroundLayers.push(makeVersionCheckerLive(options.versionCheck));
	backgroundLayers.push(makeStorageMonitorLive(options.storageMon));
	if (options.portScanner) {
		backgroundLayers.push(
			makePortScannerLive(
				options.portScanner.config,
				options.portScanner.probeFn,
			),
		);
	}

	// Compose: infrastructure → servers → background
	// Use Layer.mergeAll for independent layers, Layer.provideMerge for sequential deps.
	const infraLayer = Layer.mergeAll(signalLayer, errorLayer, pidLayer);

	// Merge all background layers
	const backgroundLayer =
		backgroundLayers.length === 1
			? backgroundLayers[0]!
			: backgroundLayers.reduce((acc, layer) => Layer.merge(acc, layer));

	return infraLayer.pipe(
		Layer.provideMerge(serversLayer),
		Layer.provideMerge(backgroundLayer),
	);
};
