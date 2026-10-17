import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
} from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../account-directory.js";
import type { Account } from "../../../contracts/account.js";
import { AccountUnroutable } from "../../../contracts/limit-recovery.js";
import {
	type AccountId,
	getProviderDriver,
	PROVIDER_DRIVERS,
} from "../../../contracts/provider-instance.js";
import { formatErrorDetail } from "../../../errors.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
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
import { canonicalEvent } from "../../../persistence/events.js";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import { removeRunnerSessionSends } from "../../../provider/runner/runner-send-journal.js";
import {
	isPickRejection,
	ModelNotInCatalog,
	type PickRejection,
	PickRequired,
	type TurnSettings,
} from "../../../provider/turn-settings.js";
import type {
	HistoryMessage,
	SessionPermissionMode,
} from "../../../shared-types.js";
import type { SessionInfo } from "../../../types.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import {
	DaemonEventBusTag,
	publishSessionCreated,
	publishSessionDeleted,
} from "../../daemon/Services/daemon-pubsub.js";
import {
	type OpenCodeInstances,
	OpenCodeInstancesTag,
} from "../../daemon/Services/opencode-instances-service.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { RelayStatusSnapshotTag } from "./relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	StatusPollerTag,
} from "./services.js";
import {
	applySessionCommand,
	createOpenCodeSession,
	normalizeSessionTitle,
	type SessionCommand,
	type SessionUpstreamAdapter,
	sessionUpstreamAdapter,
} from "./session-command.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { SessionManagerError } from "./session-manager-error.js";
import {
	CURSOR_SCAN_LIMIT,
	loadPreRenderedHistory,
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
	type ForkEntry,
	getLastKnownSessionCount,
	getSessionParentMap,
	recordMessageActivity,
	setForkEntry,
} from "./session-manager-state-operations.js";
import {
	markSessionRead,
	markSessionSeen,
	markSessionUnread,
	renameSession,
	setSessionAutoSettleDisabled,
	setSessionPinned,
	setSessionSettled,
	snoozeSession,
	unsnoozeSession,
} from "./session-manager-triage.js";
import {
	getDefaultPermissionMode,
	OverridesStateTag,
	setContextWindow,
	setModel,
	setPermissionMode,
	setVariant,
} from "./session-overrides-state.js";
import {
	loadServerSessionPick,
	resolveSessionCreationInstance,
} from "./session-pick.js";

const PROVIDER_CLEANUP_TIMEOUT = "2 seconds";
// Provider response bodies are untrusted; bound both durable receipts and the
// matching warning so one cleanup failure cannot create oversized diagnostics.
const PROVIDER_CLEANUP_DETAIL_MAX_LENGTH = 2_000;
const PROVIDER_CLEANUP_REASON_MAX_LENGTH = 4_000;
const PROVIDER_CLEANUP_TRUNCATION_MARKER = "... [truncated]";
const PROVIDER_CLEANUP_DETAIL_FALLBACK = "cleanup error detail unavailable";

function truncateProviderCleanupDiagnostic(
	detail: string,
	maximumLength: number,
): string {
	if (detail.length <= maximumLength) {
		return detail;
	}
	return `${detail.slice(
		0,
		maximumLength - PROVIDER_CLEANUP_TRUNCATION_MARKER.length,
	)}${PROVIDER_CLEANUP_TRUNCATION_MARKER}`;
}

function renderProviderCleanupDetail(error: unknown): string {
	try {
		return truncateProviderCleanupDiagnostic(
			// The upstream adapter wraps provider failures; its message is generic.
			formatErrorDetail(Cause.isUnknownException(error) ? error.error : error),
			PROVIDER_CLEANUP_DETAIL_MAX_LENGTH,
		);
	} catch {
		return PROVIDER_CLEANUP_DETAIL_FALLBACK;
	}
}

export type ListSessionsOptions = {
	limit?: number;
	roots?: boolean;
	statuses?: Record<string, SessionStatus> | undefined;
};

