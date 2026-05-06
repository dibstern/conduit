// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { Effect } from "effect";
import {
	ClaudeEventPersistTag,
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	ProviderStateServiceTag,
	QuestionBridgeTag,
	SessionManagerTag,
	SessionOverridesTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { canonicalEvent } from "../persistence/events.js";
import { createRelayEventSink } from "../provider/relay-event-sink.js";
import type { SendTurnInput } from "../provider/types.js";
import { isClaudeProvider } from "./model.js";
import type { PayloadMap } from "./payloads.js";
import type { PromptOptions } from "./types.js";

// ─── Minimal no-op EventSink for OpenCodeAdapter (which ignores it) ──────────
// OpenCodeAdapter routes messages via REST + SSE, not EventSink. The sink is
// required by the SendTurnInput interface but unused on the OpenCode path.
const NOOP_EVENT_SINK: SendTurnInput["eventSink"] = {
	push: () => Promise.resolve(),
	requestPermission: () => Promise.resolve({ decision: "once" as const }),
	requestQuestion: () => Promise.resolve({}),
};

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
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;
		const sessionMgr = yield* SessionManagerTag;
		const config = yield* ConfigTag;
		const permissionBridge = yield* PermissionBridgeTag;
		const questionBridge = yield* QuestionBridgeTag;

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
		sessionMgr.recordMessageActivity(activeId);

		const prompt: PromptOptions = {
			text,
			...(images && images.length > 0 && { images }),
		};
		const sessionAgent = overrides.getAgent(activeId);
		if (sessionAgent) prompt.agent = sessionAgent;
		const sessionModel = overrides.getModel(activeId);
		if (sessionModel && overrides.isModelUserSelected(activeId))
			prompt.model = sessionModel;
		const variant = overrides.getVariant(activeId);
		if (variant) prompt.variant = variant;

		wsHandler.sendToSession(activeId, {
			type: "status",
			sessionId: activeId,
			status: "processing",
		});
		overrides.startProcessingTimeout(activeId, () => {
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
		});

		// Check if orchestration engine is available
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const claudeEventPersistOption = yield* Effect.serviceOption(
			ClaudeEventPersistTag,
		);
		const providerStateOption = yield* Effect.serviceOption(
			ProviderStateServiceTag,
		);

		if (engineOption._tag === "Some") {
			const orchestrationEngine = engineOption.value;
			const model = overrides.getModel(activeId);
			let providerId = orchestrationEngine.getProviderForSession(activeId);
			if (!providerId) {
				providerId =
					model && isClaudeProvider(model.providerID) ? "claude" : "opencode";
			}

			// Persist user message for Claude sessions (non-fatal)
			if (providerId === "claude" && claudeEventPersistOption._tag === "Some") {
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
			const eventSink =
				providerId === "claude"
					? createRelayEventSink({
							sessionId: activeId,
							send: (msg) => wsHandler.sendToSession(activeId, msg),
							clearTimeout: () => overrides.clearProcessingTimeout(activeId),
							resetTimeout: () => overrides.resetProcessingTimeout(activeId),
							...(claudeEventPersistOption._tag === "Some"
								? { persist: claudeEventPersistOption.value }
								: {}),
							permissionBridge,
							questionBridge,
						})
					: NOOP_EVENT_SINK;

			const sendTurnInput: SendTurnInput = {
				sessionId: activeId,
				turnId: crypto.randomUUID(),
				prompt: text,
				history: [],
				providerState:
					providerStateOption._tag === "Some"
						? (providerStateOption.value.getState(activeId) ?? {})
						: {},
				...(model && overrides.isModelUserSelected(activeId)
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
			};

			// Fire-and-forget: the engine manages the turn lifecycle.
			// Use Effect.catchAll for send failure recovery (sends error to client).
			void orchestrationEngine
				.dispatch({
					type: "send_turn",
					providerId,
					input: sendTurnInput,
				})
				.then((result) => {
					if (result.status === "error") {
						const msg = result.error?.message ?? "Send failed";
						log.warn(
							`client=${clientId} session=${activeId} engine dispatch error: ${msg}`,
						);
						overrides.clearProcessingTimeout(activeId);
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
						try {
							if (providerStateOption._tag === "Some") {
								providerStateOption.value.saveUpdates(
									activeId,
									result.providerStateUpdates.map((u) => ({
										key: u.key,
										value: String(u.value),
									})),
								);
							}
						} catch {
							// Non-fatal
						}
					}
					// Auto-rename Claude sessions after first successful turn
					if (result.status !== "error" && providerId === "claude") {
						const turnCount = result.providerStateUpdates?.find(
							(u) => u.key === "turnCount",
						)?.value;
						if (Number(turnCount) === 1) {
							const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
							sessionMgr
								.listSessions()
								.then(async (sessions) => {
									const session = sessions.find((s) => s.id === activeId);
									const currentTitle = session?.title ?? "";
									const isDefault =
										!currentTitle ||
										currentTitle === "Claude Session" ||
										currentTitle.startsWith("New session");
									if (isDefault) {
										await sessionMgr.renameSession(activeId, title);
									}
								})
								.catch((err) => {
									log.warn(
										`Auto-rename failed for ${activeId}: ${err instanceof Error ? err.message : err}`,
									);
								});
						}
					}
				})
				.catch((sendErr) => {
					// Send failure — send error to client and broadcast done (intentional recovery)
					log.warn(
						`client=${clientId} session=${activeId} Failed to send message:`,
						formatErrorDetail(sendErr),
					);
					overrides.clearProcessingTimeout(activeId);
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
				overrides.clearProcessingTimeout(activeId);
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
		const overrides = yield* SessionOverridesTag;
		const log = yield* LoggerTag;

		const activeId = wsHandler.getClientSession(clientId);
		if (activeId) {
			log.info(`client=${clientId} session=${activeId} Aborting`);
			overrides.clearProcessingTimeout(activeId);

			// Route through OrchestrationEngine for Claude sessions
			const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
			if (engineOption._tag === "Some") {
				const engine = engineOption.value;
				const providerId = engine.getProviderForSession(activeId);
				if (providerId === "claude") {
					const interruptResult = yield* Effect.either(
						Effect.tryPromise(() =>
							engine.dispatch({
								type: "interrupt_turn",
								sessionId: activeId,
							}),
						),
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
		const sessionMgr = yield* SessionManagerTag;
		const log = yield* LoggerTag;

		const messageId = payload.messageId ?? payload.uuid ?? "";
		const activeId = wsHandler.getClientSession(clientId);
		if (messageId && activeId) {
			yield* Effect.tryPromise(() =>
				client.session.revert(activeId, { messageID: messageId }),
			);
			sessionMgr.clearPaginationCursor(activeId);
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
