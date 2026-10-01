// Manages the mapping between OpenCode sessions and the relay's representation.
// OpenCode (SQLite) is always the source of truth — the relay never duplicates
// storage. This layer proxies session CRUD and maintains in-memory active state.

import { EventEmitter } from "node:events";
import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { SessionDetail, SessionStatus } from "../instance/sdk-types.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { HistoryMessage } from "../shared-types.js";
import type { RelayMessage, SessionInfo } from "../types.js";
import { toSessionInfoList } from "./session-info-list.js";

/** Fetch enough sessions to initialize the complete local session count. */
const INITIAL_SESSION_LIST_LIMIT = 10_000;

export interface SessionManagerOptions {
	client: OpenCodeAPI;
	/** Number of messages to load per page (default 50) */
	historyPageSize?: number;
	/** Logger for diagnostics */
	log?: Logger;
	/** Project directory (for debug logging) */
	directory?: string;
	/** Optional getter for current session statuses (for processing indicators) */
	getStatuses?: () => Record<string, SessionStatus>;
	/** Retained for compatibility with legacy callers. */
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

export class SessionManager extends EventEmitter<SessionManagerEvents> {
	private readonly client: OpenCodeAPI;
	private readonly historyPageSize: number;
	private readonly log: Logger;
	private readonly directory: string | undefined;
	private readonly getStatuses: (() => Record<string, SessionStatus>) | null;

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
	 * Session count from the most recent listSessions() call.
	 * Used by the daemon to report session counts without an API call.
	 */
	private _lastKnownSessionCount = 0;

	constructor(options: SessionManagerOptions) {
		super();
		this.client = options.client;
		this.historyPageSize = options.historyPageSize ?? 50;
		this.log = options.log ?? createSilentLogger();
		this.directory = options.directory;
		this.getStatuses = options.getStatuses ?? null;
	}

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
		const sessions = await this.client.session.list(clientOpts);

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
		// (e.g. broadcastSessionList) don't pass statuses.
		const resolvedStatuses = options?.statuses ?? this.getStatuses?.();
		this.log.verbose(
			`listSessions: directory=${this.directory ?? "none"} roots=${options?.roots ?? "all"} returned=${sessions.length} ids=[${sessions
				.slice(0, 5)
				.map((s) => s.id.slice(0, 12))
				.join(",")}${sessions.length > 5 ? "..." : ""}]`,
		);
		return toSessionInfoList(sessions, resolvedStatuses, this.lastMessageAt);
	}

	/** Load the newest REST page for initial OpenCode history while backfill runs. */
	async loadHistory(sessionId: string): Promise<HistoryPage> {
		const page = await this.client.session.messagesPage(sessionId, {
			limit: this.historyPageSize,
		});
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
	async loadPreRenderedHistory(sessionId: string): Promise<HistoryPage> {
		const page = await this.loadHistory(sessionId);
		// Dynamic import avoids pulling jsdom/dompurify/marked into every
		// module that imports session-manager (saves ~300-500ms at load time).
		const { preRenderHistoryMessages } = await import(
			"../relay/markdown-renderer.js"
		);
		preRenderHistoryMessages(page.messages);
		return page;
	}

	/** Create a new session */
	async createSession(
		title?: string,
		opts?: { silent?: boolean },
	): Promise<SessionDetail> {
		const session = await this.client.session.create(title ? { title } : {});

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
		// The provider's delete takes the descendants too, and pending counts now
		// ride the `session_list` message rather than the sessions in it, so the
		// whole lineage has to be forgotten here — a count left behind rebuilds an
		// attention badge for a session the browser can no longer show. Read the
		// lineage from the provider before the delete rather than from
		// `cachedParentMap`, which is only a by-product of the last listSessions()
		// call and may be missing the child→parent edge that matters.
		const sessions = await this.listSessions();
		const deleted = new Set([sessionId]);
		const pendingParents = [sessionId];
		for (const parentId of pendingParents) {
			for (const candidate of sessions) {
				if (candidate.parentID === parentId && !deleted.has(candidate.id)) {
					deleted.add(candidate.id);
					pendingParents.push(candidate.id);
				}
			}
		}

		await this.client.session.delete(sessionId);

		for (const deletedId of deleted) {
			this.cachedParentMap.delete(deletedId);
		}

		this.emit("session_lifecycle", { type: "deleted", sessionId });

		if (!opts?.silent) {
			await this.broadcastSessionList();
		}
	}

	/** Rename a session */
	async renameSession(sessionId: string, title: string): Promise<void> {
		await this.client.session.update(sessionId, { title });
		await this.broadcastSessionList();
	}

	/** Search sessions by query */
	async searchSessions(
		query: string,
		options?: { roots?: boolean },
	): Promise<SessionInfo[]> {
		const sessions = await this.client.session.list(
			options?.roots !== undefined ? { roots: options.roots } : undefined,
		);
		// Client-side filter since OpenCode's list endpoint may not support search directly
		const normalizedQuery = query.toLowerCase();
		const matches = sessions.filter((s) => {
			return (
				(s.title ?? "").toLowerCase().includes(normalizedQuery) ||
				s.id.toLowerCase().includes(normalizedQuery)
			);
		});
		return toSessionInfoList(matches, this.getStatuses?.(), this.lastMessageAt);
	}

	/**
	 * Initialize: seed the lastMessageAt map from existing sessions.
	 * Returns the most recent session ID, or creates a new one if none exist.
	 */
	async initialize(title?: string): Promise<string> {
		// Fetch all sessions (not just the default 100) for accurate counting
		const existing = await this.client.session.list({
			limit: INITIAL_SESSION_LIST_LIMIT,
		});
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
			const latest = sorted[0];
			if (latest !== undefined) return latest.id;
		}
		const session = await this.client.session.create(title ? { title } : {});
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
			const firstSession = sessions[0];
			if (topLevel !== undefined) return topLevel.id;
			if (firstSession !== undefined) return firstSession.id;
		}
		const created = await this.client.session.create(title ? { title } : {});
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

	/**
	 * Send the roots-only session list.
	 * Used by all broadcast/unicast send points.
	 */
	async sendSessionLists(
		send: (msg: Extract<RelayMessage, { type: "session_list" }>) => void,
		options?: { statuses?: Record<string, SessionStatus> | undefined },
	): Promise<void> {
		const roots = await this.listSessions({
			roots: true,
			statuses: options?.statuses,
		});
		send({ type: "session_list", sessions: roots, roots: true });
	}

	private async broadcastSessionList(): Promise<void> {
		const roots = await this.listSessions({ roots: true });
		this.emit("broadcast", {
			type: "session_list",
			sessions: roots,
			roots: true,
		});
	}
}
