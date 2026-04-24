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
import { resolveSession } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/**
 * Send metadata (model info, permissions, questions, session list) to a client.
 * Independent of session_switched delivery — these are supplementary data.
 *
 * Returns a Promise that resolves when ALL metadata has been sent.
 * - handleViewSession calls this fire-and-forget (no await).
 * - handleDeleteSession awaits it to ensure full delivery before continuing.
 *
 * All errors are caught and logged internally — callers don't need .catch().
 */
async function sendSessionMetadata(
	deps: HandlerDeps,
	clientId: string,
	id: string,
): Promise<void> {
	await Promise.allSettled([
		// Model info
		(async () => {
			const session = await deps.client.session.get(id);
			if (session.modelID) {
				deps.wsHandler.sendTo(clientId, {
					type: "model_info",
					model: session.modelID,
					provider: session.providerID ?? "",
				});
			}
		})().catch((err) =>
			deps.log.warn(
				`Failed to get model info for ${id}: ${err instanceof Error ? err.message : err}`,
			),
		),

		// Pending permissions (bridge + API)
		(async () => {
			const bridgePending = deps.permissionBridge.getPending();
			const sentPermissionIds = new Set<string>();
			for (const perm of bridgePending) {
				if (perm.sessionId && perm.sessionId !== id) continue;
				deps.wsHandler.sendTo(clientId, {
					type: "permission_request",
					sessionId: perm.sessionId,
					requestId: perm.requestId,
					toolName: perm.toolName,
					toolInput: perm.toolInput,
				});
				sentPermissionIds.add(perm.requestId);
			}
			const apiPermissions = await deps.client.permission.list();
			for (const p of apiPermissions) {
				const pSessionId = (p as { sessionID?: string }).sessionID ?? "";
				if (pSessionId && pSessionId !== id) continue;
				if (sentPermissionIds.has(p.id)) continue;
				deps.wsHandler.sendTo(clientId, {
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
		})().catch((err) =>
			deps.log.warn(
				`Failed to replay pending permissions for ${id}: ${err instanceof Error ? err.message : err}`,
			),
		),

		// Pending questions (bridge + API)
		(async () => {
			const sentQuestionIds = new Set<string>();

			// Check the QuestionBridge first — Claude sessions store pending
			// questions here (OpenCode API knows nothing about them).
			const bridgePendingQuestions = deps.questionBridge.getPending();
			for (const pq of bridgePendingQuestions) {
				if (pq.sessionId && pq.sessionId !== id) continue;
				deps.wsHandler.sendTo(clientId, {
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

			// Fall back to OpenCode API for OpenCode-native sessions.
			const pendingQuestions = await deps.client.question.list();
			for (const pq of pendingQuestions) {
				const qSessionId = pq["sessionID"] as string | undefined;
				if (qSessionId && qSessionId !== id) continue;
				if (sentQuestionIds.has(pq.id)) continue;

				const rawQuestions = pq["questions"] as
					| Array<{
							question?: string;
							header?: string;
							options?: Array<{ label?: string; description?: string }>;
							multiple?: boolean;
							custom?: boolean;
					  }>
					| undefined;
				if (!Array.isArray(rawQuestions)) continue;
				const questions = mapQuestionFields(rawQuestions);
				const tool = pq["tool"] as { callID?: string } | undefined;
				const toolCallId = tool?.callID;
				deps.wsHandler.sendTo(clientId, {
					type: "ask_user",
					sessionId: id,
					toolId: pq.id,
					questions,
					...(toolCallId ? { toolUseId: toolCallId } : {}),
				});
			}
		})().catch((err) =>
			deps.log.warn(
				`Failed to replay pending questions for ${id}: ${err instanceof Error ? err.message : err}`,
			),
		),

		// Session list (for SubagentBackBar parentID resolution)
		deps.sessionMgr
			.sendDualSessionLists((msg) => deps.wsHandler.sendTo(clientId, msg))
			.catch((err) =>
				deps.log.warn(
					`Failed to send session list to ${clientId}: ${err instanceof Error ? err.message : err}`,
				),
			),
	]);
}

/**
 * Map HandlerDeps to the narrowed SessionSwitchDeps.
 * Centralizes the mapping so each handler doesn't duplicate it.
 *
 * NOTE: statusPoller and pollerManager are required on HandlerDeps
 * (made non-optional by the pipeline-resilience Plan D2 refactor).
 */
function toSessionSwitchDeps(deps: HandlerDeps): SessionSwitchDeps {
	return {
		sessionMgr: deps.sessionMgr,
		wsHandler: deps.wsHandler,
		statusPoller: deps.statusPoller,
		overrides: deps.overrides,
		pollerManager: deps.pollerManager,
		log: deps.log,
		getInputDraft: getSessionInputDraft,
		...(deps.readQuery != null && { readQuery: deps.readQuery }),
	};
}

/**
 * View a session in the requesting tab (per-tab session selection).
 * Just associates the client with the session and sends history to that client.
 */
export async function handleViewSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["view_session"],
	/** @internal Skip fire-and-forget metadata — caller will await sendSessionMetadata directly. */
	skipMetadata?: boolean,
): Promise<void> {
	const { sessionId: id } = payload;
	if (!id) return;

	await switchClientToSession(toSessionSwitchDeps(deps), clientId, id);

	// Broadcast to all clients so they can clear done-unviewed indicators.
	// The viewing client already dispatches session_viewed locally from the
	// session_switched handler — the duplicate dispatch is a harmless no-op.
	deps.wsHandler.broadcast({
		type: "notification_event",
		eventType: "session_viewed",
		sessionId: id,
	} as RelayMessage);

	// @perf-guard S2 — awaiting this call adds 20-100ms to session switch latency
	// Fire-and-forget: metadata is not on the critical path for session switching.
	// sendTo is safe after disconnect (silently drops messages).
	// All errors are caught and logged inside sendSessionMetadata.
	// NOTE: This is intentionally NOT awaited — the handler returns immediately
	// after sending session_switched, unblocking the per-client semaphore.
	// When skipMetadata is true, the caller (e.g. handleDeleteSession) will
	// await sendSessionMetadata directly to avoid duplicate metadata sends.
	if (!skipMetadata) {
		sendSessionMetadata(deps, clientId, id).catch(() => {});
	}

	deps.log.info(`client=${clientId} Viewing: ${id}`);
}

export async function handleNewSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["new_session"],
): Promise<void> {
	const { title, requestId } = payload;
	const session = await deps.sessionMgr.createSession(title, { silent: true });

	await switchClientToSession(toSessionSwitchDeps(deps), clientId, session.id, {
		...(requestId != null && { requestId }),
		skipHistory: true,
		skipPollerSeed: true,
	});

	// Session list broadcast — non-blocking so session_switched reaches the
	// client immediately without waiting for the listSessions() API call.
	deps.sessionMgr
		.sendDualSessionLists((msg) => deps.wsHandler.broadcast(msg))
		.catch((err) => {
			deps.log.warn(
				`Failed to broadcast session list after new_session: ${err}`,
			);
		});

	deps.log.info(`client=${clientId} Created: ${session.id}`);
}

/**
 * Switch to a different session — alias for handleViewSession.
 *
 * In the per-tab session model, switch_session behaves the same as
 * view_session: it associates the requesting client with the session
 * and sends history to that client only.
 */
export async function handleSwitchSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_session"],
): Promise<void> {
	return handleViewSession(deps, clientId, payload);
}

export async function handleDeleteSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["delete_session"],
): Promise<void> {
	const { sessionId: id } = payload;
	if (!id) return;

	// Find ALL clients viewing this session before deletion
	const viewers = deps.wsHandler.getClientsForSession(id);

	await deps.sessionMgr.deleteSession(id, { silent: true });

	const sessions = await deps.sessionMgr.listSessions();

	// Switch ALL viewers to the next session (not just the requester)
	if (sessions.length > 0) {
		for (const viewerClientId of viewers) {
			await handleViewSession(
				deps,
				viewerClientId,
				{
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
					sessionId: sessions[0]!.id,
				},
				/* skipMetadata */ true,
			);
			// Metadata is skipped in handleViewSession above to avoid duplicate
			// sends. Await it here so delivery completes before the session list
			// broadcast that follows.
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
			await sendSessionMetadata(deps, viewerClientId, sessions[0]!.id);
		}
	}

	// Broadcast session_deleted so all clients know this session is gone
	deps.wsHandler.broadcast({ type: "session_deleted", sessionId: id });

	await deps.sessionMgr.sendDualSessionLists((msg) =>
		deps.wsHandler.broadcast(msg),
	);
	deps.log.info(`client=${clientId} Deleted: ${id}`);
}

export async function handleRenameSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["rename_session"],
): Promise<void> {
	const { sessionId: id, title } = payload;
	if (id && title) {
		await deps.sessionMgr.renameSession(id, title);
		deps.log.info(`client=${clientId} Renamed: ${id} → ${title}`);
	}
}

export async function handleListSessions(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_sessions"],
): Promise<void> {
	await deps.sessionMgr.sendDualSessionLists((msg) =>
		deps.wsHandler.sendTo(clientId, msg),
	);
}

export async function handleSearchSessions(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["search_sessions"],
): Promise<void> {
	const { query, roots } = payload;
	const results = await deps.sessionMgr.searchSessions(
		query,
		roots !== undefined ? { roots } : undefined,
	);
	deps.wsHandler.sendTo(clientId, {
		type: "session_list",
		sessions: results,
		roots: roots ?? false,
		search: true,
	});
}

export async function handleLoadMoreHistory(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["load_more_history"],
): Promise<void> {
	const sid = payload.sessionId ?? resolveSession(deps, clientId) ?? "";
	const { offset } = payload;
	if (sid) {
		const page = await deps.sessionMgr.loadPreRenderedHistory(sid, offset);
		deps.wsHandler.sendTo(clientId, {
			type: "history_page",
			sessionId: sid,
			messages: page.messages,
			hasMore: page.hasMore,
			...(page.total != null && { total: page.total }),
		});
	}
}

/** Fork a session at a specific message point (ticket 5.3). */
export async function handleForkSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["fork_session"],
): Promise<void> {
	const sessionId = payload.sessionId || resolveSession(deps, clientId) || "";
	if (!sessionId) return;

	const { messageId } = payload;

	const forked = await deps.client.session.fork(sessionId, {
		...(messageId != null && { messageID: messageId }),
	});

	deps.overrides.clearSession(sessionId);
	// Clear stale pagination cursor — fork creates a new session with
	// potentially different message IDs.
	deps.sessionMgr.clearPaginationCursor(sessionId);

	// Determine fork-point metadata.
	// forkPointTimestamp is the primary split anchor (reliable across ID changes).
	// forkMessageId is kept for backward compat / debugging.
	let forkMessageId: string | undefined = messageId;
	let forkPointTimestamp: number | undefined;

	if (messageId) {
		// Specific-message fork: look up the fork-point message's timestamp from the parent.
		// getMessage fetches exactly one message by ID (no pagination needed).
		try {
			const forkMsg = await deps.client.session.message(sessionId, messageId);
			if (forkMsg?.time?.created) {
				forkPointTimestamp = forkMsg.time.created;
			}
		} catch {
			deps.log.warn(
				`Could not look up fork-point message ${messageId} in ${sessionId}`,
			);
		}
	} else {
		// Whole-session fork: use the forked session's creation time as the boundary.
		// All inherited messages have time.created < this value.
		forkPointTimestamp = forked.time?.created ?? forked.time?.updated;

		// Also capture the last message ID for backward compat.
		try {
			const msgs = await deps.client.session.messagesPage(forked.id, {
				limit: 1,
			});
			if (msgs.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				forkMessageId = msgs[msgs.length - 1]!.id;
			}
		} catch {
			deps.log.warn(`Could not determine fork-point for ${forked.id}`);
		}
	}

	// Persist fork-point metadata
	if (forkMessageId || forkPointTimestamp) {
		deps.forkMeta.setForkEntry(forked.id, {
			forkMessageId: forkMessageId ?? "",
			parentID: sessionId,
			...(forkPointTimestamp != null && { forkPointTimestamp }),
		});
	}

	// Find the parent title for the notification
	const sessions = await deps.sessionMgr.listSessions();
	const parent = sessions.find((s) => s.id === sessionId);

	// Broadcast the fork notification
	deps.wsHandler.broadcast({
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

	// Switch the requesting client to the forked session with full history.
	// handleViewSession loads messages from the cache or OpenCode API and
	// sends session_switched WITH events/history so the client can render
	// inherited messages and the fork divider immediately.
	await handleViewSession(deps, clientId, { sessionId: forked.id });

	// Broadcast updated session list (now includes the fork)
	await deps.sessionMgr.sendDualSessionLists((msg) =>
		deps.wsHandler.broadcast(msg),
	);

	deps.log.info(
		`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
	);
}

// ─── Effect-based handler implementations ──────────────────────────────────
// These will replace the above functions once the dispatch table is rewired
// in Task 5.3. Until then they coexist alongside the original handlers.

/**
 * Build SessionSwitchDeps from Effect context. The narrowed type
 * expected by switchClientToSession is assembled from individual Tags.
 */
const toSessionSwitchDepsEffect = Effect.gen(function* () {
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
 * Effect version of sendSessionMetadata. Sends model info, permissions,
 * questions, and session list to a client.
 */
const sendSessionMetadataEffect = (clientId: string, id: string) =>
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

export const handleViewSessionEffect = (
	clientId: string,
	payload: PayloadMap["view_session"],
	skipMetadata?: boolean,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const { sessionId: id } = payload;
		if (!id) return;

		const switchDeps = yield* toSessionSwitchDepsEffect;
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
			yield* Effect.either(sendSessionMetadataEffect(clientId, id));
		}

		log.info(`client=${clientId} Viewing: ${id}`);
	});

export const handleNewSessionEffect = (
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

		const switchDeps = yield* toSessionSwitchDepsEffect;
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

export const handleSwitchSessionEffect = (
	clientId: string,
	payload: PayloadMap["switch_session"],
) => handleViewSessionEffect(clientId, payload);

export const handleDeleteSessionEffect = (
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
				yield* handleViewSessionEffect(
					viewerClientId,
					{
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
						sessionId: sessions[0]!.id,
					},
					/* skipMetadata */ true,
				);
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
				yield* sendSessionMetadataEffect(viewerClientId, sessions[0]!.id);
			}
		}

		// Broadcast session_deleted so all clients know this session is gone
		wsHandler.broadcast({ type: "session_deleted", sessionId: id });

		yield* Effect.tryPromise(() =>
			sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg)),
		);
		log.info(`client=${clientId} Deleted: ${id}`);
	});

export const handleRenameSessionEffect = (
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

export const handleListSessionsEffect = (
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

export const handleSearchSessionsEffect = (
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

export const handleLoadMoreHistoryEffect = (
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

export const handleForkSessionEffect = (
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
		yield* handleViewSessionEffect(clientId, { sessionId: forked.id });

		// Broadcast updated session list
		yield* Effect.tryPromise(() =>
			sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg)),
		);

		log.info(
			`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
		);
	});
