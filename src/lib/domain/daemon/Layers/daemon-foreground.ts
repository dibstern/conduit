import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	Cause,
	Data,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	ManagedRuntime,
	Ref,
} from "effect";
import {
	type DaemonConfig,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfig,
} from "../../../daemon/config-persistence.js";
import type {
	DaemonOptions,
	DaemonStatus,
} from "../../../daemon/daemon-types.js";
import { isDaemonRunning } from "../../../daemon/daemon-utils.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../../../env.js";
import { formatErrorDetail } from "../../../errors.js";
import { setLogFormat, setLogLevel } from "../../../logger.js";
import { stopRegisteredClaudeRunners } from "../../../provider/claude/claude-process-session-runner.js";
import { discoverClaudeRunners } from "../../../provider/claude/claude-runner-registry.js";
import { setClaudeRunnerRestart } from "../../../provider/claude/claude-runner-shutdown.js";
import { stopPtyHost } from "../../../terminal/pty-host-client.js";
import type { OpenCodeInstance, StoredProject } from "../../../types.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	type DaemonConfigRefTag,
	type DaemonRuntimeConfig,
	makeDaemonConfigFromOptions,
} from "../Services/daemon-config-ref.js";
import {
	DaemonHandleTag,
	type EffectDaemonHandle,
} from "../Services/daemon-handle.js";
import { hasRunningClaudeTurn } from "../Services/daemon-session-reader.js";
import { resolveDefaultStaticDir } from "../Services/daemon-static-dir.js";
import {
	type InstanceManagerState,
	InstanceManagerStateTag,
	requestManagedOpenCodeShutdown,
} from "../Services/instance-manager-service.js";
import { OpenCodeUnavailableError } from "../Services/opencode-smart-default.js";
import {
	type ProjectRegistryState,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";
import {
	type DaemonLiveOptions,
	makeDaemonLive,
	ShutdownSignalTag,
} from "./daemon-layers.js";

export { OpenCodeUnavailableError };

class ForegroundDaemonStartError extends Data.TaggedError(
	"ForegroundDaemonStartError",
)<{ readonly reason: string }> {
	override get message(): string {
		return `Conduit server cannot start: ${this.reason}.`;
	}
}

export interface ForegroundDaemonHandle {
	readonly port: number;
	readonly onboardingPort: number | null;
	addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<StoredProject>;
	getStatus(): DaemonStatus;
	getProjects(): ReadonlyArray<Readonly<StoredProject>>;
	getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>>;
	removeProject(slug: string): Promise<void>;
	stop(): Promise<void>;
	/** Settles with stop()'s outcome, whether stop was triggered by a signal, RPC shutdown, or a direct call. */
	readonly stopped: Promise<void>;
}

class ForegroundRuntimeUnavailableError extends Error {
	constructor(operation: string) {
		super(
			`Foreground daemon operation "${operation}" is not available until the daemon context is fully Effect-owned`,
		);
		this.name = "ForegroundRuntimeUnavailableError";
	}
}

class ForegroundDaemonStopError extends Error {
	constructor(cause: unknown) {
		super(`Failed to flush foreground daemon: ${formatErrorDetail(cause)}`);
		this.name = "ForegroundDaemonStopError";
	}
}

const persistedSessionCounts = (config: DaemonConfig | null) =>
	new Map(
		(config?.projects ?? []).flatMap((project) =>
			project.sessionCount == null
				? []
				: ([[project.slug, project.sessionCount]] as const),
		),
	);

const buildInitialRuntimeConfig = (
	options: DaemonOptions,
	configDir: string,
) => {
	const persisted = loadDaemonConfig(configDir);
	const pinHash = options.pinHash ?? persisted?.pinHash ?? undefined;
	const keepAwakeCommand =
		options.keepAwakeCommand ?? persisted?.keepAwakeCommand ?? undefined;
	const keepAwakeArgs =
		options.keepAwakeArgs ?? persisted?.keepAwakeArgs ?? undefined;
	const claudeConfigDir =
		options.claudeConfigDir ?? persisted?.claudeConfigDir ?? undefined;

	return makeDaemonConfigFromOptions({
		port: options.port ?? persisted?.port ?? DEFAULT_PORT,
		host: options.host ?? "127.0.0.1",
		hostExplicit: options.host !== undefined,
		...(pinHash != null && { pinHash }),
		tlsEnabled: options.tlsEnabled ?? persisted?.tls ?? false,
		keepAwake: options.keepAwake ?? persisted?.keepAwake ?? false,
		autoSettleAfterDays:
			persisted?.autoSettleAfterDays === undefined
				? DEFAULT_AUTO_SETTLE_AFTER_DAYS
				: persisted.autoSettleAfterDays,
		...(keepAwakeCommand !== undefined && { keepAwakeCommand }),
		...(keepAwakeArgs !== undefined && { keepAwakeArgs }),
		...(claudeConfigDir !== undefined && { claudeConfigDir }),
		startTime: Date.now(),
		persistedSessionCounts: persistedSessionCounts(persisted),
	});
};

const runRuntimeEffect = <R, A, E>(
	runtime: ManagedRuntime.ManagedRuntime<R, unknown>,
	effect: Effect.Effect<A, E, R>,
): Promise<A> =>
	new Promise((resolve, reject) => {
		runtime.runCallback(effect, {
			onExit: (exit) => {
				if (Exit.isSuccess(exit)) {
					resolve(exit.value);
					return;
				}
				reject(Cause.squash(exit.cause));
			},
		});
	});

const makeInitialStatus = (options: DaemonOptions): DaemonStatus => ({
	ok: true,
	uptime: 0,
	port: options.port ?? DEFAULT_PORT,
	host: options.host ?? "127.0.0.1",
	projectCount: 0,
	sessionCount: 0,
	clientCount: 0,
	pinEnabled: options.pinHash != null,
	tlsEnabled: options.tlsEnabled ?? false,
	keepAwake: options.keepAwake ?? false,
	projects: [],
});

type ForegroundRuntimeRequirements =
	| DaemonHandleTag
	| ConfigPersistenceTag
	| DaemonConfigRefTag
	| InstanceManagerStateTag
	| ProjectRegistryTag
	| RelayCacheTag
	| ShutdownSignalTag;

export async function startForegroundDaemon(
	options: DaemonOptions,
): Promise<ForegroundDaemonHandle> {
	if (options.logLevel) setLogLevel(options.logLevel);
	if (options.logFormat) setLogFormat(options.logFormat);

	const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
	const initialConfig = buildInitialRuntimeConfig(options, configDir);
	const socketPath = options.socketPath ?? join(configDir, "relay.sock");
	// Check before acquiring runtime resources or replacing a stale RPC socket.
	await new Promise<void>((ready, fail) => {
		const probe = createServer();
		probe.once("error", (error: NodeJS.ErrnoException) => {
			fail(
				error.code === "EADDRINUSE"
					? new ForegroundDaemonStartError({
							reason: `port ${initialConfig.port} is already in use (${initialConfig.host})`,
						})
					: error,
			);
		});
		probe.listen(initialConfig.port, initialConfig.host, () => {
			probe.close((error) => (error ? fail(error) : ready()));
		});
	});
	if (await isDaemonRunning(socketPath)) {
		throw new ForegroundDaemonStartError({
			reason: `a server is already running for ${configDir}`,
		});
	}
	mkdirSync(configDir, { recursive: true });

	let runtime: ManagedRuntime.ManagedRuntime<
		ForegroundRuntimeRequirements,
		unknown
	> | null = null;
	let handle: EffectDaemonHandle | null = null;
	let status = makeInitialStatus(options);
	let onboardingPort: number | null = null;
	let projects: ReadonlyArray<Readonly<StoredProject>> = [];
	let instances: ReadonlyArray<Readonly<OpenCodeInstance>> = [];
	let stopped = false;
	let refreshInFlight: Promise<void> | null = null;
	let stopInFlight: Promise<void> | null = null;
	let shutdownMode: "restart" | "stop" = "restart";
	let instanceState: Ref.Ref<InstanceManagerState> | undefined;
	let projectState: Ref.Ref<ProjectRegistryState> | undefined;
	const fullStopRequested = Effect.suspend(() =>
		instanceState === undefined
			? Effect.succeed(shutdownMode === "stop")
			: Ref.get(instanceState).pipe(
					Effect.map((state) => state.stopManagedProcesses === true),
				),
	);
	let settleStopped!: { resolve: () => void; reject: (error: unknown) => void };
	const stopSettled = new Promise<void>((resolve, reject) => {
		settleStopped = { resolve, reject };
	});
	// A failed stop is reported through `stopped`; don't also surface it as an unhandled rejection.
	stopSettled.catch(() => {});

	const requireRuntime = () => {
		if (runtime == null || handle == null || stopped) {
			throw new ForegroundRuntimeUnavailableError("runtime unavailable");
		}
		return { runtime, handle };
	};

	const refreshSnapshots = async () => {
		const current = requireRuntime();
		const snapshot = await runRuntimeEffect(
			current.runtime,
			Effect.all({
				status: current.handle.getStatus(),
				onboardingPort: current.handle.onboardingPort,
				projects: current.handle.getProjects(),
				instances: current.handle.getInstances(),
			}),
		);
		status = snapshot.status;
		onboardingPort = snapshot.onboardingPort;
		projects = snapshot.projects;
		instances = snapshot.instances;
	};

	const requestSnapshotRefresh = () => {
		if (
			refreshInFlight != null ||
			stopped ||
			runtime == null ||
			handle == null
		) {
			return;
		}
		refreshInFlight = refreshSnapshots()
			.catch(() => {
				// Foreground sync getters return the latest successful snapshot.
			})
			.finally(() => {
				refreshInFlight = null;
			});
	};

	const runHandleEffect = async <A, E>(
		effect: (handle: EffectDaemonHandle) => Effect.Effect<A, E>,
	) => {
		const current = requireRuntime();
		const result = await runRuntimeEffect(
			current.runtime,
			effect(current.handle),
		);
		await refreshSnapshots();
		return result;
	};

	const teardown = async (mode: "restart" | "stop") => {
		if (stopInFlight != null) return stopInFlight;
		const currentRuntime = runtime;
		if (currentRuntime == null || stopped) return;
		stopped = true;
		stopInFlight = (async () => {
			shutdownMode = mode;
			// The Deferred wakes shutdown once; a committed full stop remains authoritative.
			if (await runRuntimeEffect(currentRuntime, fullStopRequested)) {
				shutdownMode = "stop";
			}
			setClaudeRunnerRestart(shutdownMode === "restart");
			try {
				if (shutdownMode === "stop") {
					await runRuntimeEffect(
						currentRuntime,
						requestManagedOpenCodeShutdown,
					);
				}
				await runRuntimeEffect(
					currentRuntime,
					Effect.gen(function* () {
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							shuttingDown: true,
						}));
						const persistence = yield* ConfigPersistenceTag;
						yield* persistence.requestSave;
						yield* persistence.flush;
					}),
				).catch((error: unknown) => {
					throw new ForegroundDaemonStopError(error);
				});
			} finally {
				await currentRuntime.dispose();
				runtime = null;
				handle = null;
			}
		})().finally(() => {
			stopInFlight = null;
		});
		stopInFlight.then(settleStopped.resolve, settleStopped.reject);
		return stopInFlight;
	};

	// Claude SDK subprocesses (and PTY sessions) inherit the daemon's env, so
	// a configured Claude profile must be applied before any provider starts.
	if (initialConfig.claudeConfigDir !== undefined) {
		process.env["CLAUDE_CONFIG_DIR"] = initialConfig.claudeConfigDir;
	}
	const mirrorRuntimeConfig = (config: DaemonRuntimeConfig) => {
		status = {
			...status,
			port: config.port,
			host: config.host,
			pinEnabled: config.pinHash !== null,
			tlsEnabled: config.tlsEnabled,
			keepAwake: config.keepAwake,
		};
	};
	const liveOptions: DaemonLiveOptions = {
		configDir,
		socketPath,
		staticDir: options.staticDir ?? resolveDefaultStaticDir(),
		initialConfig,
		configMirror: {
			set: (config) =>
				Effect.sync(() => {
					mirrorRuntimeConfig(config);
				}),
		},

		...(options.opencodeUrl !== undefined && {
			defaultOpencodeUrl: options.opencodeUrl,
		}),
		smartDefault: options.smartDefault ?? true,
		...(options.smartDefaultUrl !== undefined && {
			smartDefaultUrl: options.smartDefaultUrl,
		}),
		keepAwake: initialConfig.keepAwakeCommand
			? {
					command: initialConfig.keepAwakeCommand,
					...(initialConfig.keepAwakeArgs !== undefined && {
						args: [...initialConfig.keepAwakeArgs],
					}),
				}
			: {},
		configPath: join(configDir, "daemon.json"),
	};

	// A native file lock excludes concurrent owners even across a stale RPC socket.
	// SQLite releases it on process death; no process identity or stale lock cleanup is needed.
	const serverLease = Layer.scopedDiscard(
		Effect.acquireRelease(
			Effect.try({
				try: () => {
					const lease = new Database(join(configDir, "server.lock.sqlite"), {
						timeout: 0,
					});
					try {
						lease.exec("BEGIN IMMEDIATE");
						return lease;
					} catch (cause) {
						lease.close();
						if (
							cause instanceof Database.SqliteError &&
							cause.code === "SQLITE_BUSY"
						) {
							throw new ForegroundDaemonStartError({
								reason: `a server is already running for ${configDir}`,
							});
						}
						throw cause;
					}
				},
				catch: (cause) => cause,
			}),
			(lease) =>
				Effect.gen(function* () {
					if (yield* fullStopRequested) {
						// Read intent after request and relay scopes have drained.
						const registered = projectState
							? Array.from(HashMap.values(yield* Ref.get(projectState)))
							: [];
						// Failed relay acquisition can preserve a runner without a cache owner.
						yield* Effect.validateAll(
							registered,
							({ project }) =>
								stopRegisteredClaudeRunners(project.directory, configDir),
							{ concurrency: 4 },
						).pipe(
							Effect.orDie,
							Effect.ensuring(
								Effect.promise(() => stopPtyHost({ configDir, force: true })),
							),
						);
					}
				}).pipe(Effect.ensuring(Effect.sync(() => lease.close()))),
		),
	);
	runtime = ManagedRuntime.make(
		makeDaemonLive(liveOptions).pipe(Layer.provide(serverLease)),
	);
	try {
		handle = await runRuntimeEffect(runtime, DaemonHandleTag);
		instanceState = await runRuntimeEffect(runtime, InstanceManagerStateTag);
		projectState = await runRuntimeEffect(runtime, ProjectRegistryTag);
		setClaudeRunnerRestart(false);
		const currentHandle = handle;
		await runRuntimeEffect(
			runtime,
			Effect.gen(function* () {
				const relayCache = yield* RelayCacheTag;
				const registered = yield* currentHandle.getProjects();
				for (const project of registered) {
					yield* Effect.gen(function* () {
						const runners = yield* Effect.sync(() =>
							discoverClaudeRunners(project.directory, configDir),
						);
						if (
							runners.length > 0 ||
							(yield* hasRunningClaudeTurn(project.directory))
						) {
							// Cold projects stay lazy unless runner recovery or turn settlement needs them.
							yield* relayCache.get(project.slug);
						}
					}).pipe(
						Effect.catchAllCause((cause) =>
							Cause.isInterruptedOnly(cause)
								? Effect.failCause(cause)
								: Effect.logError(
										`Failed to recover relay for project "${project.slug}"`,
										cause,
									),
						),
					);
				}
			}),
		);
		await refreshSnapshots();
	} catch (error) {
		// A failed server startup must leave adopted durable children for the next attempt.
		setClaudeRunnerRestart(
			instanceState === undefined ||
				!(await runRuntimeEffect(runtime, fullStopRequested)),
		);
		await runtime.dispose();
		runtime = null;
		handle = null;
		throw error;
	}
	// Signals preserve durable children; explicit RPC shutdown performs a full stop.
	runRuntimeEffect(runtime, Effect.flatMap(ShutdownSignalTag, Deferred.await))
		.then((mode) => teardown(mode))
		.catch(() => {
			// Runtime disposed before a signal arrived, or stop failed (reported via `stopped`).
		});

	return {
		get port() {
			return status.port;
		},
		get onboardingPort() {
			return onboardingPort;
		},
		addProject: (directory, slug, instanceId) =>
			runHandleEffect((h) => h.addProject(directory, slug, instanceId)),
		getStatus: () => {
			requestSnapshotRefresh();
			return status;
		},
		getProjects: () => {
			requestSnapshotRefresh();
			return projects;
		},
		getInstances: () => {
			requestSnapshotRefresh();
			return instances;
		},
		removeProject: (slug) => runHandleEffect((h) => h.removeProject(slug)),
		stop: () => teardown("stop"),
		stopped: stopSettled,
	};
}
