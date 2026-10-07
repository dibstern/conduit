import { Data, Effect } from "effect";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { publishInputDraft } from "../domain/relay/Services/input-drafts.js";
import { PendingSendOwnershipTag } from "../domain/relay/Services/pending-send-ownership.js";
import { ProviderTurnServiceTag } from "../domain/relay/Services/provider-turn-service.js";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	getContextWindow,
	getModel,
	getVariant,
	isModelUserSelected,
	PROCESSING_TIMEOUT_DURATION,
	startProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { makeFailTurn } from "../domain/relay/Services/turn-failure.js";

// Stores the last draft per session so that a tab switching to it (e.g. on a
// different device) reads the current draft in its ViewSession response.

const sessionInputDrafts = new Map<string, string>();

interface LegacyMessagePayload {
	text: string;
	images?: string[];
	commandId?: string;
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
	readonly commandId: string;
}

export const sendMessageToSession = (input: SendMessageToSessionInput) =>
	Effect.gen(function* () {
		const ownership = yield* PendingSendOwnershipTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const { clientId, text, images, originId } = input;
		const imageList =
			images && images.length > 0 ? Array.from(images) : undefined;
		let activeId = input.sessionId;
		if (!text) return activeId;
		if (!activeId) {
			log.warn(`client=${clientId} send_turn dropped: no active session`);
			return activeId;
		}
		const originalActiveId = activeId;
		const sessionModel = yield* getModel(activeId);
		const sessionModelUserSelected = yield* isModelUserSelected(activeId);
		const providerTurnService = yield* ProviderTurnServiceTag;
		activeId = yield* providerTurnService.prepareTurnSession({
			clientId,
			commandId: input.commandId,
			sessionId: activeId,
			...(sessionModel ? { model: sessionModel } : {}),
			modelUserSelected: sessionModelUserSelected,
		});
		// Talking to a settled or snoozed session brings it back. Triage bookkeeping must
		// never stop the message itself, so a failure here is only logged.
		yield* Effect.gen(function* () {
			yield* sessionManagerService
				.unsnoozeSession(activeId)
				.pipe(
					Effect.catchAll((error) =>
						Effect.sync(() =>
							log.warn(`Failed to un-snooze ${activeId}: ${String(error)}`),
						),
					),
				);
			yield* sessionManagerService.setSessionSettled(activeId, {
				settled: false,
			});
		}).pipe(
			Effect.catchAll((error) =>
				Effect.sync(() =>
					log.warn(`Failed to un-settle ${activeId}: ${String(error)}`),
				),
			),
		);
		log.info(
			`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		);

		// Clear the input draft
		if (originalActiveId !== activeId) clearSessionInputDraft(originalActiveId);
		clearSessionInputDraft(activeId);

		// Track message activity
		yield* sessionManagerService.recordMessageActivity(activeId);

		const agentService = yield* AgentServiceTag;
		const sessionAgent = yield* agentService.getActiveAgent(activeId);
		const variant = yield* getVariant(activeId);
		const contextWindow = yield* getContextWindow(activeId);

		const failTurn = yield* makeFailTurn;
		yield* startProcessingTimeout(activeId, PROCESSING_TIMEOUT_DURATION, () =>
			Effect.suspend(() => {
				ownership.remove(activeId, input.commandId);
				log.warn(
					`client=${clientId} session=${activeId} Processing timeout (120s) — failing the turn`,
				);
				return failTurn(
					activeId,
					"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
					"PROCESSING_TIMEOUT",
				);
			}),
		);

		ownership.register(activeId, {
			commandId: input.commandId,
			text,
			originId: originalActiveId === activeId ? originId : undefined,
		});
		yield* providerTurnService
			.sendTurn({
				clientId,
				sessionId: activeId,
				text,
				commandId: input.commandId,
				...(imageList ? { images: imageList } : {}),
				...(sessionModel ? { model: sessionModel } : {}),
				modelUserSelected: sessionModelUserSelected,
				...(sessionAgent ? { agent: sessionAgent } : {}),
				...(variant ? { variant } : {}),
				...(contextWindow ? { contextWindow } : {}),
			})
			.pipe(
				Effect.onError(() =>
					Effect.sync(() => {
						ownership.remove(activeId, input.commandId);
					}),
				),
			);
		return activeId;
	});

export const handleMessage = (
	clientId: string,
	payload: LegacyMessagePayload,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		if (!payload.text) return;
		if (!payload.commandId) {
			log.warn(`client=${clientId} send_turn dropped: missing commandId`);
			return;
		}
		yield* sendMessageToSession({
			clientId,
			sessionId: wsHandler.getClientSession(clientId),
			text: payload.text,
			commandId: payload.commandId,
			...(payload.images ? { images: payload.images } : {}),
		});
	});

export const cancelSessionById = (
	clientId: string,
	sessionId: string,
	commandId: string,
) =>
	Effect.gen(function* () {
		const providerTurnService = yield* ProviderTurnServiceTag;
		yield* providerTurnService.interruptTurn({
			clientId,
			commandId,
			sessionId,
		});
	});

export class RewindTargetNotFound extends Data.TaggedError(
	"RewindTargetNotFound",
)<{
	readonly sessionId: string;
	readonly messageId: string;
	readonly message: string;
}> {}

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
		const log = yield* LoggerTag;

		const messages = yield* Effect.tryPromise(() =>
			client.session.messages(sessionId),
		);
		if (!messages.some((message) => message.id === messageId)) {
			return yield* Effect.fail(
				new RewindTargetNotFound({
					sessionId,
					messageId,
					message: `Rewind target ${messageId} not found in session ${sessionId}`,
				}),
			);
		}
		yield* Effect.tryPromise(() =>
			client.session.revert(sessionId, { messageID: messageId }),
		);
		log.info(
			`client=${clientId} session=${sessionId} Reverted to message: ${messageId}`,
		);
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
		// Store the draft so a tab switching to the session reads it
		if (text) {
			sessionInputDrafts.set(sessionId, text);
		} else {
			sessionInputDrafts.delete(sessionId);
		}

		yield* publishInputDraft({ sessionId, text, ...(from ? { from } : {}) });
	});
