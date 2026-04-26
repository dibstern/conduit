// ─── Payload Schemas ────────────────────────────────────────────────────────
// Effect Schema definitions for every message type in PayloadMap.
// Used by dispatchMessageEffect (in index.ts) for runtime validation at the
// WebSocket dispatch boundary.

import { Schema } from "effect";

import { PermissionId, RequestId } from "../shared-types.js";
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
	message: Schema.Struct({
		text: Schema.String,
		images: Schema.optional(Schema.Array(Schema.String)),
	}),

	cancel: Schema.Struct({}),

	rewind: Schema.Struct({
		messageId: Schema.optional(Schema.String),
		uuid: Schema.optional(Schema.String),
	}),

	input_sync: Schema.Struct({
		text: Schema.String,
	}),

	permission_response: Schema.Struct({
		requestId: PermissionId,
		decision: Schema.String,
		persistScope: Schema.optional(Schema.Literal("tool", "pattern")),
		persistPattern: Schema.optional(Schema.String),
	}),

	ask_user_response: Schema.Struct({
		toolId: Schema.String,
		answers: Schema.Record({ key: Schema.String, value: Schema.String }),
	}),

	question_reject: Schema.Struct({
		toolId: Schema.String,
	}),

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

	rename_session: Schema.Struct({
		sessionId: Schema.String,
		title: Schema.String,
	}),

	fork_session: Schema.Struct({
		sessionId: Schema.optional(Schema.String),
		messageId: Schema.optional(Schema.String),
	}),

	list_sessions: Schema.Struct({}),

	search_sessions: Schema.Struct({
		query: Schema.String,
		roots: Schema.optional(Schema.Boolean),
	}),

	load_more_history: Schema.Struct({
		sessionId: Schema.optional(Schema.String),
		offset: Schema.Number,
	}),

	get_agents: Schema.Struct({}),

	switch_agent: Schema.Struct({
		agentId: Schema.String,
	}),

	get_models: Schema.Struct({}),

	switch_model: Schema.Struct({
		modelId: Schema.String,
		providerId: Schema.String,
	}),

	set_default_model: Schema.Struct({
		provider: Schema.String,
		model: Schema.String,
	}),

	switch_variant: Schema.Struct({
		variant: Schema.String,
	}),

	get_commands: Schema.Struct({}),

	get_projects: Schema.Struct({}),

	add_project: Schema.Struct({
		directory: Schema.String,
		instanceId: Schema.optional(Schema.String),
	}),

	list_directories: Schema.Struct({
		path: Schema.String,
	}),

	remove_project: Schema.Struct({
		slug: Schema.String,
	}),

	rename_project: Schema.Struct({
		slug: Schema.String,
		title: Schema.String,
	}),

	get_todo: Schema.Struct({}),

	get_file_list: Schema.Struct({
		path: Schema.optional(Schema.String),
	}),

	get_file_content: Schema.Struct({
		path: Schema.String,
	}),

	get_file_tree: Schema.Struct({}),

	get_tool_content: Schema.Struct({
		toolId: Schema.String,
	}),

	terminal_command: Schema.Struct({
		action: Schema.String,
		ptyId: Schema.optional(Schema.String),
	}),

	pty_create: Schema.Struct({}),

	pty_input: Schema.Struct({
		ptyId: Schema.String,
		data: Schema.String,
	}),

	pty_resize: Schema.Struct({
		ptyId: Schema.String,
		cols: Schema.optional(Schema.Number),
		rows: Schema.optional(Schema.Number),
	}),

	pty_close: Schema.Struct({
		ptyId: Schema.String,
	}),

	instance_add: Schema.Struct({
		name: Schema.String,
		url: Schema.optional(Schema.String),
		managed: Schema.optional(Schema.Boolean),
		port: Schema.optional(Schema.Number),
		env: Schema.optional(
			Schema.Record({ key: Schema.String, value: Schema.String }),
		),
	}),

	instance_remove: Schema.Struct({
		instanceId: Schema.String,
	}),

	instance_start: Schema.Struct({
		instanceId: Schema.String,
	}),

	instance_stop: Schema.Struct({
		instanceId: Schema.String,
	}),

	instance_update: Schema.Struct({
		instanceId: Schema.String,
		name: Schema.optional(Schema.String),
		port: Schema.optional(Schema.Number),
		env: Schema.optional(
			Schema.Record({ key: Schema.String, value: Schema.String }),
		),
	}),

	set_project_instance: Schema.Struct({
		slug: Schema.String,
		instanceId: Schema.String,
	}),

	instance_rename: Schema.Struct({
		instanceId: Schema.String,
		name: Schema.String,
	}),

	proxy_detect: Schema.Struct({}),

	scan_now: Schema.Struct({}),

	reload_provider_session: Schema.Struct({}),
};
