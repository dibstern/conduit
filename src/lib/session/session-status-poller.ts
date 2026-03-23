// ─── Session Status Poller ───────────────────────────────────────────────────
// Polls OpenCode's GET /session/status endpoint at a fixed interval, diffs
// against previous state, and emits a "changed" event when any session's
// status transitions. Exposes getCurrentStatuses() for on-demand reads.
//
// Subagent propagation: when a subagent session is busy, the parent session
// is also marked busy. This is needed because OpenCode's API only reports
// the subagent as busy — the parent appears idle even though it's waiting
// for subagent results.

import { EventEmitter } from "node:events";
import type {
	OpenCodeClient,
	SessionStatus,
} from "../instance/opencode-client.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { computeAugmentedStatuses } from "./status-augmentation.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * How long a message-activity busy flag stays valid after the last
 * markMessageActivity() call. If the message poller stops finding new
 * content (e.g., the TUI session finished), the synthetic busy status
 * expires after this interval, causing a natural busy→idle transition.
 *
 * Set to 10s: agents routinely pause for 5-15 seconds while thinking
 * between tool calls or generating long responses. The previous 3s TTL
 * was too aggressive — it caused premature idle transitions that killed
 * the message poller and bounce bar during normal agent operation.
 * The message poller polls every 750ms, so 10s ≈ 13 polls with no
 * new content before the activity expires.
 */
const MESSAGE_ACTIVITY_TTL_MS = 10_000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionStatusPollerOptions {
	client: Pick<OpenCodeClient, "getSessionStatuses" | "getSession">;
	/** Polling interval in milliseconds (default: 500) */
	interval?: number;
	log?: Logger;
	/**
	 * Lazy getter for the current session list (child→parent map).
	 * Used to propagate subagent busy status to parent sessions.
	 * If not provided, subagent propagation is disabled.
	 */
	getSessionParentMap?: () => Map<string, string>;
}

export interface SessionStatusPollerEvents {
	/** Emitted every poll cycle. statusesChanged indicates if status types actually differ from last poll. */
	changed: [statuses: Record<string, SessionStatus>, statusesChanged: boolean];
}

// ─── Poller ──────────────────────────────────────────────────────────────────

export class SessionStatusPoller extends EventEmitter<SessionStatusPollerEvents> {
	private readonly client: Pick<
		OpenCodeClient,
		"getSessionStatuses" | "getSession"
	>;
	private readonly interval: number;
	private readonly log: Logger;
	private readonly getSessionParentMap: (() => Map<string, string>) | undefined;
	private timer: ReturnType<typeof setInterval> | null = null;
	private previous: Record<string, SessionStatus> = {};
	private previousRaw: Record<string, SessionStatus> = {};
	private polling = false;
	private initialized = false;

	/**
	 * Cache of child→parent mappings discovered by looking up unknown busy
	 * session IDs. Avoids repeated GET /session/{id} calls for the same
	 * subagent. Entries are never evicted — subagent relationships are stable.
	 */
	private childToParentCache = new Map<string, string | undefined>();

	/**
	 * Map of session IDs → timestamp of last activity detected by the
	 * message poller. Sessions are synthetically marked busy only while
	 * the timestamp is recent (within MESSAGE_ACTIVITY_TTL_MS). This
	 * time-decay approach ensures sessions auto-transition to idle when
	 * the poller stops finding new content, breaking the circular
	 * dependency where `augmentStatuses` kept injecting busy because
	 * `clearMessageActivity` was never reached.
	 */
	private messageActivityTimestamps = new Map<string, number>();

	/**
	 * Sessions that SSE has confirmed as idle. While a session is in this
	 * set, markMessageActivity() is ignored — the authoritative SSE idle
	 * signal overrides synthetic busy from the message poller. The flag is
	 * cleared when the status poller's next poll confirms the idle
	 * transition (i.e. the session is no longer busy in raw statuses).
	 */
	private sseIdleSessions = new Set<string>();

	constructor(options: SessionStatusPollerOptions) {
		super();
		this.client = options.client;
		this.interval = options.interval ?? 500;
		this.log = options.log ?? createSilentLogger();
		this.getSessionParentMap = options.getSessionParentMap;
	}

