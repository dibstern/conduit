// ─── SSE Stream (Effect-based) ───────────────────────────────────────────────
// SDK-backed SSE consumer using api.event.subscribe().
// Internally powered by an Effect fiber running an explicit reconnect loop.
// Conduit is the single retry owner: the SDK's internal SSE retry is disabled
// via sseMaxRetryAttempts so transport errors surface here instead of being
// swallowed. Keeps the callback-based public API for relay wiring.

import { Duration, Effect, Fiber } from "effect";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth } from "../types.js";
import { calculateBackoffDelay } from "./sse-backoff.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEStreamOptions {
	api: {
		event: {
			subscribe(options?: {
				signal?: AbortSignal;
				sseMaxRetryAttempts?: number;
				onSseError?: (error: unknown) => void;
			}): Promise<{ stream: AsyncGenerator<unknown> }>;
		};
	};
	/** Base reconnection delay in ms (default: 1000). */
	baseDelay?: number;
	/** Maximum reconnection delay in ms (default: 30_000). */
	maxDelay?: number;
	/**
	 * Tear down the connection if no event arrives within this window
	 * (default: 30_000 — three missed 10s OpenCode heartbeats).
	 */
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

export interface SSEStreamEvents {
	on<K extends keyof SSEStreamCallbacks>(
		event: K,
		callback: SSEStreamCallbacks[K],
	): void;
}

export interface SSEStreamHealth {
	getHealth(): ConnectionHealth;
	isConnected(): boolean;
}

export interface SSEStreamLifecycle {
	connectEffect(): Effect.Effect<void>;
	disconnectEffect(): Effect.Effect<void>;
	drainEffect(): Effect.Effect<void>;
}

export type SSEStreamPort = SSEStreamEvents &
	SSEStreamHealth &
	SSEStreamLifecycle;

// ─── SSE Stream ──────────────────────────────────────────────────────────────

export class SSEStream implements SSEStreamPort {
	private readonly api: SSEStreamOptions["api"];
	private readonly log: Logger;
	private readonly baseDelay: number;
	private readonly maxDelay: number;
	private readonly staleThreshold: number;

	private running = false;
	private connected = false;
	private lastEventAt: number | null = null;
	private reconnectCount = 0;

	/** When the current connection was established; null while disconnected. */
	private connectedAt: number | null = null;

	/** Whether the current connection was torn down by the staleness watchdog. */
	private staleTeardown = false;

