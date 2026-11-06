import { existsSync, mkdirSync } from "node:fs";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import type { SqlError } from "effect/sql/SqlError";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import { createLogger } from "../../../logger.js";
import {
	makePersistenceProjectLayer,
	PersistenceStore,
} from "../../../persistence/effect/live.js";
import type { ProjectionRunnerError } from "../../../persistence/effect/projection-runner-effect.js";
import {
	projectStorageDir,
	writeProjectStorageOwner,
} from "../../../persistence/project-storage.js";
import { loadClaudeSdkTestModule } from "../../../provider/claude/claude-sdk-module.js";
import { defaultClaudeSessionForkSdk } from "../../../provider/claude/claude-session-fork.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { createTranslator } from "../../../relay/event-translator.js";
import { RpcSubscriptionScopeTag } from "../../../server/ws-rpc.js";
import type { ClaudeSdkSeam } from "../../../types.js";
import { EventRetentionSchedulerTag } from "../../persistence/Services/event-retention-scheduler.js";
import type { PersistenceError } from "../../persistence/Services/persistence-service.js";
import { MessagePollerManagerLive } from "../../relay/Layers/message-poller-manager-layer.js";
import {
	AgentLivenessLive,
	makeProjectIngestionLive,
	makeProjectOpenCodeIngressLive,
} from "../../relay/Layers/project-ingestion-layer.js";
import { makePtyRuntimeLive } from "../../relay/Layers/pty-manager-layer.js";
import { SessionStateProjectionNotifierLive } from "../../relay/Layers/session-state-projection-notifier-layer.js";
import { StatusPollerLive } from "../../relay/Layers/status-poller-layer.js";
import { AgentServiceLive } from "../../relay/Services/agent-service.js";
import type { AlertsTag } from "../../relay/Services/alerts.js";
import { DirectoryListingServiceLive } from "../../relay/Services/directory-listing-service.js";
import { makeGoalSummaryServiceLive } from "../../relay/Services/goal-summary-service.js";
import { HandoffReceiptsLive } from "../../relay/Services/handoff-receipts.js";
import type { InputDraftsTag } from "../../relay/Services/input-drafts.js";
import { OpenCodeSessionCreationGateTag } from "../../relay/Services/opencode-runtime-ingress-service.js";
import {
	ProjectSettingsLive,
	refreshGlobalDefaults,
} from "../../relay/Services/project-settings.js";
import {
	ProviderTurnServiceTag,
	ProviderTurns,
} from "../../relay/Services/provider-turn-service.js";
import { makeRecapServiceLive } from "../../relay/Services/recap-service.js";
import {
	makeRelayStatusSnapshot,
	RelayStatusSnapshotTag,
} from "../../relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	TranslatorTag,
} from "../../relay/Services/services.js";
import { SessionEventBusTag } from "../../relay/Services/session-event-bus.js";
import { SessionInboxLive } from "../../relay/Services/session-inbox.js";
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
import type { SessionSetupTag } from "../../relay/Services/session-setup.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
	StatusPollerCoreTag,
} from "../../relay/Services/session-status-poller.js";
import { makeSessionTitleServiceLive } from "../../relay/Services/session-title-service.js";
import type { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { SessionWorkspaceHintStateTag } from "../../relay/Services/session-workspace-hint-state.js";
import { SSEStreamLive } from "../../relay/Services/sse-stream-service.js";
import {
	LocalPtyServiceTag,
	OpenCodeTerminalServiceLive,
} from "../../relay/Services/terminal-service.js";
import { ToolContentServiceLive } from "../../relay/Services/tool-content-service.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { AccountDirectory } from "../Services/account-directory.js";
import type { CategorySet } from "../Services/category-set.js";
import { ConfigSnapshotTag } from "../Services/config-persistence-service.js";
import { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../Services/daemon-orchestration.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { DaemonStoreAvailability } from "../Services/daemon-store-availability.js";
import type { DaemonTurns } from "../Services/daemon-turns.js";
import type { MessageSurfacingSettings } from "../Services/message-surfacing-settings.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { OpenCodeProjectStreams } from "../Services/opencode-project-streams.js";
import type { OpenCodeSessionIds } from "../Services/opencode-session-ids.js";
import { OwnerScopes } from "../Services/owner-scopes.js";
import { ProjectRegistryTag } from "../Services/project-registry-service.js";
import {
	type PollerTimings,
	type ProjectGenerationParts,
	ProjectServices,
	ProjectServicesError,
	projectConfig,
} from "../Services/project-services.js";
import { ProviderAdapters } from "../Services/provider-adapters.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import { SessionGit } from "../Services/session-git.js";
import { SessionManagerOwner } from "../Services/session-manager-owner.js";
import type { Usage } from "../Services/usage.js";
import { WorktreeCleanupQueueTag } from "../Services/worktree-cleanup-service.js";
import type { WorktreeServiceTag } from "../Services/worktree-service.js";
import { ProjectShellEnvTag } from "./project-shell-env-layer.js";
import { startProject } from "./project-startup.js";

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
	Layer.effectContext(
		Effect.gen(function* () {
			const registry = yield* ProjectRegistryTag;
			const owners = yield* OwnerScopes;
			const store = yield* PersistenceStore;
			const unavailable = yield* DaemonStoreAvailability;
			const environments = Option.getOrUndefined(
				yield* Effect.serviceOption(ProjectShellEnvTag),
			);
			// Goal summaries read the daemon's config from memory when it has one (82tn.18).
			const configSnapshot = yield* Effect.serviceOption(ConfigSnapshotTag);
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
			const providerTurns = yield* ProviderTurns;
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
			// What a turn reads from the daemon beyond the project's own parts.
			const turnShared = yield* Effect.context<
				| OwnerScopes
				| OpenCodeProjectStreams
				| SessionGit
				| SessionSetupTag
				| WorktreeServiceTag
			>();
			const statusCore = yield* Effect.serviceOption(StatusPollerCoreTag);
			const push = yield* PushManagerTag;
			const localPty = yield* LocalPtyServiceTag;
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
							// The status poller reads the project's session manager state.
							const manager = yield* managers.project(projectId);
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
									// Turns and the inbox drain, once per project (lane 16o). The
									// project's config reads its folders from the registry at each use.
									const turnContext = Context.mergeAll(
										projectBase,
										turnShared,
										models,
										ingestion,
										ingress,
										titles,
										readers,
									).pipe(
										Context.add(SessionManagerServiceTag, sessionManagers),
									);
									const turns = yield* providerTurns.own(
										projectId,
										turnContext,
									);
									const inbox = yield* Layer.build(
										SessionInboxLive.pipe(
											Layer.provideMerge(AgentServiceLive),
											Layer.provide(
												Layer.succeedContext(
													Context.add(
														turnContext,
														ProviderTurnServiceTag,
														turns,
													),
												),
											),
										),
									);
									// Terminals, once per project, so a replaced relay keeps them and a
									// main-folder change leaves them running: each call reads the folder
									// then, as t3code restarts a terminal only on a reopen with a changed
									// cwd (apps/server/src/terminal/Manager.ts:2938-2955).
									const terminals = yield* Layer.build(
										OpenCodeTerminalServiceLive.pipe(
											Layer.provideMerge(makePtyRuntimeLive()),
											Layer.provide(
												Layer.succeedContext(
													Context.add(
														projectBase,
														LocalPtyServiceTag,
														localPty,
													),
												),
											),
										),
									);
									// Stateless OpenCode readers; each call reads the folder then.
									const openCodeReaders = yield* Layer.build(
										Layer.merge(
											OpenCodeFileServiceLive,
											OpenCodeSettingsServiceLive,
										).pipe(Layer.provide(Layer.succeedContext(projectBase))),
									);
									// One message poller per project, so a replaced relay keeps its
									// polls; a session counts as viewed while any tab on the daemon
									// shows it (t3code CommandOutputHub.ts:170-191).
									const poller = yield* Layer.build(
										MessagePollerManagerLive.pipe(
											Layer.provide(Layer.succeedContext(projectBase)),
										),
									);
									// The project's OpenCode stream and status poller, so no relay holds
									// them (lane 16q); t3code starts its reactors once, in the server
									// scope (apps/server/src/server.ts:540-627).
									const snapshot = makeRelayStatusSnapshot();
									const streams = yield* Layer.build(
										Layer.merge(
											StatusPollerLive.pipe(
												Layer.provideMerge(
													Layer.merge(
														makePollerStateLive(),
														makePollerPubSubLive(),
													),
												),
											),
											SSEStreamLive,
										).pipe(
											Layer.provide(
												Layer.succeedContext(
													Context.mergeAll(
														projectBase,
														Context.pick(OpenCodeProjectStreams)(turnShared),
														Context.make(RelayStatusSnapshotTag, snapshot),
														Context.make(SessionManagerStateTag, manager.state),
														Option.isSome(statusCore)
															? Context.make(
																	StatusPollerCoreTag,
																	statusCore.value,
																)
															: Context.empty(),
													),
												),
											),
										),
									);
									// Recaps and goal summaries hold in-flight work and a cache, so one
									// per project outlives a replaced relay; their one-shot query is the
									// daemon's, which honours the process test module.
									const summaries = yield* Layer.build(
										Layer.merge(
											makeRecapServiceLive({
												queryFactory: daemon.claudeSdk.titleQuery,
											}),
											makeGoalSummaryServiceLive({
												queryFactory: daemon.claudeSdk.titleQuery,
											}),
										).pipe(
											Layer.provide(
												Layer.succeedContext(
													Option.isSome(configSnapshot)
														? Context.add(
																projectBase,
																ConfigSnapshotTag,
																configSnapshot.value,
															)
														: projectBase,
												),
											),
										),
									);
									// The project's reactors over its committed events: a completed
									// handoff is recorded, and a projected session state refreshes
									// lineage (t3code: server.ts:540-627, one reactor set per scope).
									const reactors = yield* Layer.build(
										Layer.merge(
											HandoffReceiptsLive,
											SessionStateProjectionNotifierLive,
										).pipe(
											Layer.provide(
												Layer.succeedContext(
													Context.merge(
														projectBase,
														Context.pick(SessionGit)(turnShared),
													).pipe(
														Context.add(
															SessionManagerServiceTag,
															sessionManagers,
														),
													),
												),
											),
										),
									);
									const parts = Context.mergeAll(
										persistence,
										reactors,
										models,
										ingestion,
										ingress,
										titles,
										readers,
										inbox,
										terminals,
										openCodeReaders,
										summaries,
										poller,
										streams,
									).pipe(
										Context.add(ProviderTurnServiceTag, turns),
										Context.add(RelayStatusSnapshotTag, snapshot),
										Context.add(OpenCodeSessionCreationGateTag, gate),
										Context.add(TranslatorTag, createTranslator()),
										// t3code ties output listeners to the scope that owns them
										// (CommandOutputHub.ts:170-191).
										Context.add(RpcSubscriptionScopeTag, yield* Effect.scope),
									);
									generations.set(projectId, parts);
									yield* Effect.addFinalizer(() =>
										Effect.sync(() => {
											generations.delete(projectId);
											Context.get(shared, SessionActivityTag).forgetProject(
												projectId,
											);
										}),
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
			const forProject: ProjectServices["Service"]["forProject"] = (
				projectId,
			) =>
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
						// Dismissals are the daemon's, keyed by session, as its relay reads them.
						Context.add(
							SessionWorkspaceHintStateTag,
							Context.get(shared, SessionActivityTag).hintDismissals,
						),
					);
				});
			// The daemon's one session manager; a project's turns call it too.
			const sessionManagers = makeSessionManagers((projectId) =>
				forProject(projectId).pipe(
					Effect.mapError(
						(error) =>
							new SessionManagerError({
								operation: "forProject",
								cause: error.reason,
							}),
					),
				),
			);
			// One start per generation, keyed by the generation's scope; a started
			// generation is open until `close` or its owner scope closes.
			const starts = new WeakMap<
				Scope.Scope,
				{
					readonly done: Deferred.Deferred<void, ProjectServicesError>;
					readonly scope: Scope.Closeable;
				}
			>();
			const started = new WeakSet<Scope.Scope>();
			const startContext = Context.mergeAll(ingestionShared, turnShared).pipe(
				Context.add(SessionManagerServiceTag, sessionManagers),
				Context.add(
					ProviderRegistryTag,
					Context.get(ingestionShared, ProviderAdapters).registry,
				),
			);
			const open: ProjectServices["Service"]["open"] = (projectId) =>
				Effect.gen(function* () {
					const project = yield* registered(projectId);
					const parts = generations.get(projectId);
					const current =
						parts && starts.get(Context.get(parts, RpcSubscriptionScopeTag));
					// An open project keeps serving when its folder goes missing; a
					// send reports the missing folder itself.
					if (current) {
						yield* Deferred.await(current.done);
						return yield* forProject(projectId);
					}
					const folder = project.folders[0];
					if (!existsSync(folder))
						return yield* refuse(
							projectId,
							`Project directory does not exist: ${folder}`,
						);
					// Storage ownership is kept apart from the event store's.
					yield* Effect.try({
						try: () => {
							mkdirSync(projectStorageDir(options.configDir, projectId), {
								recursive: true,
							});
							writeProjectStorageOwner(options.configDir, projectId, folder);
						},
						catch: (cause) =>
							refuse(
								projectId,
								`Failed to prepare project storage: ${formatErrorDetail(cause)}`,
							),
					});
					const context = yield* forProject(projectId);
					const scope = Context.get(context, RpcSubscriptionScopeTag);
					const existing = starts.get(scope);
					if (existing) {
						yield* Deferred.await(existing.done);
						return context;
					}
					const start = Deferred.makeUnsafe<void, ProjectServicesError>();
					// Its own scope under the generation's: a failed start or `close`
					// ends only what it wired, and removal closes both.
					const startScope = yield* Scope.fork(scope);
					starts.set(scope, { done: start, scope: startScope });
					const pushManager = Option.getOrUndefined(
						yield* push.getLegacyManager,
					);
					yield* Effect.forkIn(
						startProject({ scope: startScope, pushManager }).pipe(
							Effect.provideContext(Context.merge(context, startContext)),
							Effect.andThen(
								Effect.sync(() => {
									started.add(scope);
									// Child-process tests wait for the project to run their fake SDK.
									if (testSdk && !options.claudeSdk && process.connected)
										process.send?.({
											channel: "conduit-process-test",
											kind: "fake-sdk-active",
											module: process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"],
											projectDir: folder,
										});
								}),
							),
							// Startup may read defaults before a global write lands; once
							// opened, broadcasts reach it, so read them again.
							Effect.andThen(
								refreshGlobalDefaults.pipe(Effect.provideContext(context)),
							),
							Effect.andThen(Deferred.succeed(start, undefined)),
							Effect.onExit((exit) =>
								Exit.isSuccess(exit)
									? Effect.void
									: Effect.gen(function* () {
											// An interrupted start means the generation is closing.
											const interrupted = Failure.isInterruptedOnly(exit.cause);
											if (!interrupted) yield* Scope.close(startScope, exit);
											starts.delete(scope);
											yield* Deferred.fail(
												start,
												refuse(
													projectId,
													interrupted
														? `Project "${projectId}" start was interrupted`
														: `Project "${projectId}" failed to start: ${Failure.renderCause(exit.cause)}`,
												),
											);
										}),
							),
						),
						scope,
					);
					yield* Deferred.await(start);
					return context;
				});
			const opened: ProjectServices["Service"]["opened"] = (projectId) => {
				const parts = generations.get(projectId);
				return parts && started.has(Context.get(parts, RpcSubscriptionScopeTag))
					? forProject(projectId).pipe(Effect.option)
					: Effect.succeed(Option.none());
			};
			const close: ProjectServices["Service"]["close"] = (projectId) =>
				Effect.gen(function* () {
					const parts = generations.get(projectId);
					if (!parts) return;
					const scope = Context.get(parts, RpcSubscriptionScopeTag);
					const current = starts.get(scope);
					if (!current) return;
					// A start in flight finishes (or fails) before it is closed.
					yield* Effect.exit(Deferred.await(current.done));
					if (starts.get(scope) !== current) return;
					starts.delete(scope);
					started.delete(scope);
					yield* Scope.close(current.scope, Exit.void);
				});
			// A project holding OpenCode events with no tab open starts in its
			// generation, as t3code starts its reactors in the server scope
			// (apps/server/src/server.ts:540-627).
			yield* Stream.fromQueue(
				Context.get(turnShared, OpenCodeProjectStreams).wakes,
			).pipe(
				Stream.runForEach((slug) =>
					open(slug).pipe(
						Effect.catchCause((cause) =>
							Effect.logError(`Failed to start project "${slug}"`, cause),
						),
					),
				),
				Effect.forkScoped,
			);
			return Context.make(ProjectServices, {
				generation,
				forProject,
				open,
				opened,
				close,
			}).pipe(Context.add(SessionManagerServiceTag, sessionManagers));
		}),
	);
