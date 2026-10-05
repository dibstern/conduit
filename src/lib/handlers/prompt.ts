import { Data, Effect } from "effect";
import type { InputDelivery } from "../contracts/stored-event.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { ProviderTurnServiceTag } from "../domain/relay/Services/provider-turn-service.js";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	getContextWindow,
	getModel,
	getVariant,
	isModelUserSelected,
} from "../domain/relay/Services/session-overrides-state.js";
import { RelayError } from "../errors.js";

// Stores the last input_sync text per session so that newly connecting clients
// (e.g. opening on a different device) receive the current draft.

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
	readonly excludeClientId?: string;
	readonly missingSessionClientId?: string;
	readonly errorDelivery?: "client" | "session";
	/** Only `queue` is honoured for now; a steer is queued like any input. */
	readonly delivery?: InputDelivery;
}

export const sendMessageToSession = (input: SendMessageToSessionInput) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const { clientId, text, images, originId, excludeClientId } = input;
		const imageList =
			images && images.length > 0 ? Array.from(images) : undefined;
		let activeId = input.sessionId;
		if (!text) return activeId;
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
			const unsnoozed = yield* sessionManagerService
				.unsnoozeSession(activeId)
				.pipe(
					Effect.catchAll((error) =>
						Effect.sync(() => {
							log.warn(`Failed to un-snooze ${activeId}: ${String(error)}`);
							return false;
						}),
					),
				);
			const unsettled = yield* sessionManagerService.setSessionSettled(
				activeId,
				{ settled: false },
			);
			if (unsnoozed || unsettled) {
				yield* sessionManagerService.pushViewerFamilies();
			}
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

		// The request is captured now: a queued input keeps what was selected
		// when it was sent, whatever changes before it is handed off.
		const agentService = yield* AgentServiceTag;
		const sessionAgent = yield* agentService.getActiveAgent(activeId);
		const variant = yield* getVariant(activeId);
		const contextWindow = yield* getContextWindow(activeId);

		const inbox = yield* SessionInboxTag;
		const { handedOff } = yield* inbox.submit({
			clientId,
			sessionId: activeId,
			inputId: input.commandId,
			delivery: input.delivery ?? "queue",
			request: {
				text,
				...(imageList ? { images: imageList } : {}),
				...(sessionModel ? { model: sessionModel } : {}),
				modelUserSelected: sessionModelUserSelected,
				...(sessionAgent ? { agent: sessionAgent } : {}),
				...(variant ? { variant } : {}),
				...(contextWindow ? { contextWindow } : {}),
			},
			...(input.errorDelivery ? { errorDelivery: input.errorDelivery } : {}),
		});

		// Send user_message to OTHER clients viewing this session
		if (handedOff) {
			for (const targetId of wsHandler.getClientsForSession(activeId)) {
				if (targetId !== excludeClientId) {
					wsHandler.sendTo(targetId, {
						type: "user_message",
						sessionId: activeId,
						text,
						...(originId && originalActiveId === activeId ? { originId } : {}),
					});
				}
			}
		}
		return activeId;
	});

export const handleMessage = (
	clientId: string,
	payload: LegacyMessagePayload,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		if (!payload.text) return;
		if (!payload.commandId) {
			wsHandler.sendTo(
				clientId,
				new RelayError(
					"Missing commandId for mutating provider command: send_turn",
					{ code: "MISSING_COMMAND_ID" },
				).toSystemError(),
			);
			return;
		}
		yield* sendMessageToSession({
			clientId,
			sessionId: wsHandler.getClientSession(clientId),
			text: payload.text,
			commandId: payload.commandId,
			...(payload.images ? { images: payload.images } : {}),
			excludeClientId: clientId,
			missingSessionClientId: clientId,
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