	/** Monotonic id of the current consume-loop run; guards the un-wedge finalizer. */
	private runCounter = 0;

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
		this.staleThreshold = options.staleThreshold ?? 30_000;
	}

	/** Register a callback for a specific broadcast event type. */
	on<K extends keyof SSEStreamCallbacks>(
		event: K,
		callback: SSEStreamCallbacks[K],
	): void {
		this.callbacks[event].push(callback);
	}

	/** Start consuming SSE events. Does not throw — errors are notified via callbacks. */
	connectEffect(): Effect.Effect<void> {
		return Effect.flatMap(
			Effect.sync(() => {
				this.desiredRunning = true;
				return ++this.lifecycleGeneration;
			}),
			(generation) =>
				this.enqueueLifecycleEffect(() => {
					if (!this.desiredRunning || generation !== this.lifecycleGeneration) {
						return Effect.void;
					}
					return this.startConnectionEffect();
				}),
		);
	}

	/** Stop consuming and clean up. */
	disconnectEffect(): Effect.Effect<void> {
		return Effect.flatMap(
			Effect.sync(() => {
				this.desiredRunning = false;
				this.lifecycleGeneration++;
			}),
			() =>
				this.enqueueLifecycleEffect(() => this.stopCurrentConnectionEffect()),
		);
	}

	/** Get connection health snapshot. */
	getHealth(): ConnectionHealth {
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
	drainEffect(): Effect.Effect<void> {
		return Effect.zipRight(
			this.disconnectEffect(),
			this.awaitPendingPromisesEffect(),
		);
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private isStale(): boolean {
		if (!this.connected) return false;
		// Based on max(connectedAt, lastEventAt) so a connection that never
		// yields any event is still caught.
		const last = Math.max(this.connectedAt ?? 0, this.lastEventAt ?? 0);
		if (last === 0) return false;
		return Date.now() - last > this.staleThreshold;
	}

	private enqueueLifecycleEffect(
		work: () => Effect.Effect<void>,
	): Effect.Effect<void> {
		return Effect.async<void>((resume) => {
			let release!: () => void;
			const completion = new Promise<void>((resolve) => {
				release = resolve;
			});
			const runWork = () => {
				resume(
					Effect.suspend(work).pipe(Effect.ensuring(Effect.sync(release))),
				);
				return completion;
			};
			const run = this.lifecycleQueue.then(runWork, runWork);
			this.lifecycleQueue = run.catch(() => {});
			// Interruption canceler (c4z). Without this, an interrupted caller
			// leaves `resume` inert, so the work effect — and therefore its
			// `Effect.ensuring(release)` — never runs, `completion` never
			// settles, and the queue is poisoned for every later connect,
			// disconnect and drain (including the shutdown finalizer).
			// Releasing here settles this entry so the chain keeps moving.
			// If interruption wins before `runWork` fires, the queued work is
			// skipped entirely — its caller is gone. If the work had already
			// started, interruption unwinds it and its own inner
			// `ensuring(release)` runs first (finalizers unwind inside-out),
			// so this canceler only ever double-releases an entry whose work
			// has already terminated. Promise resolution is idempotent, and
			// mutual exclusion is preserved either way.
			return Effect.sync(release);
		});
	}

	private awaitPendingPromisesEffect(): Effect.Effect<void> {
		return Effect.async<void>((resume) => {
			Promise.allSettled([...this.pendingPromises]).then(
				() => {
					this.pendingPromises.clear();
					resume(Effect.void);
				},
				() => {
					this.pendingPromises.clear();
					resume(Effect.void);
				},
			);
		});
	}

	private startConnectionEffect(): Effect.Effect<void> {
		// Uninterruptible so an interrupt cannot land between `running = true`
		// and the fork — that would leave `running` stuck with no loop fiber
		// (and no finalizer) to ever clear it. The forked loop itself must be
		// explicitly interruptible: a fiber forked inside an uninterruptible
		// region inherits that status, and disconnect relies on interruption.
		return Effect.uninterruptible(
			Effect.gen(this, function* () {
				if (this.running) return;
				this.running = true;
				this.reconnectCount = 0;

				// Launch the Effect-based consume loop as a daemon fiber.
				this.fiber = yield* Effect.forkDaemon(
					Effect.interruptible(this.consumeLoop()),
				);
			}),
		);
	}

	private stopCurrentConnectionEffect(): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			this.running = false;
			this.connected = false;

			const abort = this.sseAbort;
			const fiber = this.fiber;

			// Abort the SSE fetch/reader so the async generator terminates.
			if (abort) {
				abort.abort();
				if (this.sseAbort === abort) this.sseAbort = null;
			}

			// Interrupt the Effect fiber and wait for its finalizers.
			if (fiber) {
				yield* Fiber.interrupt(fiber);
				if (this.fiber === fiber) this.fiber = null;
			}
		});
	}

	/**
	 * Invoke all registered callbacks for a given event type.
	 * Listener errors are logged, not propagated — a throwing listener would
	 * otherwise defect the consume-loop fiber and silently kill the stream.
	 */
	private notify<K extends keyof SSEStreamCallbacks>(
		event: K,
		...args: Parameters<SSEStreamCallbacks[K]>
	): void {
		for (const cb of this.callbacks[event]) {
			try {
				(cb as (...a: unknown[]) => void)(...args);
			} catch (err) {
				try {
					this.log.warn(`SSE '${event}' listener threw`, err);
				} catch {
					// The logger itself failed (e.g. EPIPE at shutdown) — drop it.
				}
			}
		}
	}

	/**
	 * Effect-based consume loop that owns reconnection.
	 *
	 * Runs one connection at a time and sleeps with capped, jittered
	 * exponential backoff between attempts. The loop never gives up while
	 * `running` is true; `disconnectEffect` interrupts it.
	 */
	private consumeLoop(): Effect.Effect<void, never, never> {
		const runId = ++this.runCounter;

		// Single connection attempt — connects, consumes events, fails on error
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
			let sseError: unknown;

			const staleError = () =>
				new Error(`SSE stream stale: no events for ${this.staleThreshold}ms`);

			const run = async () => {
				// Dead-stream watchdog: OpenCode emits server.heartbeat every 10s,
				// so a silent connection is a half-open socket. Abort it so the
				// SDK generator returns and the loop reconnects.
				let staleTimer: ReturnType<typeof setTimeout> | undefined;
				const armStaleTimer = () => {
					clearTimeout(staleTimer);
					staleTimer = setTimeout(() => {
						this.staleTeardown = true;
						abort.abort();
					}, this.staleThreshold);
				};

				try {
					const { stream } = await this.api.event.subscribe({
						signal: abort.signal,
						// Conduit owns reconnection — the SDK must fail fast. On error
						// the SDK fires onSseError and ends the stream instead of
						// silently retrying forever.
						sseMaxRetryAttempts: 1,
						onSseError: (error) => {
							sseError = error;
						},
					});

					// subscribe() does no network I/O — the SDK issues the fetch on
					// the stream's first next(). The first yielded frame (OpenCode
					// always sends server.connected first) is the connect signal;
					// arming the watchdog here catches a stream that never yields.
					armStaleTimer();

					for await (const event of stream) {
						if (!this.running) break;

						if (!this.connected) {
							this.connectedAt = Date.now();
							this.connected = true;
							this.notify("connected");
						}

						const evt = event as { type?: string };
						this.lastEventAt = Date.now();
						armStaleTimer();

						if (
							evt.type === "server.heartbeat" ||
							evt.type === "server.connected"
						) {
							this.notify("heartbeat");
							continue;
						}

						this.notify("event", event);
					}
				} finally {
					clearTimeout(staleTimer);
				}

				// Stream ended — signal reconnect if still running
				if (this.running) {
					this.connected = false;
					const error = this.staleTeardown
						? staleError()
						: sseError === undefined
							? undefined
							: sseError instanceof Error
								? sseError
								: new Error(String(sseError));
					this.notify("disconnected", error);
					// With sseMaxRetryAttempts: 1 the SDK never throws — transport
					// errors exit here, so this is where "error" must fire too.
					if (error) this.notify("error", error);
					resume(Effect.fail(error ?? new Error("SSE stream ended")));
				} else {
					resume(Effect.void);
				}
			};

			const runPromise = run().catch((err) => {
				if (!this.running) {
					resume(Effect.void);
					return;
				}
				const raw = err instanceof Error ? err : new Error(String(err));
				// A stale-watchdog abort is a real failure, not a clean shutdown.
				if (raw.name === "AbortError" && !this.staleTeardown) {
					resume(Effect.void);
					return;
				}
				const error = this.staleTeardown ? staleError() : raw;
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

		const loop = Effect.gen(this, function* () {
			let attempt = 0;
			while (this.running) {
				this.connectedAt = null;
				this.staleTeardown = false;
				yield* Effect.catchAll(singleConnection, () => Effect.void);
				if (!this.running) return;

				// Reset the backoff only after a connection that stayed healthy
				// for at least maxDelay — not on a mere successful subscribe(),
				// or an accept-then-drop server would be hammered at baseDelay.
				// A stale teardown was never healthy, whatever its uptime.
				if (
					!this.staleTeardown &&
					this.connectedAt !== null &&
					Date.now() - this.connectedAt >= this.maxDelay
				) {
					attempt = 0;
				}

				// The jittered delay below is both what we sleep and what we
				// report — a single source of truth for the callback payload.
				const delay =
					calculateBackoffDelay(attempt, {
						baseDelay: this.baseDelay,
						maxDelay: this.maxDelay,
						multiplier: 2,
					}) *
					(0.8 + Math.random() * 0.4);
				attempt++;
				this.reconnectCount++;
				this.notify("reconnecting", { attempt, delay });
				yield* Effect.sleep(Duration.millis(delay));
			}
		});

		// Un-wedge guard: if this loop dies for any reason while it is still
		// the active run, clear the flags so connectEffect() can start fresh.
		// Keyed on runId — a new run can only start once `running` is false,
		// so a stale finalizer can never clobber a newer run's state.
		return loop.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (runId !== this.runCounter) return;
					const wasRunning = this.running;
					this.running = false;
					this.connected = false;
					if (wasRunning) this.notify("disconnected", undefined);
				}),
			),
		);
	}
}
