// Extracted from relay-stack.ts: the pipeline that takes SSE events from
// OpenCode, translates them, filters by session, records to cache, broadcasts
// to browser clients, and sends push notifications.

import type { SqlError } from "@effect/sql/SqlError";
import { Cause, Data, Effect, Either, Option, Runtime, Schema } from "effect";
import { mapQuestionFields } from "../bridges/question-bridge.js";
import { OpenCodeEventSchema } from "../contracts/providers/opencode-sdk.js";
import type { ProjectSetting } from "../contracts/ws-rpc.js";
import {
	AlertLedgerTag,
	type SessionAlert,
} from "../domain/relay/Services/alert-ledger.js";
import type { OpenCodeRuntimeIngressResult } from "../domain/relay/Services/opencode-runtime-ingress-service.js";
import type { PendingPermissionRequestInput } from "../domain/relay/Services/pending-interaction-service.js";
import { PendingInteractionServiceTag } from "../domain/relay/Services/pending-interaction-service.js";
import {
	type ProjectSettingsTag,
	publishProjectSetting,
} from "../domain/relay/Services/project-settings.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	getPermissionMode,
	type OverridesStateTag,
} from "../domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../logger.js";
import { notificationContent } from "../notification-content.js";
import type {
	PushDeliveryReport,
	PushNotificationSender,
} from "../server/push.js";
import { describeDelivery } from "../server/push.js";
import type {
	Approval,
	PermissionId,
	SessionPermissionMode,
} from "../shared-types.js";
import { tagWithSessionId } from "../shared-types.js";
import type { PendingPermission, RelayMessage } from "../types.js";
import { applyPipelineResultEffect, processEvent } from "./event-pipeline.js";
import type { Translator } from "./event-translator.js";
import { resolveNotifications } from "./notification-policy.js";
import type { SSEEvent } from "./opencode-events.js";
import {
	hasInfoWithSessionID,
	hasPartWithSessionID,
	hasSessionID,
	isPermissionRepliedEvent,
	isQuestionAskedEvent,
	isSessionErrorEvent,
} from "./opencode-events.js";
import type { SSEStreamEvents } from "./sse-stream.js";

// Built once: envelope decoder for the fail-closed ingestion gate (see the
// consumer "event" handler). Returns Either<OpenCodeEvent, ParseError>.
const decodeOpenCodeEvent = Schema.decodeUnknownEither(OpenCodeEventSchema);

// OpenCode SSE events store sessionID in different locations by event type:
//   - Top-level: message.part.delta, session.status, message.part.removed, etc.
//   - Nested in part: message.part.updated → properties.part.sessionID
//   - Nested in info: message.updated → properties.info.sessionID
// We must check all locations to correctly attribute events to sessions.

export function extractSessionId(event: SSEEvent): string | undefined {
	const props = event.properties;
	if (hasSessionID(props)) {
		return props.sessionID;
	}
	if (hasPartWithSessionID(props)) {
		return props.part.sessionID;
	}
	if (hasInfoWithSessionID(props)) {
		return props.info.sessionID ?? props.info.id;
	}
	return undefined;
}

export interface SSEWiringDeps {
	translator: Translator;
	readonly providerInstanceId: string;
	wsHandler: {
		broadcast: (msg: RelayMessage) => void;
		sendToSession: (sessionId: string, msg: RelayMessage) => void;
		getClientsForSession: (sessionId: string) => string[];
		/**
		 * Project-scoped per-session event firehose. Pipeline
		 * routing uses this (via `applyPipelineResultEffect`) so per-session chat
		 * events reach every client on `/p/<slug>` regardless of viewed session.
		 */
		broadcastPerSessionEvent: (sessionId: string, msg: RelayMessage) => void;
	};
	pushManager?: PushNotificationSender;
	log: Logger;
	pipelineLog: Logger;
	/** Optional: notify status poller of SSE idle events. */
	statusPoller?: {
		notifySSEIdle(sessionId: string): Effect.Effect<void>;
	};
	/** Project slug for push notification routing */
	slug?: string;
	/** Optional: record that a "done" was delivered via SSE (for dedup with status-poller) */
	onDoneProcessed?: (sessionId: string) => void;
	/** Optional: reply to an OpenCode permission (auto-approve path). */
	replyPermission?: (
		sessionId: string,
		permissionId: string,
		response: "once",
	) => Promise<void>;
	/** Effect-native OpenCode runtime ingress owned by the relay runtime. */
	opencodeRuntimeIngress?: {
		onSSEEventEffect(
			event: SSEEvent,
			sessionId: string | undefined,
			providerInstanceId: string,
		): Effect.Effect<OpenCodeRuntimeIngressResult>;
		onReconnect(providerInstanceId?: string): Effect.Effect<void, SqlError>;
	};
}