export interface CreateSessionOptions {
	readonly account?: Account;
	readonly pick?: TurnSettings;
	readonly permissionMode?: SessionPermissionMode;
	readonly sourceSessionId?: string;
	/** Reserved locally before a draft creates its workspace. */
	readonly sessionId?: string;
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
	readonly mergedHead?: string;
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
export const createLocalSessionId = (): string =>
	`ses_${randomUUID().replaceAll("-", "")}`;

const createLocalSession = (
	title: string | undefined,
	account: Account,
	reservedSessionId: string | undefined,
	pick: TurnSettings,
	permissionMode: SessionPermissionMode,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;

		const provider = account.id;
		const sessionId = reservedSessionId ?? createLocalSessionId();
		const now = Date.now();
		const sessionTitle = normalizeSessionTitle(title);

		// The id is chosen here rather than upstream, so creation is one command:
		// the seam appends session.created and the projector's upsert is what
		// brings the sessions row into being.
		yield* applySessionCommand(
			{
				type: "session.created",
				data: { sessionId, title: sessionTitle, provider, permissionMode },
			},
			{ pick, upstreamAdapter: null },
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "createLocalSession", cause }),
			),
		);

		return {
			id: sessionId,
			projectID: "",
			directory: config.projectDir,
			title: sessionTitle,
			version: "",
			time: { created: now, updated: now },
			providerID: provider,
		} satisfies SessionDetail;
	}).pipe(Effect.withSpan("session.createLocalSession"));

