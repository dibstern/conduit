// src/lib/session/session-switch.ts
// ─── Session Switch — Centralized session switching ─────────────────────────
// Single entry point for all session switches. Handlers delegate here instead
// of constructing session_switched messages manually.

import type { HistoryMessage, RequestId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

// ─── Pure data types ────────────────────────────────────────────────────────

/** Discriminated union describing where session history came from. */
export type SessionHistorySource =
	| { readonly kind: "cached-events"; readonly events: readonly RelayMessage[] }
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
		/** Build a history page from already-fetched messages (no I/O). */
		buildPreRenderedHistoryFromMessages(
			messages: unknown[],
			offset?: number,
		): {
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
		};
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
	readonly client: {
		getMessages(sessionId: string): Promise<unknown[]>;
	};
	readonly log: {
		info(...args: unknown[]): void;
		warn(...args: unknown[]): void;
	};
	readonly getInputDraft: (sessionId: string) => string | undefined;
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

/** Result of resolveSessionHistory, including any messages fetched during resolution. */
export interface ResolvedSessionHistory {
	readonly source: SessionHistorySource;
	/**
	 * Raw messages fetched during resolution — reusable for poller seeding
	 * to avoid a redundant full-fetch. Only present when a REST fetch occurred.
	 */
	readonly fetchedMessages?: unknown[];
}

/**
 * Resolve session history from cache or REST API.
 * Impure — reads from cache and may call REST.
 *
 * When the cache exists but may be stale, a SINGLE getMessages() call is
 * used for both count validation AND as the REST fallback data. This avoids
 * the previous pattern where getMessageCount + loadPreRenderedHistory caused
 * two full-message fetches whose overlapping heap usage could OOM the process.
 */
export async function resolveSessionHistory(
	sessionId: string,
	deps: Pick<
		SessionSwitchDeps,
		"messageCache" | "sessionMgr" | "log" | "client"
	>,
): Promise<ResolvedSessionHistory> {
	const events = await deps.messageCache.getEvents(sessionId);
	const classification = classifyHistorySource(events);

	if (classification === "cached-events" && events) {
		// Validate cache completeness with a SINGLE fetch — the same response
		// serves as both the count source and the REST fallback when stale.
		try {
			const messages = await deps.client.getMessages(sessionId);
			const cachedCount = countUniqueMessages(events);
			if (cachedCount >= messages.length) {
				return {
					source: { kind: "cached-events", events },
					fetchedMessages: messages,
				};
			}
			deps.log.info(
				`Cache stale for ${sessionId.slice(0, 12)}: cache covers ${cachedCount}/${messages.length} messages — falling back to REST`,
			);
			// Reuse the already-fetched messages instead of a second REST call
			const history =
				deps.sessionMgr.buildPreRenderedHistoryFromMessages(messages);
			return {
				source: { kind: "rest-history", history },
				fetchedMessages: messages,
			};
		} catch {
			// Validation failed — serve cache rather than nothing
			return { source: { kind: "cached-events", events } };
		}
	}

	try {
		const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
		return { source: { kind: "rest-history", history } };
	} catch (err) {
		deps.log.warn(
			`Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : err}`,
		);
		return { source: { kind: "empty" } };
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

	// Resolve history source (single-fetch: returns any messages already fetched)
	const resolved: ResolvedSessionHistory = options?.skipHistory
		? { source: { kind: "empty" } }
		: await resolveSessionHistory(sessionId, deps);

	// Patch missing done event for idle sessions served from cache
	const patchedSource = patchMissingDone(
		resolved.source,
		deps.statusPoller,
		sessionId,
	);

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

	// Seed poller — reuse already-fetched messages when available to avoid
	// yet another full REST fetch (the previous triple-fetch was the OOM trigger).
	if (
		!options?.skipPollerSeed &&
		deps.pollerManager &&
		!deps.pollerManager.isPolling(sessionId)
	) {
		if (resolved.fetchedMessages) {
			deps.pollerManager.startPolling(sessionId, resolved.fetchedMessages);
		} else {
			deps.client
				.getMessages(sessionId)
				.then((msgs) => deps.pollerManager?.startPolling(sessionId, msgs))
				.catch((err) =>
					deps.log.warn(
						`Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
					),
				);
		}
	}
}
