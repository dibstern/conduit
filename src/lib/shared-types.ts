// Types shared between server and frontend.
// Imported by src/lib/types.ts (server) and frontend code.

import {
	LimitRecoverySchema,
	SessionResumeSchema,
} from "./contracts/limit-recovery.js";
import type {
	ProviderDriverKind,
	ProviderSessionCapabilities,
} from "./contracts/provider-instance.js";
import { SessionGoalChangedPayloadSchema } from "./contracts/stored-event.js";
// SDK-derived type aliases — single source of truth for Part/Tool enums.
// Imported for local use; re-exported below for downstream consumers.
import type { PartType, ToolStatus } from "./instance/sdk-types.js";
export type { PartType, ToolStatus };

import { Schema } from "effect";

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

export const ProviderPermissionUpdateDestinationSchema = Schema.Literal(
	"userSettings",
	"projectSettings",
	"localSettings",
	"session",
	"cliArg",
);
export type ProviderPermissionUpdateDestination =
	typeof ProviderPermissionUpdateDestinationSchema.Type;

const ProviderPermissionRuleValueSchema = Schema.Struct({
	toolName: Schema.String,
	ruleContent: Schema.optional(Schema.String),
});

const ProviderPermissionBehaviorSchema = Schema.Literal("allow", "deny", "ask");
const ProviderPermissionModeSchema = Schema.Literal(
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
);

/**
 * Conduit-level per-session approval mode. Corresponds 1:1 to the Claude Agent
 * SDK's six permission modes -- see provider/claude/permission-mode-map.ts.
 * "ask" and "full" keep conduit's original spellings (SDK "default" and
 * "bypassPermissions") so persisted rows stay valid without a migration.
 */
export const SessionPermissionModeSchema = Schema.Literal(
	"ask",
	"acceptEdits",
	"auto",
	"full",
	"plan",
	"dontAsk",
);
export type SessionPermissionMode = typeof SessionPermissionModeSchema.Type;

export const ProviderPermissionUpdateSchema = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("addRules"),
		rules: Schema.Array(ProviderPermissionRuleValueSchema),
		behavior: ProviderPermissionBehaviorSchema,
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("replaceRules"),
		rules: Schema.Array(ProviderPermissionRuleValueSchema),
		behavior: ProviderPermissionBehaviorSchema,
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("removeRules"),
		rules: Schema.Array(ProviderPermissionRuleValueSchema),
		behavior: ProviderPermissionBehaviorSchema,
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("setMode"),
		mode: ProviderPermissionModeSchema,
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("addDirectories"),
		directories: Schema.Array(Schema.String),
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("removeDirectories"),
		directories: Schema.Array(Schema.String),
		destination: ProviderPermissionUpdateDestinationSchema,
	}),
);
export type ProviderPermissionUpdate =
	typeof ProviderPermissionUpdateSchema.Type;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	subject: string;
	description?: string | undefined;
	status: TodoStatus;
}

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

export interface AgentInfo {
	id: string;
	name: string;
	description?: string;
	model?: string;
}

export interface AgentProviderScope {
	id: string;
	name: string;
}

export interface ProviderInfo {
	id: string;
	instanceId?: string;
	name: string;
	configured: boolean;
	models: ModelInfo[];
}

export interface ContextWindowOption {
	value: string;
	label: string;
	isDefault?: boolean | undefined;
}

/** The catalog entry a model id names. Turns and settings keep whatever id the
 *  catalog advertised when they were written, and Claude's catalog moves its
 *  `[1m]` context-window marker on and off (`opus[1m]` became `opus`), so an
 *  exact miss falls back to the same model with or without it. The model's own
 *  provider is searched first: OpenCode and Claude can list the same id with
 *  different options. Mirrors the frontend's `modelMatchesId`. */
export function findCatalogModel<
	M extends {
		id: string;
		routingOptions?: readonly ContextWindowOption[] | undefined;
	},
