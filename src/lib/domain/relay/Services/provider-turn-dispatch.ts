import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	FiberMap,
	type Ref,
	Runtime,
	Schema,
} from "effect";
import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import { SessionWorkspaceSchema } from "../../../contracts/session-workspace.js";
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
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { createRelayEventSink } from "../../../provider/relay-event-sink.js";
import type { SendTurnInput, TurnResult } from "../../../provider/types.js";
import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
import { publishAlert } from "./alerts.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "./provider-runtime-ingestion-service.js";
import type { ProviderTurnServiceSendInput } from "./provider-turn-service.js";
import { ConfigTag, LoggerTag, OrchestrationEngineTag } from "./services.js";
import { inferSessionModel } from "./session-model-settings.js";
import {
	clearProcessingTimeout,
	getPermissionMode,
	type OverridesState,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	setPermissionMode,
	startProcessingTimeout,
} from "./session-overrides-state.js";
import { SessionTitleServiceTag } from "./session-title-service.js";
import { makeFailTurn } from "./turn-failure.js";

export const CLAUDE_PROVIDER_ID = "claude";
export const OPENCODE_PROVIDER_ID = "opencode";

/** Recheck saved folders at launch, shared by sends and speculative warming. */
export const resolveSessionFolders = (
	session: Pick<SessionRow, "id" | "workspace">,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const state =
			session.workspace == null
				? null
				: yield* Schema.decodeUnknown(Schema.parseJson(SessionWorkspaceSchema))(
						session.workspace,
					);
		const workspaceRoot = effectiveWorkingDirectory(config.projectDir, state);
		if (!existsSync(workspaceRoot))
			return yield* Effect.fail(
				new RelayError(`Main project folder does not exist: ${workspaceRoot}`, {
					code: "FILE_NOT_FOUND",
				}),
			);
		const extraFolders: string[] = [];
		const launchFolders = state
			? [config.projectDir, ...(config.extraFolders ?? [])]
					.map((folder) => state.worktrees[folder] ?? folder)
					.filter((folder) => folder !== workspaceRoot)
			: (config.extraFolders ?? []);
		for (const folder of launchFolders) {
			if (existsSync(folder)) extraFolders.push(folder);
			else {
				// Not the turn's failure: the launch goes on without the folder, so
				// the user is warned rather than shown a failed turn.
				const message = `Extra folder "${folder}" does not exist and was skipped.`;
				const log = yield* LoggerTag;
				log.warn(`session=${session.id} ${message}`);
				yield* publishAlert({
					_tag: "alert",
					kind: "warning",
					alertId: randomUUID(),
					sessionId: session.id,
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

/**
 * End a send that failed. Each failure gets exactly one turn.error: a provider
 * that already ended the turn it was handed (failed, interrupted or completed
 * it) recorded that end through this send's sink. A handoff that ended before
 * its message was placed still shows the send, and its turn ends failed so a
 * queue behind it pauses instead of draining. A continuation places nothing:
 * its turn is the cut-off's.
 */
const failUnfinishedSend = (
	input: ProviderTurnServiceSendInput,
	driver: ProviderDriverKind | undefined,
	endedByProvider: boolean,
	error: string,
	code: string,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const sql = yield* SqlClient.SqlClient;
		const failTurn = yield* makeFailTurn;
		yield* clearProcessingTimeout(input.sessionId);
		const inputId = input.continuation ? undefined : input.commandId;
		const unplaced =
			driver !== undefined &&
			inputId !== undefined &&
			(yield* sql`SELECT 1 FROM messages
				WHERE session_id = ${input.sessionId}
					AND (id = ${inputId} OR input_id = ${inputId})
				LIMIT 1`.pipe(
				Effect.map((rows) => rows.length === 0),
				Effect.orElseSucceed(() => false),
			));
		if (unplaced) {
			const persist = yield* ClaudeEventPersistEffectTag;
			yield* persist
				.persistUserMessage(input.sessionId, input.text, {
					messageId: inputId,
					inputId,
					provider: driver,
				})
				.pipe(
					Effect.catchAll((cause) =>
						Effect.sync(() =>
							log.warn(
								`session=${input.sessionId} Failed to place unsent user message: ${formatErrorDetail(cause)}`,
							),
						),
					),
				);
		}
		// A provider's own turn end cannot have ended a turn placed only now.
		if (endedByProvider && !unplaced) return;
		yield* failTurn(input.sessionId, error, code, inputId);
	});

const makeEventSink = (sessionId: string, driver: ProviderDriverKind) =>
	Effect.gen(function* () {
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		const { runtime, overridesRef } = yield* ProviderTurnTimeoutRuntimeTag;
		const runTimeout = Runtime.runFork(runtime);
		const persist = yield* ClaudeEventPersistEffectTag;
		const ingestion = yield* ProviderRuntimeIngestionTag;
		if (!isClaudeDriver(driver)) return NOOP_EVENT_SINK;
		return createRelayEventSink({
			sessionId,
			providerId: driver,
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

const TURN_END_TYPES = new Set([
	"turn.completed",
	"turn.error",
	"turn.interrupted",
]);

const handleDispatchFailure = (
	input: ProviderTurnServiceSendInput,
	sendErr: unknown,
	driver: ProviderDriverKind | undefined,
	endedByProvider = false,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		log.warn(
			`client=${input.clientId} session=${input.sessionId} Failed to send message:`,
			formatErrorDetail(sendErr),
		);
		const error = RelayError.fromCaught(
			sendErr,
			"SEND_FAILED",
			"Failed to send message",
		);
		yield* failUnfinishedSend(
			input,
			driver,
			endedByProvider,
			error.message,
			error.code,
		);
	});

const handleDispatchResult = (
	input: ProviderTurnServiceSendInput,
	result: TurnResult,
	driver: ProviderDriverKind,
	endedByProvider: boolean,
) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		// The interrupter already sent done; finalizing again can end a newer turn.
		if (result.status === "interrupted" && !result.error) return;
		// One provider result finalises once: the input that owns it does that,
		// so an input it folded in finalises nothing.
		if (result.status === "joined") return;

		// Other non-`completed` terminal statuses (error / cancelled / orphaned)
		// must finalize the turn: a completed turn's `done` arrives via the
		// streamed provider events. A provider that streamed its own turn end
		// already finalized it; otherwise the browser would stay
		// "processing" until the 2-minute PROCESSING_TIMEOUT, so record it here.
		if (result.status !== "completed") {
			const msg =
				result.error?.message ??
				(result.status === "error" ? "Send failed" : `Turn ${result.status}`);
			log.warn(
				`client=${input.clientId} session=${input.sessionId} engine dispatch ${result.status}: ${msg}`,
			);
			yield* failUnfinishedSend(
				input,
				driver,
				endedByProvider,
				msg,
				"SEND_FAILED",
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
	providerId: string,
	driver: ProviderDriverKind,
	claudeConfigDir: string | undefined,
) =>
	Effect.gen(function* () {
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
		const folders = yield* resolveSessionFolders({
			id: resolvedInput.sessionId,
			workspace: sessionRow?.workspace ?? null,
		});
		const isFirstClaudeMessage =
			isClaudeDriver(driver) && priorHistoryMetadata?.messageCount === 0;
		const inputId = resolvedInput.commandId;
		if (isFirstClaudeMessage && !resolvedInput.continuation) {
			const titleService = yield* SessionTitleServiceTag;
			yield* titleService.startForFirstClaudeMessage({
				sessionId: resolvedInput.sessionId,
				firstMessage: resolvedInput.text,
			});
		}

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
			inputId,
			prompt: resolvedInput.text,
			...(resolvedInput.continuation
				? { continuation: resolvedInput.continuation }
				: {}),
			history: [],
			providerState,
			instanceId: providerId,
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
	driver: ProviderDriverKind,
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

		// Resolved once the engine commits the handoff, or once the dispatch ends
		// without committing it. The caller waits on it so a submit behind this
		// one reads the committed handoff, not the moment before it.
		const accepted = yield* Deferred.make<void>();

		// Each failure gets exactly one turn.error. A provider that ended the
		// turn it was handed records that end through this send's sink: `push`
		// on the inline path, `noteActivity` where the reactor ingests output.
		// Only a turn it left open is Conduit's to fail: a send that fails after
		// its turn was interrupted (a reload ends the session) must not turn
		// that interrupted turn into an error.
		let endedByProvider = false;
		const { eventSink } = sendTurnInput;
		const watchedInput: SendTurnInput = {
			...sendTurnInput,
			eventSink: {
				...eventSink,
				push: (event) =>
					eventSink.push(event).pipe(
						Effect.tap(() => {
							if (TURN_END_TYPES.has(event.type)) endedByProvider = true;
						}),
					),
				noteActivity: (event) => {
					if (TURN_END_TYPES.has(event.type)) endedByProvider = true;
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
					...(resolvedInput.events ? { events: resolvedInput.events } : {}),
					onAccepted: Deferred.succeed(accepted, undefined),
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatten,
			Effect.flatMap((result) =>
				handleDispatchResult(resolvedInput, result, driver, endedByProvider),
			),
			Effect.catchAll((error) =>
				restorePreviousBinding.pipe(
					Effect.zipRight(
						handleDispatchFailure(
							resolvedInput,
							error,
							driver,
							endedByProvider,
						),
					),
				),
			),
			Effect.onInterrupt(() => restorePreviousBinding),
			Effect.ensuring(Deferred.succeed(accepted, undefined)),
		);
		const fiber = yield* FiberMap.run(
			dispatchFibers,
			`${resolvedInput.sessionId}:${sendTurnInput.inputId}`,
			dispatchProgram,
			{ onlyIfMissing: true },
		);
		yield* Effect.raceFirst(
			Deferred.await(accepted),
			Fiber.await(fiber).pipe(Effect.asVoid),
		);
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
			providerId,
			driver,
			claudeConfigDir,
		).pipe(
			Effect.catchIf(
				(cause) =>
					cause instanceof RelayError && cause.code === "FILE_NOT_FOUND",
				(cause) => handleDispatchFailure(resolvedInput, cause, driver),
			),
		);
		if (!sendTurnInput) return;
		yield* dispatchEngineTurn(resolvedInput, providerId, driver, sendTurnInput);
	});

/** The handoff is where a turn starts working: arm its timeout. The browser's
 *  processing phase follows the session's shell row (ni8.35). */
const startProcessing = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const failTurn = yield* makeFailTurn;
		const { sessionId } = input;
		yield* startProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.suspend(() => {
				log.warn(
					`client=${input.clientId} session=${sessionId} Processing timeout (120s) — failing the turn`,
				);
				return failTurn(
					sessionId,
					input.continuation
						? "The continuation received no response. Try again."
						: "No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
					"PROCESSING_TIMEOUT",
					input.continuation ? undefined : input.commandId,
				);
			}),
		);
	});

export const sendTurn = (input: ProviderTurnServiceSendInput) =>
	Effect.gen(function* () {
		if (!input.steer) yield* startProcessing(input);
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
				undefined,
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
