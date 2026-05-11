// ─── Shared Types ───────────────────────────────────────────────────────────
// Types shared between server and frontend.
// Imported by src/lib/types.ts (server) and frontend code.

// SDK-derived type aliases (Task 10) — single source of truth for Part/Tool enums.
// Imported for local use; re-exported below for downstream consumers.
import type { PartType, ToolStatus } from "./instance/sdk-types.js";
export type { PartType, ToolStatus };

import { Schema } from "effect";

// ─── Branded identifiers ────────────────────────────────────────────────────

/**
 * Branded type for request/response correlation IDs.
 * Prevents accidentally passing a session ID where a correlation ID is expected.
 * Schema brand — decoded at construction sites, zero-cost cast elsewhere.
 */
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

/**
 * Branded type for OpenCode permission entity IDs (e.g., "per_cd6d6dc8...").
 * Prevents accidentally passing a session ID or correlation ID where a
 * permission ID is expected. Schema brand — decoded at construction sites,
 * zero-cost cast elsewhere.
 */
export const PermissionId = Schema.String.pipe(Schema.brand("PermissionId"));
export type PermissionId = typeof PermissionId.Type;

// ─── Base16 Theme ───────────────────────────────────────────────────────────

export const BASE16_KEYS = [
	"base00",
	"base01",
	"base02",
	"base03",
	"base04",
	"base05",
	"base06",
	"base07",
	"base08",
	"base09",
	"base0A",
	"base0B",
	"base0C",
	"base0D",
	"base0E",
	"base0F",
] as const;

export type Base16Key = (typeof BASE16_KEYS)[number];

export type Base16Theme = {
	name: string;
	author?: string;
	variant: "dark" | "light";
	/** Optional CSS variable overrides applied after Base16→CSS mapping. */
	overrides?: Record<string, string>;
} & Record<Base16Key, string>;

// ─── Todo / Progress ────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	subject: string;
	description?: string;
	status: TodoStatus;
}

// ─── Tool Names ──────────────────────────────────────────────────────────────

/** Canonical PascalCase tool names used by the frontend after mapping from OpenCode's lowercase names. */
export type ToolName =
	| "Read"
	| "Edit"
	| "Write"
	| "Bash"
	| "Glob"
	| "Grep"
	| "WebFetch"
	| "WebSearch"
	| "TodoWrite"
	| "TodoRead"
	| "AskUserQuestion"
	| "Task"
	| "LSP"
	| "Skill";

// ─── Agent / Model / Command info ───────────────────────────────────────────

export interface AgentInfo {
	id: string;
	name: string;
	description?: string;
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	models: ModelInfo[];
}

export interface ContextWindowOption {
	value: string;
	label: string;
	isDefault?: boolean;
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	variants?: string[];
	contextWindowOptions?: ContextWindowOption[];
}

export interface CommandInfo {
	name: string;
	description?: string;
	args?: string;
}

// ─── File Browser ───────────────────────────────────────────────────────────

export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
	modified?: number;
}

// ─── Session ────────────────────────────────────────────────────────────────

export interface SessionInfo {
	id: string;
	title: string;
	createdAt?: string | number;
	updatedAt?: string | number;
	messageCount?: number;
	processing?: boolean;
	/** Parent session ID — set when this session was forked from another. */
	parentID?: string;
	/** The message ID at the fork point — messages up to this ID are inherited context. */
	forkMessageId?: string;
	/** Unix-ms timestamp of the fork-point message. Messages created before
	 *  this time are inherited context from the parent session. */
	forkPointTimestamp?: number;
	/** Number of pending questions on this session (from server). */
	pendingQuestionCount?: number;
}

// ─── Ask User / Questions ───────────────────────────────────────────────────

