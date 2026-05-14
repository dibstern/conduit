// ─── Outbound Message Schemas ────────────────────────────────────────────────
// Schema definitions for outbound WebSocket messages. Used by wsSendValidated
// for runtime validation of messages before they leave the client.
//
// Start with the most-used outbound message types. Add more as callers
// migrate from wsSend → wsSendValidated. Full list: see PayloadMap in
// src/lib/handlers/payloads.ts (40+ types).

import { Schema } from "effect";

const ViewSession = Schema.Struct({
	type: Schema.Literal("view_session"),
	sessionId: Schema.String,
});

const NewSession = Schema.Struct({
	type: Schema.Literal("new_session"),
	requestId: Schema.String,
});

// Combine into a union — add more types as callers migrate.
export const OutboundMessage = Schema.Union(ViewSession, NewSession);

export type OutboundMessage = typeof OutboundMessage.Type;
