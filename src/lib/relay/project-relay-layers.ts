import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	Context,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
	Result,
	Semaphore,
	Tracer,
} from "effect";
import { SqlClient } from "effect/sql";
import {
	accountsStateFromConfig,
	NO_OPENCODE_HEALTH,
} from "../account-directory.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
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
import { makeAccountResourceScopesLive } from "../domain/daemon/Layers/account-resource-scopes-layer.js";
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
import { DaemonTurnsOrOwn } from "../domain/daemon/Services/daemon-turns.js";
import {
	MessageSurfacingSettings,
	makeMessageSurfacingSettings,
} from "../domain/daemon/Services/message-surfacing-settings.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import {
	makeOpenCodeProjectStreamsLive,
	OpenCodeProjectStreams,
} from "../domain/daemon/Services/opencode-project-streams.js";
import { ProjectContext } from "../domain/daemon/Services/project-context.js";
import {
	type ProjectGenerationParts,
	ProjectServices,
} from "../domain/daemon/Services/project-services.js";
import { ProviderAdapters } from "../domain/daemon/Services/provider-adapters.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../domain/daemon/Services/session-activity.js";
import {
	SessionDirectory,
	SessionDirectoryReadError,
} from "../domain/daemon/Services/session-directory.js";
import { SessionManagerOwner } from "../domain/daemon/Services/session-manager-owner.js";
import { makeUsage, Usage } from "../domain/daemon/Services/usage.js";
import type { EventRetentionTag } from "../domain/persistence/Services/event-retention.js";
import { EventRetentionSchedulerTag } from "../domain/persistence/Services/event-retention-scheduler.js";
import { makeRunLedgerSchedulerLive } from "../domain/persistence/Services/run-ledger-scheduler.js";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import {
	makeProjectIngestionLive,
	makeProjectOpenCodeIngressLive,
} from "../domain/relay/Layers/project-ingestion-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	makeProjectRelayConfigLive,
	ProjectRelayLoggerLive,
} from "../domain/relay/Layers/relay-core-layers.js";
import { makeRelayStateLive } from "../domain/relay/Layers/relay-layer.js";
import { SessionStateProjectionNotifierLive } from "../domain/relay/Layers/session-state-projection-notifier-layer.js";
import { SessionWorkspaceOrOwn } from "../domain/relay/Layers/session-workspace-layer.js";
import { StatusPollerLive } from "../domain/relay/Layers/status-poller-layer.js";
import { WebSocketHandlerLive } from "../domain/relay/Layers/websocket-handler-layer.js";
import { makeWsTransportLive } from "../domain/relay/Layers/ws-transport-layer.js";
import { AgentServiceLive } from "../domain/relay/Services/agent-service.js";
import { AlertLedgerTag } from "../domain/relay/Services/alert-ledger.js";
import { AlertsLive, AlertsTag } from "../domain/relay/Services/alerts.js";
import { ContinuationTag } from "../domain/relay/Services/continuation.js";
import {
	DaemonSessionQueryServiceLive,
	DaemonSessionQueryServiceTag,
} from "../domain/relay/Services/daemon-session-query-service.js";
import { DirectoryListingServiceLive } from "../domain/relay/Services/directory-listing-service.js";
import { DraftPreWarmOrOwn } from "../domain/relay/Services/draft-prewarm.js";
import { makeGoalSummaryServiceLive } from "../domain/relay/Services/goal-summary-service.js";
import { HandoffReceiptsLive } from "../domain/relay/Services/handoff-receipts.js";
import { InputDraftsTag } from "../domain/relay/Services/input-drafts.js";
import {
	InstanceManagementServiceLive,
	InstanceManagementServiceTag,
} from "../domain/relay/Services/instance-management-service.js";
import {
	OpenCodeHistoryReconcileTag,
	OpenCodeProcessLinkTag,
	OpenCodeRuntimeIngressTag,
	OpenCodeSessionCreationGateTag,
} from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	type PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../domain/relay/Services/pending-interaction-service.js";
import {
	ProjectManagementServiceLive,
	ProjectManagementServiceTag,
} from "../domain/relay/Services/project-management-service.js";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
} from "../domain/relay/Services/project-settings.js";
import { ProviderRuntimeIngestionTag } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	attachProviderTurnsLive,
	ProviderTurnsOrOwn,
} from "../domain/relay/Services/provider-turn-service.js";
import { makeRecapServiceLive } from "../domain/relay/Services/recap-service.js";
import {
	RelayStatusSnapshotLive,
	RelayStatusSnapshotTag,
} from "../domain/relay/Services/relay-status-snapshot.js";
import {
	ScanServiceLive,
	ScanServiceTag,
} from "../domain/relay/Services/scan-service.js";
import {
	AgentLivenessTag,
	BackgroundLivenessTag,
	type ConfigTag,
	LiveTaskListTag,
	type LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	OpenCodeModelServiceTag,
	OpenCodeSettingsServiceLive,
	type OpenCodeSettingsServiceTag,
	type OrchestrationEngineTag,
	SessionCompactionsTag,
	SessionRetriesTag,
	TranslatorTag,
} from "../domain/relay/Services/services.js";
import {
	SessionEventBusLive,
	SessionEventBusTag,
} from "../domain/relay/Services/session-event-bus.js";
import { SessionInboxLive } from "../domain/relay/Services/session-inbox.js";
import {
	ownSessionManagersLive,
	SessionManagerServiceTag,
} from "../domain/relay/Services/session-manager-service.js";
import {
	emptySessionManagerState,
	makeSessionManagerCoordination,
	SessionManagerCoordinationTag,
	SessionManagerStateTag,
} from "../domain/relay/Services/session-manager-state.js";
import { OverridesStateTag } from "../domain/relay/Services/session-overrides-state.js";
import {
	SessionSetupOrOwn,
	type SessionSetupTag,
} from "../domain/relay/Services/session-setup.js";
import {
	type PollerStateTag,
	StatusPollerCoreTag,
} from "../domain/relay/Services/session-status-poller.js";
import {
	makeSessionTitleServiceLive,
	SessionTitleServiceTag,
} from "../domain/relay/Services/session-title-service.js";
import type { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import { SessionWorkspaceHintStateTag } from "../domain/relay/Services/session-workspace-hint-state.js";
import { SSEStreamLive } from "../domain/relay/Services/sse-stream-service.js";
import {
	LocalPtyServiceOrOwn,
	OpenCodeTerminalServiceLive,
} from "../domain/relay/Services/terminal-service.js";
import { ToolContentServiceLive } from "../domain/relay/Services/tool-content-service.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import {
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	makePersistenceProjectLayer,
	type PersistenceEffectError,
	type PersistenceProjectContext,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../persistence/effect/live.js";
import type { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import type { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	ClaudeAccountScopes,
	ClaudeAccountScopesLive,
} from "../provider/claude/claude-account-scopes.js";
import { ClaudeProviderInstance } from "../provider/claude/claude-provider-instance.js";
import { captureClaudeLaunchLogin } from "../provider/claude/claude-sdk-env.js";
import { defaultClaudeSessionForkSdk } from "../provider/claude/claude-session-fork.js";
import { makeClaudeUsageReader } from "../provider/claude/claude-usage-probe.js";
import { codexUsageReader } from "../provider/codex/codex-usage.js";
import { makeOrchestrationRuntimeLayer } from "../provider/orchestration-wiring.js";
import { ProviderRegistryTag } from "../provider/provider-registry.js";
import { usageAccounts } from "../provider/usage-reader.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import { RpcSubscriptionScopeLive } from "../server/ws-rpc.js";
import type { ProjectRelayConfig } from "../types.js";
import { createTranslator } from "./event-translator.js";
import { createMonitoringWiringState } from "./monitoring-wiring.js";
import { makeSessionLifecycleWiringLive } from "./session-lifecycle-wiring.js";

/** Services promised to callers of ProjectRelay.effectRuntime. */
export type RelayRuntimeServices =
	| SessionDirectory
	| ProviderAdapters
	| AccountDirectory
	| SessionActivityTag
	| ConfigTag
	| LoggerTag
	| OpenCodeSettingsServiceTag
	| OrchestrationEngineTag
	| SessionWorkspaceTag
	| EventStoreEffectTag
	| EventRetentionTag
	| EventRetentionSchedulerTag
	| ProviderRuntimeIngestionTag
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

export interface RelayRuntime {
	runtime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeServices,
		PersistenceEffectError | DaemonConfigLoadError | Error
	>;
	dispose: () => Promise<void>;
}

export interface ProjectRelayLayerInputs {
	config: ProjectRelayConfig;
	testSendLimit?: number;
	/** Undefined until startup finishes; runner adoption publishes before then. */
	getWsHandler: () => WebSocketHandlerShape | undefined;
}

/** Build the shared per-project Layer graph and its managed runtime. */
export function createProjectRelayLayers({
	config,
	testSendLimit,
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
		| DaemonConfigRefTag
		| ConfigPersistenceTag
		| ConfigSnapshotTag
		| AccountDirectory,
		DaemonConfigLoadError
	> = Layer.unwrap(
		Effect.gen(function* () {
			const shared = config.daemonConfigContext ?? Context.empty();
			const configRef = Context.getOption(shared, DaemonConfigRefTag);
			const persistence = Context.getOption(shared, ConfigPersistenceTag);
			const accountsService = Context.getOption(shared, AccountDirectory);
			const configSnapshot = Context.getOption(shared, ConfigSnapshotTag);
			if (
				Option.isSome(configRef) &&
				Option.isSome(persistence) &&
				Option.isSome(accountsService) &&
				Option.isSome(configSnapshot)
			) {
				return Layer.succeedContext(
					Context.make(DaemonConfigRefTag, configRef.value).pipe(
						Context.add(ConfigPersistenceTag, persistence.value),
						Context.add(AccountDirectory, accountsService.value),
						Context.add(ConfigSnapshotTag, configSnapshot.value),
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
							const { cursorUsageBinding: _binding, ...unchanged } = saved;
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
				Layer.provideMerge(
					AccountDirectoryStateLive(
						accounts,
						Effect.succeed(NO_OPENCODE_HEALTH),
					),
				),
			);
		}),
	).pipe(
		Layer.merge(
			Layer.succeedContext(config.daemonConfigContext ?? Context.empty()),
		),
	);
	const claudeAccountsLayer = Layer.unwrap(
		Effect.gen(function* () {
			const shared = yield* Effect.serviceOption(ClaudeAccountScopes);
			return Option.isSome(shared)
				? Layer.empty
				: ClaudeAccountScopesLive(config.configDir).pipe(
						Layer.provideMerge(makeAccountResourceScopesLive()),
					);
		}),
	).pipe(Layer.provideMerge(daemonSettingsLayer));
	// A standalone relay is its own daemon.
	const daemonTurnsLayer = DaemonTurnsOrOwn.pipe(
		Layer.provideMerge(claudeAccountsLayer),
	);
	const daemonConfigLayer = UserAvatarLive.pipe(
		Layer.provide(AccountPictureLive),
		Layer.provideMerge(daemonTurnsLayer),
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
	const orchestrationRuntimeLayer = makeOrchestrationRuntimeLayer({
		...(config.shellEnv && { shellEnv: config.shellEnv }),
		...(config.prepareShellEnv && {
			prepareShellEnv: config.prepareShellEnv,
		}),
		claudeSessionForkSdk: claudeSdk.fork,
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
		extraFolders: config.extraFolders ?? [],
		...(config.configDir != null ? { configDir: config.configDir } : {}),
	});

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
							codex: codexUsageReader,
							cursor: cursor.reader,
							claude: makeClaudeUsageReader({
								queryFactory: claudeSdk.query,
								cwd: config.projectDir,
								...(config.shellEnv
									? { shellEnv: config.shellEnv(config.projectDir).env }
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
	const sharedDrafts = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		InputDraftsTag,
	);
	const sharedAlerts = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		AlertsTag,
	);
	// One reference, so the ingestion publisher and SubscribeAlerts share a feed:
	// the daemon's, which every project's tab reads, or a standalone relay's own.
	const alertsLayer = Option.isSome(sharedAlerts)
		? Layer.succeedContext(Context.make(AlertsTag, sharedAlerts.value))
		: AlertsLive;
	// Returning the daemon instance adds no ownership to the relay scope.
	// Keep one layer reference so every writer and subscriber uses the same bus.
	const sessionEventBusLayer = Option.isSome(sharedBus)
		? Layer.sync(SessionEventBusTag, () => sharedBus.value)
		: SessionEventBusLive;
	const sharedRetention = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		EventRetentionSchedulerTag,
	);
	// A registered project's generation is the daemon's (82tn.16): one status
	// snapshot, OpenCode creation gate, model catalog and store binding, whichever
	// relay serves it. A relay for a project outside the registry builds its own.
	const sharedProject = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		ProjectServices,
	);
	const fromProject = <I, E, R>(
		pick: (
			parts: Context.Context<ProjectGenerationParts>,
		) => Context.Context<I>,
		own: Layer.Layer<I, E, R>,
	): Layer.Layer<I, E, R> =>
		Option.isSome(sharedProject)
			? Layer.unwrap(
					Effect.match(sharedProject.value.generation(config.slug), {
						onFailure: () => own,
						onSuccess: (parts) => Layer.succeedContext(pick(parts)),
					}),
				)
			: own;
	const persistenceEffectLayer = (
		Option.isSome(sharedStore)
			? fromProject(
					(
						parts,
					): Context.Context<
						PersistenceProjectContext | PersistenceStoreContext
					> => parts,
					makePersistenceProjectLayer(config.slug, {
						sessionEventBusLayer,
						retentionSchedulerLayer: Option.isSome(sharedRetention)
							? Layer.succeedContext(
									Context.make(
										EventRetentionSchedulerTag,
										sharedRetention.value,
									),
								)
							: undefined,
					}).pipe(Layer.provideMerge(Layer.succeedContext(sharedStore.value))),
				)
			: makePersistenceEffectLayer(
					config.persistenceDbPath,
					config.slug,
					undefined,
					sessionEventBusLayer,
				)
	).pipe(
		Layer.provideMerge(activityReaders),
		// Relay writers and subscribers share the daemon instance, so a draft that
		// moves between projects keeps one broadcast channel.
		Layer.merge(
			Option.isSome(sharedDrafts)
				? Layer.sync(InputDraftsTag, () => sharedDrafts.value)
				: Layer.empty,
		),
	);
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
	// The daemon's instances; every request names its own folder.
	const openCodeInstancesLayer = sharedInstances
		? Layer.sync(OpenCodeInstancesTag, () => sharedInstances)
		: makeStandaloneOpenCodeInstancesLive(config).pipe(
				Layer.provide(daemonConfigLayer),
			);
	const worktreeLayer = config.worktreeContext
		? Layer.succeedContext(config.worktreeContext)
		: makeWorktreeLive(config.configDir ?? getConfigDir());
	// The daemon's owners, or a standalone relay's own; the relay builds none.
	const daemonContextLayer = Layer.succeedContext(
		config.daemonConfigContext ?? Context.empty(),
	);
	const sessionWorkspaceLayer = SessionWorkspaceOrOwn.pipe(
		Layer.provide(
			Layer.mergeAll(
				daemonContextLayer,
				daemonConfigLayer,
				persistenceEffectLayer,
				configLayer,
				loggerLayer,
				sessionEventBusLayer,
				worktreeLayer,
			),
		),
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
	// A registered project's ingestion side is the daemon's (82tn.16 slice 4):
	// one pending-interaction store, alert ledger and ingestion per project,
	// whichever relay serves it. One layer reference, so every relay reader
	// shares the instance the engine's reactor uses.
	const ingestionLayer = fromProject(
		Context.pick(
			PendingInteractionServiceTag,
			AlertLedgerTag,
			ProviderRuntimeIngestionTag,
			ContinuationTag,
		),
		makeProjectIngestionLive(
			Effect.succeed(Option.fromNullishOr(config.pushManager)),
		).pipe(
			Layer.provide(
				Layer.mergeAll(
					persistenceEffectLayer,
					sessionWorkspaceLayer,
					sessionEventBusLayer,
					// The same reference makeRelayStateLive merges, so it memoizes to the
					// one PubSub SubscribeAlerts reads.
					alertsLayer,
					configLayer,
					loggerLayer,
					usageLayer,
					recapSettingsLayer,
					daemonConfigLayer,
				),
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
	const sharedProjectContext = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		ProjectContext,
	);
	// Without a daemon context, orchestration builds its existing relay-local
	// folder and shell-env fallback. Shared services belong to the daemon scope.
	const projectContextLayer = Option.isSome(sharedProjectContext)
		? Layer.sync(ProjectContext, () => sharedProjectContext.value)
		: Layer.empty;
	const providerAdaptersLayer = Layer.sync(ProviderAdapters, () =>
		Option.getOrThrow(
			Context.getOption(
				config.daemonConfigContext ?? Context.empty(),
				ProviderAdapters,
			),
		),
	);
	const providerOrchestrationDeps = Layer.mergeAll(
		projectContextLayer,
		usageLayer,
		daemonConfigLayer,
		sessionWorkspaceLayer,
		persistenceEffectLayer,
		// The engine commits input.sent through commit-and-signal, which
		// announces on the same bus as the relay's subscribers.
		sessionEventBusLayer,
		ingestionLayer,
		openCodeInstancesLayer,
		instanceManagementLayer,
	);
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		// Recovery can publish a completed run while orchestration is adopted.
		Layer.provide(HandoffReceiptsLive),
		Layer.provide(providerOrchestrationDeps),
		Layer.provideMerge(providerAdaptersLayer),
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
		Layer.provide(Layer.merge(configLayer, openCodeInstancesLayer)),
	);
	const openCodeModelServiceLayer = fromProject(
		Context.pick(OpenCodeModelServiceTag),
		OpenCodeModelServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					daemonSettingsLayer,
					openCodeInstancesLayer,
					configLayer,
					loggerLayer,
				),
			),
		),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(Layer.merge(configLayer, openCodeInstancesLayer)),
	);
	// Daemon relays feed from the daemon's per-project OpenCode streams (82tn.16).
	const projectStreamsLayer = Option.match(
		Context.getOption(
			config.daemonConfigContext ?? Context.empty(),
			OpenCodeProjectStreams,
		),
		{
			onSome: (streams) => Layer.sync(OpenCodeProjectStreams, () => streams),
			onNone: () =>
				makeOpenCodeProjectStreamsLive(() => [
					{
						slug: config.slug,
						folders: [config.projectDir, ...(config.extraFolders ?? [])],
					},
				]).pipe(
					Layer.provide(
						Layer.merge(openCodeInstancesLayer, persistenceEffectLayer),
					),
				),
		},
	);
	const sseStreamLayer = SSEStreamLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				projectStreamsLayer,
				configLayer,
				persistenceEffectLayer,
				sessionEventBusLayer,
				ingestionLayer,
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
	const localPtyServiceLayer = LocalPtyServiceOrOwn(
		config.configDir ?? DEFAULT_CONFIG_DIR,
	).pipe(Layer.provide(Layer.merge(daemonContextLayer, loggerLayer)));
	const openCodeTerminalServiceLayer = OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				// 82tn.14: the daemon's owner scopes, so a removal closes the project's terminals.
				daemonContextLayer,
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
	const creationGateLayer = fromProject(
		Context.pick(OpenCodeSessionCreationGateTag),
		Layer.effect(OpenCodeSessionCreationGateTag, Semaphore.make(1)),
	);
	// The project's ingress and history ports, built with the project (82tn.16).
	const openCodeIngressLayer = fromProject(
		Context.pick(
			OpenCodeRuntimeIngressTag,
			OpenCodeHistoryReconcileTag,
			OpenCodeProcessLinkTag,
		),
		makeProjectOpenCodeIngressLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					persistenceEffectLayer,
					ingestionLayer,
					sessionWorkspaceLayer,
					openCodeInstancesLayer,
					creationGateLayer,
					configLayer,
					loggerLayer,
					daemonConfigLayer,
					providerOrchestrationLayer,
				),
			),
		),
	);

	const coreBridgeLayers = Layer.mergeAll(
		sessionWorkspaceLayer,
		sessionDirectoryLayer,
		sessionWorkspaceLayer,
		daemonConfigLayer,
		worktreeLayer,
		usageLayer,
		openCodeIngressLayer,
		creationGateLayer,
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
		ingestionLayer,
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
		ingestionLayer,
	);

	// Optional bridge layers (only included when deps are present)
	const bridgeLayers = Layer.merge(coreBridgeLayers, instanceManagementLayer);
	// Compose: self-constructing state layers + imperative bridge layers.
	// baseLayers are defined here; wiringLayers (SessionLifecycleWiringLive)
	// are added after monitoring state exists
	// (provides sseTracker, getMonitoringState).
	const sharedOverrides = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		OverridesStateTag,
	);
	const sharedSessionManager = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		SessionManagerOwner,
	);
	const relayStateAndBridges = Layer.provideMerge(
		makeRelayStateLive({
			sessionEventBusLayer,
			alertsLayer,
			statusSnapshotLayer: fromProject(
				Context.pick(RelayStatusSnapshotTag),
				RelayStatusSnapshotLive,
			),
			titlesLayer: fromProject(
				Context.pick(ProjectSettingsTag, SessionTitleServiceTag),
				makeSessionTitleServiceLive().pipe(
					Layer.provideMerge(ProjectSettingsLive),
				),
			),
			...(Option.isSome(sharedSessionManager) && {
				sessionManagerStateLayer: Layer.effectContext(
					sharedSessionManager.value.project(config.slug).pipe(
						// A relay for a project outside the registry keeps relay-local state.
						Effect.catch(() =>
							Effect.all({
								state: Ref.make(emptySessionManagerState()),
								coordination: makeSessionManagerCoordination(),
							}),
						),
						Effect.map(({ state, coordination }) =>
							Context.make(SessionManagerStateTag, state).pipe(
								Context.add(SessionManagerCoordinationTag, coordination),
							),
						),
					),
				),
			}),
			...(Option.isSome(sharedOverrides) && {
				overridesStateLayer: Layer.succeedContext(
					Context.make(OverridesStateTag, sharedOverrides.value),
				),
			}),
			...(testSendLimit !== undefined && { testSendLimit }),
		}),
		bridgeLayers,
	);
	// The daemon's session managers build each project's parts themselves.
	const sharedManagers = Context.getOption(
		config.daemonConfigContext ?? Context.empty(),
		SessionManagerServiceTag,
	);
	const relayStateBridgesAndSessions = Layer.provideMerge(
		Option.isSome(sharedManagers)
			? Layer.sync(SessionManagerServiceTag, () => sharedManagers.value)
			: ownSessionManagersLive,
		relayStateAndBridges,
	);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		Layer.merge(
			StatusPollerLive.pipe(
				Layer.provide(
					Layer.succeedContext(
						Context.pick(StatusPollerCoreTag)(
							config.daemonConfigContext ?? Context.empty(),
						),
					),
				),
			),
			// The daemon runs the one alarm scheduler; a standalone relay runs its own.
			Option.isSome(sharedStore)
				? Layer.empty
				: makeRunLedgerSchedulerLive(Effect.succeed([config.slug])).pipe(
						Layer.provide(
							Layer.effect(
								UnboundEventStoreEffectTag,
								makeUnboundEventStoreEffect,
							),
						),
					),
		),
		relayStateBridgesAndSessions,
	);
	const relayStateWithRecaps = Layer.merge(
		makeRecapServiceLive({
			queryFactory: config.titleQuery ?? claudeSdk.titleQuery,
		}),
		makeGoalSummaryServiceLive({
			queryFactory: config.titleQuery ?? claudeSdk.titleQuery,
		}),
	).pipe(
		Layer.provideMerge(relayStateBridgesAndStatus),
		Layer.provide(recapSettingsLayer),
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateWithRecaps,
	);
	// One translator per project, so a sessionless part never crosses projects.
	const translatorLayer = fromProject(
		Context.pick(TranslatorTag),
		Layer.sync(TranslatorTag, () => createTranslator()),
	);
	const draftPreWarmLayer = DraftPreWarmOrOwn.pipe(
		Layer.provide(daemonContextLayer),
	);
	const baseLayers = Layer.provideMerge(
		Layer.merge(translatorLayer, draftPreWarmLayer),
		relayStateServicesAndBridges,
	);
	const baseLayersWithProjectionNotifier = Layer.provideMerge(
		SessionStateProjectionNotifierLive,
		baseLayers,
	);
	const fullBaseLayers = Layer.provideMerge(
		attachProviderTurnsLive.pipe(
			Layer.provide(ProviderTurnsOrOwn.pipe(Layer.provide(daemonContextLayer))),
		),
		Layer.merge(
			SessionSetupOrOwn.pipe(
				Layer.provide(daemonContextLayer),
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
	// Permission timeouts run once on the daemon for every project (82tn.16).
	const wiringLayers = sessionLifecycleWiringLayer.pipe(
		Layer.provide(Layer.merge(baseLayers, sessionWorkspaceLayer)),
	);
	const inboxLayer = SessionInboxLive.pipe(Layer.provide(sessionEventBusLayer));
	// Provide the borrowed daemon tracer to every layer, including fibers forked
	// while building services such as the status poller.
	const fullLayer = Layer.provideMerge(
		Layer.provideMerge(
			RpcSubscriptionScopeLive,
			Layer.provideMerge(Layer.merge(wiringLayers, inboxLayer), fullBaseLayers),
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
	};
}
