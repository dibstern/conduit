// Coalesces explicit config save requests and writes daemon.json snapshots to
// disk using a debounced fiber plus a final scope-close flush. Replaces the
// imperative persistConfig() / flushConfigSave() closures in daemon-main.ts.
//
// The ConfigWriterTag service exists for dependency injection — production
// code provides a real disk writer, tests provide a mock.

import {
	Context,
	Data,
	Duration,
	Effect,
	Layer,
	Queue,
	Ref,
	Stream,
} from "effect";
import {
	type DaemonConfig,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../daemon/config-persistence.js";
import {
	type ConfigPersistence,
	ConfigPersistenceTag,
	type ConfigSnapshot,
	ConfigSnapshotTag,
} from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import {
	getPersistedInstanceConfigs,
	InstanceManagerStateTag,
} from "../Services/instance-manager-service.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";

export {
	ConfigPersistenceNoopLive,
	ConfigPersistenceTag,
	ConfigSnapshotTag,
	requestConfigSave,
} from "../Services/config-persistence-service.js";

export class ConfigPersistenceWriteError extends Data.TaggedError(
	"ConfigPersistenceWriteError",
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

export const buildDaemonConfigSnapshot = Effect.gen(function* () {
	const configRef = yield* DaemonConfigRefTag;
	const runtime = yield* Ref.get(configRef);
	const projects = yield* allProjects;
	const instances = yield* getPersistedInstanceConfigs;

	return {
		pid: process.pid,
		port: runtime.port,
		pinHash: runtime.pinHash,
		tls: runtime.tlsEnabled,
		tailscaleServe: runtime.tailscaleServeEnabled ?? false,
		...(runtime.tailscaleServeCleanupPending && {
			tailscaleServeCleanupPending: true,
		}),
		debug: false,
		keepAwake: runtime.keepAwake,
		autoSettleAfterDays:
			runtime.autoSettleAfterDays === undefined
				? DEFAULT_AUTO_SETTLE_AFTER_DAYS
				: runtime.autoSettleAfterDays,
		...(runtime.keepAwakeCommand !== undefined && {
			keepAwakeCommand: runtime.keepAwakeCommand,
		}),
		...(runtime.keepAwakeArgs !== undefined && {
			keepAwakeArgs: runtime.keepAwakeArgs,
		}),
		dangerouslySkipPermissions: false,
		...(runtime.claudeConfigDir !== undefined && {
			claudeConfigDir: runtime.claudeConfigDir,
		}),
		projects: projects.map((project) => {
			const sessionCount =
				runtime.persistedSessionCounts.get(project.slug) ?? 0;
			return {
				path: project.directory,
				directory: project.directory,
				folders: project.folders,
				slug: project.slug,
				title: project.title,
				addedAt: project.lastUsed ?? Date.now(),
				...(project.instanceId !== undefined && {
					instanceId: project.instanceId,
				}),
				...(project.shellEnv !== undefined && { shellEnv: project.shellEnv }),
				...(sessionCount > 0 && { sessionCount }),
			};
		}),
		instances,
	} satisfies DaemonConfig;
}).pipe(Effect.withSpan("configPersistence.buildSnapshot"));

export const ConfigSnapshotFromEffectStateLive = Layer.effect(
	ConfigSnapshotTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRegistry = yield* ProjectRegistryTag;
		const instanceState = yield* InstanceManagerStateTag;
		return {
			build: buildDaemonConfigSnapshot.pipe(
				Effect.provideService(DaemonConfigRefTag, configRef),
				Effect.provideService(ProjectRegistryTag, projectRegistry),
				Effect.provideService(InstanceManagerStateTag, instanceState),
			),
		} satisfies ConfigSnapshot;
	}),
);

export interface ConfigWriter {
	readonly write: (config: DaemonConfig) => Effect.Effect<void, Error>;
}

export class ConfigWriterTag extends Context.Tag("ConfigWriter")<
	ConfigWriterTag,
	ConfigWriter
>() {}

type PersistedInstanceConfig = NonNullable<DaemonConfig["instances"]>[number];

