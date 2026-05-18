import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { Effect } from "effect";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import {
	isProviderTurnInterruptProvider,
	makeProviderTurnService,
	ProviderTurnServiceTag,
} from "../domain/relay/Services/provider-turn-service.js";
import {
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	clearProcessingTimeout,
	getAgent,
	getContextWindow,
	getModel,
	getVariant,
	isModelUserSelected,
	PROCESSING_TIMEOUT_DURATION,
	startProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { formatErrorDetail, RelayError } from "../errors.js";

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
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

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

		const agentServiceOption = yield* Effect.serviceOption(AgentServiceTag);
		const sessionAgent =
			agentServiceOption._tag === "Some"
				? yield* agentServiceOption.value.getActiveAgent(activeId)
				: yield* getAgent(activeId);
		const sessionModel = yield* getModel(activeId);
		const sessionModelUserSelected = yield* isModelUserSelected(activeId);
		const variant = yield* getVariant(activeId);
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

		const providerTurnServiceOption = yield* Effect.serviceOption(
			ProviderTurnServiceTag,
		);
		const providerTurnService =
			providerTurnServiceOption._tag === "Some"
				? providerTurnServiceOption.value
				: yield* makeProviderTurnService;
		yield* providerTurnService.sendTurn({
			clientId,
			sessionId: activeId,
			text,
			...(imageList ? { images: imageList } : {}),
			...(sessionModel ? { model: sessionModel } : {}),
			modelUserSelected: sessionModelUserSelected,
			...(sessionAgent ? { agent: sessionAgent } : {}),
			...(variant ? { variant } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(input.errorDelivery ? { errorDelivery: input.errorDelivery } : {}),
		});
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

		const providerTurnServiceOption = yield* Effect.serviceOption(
			ProviderTurnServiceTag,
		);
		if (providerTurnServiceOption._tag === "Some") {
			const interrupted = yield* providerTurnServiceOption.value.interruptTurn({
				clientId,
				sessionId,
			});
			if (interrupted) return;
		}
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		if (engineOption._tag === "Some") {
			const engine = engineOption.value;
			const providerId = engine.getProviderForSession(sessionId);
			if (providerId && isProviderTurnInterruptProvider(providerId)) {
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
