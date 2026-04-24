// ─── Message Poller Manager (Multi-Session Polling) ──────────────────────────
// Wraps MessagePoller to support polling multiple sessions concurrently.
// Each session gets its own independent MessagePoller instance.
// Capacity gating is handled upstream by the monitoring reducer (evaluateAll).
//
// Viewer tracking is delegated to an external hasViewers function
// (typically backed by SessionRegistry). Pollers for viewed sessions
// suppress their idle timeout — they keep polling indefinitely so they can
// detect activity from external processes (e.g. the OpenCode TUI running
// in a separate OS process that shares only SQLite).

import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { Message } from "../instance/sdk-types.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { RelayMessage } from "../types.js";
import { MessagePoller } from "./message-poller.js";

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Manager ─────────────────────────────────────────────────────────────────

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
