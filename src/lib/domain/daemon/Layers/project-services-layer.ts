import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Semaphore,
} from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { formatErrorDetail } from "../../../errors.js";
import { createLogger } from "../../../logger.js";
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import type { ProjectionRunnerError } from "../../../persistence/effect/projection-runner-effect.js";
import { loadClaudeSdkTestModule } from "../../../provider/claude/claude-sdk-module.js";
import { defaultClaudeSessionForkSdk } from "../../../provider/claude/claude-session-fork.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { createTranslator } from "../../../relay/event-translator.js";
import type { ClaudeSdkSeam } from "../../../types.js";
import { EventRetentionSchedulerTag } from "../../persistence/Services/event-retention-scheduler.js";
import type { PersistenceError } from "../../persistence/Services/persistence-service.js";
import {
	AgentLivenessLive,
	makeProjectIngestionLive,
	makeProjectOpenCodeIngressLive,
} from "../../relay/Layers/project-ingestion-layer.js";
import type { AlertsTag } from "../../relay/Services/alerts.js";
import { DirectoryListingServiceLive } from "../../relay/Services/directory-listing-service.js";
import type { InputDraftsTag } from "../../relay/Services/input-drafts.js";
import { OpenCodeSessionCreationGateTag } from "../../relay/Services/opencode-runtime-ingress-service.js";
import { ProjectSettingsLive } from "../../relay/Services/project-settings.js";
import {
	makeRelayStatusSnapshot,
	RelayStatusSnapshotTag,
} from "../../relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OrchestrationEngineTag,
	TranslatorTag,
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
import { makeSessionTitleServiceLive } from "../../relay/Services/session-title-service.js";
import type { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { ToolContentServiceLive } from "../../relay/Services/tool-content-service.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { AccountDirectory } from "../Services/account-directory.js";
import type { CategorySet } from "../Services/category-set.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../Services/daemon-orchestration.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";
import type { DaemonTurns } from "../Services/daemon-turns.js";
import type { MessageSurfacingSettings } from "../Services/message-surfacing-settings.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import type { OpenCodeSessionIds } from "../Services/opencode-session-ids.js";
import { OwnerScopes } from "../Services/owner-scopes.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import {
	type ProjectGenerationParts,
	ProjectServices,
	ProjectServicesError,
	projectConfig,
} from "../Services/project-services.js";
import { ProviderAdapters } from "../Services/provider-adapters.js";
import type { SessionActivityTag } from "../Services/session-activity.js";
import { SessionManagerOwner } from "../Services/session-manager-owner.js";
import type { Usage } from "../Services/usage.js";
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
			// A relay's calls ran with the SDK its process uses; a cold project's must too.
			const testSdk = (yield* loadClaudeSdkTestModule.pipe(Effect.orDie))
				?.claudeSdk;
			const daemon = {
				...options,
				claudeSdk:
					options.claudeSdk ??
					(testSdk?.titleQuery && testSdk.fork
						? {
								query: testSdk.query,
								titleQuery: testSdk.titleQuery,
								fork: testSdk.fork,
							}
						: {
								query: sdkQuery,
								titleQuery: sdkQuery,
								fork: defaultClaudeSessionForkSdk,
							}),
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
				| OpenCodeSessionIds
				| SessionActivityTag
				| OverridesStateTag
				| DaemonEventBusTag
				| SessionWorkspaceTag
				| SessionEventBusTag
				| EventRetentionSchedulerTag
			>();
			// What a project's ingestion side reads from the daemon.
			const ingestionShared = yield* Effect.context<
				| AlertsTag
				| Usage
				| MessageSurfacingSettings
				| CategorySet
				| ProviderAdapters
				| DaemonTurns
			>();
			const push = yield* PushManagerTag;
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
			const storeUnavailable =
				(projectId: string) =>
				(error: PersistenceError | ProjectionRunnerError | SqlError) =>
					Effect.fail(
						refuse(
							projectId,
							`Project "${projectId}" store is unavailable: ${formatErrorDetail(error)}`,
						),
					);
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
								PersistenceError | ProjectionRunnerError | SqlError,
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
									const gate = yield* Semaphore.make(1);
									const projectBase = Context.mergeAll(
										shared,
										ingestionShared,
										persistence,
									).pipe(
										Context.add(ConfigTag, projectConfig(project, daemon)),
										Context.add(LoggerTag, log),
										Context.add(OrchestrationEngineTag, engine),
										Context.add(OpenCodeSessionCreationGateTag, gate),
										Context.add(
											ProviderRegistryTag,
											Context.get(ingestionShared, ProviderAdapters).registry,
										),
									);
									// Once per project, so a replaced relay keeps its pending
									// interactions, translator and ingress (82tn.16 slice 4).
									const ingestion = yield* Layer.build(
										makeProjectIngestionLive(push.getLegacyManager).pipe(
											Layer.provide(Layer.succeedContext(projectBase)),
										),
									);
									const ingress = yield* Layer.build(
										makeProjectOpenCodeIngressLive.pipe(
											Layer.provide(
												Layer.succeedContext(
													Context.merge(projectBase, ingestion),
												),
											),
										),
									);
									// A relay's title in flight and its discovered catalogs outlived
									// the relay that started them (82tn.16 slice 5).
									const titles = yield* Layer.build(
										makeSessionTitleServiceLive().pipe(
											Layer.provideMerge(ProjectSettingsLive),
											Layer.provide(Layer.succeedContext(projectBase)),
										),
									);
									// Stateless readers, built here so no relay has to (slice 7).
									const readers = yield* Layer.build(
										Layer.mergeAll(
											ToolContentServiceLive,
											DirectoryListingServiceLive,
											AgentLivenessLive,
										).pipe(Layer.provide(Layer.succeedContext(projectBase))),
									);
									const parts = Context.mergeAll(
										persistence,
										models,
										ingestion,
										ingress,
										titles,
										readers,
									).pipe(
										Context.add(
											RelayStatusSnapshotTag,
											makeRelayStatusSnapshot(),
										),
										Context.add(OpenCodeSessionCreationGateTag, gate),
										Context.add(TranslatorTag, createTranslator()),
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
							PersistenceError: storeUnavailable(projectId),
							ProjectionRunnerError: storeUnavailable(projectId),
							SqlError: storeUnavailable(projectId),
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
