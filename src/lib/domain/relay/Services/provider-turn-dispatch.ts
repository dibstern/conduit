import { randomUUID } from "node:crypto";
import { Context, Effect, FiberMap, type Ref, Runtime } from "effect";
import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { formatErrorDetail, RelayError } from "../../../errors.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
} from "../../../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../../../persistence/session-history-adapter.js";
import { createRelayEventSink } from "../../../provider/relay-event-sink.js";
import type { SendTurnInput, TurnResult } from "../../../provider/types.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import { PendingSendOwnershipTag } from "./pending-send-ownership.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import type { ProviderTurnServiceSendInput } from "./provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "./services.js";
import {
	clearProcessingTimeout,
	getPermissionMode,
	type OverridesState,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	setModelDefault,
	setPermissionMode,
} from "./session-overrides-state.js";
import { SessionTitleServiceTag } from "./session-title-service.js";

export const CLAUDE_PROVIDER_ID = "claude";
export const OPENCODE_PROVIDER_ID = "opencode";

const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Effect.void,
	requestPermission: () => Effect.succeed({ decision: "once" as const }),
	requestQuestion: () => Effect.succeed({}),
	resolvePermission: () => Effect.void,
	resolveQuestion: () => Effect.void,
};

export class ProviderTurnDispatchFibersTag extends Context.Tag(
	"ProviderTurnDispatchFibers",
)<ProviderTurnDispatchFibersTag, FiberMap.FiberMap<string, void, unknown>>() {}

export class ProviderTurnTimeoutRuntimeTag extends Context.Tag(
	"ProviderTurnTimeoutRuntime",
)<
	ProviderTurnTimeoutRuntimeTag,
	{
		readonly runtime: Runtime.Runtime<OverridesStateTag>;
		readonly overridesRef: Ref.Ref<OverridesState>;
	}
>() {}

export function isProviderTurnInterruptProvider(
	driver: ProviderDriverKind,
): boolean {
	return driver === CLAUDE_PROVIDER_ID;
}

export function isClaudeDriver(driver: ProviderDriverKind): boolean {
	return driver === CLAUDE_PROVIDER_ID;
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

const sendErrorMessage = (
	input: ProviderTurnServiceSendInput,
	message: ReturnType<RelayError["toMessage"]>,
	wsHandler: WebSocketHandlerShape,
) => {
	if (input.errorDelivery === "session") {
		wsHandler.sendToSession(input.sessionId, message);
	} else {
		wsHandler.sendTo(input.clientId, message);
	}
};

const loadClaudeHistory = (sessionId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const result = yield* Effect.either(
			readQuery.getSessionMessagesWithParts(sessionId).pipe(
				Effect.map(
					(rows) =>
						messageRowsToHistory(rows, {
							pageSize: Number.MAX_SAFE_INTEGER,
						}).messages,
				),
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
	readonly messageId?: string;
}) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const persist = yield* ClaudeEventPersistEffectTag;

		const persistResult = yield* Effect.either(
			input.messageId
				? persist.persistUserMessage(input.sessionId, input.text, {
						messageId: input.messageId,
					})
				: persist.persistUserMessage(input.sessionId, input.text),
		);
		const titleService = yield* SessionTitleServiceTag;
		if (input.isFirstClaudeMessage && persistResult._tag === "Right") {
			yield* titleService.startForFirstClaudeMessage({
				sessionId: input.sessionId,
				firstMessage: input.text,
			});
		}
		if (persistResult._tag === "Left") {
			const error = persistResult.left;
			if (error._tag === "ClaudeSessionLifecycleError") {
				log.error(
					`Claude turn persistence rejected by session lifecycle: session=${error.sessionId} operation=${error.operation} role=${error.role} reason=${error.reason}`,
				);
				return yield* error;
			}
			log.warn(
				`Non-fatal persistence error for Claude user message: ${formatErrorDetail(error)}`,
			);
		}
	});

