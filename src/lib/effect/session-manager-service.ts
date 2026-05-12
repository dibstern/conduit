// ─── SessionManager Service (Effect) ────────────────────────────────────────
// Pure Effect functions that replace the imperative SessionManager methods.
// State lives in SessionManagerStateTag (Ref<SessionManagerState>);
// API calls go through OpenCodeAPITag.
//
// Exported free functions can be used directly in Effect pipelines.
// SessionManagerServiceTag bundles them for callers that prefer a service object.

import { Context, Data, Effect, HashMap, Layer, Ref, Schedule } from "effect";
import {
	type ForkEntry,
	loadForkMetadata,
	saveForkMetadata,
} from "../daemon/fork-metadata.js";
import type { SessionDetail, SessionStatus } from "../instance/sdk-types.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import type { SessionRow } from "../persistence/read-model-types.js";
import { sessionRowsToSessionInfoList } from "../persistence/session-list-adapter.js";
import { toSessionInfoList } from "../session/session-info-list.js";
import type { RelayMessage, SessionInfo } from "../types.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	ReadQueryTag,
	StatusPollerTag,
} from "./services.js";
import { SessionManagerStateTag } from "./session-manager-state.js";

// ─── Retry policy ──────────────────────────────────────────────────────────

const retryPolicy = Schedule.exponential("500 millis").pipe(
	Schedule.intersect(Schedule.recurs(3)),
);

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
		const readQueryOption = yield* Effect.serviceOption(ReadQueryTag);
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

		if (readQueryOption._tag === "Some") {
			const rows = yield* Effect.try({
				try: () => readQueryOption.value.listSessions(sqOpts),
				catch: (cause) =>
					new SessionManagerError({ operation: "listSessions", cause }),
			});
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
	recordMessageActivity(
		sessionId: string,
		timestamp?: number,
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
	OpenCodeAPITag | SessionManagerStateTag | LoggerTag
> = Layer.effect(
	SessionManagerServiceTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const statusPollerOption = yield* Effect.serviceOption(StatusPollerTag);
		const configOption = yield* Effect.serviceOption(ConfigTag);
		const configDir =
			configOption._tag === "Some" ? configOption.value.configDir : undefined;
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
		const readQueryOption = yield* Effect.serviceOption(ReadQueryTag);
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
			return readQueryOption._tag === "Some"
				? withEffectRead.pipe(
						Effect.provideService(ReadQueryTag, readQueryOption.value),
					)
				: withEffectRead;
		};

		return {
			listSessions: serviceListSessions,
			createSession: (title) =>
				createSession(title).pipe(Effect.provideService(OpenCodeAPITag, api)),
			deleteSession: (sessionId) =>
				deleteSession(sessionId).pipe(
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			renameSession: (sessionId, title) =>
				renameSession(sessionId, title).pipe(
					Effect.provideService(OpenCodeAPITag, api),
				),
			recordMessageActivity: (sessionId, timestamp) =>
				recordMessageActivity(sessionId, timestamp).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			setForkEntry: (sessionId, entry) =>
				setForkEntry(sessionId, entry, configDir).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
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