/** Delete a session locally, then best-effort upstream, and clear associated state. */
export const deleteSession = (sessionId: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const logOption = yield* Effect.serviceOption(LoggerTag);
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const instanceClientsOption =
			yield* Effect.serviceOption(OpenCodeInstancesTag);
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const projectId = (yield* EventStoreEffectTag).projectId;

		const sessions =
			readQueryOption._tag === "Some"
				? (yield* readQueryOption.value
						.getSessionLineage({ projectIds: [projectId] })
						.pipe(
							Effect.mapError(
								(cause) =>
									new SessionManagerError({
										operation: "deleteSession.snapshot",
										cause,
									}),
							),
						)).rows
				: [];
		// The provider that owns the session is row-only state, never on the wire.
		const row =
			readQueryOption._tag === "Some"
				? yield* readQueryOption.value.getSession(sessionId).pipe(
						Effect.mapError(
							(cause) =>
								new SessionManagerError({
									operation: "deleteSession.row",
									cause,
								}),
						),
					)
				: undefined;
		const childSessionIds: string[] = [];
		const discovered = new Set([sessionId]);
		const pendingParents = [sessionId];
		for (const parentId of pendingParents) {
			for (const candidate of sessions) {
				if (candidate.parent_id === parentId && !discovered.has(candidate.id)) {
					discovered.add(candidate.id);
					childSessionIds.push(candidate.id);
					pendingParents.push(candidate.id);
				}
			}
		}

		const bindingExit =
			engineOption._tag === "Some"
				? yield* Effect.exit(
						engineOption.value.getProviderForSessionEffect(sessionId),
					)
				: undefined;

		const cleanupFailures: string[] = [];
		const capturedBinding =
			bindingExit !== undefined && Exit.isSuccess(bindingExit)
				? bindingExit.value
				: undefined;
		if (bindingExit !== undefined && Exit.isFailure(bindingExit)) {
			cleanupFailures.push(
				`binding_resolution: ${renderProviderCleanupDetail(
					Cause.squash(bindingExit.cause),
				)}`,
			);
		}

		const capturedIdentity = capturedBinding ?? row?.provider;
		const accountsOption = yield* Effect.serviceOption(AccountDirectory);
		const providerResolutionExit =
			capturedIdentity === undefined
				? undefined
				: yield* Effect.exit(
						accountsOption._tag === "Some"
							? accountsOption.value.resolve({
									_tag: "Id",
									id: capturedIdentity,
								})
							: Effect.fail(new Error("Account directory is unavailable")),
					);
		const account =
			providerResolutionExit !== undefined &&
			Exit.isSuccess(providerResolutionExit)
				? providerResolutionExit.value
				: undefined;
		const provider = account?.driver;
		const capturedInstanceId = account?.id;
		if (
			providerResolutionExit !== undefined &&
			Exit.isFailure(providerResolutionExit)
		) {
			cleanupFailures.push(
				`provider_resolution: ${renderProviderCleanupDetail(Cause.squash(providerResolutionExit.cause))}`,
			);
		}
		if (account === undefined) {
			cleanupFailures.push(
				"provider_route: no provider route could be determined, so cleanup was skipped",
			);
		}

		const providerCleanup = (command: SessionCommand) =>
			Effect.gen(function* () {
				if (capturedInstanceId === undefined || provider === undefined) {
					return;
				}

				let runnerStopped = false;
				if (engineOption._tag === "None") {
					cleanupFailures.push(
						"end_session: orchestration engine is unavailable",
					);
				} else {
					const engine = engineOption.value;
					const endSessionExit = yield* Effect.exit(
						Effect.suspend(() =>
							engine.dispatchEffect({
								type: "end_session",
								commandId: randomUUID(),
								sessionId,
								targetProviderId: capturedInstanceId,
								unbind: true,
							}),
						),
					);
					if (Exit.isFailure(endSessionExit)) {
						if (Exit.isInterrupted(endSessionExit)) {
							return yield* Effect.failCause(endSessionExit.cause);
						}
						cleanupFailures.push(
							`end_session: ${renderProviderCleanupDetail(
								Cause.squash(endSessionExit.cause),
							)}`,
						);
					} else {
						runnerStopped = true;
					}
				}

				const providerDeleteExit = yield* Effect.exit(
					Effect.gen(function* () {
						let deleteApi = api;
						if (
							getProviderDriver(provider)?.runsOpenCodeServer &&
							capturedInstanceId !== MANAGED_OPENCODE_ACCOUNT_ID
						) {
							if (instanceClientsOption._tag === "None") {
								return yield* Effect.fail(
									new Error(
										`OpenCode instance client registry is unavailable for "${capturedInstanceId}"`,
									),
								);
							}
							deleteApi =
								yield* instanceClientsOption.value.use(capturedInstanceId);
						}

						const adapter = yield* sessionUpstreamAdapter(provider, deleteApi);
						yield* adapter.sync(command);
						if (
							runnerStopped &&
							getProviderDriver(provider)?.usesLocalSessions
						) {
							const config =
								configOption._tag === "Some" ? configOption.value : undefined;
							const configDir = config?.configDir;
							if (config === undefined || configDir === undefined) {
								return yield* Effect.fail(
									new SessionManagerError({
										operation: "deleteSession.runnerJournal",
										cause:
											"Runner cleanup requires the project and config directories",
									}),
								);
							}
							yield* Effect.try(() =>
								removeRunnerSessionSends(
									config.projectDir,
									configDir,
									sessionId,
								),
							);
						}
					}).pipe(Effect.scoped),
				);
				if (Exit.isFailure(providerDeleteExit)) {
					if (Exit.isInterrupted(providerDeleteExit)) {
						return yield* Effect.failCause(providerDeleteExit.cause);
					}
					cleanupFailures.push(
						`provider_delete: ${renderProviderCleanupDetail(
							Cause.squash(providerDeleteExit.cause),
						)}`,
					);
				}
			});

		const upstreamAdapter: SessionUpstreamAdapter = {
			provider: getProviderDriver(provider)?.usesLocalSessions
				? "claude"
				: "opencode",
			sync: (command) =>
				Effect.gen(function* () {
					const cleanupExit = yield* Effect.exit(
						providerCleanup(command).pipe(
							Effect.timeout(PROVIDER_CLEANUP_TIMEOUT),
						),
					);
					if (Exit.isFailure(cleanupExit)) {
						const failure = Cause.failureOption(cleanupExit.cause);
						cleanupFailures.push(
							Option.isSome(failure) && Cause.isTimeoutException(failure.value)
								? "cleanup: timed out after 2s"
								: `cleanup: ${renderProviderCleanupDetail(
										Cause.squash(cleanupExit.cause),
									)}`,
						);
					}
				}),
		};

		yield* applySessionCommand(
			{
				type: "session.deleted",
				data:
					childSessionIds.length === 0
						? { sessionId }
						: { sessionId, childSessionIds },
			},
			{ upstreamAdapter },
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "deleteSession", cause }),
			),
		);

		// The delete took the whole lineage, so the cache must forget the whole
		// lineage: an edge naming a session that no longer exists would put a
		// deleted grandchild back under a live root on the next list.
		const deleted = new Set([sessionId, ...childSessionIds]);
		yield* Ref.update(stateRef, (s) => {
			const lastMessageAt = HashMap.remove(s.lastMessageAt, sessionId);

			const cachedParentMap = HashMap.filter(
				s.cachedParentMap,
				(parent, child) => !deleted.has(parent) && !deleted.has(child),
			);

			return {
				cachedParentMap,
				cachedSideThreadIds: new Set(
					[...s.cachedSideThreadIds].filter((id) => !deleted.has(id)),
				),
				lastMessageAt,
				lastKnownSessionCount: Math.max(0, s.lastKnownSessionCount - 1),
			};
		});
		const state = yield* Ref.get(stateRef);
		yield* updateRelaySessionCountSnapshot(state.lastKnownSessionCount);

		if (cleanupFailures.length > 0) {
			const reason = truncateProviderCleanupDiagnostic(
				cleanupFailures.join("; "),
				PROVIDER_CLEANUP_REASON_MAX_LENGTH,
			);
			const payload = {
				sessionId,
				provider: provider ?? capturedInstanceId ?? "unknown",
				...(capturedInstanceId !== undefined &&
				capturedInstanceId !== MANAGED_OPENCODE_ACCOUNT_ID
					? { instanceId: capturedInstanceId }
					: {}),
				reason,
			};
			const receiptExit =
				eventStoreOption._tag === "Some"
					? yield* Effect.exit(
							eventStoreOption.value
								.append(
									canonicalEvent(
										"session.provider_cleanup_failed",
										sessionId,
										payload,
										{ provider: payload.provider },
									),
								)
								.pipe(Effect.asVoid),
						)
					: undefined;
			const receiptFailure =
				receiptExit !== undefined && Exit.isFailure(receiptExit)
					? ` receipt_append_failed=${renderProviderCleanupDetail(
							Cause.squash(receiptExit.cause),
						)}`
					: eventStoreOption._tag === "None"
						? " receipt_append_failed=event store unavailable"
						: "";

			if (logOption._tag === "Some") {
				yield* Effect.exit(
					Effect.sync(() =>
						logOption.value.warn(
							`Provider cleanup failed: session=${sessionId} provider=${payload.provider}` +
								`${payload.instanceId ? ` instanceId=${payload.instanceId}` : ""}` +
								` reason=${reason}${receiptFailure}`,
						),
					),
				);
			}
		}
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.deleteSession", { attributes: { sessionId } }),
	);