const mergePersistedInstanceConfigs = (
	runtimeInstances: ReadonlyArray<PersistedInstanceConfig>,
	persistedInstances: ReadonlyArray<PersistedInstanceConfig>,
): PersistedInstanceConfig[] => {
	const persistedById = new Map(
		persistedInstances.map((instance) => [instance.id, instance]),
	);
	const runtimeById = new Map(
		runtimeInstances.map((instance) => [instance.id, instance]),
	);

	const mergeInstance = (runtimeInstance: PersistedInstanceConfig) => {
		const persistedInstance = persistedById.get(runtimeInstance.id);
		// Process identity belongs to the current snapshot. Never resurrect a
		// PID cleared after failed recovery or explicit shutdown.
		const {
			pid: _pid,
			version: _version,
			processIdentity: _processIdentity,
			...metadata
		} = persistedInstance ?? {};
		return {
			...metadata,
			...runtimeInstance,
			driver: runtimeInstance.driver ?? persistedInstance?.driver ?? "opencode",
			...(runtimeInstance.configDir !== undefined
				? { configDir: runtimeInstance.configDir }
				: persistedInstance?.configDir !== undefined
					? { configDir: persistedInstance.configDir }
					: {}),
		};
	};

	return [
		...persistedInstances.flatMap((persistedInstance) => {
			const runtimeInstance = runtimeById.get(persistedInstance.id);
			return runtimeInstance === undefined
				? []
				: [mergeInstance(runtimeInstance)];
		}),
		...runtimeInstances
			.filter((instance) => !persistedById.has(instance.id))
			.map(mergeInstance),
	];
};

export const makeConfigWriterLive = (configDir: string) =>
	Layer.succeed(ConfigWriterTag, {
		write: (config: DaemonConfig) =>
			Effect.tryPromise({
				try: () => {
					const persisted = loadDaemonConfig(configDir);
					return saveDaemonConfig(
						{
							...config,
							// These legacy settings have no runtime Ref; retain their
							// saved values when writing the live runtime snapshot.
							debug: persisted?.debug ?? config.debug,
							dangerouslySkipPermissions:
								persisted?.dangerouslySkipPermissions ??
								config.dangerouslySkipPermissions,
							instances: mergePersistedInstanceConfigs(
								config.instances ?? [],
								persisted?.instances ?? [],
							),
						},
						configDir,
					);
				},
				catch: (cause) =>
					new ConfigPersistenceWriteError({
						operation: "saveDaemonConfig",
						cause,
					}),
			}),
	});

const CONFIG_PERSISTENCE_RETRY_DELAY = Duration.millis(500);

export const ConfigPersistenceLive = Layer.scoped(
	ConfigPersistenceTag,
	Effect.gen(function* () {
		const snapshot = yield* ConfigSnapshotTag;
		const writer = yield* ConfigWriterTag;
		const dirty = yield* Ref.make(false);
		const permits = yield* Effect.makeSemaphore(1);
		const requests = yield* Queue.dropping<void>(1);

		const flush = permits.withPermits(1)(
			Effect.gen(function* () {
				const shouldWrite = yield* Ref.getAndSet(dirty, false);
				if (!shouldWrite) return;

				yield* Effect.gen(function* () {
					const config = yield* snapshot.build;
					yield* writer.write(config);
				}).pipe(
					Effect.catchAll((error) =>
						Ref.set(dirty, true).pipe(Effect.zipRight(Effect.fail(error))),
					),
				);
			}),
		);

		const scheduleRetry = Effect.sleep(CONFIG_PERSISTENCE_RETRY_DELAY).pipe(
			Effect.zipRight(Queue.offer(requests, void 0)),
			Effect.asVoid,
		);

		const logFlush = (options?: { retry?: boolean }) =>
			flush.pipe(
				Effect.catchAll((e) =>
					Effect.logWarning("Config persistence failed").pipe(
						Effect.annotateLogs("error", String(e)),
						Effect.zipRight(options?.retry ? scheduleRetry : Effect.void),
					),
				),
			);

		const backgroundFlush = logFlush({ retry: true });
		const finalizerFlush = logFlush();

		const requestSave = Ref.set(dirty, true).pipe(
			Effect.zipRight(Queue.offer(requests, void 0)),
			Effect.asVoid,
		);

		yield* Effect.forkScoped(
			Stream.fromQueue(requests).pipe(
				Stream.debounce(Duration.millis(500)),
				Stream.runForEach(() => backgroundFlush),
			),
		);

		yield* Effect.addFinalizer(() => finalizerFlush);

		return {
			requestSave,
			flush,
		} satisfies ConfigPersistence;
	}),
);
