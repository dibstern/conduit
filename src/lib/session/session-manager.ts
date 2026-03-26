// ─── Session Management Layer (Ticket 2.3) ───────────────────────────────────
// Manages the mapping between OpenCode sessions and the relay's representation.
// OpenCode (SQLite) is always the source of truth — the relay never duplicates
// storage. This layer proxies session CRUD and maintains in-memory active state.

import { EventEmitter } from "node:events";
import {
	type ForkEntry,
	loadForkMetadata,
	saveForkMetadata,
} from "../daemon/fork-metadata.js";
import type {
	OpenCodeClient,
	SessionDetail,
	SessionStatus,
} from "../instance/opencode-client.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { preRenderHistoryMessages } from "../relay/markdown-renderer.js";
import type { HistoryMessage } from "../shared-types.js";
import type { RelayMessage, SessionInfo } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionManagerOptions {
	client: OpenCodeClient;
	/** Number of messages to load per page (default 50) */
	historyPageSize?: number;
	/** Logger for diagnostics */
	log?: Logger;
	/** Project directory (for debug logging) */
	directory?: string;
	/** Optional getter for current session statuses (for processing indicators) */
	getStatuses?: () => Record<string, SessionStatus>;
	/** Config directory for fork metadata persistence */
	configDir?: string;
}

export interface SessionManagerEvents {
	/** Broadcast this message to all connected clients */
	broadcast: [RelayMessage];
	/** Send to a specific client */
	send: [{ clientId: string; message: RelayMessage }];
	/** Session created or deleted (discriminated payload) */
	session_lifecycle: [
		| { type: "created"; sessionId: string }
		| { type: "deleted"; sessionId: string },
	];
}

export interface HistoryPage {
	messages: HistoryMessage[];
	hasMore: boolean;
	/** Total messages in the session (if known) */
	total?: number;
}

// ─── Session Manager ─────────────────────────────────────────────────────────

export class SessionManager extends EventEmitter<SessionManagerEvents> {
	private readonly client: OpenCodeClient;
	private readonly historyPageSize: number;
	private readonly log: Logger;
	private readonly directory: string | undefined;
	private readonly getStatuses: (() => Record<string, SessionStatus>) | null;
	private readonly configDir: string | undefined;

	/**
	 * Cached child→parent map built from the most recent session list fetch.
	 * Updated every time listSessions() is called. Used by the status poller
	 * to propagate subagent busy status to parent sessions.
	 */
	private cachedParentMap = new Map<string, string>();

	/**
	 * Tracks the timestamp of the last message received per session.
	 * Used to sort the session list by most-recently-messaged first.
	 * Seeded during initialize() and updated incrementally from SSE events.
	 */
	private lastMessageAt = new Map<string, number>();

	/**
	 * Fork-point metadata: maps forked sessionId → messageId at the fork point.
	 * Loaded from disk on construction, updated on fork, saved on mutation.
	 */
	private forkMeta: Map<string, ForkEntry>;

	/**
	 * Session count from the most recent listSessions() call.
	 * Used by the daemon to report session counts without an API call.
	 */
	private _lastKnownSessionCount = 0;

	/**
	 * Tracks the number of pending questions per session.
	 * Updated from SSE events (question.asked, ask_user_resolved) and
	 * bulk-set on SSE reconnect from listPendingQuestions.
	 */
	private pendingQuestionCounts = new Map<string, number>();

	/**
	 * Cursor for paginated history loading. Maps sessionId → oldest message ID
	 * from the last loaded page. Used by loadHistory(offset>0) to fetch the
	 * next page of older messages via getMessagesPage({ before }).
	 * Reset on session switch (when offset=0 is loaded for a new session).
	 */
	private paginationCursors = new Map<string, string>();

	constructor(options: SessionManagerOptions) {
		super();
		this.client = options.client;
		this.historyPageSize = options.historyPageSize ?? 50;
		this.log = options.log ?? createSilentLogger();
		this.directory = options.directory;
		this.getStatuses = options.getStatuses ?? null;
		this.configDir = options.configDir;
		this.forkMeta = loadForkMetadata(options.configDir);
	}

	// ─── Queries ──────────────────────────────────────────────────────────

