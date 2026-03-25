// ─── Session Handlers ────────────────────────────────────────────────────────

import { mapQuestionFields } from "../bridges/question-bridge.js";
import {
	type SessionSwitchDeps,
	switchClientToSession,
} from "../session/session-switch.js";
import type { PermissionId } from "../shared-types.js";
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
			const session = await deps.client.getSession(id);
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
			const apiPermissions = await deps.client.listPendingPermissions();
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

		// Pending questions
		(async () => {
			const pendingQuestions = await deps.client.listPendingQuestions();
			for (const pq of pendingQuestions) {
				const qSessionId = pq["sessionID"] as string | undefined;
				if (qSessionId && qSessionId !== id) continue;

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
		messageCache: deps.messageCache,
		sessionMgr: deps.sessionMgr,
		wsHandler: deps.wsHandler,
		statusPoller: deps.statusPoller,
		pollerManager: deps.pollerManager,
		client: {
			getMessages: (sid: string) => deps.client.getMessages(sid),
			getMessageCount: (sid: string) =>
				deps.client.getMessages(sid).then((m) => m.length),
		},
		log: deps.log,
		getInputDraft: getSessionInputDraft,
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

	// @perf-guard S2 — awaiting this call adds 20-100ms to session switch latency
	// Fire-and-forget: metadata is not on the critical path for session switching.
	// sendTo is safe after disconnect (silently drops messages).
	// All errors are caught and logged inside sendSessionMetadata.
	// NOTE: This is intentionally NOT awaited — the handler returns immediately
	// after sending session_switched, unblocking the ClientMessageQueue.
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

	deps.messageCache.remove(id);
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

	const forked = await deps.client.forkSession(sessionId, {
		...(messageId != null && { messageID: messageId }),
	});

	deps.overrides.clearSession(sessionId);

	// Determine the fork-point messageId
	let forkMessageId: string | undefined = messageId;
	if (!forkMessageId) {
		// Whole-session fork: get all messages in the forked session and use the last one.
		// At this point the fork just happened, so all messages are inherited.
		try {
			const msgs = await deps.client.getMessages(forked.id);
			if (msgs.length > 0) {
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				forkMessageId = msgs[msgs.length - 1]!.id;
			}
		} catch {
			deps.log.warn(`Could not determine fork-point for ${forked.id}`);
		}
	}

	// Persist fork-point metadata (forkMessageId + parentID)
	if (forkMessageId) {
		deps.forkMeta.setForkEntry(forked.id, {
			forkMessageId,
			parentID: sessionId,
		});
	}

	// Find the parent title for the notification
	const sessions = await deps.sessionMgr.listSessions();
	const parent = sessions.find((s) => s.id === sessionId);

	// Broadcast the fork notification
	deps.wsHandler.broadcast({
		type: "session_forked",
		session: {
			id: forked.id,
			title: forked.title ?? "Forked Session",
			updatedAt: forked.time?.updated ?? forked.time?.created ?? 0,
			parentID: sessionId,
			...(forkMessageId && { forkMessageId }),
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
