import { Effect } from "effect";
import {
	AttachmentValidationError,
	validateAttachmentDataUrls,
} from "../attachment-data-url.js";
import type { InputDelivery, SteerBlocker } from "../contracts/stored-event.js";
import type { InputDraftKey } from "../contracts/ws-rpc.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { InputDraftsTag } from "../domain/relay/Services/input-drafts.js";
import { ProviderTurnServiceTag } from "../domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";

interface LegacyMessagePayload {
	text: string;
	images?: string[];
	commandId?: string;
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
		// Reject direct RPC payloads before preparing a session or writing its inbox.
		yield* Effect.try({
			try: () => validateAttachmentDataUrls(input.images),
			catch: (cause) =>
				new AttachmentValidationError(
					cause instanceof Error ? cause.message : String(cause),
				),
		});
		const log = yield* LoggerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const { clientId, text, images } = input;
		const imageList =
			images && images.length > 0 ? Array.from(images) : undefined;
		let activeId = input.sessionId;
		if (!text && !imageList)
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
		const drafts = yield* InputDraftsTag;
		if (originalActiveId !== activeId)
			yield* drafts.clearSent(originalActiveId, text);
		yield* drafts.clearSent(activeId, text);
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
		if (!payload.text && !payload.images?.length) return;
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
		const inbox = yield* SessionInboxTag;
		// Fence under the inbox permit, so no handoff is mid-decision; wait outside it.
		const stopped = yield* inbox.withSession(
			sessionId,
			providerTurnService.beginStop({ clientId, commandId, sessionId }),
		);
		yield* stopped;
	});

export {
	RewindTargetNotFound,
	RewindUnavailable,
	rewindSessionToMessage,
	undoSessionRewind,
} from "../domain/relay/Services/session-rewind.js";

export const syncInputDraft = ({
	key,
	text,
	from,
}: {
	key: InputDraftKey;
	text: string;
	from?: string;
}) =>
	Effect.gen(function* () {
		const drafts = yield* InputDraftsTag;
		const projectId = "draft" in key ? (yield* ConfigTag).slug : undefined;
		yield* drafts.write(key, text, from, projectId);
	});
