import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { Context, Effect, HashMap, Layer, type Option, Ref } from "effect";
import {
	isKnownDriverKind,
	type ProviderDriverKind,
	type ProviderInstanceId,
} from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveInstanceDriver,
} from "../../../daemon/config-persistence.js";
import {
	type ForkEntry,
	loadForkMetadata,
} from "../../../daemon/fork-metadata.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import type { Logger } from "../../../logger.js";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
} from "../../../persistence/effect/event-store-effect.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../persistence/effect/projection-runner-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { HistoryMessage } from "../../../shared-types.js";
import type { RelayMessage, SessionInfo } from "../../../types.js";
import {
	DaemonEventBusTag,
	publishSessionCreated,
	publishSessionDeleted,
} from "../../daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	type OpenCodeInstanceClients,
	OpenCodeInstanceClientsTag,
} from "./opencode-instance-clients.js";
import { RelayStatusSnapshotTag } from "./relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "./services.js";
import {
	applySessionCommand,
	createOpenCodeSession,
	normalizeSessionTitle,
} from "./session-command.js";
import { SessionManagerError } from "./session-manager-error.js";
import {
	CURSOR_SCAN_LIMIT,
	clearPaginationCursor,
	loadPreRenderedHistory,
	seedPaginationCursor,
} from "./session-manager-history.js";
import {
	incrementLastKnownSessionCount,
	makeSessionListOperations,
	sessionDetailsParentMap,
	sessionExists,
	updateRelaySessionCountSnapshot,
} from "./session-manager-list.js";
import { SessionManagerStateTag } from "./session-manager-state.js";
import {
	addToParentMap,
	decrementPendingQuestionCount,
	getLastKnownSessionCount,
	getSessionParentMap,
	incrementPendingQuestionCount,
	recordMessageActivity,
	setForkEntry,
	setPendingQuestionCounts,
} from "./session-manager-state-operations.js";
import {
	markSessionRead,
	markSessionUnread,
	renameSession,
	setSessionAutoSettleDisabled,
	setSessionPinned,
	setSessionSettled,
	snoozeSession,
	unsnoozeSession,
} from "./session-manager-triage.js";
import { OverridesStateTag } from "./session-overrides-state.js";

const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SDK_PROVIDER_ID = "claude-sdk";

export type ListSessionsOptions = {
	limit?: number;
	roots?: boolean;
	statuses?: Record<string, SessionStatus> | undefined;
	hasLiveBackgroundWork?: (sessionId: string) => boolean;
};

type SessionListMessage = Extract<RelayMessage, { type: "session_list" }>;

export interface CreateSessionOptions {
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
}

export interface HistoryPage {
	messages: HistoryMessage[];
	hasMore: boolean;
	total?: number;
}

export interface LoadHistoryOptions {
	historyPageSize?: number;
}

export interface SetSessionSettledOptions {
	readonly settled: boolean;
	readonly automatic?: boolean;
}

/**
 * Initialize session state from the provider and return the most recent session,
 * creating one when none exists.
 */
export const initialize = (title?: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const existing = yield* Effect.tryPromise(() =>
			api.session.list({ limit: CURSOR_SCAN_LIMIT }),
		).pipe(
			Effect.mapError(
				(cause) => new SessionManagerError({ operation: "initialize", cause }),
			),
		);

		yield* Ref.update(stateRef, (s) => {
			let lastMessageAt = s.lastMessageAt;
			for (const session of existing) {
				const ts = session.time?.updated ?? session.time?.created ?? 0;
				if (ts > 0) {
					const current = HashMap.get(lastMessageAt, session.id);
					if (current._tag === "None" || ts > current.value) {
						lastMessageAt = HashMap.set(lastMessageAt, session.id, ts);
					}
				}
			}
			return {
				...s,
				cachedParentMap: sessionDetailsParentMap(existing),
				lastMessageAt,
				lastKnownSessionCount: existing.length,
			};
		});
		yield* updateRelaySessionCountSnapshot(existing.length);

		if (existing.length > 0) {
			const sorted = [...existing].sort((a, b) => {
				const aTime = a.time?.updated ?? a.time?.created ?? 0;
				const bTime = b.time?.updated ?? b.time?.created ?? 0;
				return bTime - aTime;
			});
			return sorted[0]?.id ?? "";
		}

		// Same seam as every other create: this path used to call the provider
		// and record nothing, so the session it returned was invisible to
		// listSessions until a poller happened to pick it up.
		const session = yield* createOpenCodeSession(title, "opencode").pipe(
			Effect.provideService(OpenCodeAPITag, api),
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "getDefaultSessionId", cause }),
			),
		);
		yield* Ref.update(stateRef, (s) => ({
			...s,
			lastKnownSessionCount: 1,
		}));
		yield* updateRelaySessionCountSnapshot(1);
		return session.id;
	}).pipe(Effect.withSpan("session.initialize"));

