import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { SqlClient } from "@effect/sql";
import {
	Context,
	Effect,
	Either,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
	Stream,
} from "effect";
import { accountsStateFromConfig } from "../account-directory.js";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/provider-instance.js";
import {
	type DaemonConfigLoadError,
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	defaultDaemonConfig,
	getConfigDir,
	loadDaemonConfigResult,
} from "../daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotTag,
	makeConfigWriterLive,
} from "../domain/daemon/Layers/config-persistence-layer.js";
import { makeStandaloneOpenCodeInstancesLive } from "../domain/daemon/Layers/opencode-instances-layer.js";
import { makeWorktreeLive } from "../domain/daemon/Layers/worktree-layer.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
} from "../domain/daemon/Services/account-directory.js";
import type { ConfigPersistenceTag } from "../domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../domain/daemon/Services/daemon-config-ref.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../domain/daemon/Services/opencode-instances-service.js";
import { makeUsage, Usage } from "../domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	backgroundOpenCodeAPI,
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
import { DaemonSessionQueryServiceLive } from "../domain/relay/Services/daemon-session-query-service.js";
import { DirectoryListingServiceLive } from "../domain/relay/Services/directory-listing-service.js";
import {
	hasInstanceManagementConfig,
	InstanceManagementServiceFromConfigLive,
} from "../domain/relay/Services/instance-management-service.js";
import {
	type EffectOpenCodeRuntimeIngressPort,
	OpenCodeHistoryReconcileTag,
	OpenCodeSessionCreationGateTag,
} from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import { PendingInteractionServiceLive } from "../domain/relay/Services/pending-interaction-service.js";
import { ProjectManagementServiceLive } from "../domain/relay/Services/project-management-service.js";
import { makeProviderRuntimeIngestionLive } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../domain/relay/Services/provider-turn-service.js";
import { ScanServiceLive } from "../domain/relay/Services/scan-service.js";
import {
	BackgroundLivenessTag,
	type ConfigTag,
	LiveTaskListTag,
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	type OpenCodeModelServiceTag,
	OpenCodeSettingsServiceLive,
	type OpenCodeSettingsServiceTag,
	type OrchestrationEngineTag,
	openCodeInstanceTarget,
	SessionCompactionsTag,
	SessionRetriesTag,
	type WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionEventBusLive } from "../domain/relay/Services/session-event-bus.js";
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
import { SessionWorkspaceHintStateLive } from "../domain/relay/Services/session-workspace-hint-state.js";
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
	type PersistenceEffectError,
} from "../persistence/effect/live.js";
import type { ProjectionRunnerEffectTag } from "../persistence/effect/projection-runner-effect.js";
import type { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { captureClaudeLaunchLogin } from "../provider/claude/claude-sdk-env.js";
import { defaultClaudeSessionForkSdk } from "../provider/claude/claude-session-fork.js";
import { makeClaudeUsageReader } from "../provider/claude/claude-usage-probe.js";
import {
	makeOrchestrationRuntimeLayer,
	type OrchestrationRuntimeLayerOptions,
} from "../provider/orchestration-wiring.js";
import { SqliteProviderSessionBindingReadModel } from "../provider/provider-session-binding-read-model.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import { RpcSubscriptionScopeLive } from "../server/ws-rpc.js";
import type { makeSessionBackgroundLiveness } from "../session/background-liveness.js";
import { makeSessionCompactions } from "../session/session-compactions.js";
import { makeSessionRetries } from "../session/session-retries.js";
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
			Effect.tap(() => {
				used.add(target(instanceId));
			}),
		);
	return {
		events: (directories, instanceId = defaultId) =>
			instances
				.events(directories, target(instanceId))
				.pipe(
					Stream.filterMap((message) =>
						message.instanceId === selectedId
							? Option.some({ ...message, instanceId: defaultId })
							: used.has(message.instanceId)
								? Option.some(message)
								: Option.none(),
					),
				),
		use,
		borrow: (instanceId, directory = scope) =>
			instances.borrow(target(instanceId), directory).pipe(
				Effect.tap(() => {
					used.add(target(instanceId));
				}),
			),
		useIfRunning: (instanceId, directory = scope) =>
			instances.useIfRunning(target(instanceId), directory),
		ifRunning: (instanceId, directory = scope) =>
			instances.ifRunning(target(instanceId), directory),
		stop: (instanceId) => instances.stop(target(instanceId)),
	};
};

/** Services promised to callers of ProjectRelay.effectRuntime. */
export type RelayRuntimeServices =
	| AccountDirectory
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
	| Layer.Layer.Success<typeof PendingInteractionServiceLive>
	| PollerStateTag
	| ReadQueryEffectTag
	| OpenCodeInstancesTag
	| SessionManagerServiceTag
	| SqlClient.SqlClient
	| ReturnType<typeof createTranslator>;

