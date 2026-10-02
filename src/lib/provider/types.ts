// src/lib/provider/types.ts
// Core interface and supporting types for provider execution instances.
// Instances are execution-only — they don't own sessions, messages, or history.
// Conduit owns all state. Instances turn prompts into event streams.

import type { Effect, Scope } from "effect";
import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";
import type {
	ProviderPermissionUpdate,
	SessionPermissionMode,
} from "../shared-types.js";
import type { ProviderInstanceFailure } from "./errors.js";
import type { EventSinkError } from "./event-sink-errors.js";

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionRequest {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerItemId: string;
	readonly always?: string[];
	readonly permissionSuggestions?: readonly ProviderPermissionUpdate[];
	readonly permissionTitle?: string;
	readonly permissionDisplayName?: string;
	readonly permissionDescription?: string;
	/** The provider's own explanation of why it asked, e.g. a safety check
	 *  that fires even in bypass mode. */
	readonly permissionReason?: string;
}

export interface PermissionResponse {
	readonly decision: PermissionDecision;
	readonly permissionUpdates?: readonly ProviderPermissionUpdate[];
}

export interface QuestionRequest {
	readonly requestId: string;
	readonly toolUseId?: string;
	readonly questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect?: boolean;
		custom?: boolean;
	}>;
}

/**
 * EventSink is the provider instance's write interface to conduit's event store.
 *
 * - `push(event)`: ingest a provider runtime event, then append/project
 *   Conduit-owned domain events.
 * - `requestPermission(request)`: Effect that emits permission.asked, waits
 *   until permission.resolved arrives, then returns the decision.
 * - `requestQuestion(request)`: Effect that emits question.asked, waits until
 *   question.resolved arrives, then returns the answers.
 * - `resolvePermission(...)` / `resolveQuestion(...)`: complete the matching
 *   pending request when the UI returns an answer.
 */
export interface EventSink {
	push(event: ProviderRuntimeEvent): Effect.Effect<void, EventSinkError>;
	requestPermission(
		request: PermissionRequest,
	): Effect.Effect<PermissionResponse, EventSinkError>;
	requestQuestion(
		request: QuestionRequest,
	): Effect.Effect<Record<string, unknown>, EventSinkError>;
	resolvePermission(
		requestId: string,
		response: PermissionResponse,
	): Effect.Effect<void, EventSinkError>;
	resolveQuestion(
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, EventSinkError>;
	cancelSessionInteractions?(
		reason: string,
		options?: { readonly recoverQuestions?: boolean },
	): Effect.Effect<void>;
	/**
	 * Relay liveness hook. Providers never call this; the orchestration reactor
	 * calls it for every streamed event so the relay's processing timeout stays
	 * alive on the path where provider output goes straight to ingestion.
	 */
	noteActivity?(): void;
}

export type TurnStatus = "completed" | "error" | "interrupted" | "cancelled";

export interface TurnTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
	readonly contextWindow?: number;
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
	/** Backend-only SDK oracle for the exact model id reported at runtime. */
	readonly resolvedModel?: string;
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

export interface SendTurnInput {
	/** Durable outbox identity, forwarded to a process session runner. */
	readonly commandId?: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly prompt: string;
	readonly history: readonly HistoryMessage[];
	readonly providerState: Readonly<Record<string, unknown>>;
	/**
	 * Optional shared model selection. OpenCode may omit the model from its
	 * provider request. Claude's relay path infers a catalog model, and its
	 * runtime rejects direct model-less dispatches.
	 */
	readonly model?: ModelSelection;
	readonly workspaceRoot: string;
	readonly configDir?: string;
	readonly eventSink: EventSink;
	readonly abortSignal: AbortSignal;
	readonly permissionMode?: SessionPermissionMode;
	readonly variant?: string;
	readonly contextWindow?: string;
	readonly images?: readonly string[];
	readonly agent?: string;
}

/** Launch inputs only: pre-warming never admits a user turn. */
export type PreWarmSessionInput = Pick<
	SendTurnInput,
	| "sessionId"
	| "workspaceRoot"
	| "providerState"
	| "model"
	| "configDir"
	| "permissionMode"
	| "variant"
	| "contextWindow"
	| "agent"
>;

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

export interface ProviderCapabilities {
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

/**
 * ProviderInstance -- the 7-method contract for provider execution.
 *
 * Implementations wrap a provider's REST/SDK surface and translate provider
 * events into provider runtime events via the EventSink. Instances do not own
 * session state, message history, or projections -- conduit does.
 *
 * Compared to t3code's provider instance shape (~12 methods with Effect):
 * - No startSession/stopSession/listSessions -- conduit owns session lifecycle
 * - No readThread/rollbackThread -- conduit reads from its own projections
 * - No streamEvents -- instance pushes via EventSink, no output stream needed
 */
export interface ProviderInstance {
	/** Unique identifier for this provider (e.g. "opencode", "claude") */
	readonly providerId: string;

	/** Query the provider for available models, commands, and capabilities */
	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	>;

	/** Send a user turn to the provider and stream response events via EventSink */
	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure>;

	/** Prepare an idle runtime without sending a prompt, when supported. */
	readonly preWarmSessionEffect?: (
		input: PreWarmSessionInput,
	) => Effect.Effect<void, ProviderInstanceFailure>;

	/** Interrupt an in-progress turn */
	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure>;

	/** Resolve a pending permission request (from EventSink.requestPermission) */
	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure>;

	/** Resolve a pending question (from EventSink.requestQuestion) */
	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure>;

	/**
	 * Push a mid-session model / context-window / effort change onto the live
	 * query, when the provider can apply settings outside a turn.
	 */
	readonly applyLiveSettingsEffect?: (
		sessionId: string,
		settings: {
			readonly modelId?: string | undefined;
			readonly contextWindow?: string | undefined;
			readonly variant?: string | undefined;
		},
	) => Effect.Effect<void, ProviderInstanceFailure>;

	/** Update a live provider query's classifier mode when supported. */
	readonly setPermissionModeEffect?: (
		sessionId: string,
		mode: SessionPermissionMode,
	) => Effect.Effect<void, ProviderInstanceFailure>;

	/** Graceful shutdown -- clean up connections, abort pending turns */
	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure>;

	/**
	 * Terminate the provider's session-level state (SDK query, pending turns,
	 * approvals, queued messages). Idempotent. Does NOT unbind the session
	 * from the provider -- that's a higher-level concern. Next sendTurnEffect()
	 * re-creates state from scratch.
	 */
	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure>;
}

export interface ProviderDriver<Input, R = never, E = never> {
	readonly providerId: string;
	readonly create: (
		input: Input,
	) => Effect.Effect<ProviderInstance, E, R | Scope.Scope>;
}