// Extracted so both handleSSEEventEffect (SSE path) and relay-stack.ts (status/message
// poller paths) can fire push notifications for done/error events. Without this,
// push notifications are only sent when the translator produces done/error —
// but the translator returns ok:false for session.status:idle, so done events
// from the status poller never triggered push.

/** Minimal push manager interface for sendPushForEvent (avoids full PushNotificationManager import). */
interface PushSender {
	getSubscriptionIds?(): readonly string[];
	sendTo?: PushNotificationSender["sendTo"];
	sendToAll(payload: {
		type: string;
		title: string;
		body: string;
		tag: string;
		[key: string]: unknown;
	}): Promise<PushDeliveryReport>;
}

/** Session routing context for push notifications. */
export interface PushEventContext {
	slug?: string;
	sessionId?: string;
	/** Internal delivery scope; never sent to the browser. */
	recipientId?: string;
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
 * Legacy/test-only: the live relay runs the Effect wirings, which go through
 * {@link sendPushForEventEffect}. This twin has no durable delivery claim, so it can
 * ding again on a reload or reconnect — see ni8.23. It survives only because
 * the sync wirings still exist; retire it with them.
 *
 * When `context` is provided, `slug` and `sessionId` are included in the
 * payload so the service worker click handler can navigate directly to the
 * originating session.
 */
export function sendPushForEvent(
	pushManager: PushSender,
	msg: RelayMessage | Approval,
	log: Logger,
	context?: PushEventContext,
): void {
	const content = notificationContent(msg);
	if (!content) return;
	const kind = pushKind(msg);
	pushManager
		.sendToAll({
			type: kind,
			...content,
			...(context?.slug != null && { slug: context.slug }),
			...(context?.sessionId != null && { sessionId: context.sessionId }),
		})
		.then((report) => {
			if (report.delivered.length === 0)
				log.warn(
					`Push (${kind}) reached no device: ${describeDelivery(report)}`,
				);
		})
		.catch((err: unknown) => log.warn(`Push send failed (${kind}): ${err}`));
}

/**
 * The push payload's `type`. Approvals keep the names the old relay messages
 * had, because the service worker (sw.ts) and the alert ledger's persisted
 * kinds still key on them.
 */
const pushKind = (msg: RelayMessage | Approval): string =>
	"_tag" in msg
		? msg._tag === "permission"
			? "permission_request"
			: "ask_user"
		: msg.type;

/** A push that did not reach the push layer. Tagged so the ledger's own failures are distinguishable. */
class PushSendFailure extends Data.TaggedError("PushSendFailure")<{
	readonly cause: unknown;
}> {}

/**
 * What "the same ding" means for a push-worthy message (ni8.23).
 *
 * Alerts that can be live several at a time carry their own stable id, so every
 * path that re-observes one — including SSE reconnect recovery, which re-emits
 * every pending question at once — computes the same alert. Terminal messages
 * carry an originating identity supplied by the durable event translator.
 * Anonymous idle hints cannot identify a completed turn and do not claim one.
 */
const pushAlert = (
	msg: RelayMessage | Approval,
	sessionId: string | undefined,
): SessionAlert | undefined => {
	if (sessionId == null) return undefined;
	if ("_tag" in msg)
		return msg._tag === "permission"
			? {
					sessionId,
					kind: "permission_request",
					originId: `${sessionId}:permission:${msg.requestId}`,
					detail: msg.requestId,
				}
			: {
					sessionId,
					kind: "ask_user",
					originId: `${sessionId}:question:${msg.toolId}`,
					detail: msg.toolId,
				};
	switch (msg.type) {
		case "done":
			return msg.alertId
				? { sessionId, kind: "done", originId: msg.alertId }
				: undefined;
		case "error":
			return msg.alertId
				? {
						sessionId,
						kind: "error",
						originId: msg.alertId,
						detail: msg.message ?? "",
					}
				: undefined;
		default:
			return undefined;
	}
};

/**
 * At-least-once delivery of the same push as {@link sendPushForEvent}, deduplicated
 * per successful receipt. Abandoned attempts may be retried and recipients
 * deduplicate the immutable alert identity.
 *
 * This is the Effect-shaped path, and the only one the live relay uses. The
 * difference that matters is not the shape: it is that the send is a real
 * Effect, so a push that fails is a failure the ledger can see and give the
 * claim back for, instead of a `.catch` that swallows it after a row already
 * says the user was told.
 *
 * Delivery requires a durable claim. Missing or failed storage is logged and
 * leaves the alert available for the next observation once storage recovers.
 */
export const sendPushForEventEffect = (
	pushManager: PushSender,
	msg: RelayMessage | Approval,
	log: Logger,
	context?: PushEventContext,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const content = notificationContent(msg);
		if (!content) return;
		const kind = pushKind(msg);

		// Persist one claim per recipient so a retry reaches only devices whose
		// previous delivery failed. The real adapter always exposes this seam.
		if (
			context?.recipientId === undefined &&
			pushManager.getSubscriptionIds &&
			pushManager.sendTo
		) {
			const recipients = pushManager.getSubscriptionIds();
			if (recipients.length > 0) {
				yield* Effect.forEach(recipients, (recipientId) =>
					sendPushForEventEffect(pushManager, msg, log, {
						...context,
						recipientId,
					}),
				);
				return;
			}
		}

		const baseAlert = pushAlert(msg, context?.sessionId);
		const payload = {
			type: kind,
			alertId: baseAlert?.originId,
			...content,
			...(context?.slug != null && { slug: context.slug }),
			...(context?.sessionId != null && { sessionId: context.sessionId }),
		};
		// A send that reached nobody is a failed send, whatever the promise did.
		// This is the whole of P1-4: the adapter used to swallow every
		// per-recipient error and resolve, so the ledger wrote "the user was told"
		// for a push that left no device. It now reports who got it, and only a
		// report with at least one delivery is allowed to keep a claim.
		//
		const send = Effect.tryPromise({
			try: () =>
				context?.recipientId !== undefined && pushManager.sendTo
					? pushManager.sendTo(context.recipientId, payload)
					: pushManager.sendToAll(payload),
			catch: (cause) => new PushSendFailure({ cause }),
		}).pipe(
			Effect.flatMap((report) =>
				report.delivered.length > 0
					? Effect.void
					: Effect.fail(
							new PushSendFailure({
								cause: `reached no device (${describeDelivery(report)})`,
							}),
						),
			),
		);

		const alert =
			baseAlert && context?.recipientId !== undefined
				? { ...baseAlert, recipientId: context.recipientId }
				: baseAlert;
		const ledger = yield* Effect.serviceOption(AlertLedgerTag);
		if (alert === undefined || Option.isNone(ledger)) {
			yield* Effect.sync(() =>
				log.warn(
					`Push (${kind}) deferred without a durable delivery claim (` +
						`${alert === undefined ? "no immutable alert identity" : "alert ledger unwired"}` +
						`) — delivery requires the alert ledger`,
				),
			);
			return;
		}

		yield* ledger.value.deliver(alert, send).pipe(
			Effect.tap((fired) =>
				fired
					? Effect.void
					: Effect.sync(() =>
							log.verbose(
								`Push (${kind}) already delivered or in flight for this origin`,
							),
						),
			),
			Effect.catchTag("PushSendFailure", (failure) =>
				Effect.sync(() =>
					log.warn(
						`Push send failed (${kind}): ${failure.cause} — ` +
							`the claim was released, the next path to notice will retry`,
					),
				),
			),
			// Without a claim, delivery could repeat an alert already sent.
			Effect.catchAll((sqlError) =>
				Effect.sync(() =>
					log.error(
						`Alert ledger unavailable (${kind}); delivery deferred: ${sqlError}`,
					),
				),
			),
		);
	});

