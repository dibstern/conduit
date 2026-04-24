// ─── Daemon Lifecycle Layers ────────────────────────────────────────────────
// Scoped layers for daemon process lifecycle: signal handling, error handling,
// and leaf Drainable services (KeepAwake, VersionChecker, StorageMonitor, PortScanner).
// Finalizers remove process listeners / drain services to prevent leaks in tests.

import { Deferred, Effect, Layer } from "effect";
import type { KeepAwakeOptions } from "../daemon/keep-awake.js";
import { KeepAwake } from "../daemon/keep-awake.js";
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

// ─── Leaf Drainable Service Layers ─────────────────────────────────────────

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