>(
	providers: ReadonlyArray<{ id: string; models: ReadonlyArray<M> }>,
	model: { providerID: string; modelID: string } | undefined,
): M | undefined {
	if (!model) return undefined;
	const identity = (id: string) => id.replace(/\[1m\]$/i, "");
	const exact = (entry: M) =>
		entry.id === model.modelID ||
		entry.routingOptions?.some((option) => option.value === model.modelID);
	const own =
		providers.find((provider) => provider.id === model.providerID)?.models ??
		[];
	return (
		own.find(exact) ??
		providers.flatMap((provider) => provider.models).find(exact) ??
		own.find((entry) => identity(entry.id) === identity(model.modelID))
	);
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	variants?: string[];
	contextWindowOptions?: ContextWindowOption[];
	/** Geo routing scopes for grouped Bedrock models; value is the full model id to send. */
	routingOptions?: ContextWindowOption[];
}

export interface CommandInfo {
	name: string;
	description?: string;
	args?: string;
	/** The provider's own command or bundled skill; the composer offers these under `$`. */
	builtin?: boolean;
}

export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number | undefined;
	modified?: number | undefined;
}

/** The `sessions` projection's lifecycle status, as the row stores it. */
export const SessionStatusSchema = Schema.Literal(
	"idle",
	"busy",
	"retry",
	"error",
);

export const SESSION_ATTENTION_TIERS = [
	"needs-approval",
	"needs-reply",
	"error",
	"working",
	// Only watchers (Monitor, background shells) are live: calm, not busy.
	"monitoring",
	"done-unread",
	"idle",
] as const;
export type SessionAttention = (typeof SESSION_ATTENTION_TIERS)[number];
export const SessionAttentionSchema = Schema.Literal(
	...SESSION_ATTENTION_TIERS,
);

/** Live Claude background tasks that outlive their turn, by what they are doing. */
export const BackgroundWorkSchema = Schema.Literal("working", "monitoring");
export type BackgroundWork = typeof BackgroundWorkSchema.Type;

/** A live, non-ambient Claude background task (shell, agent, monitor, ...). */
export const BackgroundTaskSchema = Schema.Struct({
	id: Schema.String,
	/** SDK task_type, e.g. local_bash, local_agent, monitor_mcp. */
	type: Schema.String,
	description: Schema.String,
	/** Epoch ms when conduit first saw this task id; the SDK gives no start time. */
	firstSeenAt: Schema.Number,
});
export type BackgroundTask = typeof BackgroundTaskSchema.Type;

export interface SessionGit {
	branch?: string;
	head?: string;
	worktree?: string;
	dirty?: boolean;
	ahead?: number;
	behind?: number;
	merged?: boolean;
	operation?: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";
}

export const SessionGitSchema = Schema.Struct({
	branch: Schema.optionalWith(Schema.String, { exact: true }),
	head: Schema.optionalWith(Schema.String, { exact: true }),
	worktree: Schema.optionalWith(Schema.String, { exact: true }),
	dirty: Schema.optionalWith(Schema.Boolean, { exact: true }),
	ahead: Schema.optionalWith(Schema.Number, { exact: true }),
	behind: Schema.optionalWith(Schema.Number, { exact: true }),
	merged: Schema.optionalWith(Schema.Boolean, { exact: true }),
	operation: Schema.optionalWith(
		Schema.Literal("rebase", "merge", "cherry-pick", "revert", "bisect"),
		{ exact: true },
	),
});