	/**
	 * Mark a session as busy due to message activity detected by the
	 * message poller. This is used for CLI sessions where /session/status
	 * doesn't report busy but REST polling detects new content.
	 *
	 * Each call refreshes the timestamp. The synthetic busy status expires
	 * after MESSAGE_ACTIVITY_TTL_MS if no new activity is detected.
	 */
	markMessageActivity(sessionId: string): void {
		// If SSE has confirmed this session is idle, ignore stale message
		// activity from the poller. The SSE signal is authoritative.
		if (this.sseIdleSessions.has(sessionId)) return;

		const isNew = !this.messageActivityTimestamps.has(sessionId);
		this.messageActivityTimestamps.set(sessionId, Date.now());
		if (isNew) {
			this.log.info(`message-activity BUSY session=${sessionId.slice(0, 12)}`);
			// Trigger a re-evaluation so the spinner shows up immediately
			void this.poll();
		}
	}

	/**
	 * Clear the message-activity busy flag for a session. Called when
	 * the session transitions to idle or when polling stops.
	 */
	clearMessageActivity(sessionId: string): void {
		if (this.messageActivityTimestamps.delete(sessionId)) {
			this.log.verbose(
				`message-activity CLEARED session=${sessionId.slice(0, 12)}`,
			);
		}
	}

	/**
	 * Called when SSE delivers a session.status:idle event.
	 * Clears any synthetic message-activity busy flag for the session,
	 * sets an SSE-idle override to prevent the message poller from
	 * re-injecting busy, and triggers an immediate re-poll so idle
	 * transitions are detected within ~10ms instead of waiting for the
	 * next 500ms cycle.
	 *
	 * Clearing the activity flag is essential: the message poller may have
	 * recently detected content and injected a synthetic busy status via
	 * markMessageActivity(). Without clearing it, augmentStatuses() would
	 * re-inject busy on the next poll, overriding the real idle signal
	 * from OpenCode and preventing the busy→idle transition.
	 */
	notifySSEIdle(sessionId: string): void {
		this.sseIdleSessions.add(sessionId);
		this.clearMessageActivity(sessionId);
		this.log.debug(
			`SSE idle hint for session=${sessionId.slice(0, 12)} — cleared activity, triggering immediate poll`,
		);
		void this.poll();
	}

