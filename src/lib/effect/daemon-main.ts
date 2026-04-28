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

import {
	NodeFileSystem,
	NodeHttpServer,
	NodePath,
} from "@effect/platform-node";
import type { Fiber } from "effect";
import {
	Context,
	Effect,
	Layer,
	RuntimeFlags,
	RuntimeFlagsPatch,
	Schedule,
	Supervisor,
} from "effect";

import type { DaemonOptions } from "../daemon/daemon-types.js";
import {
	type CrashLimitExceeded,
	runStartupSequence,
} from "./daemon-startup.js";
import {
	type ConfigTag,
	type CrashCounterTag,
	type DaemonStateTag,
	type InstanceMgmtTag,
	type LoggerTag,
	type PersistencePathTag,
	ProjectMgmtTag,
	type RelayCacheTag,
} from "./services.js";

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
	| PersistencePathTag
	| InstanceMgmtTag
	| ProjectMgmtTag
	| RelayCacheTag
	| ConfigTag
	| LoggerTag;

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

// ─── Imperative bridge: startDaemonProcess ───────────────────────────────
// Standalone startup function that replaces `new Daemon(options).start()`.
// Orchestrates the same initialization sequence the Daemon class performed,
// using the already-extracted helper modules (daemon-lifecycle, daemon-ipc,
// project-registry, instance-manager, config-persistence, etc.).

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthManager } from "../auth.js";
import {
	ensureCerts,
	getAllIPs,
	getTailscaleIP,
	type TlsCerts,
} from "../cli/tls.js";
import {
	DAEMON_SHUTDOWN_DELAY_MS,
	DEFAULT_OPENCODE_PORT,
	DEFAULT_OPENCODE_URL,
} from "../constants.js";
import {
	clearCrashInfo,
	type DaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
	syncRecentProjects,
} from "../daemon/config-persistence.js";
import { CrashCounter } from "../daemon/crash-counter.js";
import {
	closeHttpServer,
	closeIPCServer,
	closeOnboardingServer,
	type DaemonLifecycleContext,
	startHttpServer,
	startIPCServer,
	startOnboardingServer,
} from "../daemon/daemon-lifecycle.js";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
	probeOpenCodePort,
} from "../daemon/daemon-utils.js";
import { KeepAwake } from "../daemon/keep-awake.js";
import {
	removePidFile,
	removeSocketFile,
	writePidFile,
} from "../daemon/pid-manager.js";
import { PortScanner, type ScanResult } from "../daemon/port-scanner.js";
import { ProjectRegistry } from "../daemon/project-registry.js";
import {
	installSignalHandlers,
	removeSignalHandlers,
} from "../daemon/signal-handlers.js";
import { StorageMonitor } from "../daemon/storage-monitor.js";
import { VersionChecker } from "../daemon/version-check.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../env.js";
import { formatErrorDetail } from "../errors.js";
import { InstanceManager } from "../instance/instance-manager.js";
import { createLogger, setLogFormat, setLogLevel } from "../logger.js";
import { PersistenceLayer } from "../persistence/persistence-layer.js";
import type { ProjectRelay } from "../relay/relay-stack.js";
import {
	CaCertProvider,
	effectRouterWithCors,
	HealthProvider,
	ProjectsProvider,
	PushProvider,
	RemoveProjectProvider,
	type RouterProjectInfo,
	SetupInfoProvider,
	ThemeProvider,
} from "../server/effect-http-router.js";
import { getClientIp, parseCookies } from "../server/http-utils.js";
import type { PushNotificationManager } from "../server/push.js";
import { loadThemeFiles } from "../server/theme-loader.js";
import type { OpenCodeInstance, StoredProject } from "../types.js";
import { generateSlug } from "../utils.js";
import { AuthManagerTag } from "./auth-middleware.js";
import { StaticDirTag } from "./static-file-handler.js";

/**
 * Default frontend directory resolved relative to this file.
 * Compiled: dist/src/lib/effect/daemon-main.js -> 3x.. -> dist/ -> dist/frontend/
 * Dev (tsx): src/lib/effect/daemon-main.ts -> 3x.. -> repo root -> frontend/ (doesn't exist)
 * Falls back to cwd-based resolution for dev mode.
 */
const _candidate = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"frontend",
);
const DEFAULT_STATIC_DIR = existsSync(_candidate)
	? _candidate
	: join(process.cwd(), "dist", "frontend");