export interface SessionManagerService {
	initialize(
		title?: string,
	): Effect.Effect<
		string,
		SessionManagerError | PickRejection | AccountUnroutable
	>;
	getDefaultSessionId(
		title?: string,
	): Effect.Effect<
		string,
		SessionManagerError | PickRejection | AccountUnroutable
	>;
	getLastKnownSessionCount(): Effect.Effect<number>;
	listSessions(
		options?: ListSessionsOptions,
	): Effect.Effect<SessionInfo[], SessionManagerError>;
	sessionExists(sessionId: string): Effect.Effect<boolean, SessionManagerError>;
	createSession(
		title?: string,
		options?: CreateSessionOptions,
	): Effect.Effect<
		SessionDetail,
		SessionManagerError | PickRejection | AccountUnroutable
	>;
	establishOpenCodeSession(
		session: SessionDetail,
		providerInstanceId: AccountId,
	): Effect.Effect<void, SessionManagerError>;
	deleteSession(sessionId: string): Effect.Effect<boolean, SessionManagerError>;
	renameSession(
		sessionId: string,
		title: string,
	): Effect.Effect<void, SessionManagerError>;
	markSessionRead(sessionId: string): Effect.Effect<void, SessionManagerError>;
	markSessionSeen(
		sessionId: string,
		upTo: number,
	): Effect.Effect<boolean, SessionManagerError>;
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
	loadPreRenderedHistory(
		sessionId: string,
	): Effect.Effect<HistoryPage, SessionManagerError>;
	recordMessageActivity(
		sessionId: string,
		timestamp?: number,
	): Effect.Effect<void>;
	addToParentMap(childId: string, parentId: string): Effect.Effect<void>;
	getSessionParentMap(options?: {
		readonly activityOnly?: boolean;
	}): Effect.Effect<Map<string, string>>;
	setForkEntry(
		sessionId: string,
		entry: ForkEntry,
	): Effect.Effect<void, SessionManagerError>;
	/**
	 * Re-read session lineage into the parent map, side-thread set and session
	 * count. Status propagation and the relay snapshot read these caches, so
	 * call it wherever a session or a parent edge may have appeared.
	 */
	refreshSessionLineage(): Effect.Effect<void, SessionManagerError>;
}

