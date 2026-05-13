// src/lib/provider/types.ts
// ─── Provider Adapter Types ─────────────────────────────────────────────────
// Core interface and supporting types for the provider adapter layer.
// Adapters are execution-only — they don't own sessions, messages, or history.
// Conduit owns all state. Adapters turn prompts into event streams.

import type { Effect } from "effect";
import type { CanonicalEvent } from "../persistence/events.js";
import type { ProviderAdapterFailure } from "./errors.js";

// ─── Permission / Question Decisions ────────────────────────────────────────

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionRequest {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerItemId: string;
	readonly always?: string[];
}

export interface PermissionResponse {
	readonly decision: PermissionDecision;
}

export interface QuestionRequest {
	readonly requestId: string;
	readonly questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect?: boolean;
		custom?: boolean;
	}>;
}

// ─── Event Sink ─────────────────────────────────────────────────────────────

/**
 * EventSink is the adapter's write interface to conduit's event store.
 *
 * - `push(event)`: append a canonical event to the store and project eagerly.
 * - `requestPermission(request)`: Effect that emits permission.asked, waits
 *   until permission.resolved arrives, then returns the decision.
 * - `requestQuestion(request)`: Effect that emits question.asked, waits until
 *   question.resolved arrives, then returns the answers.
 * - `resolvePermission(...)` / `resolveQuestion(...)`: complete the matching
 *   pending request when the UI returns an answer.
 */
export interface EventSink {
	push(event: CanonicalEvent): Effect.Effect<void, unknown>;
	requestPermission(
		request: PermissionRequest,
	): Effect.Effect<PermissionResponse, unknown>;
	requestQuestion(
		request: QuestionRequest,
	): Effect.Effect<Record<string, unknown>, unknown>;
	resolvePermission(
		requestId: string,
		response: PermissionResponse,
	): Effect.Effect<void, unknown>;
	resolveQuestion(
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, unknown>;
	cancelSessionInteractions?(reason: string): Effect.Effect<void, unknown>;
}

// ─── Turn Types ─────────────────────────────────────────────────────────────

export type TurnStatus = "completed" | "error" | "interrupted" | "cancelled";

export interface TurnTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
}

export type TurnErrorCode =
	| "send_failed"
	| "provider_error"
	| "interrupted"
	| "timeout"
	| "unknown";

export interface TurnError {
	readonly code: TurnErrorCode;
	readonly message: string;
	readonly retryable?: boolean;
}

export interface ProviderStateUpdate {
	readonly key: string;
	readonly value: unknown;
}

export interface TurnResult {
	readonly status: TurnStatus;
	readonly cost: number;
	readonly tokens: TurnTokens;
	readonly durationMs: number;
	readonly error?: TurnError;
	readonly providerStateUpdates: readonly ProviderStateUpdate[];
}

// ─── Model Types ────────────────────────────────────────────────────────────

export interface ModelSelection {
	readonly providerId: string;
	readonly modelId: string;
}

/** A user-selectable context-window option, e.g. 200k vs 1m. */
export interface ContextWindowOption {
	readonly value: string;
	readonly label: string;
	readonly isDefault?: boolean;
}

export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly providerId: string;
	readonly limit?: { context?: number; output?: number };
	readonly variants?: Record<string, Record<string, unknown>>;
	/**
	 * Optional per-model context-window selector entries. When present and
	 * non-empty, the UI renders a dropdown alongside the effort picker. The
	 * entry marked `isDefault: true` is selected when the user has no
	 * persisted override.
	 */
	readonly contextWindowOptions?: readonly ContextWindowOption[];
}

// ─── History ────────────────────────────────────────────────────────────────

export interface HistoryMessage {
	readonly id?: string;
	readonly role: "user" | "assistant";
	readonly content?: string;
	readonly text?: string;
	readonly parts?: readonly Record<string, unknown>[];
	readonly tokens?: unknown;
	readonly cost?: number;
	readonly time?: unknown;
}

// ─── Send Turn Input ────────────────────────────────────────────────────────

export interface SendTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly prompt: string;
	readonly history: readonly HistoryMessage[];
	readonly providerState: Readonly<Record<string, unknown>>;
	/**
	 * Optional model selection. If absent, the provider uses its default.
	 * OpenCodeAdapter skips the model field in the REST call when absent.
	 */
	readonly model?: ModelSelection;
	readonly workspaceRoot: string;
	readonly eventSink: EventSink;
	readonly abortSignal: AbortSignal;
	readonly variant?: string;
	readonly contextWindow?: string;
	readonly images?: readonly string[];
	readonly agent?: string;
}

// ─── Command Discovery ─────────────────────────────────────────────────────

export type CommandSource =
	| "builtin"
	| "user-command"
	| "project-command"
	| "user-skill"
	| "project-skill"
	| "claude-sdk";

export interface CommandInfo {
	readonly name: string;
	readonly description?: string;
	readonly args?: string;
	readonly source: CommandSource;
}

export interface ProviderAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}

// ─── Adapter Capabilities ───────────────────────────────────────────────────

export interface AdapterCapabilities {
	readonly models: readonly ModelInfo[];
	readonly supportsTools: boolean;
	readonly supportsThinking: boolean;
	readonly supportsPermissions: boolean;
	readonly supportsQuestions: boolean;
	readonly supportsAttachments: boolean;
	readonly supportsFork: boolean;
	readonly supportsRevert: boolean;
	readonly commands: readonly CommandInfo[];
	readonly agents?: readonly ProviderAgentInfo[];
}

// ─── Provider Adapter Interface ─────────────────────────────────────────────

/**
 * ProviderAdapter -- the 7-method contract for provider execution.
 *
 * Implementations wrap a provider's REST/SDK surface and translate provider
 * events into canonical events via the EventSink. Adapters do not own session
 * state, message history, or projections -- conduit does.
 *
 * Compared to t3code's ProviderAdapterShape (~12 methods with Effect):
 * - No startSession/stopSession/listSessions -- conduit owns session lifecycle
 * - No readThread/rollbackThread -- conduit reads from its own projections
 * - No streamEvents -- adapter pushes via EventSink, no output stream needed
 */
export interface ProviderAdapter {
	/** Unique identifier for this provider (e.g. "opencode", "claude") */
	readonly providerId: string;

	/** Query the provider for available models, commands, and capabilities */
	discoverEffect(): Effect.Effect<AdapterCapabilities, ProviderAdapterFailure>;

	/** Send a user turn to the provider and stream response events via EventSink */
	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderAdapterFailure>;

	/** Interrupt an in-progress turn */
	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderAdapterFailure>;

	/** Resolve a pending permission request (from EventSink.requestPermission) */
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderAdapterFailure>;

	/** Resolve a pending question (from EventSink.requestQuestion) */
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderAdapterFailure>;

	/** Graceful shutdown -- clean up connections, abort pending turns */
	shutdownEffect(): Effect.Effect<void, ProviderAdapterFailure>;

	/**
	 * Terminate the provider's session-level state (SDK query, pending turns,
	 * approvals, queued messages). Idempotent. Does NOT unbind the session
	 * from the provider -- that's a higher-level concern. Next sendTurnEffect()
	 * re-creates state from scratch.
	 */
	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderAdapterFailure>;
}
