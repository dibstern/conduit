// ─── Shared Event Pipeline ───────────────────────────────────────────────────
// Pure functions for event processing. Each function does one thing and returns
// data — no side effects. The caller composes them and executes side effects.

import type { Logger } from "../logger.js";
import type { RelayMessage } from "../shared-types.js";
import { truncateToolResult as truncateToolResultImpl } from "./truncate-content.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteDecision =
	| { action: "send"; sessionId: string }
	| { action: "drop"; reason: string };

export interface TruncateResult {
	msg: RelayMessage;
	/** Full content before truncation. Undefined if no truncation occurred. */
	fullContent: string | undefined;
}

export type EventSource = "sse" | "message-poller" | "status-poller" | "prompt";

export interface PipelineResult {
	msg: RelayMessage;
	fullContent: string | undefined;
	route: RouteDecision;
	cache: boolean;
	timeout: "clear" | "reset" | "none";
	source: EventSource;
}

// ─── Pure functions ──────────────────────────────────────────────────────────

/** Truncate tool_result messages over threshold. Other types pass through. */
export function truncateIfNeeded(msg: RelayMessage): TruncateResult {
	if (msg.type !== "tool_result") {
		return { msg, fullContent: undefined };
	}
	const { truncated, fullContent } = truncateToolResultImpl(msg);
	return { msg: truncated, fullContent };
}

/** Determine whether a message type should be cached for replay. */
export function shouldCache(
	type: RelayMessage["type"],
): type is CacheableEventType {
	return CACHEABLE_TYPES.has(type);
}

/**
 * Event types that are recorded to the message cache for replay.
 * Used to type-check test event arrays — if a test includes an event type
 * not in this list, it's fabricating data that wouldn't exist in the real cache.
 *
 * NOTE: "status" is intentionally excluded. All status:processing events
 * are sent via wsHandler.sendToSession() directly (prompt.ts, relay-stack.ts,
 * session.ts, client-init.ts) — none flow through the event pipeline.
 */
export const CACHEABLE_EVENT_TYPES = [
	"user_message",
	"delta",
	"thinking_start",
	"thinking_delta",
	"thinking_stop",
	"tool_start",
	"tool_executing",
	"tool_result",
	"result",
	"done",
	"error",
] as const;

export type CacheableEventType = (typeof CACHEABLE_EVENT_TYPES)[number];

const CACHEABLE_TYPES: ReadonlySet<RelayMessage["type"]> = new Set(
	CACHEABLE_EVENT_TYPES,
);

// ─── Compile-time assertion: CACHEABLE_EVENT_TYPES ⊆ RelayMessage["type"] ──
type _AssertCacheableSubset =
	(typeof CACHEABLE_EVENT_TYPES)[number] extends RelayMessage["type"]
		? true
		: { error: "CACHEABLE_EVENT_TYPES has invalid types" };
const _assertCacheableTypes: _AssertCacheableSubset = true;

/**
 * Event types that warrant a notification (sound/browser alert/push).
 * When the pipeline drops one of these because no viewers are on the session,
 * the server broadcasts a `notification_event` so clients can still fire
 * sound/browser notifications without updating chat state.
 *
 * NOTE: permission_request and ask_user are already broadcast/session-routed
 * separately in sse-wiring.ts (they bypass the pipeline), so only done and
 * error need the notification_event fallback.
 */
export const NOTIFICATION_EVENT_TYPES: ReadonlySet<RelayMessage["type"]> =
	new Set(["done", "error"]);

/** Check if a message type warrants a cross-session notification broadcast. */
export function isNotificationWorthy(type: RelayMessage["type"]): boolean {
	return NOTIFICATION_EVENT_TYPES.has(type);
}

/** Determine where to route a message: send to session viewers, or drop. */
export function resolveRoute(
	_msgType: string,
	sessionId: string | undefined,
	viewers: string[],
): RouteDecision {
	if (!sessionId) {
		return { action: "drop", reason: "no session ID" };
	}
	if (viewers.length > 0) {
		return { action: "send", sessionId };
	}
	return { action: "drop", reason: `no viewers for session ${sessionId}` };
}

/** Determine timeout action for a message. */
export function resolveTimeout(
	msgType: string,
	sessionId: string | undefined,
): "clear" | "reset" | "none" {
	if (!sessionId) return "none";
	if (msgType === "done") return "clear";
	// When a question is asked, the model is idle waiting for user input —
	// clear the processing timeout so it doesn't fire while the user types.
	// The timeout is restarted when the question is answered/rejected.
	if (msgType === "ask_user") return "clear";
	return "reset";
}

// ─── Side-effect application ─────────────────────────────────────────────────

/** Dependencies for applying pipeline side effects. */
export interface PipelineDeps {
	toolContentStore: {
		store(id: string, content: string, sessionId: string): void;
	};
	overrides: {
		clearProcessingTimeout(sessionId: string): void;
		resetProcessingTimeout(sessionId: string): void;
	};
	messageCache: { recordEvent(sessionId: string, msg: RelayMessage): void };
	wsHandler: { sendToSession(sessionId: string, msg: RelayMessage): void };
	log: Logger;
}

/**
 * Apply pipeline side effects based on PipelineResult decisions.
 * This is the single place where pipeline decisions become actions.
 */
export function applyPipelineResult(
	result: PipelineResult,
	sessionId: string | undefined,
	deps: PipelineDeps,
): void {
	if (
		result.fullContent !== undefined &&
		sessionId &&
		result.msg.type === "tool_result"
	) {
		deps.toolContentStore.store(result.msg.id, result.fullContent, sessionId);
	}
	if (result.timeout === "clear" && sessionId) {
		deps.overrides.clearProcessingTimeout(sessionId);
	} else if (result.timeout === "reset" && sessionId) {
		deps.overrides.resetProcessingTimeout(sessionId);
	}
	if (result.cache && sessionId) {
		deps.messageCache.recordEvent(sessionId, result.msg);
	}
	if (result.route.action === "send") {
		deps.wsHandler.sendToSession(result.route.sessionId, result.msg);
	} else {
		deps.log.info(
			`${result.route.reason} — ${result.msg.type} (${result.source})`,
		);
	}
}

// ─── Composed pipeline (convenience, still side-effect free) ─────────────────

/**
 * Process a relay event through the pipeline. Returns all decisions as data.
 * The caller is responsible for executing side effects (sending, caching, etc.).
 */
export function processEvent(
	msg: RelayMessage,
	sessionId: string | undefined,
	viewers: string[],
	source: EventSource = "sse",
): PipelineResult {
	const truncated = truncateIfNeeded(msg);
	return {
		msg: truncated.msg,
		fullContent: truncated.fullContent,
		route: resolveRoute(truncated.msg.type, sessionId, viewers),
		cache: sessionId != null && shouldCache(truncated.msg.type),
		timeout: resolveTimeout(truncated.msg.type, sessionId),
		source,
	};
}