const makeEventSink = (sessionId: string, driver: ProviderDriverKind) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		const { runtime, overridesRef } = yield* ProviderTurnTimeoutRuntimeTag;
		const runTimeout = Runtime.runFork(runtime);
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		if (!isClaudeDriver(driver)) return NOOP_EVENT_SINK;
		return createRelayEventSink({
			sessionId,
			providerId: driver,
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
			applyReportedPermissionMode: (mode) =>
				setPermissionMode(sessionId, mode).pipe(
					Effect.provideService(OverridesStateTag, overridesRef),
				),
			persist,
			ingestion: {
				ingest: (event) =>
					ingestion
						.ingest(event)
						.pipe(
							Effect.mapInputContext((caller: Context.Context<never>) =>
								Context.merge(runtime.context, caller),
							),
						),
			},
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
				cancelSessionInteractions: (reason, options) =>
					pendingInteractionService.cancelSessionInteractions(
						sessionId,
						reason,
						options,
					),
			},
		});
	});

const handleDispatchFailure = (
	input: ProviderTurnServiceSendInput,
	sendErr: unknown,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const ownership = yield* PendingSendOwnershipTag;
		ownership.remove(input.sessionId, input.commandId);
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
			wsHandler,
		);
	});

const handleDispatchResult = (
	input: ProviderTurnServiceSendInput,
	result: TurnResult,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		// The interrupter already sent done; finalizing again can end a newer turn.
		if (result.status === "interrupted" && !result.error) return;

		// Other non-`completed` terminal statuses (error / cancelled / orphaned)
		// must finalize the turn: a completed turn's `done` arrives via the
		// streamed provider events, but these results emit no such stream, so
		// without this the browser stays "processing" until the 2-minute
		// PROCESSING_TIMEOUT. Clear the timeout, broadcast `done`, and surface
		// the reason.
		if (result.status !== "completed") {
			const ownership = yield* PendingSendOwnershipTag;
			ownership.remove(input.sessionId, input.commandId);
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
				wsHandler,
			);
			return;
		}

		if (!result.providerStateUpdates?.length) {
			return;
		}
		const providerState = yield* ProviderStateEffectTag;

		const updates = result.providerStateUpdates.map((update) => ({
			key: update.key,
			value: String(update.value),
		}));
		const saveResult = yield* Effect.either(
			providerState.saveUpdates(input.sessionId, updates),
		);
		if (saveResult._tag === "Left") {
			log.warn(
				`Non-fatal provider state persistence error for ${input.sessionId}: ${formatErrorDetail(saveResult.left)}`,
			);
		}
	});

const resolveClaudeModel = (
	input: ProviderTurnServiceSendInput,
	providerId: string,
	driver: ProviderDriverKind,
) =>
	Effect.gen(function* () {
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const log = yield* LoggerTag;
		const wsHandler = yield* WebSocketHandlerTag;
		let resolvedInput = input;
		if (isClaudeDriver(driver) && input.model === undefined) {
			const discovery = yield* Effect.either(
				orchestrationEngine.dispatchEffect({
					type: "discover",
					providerId,
				}),
			);
			const models =
				discovery._tag === "Right" ? (discovery.right.models ?? []) : [];
			const inferred =
				models.find((model) => model.id === "default") ?? models[0];
			if (inferred === undefined) {
				const ownership = yield* PendingSendOwnershipTag;
				ownership.remove(input.sessionId, input.commandId);
				const reason =
					discovery._tag === "Left"
						? `discovery failed: ${formatErrorDetail(discovery.left)}`
						: "discovery returned no usable model catalog";
				log.error(
					`client=${input.clientId} session=${input.sessionId} Claude model inference failed: ${reason}`,
				);
				yield* clearProcessingTimeout(input.sessionId);
				sendErrorMessage(
					input,
					{
						type: "error",
						code: "MODEL_REQUIRED",
						message: "A Claude model is required, but none could be selected.",
						sessionId: input.sessionId,
					},
					wsHandler,
				);
				wsHandler.sendToSession(input.sessionId, {
					type: "done",
					sessionId: input.sessionId,
					code: 1,
				});
				return undefined;
			}

			const inferredModel = {
				providerID: inferred.providerId,
				modelID: inferred.id,
			};
			yield* setModelDefault(input.sessionId, inferredModel);
			log.info(
				`session=${input.sessionId} inferred provider=${inferred.providerId} model=${inferred.id} reason=no server-side session or default model; inferred from Claude catalog`,
			);
			resolvedInput = {
				...input,
				model: inferredModel,
				modelUserSelected: false,
			};
		}

		return resolvedInput;
	});