	/**
	 * Session count from the most recent unfiltered listSessions() call.
	 * Synchronous — returns cached count. 0 until first fetch completes.
	 */
	getLastKnownSessionCount(): number {
		return this._lastKnownSessionCount;
	}

	/**
	 * Get a child→parent map (sessionId → parentID) for all sessions
	 * that have a parentID. Built from the most recent listSessions() call.
	 * Synchronous — returns cached data.
	 */
	getSessionParentMap(): Map<string, string> {
		return this.cachedParentMap;
	}

	/**
	 * Eagerly add a child→parent mapping.
	 * Called from SSE wiring on `session.updated` to eliminate the race
	 * between subagent creation and the async listSessions() refresh.
	 */
	addToParentMap(childId: string, parentId: string): void {
		this.cachedParentMap.set(childId, parentId);
	}

	/** List sessions sorted by last message time first (falling back to creation time) */
	async listSessions(options?: {
		statuses?: Record<string, SessionStatus> | undefined;
		roots?: boolean;
	}): Promise<SessionInfo[]> {
		const clientOpts =
			options?.roots !== undefined ? { roots: options.roots } : undefined;
		const sessions = await this.client.listSessions(clientOpts);

		// Track total session count from unfiltered fetches
		if (!options?.roots) {
			this._lastKnownSessionCount = sessions.length;
		}

		// Only rebuild the parent map from unfiltered fetches — a roots-only
		// fetch returns no parentIDs and would wipe the map, breaking
		// subagent busy propagation in the status poller.
		if (!options?.roots) {
			this.cachedParentMap = new Map<string, string>();
			for (const s of sessions) {
				if (s.parentID) {
					this.cachedParentMap.set(s.id, s.parentID);
				}
			}
		}

		// Use explicit statuses if provided, otherwise fall back to injected getter.
		// This ensures processing flags are always included, even when callers
		// (e.g. broadcastSessionList, handleListSessions) don't pass statuses.
		const resolvedStatuses = options?.statuses ?? this.getStatuses?.();
		this.log.verbose(
			`listSessions: directory=${this.directory ?? "none"} roots=${options?.roots ?? "all"} returned=${sessions.length} ids=[${sessions
				.slice(0, 5)
				.map((s) => s.id.slice(0, 12))
				.join(",")}${sessions.length > 5 ? "..." : ""}]`,
		);
		return toSessionInfoList(
			sessions,
			resolvedStatuses,
			this.lastMessageAt,
			this.forkMeta,
			this.pendingQuestionCounts,
		);
	}

	/**
	 * Load a page of message history for a session using paginated API.
	 *
	 * Messages are returned in chronological order (oldest first).
	 * Uses cursor-based pagination via the `before` message ID:
	 *   offset=0  → most recent pageSize messages (no cursor)
	 *   offset>0  → next page of older messages (uses tracked cursor)
	 *
	 * This avoids fetching ALL messages (which can be 40MB+ for large sessions)
	 * and prevents OOM when many project relays are loaded.
	 */
	async loadHistory(sessionId: string, offset = 0): Promise<HistoryPage> {
		const before =
			offset > 0 ? this.paginationCursors.get(sessionId) : undefined;

		// If caller wants an older page but we have no cursor, we can't paginate.
		// This happens if the initial page was never loaded. Return empty.
		if (offset > 0 && !before) {
			return { messages: [], hasMore: false };
		}

		const page = await this.client.getMessagesPage(sessionId, {
			limit: this.historyPageSize,
			...(before ? { before } : {}),
		});

		// Track the oldest message ID for cursor-based "load more"
		const oldest = page[0];
		if (oldest) {
			this.paginationCursors.set(sessionId, oldest.id);
		}

		return {
			messages: page as unknown as HistoryMessage[],
			hasMore: page.length >= this.historyPageSize,
		};
	}

	/**
	 * Load a page of history and pre-render markdown for assistant text parts.
	 * This combines loadHistory() + preRenderHistoryMessages() to ensure
	 * pre-rendering is never accidentally omitted from a call site.
	 * @perf-guard — removing preRenderHistoryMessages degrades session switch latency
	 */
	async loadPreRenderedHistory(
		sessionId: string,
		offset?: number,
	): Promise<HistoryPage> {
		const page = await this.loadHistory(sessionId, offset);
		preRenderHistoryMessages(page.messages);
		return page;
	}

