import { Effect } from "effect";
import type { ProviderInstanceId } from "../contracts/provider-instance.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { forkSession } from "../domain/relay/Services/session-command.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	selectSessionModel,
	selectSessionVariant,
} from "../domain/relay/Services/session-model-settings.js";
import { clearSession as clearEffectOverrideSession } from "../domain/relay/Services/session-overrides-state.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
} from "../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import { savedVariantFor } from "./model.js";
import { getSessionInputDraft } from "./prompt.js";

interface ViewSessionPayload {
	readonly sessionId: string;
}

interface NewSessionPayload {
	readonly title?: string;
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
}

interface DeleteSessionPayload {
	readonly sessionId: string;
}

interface ForkSessionPayload {
	readonly sessionId?: string;
	readonly messageId?: string;
}

/**
 * Send the session goal to a client. It is supplementary to the transcript and
 * selection RPCs; pending permissions and questions come from the approvals
 * subscription (ni8.9), the family from SubscribeSessionFamily (ni8.28).
 */
const sendSessionMetadata = (clientId: string, id: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const row = yield* readQuery.getSession(id);
		wsHandler.sendTo(clientId, {
			type: "session.goal_changed",
			...(row ? sessionGoalState(row) : { sessionId: id, goal: null }),
		});
	});

const shouldStartOpenCodePoller = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;

		const rowResult = yield* Effect.either(readQuery.getSession(sessionId));
		if (rowResult._tag === "Left") return true;

		const row = rowResult.right;
		return !row || row.provider === "opencode";
	});

const switchClientToSession = (
	clientId: string,
	sessionId: string,
	options?: { skipPollerSeed?: boolean },
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;
		const pollerManager = yield* PollerManagerTag;

		wsHandler.setClientSession(clientId, sessionId);

		const canUseOpenCodePoller = yield* shouldStartOpenCodePoller(sessionId);
		if (
			canUseOpenCodePoller &&
			!options?.skipPollerSeed &&
			!pollerManager.isPolling(sessionId)
		) {
			pollerManager.startPolling(sessionId);
		}
	});

export const viewSessionForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;

		const id = sessionId;
		if (!id) return { draft: "" };

		yield* switchClientToSession(clientId, id);

		// No read state here: a switch also fires on restore, reload and
		// reconnect. The browser reports a user's sidebar pick through
		// session.mark_seen instead (ADR-0004, Scope; conduit-test-hk9m.3).

		// Run metadata send as a forked fiber — non-blocking
		yield* Effect.either(sendSessionMetadata(clientId, id));

		log.info(`client=${clientId} Viewing: ${id}`);
		return { draft: getSessionInputDraft(id) };
	});

export const handleViewSession = (
	clientId: string,
	payload: ViewSessionPayload,
) =>
	viewSessionForClient({
		clientId,
		sessionId: payload.sessionId,
	});

export const createSessionForClient = ({
	clientId,
	title,
	instanceId,
	providerId,
	model,
}: {
	readonly clientId: string;
	readonly title?: string;
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
	readonly model?: {
		readonly modelId: string;
		readonly providerId: string;
		readonly variant?: string | undefined;
	};
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const session =
			instanceId != null || providerId != null
				? yield* sessionManagerService.createSession(title, {
						...(instanceId != null ? { instanceId } : {}),
						...(providerId != null ? { providerId } : {}),
					})
				: yield* sessionManagerService.createSession(title);
		if (model) {
			const override = { providerID: model.providerId, modelID: model.modelId };
			yield* selectSessionModel(session.id, override);
			// The draft lists the default model's efforts, so keep a picked
			// effort only if this model offers it. Without one, use the model's
			// saved effort: the first turn would otherwise inherit the default's.
			const { variant: saved, variants } = yield* savedVariantFor(override);
			const picked = model.variant;
			yield* selectSessionVariant(
				session.id,
				picked === "" || (picked !== undefined && variants.includes(picked))
					? picked
					: saved,
			);
		}

		yield* switchClientToSession(clientId, session.id, {
			skipPollerSeed: true,
		});

		log.info(`client=${clientId} Created: ${session.id}`);
		return session;
	});

export const handleNewSession = (
	clientId: string,
	payload: NewSessionPayload,
) =>
	createSessionForClient({
		clientId,
		...(payload.title != null ? { title: payload.title } : {}),
		...(payload.instanceId != null ? { instanceId: payload.instanceId } : {}),
		...(payload.providerId != null ? { providerId: payload.providerId } : {}),
	}).pipe(Effect.asVoid);

export const handleSwitchSession = (
	clientId: string,
	payload: ViewSessionPayload,
) => handleViewSession(clientId, payload);

export const deleteSessionForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const id = sessionId;
		if (!id) return;

		const didDelete = yield* sessionManagerService.deleteSession(id);
		if (!didDelete) return;

		// Id only, no row: tabs prune the daemon-wide list and search results,
		// which the per-project shell feed does not cover.
		wsHandler.broadcast({ type: "session_deleted", sessionId: id });
		log.info(`client=${clientId} Deleted: ${id}`);
	});

export const handleDeleteSession = (
	clientId: string,
	payload: DeleteSessionPayload,
) =>
	deleteSessionForClient({
		clientId,
		sessionId: payload.sessionId,
	});

export const renameSessionForClient = ({
	clientId,
	sessionId,
	title,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly title: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const id = sessionId;
		if (id && title) {
			yield* sessionManagerService.renameSession(id, title);
			log.info(`client=${clientId} Renamed: ${id} → ${title}`);
		}
	});

