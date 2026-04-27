// ─── Effect Service Tags ────────────────────────────────────────────────────
// Context.Tag definitions for every service in HandlerDeps.
// Type-level foundation for Effect dependency injection — no runtime wiring.
//
// Each Tag maps 1:1 to a field in HandlerDeps (src/lib/handlers/types.ts).
// For importable classes/interfaces the concrete type is used directly.
// For inline/structural types a Shape interface is defined here.

import { Context, type Deferred } from "effect";

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { QuestionBridge } from "../bridges/question-bridge.js";
import type { ForkEntry } from "../daemon/fork-metadata.js";
import type {
	HandlerDeps,
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
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { ProjectRelayConfig, RelayMessage } from "../types.js";

// ─── Shape interfaces for inline/structural types ──────────────────────────

/** Shape for the wsHandler field — WebSocket broadcast/unicast capabilities. */
export interface WebSocketHandlerShape {
	broadcast(msg: RelayMessage): void;
	sendTo(clientId: string, msg: RelayMessage): void;
	setClientSession(clientId: string, sessionId: string): void;
	getClientSession(clientId: string): string | undefined;
	getClientsForSession(sessionId: string): string[];
	sendToSession(sessionId: string, msg: RelayMessage): void;
}

/** Shape for the statusPoller field — Pick<SessionStatusPollerService, "isProcessing">. */
export interface StatusPollerShape {
	isProcessing(sessionId: string): boolean;
}

/** Shape for the pollerManager field — Pick<MessagePollerManager, "isPolling" | "startPolling">. */
export interface PollerManagerShape {
	isPolling(sessionId: string): boolean;
	startPolling(sessionId: string): void;
}

/** Shape for the connectPtyUpstream function. */
export type ConnectPtyUpstreamShape = (
	ptyId: string,
	cursor?: number,
) => Promise<void>;

/** Shape for the forkMeta field — fork-point metadata store. */
export interface ForkMetaShape {
	setForkEntry(sessionId: string, entry: ForkEntry): void;
	getForkEntry(sessionId: string): ForkEntry | undefined;
}

// ─── Core Tags (always present) ────────────────────────────────────────────

export class OpenCodeAPITag extends Context.Tag("OpenCodeAPI")<
	OpenCodeAPITag,
	OpenCodeAPI
>() {}

export class SessionManagerTag extends Context.Tag("SessionManager")<
	SessionManagerTag,
	SessionManager
>() {}

export class WebSocketHandlerTag extends Context.Tag("WebSocketHandler")<
	WebSocketHandlerTag,
	WebSocketHandlerShape
>() {}

export class PermissionBridgeTag extends Context.Tag("PermissionBridge")<
	PermissionBridgeTag,
	PermissionBridge
>() {}

export class QuestionBridgeTag extends Context.Tag("QuestionBridge")<
	QuestionBridgeTag,
	QuestionBridge
>() {}

export class SessionOverridesTag extends Context.Tag("SessionOverrides")<
	SessionOverridesTag,
	SessionOverrides
>() {}

export class PtyManagerTag extends Context.Tag("PtyManager")<
	PtyManagerTag,
	PtyManager
>() {}

export class ConfigTag extends Context.Tag("Config")<
	ConfigTag,
	ProjectRelayConfig
>() {}

export class LoggerTag extends Context.Tag("Logger")<LoggerTag, Logger>() {}

export class StatusPollerTag extends Context.Tag("StatusPoller")<
	StatusPollerTag,
	StatusPollerShape
>() {}

export class SessionRegistryTag extends Context.Tag("SessionRegistry")<
	SessionRegistryTag,
	SessionRegistry
>() {}

export class PollerManagerTag extends Context.Tag("PollerManager")<
	PollerManagerTag,
	PollerManagerShape
>() {}

export class ConnectPtyUpstreamTag extends Context.Tag("ConnectPtyUpstream")<
	ConnectPtyUpstreamTag,
	ConnectPtyUpstreamShape
>() {}

export class ForkMetaTag extends Context.Tag("ForkMeta")<
	ForkMetaTag,
	ForkMetaShape
>() {}

export class OrchestrationEngineTag extends Context.Tag("OrchestrationEngine")<
	OrchestrationEngineTag,
	OrchestrationEngine
>() {}

// ─── Persistence extension Tags (when SQLite configured) ───────────────────

export class ReadQueryTag extends Context.Tag("ReadQuery")<
	ReadQueryTag,
	ReadQueryService
>() {}

export class ClaudeEventPersistTag extends Context.Tag("ClaudeEventPersist")<
	ClaudeEventPersistTag,
	RelayEventSinkPersist
>() {}

export class ProviderStateServiceTag extends Context.Tag(
	"ProviderStateService",
)<ProviderStateServiceTag, ProviderStateService>() {}

// ─── Daemon lifecycle Tags ────────────────────────────────────────────────

/** Shutdown signal — Deferred that completes when SIGTERM/SIGINT received. */
export class ShutdownSignalTag extends Context.Tag("ShutdownSignal")<
	ShutdownSignalTag,
	Deferred.Deferred<void>
>() {}

// ─── Daemon leaf-service Tags ─────────────────────────────────────────────
// Re-exported from the Effect-native layer files. These are the canonical Tags
// that consumers should use. The old imperative class wrappers are removed.

export { KeepAwakeTag } from "./keep-awake-layer.js";
export { PortScannerTag } from "./port-scanner-layer.js";
export { StorageMonitorTag } from "./storage-monitor-layer.js";
export { VersionCheckerTag } from "./version-checker-layer.js";

// ─── Daemon-only Tags ──────────────────────────────────────────────────────

export class InstanceMgmtTag extends Context.Tag("InstanceMgmt")<
	InstanceMgmtTag,
	InstanceManagementDeps
>() {}

export class ProjectMgmtTag extends Context.Tag("ProjectMgmt")<
	ProjectMgmtTag,
	ProjectManagementDeps
>() {}

export class ScanDepsTag extends Context.Tag("ScanDeps")<
	ScanDepsTag,
	ScanDeps
>() {}

// ─── Per-request Tags ──────────────────────────────────────────────────────

export class ClientIdTag extends Context.Tag("ClientId")<
	ClientIdTag,
	string
>() {}

// ─── Compile-time exhaustiveness check ─────────────────────────────────────
// This type alias maps every required+optional HandlerDeps field to its
// corresponding Tag's service type. A type error here means a field was
// added to HandlerDeps without a matching Tag.

type _AssertCoverage = {
	[K in keyof Required<HandlerDeps>]: K extends "wsHandler"
		? WebSocketHandlerShape
		: K extends "client"
			? OpenCodeAPI
			: K extends "sessionMgr"
				? SessionManager
				: K extends "permissionBridge"
					? PermissionBridge
					: K extends "questionBridge"
						? QuestionBridge
						: K extends "overrides"
							? SessionOverrides
							: K extends "ptyManager"
								? PtyManager
								: K extends "config"
									? ProjectRelayConfig
									: K extends "log"
										? Logger
										: K extends "statusPoller"
											? StatusPollerShape
											: K extends "registry"
												? SessionRegistry
												: K extends "pollerManager"
													? PollerManagerShape
													: K extends "connectPtyUpstream"
														? ConnectPtyUpstreamShape
														: K extends "forkMeta"
															? ForkMetaShape
															: K extends "instanceMgmt"
																? InstanceManagementDeps
																: K extends "projectMgmt"
																	? ProjectManagementDeps
																	: K extends "scanDeps"
																		? ScanDeps
																		: K extends "readQuery"
																			? ReadQueryService
																			: K extends "orchestrationEngine"
																				? OrchestrationEngine
																				: K extends "claudeEventPersist"
																					? RelayEventSinkPersist
																					: K extends "providerStateService"
																						? ProviderStateService
																						: never;
};

// If any field maps to `never`, this assignment will fail at compile time.
// The variable is never used at runtime — it exists purely for the type check.
type _ExhaustiveCheck = {
	[K in keyof _AssertCoverage]: _AssertCoverage[K] extends never
		? `Missing Tag for HandlerDeps field: ${K & string}`
		: _AssertCoverage[K];
};

// Force the compiler to evaluate the mapped type (unused but checked).
declare const _check: _ExhaustiveCheck;

export { PersistencePathTag } from "./daemon-config-persistence.js";
export { DaemonEventBusTag } from "./daemon-pubsub.js";
export { CrashCounterTag } from "./daemon-startup.js";
// ─── DaemonState re-export ────────────────────────────────────────────────
export { DaemonStateTag } from "./daemon-state.js";
export { InstanceManagerStateTag } from "./instance-manager-service.js";
export { PollerManagerStateTag } from "./message-poller.js";
export { IdempotencySetTag } from "./orchestration-service.js";
export { PersistenceServiceTag } from "./persistence-service.js";
export { PushManagerTag } from "./push-service.js";
export { RateLimiterTag } from "./rate-limiter-layer.js";
export { RelayCacheTag } from "./relay-cache.js";
// ─── Phase 2 Effect-native Tag re-exports ─────────────────────────────────
export { SessionManagerStateTag } from "./session-manager-state.js";
export { PollerPubSubTag, PollerStateTag } from "./session-status-poller.js";