const recordSSEEventStartEffect = (
	deps: SSEWiringDeps,
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
				deps.providerInstanceId,
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

/** OpenCode ask types auto-approved under "acceptEdits" ("edit" is a first-class category). */
function opencodeModeCoversAsk(
	mode: SessionPermissionMode,
	permissionType: string,
): boolean {
	if (mode === "full") return true;
	if (mode === "acceptEdits") return permissionType === "edit";
	return false;
}

/**
 * The ding a permission request deserves. Browsers see the card itself through
 * the approvals subscription (ni8.9); this is only what the push says.
 *
 * Returning the approval instead of pushing it is what lets the caller choose
 * the sender: the live relay is the Effect wiring, and only the Effect sender
 * takes a durable delivery claim (ni8.23 delta 1, P2-8).
 */
function permissionAskedPush(
	event: SSEEvent,
	eventSessionId: string | undefined,
	pending: PendingPermission | null,
): Approval {
	if (pending) {
		return {
			_tag: "permission",
			sessionId: pending.sessionId,
			requestId: pending.requestId,
			toolName: pending.toolName,
			toolInput: pending.toolInput,
		};
	}
	// Bridge rejected (missing id/permission) — still worth a ding. The id on
	// the raw event is the alert identity even when the bridge would not take
	// it; without one every rejected request in a turn would collapse into the
	// same claim.
	const props = event.properties as Record<string, unknown>;
	const id = typeof props["id"] === "string" ? props["id"] : "unknown";
	const tool =
		typeof props["permission"] === "string" ? props["permission"] : "A tool";
	return {
		_tag: "permission",
		sessionId: eventSessionId ?? "",
		requestId: id as PermissionId,
		toolName: tool,
		toolInput: {},
	};
}

/**
 * The ding for a question the model just asked.
 *
 * The identity comes off the event. The previous version sent `toolId: ""` for
 * every question, which made two different questions in one turn the same
 * alert: the ledger claimed the first and swallowed the second, and the user
 * was never told about it (ni8.23 delta 1, P2-8).
 */
function questionAskedPush(
	deps: SSEWiringDeps,
	event: SSEEvent,
	eventSessionId: string | undefined,
): Approval {
	deps.log.debug(`question.asked: event received`);
	if (!isQuestionAskedEvent(event)) {
		const id = "id" in event.properties ? event.properties.id : undefined;
		deps.log.warn(
			`question.asked without an id or questions — sending available request details`,
		);
		return {
			_tag: "question",
			sessionId: eventSessionId ?? "",
			toolId: typeof id === "string" ? id : "",
			questions: [],
		};
	}
	return {
		_tag: "question",
		sessionId: eventSessionId ?? "",
		toolId: event.properties.id,
		questions: mapQuestionFields(event.properties.questions),
	};
}

const refreshSessionListAfterUpdateEffect = (deps: SSEWiringDeps) =>
	Effect.gen(function* () {
		const sessionService = yield* SessionManagerServiceTag;
		yield* sessionService
			.pushViewerFamilies()
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
	deps: SSEWiringDeps,
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

			yield* refreshSessionListAfterUpdateEffect(deps);
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
				yield* sendPushForEventEffect(
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
				yield* Effect.sync(() =>
					wsHandler.broadcast(
						notification.crossSessionPayload as import("../shared-types.js").RelayMessage,
					),
				);
			}
		}
	});