export interface AskUserQuestion {
	question: string;
	header: string;
	options: { label: string; description?: string }[];
	multiSelect: boolean;
	custom?: boolean;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export interface UsageInfo {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

// ─── PTY / Terminal ─────────────────────────────────────────────────────────

export type PtyStatus = "running" | "exited";

export interface PtyInfo {
	id: string;
	title: string;
	command: string;
	cwd: string;
	status: PtyStatus;
	pid: number;
}

// ─── History Types ──────────────────────────────────────────────────────────
// These are relay-specific transport types for the session_switched / history_page
// WebSocket messages. They represent a loose superset of the SDK's Part and Message
// types with relay-specific extensions (renderedHtml, index signatures).
//
// SDK type mapping (Task 10):
//   PartType   ← SDK Part["type"]    (derived in sdk-types.ts)
//   ToolStatus ← SDK ToolState["status"] (derived in sdk-types.ts)
//   HistoryMessagePart ≈ SDK Part (loose — all fields optional, index sig)
//   HistoryMessage     ≈ SDK Message (loose — all fields optional, index sig)

/**
 * Shape of HistoryMessage parts (tool calls, text, reasoning, etc.).
 *
 * Loosely mirrors SDK `Part` with relay-specific extensions.
 * The `type` field uses SDK-derived `PartType` for discriminated narrowing,
 * widened with `"thinking"` to cover Claude SDK thinking blocks which the
 * MessageProjector stores in SQLite with `type='thinking'` (not an OpenCode
 * SDK part type).
 */
export interface HistoryMessagePart {
	id: string;
	type: PartType | "thinking";
	/** Text content — matches OpenCode's TextPart schema (field is "text", not "content"). */
	text?: string;
	/** Server-pre-rendered HTML for assistant text parts (C3 optimization). */
	renderedHtml?: string;
	/**
	 * Tool state — present on tool-type parts, contains status/input/output.
	 * Loosely mirrors SDK `ToolState` but with optional fields for transport compat.
	 */
	state?: {
		status?: ToolStatus;
		input?: unknown;
		output?: string;
		error?: string;
		[key: string]: unknown;
	};
	callID?: string;
	tool?: string;
	time?: unknown;
	[key: string]: unknown;
}

/**
 * A single message from the OpenCode REST history API.
 *
 * Loosely mirrors SDK `Message` (UserMessage | AssistantMessage) but with
 * optional fields for transport compatibility and relay-specific extensions.
 */
export interface HistoryMessage {
	id: string;
	role: "user" | "assistant";
	parts?: HistoryMessagePart[];
	time?: { created?: number; completed?: number };
	/** Cost in dollars — present on assistant messages from REST API. */
	cost?: number;
	/** Token usage — present on assistant messages from REST API. */
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	[key: string]: unknown;
}

// ─── Project Types ──────────────────────────────────────────────────────────

/** A project in the project list */
export interface ProjectInfo {
	slug: string;
	title: string;
	directory: string;
	clientCount?: number;
	instanceId?: string;
}

// ─── File History Types ─────────────────────────────────────────────────────

/** A file version from file history */
export interface FileVersion {
	id: string;
	path: string;
	content: string;
	timestamp: number;
	source: "edit" | "write" | "external";
	toolName?: string;
	description?: string;
	[key: string]: unknown;
}

// ─── Relay WebSocket message schemas ────────────────────────────────────────
// Schema definitions for each RelayMessage variant. Built with @effect/schema
// to provide runtime validation and type derivation.

// -- Helper schemas for embedded types --

const ToolStateSchema = Schema.Struct({
	status: Schema.optional(
		Schema.Literal("pending", "running", "completed", "error"),
	),
	input: Schema.optional(Schema.Unknown),
	output: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

const PartTypeSchema = Schema.Literal(
	"text",
	"reasoning",
	"file",
	"tool",
	"step-start",
	"step-finish",
	"snapshot",
	"patch",
	"agent",
	"retry",
	"compaction",
	"subtask",
	"thinking",
);

const HistoryMessagePartSchema = Schema.Struct({
	id: Schema.String,
	type: PartTypeSchema,
	text: Schema.optional(Schema.String),
	renderedHtml: Schema.optional(Schema.String),
	state: Schema.optional(ToolStateSchema),
	callID: Schema.optional(Schema.String),
	tool: Schema.optional(Schema.String),
	time: Schema.optional(Schema.Unknown),
});

const HistoryMessageSchema = Schema.Struct({
	id: Schema.String,
	role: Schema.Literal("user", "assistant"),
	parts: Schema.optional(Schema.Array(HistoryMessagePartSchema)),
	time: Schema.optional(
		Schema.Struct({
			created: Schema.optional(Schema.Number),
			completed: Schema.optional(Schema.Number),
		}),
	),
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
});

const AskUserQuestionSchema = Schema.Struct({
	question: Schema.String,
	header: Schema.String,
	options: Schema.Array(
		Schema.Struct({
			label: Schema.String,
			description: Schema.optional(Schema.String),
		}),
	),
	multiSelect: Schema.Boolean,
	custom: Schema.optional(Schema.Boolean),
});

const UsageInfoSchema = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cache_read: Schema.Number,
	cache_creation: Schema.Number,
});

const SessionInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	updatedAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	messageCount: Schema.optional(Schema.Number),
	processing: Schema.optional(Schema.Boolean),
	parentID: Schema.optional(Schema.String),
	forkMessageId: Schema.optional(Schema.String),
	forkPointTimestamp: Schema.optional(Schema.Number),
	pendingQuestionCount: Schema.optional(Schema.Number),
});

const ContextWindowOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	isDefault: Schema.optional(Schema.Boolean),
});

const ProviderInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	configured: Schema.Boolean,
	models: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			provider: Schema.String,
			cost: Schema.optional(
				Schema.Struct({
					input: Schema.optional(Schema.Number),
					output: Schema.optional(Schema.Number),
				}),
			),
			limit: Schema.optional(
				Schema.Struct({
					context: Schema.optional(Schema.Number),
					output: Schema.optional(Schema.Number),
				}),
			),
			variants: Schema.optional(Schema.Array(Schema.String)),
			contextWindowOptions: Schema.optional(
				Schema.Array(ContextWindowOptionSchema),
			),
		}),
	),
});

const AgentInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
});

const CommandInfoSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	args: Schema.optional(Schema.String),
});

const ProjectInfoSchema = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	directory: Schema.String,
	clientCount: Schema.optional(Schema.Number),
	instanceId: Schema.optional(Schema.String),
});

