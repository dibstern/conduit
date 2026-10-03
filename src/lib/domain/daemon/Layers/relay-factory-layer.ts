// Effect-native factory for creating ProjectRelay instances.
//
// RelayFactoryTag — service that creates relays given a StoredProject + URL.
// HttpServerRefTag — Ref<http.Server | null> shared between relay factory
//                    and daemon server lifecycle. The server isn't available
//                    until after Layer construction, so the Ref starts null.
//
// RelayFactoryLive captures deps from Effect Context and delegates to the
// imperative createProjectRelay. The full conversion of createProjectRelay
// to Effect is beyond scope — this provides the Effect-native entry point.

import { existsSync, mkdirSync } from "node:fs";
import type http from "node:http";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Cause,
	Context,
	Data,
	Effect,
	Exit,
	Layer,
	Option,
	Ref,
	Runtime,
} from "effect";
import { daemonSessionGitCache } from "../../../git/session-git.js";
import { openCodeAuth } from "../../../instance/managed-opencode-process.js";
import { projectEventsDbPath } from "../../../persistence/project-storage.js";
import type { ProjectRelay } from "../../../relay/relay-stack.js";
import type {
	InstanceConfig,
	OpenCodeInstance,
	SessionGit,
} from "../../../shared-types.js";
import type { ProjectRelayConfig, StoredProject } from "../../../types.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { listDaemonSessions as listEffectDaemonSessions } from "../Services/daemon-session-reader.js";
import { InstanceHealthCheckTag } from "../Services/instance-health-service.js";
import {
	addInstance as addEffectInstance,
	getInstances as getEffectInstances,
	getManagedOpenCodeProcessEnv,
	InstanceManagerStateTag,
	PollerFibersTag,
	persistConfig as persistEffectInstanceConfig,
	removeInstance as removeEffectInstance,
	startInstance as startEffectInstance,
	stopInstance as stopEffectInstance,
	updateInstance as updateEffectInstance,
} from "../Services/instance-manager-service.js";
import {
	broadcastProjectList,
	broadcastToAll,
	projectInfos as getEffectProjectInfos,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { PortScannerTag } from "./port-scanner-layer.js";
import { ProjectShellEnvTag } from "./project-shell-env-layer.js";
import { VersionCheckerTag } from "./version-checker-layer.js";

export class RelayFactoryError extends Data.TaggedError("RelayFactoryError")<{
	reason: string;
	cause?: unknown;
}> {
	get message(): string {
		const inner = this.cause instanceof Error ? `: ${this.cause.message}` : "";
		return `${this.reason}${inner}`;
	}
}

/**
 * Ref holding the HTTP server instance. Starts as null because the server
 * is created during Layer construction (by makeHttpServerLive) and isn't
 * available until the server layer has built. Both the relay factory and
 * daemon-main read from this Ref.
 */
export class HttpServerRefTag extends Context.Tag("HttpServerRef")<
	HttpServerRefTag,
	Ref.Ref<http.Server | null>
>() {}

/**
 * Layer that creates an HttpServerRef initialized to null.
 * The server lifecycle layer sets the Ref once the server is listening.
 */
export const HttpServerRefLive: Layer.Layer<HttpServerRefTag> = Layer.effect(
	HttpServerRefTag,
	Ref.make<http.Server | null>(null),
);

/**
 * Factory service for creating ProjectRelay instances from Effect Context.
 *
 * The `create` method returns an Effect that:
 * 1. Opens a SQLite persistence DB for the project
 * 2. Calls createProjectRelay with dependencies from Context
 * 3. Lets RelayCache own the long-lived relay finalizer
 */
export interface RelayFactory {
	readonly create: (
		project: StoredProject,
		opencodeUrl: string,
		projectControls?: RelayFactoryProjectControls,
	) => Effect.Effect<ProjectRelay, RelayFactoryError>;
}

export interface RelayFactoryProjectControls {
	readonly addProject: NonNullable<ProjectRelayConfig["addProject"]>;
	readonly removeProject: NonNullable<ProjectRelayConfig["removeProject"]>;
	readonly setProjectTitle: NonNullable<ProjectRelayConfig["setProjectTitle"]>;
	readonly setProjectInstance: NonNullable<
		ProjectRelayConfig["setProjectInstance"]
	>;
}

export class RelayFactoryTag extends Context.Tag("RelayFactory")<
	RelayFactoryTag,
	RelayFactory
>() {}

/**
 * Create a Layer providing RelayFactoryTag.
 *
 * Dependencies (from Effect Context):
 * - DaemonConfigRefTag — for reading runtime config
 * - HttpServerRefTag — for the HTTP server reference
 *
 * HttpServerRefLive is self-provided (starts as null Ref).
 * DaemonConfigRefTag must be provided by the caller (daemon-layers composition).
 *
 * The factory's `create` method is called at runtime (not build time)
 * when a relay needs to be created for a specific project.
 *
 * @param configDir - The daemon config directory path (e.g., ~/.conduit)
 */
export const RelayFactoryLive = (
	configDir: string,
): Layer.Layer<
	RelayFactoryTag | HttpServerRefTag,
	never,
	| DaemonConfigRefTag
	| ProjectRegistryTag
	| InstanceManagerStateTag
	| PollerFibersTag
	| InstanceHealthCheckTag
	| DaemonEventBusTag
	| ConfigPersistenceTag
	| PortScannerTag
	| VersionCheckerTag
	| PushManagerTag
> =>
	Layer.effect(
		RelayFactoryTag,
		Effect.gen(function* () {
			const configRef = yield* DaemonConfigRefTag;
			const envResolver = Option.getOrUndefined(
				yield* Effect.serviceOption(ProjectShellEnvTag),
			);
			const httpServerRef = yield* HttpServerRefTag;
			const projectRegistry = yield* ProjectRegistryTag;
			const instanceState = yield* InstanceManagerStateTag;
			const pollerFibers = yield* PollerFibersTag;
			const healthCheck = yield* InstanceHealthCheckTag;
			const eventBus = yield* DaemonEventBusTag;
			const configPersistence = yield* ConfigPersistenceTag;
			const portScanner = yield* PortScannerTag;
			const versionChecker = yield* VersionCheckerTag;
			const pushManager = yield* PushManagerTag;
			const runtime = yield* Effect.runtime<never>();

			const runCallback = <A>(effect: Effect.Effect<A, unknown>) =>
				new Promise<A>((resolve, reject) => {
					Runtime.runCallback(runtime)(effect, {
						onExit: (exit) => {
							if (Exit.isSuccess(exit)) {
								resolve(exit.value);
								return;
							}
							reject(Cause.squash(exit.cause));
						},
					});
				});

			const getProjects = () =>
				runCallback(
					getEffectProjectInfos.pipe(
						Effect.provideService(ProjectRegistryTag, projectRegistry),
					),
				);

			const listDaemonSessions: NonNullable<
				ProjectRelayConfig["listDaemonSessions"]
			> = (options) =>
				runCallback(
					listEffectDaemonSessions(options).pipe(
						Effect.provideService(ProjectRegistryTag, projectRegistry),
					),
				);
			const broadcastSessionListChanged = () =>
				runCallback(
					broadcastToAll({ type: "daemon_sessions_changed" }).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					),
				);
			const publishProjectList = () =>
				runCallback(
					broadcastProjectList.pipe(
						Effect.provideService(ProjectRegistryTag, projectRegistry),
						Effect.provideService(DaemonEventBusTag, eventBus),
					),
				);

			const getInstances = () =>
				runCallback(
					getEffectInstances.pipe(
						Effect.map((instances) => Array.from(instances)),
						Effect.provideService(InstanceManagerStateTag, instanceState),
					),
				);

			const provideInstanceDeps = <A, E>(
				effect: Effect.Effect<
					A,
					E,
					| InstanceManagerStateTag
					| PollerFibersTag
					| InstanceHealthCheckTag
					| DaemonEventBusTag
					| ConfigPersistenceTag
				>,
			) =>
				effect.pipe(
					Effect.provideService(InstanceManagerStateTag, instanceState),
					Effect.provideService(PollerFibersTag, pollerFibers),
					Effect.provideService(InstanceHealthCheckTag, healthCheck),
					Effect.provideService(DaemonEventBusTag, eventBus),
					Effect.provideService(ConfigPersistenceTag, configPersistence),
				);

			const addInstance = (id: string, config: InstanceConfig) =>
				runCallback(provideInstanceDeps(addEffectInstance({ id, ...config })));

			const removeInstance = (id: string) =>
				runCallback(provideInstanceDeps(removeEffectInstance(id)));

			const startInstance = (id: string) =>
				runCallback(provideInstanceDeps(startEffectInstance(id)));

			const stopInstance = (id: string) =>
				runCallback(provideInstanceDeps(stopEffectInstance(id)));

			const updateInstance = (
				id: string,
				updates: {
					readonly name?: string;
					readonly env?: Record<string, string>;
					readonly port?: number;
					readonly driver?: import("../../../contracts/provider-instance.js").ProviderDriverKind;
					readonly configDir?: string;
				},
			) =>
				runCallback(
					provideInstanceDeps(updateEffectInstance(id, updates)).pipe(
						Effect.flatMap(() =>
							getEffectInstances.pipe(
								Effect.flatMap((instances) => {
									const instance = Array.from(instances).find(
										(candidate) => candidate.id === id,
									);
									if (instance === undefined) {
										return Effect.fail(
											new RelayFactoryError({
												reason: `Instance "${id}" not found after update`,
											}),
										);
									}
									return Effect.succeed(instance as OpenCodeInstance);
								}),
								Effect.provideService(InstanceManagerStateTag, instanceState),
							),
						),
					),
				);

			const persistConfig = () =>
				runCallback(provideInstanceDeps(persistEffectInstanceConfig));

			const triggerScan = () => runCallback(portScanner.scanNow());

			const getCachedUpdate = () =>
				runCallback(versionChecker.getLatestKnown());

			return {
				create: (
					project: StoredProject,
					opencodeUrl: string,
					projectControls?: RelayFactoryProjectControls,
				): Effect.Effect<ProjectRelay, RelayFactoryError> =>
					Effect.gen(function* () {
						// Read current HTTP server from Ref
						const httpServer = yield* Ref.get(httpServerRef);
						if (!httpServer) {
							return yield* new RelayFactoryError({
								reason: "HTTP server not started",
							});
						}

						// Create persistence DB directory and open SQLite
						if (!existsSync(project.directory)) {
							return yield* new RelayFactoryError({
								reason: `Project directory does not exist: ${project.directory}`,
							});
						}
						const dbPath = projectEventsDbPath(project);
						const conduitDir = dirname(dbPath);
						yield* Effect.try({
							try: () => mkdirSync(conduitDir, { recursive: true }),
							catch: (cause) =>
								new RelayFactoryError({
									reason: `Failed to create .conduit directory at ${conduitDir}`,
									cause,
								}),
						});

						// Dynamic import to avoid circular dependency at module load time
						const { createProjectRelay } = yield* Effect.tryPromise({
							try: () => import("../../../relay/relay-stack.js"),
							catch: (cause) =>
								new RelayFactoryError({
									reason: "Failed to import relay-stack module",
									cause,
								}),
						});

						// Read config for any runtime values needed
						const _config = yield* Ref.get(configRef);
						const instances = Array.from(
							yield* getEffectInstances.pipe(
								Effect.provideService(InstanceManagerStateTag, instanceState),
							),
						);
						const selectedInstance =
							instances.find(
								(instance) =>
									instance.driver !== "claude" &&
									instance.id === project.instanceId,
							) ?? instances.find((instance) => instance.driver !== "claude");
						const opencodeAuth = selectedInstance?.managed
							? openCodeAuth(
									yield* getManagedOpenCodeProcessEnv(selectedInstance.id).pipe(
										Effect.provideService(
											InstanceManagerStateTag,
											instanceState,
										),
									),
								)
							: undefined;
						envResolver?.register(project.directory, project.shellEnv);
						const relayPushSender = yield* pushManager.getLegacyManager.pipe(
							Effect.map(Option.getOrUndefined),
						);

						// Create the relay using the imperative createProjectRelay while
						// threading Effect-owned daemon read models and instance callbacks.
						const ac = new AbortController();
						let lastPublishedGit: SessionGit | undefined;
						let creation: Promise<ProjectRelay> | undefined;
						const relay = yield* Effect.tryPromise({
							try: () => {
								creation = createProjectRelay({
									httpServer,
									opencodeUrl,
									...(opencodeAuth !== undefined ? { opencodeAuth } : {}),
									projectDir: project.directory,
									...(envResolver && {
										shellEnv: (directory: string) => envResolver.get(directory),
										prepareShellEnv: (directory: string) =>
											envResolver.waitUntilReady(directory),
									}),
									slug: project.slug,
									noServer: true,
									signal: ac.signal,
									configDir,
									persistenceDbPath: dbPath,
									getProjects,
									listDaemonSessions,
									broadcastSessionListChanged,
									refreshSessionGit: async () => {
										const git = await daemonSessionGitCache.refresh(
											project.directory,
										);
										if (isDeepStrictEqual(git, lastPublishedGit)) return;
										await publishProjectList();
										await broadcastSessionListChanged();
										lastPublishedGit = git;
									},
									getInstances,
									addInstance,
									removeInstance,
									startInstance,
									stopInstance,
									updateInstance,
									persistConfig,
									triggerScan,
									getCachedUpdate,
									...(relayPushSender != null && {
										pushManager: relayPushSender,
									}),
									...(projectControls != null && {
										addProject: projectControls.addProject,
										removeProject: projectControls.removeProject,
										setProjectTitle: projectControls.setProjectTitle,
										setProjectInstance: projectControls.setProjectInstance,
									}),
								});
								return creation;
							},
							catch: (cause) =>
								new RelayFactoryError({
									reason: `Failed to create relay for project "${project.slug}"`,
									cause,
								}),
						}).pipe(
							Effect.onInterrupt(() =>
								Effect.gen(function* () {
									ac.abort();
									const pending = creation;
									if (!pending) return;
									// Interruption must join rollback before removal or a registry sweep.
									// A late successful acquisition still needs its scope closed.
									yield* Effect.tryPromise({
										try: () =>
											pending.then(
												(relay) => relay.stop(),
												() => undefined,
											),
										catch: (cause) =>
											new RelayFactoryError({
												reason: `Failed to stop cancelled relay for project "${project.slug}"`,
												cause,
											}),
									}).pipe(Effect.catchAll((error) => Effect.logError(error)));
								}),
							),
						);

						return relay;
					}).pipe(
						Effect.annotateLogs("slug", project.slug),
						Effect.withSpan("RelayFactory.create", {
							attributes: {
								slug: project.slug,
								directory: project.directory,
							},
						}),
					),
			} satisfies RelayFactory;
		}),
	).pipe(
		// Merge HttpServerRefLive so HttpServerRefTag is both provided to
		// the factory AND exposed to the caller (for setting the server later).
		Layer.provideMerge(HttpServerRefLive),
	);
