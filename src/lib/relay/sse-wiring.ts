// ─── SSE Event Wiring ────────────────────────────────────────────────────────
// Extracted from relay-stack.ts: the pipeline that takes SSE events from
// OpenCode, translates them, filters by session, records to cache, broadcasts
// to browser clients, and sends push notifications.

import { Cause, Effect, Runtime } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import type { OpenCodeRuntimeIngressResult } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import type {
	PendingPermissionRecoveryInput,
	PendingPermissionRequestInput,
} from "../domain/relay/Services/pending-interaction-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import type { OverridesStateTag } from "../domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../logger.js";
import { notificationContent } from "../notification-content.js";
import type { PushNotificationSender } from "../server/push.js";
import type { PermissionId } from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { PendingPermission, RelayMessage } from "../types.js";
import {
	applyPipelineResult,
	applyPipelineResultEffect,
	type ProcessingTimeoutsPort,
	processEvent,
} from "./event-pipeline.js";
import type { Translator } from "./event-translator.js";
import { resolveNotifications } from "./notification-policy.js";
import type { SSEEvent } from "./opencode-events.js";
import {
	hasInfoWithSessionID,
	hasPartWithSessionID,
	hasSessionID,
	isPermissionRepliedEvent,
	isSessionErrorEvent,
} from "./opencode-events.js";
import type { SSEStreamEvents } from "./sse-stream.js";

// ─── Session ID extraction ────────────────────────────────────────────────────
// OpenCode SSE events store sessionID in different locations by event type:
//   - Top-level: message.part.delta, session.status, message.part.removed, etc.
//   - Nested in part: message.part.updated → properties.part.sessionID
//   - Nested in info: message.updated → properties.info.sessionID
// We must check all locations to correctly attribute events to sessions.

export function extractSessionId(event: SSEEvent): string | undefined {
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

/** Narrowed Effect session service capabilities needed by SSE wiring. */
interface SessionServiceLike {
	recordMessageActivity(sessionId: string, timestamp?: number): void;
	incrementPendingQuestionCount(sessionId: string): void;
	addToParentMap(childId: string, parentId: string): void;
	sendDualSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: {
			statuses?:
				| Record<string, import("../instance/sdk-types.js").SessionStatus>
				| undefined;
		},
	): Promise<void>;
	setPendingQuestionCounts(counts: Map<string, number>): void;
}

interface PendingInteractionServiceLike {
	recordPermissionRequest(
		input: PendingPermissionRequestInput,
	): PendingPermission;
	markPermissionReplied(requestId: string): boolean;
	recoverPendingPermissions(
		permissions: readonly PendingPermissionRecoveryInput[],
	): PendingPermission[];
}

export interface SSEWiringDeps {
	translator: Translator;
	sessionService: SessionServiceLike;
	pendingInteractions: PendingInteractionServiceLike;
	processingTimeouts: ProcessingTimeoutsPort;
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendToSession: (sessionId: string, msg: RelayMessage) => void;
		getClientsForSession: (sessionId: string) => string[];
		/**
		 * Phase 0b: project-scoped per-session event firehose. Pipeline
		 * routing uses this (via `applyPipelineResult`) so per-session chat
		 * events reach every client on `/p/<slug>` regardless of viewed session.
		 */
		broadcastPerSessionEvent: (sessionId: string, msg: RelayMessage) => void;
	};
	pushManager?: PushNotificationSender;
	log: Logger;
	pipelineLog: Logger;
	/** Optional: current session statuses for processing flags */
	getSessionStatuses?: () => Record<
		string,
		import("../instance/sdk-types.js").SessionStatus
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
	statusPoller?: {
		notifySSEIdle(sessionId: string): void;
		/** One-shot reconciliation on SSE reconnect — corrects stuck statuses. */
		reconcileNow?(): Promise<void>;
	};
	/** Optional: session parent map for subagent detection in notification routing */
	getSessionParentMap?: () => Map<string, string>;
	/** Project slug for push notification routing */
	slug?: string;
	/** Optional: record that a "done" was delivered via SSE (for dedup with status-poller) */
	onDoneProcessed?: (sessionId: string) => void;
}

