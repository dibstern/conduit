import { Effect } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import type { ProviderInstanceId } from "../contracts/provider-instance.js";
import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { forkSession } from "../domain/relay/Services/session-command.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	clearSession as clearEffectOverrideSession,
	hasActiveProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import {
	ReadQueryEffectTag,
	sessionGoalState,
} from "../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import { busySessionIds } from "../session-busy.js";
import type { PermissionId } from "../shared-types.js";
import { getSessionInputDraft } from "./prompt.js";

const SESSION_METADATA_FANOUT = 4;

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
 * Send metadata (model info, permissions, questions, viewed family) to a client.
 * These are supplementary data to the transcript and selection RPCs.
 */
const sendSessionMetadata = (clientId: string, id: string) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const family = yield* sessionManagerService.getSessionFamily(id);
		const familyIds = new Set([
			id,
			...family.sessions.map((session) => session.id),
		]);
		const readQuery = yield* ReadQueryEffectTag;
		const row = yield* readQuery.getSession(id);
		wsHandler.sendTo(clientId, {
			type: "session.goal_changed",
			...(row ? sessionGoalState(row) : { sessionId: id, goal: null }),
		});

		// Run all metadata sends concurrently, catching errors individually
		yield* Effect.all(
			[
				// Model info
				Effect.gen(function* () {
					const session = yield* modelService.getSession(id);
					if (session.modelID) {
						wsHandler.sendTo(clientId, {
							type: "model_info",
							sessionId: id,
							model: session.modelID,
							provider: session.providerID ?? "",
						});
					}
				}).pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to get model info for ${id}: ${err instanceof Error ? err.message : err}`,
							),
						),
					),
				),

				// Pending permissions (service + API)
				Effect.gen(function* () {
					const bridgePending =
						yield* pendingInteractions.listPendingPermissions();
					const sentPermissionIds = new Set<string>();
					for (const { timestamp: _, ...perm } of bridgePending) {
						if (!familyIds.has(perm.sessionId)) continue;
						// Spread, not a field list: a reload must rebuild the same card
						// the live prompt showed (title, description, reason).
						wsHandler.sendTo(clientId, { type: "permission_request", ...perm });
						sentPermissionIds.add(perm.requestId);
					}
					const apiPermissions = yield* Effect.tryPromise(() =>
						client.permission.list(),
					);
					for (const p of apiPermissions) {
						const pSessionId = (p as { sessionID?: string }).sessionID ?? "";
						if (pSessionId && !familyIds.has(pSessionId)) continue;
						if (sentPermissionIds.has(p.id)) continue;
						wsHandler.sendTo(clientId, {
							type: "permission_request",
							sessionId: pSessionId,
							requestId: p.id as PermissionId,
							toolName: p.permission,
							toolInput: {
								patterns: (p as { patterns?: string[] }).patterns ?? [],
								metadata:
									(p as { metadata?: Record<string, unknown> }).metadata ?? {},
							},
						});
					}
				}).pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to replay pending permissions for ${id}: ${err instanceof Error ? err.message : err}`,
							),
						),
					),
				),

				// Pending questions (bridge + API)
				Effect.gen(function* () {
					const sentQuestionIds = new Set<string>();

					const servicePendingQuestions =
						yield* pendingInteractions.listPendingQuestions();
					for (const pq of servicePendingQuestions) {
						if (pq.sessionId && !familyIds.has(pq.sessionId)) continue;
						wsHandler.sendTo(clientId, {
							type: "ask_user",
							sessionId: pq.sessionId || id,
							toolId: pq.requestId,
							questions: pq.questions.map((q) => ({
								question: q.question,
								header: q.header ?? "",
								options: (q.options ?? []) as Array<{
									label: string;
									description?: string;
								}>,
								multiSelect: q.multiSelect ?? false,
							})),
							...(pq.toolCallId ? { toolUseId: pq.toolCallId } : {}),
							...(pq.providerId ? { providerId: pq.providerId } : {}),
						});
						sentQuestionIds.add(pq.requestId);
					}

					const pendingQuestions = yield* Effect.tryPromise(() =>
						client.question.list(),
					);
					for (const pq of pendingQuestions) {
						const qSessionId = pq["sessionID"] as string | undefined;
						if (qSessionId && !familyIds.has(qSessionId)) continue;
						if (sentQuestionIds.has(pq.id)) continue;

						const rawQuestions = pq["questions"] as
							| Array<{
									question?: string;
									header?: string;
									options?: Array<{
										label?: string;
										description?: string;
									}>;
									multiple?: boolean;
									custom?: boolean;
							  }>
							| undefined;
						if (!Array.isArray(rawQuestions)) continue;
						const questions = mapQuestionFields(rawQuestions);
						const tool = pq["tool"] as { callID?: string } | undefined;
						const toolCallId = tool?.callID;
						wsHandler.sendTo(clientId, {
							type: "ask_user",
							sessionId: qSessionId || id,
							toolId: pq.id,
							questions,
							providerId: "opencode",
							...(toolCallId ? { toolUseId: toolCallId } : {}),
						});
					}
				}).pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to replay pending questions for ${id}: ${err instanceof Error ? err.message : err}`,
							),
						),
					),
				),

				// Viewed family
				sessionManagerService
					.pushViewerFamilies()
					.pipe(
						Effect.catchAll((err) =>
							Effect.sync(() =>
								log.warn(
									`Failed to push viewed family to ${clientId}: ${err instanceof Error ? err.message : err}`,
								),
							),
						),
					),
			],
			{ concurrency: SESSION_METADATA_FANOUT, discard: true },
		);
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
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const hasActiveTimeout = yield* hasActiveProcessingTimeout(sessionId);

		wsHandler.setClientSession(clientId, sessionId);

		const sessionService = yield* SessionManagerServiceTag;
		const family = yield* sessionService.getSessionFamily(sessionId);
		wsHandler.sendTo(clientId, family);

		// The poller is cold until its first poll and never starts without
		// OpenCode, so the persisted family (children included) also counts.
		const isProcessing =
			busySessionIds(
				new Map(family.sessions.map((session) => [session.id, session])),
			).has(sessionId) ||
			(yield* statusPoller.isProcessing(sessionId)) ||
			hasActiveTimeout;
		wsHandler.sendTo(clientId, {
			type: "status",
			sessionId,
			status: isProcessing ? "processing" : "idle",
		});

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
}: {
	readonly clientId: string;
	readonly title?: string;
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
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

		yield* switchClientToSession(clientId, session.id, {
			skipPollerSeed: true,
		});

		yield* Effect.forkDaemon(
			sessionManagerService
				.pushViewerFamilies()
				.pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to push viewed families after CreateSession: ${err}`,
							),
						),
					),
				),
		);

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
		yield* sessionManagerService.pushViewerFamilies();
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
			yield* sessionManagerService.pushViewerFamilies();
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
			yield* service.pushViewerFamilies();
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
			yield* service.pushViewerFamilies();
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
			yield* service.pushViewerFamilies();
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
			yield* service.pushViewerFamilies();
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
			yield* service.pushViewerFamilies();
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
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionUnread(sessionId);
			yield* sessionManagerService.pushViewerFamilies();
			wsHandler.sendToSession(
				sessionId,
				yield* sessionManagerService.getSessionFamily(sessionId),
			);
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
			yield* sessionManagerService.pushViewerFamilies();
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
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionRead(sessionId);
			yield* sessionManagerService.pushViewerFamilies();
			wsHandler.sendToSession(
				sessionId,
				yield* sessionManagerService.getSessionFamily(sessionId),
			);
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
			messages: messageRowsToHistory(page.messages, { pageSize: 50 }).messages,
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

		// Refresh the viewed family after the fork.
		yield* sessionManagerService.pushViewerFamilies();

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
