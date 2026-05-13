// ─── SessionManager Service (Effect) ────────────────────────────────────────
// Pure Effect functions that replace the imperative SessionManager methods.
// State lives in SessionManagerStateTag (Ref<SessionManagerState>);
// API calls go through OpenCodeAPITag.
//
// Exported free functions can be used directly in Effect pipelines.
// SessionManagerServiceTag bundles them for callers that prefer a service object.

import {
	Context,
	Data,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schedule,
} from "effect";
import {
	type ForkEntry,
	loadForkMetadata,
	saveForkMetadata,
} from "../daemon/fork-metadata.js";
import { OpenCodeApiError } from "../errors.js";
import type { SessionDetail, SessionStatus } from "../instance/sdk-types.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../persistence/read-model-types.js";
import { sessionRowsToSessionInfoList } from "../persistence/session-list-adapter.js";
import { toSessionInfoList } from "../session/session-info-list.js";
import type { HistoryMessage } from "../shared-types.js";
import type { RelayMessage, SessionInfo } from "../types.js";
import {
	DaemonEventBusTag,
	publishSessionCreated,
	publishSessionDeleted,
} from "./daemon-pubsub.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	SessionManagerTag,
	StatusPollerTag,
} from "./services.js";
import { SessionManagerStateTag } from "./session-manager-state.js";

// ─── Retry policy ──────────────────────────────────────────────────────────

const retryPolicy = Schedule.exponential("500 millis").pipe(
	Schedule.intersect(Schedule.recurs(3)),
);

const DEFAULT_HISTORY_PAGE_SIZE = 50;
const CURSOR_SCAN_LIMIT = 10_000;

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

const sessionRowsParentMap = (
	rows: readonly SessionRow[],
	forkMeta: HashMap.HashMap<string, ForkEntry>,
): HashMap.HashMap<string, string> => {
	let parentMap = HashMap.empty<string, string>();
	for (const row of rows) {
		const forkEntry = HashMap.get(forkMeta, row.id);
		const parentID =
			row.parent_id ??
			(forkEntry._tag === "Some" ? forkEntry.value.parentID : undefined);
		if (parentID) {
			parentMap = HashMap.set(parentMap, row.id, parentID);
		}
	}
	return parentMap;
};

const sessionRowsToInfo = (
	rows: readonly SessionRow[],
	options: ListSessionsOptions | undefined,
	state: {
		forkMeta: HashMap.HashMap<string, ForkEntry>;
		pendingQuestionCounts: HashMap.HashMap<string, number>;
	},
): SessionInfo[] =>
	sessionRowsToSessionInfoList(Array.from(rows), {
		...(options?.statuses !== undefined ? { statuses: options.statuses } : {}),
		forkMeta: toReadonlyMap(state.forkMeta),
		pendingQuestionCounts: toReadonlyMap(state.pendingQuestionCounts),
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
		const sqOpts =
			options?.roots !== undefined ? { roots: options.roots } : undefined;
		const state = yield* Ref.get(stateRef);

		if (readQueryEffectOption._tag === "Some") {
			const rows = yield* readQueryEffectOption.value
				.listSessions(sqOpts)
				.pipe(
					Effect.mapError(
						(cause) =>
							new SessionManagerError({ operation: "listSessions", cause }),
					),
				);
			if (!options?.roots) {
				yield* Ref.update(stateRef, (s) => ({
					...s,
					cachedParentMap: sessionRowsParentMap(rows, s.forkMeta),
				}));
			}
			return sessionRowsToInfo(rows, options, state);
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
			let parentMap = HashMap.empty<string, string>();
			for (const session of sessions) {
				const rec = session as Record<string, unknown>;
				const parentID = rec["parentID"];
				if (typeof parentID === "string") {
					parentMap = HashMap.set(parentMap, session.id, parentID);
				}
			}
			yield* Ref.update(stateRef, (s) => ({
				...s,
				cachedParentMap: parentMap,
			}));
		}

		return toSessionInfoList(
			sessions,
			options?.statuses,
			toReadonlyMap(state.lastMessageAt),
			toReadonlyMap(state.forkMeta),
			toReadonlyMap(state.pendingQuestionCounts),
		);
	}).pipe(
		Effect.annotateLogs("operation", "listSessions"),
		Effect.withSpan("session.listSessions"),
	);

/**
 * Create a new session via the API.
 */
export const createSession = (title?: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		// No retry: create is not idempotent — retrying could produce duplicates.
		const session = yield* Effect.tryPromise(() =>
			api.session.create(title ? { title } : undefined),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "createSession", cause }),
			),
		);
		return session;
	}).pipe(
		Effect.annotateLogs("operation", "createSession"),
		Effect.withSpan("session.createSession"),
	);

/**
 * Delete a session via the API and clear all associated state.
 */
