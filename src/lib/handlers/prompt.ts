import { Effect } from "effect";
import type { InputDelivery, SteerBlocker } from "../contracts/stored-event.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { publishInputDraft } from "../domain/relay/Services/input-drafts.js";
import { ProviderTurnServiceTag } from "../domain/relay/Services/provider-turn-service.js";
import {
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";

// Stores the last draft per session so that a tab switching to it (e.g. on a
// different device) reads the current draft in its ViewSession response.
// A cleared draft stays as "": after a restart the map is empty, and a missing
// entry must read as "unknown" so it cannot erase the draft a tab still holds.

const sessionInputDrafts = new Map<string, string>();

interface LegacyMessagePayload {
	text: string;
	images?: string[];
	commandId?: string;
}

/** The stored input draft for a session, or undefined if this process never saw one. */
export function getSessionInputDraft(sessionId: string): string | undefined {
	return sessionInputDrafts.get(sessionId);
}

/** Clear the stored input draft for a session (e.g. after sending a message). */
export function clearSessionInputDraft(sessionId: string): void {
	sessionInputDrafts.set(sessionId, "");
}

export interface SendMessageToSessionInput {
	readonly clientId: string;
	readonly sessionId: string | undefined;
	readonly text: string;
	readonly images?: readonly string[];
	readonly commandId: string;
	/** A steer joins the running turn of a busy session, or is refused. */
	readonly delivery?: InputDelivery;
}

export type SendMessageToSessionResult = {
	readonly sessionId: string | undefined;
} & (
	| { readonly handedOff: boolean; readonly refused?: never }
	/** Why the steer was refused; nothing was admitted. */
	| { readonly refused: SteerBlocker; readonly handedOff?: never }
);

export const sendMessageToSession = (input: SendMessageToSessionInput) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const { clientId, text, images } = input;
		const imageList =
			images && images.length > 0 ? Array.from(images) : undefined;
		let activeId = input.sessionId;
		if (!text)
			return {
				sessionId: activeId,
				handedOff: false,
			} satisfies SendMessageToSessionResult;
		if (!activeId) {
			log.warn(`client=${clientId} send_turn dropped: no active session`);
			return {
				sessionId: activeId,
				handedOff: false,
			} satisfies SendMessageToSessionResult;
		}
		const originalActiveId = activeId;
		const read = yield* ReadQueryEffectTag;
		const originalSession = yield* read.getSession(activeId);
		const sessionModel =
			originalSession?.model_id && originalSession.model_provider
				? {
						modelID: originalSession.model_id,
						providerID: originalSession.model_provider,
					}
				: undefined;
		const providerTurnService = yield* ProviderTurnServiceTag;
		activeId = yield* providerTurnService.prepareTurnSession({
			clientId,
			commandId: input.commandId,
			sessionId: activeId,
			...(sessionModel ? { model: sessionModel } : {}),
			...(input.delivery === "steer" ? { delivery: input.delivery } : {}),
		});
		// Restore all triage state under one lock. Bookkeeping failures are logged
		// inside the service so they never prevent delivery of the message.
		yield* sessionManagerService
			.restoreSessionForSend(activeId)
			.pipe(
				Effect.catch((error) =>
					Effect.sync(() =>
						log.warn(`Failed to restore ${activeId} on send: ${String(error)}`),
					),
				),
			);
		log.info(
			`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
		);

		// Track message activity
		yield* sessionManagerService.recordMessageActivity(activeId);

		// The inbox records the session pick; dispatch re-reads the durable pick.
		const agentService = yield* AgentServiceTag;
		const sessionAgent = yield* agentService.getActiveAgent(activeId);
		const session =
			activeId === originalActiveId
				? originalSession
				: yield* read.getSession(activeId);
		const model =
			session?.model_id && session.model_provider
				? { modelID: session.model_id, providerID: session.model_provider }
				: undefined;

		const inbox = yield* SessionInboxTag;
		const submitted = yield* inbox.submit({
			clientId,
			sessionId: activeId,
			inputId: input.commandId,
			delivery: input.delivery ?? "queue",
			request: {
				text,
				...(imageList ? { images: imageList } : {}),
				...(model ? { model } : {}),
				...(sessionAgent ? { agent: sessionAgent } : {}),
				variant: session?.variant ?? "",
				contextWindow: session?.context_window ?? "",
			},
		});
		// A refused steer admitted nothing: the text stays in the input box.
		if ("refused" in submitted)
			return {
				sessionId: activeId,
				refused: submitted.refused,
			} satisfies SendMessageToSessionResult;
		if (originalActiveId !== activeId) clearSessionInputDraft(originalActiveId);
		clearSessionInputDraft(activeId);
		return {
			sessionId: activeId,
			handedOff: submitted.handedOff,
		} satisfies SendMessageToSessionResult;
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

export {
	RewindTargetNotFound,
	RewindUnavailable,
	rewindSessionToMessage,
	undoSessionRewind,
} from "../domain/relay/Services/session-rewind.js";

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
		sessionInputDrafts.set(sessionId, text);

		yield* publishInputDraft({ sessionId, text, ...(from ? { from } : {}) });
	});