/** One wire shape for projected sessions and daemon-wide lists. */
export const SessionInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	status: SessionStatusSchema,
	projectSlug: Schema.optional(Schema.String),
	createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	updatedAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	messageCount: Schema.optional(Schema.Number),
	processing: Schema.optional(Schema.Boolean),
	goalState: Schema.optional(SessionGoalChangedPayloadSchema),
	limitRecovery: Schema.optional(Schema.NullOr(LimitRecoverySchema)),
	resumes: Schema.optional(Schema.Array(SessionResumeSchema)),
	/** The approval mode this session was last switched to; absent until one is. */
	permissionMode: Schema.optional(SessionPermissionModeSchema),
	/** The session's model, effort and context window; absent until set. "" follows the default. */
	model: Schema.optional(
		Schema.Struct({ model: Schema.String, provider: Schema.String }),
	),
	variant: Schema.optional(Schema.String),
	contextWindow: Schema.optional(Schema.String),
	/** Parent session ID — set when this session was forked from another. */
	parentID: Schema.optional(Schema.String),
	sideThread: Schema.optional(Schema.Boolean),
	/** The message ID at the fork point — messages up to this ID are inherited context. */
	forkMessageId: Schema.optional(Schema.String),
	/** Inclusive boundary in transcript (created_at, id) order. */
	forkPointTimestamp: Schema.optional(Schema.Number),
	/** Ordering ID when the SDK lineage boundary differs from the UI message ID. */
	forkPointMessageId: Schema.optional(Schema.String),
	pendingQuestionCount: Schema.optional(Schema.Number),
	pendingPermissionCount: Schema.optional(Schema.Number),
	attention: Schema.optional(SessionAttentionSchema),
	/** This session's own background work; unlike attention, not rolled up. */
	backgroundWork: Schema.optional(BackgroundWorkSchema),
	/** The live tasks behind backgroundWork, oldest first. */
	backgroundTasks: Schema.optional(Schema.Array(BackgroundTaskSchema)),
	/** A compaction in progress: transient status, never logged (C1). */
	compacting: Schema.optional(Schema.String),
	/** A provider retry's reason while it waits: transient status, never logged (C1). */
	retrying: Schema.optional(Schema.String),
	unread: Schema.optional(Schema.Boolean),
	/** Stream version of the latest turn end; what a sidebar pick reports as seen. */
	lastTurnEndVersion: Schema.optional(Schema.Number),
	settledAt: Schema.optional(Schema.Number),
	settledAutomatically: Schema.optional(Schema.Boolean),
	autoSettleDisabled: Schema.optional(Schema.Boolean),
	pinnedAt: Schema.optional(Schema.Number),
	snoozedAt: Schema.optional(Schema.Number),
	git: Schema.optional(SessionGitSchema),
	snoozedUntil: Schema.optional(Schema.Number),
	wokenAt: Schema.optional(Schema.Number),
	wokeBecause: Schema.optional(
		Schema.Literal("time", "approval", "question", "error", "turn"),
	),
});

export type SessionInfo = typeof SessionInfoSchema.Type;

export interface DaemonSessionQueryOptions {
	readonly limit?: number;
	readonly roots?: boolean;
	readonly search?: string;
	readonly cursor?: DaemonSessionCursor;
	/** Read one project only. Filtering the merged page instead would leave a
	 *  scoped list with a handful of rows per page, and paging would stall. */
	readonly scope?: string;
	/** Skip one project. The browser already holds its own project's roots
	 *  from the shell feed, so those rows would only be fetched and dropped. */
	readonly exclude?: string;
}

export interface DaemonSessionCursor {
	readonly updatedAt: number;
	readonly id: string;
}

export type ProjectSessionAvailability =
	| {
			readonly projectSlug: string;
			readonly available: true;
	  }
	| {
			readonly projectSlug: string;
			readonly available: false;
			readonly error: string;
	  };

export interface DaemonSessionQueryResult {
	readonly sessions: ReadonlyArray<SessionInfo>;
	readonly availability: ReadonlyArray<ProjectSessionAvailability>;
	readonly hasMore: boolean;
	readonly nextCursor: DaemonSessionCursor | null;
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: { label: string; description?: string }[];
	multiSelect: boolean;
	custom?: boolean;
}

export interface UsageInfo {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
	context_window?: number | undefined;
}

export type PtyStatus = "running" | "exited";

export interface PtyInfo {
	id: string;
	title: string;
	command: string;
	cwd: string;
	status: PtyStatus;
	pid: number;
}

// These are relay-specific history types for paged transcript RPC responses.
// They represent a loose superset of the SDK's Part and Message
// types with relay-specific extensions (renderedHtml, index signatures).
//
// SDK type mapping:
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
	type: PartType | "thinking" | "error";
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
		/** `output` is a preview; GetToolContent serves the full text. */
		isTruncated?: boolean;
		fullContentLength?: number;
		error?: string;
		[key: string]: unknown;
	};
	callID?: string;
	tool?: string;
	/** Wall-clock span of this part. `start` is what activity timings measure. */
	time?: { start?: number; end?: number };
	/** Context size before/after a compaction boundary — present on `compaction`
	 *  parts so the divider and context-% bar can be reconstructed on reload. */
	preTokens?: number;
	postTokens?: number;
	/** A `compaction` part whose compaction failed. */
	failed?: boolean;
	/** Provider error code on an `error` part (a turn that ended in error). */
	code?: string;
	[key: string]: unknown;
}