export const deleteSession = (sessionId: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;

		// No retry: delete is not idempotent — retrying a 404 would fail unnecessarily.
		yield* Effect.tryPromise(() => api.session.delete(sessionId)).pipe(
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
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.deleteSession", { attributes: { sessionId } }),
	);

/**
 * Rename a session via the API.
 */
export const renameSession = (sessionId: string, title: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		yield* Effect.tryPromise(() =>
			api.session.update(sessionId, { title }),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "renameSession", cause }),
			),
		);
	}).pipe(
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
			() => import("../relay/markdown-renderer.js"),
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
		yield* Ref.update(ref, (s) => ({
			...s,
			lastMessageAt: HashMap.set(
				s.lastMessageAt,
				sessionId,
				timestamp ?? Date.now(),
			),
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.recordMessageActivity"),
	);

/** Increment pending question count for a session. */
export const incrementPendingQuestionCount = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => {
			const current = Option.getOrElse(
				HashMap.get(s.pendingQuestionCounts, sessionId),
				() => 0,
			);
			return {
				...s,
				pendingQuestionCounts: HashMap.set(
					s.pendingQuestionCounts,
					sessionId,
					current + 1,
				),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.incrementPendingQuestionCount"),
	);

/** Decrement pending question count for a session and clear zero counts. */
export const decrementPendingQuestionCount = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => {
			const current = Option.getOrElse(
				HashMap.get(s.pendingQuestionCounts, sessionId),
				() => 0,
			);
			return {
				...s,
				pendingQuestionCounts:
					current <= 1
						? HashMap.remove(s.pendingQuestionCounts, sessionId)
						: HashMap.set(s.pendingQuestionCounts, sessionId, current - 1),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.decrementPendingQuestionCount"),
	);

/** Replace pending question counts from a reconnect/list-pending snapshot. */
export const setPendingQuestionCounts = (counts: ReadonlyMap<string, number>) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			pendingQuestionCounts: HashMap.fromIterable(counts),
		}));
	}).pipe(Effect.withSpan("session.setPendingQuestionCounts"));

/** Record fork-point metadata for a forked session and persist it to disk. */
export const setForkEntry = (
	sessionId: string,
	entry: ForkEntry,
	configDir?: string,
) =>
	Effect.gen(function* () {
		const ref = yield* SessionManagerStateTag;
		const forkMeta = yield* Ref.modify(ref, (s) => {
			const nextForkMeta = HashMap.set(s.forkMeta, sessionId, entry);
			return [
				nextForkMeta,
				{
					...s,
					forkMeta: nextForkMeta,
				},
			] as const;
		});

		yield* Effect.try({
			try: () =>
				saveForkMetadata(new Map(HashMap.toEntries(forkMeta)), configDir),
			catch: (cause) =>
				new SessionManagerError({ operation: "setForkEntry", cause }),
		});
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
		send({ type: "session_list", sessions: roots, roots: true });

		yield* Effect.forkDaemon(
			listSessions({ statuses: options?.statuses }).pipe(
				Effect.tap((all) =>
					Effect.sync(() =>
						send({ type: "session_list", sessions: all, roots: false }),
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
	getDefaultSessionId(
		title?: string,
	): Effect.Effect<string, SessionManagerError>;
	listSessions(
		options?: ListSessionsOptions,
	): Effect.Effect<SessionInfo[], SessionManagerError>;
	createSession(
		title?: string,
	): Effect.Effect<SessionDetail, SessionManagerError>;
	deleteSession(sessionId: string): Effect.Effect<void, SessionManagerError>;
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
	incrementPendingQuestionCount(sessionId: string): Effect.Effect<void>;
	decrementPendingQuestionCount(sessionId: string): Effect.Effect<void>;
	setPendingQuestionCounts(
		counts: ReadonlyMap<string, number>,
	): Effect.Effect<void>;
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
	SessionManagerServiceTag,
	never,
	OpenCodeAPITag | SessionManagerStateTag | LoggerTag | DaemonEventBusTag
> = Layer.effect(
	SessionManagerServiceTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const eventBus = yield* DaemonEventBusTag;
		const statusPollerOption = yield* Effect.serviceOption(StatusPollerTag);
		const legacySessionManagerOption =
			yield* Effect.serviceOption(SessionManagerTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const configDir =
			configOption._tag === "Some" ? configOption.value.configDir : undefined;
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
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
		const currentStatuses = (
			explicit?: Record<string, SessionStatus> | undefined,
		): Record<string, SessionStatus> | undefined =>
			explicit ??
			(statusPollerOption._tag === "Some"
				? statusPollerOption.value.getCurrentStatuses?.()
				: undefined);
		const serviceListSessions = (options?: ListSessionsOptions) => {
			const base = listSessions({
				...options,
				statuses: currentStatuses(options?.statuses),
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
			return withEffectRead;
		};

		return {
			getDefaultSessionId: (title) =>
				Effect.gen(function* () {
					const sessions = yield* serviceListSessions();
					if (sessions.length > 0) {
						const topLevel = sessions.find((session) => !session.parentID);
						return (topLevel ?? sessions[0])?.id ?? "";
					}
					const session = yield* createSession(title).pipe(
						Effect.provideService(OpenCodeAPITag, api),
					);
					yield* publishSessionCreated(session.id).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
					return session.id;
				}),
			listSessions: serviceListSessions,
			createSession: (title) =>
				Effect.gen(function* () {
					const session = yield* createSession(title).pipe(
						Effect.provideService(OpenCodeAPITag, api),
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
					);
					yield* publishSessionDeleted(sessionId).pipe(
						Effect.provideService(DaemonEventBusTag, eventBus),
					);
				}),
			renameSession: (sessionId, title) =>
				renameSession(sessionId, title).pipe(
					Effect.provideService(OpenCodeAPITag, api),
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
					);
					if (legacySessionManagerOption._tag === "Some") {
						yield* Effect.try({
							try: () =>
								legacySessionManagerOption.value.setForkEntry(sessionId, entry),
							catch: (cause) =>
								new SessionManagerError({
									operation: "setForkEntry",
									cause,
								}),
						});
					}
				}),
			sendDualSessionLists: (send, options) =>
				Effect.gen(function* () {
					const roots = yield* serviceListSessions({
						roots: true,
						statuses: options?.statuses,
					});
					send({ type: "session_list", sessions: roots, roots: true });

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
);
