import type { Effect } from "effect";
import type { SessionPermissionMode } from "../../shared-types.js";
import type {
	EventSink,
	PermissionDecision,
	ProviderNativeSession,
	TurnResult,
} from "../types.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionTurn,
} from "./session-runner.js";

export type PayloadFailure = SessionFailure;

export interface LiveSettings {
	readonly modelId?: string | undefined;
	readonly contextWindow?: string | undefined;
	readonly variant?: string | undefined;
	readonly permissionMode?: SessionPermissionMode | undefined;
}

/** Session state belongs to the payload; interaction waiters belong to the host. */
export interface RunnerPayload {
	hasDemandEffect?(sessionId: string): Effect.Effect<boolean>;
	hasActiveTurnsEffect?(sessionId: string): Effect.Effect<boolean>;
	/** A concurrent send is a steer, passed through without host serialization. */
	sendTurn(
		input: SessionTurn,
		sink: EventSink,
		signal: AbortSignal,
	): Effect.Effect<TurnResult, PayloadFailure>;
	interrupt(
		sessionId: string,
		turnIds?: readonly string[],
	): Effect.Effect<void, PayloadFailure>;
	applySettings(
		sessionId: string,
		settings: LiveSettings,
	): Effect.Effect<void, PayloadFailure>;
	endSession(sessionId: string): Effect.Effect<void, PayloadFailure>;

	prepareTurn?(
		command: Extract<SessionCommand, { type: "send-turn" }>,
		sink: EventSink,
	): Effect.Effect<void, PayloadFailure>;
	preWarm?(
		command: Extract<SessionCommand, { type: "pre-warm" }>,
	): Effect.Effect<void, PayloadFailure>;
	stopTask?(
		sessionId: string,
		taskId: string,
	): Effect.Effect<void, PayloadFailure>;
	setPermissionMode?(
		sessionId: string,
		mode: Extract<SessionCommand, { type: "set-permission-mode" }>["mode"],
	): Effect.Effect<void, PayloadFailure>;
	shutdownAfterTurn?(sessionId: string): Effect.Effect<void, PayloadFailure>;
	shutdown?(): Effect.Effect<void, PayloadFailure>;
	/** Legacy SDK bridge controls for interactions not registered on a host sink. */
	resolvePermission?(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, PayloadFailure>;
	resolveQuestion?(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, PayloadFailure>;
	hasPendingSubagentFinalizers?(sessionId: string): boolean;
	getResumeSessionIdEffect?(
		sessionId: string,
	): Effect.Effect<string | null | undefined>;
	getNativeSessionEffect?(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined>;
}
