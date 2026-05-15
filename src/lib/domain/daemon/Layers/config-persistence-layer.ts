// ─── ConfigPersistenceLive ──────────────────────────────────────────────────
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
		debug: false,
		keepAwake: runtime.keepAwake,
		...(runtime.keepAwakeCommand !== undefined && {
			keepAwakeCommand: runtime.keepAwakeCommand,
		}),
		...(runtime.keepAwakeArgs !== undefined && {
			keepAwakeArgs: runtime.keepAwakeArgs,
		}),
		dangerouslySkipPermissions: false,
		projects: projects.map((project) => {
			const sessionCount =
				runtime.persistedSessionCounts.get(project.slug) ?? 0;
			return {
				path: project.directory,
				slug: project.slug,
				title: project.title,
				addedAt: project.lastUsed ?? Date.now(),
				...(project.instanceId !== undefined && {
					instanceId: project.instanceId,
				}),
				...(sessionCount > 0 && { sessionCount }),
			};
		}),
		instances,
		...(runtime.dismissedPaths.size > 0 && {
			dismissedPaths: Array.from(runtime.dismissedPaths),
		}),
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

// ─── ConfigWriter service ──────────────────────────────────────────────────

export interface ConfigWriter {
	readonly write: (config: DaemonConfig) => Effect.Effect<void, unknown>;
}

export class ConfigWriterTag extends Context.Tag("ConfigWriter")<
	ConfigWriterTag,
	ConfigWriter
>() {}

export const makeConfigWriterLive = (configDir: string) =>
	Layer.succeed(ConfigWriterTag, {
		write: (config: DaemonConfig) =>
			Effect.tryPromise({
				try: () => saveDaemonConfig(config, configDir),
				catch: (cause) =>
					new ConfigPersistenceWriteError({
						operation: "saveDaemonConfig",
						cause,
					}),
			}),
	});

const CONFIG_PERSISTENCE_RETRY_DELAY = Duration.millis(500);

// ─── Layer ─────────────────────────────────────────────────────────────────

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
