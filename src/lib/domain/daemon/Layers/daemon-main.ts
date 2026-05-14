import type { CrashCounterTag } from "../Services/daemon-startup.js";
import type { DaemonStateTag } from "../Services/daemon-state.js";
import {
	type InstanceMgmtTag,
	ProjectMgmtTag,
} from "../Services/management-service.js";
// ─── Daemon Main — Effect Entry Point ────────────────────────────────────────
// Top-level Effect program that replaces the Daemon class's start() method.
// Creates a Layer that runs the startup sequence, forks background tasks
// under supervision, and keeps alive until interrupted (SIGINT/SIGTERM).
//
// Phase 1: Only projectDiscovery is forked. Session prefetch and push init
// are stubbed as comments for Phase 2 expansion.
//
// Design points:
//   - Layer.scopedDiscard — side-effect-only Layer (no output service)
//   - Effect.forkScoped — fibers tied to enclosing scope, interrupted on shutdown
//   - Effect.tapDefect — logs defects without swallowing them
//   - Effect.never — keeps the fiber alive until SIGINT/SIGTERM
//   - Layer.provide(daemonLayer) — provides all deps to the program

import { NodeRuntime } from "@effect/platform-node";
import type { Fiber } from "effect";
import {
	Context,
	Duration,
	Effect,
	Layer,
	ManagedRuntime,
	Ref,
	RuntimeFlags,
	RuntimeFlagsPatch,
	Schedule,
	Supervisor,
} from "effect";
import type { DaemonOptions } from "../../../daemon/daemon-types.js";
import {
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
	makeDaemonConfigFromOptions,
} from "../Services/daemon-config-ref.js";
import {
	type CrashLimitExceeded,
	runStartupSequence,
} from "../Services/daemon-startup.js";
import type { DaemonLiveOptions } from "./daemon-layers.js";
import { makeDaemonLive, ShutdownAwaiterLive } from "./daemon-layers.js";

// ─── SupervisorTag ───────────────────────────────────────────────────────
// Context.Tag for the daemon-wide Supervisor.track instance.
// Allows any fiber in the daemon scope to query tracked fiber diagnostics.

export class SupervisorTag extends Context.Tag("DaemonSupervisor")<
	SupervisorTag,
	Supervisor.Supervisor<Array<Fiber.RuntimeFiber<unknown, unknown>>>
>() {}

/**
 * Live Layer that creates a Supervisor.track instance and provides it
 * via SupervisorTag. Use `Layer.provide(makeSupervisorLive)` to make
 * the supervisor available to the daemon program.
 */
export const makeSupervisorLive: Layer.Layer<SupervisorTag> = Layer.effect(
	SupervisorTag,
	Supervisor.track,
);

// ─── DaemonDeps type ──────────────────────────────────────────────────────
// Minimal at Phase 1, listing only Tags available from Tasks 1-5.
// DO NOT import Tags from Phase 2+ modules.

export type DaemonDeps =
	| DaemonStateTag
	| CrashCounterTag
	| InstanceMgmtTag
	| ProjectMgmtTag;

// ─── Retry schedule ───────────────────────────────────────────────────────

/** Exponential backoff with 3 retries for startup. */
export const startupRetry = Schedule.exponential("1 second").pipe(
	Schedule.intersect(Schedule.recurs(3)),
);

// ─── Background tasks ─────────────────────────────────────────────────────

/**
 * Discover projects from the ProjectMgmt service.
 *
 * Phase 1 implementation: calls getProjects() as a lightweight discovery
 * step. The full discovery logic (calling OpenCode's /project API) will
 * be wired in later phases.
 *
 * Error isolation: catches all expected errors and logs them.
 * Programming defects propagate to the supervisor.
 */
export const projectDiscovery: Effect.Effect<void, never, ProjectMgmtTag> =
	Effect.gen(function* () {
		const mgmt = yield* ProjectMgmtTag;
		yield* Effect.try(() => mgmt.getProjects());
		yield* Effect.logInfo("Project discovery complete");
	}).pipe(
		Effect.catchAll((e) =>
			Effect.logWarning("Project discovery failed", { error: String(e) }),
		),
		Effect.annotateLogs("task", "projectDiscovery"),
		Effect.withSpan("projectDiscovery"),
	);

// ── sessionPrefetch — STUB (Phase 2a) ──
// export const sessionPrefetch: Effect.Effect<void, never, ...> = ...

// ── pushInit — STUB (Phase 2b) ──
// export const pushInit: Effect.Effect<void, never, ...> = ...

// ─── makeDaemonProgramLayer ───────────────────────────────────────────────

/**
 * Takes a Layer providing all DaemonDeps and returns a Layer<never> that:
 *   1. Enables cooperative yielding
 *   2. Runs the startup sequence with retry and CrashLimitExceeded handling
 *   3. Forks background tasks under supervision
 *   4. Keeps alive until interrupted
 *
 * The returned Layer is meant to be the outermost layer in the daemon
 * runtime — `Layer.launch(makeDaemonProgramLayer(daemonLayer))`.
 */
export const makeDaemonProgramLayer = (
	daemonLayer: Layer.Layer<DaemonDeps>,
): Layer.Layer<never> =>
	Layer.scopedDiscard(
		Effect.gen(function* () {
			// Enable cooperative yielding so long-running effects yield to siblings
			yield* Effect.withRuntimeFlagsPatchScoped(
				RuntimeFlagsPatch.enable(RuntimeFlags.CooperativeYielding),
			);

			// Run startup sequence with retry and crash-limit handling
			yield* runStartupSequence.pipe(
				Effect.retry(startupRetry),
				Effect.withSpan("daemon.startup"),
				Effect.catchTag("CrashLimitExceeded", (e: CrashLimitExceeded) =>
					Effect.logError(
						`Daemon aborting: crash limit exceeded (${e.count} consecutive crashes)`,
					).pipe(Effect.andThen(Effect.die(e))),
				),
			);

			// Fork background tasks under supervision (supervisor from context)
			const supervisor = yield* SupervisorTag;
			yield* Effect.supervised(
				Effect.gen(function* () {
					yield* Effect.forkScoped(projectDiscovery);
					// yield* Effect.forkScoped(sessionPrefetch);  // EXPAND Phase 2a
					// yield* Effect.forkScoped(pushInit);          // EXPAND Phase 2b
				}),
				supervisor,
			).pipe(
				Effect.tapDefect((defect) =>
					Effect.logError("DEFECT in background task — this is a bug", {
						defect,
					}),
				),
			);

			yield* Effect.logInfo("Daemon started — awaiting interruption");
			yield* Effect.never; // Keep alive until interrupted
		}).pipe(Effect.annotateLogs("component", "daemon-main")),
	).pipe(Layer.provide(Layer.merge(daemonLayer, makeSupervisorLive)));

