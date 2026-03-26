// ─── SSE Event Wiring ────────────────────────────────────────────────────────
// Extracted from relay-stack.ts: the pipeline that takes SSE events from
// OpenCode, translates them, filters by session, records to cache, broadcasts
// to browser clients, and sends push notifications.

import type { PermissionBridge } from "../bridges/permission-bridge.js";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import type { Logger } from "../logger.js";
import { notificationContent } from "../notification-content.js";
import type { PushNotificationManager } from "../server/push.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SessionOverrides } from "../session/session-overrides.js";
import type { PermissionId } from "../shared-types.js";
import type { OpenCodeEvent, RelayMessage } from "../types.js";
import { applyPipelineResult, processEvent } from "./event-pipeline.js";
import type { Translator } from "./event-translator.js";
import type { MessageCache } from "./message-cache.js";
import { resolveNotifications } from "./notification-policy.js";
import {
	hasInfoWithSessionID,
	hasPartWithSessionID,
	hasSessionID,
	isPermissionRepliedEvent,
	isSessionErrorEvent,
} from "./opencode-events.js";
import type { PendingUserMessages } from "./pending-user-messages.js";
import type { SSEConsumer } from "./sse-consumer.js";
import type { ToolContentStore } from "./tool-content-store.js";

// ─── Session ID extraction ────────────────────────────────────────────────────
// OpenCode SSE events store sessionID in different locations by event type:
//   - Top-level: message.part.delta, session.status, message.part.removed, etc.
//   - Nested in part: message.part.updated → properties.part.sessionID
//   - Nested in info: message.updated → properties.info.sessionID
// We must check all locations to correctly attribute events to sessions.

export function extractSessionId(event: OpenCodeEvent): string | undefined {
	const props = event.properties;
	// 1. Top-level sessionID (most common)
	if (hasSessionID(props)) {
		return props.sessionID;
	}
	// 2. Nested in part (message.part.updated)
	if (hasPartWithSessionID(props)) {
		return props.part.sessionID;
	}
	// 3. Nested in info (message.updated, session.updated)
	if (hasInfoWithSessionID(props)) {
		return props.info.sessionID ?? props.info.id;
	}
	return undefined;
}

// ─── SSE Wiring Dependencies ─────────────────────────────────────────────────

export interface SSEWiringDeps {
	translator: Translator;
	sessionMgr: SessionManager;
	messageCache: MessageCache;
	pendingUserMessages: PendingUserMessages;
	permissionBridge: PermissionBridge;
	overrides: SessionOverrides;
	toolContentStore: ToolContentStore;
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendToSession: (sessionId: string, msg: RelayMessage) => void;
		getClientsForSession: (sessionId: string) => string[];
	};
	pushManager?: PushNotificationManager;
	log: Logger;
	pipelineLog: Logger;
	/** Optional: current session statuses for processing flags */
	getSessionStatuses?: () => Record<
		string,
		import("../instance/opencode-client.js").SessionStatus
	>;
	/** Optional: REST client for rehydrating pending questions on reconnect */
	listPendingQuestions?: () => Promise<
		Array<{ id: string; [key: string]: unknown }>
	>;
	/** Optional: REST client for rehydrating pending permissions on reconnect */
	listPendingPermissions?: () => Promise<
		Array<{ id: string; permission: string; [key: string]: unknown }>
	>;
	/** Optional: notify status poller of SSE idle events for fast transition detection */
	statusPoller?: { notifySSEIdle(sessionId: string): void };
	/** Optional: session parent map for subagent detection in notification routing */
	getSessionParentMap?: () => Map<string, string>;
	/** Project slug for push notification routing */
	slug?: string;
}

// ─── Push notification helper ────────────────────────────────────────────────
// Extracted so both handleSSEEvent (SSE path) and relay-stack.ts (status/message
// poller paths) can fire push notifications for done/error events. Without this,
// push notifications are only sent when the translator produces done/error —
// but the translator returns ok:false for session.status:idle, so done events
// from the status poller never triggered push.

/** Minimal push manager interface for sendPushForEvent (avoids full PushNotificationManager import). */
interface PushSender {
	sendToAll(payload: {
		type: string;
		title: string;
		body: string;
		tag: string;
		[key: string]: unknown;
	}): Promise<void>;
}

/** Session routing context for push notifications. */
export interface PushEventContext {
	slug?: string;
	sessionId?: string;
}

/**
 * Build a PushEventContext from optional values.
 * Avoids setting keys to `undefined` (required by exactOptionalPropertyTypes).
 */
