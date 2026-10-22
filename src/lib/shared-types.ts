// Types shared between server and frontend.
// Imported by src/lib/types.ts (server) and frontend code.

import type { SurfacingMark } from "./contracts/category-set.js";
import {
	LimitRecoverySchema,
	SessionResumeSchema,
} from "./contracts/limit-recovery.js";
import type { SessionMode } from "./contracts/project-file.js";
import type { ProjectSetupState } from "./contracts/project-setup.js";
import type {
	ProviderDriverKind,
	ProviderSessionCapabilities,
} from "./contracts/provider-instance.js";
import { SessionWorkspaceSchema } from "./contracts/session-workspace.js";
import { WorkspaceMissingSchema } from "./contracts/worktree.js";

export type {
	SessionWorkspace,
	WorktreeInfo,
} from "./contracts/session-workspace.js";

import { SessionGoalChangedPayloadSchema } from "./contracts/stored-event.js";
import type { ToolInput, ToolText } from "./contracts/tool-wire.js";
import type { ModelInfo as WireModelInfo } from "./contracts/ws-rpc.js";
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

export const ProviderPermissionUpdateDestinationSchema = Schema.Literals([
	"userSettings",
	"projectSettings",
	"localSettings",
	"session",
	"cliArg",
]);
export type ProviderPermissionUpdateDestination =
	typeof ProviderPermissionUpdateDestinationSchema.Type;

const ProviderPermissionRuleValueSchema = Schema.Struct({
	toolName: Schema.String,
	ruleContent: Schema.optional(Schema.String),
});

const ProviderPermissionBehaviorSchema = Schema.Literals([
	"allow",
	"deny",
	"ask",
]);
const ProviderPermissionModeSchema = Schema.Literals([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
]);

/**
 * Conduit-level per-session approval mode. Corresponds 1:1 to the Claude Agent
 * SDK's six permission modes -- see provider/claude/permission-mode-map.ts.
 * "ask" and "full" keep conduit's original spellings (SDK "default" and
 * "bypassPermissions") so persisted rows stay valid without a migration.
 */
export const SessionPermissionModeSchema = Schema.Literals([
	"ask",
	"acceptEdits",
	"auto",
	"full",
	"plan",
	"dontAsk",
]);
export type SessionPermissionMode = typeof SessionPermissionModeSchema.Type;

export const ProviderPermissionUpdateSchema = Schema.Union([
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
]);
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

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	variants?: string[];
	parameters?: WireModelInfo["parameters"];
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
export const SessionStatusSchema = Schema.Literals([
	"idle",
	"busy",
	"retry",
	"error",
]);

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
export const SessionAttentionSchema = Schema.Literals([
	...SESSION_ATTENTION_TIERS,
]);

/** Live Claude background tasks that outlive their turn, by what they are doing. */
export const BackgroundWorkSchema = Schema.Literals(["working", "monitoring"]);
export type BackgroundWork = typeof BackgroundWorkSchema.Type;

