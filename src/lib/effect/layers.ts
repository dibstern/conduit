// ─── Effect Service Layers ───────────────────────────────────────────────────
// Layer definitions that wrap existing imperative constructors in Effect Layer
// form. These are bridge Layers — they do NOT rewrite services, they adapt
// them so handler migration (Layer 5) can `yield* Tag` instead of `deps.field`.
//
// Pattern: Layer.succeed(Tag, existingInstance)
// All services are constructed imperatively in relay-stack.ts; these Layers
// wrap the already-built instances into the Effect Context.

import { Layer } from "effect";

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { QuestionBridge } from "../bridges/question-bridge.js";
import type {
	InstanceManagementDeps,
	ProjectManagementDeps,
	ScanDeps,
} from "../handlers/types.js";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Logger } from "../logger.js";
import type { ProviderStateService } from "../persistence/provider-state-service.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { OrchestrationEngine } from "../provider/orchestration-engine.js";
import type { RelayEventSinkPersist } from "../provider/relay-event-sink.js";
import type { PtyManager } from "../relay/pty-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { ProjectRelayConfig } from "../types.js";

import { makePollerManagerStateLive } from "./message-poller.js";
import { RateLimiterLive } from "./rate-limiter-layer.js";
import {
	ClaudeEventPersistTag,
	ConfigTag,
	type ConnectPtyUpstreamShape,
	ConnectPtyUpstreamTag,
	type ForkMetaShape,
	ForkMetaTag,
	InstanceMgmtTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	type PollerManagerShape,
	PollerManagerTag,
	ProjectMgmtTag,
	ProviderStateServiceTag,
	PtyManagerTag,
	QuestionBridgeTag,
	ReadQueryTag,
	ScanDepsTag,
	type SessionManagerShape,
	SessionManagerTag,
	SessionOverridesTag,
	SessionRegistryTag,
	type StatusPollerShape,
	StatusPollerTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "./services.js";
import { makeSessionManagerStateLive } from "./session-manager-state.js";

// ─── Individual Layer factories ──────────────────────────────────────────────
// Each factory takes the existing imperative instance and wraps it in a Layer.

export const makeOpenCodeAPILive = (instance: OpenCodeAPI) =>
	Layer.succeed(OpenCodeAPITag, instance);

export const makeSessionManagerLive = (instance: SessionManagerShape) =>
	Layer.succeed(SessionManagerTag, instance);

export const makeWebSocketHandlerLive = (instance: WebSocketHandlerShape) =>
	Layer.succeed(WebSocketHandlerTag, instance);

export const makePermissionBridgeLive = (instance: PermissionBridge) =>
	Layer.succeed(PermissionBridgeTag, instance);

export const makeQuestionBridgeLive = (instance: QuestionBridge) =>
	Layer.succeed(QuestionBridgeTag, instance);

export const makeSessionOverridesLive = (instance: SessionOverrides) =>
	Layer.succeed(SessionOverridesTag, instance);

export const makePtyManagerLive = (instance: PtyManager) =>
	Layer.succeed(PtyManagerTag, instance);

export const makeConfigLive = (instance: ProjectRelayConfig) =>
	Layer.succeed(ConfigTag, instance);

export const makeLoggerLive = (instance: Logger) =>
	Layer.succeed(LoggerTag, instance);

export const makeStatusPollerLive = (instance: StatusPollerShape) =>
	Layer.succeed(StatusPollerTag, instance);

export const makeSessionRegistryLive = (instance: SessionRegistry) =>
	Layer.succeed(SessionRegistryTag, instance);

export const makePollerManagerLive = (instance: PollerManagerShape) =>
	Layer.succeed(PollerManagerTag, instance);

export const makeConnectPtyUpstreamLive = (instance: ConnectPtyUpstreamShape) =>
	Layer.succeed(ConnectPtyUpstreamTag, instance);

export const makeForkMetaLive = (instance: ForkMetaShape) =>
	Layer.succeed(ForkMetaTag, instance);

export const makeOrchestrationEngineLive = (instance: OrchestrationEngine) =>
	Layer.succeed(OrchestrationEngineTag, instance);

// ─── Persistence extension Layers ────────────────────────────────────────────

export const makeReadQueryLive = (instance: ReadQueryService) =>
	Layer.succeed(ReadQueryTag, instance);

export const makeClaudeEventPersistLive = (instance: RelayEventSinkPersist) =>
	Layer.succeed(ClaudeEventPersistTag, instance);

export const makeProviderStateServiceLive = (instance: ProviderStateService) =>
	Layer.succeed(ProviderStateServiceTag, instance);

// ─── Daemon-only Layers ──────────────────────────────────────────────────────

export const makeInstanceMgmtLive = (instance: InstanceManagementDeps) =>
	Layer.succeed(InstanceMgmtTag, instance);

export const makeProjectMgmtLive = (instance: ProjectManagementDeps) =>
	Layer.succeed(ProjectMgmtTag, instance);

export const makeScanDepsLive = (instance: ScanDeps) =>
	Layer.succeed(ScanDepsTag, instance);

// ─── HandlerLayer composition ────────────────────────────────────────────────
// Factory that takes all already-constructed services and merges them into a
// single Layer providing every core HandlerDeps Tag. This is what handler
// migration (Layer 5) will use to run Effect programs.

/** Required services for the core handler layer. */
export interface HandlerLayerDeps {
	// Core (always present)
	readonly wsHandler: WebSocketHandlerShape;
	readonly client: OpenCodeAPI;
	readonly sessionMgr: SessionManagerShape;
	readonly permissionBridge: PermissionBridge;
	readonly questionBridge: QuestionBridge;
	readonly overrides: SessionOverrides;
	readonly ptyManager: PtyManager;
	readonly config: ProjectRelayConfig;
	readonly log: Logger;
	readonly statusPoller: StatusPollerShape;
	readonly registry: SessionRegistry;
	readonly pollerManager: PollerManagerShape;
	readonly connectPtyUpstream: ConnectPtyUpstreamShape;
	readonly forkMeta: ForkMetaShape;
	readonly orchestrationEngine: OrchestrationEngine;

	// Persistence extensions (optional)
	readonly readQuery?: ReadQueryService;
	readonly claudeEventPersist?: RelayEventSinkPersist;
	readonly providerStateService?: ProviderStateService;

	// Daemon-only (optional)
	readonly instanceMgmt?: InstanceManagementDeps;
	readonly projectMgmt?: ProjectManagementDeps;
	readonly scanDeps?: ScanDeps;

	// Effect-native state Layers (optional — included when the relay wants
	// Effect handlers to access Ref-backed state alongside the imperative
	// bridge services). These are self-constructing Layers (Ref.make or
	// FiberMap.make), not imperative instances.
	/** When true, include SessionManagerStateTag (Ref<SessionManagerState>). */
	readonly includeSessionManagerState?: boolean;
	/** When true, include PollerManagerStateTag (FiberMap<string>). */
	readonly includePollerManagerState?: boolean;
}

/**
 * Create a composite Layer providing all handler service Tags.
 *
 * Takes already-constructed service instances (from relay-stack.ts) and wraps
 * each one in a Layer.succeed, then merges them all. Optional services are
 * included only when present.
 */
export const makeHandlerLayer = (deps: HandlerLayerDeps) => {
	// Start with required core layers
	const coreLayers = Layer.mergeAll(
		makeOpenCodeAPILive(deps.client),
		makeSessionManagerLive(deps.sessionMgr),
		makeWebSocketHandlerLive(deps.wsHandler),
		makePermissionBridgeLive(deps.permissionBridge),
		makeQuestionBridgeLive(deps.questionBridge),
		makeSessionOverridesLive(deps.overrides),
		makePtyManagerLive(deps.ptyManager),
		makeConfigLive(deps.config),
		makeLoggerLive(deps.log),
		makeStatusPollerLive(deps.statusPoller),
		makeSessionRegistryLive(deps.registry),
		makePollerManagerLive(deps.pollerManager),
		makeConnectPtyUpstreamLive(deps.connectPtyUpstream),
		makeForkMetaLive(deps.forkMeta),
		makeOrchestrationEngineLive(deps.orchestrationEngine),
	);

	// Merge optional layers onto core — each conditional branch narrows further.
	// biome-ignore lint/suspicious/noExplicitAny: Layer generics are complex; the factory return type is inferred correctly by callers
	let result: Layer.Layer<any, never, never> = coreLayers;

	if (deps.readQuery != null) {
		result = Layer.merge(result, makeReadQueryLive(deps.readQuery));
	}
	if (deps.claudeEventPersist != null) {
		result = Layer.merge(
			result,
			makeClaudeEventPersistLive(deps.claudeEventPersist),
		);
	}
	if (deps.providerStateService != null) {
		result = Layer.merge(
			result,
			makeProviderStateServiceLive(deps.providerStateService),
		);
	}
	if (deps.instanceMgmt != null) {
		result = Layer.merge(result, makeInstanceMgmtLive(deps.instanceMgmt));
	}
	if (deps.projectMgmt != null) {
		result = Layer.merge(result, makeProjectMgmtLive(deps.projectMgmt));
	}
	if (deps.scanDeps != null) {
		result = Layer.merge(result, makeScanDepsLive(deps.scanDeps));
	}

	// RateLimiterLive is a scoped Layer with its own cleanup fiber — no
	// imperative instance needed. Cleanup runs every 60s inside the scope.
	result = Layer.merge(
		result,
		RateLimiterLive({ maxRequests: 5, windowMs: 10_000 }),
	);

	// ── Effect-native state Layers ─────────────────────────────────────────
	// These are self-constructing — they create their own Ref/FiberMap
	// internally, so no imperative instance is passed in. They live alongside
	// the imperative bridge services, allowing Effect handlers to gradually
	// migrate to Ref-based state access.

	if (deps.includeSessionManagerState) {
		result = Layer.merge(result, makeSessionManagerStateLive());
	}
	if (deps.includePollerManagerState) {
		result = Layer.merge(result, makePollerManagerStateLive());
	}

	return result;
};
