import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	PendingSendOwnershipLive,
	PendingSendOwnershipTag,
} from "./pending-send-ownership.js";
// ─── SessionManager Service (Effect) ────────────────────────────────────────
// Pure Effect functions that replace the imperative SessionManager methods.
// State lives in SessionManagerStateTag (Ref<SessionManagerState>);
// API calls go through OpenCodeAPITag.
//
// Exported free functions can be used directly in Effect pipelines.
// SessionManagerServiceTag bundles them for callers that prefer a service object.

import {
	Cause,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
	Schema,
} from "effect";
import {
	isKnownDriverKind,
	type ProviderDriverKind,
	type ProviderInstanceId,
} from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveInstanceDriver,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { formatErrorDetail, OpenCodeApiError } from "../../../errors.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../instance/sdk-types.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { toSessionInfoList } from "../../../session/session-info-list.js";
import {
	type HistoryMessage,
	type SessionPermissionMode,
	SessionPermissionModeSchema,
} from "../../../shared-types.js";
import type { RelayMessage, SessionInfo } from "../../../types.js";
import {
	DaemonEventBusTag,
	publishSessionCreated,
	publishSessionDeleted,
} from "../../daemon/Services/daemon-pubsub.js";
import { OpenCodeInstanceClientsTag } from "./opencode-instance-clients.js";
import { RelayStatusSnapshotTag } from "./relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	StatusPollerTag,
} from "./services.js";
import {
	applySessionCommand,
	createOpenCodeSession,
	normalizeSessionTitle,
	openCodeUpstreamAdapter,
	type SessionCommand,
	type SessionUpstreamAdapter,
} from "./session-command.js";
import { SessionManagerStateTag } from "./session-manager-state.js";
import {
	OverridesStateTag,
	setPermissionMode,
} from "./session-overrides-state.js";

// ─── Retry policy ──────────────────────────────────────────────────────────

const retryPolicy = Schedule.exponential("500 millis").pipe(
	Schedule.intersect(Schedule.recurs(3)),
);

const DEFAULT_HISTORY_PAGE_SIZE = 50;
const CURSOR_SCAN_LIMIT = 10_000;
const CLAUDE_PROVIDER_ID = "claude";
const CLAUDE_SDK_PROVIDER_ID = "claude-sdk";
// The delete handler's broadcasts wait for this Effect, so provider cleanup
// must not delay the already-committed local deletion indefinitely.
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
			formatErrorDetail(error),
			PROVIDER_CLEANUP_DETAIL_MAX_LENGTH,
		);
	} catch {
		return PROVIDER_CLEANUP_DETAIL_FALLBACK;
	}
}

// ─── Error types ───────────────────────────────────────────────────────────

export class SessionManagerError extends Data.TaggedError(
	"SessionManagerError",
)<{
	operation: string;
	cause: unknown;
}> {}

export type ListSessionsOptions = {
	limit?: number;
	roots?: boolean;
	statuses?: Record<string, SessionStatus> | undefined;
};

type SessionListMessage = Extract<RelayMessage, { type: "session_list" }>;

export interface CreateSessionOptions {
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
}

interface ForkEntry {
	readonly parentID: string;
	readonly forkMessageId: string;
	readonly forkPointTimestamp?: number;
}

export interface HistoryPage {
	messages: HistoryMessage[];
	hasMore: boolean;
	total?: number;
}

export interface LoadHistoryOptions {
	historyPageSize?: number;
}

const toReadonlyMap = <K, V>(map: HashMap.HashMap<K, V>): ReadonlyMap<K, V> =>
	new Map(HashMap.toEntries(map));

const sessionsParentMap = (
	sessions: readonly SessionInfo[],
): HashMap.HashMap<string, string> => {
	let parentMap = HashMap.empty<string, string>();
	for (const session of sessions) {
		const parentID = session.parentID;
		if (parentID) {
			parentMap = HashMap.set(parentMap, session.id, parentID);
		}
	}
	return parentMap;
};