function buildPushContext(slug?: string, sessionId?: string): PushEventContext {
	const ctx: PushEventContext = {};
	if (slug != null) ctx.slug = slug;
	if (sessionId != null) ctx.sessionId = sessionId;
	return ctx;
}

/**
 * Send a push notification for notable relay messages (done, error, etc.).
 * No-op for message types that don't warrant a notification.
 * Safe to call with any RelayMessage.
 *
 * When `context` is provided, `slug` and `sessionId` are included in the
 * payload so the service worker click handler can navigate directly to the
 * originating session.
 */
export function sendPushForEvent(
	pushManager: PushSender,
	msg: RelayMessage,
	log: Logger,
	context?: PushEventContext,
): void {
	const content = notificationContent(msg);
	if (!content) return;
	pushManager
		.sendToAll({
			type: msg.type,
			...content,
			...(context?.slug != null && { slug: context.slug }),
			...(context?.sessionId != null && { sessionId: context.sessionId }),
		})
		.catch((err: unknown) =>
			log.warn(`Push send failed (${msg.type}): ${err}`),
		);
}

// ─── Handle a single SSE event ───────────────────────────────────────────────

export function handleSSEEvent(
	deps: SSEWiringDeps,
	event: OpenCodeEvent,
): void {
	const {
		translator,
		sessionMgr,
		messageCache,
		permissionBridge,
		overrides,
		toolContentStore,
		wsHandler,
		pushManager,
		pipelineLog,
		log,
	} = deps;

	const eventSessionId = extractSessionId(event);
	log.verbose(`event=${event.type} session=${eventSessionId ?? "?"}`);

	// ── Track message activity for session ordering ──────────────────────
	// Record the timestamp of any message-related event so sessions are
	// ordered by actual conversation activity, not metadata updates.
	if (eventSessionId && event.type.startsWith("message.")) {
		sessionMgr.recordMessageActivity(eventSessionId);
	}
	// ── Permission / question bridge routing ──────────────────────────────

	if (event.type === "permission.asked") {
		const pending = permissionBridge.onPermissionRequest(event);
		// Broadcast directly from bridge data — bypasses the translator so
		// permissions are delivered even when the SSE event lacks sessionID.
		if (pending) {
			// Prefer bridge's sessionId; fall back to the event-level
			// sessionId so the notification is never empty-string (which
			// getRemotePermissions filters out).
			const permSessionId = pending.sessionId || eventSessionId || "";
			const permMsg: RelayMessage = {
				type: "permission_request",
				sessionId: permSessionId,
				requestId: pending.requestId,
				toolName: pending.toolName,
				toolInput: pending.toolInput,
				always: pending.always ?? [],
			};
			wsHandler.broadcast(permMsg);
			if (pushManager) {
				sendPushForEvent(
					pushManager,
					permMsg,
					log,
					buildPushContext(deps.slug, permSessionId),
				);
			}
		} else if (pushManager) {
			// Bridge rejected (missing id/permission) — still attempt push
			const props = event.properties;
			const id = typeof props["id"] === "string" ? props["id"] : "unknown";
			const tool =
				typeof props["permission"] === "string"
					? props["permission"]
					: "A tool";
			sendPushForEvent(
				pushManager,
				{
					type: "permission_request",
					sessionId: eventSessionId ?? "",
					requestId: id as PermissionId,
					toolName: tool,
					toolInput: {},
				},
				log,
				buildPushContext(deps.slug, eventSessionId),
			);
		}
	}
	if (event.type === "question.asked") {
		// No bridge storage needed — the translator produces an `ask_user`
		// WebSocket message with the `que_` ID that the frontend stores and
		// sends back with the answer.  The handler calls the OpenCode API
		// directly.
		log.debug(`question.asked: event received`);
		if (pushManager) {
			sendPushForEvent(
				pushManager,
				{ type: "ask_user", toolId: "", questions: [] },
				log,
				buildPushContext(deps.slug, eventSessionId),
			);
		}
	}
	if (isPermissionRepliedEvent(event)) {
		permissionBridge.onPermissionReplied(event.properties.id);
	}

	// ── Session updated (title change, etc.) → refresh session list ──────

	if (event.type === "session.updated") {
		// Eagerly update parent map from SSE event to eliminate the race
		// between subagent creation and the async listSessions() refresh.
		// Without this, a fast subagent could complete before getSessionParentMap()
		// knows about it, causing its "done" to be treated as a root session event.
		if (hasInfoWithSessionID(event.properties)) {
			const info = event.properties.info;
			const childId = info.sessionID ?? info.id;
			const parentId =
				typeof (info as Record<string, unknown>)["parentID"] === "string"
					? ((info as Record<string, unknown>)["parentID"] as string)
					: undefined;
			if (childId && parentId) {
				sessionMgr.addToParentMap(childId, parentId);
			}
		}

		const statuses = deps.getSessionStatuses?.();
		sessionMgr
			.sendDualSessionLists((msg) => wsHandler.broadcast(msg), { statuses })
			.catch((err) =>
				log.warn(`Failed to refresh sessions after session.updated: ${err}`),
			);
	}

	// ── Log session errors for debugging ──────────────────────────────────

	if (isSessionErrorEvent(event)) {
		const err = event.properties.error;
		log.warn(
			`event=${event.type} session=${eventSessionId ?? "?"} Session error: ${err?.name ?? "?"} — ${err?.data?.message ?? "(no message)"}`,
		);
	}

	// ── SSE idle hint → status poller for fast transition detection ──────
	if (event.type === "session.status") {
		const statusType = (
			event.properties?.["status"] as { type?: string } | undefined
		)?.type;
		if (statusType === "idle" && eventSessionId && deps.statusPoller) {
			deps.statusPoller.notifySSEIdle(eventSessionId);
		}
	}

	// ── permission.asked already handled above (bridge → broadcast) ─────
	// Skip the translator to avoid double-broadcasting.
	if (event.type === "permission.asked") return;

	// ── Translate → filter → cache → route per-session ──────────────────

	const translateResult = translator.translate(event, {
		sessionId: eventSessionId,
	});
	if (!translateResult.ok) {
		// Log skipped events for debugging (skip noisy unhandled types in production)
		if (!translateResult.reason.startsWith("unhandled event type")) {
			log.verbose(`translate skip: ${translateResult.reason} (${event.type})`);
		}
		return;
	}

	const targetSessionId = eventSessionId;

	const toSend = translateResult.messages;
	for (let msg of toSend) {
		// ── Suppress relay-originated user messages ──────────────────────
		// When we send a message via the relay, the frontend already adds it
		// locally. OpenCode fires a `message.created` SSE event for the same
		// message, which the translator converts to `user_message`. Without
		// this check the message appears twice (once from local add, once
		// from SSE echo). The pending tracker was populated by prompt.ts.
		if (
			msg.type === "user_message" &&
			targetSessionId &&
			deps.pendingUserMessages.consume(targetSessionId, msg.text)
		) {
			log.debug(
				`Suppressed relay-originated user_message echo for session=${targetSessionId}`,
			);
			continue;
		}

		// Permission events: broadcast to all clients (not session-scoped)
		if (
			msg.type === "permission_request" ||
			msg.type === "permission_resolved"
		) {
			wsHandler.broadcast(msg);
			continue;
		}

		// Question events: route to clients viewing the question's session
		if (msg.type === "ask_user" || msg.type === "ask_user_resolved") {
			if (msg.type === "ask_user") {
				const askMsg = msg as Extract<RelayMessage, { type: "ask_user" }>;
				log.debug(
					`Routing ask_user to session=${targetSessionId ?? "?"}: toolId=${askMsg.toolId} questionCount=${askMsg.questions?.length ?? 0}`,
				);
			}
			if (targetSessionId) {
				wsHandler.sendToSession(targetSessionId, msg);
				// Broadcast a lightweight notification so clients on OTHER
				// sessions know a question exists (AttentionBanner).
				wsHandler.broadcast({
					type: "notification_event",
					eventType: msg.type,
					...(targetSessionId != null ? { sessionId: targetSessionId } : {}),
				});
			} else {
				// No session ID available — broadcast as fallback (defensive)
				wsHandler.broadcast(msg);
			}
			continue;
		}

		// Shared pipeline: pure decisions, explicit side effects
		const viewers = targetSessionId
			? wsHandler.getClientsForSession(targetSessionId)
			: [];
		const pipeResult = processEvent(msg, targetSessionId, viewers);
		msg = pipeResult.msg;

		applyPipelineResult(pipeResult, targetSessionId, {
			toolContentStore,
			overrides,
			messageCache,
			wsHandler,
			log: pipelineLog,
		});

		// Notification routing: push + cross-session broadcast
		const isSubagent =
			targetSessionId != null &&
			(deps.getSessionParentMap?.().has(targetSessionId) ?? false);
		const notification = resolveNotifications(
			msg,
			pipeResult.route,
			isSubagent,
			targetSessionId,
		);
		if (notification.sendPush && pushManager) {
			sendPushForEvent(
				pushManager,
				msg,
				log,
				buildPushContext(deps.slug, targetSessionId),
			);
		}
		if (
			notification.broadcastCrossSession &&
			notification.crossSessionPayload
		) {
			wsHandler.broadcast(
				notification.crossSessionPayload as import("../shared-types.js").RelayMessage,
			);
		}
	}
}

