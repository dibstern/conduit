import type { AddAccountInput } from "../../../contracts/account.js";
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
import { join } from "node:path";
import {
	Cause,
	Context,
	Data,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Runtime,
} from "effect";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import {
	projectEventsDbPath,
	projectStorageDir,
	writeProjectStorageOwner,
} from "../../../persistence/project-storage.js";
import type { ProjectRelay } from "../../../relay/relay-stack.js";
import type { OpenCodeInstance } from "../../../shared-types.js";
import type { ProjectRelayConfig, StoredProject } from "../../../types.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { listDaemonSessions as listEffectDaemonSessions } from "../Services/daemon-session-reader.js";
import { InstanceHealthCheckTag } from "../Services/instance-health-service.js";
import {
	addInstance as addEffectInstance,
	getInstance as getEffectInstance,
	getInstances as getEffectInstances,
	InstanceManagerStateTag,
	PollerFibersTag,
	persistConfig as persistEffectInstanceConfig,
	removeInstance as removeEffectInstance,
	updateInstance as updateEffectInstance,
} from "../Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import {
	broadcastProjectList,
	projectInfos as getEffectProjectInfos,
	openCodeInstanceFor,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import { SessionDirectory } from "../Services/session-directory.js";
import { Usage } from "../Services/usage.js";
import { WorktreeCleanupQueueTag } from "../Services/worktree-cleanup-service.js";
import { WorktreeServiceTag } from "../Services/worktree-service.js";
import { PortScannerTag } from "./port-scanner-layer.js";
import { ProjectShellEnvTag } from "./project-shell-env-layer.js";

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
		projectControls?: RelayFactoryProjectControls,
	) => Effect.Effect<ProjectRelay, RelayFactoryError>;
}