export type EffectSSEWiringDeps = Omit<
	SSEWiringDeps,
	| "pendingInteractions"
	| "processingTimeouts"
	| "sessionService"
	| "getSessionParentMap"
	| "getSessionStatuses"
	| "statusPoller"
> & {
	/** Optional: current session statuses for processing flags. */
	getSessionStatuses?: () => Effect.Effect<
		Record<string, import("../instance/sdk-types.js").SessionStatus>
	>;
	/** Optional: notify status poller of SSE status events and reconnects. */
	statusPoller?: {
		notifySSEIdle(sessionId: string): Effect.Effect<void>;
		reconcileNow?(): Effect.Effect<void>;
	};
	/** Effect-native OpenCode runtime ingress owned by the relay runtime. */
	opencodeRuntimeIngress?: {
		onSSEEventEffect(
			event: SSEEvent,
			sessionId: string | undefined,
		): Effect.Effect<OpenCodeRuntimeIngressResult>;
		onReconnect(): void;
	};
};

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

function recordSSEEventStart(
	deps: SSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
): void {
	deps.log.verbose(`event=${event.type} session=${eventSessionId ?? "?"}`);

	// ── Track message activity for session ordering ──────────────────────
	// Record the timestamp of any message-related event so sessions are
	// ordered by actual conversation activity, not metadata updates.
	if (eventSessionId && event.type.startsWith("message.")) {
		deps.sessionService.recordMessageActivity(eventSessionId, Date.now());
	}
}

const recordSSEEventStartEffect = (
	deps: EffectSSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
) =>
	Effect.gen(function* () {
		yield* Effect.sync(() =>
			deps.log.verbose(`event=${event.type} session=${eventSessionId ?? "?"}`),
		);
		if (deps.opencodeRuntimeIngress) {
			yield* deps.opencodeRuntimeIngress.onSSEEventEffect(
				event,
				eventSessionId,
			);
		}

		if (eventSessionId && event.type.startsWith("message.")) {
			const sessionService = yield* SessionManagerServiceTag;
			yield* sessionService.recordMessageActivity(eventSessionId, Date.now());
		}
	});

function permissionRequestInput(
	event: SSEEvent,
	eventSessionId: string | undefined,
): PendingPermissionRequestInput | undefined {
	const props = event.properties as {
		id?: string;
		sessionID?: string;
		permission?: string;
		patterns?: string[];
		metadata?: Record<string, unknown>;
		always?: string[];
	};
	if (!props.id || !props.permission) return undefined;
	return {
		requestId: props.id as PermissionId,
		sessionId: props.sessionID || eventSessionId || "",
		toolName: props.permission,
		toolInput: {
			patterns: props.patterns ?? [],
			metadata: props.metadata ?? {},
		},
		always: props.always ?? [],
	};
}

function permissionRecoveryInputs(
	pendingPermissions: Array<{
		id: string;
		permission: string;
		[key: string]: unknown;
	}>,
): PendingPermissionRecoveryInput[] {
	return pendingPermissions.map((p) => {
		const sessionId = typeof p["sessionID"] === "string" ? p["sessionID"] : "";
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
	});
}

function broadcastRecoveredPermissions(
	deps: SSEWiringDeps | EffectSSEWiringDeps,
	recovered: readonly PendingPermission[],
): void {
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
}

