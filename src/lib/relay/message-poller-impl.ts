// ─── Message Poller Implementation (Internal) ───────────────────────────────
// Imperative polling classes that wrap the pure diff/synthesize functions.
// Only imported by relay-stack.ts (composition root). All other modules use
// structural interfaces (PollerManagerLike) instead of concrete classes.
//
// MessagePoller: single-session poller with SSE suppression + idle timeout.
// MessagePollerManager: manages multiple concurrent MessagePoller instances.

import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Message } from "../instance/sdk-types.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { tagWithSessionId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";
import {
	buildSeedSnapshot,
	diffAndSynthesize,
	type MessageSnapshot,
} from "./message-poller.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Polling interval when actively polling messages. */
const POLL_INTERVAL_MS = 750;

/** How long to wait after the last SSE event before starting REST polling. */
const SSE_SILENCE_THRESHOLD_MS = 2000;

/**
 * How long to poll with no new content before auto-stopping.
 * Prevents indefinite 750ms polling for truly idle sessions.
 * The poller can be restarted by calling startPolling() again.
 */
const IDLE_TIMEOUT_MS = 5000;

// ─── MessagePoller Types ────────────────────────────────────────────────────

export interface MessagePollerOptions {
	client: Pick<OpenCodeAPI, "session">;
	/** Polling interval in milliseconds (default: 750) */
	interval?: number;
	log?: Logger;
	/**
	 * Optional callback checked before applying the idle timeout.
	 * When this returns true, the poller stays alive even without new
	 * content — used to keep polling while browser clients are viewing
	 * a session (e.g. TUI sessions where SSE events don't cross processes).
	 */
	hasViewers?: () => boolean;
}

/** Callback signature for the "events" broadcast event. */
export type MessagePollerEventsCallback = (messages: RelayMessage[]) => void;

// ─── MessagePoller ──────────────────────────────────────────────────────────

export class MessagePoller {
	private readonly client: Pick<OpenCodeAPI, "session">;
	private readonly interval: number;
	private readonly log: Logger;
	private readonly hasViewers: (() => boolean) | undefined;

	private timer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private activeSessionId: string | null = null;
	private previousSnapshot: Map<string, MessageSnapshot> = new Map();

	/** Timestamp of the last SSE event for the active session */
	private lastSSEEventAt = 0;

	/** Timestamp of the last poll that found new content */
	private lastContentAt = 0;

	/**
	 * True when SSE events have been received since the last reseed.
	 * When the poller detects SSE silence after this flag is set, it
	 * reseeds the snapshot from the REST API to avoid re-synthesizing
	 * content that SSE already delivered.
	 */
	private needsReseed = false;

	/**
	 * True when startPolling() was called without seed messages.
	 * The first poll will seed the snapshot from REST instead of synthesizing,
	 * preventing duplicate events when the client already has cached history.
	 */
	private needsSeedOnFirstPoll = false;

	/** Pending fire-and-forget promises — awaited in drain(). */
	private readonly pendingPromises = new Set<Promise<unknown>>();

	/** Registered "events" broadcast callbacks. */
	private readonly eventsCallbacks: MessagePollerEventsCallback[] = [];

	constructor(options: MessagePollerOptions) {
		this.client = options.client;
		this.interval = options.interval ?? POLL_INTERVAL_MS;
		this.log = options.log ?? createSilentLogger();
		this.hasViewers = options.hasViewers;
	}

	/** Register a callback for the "events" broadcast event. */
	on(_event: "events", callback: MessagePollerEventsCallback): void {
		this.eventsCallbacks.push(callback);
	}

	/** Remove all registered callbacks. */
	removeAllListeners(): void {
		this.eventsCallbacks.length = 0;
	}

	// ─── Public API ────────────────────────────────────────────────────────

	/**
	 * Start polling messages for a session.
	 * Replaces any existing polling target.
	 *
	 * @param seedMessages  Optional array of existing messages to seed the
	 *   snapshot baseline. When provided, the poller builds its initial
	 *   `previousSnapshot` from these messages so it only emits events for
	 *   genuinely NEW content that appears after polling starts. This prevents
	 *   duplicate events when both SSE and the poller observe the same content.
	 */
	startPolling(sessionId: string, seedMessages?: Message[]): void {
		if (this.activeSessionId === sessionId && this.timer) return;

		this.stopPolling();
		this.activeSessionId = sessionId;
		this.previousSnapshot = new Map();
		this.lastSSEEventAt = 0;
		this.lastContentAt = Date.now(); // Grace period: treat start as "content" to avoid immediate timeout
		this.needsReseed = false;
		this.needsSeedOnFirstPoll = false;

		// Seed the snapshot from existing messages so the first poll doesn't
		// re-emit events for content that SSE already delivered.
		if (seedMessages && seedMessages.length > 0) {
			this.previousSnapshot = buildSeedSnapshot(seedMessages);
			this.log.info(
				`START session=${sessionId.slice(0, 12)} interval=${this.interval}ms seeded=${seedMessages.length} messages`,
			);
		} else {
			// No seed provided — first poll will build a baseline snapshot from
			// REST instead of synthesizing events. This prevents re-emitting
			// the entire history as duplicate events when the client already
			// has cached events from session_switched.
			this.needsSeedOnFirstPoll = true;
			this.log.info(
				`START session=${sessionId.slice(0, 12)} interval=${this.interval}ms`,
			);
		}

		this.timer = setInterval(() => {
			this.trackPromise(this.poll());
		}, this.interval);

		// Immediate first poll
		this.trackPromise(this.poll());
	}

