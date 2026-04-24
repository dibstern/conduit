// ─── Outbound Message Schemas ────────────────────────────────────────────────
// Schema definitions for outbound WebSocket messages. Used by wsSendValidated
// for runtime validation of messages before they leave the client.
//
// Start with the most-used outbound message types. Add more as callers
// migrate from wsSend → wsSendValidated. Full list: see PayloadMap in
// src/lib/handlers/payloads.ts (40+ types).

import { Schema } from "effect";

const ChatMessage = Schema.Struct({
	type: Schema.Literal("message"),
	text: Schema.String,
	sessionId: Schema.optional(Schema.String),
});

const CancelMessage = Schema.Struct({
	type: Schema.Literal("cancel"),
	sessionId: Schema.String,
});

const ViewSession = Schema.Struct({
	type: Schema.Literal("view_session"),
	sessionId: Schema.String,
});

const NewSession = Schema.Struct({
	type: Schema.Literal("new_session"),
	requestId: Schema.String,
});

const ListSessions = Schema.Struct({
	type: Schema.Literal("list_sessions"),
});

const GetAgents = Schema.Struct({
	type: Schema.Literal("get_agents"),
});

const GetModels = Schema.Struct({
	type: Schema.Literal("get_models"),
});

const GetCommands = Schema.Struct({
	type: Schema.Literal("get_commands"),
});

const GetProjects = Schema.Struct({
	type: Schema.Literal("get_projects"),
});

// Combine into a union — add more types as callers migrate.
export const OutboundMessage = Schema.Union(
	ChatMessage,
	CancelMessage,
	ViewSession,
	NewSession,
	ListSessions,
	GetAgents,
	GetModels,
	GetCommands,
	GetProjects,
);

export type OutboundMessage = typeof OutboundMessage.Type;