export interface ModelExecution {
	requestedModel?: string | undefined;
	expectedModel?: string | undefined;
	actualModel: string;
	drifted?: boolean | undefined;
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
	/** True when reconstructed from provider REST history rather than observed live. */
	isBackfilled?: boolean;
	parts?: HistoryMessagePart[];
	time?: { created?: number; completed?: number };
	/** Cost in dollars — present on assistant messages from REST API. */
	cost?: number;
	/** Token usage — present on assistant messages from REST API. */
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
		context_window?: number;
	};
	/** OpenCode: the user message this assistant step answers. */
	parentID?: string;
	/** OpenCode: why the step stopped; "tool-calls" means the turn goes on. */
	finish?: string;
	error?: unknown;
	modelExecution?: ModelExecution;
	turnTiming?: {
		startedAt: number;
		endedAt?: number;
		waits: { id: string; from: number; to?: number }[];
	};
	[key: string]: unknown;
}

export const RepositoryIdentitySchema = Schema.Struct({
	key: Schema.String,
	name: Schema.String,
	root: Schema.String,
});
export type RepositoryIdentity = typeof RepositoryIdentitySchema.Type;

/** A project in the project list */
export interface ProjectInfo {
	slug: string;
	title: string;
	/** folders[0] is the main folder, where sessions run. */
	folders: readonly [string, ...string[]];
	/** Keys are Project Folder paths; absent entries have no Repository Identity. */
	repositoryIdentities?: Readonly<Record<string, RepositoryIdentity>>;
	missing?: boolean;
	git?: SessionGit;
	clientCount?: number;
	instanceId?: string;
}

// Schema definitions for each RelayMessage variant. Built with @effect/schema
// to provide runtime validation and type derivation.

// -- Helper schemas for embedded types --

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
	context_window: Schema.optional(Schema.Number),
});

// -- Individual message variant schemas --

