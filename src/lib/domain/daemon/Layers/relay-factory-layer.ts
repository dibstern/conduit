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
import {
	Context,
	Data,
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
} from "effect";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import {
	ProjectSaveRejected,
	type SaveProjectInput,
} from "../../../contracts/ws-rpc.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import {
	daemonStorePath,
	projectStorageDir,
	writeProjectStorageOwner,
} from "../../../persistence/project-storage.js";
import type { ProjectRelay } from "../../../relay/relay-stack.js";
import type { StoredProject } from "../../../types.js";
import {
	DaemonSessionQueryServiceError,
	DaemonSessionQueryServiceTag,
} from "../../relay/Services/daemon-session-query-service.js";
import {
	InputDraftsTag,
	makeInputDrafts,
} from "../../relay/Services/input-drafts.js";
import {
	InstanceManagementServiceError,
	InstanceManagementServiceTag,
} from "../../relay/Services/instance-management-service.js";
import {
	ProjectManagementNotSupported,
	ProjectManagementServiceError,
	ProjectManagementServiceTag,
	type SaveProjectResult,
} from "../../relay/Services/project-management-service.js";
import { ScanServiceTag } from "../../relay/Services/scan-service.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { CategorySet } from "../Services/category-set.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	listArchivedSessions,
	listDaemonSessions as listEffectDaemonSessions,
} from "../Services/daemon-session-reader.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";
import type { InstanceHealthCheckTag } from "../Services/instance-health-service.js";
import {
	addInstance as addEffectInstance,
	getInstance as getEffectInstance,
	getInstances as getEffectInstances,
	InstanceManagerStateTag,
	type PollerFibersTag,
	persistConfig as persistEffectInstanceConfig,
	removeInstance as removeEffectInstance,
	updateInstance as updateEffectInstance,
} from "../Services/instance-manager-service.js";
import { MessageSurfacingSettings } from "../Services/message-surfacing-settings.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { persistenceStoreContext } from "../Services/project-read-database.js";
import {
	type broadcastProjectList,
	getEffectiveWorktreeCleanup,
	projectInfos as getEffectProjectInfos,
	openCodeInstanceFor,
	ProjectRegistryTag,
	type removeProjectFromEffectRegistry,
	type saveProject,
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
export class HttpServerRefTag extends Context.Service<
	HttpServerRefTag,
	Ref.Ref<http.Server | null>
>()("HttpServerRef") {}

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
	readonly saveProject: (
		input: SaveProjectInput,
	) => Effect.Effect<
		Omit<SaveProjectResult, "projects">,
		| Effect.Error<ReturnType<typeof saveProject>>
		| Effect.Error<typeof broadcastProjectList>
	>;
	readonly removeProject: (
		slug: string,
	) => Effect.Effect<
		void,
		| Effect.Error<ReturnType<typeof removeProjectFromEffectRegistry>>
		| Effect.Error<typeof broadcastProjectList>
	>;
}

export class RelayFactoryTag extends Context.Service<
	RelayFactoryTag,
	RelayFactory
>()("RelayFactory") {}

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
	| SessionEventBusTag
	| ConfigPersistenceTag
	| PortScannerTag
	| PushManagerTag
	| OpenCodeInstancesTag
	| PersistenceStore
