import { OpenCodeAPITag } from "./opencode-api-service.js";
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
//   - src/lib/contracts/providers/opencode-sdk.ts (provider boundary schemas)
//   - src/lib/instance/sdk-types.ts (type definitions)

import { Context, Data, Effect, Request, RequestResolver } from "effect";

import type {
	SessionDetail as SchemaSessionDetail,
	SessionStatus,
} from "../../../contracts/providers/opencode-sdk.js";

export class OpenCodeRequestError extends Data.TaggedError(
	"OpenCodeRequestError",
)<{
	readonly method: string;
	readonly cause: unknown;
}> {}

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

/** Fetch the session list. Returns Array<SessionDetail>. */
export class GetSessions extends Request.TaggedClass("GetSessions")<
	Record<string, never>,
	ReadonlyArray<SchemaSessionDetail>,
	OpenCodeRequestError,
	OpenCodeAPITag
> {}

/** Fetch messages for a specific session. Returns Array<FlatMessage>. */
export class GetMessages extends Request.TaggedClass("GetMessages")<
	{ readonly sessionId: string },
	ReadonlyArray<FlatMessage>,
	OpenCodeRequestError,
	OpenCodeAPITag
> {}

/** Fetch all session statuses. Returns Record<string, SessionStatus>. */
export class GetSessionStatuses extends Request.TaggedClass(
	"GetSessionStatuses",
)<
	Record<string, never>,
	Record<string, SessionStatus>,
	OpenCodeRequestError,
	OpenCodeAPITag
> {}

/** Fetch a single session detail by ID. Batchable via session.list(). */
export class GetSession extends Request.TaggedClass("GetSession")<
	{ readonly sessionId: string },
	SchemaSessionDetail,
	OpenCodeRequestError,
	OpenCodeAPITag
> {}

export type OpenCodeRequest =
	| GetSessions
	| GetMessages
	| GetSessionStatuses
	| GetSession;

/** Resolver for GetSessions — calls session.list() */
export const GetSessionsResolver = RequestResolver.fromEffect<GetSessions>(
	(entry) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.list(),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.list", cause }),
			});
		}).pipe(
			Effect.provideContext(entry.context),
			Effect.withSpan("opencode.request.GetSessions"),
		),
);

/** Resolver for GetMessages — calls session.messages(sessionId) */
export const GetMessagesResolver = RequestResolver.fromEffect<GetMessages>(
	(entry) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.messages(entry.request.sessionId),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.messages", cause }),
			});
		}).pipe(
			Effect.provideContext(entry.context),
			Effect.withSpan("opencode.request.GetMessages"),
		),
);

/** Resolver for GetSessionStatuses — calls session.statuses() (returns all at once) */
export const GetSessionStatusesResolver =
	RequestResolver.fromEffect<GetSessionStatuses>((entry) =>
		Effect.gen(function* () {
			const api = yield* OpenCodeAPITag;
			return yield* Effect.tryPromise({
				try: () => api.session.statuses(),
				catch: (cause) =>
					new OpenCodeRequestError({ method: "session.statuses", cause }),
			});
		}).pipe(
			Effect.provideContext(entry.context),
			Effect.withSpan("opencode.request.GetSessionStatuses"),
		),
	);

/**
 * Batched resolver for GetSession — when multiple fibers concurrently request
 * individual session details, fetches session.list() once and resolves each
 * request from the result.
 *
 * Sessions not found in the list are failed with OpenCodeRequestError.
 */
export const GetSessionBatchedResolver = RequestResolver.makeGrouped<
	GetSession,
	OpenCodeAPITag["Service"]
>({
	key: (entry) => Context.get(entry.context, OpenCodeAPITag),
	resolver: (requests, api) =>
		Effect.gen(function* () {
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
					const session = sessionMap.get(req.request.sessionId);
					if (session) {
						return Request.succeed(req, session);
					}
					return Request.fail(
						req,
						new OpenCodeRequestError({
							method: "session.get (batched)",
							cause: new Error(`Session not found: ${req.request.sessionId}`),
						}),
					);
				},
				{ discard: true },
			);
		}).pipe(
			// If the batch fetch itself fails, fail all requests
			Effect.catch((error) =>
				Effect.forEach(requests, (req) => Request.fail(req, error), {
					discard: true,
				}),
			),
			Effect.withSpan("opencode.request.GetSession.batched", {
				attributes: { batchSize: requests.length },
			}),
		),
});

/** Fetch the session list via the request system. */
export const getSessions = Effect.request(
	new GetSessions({}),
	GetSessionsResolver,
);

/** Fetch messages for a session via the request system. */
export const getMessages = (sessionId: string) =>
	Effect.request(new GetMessages({ sessionId }), GetMessagesResolver);

/** Fetch all session statuses via the request system. */
export const getSessionStatuses = Effect.request(
	new GetSessionStatuses({}),
	GetSessionStatusesResolver,
);

/** Fetch a single session detail via the batched request system. */
export const getSession = (sessionId: string) =>
	Effect.request(new GetSession({ sessionId }), GetSessionBatchedResolver);
