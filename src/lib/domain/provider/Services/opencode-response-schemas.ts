// ─── OpenCode API Response Schemas ───────────────────────────────────────────
// Effect Schema definitions for OpenCode REST API responses, replacing untyped
// `as any` casts with runtime validation. Malformed responses produce
// ParseError instead of silent runtime crashes.
//
// Response shapes verified against:
// - @opencode-ai/sdk/dist/gen/types.gen.d.ts (SDK type definitions)
// - src/lib/instance/opencode-api.ts (API adapter)
// - src/lib/instance/sdk-types.ts (relay's Message/SessionDetail interfaces)
//
// API shape notes:
// - session.list() returns `Array<Session>` (not wrapped in an object)
// - session.messages() returns `Array<{ info: Message, parts: Part[] }>`
//   which the API adapter flattens to `Array<FlatMessage>`
// - session.statuses() returns `Record<string, SessionStatus>`
// - No health endpoint exists in the OpenCode SDK

import { Effect, Schema } from "effect";

// ─── Session Time ───────────────────────────────────────────────────────────

const SessionTimeSchema = Schema.Struct({
	created: Schema.Number,
	updated: Schema.Number,
	compacting: Schema.optional(Schema.Number),
});

// ─── Session Summary ────────────────────────────────────────────────────────

const SessionSummarySchema = Schema.Struct({
	additions: Schema.Number,
	deletions: Schema.Number,
	files: Schema.Number,
	diffs: Schema.optional(Schema.Array(Schema.Unknown)),
});

// ─── Session Share ──────────────────────────────────────────────────────────

const SessionShareSchema = Schema.Struct({
	url: Schema.String,
});

// ─── Session Revert ─────────────────────────────────────────────────────────

const SessionRevertSchema = Schema.Struct({
	messageID: Schema.String,
	partID: Schema.optional(Schema.String),
	snapshot: Schema.optional(Schema.String),
	diff: Schema.optional(Schema.String),
});

// ─── SessionSchema ──────────────────────────────────────────────────────────
// Matches the SDK's `Session` type from @opencode-ai/sdk/client.

export const SessionSchema = Schema.Struct({
	id: Schema.String,
	projectID: Schema.String,
	directory: Schema.String,
	title: Schema.String,
	version: Schema.String,
	time: SessionTimeSchema,
	parentID: Schema.optional(Schema.String),
	summary: Schema.optional(SessionSummarySchema),
	share: Schema.optional(SessionShareSchema),
	revert: Schema.optional(SessionRevertSchema),
});

/** Decoded Session type */
export type Session = typeof SessionSchema.Type;

// ─── SessionDetailSchema ────────────────────────────────────────────────────
// Extends SessionSchema with relay-specific fields from sdk-types.ts.
// The OpenCode API returns these fields at runtime but the SDK's generated
// types don't include them.

export const SessionDetailSchema = Schema.Struct({
	...SessionSchema.fields,
	modelID: Schema.optional(Schema.String),
	providerID: Schema.optional(Schema.String),
	agentID: Schema.optional(Schema.String),
	slug: Schema.optional(Schema.String),
	archived: Schema.optional(Schema.Boolean),
});

/** Decoded SessionDetail type */
export type SessionDetail = typeof SessionDetailSchema.Type;

// ─── Part Schema (loose) ────────────────────────────────────────────────────
// Parts are a complex discriminated union in the SDK. We validate structure
// loosely here (must have id and type) and allow extra fields, since full
// Part validation belongs in event schemas rather than response schemas.

const PartSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
}).pipe(Schema.annotations({ identifier: "Part" }));

// ─── FlatMessageSchema ──────────────────────────────────────────────────────
// The relay's flattened message shape, produced by opencode-api.ts's
// flattenMessage helper. This is what downstream relay code consumes.
// Matches the Message interface in sdk-types.ts.

export const FlatMessageSchema = Schema.Struct({
	id: Schema.String,
	role: Schema.String,
	sessionID: Schema.String,
	parts: Schema.optional(Schema.Array(PartSchema)),
	cost: Schema.optional(Schema.Number),
	tokens: Schema.optional(
		Schema.Struct({
			input: Schema.optional(Schema.Number),
			output: Schema.optional(Schema.Number),
			cache: Schema.optional(
				Schema.Struct({
					read: Schema.optional(Schema.Number),
					write: Schema.optional(Schema.Number),
				}),
			),
		}),
	),
	time: Schema.optional(
		Schema.Struct({
			created: Schema.optional(Schema.Number),
			completed: Schema.optional(Schema.Number),
		}),
	),
});

/** Decoded flat message type */
export type FlatMessage = typeof FlatMessageSchema.Type;

// ─── MessageInfoSchema ──────────────────────────────────────────────────────
// The SDK's Message (UserMessage | AssistantMessage) info field.
// We validate loosely: must have id, sessionID, role, time.

const MessageInfoSchema = Schema.Struct({
	id: Schema.String,
	sessionID: Schema.String,
	role: Schema.String,
	time: Schema.Struct({
		created: Schema.Number,
		completed: Schema.optional(Schema.Number),
	}),
}).pipe(Schema.annotations({ identifier: "MessageInfo" }));

// ─── MessageWithPartsSchema ─────────────────────────────────────────────────
// The SDK's raw response shape for messages: { info: Message, parts: Part[] }.
// This is what the API returns before flattenMessage transforms it.

export const MessageWithPartsSchema = Schema.Struct({
	info: MessageInfoSchema,
	parts: Schema.Array(Schema.Unknown),
});

/** Decoded message-with-parts type */
export type MessageWithParts = typeof MessageWithPartsSchema.Type;

// ─── SessionStatus ──────────────────────────────────────────────────────────
// Discriminated union: { type: "idle" } | { type: "busy" } | { type: "retry", ... }

const SessionStatusIdle = Schema.Struct({ type: Schema.Literal("idle") });
const SessionStatusBusy = Schema.Struct({ type: Schema.Literal("busy") });
const SessionStatusRetry = Schema.Struct({
	type: Schema.Literal("retry"),
	attempt: Schema.Number,
	message: Schema.String,
	next: Schema.Number,
});

const SessionStatusSchema = Schema.Union(
	SessionStatusIdle,
	SessionStatusBusy,
	SessionStatusRetry,
);

/** Decoded SessionStatus type */
export type SessionStatus = typeof SessionStatusSchema.Type;

// ─── Response-level Schemas ─────────────────────────────────────────────────
// These match the actual API response shapes (verified against SDK types).

/** session.list() returns Array<Session> */
export const SessionListResponseSchema = Schema.Array(SessionDetailSchema);

/** session.messages() returns Array<{ info: Message, parts: Part[] }> */
export const MessageListResponseSchema = Schema.Array(MessageWithPartsSchema);

/** session.statuses() returns Record<string, SessionStatus> */
export const SessionStatusMapSchema = Schema.Record({
	key: Schema.String,
	value: SessionStatusSchema,
});

// ─── Decode helpers with tracing spans ──────────────────────────────────────

export const decodeSessionList = (raw: unknown) =>
	Schema.decodeUnknown(SessionListResponseSchema)(raw).pipe(
		Effect.withSpan("opencode.decodeSessionList"),
	);

export const decodeMessageList = (raw: unknown) =>
	Schema.decodeUnknown(MessageListResponseSchema)(raw).pipe(
		Effect.withSpan("opencode.decodeMessageList"),
	);

export const decodeSessionStatusMap = (raw: unknown) =>
	Schema.decodeUnknown(SessionStatusMapSchema)(raw).pipe(
		Effect.withSpan("opencode.decodeSessionStatusMap"),
	);
