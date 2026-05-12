// ─── SSE Stream (Effect-based) ───────────────────────────────────────────────
// SDK-backed SSE consumer using api.event.subscribe().
// Internally powered by Effect Fiber + Schedule for lifecycle and reconnection.
// Keeps the callback-based public API for compatibility with relay wiring.

import { Duration, Effect, Fiber, Schedule } from "effect";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEStreamOptions {
	api: {
		event: {
			subscribe(options?: {
				signal?: AbortSignal;
			}): Promise<{ stream: AsyncGenerator<unknown> }>;
		};
	};
	/** Base reconnection delay in ms (default: 1000). */
	baseDelay?: number;
	/** Maximum reconnection delay in ms (default: 30_000). */
	maxDelay?: number;
	/** Mark stream as stale if no event within this window (default: 60_000). */
	staleThreshold?: number;
	log?: Logger;
}

/** Callback signatures for each SSEStream broadcast event type. */
export interface SSEStreamCallbacks {
	event: (data: unknown) => void;
	connected: () => void;
	disconnected: (error: Error | undefined) => void;
	reconnecting: (info: { attempt: number; delay: number }) => void;
	error: (error: Error) => void;
	heartbeat: () => void;
}

// ─── Reconnect schedule factory ─────────────────────────────────────────────

function makeReconnectSchedule(baseDelay: number, maxDelay: number) {
	return Schedule.exponential(Duration.millis(baseDelay)).pipe(
		Schedule.jittered,
		Schedule.whileOutput((d) => Duration.toMillis(d) <= maxDelay),
		// Cap total retry time at 5 minutes of continuous failures
		Schedule.upTo(Duration.minutes(5)),
	);
}

// ─── SSE Stream ──────────────────────────────────────────────────────────────

export class SSEStream {
	private readonly api: SSEStreamOptions["api"];
	private readonly log: Logger;
	private readonly baseDelay: number;
	private readonly maxDelay: number;
	private readonly staleThreshold: number;

	private running = false;
	private connected = false;
	private lastEventAt: number | null = null;
	private reconnectCount = 0;

	/** AbortController for the current SSE connection. */
	private sseAbort: AbortController | null = null;

	/** Effect fiber running the consume loop. */
	private fiber: Fiber.RuntimeFiber<void, never> | null = null;

	private desiredRunning = false;
	private lifecycleGeneration = 0;
	private lifecycleQueue: Promise<void> = Promise.resolve();

	/** Pending fire-and-forget promises — awaited in drain(). */
	private readonly pendingPromises = new Set<Promise<unknown>>();

