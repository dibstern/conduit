// ─── SessionManager Service (Effect) ────────────────────────────────────────
// Pure Effect functions that replace the imperative SessionManager methods.
// State lives in SessionManagerStateTag (Ref<SessionManagerState>);
// API calls go through OpenCodeAPITag.
//
// Exported free functions can be used directly in Effect pipelines.
// SessionManagerServiceTag bundles them for callers that prefer a service object.

import { Context, Data, Effect, HashMap, Layer, Ref, Schedule } from "effect";
import type { SessionDetail, SessionStatus } from "../instance/sdk-types.js";
import { toSessionInfoList } from "../session/session-info-list.js";
import type { RelayMessage, SessionInfo } from "../types.js";
import { LoggerTag, OpenCodeAPITag, StatusPollerTag } from "./services.js";
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

// ─── Free functions ─────────────────────────────────────────────────────────

/**
 * Fetch the session list from the API.
 * Caches the child-to-parent map in state for subagent status propagation.
 */
export const listSessions = (options?: ListSessionsOptions) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
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

		const state = yield* Ref.get(stateRef);

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
	recordMessageActivity(
		sessionId: string,
		timestamp?: number,
	): Effect.Effect<void>;
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
		const currentStatuses = (
			explicit?: Record<string, SessionStatus> | undefined,
		): Record<string, SessionStatus> | undefined =>
			explicit ??
			(statusPollerOption._tag === "Some"
				? statusPollerOption.value.getCurrentStatuses?.()
				: undefined);

		return {
			listSessions: (options) =>
				listSessions({
					...options,
					statuses: currentStatuses(options?.statuses),
				}).pipe(
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			createSession: (title) =>
				createSession(title).pipe(Effect.provideService(OpenCodeAPITag, api)),
			deleteSession: (sessionId) =>
				deleteSession(sessionId).pipe(
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			recordMessageActivity: (sessionId, timestamp) =>
				recordMessageActivity(sessionId, timestamp).pipe(
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
			sendDualSessionLists: (send, options) =>
				sendDualSessionLists(send, {
					statuses: currentStatuses(options?.statuses),
				}).pipe(
					Effect.provideService(LoggerTag, log),
					Effect.provideService(OpenCodeAPITag, api),
					Effect.provideService(SessionManagerStateTag, stateRef),
				),
		} satisfies SessionManagerService;
	}),
);
