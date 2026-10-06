import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { defaultInstanceIdForDriver } from "../contracts/provider-instance.js";
import { makeStandaloneOpenCodeInstancesLive } from "../domain/daemon/Layers/opencode-instances-layer.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../domain/daemon/Services/opencode-instances-service.js";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	makeProjectRelayConfigLive,
	OpenCodeAPILive,
	ProjectRelayLoggerLive,
} from "../domain/relay/Layers/relay-core-layers.js";
import { makeRelayStateLive } from "../domain/relay/Layers/relay-layer.js";
import { makeSessionStateProjectionNotifierLive } from "../domain/relay/Layers/session-state-projection-notifier-layer.js";
import { StatusPollerLive } from "../domain/relay/Layers/status-poller-layer.js";
import { WebSocketHandlerLive } from "../domain/relay/Layers/websocket-handler-layer.js";
import { makeWsTransportLive } from "../domain/relay/Layers/ws-transport-layer.js";
import { AgentServiceLive } from "../domain/relay/Services/agent-service.js";
import {
	AlertLedgerLive,
	AlertLedgerTag,
} from "../domain/relay/Services/alert-ledger.js";
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
import { PendingSendOwnershipTag } from "../domain/relay/Services/pending-send-ownership.js";
import { ProjectManagementServiceLive } from "../domain/relay/Services/project-management-service.js";
import { makeProviderRuntimeIngestionLive } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../domain/relay/Services/provider-turn-service.js";
import { ScanServiceLive } from "../domain/relay/Services/scan-service.js";
import {
	BackgroundLivenessTag,
	type ConfigTag,
	LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	type OpenCodeModelServiceTag,
	OpenCodeSettingsServiceLive,
	type OrchestrationEngineTag,
	type WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionEventBusLive } from "../domain/relay/Services/session-event-bus.js";
import type { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { OverridesStateTag } from "../domain/relay/Services/session-overrides-state.js";
import type { PollerStateTag } from "../domain/relay/Services/session-status-poller.js";
import { SSEStreamLive } from "../domain/relay/Services/sse-stream-service.js";
import {
	LocalPtyServiceLive,
	OpenCodeTerminalServiceLive,
} from "../domain/relay/Services/terminal-service.js";
import { ToolContentServiceLive } from "../domain/relay/Services/tool-content-service.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectError,
} from "../persistence/effect/live.js";
import type { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { defaultClaudeSessionForkSdk } from "../provider/claude/claude-session-fork.js";
import {
	makeOrchestrationRuntimeLayer,
	type OrchestrationRuntimeLayerOptions,
} from "../provider/orchestration-wiring.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { makeSessionBackgroundLiveness } from "../session/background-liveness.js";
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
): OpenCodeInstances => {
	const defaultId = defaultInstanceIdForDriver("opencode");
	const selectedId = config.openCodeInstanceId ?? defaultId;
	const target = (instanceId: string) =>
		instanceId === defaultId ? selectedId : instanceId;
	const scope = config.noServer ? config.projectDir : undefined;
	// Other instances' events reach this relay only once it has used them.
	const used = new Set<string>();
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
		ifRunning: (instanceId, directory = scope) =>
			instances.ifRunning(target(instanceId), directory),
		stop: (instanceId) => instances.stop(target(instanceId)),
	};
};

