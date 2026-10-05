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
import type { ClaudeSDKCommandLifecycleMessage } from "../../contracts/providers/claude-agent-sdk.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import type { ClaudeAdapterError } from "../event-sink-errors.js";
import type { EventSink, PermissionDecision } from "../types.js";
import type { ClaudeGoalTracker } from "./claude-goal-tracker.js";
import type { ClaudeSubagentTranscriptCursor } from "./claude-subagent-materializer.js";

// Imported from the real Claude Agent SDK and re-exported so that internal
// modules can import from "./types.js" without depending on the SDK directly.

export type {
	CanUseTool,
	Options,
	PermissionMode,
	PermissionResult,
	PermissionUpdate,
	PermissionUpdateDestination,
	SDKAPIRetryMessage,
	SDKAssistantMessage,
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
	SDKActiveGoalMessage,
	SDKPartialAssistantMessage,
	Query as SDKQuery,
	SDKMessage as SDKStreamMessage,
	SDKUserMessage,
	SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

// active_goal is declared by the SDK separately from its iterator's union.
// Accept it if a future CLI forwards this currently internal envelope.
// command_lifecycle is emitted by the CLI but not yet declared by the SDK.
export type SDKMessage =
	| SDKStreamMessage
	| SDKActiveGoalMessage
	| ClaudeSDKCommandLifecycleMessage;

// Keep SDK query controls while allowing the wire vocabulary accepted above.
export type Query = Omit<
	SDKQuery,
	keyof AsyncGenerator<SDKStreamMessage, void, unknown>
> &
	AsyncGenerator<SDKMessage, void, unknown>;

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

// Multiple SDK types share `type: 'system'` but differ in `subtype`.
// When `translate()` switches on `message.type === 'system'`, TypeScript
// narrows to this union. Further narrowing on `subtype` is done inside
// `translateSystem()`.
export type SDKSystemLike = Extract<
	import("@anthropic-ai/claude-agent-sdk").SDKMessage,
	{ type: "system" }
>;

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

/**
 * An in-flight `canUseTool` callback waiting for a user decision.
 * ClaudePermissionService creates one and blocks on the event sink's
 * requestPermission(), which records permission.asked, waits for the UI to
 * call resolvePermission(), and records permission.resolved however the wait
 * ends.
 */
export interface PendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly createdAt: string;
	resolve(
		decision: PermissionDecision,
	): Effect.Effect<void, ClaudeAdapterError>;
	reject(error: Error): Effect.Effect<void, ClaudeAdapterError>;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly createdAt: string;
	resolve(
		answers: Record<string, unknown>,
	): Effect.Effect<void, ClaudeAdapterError>;
	reject(error: Error): Effect.Effect<void, ClaudeAdapterError>;
}

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
	/** Tool_use blocks buffer until content_block_stop. */
	pendingStart?: boolean;
	/** Accumulated parsed input from input_json_delta. */
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

/**
 * Per-session Claude state keyed by conduit sessionId. The Effect-owned Claude
 * provider runtime stores these contexts and owns the SDK stream fibers.
 */
export interface ClaudeSessionContext {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	goalTracker?: ClaudeGoalTracker;
	cumulativeTokens?: number;
	readonly startedAt: string;
	readonly promptQueue: PromptQueueController;
	readonly query: Query;
	/** Claude config directory selected when this SDK query was created. */
	readonly configDir?: string;
	/** Serializes turn admission while each caller awaits the prior turn.
	 *  Runtime-owned contexts always set this; translator-only test contexts may omit it. */
	readonly turnAdmissionSemaphore?: Effect.Semaphore;
	readonly pendingApprovals: Map<string, PendingApproval>;
	readonly pendingQuestions: Map<string, PendingQuestion>;
	readonly inFlightTools: Map<number, ToolInFlight>;
	readonly subagentTasks?: Map<string, ClaudeSubagentTaskContext>;
	readonly subagentPollers?: Map<string, ClaudeSubagentLivePoller>;
	readonly pendingSubagentMessages?: Map<string, SessionMessage[]>;
	/** EventSink for this session — updated on each turn (latest sink wins). */
	eventSink: EventSink | undefined;
	currentTurnId: string | undefined;
	/** True from prompt submit until a terminal turn message. The SDK's
	 *  system/init reports idle to clear a busy status stranded by a crash
	 *  mid-turn, but it arrives ~1s AFTER the prompt starts — so it needs to
	 *  know whether a turn is actually running. currentTurnId cannot answer
	 *  that: it is set at submit and never cleared. */
	turnInFlight?: boolean;
	/** Conduit's requested catalog/base model id for the current turn. */
	currentModel: string | undefined;
	/** Exact model id sent to the Claude SDK after context-window normalization. */
	currentApiModelId?: string;
	/** Oracle-normalized model id expected from the SDK's system/init report. */
	expectedApiModelId?: string;
	/** Last model id reported as actually serving this session, so a mid-session
	 *  switch re-reports instead of leaving the creation-time model standing. */
	reportedApiModelId?: string;
	/** Last permission mode the SDK reported for this session. The SDK owns the
	 *  live mode, so this -- not conduit's stored request -- is what conduit has
	 *  been told is in force. Undefined until the first system/init lands, which
	 *  is why the first report always fires. */
	reportedPermissionMode?: SessionPermissionMode;
	currentAgent?: string;
	/** Reasoning effort in force on the live query. Undefined means SDK default. */
	currentVariant?: string;
	/** A prior admission may have partially mutated the SDK query. The next
	 *  admission must re-apply both model and effort before enqueueing. */
	settingsOutOfSync?: boolean;
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
	enqueue(message: SDKUserMessage): Effect.Effect<void>;
	close(): Effect.Effect<void>;
}