function broadcastPermissionAsked(
	deps: SSEWiringDeps | EffectSSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
	pending: PendingPermission | null,
): void {
	const { wsHandler, pushManager, log } = deps;
	if (pending) {
		const permSessionId = pending.sessionId;
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
		const props = event.properties as Record<string, unknown>;
		const id = typeof props["id"] === "string" ? props["id"] : "unknown";
		const tool =
			typeof props["permission"] === "string" ? props["permission"] : "A tool";
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

function handleQuestionAsked(
	deps: SSEWiringDeps,
	eventSessionId: string | undefined,
): void {
	deps.log.debug(`question.asked: event received`);
	if (eventSessionId) {
		deps.sessionService.incrementPendingQuestionCount(eventSessionId);
	}
	if (deps.pushManager) {
		sendPushForEvent(
			deps.pushManager,
			{
				type: "ask_user",
				sessionId: eventSessionId ?? "",
				toolId: "",
				questions: [],
			},
			deps.log,
			buildPushContext(deps.slug, eventSessionId),
		);
	}
}

const handleQuestionAskedEffect = (
	deps: EffectSSEWiringDeps,
	eventSessionId: string | undefined,
) =>
	Effect.gen(function* () {
		yield* Effect.sync(() => deps.log.debug(`question.asked: event received`));
		if (eventSessionId) {
			const sessionService = yield* SessionManagerServiceTag;
			yield* sessionService.incrementPendingQuestionCount(eventSessionId);
		}
		const pushManager = deps.pushManager;
		if (pushManager) {
			yield* Effect.sync(() =>
				sendPushForEvent(
					pushManager,
					{
						type: "ask_user",
						sessionId: eventSessionId ?? "",
						toolId: "",
						questions: [],
					},
					deps.log,
					buildPushContext(deps.slug, eventSessionId),
				),
			);
		}
	});

function handleSSEEventAfterPending(
	deps: SSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
): void {
	const {
		translator,
		sessionService,
		processingTimeouts,
		wsHandler,
		pushManager,
		pipelineLog,
		log,
	} = deps;

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
				sessionService.addToParentMap(childId, parentId);
			}
		}

		const statuses = deps.getSessionStatuses?.();
		sessionService
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

	// Tag per-session events with sessionId after translation.
	// The translator produces untagged events; we attach sessionId here
	// at the SSE emission site.
	const toSend: RelayMessage[] = translateResult.messages.map((m) =>
		targetSessionId
			? tagWithSessionId(m, targetSessionId)
			: (m as RelayMessage),
	);
	for (let msg of toSend) {
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
			processingTimeouts,
			wsHandler,
			log: pipelineLog,
		});

		// Record done delivery for dedup with status-poller synthetic done
		if (msg.type === "done" && targetSessionId) {
			deps.onDoneProcessed?.(targetSessionId);
		}

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

const refreshSessionListAfterUpdateEffect = (
	deps: EffectSSEWiringDeps,
	statuses:
		| Record<string, import("../instance/sdk-types.js").SessionStatus>
		| undefined,
) =>
	Effect.gen(function* () {
		const sessionService = yield* SessionManagerServiceTag;
		yield* sessionService
			.sendDualSessionLists((msg) => deps.wsHandler.broadcast(msg), {
				statuses,
			})
			.pipe(
				Effect.catchAll((err) =>
					Effect.sync(() =>
						deps.log.warn(
							`Failed to refresh sessions after session.updated: ${err}`,
						),
					),
				),
			);
	});