/** Services promised to callers of ProjectRelay.effectRuntime. */
export type RelayRuntimeServices =
	| OverridesStateTag
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
		PersistenceEffectError
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
	// Orchestration runtime layer (provider instance routing)
	const orchestrationRuntimeLayer = makeOrchestrationRuntimeLayer({
		...(config.shellEnv && { shellEnv: config.shellEnv }),
		...(config.prepareShellEnv && { prepareShellEnv: config.prepareShellEnv }),
		onBackgroundTask: backgroundLiveness.record,
		claudeQueryFactory: claudeSdk.query,
		...(claudeRunnerFactory && { claudeRunnerFactory }),
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
		extraFolders: config.extraFolders ?? [],
		...(config.slug != null ? { projectKey: config.slug } : {}),
		...(config.configDir != null ? { configDir: config.configDir } : {}),
	});

	// Effect ManagedRuntime (Layer-based composition)
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Imperative edge objects are provided as ports and merged into one Layer tree.

	const configLayer = makeProjectRelayConfigLive({ ...config, claudeSdk });
	const loggerLayer = ProjectRelayLoggerLive.pipe(Layer.provide(configLayer));
	// One shared layer reference (Effect memoizes it), so orchestration wiring,
	// the session manager, startup and the SSE adapter see one relay view.
	const sharedInstances = config.openCodeInstances;
	const openCodeInstancesLayer = Layer.map(
		sharedInstances
			? Layer.sync(OpenCodeInstancesTag, () => sharedInstances)
			: makeStandaloneOpenCodeInstancesLive(config),
		(context) =>
			Context.make(
				OpenCodeInstancesTag,
				relayOpenCodeInstances(
					Context.get(context, OpenCodeInstancesTag),
					config,
				),
			),
	);
	// The relay's default client resolves its endpoint through that view.
	const openCodeApiLayer = OpenCodeAPILive.pipe(
		Layer.provide(Layer.merge(configLayer, openCodeInstancesLayer)),
	);
	const persistenceEffectLayer = makePersistenceEffectLayer(
		config.persistenceDbPath,
		undefined,
		SessionEventBusLive,
	);
	const alertLedgerLayer = AlertLedgerLive.pipe(
		Layer.provide(persistenceEffectLayer),
	);
	const providerRuntimeIngestionLayer = Layer.unwrapEffect(
		Effect.gen(function* () {
			const ledger = yield* AlertLedgerTag;
			const sql = yield* SqlClient.SqlClient;
			const log = yield* LoggerTag;
			return makeProviderRuntimeIngestionLive({
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
						),
				},
			});
		}),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				persistenceEffectLayer,
				SessionEventBusLive,
				alertLedgerLayer,
				loggerLayer,
			),
		),
	);
	// The orchestration engine's side-effect reactor consumes the SAME
	// ProviderRuntimeIngestion instance the relay uses (Effect memoizes the shared
	// layer reference), so committed provider side effects stream through one
	// ingestion pipeline — no duplicate event append. Likewise the shared
	// persistenceEffectLayer reference gives orchestration (session bindings,
	// durable command receipts) the relay's one SqlClient connection.
	const providerOrchestrationDeps = Layer.mergeAll(
		openCodeApiLayer,
		persistenceEffectLayer,
		providerRuntimeIngestionLayer,
		openCodeInstancesLayer,
	);
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		Layer.provide(providerOrchestrationDeps),
	);
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
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
		Layer.provide(openCodeApiLayer),
	);
	const sseStreamLayer = SSEStreamLive.pipe(
		Layer.provide(Layer.mergeAll(openCodeInstancesLayer, configLayer)),
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
	const messagePollerManagerLayer = makeMessagePollerManagerLive({
		hasViewers: (sid) => getWsHandler().getClientsForSession(sid).length > 0,
	}).pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, configLayer, loggerLayer)),
	);
	const ptyRuntimeLayer = makePtyRuntimeLive().pipe(
		Layer.provide(
			Layer.mergeAll(openCodeInstancesLayer, configLayer, loggerLayer),
		),
	);
	const openCodeTerminalServiceLayer = OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeInstancesLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
				ptyRuntimeLayer,
				LocalPtyServiceLive.pipe(
					Layer.provide(Layer.merge(configLayer, loggerLayer)),
				),
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
		historyReconcileLayer,
		Layer.effect(OpenCodeSessionCreationGateTag, Effect.makeSemaphore(1)),
		openCodeApiLayer,
		openCodeFileServiceLayer,
		openCodeModelServiceLayer,
		openCodeSettingsServiceLayer,
		sseStreamLayer,
		projectManagementServiceLayer,
		daemonSessionQueryServiceLayer,
		DirectoryListingServiceLive,
		scanServiceLayer,
		openCodeTerminalServiceLayer,
		pendingInteractionServiceLayer,
		toolContentServiceLayer,
		webSocketHandlerLayer,
		messagePollerManagerLayer,
		Layer.sync(BackgroundLivenessTag, () => backgroundLiveness.backgroundOf),
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
	const bridgeLayers = hasInstanceManagement
		? Layer.merge(
				coreBridgeLayers,
				InstanceManagementServiceFromConfigLive.pipe(
					Layer.provide(configLayer),
				),
			)
		: coreBridgeLayers;
	// Compose: self-constructing state layers + imperative bridge layers.
	// baseLayers are defined here; wiringLayers (PermissionTimeoutLive,
	// SessionLifecycleWiringLive) are added after monitoring state exists
	// (provides sseTracker, getMonitoringState).
	const relayStateAndBridges = Layer.provideMerge(
		makeRelayStateLive({
			titleQueryFactory: claudeSdk.titleQuery,
			...(testSendLimit !== undefined && { testSendLimit }),
		}),
		bridgeLayers,
	);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		StatusPollerLive,
		relayStateAndBridges,
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateBridgesAndStatus,
	);
	const translatorLayer = Layer.effect(
		TranslatorTag,
		Effect.map(PendingSendOwnershipTag, (ownership) =>
			createTranslator(ownership.resolve),
		),
	);
	const baseLayers = Layer.provideMerge(
		translatorLayer,
		relayStateServicesAndBridges,
	);
	const baseLayersWithProjectionNotifier = Layer.provideMerge(
		makeSessionStateProjectionNotifierLive(async () => {
			await config.refreshSessionGit?.();
			await config.broadcastSessionListChanged?.();
		}),
		baseLayers,
	);
	const fullBaseLayers = Layer.provideMerge(
		ProviderTurnServiceLive,
		Layer.merge(
			baseLayersWithProjectionNotifier,
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
	const fullLayer = Layer.provideMerge(wiringLayers, fullBaseLayers);
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