	/** Stop polling and clear state. */
	stopPolling(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.activeSessionId) {
			this.log.info(`STOP session=${this.activeSessionId.slice(0, 12)}`);
		}
		this.activeSessionId = null;
		this.previousSnapshot = new Map();
	}

	/** Whether we're actively polling a session. */
	isPolling(): boolean {
		return this.timer !== null;
	}

	/** Which session we're polling (if any). */
	getPollingSessionId(): string | null {
		return this.activeSessionId;
	}

	/**
	 * Notify the poller that an SSE event was received for a session.
	 * If SSE events are flowing, REST polling is unnecessary and will be suppressed.
	 */
	notifySSEEvent(sessionId: string): void {
		if (sessionId === this.activeSessionId) {
			this.lastSSEEventAt = Date.now();
			this.needsReseed = true;
		}
	}

	/**
	 * Check if SSE events are currently flowing for the active session.
	 * Returns true if we received an SSE event within the silence threshold.
	 */
	isSSEActive(): boolean {
		if (this.lastSSEEventAt === 0) return false;
		return Date.now() - this.lastSSEEventAt < SSE_SILENCE_THRESHOLD_MS;
	}

	/**
	 * Emit a done event for the session when it transitions to idle.
	 * Called externally by the status poller integration.
	 */
	emitDone(sessionId: string): void {
		if (sessionId !== this.activeSessionId) return;
		const events: RelayMessage[] = [{ type: "done", sessionId, code: 0 }];
		for (const cb of this.eventsCallbacks) {
			cb(events);
		}
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async poll(): Promise<void> {
		if (this.polling) {
			this.log.verbose(`poll skipped — previous poll still running`);
			return;
		}
		if (!this.activeSessionId) return;

		// If SSE events are flowing, skip REST polling
		if (this.isSSEActive()) {
			this.log.verbose(
				`poll skipped — SSE active for session=${this.activeSessionId?.slice(0, 12)}`,
			);
			return;
		}

		// Auto-stop if no content detected for IDLE_TIMEOUT_MS,
		// but only when no browser clients are viewing this session.
		// When viewers are present, keep polling so we can detect
		// activity from external processes (e.g. the OpenCode TUI).
		if (
			this.lastContentAt > 0 &&
			Date.now() - this.lastContentAt > IDLE_TIMEOUT_MS &&
			!this.hasViewers?.()
		) {
			this.log.info(
				`IDLE TIMEOUT session=${this.activeSessionId.slice(0, 12)} — auto-stopping`,
			);
			this.stopPolling();
			return;
		}

		this.polling = true;
		const sessionId = this.activeSessionId;

		try {
			const messages = await this.client.session.messages(sessionId);

			// ── Seed on first poll (no seed provided at startPolling) ──
			// Build a baseline snapshot from REST instead of synthesizing
			// events. Without this, the first poll with an empty snapshot
			// would re-emit the entire history as duplicate events.
			if (this.needsSeedOnFirstPoll) {
				this.needsSeedOnFirstPoll = false;
				this.previousSnapshot = buildSeedSnapshot(messages);
				this.log.info(
					`SEEDED session=${sessionId.slice(0, 12)} — first poll baseline (${messages.length} messages)`,
				);
				return; // Skip this cycle — snapshot is now current
			}

			// ── Reseed after SSE silence ─────────────────────────────────
			// When SSE was active (needsReseed=true) but has now gone silent,
			// reseed the snapshot from the REST API before diffing. This
			// prevents the poller from re-synthesizing content that SSE
			// already delivered to clients.
			if (this.needsReseed) {
				this.needsReseed = false;
				this.previousSnapshot = buildSeedSnapshot(messages);
				this.log.info(
					`RESEEDED session=${sessionId.slice(0, 12)} — SSE silence transition`,
				);
				return; // Skip this cycle — snapshot is now current
			}

			const events = this.doDiffAndSynthesize(sessionId, messages);

			if (events.length > 0) {
				this.lastContentAt = Date.now();
				this.log.info(
					`SYNTHESIZED session=${sessionId.slice(0, 12)} events=${events.length} types=[${events.map((e) => e.type).join(",")}]`,
				);
				for (const cb of this.eventsCallbacks) {
					cb(events);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.log.warn(`poll failed: ${msg}`);
		} finally {
			this.polling = false;
		}
	}

	/** Cancel all work and wait for in-flight operations to settle. */
	async drain(): Promise<void> {
		this.stopPolling();
		await Promise.allSettled([...this.pendingPromises]);
		this.pendingPromises.clear();
	}

	// ─── Diff + Synthesis ──────────────────────────────────────────────────

	private doDiffAndSynthesize(
		sessionId: string,
		messages: Message[],
	): RelayMessage[] {
		const { events, newSnapshot } = diffAndSynthesize(
			this.previousSnapshot,
			messages,
		);
		this.previousSnapshot = newSnapshot;
		// Tag all synthesized events with the active session's ID
		return events.map((e) => tagWithSessionId(e, sessionId));
	}

	/** Track a fire-and-forget promise for drain. */
	private trackPromise<T>(promise: Promise<T>): void {
		this.pendingPromises.add(promise);
		promise.finally(() => this.pendingPromises.delete(promise)).catch(() => {});
	}
}

// ─── MessagePollerManager Types ─────────────────────────────────────────────

/** Callback signature for the "events" broadcast event. */
export type PollerManagerEventsCallback = (
	messages: RelayMessage[],
	sessionId: string,
) => void;

export interface MessagePollerManagerOptions {
	client: Pick<OpenCodeAPI, "session">;
	log?: Logger;
	interval?: number;
	/** External viewer check — delegates to SessionRegistry */
	hasViewers?: (sessionId: string) => boolean;
}

// ─── MessagePollerManager ───────────────────────────────────────────────────

export class MessagePollerManager {
	private readonly pollers: Map<string, MessagePoller> = new Map();
	private readonly client: Pick<OpenCodeAPI, "session">;
	private readonly log: Logger;
	private readonly interval?: number;

	/** External viewer check — delegates to SessionRegistry when provided */
	private readonly _hasViewers: ((sessionId: string) => boolean) | undefined;

	/** Registered "events" broadcast callbacks. */
	private readonly eventsCallbacks: PollerManagerEventsCallback[] = [];

	constructor(options: MessagePollerManagerOptions) {
		this.client = options.client;
		this.log = options.log ?? createSilentLogger();
		if (options.interval != null) this.interval = options.interval;
		this._hasViewers = options.hasViewers;
	}

	/** Register a callback for the "events" broadcast event. */
	on(_event: "events", callback: PollerManagerEventsCallback): void {
		this.eventsCallbacks.push(callback);
	}

	// ─── Viewer tracking ──────────────────────────────────────────────────

	/** Check if any browser client is viewing the given session. */
	hasViewers(sessionId: string): boolean {
		return this._hasViewers?.(sessionId) ?? false;
	}

	// ─── Polling lifecycle ────────────────────────────────────────────────

	/**
	 * Start polling messages for a session.
	 * No-op if already polling that session.
	 * Capacity gating is handled upstream by the monitoring reducer.
	 */
	startPolling(sessionId: string, seedMessages?: Message[]): void {
		if (this.pollers.has(sessionId)) return;

		const poller = new MessagePoller({
			client: this.client,
			...(this.interval != null && { interval: this.interval }),
			log: this.log,
			hasViewers: () => this.hasViewers(sessionId),
		});
		poller.on("events", (events) => {
			for (const cb of this.eventsCallbacks) {
				cb(events, sessionId);
			}
		});
		poller.startPolling(sessionId, seedMessages);
		this.pollers.set(sessionId, poller);
	}

	/** Stop polling for a specific session. */
	stopPolling(sessionId: string): void {
		const poller = this.pollers.get(sessionId);
		if (poller) {
			poller.stopPolling();
			poller.removeAllListeners();
			this.pollers.delete(sessionId);
		}
	}

	/**
	 * Check if a specific session (or any session) is being polled.
	 * @param sessionId If provided, checks that specific session. Otherwise checks if any poller is active.
	 */
	isPolling(sessionId?: string): boolean {
		if (sessionId) return this.pollers.has(sessionId);
		return this.pollers.size > 0;
	}

	/**
	 * Notify that an SSE event was received for a session.
	 * Forwards to the session's poller (if any) to suppress REST polling.
	 */
	notifySSEEvent(sessionId: string): void {
		this.pollers.get(sessionId)?.notifySSEEvent(sessionId);
	}

	/**
	 * Emit a done event for a session when it transitions to idle.
	 * Forwards to the session's poller (if any).
	 */
	emitDone(sessionId: string): void {
		this.pollers.get(sessionId)?.emitDone(sessionId);
	}

	/** Stop all active pollers. */
	stopAll(): void {
		for (const [, poller] of this.pollers) {
			poller.stopPolling();
			poller.removeAllListeners();
		}
		this.pollers.clear();
	}

	/** Drain: stop all child pollers. */
	async drain(): Promise<void> {
		this.stopAll();
	}

	/** Get the number of active pollers. */
	get size(): number {
		return this.pollers.size;
	}

	/**
	 * Get all session IDs currently being polled.
	 * Used by relay-stack to iterate over active polled sessions.
	 */
	getPollingSessionIds(): string[] {
		return [...this.pollers.keys()];
	}
}
