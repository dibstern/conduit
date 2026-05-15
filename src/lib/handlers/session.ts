import { OpenCodeAPITag } from "../domain/provider/Services/opencode-api-service.js";
// ─── Session Handlers ────────────────────────────────────────────────────────

import { Effect } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	PollerManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	clearSession as clearEffectOverrideSession,
	hasActiveProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	buildSessionSwitchedMessage,
	extractOldestMessageId,
	patchMissingDoneForProcessingState,
	resolveSessionHistoryFromRows,
	type SessionHistorySource,
	type SwitchClientOptions,
} from "../session/session-switch.js";
import type { PermissionId, RelayMessage, RequestId } from "../shared-types.js";
import { getSessionInputDraft } from "./prompt.js";

const SESSION_METADATA_FANOUT = 4;

interface ViewSessionPayload {
	readonly sessionId: string;
}

interface NewSessionPayload {
	readonly title?: string;
	readonly requestId?: RequestId;
}

interface DeleteSessionPayload {
	readonly sessionId: string;
}

interface ForkSessionPayload {
	readonly sessionId?: string;
	readonly messageId?: string;
}

/**
 * Send metadata (model info, permissions, questions, session list) to a client.
 * Independent of session_switched delivery — these are supplementary data.
 */
const sendSessionMetadata = (clientId: string, id: string) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const modelService = yield* OpenCodeModelServiceTag;
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		// Run all metadata sends concurrently, catching errors individually
		yield* Effect.all(
			[
				// Model info
				Effect.gen(function* () {
					const session = yield* modelService.getSession(id);
					if (session.modelID) {
						wsHandler.sendTo(clientId, {
							type: "model_info",
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
						yield* pendingInteractions.listPendingPermissions(id);
					const sentPermissionIds = new Set<string>();
					for (const perm of bridgePending) {
						wsHandler.sendTo(clientId, {
							type: "permission_request",
							sessionId: perm.sessionId,
							requestId: perm.requestId,
							toolName: perm.toolName,
							toolInput: perm.toolInput,
						});
						sentPermissionIds.add(perm.requestId);
					}
					const apiPermissions = yield* Effect.tryPromise(() =>
						client.permission.list(),
					);
					for (const p of apiPermissions) {
						const pSessionId = (p as { sessionID?: string }).sessionID ?? "";
						if (pSessionId && pSessionId !== id) continue;
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
						yield* pendingInteractions.listPendingQuestions(id);
					for (const pq of servicePendingQuestions) {
						if (pq.sessionId && pq.sessionId !== id) continue;
						wsHandler.sendTo(clientId, {
							type: "ask_user",
							sessionId: id,
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
						});
						sentQuestionIds.add(pq.requestId);
					}

					const pendingQuestions = yield* Effect.tryPromise(() =>
						client.question.list(),
					);
					for (const pq of pendingQuestions) {
						const qSessionId = pq["sessionID"] as string | undefined;
						if (qSessionId && qSessionId !== id) continue;
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
							sessionId: id,
							toolId: pq.id,
							questions,
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

				// Session list
				sessionManagerService
					.sendDualSessionLists((msg) => wsHandler.sendTo(clientId, msg))
					.pipe(
						Effect.catchAll((err) =>
							Effect.sync(() =>
								log.warn(
									`Failed to send session list to ${clientId}: ${err instanceof Error ? err.message : err}`,
								),
							),
						),
					),
			],
			{ concurrency: SESSION_METADATA_FANOUT, discard: true },
		);
	});

const resolveSessionHistory = (sessionId: string) =>
	Effect.gen(function* () {
		const readQueryOption = yield* Effect.serviceOption(ReadQueryEffectTag);
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		if (readQueryOption._tag === "Some") {
			const rows =
				yield* readQueryOption.value.getSessionMessagesWithParts(sessionId);
			return resolveSessionHistoryFromRows(rows, { pageSize: 50 });
		}

		const historyResult = yield* Effect.either(
			sessionManagerService.loadPreRenderedHistory(sessionId),
		);
		if (historyResult._tag === "Right") {
			return {
				kind: "rest-history",
				history: historyResult.right,
			} satisfies SessionHistorySource;
		}

		log.warn(`Failed to load history for ${sessionId}: ${historyResult.left}`);
		return { kind: "empty" } satisfies SessionHistorySource;
	});

const seedPaginationCursorFromHistory = (
	sessionId: string,
	source: SessionHistorySource,
) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		let oldestMessageId: string | undefined;

		if (source.kind === "cached-events" && source.hasMore) {
			oldestMessageId = extractOldestMessageId(source.events);
		} else if (source.kind === "rest-history" && source.history.hasMore) {
			oldestMessageId = source.history.messages[0]?.id;
		}

		if (oldestMessageId) {
			yield* sessionManagerService.seedPaginationCursor(
				sessionId,
				oldestMessageId,
			);
		}
	});

const switchClientToSession = (
	clientId: string,
	sessionId: string,
	options?: SwitchClientOptions,
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;
		const statusPoller = yield* StatusPollerTag;
		const pollerManager = yield* PollerManagerTag;
		const hasActiveTimeout = yield* hasActiveProcessingTimeout(sessionId);

		wsHandler.setClientSession(clientId, sessionId);

		const source: SessionHistorySource = options?.skipHistory
			? { kind: "empty" }
			: yield* resolveSessionHistory(sessionId);
		const pollerIsProcessing = yield* statusPoller.isProcessing(sessionId);
		const patchedSource = patchMissingDoneForProcessingState(
			source,
			sessionId,
			pollerIsProcessing || hasActiveTimeout,
		);

		yield* seedPaginationCursorFromHistory(sessionId, patchedSource);

		const draft = getSessionInputDraft(sessionId);
		wsHandler.sendTo(
			clientId,
			buildSessionSwitchedMessage(sessionId, patchedSource, {
				...(draft ? { draft } : {}),
				...(options?.requestId != null ? { requestId: options.requestId } : {}),
			}),
		);

		const isProcessing = pollerIsProcessing || hasActiveTimeout;
		wsHandler.sendTo(clientId, {
			type: "status",
			sessionId,
			status: isProcessing ? "processing" : "idle",
		});

		if (!options?.skipPollerSeed && !pollerManager.isPolling(sessionId)) {
			pollerManager.startPolling(sessionId);
		}
	});

export const viewSessionForClient = ({
	clientId,
	sessionId,
	skipMetadata,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly skipMetadata?: boolean;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const id = sessionId;
		if (!id) return;

		yield* switchClientToSession(clientId, id);

		// Broadcast session_viewed notification
		wsHandler.broadcast({
			type: "notification_event",
			eventType: "session_viewed",
			sessionId: id,
		} as RelayMessage);

		// Fire-and-forget metadata (unless skipMetadata is set)
		if (!skipMetadata) {
			// Run metadata send as a forked fiber — non-blocking
			yield* Effect.either(sendSessionMetadata(clientId, id));
		}

		log.info(`client=${clientId} Viewing: ${id}`);
	});

export const handleViewSession = (
	clientId: string,
	payload: ViewSessionPayload,
	skipMetadata?: boolean,
) =>
	viewSessionForClient({
		clientId,
		sessionId: payload.sessionId,
		...(skipMetadata != null ? { skipMetadata } : {}),
	});

export const createSessionForClient = ({
	clientId,
	title,
	requestId,
}: {
	readonly clientId: string;
	readonly title?: string;
	readonly requestId?: string;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const session = yield* sessionManagerService.createSession(title);

		yield* switchClientToSession(clientId, session.id, {
			...(requestId != null && { requestId: requestId as RequestId }),
			skipHistory: true,
			skipPollerSeed: true,
		});

		// Session list broadcast — non-blocking
		yield* Effect.either(
			sessionManagerService.sendDualSessionLists((msg) =>
				wsHandler.broadcast(msg),
			),
		).pipe(
			Effect.tap((result) => {
				if (result._tag === "Left") {
					log.warn(
						`Failed to broadcast session list after CreateSession: ${result.left}`,
					);
				}
				return Effect.void;
			}),
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
		...(payload.requestId != null ? { requestId: payload.requestId } : {}),
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

		// Find ALL clients viewing this session before deletion
		const viewers = wsHandler.getClientsForSession(id);

		yield* sessionManagerService.deleteSession(id);

		const sessions =
			viewers.length > 0 ? yield* sessionManagerService.listSessions() : [];

		// Switch ALL viewers to the next session
		if (sessions.length > 0) {
			for (const viewerClientId of viewers) {
				yield* handleViewSession(
					viewerClientId,
					{
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
						sessionId: sessions[0]!.id,
					},
					/* skipMetadata */ true,
				);
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
				yield* sendSessionMetadata(viewerClientId, sessions[0]!.id);
			}
		}

		// Broadcast session_deleted so all clients know this session is gone
		wsHandler.broadcast({ type: "session_deleted", sessionId: id });

		yield* sessionManagerService.sendDualSessionLists((msg) =>
			wsHandler.broadcast(msg),
		);
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
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const id = sessionId;
		if (id && title) {
			yield* sessionManagerService.renameSession(id, title);
			yield* sessionManagerService.sendDualSessionLists((msg) =>
				wsHandler.broadcast(msg),
			);
			log.info(`client=${clientId} Renamed: ${id} → ${title}`);
		}
	});

export const loadMoreHistoryForSession = ({
	sessionId,
	offset,
}: {
	readonly sessionId: string;
	readonly offset: number;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;

		const page = yield* sessionManagerService.loadPreRenderedHistory(
			sessionId,
			offset,
		);
		return {
			sessionId,
			messages: page.messages,
			hasMore: page.hasMore,
			...(page.total != null && { total: page.total }),
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
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;

		const sessionId =
			requestedSessionId || wsHandler.getClientSession(clientId) || "";
		if (!sessionId) return undefined;

		const forked = yield* Effect.tryPromise(() =>
			client.session.fork(sessionId, {
				...(messageId != null && { messageID: messageId }),
			}),
		);

		yield* clearEffectOverrideSession(sessionId);
		yield* sessionManagerService.clearPaginationCursor(sessionId);

		// Determine fork-point metadata
		let forkMessageId: string | undefined = messageId;
		let forkPointTimestamp: number | undefined;

		if (messageId) {
			const msgResult = yield* Effect.either(
				Effect.tryPromise(() => client.session.message(sessionId, messageId)),
			);
			if (msgResult._tag === "Right" && msgResult.right?.time?.created) {
				forkPointTimestamp = msgResult.right.time.created;
			} else if (msgResult._tag === "Left") {
				log.warn(
					`Could not look up fork-point message ${messageId} in ${sessionId}`,
				);
			}
		} else {
			forkPointTimestamp = forked.time?.created ?? forked.time?.updated;

			const msgsResult = yield* Effect.either(
				Effect.tryPromise(() =>
					client.session.messagesPage(forked.id, { limit: 1 }),
				),
			);
			if (msgsResult._tag === "Right" && msgsResult.right.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				forkMessageId = msgsResult.right[msgsResult.right.length - 1]!.id;
			} else if (msgsResult._tag === "Left") {
				log.warn(`Could not determine fork-point for ${forked.id}`);
			}
		}

		// Persist fork-point metadata
		if (forkMessageId || forkPointTimestamp) {
			yield* sessionManagerService.setForkEntry(forked.id, {
				forkMessageId: forkMessageId ?? "",
				parentID: sessionId,
				...(forkPointTimestamp != null && { forkPointTimestamp }),
			});
		}

		// Find the parent title for the notification
		const sessions = yield* sessionManagerService.listSessions();
		const parent = sessions.find((s) => s.id === sessionId);

		// Broadcast the fork notification
		wsHandler.broadcast({
			type: "session_forked",
			sessionId: forked.id,
			session: {
				id: forked.id,
				title: forked.title ?? "Forked Session",
				updatedAt: forked.time?.updated ?? forked.time?.created ?? 0,
				parentID: sessionId,
				...(forkMessageId && { forkMessageId }),
				...(forkPointTimestamp != null && { forkPointTimestamp }),
			},
			parentId: sessionId,
			parentTitle: parent?.title ?? "Unknown",
		});

		// Switch client to forked session with full history
		yield* handleViewSession(clientId, { sessionId: forked.id });

		// Broadcast updated session list
		yield* sessionManagerService.sendDualSessionLists((msg) =>
			wsHandler.broadcast(msg),
		);

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