// ─── Wire all SSE consumer event listeners ───────────────────────────────────

export function wireSSEConsumer(
	deps: SSEWiringDeps,
	consumer: SSEConsumer,
): void {
	const { log } = deps;

	// Generation counter: incremented on each SSE connect. Async rehydration
	// callbacks compare their captured generation against the current value
	// and bail if a newer connect has superseded them (prevents duplicate
	// broadcasts on rapid reconnect).
	let rehydrationGen = 0;

	consumer.on("connected", () => {
		const gen = ++rehydrationGen;
		log.info("Connected to OpenCode event stream");
		deps.wsHandler.broadcast({
			type: "connection_status",
			status: "connected",
		});

		// Rehydrate pending permissions from OpenCode API on (re)connect.
		// Broadcast each recovered permission to all connected clients.
		if (deps.listPendingPermissions) {
			deps
				.listPendingPermissions()
				.then((pendingPermissions) => {
					if (gen !== rehydrationGen) return; // superseded
					log.debug(
						`listPendingPermissions returned ${pendingPermissions.length} permission(s)`,
					);
					if (pendingPermissions.length === 0) return;
					log.info(
						`Rehydrating ${pendingPermissions.length} pending permission(s) from API`,
					);
					const recovered = deps.permissionBridge.recoverPending(
						pendingPermissions.map((p) => {
							const sessionId =
								typeof p["sessionID"] === "string" ? p["sessionID"] : "";
							const patterns = Array.isArray(p["patterns"])
								? (p["patterns"] as string[])
								: undefined;
							const metadata =
								typeof p["metadata"] === "object" && p["metadata"] !== null
									? (p["metadata"] as Record<string, unknown>)
									: undefined;
							const always = Array.isArray(p["always"])
								? (p["always"] as string[])
								: undefined;
							return {
								id: p.id,
								permission: p.permission,
								sessionId,
								...(patterns ? { patterns } : {}),
								...(metadata ? { metadata } : {}),
								...(always ? { always } : {}),
							};
						}),
					);
					for (const perm of recovered) {
						deps.wsHandler.broadcast({
							type: "permission_request",
							sessionId: perm.sessionId,
							requestId: perm.requestId,
							toolName: perm.toolName,
							toolInput: perm.toolInput,
							always: perm.always ?? [],
						});
					}
				})
				.catch((err: unknown) =>
					log.warn(`Failed to rehydrate pending permissions: ${err}`),
				);
		}

		// Rehydrate pending questions from OpenCode API on (re)connect.
		// Route each question only to clients viewing its session.
		if (deps.listPendingQuestions) {
			deps
				.listPendingQuestions()
				.then((pendingQuestions) => {
					if (gen !== rehydrationGen) return; // superseded
					log.debug(
						`listPendingQuestions returned ${pendingQuestions.length} question(s)`,
					);
					if (pendingQuestions.length === 0) return;
					log.info(
						`Rehydrating ${pendingQuestions.length} pending question(s) from API`,
					);
					for (const pq of pendingQuestions) {
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

						const askMsg = {
							type: "ask_user" as const,
							toolId: pq.id,
							questions,
							...(toolCallId ? { toolUseId: toolCallId } : {}),
						};

						// Route to clients viewing this question's session
						const qSessionId = pq["sessionID"] as string | undefined;
						if (qSessionId) {
							deps.wsHandler.sendToSession(qSessionId, askMsg);
						} else {
							// No sessionID — broadcast as fallback (defensive)
							deps.wsHandler.broadcast(askMsg);
						}
					}
				})
				.catch((err: unknown) =>
					log.warn(`Failed to rehydrate pending questions: ${err}`),
				);
		}
	});

	consumer.on("disconnected", (err) => {
		log.warn(`Disconnected${err ? `: ${err.message}` : ""}`);
		deps.wsHandler.broadcast({
			type: "connection_status",
			status: "disconnected",
		});
	});
	consumer.on("reconnecting", ({ attempt, delay }) => {
		log.info(`Reconnecting (attempt ${attempt}, ${delay}ms delay)…`);
		deps.wsHandler.broadcast({
			type: "connection_status",
			status: "reconnecting",
		});
	});
	consumer.on("error", (err) => log.warn(`Error: ${err.message}`));

	consumer.on("event", (event: OpenCodeEvent) => {
		handleSSEEvent(deps, event);
	});
}
