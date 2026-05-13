// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { Effect, Runtime } from "effect";
import { AgentServiceTag } from "../effect/agent-service.js";
import { PendingInteractionServiceTag } from "../effect/pending-interaction-service.js";
import {
	ClaudeEventPersistTag,
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	ProviderStateServiceTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import {
	type SessionManagerService,
	SessionManagerServiceTag,
} from "../effect/session-manager-service.js";
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
} from "../effect/session-overrides-state.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { ClaudeEventPersistEffectTag } from "../persistence/effect/claude-event-persist-effect.js";
import { ProviderStateEffectTag } from "../persistence/effect/provider-state-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectTag,
} from "../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../persistence/events.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import {
	createRelayEventSink,
	type RelayEventSinkPersist,
} from "../provider/relay-event-sink.js";
import type { SendTurnInput, TurnResult } from "../provider/types.js";
import { isClaudeProvider } from "./model.js";
import type { PayloadMap } from "./payloads.js";
import type { PromptOptions } from "./types.js";

// ─── Minimal no-op EventSink for OpenCodeAdapter (which ignores it) ──────────
// OpenCodeAdapter routes messages via REST + SSE, not EventSink. The sink is
// required by the SendTurnInput interface but unused on the OpenCode path.
const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Effect.void,
	requestPermission: () => Promise.resolve({ decision: "once" as const }),
	requestQuestion: () => Promise.resolve({}),
	resolvePermission: () => {},
	resolveQuestion: () => {},
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

/** Get the stored input draft for a session (empty string if none). */
export function getSessionInputDraft(sessionId: string): string {
	return sessionInputDrafts.get(sessionId) ?? "";
}

/** Clear the stored input draft for a session (e.g. after sending a message). */
export function clearSessionInputDraft(sessionId: string): void {
	sessionInputDrafts.delete(sessionId);
}

