import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { createRelayEventSink } from "../../../provider/relay-event-sink.js";
import type { SendTurnInput, TurnResult } from "../../../provider/types.js";
import { publishAlert } from "./alerts.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import { PendingSendOwnershipTag } from "./pending-send-ownership.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import type { ProviderTurnServiceSendInput } from "./provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import { inferSessionModel } from "./session-model-settings.js";
import {
	clearProcessingTimeout,
	getPermissionMode,
	type OverridesState,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	setPermissionMode,
} from "./session-overrides-state.js";
import { SessionTitleServiceTag } from "./session-title-service.js";
import { makeFailTurn } from "./turn-failure.js";

export const CLAUDE_PROVIDER_ID = "claude";
export const OPENCODE_PROVIDER_ID = "opencode";

/** Recheck saved folders at launch, shared by sends and speculative warming. */
export const resolveProjectLaunchFolders = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const workspaceRoot = config.projectDir;
		if (!existsSync(workspaceRoot))
			return yield* Effect.fail(
				new RelayError(`Main project folder does not exist: ${workspaceRoot}`, {
					code: "FILE_NOT_FOUND",
				}),
			);
		const extraFolders: string[] = [];
		for (const folder of config.extraFolders ?? []) {
			if (existsSync(folder)) extraFolders.push(folder);
			else {
				// Not the turn's failure: the launch goes on without the folder, so
				// the user is warned rather than shown a failed turn.
				const message = `Extra folder "${folder}" does not exist and was skipped.`;
				const log = yield* LoggerTag;
				log.warn(`session=${sessionId} ${message}`);
				yield* publishAlert({
					_tag: "alert",
					kind: "warning",
					alertId: randomUUID(),
					sessionId,
					message,
				});
			}
		}
		return { workspaceRoot, extraFolders };
	});

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

const loadClaudeHistoryMetadata = (sessionId: string) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const result = yield* Effect.either(
			readQuery.getSessionHistoryMetadata(sessionId),
		);
		if (result._tag === "Right") {
			return result.right;
		}
		log.warn(
			`Failed to load prior Claude history metadata for ${sessionId}: ${
				result.left instanceof Error ? result.left.message : result.left
			}`,
		);
		return undefined;
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
	recordedByProvider = false,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const ownership = yield* PendingSendOwnershipTag;
		const failTurn = yield* makeFailTurn;
		ownership.remove(input.sessionId, input.commandId);
		log.warn(
			`client=${input.clientId} session=${input.sessionId} Failed to send message:`,
			formatErrorDetail(sendErr),
		);
		yield* clearProcessingTimeout(input.sessionId);
		if (recordedByProvider) return;
		const error = RelayError.fromCaught(
			sendErr,
			"SEND_FAILED",
			"Failed to send message",
		);
		yield* failTurn(input.sessionId, error.message, error.code);
	});

const handleDispatchResult = (
	input: ProviderTurnServiceSendInput,
	result: TurnResult,
	recordedByProvider: boolean,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		// The interrupter already sent done; finalizing again can end a newer turn.
		if (result.status === "interrupted" && !result.error) return;

		// Other non-`completed` terminal statuses (error / cancelled / orphaned)
		// must finalize the turn: a completed turn's `done` arrives via the
		// streamed provider events. A provider that streamed its own turn.error
		// already sent the failed `done`; otherwise the browser would stay
		// "processing" until the 2-minute PROCESSING_TIMEOUT, so record it here.
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
			if (recordedByProvider) return;
			const failTurn = yield* makeFailTurn;
			yield* failTurn(input.sessionId, msg, "SEND_FAILED");
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
				const failTurn = yield* makeFailTurn;
				yield* failTurn(
					input.sessionId,
					"A Claude model is required, but none could be selected.",
					"MODEL_REQUIRED",
				);
				return undefined;
			}

			const inferredModel = {
				providerID: inferred.providerId,
				modelID: inferred.id,
			};
			// Recording the pick is not what this turn waits on.
			yield* inferSessionModel(input.sessionId, inferredModel).pipe(
				Effect.catchAll((error) =>
					Effect.sync(() =>
						log.warn(
							`session=${input.sessionId} Could not record inferred model: ${formatErrorDetail(error)}`,
						),
					),
				),
			);
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
		const folders = yield* resolveProjectLaunchFolders(resolvedInput.sessionId);
		const priorHistoryMetadata = isClaudeDriver(driver)
			? yield* loadClaudeHistoryMetadata(resolvedInput.sessionId)
			: undefined;
		const readQuery = yield* ReadQueryEffectTag;
		const sessionRow = yield* readQuery
			.getSession(resolvedInput.sessionId)
			.pipe(
				Effect.catchAll((cause) =>
					Effect.gen(function* () {
						const log = yield* LoggerTag;
						log.debug(
							`Failed to read session ${resolvedInput.sessionId}: ${cause}`,
						);
						return undefined;
					}),
				),
			);
		const isFirstClaudeMessage =
			isClaudeDriver(driver) && priorHistoryMetadata?.messageCount === 0;
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
			history: [],
			providerState,
			...(sendModel && resolvedInput.model
				? {
						model: {
							providerId: resolvedInput.model.providerID,
							modelId: resolvedInput.model.modelID,
						},
					}
				: {}),
			...folders,
			...(claudeConfigDir === undefined ? {} : { configDir: claudeConfigDir }),
			...(isClaudeDriver(driver) && sessionRow
				? { goalState: sessionGoalState(sessionRow) }
				: {}),
			...(isClaudeDriver(driver)
				? {
						cumulativeTokens: priorHistoryMetadata?.cumulativeTokens ?? 0,
					}
				: {}),
			eventSink,
			abortSignal: new AbortController().signal,
			permissionMode: yield* getPermissionMode(resolvedInput.sessionId),
			...(sessionRow?.side_thread === 1 ? { sideThread: true } : {}),
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

		// Each failure gets exactly one turn.error. A provider that failed the
		// turn it was handed records its own, through this send's sink: `push`
		// on the inline path, `noteActivity` where the reactor ingests output.
		// Only a failure it did not record is Conduit's to record.
		let recordedByProvider = false;
		const { eventSink } = sendTurnInput;
		const watchedInput: SendTurnInput = {
			...sendTurnInput,
			eventSink: {
				...eventSink,
				push: (event) =>
					eventSink.push(event).pipe(
						Effect.tap(() => {
							if (event.type === "turn.error") recordedByProvider = true;
						}),
					),
				noteActivity: (event) => {
					if (event.type === "turn.error") recordedByProvider = true;
					eventSink.noteActivity?.(event);
				},
			},
		};
		const dispatchProgram = Effect.try({
			try: () =>
				orchestrationEngine.dispatchEffect({
					type: "send_turn",
					commandId: resolvedInput.commandId,
					providerId,
					input: watchedInput,
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatten,
			Effect.flatMap((result) =>
				handleDispatchResult(resolvedInput, result, recordedByProvider),
			),
			Effect.catchAll((error) =>
				restorePreviousBinding.pipe(
					Effect.zipRight(
						handleDispatchFailure(resolvedInput, error, recordedByProvider),
					),
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
		).pipe(
			Effect.catchIf(
				(cause) =>
					cause instanceof RelayError && cause.code === "FILE_NOT_FOUND",
				(cause) => handleDispatchFailure(resolvedInput, cause),
			),
		);
		if (!sendTurnInput) return;
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
