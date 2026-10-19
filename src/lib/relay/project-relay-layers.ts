import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	Context,
	Effect,
	Filter,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
	Result,
	Semaphore,
	Stream,
	Tracer,
} from "effect";
import { SqlClient } from "effect/sql";
import { accountsStateFromConfig } from "../account-directory.js";
import {
	MANAGED_OPENCODE_ACCOUNT_ID,
	PROVIDER_DRIVERS,
} from "../contracts/provider-instance.js";
import {
	type DaemonConfigLoadError,
	DaemonConfigUnreadable,
	DEFAULT_AUTO_ARCHIVE_AFTER_DAYS,
	DEFAULT_AUTO_DELETE_ARCHIVED_AFTER_DAYS,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	defaultDaemonConfig,
	getConfigDir,
	loadDaemonConfigResult,
} from "../daemon/config-persistence.js";
import { AccountPictureLive } from "../domain/daemon/Layers/account-picture-layer.js";
import { CategorySetLive } from "../domain/daemon/Layers/category-set-layer.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotTag,
	makeConfigWriterLive,
} from "../domain/daemon/Layers/config-persistence-layer.js";
import { makeStandaloneOpenCodeInstancesLive } from "../domain/daemon/Layers/opencode-instances-layer.js";
import { makeConfiguredCursorUsage } from "../domain/daemon/Layers/usage-layer.js";
import { UserAvatarLive } from "../domain/daemon/Layers/user-avatar-layer.js";
import { makeWorktreeLive } from "../domain/daemon/Layers/worktree-layer.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
} from "../domain/daemon/Services/account-directory.js";
import { CategorySet } from "../domain/daemon/Services/category-set.js";
import { ConfigPersistenceTag } from "../domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../domain/daemon/Services/daemon-config-ref.js";
import {
	MessageSurfacingSettings,
	makeMessageSurfacingSettings,
} from "../domain/daemon/Services/message-surfacing-settings.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../domain/daemon/Services/opencode-instances-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../domain/daemon/Services/session-activity.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../domain/daemon/Services/session-directory.js";
import { makeUsage, Usage } from "../domain/daemon/Services/usage.js";
import type { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	makeProjectRelayConfigLive,
	OpenCodeAPILive,
	ProjectRelayLoggerLive,
} from "../domain/relay/Layers/relay-core-layers.js";
import { makeRelayStateLive } from "../domain/relay/Layers/relay-layer.js";
import { SessionGitLive } from "../domain/relay/Layers/session-git-layer.js";
import { makeSessionStateProjectionNotifierLive } from "../domain/relay/Layers/session-state-projection-notifier-layer.js";
import { SessionWorkspaceLive } from "../domain/relay/Layers/session-workspace-layer.js";
import { StatusPollerLive } from "../domain/relay/Layers/status-poller-layer.js";
import { WebSocketHandlerLive } from "../domain/relay/Layers/websocket-handler-layer.js";
import { makeWsTransportLive } from "../domain/relay/Layers/ws-transport-layer.js";
import { AgentServiceLive } from "../domain/relay/Services/agent-service.js";
import {
	AlertLedgerLive,
	AlertLedgerTag,
} from "../domain/relay/Services/alert-ledger.js";
import { AlertsLive, AlertsTag } from "../domain/relay/Services/alerts.js";
import {
	DaemonSessionQueryServiceLive,
	DaemonSessionQueryServiceTag,
} from "../domain/relay/Services/daemon-session-query-service.js";
import { DirectoryListingServiceLive } from "../domain/relay/Services/directory-listing-service.js";
import { DraftPreWarmLive } from "../domain/relay/Services/draft-prewarm.js";
import {
	InstanceManagementServiceLive,
	InstanceManagementServiceTag,
} from "../domain/relay/Services/instance-management-service.js";
import {
	type EffectOpenCodeRuntimeIngressPort,
	OpenCodeHistoryReconcileTag,
	OpenCodeSessionCreationGateTag,
} from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import { PendingInteractionServiceLive } from "../domain/relay/Services/pending-interaction-service.js";
import {
	ProjectManagementServiceLive,
	ProjectManagementServiceTag,
} from "../domain/relay/Services/project-management-service.js";
import { makeProviderRuntimeIngestionLive } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../domain/relay/Services/provider-turn-service.js";
import { makeRecapServiceLive } from "../domain/relay/Services/recap-service.js";
import {
	ScanServiceLive,
	ScanServiceTag,
} from "../domain/relay/Services/scan-service.js";
import {
	AgentLivenessTag,
	BackgroundLivenessTag,
	type ConfigTag,
	LiveTaskListTag,
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeSettingsServiceLive,
	type OpenCodeSettingsServiceTag,
	type OrchestrationEngineTag,
	openCodeInstanceTarget,
	SessionCompactionsTag,
	SessionRetriesTag,
} from "../domain/relay/Services/services.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../domain/relay/Services/session-event-bus.js";
import { SessionInboxLive } from "../domain/relay/Services/session-inbox.js";
import type { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { OverridesStateTag } from "../domain/relay/Services/session-overrides-state.js";
import {
	SessionSetupLive,
	type SessionSetupTag,
} from "../domain/relay/Services/session-setup.js";
import type { PollerStateTag } from "../domain/relay/Services/session-status-poller.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import { SessionWorkspaceHintReactorLive } from "../domain/relay/Services/session-workspace-hint.js";
import { SessionWorkspaceHintStateTag } from "../domain/relay/Services/session-workspace-hint-state.js";
import { SSEStreamLive } from "../domain/relay/Services/sse-stream-service.js";
import {
	LocalPtyServiceLive,
	OpenCodeTerminalServiceLive,
} from "../domain/relay/Services/terminal-service.js";
import { ToolContentServiceLive } from "../domain/relay/Services/tool-content-service.js";
import { realWorkspacePath } from "../git/worktrees.js";
import type { CommitAndSignalProject } from "../persistence/effect/commit-and-signal.js";
import type { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { EventStoreError } from "../persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	makePersistenceProjectLayer,
	type PersistenceEffectError,
	PersistenceStore,
} from "../persistence/effect/live.js";
import type { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import type { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { ClaudeProviderInstance } from "../provider/claude/claude-provider-instance.js";
import { captureClaudeLaunchLogin } from "../provider/claude/claude-sdk-env.js";
import { defaultClaudeSessionForkSdk } from "../provider/claude/claude-session-fork.js";
import { makeClaudeUsageReader } from "../provider/claude/claude-usage-probe.js";
import {
	makeOrchestrationRuntimeLayer,
	type OrchestrationRuntimeLayerOptions,
} from "../provider/orchestration-wiring.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";
import { SqliteProviderSessionBindingReadModel } from "../provider/provider-session-binding-read-model.js";
import { usageAccounts } from "../provider/usage-reader.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import { RpcSubscriptionScopeLive } from "../server/ws-rpc.js";
import type { ProjectRelayConfig } from "../types.js";
import { createTranslator } from "./event-translator.js";
import { createMonitoringWiringState } from "./monitoring-wiring.js";
import { publishProviderRelayMessage } from "./project-relay-publisher.js";
import { makeSessionLifecycleWiringLive } from "./session-lifecycle-wiring.js";
import { PermissionTimeoutLive } from "./timer-wiring.js";

/**
 * Relay view of OpenCode Instances. Sessions bound to the default id run on
 * this relay's selected instance, so the default id maps to it both ways, and
 * clients default to the relay's directory scope.
 */
const relayOpenCodeInstances = (
	instances: OpenCodeInstances,
	config: ProjectRelayConfig,
	persistedInstanceIds: readonly string[],
): OpenCodeInstances => {
	const defaultId = MANAGED_OPENCODE_ACCOUNT_ID;
	const selectedId = config.openCodeInstanceId ?? defaultId;
	const target = openCodeInstanceTarget(selectedId);
	const scope = config.noServer ? config.projectDir : undefined;
	// Restored sessions receive events before the relay first uses their instance.
	const used = new Set(persistedInstanceIds.map(target));
	const use: OpenCodeInstances["use"] = (instanceId, directory = scope) =>
		instances.use(target(instanceId), directory).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					used.add(target(instanceId));
				}),
			),
		);
	return {
		events: (directories, instanceId = defaultId) =>
			instances
				.events(directories, target(instanceId))
				.pipe(
					Stream.filterMap(
						Filter.fromPredicateOption((message) =>
							message.instanceId === selectedId
								? Option.some({ ...message, instanceId: defaultId })
								: used.has(message.instanceId)
									? Option.some(message)
									: Option.none(),
						),
					),
				),
		use,
		borrow: (instanceId, directory = scope) =>
			instances.borrow(target(instanceId), directory).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						used.add(target(instanceId));
					}),
				),
			),
		useIfRunning: (instanceId, directory = scope) =>
			instances.useIfRunning(target(instanceId), directory),
		ifRunning: (instanceId, directory = scope) =>
			instances.ifRunning(target(instanceId), directory),
		isManagedStopped: (instanceId) =>
			instances.isManagedStopped(target(instanceId)),
		stop: (instanceId) => instances.stop(target(instanceId)),
	};
};

