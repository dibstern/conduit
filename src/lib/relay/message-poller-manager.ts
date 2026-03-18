// ─── Message Poller Manager (Multi-Session Polling) ──────────────────────────
// Wraps MessagePoller to support polling multiple sessions concurrently.
// Each session gets its own independent MessagePoller instance, up to a
// configurable maximum to prevent resource exhaustion.
//
// Viewer tracking is delegated to an external hasViewers function
// (typically backed by SessionRegistry). Pollers for viewed sessions
// suppress their idle timeout — they keep polling indefinitely so they can
// detect activity from external processes (e.g. the OpenCode TUI running
// in a separate OS process that shares only SQLite).

import { EventEmitter } from "node:events";
import type { Message, OpenCodeClient } from "../instance/opencode-client.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { RelayMessage } from "../types.js";
import { MessagePoller } from "./message-poller.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of concurrent pollers to prevent resource exhaustion. */
const MAX_CONCURRENT_POLLERS = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessagePollerManagerEvents {
	/** Emitted with synthesized events + sessionId from REST diff */
	events: [messages: RelayMessage[], sessionId: string];
	/** Emitted when a new poller is rejected because the cap is reached */
	capacity_exceeded: [{ sessionId: string; current: number; max: number }];
}

export interface MessagePollerManagerOptions {
	client: Pick<OpenCodeClient, "getMessages">;
	log?: Logger;
	interval?: number;
	/** External viewer check — delegates to SessionRegistry */
	hasViewers?: (sessionId: string) => boolean;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class MessagePollerManager extends EventEmitter<MessagePollerManagerEvents> {
	private readonly pollers: Map<string, MessagePoller> = new Map();
	private readonly client: Pick<OpenCodeClient, "getMessages">;
	private readonly log: Logger;
	private readonly interval?: number;

	/** External viewer check — delegates to SessionRegistry when provided */
	private readonly _hasViewers: ((sessionId: string) => boolean) | undefined;

	constructor(options: MessagePollerManagerOptions) {
		super();
		this.client = options.client;
		this.log = options.log ?? createSilentLogger();
		if (options.interval != null) this.interval = options.interval;
		this._hasViewers = options.hasViewers;
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
	 * Rejected (with a log warning) if max concurrent pollers reached.
	 */
	startPolling(sessionId: string, seedMessages?: Message[]): void {
		if (this.pollers.has(sessionId)) return;
		if (this.pollers.size >= MAX_CONCURRENT_POLLERS) {
			this.log.warn(
				`MAX POLLERS reached (${MAX_CONCURRENT_POLLERS}), skipping ${sessionId.slice(0, 12)}`,
			);
			this.emit("capacity_exceeded", {
				sessionId,
				current: this.pollers.size,
				max: MAX_CONCURRENT_POLLERS,
			});
			return;
		}

		const poller = new MessagePoller({
			client: this.client,
			...(this.interval != null && { interval: this.interval }),
			log: this.log,
			hasViewers: () => this.hasViewers(sessionId),
		});
		poller.on("events", (events) => this.emit("events", events, sessionId));
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