/**
 * Create a new session via the API.
 */
const createLocalSessionId = (): string =>
	`ses_${randomUUID().replaceAll("-", "")}`;

const getLocalSessionProvider = () =>
	Effect.gen(function* () {
		const configuredProvider = yield* getConfiguredLocalSessionProvider();
		return configuredProvider ?? "claude";
	});

const getConfiguredLocalSessionProvider = () =>
	Effect.gen(function* () {
		const overridesOption = yield* Effect.serviceOption(OverridesStateTag);
		if (overridesOption._tag === "Some") {
			const state = yield* Ref.get(overridesOption.value);
			return state.defaultModel?.providerID;
		}
		return undefined;
	});

const createLocalSession = (
	title?: string,
	selectedInstanceId?: ProviderInstanceId,
) =>
	Effect.gen(function* () {
		const configOption = yield* Effect.serviceOption(ConfigTag);

		const provider =
			selectedInstanceId === undefined
				? yield* getLocalSessionProvider()
				: selectedInstanceId;
		const sessionId = createLocalSessionId();
		const now = Date.now();
		const sessionTitle = normalizeSessionTitle(title);

		// The id is chosen here rather than upstream, so creation is one command:
		// the seam appends session.created and the projector's upsert is what
		// brings the sessions row into being.
		yield* applySessionCommand({
			type: "session.created",
			data: { sessionId, title: sessionTitle, provider },
		}).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "createLocalSession", cause }),
			),
		);

		return {
			id: sessionId,
			projectID: "",
			directory:
				configOption._tag === "Some" ? configOption.value.projectDir : "",
			title: sessionTitle,
			version: "",
			time: { created: now, updated: now },
			providerID: provider,
		} satisfies SessionDetail;
	}).pipe(Effect.withSpan("session.createLocalSession"));

/** Delete a session locally, then best-effort upstream, and clear associated state. */
export const deleteSession = (sessionId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;

		yield* applySessionCommand({
			type: "session.deleted",
			data: { sessionId },
		}).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "deleteSession", cause }),
			),
		);

		yield* Ref.update(stateRef, (s) => {
			let cachedParentMap = HashMap.remove(s.cachedParentMap, sessionId);
			const lastMessageAt = HashMap.remove(s.lastMessageAt, sessionId);
			const forkMeta = HashMap.remove(s.forkMeta, sessionId);
			const pendingQuestionCounts = HashMap.remove(
				s.pendingQuestionCounts,
				sessionId,
			);
			const paginationCursors = HashMap.remove(s.paginationCursors, sessionId);

			// Also remove any entries where this session was a parent
			cachedParentMap = HashMap.filter(
				cachedParentMap,
				(parent) => parent !== sessionId,
			);

			return {
				cachedParentMap,
				lastMessageAt,
				forkMeta,
				pendingQuestionCounts,
				paginationCursors,
				lastKnownSessionCount: Math.max(0, s.lastKnownSessionCount - 1),
			};
		});
		const state = yield* Ref.get(stateRef);
		yield* updateRelaySessionCountSnapshot(state.lastKnownSessionCount);
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.deleteSession", { attributes: { sessionId } }),
	);