/** Bundled service object for callers that prefer DI over free functions. */
export class SessionManagerServiceTag extends Context.Tag(
	"SessionManagerService",
)<SessionManagerServiceTag, SessionManagerService>() {}

const makeServiceCreateSession = ({
	engine,
	accounts,
	instanceClients,
	readQuery,
	eventStore,
	projectionRunner,
	sql,
}: {
	engine: OrchestrationEngine;
	accounts: AccountDirectory["Type"];
	instanceClients: OpenCodeInstances;
	readQuery: ReadQueryEffect;
	eventStore: EventStoreEffect;
	projectionRunner: ProjectionRunnerEffect;
	sql: SqlClient.SqlClient;
}) => {
	const serviceCreateSession = (
		title?: string,
		options?: CreateSessionOptions,
	) =>
		Effect.gen(function* () {
			const { account, instanceId, harness } =
				yield* resolveSessionCreationInstance(options).pipe(
					Effect.provideService(AccountDirectory, accounts),
				);
			const source = options?.sourceSessionId
				? yield* readQuery.getSession(options.sourceSessionId)
				: undefined;
			if (options?.sourceSessionId && !source) return yield* new PickRequired();
			const pick =
				options?.pick ??
				(yield* loadServerSessionPick(harness, instanceId, source));
			if (pick.harness !== harness)
				return yield* new ModelNotInCatalog({ harness, ...pick.model });
			const permissionMode =
				options?.permissionMode ?? (yield* getDefaultPermissionMode());
			const session = yield* Effect.scoped(
				Effect.gen(function* () {
					if (PROVIDER_DRIVERS[account.driver].usesLocalSessions)
						return yield* createLocalSession(
							title,
							account,
							options?.sessionId,
							pick,
							permissionMode,
						);
					if (PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
						const instanceApi = yield* instanceClients.use(instanceId);
						return yield* createOpenCodeSession(
							title,
							instanceId,
							pick,
							options?.sessionId,
							permissionMode,
						).pipe(Effect.provideService(OpenCodeAPITag, instanceApi));
					}
					return yield* new SessionManagerError({
						operation: "createSession",
						cause: `Driver "${account.driver}" does not support session creation`,
					});
				}),
			).pipe(
				Effect.provideService(AccountDirectory, accounts),
				Effect.provideService(ReadQueryEffectTag, readQuery),
				Effect.provideService(EventStoreEffectTag, eventStore),
				Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "createSession", cause }),
				),
			);
			engine.bindSession(session.id, instanceId);
			yield* setModel(session.id, {
				providerID: pick.model.providerId,
				modelID: pick.model.modelId,
			});
			yield* setVariant(session.id, pick.effort);
			yield* setContextWindow(session.id, pick.contextWindow);
			yield* setPermissionMode(session.id, permissionMode);
			return session;
		}).pipe(
			Effect.mapError((cause) =>
				isPickRejection(cause) ||
				cause instanceof AccountUnroutable ||
				cause instanceof SessionManagerError
					? cause
					: new SessionManagerError({ operation: "createSession", cause }),
			),
		);
	return serviceCreateSession;
};