/**
 * Structural type covering the running daemon's public surface.
 * Used by cli-core.ts (foreground mode) and test harnesses.
 */
export interface DaemonHandle {
	readonly port: number;
	addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<import("../types.js").StoredProject>;
	discoverProjects(): Promise<void>;
	getStatus(): import("../daemon/daemon-types.js").DaemonStatus;
	/** Gracefully stop the daemon (servers, services, PID/socket cleanup). */
	stop(): Promise<void>;
	/** Get all registered projects. */
	getProjects(): ReadonlyArray<Readonly<import("../types.js").StoredProject>>;
	/** Get all registered OpenCode instances. */
	getInstances(): ReadonlyArray<
		Readonly<import("../types.js").OpenCodeInstance>
	>;
	/** Remove a project by slug. */
	removeProject(slug: string): Promise<void>;
	/**
	 * Direct access to the ProjectRegistry for integration/E2E tests.
	 * Not part of the public API — callers should prefer addProject/removeProject/getStatus.
	 */
	readonly registry: import("../daemon/project-registry.js").ProjectRegistry;
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
	const hostExplicit = options.host != null;
	const smartDefault = options.smartDefault ?? true;

	// Ensure config directory exists
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// ── Crash counter ─────────────────────────────────────────────────────
	const crashCounter = new CrashCounter();
	crashCounter.record();
	if (crashCounter.shouldGiveUp()) {
		throw new Error(
			"Daemon crashed too many times within crash window — giving up",
		);
	}

	// ── PID file ──────────────────────────────────────────────────────────
	writePidFile(configDir, pidPath);
	log.debug(`[startup:${elapsed()}] PID file + crash counter done`);

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
	let _eventLoopTimer: ReturnType<typeof setInterval> | null = null;
	let tlsCerts: TlsCerts | null = null;
	let pushManager: PushNotificationManager | null = null;
	let versionChecker: VersionChecker | null = null;
	let keepAwakeManager: KeepAwake | null = null;
	let storageMonitor: StorageMonitor | null = null;
	let scanner: PortScanner | null = null;
	let _onUnhandledRejection: ((err: unknown) => void) | null = null;
	let _onUncaughtException: ((err: Error) => void) | null = null;

	const persistedSessionCounts = new Map<string, number>();
	const dismissedPaths = new Set<string>();

	// ── Core services ─────────────────────────────────────────────────────
	const auth = new AuthManager();
	if (pinHash) auth.setPinHash(pinHash);

	const instanceManager = new InstanceManager();
	const registry = new ProjectRegistry();

	// ── Config persistence (coalescing) ───────────────────────────────────
	let _pendingSave: Promise<void> | null = null;
	let _needsResave = false;