export interface SessionManagerService {
	initialize(title?: string): Effect.Effect<string, SessionManagerError>;
	getDefaultSessionId(
		title?: string,
	): Effect.Effect<string, SessionManagerError>;
	getLastKnownSessionCount(): Effect.Effect<number>;
	listSessions(
		options?: ListSessionsOptions,
	): Effect.Effect<SessionInfo[], SessionManagerError>;
	sessionExists(sessionId: string): Effect.Effect<boolean, SessionManagerError>;
	getSessionFamily(
		sessionId: string,
	): Effect.Effect<
		Extract<RelayMessage, { type: "session_family" }>,
		SessionManagerError
	>;
	createSession(
		title?: string,
		options?: CreateSessionOptions,
	): Effect.Effect<SessionDetail, SessionManagerError>;
	deleteSession(sessionId: string): Effect.Effect<void, SessionManagerError>;
	renameSession(
		sessionId: string,
		title: string,
	): Effect.Effect<void, SessionManagerError>;
	markSessionRead(sessionId: string): Effect.Effect<void, SessionManagerError>;
	setSessionSettled(
		sessionId: string,
		options: SetSessionSettledOptions,
	): Effect.Effect<boolean, SessionManagerError>;
	setSessionAutoSettleDisabled(
		sessionId: string,
		disabled: boolean,
	): Effect.Effect<boolean, SessionManagerError>;
	setSessionPinned(
		sessionId: string,
		pinned: boolean,
	): Effect.Effect<boolean, SessionManagerError>;
	snoozeSession(
		sessionId: string,
		until: number | null,
	): Effect.Effect<boolean, SessionManagerError>;
	unsnoozeSession(
		sessionId: string,
	): Effect.Effect<boolean, SessionManagerError>;
	markSessionUnread(
		sessionId: string,
	): Effect.Effect<void, SessionManagerError>;
	clearPaginationCursor(sessionId: string): Effect.Effect<void>;
	seedPaginationCursor(
		sessionId: string,
		messageId: string,
	): Effect.Effect<void>;
	loadPreRenderedHistory(
		sessionId: string,
		offset?: number,
	): Effect.Effect<HistoryPage, SessionManagerError>;
	recordMessageActivity(
		sessionId: string,
		timestamp?: number,
	): Effect.Effect<void>;
	addToParentMap(childId: string, parentId: string): Effect.Effect<void>;
	getSessionParentMap(): Effect.Effect<Map<string, string>>;
	incrementPendingQuestionCount(sessionId: string): Effect.Effect<void>;
	decrementPendingQuestionCount(sessionId: string): Effect.Effect<void>;
	setPendingQuestionCounts(
		counts: ReadonlyMap<string, number>,
	): Effect.Effect<void>;
	setForkEntry(
		sessionId: string,
		entry: ForkEntry,
	): Effect.Effect<void, SessionManagerError>;
	sendSessionLists(
		send: (msg: SessionListMessage) => void,
		options?: { statuses?: Record<string, SessionStatus> | undefined },
	): Effect.Effect<void, SessionManagerError>;
}

// ─── Service Tag ────────────────────────────────────────────────────────────

/** Bundled service object for callers that prefer DI over free functions. */
export class SessionManagerServiceTag extends Context.Tag(
	"SessionManagerService",
)<SessionManagerServiceTag, SessionManagerService>() {}

