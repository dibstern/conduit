// ─── Session Handlers ────────────────────────────────────────────────────────

import { Effect } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import {
	ForkMetaTag,
	LoggerTag,
	OpenCodeAPITag,
	PermissionBridgeTag,
	PollerManagerTag,
	QuestionBridgeTag,
	ReadQueryTag,
	SessionManagerTag,
	SessionOverridesTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import {
	type SessionSwitchDeps,
	switchClientToSession,
} from "../session/session-switch.js";
import type { PermissionId, RelayMessage } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import { getSessionInputDraft } from "./prompt.js";

/**
 * Build SessionSwitchDeps from Effect context. The narrowed type
 * expected by switchClientToSession is assembled from individual Tags.
 */
const toSessionSwitchDepsFromContext = Effect.gen(function* () {
	const sessionMgr = yield* SessionManagerTag;
	const wsHandler = yield* WebSocketHandlerTag;
	const statusPoller = yield* StatusPollerTag;
	const overrides = yield* SessionOverridesTag;
	const pollerManager = yield* PollerManagerTag;
	const log = yield* LoggerTag;
	const readQueryOption = yield* Effect.serviceOption(ReadQueryTag);

	return {
		sessionMgr,
		wsHandler,
		statusPoller,
		overrides,
		pollerManager,
		log,
		getInputDraft: getSessionInputDraft,
		...(readQueryOption._tag === "Some" && {
			readQuery: readQueryOption.value,
		}),
	} as SessionSwitchDeps;
});

/**
 * Send metadata (model info, permissions, questions, session list) to a client.
 * Independent of session_switched delivery — these are supplementary data.
 */
const sendSessionMetadata = (clientId: string, id: string) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const permissionBridge = yield* PermissionBridgeTag;
		const questionBridge = yield* QuestionBridgeTag;
		const sessionMgr = yield* SessionManagerTag;

		// Run all metadata sends concurrently, catching errors individually
		yield* Effect.all(
			[
				// Model info
				Effect.gen(function* () {
					const session = yield* Effect.tryPromise(() =>
						client.session.get(id),
					);
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

				// Pending permissions (bridge + API)
				Effect.gen(function* () {
					const bridgePending = permissionBridge.getPending();
					const sentPermissionIds = new Set<string>();
					for (const perm of bridgePending) {
						if (perm.sessionId && perm.sessionId !== id) continue;
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

					const bridgePendingQuestions = questionBridge.getPending();
					for (const pq of bridgePendingQuestions) {
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
				Effect.tryPromise(() =>
					sessionMgr.sendDualSessionLists((msg) =>
						wsHandler.sendTo(clientId, msg),
					),
				).pipe(
					Effect.catchAll((err) =>
						Effect.sync(() =>
							log.warn(
								`Failed to send session list to ${clientId}: ${err instanceof Error ? err.message : err}`,
							),
						),
					),
				),
			],
			{ concurrency: "unbounded" },
		);
	});

export const handleViewSession = (
	clientId: string,
	payload: PayloadMap["view_session"],
	skipMetadata?: boolean,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { sessionId: id } = payload;
		if (!id) return;

		const switchDeps = yield* toSessionSwitchDepsFromContext;
		yield* Effect.tryPromise(() =>
			switchClientToSession(switchDeps, clientId, id),
		);

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

export const handleNewSession = (
	clientId: string,
	payload: PayloadMap["new_session"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;
		const log = yield* LoggerTag;

		const { title, requestId } = payload;
		const session = yield* Effect.tryPromise(() =>
			sessionMgr.createSession(title, { silent: true }),
		);

		const switchDeps = yield* toSessionSwitchDepsFromContext;
		yield* Effect.tryPromise(() =>
			switchClientToSession(switchDeps, clientId, session.id, {
				...(requestId != null && { requestId }),
				skipHistory: true,
				skipPollerSeed: true,
			}),
		);

		// Session list broadcast — non-blocking
		yield* Effect.either(
			Effect.tryPromise(() =>
				sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg)),
			),
		).pipe(
			Effect.tap((result) => {
				if (result._tag === "Left") {
					log.warn(
						`Failed to broadcast session list after new_session: ${result.left}`,
					);
				}
				return Effect.void;
			}),
		);

		log.info(`client=${clientId} Created: ${session.id}`);
	});

export const handleSwitchSession = (
	clientId: string,
	payload: PayloadMap["switch_session"],
) => handleViewSession(clientId, payload);

export const handleDeleteSession = (
	clientId: string,
	payload: PayloadMap["delete_session"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;
		const log = yield* LoggerTag;

		const { sessionId: id } = payload;
		if (!id) return;

		// Find ALL clients viewing this session before deletion
		const viewers = wsHandler.getClientsForSession(id);

		yield* Effect.tryPromise(() =>
			sessionMgr.deleteSession(id, { silent: true }),
		);

		const sessions = yield* Effect.tryPromise(() => sessionMgr.listSessions());

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

		yield* Effect.tryPromise(() =>
			sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg)),
		);
		log.info(`client=${clientId} Deleted: ${id}`);
	});

export const handleRenameSession = (
	clientId: string,
	payload: PayloadMap["rename_session"],
) =>
	Effect.gen(function* () {
		const sessionMgr = yield* SessionManagerTag;
		const log = yield* LoggerTag;

		const { sessionId: id, title } = payload;
		if (id && title) {
			yield* Effect.tryPromise(() => sessionMgr.renameSession(id, title));
			log.info(`client=${clientId} Renamed: ${id} → ${title}`);
		}
	});

export const handleListSessions = (
	clientId: string,
	_payload: PayloadMap["list_sessions"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;

		yield* Effect.tryPromise(() =>
			sessionMgr.sendDualSessionLists((msg) => wsHandler.sendTo(clientId, msg)),
		);
	});

export const handleSearchSessions = (
	clientId: string,
	payload: PayloadMap["search_sessions"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;

		const { query, roots } = payload;
		const results = yield* Effect.tryPromise(() =>
			sessionMgr.searchSessions(
				query,
				roots !== undefined ? { roots } : undefined,
			),
		);
		wsHandler.sendTo(clientId, {
			type: "session_list",
			sessions: results,
			roots: roots ?? false,
			search: true,
		});
	});

export const handleLoadMoreHistory = (
	clientId: string,
	payload: PayloadMap["load_more_history"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;

		const sid = payload.sessionId ?? wsHandler.getClientSession(clientId) ?? "";
		const { offset } = payload;
		if (sid) {
			const page = yield* Effect.tryPromise(() =>
				sessionMgr.loadPreRenderedHistory(sid, offset),
			);
			wsHandler.sendTo(clientId, {
				type: "history_page",
				sessionId: sid,
				messages: page.messages,
				hasMore: page.hasMore,
				...(page.total != null && { total: page.total }),
			});
		}
	});

/** Fork a session at a specific message point (ticket 5.3). */
export const handleForkSession = (
	clientId: string,
	payload: PayloadMap["fork_session"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionMgr = yield* SessionManagerTag;
		const overrides = yield* SessionOverridesTag;
		const forkMeta = yield* ForkMetaTag;
		const log = yield* LoggerTag;

		const sessionId =
			payload.sessionId || wsHandler.getClientSession(clientId) || "";
		if (!sessionId) return;

		const { messageId } = payload;

		const forked = yield* Effect.tryPromise(() =>
			client.session.fork(sessionId, {
				...(messageId != null && { messageID: messageId }),
			}),
		);

		overrides.clearSession(sessionId);
		sessionMgr.clearPaginationCursor(sessionId);

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
			forkMeta.setForkEntry(forked.id, {
				forkMessageId: forkMessageId ?? "",
				parentID: sessionId,
				...(forkPointTimestamp != null && { forkPointTimestamp }),
			});
		}

		// Find the parent title for the notification
		const sessions = yield* Effect.tryPromise(() => sessionMgr.listSessions());
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
		yield* Effect.tryPromise(() =>
			sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg)),
		);

		log.info(
			`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
		);
	});