export interface RelayFactoryProjectControls {
	readonly saveProject: NonNullable<ProjectRelayConfig["saveProject"]>;
	readonly removeProject: NonNullable<ProjectRelayConfig["removeProject"]>;
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
	| AccountDirectory
	| ProjectRegistryTag
	| InstanceManagerStateTag
	| PollerFibersTag
	| InstanceHealthCheckTag
	| DaemonEventBusTag
	| SessionActivityTag
	| ConfigPersistenceTag
	| PortScannerTag
	| PushManagerTag
	| OpenCodeInstancesTag
> =>
	Layer.effect(
		RelayFactoryTag,
		Effect.gen(function* () {
			const accounts = yield* AccountDirectory;
			const sessionDirectory = yield* Effect.serviceOption(SessionDirectory);
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
			const activity = yield* SessionActivityTag;
			const cleanupQueue = yield* Effect.serviceOption(WorktreeCleanupQueueTag);
			const configPersistence = yield* ConfigPersistenceTag;
			const portScanner = yield* PortScannerTag;
			const pushManager = yield* PushManagerTag;
			const openCodeInstances = yield* OpenCodeInstancesTag;
			const usage = Option.getOrUndefined(yield* Effect.serviceOption(Usage));
			const worktreeService = yield* Effect.serviceOption(WorktreeServiceTag);
			const tracer = yield* Effect.tracer;
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
					listEffectDaemonSessions(configDir, options).pipe(
						Effect.provideService(ProjectRegistryTag, projectRegistry),
						Effect.provideService(AccountDirectory, accounts),
						Effect.provideService(SessionActivityTag, activity),
					),
				);
			const broadcastSessionListChanged = () =>
				runCallback(
					PubSub.publish(eventBus, DaemonEvent.DaemonSessionsChanged()).pipe(
						Effect.asVoid,
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
						Effect.provideService(AccountDirectory, accounts),
					),
				);

			const provideInstanceDeps = <A, E>(
				effect: Effect.Effect<
					A,
					E,
					| AccountDirectory
					| InstanceManagerStateTag
					| PollerFibersTag
					| InstanceHealthCheckTag
					| DaemonEventBusTag
					| ConfigPersistenceTag
				>,
			) =>
				effect.pipe(
					Effect.provideService(InstanceManagerStateTag, instanceState),
					Effect.provideService(AccountDirectory, accounts),
					Effect.provideService(PollerFibersTag, pollerFibers),
					Effect.provideService(InstanceHealthCheckTag, healthCheck),
					Effect.provideService(DaemonEventBusTag, eventBus),
					Effect.provideService(ConfigPersistenceTag, configPersistence),
				);

			const addInstance = (input: AddAccountInput) =>
				runCallback(provideInstanceDeps(addEffectInstance(input)));

			const removeInstance = (id: string) =>
				runCallback(provideInstanceDeps(removeEffectInstance(id)));

			// Only server-backed instances have an OpenCode process to start.
			const startInstance = (id: string) =>
				runCallback(
					provideInstanceDeps(getEffectInstance(id)).pipe(
						Effect.flatMap((instance) =>
							getProviderDriver(instance.driver ?? "opencode")
								?.runsOpenCodeServer
								? Effect.asVoid(Effect.scoped(openCodeInstances.use(id)))
								: Effect.void,
						),
					),
				);

			const stopInstance = (id: string) =>
				runCallback(openCodeInstances.stop(id));

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
								Effect.provideService(AccountDirectory, accounts),
							),
						),
					),
				);

			const persistConfig = () =>
				runCallback(provideInstanceDeps(persistEffectInstanceConfig));

			const triggerScan = () => runCallback(portScanner.scanNow());

			return {
				create: (
					project: StoredProject,
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
						if (!existsSync(project.folders[0])) {
							return yield* new RelayFactoryError({
								reason: `Project directory does not exist: ${project.folders[0]}`,
							});
						}
						const dbPath = projectEventsDbPath({ configDir, ...project });
						const storageDir = projectStorageDir(configDir, project.slug);
						yield* Effect.try({
							try: () => {
								mkdirSync(storageDir, { recursive: true });
								writeProjectStorageOwner(
									configDir,
									project.slug,
									project.folders[0],
								);
							},
							catch: (cause) =>
								new RelayFactoryError({
									reason: `Failed to prepare project storage at ${storageDir}`,
									cause,
								}),
						}).pipe(
							Effect.catchAll((error) =>
								dbPath === join(storageDir, "events.db")
									? Effect.fail(error)
									: Effect.logWarning(
											"Using legacy project history after storage setup failed",
											{ projectSlug: project.slug, cause: error },
										),
							),
						);

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
								Effect.provideService(AccountDirectory, accounts),
							),
						);
						const selectedInstance = openCodeInstanceFor(instances);
						envResolver?.register(project.folders[0], project.shellEnv);
						const relayPushSender = yield* pushManager.getLegacyManager.pipe(
							Effect.map(Option.getOrUndefined),
						);

						// Create the relay using the imperative createProjectRelay while
						// threading Effect-owned daemon read models and instance callbacks.
						const ac = new AbortController();
						let creation: Promise<ProjectRelay> | undefined;
						const relay = yield* Effect.tryPromise({
							try: () => {
								creation = createProjectRelay({
									httpServer,
									daemonConfigContext: Context.make(
										DaemonConfigRefTag,
										configRef,
									).pipe(
										Context.add(ConfigPersistenceTag, configPersistence),
										Context.add(AccountDirectory, accounts),
										Context.add(SessionActivityTag, activity),
										Context.merge(
											Option.isSome(sessionDirectory)
												? Context.make(SessionDirectory, sessionDirectory.value)
												: Context.empty(),
										),
									),
									openCodeInstances,
									...(Option.isSome(worktreeService)
										? {
												worktreeContext: Context.make(
													WorktreeServiceTag,
													worktreeService.value,
												),
											}
										: {}),
									...(usage ? { usage } : {}),
									...(selectedInstance
										? { openCodeInstanceId: selectedInstance.id }
										: {}),
									projectDir: project.folders[0],
									extraFolders: project.folders.slice(1),
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
									tracer,
									getProjects,
									listDaemonSessions,
									resolveSessionProject: (sessionId) =>
										runCallback(
											Option.isSome(sessionDirectory)
												? sessionDirectory.value
														.projectOf(sessionId)
														.pipe(Effect.map(Option.getOrNull))
												: Effect.succeed(null),
										),
									broadcastSessionListChanged,
									requestWorktreeCleanup: () =>
										cleanupQueue._tag === "Some"
											? Queue.offer(cleanupQueue.value, {
													projectSlug: project.slug,
												}).pipe(Effect.asVoid)
											: Effect.void,
									publishGlobalSetting: (tag) =>
										PubSub.publish(
											eventBus,
											DaemonEvent.GlobalSettingChanged({
												originSlug: project.slug,
												tag,
											}),
										).pipe(Effect.asVoid),
									refreshSessionGit: async () => {
										await publishProjectList();
									},
									getInstances,
									addInstance,
									removeInstance,
									startInstance,
									stopInstance,
									updateInstance,
									persistConfig,
									triggerScan,
									...(relayPushSender != null && {
										pushManager: relayPushSender,
									}),
									...(projectControls != null && {
										saveProject: projectControls.saveProject,
										removeProject: projectControls.removeProject,
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
								mainFolder: project.folders[0],
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
