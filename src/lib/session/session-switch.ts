// src/lib/session/session-switch.ts
// ─── Session Switch — Centralized session switching ─────────────────────────
// Single entry point for all session switches. Handlers delegate here instead
// of constructing session_switched messages manually.

import { isLastTurnActive } from "../event-classify.js";
import type { ReadFlagMode, ReadFlags } from "../persistence/read-flags.js";
import { isActive } from "../persistence/read-flags.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import type { HistoryMessage, RequestId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
// Re-export for callers that need the mode type without a separate import.
export type { ReadFlagMode };

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
		getLastMessageAtMap?(): ReadonlyMap<string, number>;
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
	/** Phase 4e: SQLite read query service (optional, for gradual rollout). */
	readonly readQuery?: ReadQueryService;
	/** Phase 4e: Read path feature flags (optional, for gradual rollout). */
	readonly readFlags?: ReadFlags;
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
 * If session is idle and the cached event stream ends with an active
 * (unterminated) LLM turn, append a synthetic `done`.
 *
 * Uses {@link isLastTurnActive} — the canonical shared function for LLM turn
 * boundary detection. This ensures the server's patch logic matches the
 * frontend's `llmActive` tracking in `replayEvents()`.
 *
 * Pure function — returns a new source or the original unchanged.
 */
export function patchMissingDone(
	source: SessionHistorySource,
	statusPoller: SessionSwitchDeps["statusPoller"],
	sessionId: string,
): SessionHistorySource {
	if (source.kind !== "cached-events") return source;
	if (statusPoller?.isProcessing(sessionId)) return source;

	if (!isLastTurnActive(source.events)) return source;

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

// ─── SQLite history path (Phase 4e) ─────────────────────────────────────────

/**
 * Resolve session history from the SQLite projection.
 * Synchronous — all data comes from the local database.
 *
 * Returns a `SessionHistorySource` compatible with `buildSessionSwitchedMessage()`.
 * Uses the same `"rest-history"` kind as the REST path so the frontend cannot
 * tell whether data came from REST or SQLite.
 */
export function resolveSessionHistoryFromSqlite(
	sessionId: string,
	readQuery: ReadQueryService,
	opts: { pageSize: number },
): SessionHistorySource {
	const rows = readQuery.getSessionMessagesWithParts(sessionId);

	if (rows.length === 0) {
		return { kind: "empty" };
	}

	const { messages, hasMore } = messageRowsToHistory(rows, {
		pageSize: opts.pageSize,
	});

	return {
		kind: "rest-history",
		history: { messages, hasMore },
	};
}

// ─── Async I/O functions ────────────────────────────────────────────────────

/**
 * Resolve session history from SQLite or REST API.
 * Impure — may call REST.
 *
 * Phase 4e: When `readFlags.sessionHistory` is active ("shadow" or "sqlite")
 * and `readQuery` is available, reads from SQLite (synchronous, always fresh).
 * Otherwise falls back to REST API via loadPreRenderedHistory.
 *
 * The in-memory MessageCache path has been removed — SQLite is the source of
 * truth for history. See Task 50.5 in the implementation plan.
 */
export async function resolveSessionHistory(
	sessionId: string,
	deps: Pick<
		SessionSwitchDeps,
		"sessionMgr" | "log" | "readQuery" | "readFlags"
	>,
): Promise<SessionHistorySource> {
	// Phase 4e: Read from SQLite when flag is active (shadow or sqlite mode).
	// (C1) CRITICAL: use isActive(), not truthy check — "legacy" is a non-empty
	// string and would activate the SQLite path with a plain `if (flags.xxx)`.
	if (isActive(deps.readFlags?.sessionHistory) && deps.readQuery) {
		return resolveSessionHistoryFromSqlite(sessionId, deps.readQuery, {
			pageSize: 50,
		});
	}

	// Fallback: REST API
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