const handleSSEEventAfterPendingEffect = (
	deps: EffectSSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
) =>
	Effect.gen(function* () {
		const { translator, wsHandler, pushManager, pipelineLog, log } = deps;

		if (event.type === "session.updated") {
			if (hasInfoWithSessionID(event.properties)) {
				const info = event.properties.info;
				const childId = info.sessionID ?? info.id;
				const parentId =
					typeof (info as Record<string, unknown>)["parentID"] === "string"
						? ((info as Record<string, unknown>)["parentID"] as string)
						: undefined;
				if (childId && parentId) {
					const sessionService = yield* SessionManagerServiceTag;
					yield* sessionService.addToParentMap(childId, parentId);
				}
			}

			const statuses = deps.getSessionStatuses
				? yield* deps.getSessionStatuses()
				: undefined;
			yield* refreshSessionListAfterUpdateEffect(deps, statuses);
		}

		if (isSessionErrorEvent(event)) {
			const err = event.properties.error;
			yield* Effect.sync(() =>
				log.warn(
					`event=${event.type} session=${eventSessionId ?? "?"} Session error: ${err?.name ?? "?"} — ${err?.data?.message ?? "(no message)"}`,
				),
			);
		}

		if (event.type === "session.status") {
			const statusType = (
				event.properties?.["status"] as { type?: string } | undefined
			)?.type;
			if (statusType === "idle" && eventSessionId && deps.statusPoller) {
				yield* deps.statusPoller.notifySSEIdle(eventSessionId);
			}
		}

		if (event.type === "permission.asked") return;

		const translateResult = translator.translate(event, {
			sessionId: eventSessionId,
		});
		if (!translateResult.ok) {
			if (!translateResult.reason.startsWith("unhandled event type")) {
				yield* Effect.sync(() =>
					log.verbose(
						`translate skip: ${translateResult.reason} (${event.type})`,
					),
				);
			}
			return;
		}

		const targetSessionId = eventSessionId;
		const toSend: RelayMessage[] = translateResult.messages.map((m) =>
			targetSessionId
				? tagWithSessionId(m, targetSessionId)
				: (m as RelayMessage),
		);
		for (let msg of toSend) {
			if (
				msg.type === "permission_request" ||
				msg.type === "permission_resolved"
			) {
				yield* Effect.sync(() => wsHandler.broadcast(msg));
				continue;
			}

			if (msg.type === "ask_user" || msg.type === "ask_user_resolved") {
				if (msg.type === "ask_user") {
					const askMsg = msg as Extract<RelayMessage, { type: "ask_user" }>;
					yield* Effect.sync(() =>
						log.debug(
							`Routing ask_user to session=${targetSessionId ?? "?"}: toolId=${askMsg.toolId} questionCount=${askMsg.questions?.length ?? 0}`,
						),
					);
				}
				if (targetSessionId) {
					yield* Effect.sync(() => {
						wsHandler.sendToSession(targetSessionId, msg);
						wsHandler.broadcast({
							type: "notification_event",
							eventType: msg.type,
							...(targetSessionId != null
								? { sessionId: targetSessionId }
								: {}),
						});
					});
				} else {
					yield* Effect.sync(() => wsHandler.broadcast(msg));
				}
				continue;
			}

			const viewers = targetSessionId
				? wsHandler.getClientsForSession(targetSessionId)
				: [];
			const pipeResult = processEvent(msg, targetSessionId, viewers);
			msg = pipeResult.msg;

			yield* applyPipelineResultEffect(pipeResult, targetSessionId, {
				wsHandler,
				log: pipelineLog,
			});

			if (msg.type === "done" && targetSessionId) {
				yield* Effect.sync(() => deps.onDoneProcessed?.(targetSessionId));
			}

			let parentMap = new Map<string, string>();
			if (targetSessionId != null) {
				const sessionService = yield* SessionManagerServiceTag;
				parentMap = yield* sessionService.getSessionParentMap();
			}
			const isSubagent =
				targetSessionId != null && parentMap.has(targetSessionId);
			const notification = resolveNotifications(
				msg,
				pipeResult.route,
				isSubagent,
				targetSessionId,
			);
			if (notification.sendPush && pushManager) {
				yield* Effect.sync(() =>
					sendPushForEvent(
						pushManager,
						msg,
						log,
						buildPushContext(deps.slug, targetSessionId),
					),
				);
			}
			if (
				notification.broadcastCrossSession &&
				notification.crossSessionPayload
			) {
				yield* Effect.sync(() =>
					wsHandler.broadcast(
						notification.crossSessionPayload as import("../shared-types.js").RelayMessage,
					),
				);
			}
		}
	});

// ─── Handle a single SSE event ───────────────────────────────────────────────

export function handleSSEEvent(deps: SSEWiringDeps, event: SSEEvent): void {
	const eventSessionId = extractSessionId(event);
	recordSSEEventStart(deps, event, eventSessionId);
	// ── Permission / question bridge routing ──────────────────────────────

	if (event.type === "permission.asked") {
		const input = permissionRequestInput(event, eventSessionId);
		const pending = input
			? deps.pendingInteractions.recordPermissionRequest(input)
			: null;
		broadcastPermissionAsked(deps, event, eventSessionId, pending);
	}
	if (event.type === "question.asked") {
		handleQuestionAsked(deps, eventSessionId);
	}
	if (isPermissionRepliedEvent(event)) {
		deps.pendingInteractions.markPermissionReplied(
			event.properties.permissionID,
		);
	}

	handleSSEEventAfterPending(deps, event, eventSessionId);
}

