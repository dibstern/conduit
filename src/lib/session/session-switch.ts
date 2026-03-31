// src/lib/session/session-switch.ts
// ─── Session Switch — Centralized session switching ─────────────────────────
// Single entry point for all session switches. Handlers delegate here instead
// of constructing session_switched messages manually.

import type { HistoryMessage, RequestId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

// ─── Pure data types ────────────────────────────────────────────────────────

/** Discriminated union describing where session history came from. */
export type SessionHistorySource =
	| {
			readonly kind: "cached-events";
			readonly events: readonly RelayMessage[];
			/** True when the event cache does not cover the full session
			 *  (eviction, late relay start). The frontend should fall through
			 *  to server pagination when the local replay buffer is exhausted. */
			readonly hasMore: boolean;
	  }
	| {
			readonly kind: "rest-history";
			readonly history: {
				readonly messages: readonly HistoryMessage[];
				readonly hasMore: boolean;
				readonly total?: number;
			};
	  }
	| { readonly kind: "empty" };

/** Options for building the session_switched message. */
export interface SessionSwitchMessageOptions {
	readonly draft?: string;
	readonly requestId?: RequestId;
}

/** Options for the switchClientToSession orchestrator. */
export interface SwitchClientOptions {
	readonly requestId?: RequestId;
	/** Skip cache/REST history lookup — send empty session_switched. Default: false. */
	readonly skipHistory?: boolean;
	/** Skip poller seeding. Default: false. */
	readonly skipPollerSeed?: boolean;
}

// ─── Dependency interface (principle of least privilege) ────────────────────

/** Narrowed deps for switchClientToSession — only what's needed, nothing more. */
export interface SessionSwitchDeps {
	readonly messageCache: {
		getEvents(sessionId: string): Promise<RelayMessage[] | null>;
	};
	readonly sessionMgr: {
		loadPreRenderedHistory(
			sessionId: string,
			offset?: number,
		): Promise<{
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
		}>;
		seedPaginationCursor(sessionId: string, messageId: string): void;
	};
	readonly wsHandler: {
		sendTo(clientId: string, msg: RelayMessage): void;
		setClientSession(clientId: string, sessionId: string): void;
	};
	readonly statusPoller?: { isProcessing(sessionId: string): boolean };
	readonly pollerManager?: {
		isPolling(sessionId: string): boolean;
		startPolling(sessionId: string, messages?: unknown[]): void;
	};
	readonly log: {
		info(...args: unknown[]): void;
		warn(...args: unknown[]): void;
	};
	readonly getInputDraft: (sessionId: string) => string | undefined;
	/** Fork metadata — used to force REST for fork sessions (SSE cache lacks inherited messages). */
	readonly forkMeta?: {
		getForkEntry(
			sessionId: string,
		): { forkMessageId: string; parentID: string } | undefined;
	};
}

// ─── Pure functions ─────────────────────────────────────────────────────────

/**
 * Classify whether cached SSE events contain renderable chat content.
 * Pure function — no side effects, no I/O.
 */
export function classifyHistorySource(
	events: readonly RelayMessage[] | null | undefined,
): "cached-events" | "needs-rest" {
	if (!events || events.length === 0) return "needs-rest";
	const hasChatContent = events.some(
		(e) => e.type === "user_message" || e.type === "delta",
	);
	return hasChatContent ? "cached-events" : "needs-rest";
}

/**
 * Count unique OpenCode messages referenced in cached events.
 * Uses optional `messageId` fields from streaming/tool events (each unique
 * messageId = one assistant message), plus counts `user_message` events.
 *
 * This is a conservative heuristic — SSE-path events may lack `messageId`,
 * causing undercounting and unnecessary REST fallbacks. This is safe:
 * correctness is preserved at the cost of one extra REST call on session view.
 */
export function countUniqueMessages(events: readonly RelayMessage[]): number {
	const messageIds = new Set<string>();
	let userMessageCount = 0;
	for (const e of events) {
		if (e.type === "user_message") {
			userMessageCount++;
		} else if (
			"messageId" in e &&
			typeof e.messageId === "string" &&
			e.messageId
		) {
			messageIds.add(e.messageId);
		}
	}
	return messageIds.size + userMessageCount;
}

/**
 * Extract the oldest OpenCode message ID from cached events.
 *
 * Iterates events in chronological order, returning the first `messageId`
 * found. This is used to seed the pagination cursor so that server-based
 * history loading can pick up where the event cache leaves off.
 *
 * Returns undefined if no events carry a messageId (e.g. only user_message
 * events with no assistant responses).
 */
export function extractOldestMessageId(
	events: readonly RelayMessage[],
): string | undefined {
	for (const e of events) {
		if ("messageId" in e && typeof e.messageId === "string" && e.messageId) {
			return e.messageId;
		}
	}
	return undefined;
}

/**
 * If session is idle and cached events lack a `done` event, append a synthetic one.
 * Matches the shape used by monitoring-wiring.ts and message-poller.ts.
 * Pure function — returns a new source or the original unchanged.
 */
export function patchMissingDone(
	source: SessionHistorySource,
	statusPoller: SessionSwitchDeps["statusPoller"],
	sessionId: string,
): SessionHistorySource {
	if (source.kind !== "cached-events") return source;
	if (statusPoller?.isProcessing(sessionId)) return source;

	const hasDone = source.events.some((e) => e.type === "done");
	if (hasDone) return source;

	return {
		kind: "cached-events",
		events: [...source.events, { type: "done", code: 0 }],
		hasMore: source.hasMore,
	};
}

/**
 * Build a session_switched message from resolved history source.
 * Pure function — no side effects, no I/O.
 *
 * @remarks Uses conditional spreads to satisfy exactOptionalPropertyTypes.
 * Never assigns `undefined` to optional properties.
 */
export function buildSessionSwitchedMessage(
	sessionId: string,
	source: SessionHistorySource,
	options?: SessionSwitchMessageOptions,
): Extract<RelayMessage, { type: "session_switched" }> {
	const optionalFields = {
		...(options?.draft ? { inputText: options.draft } : {}),
		...(options?.requestId != null ? { requestId: options.requestId } : {}),
	};

	switch (source.kind) {
		case "cached-events":
			return {
				type: "session_switched",
				id: sessionId,
				events: source.events as RelayMessage[],
				...(source.hasMore ? { eventsHasMore: true } : {}),
				...optionalFields,
			};
		case "rest-history":
			return {
				type: "session_switched",
				id: sessionId,
				history: {
					messages: source.history.messages as HistoryMessage[],
					hasMore: source.history.hasMore,
					...(source.history.total != null
						? { total: source.history.total }
						: {}),
				},
				...optionalFields,
			};
		case "empty":
			return {
				type: "session_switched",
				id: sessionId,
				...optionalFields,
			};
	}
}

// ─── Async I/O functions ────────────────────────────────────────────────────

/**
 * Resolve session history from cache or REST API.
 * Impure — reads from cache and may call REST.
 *
 * When the cache has chat content, it is served directly WITHOUT a validation
 * fetch. The cache may be stale (missing older messages), but:
 * - SSE events continuously fill the cache with new activity
 * - Users can load older messages via the "load more" pagination
 * - cold-cache-repair cleans up incomplete turns on restart
 *
 * This avoids fetching all messages (which can be 40MB+ for large sessions)
 * and prevents OOM when many project relays are loaded.
 */
export async function resolveSessionHistory(
	sessionId: string,
	deps: Pick<
		SessionSwitchDeps,
		"messageCache" | "sessionMgr" | "log" | "forkMeta"
	>,
): Promise<SessionHistorySource> {
	const events = await deps.messageCache.getEvents(sessionId);
	const classification = classifyHistorySource(events);

	if (classification === "cached-events" && events) {
		// Fork sessions: the SSE cache only has events from after the fork was
		// opened — it never contains the inherited parent messages. Force REST
		// so the frontend gets the full history with timestamps for splitting.
		const isFork = !!deps.forkMeta?.getForkEntry(sessionId);
		if (isFork) {
			deps.log.info(
				`Fork session ${sessionId.slice(0, 16)}: SSE cache has ${events.length} events but lacks inherited messages — using REST`,
			);
			try {
				const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
				return { kind: "rest-history", history };
			} catch (err) {
				deps.log.warn(
					`Failed to load history for fork ${sessionId}: ${err instanceof Error ? err.message : err}`,
				);
				return { kind: "empty" };
			}
		}

		// Heuristic: if the first event is a user_message, the cache starts
		// from session creation and covers the full session. If the first
		// event is mid-conversation (delta, tool_*, etc.), the cache was
		// truncated (eviction or late relay start) and older messages exist.
		const cacheAppearsComplete = events[0]?.type === "user_message";
		return {
			kind: "cached-events",
			events,
			hasMore: !cacheAppearsComplete,
		};
	}

	try {
		const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
		return { kind: "rest-history", history };
	} catch (err) {
		deps.log.warn(
			`Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : err}`,
		);
		return { kind: "empty" };
	}
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Switch a client to a session: resolve history, build and send the
 * session_switched message, send processing status, and seed the poller.
 *
 * This is the SINGLE entry point for all session switches. Handlers must
 * call this instead of constructing session_switched messages manually.
 */
export async function switchClientToSession(
	deps: SessionSwitchDeps,
	clientId: string,
	sessionId: string,
	options?: SwitchClientOptions,
): Promise<void> {
	if (!sessionId) return;

	deps.wsHandler.setClientSession(clientId, sessionId);

	// Resolve history source — cache-first, paginated REST fallback, no full-fetch
	const source: SessionHistorySource = options?.skipHistory
		? { kind: "empty" }
		: await resolveSessionHistory(sessionId, deps);

	// Patch missing done event for idle sessions served from cache
	const patchedSource = patchMissingDone(source, deps.statusPoller, sessionId);

	// Seed pagination cursor only when the cache is incomplete (hasMore=true).
	// Complete caches cover the full session — no server fallback needed.
	if (patchedSource.kind === "cached-events" && patchedSource.hasMore) {
		const oldestMsgId = extractOldestMessageId(patchedSource.events);
		if (oldestMsgId) {
			deps.sessionMgr.seedPaginationCursor(sessionId, oldestMsgId);
		}
	}

	// Build and send session_switched
	const draft = deps.getInputDraft(sessionId);
	const message = buildSessionSwitchedMessage(sessionId, patchedSource, {
		...(draft ? { draft } : {}),
		...(options?.requestId != null ? { requestId: options.requestId } : {}),
	});
	deps.wsHandler.sendTo(clientId, message);

	// Send processing status
	deps.wsHandler.sendTo(clientId, {
		type: "status",
		status: deps.statusPoller?.isProcessing(sessionId) ? "processing" : "idle",
	});

	// Start poller without seeding — the poller will self-seed on first poll.
	// Avoids a full getMessages() fetch that can OOM on large sessions.
	if (
		!options?.skipPollerSeed &&
		deps.pollerManager &&
		!deps.pollerManager.isPolling(sessionId)
	) {
		deps.pollerManager.startPolling(sessionId);
	}
}
