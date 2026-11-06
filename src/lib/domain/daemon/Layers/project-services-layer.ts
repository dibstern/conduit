import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Semaphore,
} from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { createLogger } from "../../../logger.js";
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import type { ClaudeSdkSeam } from "../../../types.js";
import { EventRetentionSchedulerTag } from "../../persistence/Services/event-retention-scheduler.js";
import type { PersistenceError } from "../../persistence/Services/persistence-service.js";
import type { InputDraftsTag } from "../../relay/Services/input-drafts.js";
import { OpenCodeSessionCreationGateTag } from "../../relay/Services/opencode-runtime-ingress-service.js";
import {
	makeRelayStatusSnapshot,
	RelayStatusSnapshotTag,
} from "../../relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OrchestrationEngineTag,
} from "../../relay/Services/services.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { SessionManagerError } from "../../relay/Services/session-manager-error.js";
import {
	makeSessionManagers,
	SessionManagerServiceTag,
} from "../../relay/Services/session-manager-service.js";
import {
	SessionManagerCoordinationTag,
	SessionManagerStateTag,
} from "../../relay/Services/session-manager-state.js";
import type { OverridesStateTag } from "../../relay/Services/session-overrides-state.js";
import type { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { AccountDirectory } from "../Services/account-directory.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../Services/daemon-orchestration.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { OwnerScopes } from "../Services/owner-scopes.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import {
	type ProjectGenerationParts,
	ProjectServices,
	ProjectServicesError,
	projectConfig,
} from "../Services/project-services.js";
import type { SessionActivityTag } from "../Services/session-activity.js";
import { SessionManagerOwner } from "../Services/session-manager-owner.js";
import { WorktreeCleanupQueueTag } from "../Services/worktree-cleanup-service.js";
import { ProjectShellEnvTag } from "./project-shell-env-layer.js";
import type { PollerTimings } from "./relay-factory-layer.js";

/**
 * Builds each registered project's context on request, from the registry and
 * the daemon's own services (82tn.16). What a project generation owns (status
 * snapshot, OpenCode creation gate, model catalog, store binding) is made once
 * in the project's owner scope, so it outlives any relay and goes with removal.
 */
export const makeProjectServicesLive = (options: {
	readonly configDir: string;
	readonly claudeSdk?: ClaudeSdkSeam | undefined;
	readonly pollerTimings?: PollerTimings | undefined;
}) =>
	Layer.effect(
		ProjectServices,
		Effect.gen(function* () {
			const registry = yield* ProjectRegistryTag;
			const owners = yield* OwnerScopes;
			const store = yield* PersistenceStore;
			const unavailable = yield* DaemonStoreAvailability;
			const environments = Option.getOrUndefined(
				yield* Effect.serviceOption(ProjectShellEnvTag),
			);
			const daemon = {
				...options,
				environments,
				cleanupQueue: yield* Effect.serviceOption(WorktreeCleanupQueueTag),
				registry,
				configRef: yield* DaemonConfigRefTag,
				eventBus: yield* DaemonEventBusTag,
			};
			const managers = yield* SessionManagerOwner;
			const { engine } = yield* DaemonOrchestration;
			const shared = yield* Effect.context<
				| AccountDirectory
				| InputDraftsTag
				| OpenCodeInstancesTag
				| SessionActivityTag
				| OverridesStateTag
				| DaemonEventBusTag
				| SessionWorkspaceTag
				| SessionEventBusTag
				| EventRetentionSchedulerTag
			>();
			const log = createLogger("relay");
			const generations = new Map<
				string,
				Context.Context<ProjectGenerationParts>
			>();
			const lock = yield* Semaphore.make(1);
			const refuse = (projectId: string, reason: string) =>
				new ProjectServicesError({ projectId, reason });
			const registered = (projectId: string) =>
				Effect.gen(function* () {
					const entry = HashMap.get(yield* Ref.get(registry), projectId);
					if (Option.isNone(entry))
						return yield* refuse(
							projectId,
							`Project "${projectId}" is not registered`,
						);
					const reason = unavailable.get(projectId);
					if (reason !== undefined) return yield* refuse(projectId, reason);
					return entry.value.project;
				});
			const generation = (
				projectId: string,
			): Effect.Effect<
				Context.Context<ProjectGenerationParts>,
				ProjectServicesError
			> =>
				lock
					.withPermits(1)(
						Effect.gen(function* () {
							const existing = generations.get(projectId);
							if (existing) return existing;
							const project = yield* registered(projectId);
							const scope = yield* owners.projectScope(projectId);
							return yield* scope.acquire<
								Context.Context<ProjectGenerationParts>,
								PersistenceError,
								never
							>(
								Effect.gen(function* () {
									const persistence = yield* Layer.build(
										makePersistenceProjectLayer(projectId, {
											sessionEventBusLayer: Layer.succeedContext(
												Context.pick(SessionEventBusTag)(shared),
											),
											retentionSchedulerLayer: Layer.succeedContext(
												Context.pick(EventRetentionSchedulerTag)(shared),
											),
										}).pipe(Layer.provideMerge(Layer.succeedContext(store))),
									);
									// Built with the folders the project had at first use; a
									// catalog is per OpenCode instance, not per folder.
									const models = yield* Layer.build(
										OpenCodeModelServiceLive.pipe(
											Layer.provide(
												Layer.succeedContext(
													Context.pick(
														AccountDirectory,
														OpenCodeInstancesTag,
													)(shared).pipe(
														Context.add(
															ConfigTag,
															projectConfig(project, daemon),
														),
														Context.add(LoggerTag, log),
													),
												),
											),
										),
									);
									const parts = Context.mergeAll(persistence, models).pipe(
										Context.add(
											RelayStatusSnapshotTag,
											makeRelayStatusSnapshot(),
										),
										Context.add(
											OpenCodeSessionCreationGateTag,
											yield* Semaphore.make(1),
										),
									);
									generations.set(projectId, parts);
									yield* Effect.addFinalizer(() =>
										Effect.sync(() => generations.delete(projectId)),
									);
									return parts;
								}),
							);
						}),
					)
					.pipe(
						Effect.catchTags({
							OwnerScopeProjectNotRegisteredError: () =>
								Effect.fail(
									refuse(projectId, `Project "${projectId}" is not registered`),
								),
							OwnerScopeClosedError: (error) =>
								Effect.fail(
									refuse(
										projectId,
										`Project "${projectId}" is closing (${error.reason})`,
									),
								),
							PersistenceError: (error) =>
								Effect.fail(
									refuse(
										projectId,
										`Project "${projectId}" store is unavailable: ${formatErrorDetail(error)}`,
									),
								),
						}),
					);
			return {
				generation,
				forProject: (projectId) =>
					Effect.gen(function* () {
						const project = yield* registered(projectId);
						environments?.register(
							project.folders[0],
							project.shellEnv,
							projectId,
						);
						const parts = yield* generation(projectId);
						const manager = yield* managers
							.project(projectId)
							.pipe(
								Effect.mapError((error) =>
									refuse(projectId, formatErrorDetail(error)),
								),
							);
						return Context.merge(shared, parts).pipe(
							Context.add(ConfigTag, projectConfig(project, daemon)),
							Context.add(LoggerTag, log),
							Context.add(OrchestrationEngineTag, engine),
							Context.add(SessionManagerStateTag, manager.state),
							Context.add(SessionManagerCoordinationTag, manager.coordination),
						);
					}),
			};
		}),
	);

/** The daemon's session managers: every project's parts come from ProjectServices. */
export const DaemonSessionManagersLive = Layer.effect(
	SessionManagerServiceTag,
	Effect.map(ProjectServices, (projects) =>
		makeSessionManagers((projectId) =>
			projects.forProject(projectId).pipe(
				Effect.mapError(
					(error) =>
						new SessionManagerError({
							operation: "forProject",
							cause: error.reason,
						}),
				),
			),
		),
	),
);
