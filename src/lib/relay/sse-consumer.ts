// ─── SSE Event Consumer (Ticket 1.2) ─────────────────────────────────────────
// Connects to OpenCode's SSE endpoint and emits typed events.
// Uses sse-backoff.ts for reconnection logic and event-translator.ts for parsing.
// IO layer: actual HTTP fetch + SSE parsing.

import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import { SSEConnectionError } from "../errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth, OpenCodeEvent } from "../types.js";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	createHealthTracker,
	type HealthTracker,
	parseSSEDataAuto,
} from "./sse-backoff.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEConsumerOptions {
	baseUrl: string;
	authHeaders?: Record<string, string>;
	backoff?: Partial<BackoffConfig>;
	staleThreshold?: number;
	log?: Logger;
}

export type SSEConsumerEvents = {
	event: [OpenCodeEvent];
	connected: [];
	disconnected: [Error | undefined];
	reconnecting: [{ attempt: number; delay: number }];
	error: [Error];
	heartbeat: [];
};

// ─── SSE Consumer ────────────────────────────────────────────────────────────

export class SSEConsumer extends TrackedService<SSEConsumerEvents> {
	private readonly baseUrl: string;
	private readonly authHeaders: Record<string, string>;
	private readonly backoffConfig: BackoffConfig;
	private readonly healthTracker: HealthTracker;
	private readonly log: Logger;

	private abortController: AbortController | null = null;
	private reconnectAttempt = 0;
	private running = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(registry: ServiceRegistry, options: SSEConsumerOptions) {
		super(registry);
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.authHeaders = options.authHeaders ?? {};
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
		// Fire-and-forget: startStream handles its own errors via emit + reconnect.
		// Catch edge cases where startStream throws before its internal try/catch.
		this.tracked(
			this.startStream().catch((err) => {
				if (!this.running) return;
				const error = err instanceof Error ? err : new Error(String(err));
				this.emit("error", error);
				this.scheduleReconnect();
			}),
		);
	}

	/** Stop consuming and clean up */
	async disconnect(): Promise<void> {
		this.running = false;
		if (this.reconnectTimer) {
			this.clearTrackedTimer(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.healthTracker.onDisconnected();
	}

	/** Get connection health snapshot */
	getHealth(): ConnectionHealth & { stale: boolean } {
		return this.healthTracker.getHealth();
	}

	/** Check if actively connected and consuming */
	isConnected(): boolean {
		return this.running && this.healthTracker.getHealth().connected;
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async startStream(): Promise<void> {
		if (!this.running) return;

		const url = `${this.baseUrl}/event`;
		this.abortController = new AbortController();

		try {
			const response = await fetch(url, {
				headers: {
					...this.authHeaders,
					Accept: "text/event-stream",
					"Cache-Control": "no-cache",
				},
				signal: this.abortController.signal,
			});

			if (!response.ok) {
				throw new SSEConnectionError(
					`SSE connection failed: HTTP ${response.status}`,
					{ context: { url, status: response.status } },
				);
			}

			if (!response.body) {
				throw new SSEConnectionError("SSE response has no body", {
					context: { url },
				});
			}

			// Connected successfully
			this.reconnectAttempt = 0;
			this.healthTracker.onConnected();
			this.emit("connected");

			// Parse SSE stream
			await this.consumeStream(response.body);
		} catch (err) {
			if (!this.running) return; // Intentional disconnect

			const error = err instanceof Error ? err : new Error(String(err));
			if (error.name === "AbortError") return; // Intentional abort

			this.healthTracker.onDisconnected();
			this.emit("disconnected", error);
			this.emit("error", error);

			// Schedule reconnection
			this.scheduleReconnect();
		}
	}

	private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (this.running) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete SSE messages (double newline separated)
				const messages = buffer.split("\n\n");
				buffer = messages.pop() ?? "";

				for (const message of messages) {
					this.processSSEMessage(message);
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Stream ended — reconnect if still running
		if (this.running) {
			this.healthTracker.onDisconnected();
			this.emit("disconnected", undefined);
			this.scheduleReconnect();
		}
	}

	private processSSEMessage(raw: string): void {
		// Parse SSE format: "event: type\ndata: {...}\n"
		const lines = raw.split("\n");
		let _eventType = "";
		const dataLines: string[] = [];

		for (const line of lines) {
			if (line.startsWith("event:")) {
				_eventType = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trim());
			} else if (line.startsWith(":")) {
			}
		}

		if (dataLines.length === 0) {
			// Heartbeat or empty message
			if (raw.trim().startsWith(":")) {
				this.healthTracker.onEvent();
				this.emit("heartbeat");
			}
			return;
		}

		const dataStr = dataLines.join("\n");
		const parsed = parseSSEDataAuto(dataStr);

		if (!parsed.ok || !parsed.event) {
			// Malformed event — log warning but continue (AC5)
			this.log.warn(`Malformed event: ${dataStr.slice(0, 120)}`);
			return;
		}

		const event = parsed.event;

		// Handle heartbeat events
		if (
			event.type === "server.heartbeat" ||
			event.type === "server.connected"
		) {
			this.healthTracker.onEvent();
			if (event.type === "server.connected") {
				this.emit("heartbeat");
			}
			return;
		}

		// Track event for health
		this.healthTracker.onEvent();

		// Emit the event
		this.emit("event", event);
	}

	/** Kill SSE stream and drain tracked work. */
	override async drain(): Promise<void> {
		await this.disconnect();
		await super.drain();
	}

	private scheduleReconnect(): void {
		if (!this.running) return;

		const delay = calculateBackoffDelay(
			this.reconnectAttempt,
			this.backoffConfig,
		);
		this.reconnectAttempt++;

		this.emit("reconnecting", {
			attempt: this.reconnectAttempt,
			delay,
		});

		this.healthTracker.onReconnect();

		this.reconnectTimer = this.delayed(() => {
			this.reconnectTimer = null;
			this.tracked(
				this.startStream().catch((err) => {
					if (!this.running) return;
					const error = err instanceof Error ? err : new Error(String(err));
					this.emit("error", error);
					this.scheduleReconnect();
				}),
			);
		}, delay);
	}
}