	/** Registered callbacks keyed by event type. */
	private readonly callbacks: {
		[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
	} = {
		event: [],
		connected: [],
		disconnected: [],
		reconnecting: [],
		error: [],
		heartbeat: [],
	};

	constructor(options: SSEStreamOptions) {
		this.api = options.api;
		this.log = options.log ?? createSilentLogger();
		this.baseDelay = options.baseDelay ?? 1000;
		this.maxDelay = options.maxDelay ?? 30_000;
		this.staleThreshold = options.staleThreshold ?? 60_000;
	}

	/** Register a callback for a specific broadcast event type. */
	on<K extends keyof SSEStreamCallbacks>(
		event: K,
		callback: SSEStreamCallbacks[K],
	): void {
		this.callbacks[event].push(callback);
	}

	/** Start consuming SSE events. Does not throw — errors are notified via callbacks. */
	async connect(): Promise<void> {
		this.desiredRunning = true;
		const generation = ++this.lifecycleGeneration;

		await this.enqueueLifecycle(async () => {
			if (!this.desiredRunning || generation !== this.lifecycleGeneration)
				return;
			this.startConnection();
		});
	}

	/** Stop consuming and clean up. */
	async disconnect(): Promise<void> {
		this.desiredRunning = false;
		this.lifecycleGeneration++;

		await this.enqueueLifecycle(() => this.stopCurrentConnection());
	}

	/** Get connection health snapshot. */
	getHealth(): ConnectionHealth & { stale: boolean } {
		return {
			connected: this.connected,
			lastEventAt: this.lastEventAt,
			reconnectCount: this.reconnectCount,
			stale: this.isStale(),
		};
	}

	/** Check if actively connected and consuming. */
	isConnected(): boolean {
		return this.running && this.connected;
	}

	/** Kill SSE stream and drain tracked work. */
	async drain(): Promise<void> {
		await this.disconnect();
		await Promise.allSettled([...this.pendingPromises]);
		this.pendingPromises.clear();
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private isStale(): boolean {
		if (!this.connected) return false;
		if (this.lastEventAt === null) return false;
		return Date.now() - this.lastEventAt > this.staleThreshold;
	}

	private enqueueLifecycle(work: () => void | Promise<void>): Promise<void> {
		const run = this.lifecycleQueue.then(work, work);
		this.lifecycleQueue = run.catch(() => {});
		return this.lifecycleQueue;
	}

	private startConnection(): void {
		if (this.running) return;
		this.running = true;
		this.reconnectCount = 0;

		// Launch the Effect-based consume loop as a daemon fiber
		const program = this.consumeLoop();

		this.fiber = Effect.runFork(program);
	}

	private async stopCurrentConnection(): Promise<void> {
		this.running = false;
		this.connected = false;

		const abort = this.sseAbort;
		const fiber = this.fiber;

		// Abort the SSE fetch/reader so the async generator terminates.
		if (abort) {
			abort.abort();
			if (this.sseAbort === abort) this.sseAbort = null;
		}

		// Interrupt the Effect fiber
		if (fiber) {
			await Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {});
			if (this.fiber === fiber) this.fiber = null;
		}
	}

	/** Invoke all registered callbacks for a given event type. */
	private notify<K extends keyof SSEStreamCallbacks>(
		event: K,
		...args: Parameters<SSEStreamCallbacks[K]>
	): void {
		for (const cb of this.callbacks[event]) {
			(cb as (...a: unknown[]) => void)(...args);
		}
	}

	/**
	 * Effect-based consume loop with automatic reconnection.
	 *
	 * Uses Effect.retry with an exponential schedule for reconnection.
	 * Each connection attempt creates a fresh AbortController and consumes
	 * the SDK's AsyncGenerator as a stream.
	 */
	private consumeLoop(): Effect.Effect<void, never, never> {
		const schedule = makeReconnectSchedule(this.baseDelay, this.maxDelay);

		// Single connection attempt — connects, consumes events, returns on error
		const singleConnection: Effect.Effect<void, Error, never> = Effect.async<
			void,
			Error
		>((resume) => {
			// Guard: if not running, resolve immediately
			if (!this.running) {
				resume(Effect.void);
				return;
			}

			this.sseAbort = new AbortController();
			const abort = this.sseAbort;

			const run = async () => {
				const { stream } = await this.api.event.subscribe({
					signal: abort.signal,
				});

				this.reconnectCount =
					this.connected === false && this.reconnectCount > 0
						? this.reconnectCount
						: 0;
				this.connected = true;
				this.notify("connected");

				for await (const event of stream) {
					if (!this.running) break;

					const evt = event as { type?: string };
					this.lastEventAt = Date.now();

					if (
						evt.type === "server.heartbeat" ||
						evt.type === "server.connected"
					) {
						this.notify("heartbeat");
						continue;
					}

					this.notify("event", event);
				}

				// Stream ended gracefully — signal reconnect if still running
				if (this.running) {
					this.connected = false;
					this.notify("disconnected", undefined);
					resume(Effect.fail(new Error("SSE stream ended")));
				} else {
					resume(Effect.void);
				}
			};

			const runPromise = run().catch((err) => {
				if (!this.running) {
					resume(Effect.void);
					return;
				}
				const error = err instanceof Error ? err : new Error(String(err));
				if (error.name === "AbortError") {
					resume(Effect.void);
					return;
				}
				this.connected = false;
				this.notify("disconnected", error);
				this.notify("error", error);
				resume(Effect.fail(error));
			});

			return Effect.tryPromise({
				try: async () => {
					if (!abort.signal.aborted) abort.abort();
					await runPromise;
				},
				catch: () => undefined,
			}).pipe(Effect.catchAll(() => Effect.void));
		});

		// Wrap with retry using the Effect Schedule, notifying reconnection callbacks
		return singleConnection.pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					if (!this.running) return;
					this.reconnectCount++;
					const delay = Math.min(
						this.baseDelay * 2 ** (this.reconnectCount - 1),
						this.maxDelay,
					);
					this.notify("reconnecting", {
						attempt: this.reconnectCount,
						delay,
					});
					this.log.debug(
						`Reconnecting in ~${delay}ms (attempt ${this.reconnectCount})`,
					);
				}),
			),
			Effect.retry(schedule),
			Effect.catchAll(() => Effect.void),
		);
	}
}
