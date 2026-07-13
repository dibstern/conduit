import { randomUUID } from "node:crypto";
import {
	Context,
	Deferred,
	Effect,
	type Fiber,
	FiberId,
	FiberMap,
	Layer,
	MutableHashMap,
	Runtime,
} from "effect";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import type { PromptOptions } from "../../../instance/sdk-types.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../../../persistence/session-history-adapter.js";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import {
	createRelayEventSink,
	type RelayEventSinkPersist,
} from "../../../provider/relay-event-sink.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
	SendTurnInput,
	TurnResult,
} from "../../../provider/types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "./provider-runtime-ingestion-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "./session-manager-service.js";
import {
	clearProcessingTimeout,
	type OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	setModel,
} from "./session-overrides-state.js";
import { SessionTitleServiceTag } from "./session-title-service.js";

const CLAUDE_PROVIDER_ID = "claude";
const OPENCODE_PROVIDER_ID = "opencode";

const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Effect.void,
	requestPermission: () => Effect.succeed({ decision: "once" as const }),
	requestQuestion: () => Effect.succeed({}),
	resolvePermission: () => Effect.void,
	resolveQuestion: () => Effect.void,
};

export class ProviderRuntimeIngestionRequired extends Error {
	readonly _tag = "ProviderRuntimeIngestionRequired" as const;

	constructor(readonly sessionId: string) {
		super(
			`ProviderRuntimeIngestion is required for provider output: session=${sessionId}`,
		);
	}
}

const makeProviderRuntimeIngestionRequiredSink = (
	sessionId: string,
): EventSink => {
	const fail = () =>
		Effect.fail(new ProviderRuntimeIngestionRequired(sessionId));
	return {
		push: fail,
		requestPermission: (_request: PermissionRequest) => fail(),
		requestQuestion: (_request: QuestionRequest) => fail(),
		resolvePermission: (_requestId: string, _response: PermissionResponse) =>
			fail(),
		resolveQuestion: (_requestId: string, _answers: Record<string, unknown>) =>
			fail(),
		cancelSessionInteractions: () => Effect.void,
	};
};

// Compatibility constructor support for the old prompt-handler fallback seam.
// Production wiring uses the scoped Layer below so dispatch fibers are
// interrupted with the relay ProviderTurnService scope.
const makeUnsafeFiberMap = <K, A = unknown, E = unknown>(): FiberMap.FiberMap<
	K,
	A,
	E
> =>
	({
		[FiberMap.TypeId]: FiberMap.TypeId,
		deferred: Deferred.unsafeMake<void, E>(FiberId.none),
		state: {
			_tag: "Open",
			backing: MutableHashMap.empty<K, Fiber.RuntimeFiber<A, E>>(),
		},
		[Symbol.iterator](this: {
			state:
				| { readonly _tag: "Closed" }
				| {
						readonly _tag: "Open";
						readonly backing: MutableHashMap.MutableHashMap<
							K,
							Fiber.RuntimeFiber<A, E>
						>;
				  };
		}) {
			if (this.state._tag === "Closed") {
				return [][Symbol.iterator]();
			}
			return this.state.backing[Symbol.iterator]();
		},
	}) as unknown as FiberMap.FiberMap<K, A, E>;

export interface ProviderTurnServiceSendInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly text: string;
	readonly images?: readonly string[];
	readonly model?: {
		readonly providerID: string;
		readonly modelID: string;
	};
	readonly modelUserSelected: boolean;
	readonly agent?: string;
	readonly variant?: string;
	readonly contextWindow?: string;
	readonly errorDelivery?: "client" | "session";
}

export interface ProviderTurnServicePrepareInput {
	readonly clientId: string;
	readonly sessionId: string;
	readonly model?: ProviderTurnServiceSendInput["model"];
	readonly modelUserSelected: boolean;
}

export interface ProviderTurnServiceInterruptInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
}

export interface ProviderTurnService {
	readonly prepareTurnSession: (
		input: ProviderTurnServicePrepareInput,
	) => Effect.Effect<string, unknown, OverridesStateTag>;
	readonly sendTurn: (
		input: ProviderTurnServiceSendInput,
	) => Effect.Effect<void, unknown, OverridesStateTag>;
	readonly interruptTurn: (
		input: ProviderTurnServiceInterruptInput,
	) => Effect.Effect<void, never, OverridesStateTag>;
}

export class ProviderTurnServiceTag extends Context.Tag("ProviderTurnService")<
	ProviderTurnServiceTag,
	ProviderTurnService
>() {}

