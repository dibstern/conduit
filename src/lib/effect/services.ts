// ─── Effect Service Tags ────────────────────────────────────────────────────
// Context.Tag definitions for every service in HandlerDeps.
// Type-level foundation for Effect dependency injection — no runtime wiring.
//
// Each Tag maps 1:1 to a field in HandlerDeps (src/lib/handlers/types.ts).
// For importable classes/interfaces the concrete type is used directly.
// For inline/structural types a Shape interface is defined here.

import { type Cause, Context, Effect, Layer } from "effect";

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
import type {
	Message,
	SessionDetail,
	SessionStatus,
} from "../instance/sdk-types.js";
import type { Logger } from "../logger.js";
import type { ProviderStateService } from "../persistence/provider-state-service.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { OrchestrationEngine } from "../provider/orchestration-engine.js";
import type { LegacyRelayEventSinkPersist } from "../provider/relay-event-sink.js";
import type { Translator } from "../relay/event-translator.js";
import type { PtyManager } from "../relay/pty-manager.js";
import type { WebSocketHandlerShape } from "../server/ws-handler-shape.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { SessionRegistry } from "../session/session-registry.js";
import type { HistoryMessage } from "../shared-types.js";
import type {
	ProjectRelayConfig,
	RelayMessage,
	SessionInfo,
} from "../types.js";

// ─── Shape interfaces for inline/structural types ──────────────────────────

export type { WebSocketHandlerShape };

/** Shape for the statusPoller field — methods needed by effect handlers and lifecycle wiring. */
export interface StatusPollerShape {
	isProcessing(sessionId: string): boolean;
	clearMessageActivity(sessionId: string): void;
}

/** Shape for the pollerManager field — isPolling + startPolling capabilities. */
export interface PollerManagerShape {
	isPolling(sessionId: string): boolean;
	startPolling(sessionId: string, seedMessages?: Message[]): void;
	stopPolling(sessionId: string): void;
}

/** Shape for the connectPtyUpstream function. */
export type ConnectPtyUpstreamShape = (
	ptyId: string,
	cursor?: number,
) => Promise<void>;

/**
 * Shape for the sessionMgr field — all SessionManager capabilities used
 * by handlers, session-switch, and wiring modules.
 *
 * Replaces the concrete SessionManager class import so consumers depend
 * on a structural interface, not the implementation.
 */
export interface SessionManagerShape {
	// ── Queries ────────────────────────────────────────────────────────
	listSessions(options?: {
		statuses?: Record<string, SessionStatus>;
		roots?: boolean;
	}): Promise<SessionInfo[]>;
	searchSessions(
		query: string,
		options?: { roots?: boolean },
	): Promise<SessionInfo[]>;
	loadPreRenderedHistory(
		sessionId: string,
		offset?: number,
	): Promise<{
		messages: HistoryMessage[];
		hasMore: boolean;
		total?: number;
	}>;
	getDefaultSessionId(title?: string): Promise<string>;
	getLastKnownSessionCount(): number;
	getSessionParentMap(): Map<string, string>;
	getLastMessageAtMap(): ReadonlyMap<string, number>;
	getForkEntry(sessionId: string): ForkEntry | undefined;

	// ── Mutations ──────────────────────────────────────────────────────
	createSession(
		title?: string,
		opts?: { silent?: boolean },
	): Promise<SessionDetail>;
	deleteSession(sessionId: string, opts?: { silent?: boolean }): Promise<void>;
	renameSession(sessionId: string, title: string): Promise<void>;
	initialize(title?: string): Promise<string>;
	recordMessageActivity(sessionId: string, timestamp?: number): void;
	addToParentMap(childId: string, parentId: string): void;
	setForkEntry(sessionId: string, entry: ForkEntry): void;

	// ── Pagination ─────────────────────────────────────────────────────
	clearPaginationCursor(sessionId: string): void;
	seedPaginationCursor(sessionId: string, messageId: string): void;

	// ── Pending questions ──────────────────────────────────────────────
	incrementPendingQuestionCount(sessionId: string): void;
	decrementPendingQuestionCount(sessionId: string): void;
	setPendingQuestionCounts(counts: Map<string, number>): void;