export const handleSSEEventEffect = (deps: SSEWiringDeps, event: SSEEvent) =>
	Effect.gen(function* () {
		const pendingInteractions = yield* PendingInteractionServiceTag;
		const eventSessionId = extractSessionId(event);
		yield* recordSSEEventStartEffect(deps, event, eventSessionId);

		if (event.type === "permission.asked") {
			const input = permissionRequestInput(event, eventSessionId);
			const mode = input?.sessionId
				? yield* getPermissionMode(input.sessionId)
				: ("ask" as const);
			const reply = deps.replyPermission;
			let autoApproved = false;
			if (
				input?.sessionId &&
				reply &&
				opencodeModeCoversAsk(mode, input.toolName)
			) {
				const replied = yield* Effect.either(
					Effect.tryPromise(() =>
						reply(input.sessionId, input.requestId, "once"),
					),
				);
				if (replied._tag === "Right") {
					autoApproved = true;
					yield* Effect.sync(() =>
						deps.log.info(
							`auto-approved ${input.toolName} (mode=${mode}, session=${input.sessionId}, request=${input.requestId})`,
						),
					);
				} else {
					yield* Effect.sync(() =>
						deps.log.warn(
							`auto-approve reply failed, falling back to card (request=${input.requestId}): ${replied.left}`,
						),
					);
				}
			}
			if (!autoApproved) {
				const pending = input
					? yield* pendingInteractions.recordPermissionRequest(input)
					: null;
				const pushManager = deps.pushManager;
				if (pushManager)
					yield* sendPushForEventEffect(
						pushManager,
						permissionAskedPush(event, eventSessionId, pending),
						deps.log,
						buildPushContext(deps.slug, pending?.sessionId ?? eventSessionId),
					);
			}
		}
		if (event.type === "question.asked") {
			const askMsg = yield* Effect.sync(() =>
				questionAskedPush(deps, event, eventSessionId),
			);
			const pushManager = deps.pushManager;
			if (pushManager)
				yield* sendPushForEventEffect(
					pushManager,
					askMsg,
					deps.log,
					buildPushContext(deps.slug, eventSessionId),
				);
		}
		if (isPermissionRepliedEvent(event)) {
			yield* pendingInteractions.markPermissionReplied(
				event.properties.requestID,
			);
		}

		yield* handleSSEEventAfterPendingEffect(deps, event, eventSessionId);
	});

