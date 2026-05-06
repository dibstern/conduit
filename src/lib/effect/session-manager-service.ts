// ─── SessionManager Service (Effect) ────────────────────────────────────────
// Pure Effect functions that replace the imperative SessionManager methods.
// State lives in SessionManagerStateTag (Ref<SessionManagerState>);
// API calls go through OpenCodeAPITag.
//
// Exported free functions can be used directly in Effect pipelines.
// SessionManagerServiceTag bundles them for callers that prefer a service object.

import { Context, Data, Effect, HashMap, Layer, Ref, Schedule } from "effect";
import { OpenCodeAPITag } from "./services.js";
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

// ─── Free functions ─────────────────────────────────────────────────────────

/**
 * Fetch the session list from the API.
 * Caches the child-to-parent map in state for subagent status propagation.
 */
export const listSessions = (options?: { limit?: number; roots?: boolean }) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;

		const sessions = yield* Effect.tryPromise(() =>
			api.session.list(options),
		).pipe(
			Effect.retry(retryPolicy),
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: "listSessions", cause }),
			),
		);

		// Build parent map from sessions that have a parentID
		if (sessions) {
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

		return sessions;
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

// ─── Service Tag ────────────────────────────────────────────────────────────

/** Bundled service object for callers that prefer DI over free functions. */
export class SessionManagerServiceTag extends Context.Tag(
	"SessionManagerService",
)<
	SessionManagerServiceTag,
	{
		listSessions: typeof listSessions;
		createSession: typeof createSession;
		deleteSession: typeof deleteSession;
		recordMessageActivity: typeof recordMessageActivity;
	}
>() {}

// ─── Service Layer ──────────────────────────────────────────────────────────

export const SessionManagerServiceLive = Layer.succeed(
	SessionManagerServiceTag,
	{
		listSessions,
		createSession,
		deleteSession,
		recordMessageActivity,
	},
);
