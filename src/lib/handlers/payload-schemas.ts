// ─── Payload Schemas ────────────────────────────────────────────────────────
// Effect Schema definitions for every message type in PayloadMap.
// Used by dispatchMessageEffect (in index.ts) for runtime validation at the
// WebSocket dispatch boundary.

import { Schema } from "effect";

import { RequestId } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";

/**
 * Schema definitions for each incoming WebSocket message payload.
 * Each key corresponds to a key in PayloadMap, and the Schema validates
 * the raw JSON payload before it reaches the handler function.
 *
 * The type constraint ensures every PayloadMap key has a matching Schema.
 * We use `Schema.Schema<any, any>` because Effect Schema optional fields
 * produce `T | undefined` (not `T?`), and Struct always adds `readonly` --
 * these structural differences don't affect runtime validation correctness.
 */
export const PayloadSchemas: {
	// biome-ignore lint/suspicious/noExplicitAny: Schema Struct produces readonly/undefined-widened types that differ structurally from PayloadMap; `any` avoids a fight with exactOptionalPropertyTypes while keeping the key-exhaustiveness constraint
	[K in keyof PayloadMap]: Schema.Schema<any, any>;
} = {
	new_session: Schema.Struct({
		title: Schema.optional(Schema.String),
		requestId: Schema.optional(RequestId),
	}),

	switch_session: Schema.Struct({
		sessionId: Schema.String,
	}),

	view_session: Schema.Struct({
		sessionId: Schema.String,
	}),

	delete_session: Schema.Struct({
		sessionId: Schema.String,
	}),

	fork_session: Schema.Struct({
		sessionId: Schema.optional(Schema.String),
		messageId: Schema.optional(Schema.String),
	}),

	pty_input: Schema.Struct({
		ptyId: Schema.String,
		data: Schema.String,
	}),
};