class ProviderTurnDispatchFibersTag extends Context.Tag(
	"ProviderTurnDispatchFibers",
)<ProviderTurnDispatchFibersTag, FiberMap.FiberMap<string, void, unknown>>() {}

export function isProviderTurnInterruptProvider(providerId: string): boolean {
	return providerId === CLAUDE_PROVIDER_ID;
}

function isClaudeProviderId(providerId: string): boolean {
	return providerId === CLAUDE_PROVIDER_ID;
}

function targetSessionForRelayMessage(
	msg: unknown,
	fallbackSessionId: string,
): string {
	if (msg == null || typeof msg !== "object" || !("sessionId" in msg)) {
		return fallbackSessionId;
	}
	const sessionId = (msg as { readonly sessionId?: unknown }).sessionId;
	return typeof sessionId === "string" && sessionId.length > 0
		? sessionId
		: fallbackSessionId;
}

type PriorHistoryReaders = {
	readQueryEffect?: ReadQueryEffect;
};

function loadPriorHistoryForTurn(
	sessionId: string,
	sessionManagerService: SessionManagerService,
	readers: PriorHistoryReaders,
): Effect.Effect<SendTurnInput["history"], unknown> {
	if (readers.readQueryEffect) {
		return readers.readQueryEffect.getSessionMessagesWithParts(sessionId).pipe(
			Effect.map(
				(rows) =>
					messageRowsToHistory(rows, {
						pageSize: Number.MAX_SAFE_INTEGER,
					}).messages,
			),
		);
	}
	return sessionManagerService
		.loadPreRenderedHistory(sessionId)
		.pipe(Effect.map((history) => history.messages));
}

function buildLegacyPrompt(input: ProviderTurnServiceSendInput): PromptOptions {
	const prompt: PromptOptions = {
		text: input.text,
		...(input.images && input.images.length > 0
			? { images: Array.from(input.images) }
			: {}),
	};
	if (input.agent) prompt.agent = input.agent;
	if (input.model && input.modelUserSelected) prompt.model = input.model;
	if (input.variant) prompt.variant = input.variant;
	return prompt;
}

