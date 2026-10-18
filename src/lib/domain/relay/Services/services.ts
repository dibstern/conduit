// Context.Tag definitions for every service in HandlerDeps.
// Type-level foundation for Effect dependency injection — no runtime wiring.
//
// Each Tag maps 1:1 to a field in HandlerDeps (src/lib/handlers/types.ts).
// For importable classes/interfaces the concrete type is used directly.
// For inline/structural types a Shape interface is defined here.

import { type Cause, Context, Effect, Layer, Option } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../contracts/provider-instance.js";
import * as Failure from "../../../effect/failure-classification.js";

import type {
	HandlerDeps,
	InstanceManagementDeps,
	ProjectManagementDeps,
} from "../../../handlers/types.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import { fixupConfigFile } from "../../../instance/opencode-config-fixup.js";
import type {
	Message,
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import type { Logger } from "../../../logger.js";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { Translator } from "../../../relay/event-translator.js";
import type { PtyManager } from "../../../relay/pty-manager.js";
import type { WebSocketHandlerShape } from "../../../server/ws-handler-shape.js";
import type { SessionBackground } from "../../../session/background-liveness.js";
import type { HistoryMessage } from "../../../shared-types.js";
import type {
	ProjectRelayConfig,
	RelayMessage,
	SessionInfo,
} from "../../../types.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import type { SessionStatusPollerService } from "./session-status-poller.js";

export type { WebSocketHandlerShape };

/** Shape for the statusPoller field — methods needed by relay effects and lifecycle wiring. */
export type StatusPollerShape = Pick<
	SessionStatusPollerService,
	| "clearMessageActivity"
	| "drain"
	| "getCurrentStatuses"
	| "getSessionProviders"
	| "isProcessing"
	| "markMessageActivity"
	| "notifySSEIdle"
	| "on"
	| "start"
	| "stop"
>;

/** Shape for the pollerManager field — isPolling + startPolling capabilities. */
export interface PollerManagerShape {
	on(
		event: "events",
		callback: (
			messages: RelayMessage[],
			sessionId: string,
			hasActivity?: boolean,
		) => void,
	): void;
	isPolling(sessionId: string): boolean;
	startPolling(sessionId: string, seedMessages?: Message[]): void;
	stopPolling(sessionId: string): void;
	notifySSEEvent(sessionId: string): void;
}

/** Shape for the connectPtyUpstream function. */
export type ConnectPtyUpstreamShape = (
	ptyId: string,
	cursor?: number,
) => Effect.Effect<void, unknown>;

/**
 * Shape for the sessionMgr field — all SessionManager capabilities used
 * by handlers and wiring modules.
 *
 * Replaces the concrete SessionManager class import so consumers depend
 * on a structural interface, not the implementation.
 */
export interface SessionManagerShape {
	listSessions(options?: {
		statuses?: Record<string, SessionStatus>;
		roots?: boolean;
	}): Promise<SessionInfo[]>;
	searchSessions(
		query: string,
		options?: { roots?: boolean },
	): Promise<SessionInfo[]>;
	loadPreRenderedHistory(sessionId: string): Promise<{
		messages: HistoryMessage[];
		hasMore: boolean;
		total?: number;
	}>;
	getDefaultSessionId(title?: string): Promise<string>;
	getLastKnownSessionCount(): number;
	getSessionParentMap(options?: {
		readonly activityOnly?: boolean;
	}): Map<string, string>;
	getLastMessageAtMap(): ReadonlyMap<string, number>;

	createSession(
		title?: string,
		opts?: { silent?: boolean },
	): Promise<SessionDetail>;
	deleteSession(sessionId: string, opts?: { silent?: boolean }): Promise<void>;
	renameSession(sessionId: string, title: string): Promise<void>;
	initialize(title?: string): Promise<string>;
	recordMessageActivity(sessionId: string, timestamp?: number): void;
	addToParentMap(childId: string, parentId: string): void;
}

// Core Tags (always present)

export type OpenCodeFileEntry = Awaited<
	ReturnType<OpenCodeAPI["file"]["list"]>
>[number];
export type OpenCodeFileContent = Awaited<
	ReturnType<OpenCodeAPI["file"]["read"]>
>;
export type OpenCodeProviderList = Awaited<
	ReturnType<OpenCodeAPI["provider"]["list"]>
> & { readonly nativeDefaultModel?: string };
export type OpenCodeCommandList = Awaited<
	ReturnType<OpenCodeAPI["app"]["commands"]>
>;
export type OpenCodeProjectList = Awaited<
	ReturnType<OpenCodeAPI["app"]["projects"]>
>;

export interface OpenCodeFileService {
	list(
		path: string,
		directory?: string,
		options?: { readonly startIfStopped?: boolean },
	): Effect.Effect<OpenCodeFileEntry[], Cause.UnknownError>;
	read(
		path: string,
		directory?: string,
		options?: { readonly startIfStopped?: boolean },
	): Effect.Effect<OpenCodeFileContent, Cause.UnknownError>;
}

export class OpenCodeFileServiceTag extends Context.Service<
	OpenCodeFileServiceTag,
	OpenCodeFileService
>()("OpenCodeFileService") {}

export const OpenCodeFileServiceLive: Layer.Layer<
	OpenCodeFileServiceTag,
	never,
	OpenCodeAPITag | OpenCodeInstancesTag
> = Layer.effect(
	OpenCodeFileServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const instances = yield* OpenCodeInstancesTag;
		const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
		return {
			list: (
				path: string,
				directory?: string,
				{ startIfStopped = true } = {},
			) =>
				Effect.gen(function* () {
					const available = startIfStopped
						? Option.some(client)
						: yield* instances.ifRunning(instanceId);
					if (Option.isNone(available)) return [];
					return yield* Effect.tryPromise((signal) =>
						available.value.file.list(path, { signal, directory }),
					);
				}).pipe(Effect.scoped),
			read: (
				path: string,
				directory?: string,
				{ startIfStopped = true } = {},
			) =>
				Effect.gen(function* () {
					const available = startIfStopped
						? Option.some(client)
						: yield* instances.ifRunning(instanceId);
					if (Option.isNone(available)) return { content: "" };
					return yield* Effect.tryPromise((signal) =>
						available.value.file.read(path, { signal, directory }),
					);
				}).pipe(Effect.scoped),
		};
	}),
);

