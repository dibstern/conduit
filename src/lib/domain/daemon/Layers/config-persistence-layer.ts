// Coalesces explicit config save requests and writes daemon.json snapshots to
// disk within 500 ms of the first request plus a final scope-close flush. Replaces the
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
	Record,
	Ref,
} from "effect";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../contracts/worktree.js";
import {
	type DaemonConfig,
	DEFAULT_AUTO_ARCHIVE_AFTER_DAYS,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfigResult,
	saveDaemonConfig,
} from "../../../daemon/config-persistence.js";
import { AccountDirectory } from "../Services/account-directory.js";
import {
	type ConfigPersistence,
	ConfigPersistenceTag,
	type ConfigSnapshot,
	ConfigSnapshotTag,
} from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import {
	InstanceManagerStateTag,
	persistedInstanceConfigs,
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
	const directory = yield* AccountDirectory;
	const accounts = yield* directory.snapshot;
	const instanceState = yield* Ref.get(yield* InstanceManagerStateTag);
	const instances = persistedInstanceConfigs(accounts.accounts, instanceState);

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
		autoArchiveAfterDays:
			runtime.autoArchiveAfterDays === undefined
				? DEFAULT_AUTO_ARCHIVE_AFTER_DAYS
				: runtime.autoArchiveAfterDays,
		worktreeCleanup: runtime.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP,
		...(runtime.usageLimits !== undefined && {
			usageLimits: runtime.usageLimits,
		}),
		...(runtime.cursorUsageBinding !== undefined && {
			cursorUsageBinding: runtime.cursorUsageBinding,
		}),
		...(runtime.keepAwakeCommand !== undefined && {
			keepAwakeCommand: runtime.keepAwakeCommand,
		}),
		...(runtime.keepAwakeArgs !== undefined && {
			keepAwakeArgs: runtime.keepAwakeArgs,
		}),
		...(runtime.newSessionProject !== undefined && {
			newSessionProject: runtime.newSessionProject,
		}),
		projects: projects.map((project) => {
			const sessionCount =
				runtime.persistedSessionCounts.get(project.slug) ?? 0;
			return {
				path: project.folders[0],
				folders: project.folders,
				...(project.repositoryIdentities !== undefined && {
					repositoryIdentities: project.repositoryIdentities,
				}),
				slug: project.slug,
				title: project.title,
				addedAt: project.lastUsed ?? Date.now(),
				...(project.shellEnv !== undefined && { shellEnv: project.shellEnv }),
				...(project.setupScript !== undefined && {
					setupScript: project.setupScript,
				}),
				...(project.sessionMode !== undefined && {
					sessionMode: project.sessionMode,
				}),
				...(project.worktreeCleanup !== undefined && {
					worktreeCleanup: project.worktreeCleanup,
				}),
				...(sessionCount > 0 && { sessionCount }),
			};
		}),
		instances,
		accountDefaults: Record.filterMap(accounts.defaults, (id) => id),
		deletedAccounts: [...accounts.deleted],
	} satisfies DaemonConfig;
}).pipe(Effect.withSpan("configPersistence.buildSnapshot"));

export const ConfigSnapshotFromEffectStateLive = Layer.effect(
	ConfigSnapshotTag,
	Effect.gen(function* () {
		const configRef = yield* DaemonConfigRefTag;
		const projectRegistry = yield* ProjectRegistryTag;
		const instanceState = yield* InstanceManagerStateTag;
		const directory = yield* AccountDirectory;
		return {
			build: buildDaemonConfigSnapshot.pipe(
				Effect.provideService(DaemonConfigRefTag, configRef),
				Effect.provideService(ProjectRegistryTag, projectRegistry),
				Effect.provideService(InstanceManagerStateTag, instanceState),
				Effect.provideService(AccountDirectory, directory),
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

export const makeConfigWriterLive = (configDir: string) =>
	Layer.succeed(ConfigWriterTag, {
		write: (config: DaemonConfig) =>
			Effect.tryPromise({
				try: () => {
					const loaded = loadDaemonConfigResult(configDir);
					if (loaded._tag === "Left" && loaded.left._tag !== "NotFound") {
						throw loaded.left;
					}
					const persisted = loaded._tag === "Right" ? loaded.right : null;
					return saveDaemonConfig(
						{
							...config,
							// This legacy setting has no runtime Ref; retain its
							// saved value when writing the live runtime snapshot.
							debug: persisted?.debug ?? config.debug,
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
			}).pipe(
				// Disk writes cannot be cancelled. Retain the permit until the
				// write completes, even when the requesting RPC disconnects.
				Effect.uninterruptible,
			),
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
			Effect.gen(function* () {
				yield* Queue.take(requests);
				yield* Effect.sleep(Duration.millis(500));
				yield* Queue.takeAll(requests);
				yield* backgroundFlush;
			}).pipe(Effect.forever),
		);

		yield* Effect.addFinalizer(() => finalizerFlush);

		return {
			requestSave,
			flush,
		} satisfies ConfigPersistence;
	}),
);