const makeServiceCreateSession = ({
	api,
	engine,
	configDir,
	instanceClientsOption,
	readQuery,
	eventStore,
	projectionRunner,
	sql,
	log,
}: {
	api: OpenCodeAPI;
	engine: OrchestrationEngine;
	configDir: string | undefined;
	instanceClientsOption: Option.Option<OpenCodeInstanceClients>;
	readQuery: ReadQueryEffect;
	eventStore: EventStoreEffect;
	projectionRunner: ProjectionRunnerEffect;
	sql: SqlClient.SqlClient;
	log: Logger;
}) => {
	const serviceCreateSession = (
		title?: string,
		options?: CreateSessionOptions,
	) =>
		Effect.gen(function* () {
			const bindSessionProvider = (
				session: SessionDetail,
				providerId: string,
			) =>
				Effect.sync(() => {
					engine.bindSession(session.id, providerId);
				});
			const resolveSelectedDriver = (
				instanceId: ProviderInstanceId,
			): Effect.Effect<ProviderDriverKind, SessionManagerError> =>
				Effect.gen(function* () {
					const daemonConfig = loadDaemonConfig(configDir);
					if (daemonConfig !== null) {
						return resolveInstanceDriver(daemonConfig, instanceId);
					}
					if (isKnownDriverKind(instanceId)) {
						return instanceId;
					}
					return yield* new SessionManagerError({
						operation: "createSession.resolveInstanceDriver",
						cause: `Cannot resolve provider instance without daemon config: ${instanceId}`,
					});
				});
			const createViaOpenCode = (instanceId?: ProviderInstanceId) =>
				Effect.either(
					Effect.gen(function* () {
						// A session bound to a NAMED OpenCode instance is
						// created on THAT instance's server; the default id (and
						// wirings without the instance-clients service, e.g. legacy
						// or unit harnesses) use the project-default client. A named
						// instance that cannot be resolved fails the create cleanly
						// instead of silently landing on the default server.
						const instanceApi =
							instanceId !== undefined && instanceClientsOption._tag === "Some"
								? yield* instanceClientsOption.value.clientFor(instanceId).pipe(
										Effect.mapError(
											(cause) =>
												new SessionManagerError({
													operation: "createSession.resolveInstanceClient",
													cause,
												}),
										),
									)
								: undefined;
						return yield* createOpenCodeSession(
							title,
							instanceId ?? "opencode",
						).pipe(
							Effect.provideService(OpenCodeAPITag, instanceApi ?? api),
							Effect.provideService(ReadQueryEffectTag, readQuery),
							Effect.provideService(EventStoreEffectTag, eventStore),
							Effect.provideService(
								ProjectionRunnerEffectTag,
								projectionRunner,
							),
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.mapError(
								(cause) =>
									new SessionManagerError({
										operation: "createSession",
										cause,
									}),
							),
						);
					}),
				);
			const createViaLocal = (instanceId?: ProviderInstanceId) =>
				Effect.either(
					createLocalSession(title, instanceId).pipe(
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
					),
				);

			const selectedInstanceId = options?.instanceId;
			if (selectedInstanceId !== undefined) {
				const selectedDriver = yield* resolveSelectedDriver(selectedInstanceId);
				if (selectedDriver === CLAUDE_PROVIDER_ID) {
					const localResult = yield* createViaLocal(selectedInstanceId);
					if (localResult._tag === "Right") {
						yield* bindSessionProvider(localResult.right, selectedInstanceId);
						return localResult.right;
					}
					return yield* new SessionManagerError({
						operation: "createSession",
						cause: localResult.left,
					});
				}
				if (selectedDriver === "opencode") {
					const openCodeResult = yield* createViaOpenCode(selectedInstanceId);
					if (openCodeResult._tag === "Right") {
						yield* bindSessionProvider(
							openCodeResult.right,
							selectedInstanceId,
						);
						return openCodeResult.right;
					}
					return yield* new SessionManagerError({
						operation: "createSession",
						cause: openCodeResult.left,
					});
				}
				return yield* new SessionManagerError({
					operation: "createSession",
					cause: `Unsupported provider driver for instance ${selectedInstanceId}: ${selectedDriver}`,
				});
			}

			const requestedProvider = options?.providerId?.trim();
			const requestedLocalProvider =
				requestedProvider === CLAUDE_PROVIDER_ID ||
				requestedProvider === CLAUDE_SDK_PROVIDER_ID;
			if (requestedProvider && !requestedLocalProvider) {
				const openCodeResult = yield* createViaOpenCode();
				if (openCodeResult._tag === "Right") {
					yield* bindSessionProvider(openCodeResult.right, "opencode");
					return openCodeResult.right;
				}
				return yield* new SessionManagerError({
					operation: "createSession",
					cause: openCodeResult.left,
				});
			}

			const configuredProvider = yield* getConfiguredLocalSessionProvider();
			if (
				configuredProvider == null ||
				configuredProvider === CLAUDE_PROVIDER_ID
			) {
				const localResult = yield* createViaLocal();
				if (localResult._tag === "Right") {
					yield* bindSessionProvider(localResult.right, "claude");
					return localResult.right;
				}

				log.warn(
					`Relay-owned Claude session create failed; falling back to OpenCode session create: ${localResult.left}`,
				);
				const openCodeResult = yield* createViaOpenCode();
				if (openCodeResult._tag === "Right") {
					yield* bindSessionProvider(openCodeResult.right, "opencode");
					return openCodeResult.right;
				}

				return yield* new SessionManagerError({
					operation: "createSession",
					cause: {
						local: localResult.left,
						openCode: openCodeResult.left,
					},
				});
			}

			const openCodeResult = yield* createViaOpenCode();
			if (openCodeResult._tag === "Right") {
				yield* bindSessionProvider(openCodeResult.right, "opencode");
				return openCodeResult.right;
			}

			log.warn(
				`OpenCode session create failed; creating relay-owned session: ${openCodeResult.left}`,
			);
			const localResult = yield* createViaLocal();
			if (localResult._tag === "Right") {
				if (localResult.right.providerID === CLAUDE_PROVIDER_ID) {
					yield* bindSessionProvider(localResult.right, "claude");
				}
				return localResult.right;
			}

			return yield* new SessionManagerError({
				operation: "createSession",
				cause: {
					openCode: openCodeResult.left,
					local: localResult.left,
				},
			});
		});
	return serviceCreateSession;
};