	// ── Broadcasts ─────────────────────────────────────────────────────
	sendDualSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: { statuses?: Record<string, SessionStatus> | undefined },
	): Promise<void>;

	// ── EventEmitter (used by session-lifecycle-wiring) ────────────────
	on(event: "broadcast", handler: (msg: RelayMessage) => void): this;
	on(
		event: "session_lifecycle",
		handler: (
			ev:
				| { type: "created"; sessionId: string }
				| { type: "deleted"; sessionId: string },
		) => void,
	): this;
	off(event: "broadcast", handler: (msg: RelayMessage) => void): this;
	off(
		event: "session_lifecycle",
		handler: (
			ev:
				| { type: "created"; sessionId: string }
				| { type: "deleted"; sessionId: string },
		) => void,
	): this;
}

// ─── Core Tags (always present) ────────────────────────────────────────────

export class OpenCodeAPITag extends Context.Tag("OpenCodeAPI")<
	OpenCodeAPITag,
	OpenCodeAPI
>() {}

export type OpenCodeFileEntry = Awaited<
	ReturnType<OpenCodeAPI["file"]["list"]>
>[number];
export type OpenCodeFileContent = Awaited<
	ReturnType<OpenCodeAPI["file"]["read"]>
>;

export interface OpenCodeFileService {
	list(
		path: string,
	): Effect.Effect<OpenCodeFileEntry[], Cause.UnknownException>;
	read(
		path: string,
	): Effect.Effect<OpenCodeFileContent, Cause.UnknownException>;
}

export class OpenCodeFileServiceTag extends Context.Tag("OpenCodeFileService")<
	OpenCodeFileServiceTag,
	OpenCodeFileService
>() {}

export const OpenCodeFileServiceLive: Layer.Layer<
	OpenCodeFileServiceTag,
	never,
	OpenCodeAPITag
> = Layer.effect(
	OpenCodeFileServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		return {
			list: (path: string) => Effect.tryPromise(() => client.file.list(path)),
			read: (path: string) => Effect.tryPromise(() => client.file.read(path)),
		};
	}),
);

export class SessionManagerTag extends Context.Tag("SessionManager")<
	SessionManagerTag,
	SessionManagerShape
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

export class OrchestrationEngineTag extends Context.Tag("OrchestrationEngine")<
	OrchestrationEngineTag,
	OrchestrationEngine
>() {}

export class TranslatorTag extends Context.Tag("Translator")<
	TranslatorTag,
	Translator
>() {}

// ─── Persistence extension Tags (when SQLite configured) ───────────────────

export class ReadQueryTag extends Context.Tag("ReadQuery")<
	ReadQueryTag,
	ReadQueryService
>() {}

export class ClaudeEventPersistTag extends Context.Tag("ClaudeEventPersist")<
	ClaudeEventPersistTag,
	LegacyRelayEventSinkPersist
>() {}

export class ProviderStateServiceTag extends Context.Tag(
	"ProviderStateService",
)<ProviderStateServiceTag, ProviderStateService>() {}

// ─── Daemon lifecycle Tags ────────────────────────────────────────────────

// ShutdownSignalTag moved to daemon-layers.ts to break circular dependency.
// Import it directly from daemon-layers.ts if needed.

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
				? SessionManagerShape
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
																				? LegacyRelayEventSinkPersist
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
// NOTE: SupervisorTag intentionally NOT re-exported here — import directly
// from daemon-main.js. Re-exporting created a circular dependency:
//   services → daemon-main → daemon-layers → services (ShutdownSignalTag undefined)
export { DaemonEventBusTag } from "./daemon-pubsub.js";
export { CrashCounterTag } from "./daemon-startup.js";
// ─── DaemonState re-export ────────────────────────────────────────────────
export { DaemonStateTag } from "./daemon-state.js";
export { InstanceManagerStateTag } from "./instance-manager-service.js";
export { PollerManagerStateTag } from "./message-poller.js";
export { IdempotencySetTag } from "./orchestration-service.js";
export { PersistenceServiceTag } from "./persistence-service.js";
export { ProjectRegistryTag } from "./project-registry-service.js";
export { PushManagerTag } from "./push-service.js";
export { RateLimiterTag } from "./rate-limiter-layer.js";
export { RelayCacheTag } from "./relay-cache.js";
export { HttpServerRefTag, RelayFactoryTag } from "./relay-factory-layer.js";
// ─── Phase 2 Effect-native Tag re-exports ─────────────────────────────────
export { SessionManagerStateTag } from "./session-manager-state.js";
export { OverridesStateTag } from "./session-overrides-state.js";
export { SessionRegistryStateTag } from "./session-registry-state.js";
export { PollerPubSubTag, PollerStateTag } from "./session-status-poller.js";