const sessionDetailsParentMap = (
	sessions: readonly SessionDetail[],
): HashMap.HashMap<string, string> => {
	let parentMap = HashMap.empty<string, string>();
	for (const session of sessions) {
		const rec = session as Record<string, unknown>;
		const apiParentID = rec["parentID"];
		const parentID = typeof apiParentID === "string" ? apiParentID : undefined;
		if (parentID) {
			parentMap = HashMap.set(parentMap, session.id, parentID);
		}
	}
	return parentMap;
};

const updateRelaySessionCountSnapshot = (sessionCount: number) =>
	Effect.serviceOption(RelayStatusSnapshotTag).pipe(
		Effect.flatMap((snapshot) =>
			snapshot._tag === "Some"
				? snapshot.value.setSessionCount(sessionCount)
				: Effect.void,
		),
	);

const incrementLastKnownSessionCount = () =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		const sessionCount = yield* Ref.modify(stateRef, (state) => {
			const nextCount = state.lastKnownSessionCount + 1;
			return [
				nextCount,
				{
					...state,
					lastKnownSessionCount: nextCount,
				},
			];
		});
		yield* updateRelaySessionCountSnapshot(sessionCount);
		return sessionCount;
	});

// ─── Free functions ─────────────────────────────────────────────────────────

/**
 * Fetch the session list from the API.
 * Caches the child-to-parent map in state for subagent status propagation.
 */