/** Services promised to callers of ProjectRelay.effectRuntime. */
export type RelayRuntimeServices =
	| SessionDirectory
	| AccountDirectory
	| SessionActivityTag
	| ConfigTag
	| LoggerTag
	| OpenCodeAPITag
	| OpenCodeSettingsServiceTag
	| OrchestrationEngineTag
	| SessionWorkspaceTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| SessionSetupTag
	| OverridesStateTag
	| DaemonConfigRefTag
	| ConfigPersistenceTag
	| Layer.Success<typeof PendingInteractionServiceLive>
	| PollerStateTag
	| ReadQueryEffectTag
	| OpenCodeInstancesTag
	| SessionManagerServiceTag
	| ScanServiceTag
	| DaemonSessionQueryServiceTag
	| ProjectManagementServiceTag
	| InstanceManagementServiceTag
	| SqlClient.SqlClient
	| TranslatorTag;

export class TranslatorTag extends Context.Service<
	TranslatorTag,
	ReturnType<typeof createTranslator>
>()("RelayTranslator") {}

export interface RelayRuntime {
	runtime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeServices,
		PersistenceEffectError | DaemonConfigLoadError
	>;
	dispose: () => Promise<void>;
}

export interface ProjectRelayLayerInputs {
	config: ProjectRelayConfig;
	claudeRunnerFactory?: OrchestrationRuntimeLayerOptions["claudeRunnerFactory"];
	testSendLimit?: number;
	onBackgroundWorkChanged: (sessionId: string) => void;
	/** Undefined until startup finishes; runner adoption publishes before then. */
	getWsHandler: () => WebSocketHandlerShape | undefined;
}

