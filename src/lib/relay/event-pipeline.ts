// Pure functions for event processing. Each function does one thing and returns
// data — no side effects. The caller composes them and executes side effects.

import { Effect } from "effect";
import {
	clearProcessingTimeout,
	PROCESSING_TIMEOUT_DURATION,
	resetProcessingTimeout,
} from "../domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../logger.js";
import type { RelayMessage } from "../shared-types.js";
import { truncateToolResult as truncateToolResultImpl } from "./truncate-content.js";

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

/** Truncate tool_result messages over threshold. Other types pass through. */
export function truncateIfNeeded(msg: RelayMessage): TruncateResult {
	if (msg.type !== "tool_result") {
		return { msg, fullContent: undefined };
	}
	const { truncated, fullContent } = truncateToolResultImpl(msg);
	return { msg: truncated, fullContent };
}

/** Determine whether a message type is persisted to the event store for replay. */
export function shouldCache(
	type: RelayMessage["type"],
): type is PersistedEventType {
	return PERSISTED_TYPES.has(type);
}

/**
 * Event types that are persisted to the SQLite event store for replay.
 * Used to type-check test event arrays — if a test includes an event type
 * not in this list, it's fabricating data that wouldn't exist in the real store.
 */
export const PERSISTED_EVENT_TYPES = [
	"user_message",
	"delta",
	"thinking_start",
	"thinking_delta",
	"tool_start",
	"tool_result",
	"result",
	"done",
] as const;

export type PersistedEventType = (typeof PERSISTED_EVENT_TYPES)[number];

const PERSISTED_TYPES: ReadonlySet<RelayMessage["type"]> = new Set(
	PERSISTED_EVENT_TYPES,
);

type _AssertPersistedSubset =
	(typeof PERSISTED_EVENT_TYPES)[number] extends RelayMessage["type"]
		? true
		: { error: "PERSISTED_EVENT_TYPES has invalid types" };
const _assertPersistedTypes: _AssertPersistedSubset = true;

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
	return "reset";
}

/** Dependencies for applying pipeline side effects. */
export interface ProcessingTimeoutsPort {
	clearProcessingTimeout(sessionId: string): void;
	resetProcessingTimeout(sessionId: string): void;
}

export interface PipelineDeps {
	processingTimeouts: ProcessingTimeoutsPort;
	log: Logger;
}

/** Apply processing timeouts and log viewer-routing decisions. */
export function applyPipelineResult(
	result: PipelineResult,
	sessionId: string | undefined,
	deps: PipelineDeps,
): void {
	if (result.timeout === "clear" && sessionId) {
		deps.processingTimeouts.clearProcessingTimeout(sessionId);
	} else if (result.timeout === "reset" && sessionId) {
		deps.processingTimeouts.resetProcessingTimeout(sessionId);
	}
	if (result.route.action === "drop") {
		deps.log.info(
			`${result.route.reason} — ${result.msg.type} (${result.source})`,
		);
	}
}

export function applyPipelineResultEffect(
	result: PipelineResult,
	sessionId: string | undefined,
	deps: Omit<PipelineDeps, "processingTimeouts">,
) {
	return Effect.gen(function* () {
		if (result.timeout === "clear" && sessionId) {
			yield* clearProcessingTimeout(sessionId);
		} else if (result.timeout === "reset" && sessionId) {
			yield* resetProcessingTimeout(sessionId, PROCESSING_TIMEOUT_DURATION);
		}
		yield* Effect.sync(() => {
			if (result.route.action === "drop") {
				deps.log.info(
					`${result.route.reason} — ${result.msg.type} (${result.source})`,
				);
			}
		});
	});
}

// Composed pipeline (convenience, still side-effect free)

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