/** A live, non-ambient Claude background task (shell, agent, monitor, ...). */
export const BackgroundTaskSchema = Schema.Struct({
	id: Schema.String,
	/** SDK task_type, e.g. local_bash, local_agent, monitor_mcp. */
	type: Schema.String,
	description: Schema.String,
	/** The originating shell command, agent type or workflow name, when known. */
	detail: Schema.optional(Schema.String),
	/** Epoch ms when conduit first saw this task id; the SDK gives no start time. */
	firstSeenAt: Schema.Number,
	/** An agent's Child Session. */
	childSessionId: Schema.optional(Schema.String),
	/** The task that started this one, for a task started inside an agent. */
	parentTaskId: Schema.optional(Schema.String),
	/** Ancestors beyond the live list, nearest first; supplied by task ownership. */
	ancestorTaskIds: Schema.optional(Schema.Array(Schema.String)),
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
	/** Full branch head incorporated into the default branch. */
	mergedHead?: string;
	/** Epoch milliseconds when the branch head reached the default branch. */
	mergedAt?: number;
	operation?: "rebase" | "merge" | "cherry-pick" | "revert" | "bisect";
	/** Git and shared Effective Folders in Project Folder order. */
	folders?: readonly SessionFolderGit[];
}

const GitStatusSchema = Schema.Struct({
	branch: Schema.optionalKey(Schema.String),
	head: Schema.optionalKey(Schema.String),
	worktree: Schema.optionalKey(Schema.String),
	dirty: Schema.optionalKey(Schema.Boolean),
	ahead: Schema.optionalKey(Schema.Number),
	behind: Schema.optionalKey(Schema.Number),
	merged: Schema.optionalKey(Schema.Boolean),
	mergedHead: Schema.optionalKey(Schema.String),
	mergedAt: Schema.optionalKey(Schema.Number),
	operation: Schema.optionalKey(
		Schema.Literals(["rebase", "merge", "cherry-pick", "revert", "bisect"]),
	),
});

export const SessionFolderGitSchema = Schema.Struct({
	root: Schema.String,
	label: Schema.String,
	/** Derived from conduit workspace origin and an absent worktree mapping. */
	shared: Schema.optionalKey(Schema.Boolean),
	/** An unavailable recorded checkout has no healthy Git status fields. */
	missing: Schema.optionalKey(Schema.Boolean),
	...GitStatusSchema.fields,
});
export type SessionFolderGit = typeof SessionFolderGitSchema.Type;

export const SessionGitSchema = Schema.Struct({
	...GitStatusSchema.fields,
	folders: Schema.optionalKey(Schema.Array(SessionFolderGitSchema)),
});

/** A run of consecutive goal checks that report the same blocker, found by code without a model call. */
export const GoalStuckSchema = Schema.Struct({
	/** Time of the first check in the run. */
	since: Schema.Number,
	/** Time of the latest check in the run. */
	lastAt: Schema.Number,
	/** Checks in the run, including the first. */
	count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
});
export type GoalStuck = typeof GoalStuckSchema.Type;

/** One wire shape for projected sessions and daemon-wide lists. */
export const SessionInfoSchema = Schema.Struct({
	id: Schema.String,
	/** Effective live account, or null when the stored binding cannot route. */
	accountId: Schema.NullOr(Schema.String),
	title: Schema.String,
	status: SessionStatusSchema,
	/** Whether explicit Stop has a target; absence preserves older-client behavior. */
	canStop: Schema.optional(Schema.Boolean),
	projectSlug: Schema.String,
	createdAt: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
	updatedAt: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
	/** Latest human-authored message in this session alone, in epoch milliseconds. */
	lastUserMessageAt: Schema.optional(Schema.Number),
	messageCount: Schema.optional(Schema.Number),
	processing: Schema.optional(Schema.Boolean),
	goalState: Schema.optional(SessionGoalChangedPayloadSchema),
	/** The current goal's stuck run, derived by code from its checks; absent when the latest checks are not repeating one blocker, and for met or cleared goals. */
	goalStuck: Schema.optional(GoalStuckSchema),
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
	/** Containing session, for subagents and Side Threads only. */
	parentID: Schema.optional(Schema.String),
	/** Source session whose context started this Fork or Side Thread. */
	forkedFrom: Schema.optional(Schema.String),
	sideThread: Schema.optional(Schema.Boolean),
	/** The message ID at the fork point — messages up to this ID are inherited context. */
	forkMessageId: Schema.optional(Schema.String),
	/** Inclusive boundary in transcript (created_at, id) order. */
	forkPointTimestamp: Schema.optional(Schema.Number),
	/** Source ordering ID at the cut; legacy Cursor forks may store the copied ID. */
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
	/** The send whose turn ended at `lastTurnEndVersion`, when known. */
	lastTurnEndInputId: Schema.optional(Schema.String),
	settledAt: Schema.optional(Schema.Number),
	archivedAt: Schema.optional(Schema.Number),
	settledAutomatically: Schema.optional(Schema.Boolean),
	autoSettleDisabled: Schema.optional(Schema.Boolean),
	pinnedAt: Schema.optional(Schema.Number),
	snoozedAt: Schema.optional(Schema.Number),
	git: Schema.optional(SessionGitSchema),
	workspace: Schema.optional(Schema.NullOr(SessionWorkspaceSchema)),
	workspaceMissing: Schema.optional(WorkspaceMissingSchema),
	/** Explicit Conduit launch ownership permits renaming its branches. */
	canRenameBranch: Schema.optional(Schema.Boolean),
	workspaceHint: Schema.optional(Schema.String),
	workspaceMismatch: Schema.optional(
		Schema.Struct({ actualPath: Schema.String }),
	),
	snoozedUntil: Schema.optional(Schema.Number),
	wokenAt: Schema.optional(Schema.Number),
	wokeBecause: Schema.optional(
		Schema.Literals(["time", "approval", "question", "error", "turn"]),
	),
});

export type SessionInfo = typeof SessionInfoSchema.Type;

export interface DaemonSessionQueryOptions {
	readonly limit?: number;
	readonly roots?: boolean;
	readonly search?: string;
	readonly includeArchived?: boolean;
	readonly cursor?: DaemonSessionCursor;
	/** Read one project slug. Filter projects
	 *  before merging their pages, so scoped search and paging remain complete. */
	readonly scope?: string;
	/** Skip one project. The browser already holds its own project's roots
	 *  from the shell feed, so those rows would only be fetched and dropped. */
	readonly exclude?: string;
}

export interface DaemonSessionCursor {
	readonly updatedAt: number;
	readonly id: string;
}

export interface ArchivedSessionCursor {
	readonly archivedAt: number;
	readonly id: string;
}

export interface ArchivedSessionQueryOptions {
	readonly limit?: number;
	readonly cursor?: ArchivedSessionCursor;
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
	readonly settledCounts?: ReadonlyArray<{
		readonly projectSlug: string;
		readonly count: number;
	}>;
	readonly availability: ReadonlyArray<ProjectSessionAvailability>;
	readonly hasMore: boolean;
	readonly nextCursor: DaemonSessionCursor | null;
}

export interface ArchivedSessionQueryResult
	extends Omit<DaemonSessionQueryResult, "nextCursor"> {
	readonly nextCursor: ArchivedSessionCursor | null;
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
	surfacingMark?: SurfacingMark | null | undefined;
	surfacingOrdinal?: number;
	surfacingProbabilities?: Record<string, number> | null;
	surfacingSetVersion?: number;
	surfacingModel?: string;
	surfacingRead?: boolean;
	type: PartType | "thinking" | "error" | "setup" | "notice";
	/** Daemon setup notice, carried by the normal durable transcript. */
	setup?: ProjectSetupState;
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
		/** Whole, or a preview GetToolDetails serves in full. */
		input?: ToolInput;
		output?: ToolText;
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
	/** The browser send a user message was placed for. */
	inputId?: string;
	/** A user message the provider read mid-turn, closing the turn it joined. */
	steered?: boolean;
	parts?: HistoryMessagePart[];
	time?: { created?: number; completed?: number };
	/** Cost in dollars — present on assistant messages from REST API. */
	cost?: number;
	/** Canonical turn cost from the persisted turn projection, when available. */
	turnCost?: number;
	/** Context occupancy reported separately from cumulative result usage. */
	contextTokens?: number;
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
	addedAt?: number;
	/** folders[0] is the main folder, where sessions run. */
	folders: readonly [string, ...string[]];
	setupScript?: string | undefined;
	sessionMode?: SessionMode | undefined;
	/** Keys are Project Folder paths; absent entries have no Repository Identity. */
	repositoryIdentities?: Readonly<Record<string, RepositoryIdentity>>;
	missing?: boolean;
	unavailableReason?: string;
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
	messageId: Schema.optional(Schema.String),
});