interface SSEConsumerCallbacks {
	handleEvent(event: SSEEvent): void;
	onReconnect?(): void;
	/** The relay's upstream stream state, for the banner on every tab. */
	onConnectionStatus(
		status: Extract<ProjectSetting, { _tag: "opencodeConnection" }>["status"],
	): void;
}

function wireSSEConsumerWithCallbacks(
	deps: SSEWiringDeps,
	consumer: SSEStreamEvents,
	callbacks: SSEConsumerCallbacks,
): void {
	const { log } = deps;

	// Pending prompts and missed status are recovered upstream by OpenCode
	// Instances and arrive as ordinary stream events.
	consumer.on("connected", () => {
		log.info("Connected to OpenCode event stream");

		callbacks.onReconnect?.();
		callbacks.onConnectionStatus("connected");
	});

	consumer.on("disconnected", (err) => {
		log.warn(`Disconnected${err ? `: ${err.message}` : ""}`);
		callbacks.onConnectionStatus("disconnected");
	});
	consumer.on("reconnecting", ({ attempt, delay }) => {
		log.info(`Reconnecting (attempt ${attempt}, ${delay}ms delay)…`);
		callbacks.onConnectionStatus("reconnecting");
	});
	consumer.on("error", (err) => log.warn(`Error: ${err.message}`));

	// Decode boundary. OpenCodeEventSchema now models the full
	// 1.17.18 event surface (all 89 event types), and the consumer guards are
	// reconciled to the real wire, so an envelope decode here
	// is finally meaningful: a failure means the frame is malformed or the server
	// introduced a new/renamed event type we do not yet model. We surface that as
	// a warning but ALWAYS forward the raw event — a hard fail-closed drop would
	// silently lose live traffic (e.g. a future server event) and regress today's
	// pass-through behavior. Field-level consumption stays guarded per translator.
	consumer.on("event", (event: unknown) => {
		if (Either.isLeft(decodeOpenCodeEvent(event))) {
			const type =
				typeof (event as { type?: unknown } | null)?.type === "string"
					? (event as { type: string }).type
					: "(unknown)";
			log.warn(
				`SSE event failed OpenCodeEventSchema decode (forwarded raw): type=${type}`,
			);
		}
		callbacks.handleEvent(event as SSEEvent);
	});
}

export const wireSSEConsumerEffect = (
	deps: SSEWiringDeps,
	consumer: SSEStreamEvents,
) =>
	Effect.gen(function* () {
		const runtime = yield* Effect.runtime<
			| PendingInteractionServiceTag
			| OverridesStateTag
			| SessionManagerServiceTag
			| ProjectSettingsTag
		>();
		yield* Effect.sync(() => {
			const runFork = Runtime.runFork(runtime);
			wireSSEConsumerWithCallbacks(deps, consumer, {
				onConnectionStatus: (status) => {
					runFork(
						publishProjectSetting({ _tag: "opencodeConnection", status }),
					);
				},
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
					if (deps.opencodeRuntimeIngress)
						runFork(
							deps.opencodeRuntimeIngress
								.onReconnect(deps.providerInstanceId)
								.pipe(
									Effect.catchAllCause((cause) =>
										Effect.sync(() =>
											deps.log.warn(
												`OpenCode reconnect backfill scheduling failed: ${Cause.pretty(cause)}`,
											),
										),
									),
								),
						);
				},
			});
		});
	});