export const setSessionSettledForClient = ({
	clientId,
	sessionId,
	settled,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly settled: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.setSessionSettled(sessionId, { settled })) {
			const config = yield* Effect.serviceOption(ConfigTag);
			if (config._tag === "Some" && config.value.broadcastSessionListChanged) {
				yield* Effect.tryPromise(config.value.broadcastSessionListChanged).pipe(
					Effect.catchAll(() => Effect.void),
				);
			}
			log.info(`client=${clientId} Set settled=${settled}: ${sessionId}`);
		}
	});

export const setSessionPinnedForClient = ({
	clientId,
	sessionId,
	pinned,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly pinned: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.setSessionPinned(sessionId, pinned)) {
			log.info(`client=${clientId} Set pinned=${pinned}: ${sessionId}`);
		}
	});

export const setSessionAutoSettleForClient = ({
	clientId,
	sessionId,
	disabled,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly disabled: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.setSessionAutoSettleDisabled(sessionId, disabled)) {
			const config = yield* Effect.serviceOption(ConfigTag);
			if (config._tag === "Some" && config.value.broadcastSessionListChanged) {
				yield* Effect.tryPromise(config.value.broadcastSessionListChanged).pipe(
					Effect.catchAll(() => Effect.void),
				);
			}
			log.info(
				`client=${clientId} Set auto-settle disabled=${disabled}: ${sessionId}`,
			);
		}
	});

export const snoozeSessionForClient = ({
	clientId,
	sessionId,
	until,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly until: number | null;
}) =>
	Effect.gen(function* () {
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.snoozeSession(sessionId, until)) {
			log.info(`client=${clientId} Snoozed: ${sessionId}`);
		}
	});

export const unsnoozeSessionForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.unsnoozeSession(sessionId)) {
			log.info(`client=${clientId} Unsnoozed: ${sessionId}`);
		}
	});

export const markSessionUnreadForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionUnread(sessionId);
			log.info(`client=${clientId} Marked unread: ${sessionId}`);
		}
	});

export const markSessionSeenForClient = ({
	clientId,
	sessionId,
	upTo,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly upTo: number;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		// A failed save leaves the row unread; the typed error goes back to the
		// caller and nothing retries it (conduit-test-hk9m.6).
		const changed = yield* sessionManagerService
			.markSessionSeen(sessionId, upTo)
			.pipe(
				Effect.tapError((error) =>
					Effect.sync(() =>
						log.warn(
							`client=${clientId} Mark seen failed: ${sessionId} up to ${upTo}`,
							error,
						),
					),
				),
			);
		if (changed) {
			log.info(`client=${clientId} Marked seen: ${sessionId} up to ${upTo}`);
		}
	});

export const markSessionReadForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionRead(sessionId);
			log.info(`client=${clientId} Marked read: ${sessionId}`);
		}
	});

export const loadMoreHistoryForSession = ({
	sessionId,
	before,
}: {
	readonly sessionId: string;
	readonly before?: string;
}) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const page = yield* readQuery.readSessionTranscriptPage(sessionId, {
			...(before ? { before } : {}),
			limit: 50,
		});
		return {
			sessionId,
			messages: messageRowsToHistory(page.messages, {
				pageSize: page.messages.length,
				toolOutputPreview: true,
			}).messages,
			hasMore: page.hasMore,
		};
	});

export const forkSessionForClient = ({
	clientId,
	sessionId: requestedSessionId,
	messageId,
}: {
	readonly clientId: string;
	readonly sessionId?: string;
	readonly messageId?: string;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const sessionId =
			requestedSessionId || wsHandler.getClientSession(clientId) || "";
		if (!sessionId) return undefined;
		const log = yield* LoggerTag;

		// Through the seam: forking upstream and forgetting to record the forked
		// session locally is the same parity gap as creating one and forgetting.
		const forked = yield* forkSession(
			sessionId,
			messageId === undefined ? undefined : { messageId },
		);

		yield* clearEffectOverrideSession(sessionId);

		// Find the parent title for the notification
		const sessions = yield* sessionManagerService.listSessions();
		const parent = sessions.find((s) => s.id === sessionId);
		const persistedFork = sessions.find((s) => s.id === forked.id);
		const forkMessageId = persistedFork?.forkMessageId ?? forked.forkMessageId;
		const forkPointTimestamp =
			persistedFork?.forkPointTimestamp ??
			("forkPointTimestamp" in forked &&
			typeof forked.forkPointTimestamp === "number"
				? forked.forkPointTimestamp
				: undefined);

		// Broadcast the fork notification
		wsHandler.broadcast({
			type: "session_forked",
			sessionId: forked.id,
			...(forkMessageId && { forkMessageId }),
			...(forkPointTimestamp != null && { forkPointTimestamp }),
			parentId: sessionId,
			parentTitle: parent?.title ?? "Unknown",
		});

		log.info(
			`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
		);

		return forked;
	});

/** Fork a session at a specific message point (ticket 5.3). */
export const handleForkSession = (
	clientId: string,
	payload: ForkSessionPayload,
) =>
	forkSessionForClient({
		clientId,
		...(payload.sessionId != null ? { sessionId: payload.sessionId } : {}),
		...(payload.messageId != null ? { messageId: payload.messageId } : {}),
	}).pipe(Effect.asVoid);