const FileEntrySchema = Schema.Struct({
	name: Schema.String,
	type: Schema.Literal("file", "directory"),
	size: Schema.optional(Schema.Number),
	modified: Schema.optional(Schema.Number),
});

const PtyInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.Literal("running", "exited"),
	pid: Schema.Number,
});

const TodoItemSchema = Schema.Struct({
	id: Schema.String,
	subject: Schema.String,
	description: Schema.optional(Schema.String),
	status: Schema.Literal("pending", "in_progress", "completed", "cancelled"),
});

const FileVersionSchema = Schema.Struct({
	id: Schema.String,
	path: Schema.String,
	content: Schema.String,
	timestamp: Schema.Number,
	source: Schema.Literal("edit", "write", "external"),
	toolName: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
});

const InstanceStatusSchema = Schema.Literal(
	"starting",
	"healthy",
	"unhealthy",
	"stopped",
);

const OpenCodeInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	port: Schema.Number,
	managed: Schema.Boolean,
	status: InstanceStatusSchema,
	pid: Schema.optional(Schema.Number),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	needsRestart: Schema.optional(Schema.Boolean),
	exitCode: Schema.optional(Schema.Number),
	lastHealthCheck: Schema.optional(Schema.Number),
	restartCount: Schema.Number,
	createdAt: Schema.Number,
});

// -- Individual message variant schemas --

// ── Streaming ──────────────────────────────────────────────────────────
const DeltaSchema = Schema.Struct({
	type: Schema.Literal("delta"),
	sessionId: Schema.String,
	text: Schema.String,
	messageId: Schema.optional(Schema.String),
});

const ThinkingStartSchema = Schema.Struct({
	type: Schema.Literal("thinking_start"),
	sessionId: Schema.String,
	messageId: Schema.optional(Schema.String),
});

const ThinkingDeltaSchema = Schema.Struct({
	type: Schema.Literal("thinking_delta"),
	sessionId: Schema.String,
	text: Schema.String,
	messageId: Schema.optional(Schema.String),
});

const ThinkingStopSchema = Schema.Struct({
	type: Schema.Literal("thinking_stop"),
	sessionId: Schema.String,
	messageId: Schema.optional(Schema.String),
});

// ── Tools ──────────────────────────────────────────────────────────────
const ToolStartSchema = Schema.Struct({
	type: Schema.Literal("tool_start"),
	sessionId: Schema.String,
	id: Schema.String,
	name: Schema.String,
	messageId: Schema.optional(Schema.String),
});

const ToolExecutingSchema = Schema.Struct({
	type: Schema.Literal("tool_executing"),
	sessionId: Schema.String,
	id: Schema.String,
	name: Schema.String,
	input: Schema.Union(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		Schema.Undefined,
	),
	metadata: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	messageId: Schema.optional(Schema.String),
});

const ToolResultSchema = Schema.Struct({
	type: Schema.Literal("tool_result"),
	sessionId: Schema.String,
	id: Schema.String,
	content: Schema.String,
	is_error: Schema.Boolean,
	isTruncated: Schema.optional(Schema.Boolean),
	fullContentLength: Schema.optional(Schema.Number),
	messageId: Schema.optional(Schema.String),
});

const ToolContentSchema = Schema.Struct({
	type: Schema.Literal("tool_content"),
	sessionId: Schema.String,
	toolId: Schema.String,
	content: Schema.String,
});

// ── Permissions / Questions ────────────────────────────────────────────
const PermissionRequestSchema = Schema.Struct({
	type: Schema.Literal("permission_request"),
	sessionId: Schema.String,
	requestId: PermissionId,
	toolName: Schema.String,
	toolInput: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	toolUseId: Schema.optional(Schema.String),
	always: Schema.optional(Schema.Array(Schema.String)),
});

const PermissionResolvedSchema = Schema.Struct({
	type: Schema.Literal("permission_resolved"),
	sessionId: Schema.String,
	requestId: PermissionId,
	decision: Schema.String,
});

const AskUserSchema = Schema.Struct({
	type: Schema.Literal("ask_user"),
	sessionId: Schema.String,
	toolId: Schema.String,
	questions: Schema.Array(AskUserQuestionSchema),
	toolUseId: Schema.optional(Schema.String),
});

const AskUserResolvedSchema = Schema.Struct({
	type: Schema.Literal("ask_user_resolved"),
	toolId: Schema.String,
	sessionId: Schema.String,
});

const AskUserErrorSchema = Schema.Struct({
	type: Schema.Literal("ask_user_error"),
	sessionId: Schema.String,
	toolId: Schema.String,
	message: Schema.String,
});

// ── Session lifecycle ──────────────────────────────────────────────────
const ResultSchema = Schema.Struct({
	type: Schema.Literal("result"),
	usage: UsageInfoSchema,
	cost: Schema.Number,
	duration: Schema.Number,
	sessionId: Schema.String,
	messageId: Schema.optional(Schema.String),
});

const StatusSchema = Schema.Struct({
	type: Schema.Literal("status"),
	sessionId: Schema.String,
	status: Schema.String,
});

const DoneSchema = Schema.Struct({
	type: Schema.Literal("done"),
	sessionId: Schema.String,
	code: Schema.Number,
});

