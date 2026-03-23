// ─── Shared Types ───────────────────────────────────────────────────────────
// Types shared between server and frontend.
// Imported by src/lib/types.ts (server) and frontend code.

/**
 * Branded type for request/response correlation IDs.
 * Prevents accidentally passing a session ID where a correlation ID is expected.
 * Erased at runtime — zero cost.
 */
export type RequestId = string & { readonly __brand: "RequestId" };

/**
 * Branded type for OpenCode permission entity IDs (e.g., "per_cd6d6dc8...").
 * Prevents accidentally passing a session ID or correlation ID where a
 * permission ID is expected. Erased at runtime — zero cost.
 */
export type PermissionId = string & { readonly __brand: "PermissionId" };

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

// ─── Tool Status ────────────────────────────────────────────────────────────

/** Status of a tool call — shared between server relay and frontend. */
export type ToolStatus = "pending" | "running" | "completed" | "error";

/** Part type in an assistant message — covers text, reasoning, tool calls, and structural parts. */
export type PartType =
	| "text"
	| "reasoning"
	| "tool"
	| "file"
	| "snapshot"
	| "patch"
	| "agent"
	| "compaction"
	| "subtask"
	| "retry"
	| "step-start"
	| "step-finish";

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

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	variants?: string[];
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

/** Shape of HistoryMessage parts (tool calls, text, reasoning, etc.) */
export interface HistoryMessagePart {
	id: string;
	type: PartType;
	/** Text content — matches OpenCode's TextPart schema (field is "text", not "content"). */
	text?: string;
	/** Server-pre-rendered HTML for assistant text parts (C3 optimization). */
	renderedHtml?: string;
	/** Tool state — present on tool-type parts, contains status/input/output. */
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

/** A single message from the OpenCode REST history API */
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

// ─── Relay WebSocket messages ───────────────────────────────────────────────

export type RelayMessage =
	// ── Streaming ──────────────────────────────────────────────────────────
	| { type: "delta"; text: string; messageId?: string }
	| { type: "thinking_start"; messageId?: string }
	| { type: "thinking_delta"; text: string; messageId?: string }
	| { type: "thinking_stop"; messageId?: string }
	// ── Tools ──────────────────────────────────────────────────────────────
	| { type: "tool_start"; id: string; name: string; messageId?: string }
	| {
			type: "tool_executing";
			id: string;
			name: string;
			input: Record<string, unknown> | undefined;
			/** Tool part metadata — carries sessionId for Task/subagent tools. */
			metadata?: Record<string, unknown>;
			messageId?: string;
	  }
	| {
			type: "tool_result";
			id: string;
			content: string;
			is_error: boolean;
			isTruncated?: boolean;
			fullContentLength?: number;
			messageId?: string;
	  }
	| { type: "tool_content"; toolId: string; content: string }
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
	| { type: "permission_resolved"; requestId: PermissionId; decision: string }
	| {
			type: "ask_user";
			toolId: string;
			questions: AskUserQuestion[];
			toolUseId?: string;
	  }
	| { type: "ask_user_resolved"; toolId: string }
	| { type: "ask_user_error"; toolId: string; message: string }
	// ── Session lifecycle ──────────────────────────────────────────────────
	| {
			type: "result";
			usage: UsageInfo;
			cost: number;
			duration: number;
			sessionId: string;
	  }
	| { type: "status"; status: string }
	| { type: "done"; code: number }
	| {
			type: "session_switched";
			id: string;
			/** Correlation ID echoed from new_session request. */
			requestId?: RequestId;
			/** Raw events for client replay (cache hit). */
			events?: RelayMessage[];
			/** Structured messages for REST API fallback (converted to ChatMessages and prepended to chatState). */
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
	| { type: "part_removed"; partId: string; messageId: string }
	| { type: "message_removed"; messageId: string }
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
	| { type: "user_message"; text: string }
	// ── Misc ────────────────────────────────────────────────────────────────
	| { type: "error"; code: string; message: string }
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
	// ── Variant / thinking level ────────────────────────────────────────
	| { type: "variant_info"; variant?: string; variants?: string[] }
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
	  };

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