// ─── DaemonHandleTag ────────────────────────────────────────────────────
// Effect-native handle for foreground mode. Provides the same capabilities
// as the imperative DaemonHandle interface but via Effect-typed methods.
// AP-41: This Tag is used by foreground mode to interact with the running
// daemon without going through IPC.

export interface EffectDaemonHandle {
	readonly port: Effect.Effect<number>;
	readonly addProject: (dir: string) => Effect.Effect<void>;
	readonly removeProject: (slug: string) => Effect.Effect<void>;
	readonly getStatus: () => Effect.Effect<
		import("../../../daemon/daemon-types.js").DaemonStatus
	>;
	readonly getProjects: () => Effect.Effect<
		ReadonlyArray<import("../../../types.js").StoredProject>
	>;
}

export class DaemonHandleTag extends Context.Tag("DaemonHandle")<
	DaemonHandleTag,
	EffectDaemonHandle
>() {}

// ─── startDaemonEffect ──────────────────────────────────────────────────
// Effect-native daemon entry point. Uses NodeRuntime.runMain which handles
// SIGINT/SIGTERM (interrupts the fiber) and calls process.exit on
// completion. Layer.launch constructs the Layer, runs until the fiber is
// interrupted, then tears down all finalizers in reverse order.
//
// AP-39: NodeRuntime.runMain (not Effect.runFork) — installs signal
//        handlers that interrupt the fiber.
// AP-40: runMain never returns (calls process.exit on completion). The
//        --daemon path in cli-core.ts uses `await startDaemonProcess(...)`
//        then returns — this works because runMain keeps the process alive.
// AP-44: Layer.launch alone does NOT handle SIGINT/SIGTERM. runMain does.
//
// ShutdownAwaiterLive bridges the Deferred-based shutdown signal (from
// SignalHandlerLayer or IPC scheduleShutdown) into fiber interruption.
//
// NOTE: This coexists alongside the legacy startDaemonProcess. The
// transition to using startDaemonEffect as the primary entry point
// happens when all imperative code in startDaemonProcess is eliminated.

export const startDaemonEffect = (daemonLiveOptions: DaemonLiveOptions) => {
	const daemonLayer = makeDaemonLive(daemonLiveOptions);

	// ShutdownAwaiterLive needs ShutdownSignalTag, which is provided by
	// SignalHandlerLayer inside daemonLayer. Provide daemonLayer to the
	// awaiter so it has access to the Deferred.
	const fullLayer = ShutdownAwaiterLive.pipe(Layer.provideMerge(daemonLayer));

	NodeRuntime.runMain(Layer.launch(fullLayer), {
		disablePrettyLogger: true,
	});
};

// ─── Imperative bridge: startDaemonProcess ───────────────────────────────
// Standalone startup function that replaces `new Daemon(options).start()`.
// Orchestrates the same initialization sequence the Daemon class performed,
// using the already-extracted helper modules (daemon-lifecycle, daemon-ipc,
// project-registry, instance-manager, config-persistence, etc.).

import { existsSync, mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAllIPs, getTailscaleIP } from "../../../cli/tls.js";
import {
	DAEMON_SHUTDOWN_DELAY_MS,
	DEFAULT_OPENCODE_PORT,
	DEFAULT_OPENCODE_URL,
} from "../../../constants.js";
import {
	clearCrashInfo,
	type DaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
	syncRecentProjects,
} from "../../../daemon/config-persistence.js";
import type { DaemonLifecycleContext } from "../../../daemon/daemon-lifecycle.js";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
	probeOpenCodePort,
} from "../../../daemon/daemon-utils.js";
import { PortScanner, type ScanResult } from "../../../daemon/port-scanner.js";
import { ProjectRegistry } from "../../../daemon/project-registry.js";
import { fetchLatestVersion } from "../../../daemon/version-check.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../../../env.js";
import { formatErrorDetail } from "../../../errors.js";
import { InstanceManager } from "../../../instance/instance-manager.js";
import { createLogger, setLogFormat, setLogLevel } from "../../../logger.js";
import type { ProjectRelay } from "../../../relay/relay-stack.js";
import type { PushNotificationManager } from "../../../server/push.js";
import { loadThemeFiles } from "../../../server/theme-loader.js";
import type { OpenCodeInstance, StoredProject } from "../../../types.js";
import { generateSlug } from "../../../utils.js";
import { getVersion } from "../../../version.js";
import type { RouterProjectInfo } from "../../server/Layers/http-router-layer.js";
import {
	addWithoutRelay as addEffectProjectWithoutRelay,
	remove as removeEffectProject,
	updateProject as updateEffectProject,
} from "../Services/project-registry-service.js";
import { RelayCacheTag as EffectRelayCacheTag } from "../Services/relay-cache.js";

/**
 * Default frontend directory resolved relative to this file.
 * Compiled: dist/src/lib/domain/daemon/Layers/daemon-main.js -> 5x.. -> dist/ -> dist/frontend/
 * Dev (tsx): src/lib/domain/daemon/Layers/daemon-main.ts -> 5x.. -> repo root -> frontend/ (doesn't exist)
 * Falls back to cwd-based resolution for dev mode.
 */
export function resolveDefaultStaticDir(options?: {
	readonly moduleUrl?: string;
	readonly cwd?: string;
	readonly exists?: (path: string) => boolean;
}): string {
	const moduleUrl = options?.moduleUrl ?? import.meta.url;
	const cwd = options?.cwd ?? process.cwd();
	const exists = options?.exists ?? existsSync;
	const candidate = join(
		dirname(fileURLToPath(moduleUrl)),
		"..",
		"..",
		"..",
		"..",
		"..",
		"frontend",
	);
	return exists(candidate) ? candidate : join(cwd, "dist", "frontend");
}

const DEFAULT_STATIC_DIR = resolveDefaultStaticDir();

/**
 * Structural type covering the running daemon's public surface.
 * Used by cli-core.ts (foreground mode) and test harnesses.
 */
export interface DaemonHandle {
	readonly port: number;
	/** Port of the HTTP-only onboarding server (when TLS active), or null. */
	readonly onboardingPort: number | null;
	addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<import("../../../types.js").StoredProject>;
	discoverProjects(): Promise<void>;
	getStatus(): import("../../../daemon/daemon-types.js").DaemonStatus;
	/** Gracefully stop the daemon (servers, services, PID/socket cleanup). */
	stop(): Promise<void>;
	/** Get all registered projects. */
	getProjects(): ReadonlyArray<
		Readonly<import("../../../types.js").StoredProject>
	>;
	/** Get all registered OpenCode instances. */
	getInstances(): ReadonlyArray<
		Readonly<import("../../../types.js").OpenCodeInstance>
	>;
	/** Remove a project by slug. */
	removeProject(slug: string): Promise<void>;
	/**
	 * Direct access to the ProjectRegistry for integration/E2E tests.
	 * Not part of the public API — callers should prefer addProject/removeProject/getStatus.
	 */
	readonly registry: import("../../../daemon/project-registry.js").ProjectRegistry;
}