	/** Start polling. Safe to call multiple times (idempotent). */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.poll();
		}, this.interval);
		// Don't keep the process alive just for this timer
		if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
			this.timer.unref();
		}
		// Immediate first poll so statuses are available right away
		// (avoids a race where a browser connects before the first interval fires)
		void this.poll();
	}

	/** Stop polling and clear the timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Get the most recently polled statuses. */
	getCurrentStatuses(): Record<string, SessionStatus> {
		return { ...this.previous };
	}

	/** Check if a specific session is currently processing (busy or retry). */
	isProcessing(sessionId: string): boolean {
		const status = this.previous[sessionId];
		if (!status) return false;
		return status.type === "busy" || status.type === "retry";
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async poll(): Promise<void> {
		// Guard against overlapping polls
		if (this.polling) return;
		this.polling = true;

		try {
			const raw = await this.client.getSessionStatuses();
			const current = await this.augmentStatuses(raw);

			if (!this.initialized) {
				// First poll establishes the baseline — no event emitted
				this.previous = current;
				this.previousRaw = raw;
				this.initialized = true;
				const busySessions = Object.entries(current)
					.filter(([, s]) => s.type === "busy" || s.type === "retry")
					.map(([id, s]) => `${id.slice(0, 12)}:${s.type}`);
				if (busySessions.length > 0) {
					this.log.info(`INIT busy=[${busySessions.join(", ")}]`);
				}
				return;
			}

			// Compare RAW statuses (not augmented) for the statusesChanged flag.
			// Augmented statuses include synthetic entries from message-activity
			// and subagent propagation that change every cycle, which would cause
			// unnecessary session list broadcasts and mock queue exhaustion.
			const statusesChanged = this.hasChanged(this.previousRaw, raw);

			if (statusesChanged) {
				const busySessions = Object.entries(current)
					.filter(([, s]) => s.type === "busy" || s.type === "retry")
					.map(([id, s]) => `${id.slice(0, 12)}:${s.type}`);
				this.log.info(
					`CHANGED busy=[${busySessions.join(", ")}] total=${Object.keys(current).length}`,
				);
			}

			// Always emit — the monitoring reducer needs periodic evaluation
			// for time-based transitions (grace period expiry, SSE staleness).
			this.previous = current;
			this.previousRaw = raw;
			this.emit("changed", current, statusesChanged);
		} catch (err) {
			// Keep last known state (stale > empty). Log and retry next tick.
			const msg = err instanceof Error ? err.message : String(err);
			this.log.warn(`poll failed: ${msg}`);
		} finally {
			this.polling = false;
		}
	}

	// ─── Subagent + Message Activity Augmentation ──────────────────────────

	/**
	 * Augment raw statuses from /session/status with:
	 *
	 * 1. **Subagent propagation**: If a busy session is a subagent (has parentID),
	 *    mark the parent session as busy too. Uses the session list's parentID
	 *    fields as fast path, falls back to GET /session/{id} for unknown IDs.
	 *
	 * 2. **Message activity**: If the message poller detected new content for
	 *    a session (markMessageActivity was called), inject a synthetic busy
	 *    status. This covers CLI sessions that don't appear in /session/status.
	 */
	private async augmentStatuses(
		raw: Record<string, SessionStatus>,
	): Promise<Record<string, SessionStatus>> {
		// ── Pre-pass: resolve unknown parents via API ─────────────────────────
		const parentMap = this.getSessionParentMap?.() ?? new Map<string, string>();
		const busyIds = Object.entries(raw)
			.filter(([, s]) => s.type === "busy" || s.type === "retry")
			.map(([id]) => id);

		for (const busyId of busyIds) {
			// Skip if already known via parentMap or cache
			if (parentMap.has(busyId) || this.childToParentCache.has(busyId))
				continue;
			// API lookup (non-blocking — if it fails, we skip)
			try {
				const session = await this.client.getSession(busyId);
				const pid = session.parentID;
				this.childToParentCache.set(busyId, pid);
				if (pid) {
					this.log.info(
						`discovered child→parent: ${busyId.slice(0, 12)}→${pid.slice(0, 12)}`,
					);
				}
			} catch {
				this.childToParentCache.set(busyId, undefined);
			}
		}

		// ── Pure computation ──────────────────────────────────────────────────
		const result = computeAugmentedStatuses({
			raw,
			parentMap,
			childToParentResolved: this.childToParentCache,
			messageActivityTimestamps: this.messageActivityTimestamps,
			sseIdleSessions: this.sseIdleSessions,
			now: Date.now(),
			messageActivityTtlMs: MESSAGE_ACTIVITY_TTL_MS,
		});

		// ── Apply side effects ───────────────────────────────────────────────
		for (const sessionId of result.sseIdleToRemove) {
			this.sseIdleSessions.delete(sessionId);
		}
		for (const sessionId of result.expiredActivitySessions) {
			this.messageActivityTimestamps.delete(sessionId);
			this.log.info(
				`message-activity EXPIRED session=${sessionId.slice(0, 12)}`,
			);
		}

		return result.augmented;
	}

	/** Check if any session's status type has changed, or sessions added/removed. */
	private hasChanged(
		prev: Record<string, SessionStatus>,
		next: Record<string, SessionStatus>,
	): boolean {
		const prevKeys = Object.keys(prev);
		const nextKeys = Object.keys(next);

		// Different number of sessions
		if (prevKeys.length !== nextKeys.length) return true;

		// Check each session in next
		for (const key of nextKeys) {
			const prevStatus = prev[key];
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const nextStatus = next[key]!;

			// New session
			if (!prevStatus) return true;

			// Status type changed
			if (prevStatus.type !== nextStatus.type) return true;
		}

		// Check for removed sessions
		for (const key of prevKeys) {
			if (!(key in next)) return true;
		}

		return false;
	}
}
