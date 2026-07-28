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
import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
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
	getPermissionMode,
	OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	setModel,
	setModelDefault,
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

export function isProviderTurnInterruptProvider(
	driver: ProviderDriverKind,
): boolean {
	return driver === CLAUDE_PROVIDER_ID;
}

function isClaudeDriver(driver: ProviderDriverKind): boolean {
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
	const overridesRef = yield* OverridesStateTag;
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
		driver: ProviderDriverKind,
		persist: ClaudeEventPersistEffect | undefined,
		ingestion: ProviderRuntimeIngestion | undefined,
	): SendTurnInput["eventSink"] => {
		if (!isClaudeDriver(driver)) return NOOP_EVENT_SINK;
		if (!ingestion) return makeProviderRuntimeIngestionRequiredSink(sessionId);
		let eventSinkPersist: RelayEventSinkPersist | undefined;
		if (persist) eventSinkPersist = persist;
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
			getPermissionMode: () =>
				getPermissionMode(sessionId).pipe(
					Effect.provideService(OverridesStateTag, overridesRef),
				),
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
		driver: ProviderDriverKind,
		claudeConfigDir: string | undefined,
		orchestrationEngine: OrchestrationEngine,
	) =>
		Effect.gen(function* () {
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
					sendErrorMessage(input, {
						type: "error",
						code: "MODEL_REQUIRED",
						message: "A Claude model is required, but none could be selected.",
						sessionId: input.sessionId,
					});
					wsHandler.sendToSession(input.sessionId, {
						type: "done",
						sessionId: input.sessionId,
						code: 1,
					});
					return;
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

			const priorHistoryResult = isClaudeDriver(driver)
				? yield* loadClaudeHistory(resolvedInput.sessionId)
				: { history: [], loaded: false };
			const priorHistory = priorHistoryResult.history;
			const isFirstClaudeMessage =
				isClaudeDriver(driver) &&
				priorHistoryResult.loaded &&
				priorHistory.length === 0;

			yield* isClaudeDriver(driver)
				? maybePersistClaudeUserMessage({
						sessionId: resolvedInput.sessionId,
						text: resolvedInput.text,
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
					? yield* providerStateEffectOption.value.getState(
							resolvedInput.sessionId,
						)
					: {};
			const eventSink = makeEventSink(
				resolvedInput.sessionId,
				driver,
				claudeEventPersistEffectOption._tag === "Some"
					? claudeEventPersistEffectOption.value
					: undefined,
				providerRuntimeIngestionOption._tag === "Some"
					? providerRuntimeIngestionOption.value
					: undefined,
			);
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
				...(claudeConfigDir === undefined
					? {}
					: { configDir: claudeConfigDir }),
				eventSink,
				abortSignal: new AbortController().signal,
				...(imageList ? { images: imageList } : {}),
				...(resolvedInput.agent ? { agent: resolvedInput.agent } : {}),
				...(resolvedInput.variant ? { variant: resolvedInput.variant } : {}),
				...(resolvedInput.contextWindow
					? { contextWindow: resolvedInput.contextWindow }
					: {}),
			};

			const previousProviderId = orchestrationEngine.getProviderForSession(
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

	const prepareTurnSession = (input: ProviderTurnServicePrepareInput) =>
		Effect.gen(function* () {
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "None") return input.sessionId;

			const orchestrationEngine = engineOption.value;
			const providerId =
				orchestrationEngine.getProviderForSession(input.sessionId) ??
				(input.model && input.model.providerID === CLAUDE_PROVIDER_ID
					? CLAUDE_PROVIDER_ID
					: OPENCODE_PROVIDER_ID);
			const daemonConfig = loadDaemonConfig(config.configDir);
			const driver = resolveProviderRoutingDriver(daemonConfig, providerId);
			if (driver === undefined || isClaudeDriver(driver)) {
				return input.sessionId;
			}

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
			if (
				!row ||
				resolveProviderRoutingDriver(daemonConfig, row.provider) ===
					OPENCODE_PROVIDER_ID
			) {
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
					engineOption.value,
				);
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
			if (!providerId) {
				yield* interruptLegacyTurn(input);
				return;
			}
			const driver = resolveProviderRoutingDriver(
				loadDaemonConfig(config.configDir),
				providerId,
			);
			if (driver === undefined) {
				log.warn(
					`client=${input.clientId} session=${input.sessionId} Cannot resolve provider instance for interrupt routing: ${providerId}`,
				);
				wsHandler.sendToSession(input.sessionId, {
					type: "done",
					sessionId: input.sessionId,
					code: 1,
				});
				return;
			}
			if (!isProviderTurnInterruptProvider(driver)) {
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
