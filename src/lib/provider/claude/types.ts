// src/lib/provider/claude/types.ts
/**
 * Types used by the Claude Agent SDK provider instance.
 *
 * The SDK's `query()` returns a long-lived session: you feed it an
 * AsyncIterable of user messages and read back an AsyncIterable of SDK
 * messages. One `query()` runs for the entire conduit session (not per turn).
 * sendTurnEffect() enqueues into the prompt queue; a background consumer drains
 * the output stream and translates events for EventSink.
 *
 * SDK types are imported from `@anthropic-ai/claude-agent-sdk` and
 * re-exported for convenience. Conduit-specific types (session context,
 * pending approvals, tool tracking, etc.) are defined here.
 */

import type { Effect } from "effect";
import type { EventSink, PermissionDecision } from "../types.js";
import type { ClaudeSubagentTranscriptCursor } from "./claude-subagent-materializer.js";

// ─── SDK Type Re-exports ──────────────────────────────────────────────────
// Imported from the real Claude Agent SDK and re-exported so that internal
// modules can import from "./types.js" without depending on the SDK directly.

export type {
	CanUseTool,
	Options,
	PermissionMode,
	PermissionResult,
	PermissionUpdate,
	PermissionUpdateDestination,
	Query,
	SDKAPIRetryMessage,
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultError,
	SDKResultMessage,
	SDKResultSuccess,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKTaskProgressMessage,
	SDKUserMessage,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
	Query,
	SDKPartialAssistantMessage,
	SDKUserMessage,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

// ─── Stream Event Type ──────────────────────────────────────────────────
// BetaRawMessageStreamEvent is not directly exported by the SDK, but we
// can extract it from SDKPartialAssistantMessage. This is a discriminated
// union with type: 'message_start' | 'message_delta' | 'message_stop' |
// 'content_block_start' | 'content_block_delta' | 'content_block_stop'.
// The SDK's typings omit the SSE keepalive `ping` event, but the runtime
// passes it through (observed live 2026-07-15); widen so handlers can ignore
// it explicitly instead of failing decode.
export type StreamEvent =
	| SDKPartialAssistantMessage["event"]
	| { readonly type: "ping" };

// ─── System Message Subtypes ────────────────────────────────────────────
// Multiple SDK types share `type: 'system'` but differ in `subtype`.
// When `translate()` switches on `message.type === 'system'`, TypeScript
// narrows to this union. Further narrowing on `subtype` is done inside
// `translateSystem()`.
export type SDKSystemLike = Extract<
	import("@anthropic-ai/claude-agent-sdk").SDKMessage,
	{ type: "system" }
>;

// ─── Resume Cursor ─────────────────────────────────────────────────────────

/**
 * Stored in a session's `provider_state` under the `claude` namespace.
 * Written on every turn completion, read on session reopen to resume the
 * SDK session in place.
 */
export interface ClaudeResumeCursor {
	readonly resumeSessionId?: string;
	readonly lastAssistantUuid?: string;
	readonly turnCount: number;
}

// ─── Pending Approval / Question ───────────────────────────────────────────

/**
 * An in-flight `canUseTool` callback waiting for a user decision. The
 * permission bridge creates one, emits permission.asked via EventSink, and
 * blocks by awaiting the EventSink Effect until the UI calls resolvePermission().
 */
export interface PendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly createdAt: string;
	resolve(decision: PermissionDecision): Effect.Effect<void, unknown>;
	reject(error: Error): Effect.Effect<void, unknown>;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly createdAt: string;
	resolve(answers: Record<string, unknown>): Effect.Effect<void, unknown>;
	reject(error: Error): Effect.Effect<void, unknown>;
}

// ─── Tool In Flight ────────────────────────────────────────────────────────

/**
 * Tracks a tool_use content block while it streams so that tool.running
 * events can be emitted as input_json deltas arrive.
 */
export interface ToolInFlight {
	readonly itemId: string;
	readonly toolName: string;
	readonly title: string;
	input: Record<string, unknown>;
	partialInputJson: string;
	lastEmittedFingerprint?: string;
	/** Phase 2: tool_use blocks buffer until content_block_stop. */
	pendingStart?: boolean;
	/** Phase 2: accumulated parsed input from input_json_delta. */
	bufferedInput?: Record<string, unknown>;
}

export interface ClaudeSubagentTaskContext {
	readonly toolUseId: string;
	readonly childSessionId?: string;
	readonly parentMessageId?: string;
	readonly description?: string;
	readonly subagentType?: string;
}

export interface ClaudeSubagentLivePoller {
	readonly sdkSubagentId: string;
	readonly childSessionId: string;
	readonly parentClaudeSessionId: string;
	readonly parentToolUseId: string;
	readonly cursor: ClaudeSubagentTranscriptCursor;
	sessionReady: boolean;
	active: boolean;
}

// ─── Session Context ───────────────────────────────────────────────────────

/**
 * Per-session Claude state keyed by conduit sessionId. The Effect-owned Claude
 * provider runtime stores these contexts and owns the SDK stream fibers.
 */
export interface ClaudeSessionContext {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly startedAt: string;
	readonly promptQueue: PromptQueueController;
	readonly query: Query;
	readonly pendingApprovals: Map<string, PendingApproval>;
	readonly pendingQuestions: Map<string, PendingQuestion>;
	readonly inFlightTools: Map<number, ToolInFlight>;
	readonly subagentTasks?: Map<string, ClaudeSubagentTaskContext>;
	readonly subagentPollers?: Map<string, ClaudeSubagentLivePoller>;
	readonly pendingSubagentMessages?: Map<string, SessionMessage[]>;
	/** EventSink for this session — updated on each turn (latest sink wins). */
	eventSink: EventSink | undefined;
	currentTurnId: string | undefined;
	currentModel: string | undefined;
	currentApiModelId?: string;
	currentAgent?: string;
	resumeSessionId: string | undefined;
	lastAssistantUuid: string | undefined;
	turnCount: number;
	stopped: boolean;
	/** Set when a user prompt is enqueued while the SDK's streaming turn is
	 *  still open (no `result` arrives between queued sends). The next
	 *  message_start then starts a fresh assistant message instead of merging
	 *  the reply into the previous turn's message. */
	pendingAssistantBoundary?: boolean;
}

/**
 * Minimal interface the PromptQueue implementation must satisfy. Defined
 * here to decouple ClaudeSessionContext from the concrete class.
 */
export interface PromptQueueController extends AsyncIterable<SDKUserMessage> {
	enqueue(message: SDKUserMessage): Effect.Effect<void>;
	close(): Effect.Effect<void>;
}