// What the approvals subscription serves (ni8.9): the pending permission
// requests and questions of every session in the project, each keyed by the id
// its answer is sent back with.
export const PermissionApprovalSchema = Schema.TaggedStruct("permission", {
	sessionId: Schema.String,
	requestId: PermissionId,
	toolName: Schema.String,
	toolInput: Schema.Record(Schema.String, Schema.Unknown),
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

export const ApprovalSchema = Schema.Union([
	PermissionApprovalSchema,
	QuestionApprovalSchema,
]);
export type Approval = typeof ApprovalSchema.Type;

const ResultSchema = Schema.Struct({
	type: Schema.Literal("result"),
	usage: UsageInfoSchema,
	contextTokens: Schema.optionalKey(Schema.Number),
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
export const WS_PROTOCOL_VERSION = 7;

// -- Combined RelayMessage schema union --

export const RelayMessageSchema = Schema.Union([
	DeltaSchema,
	ThinkingStartSchema,
	ThinkingDeltaSchema,
	ToolStartSchema,
	ToolResultSchema,
	ResultSchema,
	DoneSchema,
	PartRemovedSchema,
	MessageRemovedSchema,
	UserMessageSchema,
]);

export type RelayMessage = typeof RelayMessageSchema.Type;

export const RELAY_MESSAGE_TYPES: ReadonlyArray<RelayMessage["type"]> =
	RelayMessageSchema.members.map((member) => member.fields.type.literal);

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
	/** Published directory default marker; runtime records need not store it. */
	isDefault?: boolean;
	usageEligible?: boolean;
	cursorUsageSource?: "token" | "keychain" | "can_enable" | "unsupported";
	available?: boolean;
	unavailableReason?: string;
	unavailableCode?: "auth_required";
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
	buildId: string;
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
