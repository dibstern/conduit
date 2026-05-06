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

// ── Prompt / Messages ────────────────────────────────────────────────────────

const MessageMsg = Schema.Struct({
	type: Schema.Literal("message"),
	text: Schema.String,
	images: Schema.optional(Schema.Array(Schema.String)),
});

const CancelMsg = Schema.Struct({
	type: Schema.Literal("cancel"),
});

const RewindMsg = Schema.Struct({
	type: Schema.Literal("rewind"),
	messageId: Schema.optional(Schema.String),
	uuid: Schema.optional(Schema.String),
});

const InputSyncMsg = Schema.Struct({
	type: Schema.Literal("input_sync"),
	text: Schema.String,
});

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

const RenameSessionMsg = Schema.Struct({
	type: Schema.Literal("rename_session"),
	sessionId: Schema.String,
	title: Schema.String,
});

const ForkSessionMsg = Schema.Struct({
	type: Schema.Literal("fork_session"),
	sessionId: Schema.optional(Schema.String),
	messageId: Schema.optional(Schema.String),
});

const ListSessionsMsg = Schema.Struct({
	type: Schema.Literal("list_sessions"),
});

const SearchSessionsMsg = Schema.Struct({
	type: Schema.Literal("search_sessions"),
	query: Schema.String,
	roots: Schema.optional(Schema.Boolean),
});

const LoadMoreHistoryMsg = Schema.Struct({
	type: Schema.Literal("load_more_history"),
	sessionId: Schema.optional(Schema.String),
	offset: Schema.Number,
});

// ── Agents ───────────────────────────────────────────────────────────────────

const GetAgentsMsg = Schema.Struct({
	type: Schema.Literal("get_agents"),
});

const SwitchAgentMsg = Schema.Struct({
	type: Schema.Literal("switch_agent"),
	agentId: Schema.String,
});

// ── Models ───────────────────────────────────────────────────────────────────

const GetModelsMsg = Schema.Struct({
	type: Schema.Literal("get_models"),
});

const SwitchModelMsg = Schema.Struct({
	type: Schema.Literal("switch_model"),
	modelId: Schema.String,
	providerId: Schema.String,
});

const SetDefaultModelMsg = Schema.Struct({
	type: Schema.Literal("set_default_model"),
	provider: Schema.String,
	model: Schema.String,
});

const SwitchVariantMsg = Schema.Struct({
	type: Schema.Literal("switch_variant"),
	variant: Schema.String,
});

// ── Settings / Projects ──────────────────────────────────────────────────────

const GetCommandsMsg = Schema.Struct({
	type: Schema.Literal("get_commands"),
});

const GetProjectsMsg = Schema.Struct({
	type: Schema.Literal("get_projects"),
});

const AddProjectMsg = Schema.Struct({
	type: Schema.Literal("add_project"),
	directory: Schema.String,
	instanceId: Schema.optional(Schema.String),
});

const ListDirectoriesMsg = Schema.Struct({
	type: Schema.Literal("list_directories"),
	path: Schema.String,
});

const RemoveProjectMsg = Schema.Struct({
	type: Schema.Literal("remove_project"),
	slug: Schema.String,
});

const RenameProjectMsg = Schema.Struct({
	type: Schema.Literal("rename_project"),
	slug: Schema.String,
	title: Schema.String,
});

const GetTodoMsg = Schema.Struct({
	type: Schema.Literal("get_todo"),
});

// ── File operations ──────────────────────────────────────────────────────────

const GetFileListMsg = Schema.Struct({
	type: Schema.Literal("get_file_list"),
	path: Schema.optional(Schema.String),
});

const GetFileContentMsg = Schema.Struct({
	type: Schema.Literal("get_file_content"),
	path: Schema.String,
});

const GetFileTreeMsg = Schema.Struct({
	type: Schema.Literal("get_file_tree"),
});

const GetToolContentMsg = Schema.Struct({
	type: Schema.Literal("get_tool_content"),
	toolId: Schema.String,
});

// ── Terminal / PTY ───────────────────────────────────────────────────────────

const TerminalCommandMsg = Schema.Struct({
	type: Schema.Literal("terminal_command"),
	action: Schema.String,
	ptyId: Schema.optional(Schema.String),
});

const PtyCreateMsg = Schema.Struct({
	type: Schema.Literal("pty_create"),
});

const PtyInputMsg = Schema.Struct({
	type: Schema.Literal("pty_input"),
	ptyId: Schema.String,
	data: Schema.String,
});

