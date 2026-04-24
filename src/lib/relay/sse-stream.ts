// ─── SSE Stream (Task 13) ────────────────────────────────────────────────────
// SDK-backed SSE consumer using api.event.subscribe().
// Replaces SSEConsumer's raw HTTP/SSE parsing with the typed AsyncGenerator
// returned by the OpenCode SDK. Reconnects with exponential backoff on failure.

import { EventEmitter } from "node:events";
import type { Drainable, ServiceRegistry } from "../daemon/service-registry.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth } from "../types.js";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	createHealthTracker,
	type HealthTracker,
} from "./sse-backoff.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEStreamOptions {
	api: {
		event: {
			subscribe(options?: {
				signal?: AbortSignal;
			}): Promise<{ stream: AsyncGenerator<unknown> }>;
		};
	};
	backoff?: Partial<BackoffConfig>;
	staleThreshold?: number;
	log?: Logger;
}

export type SSEStreamEvents = {
	event: [unknown];
	connected: [];
	disconnected: [Error | undefined];
	reconnecting: [{ attempt: number; delay: number }];
	error: [Error];
	heartbeat: [];
};

// ─── SSE Stream ──────────────────────────────────────────────────────────────

export class SSEStream
	extends EventEmitter<SSEStreamEvents>
	implements Drainable
{
	private readonly api: SSEStreamOptions["api"];
	private readonly backoffConfig: BackoffConfig;
	private readonly healthTracker: HealthTracker;
	private readonly log: Logger;
	private running = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** AbortController for the current SSE connection. Aborted on disconnect(). */
	private sseAbort: AbortController | null = null;

	/** Pending fire-and-forget promises — awaited in drain(). */
	private readonly pendingPromises = new Set<Promise<unknown>>();

	constructor(registry: ServiceRegistry, options: SSEStreamOptions) {
		super();
		registry.register(this);
		this.api = options.api;
		this.log = options.log ?? createSilentLogger();
		this.backoffConfig = {
			baseDelay: options.backoff?.baseDelay ?? 1000,
			maxDelay: options.backoff?.maxDelay ?? 30000,
			multiplier: options.backoff?.multiplier ?? 2,
		};
		this.healthTracker = createHealthTracker({
			staleThreshold: options.staleThreshold ?? 60_000,
		});
	}

	/** Start consuming SSE events. Does not throw — errors are emitted. */
	async connect(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.reconnectAttempt = 0;
		// Fire-and-forget: consumeLoop handles its own errors via emit + reconnect.
		this.trackPromise(
			this.consumeLoop().catch((err) => {
				if (!this.running) return;
				const error = err instanceof Error ? err : new Error(String(err));
				this.emit("error", error);
			}),
		);
	}

	/** Stop consuming and clean up. */
	async disconnect(): Promise<void> {
		this.running = false;
		// Abort the SSE fetch/reader so consumeLoop's `for await` unblocks.
		if (this.sseAbort) {
			this.sseAbort.abort();
			this.sseAbort = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.healthTracker.onDisconnected();
	}

	/** Get connection health snapshot. */
	getHealth(): ConnectionHealth & { stale: boolean } {
		return this.healthTracker.getHealth();
	}

	/** Check if actively connected and consuming. */
	isConnected(): boolean {
		return this.running && this.healthTracker.getHealth().connected;
	}

	/** Kill SSE stream and drain tracked work. */
	async drain(): Promise<void> {
		await this.disconnect();
		await Promise.allSettled([...this.pendingPromises]);
		this.pendingPromises.clear();
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	/** Track a fire-and-forget promise for drain. */
	private trackPromise<T>(promise: Promise<T>): Promise<T> {
		this.pendingPromises.add(promise);
		promise.finally(() => this.pendingPromises.delete(promise)).catch(() => {});
		return promise;
	}

	private async consumeLoop(): Promise<void> {
		while (this.running) {
			try {
				// Create a fresh AbortController per connection attempt so
				// disconnect() can cancel the underlying fetch/reader.
				this.sseAbort = new AbortController();
				const { stream } = await this.api.event.subscribe({
					signal: this.sseAbort.signal,
				});
				this.reconnectAttempt = 0;
				this.healthTracker.onConnected();
				this.emit("connected");

				for await (const event of stream) {
					if (!this.running) break;
					const evt = event as { type?: string };
					this.healthTracker.onEvent();

					if (
						evt.type === "server.heartbeat" ||
						evt.type === "server.connected"
					) {
						this.emit("heartbeat");
						continue;
					}

					this.emit("event", event);
				}

				// Stream ended gracefully — reconnect if still running
				if (this.running) {
					this.healthTracker.onDisconnected();
					this.emit("disconnected", undefined);
				}
			} catch (err) {
				if (!this.running) return;
				const error = err instanceof Error ? err : new Error(String(err));
				if (error.name === "AbortError") return;
				this.healthTracker.onDisconnected();
				this.emit("disconnected", error);
				this.emit("error", error);
			}

			// Schedule reconnection with exponential backoff
			if (this.running) {
				const delay = calculateBackoffDelay(
					this.reconnectAttempt,
					this.backoffConfig,
				);
				this.reconnectAttempt++;
				this.healthTracker.onReconnect();
				this.emit("reconnecting", {
					attempt: this.reconnectAttempt,
					delay,
				});
				this.log.debug(
					`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
				);
				await new Promise<void>((resolve) => {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						resolve();
					}, delay);
				});
			}
		}
	}
}