export const handleSSEEventEffect = (
	deps: EffectSSEWiringDeps,
	event: SSEEvent,
) =>
	Effect.gen(function* () {
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const eventSessionId = extractSessionId(event);
		yield* recordSSEEventStartEffect(deps, event, eventSessionId);

		if (event.type === "permission.asked") {
			const input = permissionRequestInput(event, eventSessionId);
			const pending = input
				? yield* pendingInteractions.recordPermissionRequest(input)
				: null;
			yield* Effect.sync(() =>
				broadcastPermissionAsked(deps, event, eventSessionId, pending),
			);
		}
		if (event.type === "question.asked") {
			yield* handleQuestionAskedEffect(deps, eventSessionId);
		}
		if (isPermissionRepliedEvent(event)) {
			yield* pendingInteractions.markPermissionReplied(
				event.properties.permissionID,
			);
		}

		yield* handleSSEEventAfterPendingEffect(deps, event, eventSessionId);
	});

interface SSEConsumerCallbacks {
	handleEvent(event: SSEEvent): void;
	onReconnect?(): void;
	reconcileOnConnected(): void;
	recoverPendingPermissions(
		pendingPermissions: Array<{
			id: string;
			permission: string;
			[key: string]: unknown;
		}>,
	): void;
	recoverPendingQuestions(
		pendingQuestions: Array<{ id: string; [key: string]: unknown }>,
	): void;
}

function questionCountsBySession(
	pendingQuestions: Array<{ id: string; [key: string]: unknown }>,
): Map<string, number> {
	const questionCounts = new Map<string, number>();
	for (const pq of pendingQuestions) {
		const sid = pq["sessionID"] as string | undefined;
		if (sid) {
			questionCounts.set(sid, (questionCounts.get(sid) ?? 0) + 1);
		}
	}
	return questionCounts;
}

function broadcastRecoveredQuestions(
	deps: SSEWiringDeps | EffectSSEWiringDeps,
	pendingQuestions: Array<{ id: string; [key: string]: unknown }>,
): void {
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

		const qSessionId = pq["sessionID"] as string | undefined;
		const askMsg: RelayMessage = {
			type: "ask_user" as const,
			sessionId: qSessionId ?? "",
			toolId: pq.id,
			questions,
			...(toolCallId ? { toolUseId: toolCallId } : {}),
		};

		if (qSessionId) {
			deps.wsHandler.sendToSession(qSessionId, askMsg);
		} else {
			deps.wsHandler.broadcast(askMsg);
		}
	}
}

const recoverPendingQuestionsEffect = (
	deps: EffectSSEWiringDeps,
	pendingQuestions: Array<{ id: string; [key: string]: unknown }>,
) =>
	Effect.gen(function* () {
		const sessionService = yield* SessionManagerServiceTag;
		yield* sessionService.setPendingQuestionCounts(
			questionCountsBySession(pendingQuestions),
		);
		yield* Effect.sync(() =>
			broadcastRecoveredQuestions(deps, pendingQuestions),
		);
	});