// session_switched: events are RelayMessage[] at the type level (see manual
// union below).  We use Schema.Unknown for array elements here to avoid a
// circular Schema.suspend reference that causes TS7022 implicit-any errors.
// Individual events are validated independently when they arrive over WS.
const SessionSwitchedSchema = Schema.Struct({
	type: Schema.Literal("session_switched"),
	id: Schema.String,
	sessionId: Schema.String,
	requestId: Schema.optional(RequestId),
	events: Schema.optional(Schema.Array(Schema.Unknown)),
	eventsHasMore: Schema.optional(Schema.Boolean),
	history: Schema.optional(
		Schema.Struct({
			messages: Schema.Array(HistoryMessageSchema),
			hasMore: Schema.Boolean,
			total: Schema.optional(Schema.Number),
		}),
	),
	inputText: Schema.optional(Schema.String),
});

const SessionListSchema = Schema.Struct({
	type: Schema.Literal("session_list"),
	sessions: Schema.Array(SessionInfoSchema),
	roots: Schema.Boolean,
	search: Schema.optional(Schema.Boolean),
});

const SessionForkedSchema = Schema.Struct({
	type: Schema.Literal("session_forked"),
	sessionId: Schema.String,
	session: SessionInfoSchema,
	parentId: Schema.String,
	parentTitle: Schema.String,
});

const HistoryPageSchema = Schema.Struct({
	type: Schema.Literal("history_page"),
	sessionId: Schema.String,
	messages: Schema.Array(HistoryMessageSchema),
	hasMore: Schema.Boolean,
	total: Schema.optional(Schema.Number),
});

// ── Model / Agent / Commands ───────────────────────────────────────────
const ModelInfoMsgSchema = Schema.Struct({
	type: Schema.Literal("model_info"),
	model: Schema.String,
	provider: Schema.String,
});

const DefaultModelInfoSchema = Schema.Struct({
	type: Schema.Literal("default_model_info"),
	model: Schema.String,
	provider: Schema.String,
});

const ModelListSchema = Schema.Struct({
	type: Schema.Literal("model_list"),
	providers: Schema.Array(ProviderInfoSchema),
});

const AgentListSchema = Schema.Struct({
	type: Schema.Literal("agent_list"),
	agents: Schema.Array(AgentInfoSchema),
	activeAgentId: Schema.optional(Schema.String),
});

const CommandListSchema = Schema.Struct({
	type: Schema.Literal("command_list"),
	commands: Schema.Array(CommandInfoSchema),
});

// ── Projects ───────────────────────────────────────────────────────────
const ProjectListSchema = Schema.Struct({
	type: Schema.Literal("project_list"),
	projects: Schema.Array(ProjectInfoSchema),
	current: Schema.optional(Schema.String),
	addedSlug: Schema.optional(Schema.String),
});

const DirectoryListSchema = Schema.Struct({
	type: Schema.Literal("directory_list"),
	path: Schema.String,
	entries: Schema.Array(Schema.String),
});

// ── File browser ───────────────────────────────────────────────────────
const FileListSchema = Schema.Struct({
	type: Schema.Literal("file_list"),
	path: Schema.String,
	entries: Schema.Array(FileEntrySchema),
});

const FileContentSchema = Schema.Struct({
	type: Schema.Literal("file_content"),
	path: Schema.String,
	content: Schema.String,
	binary: Schema.optional(Schema.Boolean),
});

const FileTreeSchema = Schema.Struct({
	type: Schema.Literal("file_tree"),
	entries: Schema.Array(Schema.String),
});

const FileChangedSchema = Schema.Struct({
	type: Schema.Literal("file_changed"),
	path: Schema.String,
	changeType: Schema.Literal("edited", "external"),
});

// ── Part lifecycle ─────────────────────────────────────────────────────
const PartRemovedSchema = Schema.Struct({
	type: Schema.Literal("part_removed"),
	sessionId: Schema.String,
	partId: Schema.String,
	messageId: Schema.String,
});

const MessageRemovedSchema = Schema.Struct({
	type: Schema.Literal("message_removed"),
	sessionId: Schema.String,
	messageId: Schema.String,
});

// ── PTY / Terminal ─────────────────────────────────────────────────────
const PtyCreatedSchema = Schema.Struct({
	type: Schema.Literal("pty_created"),
	pty: PtyInfoSchema,
});

const PtyOutputSchema = Schema.Struct({
	type: Schema.Literal("pty_output"),
	ptyId: Schema.String,
	data: Schema.String,
});

const PtyExitedSchema = Schema.Struct({
	type: Schema.Literal("pty_exited"),
	ptyId: Schema.String,
	exitCode: Schema.Number,
});

const PtyDeletedSchema = Schema.Struct({
	type: Schema.Literal("pty_deleted"),
	ptyId: Schema.String,
});

const PtyListSchema = Schema.Struct({
	type: Schema.Literal("pty_list"),
	ptys: Schema.Array(PtyInfoSchema),
});

// ── Todo ────────────────────────────────────────────────────────────────
const TodoStateSchema = Schema.Struct({
	type: Schema.Literal("todo_state"),
	items: Schema.Array(TodoItemSchema),
});