/** Build the shared per-project Layer graph and its managed runtime. */
export function createProjectRelayLayers({
	config,
	claudeRunnerFactory,
	testSendLimit,
	onBackgroundWorkChanged,
	getWsHandler,
}: ProjectRelayLayerInputs) {
	const claudeSdk = config.claudeSdk ?? {
		query: sdkQuery,
		titleQuery: sdkQuery,
		fork: defaultClaudeSessionForkSdk,
	};

	// Effect ManagedRuntime (Layer-based composition)
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Imperative edge objects are provided as ports and merged into one Layer tree.

	const configLayer = makeProjectRelayConfigLive({ ...config, claudeSdk });
	const daemonSettingsLayer: Layer.Layer<
		DaemonConfigRefTag | ConfigPersistenceTag | AccountDirectory,
		DaemonConfigLoadError
	> = Layer.unwrap(
		Effect.gen(function* () {
			const shared = config.daemonConfigContext ?? Context.empty();
			const configRef = Context.getOption(shared, DaemonConfigRefTag);
			const persistence = Context.getOption(shared, ConfigPersistenceTag);
			const accountsService = Context.getOption(shared, AccountDirectory);
			if (
				Option.isSome(configRef) &&
				Option.isSome(persistence) &&
				Option.isSome(accountsService)
			) {
				return Layer.succeedContext(
					Context.make(DaemonConfigRefTag, configRef.value).pipe(
						Context.add(ConfigPersistenceTag, persistence.value),
						Context.add(AccountDirectory, accountsService.value),
						Context.merge(shared),
					),
				);
			}
			const configDir = config.configDir ?? getConfigDir();
			const loaded = loadDaemonConfigResult(configDir);
			if (Result.isFailure(loaded) && loaded.failure._tag !== "NotFound")
				return yield* loaded.failure;
			const saved = Result.getOrElse(loaded, defaultDaemonConfig);
			const accounts = accountsStateFromConfig(
				saved,
				captureClaudeLaunchLogin(process.env),
			);
			const { pinHash, tls, ...initial } = saved;
			const configRefLayer = DaemonConfigRefLive(
				makeDaemonConfigFromOptions({
					...initial,
					tlsEnabled: tls,
					...(pinHash !== null && { pinHash }),
				}),
			);
			// Standalone relays have no daemon project/instance registry.
			// Preserve those disk fields while snapshotting their live settings.
			const snapshot = Layer.effect(
				ConfigSnapshotTag,
				Effect.gen(function* () {
					const configRef = yield* DaemonConfigRefTag;
					return {
						build: Effect.gen(function* () {
							const current = yield* Ref.get(configRef);
							const persisted = yield* Effect.suspend(() =>
								Effect.fromResult(loadDaemonConfigResult(configDir)),
							).pipe(
								Effect.catchTag("NotFound", () =>
									Effect.succeed(defaultDaemonConfig()),
								),
							);
							const { cursorUsageBinding: _binding, ...unchanged } = persisted;
							return {
								...unchanged,
								...(current.avatar !== undefined && { avatar: current.avatar }),
								autoSettleAfterDays:
									current.autoSettleAfterDays === undefined
										? DEFAULT_AUTO_SETTLE_AFTER_DAYS
										: current.autoSettleAfterDays,
								autoArchiveAfterDays:
									current.autoArchiveAfterDays === undefined
										? DEFAULT_AUTO_ARCHIVE_AFTER_DAYS
										: current.autoArchiveAfterDays,
								autoDeleteArchivedAfterDays:
									current.autoDeleteArchivedAfterDays === undefined
										? DEFAULT_AUTO_DELETE_ARCHIVED_AFTER_DAYS
										: current.autoDeleteArchivedAfterDays,
								...(current.worktreeCleanup !== undefined && {
									worktreeCleanup: current.worktreeCleanup,
								}),
								...(current.usageLimits !== undefined && {
									usageLimits: current.usageLimits,
								}),
								...(current.cursorUsageBinding
									? { cursorUsageBinding: current.cursorUsageBinding }
									: {}),
							};
						}),
					};
				}),
			).pipe(Layer.provideMerge(configRefLayer));
			return ConfigPersistenceLive.pipe(
				Layer.provideMerge(snapshot),
				Layer.provide(makeConfigWriterLive(configDir)),
				Layer.provideMerge(AccountDirectoryStateLive(accounts)),
			);
		}),
	).pipe(
		Layer.merge(
			Layer.succeedContext(config.daemonConfigContext ?? Context.empty()),
		),
	);
	const daemonConfigLayer = UserAvatarLive.pipe(
		Layer.provide(AccountPictureLive),
		Layer.provideMerge(daemonSettingsLayer),
	);
	const activityLayer = Layer.effect(
		SessionActivityTag,
		Effect.gen(function* () {
			const shared = yield* Effect.serviceOption(SessionActivityTag);
			return Option.isSome(shared) ? shared.value : yield* makeSessionActivity;
		}),
	).pipe(Layer.provide(daemonConfigLayer));
	const activityReaders = Layer.mergeAll(
		Layer.effect(
			BackgroundLivenessTag,
			Effect.map(
				SessionActivityTag,
				(activity) => activity.background.backgroundOf,
			),
		),
		Layer.effect(
			LiveTaskListTag,
			Effect.map(
				SessionActivityTag,
				(activity) => activity.background.liveListOf,
			),
		),
		Layer.effect(
			SessionCompactionsTag,
			Effect.map(
				SessionActivityTag,
				(activity) => activity.compactions.compactingOf,
			),
		),
		Layer.effect(
			SessionRetriesTag,
			Effect.map(SessionActivityTag, (activity) => activity.retries.retryingOf),
		),
		Layer.effect(
			SessionWorkspaceHintStateTag,
			Effect.map(SessionActivityTag, (activity) => activity.hintDismissals),
		),
	).pipe(Layer.provideMerge(activityLayer));
	// Orchestration runtime layer (provider instance routing)
	const orchestrationRuntimeLayer = Layer.unwrap(
		Effect.map(SessionActivityTag, (activity) =>
			makeOrchestrationRuntimeLayer({
				...(config.shellEnv && { shellEnv: config.shellEnv }),
				...(config.prepareShellEnv && {
					prepareShellEnv: config.prepareShellEnv,
				}),
				onBackgroundTask: (transition) => {
					if (activity.background.record(transition))
						onBackgroundWorkChanged(transition.sessionId);
				},
				claudeQueryFactory: claudeSdk.query,
				claudeSessionForkSdk: claudeSdk.fork,
				...(config.claudeSdk?.subagentSdk && {
					claudeSubagentSdk: config.claudeSdk.subagentSdk,
				}),
				...(claudeRunnerFactory && { claudeRunnerFactory }),
				...(config.projectDir != null && { workspaceRoot: config.projectDir }),
				extraFolders: config.extraFolders ?? [],
				...(config.configDir != null ? { configDir: config.configDir } : {}),
			}),
		),
	).pipe(Layer.provide(activityLayer));

	const sharedUsage = config.usage;
	const usageLayer = sharedUsage
		? Layer.sync(Usage, () => sharedUsage)
		: Layer.effect(
				Usage,
				Effect.gen(function* () {
					const directory = yield* AccountDirectory;
					const configRef = yield* DaemonConfigRefTag;
					const accountList = directory.list.pipe(
						Effect.provideService(DaemonConfigRefTag, configRef),
					);
					const cursor = yield* makeConfiguredCursorUsage;
					const usage = yield* makeUsage({
						accounts: Effect.map(accountList, usageAccounts),
						accountHarness: (id) =>
							Effect.map(accountList, (accounts) => {
								const account = accounts.find((account) => account.id === id);
								return account
									? PROVIDER_DRIVERS[account.driver].usageHarness
									: undefined;
							}),
						readers: {
							cursor: cursor.reader,
							claude: makeClaudeUsageReader({
								queryFactory: claudeSdk.query,
								cwd: config.projectDir,
								...(config.shellEnv
									? { shellEnv: config.shellEnv(config.projectDir) }
									: {}),
							}),
						},
					});
					return { ...usage, setCursorKeychain: cursor.setKeychain };
				}),
			).pipe(Layer.provide(daemonConfigLayer));
	const loggerLayer = ProjectRelayLoggerLive.pipe(Layer.provide(configLayer));
	// One shared layer reference (Effect memoizes it), so orchestration wiring,
	// the session manager, startup and the SSE adapter see one relay view.
	const sharedInstances = config.openCodeInstances;
	const sharedDirectory = config.daemonConfigContext
		? Context.getOption(config.daemonConfigContext, SessionDirectory)
		: Option.none();
	const sharedStore = config.daemonConfigContext
		? Context.getOption(config.daemonConfigContext, PersistenceStore)
		: Option.none();
	const sharedBus = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		SessionEventBusTag,
	);
	// Returning the daemon instance adds no ownership to the relay scope.
	// Keep one layer reference so every writer and subscriber uses the same bus.
	const sessionEventBusLayer = Option.isSome(sharedBus)
		? Layer.sync(SessionEventBusTag, () => sharedBus.value)
		: SessionEventBusLive;
	const persistenceEffectLayer = (
		Option.isSome(sharedStore)
			? makePersistenceProjectLayer(config.slug, {
					sessionEventBusLayer,
				}).pipe(Layer.provideMerge(Layer.succeedContext(sharedStore.value)))
			: makePersistenceEffectLayer(
					config.persistenceDbPath,
					config.slug,
					undefined,
					sessionEventBusLayer,
				)
	).pipe(Layer.provideMerge(activityReaders));
	// Standalone WebSocket routing resolves only sessions owned by this relay.
	const sessionDirectoryLayer = Option.isSome(sharedDirectory)
		? Layer.succeedContext(
				Context.make(SessionDirectory, sharedDirectory.value),
			)
		: Layer.effect(
				SessionDirectory,
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						projectOf: (sessionId: string) =>
							sql<{ readonly project_id: string | null }>`
								SELECT project_id FROM sessions WHERE id = ${sessionId}`.pipe(
								Effect.map((rows) =>
									rows[0]?.project_id === config.slug
										? Option.some(config.slug)
										: Option.none(),
								),
								Effect.mapError(
									(cause) =>
										new SessionDirectoryReadError({ sessionId, cause }),
								),
							),
					};
				}),
			).pipe(Layer.provide(persistenceEffectLayer));
	const openCodeInstancesLayer = Layer.effect(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const instances = yield* OpenCodeInstancesTag;
			const sql = yield* SqlClient.SqlClient;
			const bindings = yield* new SqliteProviderSessionBindingReadModel(
				sql,
			).listBoundSessions({ projectIds: [config.slug] });
			return relayOpenCodeInstances(
				instances,
				config,
				bindings.map(({ providerId }) => providerId),
			);
		}),
	).pipe(
		Layer.provide(
			Layer.merge(
				sharedInstances
					? Layer.sync(OpenCodeInstancesTag, () => sharedInstances)
					: makeStandaloneOpenCodeInstancesLive(config),
				persistenceEffectLayer,
			),
		),
	);
	// The relay's default client resolves its endpoint through that view.
	const openCodeApiLayer = OpenCodeAPILive.pipe(
		Layer.provide(Layer.merge(configLayer, openCodeInstancesLayer)),
	);
	const alertLedgerLayer = AlertLedgerLive.pipe(
		Layer.provide(persistenceEffectLayer),
	);
	const sessionWorkspaceLayer = SessionWorkspaceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				daemonConfigLayer,
				persistenceEffectLayer,
				configLayer,
				loggerLayer,
				openCodeApiLayer,
				sessionEventBusLayer,
			),
		),
	);
	const providerRuntimeIngestionLayer = Layer.unwrap(
		Effect.gen(function* () {
			const ledger = yield* AlertLedgerTag;
			const alerts = yield* AlertsTag;
			const sql = yield* SqlClient.SqlClient;
			const log = yield* LoggerTag;
			const workspace = yield* SessionWorkspaceTag;
			return makeProviderRuntimeIngestionLive({
				usage: yield* Usage,
				workspaceChanged: (event) =>
					Effect.gen(function* () {
						const { path, source } = event.data;
						if (source === "start") {
							const recorded = yield* workspace.get(event.sessionId);
							const current = yield* realWorkspacePath(recorded).pipe(
								Effect.orElseSucceed(() => recorded),
							);
							// The common case needs no history query, git discovery or cache refresh.
							if (current === path) return;
							if (
								(yield* workspace.claudeWorktreeState(event.sessionId))
									.pendingUserMove
							)
								return;
						}
						const target = yield* workspace.resolve(
							event.sessionId,
							path,
							"agent",
						);
						return (project: CommitAndSignalProject) =>
							Effect.gen(function* () {
								// A user can move while resolution is in flight. Recheck intent under
								// the commit permit before recording the declaration.
								const state = yield* workspace.claudeWorktreeState(
									event.sessionId,
								);
								if (
									state.pendingUserMove &&
									target.path !== state.requestedPath
								)
									return;
								yield* workspace.record(event.sessionId, target, "agent", {
									project,
								});
							}).pipe(
								Effect.catchTag("WorkspaceMoveError", (error) =>
									Effect.sync(() => {
										log.warn("Invalid agent workspace move", {
											sessionId: event.sessionId,
											path,
											reason: error.reason,
										});
									}),
								),
								Effect.mapError(
									(cause) =>
										new EventStoreError({
											operation: "workspace.changed",
											cause,
										}),
								),
							);
					}).pipe(
						Effect.catchTag("WorkspaceMoveError", (error) =>
							Effect.sync(() => {
								log.warn("Invalid agent workspace move", {
									sessionId: event.sessionId,
									path: event.data.path,
									reason: error.reason,
								});
								return undefined;
							}),
						),
						Effect.mapError(
							(cause) =>
								new EventStoreError({ operation: "workspace.changed", cause }),
						),
					),
				relayPublisher: {
					publish: (msg) =>
						publishProviderRelayMessage(msg, {
							wsHandler: getWsHandler() ?? { getClientsForSession: () => [] },
							log,
							slug: config.slug,
							...(config.pushManager
								? { pushManager: config.pushManager }
								: {}),
						}).pipe(
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.provideService(AlertLedgerTag, ledger),
							Effect.provideService(AlertsTag, alerts),
						),
				},
				compactions: (yield* SessionActivityTag).compactions,
				retries: (yield* SessionActivityTag).retries,
			});
		}),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				persistenceEffectLayer,
				sessionWorkspaceLayer,
				sessionEventBusLayer,
				alertLedgerLayer,
				// The same reference makeRelayStateLive merges, so it memoizes to the
				// one PubSub SubscribeAlerts reads.
				AlertsLive,
				loggerLayer,
				usageLayer,
			),
		),
	);
	// The orchestration engine's side-effect reactor consumes the SAME
	// ProviderRuntimeIngestion instance the relay uses (Effect memoizes the shared
	// layer reference), so committed provider side effects stream through one
	// ingestion pipeline — no duplicate event append. Likewise the shared
	// persistenceEffectLayer reference gives orchestration (session bindings,
	// durable command receipts) the relay's one SqlClient connection.
	const instanceManagementLayer = Option.match(
		Context.getOption(
			config.daemonConfigContext ?? Context.empty(),
			InstanceManagementServiceTag,
		),
		{
			onNone: () => InstanceManagementServiceLive,
			onSome: (service) =>
				Layer.sync(InstanceManagementServiceTag, () => service),
		},
	);
	const pendingInteractionServiceLayer = PendingInteractionServiceLive;
	const providerOrchestrationDeps = Layer.mergeAll(
		daemonConfigLayer,
		sessionWorkspaceLayer,
		openCodeApiLayer,
		persistenceEffectLayer,
		// The engine commits input.sent through commit-and-signal, which
		// announces on the same bus as the relay's subscribers.
		sessionEventBusLayer,
		pendingInteractionServiceLayer,
		providerRuntimeIngestionLayer,
		openCodeInstancesLayer,
		instanceManagementLayer,
	);
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		Layer.provide(providerOrchestrationDeps),
	);
	const agentLivenessLayer = Layer.effect(
		AgentLivenessTag,
		Effect.gen(function* () {
			const registry = yield* ProviderRegistryTag;
			return (sessionId: string) =>
				Effect.suspend(() => {
					const instance = registry.getInstance("claude");
					return instance instanceof ClaudeProviderInstance
						? instance.hasLiveProcessEffect(sessionId)
						: Effect.succeed(false);
				});
		}),
	).pipe(Layer.provide(providerOrchestrationLayer));
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(Layer.merge(openCodeApiLayer, openCodeInstancesLayer)),
	);
	const openCodeModelServiceLayer = OpenCodeModelServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeApiLayer,
				openCodeInstancesLayer,
				configLayer,
				loggerLayer,
			),
		),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(Layer.merge(openCodeApiLayer, openCodeInstancesLayer)),
	);
	const sseStreamLayer = SSEStreamLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeInstancesLayer,
				configLayer,
				persistenceEffectLayer,
				sessionEventBusLayer,
				pendingInteractionServiceLayer,
			),
		),
	);
	const projectManagementServiceLayer = Option.match(
		Context.getOption(
			config.daemonConfigContext ?? Context.empty(),
			ProjectManagementServiceTag,
		),
		{
			onNone: () =>
				ProjectManagementServiceLive.pipe(Layer.provide(configLayer)),
			onSome: (service) =>
				Layer.sync(ProjectManagementServiceTag, () => service),
		},
	);
	const daemonSessionQueryServiceLayer = Option.match(
		Context.getOption(
			config.daemonConfigContext ?? Context.empty(),
			DaemonSessionQueryServiceTag,
		),
		{
			onNone: () => DaemonSessionQueryServiceLive,
			onSome: (service) =>
				Layer.sync(DaemonSessionQueryServiceTag, () => service),
		},
	);
	const scanServiceLayer = Option.match(
		Context.getOption(
			config.daemonConfigContext ?? Context.empty(),
			ScanServiceTag,
		),
		{
			onNone: () => ScanServiceLive,
			onSome: (service) => Layer.sync(ScanServiceTag, () => service),
		},
	);
	const webSocketHandlerLayer = WebSocketHandlerLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				configLayer,
				loggerLayer,
				sessionEventBusLayer,
				persistenceEffectLayer,
			),
		),
	);
	// Polling must not restart an idle-stopped OpenCode.
	const messagePollerManagerLayer = makeMessagePollerManagerLive({
		hasViewers: (sid) =>
			(getWsHandler()?.getClientsForSession(sid).length ?? 0) > 0,
	}).pipe(
		Layer.provide(
			Layer.mergeAll(
				sessionWorkspaceLayer,
				openCodeInstancesLayer,
				persistenceEffectLayer,
				configLayer,
				loggerLayer,
			),
		),
	);
	const ptyRuntimeLayer = makePtyRuntimeLive().pipe(
		Layer.provide(
			Layer.mergeAll(openCodeInstancesLayer, configLayer, loggerLayer),
		),
	);
	const localPtyServiceLayer = LocalPtyServiceLive.pipe(
		Layer.provide(Layer.merge(configLayer, loggerLayer)),
	);
	const openCodeTerminalServiceLayer = OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeInstancesLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
				ptyRuntimeLayer,
				localPtyServiceLayer,
			),
		),
	);
	const toolContentServiceLayer = ToolContentServiceLive.pipe(
		Layer.provideMerge(persistenceEffectLayer),
	);
	let historyIngress: EffectOpenCodeRuntimeIngressPort | undefined;
	const historyReconcileLayer = Layer.sync(OpenCodeHistoryReconcileTag, () => ({
		reconcileSession: (sessionId: string) =>
			historyIngress?.reconcileSession(sessionId) ?? Effect.void,
	}));

	const coreBridgeLayers = Layer.mergeAll(
		sessionWorkspaceLayer,
		sessionDirectoryLayer,
		sessionWorkspaceLayer,
		daemonConfigLayer,
		config.worktreeContext
			? Layer.succeedContext(config.worktreeContext)
			: makeWorktreeLive(config.configDir ?? getConfigDir()),
		usageLayer,
		historyReconcileLayer,
		Layer.effect(OpenCodeSessionCreationGateTag, Semaphore.make(1)),
		openCodeApiLayer,
		openCodeFileServiceLayer,
		openCodeModelServiceLayer,
		openCodeSettingsServiceLayer,
		sseStreamLayer,
		projectManagementServiceLayer,
		daemonSessionQueryServiceLayer,
		DirectoryListingServiceLive.pipe(Layer.provide(configLayer)),
		scanServiceLayer,
		openCodeTerminalServiceLayer,
		localPtyServiceLayer,
		pendingInteractionServiceLayer,
		toolContentServiceLayer,
		webSocketHandlerLayer,
		messagePollerManagerLayer,
		activityReaders,
		agentLivenessLayer,
		ptyRuntimeLayer,
		configLayer,
		loggerLayer,
		providerOrchestrationLayer,
		openCodeInstancesLayer,
		persistenceEffectLayer,
		alertLedgerLayer,
		providerRuntimeIngestionLayer,
	);

	// Optional bridge layers (only included when deps are present)
	const bridgeLayers = Layer.merge(coreBridgeLayers, instanceManagementLayer);
	// Compose: self-constructing state layers + imperative bridge layers.
	// baseLayers are defined here; wiringLayers (PermissionTimeoutLive,
	// SessionLifecycleWiringLive) are added after monitoring state exists
	// (provides sseTracker, getMonitoringState).
	const relayStateAndBridges = Layer.provideMerge(
		makeRelayStateLive({
			sessionEventBusLayer,
			titleQueryFactory: config.titleQuery ?? claudeSdk.titleQuery,
			...(testSendLimit !== undefined && { testSendLimit }),
		}),
		bridgeLayers,
	);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		StatusPollerLive,
		Layer.provideMerge(SessionGitLive, relayStateAndBridges),
	);
	const recapSettingsLayer = Layer.suspend(() => {
		const shared = config.daemonConfigContext ?? Context.empty();
		const settings = Context.getOption(shared, MessageSurfacingSettings);
		const categories = Context.getOption(shared, CategorySet);
		const configDir = config.configDir ?? getConfigDir();
		return Layer.merge(
			Option.isSome(settings)
				? Layer.succeedContext(
						Context.make(MessageSurfacingSettings, settings.value),
					)
				: Layer.effect(
						MessageSurfacingSettings,
						makeMessageSurfacingSettings(configDir),
					),
			Option.isSome(categories)
				? Layer.succeedContext(Context.make(CategorySet, categories.value))
				: CategorySetLive(configDir),
		);
	}).pipe(
		Layer.catch((cause) =>
			Layer.effectContext(
				Effect.fail(
					new DaemonConfigUnreadable({
						path: config.configDir ?? getConfigDir(),
						cause,
					}),
				),
			),
		),
	);
	const relayStateWithRecaps = makeRecapServiceLive({
		queryFactory: config.titleQuery ?? claudeSdk.titleQuery,
	}).pipe(
		Layer.provideMerge(relayStateBridgesAndStatus),
		Layer.provide(recapSettingsLayer),
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateWithRecaps,
	);
	const translatorLayer = Layer.sync(TranslatorTag, () => createTranslator());
	const baseLayers = Layer.provideMerge(
		Layer.merge(translatorLayer, DraftPreWarmLive),
		relayStateServicesAndBridges,
	);
	const baseLayersWithProjectionNotifier = Layer.provideMerge(
		makeSessionStateProjectionNotifierLive(),
		baseLayers,
	);
	const fullBaseLayers = Layer.provideMerge(
		ProviderTurnServiceLive,
		Layer.merge(
			SessionSetupLive.pipe(
				Layer.provideMerge(
					Layer.merge(sessionWorkspaceLayer, baseLayersWithProjectionNotifier),
				),
			),
			makeWsTransportLive({ noServer: true }),
		),
	);

	// Monitoring state is created before the runtime so lifecycle wiring and
	// monitoring wiring share one view, while the poller manager itself remains
	// runtime-owned by MessagePollerManagerLive.
	const monitoringStateAccess = createMonitoringWiringState();
	const sessionLifecycleWiringLayer = Layer.unwrap(
		Effect.map(TranslatorTag, (translator) =>
			makeSessionLifecycleWiringLive({
				translator,
				sseTracker: monitoringStateAccess.sseTracker,
				getMonitoringState: monitoringStateAccess.getMonitoringState,
				setMonitoringState: monitoringStateAccess.setMonitoringState,
			}),
		),
	);
	const wiringLayers = Layer.mergeAll(
		PermissionTimeoutLive,
		sessionLifecycleWiringLayer,
	).pipe(Layer.provide(Layer.merge(baseLayers, sessionWorkspaceLayer)));
	const inboxLayer = SessionInboxLive.pipe(Layer.provide(sessionEventBusLayer));
	// Provide the borrowed daemon tracer to every layer, including fibers forked
	// while building services such as the status poller.
	const fullLayer = Layer.provideMerge(
		Layer.provideMerge(
			RpcSubscriptionScopeLive,
			Layer.provideMerge(
				Layer.mergeAll(
					wiringLayers,
					inboxLayer,
					SessionWorkspaceHintReactorLive,
				),
				fullBaseLayers,
			),
		),
		config.tracer === undefined
			? Layer.empty
			: Layer.succeed(Tracer.Tracer, config.tracer),
	);
	const relayManagedRuntime = ManagedRuntime.make(fullLayer);
	const effectRuntime: RelayRuntime = {
		runtime: relayManagedRuntime,
		dispose: () => relayManagedRuntime.dispose(),
	};
	return {
		relayManagedRuntime,
		effectRuntime,
		monitoringStateAccess,
		setHistoryIngress: (ingress: EffectOpenCodeRuntimeIngressPort) => {
			historyIngress = ingress;
		},
	};
}