export const listSessions = (options?: ListSessionsOptions) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
		const state = yield* Ref.get(stateRef);

		if (readQueryEffectOption._tag === "Some") {
			const snapshot = yield* readQueryEffectOption.value
				.readSessionList()
				.pipe(
					Effect.mapError(
						(cause) =>
							new SessionManagerError({ operation: "listSessions", cause }),
					),
				);
			// A root is a session the row gives no parent — the same test the
			// `parent_id IS NULL` filter used to make, applied before fork lineage
			// is folded on.
			const rows = snapshot.rows.map(({ item }) => item);
			const sessions = options?.roots
				? rows.filter((session) => session.parentID === undefined)
				: rows;
			if (!options?.roots) {
				yield* Ref.update(stateRef, (s) => ({
					...s,
					cachedParentMap: sessionsParentMap(sessions),
					lastKnownSessionCount: sessions.length,
				}));
				yield* updateRelaySessionCountSnapshot(sessions.length);
			}
			return sessions;
		}

		const clientOptions = {
			...(options?.limit !== undefined && { limit: options.limit }),
			...(options?.roots !== undefined && { roots: options.roots }),
		};

		const sessions = yield* Effect.tryPromise(() =>
			api.session.list(
				Object.keys(clientOptions).length > 0 ? clientOptions : undefined,
			),
		).pipe(
			Effect.retry(retryPolicy),
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "listSessions", cause }),
			),
		);

		// Only rebuild from unfiltered fetches. Roots-only responses omit children
		// and would wipe the parent map used by status propagation.
		if (!options?.roots) {
			yield* Ref.update(stateRef, (s) => ({
				...s,
				cachedParentMap: sessionDetailsParentMap(sessions),
				lastKnownSessionCount: sessions.length,
			}));
			yield* updateRelaySessionCountSnapshot(sessions.length);
		}

		return toSessionInfoList(
			sessions,
			options?.statuses,
			toReadonlyMap(state.lastMessageAt),
		);
	}).pipe(
		Effect.annotateLogs("operation", "listSessions"),
		Effect.withSpan("session.listSessions"),
	);

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
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);

		// applySessionCommand skips the local write when any of these is missing.
		// A locally-created session that is never recorded exists nowhere, so the
		// precondition is checked here instead of failing silently.
		if (
			eventStoreOption._tag === "None" ||
			projectionRunnerOption._tag === "None" ||
			readQueryOption._tag === "None" ||
			sqlOption._tag === "None"
		) {
			return yield* new SessionManagerError({
				operation: "createLocalSession",
				cause: "SQLite event-store services are unavailable",
			});
		}

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
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const logOption = yield* Effect.serviceOption(LoggerTag);
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const instanceClientsOption = yield* Effect.serviceOption(
			OpenCodeInstanceClientsTag,
		);
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);

		const sessions =
			readQueryOption._tag === "Some"
				? (yield* readQueryOption.value.readSessionList().pipe(
						Effect.mapError(
							(cause) =>
								new SessionManagerError({
									operation: "deleteSession.snapshot",
									cause,
								}),
						),
					)).rows.map(({ item }) => item)
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
				if (candidate.parentID === parentId && !discovered.has(candidate.id)) {
					discovered.add(candidate.id);
					childSessionIds.push(candidate.id);
					pendingParents.push(candidate.id);
				}
			}
		}

		const bindingExit =
			engineOption._tag === "Some"
				? yield* Effect.exit(
						Effect.sync(() =>
							engineOption.value.getProviderForSession(sessionId),
						),
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
		const capturedInstanceId =
			capturedIdentity === CLAUDE_SDK_PROVIDER_ID
				? CLAUDE_PROVIDER_ID
				: capturedIdentity;
		const providerResolutionExit =
			capturedInstanceId === undefined
				? undefined
				: yield* Effect.exit(
						Effect.sync(() => {
							if (isKnownDriverKind(capturedInstanceId)) {
								return capturedInstanceId;
							}
							return resolveProviderRoutingDriver(
								configOption._tag === "Some"
									? loadDaemonConfig(configOption.value.configDir)
									: null,
								capturedInstanceId,
							);
						}),
					);
		const provider =
			providerResolutionExit !== undefined &&
			Exit.isSuccess(providerResolutionExit)
				? providerResolutionExit.value
				: undefined;
		if (
			providerResolutionExit !== undefined &&
			Exit.isFailure(providerResolutionExit)
		) {
			cleanupFailures.push(
				`provider_resolution: ${renderProviderCleanupDetail(
					Cause.squash(providerResolutionExit.cause),
				)}`,
			);
		} else if (capturedInstanceId !== undefined && provider === undefined) {
			cleanupFailures.push(
				`provider_resolution: provider driver is unavailable for "${capturedInstanceId}"`,
			);
		}
		if (capturedInstanceId === undefined || provider === undefined) {
			cleanupFailures.push(
				"provider_route: no provider route could be determined, so cleanup was skipped",
			);
		}

		const providerCleanup = (command: SessionCommand) =>
			Effect.gen(function* () {
				if (capturedInstanceId === undefined || provider === undefined) {
					return;
				}

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
					}
				}

				if (provider === "opencode") {
					const providerDeleteExit = yield* Effect.exit(
						Effect.gen(function* () {
							let deleteApi = api;
							if (capturedInstanceId !== "opencode") {
								if (instanceClientsOption._tag === "None") {
									return yield* Effect.fail(
										new Error(
											`OpenCode instance client registry is unavailable for "${capturedInstanceId}"`,
										),
									);
								}
								const resolved =
									yield* instanceClientsOption.value.clientFor(
										capturedInstanceId,
									);
								if (resolved === undefined) {
									return yield* Effect.fail(
										new Error(
											`OpenCode instance client "${capturedInstanceId}" was not resolved`,
										),
									);
								}
								deleteApi = resolved;
							}

							yield* openCodeUpstreamAdapter(deleteApi).sync(command);
						}),
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
				}
			});

		const upstreamAdapter: SessionUpstreamAdapter = {
			provider: provider === CLAUDE_PROVIDER_ID ? "claude" : "opencode",
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

		const ownership = yield* PendingSendOwnershipTag;
		ownership.deleteSession(sessionId);
		for (const childSessionId of childSessionIds)
			ownership.deleteSession(childSessionId);

		// The delete took the whole lineage, so the cache must forget the whole
		// lineage: an edge naming a session that no longer exists would put a
		// deleted grandchild back under a live root on the next list.
		const deleted = new Set([sessionId, ...childSessionIds]);
		yield* Ref.update(stateRef, (s) => {
			const lastMessageAt = HashMap.remove(s.lastMessageAt, sessionId);
			const paginationCursors = HashMap.remove(s.paginationCursors, sessionId);

			const cachedParentMap = HashMap.filter(
				s.cachedParentMap,
				(parent, child) => !deleted.has(parent) && !deleted.has(child),
			);

			return {
				cachedParentMap,
				lastMessageAt,
				paginationCursors,
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
				...(provider !== undefined &&
				capturedInstanceId !== undefined &&
				capturedInstanceId !== provider
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

export const persistSessionPermissionMode = (
	sessionId: string,
	mode: SessionPermissionMode,
) =>
	Effect.gen(function* () {
		const eventStoreOption = yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);

		if (
			eventStoreOption._tag === "None" ||
			projectionRunnerOption._tag === "None" ||
			sqlOption._tag === "None"
		) {
			return yield* Effect.void;
		}

		// Append and projection are one transaction inside the seam, so the two
		// used to be separately labelled failures are now one: the whole write
		// either lands and is announced, or neither happened.
		const commitAndSignal = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sqlOption.value),
			Effect.provideService(EventStoreEffectTag, eventStoreOption.value),
			Effect.provideService(
				ProjectionRunnerEffectTag,
				projectionRunnerOption.value,
			),
		);

		const now = Date.now();
		yield* commitAndSignal([
			canonicalEvent(
				"session.permission_mode_changed",
				sessionId,
				{ sessionId, mode },
				{ createdAt: now, metadata: { source: "relay" } },
			),
		]).pipe(
			// BEGIN failures are typed; Effect SQL leaves COMMIT failures as defects.
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "persistPermissionMode.commit",
						cause,
					}),
			),
		);
	});

