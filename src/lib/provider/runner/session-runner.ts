import type { Effect, Option, Scope, Stream } from "effect";
import type { Account } from "../../contracts/account.js";
import type { AttachmentRef } from "../../contracts/attachment-ref.js";
import type { AccountSwitchBusy } from "../../contracts/limit-recovery.js";
import type { UsageHarness } from "../../contracts/provider-instance.js";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import type { SessionPermissionMode } from "../../shared-types.js";
import type {
	LegacyRunnerPermissionMode as LegacyPermissionMode,
	LegacyRunnerSettings as Settings,
} from "../claude/claude-runner-snapshot.js";
import type { ClaudeSubagentTranscriptSnapshot } from "../claude/types.js";
import type { CursorCredentialEnvelope } from "../cursor/cursor-credential.js";
import type {
	PermissionDecision,
	PermissionRequest,
	PermissionResponse,
	PreWarmSessionInput,
	ProviderCall,
	ProviderControlCommandStatus,
	ProviderControlContext,
	ProviderNativeSession,
	QuestionRequest,
	ResolvedSendTurnInput,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import type { UsageRead } from "../usage-reader.js";
import type { RunnerSettingsSnapshot } from "./runner-upgrade.js";
import type { SendScope, SendScopes } from "./send-scope.js";

/** Provider-Owned Payload fields contain JSON data, as on the event ingress. */
export type SessionTurn = Omit<
	ResolvedSendTurnInput,
	"eventSink" | "abortSignal" | "awaitIntake" | "reconcileIntake"
>;

/** The outbox keeps refs until replay crosses the provider boundary. */
export type DurableSessionTurn = Omit<
	SendTurnInput,
	"eventSink" | "abortSignal" | "awaitIntake" | "reconcileIntake"
>;

export type SendOrigin =
	| { readonly _tag: "Fresh" }
	| { readonly _tag: "Adopted" };

export interface SendAdmissionRequest {
	readonly origin: SendOrigin;
	readonly sinkId: string;
	readonly input: Pick<DurableSessionTurn, "sessionId" | "inputId"> &
		Partial<Omit<DurableSessionTurn, "images">> & {
			readonly images?: DurableSessionTurn["images"] | SessionTurn["images"];
		};
	/** Changing the sink creates a new send; admission retires the old handle. */
	readonly previous?: SendScope;
	/** Continue work for this provider's already-admitted logical send. */
	readonly retained?: SendScope;
	/** Read current durable completion, after the admission key is claimed. */
	readonly isEnded?: Effect.Effect<boolean, SessionFailure> | undefined;
	readonly refuse?: (
		failure: SessionFailure,
		send: SendScope,
		showFailure: boolean,
	) => Effect.Effect<void, unknown>;
}

/** None means this adopted send already ended; no work was run. */
export type AdmitSend = <A, E, R>(
	request: SendAdmissionRequest,
	work: (send: SendScope) => Effect.Effect<A, E, R>,
) => Effect.Effect<Option.Option<A>, E | SessionFailure, R>;

export type SessionCommand = (
	| {
			readonly type: "pre-warm";
			readonly sessionId: string;
			readonly input: PreWarmSessionInput;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
			readonly shellConfig?: ProviderCall["shellConfig"];
			readonly settingsSnapshot?: RunnerSettingsSnapshot;
	  }
	| {
			readonly type: "send-turn";
			/** Daemon memory snapshot retained until another turn is admitted. */
			readonly autoSettleAfterDays?: number | null | undefined;
			/** Ephemeral launch credentials, excluded from durable command inputs. */
			readonly cursorCredential?: CursorCredentialEnvelope;
			readonly sinkId: string;
			readonly aborted: boolean;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
			readonly shellConfig?: ProviderCall["shellConfig"];
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
) & { readonly call?: ProviderCall; readonly control?: ProviderControlContext };

/** Runtime events and the existing EventSink interaction operations, all data. */
export type SessionOutput =
	| {
			readonly type: "account-usage";
			readonly accountId: string;
			readonly harness: UsageHarness;
			readonly reading: UsageRead;
	  }
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
			| {
					readonly type: "cancel-interaction";
					readonly requestId: string;
					/** Persist provider withdrawal if recovery has no interaction fiber. */
					readonly kind?: "permission" | "question";
			  }
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
						readonly images?: readonly AttachmentRef[];
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
	/** Installed by the provider before recovery or reattachment may admit work. */
	setSendAdmission?(admit: AdmitSend): void;
	/** Shared daemon owner of every admitted send's resources. */
	readonly sendScopes?: SendScopes;
	/** Native work can retain a local send after its intake waiter detaches. */
	retainsSend?(send: SendScope): boolean;
	/** Local runners observe cancellation before an asynchronous setup can resume. */
	abortSend?(send: SendScope): void;
	/** Native turns, prompts, background tasks and finalizers, including after intake. */
	hasDemandEffect?(sessionId: string): Effect.Effect<boolean>;
	/** Release one project's attachment while its started runner remains independent. */
	detachSessionEffect?(sessionId: string): Effect.Effect<void>;
	/** Reattach retained processes when a project's relay is replaced. */
	attachSessionsEffect?(
		sessionIds: readonly string[],
	): Effect.Effect<void, SessionFailure>;
	/** Retains the admitted account before preparation and through native cleanup. */
	withTurnEffect?<
		A,
		E,
		R,
		T extends Pick<SessionTurn, "sessionId" | "inputId" | "account">,
	>(
		input: T,
		sinkId: string,
		work: Effect.Effect<A, E, R>,
		send: SendScope,
	): Effect.Effect<A, E | SessionFailure, R>;
	readonly getControlProcessIdEffect?: (
		sessionId: string,
	) => Effect.Effect<string | undefined>;
	readonly getControlCommandStatusEffect?: (
		sessionId: string,
		control: ProviderControlContext,
	) => Effect.Effect<ProviderControlCommandStatus, SessionFailure>;
	/** Native execution and pending intake, independent of an intake reply. */
	hasActiveTurnsEffect?(sessionId: string): Effect.Effect<boolean>;
	/** Wake inbox drains after native activity ends, even without a stored event. */
	readonly turnEnds?: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
	readonly recoverEffect?: Effect.Effect<void, SessionFailure>;
	/** Only a running cleanup before its grant deadline excludes orphan recovery. */
	readonly ownsRetirementCleanupEffect?: (
		sessionId: string,
		runId: string,
	) => Effect.Effect<boolean>;
	/** Without an ID, includes retired survivors; with one, checks the current owner. */
	hasLiveProcessEffect(
		sessionId: string,
		processId?: string,
	): Effect.Effect<boolean>;
	/** A session refusal also applies before inbox or prompt admission. */
	getSessionFailureEffect?(
		sessionId: string,
	): Effect.Effect<SessionFailure | undefined>;
	getAccountSwitchBlockEffect?(
		sessionId: string,
		account: Account,
	): Effect.Effect<AccountSwitchBusy | undefined>;
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
		send: SendScope,
	): Effect.Effect<TurnResult, SessionFailure>;
	executeEffect(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
		send?: SendScope,
	): Effect.Effect<void, SessionFailure>;
	executeEffect(
		command: SessionCommand,
		send: SendScope,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
}

/** Native child execution owns payload sinks, never daemon send handles. */
export interface NativeSessionRunner extends SessionRunner {
	executeNativeEffect(
		command: SessionCommand,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
}