const DeltaSchema = Schema.Struct({
	type: Schema.Literal("delta"),
	sessionId: Schema.String,
	text: Schema.String,
	messageId: Schema.optional(Schema.String),
	partId: Schema.optional(Schema.String),
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

const ToolStartSchema = Schema.Struct({
	type: Schema.Literal("tool_start"),
	sessionId: Schema.String,
	id: Schema.String,
	name: Schema.String,
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

// What the approvals subscription serves (ni8.9): the pending permission
// requests and questions of every session in the project, each keyed by the id
// its answer is sent back with.
export const PermissionApprovalSchema = Schema.TaggedStruct("permission", {
	sessionId: Schema.String,
	requestId: PermissionId,
	toolName: Schema.String,
	toolInput: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	toolUseId: Schema.optional(Schema.String),
	always: Schema.optional(Schema.Array(Schema.String)),
	permissionSuggestions: Schema.optional(
		Schema.Array(ProviderPermissionUpdateSchema),
	),
	permissionTitle: Schema.optional(Schema.String),
	permissionDisplayName: Schema.optional(Schema.String),
	permissionDescription: Schema.optional(Schema.String),
	permissionReason: Schema.optional(Schema.String),
});

export const QuestionApprovalSchema = Schema.TaggedStruct("question", {
	sessionId: Schema.String,
	toolId: Schema.String,
	questions: Schema.Array(AskUserQuestionSchema),
	toolUseId: Schema.optional(Schema.String),
	providerId: Schema.optional(Schema.String),
});

export const ApprovalSchema = Schema.Union(
	PermissionApprovalSchema,
	QuestionApprovalSchema,
);
export type Approval = typeof ApprovalSchema.Type;

const ResultSchema = Schema.Struct({
	type: Schema.Literal("result"),
	usage: UsageInfoSchema,
	cost: Schema.Number,
	duration: Schema.Number,
	sessionId: Schema.String,
	messageId: Schema.optional(Schema.String),
	midTurn: Schema.optional(Schema.Literal(true)),
});

const DoneSchema = Schema.Struct({
	type: Schema.Literal("done"),
	alertId: Schema.optional(Schema.String),
	sessionId: Schema.String,
	code: Schema.Number,
	/** Why the turn failed. The transcript carries the notice; this is the alert's. */
	error: Schema.optional(Schema.String),
});

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

const UserMessageSchema = Schema.Struct({
	type: Schema.Literal("user_message"),
	sessionId: Schema.String,
	text: Schema.String,
	messageId: Schema.optional(Schema.String),
	originId: Schema.optional(Schema.String),
});

/** Bump on wire-contract changes. The build ID covers behavioural changes
 *  with the same wire shape. Absence marks a daemon older than the handshake. */
export const WS_PROTOCOL_VERSION = 5;

// -- Combined RelayMessage schema union --

export const RelayMessageSchema = Schema.Union(
	// Streaming
	DeltaSchema,
	ThinkingStartSchema,
	ThinkingDeltaSchema,
	// Tools
	ToolStartSchema,
	ToolResultSchema,
	// Session lifecycle
	ResultSchema,
	DoneSchema,
	// Part lifecycle
	PartRemovedSchema,
	MessageRemovedSchema,
	// Cache / Replay
	UserMessageSchema,
);

export type RelayMessage = typeof RelayMessageSchema.Type;

export const RELAY_MESSAGE_TYPES: ReadonlyArray<RelayMessage["type"]> =
	RelayMessageSchema.members.map((member) => member.fields.type.literals[0]);

export const KNOWN_RELAY_MESSAGE_TYPES: ReadonlySet<string> = new Set(
	RELAY_MESSAGE_TYPES,
);

// These types let code distinguish per-session events (which always carry
// sessionId) from global events (which never do).

export type PerSessionEventType =
	| "delta"
	| "thinking_start"
	| "thinking_delta"
	| "tool_start"
	| "tool_result"
	| "result"
	| "done"
	| "user_message"
	| "part_removed"
	| "message_removed";

export type PerSessionEvent = Extract<
	RelayMessage,
	{ type: PerSessionEventType; sessionId: string }
>;
export type GlobalRelayEvent = Exclude<
	RelayMessage,
	{ type: PerSessionEventType }
>;

// Untagged events (translator output before sessionId tagging)
// The SSE translator and message poller produce events without sessionId.
// These are tagged with sessionId before internal activity and notification handling.

/**
 * A RelayMessage variant that may be missing sessionId.
 * Used as the output type of the SSE translator before post-translation tagging.
 *
 * Structurally a `RelayMessage` that also accepts objects without sessionId.
 * The `tagWithSessionId` helper converts these to proper RelayMessages.
 */
export type UntaggedRelayMessage =
	| RelayMessage
	| (PerSessionEvent extends infer Event
			? Event extends { sessionId: string }
				? Omit<Event, "sessionId">
				: never
			: never);

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

export type InstanceStatus = "starting" | "healthy" | "unhealthy" | "stopped";

export interface OpenCodeInstance {
	id: string;
	name: string;
	port: number;
	managed: boolean;
	driver?: ProviderDriverKind;
	capabilities?: ProviderSessionCapabilities;
	configDir?: string;
	url?: string;
	status: InstanceStatus;
	pid?: number;
	version?: string;
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
	pid?: number;
	version?: string;
	driver?: ProviderDriverKind;
	configDir?: string;
	env?: Record<string, string>;
	/** For external (unmanaged) instances: the full URL */
	url?: string;
}

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

export interface AuthStatusResponse {
	hasPin: boolean;
	authenticated: boolean;
}

export type AuthResponse =
	| { ok: true }
	| { ok: false; locked: true; retryAfter: number }
	| { ok: false; attemptsLeft: number };

export interface SetupInfoResponse {
	httpsUrl: string;
	httpUrl: string;
	hasCert: boolean;
	lanMode: boolean;
	publicUrl: string | null;
}

export interface HealthResponse {
	ok: boolean;
	projects: number;
	uptime: number;
}

export interface InfoResponse {
	version: string;
}

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

export interface ProjectStatusResponse {
	status: "registering" | "ready" | "error";
	error?: string;
}

export interface VapidKeyResponse {
	publicKey: string;
}

export interface PushOkResponse {
	ok: true;
}
