// ─── Per-Session Message Cache ───────────────────────────────────────────────
// Records every translated event per session in real-time (memory + JSONL file),
// replays on session switch through existing client handlers.
//
// Modeled after claude-relay's doSendAndRecord + appendToSessionFile pattern:
//   - Record synchronously before broadcast (identical to claude-relay)
//   - Append-only JSONL files (crash-safe, O(1) per event)
//   - Fallback chain: memory → file → null (caller uses REST API)

import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayMessage } from "../types.js";
import { repairColdSession } from "./cold-cache-repair.js";

/** Maximum events per session before eviction. */
const MAX_EVENTS = 5000;

/** After eviction, keep this fraction of events (newest). */
const KEEP_RATIO = 0.8;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileOpResult {
	ok: boolean;
	error?: string;
}

interface SessionCache {
	events: RelayMessage[];
	approxBytes: number;
	lastAccessedAt: number;
}

// ─── MessageCache ────────────────────────────────────────────────────────────

export class MessageCache {
	private readonly sessions = new Map<string, SessionCache>();
	private readonly cacheDir: string;

	constructor(cacheDir: string) {
		this.cacheDir = cacheDir;
		mkdirSync(cacheDir, { recursive: true });
	}

	// ── Recording (real-time, identical to doSendAndRecord) ────────────

	/**
	 * Append event to memory + file. Called synchronously before broadcast.
	 * Identical to claude-relay's doSendAndRecord pattern.
	 * Evicts oldest events when MAX_EVENTS is exceeded.
	 */
	recordEvent(sessionId: string, event: RelayMessage): void {
		const session = this.ensureSession(sessionId);
		session.events.push(event);

		// Serialize once — reuse for both byte tracking and file append
		const serialized = JSON.stringify(event);
		session.approxBytes += serialized.length * 2;
		session.lastAccessedAt = Date.now();

		this.appendToFileSerialized(sessionId, serialized);

		// Evict oldest events when over limit
		if (session.events.length > MAX_EVENTS) {
			const keepCount = Math.floor(MAX_EVENTS * KEEP_RATIO);
			const evicted = session.events.length - keepCount;
			session.events = session.events.slice(-keepCount);
			// Approximate: reduce bytes proportionally to evicted fraction
			session.approxBytes = Math.floor(
				session.approxBytes * (keepCount / (keepCount + evicted)),
			);
			this.rewriteFile(sessionId, session.events);
		}
	}

	// ── Serving (fallback chain) ───────────────────────────────────────

	/**
	 * Get raw events for a session. Fallback chain:
	 *   1. In-memory events → return if found
	 *   2. Load from JSONL file on disk → return if found
	 *   3. Return null → caller fetches from OpenCode REST API
	 */
	async getEvents(sessionId: string): Promise<RelayMessage[] | null> {
		// 1. In-memory
		const session = this.sessions.get(sessionId);
		if (session && session.events.length > 0) {
			session.lastAccessedAt = Date.now();
			return session.events;
		}

		// 2. File on disk
		const loaded = await this.loadFromFile(sessionId);
		if (loaded && loaded.events.length > 0) {
			this.sessions.set(sessionId, loaded);
			return loaded.events;
		}

		// 3. Return null → caller fetches from REST API
		return null;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/** Load all .jsonl files into memory. Called once on startup. */
	async loadFromDisk(): Promise<void> {
		let files: string[];
		try {
			files = await readdir(this.cacheDir);
		} catch {
			return;
		}

		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const sessionId = file.slice(0, -6); // Remove ".jsonl"
			const loaded = await this.loadFromFile(sessionId);
			if (loaded && loaded.events.length > 0) {
				this.sessions.set(sessionId, loaded);
			}
		}
	}

	/**
	 * Repair all sessions loaded from disk by removing incomplete assistant turns.
	 * Called once after loadFromDisk() during relay startup.
	 *
	 * Uses the existing rewriteFile() and flush() mechanisms — no direct I/O.
	 */
	async repairColdSessions(): Promise<void> {
		let repairedCount = 0;
		for (const [sessionId, session] of this.sessions) {
			const { repaired, changed } = repairColdSession(session.events);
			if (changed) {
				session.events = repaired;
				// Recalculate approx bytes from repaired events
				session.approxBytes = repaired.reduce(
					(sum, e) => sum + JSON.stringify(e).length * 2,
					0,
				);
				this.rewriteFile(sessionId, repaired);
				repairedCount++;
			}
		}
		if (repairedCount > 0) {
			await this.flush();
		}
	}

