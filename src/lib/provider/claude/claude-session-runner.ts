import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { Effect } from "effect";
import type { ClaudeSDKPermissionMode } from "../../contracts/providers/claude-agent-sdk.js";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { BackgroundTaskTransition } from "../../session/background-liveness.js";
import type {
	HistoryMessage,
	PermissionDecision,
	PermissionRequest,
	PermissionResponse,
	PreWarmSessionInput,
	QuestionRequest,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import type { MaterializedClaudeSubagent } from "./claude-subagent-materializer.js";

/** Provider-Owned Payload fields contain JSON data, as on the event ingress. */
export type ClaudeSessionTurn = Omit<
	SendTurnInput,
	"eventSink" | "abortSignal"
>;

export type ClaudeSessionCommand =
	| {
			readonly type: "pre-warm";
			readonly sessionId: string;
			readonly input: PreWarmSessionInput;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
	  }
	| {
			readonly type: "send-turn";
			readonly sinkId: string;
			readonly aborted: boolean;
			readonly claudeSettingsOverrides?: Settings | undefined;
			readonly shellEnv?: Readonly<Record<string, string | undefined>>;
			readonly historyOnDemand?: boolean;
			readonly input: ClaudeSessionTurn;
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
			readonly failure: ClaudeSessionFailure;
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
			readonly type: "interrupt" | "end-session" | "shutdown-after-turn";
			readonly sessionId: string;
	  }
	| { readonly type: "abort"; readonly sinkId: string }
	| {
			readonly type: "apply-live-settings";
			readonly sessionId: string;
			readonly settings: {
				readonly modelId?: string | undefined;
				readonly contextWindow?: string | undefined;
				readonly variant?: string | undefined;
			};
	  }
	| {
			readonly type: "set-permission-mode";
			readonly sessionId: string;
			readonly mode: ClaudeSDKPermissionMode;
	  }
	| { readonly type: "shutdown" };

/** Runtime events and the existing EventSink interaction operations, all data. */
export type ClaudeSessionOutput =
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
			| { readonly type: "read-turn-history" }
			| {
					readonly type: "materialize-subagents";
					readonly input: {
						readonly parentConduitSessionId: string;
						readonly parentClaudeSessionId: string;
						readonly workspaceRoot: string;
						readonly knownTasks: ReadonlyArray<
							readonly [
								string,
								{
									readonly toolUseId: string;
									readonly description?: string;
									readonly subagentType?: string;
								},
							]
						>;
					};
			  }
			| {
					readonly type: "ensure-subagent-session";
					readonly input: {
						readonly childSessionId: string;
						readonly parentSessionId: string;
						readonly providerSessionId: string;
						readonly title: string;
					};
			  }
	  ));

/** Plain-data reply to an output operation; events and notifications return {}. */
export interface ClaudeSessionOutputReply {
	readonly children?: readonly MaterializedClaudeSubagent[];
	readonly history?: readonly HistoryMessage[];
}

/** Failure replies preserve the SDK fields used by the side-effect reactor. */
export interface ClaudeSessionFailure {
	readonly operation: string;
	readonly message: string;
	readonly name?: string;
	readonly code?: string | number;
	readonly retryable?: boolean;
}

/** Effects are execution carriers; only command/output/reply data crosses here. */
export interface ClaudeSessionRunner {
	executeEffect(
		command: Extract<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<TurnResult, ClaudeSessionFailure>;
	executeEffect(
		command: Exclude<ClaudeSessionCommand, { type: "send-turn" }>,
	): Effect.Effect<void, ClaudeSessionFailure>;
	executeEffect(
		command: ClaudeSessionCommand,
	): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure>;
}
