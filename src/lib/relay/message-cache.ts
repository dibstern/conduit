// ─── Per-Session Message Cache ───────────────────────────────────────────────
// Records every translated event per session in real-time (memory + JSONL file),
// replays on session switch through existing client handlers.
//
// Modeled after claude-relay's doSendAndRecord + appendToSessionFile pattern:
//   - Record synchronously before broadcast (identical to claude-relay)
//   - Append-only JSONL files (crash-safe, O(1) per event)
//   - Fallback chain: memory → file → null (caller uses REST API)

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { formatErrorDetail } from "../errors.js";
import type { RelayMessage } from "../types.js";

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

		// Track approximate byte size (UTF-16 estimate)
		const eventBytes = JSON.stringify(event).length * 2;
		session.approxBytes += eventBytes;
		session.lastAccessedAt = Date.now();

		this.appendToFile(sessionId, event);

		// Evict oldest events when over limit
		if (session.events.length > MAX_EVENTS) {
			const keepCount = Math.floor(MAX_EVENTS * KEEP_RATIO);
			session.events = session.events.slice(-keepCount);
			// Recompute byte estimate after eviction
			session.approxBytes = JSON.stringify(session.events).length * 2;
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
	getEvents(sessionId: string): RelayMessage[] | null {
		// 1. In-memory
		const session = this.sessions.get(sessionId);
		if (session && session.events.length > 0) {
			session.lastAccessedAt = Date.now();
			return session.events;
		}

		// 2. File on disk
		const fromFile = this.loadFromFile(sessionId);
		if (fromFile && fromFile.length > 0) {
			const approxBytes = JSON.stringify(fromFile).length * 2;
			this.sessions.set(sessionId, {
				events: fromFile,
				approxBytes,
				lastAccessedAt: Date.now(),
			});
			return fromFile;
		}

		// 3. Return null → caller fetches from REST API
		return null;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/** Remove all data (memory + file). Called on session delete. */
	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
		try {
			unlinkSync(this.filePath(sessionId));
		} catch {
			// File may not exist — that's fine
		}
	}

	/** Load all .jsonl files into memory. Called once on startup. */
	loadFromDisk(): void {
		let files: string[];
		try {
			files = readdirSync(this.cacheDir);
		} catch {
			return;
		}

		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const sessionId = file.slice(0, -6); // Remove ".jsonl"
			const events = this.loadFromFile(sessionId);
			if (events && events.length > 0) {
				const approxBytes = JSON.stringify(events).length * 2;
				this.sessions.set(sessionId, {
					events,
					approxBytes,
					lastAccessedAt: Date.now(),
				});
			}
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

	private loadFromFile(sessionId: string): RelayMessage[] | null {
		let content: string;
		try {
			content = readFileSync(this.filePath(sessionId), "utf8");
		} catch {
			return null;
		}

		const lines = content.trim().split("\n");
		if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
			return null;
		}

		const events: RelayMessage[] = [];
		for (const line of lines) {
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as RelayMessage);
			} catch {
				// Skip malformed lines (crash-safe: partial last line is OK)
			}
		}
		return events.length > 0 ? events : null;
	}

	private appendToFile(sessionId: string, event: RelayMessage): FileOpResult {
		try {
			appendFileSync(this.filePath(sessionId), `${JSON.stringify(event)}\n`);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: formatErrorDetail(err) };
		}
	}

	/** Rewrite the JSONL file with only the given events (after eviction). */
	private rewriteFile(sessionId: string, events: RelayMessage[]): FileOpResult {
		try {
			const content = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
			writeFileSync(this.filePath(sessionId), content);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: formatErrorDetail(err) };
		}
	}
}
