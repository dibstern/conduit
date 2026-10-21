import type { Effect } from "effect";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import type {
	LegacyRunnerPermissionMode as LegacyPermissionMode,
	LegacyRunnerSettings as Settings,
} from "../claude/claude-runner-snapshot.js";
import type { ClaudeSubagentTranscriptSnapshot } from "../claude/types.js";
import type { CursorCredential } from "../cursor/sdk-port.js";
import type {
	PermissionDecision,
	PermissionRequest,
	PermissionResponse,
	PreWarmSessionInput,
	ProviderCall,
	ProviderNativeSession,
	QuestionRequest,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import type { RunnerSettingsSnapshot } from "./runner-upgrade.js";

/** Provider-Owned Payload fields contain JSON data, as on the event ingress. */
export type SessionTurn = Omit<
	SendTurnInput,
	"eventSink" | "abortSignal" | "awaitIntake" | "reconcileIntake"
>;

export type SessionCommand = (
	| {
			readonly type: "pre-warm";
			readonly sessionId: string;
			readonly input: PreWarmSessionInput;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
			readonly settingsSnapshot?: RunnerSettingsSnapshot;
	  }
	| {
			readonly type: "send-turn";
			/** Ephemeral launch credentials, excluded from durable command inputs. */
			readonly cursorCredential?: CursorCredential;
			readonly sinkId: string;
			readonly aborted: boolean;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
			readonly input: SessionTurn;
	  }
	| {
			readonly type: "answer-permission";
			readonly sinkId: string;
			readonly requestId: string;
			readonly response: PermissionResponse;
	  }
	| {
			readonly type: "answer-question";
			readonly sinkId: string;
			readonly requestId: string;
			readonly answers: Record<string, unknown>;
	  }
	| {
			readonly type: "interaction-failed";
			readonly sinkId: string;
			readonly requestId: string;
			readonly kind: "permission" | "question";
			readonly failure: SessionFailure;
	  }
	| {
			readonly type: "resolve-permission";
			readonly sessionId: string;
			readonly requestId: string;
			readonly decision: PermissionDecision;
	  }
	| {
			readonly type: "resolve-question";
			readonly sessionId: string;
			readonly requestId: string;
			readonly answers: Record<string, unknown>;
	  }
	| {
			readonly type: "interrupt";
			readonly sessionId: string;
			// No capability flag: runners predating it ignore the field and
			// interrupt session-wide, bounded by the daemon's Stop wait like OpenCode.
			readonly turnIds?: readonly string[];
	  }
	| {
			readonly type: "end-session" | "shutdown-after-turn";
			readonly sessionId: string;
	  }
	| {
			readonly type: "stop-task";
			readonly sessionId: string;
			readonly taskId: string;
	  }
	| { readonly type: "abort"; readonly sinkId: string }
	| {
			readonly type: "apply-live-settings";
			readonly sessionId: string;
			readonly settings: {
				readonly modelId?: string | undefined;
				readonly contextWindow?: string | undefined;
				readonly variant?: string | undefined;
				readonly permissionMode?: SessionPermissionMode | undefined;
			};
	  }
	| {
			readonly type: "set-permission-mode";
			readonly sessionId: string;
			readonly mode: LegacyPermissionMode;
	  }
	| { readonly type: "shutdown" }
) & { readonly call?: ProviderCall };

/** Runtime events and the existing EventSink interaction operations, all data. */
export type SessionOutput =
	| {
			readonly type: "background-task";
			readonly transition: BackgroundTaskTransition;
	  }
	| ({ readonly sinkId: string } & (
			| { readonly type: "event"; readonly event: ProviderRuntimeEvent }
			| {
					readonly type: "permission-request";
					readonly request: PermissionRequest;
			  }
			| { readonly type: "question-request"; readonly request: QuestionRequest }
			| { readonly type: "cancel-interaction"; readonly requestId: string }
			| {
					readonly type: "resolve-permission";
					readonly requestId: string;
					readonly response: PermissionResponse;
			  }
			| {
					readonly type: "resolve-question";
					readonly requestId: string;
					readonly answers: Record<string, unknown>;
			  }
			| {
					readonly type: "cancel-interactions";
					readonly reason: string;
					readonly recoverQuestions: boolean;
			  }
			| { readonly type: "release-sink" }
			| {
					/** Places a send's membership before the query admits it. */
					readonly type: "place-user-message";
					readonly input: {
						readonly sessionId: string;
						readonly inputId: string;
						readonly text: string;
						readonly runId?: string;
						readonly images?: readonly string[];
					};
			  }
			| {
					readonly type: "read-subagent-transcript";
					readonly childSessionId: string;
			  }
			| {
					readonly type: "ensure-subagent-session";
					readonly input: {
						readonly childSessionId: string;
						readonly parentSessionId: string;
						readonly providerSessionId: string;
						readonly title: string;
						readonly instanceId?: string;
						readonly modelId?: string;
					};
			  }
	  ));

/** Plain-data reply to an output operation; events and notifications return {}. */
export interface SessionOutputReply {
	readonly subagentTranscript?: ClaudeSubagentTranscriptSnapshot;
}

/** Failure replies preserve the SDK fields used by the side-effect reactor. */
export interface SessionFailure {
	readonly operation: string;
	readonly message: string;
	readonly name?: string;
	readonly code?: string | number;
	readonly retryable?: boolean;
}

/** Effects are execution carriers; only command/output/reply data crosses here. */
export interface SessionRunner {
	/** Release one project's attachment while its started runner remains independent. */
	detachSessionEffect?(sessionId: string): Effect.Effect<void>;
	/** Reattach retained processes when a project's relay is replaced. */
	attachSessionsEffect?(
		sessionIds: readonly string[],
	): Effect.Effect<void, SessionFailure>;
	/** Retains the admitted account before preparation and through native cleanup. */
	withTurnEffect?<A, E, R>(
		input: SessionTurn,
		sinkId: string,
		work: Effect.Effect<A, E, R>,
	): Effect.Effect<A, E | SessionFailure, R>;
	/** Native execution and pending intake, independent of an intake reply. */
	hasActiveTurnsEffect?(sessionId: string): Effect.Effect<boolean>;
	readonly recoverEffect?: Effect.Effect<void, SessionFailure>;
	/** Without an ID, checks all live processes; with one, checks the current or quarantined owner. */
	hasLiveProcessEffect(
		sessionId: string,
		processId?: string,
	): Effect.Effect<boolean>;
	/** A session refusal also applies before inbox or prompt admission. */
	getSessionFailureEffect?(
		sessionId: string,
	): Effect.Effect<SessionFailure | undefined>;
	/** Local runner lifecycle state, including work outside the foreground turn. */
	hasPendingSubagentFinalizers?(sessionId: string): boolean;
	/** Undefined means no runtime session; null means its cursor is cleared. */
	getResumeSessionIdEffect?(
		sessionId: string,
	): Effect.Effect<string | null | undefined>;
	getNativeSessionEffect?(
		sessionId: string,
	): Effect.Effect<ProviderNativeSession | undefined>;
	executeEffect(
		command: Extract<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, SessionFailure>;
	executeEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, SessionFailure>;
	executeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
}
