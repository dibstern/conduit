import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { Effect, Runtime } from "effect";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../domain/relay/Services/session-manager-service.js";
import {
	clearProcessingTimeout,
	getAgent,
	getContextWindow,
	getModel,
	getVariant,
	isModelUserSelected,
	type OverridesStateTag,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
	startProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { SessionTitleServiceTag } from "../domain/relay/Services/session-title-service.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import {
	createRelayEventSink,
	type RelayEventSinkPersist,
} from "../provider/relay-event-sink.js";
import type { SendTurnInput, TurnResult } from "../provider/types.js";
import { isClaudeProvider } from "./model.js";
import type { PromptOptions } from "./types.js";

// ─── Minimal no-op EventSink for OpenCodeProviderInstance (which ignores it) ──────────
// OpenCodeProviderInstance routes messages via REST + SSE, not EventSink. The sink is
// required by the SendTurnInput interface but unused on the OpenCode path.
const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Effect.void,
	requestPermission: () => Effect.succeed({ decision: "once" as const }),
	requestQuestion: () => Effect.succeed({}),
	resolvePermission: () => Effect.void,
	resolveQuestion: () => Effect.void,
};

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

// ─── Per-session input draft store ──────────────────────────────────────────
// Stores the last input_sync text per session so that newly connecting clients
// (e.g. opening on a different device) receive the current draft.

const sessionInputDrafts = new Map<string, string>();

interface LegacyMessagePayload {
	text: string;
	images?: string[];
}

/** Get the stored input draft for a session (empty string if none). */
export function getSessionInputDraft(sessionId: string): string {
	return sessionInputDrafts.get(sessionId) ?? "";
}

/** Clear the stored input draft for a session (e.g. after sending a message). */
export function clearSessionInputDraft(sessionId: string): void {
	sessionInputDrafts.delete(sessionId);
}

export interface SendMessageToSessionInput {
	readonly clientId: string;
	readonly sessionId: string | undefined;
	readonly text: string;
	readonly images?: readonly string[];
	readonly originId?: string;
	readonly excludeClientId?: string;
	readonly missingSessionClientId?: string;
	readonly errorDelivery?: "client" | "session";
}