// ── Connection status ────────────────────────────────────────────────
const ConnectionStatusSchema = Schema.Struct({
	type: Schema.Literal("connection_status"),
	status: Schema.Literal("disconnected", "reconnecting", "connected"),
});

// ── Plan mode ────────────────────────────────────────────────────────
const PlanEnterSchema = Schema.Struct({
	type: Schema.Literal("plan_enter"),
});

const PlanExitSchema = Schema.Struct({
	type: Schema.Literal("plan_exit"),
});

const PlanContentSchema = Schema.Struct({
	type: Schema.Literal("plan_content"),
	content: Schema.String,
});

const PlanApprovalSchema = Schema.Struct({
	type: Schema.Literal("plan_approval"),
});

// ── Banners ────────────────────────────────────────────────────────────
const SkipPermissionsSchema = Schema.Struct({
	type: Schema.Literal("skip_permissions"),
});

const BannerSchema = Schema.Struct({
	type: Schema.Literal("banner"),
	config: Schema.Struct({
		id: Schema.optional(Schema.String),
		variant: Schema.optional(Schema.String),
		icon: Schema.optional(Schema.String),
		text: Schema.optional(Schema.String),
		dismissible: Schema.optional(Schema.Boolean),
	}),
});

// ── File history / Rewind ────────────────────────────────────────────
const FileHistoryResultSchema = Schema.Struct({
	type: Schema.Literal("file_history_result"),
	path: Schema.String,
	versions: Schema.Array(FileVersionSchema),
});

const RewindResultSchema = Schema.Struct({
	type: Schema.Literal("rewind_result"),
	mode: Schema.String,
});

// ── Cache / Replay ────────────────────────────────────────────────────
const UserMessageSchema = Schema.Struct({
	type: Schema.Literal("user_message"),
	sessionId: Schema.String,
	text: Schema.String,
});

// ── Session deletion ──────────────────────────────────────────────────
const SessionDeletedSchema = Schema.Struct({
	type: Schema.Literal("session_deleted"),
	sessionId: Schema.String,
});

// ── Misc ────────────────────────────────────────────────────────────────
const ErrorSchema = Schema.Struct({
	type: Schema.Literal("error"),
	sessionId: Schema.String,
	code: Schema.String,
	message: Schema.String,
	statusCode: Schema.optional(Schema.Number),
	details: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
});

const SystemErrorSchema = Schema.Struct({
	type: Schema.Literal("system_error"),
	code: Schema.String,
	message: Schema.String,
	statusCode: Schema.optional(Schema.Number),
	details: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
});

const ClientCountSchema = Schema.Struct({
	type: Schema.Literal("client_count"),
	count: Schema.Number,
});

const InputSyncSchema = Schema.Struct({
	type: Schema.Literal("input_sync"),
	text: Schema.String,
	from: Schema.optional(Schema.String),
});

const UpdateAvailableSchema = Schema.Struct({
	type: Schema.Literal("update_available"),
	version: Schema.optional(Schema.String),
});

// ── Instance Management ──────────────────────────────────────────────
const InstanceListSchema = Schema.Struct({
	type: Schema.Literal("instance_list"),
	instances: Schema.Array(OpenCodeInstanceSchema),
});

const InstanceStatusMsgSchema = Schema.Struct({
	type: Schema.Literal("instance_status"),
	instanceId: Schema.String,
	status: InstanceStatusSchema,
});

const InstanceUpdateSchema = Schema.Struct({
	type: Schema.Literal("instance_update"),
	instanceId: Schema.String,
	name: Schema.optional(Schema.String),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	port: Schema.optional(Schema.Number),
});

// ── Provider session reload ─────────────────────────────────────────
const ProviderSessionReloadedSchema = Schema.Struct({
	type: Schema.Literal("provider_session_reloaded"),
	sessionId: Schema.String,
});

// ── Variant / thinking level ────────────────────────────────────────
const VariantInfoSchema = Schema.Struct({
	type: Schema.Literal("variant_info"),
	variant: Schema.optional(Schema.String),
	variants: Schema.optional(Schema.Array(Schema.String)),
});

const ContextWindowInfoSchema = Schema.Struct({
	type: Schema.Literal("context_window_info"),
	contextWindow: Schema.String,
	options: Schema.Array(ContextWindowOptionSchema),
});

const ProxyDetectedSchema = Schema.Struct({
	type: Schema.Literal("proxy_detected"),
	found: Schema.Boolean,
	port: Schema.Number,
});

const ScanResultSchema = Schema.Struct({
	type: Schema.Literal("scan_result"),
	discovered: Schema.Array(Schema.Number),
	lost: Schema.Array(Schema.Number),
	active: Schema.Array(Schema.Number),
});

// ── Cross-session notifications ──────────────────────────────────────
const NotificationEventSchema = Schema.Struct({
	type: Schema.Literal("notification_event"),
	eventType: Schema.String,
	message: Schema.optional(Schema.String),
	sessionId: Schema.optional(Schema.String),
});

// -- Combined RelayMessage schema union --

