// src/lib/provider/types.ts
// ─── Provider Adapter Types ─────────────────────────────────────────────────
// Core interface and supporting types for the provider adapter layer.
// Adapters are execution-only — they don't own sessions, messages, or history.
// Conduit owns all state. Adapters turn prompts into event streams.

import type { CanonicalEvent } from "../persistence/events.js";

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
 * - `requestPermission(request)`: emit permission.asked, block until
 *   permission.resolved arrives, return the decision.
 * - `requestQuestion(request)`: emit question.asked, block until
 *   question.resolved arrives, return the answers.
 */
export interface EventSink {
	push(event: CanonicalEvent): Promise<void>;
	requestPermission(request: PermissionRequest): Promise<PermissionResponse>;
	requestQuestion(request: QuestionRequest): Promise<Record<string, unknown>>;
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

export interface TurnError {
	readonly code: string;
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

export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly providerId: string;
	readonly limit?: { context?: number; output?: number };
	readonly variants?: Record<string, Record<string, unknown>>;
}

// ─── History ────────────────────────────────────────────────────────────────

export interface HistoryMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
	readonly parts?: readonly Record<string, unknown>[];
	readonly tokens?: TurnTokens;
	readonly cost?: number;
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
	readonly images?: readonly string[];
	readonly agent?: string;
}

// ─── Command Discovery ─────────────────────────────────────────────────────

export type CommandSource =
	| "builtin"
	| "user-command"
	| "project-command"
	| "user-skill"
	| "project-skill";

export interface CommandInfo {
	readonly name: string;
	readonly description?: string;
	readonly source: CommandSource;
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
	discover(): Promise<AdapterCapabilities>;

	/** Send a user turn to the provider and stream response events via EventSink */
	sendTurn(input: SendTurnInput): Promise<TurnResult>;

	/** Interrupt an in-progress turn */
	interruptTurn(sessionId: string): Promise<void>;

	/** Resolve a pending permission request (from EventSink.requestPermission) */
	resolvePermission(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void>;

	/** Resolve a pending question (from EventSink.requestQuestion) */
	resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Promise<void>;

	/** Graceful shutdown -- clean up connections, abort pending turns */
	shutdown(): Promise<void>;
}