export const restoreSessionPermissionModes = () =>
	Effect.gen(function* () {
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const projectionRunnerOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);

		if (
			readQueryOption._tag === "None" ||
			projectionRunnerOption._tag === "None" ||
			sqlOption._tag === "None"
		) {
			return yield* Effect.succeed(0);
		}

		const readQuery = readQueryOption.value;
		const projectionRunner = projectionRunnerOption.value;
		const sql = sqlOption.value;

		const withSql = <A, E>(
			effect: Effect.Effect<A, E, SqlClient.SqlClient>,
		): Effect.Effect<A, E> =>
			effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

		const recovered = yield* projectionRunner.isRecovered();
		if (!recovered) {
			yield* withSql(projectionRunner.recover()).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({
							operation: "restorePermissionModes.recover",
							cause,
						}),
				),
				Effect.asVoid,
			);
		}

		const rows = yield* readQuery.listSessions().pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "restorePermissionModes.listSessions",
						cause,
					}),
			),
		);
		const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);
		let restored = 0;
		for (const row of rows) {
			const mode = row.permission_mode;
			if (mode === null || !isSessionPermissionMode(mode)) continue;
			yield* setPermissionMode(row.id, mode);
			restored += 1;
		}
		return restored;
	});

/**
 * Rename a session through Conduit's event store for Claude rows, otherwise via the API.
 */
export const renameSession = (sessionId: string, title: string) =>
	applySessionCommand({
		type: "session.renamed",
		data: { sessionId, title },
	}).pipe(
		Effect.mapError(
			(cause) => new SessionManagerError({ operation: "renameSession", cause }),
		),
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.renameSession", { attributes: { sessionId } }),
	);

/**
 * Clear the stored pagination cursor for a session.
 */
export const clearPaginationCursor = (sessionId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		yield* Ref.update(stateRef, (s) => ({
			...s,
			paginationCursors: HashMap.remove(s.paginationCursors, sessionId),
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.clearPaginationCursor", {
			attributes: { sessionId },
		}),
	);

/**
 * Seed a pagination cursor without overwriting a cursor already advanced by load-more.
 */
export const seedPaginationCursor = (sessionId: string, messageId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		yield* Ref.update(stateRef, (s) => {
			if (HashMap.has(s.paginationCursors, sessionId)) {
				return s;
			}
			return {
				...s,
				paginationCursors: HashMap.set(
					s.paginationCursors,
					sessionId,
					messageId,
				),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.seedPaginationCursor", {
			attributes: { sessionId },
		}),
	);

const loadHistoryByCursorScan = (sessionId: string, cursorId: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const all = yield* Effect.tryPromise({
			try: () =>
				api.session.messagesPage(sessionId, { limit: CURSOR_SCAN_LIMIT }),
			catch: (cause) => cause,
		}).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "loadHistoryByCursorScan",
						cause,
					}),
			),
		);

		const cursorIdx = all.findIndex((message) => message.id === cursorId);
		if (cursorIdx <= 0) {
			return { messages: [], hasMore: false } satisfies HistoryPage;
		}

		return {
			messages: all.slice(0, cursorIdx) as unknown as HistoryMessage[],
			hasMore: false,
		} satisfies HistoryPage;
	});