export const RelayMessageSchema = Schema.Union(
	// Streaming
	DeltaSchema,
	ThinkingStartSchema,
	ThinkingDeltaSchema,
	ThinkingStopSchema,
	// Tools
	ToolStartSchema,
	ToolExecutingSchema,
	ToolResultSchema,
	ToolContentSchema,
	// Permissions / Questions
	PermissionRequestSchema,
	PermissionResolvedSchema,
	AskUserSchema,
	AskUserResolvedSchema,
	AskUserErrorSchema,
	// Session lifecycle
	ResultSchema,
	StatusSchema,
	DoneSchema,
	SessionSwitchedSchema,
	SessionListSchema,
	SessionForkedSchema,
	HistoryPageSchema,
	// Model / Agent / Commands
	ModelInfoMsgSchema,
	DefaultModelInfoSchema,
	ModelListSchema,
	AgentListSchema,
	CommandListSchema,
	// Projects
	ProjectListSchema,
	DirectoryListSchema,
	// File browser
	FileListSchema,
	FileContentSchema,
	FileTreeSchema,
	FileChangedSchema,
	// Part lifecycle
	PartRemovedSchema,
	MessageRemovedSchema,
	// PTY / Terminal
	PtyCreatedSchema,
	PtyOutputSchema,
	PtyExitedSchema,
	PtyDeletedSchema,
	PtyListSchema,
	// Todo
	TodoStateSchema,
	// Connection status
	ConnectionStatusSchema,
	// Plan mode
	PlanEnterSchema,
	PlanExitSchema,
	PlanContentSchema,
	PlanApprovalSchema,
	// Banners
	SkipPermissionsSchema,
	BannerSchema,
	// File history / Rewind
	FileHistoryResultSchema,
	RewindResultSchema,
	// Cache / Replay
	UserMessageSchema,
	// Session deletion
	SessionDeletedSchema,
	// Misc
	ErrorSchema,
	SystemErrorSchema,
	ClientCountSchema,
	InputSyncSchema,
	UpdateAvailableSchema,
	// Instance Management
	InstanceListSchema,
	InstanceStatusMsgSchema,
	InstanceUpdateSchema,
	// Provider session reload
	ProviderSessionReloadedSchema,
	// Variant / thinking level
	VariantInfoSchema,
	ContextWindowInfoSchema,
	ProxyDetectedSchema,
	ScanResultSchema,
	// Cross-session notifications
	NotificationEventSchema,
);

// ─── Relay WebSocket messages ───────────────────────────────────────────────
// The manual union below is the primary type used throughout the codebase.
// RelayMessageSchema (above) provides runtime validation and is exported
// alongside for consumers that want schema-based decoding.