	// ─── Mutations ────────────────────────────────────────────────────────

	/** Create a new session */
	async createSession(
		title?: string,
		opts?: { silent?: boolean },
	): Promise<SessionDetail> {
		const session = await this.client.createSession(title ? { title } : {});

		this.emit("session_lifecycle", { type: "created", sessionId: session.id });

		if (!opts?.silent) {
			await this.broadcastSessionList();
		}

		return session;
	}

	/** Delete a session. Emits session_lifecycle { type: "deleted" } always. */
	async deleteSession(
		sessionId: string,
		opts?: { silent?: boolean },
	): Promise<void> {
		await this.client.deleteSession(sessionId);

		this.emit("session_lifecycle", { type: "deleted", sessionId });

		if (!opts?.silent) {
			await this.broadcastSessionList();
		}
	}

	/** Rename a session */
	async renameSession(sessionId: string, title: string): Promise<void> {
		await this.client.updateSession(sessionId, { title });
		await this.broadcastSessionList();
	}

	/** Search sessions by query */
	async searchSessions(
		query: string,
		options?: { roots?: boolean },
	): Promise<SessionInfo[]> {
		const sessions = await this.client.listSessions(
			options?.roots !== undefined ? { roots: options.roots } : undefined,
		);
		// Client-side filter since OpenCode's list endpoint may not support search directly
		const q = query.toLowerCase();
		const matches = sessions.filter((s) => {
			return (
				(s.title ?? "").toLowerCase().includes(q) ||
				s.id.toLowerCase().includes(q)
			);
		});
		return toSessionInfoList(
			matches,
			this.getStatuses?.(),
			this.lastMessageAt,
			this.forkMeta,
			this.pendingQuestionCounts,
		);
	}

	/**
	 * Initialize: seed the lastMessageAt map from existing sessions.
	 * Returns the most recent session ID, or creates a new one if none exist.
	 */
	async initialize(title?: string): Promise<string> {
		// Fetch all sessions (not just the default 100) for accurate counting
		const existing = await this.client.listSessions({ limit: 10000 });
		this._lastKnownSessionCount = existing.length;
		if (existing.length > 0) {
			// Seed lastMessageAt from session metadata timestamps.
			// time.updated reflects latest activity; SSE events refine it later.
			// This avoids fetching messages for every session (was 500+ HTTP requests).
			for (const s of existing) {
				const ts = s.time?.updated ?? s.time?.created ?? 0;
				if (ts > 0) this.lastMessageAt.set(s.id, ts);
			}

			// Sort by last message time, falling back to creation time
			const sorted = existing.sort((a, b) => {
				const aTime = this.lastMessageAt.get(a.id) ?? a.time?.created ?? 0;
				const bTime = this.lastMessageAt.get(b.id) ?? b.time?.created ?? 0;
				return bTime - aTime;
			});
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			return sorted[0]!.id;
		}
		const session = await this.client.createSession(title ? { title } : {});
		return session.id;
	}

	/**
	 * Compute the default session (most recent, or create one).
	 * Stateless — no global mutation.
	 */
	async getDefaultSessionId(title?: string): Promise<string> {
		const sessions = await this.listSessions();
		if (sessions.length > 0) {
			// Prefer a top-level session over a subagent (forked) session so
			// that fresh loads don't land on a child session.
			const topLevel = sessions.find((s) => !s.parentID);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			return (topLevel ?? sessions[0]!).id;
		}
		const created = await this.client.createSession(title ? { title } : {});
		this.emit("session_lifecycle", { type: "created", sessionId: created.id });
		return created.id;
	}

	/**
	 * Record that a message was received for a session at the given time.
	 * Called from SSE event handling to keep session ordering up to date.
	 * If no timestamp is provided, uses Date.now().
	 */
	recordMessageActivity(sessionId: string, timestamp?: number): void {
		const ts = timestamp ?? Date.now();
		const existing = this.lastMessageAt.get(sessionId);
		if (!existing || ts > existing) {
			this.lastMessageAt.set(sessionId, ts);
		}
	}

	/** Get the last-message-at map (for passing to toSessionInfoList). */
	getLastMessageAtMap(): ReadonlyMap<string, number> {
		return this.lastMessageAt;
	}

