// src/lib/provider/claude/types.ts
/**
 * Types used by the Claude Agent SDK adapter.
 *
 * The SDK's `query()` returns a long-lived session: you feed it an
 * AsyncIterable of user messages and read back an AsyncIterable of SDK
 * messages. One `query()` runs for the entire conduit session (not per turn).
 * sendTurn() enqueues into the prompt queue; a background consumer drains
 * the output stream and translates events for EventSink.
 *
 * SDK types are imported from `@anthropic-ai/claude-agent-sdk` and
 * re-exported for convenience. Conduit-specific types (session context,
 * pending approvals, tool tracking, etc.) are defined here.
 */
import type { PermissionDecision } from "../types.js";

// ─── SDK Type Re-exports ──────────────────────────────────────────────────
// Imported from the real Claude Agent SDK and re-exported so that internal
// modules can import from "./types.js" without depending on the SDK directly.

export type {
	CanUseTool,
	Options,
	PermissionMode,
	PermissionResult,
	Query,
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultError,
	SDKResultMessage,
	SDKResultSuccess,
	SDKSystemMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// ─── Prompt Queue ──────────────────────────────────────────────────────────

/**
 * Items placed into the PromptQueue and consumed as an AsyncIterable by
 * the SDK's `query()`. "terminate" ends the iteration and shuts down the
 * SDK session cleanly.
 */
export type PromptQueueItem =
	| { readonly type: "message"; readonly message: SDKUserMessage }
	| { readonly type: "terminate" };

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
 * blocks by awaiting the deferred until the UI calls resolvePermission().
 */
export interface PendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly createdAt: string;
	resolve(decision: PermissionDecision): void;
	reject(error: Error): void;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly createdAt: string;
	resolve(answers: Record<string, unknown>): void;
	reject(error: Error): void;
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
}

// ─── Session Context ───────────────────────────────────────────────────────

/**
 * All state for a single Claude session. Owned by ClaudeAdapter and keyed
 * by conduit sessionId. One instance per live SDK `query()`.
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
	streamConsumer: Promise<void> | undefined;
	currentTurnId: string | undefined;
	currentModel: string | undefined;
	resumeSessionId: string | undefined;
	lastAssistantUuid: string | undefined;
	turnCount: number;
	stopped: boolean;
}

/**
 * Minimal interface the PromptQueue implementation must satisfy. Defined
 * here to decouple ClaudeSessionContext from the concrete class.
 */
export interface PromptQueueController extends AsyncIterable<SDKUserMessage> {
	enqueue(message: SDKUserMessage): void;
	close(): void;
}

// ─── Claude Adapter Config ─────────────────────────────────────────────────

/**
 * Configuration for the Claude adapter.
 */
export interface ClaudeAdapterConfig {
	readonly apiKey?: string;
	readonly model?: string;
	readonly maxTurns?: number;
	readonly workspaceRoot: string;
}