/** The canonical id names this relay's configured OpenCode default. */
export const openCodeInstanceTarget =
	(defaultInstanceId: string) => (instanceId: string) =>
		instanceId === MANAGED_OPENCODE_ACCOUNT_ID ? defaultInstanceId : instanceId;

export interface OpenCodeModelService {
	/** Uses cached/empty data while stopped unless an interactive caller opts in. */
	listProviders(options?: {
		readonly startIfStopped?: boolean;
		readonly instanceId?: string;
		readonly requireFresh?: boolean;
	}): Effect.Effect<OpenCodeProviderList, Cause.UnknownError>;
	/** The last catalog listProviders returned. Never contacts OpenCode. */
	cachedProviders(
		instanceId?: string,
	): Effect.Effect<Option.Option<OpenCodeProviderList>>;
	persistDefaultModel(
		providerID: string,
		modelID: string,
	): Effect.Effect<void, Cause.UnknownError>;
}

export class OpenCodeModelServiceTag extends Context.Service<
	OpenCodeModelServiceTag,
	OpenCodeModelService
>()("OpenCodeModelService") {}

export const OpenCodeModelServiceLive: Layer.Layer<
	OpenCodeModelServiceTag,
	never,
	OpenCodeAPITag | OpenCodeInstancesTag | ConfigTag | LoggerTag
> = Layer.effect(
	OpenCodeModelServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const instances = yield* OpenCodeInstancesTag;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const defaultInstanceId =
			config.openCodeInstanceId ?? MANAGED_OPENCODE_ACCOUNT_ID;
		const target = openCodeInstanceTarget(defaultInstanceId);
		const catalogs = new Map<string, OpenCodeProviderList>();
		const refresh = (
			opencode: OpenCodeAPI,
			instanceId: string,
			requireFresh: boolean,
		) =>
			Effect.gen(function* () {
				const cached = catalogs.get(instanceId);
				const list = yield* Effect.tryPromise(() => opencode.provider.list());
				const nativeConfig = yield* Effect.result(
					Effect.tryPromise(() => opencode.config.get()),
				);
				const nativeDefaultModel =
					nativeConfig._tag === "Success"
						? typeof nativeConfig.success["model"] === "string"
							? nativeConfig.success["model"]
							: undefined
						: cached?.nativeDefaultModel;
				if (nativeConfig._tag === "Failure")
					log.warn("Failed to read OpenCode's native default model");
				const catalog = {
					...list,
					...(nativeDefaultModel === undefined ? {} : { nativeDefaultModel }),
				};
				catalogs.set(instanceId, catalog);
				return catalog;
			}).pipe(
				Effect.catch((error) => {
					const cached = catalogs.get(instanceId);
					return cached && !requireFresh
						? Effect.succeed(cached)
						: Effect.fail(error);
				}),
			);
		return {
			listProviders: ({
				startIfStopped = false,
				instanceId = defaultInstanceId,
				requireFresh = false,
			} = {}) =>
				Effect.gen(function* () {
					const targetId = target(instanceId);
					const running = startIfStopped
						? Option.some(
								yield* instances
									.use(targetId, config.projectDir)
									.pipe(Failure.mapEffectFailures(Failure.unknownError)),
							)
						: yield* instances.ifRunning(targetId, config.projectDir);
					if (Option.isSome(running))
						return yield* refresh(running.value, targetId, requireFresh);
					if (requireFresh)
						return yield* Effect.fail(
							Failure.unknownError("OpenCode is not running"),
						);
					return (
						catalogs.get(targetId) ?? {
							providers: [],
							defaults: {},
							connected: [],
						}
					);
				}).pipe(Effect.scoped),
			cachedProviders: (instanceId = defaultInstanceId) =>
				Effect.sync(() =>
					Option.fromNullishOr(catalogs.get(target(instanceId))),
				),
			persistDefaultModel: (providerID: string, modelID: string) =>
				Effect.tryPromise(async () => {
					await client.config.update({ model: `${providerID}/${modelID}` });
					await fixupConfigFile(config.projectDir, log);
				}),
		};
	}),
);