	/** Check if a session has cached events in memory. */
	has(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session !== undefined && session.events.length > 0;
	}

	/** Number of sessions currently cached. */
	sessionCount(): number {
		return this.sessions.size;
	}

	/** Total approximate bytes across all cached sessions. */
	approximateBytes(): number {
		let total = 0;
		for (const session of this.sessions.values()) {
			total += session.approxBytes;
		}
		return total;
	}

	/**
	 * Evict the session with the oldest `lastAccessedAt`.
	 * Removes both memory and disk data.
	 * Returns the evicted session ID, or `null` if no sessions exist.
	 */
	evictOldestSession(): string | null {
		if (this.sessions.size === 0) return null;

		let oldestId: string | null = null;
		let oldestTime = Infinity;

		for (const [id, session] of this.sessions) {
			if (session.lastAccessedAt < oldestTime) {
				oldestTime = session.lastAccessedAt;
				oldestId = id;
			}
		}

		if (oldestId !== null) {
			this.remove(oldestId);
		}

		return oldestId;
	}

	// ── Internal ───────────────────────────────────────────────────────

	private ensureSession(sessionId: string): SessionCache {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;

		const session: SessionCache = {
			events: [],
			approxBytes: 0,
			lastAccessedAt: Date.now(),
		};
		this.sessions.set(sessionId, session);
		return session;
	}

	private filePath(sessionId: string): string {
		return join(this.cacheDir, `${sessionId}.jsonl`);
	}

	private async loadFromFile(sessionId: string): Promise<SessionCache | null> {
		let content: string;
		try {
			content = await readFile(this.filePath(sessionId), "utf8");
		} catch {
			return null;
		}

		const lines = content.trim().split("\n");
		if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
			return null;
		}

		const events: RelayMessage[] = [];
		let approxBytes = 0;
		for (const line of lines) {
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as RelayMessage);
				// Track bytes incrementally (UTF-16 estimate from line length)
				approxBytes += line.length * 2;
			} catch {
				// Skip malformed lines (crash-safe: partial last line is OK)
			}
		}
		if (events.length === 0) return null;
		return { events, approxBytes, lastAccessedAt: Date.now() };
	}

	/**
	 * Pending write buffer: accumulated serialized lines per session.
	 * Flushed to disk every FLUSH_INTERVAL_MS via a batched appendFileSync.
	 * This avoids both: (a) blocking the event loop per-event (old sync approach)
	 * and (b) creating hundreds of concurrent async file operations (crash-prone).
	 */
	private pendingAppends = new Map<string, string[]>();
	private pendingRewrites = new Map<string, string>();
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private static readonly FLUSH_INTERVAL_MS = 200;

	private ensureFlushTimer(): void {
		if (this.flushTimer) return;
		this.flushTimer = setInterval(
			() => this.flushSync(),
			MessageCache.FLUSH_INTERVAL_MS,
		);
		this.flushTimer.unref();
	}

	/** Synchronous batch flush of all pending writes. */
	private flushSync(): void {
		// Process rewrites first (they replace entire files)
		for (const [sessionId, content] of this.pendingRewrites) {
			try {
				writeFileSync(this.filePath(sessionId), content);
			} catch {
				// Best-effort
			}
			// Clear any pending appends for this session (rewrite supersedes)
			this.pendingAppends.delete(sessionId);
		}
		this.pendingRewrites.clear();

		// Process appends (batched into one write per session)
		for (const [sessionId, lines] of this.pendingAppends) {
			try {
				appendFileSync(this.filePath(sessionId), lines.join(""));
			} catch {
				// Best-effort
			}
		}
		this.pendingAppends.clear();
	}

	private appendToFileSerialized(sessionId: string, serialized: string): void {
		const lines = this.pendingAppends.get(sessionId) ?? [];
		lines.push(`${serialized}\n`);
		this.pendingAppends.set(sessionId, lines);
		this.ensureFlushTimer();
	}

	/** Rewrite the JSONL file with only the given events (after eviction). */
	private rewriteFile(sessionId: string, events: RelayMessage[]): void {
		const content = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		this.pendingRewrites.set(sessionId, content);
		this.ensureFlushTimer();
	}

	/** Remove all data (memory + file). Called on session delete. */
	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.pendingAppends.delete(sessionId);
		this.pendingRewrites.delete(sessionId);
		try {
			unlinkSync(this.filePath(sessionId));
		} catch {
			// File may not exist — that's fine
		}
	}

	/** Wait for all pending writes to flush. */
	async flush(): Promise<void> {
		this.flushSync();
	}
}