> =>
	Layer.effect(
		RelayFactoryTag,
		Effect.gen(function* () {
			const accounts = yield* AccountDirectory;
			const surfacing = yield* Effect.serviceOption(MessageSurfacingSettings);
			const categories = yield* Effect.serviceOption(CategorySet);
			const sessionDirectory = yield* Effect.serviceOption(SessionDirectory);
			const storeContext = yield* persistenceStoreContext;
			const sharedDrafts = yield* Effect.serviceOption(InputDraftsTag);
			const inputDrafts = Option.isSome(sharedDrafts)
				? sharedDrafts.value
				: yield* makeInputDrafts.pipe(Effect.provide(yield* PersistenceStore));
			const unavailable = yield* DaemonStoreAvailability;
			const configRef = yield* DaemonConfigRefTag;
			const envResolver = Option.getOrUndefined(
				yield* Effect.serviceOption(ProjectShellEnvTag),
			);
			const httpServerRef = yield* HttpServerRefTag;
			const projectRegistry = yield* ProjectRegistryTag;
			const instanceState = yield* InstanceManagerStateTag;
			const eventBus = yield* DaemonEventBusTag;
			const activity = yield* SessionActivityTag;
			const sessionEventBus = yield* SessionEventBusTag;
			const cleanupQueue = yield* Effect.serviceOption(WorktreeCleanupQueueTag);
			const configPersistence = yield* ConfigPersistenceTag;
			const portScanner = yield* PortScannerTag;
			const pushManager = yield* PushManagerTag;
			const openCodeInstances = yield* OpenCodeInstancesTag;
			const usage = Option.getOrUndefined(yield* Effect.serviceOption(Usage));
			const worktreeService = yield* Effect.serviceOption(WorktreeServiceTag);
			const tracer = yield* Effect.tracer;
			const baseDaemonContext = yield* Effect.context<
				| AccountDirectory
				| ProjectRegistryTag
				| InstanceManagerStateTag
				| PollerFibersTag
				| InstanceHealthCheckTag
				| DaemonEventBusTag
				| SessionActivityTag
				| ConfigPersistenceTag
			>();
			const daemonContext = Context.merge(baseDaemonContext, storeContext);

			const scanAdapter = Context.make(ScanServiceTag, {
				scanNow: () => portScanner.scanNow(),
			});
			const daemonSessionQueryAdapter = Context.make(
				DaemonSessionQueryServiceTag,
				{
					listArchived: (options) =>
						listArchivedSessions(options).pipe(
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) => new DaemonSessionQueryServiceError({ cause }),
							),
						),
					list: (options) =>
						listEffectDaemonSessions(options).pipe(
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) => new DaemonSessionQueryServiceError({ cause }),
							),
						),
				},
			);
			const listInstances = getEffectInstances.pipe(
				Effect.provide(daemonContext),
				Effect.mapError(
					(cause) =>
						new InstanceManagementServiceError({ operation: "list", cause }),
				),
			);
			const instanceManagementAdapter = Context.make(
				InstanceManagementServiceTag,
				{
					list: () => listInstances,
					add: (input) =>
						addEffectInstance(input).pipe(
							Effect.andThen(persistEffectInstanceConfig),
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "add",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
					remove: (id) =>
						removeEffectInstance(id).pipe(
							Effect.andThen(persistEffectInstanceConfig),
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "remove",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
					start: (id) =>
						getEffectInstance(id).pipe(
							Effect.flatMap((instance) =>
								getProviderDriver(instance.driver ?? "opencode")
									?.runsOpenCodeServer
									? Effect.asVoid(Effect.scoped(openCodeInstances.use(id)))
									: Effect.void,
							),
							Effect.andThen(configPersistence.flush),
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "start",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
					stop: (id) =>
						openCodeInstances.stop(id).pipe(
							Effect.andThen(configPersistence.flush),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "stop",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
					update: (id, input) =>
						updateEffectInstance(id, input).pipe(
							Effect.andThen(persistEffectInstanceConfig),
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "update",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
					rename: (id, name) =>
						updateEffectInstance(id, { name }).pipe(
							Effect.andThen(persistEffectInstanceConfig),
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new InstanceManagementServiceError({
										operation: "rename",
										cause,
									}),
							),
							Effect.andThen(listInstances),
						),
				},
			);

			return {
				create: (
					project: StoredProject,
					projectControls?: RelayFactoryProjectControls,
				): Effect.Effect<ProjectRelay, RelayFactoryError> =>
					Effect.gen(function* () {
						const listProjects = getEffectProjectInfos.pipe(
							Effect.provide(daemonContext),
							Effect.mapError(
								(cause) =>
									new ProjectManagementServiceError({
										operation: "list",
										cause,
									}),
							),
						);
						const projectManagementAdapter = Context.make(
							ProjectManagementServiceTag,
							{
								currentSlug: () => Effect.succeed(project.slug),
								list: () => listProjects,
								save: (input) =>
									Effect.gen(function* () {
										if (projectControls === undefined) {
											return yield* new ProjectManagementNotSupported({
												operation: "save",
												message:
													"Saving projects is not supported in this mode",
											});
										}
										const result = yield* projectControls
											.saveProject(input)
											.pipe(
												Effect.mapError((cause) =>
													cause instanceof ProjectSaveRejected
														? cause
														: new ProjectManagementServiceError({
																operation: "save",
																cause,
															}),
												),
											);
										return { ...result, projects: yield* listProjects };
									}),
								remove: (slug) =>
									Effect.gen(function* () {
										if (projectControls === undefined) {
											return yield* new ProjectManagementNotSupported({
												operation: "remove",
												message:
													"Removing projects is not supported in this mode",
											});
										}
										yield* projectControls.removeProject(slug).pipe(
											Effect.mapError(
												(cause) =>
													new ProjectManagementServiceError({
														operation: "remove",
														cause,
													}),
											),
										);
										return yield* listProjects;
									}),
							},
						);
						const daemonServices = Context.mergeAll(
							scanAdapter,
							daemonSessionQueryAdapter,
							projectManagementAdapter,
							instanceManagementAdapter,
						);
						// Read current HTTP server from Ref
						const httpServer = yield* Ref.get(httpServerRef);
						if (!httpServer) {
							return yield* new RelayFactoryError({
								reason: "HTTP server not started",
							});
						}

						// Keep storage ownership metadata independently of event-store ownership.
						if (!existsSync(project.folders[0])) {
							return yield* new RelayFactoryError({
								reason: `Project directory does not exist: ${project.folders[0]}`,
							});
						}
						const unavailableReason = unavailable.get(project.slug);
						if (unavailableReason !== undefined) {
							return yield* new RelayFactoryError({
								reason: unavailableReason,
							});
						}
						const dbPath = daemonStorePath(configDir);
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
								Effect.provideService(AccountDirectory, accounts),
							),
						);
						const selectedInstance = openCodeInstanceFor(instances);
						envResolver?.register(project.folders[0], project.shellEnv);
						const relayPushSender = yield* pushManager.getLegacyManager.pipe(
							Effect.map(Option.getOrUndefined),
						);

						// Create the relay using the imperative createProjectRelay while
						// threading Effect-owned daemon services into the relay runtime.
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
										Context.merge(
											Option.isSome(surfacing)
												? Context.make(
														MessageSurfacingSettings,
														surfacing.value,
													)
												: Context.empty(),
										),
										Context.merge(
											Option.isSome(categories)
												? Context.make(CategorySet, categories.value)
												: Context.empty(),
										),
										Context.add(SessionActivityTag, activity),
										Context.add(SessionEventBusTag, sessionEventBus),
										Context.add(InputDraftsTag, inputDrafts),
										Context.add(DaemonEventBusTag, eventBus),
										Context.add(ProjectRegistryTag, projectRegistry),
										Context.add(PortScannerTag, portScanner),
										Context.merge(storeContext),
										Context.merge(daemonServices),
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
									requestWorktreeCleanup: () =>
										cleanupQueue._tag === "Some"
											? Queue.offer(cleanupQueue.value, {
													projectSlug: project.slug,
												}).pipe(Effect.asVoid)
											: Effect.void,
									getWorktreeCleanup: () =>
										getEffectiveWorktreeCleanup(project.slug).pipe(
											Effect.provideService(
												ProjectRegistryTag,
												projectRegistry,
											),
											Effect.provideService(DaemonConfigRefTag, configRef),
											Effect.orElseSucceed(() => "off" as const),
										),
									publishGlobalSetting: (tag) =>
										PubSub.publish(
											eventBus,
											DaemonEvent.GlobalSettingChanged({
												originSlug: project.slug,
												tag,
											}),
										).pipe(Effect.asVoid),
									...(relayPushSender != null && {
										pushManager: relayPushSender,
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
									}).pipe(Effect.catch((error) => Effect.logError(error)));
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