/**
 * Load one page of session history and maintain the service-owned pagination cursor.
 */
export const loadHistory = (
	sessionId: string,
	offset = 0,
	options?: LoadHistoryOptions,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const historyPageSize =
			options?.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		const state = yield* Ref.get(stateRef);
		const cursorOption =
			offset > 0 ? HashMap.get(state.paginationCursors, sessionId) : undefined;
		const before =
			cursorOption?._tag === "Some" ? cursorOption.value : undefined;

		if (offset > 0 && !before) {
			return { messages: [], hasMore: false } satisfies HistoryPage;
		}

		const fetchPage = (requestOptions: { limit: number; before?: string }) =>
			Effect.tryPromise({
				try: () => api.session.messagesPage(sessionId, requestOptions),
				catch: (cause) => cause,
			});

		const page = yield* fetchPage({
			limit: historyPageSize,
			...(before ? { before } : {}),
		}).pipe(
			Effect.catchAll((cause) => {
				if (
					before &&
					cause instanceof OpenCodeApiError &&
					cause.responseStatus === 400
				) {
					return Effect.gen(function* () {
						log.warn(
							`Pagination cursor failed for ${sessionId.slice(0, 12)} — falling back to full fetch`,
						);
						yield* clearPaginationCursor(sessionId);

						if (offset > 0) {
							return yield* loadHistoryByCursorScan(sessionId, before);
						}

						const retryPage = yield* fetchPage({ limit: historyPageSize }).pipe(
							Effect.mapError(
								(retryCause) =>
									new SessionManagerError({
										operation: "loadHistory",
										cause: retryCause,
									}),
							),
						);
						return {
							messages: retryPage as unknown as HistoryMessage[],
							hasMore: retryPage.length >= historyPageSize,
						} satisfies HistoryPage;
					});
				}

				return Effect.fail(
					new SessionManagerError({ operation: "loadHistory", cause }),
				);
			}),
		);

		if ("messages" in page) {
			return page;
		}

		const oldest = page[0];
		if (oldest) {
			yield* Ref.update(stateRef, (s) => ({
				...s,
				paginationCursors: HashMap.set(
					s.paginationCursors,
					sessionId,
					oldest.id,
				),
			}));
		}

		return {
			messages: page as unknown as HistoryMessage[],
			hasMore: page.length >= historyPageSize,
		} satisfies HistoryPage;
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.loadHistory", { attributes: { sessionId } }),
	);

/**
 * Load history and pre-render assistant markdown in one service boundary.
 */
export const loadPreRenderedHistory = (
	sessionId: string,
	offset?: number,
	options?: LoadHistoryOptions,
) =>
	Effect.gen(function* () {
		const page = yield* loadHistory(sessionId, offset, options);
		const renderer = yield* Effect.tryPromise(
			() => import("../../../relay/markdown-renderer.js"),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "loadPreRenderedHistory",
						cause,
					}),
			),
		);
		yield* Effect.sync(() => renderer.preRenderHistoryMessages(page.messages));
		return page;
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.loadPreRenderedHistory", {
			attributes: { sessionId },
		}),
	);

/**
 * Record message activity for a session (updates lastMessageAt timestamp).
 */
export const recordMessageActivity = (sessionId: string, timestamp?: number) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const ts = timestamp ?? Date.now();
		yield* Ref.update(ref, (s) => {
			const existing = HashMap.get(s.lastMessageAt, sessionId);
			if (existing._tag === "Some" && existing.value >= ts) return s;
			return {
				...s,
				lastMessageAt: HashMap.set(s.lastMessageAt, sessionId, ts),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.recordMessageActivity"),
	);

/** Record an eager child-to-parent session mapping. */
export const addToParentMap = (childId: string, parentId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			cachedParentMap: HashMap.set(s.cachedParentMap, childId, parentId),
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", childId),
		Effect.withSpan("session.addToParentMap"),
	);

/** Snapshot the current child-to-parent session map. */
export const getSessionParentMap = () =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const state = yield* Ref.get(ref);
		return new Map(HashMap.toEntries(state.cachedParentMap));
	}).pipe(Effect.withSpan("session.getSessionParentMap"));

