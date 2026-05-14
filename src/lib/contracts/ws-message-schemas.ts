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

// ─── Individual message schemas ─────────────────────────────────────────────
// Each schema includes `type: Schema.Literal(...)` as the discriminant.

// ── Terminal / PTY ───────────────────────────────────────────────────────────

const PtyInputMsg = Schema.Struct({
	type: Schema.Literal("pty_input"),
	ptyId: Schema.String,
	data: Schema.String,
});

// ─── Combined union schema ──────────────────────────────────────────────────
// Covers all remaining legacy IncomingMessageType values from ws-router.ts.

export const IncomingWsMessage = Schema.Union(
	// Terminal / PTY
	PtyInputMsg,
);

/** Decoded type for an incoming WS message. */
export type IncomingWsMessageType = typeof IncomingWsMessage.Type;

// ─── Decoder helper ─────────────────────────────────────────────────────────
// Decodes an unknown value through IncomingWsMessage with an OpenTelemetry span.

export const decodeWsMessage = (raw: unknown) =>
	Schema.decodeUnknown(IncomingWsMessage)(raw).pipe(
		Effect.withSpan("ws.decodeMessage"),
	);