const PtyResizeMsg = Schema.Struct({
	type: Schema.Literal("pty_resize"),
	ptyId: Schema.String,
	cols: Schema.optional(Schema.Number),
	rows: Schema.optional(Schema.Number),
});

const PtyCloseMsg = Schema.Struct({
	type: Schema.Literal("pty_close"),
	ptyId: Schema.String,
});

// ── Instance management ──────────────────────────────────────────────────────

const InstanceAddMsg = Schema.Struct({
	type: Schema.Literal("instance_add"),
	name: Schema.String,
	url: Schema.optional(Schema.String),
	managed: Schema.optional(Schema.Boolean),
	port: Schema.optional(Schema.Number),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
});

const InstanceRemoveMsg = Schema.Struct({
	type: Schema.Literal("instance_remove"),
	instanceId: Schema.String,
});

const InstanceStartMsg = Schema.Struct({
	type: Schema.Literal("instance_start"),
	instanceId: Schema.String,
});

const InstanceStopMsg = Schema.Struct({
	type: Schema.Literal("instance_stop"),
	instanceId: Schema.String,
});

const InstanceUpdateMsg = Schema.Struct({
	type: Schema.Literal("instance_update"),
	instanceId: Schema.String,
	name: Schema.optional(Schema.String),
	port: Schema.optional(Schema.Number),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
});

const InstanceRenameMsg = Schema.Struct({
	type: Schema.Literal("instance_rename"),
	instanceId: Schema.String,
	name: Schema.String,
});

const SetProjectInstanceMsg = Schema.Struct({
	type: Schema.Literal("set_project_instance"),
	slug: Schema.String,
	instanceId: Schema.String,
});

// ── Network / Scanning ───────────────────────────────────────────────────────

const ProxyDetectMsg = Schema.Struct({
	type: Schema.Literal("proxy_detect"),
});

const ScanNowMsg = Schema.Struct({
	type: Schema.Literal("scan_now"),
});

// ── Daemon operations ────────────────────────────────────────────────────────

const SetLogLevelMsg = Schema.Struct({
	type: Schema.Literal("set_log_level"),
	level: Schema.String,
});

const ReloadProviderSessionMsg = Schema.Struct({
	type: Schema.Literal("reload_provider_session"),
});

// ─── Combined union schema ──────────────────────────────────────────────────
// Covers all 49 IncomingMessageType values from ws-router.ts.

export const IncomingWsMessage = Schema.Union(
	// Prompt / Messages
	MessageMsg,
	CancelMsg,
	RewindMsg,
	InputSyncMsg,
	// Permissions / Questions
	PermissionResponseMsg,
	AskUserResponseMsg,
	QuestionRejectMsg,
	// Session lifecycle
	NewSessionMsg,
	SwitchSessionMsg,
	ViewSessionMsg,
	DeleteSessionMsg,
	RenameSessionMsg,
	ForkSessionMsg,
	ListSessionsMsg,
	SearchSessionsMsg,
	LoadMoreHistoryMsg,
	// Agents
	GetAgentsMsg,
	SwitchAgentMsg,
	// Models
	GetModelsMsg,
	SwitchModelMsg,
	SetDefaultModelMsg,
	SwitchVariantMsg,
	// Settings / Projects
	GetCommandsMsg,
	GetProjectsMsg,
	AddProjectMsg,
	ListDirectoriesMsg,
	RemoveProjectMsg,
	RenameProjectMsg,
	GetTodoMsg,
	// File operations
	GetFileListMsg,
	GetFileContentMsg,
	GetFileTreeMsg,
	GetToolContentMsg,
	// Terminal / PTY
	TerminalCommandMsg,
	PtyCreateMsg,
	PtyInputMsg,
	PtyResizeMsg,
	PtyCloseMsg,
	// Instance management
	InstanceAddMsg,
	InstanceRemoveMsg,
	InstanceStartMsg,
	InstanceStopMsg,
	InstanceUpdateMsg,
	InstanceRenameMsg,
	SetProjectInstanceMsg,
	// Network / Scanning
	ProxyDetectMsg,
	ScanNowMsg,
	// Daemon operations
	SetLogLevelMsg,
	ReloadProviderSessionMsg,
);

/** Decoded type for an incoming WS message. */
export type IncomingWsMessageType = typeof IncomingWsMessage.Type;

// ─── Decoder helper ─────────────────────────────────────────────────────────
// Decodes an unknown value through IncomingWsMessage with an OpenTelemetry span.

export const decodeWsMessage = (raw: unknown) =>
	Schema.decodeUnknown(IncomingWsMessage)(raw).pipe(
		Effect.withSpan("ws.decodeMessage"),
	);