/** Snapshot the most recently observed unfiltered session count. */
export const getLastKnownSessionCount = () =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const state = yield* Ref.get(ref);
		return state.lastKnownSessionCount;
	}).pipe(Effect.withSpan("session.getLastKnownSessionCount"));

/**
 * Record fork lineage through the event store and announce the projected row.
 */
export const setForkEntry = (sessionId: string, entry: ForkEntry) =>
	Effect.gen(function* () {
		if (entry.parentID) {
			yield* applySessionCommand({
				type: "session.forked",
				data: {
					sessionId,
					parentId: entry.parentID,
					...(entry.forkMessageId
						? { forkPointEvent: entry.forkMessageId }
						: {}),
					...(entry.forkPointTimestamp != null
						? { forkPointTimestamp: entry.forkPointTimestamp }
						: {}),
				},
			}).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({ operation: "setForkEntry", cause }),
				),
			);
		}

		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			cachedParentMap: entry.parentID
				? HashMap.set(s.cachedParentMap, sessionId, entry.parentID)
				: s.cachedParentMap,
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.setForkEntry"),
	);

/**
 * Send roots-only session list immediately, then all sessions in the background.
 */
export const sendDualSessionLists = (
	send: (msg: SessionListMessage) => void,
	options?: { statuses?: Record<string, SessionStatus> | undefined },
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const roots = yield* listSessions({
			roots: true,
			statuses: options?.statuses,
		});
		send({
			type: "session_list",
			sessions: roots,
			roots: true,
		});

		yield* Effect.forkDaemon(
			listSessions({ statuses: options?.statuses }).pipe(
				Effect.tap((all) =>
					Effect.sync(() =>
						send({
							type: "session_list",
							sessions: all,
							roots: false,
						}),
					),
				),
				Effect.catchAll((err) =>
					Effect.sync(() =>
						log.warn(`Background all-sessions fetch failed: ${err}`),
					),
				),
			),
		);
	}).pipe(
		Effect.annotateLogs("operation", "sendDualSessionLists"),
		Effect.withSpan("session.sendDualSessionLists"),
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
	createSession(
		title?: string,
		options?: CreateSessionOptions,
	): Effect.Effect<SessionDetail, SessionManagerError>;
	establishOpenCodeSession(
		session: SessionDetail,
		providerInstanceId: ProviderInstanceId,
	): Effect.Effect<void, SessionManagerError>;
	deleteSession(sessionId: string): Effect.Effect<boolean, SessionManagerError>;
	renameSession(
		sessionId: string,
		title: string,
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
	setForkEntry(
		sessionId: string,
		entry: ForkEntry,
	): Effect.Effect<void, SessionManagerError>;
	sendDualSessionLists(
		send: (msg: SessionListMessage) => void,
		options?: { statuses?: Record<string, SessionStatus> | undefined },
	): Effect.Effect<void, SessionManagerError>;
}

// ─── Service Tag ────────────────────────────────────────────────────────────

/** Bundled service object for callers that prefer DI over free functions. */
export class SessionManagerServiceTag extends Context.Tag(
	"SessionManagerService",
)<SessionManagerServiceTag, SessionManagerService>() {}

// ─── Service Layer ──────────────────────────────────────────────────────────

export const SessionManagerServiceLive: Layer.Layer<
	SessionManagerServiceTag | PendingSendOwnershipTag,
	never,
	OpenCodeAPITag | SessionManagerStateTag | LoggerTag | DaemonEventBusTag
> = Layer.effect(
	SessionManagerServiceTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const eventBus = yield* DaemonEventBusTag;
		const ownership = yield* PendingSendOwnershipTag;
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const configDir =
			configOption._tag === "Some" ? configOption.value.configDir : undefined;
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
		const eventStoreEffectOption =
			yield* Effect.serviceOption(EventStoreEffectTag);
		const projectionRunnerEffectOption = yield* Effect.serviceOption(
			ProjectionRunnerEffectTag,
		);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const statusPollerOption = yield* Effect.serviceOption(StatusPollerTag);
		const instanceClientsOption = yield* Effect.serviceOption(
			OpenCodeInstanceClientsTag,
		);
		const inFlightDeletes = new Map<
			string,
			Deferred.Deferred<void, SessionManagerError>
		>();
		const currentStatuses = (
			explicit?: Record<string, SessionStatus> | undefined,
		): Effect.Effect<Record<string, SessionStatus> | undefined> => {
			if (explicit !== undefined) return Effect.succeed(explicit);
			return statusPollerOption._tag === "Some"
				? statusPollerOption.value.getCurrentStatuses()
				: Effect.succeed(undefined);
		};
		const establishOpenCodeSession = (
			session: SessionDetail,
			providerInstanceId: ProviderInstanceId,
		): Effect.Effect<void, SessionManagerError> =>
			Effect.gen(function* () {
				const persistenceConfigured =
					configOption._tag === "Some" &&
					configOption.value.persistenceDbPath != null;
				const persistenceUnavailable =
					eventStoreEffectOption._tag === "None" &&
					projectionRunnerEffectOption._tag === "None" &&
					sqlOption._tag === "None";
				if (!persistenceConfigured && persistenceUnavailable) return;

				if (
					eventStoreEffectOption._tag === "None" ||
					projectionRunnerEffectOption._tag === "None" ||
					sqlOption._tag === "None"
				) {
					return yield* new SessionManagerError({
						operation: "establishOpenCodeSession.services",
						cause: "SQLite event-store services are unavailable",
					});
				}

				const eventStore = eventStoreEffectOption.value;
				const sql = sqlOption.value;
				// `write` rather than the plain form: the seed and the verification
				// query belong in the same transaction as the append, and projecting
				// through the handle it hands us is what makes the announcement
				// unskippable.
				const commitAndSignal = yield* makeCommitAndSignal.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(EventStoreEffectTag, eventStore),
					Effect.provideService(
						ProjectionRunnerEffectTag,
						projectionRunnerEffectOption.value,
					),
				);

				const now = Date.now();
				const normalizedTitle = normalizeSessionTitle(session.title);
				yield* commitAndSignal
					.write((project) =>
						Effect.gen(function* () {
							yield* sql`
					INSERT OR IGNORE INTO sessions (
						id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${session.id}, ${providerInstanceId}, ${session.id}, ${normalizedTitle}, 'idle', ${now}, ${now}
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
		const serviceListSessions = (options?: ListSessionsOptions) =>
			Effect.gen(function* () {
				const statuses = yield* currentStatuses(options?.statuses);
				const base = listSessions({
					...options,
					statuses,
				}).pipe(
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
				);
				const withEffectRead =
					readQueryEffectOption._tag === "Some"
						? base.pipe(
								Effect.provideService(
									ReadQueryEffectTag,
									readQueryEffectOption.value,
								),
							)
						: base;
				return yield* withEffectRead;
			});
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
						if (engineOption._tag === "Some") {
							engineOption.value.bindSession(session.id, providerId);
						}
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
							// Phase 4.4: a session bound to a NAMED OpenCode instance is
							// created on THAT instance's server; the default id (and
							// wirings without the instance-clients service, e.g. legacy
							// or unit harnesses) use the project-default client. A named
							// instance that cannot be resolved fails the create cleanly
							// instead of silently landing on the default server.
							const instanceApi =
								instanceId !== undefined &&
								instanceClientsOption._tag === "Some"
									? yield* instanceClientsOption.value
											.clientFor(instanceId)
											.pipe(
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
					Effect.either(createLocalSession(title, instanceId));

				const selectedInstanceId = options?.instanceId;
				if (selectedInstanceId !== undefined) {
					const selectedDriver =
						yield* resolveSelectedDriver(selectedInstanceId);
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
			establishOpenCodeSession,
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
					const completion = yield* Deferred.make<void, SessionManagerError>();
					const existing = inFlightDeletes.get(sessionId);
					if (existing) {
						yield* Deferred.await(existing);
						return false;
					}

					inFlightDeletes.set(sessionId, completion);
					const base = deleteSession(sessionId).pipe(
						Effect.provideService(PendingSendOwnershipTag, ownership),
						Effect.provideService(OpenCodeAPITag, api),
						Effect.provideService(SessionManagerStateTag, stateRef),
						Effect.provideService(LoggerTag, log),
					);
					const withReadQuery =
						readQueryEffectOption._tag === "Some"
							? base.pipe(
									Effect.provideService(
										ReadQueryEffectTag,
										readQueryEffectOption.value,
									),
								)
							: base;
					const withEventStore =
						eventStoreEffectOption._tag === "Some"
							? withReadQuery.pipe(
									Effect.provideService(
										EventStoreEffectTag,
										eventStoreEffectOption.value,
									),
								)
							: withReadQuery;
					const withProjectionRunner =
						projectionRunnerEffectOption._tag === "Some"
							? withEventStore.pipe(
									Effect.provideService(
										ProjectionRunnerEffectTag,
										projectionRunnerEffectOption.value,
									),
								)
							: withEventStore;
					const withSql =
						sqlOption._tag === "Some"
							? withProjectionRunner.pipe(
									Effect.provideService(SqlClient.SqlClient, sqlOption.value),
								)
							: withProjectionRunner;
					const withConfig =
						configOption._tag === "Some"
							? withSql.pipe(
									Effect.provideService(ConfigTag, configOption.value),
								)
							: withSql;
					const withEngine =
						engineOption._tag === "Some"
							? withConfig.pipe(
									Effect.provideService(
										OrchestrationEngineTag,
										engineOption.value,
									),
								)
							: withConfig;
					const deleteAndPublish = Effect.gen(function* () {
						yield* instanceClientsOption._tag === "Some"
							? withEngine.pipe(
									Effect.provideService(
										OpenCodeInstanceClientsTag,
										instanceClientsOption.value,
									),
								)
							: withEngine;
						yield* publishSessionDeleted(sessionId).pipe(
							Effect.provideService(DaemonEventBusTag, eventBus),
						);
					});
					const exit = yield* Effect.exit(deleteAndPublish);

					yield* Deferred.done(completion, exit);
					yield* Effect.sync(() => {
						if (inFlightDeletes.get(sessionId) === completion) {
							inFlightDeletes.delete(sessionId);
						}
					});

					return yield* Exit.matchEffect(exit, {
						onFailure: Effect.failCause,
						onSuccess: () => Effect.succeed(true),
					});
				}),
			renameSession: (sessionId, title) =>
				(() => {
					const base = renameSession(sessionId, title).pipe(
						Effect.provideService(OpenCodeAPITag, api),
					);
					const withReadQuery =
						readQueryEffectOption._tag === "Some"
							? base.pipe(
									Effect.provideService(
										ReadQueryEffectTag,
										readQueryEffectOption.value,
									),
								)
							: base;
					const withEventStore =
						eventStoreEffectOption._tag === "Some"
							? withReadQuery.pipe(
									Effect.provideService(
										EventStoreEffectTag,
										eventStoreEffectOption.value,
									),
								)
							: withReadQuery;
					const withProjectionRunner =
						projectionRunnerEffectOption._tag === "Some"
							? withEventStore.pipe(
									Effect.provideService(
										ProjectionRunnerEffectTag,
										projectionRunnerEffectOption.value,
									),
								)
							: withEventStore;
					return sqlOption._tag === "Some"
						? withProjectionRunner.pipe(
								Effect.provideService(SqlClient.SqlClient, sqlOption.value),
							)
						: withProjectionRunner;
				})(),
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
			setForkEntry: (sessionId, entry) =>
				Effect.gen(function* () {
					yield* setForkEntry(sessionId, entry).pipe(
						Effect.provideService(SessionManagerStateTag, stateRef),
					);
				}),
			sendDualSessionLists: (send, options) =>
				Effect.gen(function* () {
					const roots = yield* serviceListSessions({
						roots: true,
						statuses: options?.statuses,
					});
					send({
						type: "session_list",
						sessions: roots,
						roots: true,
					});

					yield* Effect.forkDaemon(
						serviceListSessions({ statuses: options?.statuses }).pipe(
							Effect.tap((all) =>
								Effect.sync(() =>
									send({
										type: "session_list",
										sessions: all,
										roots: false,
									}),
								),
							),
							Effect.catchAll((err) =>
								Effect.sync(() =>
									log.warn(`Background all-sessions fetch failed: ${err}`),
								),
							),
						),
					);
				}),
		} satisfies SessionManagerService;
	}),
).pipe(Layer.provideMerge(PendingSendOwnershipLive));