export interface OpenCodeSettingsService {
	listCommands(options?: {
		readonly startIfStopped?: boolean;
	}): Effect.Effect<OpenCodeCommandList, Cause.UnknownError>;
	listProjects(): Effect.Effect<OpenCodeProjectList, Cause.UnknownError>;
}

export class OpenCodeSettingsServiceTag extends Context.Service<
	OpenCodeSettingsServiceTag,
	OpenCodeSettingsService
>()("OpenCodeSettingsService") {}

export const OpenCodeSettingsServiceLive: Layer.Layer<
	OpenCodeSettingsServiceTag,
	never,
	OpenCodeAPITag | OpenCodeInstancesTag
> = Layer.effect(
	OpenCodeSettingsServiceTag,
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const instances = yield* OpenCodeInstancesTag;
		const instanceId = MANAGED_OPENCODE_ACCOUNT_ID;
		return {
			listCommands: ({ startIfStopped = true } = {}) =>
				Effect.gen(function* () {
					const available = startIfStopped
						? Option.some(client)
						: yield* instances.ifRunning(instanceId);
					if (Option.isNone(available)) return [];
					return yield* Effect.tryPromise(() => available.value.app.commands());
				}).pipe(Effect.scoped),
			listProjects: () => Effect.tryPromise(() => client.app.projects()),
		};
	}),
);

export class WebSocketHandlerTag extends Context.Service<
	WebSocketHandlerTag,
	WebSocketHandlerShape
>()("WebSocketHandler") {}

export class PtyManagerTag extends Context.Service<PtyManagerTag, PtyManager>()(
	"PtyManager",
) {}

export class ConfigTag extends Context.Service<ConfigTag, ProjectRelayConfig>()(
	"Config",
) {}

export class LoggerTag extends Context.Service<LoggerTag, Logger>()("Logger") {}

export class StatusPollerTag extends Context.Service<
	StatusPollerTag,
	StatusPollerShape
>()("StatusPoller") {}

export class BackgroundLivenessTag extends Context.Service<
	BackgroundLivenessTag,
	(sessionId: string) => SessionBackground | undefined
>()("BackgroundLiveness") {}

/** A Claude runtime's live task ids; see makeSessionBackgroundLiveness. */
export class LiveTaskListTag extends Context.Service<
	LiveTaskListTag,
	(
		sessionId: string,
	) =>
		| { readonly taskIds: ReadonlySet<string>; readonly since: number }
		| undefined
>()("LiveTaskList") {}

/** The compaction in progress per session; see makeSessionCompactions. */
export class SessionCompactionsTag extends Context.Service<
	SessionCompactionsTag,
	(sessionId: string) => string | undefined
>()("SessionCompactions") {}

/** The provider retry a session is waiting on; see makeSessionRetries. */
export class SessionRetriesTag extends Context.Service<
	SessionRetriesTag,
	(sessionId: string) => string | undefined
>()("SessionRetries") {}

export class PollerManagerTag extends Context.Service<
	PollerManagerTag,
	PollerManagerShape
>()("PollerManager") {}

export class ConnectPtyUpstreamTag extends Context.Service<
	ConnectPtyUpstreamTag,
	ConnectPtyUpstreamShape
>()("ConnectPtyUpstream") {}

export class OrchestrationEngineTag extends Context.Service<
	OrchestrationEngineTag,
	OrchestrationEngine
>()("OrchestrationEngine") {}

export class TranslatorTag extends Context.Service<TranslatorTag, Translator>()(
	"Translator",
) {}

export class ClientIdTag extends Context.Service<ClientIdTag, string>()(
	"ClientId",
) {}

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
				: K extends "ptyManager"
					? PtyManager
					: K extends "config"
						? ProjectRelayConfig
						: K extends "log"
							? Logger
							: K extends "statusPoller"
								? StatusPollerShape
								: K extends "pollerManager"
									? PollerManagerShape
									: K extends "connectPtyUpstream"
										? ConnectPtyUpstreamShape
										: K extends "instanceMgmt"
											? InstanceManagementDeps
											: K extends "projectMgmt"
												? ProjectManagementDeps
												: K extends "orchestrationEngine"
													? OrchestrationEngine
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

export { RateLimiterTag } from "../Layers/rate-limiter-layer.js";
export { PollerManagerStateTag } from "./message-poller.js";
export { SessionManagerStateTag } from "./session-manager-state.js";
export { OverridesStateTag } from "./session-overrides-state.js";
export { SessionRegistryStateTag } from "./session-registry-state.js";
export { PollerPubSubTag, PollerStateTag } from "./session-status-poller.js";
