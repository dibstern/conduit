import { OpenCodeAPITag } from "./opencode-api-service.js";
// ─── OpenCode API Request/RequestResolver ───────────────────────────────────
// Effect Request types and RequestResolver implementations for OpenCode API
// calls, enabling automatic batching of concurrent requests.
//
// Request types:
//   GetSessions     — fetches the session list
//   GetMessages     — fetches messages for a given session
//   GetSessionStatuses — fetches status map for all sessions (single HTTP call)
//   GetSession      — fetches a single session detail (batchable)
//
// Batching strategy:
//   The OpenCode API's session.statuses() already returns all statuses in a
//   single call (Record<string, SessionStatus>), so GetSessionStatuses uses
//   a simple fromEffect resolver — no per-ID batching needed.
//
//   GetSession requests ARE batchable: when multiple fibers concurrently need
//   individual session details, the batched resolver groups them and resolves
//   each from a single session.list() call.
//
// API endpoints verified against:
//   - src/lib/instance/opencode-api.ts (the actual SDK wrapper)
//   - src/lib/domain/provider/Services/opencode-response-schemas.ts (Schema definitions)
//   - src/lib/instance/sdk-types.ts (type definitions)

import { Data, Effect, Request, RequestResolver } from "effect";
import type { NonEmptyArray } from "effect/Array";

import type {
	SessionDetail as SchemaSessionDetail,
	SessionStatus,
} from "./opencode-response-schemas.js";

// ─── Error Type ────────────────────────────────────────────────────────────

export class OpenCodeRequestError extends Data.TaggedError(
	"OpenCodeRequestError",
)<{
	readonly method: string;
	readonly cause: unknown;
}> {}

// ─── Message shape returned by GetMessages ─────────────────────────────────
// Matches the flat message shape from OpenCodeAPI.session.messages()

interface FlatMessage {
	readonly id: string;
	readonly role: string;
	readonly sessionID: string;
	readonly parts?: ReadonlyArray<{
		readonly id: string;
		readonly type: string;
	}>;
}

// ─── Request Types ─────────────────────────────────────────────────────────

/** Fetch the session list. Returns Array<SessionDetail>. */
export class GetSessions extends Request.TaggedClass("GetSessions")<
	ReadonlyArray<SchemaSessionDetail>,
	OpenCodeRequestError,
	Record<string, never>
> {}

/** Fetch messages for a specific session. Returns Array<FlatMessage>. */
export class GetMessages extends Request.TaggedClass("GetMessages")<
	ReadonlyArray<FlatMessage>,
	OpenCodeRequestError,
	{ readonly sessionId: string }
> {}

/** Fetch all session statuses. Returns Record<string, SessionStatus>. */
export class GetSessionStatuses extends Request.TaggedClass(
	"GetSessionStatuses",
)<Record<string, SessionStatus>, OpenCodeRequestError, Record<string, never>> {}

/** Fetch a single session detail by ID. Batchable via session.list(). */
export class GetSession extends Request.TaggedClass("GetSession")<
	SchemaSessionDetail,
	OpenCodeRequestError,
	{ readonly sessionId: string }
> {}

// ─── Union type for all requests ───────────────────────────────────────────

export type OpenCodeRequest =
	| GetSessions
	| GetMessages
	| GetSessionStatuses
	| GetSession;

// ─── Individual Resolvers ──────────────────────────────────────────────────

/** Resolver for GetSessions — calls session.list() */
export const GetSessionsResolver = RequestResolver.fromEffect(
	(_req: GetSessions) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.list(),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.list", cause }),
			});
		}).pipe(Effect.withSpan("opencode.request.GetSessions")),
);

/** Resolver for GetMessages — calls session.messages(sessionId) */
export const GetMessagesResolver = RequestResolver.fromEffect(
	(req: GetMessages) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.messages(req.sessionId),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.messages", cause }),
			});
		}).pipe(Effect.withSpan("opencode.request.GetMessages")),
);

/** Resolver for GetSessionStatuses — calls session.statuses() (returns all at once) */
export const GetSessionStatusesResolver = RequestResolver.fromEffect(
	(_req: GetSessionStatuses) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.statuses(),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.statuses", cause }),
			});
		}).pipe(Effect.withSpan("opencode.request.GetSessionStatuses")),
);

// ─── Batched Resolver ──────────────────────────────────────────────────────

/**
 * Batched resolver for GetSession — when multiple fibers concurrently request
 * individual session details, fetches session.list() once and resolves each
 * request from the result.
 *
 * Sessions not found in the list are failed with OpenCodeRequestError.
 */
export const GetSessionBatchedResolver = RequestResolver.makeBatched(
	(requests: NonEmptyArray<GetSession>) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;

			// Fetch all sessions in a single API call
			const sessions = yield* Effect.tryPromise({
				try: () => api.session.list(),
				catch: (cause) =>
					new OpenCodeRequestError({
						method: "session.list (batched)",
						cause,
					}),
			});

			// Build lookup map for O(1) resolution
			const sessionMap = new Map<string, SchemaSessionDetail>();
			for (const session of sessions) {
				sessionMap.set(session.id, session);
			}

			// Resolve each request
			yield* Effect.forEach(
				requests,
				(req) => {
					const session = sessionMap.get(req.sessionId);
					if (session) {
						return Request.succeed(req, session);
					}
					return Request.fail(
						req,
						new OpenCodeRequestError({
							method: "session.get (batched)",
							cause: new Error(`Session not found: ${req.sessionId}`),
						}),
					);
				},
				{ discard: true },
			);
		}).pipe(
			// If the batch fetch itself fails, fail all requests
			Effect.catchAll((error) =>
				Effect.forEach(requests, (req) => Request.fail(req, error), {
					discard: true,
				}),
			),
			Effect.withSpan("opencode.request.GetSession.batched", {
				attributes: { batchSize: requests.length },
			}),
		),
);

// ─── Convenience functions ─────────────────────────────────────────────────
// These use RequestResolver.contextFromEffect to lift the context-dependent
// resolvers into Effect values that Effect.request accepts.

/** Fetch the session list via the request system. */
export const getSessions = Effect.flatMap(
	RequestResolver.contextFromEffect(GetSessionsResolver),
	(resolver) => Effect.request(new GetSessions({}), resolver),
);

/** Fetch messages for a session via the request system. */
export const getMessages = (sessionId: string) =>
	Effect.flatMap(
		RequestResolver.contextFromEffect(GetMessagesResolver),
		(resolver) => Effect.request(new GetMessages({ sessionId }), resolver),
	);

/** Fetch all session statuses via the request system. */
export const getSessionStatuses = Effect.flatMap(
	RequestResolver.contextFromEffect(GetSessionStatusesResolver),
	(resolver) => Effect.request(new GetSessionStatuses({}), resolver),
);

/** Fetch a single session detail via the batched request system. */
export const getSession = (sessionId: string) =>
	Effect.flatMap(
		RequestResolver.contextFromEffect(GetSessionBatchedResolver),
		(resolver) => Effect.request(new GetSession({ sessionId }), resolver),
	);