export const SessionManagerServiceLive: Layer.Layer<
	SessionManagerServiceTag,
	never,
	| AccountDirectory
	| OpenCodeAPITag
	| SessionManagerStateTag
	| LoggerTag
	| ConfigTag
	| RelayStatusSnapshotTag
	| OpenCodeInstancesTag
	| SessionActivityTag
	| OverridesStateTag
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
		const config = yield* ConfigTag;
		const engine = yield* OrchestrationEngineTag;
		const readQuery = yield* ReadQueryEffectTag;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;
		// The relay constructs the session manager before its status-poller layer.
		const statusPollerOption = yield* Effect.serviceOption(StatusPollerTag);
		const activity = yield* SessionActivityTag;
		const snapshot = yield* RelayStatusSnapshotTag;
		const instanceClients = yield* OpenCodeInstancesTag;
		const accounts = yield* AccountDirectory;
		const overrides = yield* OverridesStateTag;
		const modelService = yield* Effect.serviceOption(OpenCodeModelServiceTag);
		// Captured here, not read at call time: the auto-settle sweep calls in from
		// a daemon fiber that lacks the project's bus, and a commit without it
		// never reaches the sidebar's shell subscription.
		const sessionEventBus = yield* Effect.serviceOption(SessionEventBusTag);
		const inFlightDeletes = new Map<
			string,
			Deferred.Deferred<void, SessionManagerError>
		>();
		const { serviceListSessions, refreshSessionLineage } =
			makeSessionListOperations({
				api,
				stateRef,
				readQuery,
				sql,
				accounts,
				statusPollerOption,
				activity,
				snapshot,
				projectFolders: [config.projectDir, ...(config.extraFolders ?? [])],
				projectSlug: config.slug,
			});
		const establishOpenCodeSession = (
			session: SessionDetail,
			providerInstanceId: AccountId,
		): Effect.Effect<void, SessionManagerError> =>
			Effect.gen(function* () {
				// `write` rather than the plain form: the seed and the verification
				// query belong in the same transaction as the append, and projecting
				// through the handle it hands us is what makes the announcement
				// unskippable.
				const commitAndSignal = yield* makeCommitAndSignal.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(EventStoreEffectTag, eventStore),
					Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
				);

				const now = Date.now();
				const normalizedTitle = normalizeSessionTitle(session.title);
				yield* commitAndSignal
					.write((project) =>
						Effect.gen(function* () {
							yield* sql`
					INSERT OR IGNORE INTO sessions (
						id, project_id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${session.id}, ${eventStore.projectId}, ${providerInstanceId}, ${session.id}, ${normalizedTitle}, 'idle', ${now}, ${now}
					)
					`.pipe(
								Effect.mapError(
									(cause) =>
										new SessionManagerError({
											operation: "establishOpenCodeSession.seed",
											cause,
										}),
								),
							);
							const stored = yield* eventStore
								.append(
									canonicalEvent(
										"session.created",
										session.id,
										{
											sessionId: session.id,
											title: normalizedTitle,
											provider: providerInstanceId,
											providerSessionId: session.id,
											...(session.parentID === undefined
												? {}
												: { parentId: session.parentID }),
										},
										{
											provider: providerInstanceId,
											createdAt: now,
											metadata: { source: "relay", synthetic: true },
										},
									),
								)
								.pipe(
									Effect.mapError(
										(cause) =>
											new SessionManagerError({
												operation: "establishOpenCodeSession.append",
												cause,
											}),
									),
								);

							yield* project([stored]).pipe(
								Effect.mapError(
									(cause) =>
										new SessionManagerError({
											operation: "establishOpenCodeSession.project",
											cause,
										}),
								),
							);

							const establishedRows = yield* sql<{ readonly id: string }>`
						SELECT sessions.id
						FROM sessions
						JOIN session_providers
							ON session_providers.session_id = sessions.id
						WHERE sessions.id = ${session.id}
							AND sessions.provider = ${providerInstanceId}
							AND sessions.provider_sid = ${session.id}
							AND session_providers.id = ${`${session.id}:initial`}
							AND session_providers.provider = ${providerInstanceId}
							AND session_providers.status = 'active'
						LIMIT 1`.pipe(
								Effect.mapError(
									(cause) =>
										new SessionManagerError({
											operation: "establishOpenCodeSession.project",
											cause,
										}),
								),
							);
							if (establishedRows.length === 0) {
								return yield* new SessionManagerError({
									operation: "establishOpenCodeSession.project",
									cause: `Projected session ${session.id} has no matching active provider binding`,
								});
							}
						}),
					)
					.pipe(
						// BEGIN failures are typed; Effect SQL leaves COMMIT failures as defects.
						Effect.mapError((cause) =>
							cause instanceof SessionManagerError
								? cause
								: new SessionManagerError({
										operation: "establishOpenCodeSession.transaction",
										cause,
									}),
						),
					);
			});
		const serviceCreateSession = makeServiceCreateSession({
			engine,
			accounts,
			instanceClients,
			readQuery,
			eventStore,
			projectionRunner,
			sql,
		});
		const createSessionWithServices = (
			title?: string,
			options?: CreateSessionOptions,
		) => {
			const create = serviceCreateSession(title, options).pipe(
				Effect.provideService(AccountDirectory, accounts),
				Effect.provideService(ConfigTag, config),
				Effect.provideService(LoggerTag, log),
				Effect.provideService(OpenCodeAPITag, api),
				Effect.provideService(OrchestrationEngineTag, engine),
				Effect.provideService(OverridesStateTag, overrides),
				Effect.provideService(RelayStatusSnapshotTag, snapshot),
			);
			return modelService._tag === "Some"
				? create.pipe(
						Effect.provideService(OpenCodeModelServiceTag, modelService.value),
					)
				: create;
		};

		const withSessionCommandServices = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				| AccountDirectory
				| OpenCodeAPITag
				| ReadQueryEffectTag
				| EventStoreEffectTag
				| ProjectionRunnerEffectTag
				| SqlClient.SqlClient
				| ConfigTag
				| LoggerTag
			>,
		): Effect.Effect<A, E> => {
			const provided = effect.pipe(
				Effect.provideService(AccountDirectory, accounts),
				Effect.provideService(OpenCodeAPITag, api),
				Effect.provideService(ReadQueryEffectTag, readQuery),
				Effect.provideService(EventStoreEffectTag, eventStore),
				Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(ConfigTag, config),
				Effect.provideService(LoggerTag, log),
			);
			return Option.isSome(sessionEventBus)
				? Effect.provideService(
						provided,
						SessionEventBusTag,
						sessionEventBus.value,
					)
				: provided;
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
					const session = yield* createSessionWithServices(title);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(RelayStatusSnapshotTag, snapshot),
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
					const session = yield* createSessionWithServices(title);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(RelayStatusSnapshotTag, snapshot),
					);
					yield* updateRelaySessionCountSnapshot(1).pipe(
						Effect.provideService(RelayStatusSnapshotTag, snapshot),
					);
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
			createSession: (title, options) =>
				Effect.gen(function* () {
					const session = yield* createSessionWithServices(title, options);
					yield* incrementLastKnownSessionCount().pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(RelayStatusSnapshotTag, snapshot),
					);
					yield* publishSessionCreated(session.id).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
					return session;
				}),
			establishOpenCodeSession,
			deleteSession: (sessionId) =>
				Effect.gen(function* () {
					const completion = yield* Deferred.make<void, SessionManagerError>();
					const existing = inFlightDeletes.get(sessionId);
					if (existing) {
						yield* Deferred.await(existing);
						return false;
					}
					inFlightDeletes.set(sessionId, completion);
					const exit = yield* Effect.exit(
						Effect.gen(function* () {
							yield* deleteSession(sessionId).pipe(
								Effect.provideService(AccountDirectory, accounts),
								Effect.provideService(OpenCodeAPITag, api),
								Effect.provideService(OrchestrationEngineTag, engine),
								Effect.provideService(OpenCodeInstancesTag, instanceClients),
								Effect.provideService(SessionManagerStateTag, stateRef),
								Effect.provideService(ReadQueryEffectTag, readQuery),
								Effect.provideService(EventStoreEffectTag, eventStore),
								Effect.provideService(
									ProjectionRunnerEffectTag,
									projectionRunner,
								),
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.provideService(ConfigTag, config),
								Effect.provideService(LoggerTag, log),
								Effect.provideService(RelayStatusSnapshotTag, snapshot),
							);
							yield* publishSessionDeleted(sessionId).pipe(
								Effect.provideService(DaemonEventBusTag, eventBus),
							);
						}),
					);
					yield* Deferred.done(completion, exit);
					inFlightDeletes.delete(sessionId);
					return yield* Exit.matchEffect(exit, {
						onFailure: Effect.failCause,
						onSuccess: () => Effect.succeed(true),
					});
				}).pipe(
					Effect.tap((deleted) =>
						deleted
							? (config.requestWorktreeCleanup?.() ?? Effect.void)
							: Effect.void,
					),
				),
			renameSession: (sessionId, title) =>
				withSessionCommandServices(renameSession(sessionId, title)),
			markSessionSeen: (sessionId, upTo) =>
				withSessionCommandServices(markSessionSeen(sessionId, upTo)),
			markSessionRead: (sessionId) =>
				withSessionCommandServices(markSessionRead(sessionId)),
			markSessionUnread: (sessionId) =>
				withSessionCommandServices(markSessionUnread(sessionId)),
			setSessionSettled: (sessionId, options) =>
				triageLock
					.withPermits(1)(
						withSessionCommandServices(setSessionSettled(sessionId, options)),
					)
					.pipe(
						Effect.tap((changed) =>
							changed && options.settled
								? (config.requestWorktreeCleanup?.() ?? Effect.void)
								: Effect.void,
						),
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
			loadPreRenderedHistory: (sessionId) =>
				Effect.gen(function* () {
					const row = yield* readQuery.getSession(sessionId).pipe(
						Effect.mapError(
							(cause) =>
								new SessionManagerError({
									operation: "loadPreRenderedHistory",
									cause,
								}),
						),
					);
					const account =
						row === undefined
							? undefined
							: yield* accounts.resolve({ _tag: "Id", id: row.provider }).pipe(
									Effect.mapError(
										(cause) =>
											new SessionManagerError({
												operation: "loadPreRenderedHistory",
												cause,
											}),
									),
								);
					const instanceApi =
						account !== undefined &&
						PROVIDER_DRIVERS[account.driver].runsOpenCodeServer
							? yield* instanceClients.use(account.id).pipe(
									Effect.mapError(
										(cause) =>
											new SessionManagerError({
												operation: "loadPreRenderedHistory",
												cause,
											}),
									),
								)
							: undefined;

					return yield* loadPreRenderedHistory(sessionId).pipe(
						Effect.provideService(OpenCodeAPITag, instanceApi ?? api),
					);
				}).pipe(Effect.scoped),
			recordMessageActivity: (sessionId, timestamp) =>
				recordMessageActivity(sessionId, timestamp).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			addToParentMap: (childId, parentId) =>
				addToParentMap(childId, parentId).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			getSessionParentMap: (options) =>
				getSessionParentMap(options).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			setForkEntry: (sessionId, entry) =>
				Effect.gen(function* () {
					yield* setForkEntry(sessionId, entry).pipe(
						Effect.provideService(AccountDirectory, accounts),
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(ReadQueryEffectTag, readQuery),
						Effect.provideService(EventStoreEffectTag, eventStore),
						Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.provideService(ConfigTag, config),
						Effect.provideService(LoggerTag, log),
						Effect.provideService(OpenCodeAPITag, api),
					);
				}),
			refreshSessionLineage,
		} satisfies SessionManagerService;
	}),
);