const prepareEngineTurnInput = (
	resolvedInput: ProviderTurnServiceSendInput,
	driver: ProviderDriverKind,
	claudeConfigDir: string | undefined,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const priorHistoryResult = isClaudeDriver(driver)
			? yield* loadClaudeHistory(resolvedInput.sessionId)
			: { history: [], loaded: false };
		const priorHistory = priorHistoryResult.history;
		const readQuery = yield* ReadQueryEffectTag;
		const goalRow = isClaudeDriver(driver)
			? yield* readQuery.getSession(resolvedInput.sessionId).pipe(
					Effect.catchAll((cause) =>
						Effect.gen(function* () {
							const log = yield* LoggerTag;
							log.debug(
								`Failed to restore goal for ${resolvedInput.sessionId}: ${cause}`,
							);
							return undefined;
						}),
					),
				)
			: undefined;
		const isFirstClaudeMessage =
			isClaudeDriver(driver) &&
			priorHistoryResult.loaded &&
			priorHistory.length === 0;
		const userMessageId = isClaudeDriver(driver) ? randomUUID() : undefined;

		yield* isClaudeDriver(driver)
			? maybePersistClaudeUserMessage({
					sessionId: resolvedInput.sessionId,
					text: resolvedInput.text,
					isFirstClaudeMessage,
					...(userMessageId ? { messageId: userMessageId } : {}),
				})
			: Effect.void;

		const providerStateEffect = yield* ProviderStateEffectTag;
		const providerState = yield* providerStateEffect.getState(
			resolvedInput.sessionId,
		);
		const eventSink = yield* makeEventSink(resolvedInput.sessionId, driver);
		const imageList =
			resolvedInput.images && resolvedInput.images.length > 0
				? Array.from(resolvedInput.images)
				: undefined;
		// OpenCode keeps its own session model, so we only override it on an
		// explicit pick. The Claude SDK has no such memory: omitting `model`
		// makes it resolve the config dir's settings.json `model` instead, so a
		// session inheriting the global default (or one whose per-session pick
		// was lost to a daemon restart) would silently run a different model
		// than the one conduit displays. Always send what we display.
		const sendModel =
			resolvedInput.model &&
			(resolvedInput.modelUserSelected ||
				(isClaudeDriver(driver) &&
					resolvedInput.model.providerID === CLAUDE_PROVIDER_ID));
		const sendTurnInput: SendTurnInput = {
			sessionId: resolvedInput.sessionId,
			turnId: randomUUID(),
			...(userMessageId ? { userMessageId } : {}),
			prompt: resolvedInput.text,
			history: priorHistory,
			providerState,
			...(sendModel && resolvedInput.model
				? {
						model: {
							providerId: resolvedInput.model.providerID,
							modelId: resolvedInput.model.modelID,
						},
					}
				: {}),
			workspaceRoot: config.projectDir ?? "",
			...(claudeConfigDir === undefined ? {} : { configDir: claudeConfigDir }),
			...(goalRow ? { goalState: sessionGoalState(goalRow) } : {}),
			...(isClaudeDriver(driver)
				? {
						cumulativeTokens: priorHistory.reduce(
							(total, message) =>
								total +
								(message.tokens?.input ?? 0) +
								(message.tokens?.output ?? 0) +
								(message.tokens?.cache?.read ?? 0) +
								(message.tokens?.cache?.write ?? 0),
							0,
						),
					}
				: {}),
			eventSink,
			abortSignal: new AbortController().signal,
			permissionMode: yield* getPermissionMode(resolvedInput.sessionId),
			...(imageList ? { images: imageList } : {}),
			...(resolvedInput.agent ? { agent: resolvedInput.agent } : {}),
			...(resolvedInput.variant ? { variant: resolvedInput.variant } : {}),
			...(resolvedInput.contextWindow
				? { contextWindow: resolvedInput.contextWindow }
				: {}),
		};

		return sendTurnInput;
	});