	/** Record fork-point metadata for a forked session and persist to disk. */
	setForkEntry(sessionId: string, entry: ForkEntry): void {
		this.forkMeta.set(sessionId, entry);
		saveForkMetadata(this.forkMeta, this.configDir);
	}

	// ─── Pending Question Counts ──────────────────────────────────────────

	/** Increment pending question count (called from SSE wiring on question.asked). */
	incrementPendingQuestionCount(sessionId: string): void {
		const current = this.pendingQuestionCounts.get(sessionId) ?? 0;
		this.pendingQuestionCounts.set(sessionId, current + 1);
	}

	/** Decrement pending question count (called from handlers on answer/reject). */
	decrementPendingQuestionCount(sessionId: string): void {
		const current = this.pendingQuestionCounts.get(sessionId) ?? 0;
		if (current <= 1) {
			this.pendingQuestionCounts.delete(sessionId);
		} else {
			this.pendingQuestionCounts.set(sessionId, current - 1);
		}
	}

	/** Bulk-set pending question counts (called on SSE reconnect from listPendingQuestions). */
	setPendingQuestionCounts(counts: Map<string, number>): void {
		this.pendingQuestionCounts = counts;
	}

	/**
	 * Send roots-only session list immediately, then all-sessions in background.
	 * Used by all broadcast/unicast send points.
	 */
	async sendDualSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: { statuses?: Record<string, SessionStatus> | undefined },
	): Promise<void> {
		const roots = await this.listSessions({
			roots: true,
			statuses: options?.statuses,
		});
		send({ type: "session_list", sessions: roots, roots: true });

		this.listSessions({ statuses: options?.statuses })
			.then((all) => {
				send({ type: "session_list", sessions: all, roots: false });
			})
			.catch((err) => {
				this.log.warn(`Background all-sessions fetch failed: ${err}`);
			});
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async broadcastSessionList(): Promise<void> {
		const roots = await this.listSessions({ roots: true });
		this.emit("broadcast", {
			type: "session_list",
			sessions: roots,
			roots: true,
		});

		this.listSessions()
			.then((all) => {
				this.emit("broadcast", {
					type: "session_list",
					sessions: all,
					roots: false,
				});
			})
			.catch((err) => {
				this.log.warn(`Background all-sessions broadcast failed: ${err}`);
			});
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert OpenCode SessionDetail[] → sorted SessionInfo[] for the frontend.
 *
 * Sorting priority: last message timestamp (from lastMessageAt map),
 * falling back to session creation time for sessions with no messages.
 * This ensures sessions are ordered by actual conversation activity,
 * not by metadata updates (renames, etc.).
 */
function toSessionInfoList(
	sessions: SessionDetail[],
	statuses?: Record<string, SessionStatus>,
	lastMessageAt?: ReadonlyMap<string, number>,
	forkMeta?: ReadonlyMap<string, ForkEntry>,
	pendingQuestionCounts?: ReadonlyMap<string, number>,
): SessionInfo[] {
	return sessions
		.map((s) => {
			// For display: use last message time if available, otherwise creation time
			const lastMsgTime = lastMessageAt?.get(s.id);
			const displayTime = lastMsgTime ?? s.time?.created ?? 0;

			const forkEntry = forkMeta?.get(s.id);
			// parentID: prefer OpenCode's value, fall back to conduit's fork metadata
			// (OpenCode does not set parentID on user-initiated forks, only on subagent sessions)
			const parentID = s.parentID ?? forkEntry?.parentID;

			const info: SessionInfo = {
				id: s.id,
				title: s.title ?? "Untitled",
				updatedAt: displayTime,
				messageCount: 0, // OpenCode doesn't include this in list; frontend can fetch if needed
				...(parentID != null && { parentID }),
				...(forkEntry != null && { forkMessageId: forkEntry.forkMessageId }),
			};
			if (statuses) {
				const status = statuses[s.id];
				if (status && (status.type === "busy" || status.type === "retry")) {
					info.processing = true;
				}
			}
			const qCount = pendingQuestionCounts?.get(s.id);
			if (qCount != null && qCount > 0) {
				info.pendingQuestionCount = qCount;
			}
			return info;
		})
		.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
}