export type RelayMessage =
	// ── Streaming ──────────────────────────────────────────────────────────
	| { type: "delta"; sessionId: string; text: string; messageId?: string }
	| { type: "thinking_start"; sessionId: string; messageId?: string }
	| {
			type: "thinking_delta";
			sessionId: string;
			text: string;
			messageId?: string;
	  }
	| { type: "thinking_stop"; sessionId: string; messageId?: string }
	// ── Tools ──────────────────────────────────────────────────────────────
	| {
			type: "tool_start";
			sessionId: string;
			id: string;
			name: string;
			messageId?: string;
	  }
	| {
			type: "tool_executing";
			sessionId: string;
			id: string;
			name: string;
			input: Record<string, unknown> | undefined;
			/** Tool part metadata — carries sessionId for Task/subagent tools. */
			metadata?: Record<string, unknown>;
			messageId?: string;
	  }
	| {
			type: "tool_result";
			sessionId: string;
			id: string;
			content: string;
			is_error: boolean;
			isTruncated?: boolean;
			fullContentLength?: number;
			messageId?: string;
	  }
	| { type: "tool_content"; sessionId: string; toolId: string; content: string }
	// ── Permissions / Questions ────────────────────────────────────────────
	| {
			type: "permission_request";
			sessionId: string;
			requestId: PermissionId;
			toolName: string;
			toolInput: Record<string, unknown>;
			toolUseId?: string;
			always?: string[];
	  }
	| {
			type: "permission_resolved";
			sessionId: string;
			requestId: PermissionId;
			decision: string;
	  }
	| {
			type: "ask_user";
			sessionId: string;
			toolId: string;
			questions: AskUserQuestion[];
			toolUseId?: string;
	  }
	| { type: "ask_user_resolved"; toolId: string; sessionId: string }
	| {
			type: "ask_user_error";
			sessionId: string;
			toolId: string;
			message: string;
	  }
	// ── Session lifecycle ──────────────────────────────────────────────────
	| {
			type: "result";
			usage: UsageInfo;
			cost: number;
			duration: number;
			sessionId: string;
			messageId?: string;
	  }
	| { type: "status"; sessionId: string; status: string }
	| { type: "done"; sessionId: string; code: number }
	| {
			type: "session_switched";
			id: string;
			sessionId: string;
			/** Correlation ID echoed from new_session request. */
			requestId?: RequestId;
			/** Raw events for client replay (cache hit). */
			events?: RelayMessage[];
			/** When true, the event cache does not cover the full session
			 *  (eviction or late start) and the frontend should fall through
			 *  to server-based pagination when the replay buffer is exhausted. */
			eventsHasMore?: boolean;
			/** Structured messages for REST API fallback (converted to ChatMessages and prepended to the session's message list). */
			history?: {
				messages: HistoryMessage[];
				hasMore: boolean;
				total?: number;
			};
			/** Current input draft text for this session (from input_sync). */
			inputText?: string;
	  }
	| {
			type: "session_list";
			sessions: SessionInfo[];
			roots: boolean;
			search?: boolean;
	  }
	| {
			type: "session_forked";
			sessionId: string;
			/** The newly created forked session. */
			session: SessionInfo;
			/** The session this was forked from. */
			parentId: string;
			/** Title of the parent session. */
			parentTitle: string;
	  }
	| {
			type: "history_page";
			sessionId: string;
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
	  }
	// ── Model / Agent / Commands ───────────────────────────────────────────
	| { type: "model_info"; model: string; provider: string }
	| { type: "default_model_info"; model: string; provider: string }
	| { type: "model_list"; providers: ProviderInfo[] }
	| { type: "agent_list"; agents: AgentInfo[]; activeAgentId?: string }
	| { type: "command_list"; commands: CommandInfo[] }
	// ── Projects ───────────────────────────────────────────────────────────
	| {
			type: "project_list";
			projects: readonly ProjectInfo[];
			current?: string;
			addedSlug?: string;
	  }
	| { type: "directory_list"; path: string; entries: string[] }
	// ── File browser ───────────────────────────────────────────────────────
	| { type: "file_list"; path: string; entries: FileEntry[] }
	| { type: "file_content"; path: string; content: string; binary?: boolean }
	| { type: "file_tree"; entries: string[] }
	| { type: "file_changed"; path: string; changeType: "edited" | "external" }
	// ── Part lifecycle ─────────────────────────────────────────────────────
	| {
			type: "part_removed";
			sessionId: string;
			partId: string;
			messageId: string;
	  }
	| { type: "message_removed"; sessionId: string; messageId: string }
	// ── PTY / Terminal ─────────────────────────────────────────────────────
	| { type: "pty_created"; pty: PtyInfo }
	| { type: "pty_output"; ptyId: string; data: string }
	| { type: "pty_exited"; ptyId: string; exitCode: number }
	| { type: "pty_deleted"; ptyId: string }
	| { type: "pty_list"; ptys: PtyInfo[] }
	// ── Todo ────────────────────────────────────────────────────────────────
	| { type: "todo_state"; items: TodoItem[] }
	// ── Connection status (for frontend reconnection UI) ────────────────
	| {
			type: "connection_status";
			status: "disconnected" | "reconnecting" | "connected";
	  }
	// ── Plan mode (future feature) ────────────────────────────────────────
	| { type: "plan_enter" }
	| { type: "plan_exit" }
	| { type: "plan_content"; content: string }
	| { type: "plan_approval" }
	// ── Banners ────────────────────────────────────────────────────────────
	| { type: "skip_permissions" }
	| {
			type: "banner";
			config: {
				id?: string;
				variant?: string;
				icon?: string;
				text?: string;
				dismissible?: boolean;
			};
	  }
	// ── File history / Rewind (future feature) ────────────────────────────
	| { type: "file_history_result"; path: string; versions: FileVersion[] }
	| { type: "rewind_result"; mode: string }
	// ── Cache / Replay ────────────────────────────────────────────────────
	| { type: "user_message"; sessionId: string; text: string }
	// ── Session deletion ──────────────────────────────────────────────────
	| { type: "session_deleted"; sessionId: string }
	// ── Misc ────────────────────────────────────────────────────────────────
	| {
			type: "error";
			sessionId: string;
			code: string;
			message: string;
			statusCode?: number;
			details?: Record<string, unknown>;
	  }
	| {
			type: "system_error";
			code: string;
			message: string;
			statusCode?: number;
			details?: Record<string, unknown>;
	  }
	| { type: "client_count"; count: number }
	| { type: "input_sync"; text: string; from?: string }
	| { type: "update_available"; version?: string }
	// ── Instance Management ──────────────────────────────────────────────
	| { type: "instance_list"; instances: readonly OpenCodeInstance[] }
	| {
			type: "instance_status";
			instanceId: string;
			status: InstanceStatus;
	  }
	| {
			type: "instance_update";
			instanceId: string;
			name?: string;
			env?: Record<string, string>;
			port?: number;
	  }
	// ── Provider session reload ─────────────────────────────────────────
	| { type: "provider_session_reloaded"; sessionId: string }
	// ── Variant / thinking level ────────────────────────────────────────
	| { type: "variant_info"; variant?: string; variants?: string[] }
	| {
			type: "context_window_info";
			contextWindow: string;
			options: readonly ContextWindowOption[];
	  }
	| { type: "proxy_detected"; found: boolean; port: number }
	| {
			type: "scan_result";
			discovered: number[];
			lost: number[];
			active: number[];
	  }
	// ── Cross-session notifications ──────────────────────────────────────
	// Broadcast to ALL clients when a notification-worthy event (done, error)
	// is dropped by the pipeline because no viewers are on that session.
	// The frontend triggers sound/browser notifications without updating
	// chat state. See ws-dispatch.ts and event-pipeline.ts.
	| {
			type: "notification_event";
			/** The original event type (done, error, etc.) */
			eventType: string;
			/** Error message (for error events) */
			message?: string;
			/** Session that triggered the event (for notification click routing) */
			sessionId?: string;
	  };