export const makeProviderTurnService = Effect.gen(function* () {
	const client = yield* OpenCodeAPITag;
	const wsHandler = yield* WebSocketHandlerTag;
	const log = yield* LoggerTag;
	const sessionManagerService = yield* SessionManagerServiceTag;
	const config = yield* ConfigTag;
	const pendingInteractionService = yield* PendingInteractionServiceTag;
	const runtime = yield* Effect.runtime<OverridesStateTag>();
	const runTimeout = Runtime.runFork(runtime);
	const dispatchFibersOption = yield* Effect.serviceOption(
		ProviderTurnDispatchFibersTag,
	);
	const dispatchFibers =
		dispatchFibersOption._tag === "Some"
			? dispatchFibersOption.value
			: makeUnsafeFiberMap<string, void, unknown>();

	const sendErrorMessage = (
		input: ProviderTurnServiceSendInput,
		message: ReturnType<RelayError["toMessage"]>,
	) => {
		if (input.errorDelivery === "session") {
			wsHandler.sendToSession(input.sessionId, message);
		} else {
			wsHandler.sendTo(input.clientId, message);
		}
	};

	const loadClaudeHistory = (sessionId: string) =>
		Effect.gen(function* () {
			const readQueryEffectOption =
				yield* Effect.serviceOption(ReadQueryEffectTag);
			const historyReaders: PriorHistoryReaders = {
				...(readQueryEffectOption._tag === "Some"
					? { readQueryEffect: readQueryEffectOption.value }
					: {}),
			};
			const result = yield* Effect.either(
				loadPriorHistoryForTurn(
					sessionId,
					sessionManagerService,
					historyReaders,
				),
			);
			if (result._tag === "Right") {
				return { history: result.right, loaded: true };
			}
			log.warn(
				`Failed to load prior Claude history for ${sessionId}: ${
					result.left instanceof Error ? result.left.message : result.left
				}`,
			);
			return { history: [], loaded: false };
		});

	const maybePersistClaudeUserMessage = (input: {
		readonly sessionId: string;
		readonly text: string;
		readonly isFirstClaudeMessage: boolean;
	}) =>
		Effect.gen(function* () {
			const claudeEventPersistEffectOption = yield* Effect.serviceOption(
				ClaudeEventPersistEffectTag,
			);
			if (claudeEventPersistEffectOption._tag === "None") return;

			const persistResult = yield* Effect.either(
				claudeEventPersistEffectOption.value.persistUserMessage(
					input.sessionId,
					input.text,
				),
			);
			const titleServiceOption = yield* Effect.serviceOption(
				SessionTitleServiceTag,
			);
			if (
				input.isFirstClaudeMessage &&
				titleServiceOption._tag === "Some" &&
				persistResult._tag === "Right"
			) {
				yield* titleServiceOption.value.startForFirstClaudeMessage({
					sessionId: input.sessionId,
					firstMessage: input.text,
				});
			}
			if (persistResult._tag === "Left") {
				log.warn(
					`Non-fatal persistence error for Claude user message: ${formatErrorDetail(persistResult.left)}`,
				);
			}
		});

	const makeEventSink = (
		sessionId: string,
		providerId: string,
		persist: ClaudeEventPersistEffect | undefined,
		ingestion: ProviderRuntimeIngestion | undefined,
	): SendTurnInput["eventSink"] => {
		if (!isClaudeProviderId(providerId)) return NOOP_EVENT_SINK;
		if (!ingestion) return makeProviderRuntimeIngestionRequiredSink(sessionId);
		let eventSinkPersist: RelayEventSinkPersist | undefined;
		if (persist) eventSinkPersist = persist;
		return createRelayEventSink({
			sessionId,
			providerId,
			send: (msg) =>
				wsHandler.sendToSession(
					targetSessionForRelayMessage(msg, sessionId),
					msg,
				),
			clearTimeout: () => {
				runTimeout(clearProcessingTimeout(sessionId));
			},
			resetTimeout: () => {
				runTimeout(
					resetProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION),
				);
			},
			...(eventSinkPersist ? { persist: eventSinkPersist } : {}),
			...(ingestion ? { ingestion } : {}),
			pendingInteractions: {
				beginPermissionRequest: (request) =>
					pendingInteractionService.beginPermissionRequest(request),
				resolvePermissionRequest: (requestId, response) =>
					pendingInteractionService.resolvePermissionRequest(
						requestId,
						response,
					),
				beginQuestionRequest: (request) =>
					pendingInteractionService.beginQuestionRequest(request),
				resolveQuestionRequest: (requestId, answers) =>
					pendingInteractionService.resolveQuestionRequest(requestId, answers),
				cancelSessionInteractions: (reason) =>
					pendingInteractionService.cancelSessionInteractions(
						sessionId,
						reason,
					),
			},
		});
	};

	const handleDispatchFailure = (
		input: ProviderTurnServiceSendInput,
		sendErr: unknown,
	) =>
		Effect.gen(function* () {
			log.warn(
				`client=${input.clientId} session=${input.sessionId} Failed to send message:`,
				formatErrorDetail(sendErr),
			);
			yield* clearProcessingTimeout(input.sessionId);
			wsHandler.sendToSession(input.sessionId, {
				type: "done",
				sessionId: input.sessionId,
				code: 1,
			});
			sendErrorMessage(
				input,
				RelayError.fromCaught(
					sendErr,
					"SEND_FAILED",
					"Failed to send message",
				).toMessage(input.sessionId),
			);
		});

	const handleDispatchResult = (
		input: ProviderTurnServiceSendInput,
		result: TurnResult,
	) =>
		Effect.gen(function* () {
			// Any non-`completed` terminal status (error / interrupted / cancelled)
			// must finalize the turn: a completed turn's `done` arrives via the
			// streamed provider events, but these results emit no such stream, so
			// without this the browser stays "processing" until the 2-minute
			// PROCESSING_TIMEOUT. Clear the timeout, broadcast `done`, and surface
			// the reason.
			if (result.status !== "completed") {
				const msg =
					result.error?.message ??
					(result.status === "error" ? "Send failed" : `Turn ${result.status}`);
				log.warn(
					`client=${input.clientId} session=${input.sessionId} engine dispatch ${result.status}: ${msg}`,
				);
				yield* clearProcessingTimeout(input.sessionId);
				wsHandler.sendToSession(input.sessionId, {
					type: "done",
					sessionId: input.sessionId,
					code: 1,
				});
				sendErrorMessage(
					input,
					new RelayError(msg, {
						code: "SEND_FAILED",
					}).toMessage(input.sessionId),
				);
				return;
			}

			if (!result.providerStateUpdates?.length) {
				return;
			}
			const providerStateEffectOption = yield* Effect.serviceOption(
				ProviderStateEffectTag,
			);
			if (providerStateEffectOption._tag === "None") return;

			const updates = result.providerStateUpdates.map((update) => ({
				key: update.key,
				value: String(update.value),
			}));
			const saveResult = yield* Effect.either(
				providerStateEffectOption.value.saveUpdates(input.sessionId, updates),
			);
			if (saveResult._tag === "Left") {
				log.warn(
					`Non-fatal provider state persistence error for ${input.sessionId}: ${formatErrorDetail(saveResult.left)}`,
				);
			}
		});

	const sendViaEngine = (
		input: ProviderTurnServiceSendInput,
		providerId: string,
		orchestrationEngine: OrchestrationEngine,
	) =>
		Effect.gen(function* () {
			const priorHistoryResult = isClaudeProviderId(providerId)
				? yield* loadClaudeHistory(input.sessionId)
				: { history: [], loaded: false };
			const priorHistory = priorHistoryResult.history;
			const isFirstClaudeMessage =
				isClaudeProviderId(providerId) &&
				priorHistoryResult.loaded &&
				priorHistory.length === 0;

			yield* isClaudeProviderId(providerId)
				? maybePersistClaudeUserMessage({
						sessionId: input.sessionId,
						text: input.text,
						isFirstClaudeMessage,
					})
				: Effect.void;

			const claudeEventPersistEffectOption = yield* Effect.serviceOption(
				ClaudeEventPersistEffectTag,
			);
			const providerRuntimeIngestionOption = yield* Effect.serviceOption(
				ProviderRuntimeIngestionTag,
			);
			const providerStateEffectOption = yield* Effect.serviceOption(
				ProviderStateEffectTag,
			);
			const providerState =
				providerStateEffectOption._tag === "Some"
					? yield* providerStateEffectOption.value.getState(input.sessionId)
					: {};
			const eventSink = makeEventSink(
				input.sessionId,
				providerId,
				claudeEventPersistEffectOption._tag === "Some"
					? claudeEventPersistEffectOption.value
					: undefined,
				providerRuntimeIngestionOption._tag === "Some"
					? providerRuntimeIngestionOption.value
					: undefined,
			);
			const imageList =
				input.images && input.images.length > 0
					? Array.from(input.images)
					: undefined;
			const sendTurnInput: SendTurnInput = {
				sessionId: input.sessionId,
				turnId: randomUUID(),
				prompt: input.text,
				history: priorHistory,
				providerState,
				...(input.model && input.modelUserSelected
					? {
							model: {
								providerId: input.model.providerID,
								modelId: input.model.modelID,
							},
						}
					: {}),
				workspaceRoot: config.projectDir ?? "",
				eventSink,
				abortSignal: new AbortController().signal,
				...(imageList ? { images: imageList } : {}),
				...(input.agent ? { agent: input.agent } : {}),
				...(input.variant ? { variant: input.variant } : {}),
				...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
			};

			const previousProviderId = orchestrationEngine.getProviderForSession(
				input.sessionId,
			);
			const restorePreviousBinding = Effect.sync(() => {
				if (previousProviderId) {
					orchestrationEngine.bindSession(input.sessionId, previousProviderId);
				} else {
					orchestrationEngine.unbindSession(input.sessionId);
				}
			});
			yield* Effect.sync(() =>
				orchestrationEngine.bindSession(input.sessionId, providerId),
			);

			const dispatchProgram = Effect.try({
				try: () =>
					orchestrationEngine.dispatchEffect({
						type: "send_turn",
						commandId: input.commandId,
						providerId,
						input: sendTurnInput,
					}),
				catch: (cause) => cause,
			}).pipe(
				Effect.flatten,
				Effect.flatMap((result) => handleDispatchResult(input, result)),
				Effect.catchAll((error) =>
					restorePreviousBinding.pipe(
						Effect.zipRight(handleDispatchFailure(input, error)),
					),
				),
				Effect.onInterrupt(() => restorePreviousBinding),
			);
			yield* FiberMap.run(
				dispatchFibers,
				`${input.sessionId}:${sendTurnInput.turnId}`,
				dispatchProgram,
			).pipe(Effect.asVoid);
		});

	const prepareTurnSession = (input: ProviderTurnServicePrepareInput) =>
		Effect.gen(function* () {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None") return input.sessionId;

			const orchestrationEngine = engineOption.value;
			const providerId =
				orchestrationEngine.getProviderForSession(input.sessionId) ??
				(input.model && isClaudeProviderId(input.model.providerID)
					? CLAUDE_PROVIDER_ID
					: OPENCODE_PROVIDER_ID);
			if (isClaudeProviderId(providerId)) return input.sessionId;

			const readQueryEffectOption =
				yield* Effect.serviceOption(ReadQueryEffectTag);
			if (readQueryEffectOption._tag === "None") return input.sessionId;

			const rowResult = yield* Effect.either(
				readQueryEffectOption.value.getSession(input.sessionId),
			);
			if (rowResult._tag === "Left") {
				log.warn(
					`Could not inspect session provider before OpenCode dispatch for ${input.sessionId}: ${formatErrorDetail(rowResult.left)}`,
				);
				return input.sessionId;
			}

			const row = rowResult.right;
			if (!row || row.provider === OPENCODE_PROVIDER_ID) {
				return input.sessionId;
			}

			const targetProvider = input.model?.providerID ?? providerId;
			const session = yield* sessionManagerService.createSession(row.title, {
				providerId: targetProvider,
			});
			if (input.model && input.modelUserSelected) {
				yield* setModel(session.id, input.model);
			}
			orchestrationEngine.bindSession(session.id, OPENCODE_PROVIDER_ID);
			wsHandler.setClientSession(input.clientId, session.id);
			wsHandler.sendTo(input.clientId, {
				type: "session_switched",
				id: session.id,
				sessionId: session.id,
			});
			yield* Effect.forkDaemon(
				sessionManagerService
					.sendDualSessionLists((msg) => wsHandler.broadcast(msg))
					.pipe(
						Effect.catchAll((err) =>
							Effect.sync(() =>
								log.warn(
									`Failed to broadcast session list after OpenCode materialization: ${err}`,
								),
							),
						),
					),
			);
			log.info(
				`client=${input.clientId} materialized OpenCode session ${session.id} from local session ${input.sessionId}`,
			);
			return session.id;
		});

	const sendTurn = (input: ProviderTurnServiceSendInput) =>
		Effect.gen(function* () {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const providerId =
					engineOption.value.getProviderForSession(input.sessionId) ??
					(input.model && isClaudeProviderId(input.model.providerID)
						? CLAUDE_PROVIDER_ID
						: OPENCODE_PROVIDER_ID);
				yield* sendViaEngine(input, providerId, engineOption.value);
				return;
			}

			const sendResult = yield* Effect.either(
				Effect.tryPromise(() =>
					client.session.prompt(input.sessionId, buildLegacyPrompt(input)),
				),
			);
			if (sendResult._tag === "Left") {
				yield* handleDispatchFailure(input, sendResult.left);
			}
		});

	const interruptLegacyTurn = (input: ProviderTurnServiceInterruptInput) =>
		Effect.gen(function* () {
			const abortResult = yield* Effect.either(
				Effect.tryPromise(() => client.session.abort(input.sessionId)),
			);
			if (abortResult._tag === "Left") {
				log.warn(
					`client=${input.clientId} session=${input.sessionId} Abort failed:`,
					formatErrorDetail(abortResult.left),
				);
			}
			wsHandler.sendToSession(input.sessionId, {
				type: "done",
				sessionId: input.sessionId,
				code: 1,
			});
		});

	const interruptTurn = (input: ProviderTurnServiceInterruptInput) =>
		Effect.gen(function* () {
			log.info(`client=${input.clientId} session=${input.sessionId} Aborting`);
			yield* clearProcessingTimeout(input.sessionId);

			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None") {
				yield* interruptLegacyTurn(input);
				return;
			}

			const providerId = engineOption.value.getProviderForSession(
				input.sessionId,
			);
			if (!providerId || !isProviderTurnInterruptProvider(providerId)) {
				yield* interruptLegacyTurn(input);
				return;
			}

			const interruptResult = yield* Effect.either(
				engineOption.value.dispatchEffect({
					type: "interrupt_turn",
					commandId: input.commandId,
					sessionId: input.sessionId,
				}),
			);
			if (interruptResult._tag === "Left") {
				log.warn(
					`client=${input.clientId} session=${input.sessionId} engine interrupt_turn failed:`,
					formatErrorDetail(interruptResult.left),
				);
			}
			wsHandler.sendToSession(input.sessionId, {
				type: "done",
				sessionId: input.sessionId,
				code: 1,
			});
		});

	return {
		prepareTurnSession,
		sendTurn,
		interruptTurn,
	} satisfies ProviderTurnService;
});

const ProviderTurnDispatchFibersLive = Layer.scoped(
	ProviderTurnDispatchFibersTag,
	FiberMap.make<string, void, unknown>(),
);

export const ProviderTurnServiceLive: Layer.Layer<
	ProviderTurnServiceTag,
	never,
	| OpenCodeAPITag
	| WebSocketHandlerTag
	| LoggerTag
	| ConfigTag
	| SessionManagerServiceTag
	| PendingInteractionServiceTag
	| OverridesStateTag
> = Layer.effect(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
