// ─── Incoming WebSocket Message Schemas ──────────────────────────────────────
// Effect Schema definitions for ALL incoming WebSocket message types (client
// → daemon direction). Each variant includes the `type` discriminant field
// and all payload fields, combined into a single Schema.Union.
//
// Complements the OUTGOING RelayMessageSchema in shared-types.ts (daemon →
// client direction) and the per-payload PayloadSchemas in handlers/
// payload-schemas.ts (which validate payloads AFTER type extraction).
//
// This module validates full messages at the WebSocket boundary BEFORE type
// extraction, enabling schema-first error reporting.
//
// Source of truth for incoming message types: ws-router.ts IncomingMessageType.
// Source of truth for payload shapes: handlers/payloads.ts PayloadMap.

import { Effect, Schema } from "effect";
import { PermissionId, RequestId } from "../shared-types.js";

// ─── Individual message schemas ─────────────────────────────────────────────
// Each schema includes `type: Schema.Literal(...)` as the discriminant.

// ── Permissions / Questions ──────────────────────────────────────────────────

const PermissionResponseMsg = Schema.Struct({
	type: Schema.Literal("permission_response"),
	requestId: PermissionId,
	decision: Schema.String,
	persistScope: Schema.optional(Schema.Literal("tool", "pattern")),
	persistPattern: Schema.optional(Schema.String),
});

const AskUserResponseMsg = Schema.Struct({
	type: Schema.Literal("ask_user_response"),
	toolId: Schema.String,
	answers: Schema.Record({ key: Schema.String, value: Schema.String }),
});

const QuestionRejectMsg = Schema.Struct({
	type: Schema.Literal("question_reject"),
	toolId: Schema.String,
});

// ── Session lifecycle ────────────────────────────────────────────────────────

const NewSessionMsg = Schema.Struct({
	type: Schema.Literal("new_session"),
	title: Schema.optional(Schema.String),
	requestId: Schema.optional(RequestId),
});

const SwitchSessionMsg = Schema.Struct({
	type: Schema.Literal("switch_session"),
	sessionId: Schema.String,
});

const ViewSessionMsg = Schema.Struct({
	type: Schema.Literal("view_session"),
	sessionId: Schema.String,
});

const DeleteSessionMsg = Schema.Struct({
	type: Schema.Literal("delete_session"),
	sessionId: Schema.String,
});

const ForkSessionMsg = Schema.Struct({
	type: Schema.Literal("fork_session"),
	sessionId: Schema.optional(Schema.String),
	messageId: Schema.optional(Schema.String),
});

// ── Terminal / PTY ───────────────────────────────────────────────────────────

const PtyInputMsg = Schema.Struct({
	type: Schema.Literal("pty_input"),
	ptyId: Schema.String,
	data: Schema.String,
});

// ── Daemon operations ────────────────────────────────────────────────────────

const SetLogLevelMsg = Schema.Struct({
	type: Schema.Literal("set_log_level"),
	level: Schema.String,
});

// ─── Combined union schema ──────────────────────────────────────────────────
// Covers all remaining legacy IncomingMessageType values from ws-router.ts.

export const IncomingWsMessage = Schema.Union(
	// Permissions / Questions
	PermissionResponseMsg,
	AskUserResponseMsg,
	QuestionRejectMsg,
	// Session lifecycle
	NewSessionMsg,
	SwitchSessionMsg,
	ViewSessionMsg,
	DeleteSessionMsg,
	ForkSessionMsg,
	// Terminal / PTY
	PtyInputMsg,
	// Daemon operations
	SetLogLevelMsg,
);

/** Decoded type for an incoming WS message. */
export type IncomingWsMessageType = typeof IncomingWsMessage.Type;

// ─── Decoder helper ─────────────────────────────────────────────────────────
// Decodes an unknown value through IncomingWsMessage with an OpenTelemetry span.

export const decodeWsMessage = (raw: unknown) =>
	Schema.decodeUnknown(IncomingWsMessage)(raw).pipe(
		Effect.withSpan("ws.decodeMessage"),
	);