	function buildConfig(): DaemonConfig {
		return {
			pid: process.pid,
			port,
			pinHash,
			tls: tlsEnabled,
			debug: false,
			keepAwake,
			...(keepAwakeCommand != null && { keepAwakeCommand }),
			...(keepAwakeArgs != null && { keepAwakeArgs }),
			dangerouslySkipPermissions: false,
			projects: registry.allProjects().map((p) => {
				const e = registry.get(p.slug);
				const relay = e?.status === "ready" ? e.relay : undefined;
				const sessionCount = relay?.sessionMgr.getLastKnownSessionCount() || 0;
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
			...(dismissedPaths.size > 0 && {
				dismissedPaths: Array.from(dismissedPaths),
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

	function applyRestartConfig(config: Record<string, unknown>): void {
		if (typeof config["port"] === "number") port = config["port"];
		if (typeof config["tls"] === "boolean") tlsEnabled = config["tls"];
		if (typeof config["pinHash"] === "string" || config["pinHash"] === null) {
			pinHash = config["pinHash"];
			if (pinHash) auth.setPinHash(pinHash);
		}
		if (typeof config["keepAwake"] === "boolean") {
			keepAwake = config["keepAwake"];
			keepAwakeManager?.setEnabled(keepAwake);
		}
		if (typeof config["keepAwakeCommand"] === "string") {
			keepAwakeCommand = config["keepAwakeCommand"];
		}
		if (
			Array.isArray(config["keepAwakeArgs"]) &&
			config["keepAwakeArgs"].every((arg) => typeof arg === "string")
		) {
			keepAwakeArgs = config["keepAwakeArgs"];
		}
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
			const persistence = PersistenceLayer.open(dbPath);
			signal.addEventListener("abort", () => persistence.close(), {
				once: true,
			});
			const { createProjectRelay } = await import("../relay/relay-stack.js");
			return createProjectRelay({
				// biome-ignore lint/style/noNonNullAssertion: relay factory is only invoked after the HTTP server has been started
				httpServer: ctx.httpServer!,
				opencodeUrl,
				projectDir: project.directory,
				slug: project.slug,
				noServer: true,
				signal,
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
				...(versionChecker != null && {
					getCachedUpdate: () =>
						versionChecker?.isUpdateAvailable()
							? versionChecker.getLatestVersion()
							: null,
				}),
				persistence,
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
		const existing = registry.findByDirectory(dir);
		if (existing) return existing.project;

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
		await registry.remove(slug);
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
	function getStatus(): import("../daemon/daemon-types.js").DaemonStatus {
		const tsIP = getTailscaleIP();
		const allIPs = getAllIPs();
		const lanIP = allIPs.find((ip) => !ip.startsWith("100.")) ?? null;
		let sessionCount = 0;
		for (const slug of registry.slugs()) {
			const e = registry.get(slug);
			if (!e) continue;
			const relay = e.status === "ready" ? e.relay : undefined;
			sessionCount +=
				relay?.sessionMgr.getLastKnownSessionCount() ||
				persistedSessionCounts.get(slug) ||
				0;
		}
		return {
			ok: true,
			uptime: (Date.now() - startTime) / 1000,
			port,
			host,
			...(tsIP != null && { tailscaleIP: tsIP }),
			...(lanIP != null && { lanIP }),
			projectCount: registry.size,
			sessionCount,
			clientCount: ctx.clientCount,
			pinEnabled: pinHash !== null,
			tlsEnabled,
			keepAwake,
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
		shuttingDown = true;
		if (shutdownTimer) {
			clearTimeout(shutdownTimer);
			shutdownTimer = null;
		}
		removeSignalHandlers();
		if (_onUnhandledRejection) {
			process.removeListener("unhandledRejection", _onUnhandledRejection);
			_onUnhandledRejection = null;
		}
		if (_onUncaughtException) {
			process.removeListener("uncaughtException", _onUncaughtException);
			_onUncaughtException = null;
		}
		if (_eventLoopTimer) clearInterval(_eventLoopTimer);
		_eventLoopTimer = null;
		await flushConfigSave();
		await saveDaemonConfig(buildConfig(), configDir);
		await keepAwakeManager?.drain();
		await versionChecker?.drain();
		await storageMonitor?.drain();
		await scanner?.drain();
		await instanceManager.drain();
		await registry.drain();
		scanner = null;
		versionChecker = null;
		storageMonitor = null;
		keepAwakeManager = null;
		for (const client of ctx.ipcClients) {
			try {
				client.destroy();
			} catch {
				/* already closed */
			}
		}
		ctx.ipcClients.clear();
		await closeIPCServer(ctx);
		await closeOnboardingServer(ctx);
		await closeHttpServer(ctx);
		removePidFile(pidPath);
		removeSocketFile(socketPath);
		shuttingDown = false;
	}

	// ── Lifecycle context ─────────────────────────────────────────────────
	const ctx: DaemonLifecycleContext = {
		port,
		host,
		httpServer: null,
		upgradeServer: null,
		onboardingServer: null,
		ipcServer: null,
		ipcClients: new Set(),
		clientCount: 0,
		socketPath,
		router: null,
	};

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
	const ipcContext = {
		addProject: (dir: string) => addProject(dir),
		removeProject: (slug: string) => removeProject(slug),
		getProjects: () =>
			registry.allProjects().map((project) => {
				// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.allProjects() so the entry is guaranteed to exist
				const entry = registry.get(project.slug)!;
				const relay = entry.status === "ready" ? entry.relay : undefined;
				return {
					...project,
					sessions:
						relay?.sessionMgr.getLastKnownSessionCount() ||
						persistedSessionCounts.get(project.slug) ||
						0,
					clients: relay?.wsHandler.getClientCount() ?? 0,
					isProcessing: relay?.isAnySessionProcessing() ?? false,
				};
			}),
		setProjectTitle: (slug: string, title: string) => {
			registry.updateProject(slug, { title });
		},
		getPinHash: () => pinHash,
		setPinHash: (hash: string) => {
			pinHash = hash;
			auth.setPinHash(hash);
			persistConfig();
		},
		getKeepAwake: () => keepAwake,
		setKeepAwake: (enabled: boolean) => {
			keepAwake = enabled;
			keepAwakeManager?.setEnabled(enabled);
			persistConfig();
			return {
				supported: keepAwakeManager?.isSupported() ?? false,
				active: keepAwakeManager?.isActive() ?? false,
			};
		},
		setKeepAwakeCommand: (command: string, args: string[]) => {
			keepAwakeCommand = command;
			keepAwakeArgs = args;
			keepAwakeManager?.deactivate();
			keepAwakeManager = new KeepAwake({
				enabled: keepAwake,
				command,
				args,
			});
			keepAwakeManager.onError = ({ error }) => {
				log.warn("KeepAwake error:", formatErrorDetail(error));
			};
			if (keepAwake) keepAwakeManager.activate();
			persistConfig();
		},
		persistConfig: () => persistConfig(),
		scheduleShutdown: () => {
			shutdownTimer = setTimeout(() => stop(), DAEMON_SHUTDOWN_DELAY_MS);
		},
		applyConfig: (config: Record<string, unknown>) => {
			applyRestartConfig(config);
		},
		getInstances: () => instanceManager.getInstances(),
		getInstance: (id: string) => instanceManager.getInstance(id),
		addInstance: (id: string, config: import("../types.js").InstanceConfig) =>
			instanceManager.addInstance(id, config),
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
	};

	await startIPCServer(ctx, ipcContext, getStatus);
	log.debug(`[startup:${elapsed()}] IPC server listening`);

	// ── Push notifications ────────────────────────────────────────────────
	try {
		const { PushNotificationManager } = await import("../server/push.js");
		pushManager = new PushNotificationManager({ configDir });
		await pushManager.init();
	} catch (err) {
		log.warn("Push notifications unavailable:", formatErrorDetail(err));
		pushManager = null;
	}
	log.debug(`[startup:${elapsed()}] Push notifications init done`);

	// ── TLS ───────────────────────────────────────────────────────────────
	if (tlsEnabled) {
		try {
			tlsCerts = await ensureCerts({ configDir });
			if (!tlsCerts) {
				log.warn("TLS enabled but mkcert not available — falling back to HTTP");
				tlsEnabled = false;
			} else if (!hostExplicit) {
				host = "0.0.0.0";
				ctx.host = host;
			}
		} catch (err) {
			log.warn(
				"TLS cert loading failed — falling back to HTTP:",
				formatErrorDetail(err),
			);
			tlsEnabled = false;
		}
	}

	if (tlsCerts) {
		ctx.tls = {
			key: tlsCerts.key,
			cert: tlsCerts.caCertPem
				? Buffer.concat([tlsCerts.cert, Buffer.from("\n"), tlsCerts.caCertPem])
				: tlsCerts.cert,
		};
	}

	log.info(
		`[startup:${elapsed()}] TLS certs ${tlsEnabled ? "loaded" : "skipped"}`,
	);

	// ── HTTP request router ───────────────────────────────────────────────
	const getRouterProjects = (): RouterProjectInfo[] =>
		registry.allProjects().map((project) => {
			// biome-ignore lint/style/noNonNullAssertion: slug comes from registry.allProjects() so the entry is guaranteed to exist
			const entry = registry.get(project.slug)!;
			const relay = entry.status === "ready" ? entry.relay : undefined;
			return {
				slug: project.slug,
				directory: project.directory,
				title: project.title,
				status: entry.status,
				...(entry.status === "error" && { error: entry.error }),
				clients: relay?.wsHandler.getClientCount() ?? 0,
				sessions:
					relay?.sessionMgr.getLastKnownSessionCount() ||
					persistedSessionCounts.get(project.slug) ||
					0,
				isProcessing: relay?.isAnySessionProcessing() ?? false,
			} satisfies RouterProjectInfo;
		});

	// biome-ignore lint/suspicious/noExplicitAny: optional daemon providers are merged conditionally.
	let routerLayer: Layer.Layer<any, never, never> = Layer.mergeAll(
		Layer.succeed(AuthManagerTag, auth),
		Layer.succeed(StaticDirTag, staticDir),
		Layer.succeed(ProjectsProvider, { getProjects: getRouterProjects }),
		Layer.succeed(RemoveProjectProvider, {
			removeProject: (slug: string) =>
				Effect.tryPromise(() => removeProject(slug)),
		}),
		Layer.succeed(SetupInfoProvider, { port, isTls: tlsEnabled }),
		Layer.succeed(HealthProvider, { getHealthResponse: () => getStatus() }),
		Layer.succeed(ThemeProvider, { loadThemes: loadThemeFiles }),
		NodeFileSystem.layer,
		NodePath.layer,
	);
	if (pushManager != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(PushProvider, {
				getPublicKey: () => pushManager?.getPublicKey() ?? undefined,
				addSubscription: (endpoint, subscription) =>
					pushManager?.addSubscription(
						endpoint,
						subscription as Parameters<
							PushNotificationManager["addSubscription"]
						>[1],
					),
				removeSubscription: (endpoint) =>
					pushManager?.removeSubscription(endpoint),
			}),
		);
	}
	if (tlsCerts?.caRoot != null || tlsCerts?.caCertDer != null) {
		routerLayer = Layer.merge(
			routerLayer,
			Layer.succeed(CaCertProvider, {
				caCertDer: tlsCerts?.caCertDer ?? undefined,
				caRootPath: tlsCerts?.caRoot ?? undefined,
			}),
		);
	}

	const effectHandler = Effect.runSync(
		NodeHttpServer.makeHandler(
			effectRouterWithCors.pipe(Effect.provide(routerLayer)),
		),
	);
	ctx.router = {
		handleRequest: async (req, res) => {
			effectHandler(req, res);
		},
	};

	// ── Start HTTP server ─────────────────────────────────────────────────
	// Sync port/host into ctx before starting (they may have changed from TLS detection)
	ctx.port = port;
	ctx.host = host;
	await startHttpServer(ctx);
	// Read back the actual port (important when port 0 is used)
	port = ctx.port;
	log.debug(`[startup:${elapsed()}] HTTP server listening`);

	// ── Onboarding server ─────────────────────────────────────────────────
	if (tlsEnabled) {
		await startOnboardingServer(ctx, {
			caRootPath: tlsCerts?.caRoot ?? null,
			caCertDer: tlsCerts?.caCertDer ?? null,
			staticDir,
		});
	}

	// ── WebSocket upgrade routing ─────────────────────────────────────────
	const wsServer = ctx.upgradeServer ?? ctx.httpServer;
	wsServer?.on("upgrade", async (req, socket, head) => {
		const match = req.url?.match(/^\/p\/([^/]+)\/ws(?:\?|$)/);
		if (!match) {
			log.debug(
				{ url: req.url },
				"WS upgrade rejected: URL does not match /p/{slug}/ws",
			);
			socket.destroy();
			return;
		}
		// biome-ignore lint/style/noNonNullAssertion: regex matched successfully so capture group 1 is always present
		const slug = match[1]!;
		const cookies = parseCookies(req.headers.cookie ?? "");
		const sessionCookie = cookies["relay_session"] ?? "";
		const pinHeader = req.headers["x-relay-pin"];
		const authenticated =
			!auth.hasPin() ||
			auth.validateCookie(sessionCookie) ||
			(typeof pinHeader === "string" &&
				auth.authenticate(pinHeader, getClientIp(req)).ok);
		if (!authenticated) {
			log.warn({ slug }, "WS upgrade rejected: auth failed");
			socket.destroy();
			return;
		}
		try {
			ensureRelayStarted(slug);
			const relay = await registry.waitForRelay(slug, 10_000);
			if (socket.destroyed || shuttingDown) {
				if (!socket.destroyed) socket.destroy();
				return;
			}
			log.debug({ slug }, "WS upgrade accepted");
			registry.touchLastUsed(slug);
			relay.wsHandler.handleUpgrade(req, socket, head);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log.warn(
				{ slug, error: formatErrorDetail(err) },
				`WS upgrade rejected: ${errMsg}`,
			);
			if (!socket.destroyed) {
				if (socket.writable) {
					socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
				}
				socket.destroy();
			}
		}
	});

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

	// ── Prefetch session counts ───────────────────────────────────────────
	for (const slug of registry.slugs()) {
		const entry = registry.get(slug);
		if (!entry) continue;
		if (persistedSessionCounts.has(slug)) continue;
		const url = resolveOpencodeUrl(entry.project.instanceId);
		if (!url) continue;
		const instanceId = entry.project.instanceId ?? "default";
		const instance = instanceManager.getInstance(instanceId);
		const password =
			instance?.env?.["OPENCODE_SERVER_PASSWORD"] ??
			process.env["OPENCODE_SERVER_PASSWORD"] ??
			"";
		const username =
			instance?.env?.["OPENCODE_SERVER_USERNAME"] ??
			process.env["OPENCODE_SERVER_USERNAME"] ??
			"opencode";
		const headers: Record<string, string> = {
			"x-opencode-directory": entry.project.directory,
		};
		if (password) {
			headers["Authorization"] =
				`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
		}
		fetch(`${url}/session?limit=10000`, { headers })
			.then((res) => res.json())
			.then((data: unknown) => {
				if (Array.isArray(data)) {
					persistedSessionCounts.set(slug, data.length);
				}
			})
			.catch(() => {
				// Best-effort
			});
	}

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

	// ── Signal handlers ───────────────────────────────────────────────────
	installSignalHandlers(() => {
		stop();
	});

	_onUnhandledRejection = (err) => {
		log.error(
			{ error: err instanceof Error ? err.message : String(err) },
			"Unhandled rejection (daemon kept alive)",
		);
	};
	_onUncaughtException = (err) => {
		log.error(
			{ error: err.message, stack: err.stack },
			"Uncaught exception (daemon kept alive)",
		);
	};
	process.on("unhandledRejection", _onUnhandledRejection);
	process.on("uncaughtException", _onUncaughtException);

	startTime = Date.now();

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

	// ── Background services ───────────────────────────────────────────────
	versionChecker = new VersionChecker({
		enabled: !process.argv.includes("--no-update"),
	});
	versionChecker.onUpdateAvailable = ({ latest }) => {
		registry.broadcastToAll({ type: "update_available", version: latest });
	};
	versionChecker.start();

	keepAwakeManager = new KeepAwake({
		enabled: keepAwake,
		...(keepAwakeCommand != null && { command: keepAwakeCommand }),
		...(keepAwakeArgs != null && { args: keepAwakeArgs }),
	});
	keepAwakeManager.onError = ({ error }) => {
		log.warn("KeepAwake error:", formatErrorDetail(error));
	};
	keepAwakeManager.activate();

	const firstProject = registry.allProjects()[0];
	storageMonitor = new StorageMonitor({
		path: firstProject?.directory ?? process.cwd(),
	});
	storageMonitor.onLowDiskSpace = ({ availableBytes, thresholdBytes }) => {
		log.warn(
			`Low disk space warning: ${availableBytes / 1024 / 1024}MB available (threshold: ${thresholdBytes / 1024 / 1024}MB)`,
		);
		const summaries = registry.evictOldestSessions(3);
		if (summaries.length > 0) {
			for (const summary of summaries) log.info(`Eviction: ${summary}`);
		} else {
			log.info("Eviction triggered but no events were eligible for removal");
		}
	};
	storageMonitor.onDiskSpaceOk = ({ availableBytes }) => {
		log.info(
			`Disk space recovered: ${availableBytes / 1024 / 1024}MB available`,
		);
	};
	storageMonitor.start();

	log.info(`Daemon fully started in ${elapsed()}`);

	// ── Event loop monitor ────────────────────────────────────────────────
	let lastTick = Date.now();
	_eventLoopTimer = setInterval(() => {
		const now = Date.now();
		const delta = now - lastTick;
		if (delta > 100) {
			log.debug(`[eventloop] blocked for ${delta}ms`);
		}
		lastTick = now;
	}, 50);
	_eventLoopTimer.unref();

	// ── discoverProjects helper ───────────────────────────────────────────
	async function discoverProjects(): Promise<void> {
		const discoveryUrl = resolveOpencodeUrl();
		if (!discoveryUrl) return;
		const discoveryLog = createLogger("relay").child("discovery");
		try {
			const { createSdkClientEffect } = await import(
				"../instance/sdk-factory.js"
			);
			const { Effect: Eff } = await import("effect");
			const { client } = Eff.runSync(
				createSdkClientEffect({ baseUrl: discoveryUrl }),
			);
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
			return port;
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