// ─── Per-session / Global event discriminators ────────────────────────────
// These types let code distinguish per-session events (which always carry
// sessionId) from global events (which never do).

export type PerSessionEventType =
	| "delta"
	| "thinking_start"
	| "thinking_delta"
	| "thinking_stop"
	| "tool_start"
	| "tool_executing"
	| "tool_result"
	| "tool_content"
	| "result"
	| "done"
	| "error"
	| "status"
	| "user_message"
	| "part_removed"
	| "message_removed"
	| "ask_user"
	| "ask_user_resolved"
	| "ask_user_error"
	| "permission_request"
	| "permission_resolved"
	| "session_switched"
	| "session_forked"
	| "history_page"
	| "provider_session_reloaded"
	| "session_deleted";

export type PerSessionEvent = Extract<
	RelayMessage,
	{ type: PerSessionEventType; sessionId: string }
>;
export type GlobalRelayEvent = Exclude<
	RelayMessage,
	{ type: PerSessionEventType }
>;

// ─── Untagged events (translator output before sessionId tagging) ──────────
// The SSE translator and message poller produce events without sessionId.
// These are tagged with sessionId at emission sites before broadcast.

/**
 * A RelayMessage variant that may be missing sessionId.
 * Used as the output type of the SSE translator before post-translation tagging.
 *
 * Structurally a `RelayMessage` that also accepts objects without sessionId.
 * The `tagWithSessionId` helper converts these to proper RelayMessages.
 */
export type UntaggedRelayMessage =
	| RelayMessage
	// biome-ignore lint/suspicious/noExplicitAny: intentionally loose — translator output before sessionId tagging
	| (Record<string, any> & { type: string });

/**
 * Tag a per-session event with the given sessionId. Non-per-session events
 * pass through unchanged. Returns a properly typed RelayMessage.
 */
export function tagWithSessionId(
	msg: UntaggedRelayMessage,
	sessionId: string,
): RelayMessage {
	// If the message already has a sessionId, return as-is
	if (
		"sessionId" in msg &&
		typeof msg.sessionId === "string" &&
		msg.sessionId
	) {
		return msg as RelayMessage;
	}
	// Add sessionId to all per-session event types
	return { ...msg, sessionId } as RelayMessage;
}

// ─── Instance Types ─────────────────────────────────────────────────────────

export type InstanceStatus = "starting" | "healthy" | "unhealthy" | "stopped";

export interface OpenCodeInstance {
	id: string;
	name: string;
	port: number;
	managed: boolean;
	status: InstanceStatus;
	pid?: number;
	env?: Record<string, string>;
	needsRestart?: boolean;
	exitCode?: number;
	lastHealthCheck?: number;
	restartCount: number;
	createdAt: number;
}

export interface InstanceConfig {
	name: string;
	port: number;
	managed: boolean;
	env?: Record<string, string>;
	/** For external (unmanaged) instances: the full URL */
	url?: string;
}

// ─── Typed API Responses ────────────────────────────────────────────────────
// Every HTTP JSON endpoint uses one of these types with `satisfies` at the
// JSON.stringify call site.  This prevents serialization bugs where fields
// are silently dropped.

/** Standard API error envelope used by all error responses. */
export interface ApiError {
	error: {
		code: string;
		message: string;
	};
}

// ─── Auth ──────────────────────────────────────────────────────────────────

export interface AuthStatusResponse {
	hasPin: boolean;
	authenticated: boolean;
}

export type AuthResponse =
	| { ok: true }
	| { ok: false; locked: true; retryAfter: number }
	| { ok: false; attemptsLeft: number };

// ─── Setup ─────────────────────────────────────────────────────────────────

export interface SetupInfoResponse {
	httpsUrl: string;
	httpUrl: string;
	hasCert: boolean;
	lanMode: boolean;
}

// ─── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
	ok: boolean;
	projects: number;
	uptime: number;
}

// ─── Info ──────────────────────────────────────────────────────────────────

export interface InfoResponse {
	version: string;
}

// ─── Themes ────────────────────────────────────────────────────────────────

export interface ThemesResponse {
	bundled: Record<string, Base16Theme>;
	custom: Record<string, Base16Theme>;
}

// ─── Projects ──────────────────────────────────────────────────────────────

export interface DashboardProjectResponse {
	slug: string;
	path: string;
	title: string;
	status: "registering" | "ready" | "error";
	error?: string;
	sessions: number;
	clients: number;
	isProcessing: boolean;
}

export interface ProjectsListResponse {
	projects: DashboardProjectResponse[];
	version: string;
}

// ─── Project Status ────────────────────────────────────────────────────────

export interface ProjectStatusResponse {
	status: "registering" | "ready" | "error";
	error?: string;
}

// ─── Push ──────────────────────────────────────────────────────────────────

export interface VapidKeyResponse {
	publicKey: string;
}

export interface PushOkResponse {
	ok: true;
}