export const TranslatorTag =
	Context.GenericTag<ReturnType<typeof createTranslator>>("RelayTranslator");

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
	backgroundLiveness: ReturnType<typeof makeSessionBackgroundLiveness>;
	getWsHandler: () => WebSocketHandlerShape;
	defaultCommandQueueLayer: Layer.Layer<
		never,
		never,
		| ConfigTag
		| LoggerTag
		| OpenCodeModelServiceTag
		| OrchestrationEngineTag
		| ReadQueryEffectTag
		| OverridesStateTag
		| WebSocketHandlerTag
	>;
}

/** Build the shared per-project Layer graph and its managed runtime. */
export function createProjectRelayLayers({
	config,
	claudeRunnerFactory,
	testSendLimit,
	backgroundLiveness,
	getWsHandler,
	defaultCommandQueueLayer,
}: ProjectRelayLayerInputs) {
	const hasInstanceManagement = hasInstanceManagementConfig(config);
	const claudeSdk = config.claudeSdk ?? {
		query: sdkQuery,
		titleQuery: sdkQuery,
		fork: defaultClaudeSessionForkSdk,
	};
	const compactions = makeSessionCompactions();
	const retries = makeSessionRetries();
	// Orchestration runtime layer (provider instance routing)
	const orchestrationRuntimeLayer = makeOrchestrationRuntimeLayer({
		...(config.shellEnv && { shellEnv: config.shellEnv }),
		...(config.prepareShellEnv && { prepareShellEnv: config.prepareShellEnv }),
		onBackgroundTask: backgroundLiveness.record,
		claudeQueryFactory: claudeSdk.query,
		claudeSessionForkSdk: claudeSdk.fork,
		...(config.claudeSdk?.subagentSdk && {
			claudeSubagentSdk: config.claudeSdk.subagentSdk,
		}),
		...(claudeRunnerFactory && { claudeRunnerFactory }),
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
		extraFolders: config.extraFolders ?? [],
		...(config.configDir != null ? { configDir: config.configDir } : {}),
	});

	// Effect ManagedRuntime (Layer-based composition)
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Imperative edge objects are provided as ports and merged into one Layer tree.

	const configLayer = makeProjectRelayConfigLive({ ...config, claudeSdk });
	const daemonConfigLayer = config.daemonConfigContext
		? Layer.succeedContext(config.daemonConfigContext)
		: Layer.unwrapEffect(
				Effect.gen(function* () {
					const configDir = config.configDir ?? getConfigDir();
					const loaded = loadDaemonConfigResult(configDir);
					if (Either.isLeft(loaded) && loaded.left._tag !== "NotFound")
						return yield* loaded.left;
					const saved = Either.getOrElse(loaded, defaultDaemonConfig);
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
										loadDaemonConfigResult(configDir),
									).pipe(
										Effect.catchTag("NotFound", () =>
											Effect.succeed(defaultDaemonConfig()),
										),
									);
									return {
										...persisted,
										autoSettleAfterDays:
											current.autoSettleAfterDays === undefined
												? DEFAULT_AUTO_SETTLE_AFTER_DAYS
												: current.autoSettleAfterDays,
										...(current.worktreeCleanup !== undefined && {
											worktreeCleanup: current.worktreeCleanup,
										}),
										...(current.usageLimits !== undefined && {
											usageLimits: current.usageLimits,
										}),
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
			);
	const sharedUsage = config.usage;
	const usageLayer = sharedUsage
		? Layer.sync(Usage, () => sharedUsage)
		: Layer.scoped(
				Usage,
				Effect.flatMap(AccountDirectory, (directory) =>
					makeUsage({
						accounts: Effect.map(directory.list, (accounts) =>
							accounts.flatMap((account) =>
								account.driver === "claude" && account.usageEligible
									? [
											{
												id: account.id,
												harness: "claude" as const,
												folder: account.folder,
												...(account.env ? { env: account.env } : {}),
											},
										]
									: [],
							),
						),
						readers: {
							claude: makeClaudeUsageReader({
								queryFactory: claudeSdk.query,
								cwd: config.projectDir,
								...(config.shellEnv
									? { shellEnv: config.shellEnv(config.projectDir) }
									: {}),
							}),
						},
					}),
				),
			).pipe(Layer.provide(daemonConfigLayer));
	const loggerLayer = ProjectRelayLoggerLive.pipe(Layer.provide(configLayer));
	// One shared layer reference (Effect memoizes it), so orchestration wiring,
	// the session manager, startup and the SSE adapter see one relay view.
	const sharedInstances = config.openCodeInstances;
	const persistenceEffectLayer = makePersistenceEffectLayer(
		config.persistenceDbPath,
		config.slug,
		undefined,
		SessionEventBusLive,
	).pipe(Layer.provideMerge(SessionWorkspaceHintStateLive));
	const openCodeInstancesLayer = Layer.effect(
		OpenCodeInstancesTag,
		Effect.gen(function* () {
			const instances = yield* OpenCodeInstancesTag;
			const sql = yield* SqlClient.SqlClient;
			const bindings = yield* new SqliteProviderSessionBindingReadModel(
				sql,
			).listBoundSessions();
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
				SessionEventBusLive,
			),
		),
	);
	const providerRuntimeIngestionLayer = Layer.unwrapEffect(
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
							wsHandler: getWsHandler(),
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
				compactions,
				retries,
			});
		}),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				persistenceEffectLayer,
				sessionWorkspaceLayer,
				SessionEventBusLive,
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
	const instanceManagementLayer = hasInstanceManagement
		? InstanceManagementServiceFromConfigLive.pipe(Layer.provide(configLayer))
		: Layer.empty;
	const providerOrchestrationDeps = Layer.mergeAll(
		daemonConfigLayer,
		openCodeApiLayer,
		persistenceEffectLayer,
		// The engine commits input.sent through commit-and-signal, which
		// announces on the relay's one bus.
		SessionEventBusLive,
		providerRuntimeIngestionLayer,
		openCodeInstancesLayer,
		instanceManagementLayer,
	);
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		Layer.provide(providerOrchestrationDeps),
	);
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
			),
		),
	);
	const projectManagementServiceLayer = ProjectManagementServiceLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, openCodeSettingsServiceLayer)),
	);
	const daemonSessionQueryServiceLayer = DaemonSessionQueryServiceLive.pipe(
		Layer.provide(configLayer),
	);
	const scanServiceLayer = ScanServiceLive.pipe(Layer.provide(configLayer));
	const webSocketHandlerLayer = WebSocketHandlerLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				configLayer,
				loggerLayer,
				SessionEventBusLive,
				persistenceEffectLayer,
			),
		),
	);
	// Polling must not restart an idle-stopped OpenCode.
	const messagePollerManagerLayer = makeMessagePollerManagerLive({
		hasViewers: (sid) => getWsHandler().getClientsForSession(sid).length > 0,
	}).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.effect(OpenCodeAPITag, backgroundOpenCodeAPI).pipe(
					Layer.provide(Layer.merge(configLayer, openCodeInstancesLayer)),
				),
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
	const pendingInteractionServiceLayer = PendingInteractionServiceLive;
	const toolContentServiceLayer = ToolContentServiceLive.pipe(
		Layer.provideMerge(persistenceEffectLayer),
	);
	let historyIngress: EffectOpenCodeRuntimeIngressPort | undefined;
	const historyReconcileLayer = Layer.sync(OpenCodeHistoryReconcileTag, () => ({
		reconcileSession: (sessionId: string) =>
			historyIngress?.reconcileSession(sessionId) ?? Effect.void,
	}));

	const coreBridgeLayers = Layer.mergeAll(
		daemonConfigLayer,
		config.worktreeContext
			? Layer.succeedContext(config.worktreeContext)
			: makeWorktreeLive(config.configDir ?? getConfigDir()),
		usageLayer,
		historyReconcileLayer,
		Layer.effect(OpenCodeSessionCreationGateTag, Effect.makeSemaphore(1)),
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
		Layer.sync(BackgroundLivenessTag, () => backgroundLiveness.backgroundOf),
		Layer.sync(LiveTaskListTag, () => backgroundLiveness.liveListOf),
		Layer.sync(SessionCompactionsTag, () => compactions.compactingOf),
		Layer.sync(SessionRetriesTag, () => retries.retryingOf),
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
			titleQueryFactory: config.titleQuery ?? claudeSdk.titleQuery,
			...(testSendLimit !== undefined && { testSendLimit }),
		}),
		bridgeLayers,
	);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		StatusPollerLive,
		Layer.provideMerge(SessionGitLive, relayStateAndBridges),
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateBridgesAndStatus,
	);
	const translatorLayer = Layer.sync(TranslatorTag, () => createTranslator());
	const baseLayers = Layer.provideMerge(
		translatorLayer,
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
	const sessionLifecycleWiringLayer = Layer.unwrapEffect(
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
		defaultCommandQueueLayer,
	).pipe(Layer.provide(baseLayers));
	// The inbox drains on the relay's one bus (memoised by layer reference).
	const inboxLayer = SessionInboxLive.pipe(Layer.provide(SessionEventBusLive));
	// The borrowed daemon tracer goes BENEATH everything, not beside it:
	// Layer.setTracer patches a FiberRef in its own build fiber, so a merged
	// tracer never reaches fibers forked while building sibling layers
	// (e.g. the status poller loop).
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
		config.tracer === undefined ? Layer.empty : Layer.setTracer(config.tracer),
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