export const handleMessage = (
	clientId: string,
	payload: PayloadMap["message"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const config = yield* ConfigTag;
		const pendingInteractionService = yield* PendingInteractionServiceTag;
		const runtime = yield* Effect.runtime<OverridesStateTag>();
		const runPending = Runtime.runPromise(runtime);
		const runTimeout = Runtime.runFork(runtime);

		const { text, images } = payload;
		const activeId = wsHandler.getClientSession(clientId);
		if (!text) return;
		if (!activeId) {
			wsHandler.sendTo(
				clientId,
				new RelayError(
					"No active session. Create or switch to a session first.",
					{ code: "NO_SESSION" },
				).toSystemError(),
			);
			return;
		}
		log.info(
			`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		);

		// Clear the input draft
		clearSessionInputDraft(activeId);

		// Send user_message to OTHER clients viewing this session
		const targets = wsHandler.getClientsForSession(activeId);
		for (const targetId of targets) {
			if (targetId !== clientId) {
				wsHandler.sendTo(targetId, {
					type: "user_message",
					sessionId: activeId,
					text,
				});
			}
		}

		// Track message activity
		yield* sessionManagerService.recordMessageActivity(activeId);

		const prompt: PromptOptions = {
			text,
			...(images && images.length > 0 && { images }),
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
		const claudeEventPersistOption = yield* Effect.serviceOption(
			ClaudeEventPersistTag,
		);
		const claudeEventPersistEffectOption = yield* Effect.serviceOption(
			ClaudeEventPersistEffectTag,
		);
		const providerStateOption = yield* Effect.serviceOption(
			ProviderStateServiceTag,
		);
		const providerStateEffectOption = yield* Effect.serviceOption(
			ProviderStateEffectTag,
		);
		const readQueryEffectOption =
			yield* Effect.serviceOption(ReadQueryEffectTag);

		if (engineOption._tag === "Some") {
			const orchestrationEngine = engineOption.value;
			const model = sessionModel;
			let providerId = orchestrationEngine.getProviderForSession(activeId);
			if (!providerId) {
				providerId =
					model && isClaudeProvider(model.providerID) ? "claude" : "opencode";
			}
			const priorHistory =
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
							if (result._tag === "Right") return result.right;
							log.warn(
								`Failed to load prior Claude history for ${activeId}: ${result.left instanceof Error ? result.left.message : result.left}`,
							);
							return [];
						})
					: [];

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
				if (persistResult._tag === "Left") {
					log.warn(
						`Non-fatal persistence error for Claude user message: ${formatErrorDetail(persistResult.left)}`,
					);
				}
			} else if (
				providerId === "claude" &&
				claudeEventPersistOption._tag === "Some"
			) {
				// Persistence failure is non-fatal, must not block message sending
				const persistResult = yield* Effect.either(
					Effect.try(() => {
						const claudeEventPersist = claudeEventPersistOption.value;
						const now = Date.now();
						const userMsgId = crypto.randomUUID();
						claudeEventPersist.ensureSession(activeId);
						const storedSession = claudeEventPersist.eventStore.append(
							canonicalEvent(
								"session.created",
								activeId,
								{
									sessionId: activeId,
									title: "Claude Session",
									provider: "claude",
								},
								{ provider: "claude", createdAt: now },
							),
						);
						claudeEventPersist.projectionRunner.projectEvent(storedSession);
						const storedCreated = claudeEventPersist.eventStore.append(
							canonicalEvent(
								"message.created",
								activeId,
								{
									messageId: userMsgId,
									role: "user",
									sessionId: activeId,
								},
								{ provider: "claude", createdAt: now },
							),
						);
						claudeEventPersist.projectionRunner.projectEvent(storedCreated);
						const storedDelta = claudeEventPersist.eventStore.append(
							canonicalEvent(
								"text.delta",
								activeId,
								{
									messageId: userMsgId,
									partId: `${userMsgId}-0`,
									text,
								},
								{ provider: "claude", createdAt: now },
							),
						);
						claudeEventPersist.projectionRunner.projectEvent(storedDelta);
					}),
				);
				// Log but don't block (intentional recovery — non-fatal persistence failure)
				if (persistResult._tag === "Left") {
					log.warn(
						`Non-fatal persistence error for Claude user message: ${persistResult.left}`,
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
			} else if (
				providerId === "claude" &&
				claudeEventPersistOption._tag === "Some"
			) {
				eventSinkPersist = claudeEventPersistOption.value;
			}

			const eventSink =
				providerId === "claude"
					? createRelayEventSink({
							sessionId: activeId,
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
									runPending(
										pendingInteractionService
											.beginPermissionRequest(input)
											.pipe(Effect.flatMap((pending) => pending.awaitResponse)),
									),
								resolvePermissionRequest: (requestId, response) =>
									runPending(
										pendingInteractionService.resolvePermissionRequest(
											requestId,
											response,
										),
									),
								beginQuestionRequest: (input) =>
									runPending(
										pendingInteractionService
											.beginQuestionRequest(input)
											.pipe(Effect.flatMap((pending) => pending.awaitAnswers)),
									),
								resolveQuestionRequest: (requestId, answers) =>
									runPending(
										pendingInteractionService.resolveQuestionRequest(
											requestId,
											answers,
										),
									),
								cancelSessionInteractions: (reason) =>
									runPending(
										pendingInteractionService.cancelSessionInteractions(
											activeId,
											reason,
										),
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
						: providerStateOption._tag === "Some"
							? (providerStateOption.value.getState(activeId) ?? {})
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
				...(images && images.length > 0 ? { images } : {}),
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
					wsHandler.sendTo(
						clientId,
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
						wsHandler.sendTo(
							clientId,
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
						} else {
							if (providerStateOption._tag === "Some") {
								yield* Effect.try({
									try: () =>
										providerStateOption.value.saveUpdates(activeId, updates),
									catch: (err) => err,
								}).pipe(Effect.catchAll(() => Effect.void));
							}
						}
					}

					// Auto-rename Claude sessions after first successful turn
					if (result.status !== "error" && providerId === "claude") {
						const turnCount = result.providerStateUpdates?.find(
							(u) => u.key === "turnCount",
						)?.value;
						if (Number(turnCount) === 1) {
							const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
							const renameResult = yield* Effect.either(
								Effect.gen(function* () {
									const sessions = yield* sessionManagerService.listSessions();
									const session = sessions.find((s) => s.id === activeId);
									const currentTitle = session?.title ?? "";
									const isDefault =
										!currentTitle ||
										currentTitle === "Claude Session" ||
										currentTitle.startsWith("New session");
									if (!isDefault) return;

									yield* sessionManagerService.renameSession(activeId, title);
									yield* sessionManagerService.sendDualSessionLists((msg) =>
										wsHandler.broadcast(msg),
									);
								}),
							);
							if (renameResult._tag === "Left") {
								log.warn(
									`Auto-rename failed for ${activeId}: ${formatErrorDetail(renameResult.left)}`,
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
				wsHandler.sendTo(
					clientId,
					RelayError.fromCaught(
						sendResult.left,
						"SEND_FAILED",
						"Failed to send message",
					).toMessage(activeId),
				);
			}
		}
	});

export const handleCancel = (
	clientId: string,
	_payload: PayloadMap["cancel"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const activeId = wsHandler.getClientSession(clientId);
		if (activeId) {
			log.info(`client=${clientId} session=${activeId} Aborting`);
			yield* clearProcessingTimeout(activeId);

			// Route through OrchestrationEngine for Claude sessions
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const engine = engineOption.value;
				const providerId = engine.getProviderForSession(activeId);
				if (providerId === "claude") {
					const interruptResult = yield* Effect.either(
						engine.dispatchEffect({
							type: "interrupt_turn",
							sessionId: activeId,
						}),
					);
					if (interruptResult._tag === "Left") {
						log.warn(
							`client=${clientId} session=${activeId} engine interrupt_turn failed:`,
							formatErrorDetail(interruptResult.left),
						);
					}
					wsHandler.sendToSession(activeId, {
						type: "done",
						sessionId: activeId,
						code: 1,
					});
					return;
				}
			}

			// OpenCode path: abort via REST API
			const abortResult = yield* Effect.either(
				Effect.tryPromise(() => client.session.abort(activeId)),
			);
			if (abortResult._tag === "Left") {
				log.warn(
					`client=${clientId} session=${activeId} Abort failed:`,
					formatErrorDetail(abortResult.left),
				);
			}
			wsHandler.sendToSession(activeId, {
				type: "done",
				sessionId: activeId,
				code: 1,
			});
		}
	});

export const handleRewind = (clientId: string, payload: PayloadMap["rewind"]) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const messageId = payload.messageId ?? payload.uuid ?? "";
		const activeId = wsHandler.getClientSession(clientId);
		if (messageId && activeId) {
			yield* Effect.tryPromise(() =>
				client.session.revert(activeId, { messageID: messageId }),
			);
			yield* sessionManagerService.clearPaginationCursor(activeId);
			log.info(
				`client=${clientId} session=${activeId} Reverted to message: ${messageId}`,
			);
		}
	});

export const handleInputSync = (
	clientId: string,
	payload: PayloadMap["input_sync"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		const senderSession = wsHandler.getClientSession(clientId);
		if (!senderSession) return;

		// Store the draft so newly connecting clients receive it
		if (payload.text) {
			sessionInputDrafts.set(senderSession, payload.text);
		} else {
			sessionInputDrafts.delete(senderSession);
		}

		const targets = wsHandler.getClientsForSession(senderSession);
		for (const targetId of targets) {
			if (targetId !== clientId) {
				wsHandler.sendTo(targetId, {
					type: "input_sync",
					text: payload.text,
					from: clientId,
				});
			}
		}
	});