export function resolveRuntimeConfigUpdateSync(
	current: DaemonRuntimeConfig,
	update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
	runRuntimeUpdate:
		| ((
				update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
		  ) => DaemonRuntimeConfig)
		| null,
): DaemonRuntimeConfig {
	if (!runRuntimeUpdate) return update(current);
	return runRuntimeUpdate(update);
}

/**
 * Start the daemon process. Directly orchestrates the startup sequence
 * that was previously encapsulated in the Daemon class.
 *
 * Returns a DaemonHandle (needed by foreground mode for
 * addProject / discoverProjects / getStatus / port).
 */
export async function startDaemonProcess(
	options: DaemonOptions,
): Promise<DaemonHandle> {
	const startupT0 = Date.now();
	const elapsed = () => `${Date.now() - startupT0}ms`;

	// ── Logging setup ─────────────────────────────────────────────────────
	if (options.logLevel) setLogLevel(options.logLevel);
	if (options.logFormat) setLogFormat(options.logFormat);
	const log = createLogger("daemon");

	// ── Config paths ──────────────────────────────────────────────────────
	const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
	const socketPath = options.socketPath ?? join(configDir, "relay.sock");
	const pidPath = options.pidPath ?? join(configDir, "daemon.pid");
	const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
	const smartDefault = options.smartDefault ?? true;

	// Ensure config directory exists
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Crash counter is now managed by CrashCounterLive (via makeDaemonLive).
	// The crash check happens in runStartupSequence via recordCrashCounter.
	// PID file is now managed by makePidFileLive (via makeDaemonLive).

	// ── Mutable state ─────────────────────────────────────────────────────
	let port = options.port ?? DEFAULT_PORT;
	let host = options.host ?? "127.0.0.1";
	let pinHash = options.pinHash ?? null;
	let tlsEnabled = options.tlsEnabled ?? false;
	let keepAwake = options.keepAwake ?? false;
	let keepAwakeCommand: string | undefined = options.keepAwakeCommand;
	let keepAwakeArgs: string[] | undefined = options.keepAwakeArgs;
	let shuttingDown = false;
	let startTime = Date.now();
	let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
	let pushManager: PushNotificationManager | null = null;
	let scanner: PortScanner | null = null;
	// Layer-managed runtime — set after router setup, used by stop().
	// biome-ignore lint/suspicious/noExplicitAny: ManagedRuntime generic resolved at construction
	let daemonRuntime: ManagedRuntime.ManagedRuntime<any, any> | null = null;

	const persistedSessionCounts = new Map<string, number>();
	const dismissedPaths = new Set<string>();
	let runtimeConfigSnapshot = makeDaemonConfigFromOptions({
		port,
		host,
		hostExplicit: options.host !== undefined,
		...(pinHash != null && { pinHash }),
		tlsEnabled,
		keepAwake,
		...(keepAwakeCommand != null && { keepAwakeCommand }),
		...(keepAwakeArgs != null && { keepAwakeArgs }),
		dismissedPaths: Array.from(dismissedPaths),
		startTime,
		persistedSessionCounts,
	});

	function syncLegacyConfigLocals(config: DaemonRuntimeConfig): void {
		port = config.port;
		host = config.host;
		pinHash = config.pinHash;
		tlsEnabled = config.tlsEnabled;
		keepAwake = config.keepAwake;
		keepAwakeCommand = config.keepAwakeCommand;
		keepAwakeArgs =
			config.keepAwakeArgs != null ? [...config.keepAwakeArgs] : undefined;
		startTime = config.startTime;
		dismissedPaths.clear();
		for (const path of config.dismissedPaths) dismissedPaths.add(path);
		persistedSessionCounts.clear();
		for (const [slug, count] of config.persistedSessionCounts) {
			persistedSessionCounts.set(slug, count);
		}
	}

	function readRuntimeConfigSnapshot(): DaemonRuntimeConfig {
		if (!daemonRuntime || shuttingDown) return runtimeConfigSnapshot;
		try {
			runtimeConfigSnapshot = daemonRuntime.runSync(
				Effect.gen(function* () {
					const ref = yield* DaemonConfigRefTag;
					return yield* Ref.get(ref);
				}),
			);
			syncLegacyConfigLocals(runtimeConfigSnapshot);
		} catch {
			// During startup/shutdown, keep the last known snapshot.
		}
		return runtimeConfigSnapshot;
	}

	function updateRuntimeConfigSync(
		update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
	): void {
		const runtime = shuttingDown ? null : daemonRuntime;
		try {
			runtimeConfigSnapshot = resolveRuntimeConfigUpdateSync(
				runtimeConfigSnapshot,
				update,
				runtime
					? (runtimeUpdate) =>
							runtime.runSync(
								Effect.gen(function* () {
									const ref = yield* DaemonConfigRefTag;
									yield* Ref.update(ref, runtimeUpdate);
									return yield* Ref.get(ref);
								}),
							)
					: null,
			);
			syncLegacyConfigLocals(runtimeConfigSnapshot);
		} catch (err) {
			log.error(
				{ err: formatErrorDetail(err) },
				"Runtime config update failed",
			);
			throw err;
		}
	}

	function syncEffectProjectRegistry<R>(
		operation: string,
		effect: Effect.Effect<void, unknown, R>,
	): Promise<void> {
		const runtime = shuttingDown ? null : daemonRuntime;
		if (!runtime) return Promise.resolve();
		return runtime.runPromise(effect).catch((cause: unknown) => {
			log.warn(
				{ err: formatErrorDetail(cause) },
				`Effect project registry sync failed: ${operation}`,
			);
			throw cause;
		});
	}

	function syncEffectProjectRegistrySoon<R>(
		operation: string,
		effect: Effect.Effect<void, unknown, R>,
	): void {
		void syncEffectProjectRegistry(operation, effect).catch(() => {});
	}

	const syncEffectProjectAdd = (project: StoredProject) =>
		addEffectProjectWithoutRelay(project, { silent: true }).pipe(
			Effect.catchTag("ProjectAlreadyExists", () =>
				updateEffectProject(project.slug, {
					title: project.title,
					...(project.instanceId !== undefined && {
						instanceId: project.instanceId,
					}),
				}),
			),
		);

	const invalidateEffectRelay = (slug: string) =>
		Effect.gen(function* () {
			const relayCache = yield* EffectRelayCacheTag;
			yield* relayCache.invalidate(slug);
		});

	// ── Core services ─────────────────────────────────────────────────────
	const instanceManager = new InstanceManager();
	const registry = new ProjectRegistry();

	// ── Config persistence (coalescing) ───────────────────────────────────
	let _pendingSave: Promise<void> | null = null;
	let _needsResave = false;

	function buildConfig(): DaemonConfig {
		const cfg = readRuntimeConfigSnapshot();
		return {
			pid: process.pid,
			port: cfg.port,
			pinHash: cfg.pinHash,
			tls: cfg.tlsEnabled,
			debug: false,
			keepAwake: cfg.keepAwake,
			...(cfg.keepAwakeCommand != null && {
				keepAwakeCommand: cfg.keepAwakeCommand,
			}),
			...(cfg.keepAwakeArgs != null && { keepAwakeArgs: cfg.keepAwakeArgs }),
			dangerouslySkipPermissions: false,
			projects: registry.allProjects().map((p) => {
				const e = registry.get(p.slug);
				const relay = e?.status === "ready" ? e.relay : undefined;
				const relayStatus = relay?.getStatusSnapshot();
				const sessionCount =
					relayStatus?.sessionCount ||
					cfg.persistedSessionCounts.get(p.slug) ||
					persistedSessionCounts.get(p.slug) ||
					0;
				return {
					path: p.directory,
					slug: p.slug,
					title: p.title,
					addedAt: p.lastUsed ?? Date.now(),
					...(p.instanceId != null && { instanceId: p.instanceId }),
					...(sessionCount > 0 && { sessionCount }),
				};
			}),
			instances: instanceManager.getInstances().map((inst) => {
				const extUrl = instanceManager.getExternalUrl(inst.id);
				return {
					id: inst.id,
					name: inst.name,
					port: inst.port,
					managed: inst.managed,
					...(inst.env != null && { env: inst.env }),
					...(extUrl != null && { url: extUrl }),
				};
			}),
			...(cfg.dismissedPaths.size > 0 && {
				dismissedPaths: Array.from(cfg.dismissedPaths),
			}),
		};
	}

	function persistConfig(): void {
		if (_pendingSave) {
			_needsResave = true;
			return;
		}
		_pendingSave = saveDaemonConfig(buildConfig(), configDir)
			.catch(() => {
				// Best-effort
			})
			.finally(() => {
				_pendingSave = null;
				if (_needsResave) {
					_needsResave = false;
					persistConfig();
				}
			});
	}

	async function flushConfigSave(): Promise<void> {
		while (_pendingSave) await _pendingSave;
	}

	// ── Registry event listeners ──────────────────────────────────────────
	registry.on("project_added", () => persistConfig());
	registry.on("project_ready", () => persistConfig());
	registry.on("project_updated", () => persistConfig());
	registry.on("project_removed", () => {
		if (!shuttingDown) persistConfig();
	});
	registry.on("project_added", (slug) =>
		log.info({ slug }, "Project registered"),
	);
	registry.on("project_ready", (slug) =>
		log.info({ slug }, "Project relay ready"),
	);
	registry.on("project_error", (slug, error) =>
		log.warn({ slug, error }, "Project relay failed"),
	);
	registry.on("project_removed", (slug) =>
		log.info({ slug }, "Project removed"),
	);

	// ── Health checker ────────────────────────────────────────────────────
	const globalPassword = process.env["OPENCODE_SERVER_PASSWORD"];
	const globalUsername = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";

	instanceManager.setHealthChecker(
		async (p: number, instance: OpenCodeInstance) => {
			const password =
				instance.env?.["OPENCODE_SERVER_PASSWORD"] ?? globalPassword;
			if (!password) {
				try {
					const res = await fetch(`http://localhost:${p}/health`);
					return res.ok;
				} catch {
					return false;
				}
			}
			const username =
				instance.env?.["OPENCODE_SERVER_USERNAME"] ?? globalUsername;
			const encoded = Buffer.from(`${username}:${password}`).toString("base64");
			try {
				const res = await fetch(`http://localhost:${p}/health`, {
					headers: { Authorization: `Basic ${encoded}` },
				});
				return res.ok;
			} catch {
				return false;
			}
		},
	);

	// ── Instance status broadcasts ────────────────────────────────────────
	instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
		registry.broadcastToAll({
			type: "instance_status",
			instanceId: instance.id,
			status: instance.status,
		});
	});

	// ── Backward compat: default instance from opencodeUrl ────────────────
	const initialUrl = options.opencodeUrl ?? null;
	if (initialUrl) {
		const urlPort = (() => {
			try {
				return new URL(initialUrl).port;
			} catch {
				return "";
			}
		})();
		const instancePort = urlPort
			? parseInt(urlPort, 10)
			: DEFAULT_OPENCODE_PORT;
		instanceManager.addInstance("default", {
			name: "Default",
			port: instancePort,
			managed: false,
			url: initialUrl,
		});
	}

	// ── Helper: resolveOpencodeUrl ────────────────────────────────────────
	function resolveOpencodeUrl(instanceId?: string): string | null {
		if (!instanceId) {
			const instances = instanceManager.getInstances();
			if (instances.length === 0) return null;
			try {
				// biome-ignore lint/style/noNonNullAssertion: length check above guarantees [0] exists
				return instanceManager.getInstanceUrl(instances[0]!.id);
			} catch {
				return null;
			}
		}
		try {
			return instanceManager.getInstanceUrl(instanceId);
		} catch {
			return null;
		}
	}

	// ── Helper: buildRelayFactory ─────────────────────────────────────────
	function buildRelayFactory(
		project: StoredProject,
		opencodeUrl: string,
	): (signal: AbortSignal) => Promise<ProjectRelay> {
		return async (signal: AbortSignal) => {
			const conduitDir = resolve(project.directory, ".conduit");
			mkdirSync(conduitDir, { recursive: true });
			const dbPath = resolve(conduitDir, "events.db");
			const { createProjectRelay } = await import(
				"../../../relay/relay-stack.js"
			);
			return createProjectRelay({
				// biome-ignore lint/style/noNonNullAssertion: relay factory is only invoked after the HTTP server has been started
				httpServer: ctx.httpServer!,
				opencodeUrl,
				projectDir: project.directory,
				slug: project.slug,
				noServer: true,
				signal,
				persistenceDbPath: dbPath,
				log: createLogger("relay"),
				getProjects: () => registry.allProjects(),
				addProject: async (dir: string) => {
					const p = await addProject(dir);
					return {
						slug: p.slug,
						title: p.title,
						directory: p.directory,
						...(p.instanceId != null && {
							instanceId: p.instanceId,
						}),
					};
				},
				removeProject: async (slug: string) => {
					await removeProject(slug);
				},
				setProjectTitle: (slug: string, title: string) => {
					registry.updateProject(slug, { title });
					syncEffectProjectRegistrySoon(
						"set project title",
						updateEffectProject(slug, { title }),
					);
					persistConfig();
				},
				getInstances: () => instanceManager.getInstances(),
				addInstance: (id, config) => instanceManager.addInstance(id, config),
				removeInstance: (id) => instanceManager.removeInstance(id),
				startInstance: (id) => instanceManager.startInstance(id),
				stopInstance: (id) => instanceManager.stopInstance(id),
				updateInstance: (id, updates) =>
					instanceManager.updateInstance(id, updates),
				persistConfig: () => persistConfig(),
				...(scanner != null && {
					triggerScan: () => {
						if (!scanner) throw new Error("Scanner no longer available");
						return scanner.scan();
					},
				}),
				setProjectInstance: (slug: string, instanceId: string) =>
					setProjectInstance(slug, instanceId),
				...(pushManager != null && { pushManager }),
				configDir,
			});
		};
	}

	// ── Helper: ensureRelayStarted ────────────────────────────────────────
	function ensureRelayStarted(slug: string): void {
		const entry = registry.get(slug);
		if (!entry) return;
		if (entry.status === "ready") return;
		if (entry.status === "registering" && registry.isStarting(slug)) return;
		const opencodeUrl = resolveOpencodeUrl(entry.project.instanceId);
		if (!opencodeUrl) return;
		log.info({ slug }, "Lazy-starting relay on first client connection");
		registry.startRelay(slug, buildRelayFactory(entry.project, opencodeUrl));
	}

	// ── Helper: setProjectInstance ────────────────────────────────────────
	async function setProjectInstance(
		slug: string,
		instanceId: string,
	): Promise<void> {
		registry.updateProject(slug, { instanceId });
		// biome-ignore lint/style/noNonNullAssertion: slug was just successfully updated, so the project must exist in the registry
		const project = registry.getProject(slug)!;
		const opencodeUrl = resolveOpencodeUrl(instanceId);
		if (opencodeUrl) {
			await registry.replaceRelay(
				slug,
				buildRelayFactory(project, opencodeUrl),
			);
		}
		await syncEffectProjectRegistry(
			"set project instance",
			updateEffectProject(slug, { instanceId }).pipe(
				Effect.zipRight(invalidateEffectRelay(slug)),
			),
		);
	}

	// ── Helper: addProject ────────────────────────────────────────────────
	async function addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<StoredProject> {
		let dir = directory;
		if (dir.startsWith("~/") || dir === "~") {
			dir = dir.replace(/^~/, homedir());
		}
		dir = resolve(dir);
		dismissedPaths.delete(dir);
		updateRuntimeConfigSync((c) => ({
			...c,
			dismissedPaths: new Set(dismissedPaths),
		}));
		const existing = registry.findByDirectory(dir);
		if (existing) {
			await syncEffectProjectRegistry(
				"refresh existing project",
				syncEffectProjectAdd(existing.project),
			);
			return existing.project;
		}

		const existingSlugs = new Set(registry.slugs());
		const resolvedSlug = slug ?? generateSlug(dir, existingSlugs);
		const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
		const title = parts[parts.length - 1] ?? "project";
		const resolvedInstanceId =
			instanceId ??
			instanceManager.getInstances().find((i) => i.status === "healthy")?.id ??
			instanceManager.getInstances()[0]?.id;

		const project: StoredProject = {
			slug: resolvedSlug,
			directory: dir,
			title,
			lastUsed: Date.now(),
			...(resolvedInstanceId != null && {
				instanceId: resolvedInstanceId,
			}),
		};
		registry.addWithoutRelay(project);
		await syncEffectProjectRegistry(
			"add project",
			syncEffectProjectAdd(project),
		);
		syncRecentProjects(
			registry.allProjects().map((p) => ({
				path: p.directory,
				slug: p.slug,
				title: p.title,
			})),
			configDir,
		);
		await flushConfigSave();
		return project;
	}

	// ── Helper: removeProject ─────────────────────────────────────────────
	async function removeProject(slug: string): Promise<void> {
		const entry = registry.get(slug);
		if (!entry) throw new Error(`Project "${slug}" not found`);
		dismissedPaths.add(entry.project.directory);
		updateRuntimeConfigSync((c) => ({
			...c,
			dismissedPaths: new Set(dismissedPaths),
		}));
		await registry.remove(slug);
		await syncEffectProjectRegistry(
			"remove project",
			removeEffectProject(slug),
		);
		syncRecentProjects(
			registry.allProjects().map((p) => ({
				path: p.directory,
				slug: p.slug,
				title: p.title,
			})),
			configDir,
		);
		await flushConfigSave();
	}

	// ── Helper: getStatus ─────────────────────────────────────────────────
	function getStatus(): import("../../../daemon/daemon-types.js").DaemonStatus {
		const cfg = readRuntimeConfigSnapshot();
		const tsIP = getTailscaleIP();
		const allIPs = getAllIPs();
		const lanIP = allIPs.find((ip) => !ip.startsWith("100.")) ?? null;
		let sessionCount = 0;
		for (const slug of registry.slugs()) {
			const e = registry.get(slug);
			if (!e) continue;
			const relay = e.status === "ready" ? e.relay : undefined;
			const relayStatus = relay?.getStatusSnapshot();
			sessionCount +=
				relayStatus?.sessionCount ||
				cfg.persistedSessionCounts.get(slug) ||
				persistedSessionCounts.get(slug) ||
				0;
		}
		return {
			ok: true,
			uptime: (Date.now() - cfg.startTime) / 1000,
			port: cfg.port,
			host: cfg.host,
			...(tsIP != null && { tailscaleIP: tsIP }),
			...(lanIP != null && { lanIP }),
			projectCount: registry.size,
			sessionCount,
			clientCount: ctx.clientCount,
			pinEnabled: cfg.pinHash !== null,
			tlsEnabled: cfg.tlsEnabled,
			keepAwake: cfg.keepAwake,
			projects: Array.from(registry.slugs()).map((slug) => {
				// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.slugs() so the entry is guaranteed to exist
				const entry = registry.get(slug)!;
				return {
					slug,
					directory: entry.project.directory,
					title: entry.project.title,
					status: entry.status,
					...(entry.project.lastUsed != null && {
						lastUsed: entry.project.lastUsed,
					}),
				};
			}),
		};
	}

	// ── Helper: stop ──────────────────────────────────────────────────────
	async function stop(): Promise<void> {
		if (shuttingDown) return;
		readRuntimeConfigSnapshot();
		updateRuntimeConfigSync((config) => ({ ...config, shuttingDown: true }));
		shuttingDown = true;
		if (shutdownTimer) {
			clearTimeout(shutdownTimer);
			shutdownTimer = null;
		}
		await flushConfigSave();
		await saveDaemonConfig(buildConfig(), configDir);
		// Drain imperative services not yet Layer-managed (Tasks 6-7)
		await scanner?.drain();
		await instanceManager.drain();
		await registry.drain();
		scanner = null;
		// Dispose the Layer-managed runtime — tears down in reverse order:
		// servers (HTTP, IPC, onboarding), signal handlers, error handlers,
		// PID/socket file cleanup, KeepAwake, VersionChecker, StorageMonitor,
		// DaemonState, DaemonEventBus.
		const runtime = daemonRuntime;
		daemonRuntime = null;
		if (runtime) await runtime.dispose();
		shuttingDown = false;
	}

	// ── Lifecycle context ─────────────────────────────────────────────────
	const ctx: DaemonLifecycleContext = {
		httpServer: null,
		upgradeServer: null,
		onboardingServer: null,
		ipcServer: null,
		ipcClients: new Set(),
		clientCount: 0,
		socketPath,
		router: null,
	};

	function readBoundHttpPort(): number | null {
		const server = ctx.upgradeServer ?? ctx.httpServer;
		const addr = server?.address();
		return typeof addr === "object" && addr ? addr.port : null;
	}

	function syncBoundHttpPortSnapshot(): DaemonRuntimeConfig {
		const boundPort = readBoundHttpPort();
		if (boundPort == null || boundPort === runtimeConfigSnapshot.port) {
			return runtimeConfigSnapshot;
		}
		runtimeConfigSnapshot = { ...runtimeConfigSnapshot, port: boundPort };
		syncLegacyConfigLocals(runtimeConfigSnapshot);
		return runtimeConfigSnapshot;
	}

	// ── Rehydrate instances from config ───────────────────────────────────
	const savedConfig = loadDaemonConfig(configDir);
	if (savedConfig?.instances) {
		for (const inst of savedConfig.instances) {
			const existing = instanceManager.getInstance(inst.id);
			if (existing) {
				if (inst.name && inst.name !== existing.name) {
					try {
						instanceManager.updateInstance(inst.id, {
							name: inst.name,
						});
					} catch {
						// Non-fatal
					}
				}
				continue;
			}
			try {
				instanceManager.addInstance(inst.id, {
					name: inst.name,
					port: inst.port,
					managed: inst.managed,
					...(inst.env != null && { env: inst.env }),
					...(inst.url != null && { url: inst.url }),
				});
			} catch (err) {
				log.warn(
					`Failed to rehydrate instance "${inst.id}":`,
					formatErrorDetail(err),
				);
			}
		}
	}

	// ── Rehydrate projects from config ────────────────────────────────────
	if (savedConfig?.projects) {
		for (const proj of savedConfig.projects) {
			if (!proj.path || !proj.slug) continue;
			if (proj.sessionCount != null && proj.sessionCount > 0) {
				persistedSessionCounts.set(proj.slug, proj.sessionCount);
			}
			if (registry.has(proj.slug)) continue;
			const project: StoredProject = {
				slug: proj.slug,
				directory: proj.path,
				title: proj.title ?? proj.slug,
				lastUsed: proj.addedAt ?? Date.now(),
				...(proj.instanceId != null && {
					instanceId: proj.instanceId,
				}),
			};
			registry.addWithoutRelay(project, { silent: true });
		}
		if (registry.size > 0) {
			log.info(`Rehydrated ${registry.size} project(s) from saved config`);
		}
	}

	log.info(
		`[startup:${elapsed()}] Rehydrated config (${registry.size} projects, ${savedConfig?.instances?.length ?? 0} instances)`,
	);

	// ── Rehydrate dismissed paths ─────────────────────────────────────────
	if (savedConfig?.dismissedPaths) {
		for (const p of savedConfig.dismissedPaths) {
			if (typeof p === "string") dismissedPaths.add(p);
		}
	}
	if (savedConfig?.keepAwakeCommand) {
		keepAwakeCommand = savedConfig.keepAwakeCommand;
	}
	if (savedConfig?.keepAwakeArgs) {
		keepAwakeArgs = savedConfig.keepAwakeArgs;
	}
	updateRuntimeConfigSync((c) => ({
		...c,
		keepAwakeCommand,
		keepAwakeArgs,
		startTime: Date.now(),
		dismissedPaths: new Set(dismissedPaths),
		persistedSessionCounts: new Map(persistedSessionCounts),
	}));
	log.debug(`[startup:${elapsed()}] Rehydration complete`);

	// ── Probe-and-convert default instance ────────────────────────────────
	const existingDefault = instanceManager.getInstance("default");
	if (smartDefault && existingDefault && !existingDefault.managed) {
		const url = `http://localhost:${existingDefault.port}`;
		const reachable = await probeOpenCode(url);
		if (!reachable) {
			if (!(await isOpencodeInstalled())) {
				throw new Error(
					`OpenCode is not running at ${url} and the "opencode" binary ` +
						"was not found on PATH.\n" +
						"Install OpenCode first: https://opencode.ai\n" +
						"Or start it manually: opencode serve --port " +
						`${existingDefault.port}`,
				);
			}
			const { name, port: originalPort } = existingDefault;
			instanceManager.removeInstance("default");
			const freePort = await findFreePort(originalPort);
			instanceManager.addInstance("default", {
				name,
				port: freePort,
				managed: true,
			});
			log.info(
				`OpenCode not reachable at ${url} — will spawn managed instance on port ${freePort}`,
			);
		}
	}

	log.debug(`[startup:${elapsed()}] Probe-and-convert done`);

	// ── Smart default detection ───────────────────────────────────────────
	if (smartDefault && !instanceManager.getInstance("default")) {
		const probeUrl = DEFAULT_OPENCODE_URL;
		const reachable = await probeOpenCode(probeUrl);
		if (reachable) {
			instanceManager.addInstance("default", {
				name: "Default",
				port: DEFAULT_OPENCODE_PORT,
				managed: false,
				url: probeUrl,
			});
			log.info(
				"Detected running OpenCode at localhost:4096 — connecting as unmanaged",
			);
		} else {
			if (!(await isOpencodeInstalled())) {
				throw new Error(
					`OpenCode is not running at ${probeUrl} and the "opencode" ` +
						"binary was not found on PATH.\n" +
						"Install OpenCode first: https://opencode.ai\n" +
						`Or start it manually: opencode serve --port ${DEFAULT_OPENCODE_PORT}`,
				);
			}
			const freePort = await findFreePort(DEFAULT_OPENCODE_PORT);
			instanceManager.addInstance("default", {
				name: "Default",
				port: freePort,
				managed: true,
			});
			log.info(
				`No OpenCode detected — will spawn managed instance on port ${freePort}`,
			);
		}
	}

	log.debug(`[startup:${elapsed()}] Smart default detection done`);

	// ── Auto-start managed default instance ───────────────────────────────
	const defaultInst = instanceManager.getInstance("default");
	if (defaultInst?.managed && defaultInst.status === "stopped") {
		try {
			await instanceManager.startInstance("default");
		} catch (err) {
			log.warn(
				"Failed to auto-start default instance:",
				formatErrorDetail(err),
			);
		}
	}
	log.debug(`[startup:${elapsed()}] Instance auto-start done`);

	// ── IPC server ────────────────────────────────────────────────────────
	const getReadyProjectRelay = (slug: string): ProjectRelay => {
		const relay = registry.getRelay(slug);
		if (!relay) {
			throw new Error(`Project "${slug}" is not ready`);
		}
		return relay;
	};
	const ipcContext = {
		addProject: (dir: string) => addProject(dir),
		removeProject: (slug: string) => removeProject(slug),
		getStatus,
		getProjects: () => {
			const cfg = readRuntimeConfigSnapshot();
			return registry.allProjects().map((project) => {
				// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.allProjects() so the entry is guaranteed to exist
				const entry = registry.get(project.slug)!;
				const relay = entry.status === "ready" ? entry.relay : undefined;
				const relayStatus = relay?.getStatusSnapshot();
				return {
					...project,
					sessions:
						relayStatus?.sessionCount ||
						cfg.persistedSessionCounts.get(project.slug) ||
						persistedSessionCounts.get(project.slug) ||
						0,
					clients: relayStatus?.clients ?? 0,
					isProcessing: relayStatus?.isProcessing ?? false,
				};
			});
		},
		setProjectTitle: (slug: string, title: string) => {
			registry.updateProject(slug, { title });
			syncEffectProjectRegistrySoon(
				"set project title",
				updateEffectProject(slug, { title }),
			);
		},
		persistConfig: () => persistConfig(),
		getInstances: () => instanceManager.getInstances(),
		getInstance: (id: string) => instanceManager.getInstance(id),
		addInstance: (
			id: string,
			config: import("../../../types.js").InstanceConfig,
		) => instanceManager.addInstance(id, config),
		removeInstance: (id: string) => instanceManager.removeInstance(id),
		startInstance: (id: string) => instanceManager.startInstance(id),
		stopInstance: (id: string) => instanceManager.stopInstance(id),
		updateInstance: (
			id: string,
			updates: {
				name?: string;
				env?: Record<string, string>;
				port?: number;
			},
		) => instanceManager.updateInstance(id, updates),
		setProjectAgent: async (slug: string, agent: string) => {
			const relay = getReadyProjectRelay(slug);
			await relay.setDefaultAgent(agent);
		},
		setProjectModel: async (
			slug: string,
			model: { providerID: string; modelID: string },
		) => {
			const relay = getReadyProjectRelay(slug);
			await relay.setDefaultModel(model);
		},
	};

	// IPC server is now started by makeIpcServerLive (via makeDaemonLive).
	log.debug(`[startup:${elapsed()}] IPC context built`);

	// ── Push notifications ────────────────────────────────────────────────
	try {
		const { PushNotificationManager } = await import("../../../server/push.js");
		pushManager = new PushNotificationManager({ configDir });
		await pushManager.init();
	} catch (err) {
		log.warn("Push notifications unavailable:", formatErrorDetail(err));
		pushManager = null;
	}
	log.debug(`[startup:${elapsed()}] Push notifications init done`);

	// ── HTTP request router ───────────────────────────────────────────────
	const getRouterProjects = (): RouterProjectInfo[] => {
		const cfg = readRuntimeConfigSnapshot();
		return registry.allProjects().map((project) => {
			// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.allProjects() so the entry is guaranteed to exist
			const entry = registry.get(project.slug)!;
			const relay = entry.status === "ready" ? entry.relay : undefined;
			const relayStatus = relay?.getStatusSnapshot();
			return {
				slug: project.slug,
				directory: project.directory,
				title: project.title,
				status: entry.status,
				...(entry.status === "error" && { error: entry.error }),
				clients: relayStatus?.clients ?? 0,
				sessions:
					relayStatus?.sessionCount ||
					cfg.persistedSessionCounts.get(project.slug) ||
					persistedSessionCounts.get(project.slug) ||
					0,
				isProcessing: relayStatus?.isProcessing ?? false,
			} satisfies RouterProjectInfo;
		});
	};

	// CaCertProvider is now available via TlsCertTag in the Layer.
	// The /ca/download endpoint uses Effect.serviceOption(CaCertProvider) and
	// handles absence gracefully. A future task will wire the router to read
	// directly from TlsCertTag.

	// ── Layer-managed daemon lifecycle ────────────────────────────────────
	const onboardingDeps = {
		caRootPath: null as string | null,
		caCertDer: null as Buffer | null,
		staticDir,
	};

	const initialRuntimeConfig = readRuntimeConfigSnapshot();
	const firstProject = registry.allProjects()[0];
	const scheduleLegacyPostResponseShutdown = () => {
		shutdownTimer = setTimeout(() => {
			void stop().catch((err) => {
				log.warn(
					{ err: formatErrorDetail(err) },
					"Scheduled daemon shutdown failed",
				);
			});
		}, DAEMON_SHUTDOWN_DELAY_MS);
	};
	const daemonLiveOptions: DaemonLiveOptions = {
		configDir,
		pidPath,
		socketPath,
		ctx,
		ipcContext,
		ipcPostResponseActions: {
			scheduleShutdown: scheduleLegacyPostResponseShutdown,
		},
		onboarding: onboardingDeps,
		httpRouter: {
			staticDir,
			getProjects: getRouterProjects,
			removeProject,
			getHealthResponse: () => getStatus(),
			loadThemes: loadThemeFiles,
			pushManager,
		},
		initialConfig: initialRuntimeConfig,
		// KeepAwake config — pure Effect Layer replaces imperative KeepAwake class.
		// Always provide config (even empty) so the Layer is created; platform
		// detection in KeepAwakeLive handles the default command.
		keepAwake: initialRuntimeConfig.keepAwakeCommand
			? {
					command: initialRuntimeConfig.keepAwakeCommand,
					...(initialRuntimeConfig.keepAwakeArgs != null && {
						args: [...initialRuntimeConfig.keepAwakeArgs],
					}),
				}
			: {},
		// VersionChecker config — pure Effect Layer replaces imperative VersionChecker class.
		...(!process.argv.includes("--no-update") && {
			versionCheck: {
				getCurrentVersion: getVersion,
				fetchLatestVersion: () =>
					Effect.tryPromise(() =>
						fetchLatestVersion("conduit-code", "https://registry.npmjs.org"),
					).pipe(Effect.orElseSucceed(() => null)),
				broadcast: (msg: { type: string; current: string; latest: string }) =>
					Effect.sync(() =>
						registry.broadcastToAll({
							type: "update_available",
							version: msg.latest,
						}),
					),
				checkInterval: Duration.hours(1),
			},
		}),
		// StorageMonitor config — pure Effect Layer replaces imperative StorageMonitor class.
		storageMon: {
			getStorageUsage: () =>
				Effect.tryPromise(async () => {
					const monitorPath = firstProject?.directory ?? process.cwd();
					const stats = await statfs(monitorPath);
					const total = stats.blocks * stats.bsize;
					const available = stats.bavail * stats.bsize;
					return total > 0 ? 1 - available / total : 0;
				}).pipe(Effect.catchAll(() => Effect.succeed(0))),
			persistence: {
				// TODO: Wire to ProjectRegistryTag after Task 6
				evictOldEvents: () => Effect.void,
			},
			checkInterval: Duration.minutes(5),
			highWaterMark: 0.9,
		},
		// PortScanner: deferred to Task 7
		configPath: join(configDir, "daemon.json"),
		configSnapshot: buildConfig,
		relayFactory: (slug: string) =>
			Effect.tryPromise({
				try: async () => {
					ensureRelayStarted(slug);
					const relay = await registry.waitForRelay(slug, 10_000);
					return {
						slug,
						wsHandler: {
							handleUpgrade: (
								...args: Parameters<ProjectRelay["wsHandler"]["handleUpgrade"]>
							) => {
								registry.touchLastUsed(slug);
								relay.wsHandler.handleUpgrade(...args);
							},
						},
						rpcWsHandler: {
							handleUpgrade: (
								...args: Parameters<
									ProjectRelay["rpcWsHandler"]["handleUpgrade"]
								>
							) => {
								registry.touchLastUsed(slug);
								relay.rpcWsHandler.handleUpgrade(...args);
							},
						},
						// Relay lifecycle is still owned by the legacy ProjectRegistry in
						// this hybrid daemon; RelayCache only avoids duplicate WS starts.
						stop: () => {},
					};
				},
				catch: (cause) => cause,
			}),
	};

	// Create and build the daemon Layer — starts servers, installs signal/error
	// handlers, writes PID file, creates DaemonState, DaemonEventBus, PinoLogger,
	// CrashCounter, AuthManager (reactive pinHash from DaemonConfigRef).
	try {
		daemonRuntime = ManagedRuntime.make(makeDaemonLive(daemonLiveOptions));
		await daemonRuntime.runPromise(Effect.void);
	} catch (err) {
		log.error({ err: formatErrorDetail(err) }, "Daemon startup failed");
		throw err;
	}

	const postStartupConfig = syncBoundHttpPortSnapshot();
	log.debug(`[startup:${elapsed()}] Servers started via Layer`);
	log.info(
		`[startup:${elapsed()}] TLS certs ${postStartupConfig.tlsEnabled ? "loaded" : "skipped"}`,
	);

	// ── Port scanner ──────────────────────────────────────────────────────
	if (smartDefault) {
		scanner = new PortScanner(
			{
				portRange: [4096, 4110],
				intervalMs: 30_000,
				probeTimeoutMs: 2000,
				removalThreshold: 3,
			},
			(p) => probeOpenCodePort(p),
		);

		const managedPorts = new Set(
			instanceManager
				.getInstances()
				.filter((i) => i.managed)
				.map((i) => i.port),
		);
		scanner.excludePorts(managedPorts);

		scanner.onScan = (result: ScanResult) => {
			for (const p of result.discovered) {
				const existing = instanceManager
					.getInstances()
					.find((i) => i.port === p);
				if (existing) continue;
				const id = `discovered-${p}`;
				try {
					instanceManager.addInstance(id, {
						name: `OpenCode :${p}`,
						port: p,
						managed: false,
					});
					log.info(`Auto-discovered OpenCode instance on port ${p}`);
				} catch (err) {
					log.warn(
						`Failed to register discovered instance on port ${p}:`,
						formatErrorDetail(err),
					);
				}
			}
			for (const p of result.lost) {
				const instance = instanceManager
					.getInstances()
					.find((i) => i.port === p && !i.managed);
				if (instance) {
					try {
						instanceManager.removeInstance(instance.id);
						log.info(`Removed lost instance "${instance.id}" (port ${p})`);
					} catch {
						// Already removed
					}
				}
			}
			if (result.discovered.length > 0 || result.lost.length > 0) {
				const instances = instanceManager.getInstances();
				registry.broadcastToAll({ type: "instance_list", instances });
			}
		};
		scanner.start();
		void scanner.scan();
	}

	log.info(`[startup:${elapsed()}] Port scanner + WS upgrade handler ready`);
	log.info(
		`[startup:${elapsed()}] Relay startup dispatched for ${registry.size} project(s)`,
	);

	// ── Instance status listener for relay resets ─────────────────────────
	instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
		if (instance.status !== "healthy") return;
		for (const slug of registry.slugs()) {
			// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.slugs() so the entry is guaranteed to exist
			const entry = registry.get(slug)!;
			if (entry.status === "error") {
				registry.addWithoutRelay(entry.project, { silent: true });
			}
		}
	});

	// Signal handlers and error handlers are now managed by
	// SignalHandlerLayer and ProcessErrorHandlerLayer (via makeDaemonLive).

	// ── Discover projects (non-blocking) ──────────────────────────────────
	if (smartDefault) {
		void discoverProjects().catch((err) => {
			log.warn(
				"Failed to discover projects on startup:",
				formatErrorDetail(err),
			);
		});
	}

	clearCrashInfo(configDir);
	await saveDaemonConfig(buildConfig(), configDir);

	// Background services (VersionChecker, KeepAwake, StorageMonitor) are now
	// managed by their respective Effect Layers via makeDaemonLive.

	log.info(`Daemon fully started in ${elapsed()}`);

	// Event loop monitoring handled by Layer

	// ── discoverProjects helper ───────────────────────────────────────────
	async function discoverProjects(): Promise<void> {
		const discoveryUrl = resolveOpencodeUrl();
		if (!discoveryUrl) return;
		const discoveryLog = createLogger("relay").child("discovery");
		try {
			const { createSdkClient } = await import(
				"../../../instance/sdk-factory.js"
			);
			const { client } = createSdkClient({ baseUrl: discoveryUrl });
			const result = await client.project.list();
			const projects =
				(
					result as {
						data?: Array<{
							id?: string;
							worktree?: string;
							path?: string;
						}>;
					}
				).data ?? [];
			let added = 0;
			for (const p of projects) {
				const dir = p.worktree ?? p.path;
				if (dir && dir !== "/") {
					const normalizedDir = resolve(dir);
					if (dismissedPaths.has(normalizedDir)) continue;
					try {
						const sizeBefore = registry.size;
						await addProject(dir);
						if (registry.size > sizeBefore) added++;
					} catch {
						// Non-fatal
					}
				}
			}
			for (const slug of registry.slugs()) {
				// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.slugs() so the entry is guaranteed to exist
				const entry = registry.get(slug)!;
				if (entry.status !== "error") continue;
				registry.addWithoutRelay(entry.project, { silent: true });
				discoveryLog.info({ slug }, "Reset error-state project for lazy retry");
			}
			discoveryLog.info(
				`Discovered ${projects.length} project(s) from OpenCode, registered ${added}`,
			);
		} catch (err) {
			discoveryLog.warn(
				"Failed to discover projects from OpenCode:",
				formatErrorDetail(err),
			);
		}
	}

	// ── Return DaemonHandle ───────────────────────────────────────────────
	return {
		get port() {
			return runtimeConfigSnapshot.port;
		},
		get onboardingPort() {
			const server = ctx.onboardingServer;
			if (!server) return null;
			const addr = server.address();
			return typeof addr === "object" && addr ? addr.port : null;
		},
		addProject,
		discoverProjects,
		getStatus,
		stop,
		getProjects: () => registry.allProjects(),
		getInstances: () => instanceManager.getInstances(),
		removeProject,
		registry,
	};
}