// ─── Service Layer ──────────────────────────────────────────────────────────

export const SessionManagerServiceLive: Layer.Layer<
	SessionManagerServiceTag,
	never,
	| OpenCodeAPITag
	| SessionManagerStateTag
	| LoggerTag
	| DaemonEventBusTag
	| OrchestrationEngineTag
	| ReadQueryEffectTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| SqlClient.SqlClient
> = Layer.effect(
	SessionManagerServiceTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const eventBus = yield* DaemonEventBusTag;
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const configDir =
			configOption._tag === "Some" ? configOption.value.configDir : undefined;
		const engine = yield* OrchestrationEngineTag;
		const readQuery = yield* ReadQueryEffectTag;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const statusPollerOption = yield* Effect.serviceOption(StatusPollerTag);
		const backgroundLivenessOption = yield* Effect.serviceOption(
			BackgroundLivenessTag,
		);
		const hasLiveBackgroundWork =
			backgroundLivenessOption._tag === "Some"
				? backgroundLivenessOption.value
				: undefined;
		const wsHandlerOption = yield* Effect.serviceOption(WebSocketHandlerTag);
		const snapshotOption = yield* Effect.serviceOption(RelayStatusSnapshotTag);
		const instanceClientsOption = yield* Effect.serviceOption(
			OpenCodeInstanceClientsTag,
		);
		if (configOption._tag === "Some") {
			const forkMeta = loadForkMetadata(configDir);
			if (forkMeta.size > 0) {
				yield* Ref.update(stateRef, (s) => {
					let nextForkMeta = s.forkMeta;
					for (const [sessionId, entry] of forkMeta) {
						nextForkMeta = HashMap.set(nextForkMeta, sessionId, entry);
					}
					return { ...s, forkMeta: nextForkMeta };
				});
			}
		}
		const { serviceListSessions, getSessionFamily, serviceSendSessionLists } =
			makeSessionListOperations({
				api,
				stateRef,
				readQuery,
				statusPollerOption,
				hasLiveBackgroundWork,
				snapshotOption,
				wsHandlerOption,
			});
		const serviceCreateSession = makeServiceCreateSession({
			api,
			engine,
			configDir,
			instanceClientsOption,
			readQuery,
			eventStore,
			projectionRunner,
			sql,
			log,
		});

		const withSessionCommandServices = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				| OpenCodeAPITag
				| ReadQueryEffectTag
				| EventStoreEffectTag
				| ProjectionRunnerEffectTag
				| SqlClient.SqlClient
			>,
		): Effect.Effect<A, E> => {
			return effect.pipe(
				Effect.provideService(OpenCodeAPITag, api),
				Effect.provideService(ReadQueryEffectTag, readQuery),
				Effect.provideService(EventStoreEffectTag, eventStore),
				Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
				Effect.provideService(SqlClient.SqlClient, sql),
			);
		};

		const triageLock = yield* Effect.makeSemaphore(1);
		return {
			getDefaultSessionId: (title) =>
				Effect.gen(function* () {
					const sessions = yield* serviceListSessions();
					if (sessions.length > 0) {
						const topLevel = sessions.find((session) => !session.parentID);
						return (topLevel ?? sessions[0])?.id ?? "";
					}
					const session = yield* serviceCreateSession(title);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
					);
					yield* publishSessionCreated(session.id).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
					return session.id;
				}),
			initialize: (title) =>
				Effect.gen(function* () {
					const sessions = yield* serviceListSessions();
					if (sessions.length > 0) {
						const sorted = [...sessions].sort(
							(a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0),
						);
						return sorted[0]?.id ?? "";
					}
					const session = yield* serviceCreateSession(title);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
					);
					yield* updateRelaySessionCountSnapshot(1);
					return session.id;
				}),
			getLastKnownSessionCount: () =>
				getLastKnownSessionCount().pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			listSessions: serviceListSessions,
			sessionExists: (sessionId) =>
				sessionExists(sessionId).pipe(
					Effect.provideService(ReadQueryEffectTag, readQuery),
				),
			getSessionFamily,
			createSession: (title, options) =>
				Effect.gen(function* () {
					const session = yield* serviceCreateSession(title, options);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
					);
					yield* publishSessionCreated(session.id).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
					return session;
				}),
			deleteSession: (sessionId) =>
				Effect.gen(function* () {
					yield* deleteSession(sessionId).pipe(
						Effect.provideService(OpenCodeAPITag, api),
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					yield* publishSessionDeleted(sessionId).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
				}),
			renameSession: (sessionId, title) =>
				withSessionCommandServices(renameSession(sessionId, title)),
			markSessionRead: (sessionId) =>
				withSessionCommandServices(markSessionRead(sessionId)),
			markSessionUnread: (sessionId) =>
				withSessionCommandServices(markSessionUnread(sessionId)),
			setSessionSettled: (sessionId, options) =>
				triageLock.withPermits(1)(
					withSessionCommandServices(setSessionSettled(sessionId, options)),
				),
			setSessionAutoSettleDisabled: (sessionId, disabled) =>
				triageLock.withPermits(1)(
					withSessionCommandServices(
						setSessionAutoSettleDisabled(sessionId, disabled),
					),
				),
			setSessionPinned: (sessionId, pinned) =>
				triageLock.withPermits(1)(
					withSessionCommandServices(setSessionPinned(sessionId, pinned)),
				),
			snoozeSession: (sessionId, until) =>
				triageLock.withPermits(1)(
					withSessionCommandServices(snoozeSession(sessionId, until)),
				),
			unsnoozeSession: (sessionId) =>
				triageLock.withPermits(1)(
					withSessionCommandServices(unsnoozeSession(sessionId)),
				),
			clearPaginationCursor: (sessionId) =>
				clearPaginationCursor(sessionId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			seedPaginationCursor: (sessionId, messageId) =>
				seedPaginationCursor(sessionId, messageId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			loadPreRenderedHistory: (sessionId, offset) =>
				loadPreRenderedHistory(sessionId, offset).pipe(
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
					Effect.provideService(LoggerTag, log),
				),
			recordMessageActivity: (sessionId, timestamp) =>
				recordMessageActivity(sessionId, timestamp).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			addToParentMap: (childId, parentId) =>
				addToParentMap(childId, parentId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			getSessionParentMap: () =>
				getSessionParentMap().pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			incrementPendingQuestionCount: (sessionId) =>
				incrementPendingQuestionCount(sessionId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			decrementPendingQuestionCount: (sessionId) =>
				decrementPendingQuestionCount(sessionId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			setPendingQuestionCounts: (counts) =>
				setPendingQuestionCounts(counts).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			setForkEntry: (sessionId, entry) =>
				Effect.gen(function* () {
					yield* setForkEntry(sessionId, entry, configDir).pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
					);
				}),
			sendSessionLists: serviceSendSessionLists,
		} satisfies SessionManagerService;
	}),
);