const dispatchEngineTurn = (
	resolvedInput: ProviderTurnServiceSendInput,
	providerId: string,
	sendTurnInput: SendTurnInput,
) =>
	Effect.gen(function* () {
		const orchestrationEngine = yield* OrchestrationEngineTag;
		const dispatchFibers = yield* ProviderTurnDispatchFibersTag;
		const previousProviderId =
			yield* orchestrationEngine.getProviderForSessionEffect(
				resolvedInput.sessionId,
			);
		const restorePreviousBinding = Effect.sync(() => {
			if (previousProviderId) {
				orchestrationEngine.bindSession(
					resolvedInput.sessionId,
					previousProviderId,
				);
			} else {
				orchestrationEngine.unbindSession(resolvedInput.sessionId);
			}
		});
		yield* Effect.sync(() =>
			orchestrationEngine.bindSession(resolvedInput.sessionId, providerId),
		);

		const dispatchProgram = Effect.try({
			try: () =>
				orchestrationEngine.dispatchEffect({
					type: "send_turn",
					commandId: resolvedInput.commandId,
					providerId,
					input: sendTurnInput,
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatten,
			Effect.flatMap((result) => handleDispatchResult(resolvedInput, result)),
			Effect.catchAll((error) =>
				restorePreviousBinding.pipe(
					Effect.zipRight(handleDispatchFailure(resolvedInput, error)),
				),
			),
			Effect.onInterrupt(() => restorePreviousBinding),
		);
		yield* FiberMap.run(
			dispatchFibers,
			`${resolvedInput.sessionId}:${sendTurnInput.turnId}`,
			dispatchProgram,
		).pipe(Effect.asVoid);
	});

const sendViaEngine = (
	input: ProviderTurnServiceSendInput,
	providerId: string,
	driver: ProviderDriverKind,
	claudeConfigDir: string | undefined,
) =>
	Effect.gen(function* () {
		const resolvedInput = yield* resolveClaudeModel(input, providerId, driver);
		if (!resolvedInput) return;
		const sendTurnInput = yield* prepareEngineTurnInput(
			resolvedInput,
			driver,
			claudeConfigDir,
		);
		yield* dispatchEngineTurn(resolvedInput, providerId, sendTurnInput);
	});

export const sendTurn = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const engine = yield* OrchestrationEngineTag;
		const providerId =
			(yield* engine.getProviderForSessionEffect(input.sessionId)) ??
			(input.model && input.model.providerID === CLAUDE_PROVIDER_ID
				? CLAUDE_PROVIDER_ID
				: OPENCODE_PROVIDER_ID);
		const daemonConfig = loadDaemonConfig(config.configDir);
		const driver = resolveProviderRoutingDriver(daemonConfig, providerId);
		if (driver === undefined) {
			yield* handleDispatchFailure(
				input,
				new Error(
					`Cannot resolve provider instance for turn routing: ${providerId}`,
				),
			);
			return;
		}
		yield* sendViaEngine(
			input,
			providerId,
			driver,
			resolveClaudeInstanceConfigDir(daemonConfig, providerId),
		).pipe(Effect.provideService(OrchestrationEngineTag, engine));
	});
