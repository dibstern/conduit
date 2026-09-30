import { Effect, Layer, ManagedRuntime } from "effect";
import { makeMessagePollerManagerLive } from "../domain/relay/Layers/message-poller-manager-layer.js";
import { makePtyRuntimeLive } from "../domain/relay/Layers/pty-manager-layer.js";
import {
	makeProjectRelayConfigLive,
	OpenCodeAPILive,
	ProjectRelayLoggerLive,
} from "../domain/relay/Layers/relay-core-layers.js";
import { RelayStateLive } from "../domain/relay/Layers/relay-layer.js";
import { makeSessionStateProjectionNotifierLive } from "../domain/relay/Layers/session-state-projection-notifier-layer.js";
import { StatusPollerLive } from "../domain/relay/Layers/status-poller-layer.js";
import { WebSocketHandlerLive } from "../domain/relay/Layers/websocket-handler-layer.js";
import { makeWsTransportLive } from "../domain/relay/Layers/ws-transport-layer.js";
import { AgentServiceLive } from "../domain/relay/Services/agent-service.js";
import { DaemonSessionQueryServiceLive } from "../domain/relay/Services/daemon-session-query-service.js";
import { DirectoryListingServiceLive } from "../domain/relay/Services/directory-listing-service.js";
import {
	hasInstanceManagementConfig,
	InstanceManagementServiceFromConfigLive,
} from "../domain/relay/Services/instance-management-service.js";
import { OpenCodeInstanceClientsLive } from "../domain/relay/Services/opencode-instance-clients.js";
import { PendingInteractionServiceLive } from "../domain/relay/Services/pending-interaction-service.js";
import { ProjectManagementServiceLive } from "../domain/relay/Services/project-management-service.js";
import { makeProviderRuntimeIngestionLive } from "../domain/relay/Services/provider-runtime-ingestion-service.js";
import { ProviderTurnServiceLive } from "../domain/relay/Services/provider-turn-service.js";
import { makeRelayCommandGateLive } from "../domain/relay/Services/relay-command-gate.js";
import { ScanServiceLive } from "../domain/relay/Services/scan-service.js";
import {
	BackgroundLivenessTag,
	type ConfigTag,
	type LoggerTag,
	OpenCodeFileServiceLive,
	OpenCodeModelServiceLive,
	type OpenCodeModelServiceTag,
	OpenCodeSettingsServiceLive,
	type OrchestrationEngineTag,
	type WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
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
import { makeOrchestrationRuntimeLayer } from "../provider/orchestration-wiring.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { makeSessionBackgroundLiveness } from "../session/background-liveness.js";
import type { ProjectRelayConfig } from "../types.js";
import type { createTranslator } from "./event-translator.js";
import { createMonitoringWiringState } from "./monitoring-wiring.js";
import { makeSessionLifecycleWiringLive } from "./session-lifecycle-wiring.js";
import { PermissionTimeoutLive } from "./timer-wiring.js";

/** Services promised to callers of ProjectRelay.effectRuntime. */
export type RelayRuntimeServices =
	| OverridesStateTag
	| Layer.Layer.Success<typeof PendingInteractionServiceLive>
	| PollerStateTag
	| ReadQueryEffectTag;

export interface RelayRuntime {
	runtime: ManagedRuntime.ManagedRuntime<
		RelayRuntimeServices,
		PersistenceEffectError
	>;
	dispose: () => Promise<void>;
}

export interface ProjectRelayLayerInputs {
	config: ProjectRelayConfig;
	backgroundLiveness: ReturnType<typeof makeSessionBackgroundLiveness>;
	translator: ReturnType<typeof createTranslator>;
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
	backgroundLiveness,
	translator,
	getWsHandler,
	defaultCommandQueueLayer,
}: ProjectRelayLayerInputs) {
	const hasInstanceManagement = hasInstanceManagementConfig(config);
	// ── Orchestration runtime layer (provider instance routing) ─────────────
	const orchestrationRuntimeLayer = makeOrchestrationRuntimeLayer({
		onBackgroundTask: backgroundLiveness.record,
		...(config.projectDir != null && { workspaceRoot: config.projectDir }),
		...(config.slug != null ? { projectKey: config.slug } : {}),
		...(config.configDir != null ? { configDir: config.configDir } : {}),
	});

	// ── Effect ManagedRuntime (Layer-based composition) ─────────────────────
	// RelayStateLive provides all self-constructing Effect-native state Layers.
	// Imperative edge objects are provided as ports and merged into one Layer tree.

	const configLayer = makeProjectRelayConfigLive(config);
	const loggerLayer = ProjectRelayLoggerLive.pipe(Layer.provide(configLayer));
	const openCodeApiLayer = OpenCodeAPILive.pipe(Layer.provide(configLayer));
	const persistenceEffectLayer = makePersistenceEffectLayer(
		config.persistenceDbPath,
	);
	const providerRuntimeIngestionLayer = makeProviderRuntimeIngestionLive({
		relayPublisher: {
			publish: (msg) =>
				Effect.sync(() => {
					getWsHandler().sendToSession(
						"sessionId" in msg &&
							typeof msg.sessionId === "string" &&
							msg.sessionId.length > 0
							? msg.sessionId
							: "",
						msg,
					);
				}),
		},
	}).pipe(Layer.provide(persistenceEffectLayer));
	// Named OpenCode instance clients: one shared layer reference
	// (Effect memoizes it) so orchestration wiring, the session manager, and
	// the startup SSE wiring all see the same lazy per-instance client cache.
	const openCodeInstanceClientsLayer = OpenCodeInstanceClientsLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, loggerLayer)),
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
		openCodeInstanceClientsLayer,
	);
	const providerOrchestrationLayer = orchestrationRuntimeLayer.pipe(
		Layer.provide(providerOrchestrationDeps),
	);
	const openCodeFileServiceLayer = OpenCodeFileServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const openCodeModelServiceLayer = OpenCodeModelServiceLive.pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, configLayer, loggerLayer)),
	);
	const openCodeSettingsServiceLayer = OpenCodeSettingsServiceLive.pipe(
		Layer.provide(openCodeApiLayer),
	);
	const sseStreamLayer = SSEStreamLive.pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, loggerLayer)),
	);
	const projectManagementServiceLayer = ProjectManagementServiceLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, openCodeSettingsServiceLayer)),
	);
	const daemonSessionQueryServiceLayer = DaemonSessionQueryServiceLive.pipe(
		Layer.provide(configLayer),
	);
	const scanServiceLayer = ScanServiceLive.pipe(Layer.provide(configLayer));
	const webSocketHandlerLayer = WebSocketHandlerLive.pipe(
		Layer.provide(Layer.mergeAll(configLayer, loggerLayer)),
	);
	const messagePollerManagerLayer = makeMessagePollerManagerLive({
		hasViewers: (sid) => getWsHandler().getClientsForSession(sid).length > 0,
	}).pipe(
		Layer.provide(Layer.mergeAll(openCodeApiLayer, configLayer, loggerLayer)),
	);
	const ptyRuntimeLayer = makePtyRuntimeLive().pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeApiLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
			),
		),
	);
	const openCodeTerminalServiceLayer = OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				openCodeApiLayer,
				webSocketHandlerLayer,
				loggerLayer,
				configLayer,
				ptyRuntimeLayer,
				LocalPtyServiceLive,
			),
		),
	);
	const pendingInteractionServiceLayer = PendingInteractionServiceLive;
	const toolContentServiceLayer = ToolContentServiceLive.pipe(
		Layer.provideMerge(persistenceEffectLayer),
	);

	const coreBridgeLayers = Layer.mergeAll(
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
		Layer.sync(BackgroundLivenessTag, () => backgroundLiveness.hasLiveWork),
		ptyRuntimeLayer,
		configLayer,
		loggerLayer,
		providerOrchestrationLayer,
		openCodeInstanceClientsLayer,
		persistenceEffectLayer,
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
	const relayStateAndBridges = Layer.provideMerge(RelayStateLive, bridgeLayers);
	const relayStateBridgesAndStatus = Layer.provideMerge(
		StatusPollerLive,
		relayStateAndBridges,
	);
	const relayStateServicesAndBridges = Layer.provideMerge(
		AgentServiceLive,
		relayStateBridgesAndStatus,
	);
	const baseLayers = relayStateServicesAndBridges;
	const baseLayersWithProjectionNotifier = Layer.provideMerge(
		makeSessionStateProjectionNotifierLive(config.refreshSessionGit),
		baseLayers,
	);
	const fullBaseLayers = Layer.provideMerge(
		ProviderTurnServiceLive,
		Layer.merge(
			baseLayersWithProjectionNotifier,
			makeWsTransportLive({ noServer: true }),
		),
	);

	// ── Build ManagedRuntime with all wiring Layers ─────────────────────────
	// Monitoring state is created before the runtime so lifecycle wiring and
	// monitoring wiring share one view, while the poller manager itself remains
	// runtime-owned by MessagePollerManagerLive.
	const monitoringStateAccess = createMonitoringWiringState();
	const sessionLifecycleWiringLayer = makeSessionLifecycleWiringLive({
		translator,
		sseTracker: monitoringStateAccess.sseTracker,
		getMonitoringState: monitoringStateAccess.getMonitoringState,
		setMonitoringState: monitoringStateAccess.setMonitoringState,
	});
	const wiringLayers = Layer.mergeAll(
		PermissionTimeoutLive,
		sessionLifecycleWiringLayer,
		defaultCommandQueueLayer,
		makeRelayCommandGateLive(config.slug),
	).pipe(Layer.provide(baseLayers));
	const fullLayer = Layer.provideMerge(wiringLayers, fullBaseLayers);
	const relayManagedRuntime = ManagedRuntime.make(fullLayer);
	const effectRuntime: RelayRuntime = {
		runtime: relayManagedRuntime,
		dispose: () => relayManagedRuntime.dispose(),
	};
	return { relayManagedRuntime, effectRuntime, monitoringStateAccess };
}