export const sendMessageToSession = (input: SendMessageToSessionInput) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const config = yield* ConfigTag;
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		const runtime = yield* Effect.runtime<OverridesStateTag>();
		const runTimeout = Runtime.runFork(runtime);

		const { clientId, text, images, originId, excludeClientId } = input;
		const imageList =
			images && images.length > 0 ? Array.from(images) : undefined;
		const activeId = input.sessionId;
		if (!text) return;
		if (!activeId) {
			if (input.missingSessionClientId) {
				wsHandler.sendTo(
					input.missingSessionClientId,
					new RelayError(
						"No active session. Create or switch to a session first.",
						{ code: "NO_SESSION" },
					).toSystemError(),
				);
			}
			return;
		}
		log.info(
			`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		);
		const sendErrorMessage = (message: ReturnType<RelayError["toMessage"]>) => {
			if (input.errorDelivery === "session") {
				wsHandler.sendToSession(activeId, message);
			} else {
				wsHandler.sendTo(clientId, message);
			}
		};

		// Clear the input draft
		clearSessionInputDraft(activeId);

		// Send user_message to OTHER clients viewing this session
		const targets = wsHandler.getClientsForSession(activeId);
		for (const targetId of targets) {
			if (targetId !== excludeClientId) {
				wsHandler.sendTo(targetId, {
					type: "user_message",
					sessionId: activeId,
					text,
					...(originId ? { originId } : {}),
				});
			}
		}

		// Track message activity
		yield* sessionManagerService.recordMessageActivity(activeId);

		const prompt: PromptOptions = {
			text,
			...(imageList ? { images: imageList } : {}),
		};
		const agentServiceOption = yield* Effect.serviceOption(AgentServiceTag);
		const sessionAgent =
			agentServiceOption._tag === "Some"
				? yield* agentServiceOption.value.getActiveAgent(activeId)
				: yield* getAgent(activeId);
		if (sessionAgent) prompt.agent = sessionAgent;
		const sessionModel = yield* getModel(activeId);
		const sessionModelUserSelected = yield* isModelUserSelected(activeId);
		if (sessionModel && sessionModelUserSelected) {
			prompt.model = sessionModel;
		}
		const variant = yield* getVariant(activeId);
		if (variant) prompt.variant = variant;
		const contextWindow = yield* getContextWindow(activeId);

		wsHandler.sendToSession(activeId, {
			type: "status",
			sessionId: activeId,
			status: "processing",
		});
		yield* startProcessingTimeout(activeId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.sync(() => {
				log.warn(
					`client=${clientId} session=${activeId} Processing timeout (120s) — broadcasting done`,
				);
				wsHandler.sendToSession(
					activeId,
					new RelayError(
						"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
						{ code: "PROCESSING_TIMEOUT" },
					).toMessage(activeId),
				);
				wsHandler.sendToSession(activeId, {
					type: "done",
					sessionId: activeId,
					code: 1,
				});
			}),
		);

		// Check if orchestration engine is available
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const claudeEventPersistEffectOption = yield* Effect.serviceOption(
			ClaudeEventPersistEffectTag,
		);
		const providerStateEffectOption = yield* Effect.serviceOption(
			ProviderStateEffectTag,
		);
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);
		const titleServiceOption = yield* Effect.serviceOption(
			SessionTitleServiceTag,
		);

		if (engineOption._tag === "Some") {
			const orchestrationEngine = engineOption.value;
			const model = sessionModel;
			let providerId = orchestrationEngine.getProviderForSession(activeId);
			if (!providerId) {
				providerId =
					model && isClaudeProvider(model.providerID) ? "claude" : "opencode";
			}
			const priorHistoryResult =
				providerId === "claude"
					? yield* Effect.gen(function* () {
							const historyReaders: PriorHistoryReaders = {
								...(readQueryEffectOption._tag === "Some"
									? { readQueryEffect: readQueryEffectOption.value }
									: {}),
							};
							const result = yield* Effect.either(
								loadPriorHistoryForTurn(
									activeId,
									sessionManagerService,
									historyReaders,
								),
							);
							if (result._tag === "Right") {
								return { history: result.right, loaded: true };
							}
							log.warn(
								`Failed to load prior Claude history for ${activeId}: ${result.left instanceof Error ? result.left.message : result.left}`,
							);
							return { history: [], loaded: false };
						})
					: { history: [], loaded: false };
			const priorHistory = priorHistoryResult.history;
			const isFirstClaudeMessage =
				providerId === "claude" &&
				priorHistoryResult.loaded &&
				priorHistory.length === 0;

			// Persist user message for Claude sessions (non-fatal)
			if (
				providerId === "claude" &&
				claudeEventPersistEffectOption._tag === "Some"
			) {
				const persistResult = yield* Effect.either(
					claudeEventPersistEffectOption.value.persistUserMessage(
						activeId,
						text,
					),
				);
				if (
					isFirstClaudeMessage &&
					titleServiceOption._tag === "Some" &&
					persistResult._tag === "Right"
				) {
					yield* titleServiceOption.value.startForFirstClaudeMessage({
						sessionId: activeId,
						firstMessage: text,
					});
				}
				if (persistResult._tag === "Left") {
					log.warn(
						`Non-fatal persistence error for Claude user message: ${formatErrorDetail(persistResult.left)}`,
					);
				}
			}

			// Build event sink
			let eventSinkPersist: RelayEventSinkPersist | undefined;
			if (
				providerId === "claude" &&
				claudeEventPersistEffectOption._tag === "Some"
			) {
				eventSinkPersist = claudeEventPersistEffectOption.value;
			}

			const eventSink =
				providerId === "claude"
					? createRelayEventSink({
							sessionId: activeId,
							providerId,
							send: (msg) => wsHandler.sendToSession(activeId, msg),
							clearTimeout: () => {
								runTimeout(clearProcessingTimeout(activeId));
							},
							resetTimeout: () => {
								runTimeout(
									resetProcessingTimeout(activeId, PROCESSING_TIMEOUT_DURATION),
								);
							},
							...(eventSinkPersist ? { persist: eventSinkPersist } : {}),
							pendingInteractions: {
								beginPermissionRequest: (input) =>
									pendingInteractionService.beginPermissionRequest(input),
								resolvePermissionRequest: (requestId, response) =>
									pendingInteractionService.resolvePermissionRequest(
										requestId,
										response,
									),
								beginQuestionRequest: (input) =>
									pendingInteractionService.beginQuestionRequest(input),
								resolveQuestionRequest: (requestId, answers) =>
									pendingInteractionService.resolveQuestionRequest(
										requestId,
										answers,
									),
								cancelSessionInteractions: (reason) =>
									pendingInteractionService.cancelSessionInteractions(
										activeId,
										reason,
									),
							},
						})
					: NOOP_EVENT_SINK;

			const sendTurnInput: SendTurnInput = {
				sessionId: activeId,
				turnId: crypto.randomUUID(),
				prompt: text,
				history: priorHistory,
				providerState:
					providerStateEffectOption._tag === "Some"
						? yield* providerStateEffectOption.value.getState(activeId)
						: {},
				...(model && sessionModelUserSelected
					? {
							model: {
								providerId: model.providerID,
								modelId: model.modelID,
							},
						}
					: {}),
				workspaceRoot: config.projectDir ?? "",
				eventSink,
				abortSignal: new AbortController().signal,
				...(imageList ? { images: imageList } : {}),
				...(sessionAgent ? { agent: sessionAgent } : {}),
				...(variant ? { variant } : {}),
				...(contextWindow ? { contextWindow } : {}),
			};

			const handleDispatchFailure = (sendErr: unknown) =>
				Effect.gen(function* () {
					log.warn(
						`client=${clientId} session=${activeId} Failed to send message:`,
						formatErrorDetail(sendErr),
					);
					yield* clearProcessingTimeout(activeId);
					wsHandler.sendToSession(activeId, {
						type: "done",
						sessionId: activeId,
						code: 1,
					});
					sendErrorMessage(
						RelayError.fromCaught(
							sendErr,
							"SEND_FAILED",
							"Failed to send message",
						).toMessage(activeId),
					);
				});

			const handleDispatchResult = (result: TurnResult) =>
				Effect.gen(function* () {
					if (result.status === "error") {
						const msg = result.error?.message ?? "Send failed";
						log.warn(
							`client=${clientId} session=${activeId} engine dispatch error: ${msg}`,
						);
						yield* clearProcessingTimeout(activeId);
						wsHandler.sendToSession(activeId, {
							type: "done",
							sessionId: activeId,
							code: 1,
						});
						sendErrorMessage(
							new RelayError(msg, {
								code: "SEND_FAILED",
							}).toMessage(activeId),
						);
					}

					// Persist provider state updates
					if (
						result.status !== "error" &&
						result.providerStateUpdates?.length
					) {
						const updates = result.providerStateUpdates.map((u) => ({
							key: u.key,
							value: String(u.value),
						}));
						if (providerStateEffectOption._tag === "Some") {
							const saveResult = yield* Effect.either(
								providerStateEffectOption.value.saveUpdates(activeId, updates),
							);
							if (saveResult._tag === "Left") {
								log.warn(
									`Non-fatal provider state persistence error for ${activeId}: ${formatErrorDetail(saveResult.left)}`,
								);
							}
						}
					}
				});

			yield* Effect.forkDaemon(
				orchestrationEngine
					.dispatchEffect({
						type: "send_turn",
						providerId,
						input: sendTurnInput,
					})
					.pipe(
						Effect.flatMap(handleDispatchResult),
						Effect.catchAll(handleDispatchFailure),
					),
			);
		} else {
			// Legacy path: direct REST call
			const sendResult = yield* Effect.either(
				Effect.tryPromise(() => client.session.prompt(activeId, prompt)),
			);
			if (sendResult._tag === "Left") {
				// Send failure recovery — send error to client and broadcast done
				log.warn(
					`client=${clientId} session=${activeId} Failed to send message:`,
					formatErrorDetail(sendResult.left),
				);
				yield* clearProcessingTimeout(activeId);
				wsHandler.sendToSession(activeId, {
					type: "done",
					sessionId: activeId,
					code: 1,
				});
				sendErrorMessage(
					RelayError.fromCaught(
						sendResult.left,
						"SEND_FAILED",
						"Failed to send message",
					).toMessage(activeId),
				);
			}
		}
	});

export const handleMessage = (
	clientId: string,
	payload: LegacyMessagePayload,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		yield* sendMessageToSession({
			clientId,
			sessionId: wsHandler.getClientSession(clientId),
			text: payload.text,
			...(payload.images ? { images: payload.images } : {}),
			excludeClientId: clientId,
			missingSessionClientId: clientId,
		});
	});

export const cancelSessionById = (clientId: string, sessionId: string) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		log.info(`client=${clientId} session=${sessionId} Aborting`);
		yield* clearProcessingTimeout(sessionId);

		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		if (engineOption._tag === "Some") {
			const engine = engineOption.value;
			const providerId = engine.getProviderForSession(sessionId);
			if (providerId === "claude") {
				const interruptResult = yield* Effect.either(
					engine.dispatchEffect({
						type: "interrupt_turn",
						sessionId,
					}),
				);
				if (interruptResult._tag === "Left") {
					log.warn(
						`client=${clientId} session=${sessionId} engine interrupt_turn failed:`,
						formatErrorDetail(interruptResult.left),
					);
				}
				wsHandler.sendToSession(sessionId, {
					type: "done",
					sessionId,
					code: 1,
				});
				return;
			}
		}

		const abortResult = yield* Effect.either(
			Effect.tryPromise(() => client.session.abort(sessionId)),
		);
		if (abortResult._tag === "Left") {
			log.warn(
				`client=${clientId} session=${sessionId} Abort failed:`,
				formatErrorDetail(abortResult.left),
			);
		}
		wsHandler.sendToSession(sessionId, {
			type: "done",
			sessionId,
			code: 1,
		});
	});

export const rewindSessionToMessage = ({
	clientId,
	sessionId,
	messageId,
}: {
	clientId: string;
	sessionId: string;
	messageId: string;
}) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (messageId) {
			yield* Effect.tryPromise(() =>
				client.session.revert(sessionId, { messageID: messageId }),
			);
			yield* sessionManagerService.clearPaginationCursor(sessionId);
			log.info(
				`client=${clientId} session=${sessionId} Reverted to message: ${messageId}`,
			);
		}
	});

export const syncInputDraftForSession = ({
	sessionId,
	text,
	from,
}: {
	sessionId: string;
	text: string;
	from?: string;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		// Store the draft so newly connecting clients receive it
		if (text) {
			sessionInputDrafts.set(sessionId, text);
		} else {
			sessionInputDrafts.delete(sessionId);
		}

		const targets = wsHandler.getClientsForSession(sessionId);
		for (const targetId of targets) {
			wsHandler.sendTo(targetId, {
				type: "input_sync",
				text,
				...(from ? { from } : {}),
			});
		}
	});
