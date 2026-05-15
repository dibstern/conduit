import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import {
	type DaemonConfig,
	loadDaemonConfig,
} from "../../../daemon/config-persistence.js";
import type {
	DaemonOptions,
	DaemonStatus,
} from "../../../daemon/daemon-types.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../../../env.js";
import { formatErrorDetail } from "../../../errors.js";
import { setLogFormat, setLogLevel } from "../../../logger.js";
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
import { resolveDefaultStaticDir } from "../Services/daemon-static-dir.js";
import { type DaemonLiveOptions, makeDaemonLive } from "./daemon-layers.js";

export interface ForegroundDaemonHandle {
	readonly port: number;
	readonly onboardingPort: number | null;
	addProject(
		directory: string,
		slug?: string,
		instanceId?: string,
	): Promise<StoredProject>;
	discoverProjects(): Promise<void>;
	getStatus(): DaemonStatus;
	getProjects(): ReadonlyArray<Readonly<StoredProject>>;
	getInstances(): ReadonlyArray<Readonly<OpenCodeInstance>>;
	removeProject(slug: string): Promise<void>;
	stop(): Promise<void>;
}

class ForegroundIpcUnsupportedError extends Error {
	constructor(operation: string) {
		super(
			`Foreground daemon IPC operation "${operation}" is not available until the daemon IPC context is fully Effect-owned`,
		);
		this.name = "ForegroundIpcUnsupportedError";
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

	return makeDaemonConfigFromOptions({
		port: options.port ?? persisted?.port ?? DEFAULT_PORT,
		host: options.host ?? "127.0.0.1",
		hostExplicit: options.host !== undefined,
		...(pinHash != null && { pinHash }),
		tlsEnabled: options.tlsEnabled ?? persisted?.tls ?? false,
		keepAwake: options.keepAwake ?? persisted?.keepAwake ?? false,
		...(keepAwakeCommand !== undefined && { keepAwakeCommand }),
		...(keepAwakeArgs !== undefined && { keepAwakeArgs }),
		dismissedPaths: persisted?.dismissedPaths ?? [],
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
	| DaemonConfigRefTag;

export async function startForegroundDaemon(
	options: DaemonOptions,
): Promise<ForegroundDaemonHandle> {
	if (options.logLevel) setLogLevel(options.logLevel);
	if (options.logFormat) setLogFormat(options.logFormat);

	const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
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

	const requireRuntime = () => {
		if (runtime == null || handle == null || stopped) {
			throw new ForegroundIpcUnsupportedError("runtime unavailable");
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

	const stop = async () => {
		const currentRuntime = runtime;
		if (currentRuntime == null || stopped) return;
		stopped = true;
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
		await currentRuntime.dispose();
		runtime = null;
		handle = null;
	};

	const initialConfig = buildInitialRuntimeConfig(options, configDir);
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
		pidPath: options.pidPath ?? join(configDir, "daemon.pid"),
		socketPath: options.socketPath ?? join(configDir, "relay.sock"),
		staticDir: options.staticDir ?? resolveDefaultStaticDir(),
		initialConfig,
		configMirror: {
			set: (config) =>
				Effect.sync(() => {
					mirrorRuntimeConfig(config);
				}),
		},
		ipcPostResponseActions: {
			scheduleShutdown: () => {
				void stop();
			},
		},
		...(options.opencodeUrl !== undefined && {
			defaultOpencodeUrl: options.opencodeUrl,
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

	runtime = ManagedRuntime.make(makeDaemonLive(liveOptions));
	handle = await runRuntimeEffect(runtime, DaemonHandleTag);
	await refreshSnapshots();

	return {
		get port() {
			return status.port;
		},
		get onboardingPort() {
			return onboardingPort;
		},
		addProject: (directory, slug, instanceId) =>
			runHandleEffect((h) => h.addProject(directory, slug, instanceId)),
		discoverProjects: () =>
			runHandleEffect((h) => h.discoverProjects()).then(() => undefined),
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
		stop,
	};
}

export async function startDaemonChildProcess(
	options: DaemonOptions,
): Promise<void> {
	await startForegroundDaemon(options);
}