function wireSSEConsumerWithCallbacks(
	deps: SSEWiringDeps | EffectSSEWiringDeps,
	consumer: SSEStreamEvents,
	callbacks: SSEConsumerCallbacks,
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

		callbacks.onReconnect?.();

		deps.wsHandler.broadcast({
			type: "connection_status",
			status: "connected",
		});

		callbacks.reconcileOnConnected();

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
					callbacks.recoverPendingPermissions(pendingPermissions);
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

					callbacks.recoverPendingQuestions(pendingQuestions);
					if (pendingQuestions.length > 0) {
						log.info(
							`Rehydrating ${pendingQuestions.length} pending question(s) from API`,
						);
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

	// Decode boundary: raw SSE frames are forwarded as `SSEEvent` without a
	// fail-closed envelope decode against OpenCodeEventSchema. Field-level
	// strictness (grill #10) is enforced downstream at the per-event translator
	// sites via the hand-written type guards in opencode-events.ts, which only
	// read the fields Conduit consumes. A blanket fail-closed decode here would
	// be actively unsafe today: those guards intentionally model a subset (and,
	// where they drift from the SDK — see conduit-test-1ao — a stricter gate
	// would drop live events wholesale rather than degrade one translator). Wire
	// OpenCodeEventSchema here only once the consumer guards are reconciled to
	// the SDK shapes (tracked in conduit-test-8g7).
	consumer.on("event", (event: unknown) => {
		callbacks.handleEvent(event as SSEEvent);
	});
}

// ─── Wire all SSE consumer event listeners ───────────────────────────────────

export function wireSSEConsumer(
	deps: SSEWiringDeps,
	consumer: SSEStreamEvents,
): void {
	wireSSEConsumerWithCallbacks(deps, consumer, {
		handleEvent: (event) => handleSSEEvent(deps, event),
		reconcileOnConnected: () => {
			if (deps.statusPoller?.reconcileNow) {
				deps.statusPoller
					.reconcileNow()
					.catch((err: unknown) =>
						deps.log.warn(`SSE reconnect reconciliation failed: ${err}`),
					);
			}
		},
		recoverPendingPermissions: (pendingPermissions) => {
			const recovered = deps.pendingInteractions.recoverPendingPermissions(
				permissionRecoveryInputs(pendingPermissions),
			);
			broadcastRecoveredPermissions(deps, recovered);
		},
		recoverPendingQuestions: (pendingQuestions) => {
			deps.sessionService.setPendingQuestionCounts(
				questionCountsBySession(pendingQuestions),
			);
			broadcastRecoveredQuestions(deps, pendingQuestions);
		},
	});
}

export const wireSSEConsumerEffect = (
	deps: EffectSSEWiringDeps,
	consumer: SSEStreamEvents,
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<
			| PendingInteractionServiceTag
			| OverridesStateTag
			| SessionManagerServiceTag
		>();
		yield* Effect.sync(() => {
			const runFork = Runtime.runFork(runtime);
			wireSSEConsumerWithCallbacks(deps, consumer, {
				handleEvent: (event) => {
					runFork(
						handleSSEEventEffect(deps, event).pipe(
							Effect.catchAllCause((cause) =>
								Effect.sync(() =>
									deps.log.warn(
										`SSE event handling failed: ${Cause.pretty(cause)}`,
									),
								),
							),
						),
					);
				},
				onReconnect: () => {
					deps.opencodeRuntimeIngress?.onReconnect();
				},
				reconcileOnConnected: () => {
					if (deps.statusPoller?.reconcileNow) {
						runFork(
							deps.statusPoller
								.reconcileNow()
								.pipe(
									Effect.catchAllCause((cause) =>
										Effect.sync(() =>
											deps.log.warn(
												`SSE reconnect reconciliation failed: ${Cause.pretty(cause)}`,
											),
										),
									),
								),
						);
					}
				},
				recoverPendingPermissions: (pendingPermissions) => {
					runFork(
						Effect.gen(function* () {
							const pendingInteractions = yield* PendingInteractionServiceTag;
							const recovered =
								yield* pendingInteractions.recoverPendingPermissions(
									permissionRecoveryInputs(pendingPermissions),
								);
							yield* Effect.sync(() =>
								broadcastRecoveredPermissions(deps, recovered),
							);
						}).pipe(
							Effect.catchAllCause((cause) =>
								Effect.sync(() =>
									deps.log.warn(
										`Failed to recover pending permissions: ${Cause.pretty(cause)}`,
									),
								),
							),
						),
					);
				},
				recoverPendingQuestions: (pendingQuestions) => {
					runFork(
						recoverPendingQuestionsEffect(deps, pendingQuestions).pipe(
							Effect.catchAllCause((cause) =>
								Effect.sync(() =>
									deps.log.warn(
										`Failed to recover pending questions: ${Cause.pretty(cause)}`,
									),
								),
							),
						),
					);
				},
			});
		});
	});
