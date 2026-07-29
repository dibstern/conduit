import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { calculateBackoffDelay } from "../../../src/lib/relay/sse-backoff.js";
import { SSEStream } from "../../../src/lib/relay/sse-stream.js";
import type { ConnectionHealth } from "../../../src/lib/types.js";

function makeStubApi(events: Array<{ type: string; properties?: unknown }>) {
	return {
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {
					for (const e of events) {
						yield e;
					}
				})(),
			})),
		},
		// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
	} as any;
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function withTimeout<T>(
	promise: Promise<T>,
	label: string,
	ms = 1000,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label}`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const connect = (stream: SSEStream) =>
	Effect.runPromise(stream.connectEffect());
const disconnect = (stream: SSEStream) =>
	Effect.runPromise(stream.disconnectEffect());
const drain = (stream: SSEStream) => Effect.runPromise(stream.drainEffect());

describe("SSEStream", () => {
	it("can be created and starts disconnected", () => {
		const api = makeStubApi([]);
		const stream = new SSEStream({ api });
		expect(stream.isConnected()).toBe(false);
	});

	it("emits 'connected' when stream starts", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await disconnect(stream);
	});

	it("emits events from the SDK stream", async () => {
		const events = [
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{
				type: "session.status",
				properties: { sessionID: "s1", status: { type: "idle" } },
			},
		];
		const api = makeStubApi(events);
		const stream = new SSEStream({ api });
		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await disconnect(stream);
		expect(received).toHaveLength(2);
		expect(received[0]).toEqual(events[0]);
	});

	it("emits heartbeat for server.heartbeat events", async () => {
		const api = makeStubApi([{ type: "server.heartbeat" }]);
		const stream = new SSEStream({ api });
		let heartbeatSeen = false;
		stream.on("heartbeat", () => {
			heartbeatSeen = true;
		});
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await disconnect(stream);
		expect(heartbeatSeen).toBe(true);
	});

	it("emits heartbeat for server.connected events", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream({ api });
		let heartbeatSeen = false;
		stream.on("heartbeat", () => {
			heartbeatSeen = true;
		});
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await disconnect(stream);
		expect(heartbeatSeen).toBe(true);
	});

	it("does not emit heartbeat events as regular events", async () => {
		const api = makeStubApi([
			{ type: "server.heartbeat" },
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{ type: "server.connected" },
		]);
		const stream = new SSEStream({ api });
		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await disconnect(stream);
		expect(received).toHaveLength(1);
		expect((received[0] as { type: string }).type).toBe("message.part.updated");
	});

	it("reports health state", () => {
		const api = makeStubApi([]);
		const stream = new SSEStream({ api });
		const health: ConnectionHealth = stream.getHealth();
		expect(health).toEqual({
			connected: false,
			lastEventAt: null,
			reconnectCount: 0,
			stale: false,
		});
		expect(health.stale).toBe(false);
	});

	it("pulls current staleness and clears it after disconnect", async () => {
		let now = 1_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => ({
					stream: (async function* () {
						yield { type: "server.connected" };
						await new Promise<void>((resolve) => {
							if (signal?.aborted) {
								resolve();
								return;
							}
							signal?.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = new SSEStream({
			api,
			staleThreshold: 1_000_000,
		});
		const connected = deferred();
		stream.on("connected", () => connected.resolve());

		try {
			await connect(stream);
			await connected.promise;
			expect(stream.getHealth()).toEqual({
				connected: true,
				lastEventAt: 1_000,
				reconnectCount: 0,
				stale: false,
			});

			now += 1_000_000;
			expect(stream.getHealth().stale).toBe(false);

			now += 1;
			expect(stream.getHealth().stale).toBe(true);

			await disconnect(stream);
			expect(stream.getHealth().stale).toBe(false);
		} finally {
			await disconnect(stream);
			nowSpy.mockRestore();
		}
	});

	it("isConnected returns false before connect", () => {
		const api = makeStubApi([]);
		const stream = new SSEStream({ api });
		expect(stream.isConnected()).toBe(false);
	});

	it("isConnected returns true after connect", async () => {
		const api = makeStubApi([{ type: "message.part.updated", properties: {} }]);
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		expect(stream.isConnected()).toBe(true);
		await disconnect(stream);
	});

	it("isConnected returns false after disconnect", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await disconnect(stream);
		expect(stream.isConnected()).toBe(false);
	});

	it("drain stops the stream", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		await drain(stream);
		expect(stream.isConnected()).toBe(false);
	});

	it("connect is idempotent when already running", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		connect(stream).catch(() => {});
		await connected;
		// Second connect should be a no-op
		await connect(stream);
		expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		await disconnect(stream);
	});

	it("disconnect waits for async generator cleanup after abort", async () => {
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		const cleanupFinished = deferred();
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => ({
					stream: (async function* () {
						try {
							yield { type: "server.connected" };
							await new Promise<void>((resolve) => {
								if (signal?.aborted) {
									resolve();
									return;
								}
								signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
							});
						} finally {
							cleanupStarted.resolve();
							await releaseCleanup.promise;
							cleanupFinished.resolve();
						}
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = new SSEStream({ api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await connected;

		let disconnectSettled = false;
		const disconnecting = disconnect(stream).then(() => {
			disconnectSettled = true;
		});
		let cleanupStartedSeen = false;
		let settledBeforeCleanupReleased = true;

		try {
			await withTimeout(cleanupStarted.promise, "cleanup to start");
			cleanupStartedSeen = true;
			await new Promise((resolve) => setTimeout(resolve, 0));
			settledBeforeCleanupReleased = disconnectSettled;
		} finally {
			releaseCleanup.resolve();
			await withTimeout(disconnecting, "disconnect to finish");
		}

		if (cleanupStartedSeen) {
			await withTimeout(cleanupFinished.promise, "cleanup to finish");
		}

		expect(settledBeforeCleanupReleased).toBe(false);
	});

	it("connect waits for pending disconnect cleanup before starting another stream", async () => {
		const firstCleanupStarted = deferred();
		const releaseFirstCleanup = deferred();
		let subscribeCount = 0;
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => {
					subscribeCount++;
					const connectionNumber = subscribeCount;
					return {
						stream: (async function* () {
							try {
								yield { type: "server.connected" };
								await new Promise<void>((resolve) => {
									if (signal?.aborted) {
										resolve();
										return;
									}
									signal?.addEventListener("abort", () => resolve(), {
										once: true,
									});
								});
							} finally {
								if (connectionNumber === 1) {
									firstCleanupStarted.resolve();
									await releaseFirstCleanup.promise;
								}
							}
						})(),
					};
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = new SSEStream({ api });
		const firstConnected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await firstConnected;

		const disconnecting = disconnect(stream);
		let reconnectSettled = false;
		let reconnecting: Promise<void> = Promise.resolve();

		let assertionFailure: unknown;
		try {
			await withTimeout(firstCleanupStarted.promise, "first cleanup to start");
			reconnecting = connect(stream).then(() => {
				reconnectSettled = true;
			});
			await Promise.resolve();
			expect(reconnectSettled).toBe(false);
			expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		} catch (error) {
			assertionFailure = error;
		} finally {
			releaseFirstCleanup.resolve();
			await withTimeout(disconnecting, "disconnect to finish");
			await withTimeout(reconnecting, "reconnect to finish");
			if (assertionFailure) await disconnect(stream);
		}

		if (assertionFailure) throw assertionFailure;
		expect(api.event.subscribe).toHaveBeenCalledTimes(2);
		await disconnect(stream);
	});

	it("later disconnect cancels a reconnect queued behind cleanup", async () => {
		const firstCleanupStarted = deferred();
		const releaseFirstCleanup = deferred();
		let subscribeCount = 0;
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => {
					subscribeCount++;
					const connectionNumber = subscribeCount;
					return {
						stream: (async function* () {
							try {
								yield { type: "server.connected" };
								await new Promise<void>((resolve) => {
									if (signal?.aborted) {
										resolve();
										return;
									}
									signal?.addEventListener("abort", () => resolve(), {
										once: true,
									});
								});
							} finally {
								if (connectionNumber === 1) {
									firstCleanupStarted.resolve();
									await releaseFirstCleanup.promise;
								}
							}
						})(),
					};
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = new SSEStream({ api });
		const firstConnected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await firstConnected;

		const firstDisconnect = disconnect(stream);
		let queuedReconnect: Promise<void> = Promise.resolve();
		let laterDisconnect: Promise<void> = Promise.resolve();
		let assertionFailure: unknown;

		try {
			await withTimeout(firstCleanupStarted.promise, "first cleanup to start");
			queuedReconnect = connect(stream);
			laterDisconnect = disconnect(stream);
		} catch (error) {
			assertionFailure = error;
		} finally {
			releaseFirstCleanup.resolve();
			await withTimeout(firstDisconnect, "first disconnect to finish");
			await withTimeout(queuedReconnect, "queued reconnect to finish");
			await withTimeout(laterDisconnect, "later disconnect to finish");
			if (assertionFailure) await disconnect(stream);
		}

		if (assertionFailure) throw assertionFailure;
		expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		expect(stream.isConnected()).toBe(false);
	});

	it("connect waits even when triggered synchronously by abort listeners", async () => {
		const firstCleanupStarted = deferred();
		const releaseFirstCleanup = deferred();
		let subscribeCount = 0;
		let stream: SSEStream;
		let reentrantConnect: Promise<void> | undefined;
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => {
					subscribeCount++;
					const connectionNumber = subscribeCount;
					return {
						stream: (async function* () {
							try {
								yield { type: "server.connected" };
								await new Promise<void>((resolve) => {
									if (signal?.aborted) {
										resolve();
										return;
									}
									signal?.addEventListener(
										"abort",
										() => {
											if (connectionNumber === 1) {
												reentrantConnect = connect(stream);
											}
											resolve();
										},
										{ once: true },
									);
								});
							} finally {
								if (connectionNumber === 1) {
									firstCleanupStarted.resolve();
									await releaseFirstCleanup.promise;
								}
							}
						})(),
					};
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		stream = new SSEStream({ api });
		const firstConnected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await firstConnected;

		const disconnecting = disconnect(stream);

		let assertionFailure: unknown;
		try {
			await withTimeout(firstCleanupStarted.promise, "first cleanup to start");
			await Promise.resolve();
			expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		} catch (error) {
			assertionFailure = error;
		} finally {
			releaseFirstCleanup.resolve();
			await withTimeout(disconnecting, "disconnect to finish");
			if (reentrantConnect) {
				await withTimeout(reentrantConnect, "reentrant connect to finish");
			}
			if (assertionFailure) await disconnect(stream);
		}

		if (assertionFailure) throw assertionFailure;
		expect(api.event.subscribe).toHaveBeenCalledTimes(2);
		await disconnect(stream);
	});

	// c4z: an interrupted caller must not poison the lifecycle queue.
	it("does not poison the lifecycle queue when a queued caller is interrupted", async () => {
		const cleanupStarted = deferred();
		const releaseCleanup = deferred();
		const api = makeStubApi([]);

		api.event.subscribe.mockImplementation(
			async ({ signal }: { signal?: AbortSignal } = {}) => ({
				stream: (async function* () {
					try {
						yield { type: "server.connected" };
						await new Promise<void>((resolve) => {
							if (signal?.aborted) {
								resolve();
								return;
							}
							signal?.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
					} finally {
						cleanupStarted.resolve();
						await releaseCleanup.promise;
					}
				})(),
			}),
		);

		const stream = new SSEStream({ api });
		const connected = deferred();
		stream.on("connected", () => connected.resolve());

		await connect(stream);
		await withTimeout(connected.promise, "initial connection");

		// Disconnect aborts the stream and then blocks awaiting generator cleanup,
		// so it owns the lifecycle queue slot for the duration of this test.
		const firstDisconnect = disconnect(stream);

		try {
			await withTimeout(cleanupStarted.promise, "first cleanup to start");

			// This connect queues behind the in-flight disconnect, then is
			// interrupted by the timeout before it ever reaches the head.
			const timedConnect = await Effect.runPromise(
				stream.connectEffect().pipe(Effect.timeoutOption("10 millis")),
			);

			expect(Option.isNone(timedConnect)).toBe(true);
			// Proves the queued work never started.
			expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		} finally {
			releaseCleanup.resolve();
			await withTimeout(firstDisconnect, "first disconnect to finish");
		}

		// Before the fix the interrupted entry's `completion` promise never
		// settles, so the queue is permanently pending and this drain hangs.
		await withTimeout(drain(stream), "drain after interrupted queued connect");
	});

	it("continues the lifecycle queue when the active caller is interrupted", async () => {
		const firstCleanupStarted = deferred();
		const releaseFirstCleanup = deferred();
		const firstCleanupFinished = deferred();
		const secondSubscribed = deferred();
		const observed: string[] = [];
		let subscribeCount = 0;
		const api = makeStubApi([]);

		api.event.subscribe.mockImplementation(
			async ({ signal }: { signal?: AbortSignal } = {}) => {
				subscribeCount++;
				const connectionNumber = subscribeCount;
				observed.push(`subscribe-${connectionNumber}`);
				if (connectionNumber === 2) secondSubscribed.resolve();

				return {
					stream: (async function* () {
						try {
							yield { type: "server.connected" };
							await new Promise<void>((resolve) => {
								if (signal?.aborted) {
									resolve();
									return;
								}
								signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
							});
						} finally {
							if (connectionNumber === 1) {
								observed.push("first-cleanup-started");
								firstCleanupStarted.resolve();
								await releaseFirstCleanup.promise;
								observed.push("first-cleanup-finished");
								firstCleanupFinished.resolve();
							}
						}
					})(),
				};
			},
		);

		const stream = new SSEStream({ api });
		const connected = deferred();
		stream.on("connected", () => connected.resolve());

		await connect(stream);
		await withTimeout(connected.promise, "initial connection");

		const activeAbort = new AbortController();
		const activeDisconnect = Effect.runPromise(stream.disconnectEffect(), {
			signal: activeAbort.signal,
		}).then(
			() => "completed" as const,
			() => "interrupted" as const,
		);
		let queuedConnect: Promise<void> | undefined;
		let assertionFailure: unknown;

		try {
			await withTimeout(firstCleanupStarted.promise, "first cleanup to start");
			queuedConnect = connect(stream);

			// Give any already-runnable Promise continuation one event-loop turn.
			// This is not a timing allowance: microtasks must run before this timer,
			// so an entry released before interruption cannot hide on a loaded host.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(api.event.subscribe).toHaveBeenCalledTimes(1);

			observed.push("active-interruption-sent");
			activeAbort.abort();
			expect(
				await withTimeout(activeDisconnect, "active disconnect interruption"),
			).toBe("interrupted");

			// Fiber.interrupt sends interruption to the child and then awaits its
			// exit. Interrupting this parent wait releases the lifecycle entry while
			// the child's async-generator finalizer is still draining. That overlap
			// predates the c4z canceler; the invariant is that interruption advances
			// the queue, not that generator cleanup and the next subscribe never overlap.
			await withTimeout(
				secondSubscribed.promise,
				"queued connect after active interruption",
			);
			expect(observed).toEqual([
				"subscribe-1",
				"first-cleanup-started",
				"active-interruption-sent",
				"subscribe-2",
			]);
		} catch (error) {
			assertionFailure = error;
		} finally {
			activeAbort.abort();
			releaseFirstCleanup.resolve();
			await withTimeout(
				firstCleanupFinished.promise,
				"first cleanup to finish",
			);
			await withTimeout(activeDisconnect, "active disconnect to settle");
			if (queuedConnect) {
				await withTimeout(queuedConnect, "queued connect to finish");
			}
			await withTimeout(drain(stream), "final lifecycle drain");
		}

		if (assertionFailure) throw assertionFailure;
	});
});

// ─── Reconnection ownership (n2x) ────────────────────────────────────────────

describe("SSEStream reconnection", () => {
	const streams: SSEStream[] = [];

	function track(stream: SSEStream): SSEStream {
		streams.push(stream);
		return stream;
	}

	afterEach(async () => {
		await Promise.all(streams.splice(0).map((s) => disconnect(s)));
	});

	function failingApi() {
		return {
			event: {
				subscribe: vi.fn(async () => {
					throw new Error("connection refused");
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
	}

	async function waitFor(
		predicate: () => boolean,
		label: string,
		ms: number,
	): Promise<void> {
		const deadline = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for ${label}`);
			}
			await new Promise((r) => setTimeout(r, 5));
		}
	}

	it("T1: never gives up reconnecting against a dead server", async () => {
		const api = failingApi();
		const stream = track(new SSEStream({ api, baseDelay: 1, maxDelay: 2 }));
		await connect(stream);
		await waitFor(
			() => api.event.subscribe.mock.calls.length >= 25,
			"25 subscribe attempts",
			1000,
		);
		expect(api.event.subscribe.mock.calls.length).toBeGreaterThanOrEqual(25);
	});

	it("publishes an advancing reconnect count within one lifecycle", async () => {
		const api = failingApi();
		const stream = new SSEStream({ api, baseDelay: 1, maxDelay: 2 });
		const thirdReconnect = deferred();
		const publishedCounts: number[] = [];
		stream.on("reconnecting", () => {
			publishedCounts.push(stream.getHealth().reconnectCount);
			if (publishedCounts.length === 3) thirdReconnect.resolve();
		});

		try {
			await connect(stream);
			await withTimeout(thirdReconnect.promise, "third reconnect", 5_000);
			expect(publishedCounts.slice(0, 3)).toEqual([1, 2, 3]);
		} finally {
			await drain(stream);
		}
	});

	it("T2: reconnect delays follow the jittered backoff curve and plateau at maxDelay", async () => {
		const cfg = { baseDelay: 2, maxDelay: 32, multiplier: 2 };
		const api = failingApi();
		const stream = track(
			new SSEStream({ api, baseDelay: cfg.baseDelay, maxDelay: cfg.maxDelay }),
		);
		const payloads: Array<{ attempt: number; delay: number }> = [];
		stream.on("reconnecting", (info) => payloads.push(info));
		await connect(stream);
		await waitFor(
			() => payloads.length >= 10,
			"10 reconnecting payloads",
			2000,
		);

		const observed = payloads.slice(0, 10);
		observed.forEach((info, i) => {
			const nominal = calculateBackoffDelay(i, cfg);
			expect(info.attempt).toBe(i + 1);
			expect(info.delay).toBeGreaterThanOrEqual(0.8 * nominal);
			expect(info.delay).toBeLessThanOrEqual(1.2 * nominal);
		});
		// From attempt 5 on (2 * 2^4 = 32) the nominal delay is capped at maxDelay.
		for (const info of observed.slice(4)) {
			expect(info.delay).toBeGreaterThanOrEqual(0.8 * cfg.maxDelay);
			expect(info.delay).toBeLessThanOrEqual(1.2 * cfg.maxDelay);
		}
	});

	it("T3: does not reset backoff on accept-then-drop", async () => {
		const api = {
			event: {
				subscribe: vi.fn(async () => ({
					stream: (async function* () {
						// Accept the connection (first frame), then drop immediately.
						yield { type: "server.connected" };
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const cfg = { baseDelay: 2, maxDelay: 64, multiplier: 2 };
		const stream = track(
			new SSEStream({ api, baseDelay: cfg.baseDelay, maxDelay: cfg.maxDelay }),
		);
		const payloads: Array<{ attempt: number; delay: number }> = [];
		stream.on("reconnecting", (info) => payloads.push(info));
		await connect(stream);
		await waitFor(() => payloads.length >= 6, "6 reconnecting payloads", 2000);

		// Every connection succeeds then drops instantly, so the backoff must
		// keep growing — a reset here would hammer the server once per baseDelay.
		payloads.slice(0, 6).forEach((info, i) => {
			const nominal = calculateBackoffDelay(i, cfg);
			expect(info.attempt).toBe(i + 1);
			expect(info.delay).toBeGreaterThanOrEqual(0.8 * nominal);
			expect(info.delay).toBeLessThanOrEqual(1.2 * nominal);
		});
	});

	it("T4: resets backoff after a healthy connection", async () => {
		const releaseThird = deferred();
		let subscribeCount = 0;
		const api = {
			event: {
				subscribe: vi.fn(async () => {
					subscribeCount++;
					if (subscribeCount < 3) throw new Error("connection refused");
					const holdOpen = subscribeCount === 3;
					return {
						stream: (async function* () {
							yield { type: "server.heartbeat" };
							if (holdOpen) await releaseThird.promise;
						})(),
					};
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const cfg = { baseDelay: 5, maxDelay: 40, multiplier: 2 };
		const stream = track(
			new SSEStream({ api, baseDelay: cfg.baseDelay, maxDelay: cfg.maxDelay }),
		);
		const payloads: Array<{ attempt: number; delay: number }> = [];
		stream.on("reconnecting", (info) => payloads.push(info));
		await connect(stream);

		// Two failures, then the third connection is held open past maxDelay.
		await waitFor(() => subscribeCount === 3, "third connection", 2000);
		await new Promise((r) => setTimeout(r, cfg.maxDelay * 2));
		const priorPayloads = payloads.length;
		releaseThird.resolve();

		await waitFor(
			() => payloads.length > priorPayloads,
			"reconnecting after healthy connection",
			2000,
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — waitFor guarantees the index exists
		const next = payloads[priorPayloads]!;
		expect(next.attempt).toBe(1);
		expect(next.delay).toBeGreaterThanOrEqual(0.8 * cfg.baseDelay);
		expect(next.delay).toBeLessThanOrEqual(1.2 * cfg.baseDelay);
	});

	it("T5: tears down and reconnects a stale connection", async () => {
		let subscribeCount = 0;
		const disconnects: Array<Error | undefined> = [];
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => {
					subscribeCount++;
					return {
						stream: (async function* () {
							yield { type: "message.part.updated", properties: {} };
							// Half-open socket: no more events, no error — only the
							// watchdog's abort ends the stream (as the SDK's reader
							// cancel does in production).
							await new Promise<void>((resolve) => {
								if (signal?.aborted) return resolve();
								signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
							});
						})(),
					};
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(
			new SSEStream({ api, baseDelay: 1, maxDelay: 4, staleThreshold: 30 }),
		);
		stream.on("disconnected", (err) => disconnects.push(err));
		await connect(stream);
		await waitFor(
			() => subscribeCount >= 2,
			"a second subscribe after staleness",
			2000,
		);
		// The stale teardown must report an error, not a silent clean stop.
		expect(disconnects[0]).toBeInstanceOf(Error);
		expect(String(disconnects[0])).toMatch(/stale/i);
	});

	it("T6: a throwing listener cannot kill the stream", async () => {
		const api = failingApi();
		const stream = track(new SSEStream({ api, baseDelay: 1, maxDelay: 2 }));
		stream.on("reconnecting", () => {
			throw new Error("listener boom");
		});
		await connect(stream);
		await waitFor(
			() => api.event.subscribe.mock.calls.length >= 3,
			"reconnect attempts despite a throwing listener",
			1000,
		);
	});

	it("R4 (F6): a throwing logger cannot kill the stream", async () => {
		// EPIPE / destroyed-stream at shutdown: every logger call throws.
		const boomLog = {
			...createSilentLogger(),
			debug: () => {
				throw new Error("EPIPE");
			},
			warn: () => {
				throw new Error("EPIPE");
			},
		};
		const api = failingApi();
		const stream = track(
			new SSEStream({ api, baseDelay: 1, maxDelay: 2, log: boomLog }),
		);
		stream.on("reconnecting", () => {
			throw new Error("listener boom");
		});
		await connect(stream);
		await waitFor(
			() => api.event.subscribe.mock.calls.length >= 3,
			"reconnect attempts despite a throwing logger",
			1000,
		);
	});

	it("T7: does not notify 'reconnecting' on graceful shutdown", async () => {
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => ({
					stream: (async function* () {
						yield { type: "server.connected" };
						await new Promise<void>((resolve) => {
							if (signal?.aborted) return resolve();
							signal?.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(new SSEStream({ api, baseDelay: 1, maxDelay: 2 }));
		const reconnects: unknown[] = [];
		stream.on("reconnecting", (info) => reconnects.push(info));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await connected;
		await disconnect(stream);
		await new Promise((r) => setTimeout(r, 20));
		expect(reconnects).toHaveLength(0);
	});

	it("R1 (F1): reports connected only when the stream yields its first frame", async () => {
		const releaseFirstFrame = deferred();
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => ({
					stream: (async function* () {
						const aborted = new Promise<void>((resolve) => {
							if (signal?.aborted) return resolve();
							signal?.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
						// Like the real SDK, an abort cancels the pending read.
						await Promise.race([releaseFirstFrame.promise, aborted]);
						if (signal?.aborted) return;
						yield { type: "server.connected" };
						await aborted;
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(new SSEStream({ api, baseDelay: 1, maxDelay: 2 }));
		let connectedCount = 0;
		stream.on("connected", () => connectedCount++);
		await connect(stream);

		// subscribe() resolving does no network I/O — the SDK issues the fetch
		// on the first next(). No first frame means no "connected".
		await new Promise((r) => setTimeout(r, 30));
		expect(connectedCount).toBe(0);
		expect(stream.isConnected()).toBe(false);

		releaseFirstFrame.resolve();
		await waitFor(
			() => connectedCount === 1,
			"connected after first frame",
			1000,
		);
		expect(stream.isConnected()).toBe(true);
	});

	it("R2 (F2): stale teardown does not reset the backoff", async () => {
		// staleThreshold >= maxDelay mirrors the default config (30s / 30s):
		// a stale connection's uptime always exceeds the healthy-reset
		// threshold, so without an explicit guard every stale cycle resets.
		const api = {
			event: {
				subscribe: vi.fn(async ({ signal }: { signal?: AbortSignal } = {}) => ({
					stream: (async function* () {
						yield { type: "server.connected" };
						await new Promise<void>((resolve) => {
							if (signal?.aborted) return resolve();
							signal?.addEventListener("abort", () => resolve(), {
								once: true,
							});
						});
					})(),
				})),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(
			new SSEStream({ api, baseDelay: 5, maxDelay: 30, staleThreshold: 40 }),
		);
		const payloads: Array<{ attempt: number; delay: number }> = [];
		stream.on("reconnecting", (info) => payloads.push(info));
		await connect(stream);
		await waitFor(
			() => payloads.length >= 3,
			"3 stale-teardown reconnects",
			2000,
		);
		payloads.slice(0, 3).forEach((info, i) => {
			expect(info.attempt).toBe(i + 1);
		});
	});

	it("R3 (F3/F7): surfaces the SDK's onSseError as disconnected(error) and error(error)", async () => {
		const transportError = new Error("ECONNRESET: transport failed");
		const api = {
			event: {
				subscribe: vi.fn(
					async ({
						onSseError,
					}: {
						onSseError?: (e: unknown) => void;
					} = {}) => ({
						stream: (async function* () {
							yield { type: "server.connected" };
							// Faithful SDK shape: with sseMaxRetryAttempts: 1 the SDK
							// fires onSseError, then ends the generator normally —
							// it never throws out of the stream.
							onSseError?.(transportError);
						})(),
					}),
				),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(new SSEStream({ api, baseDelay: 1, maxDelay: 2 }));
		const disconnects: Array<Error | undefined> = [];
		const errors: Error[] = [];
		stream.on("disconnected", (err) => disconnects.push(err));
		stream.on("error", (err) => errors.push(err));
		await connect(stream);

		await waitFor(() => disconnects.length >= 1, "disconnected callback", 1000);
		// The transport error, not the clean-EOF sentinel.
		expect(disconnects[0]).toBe(transportError);
		await waitFor(() => errors.length >= 1, "error callback", 1000);
		expect(errors[0]).toBe(transportError);
	});

	it("R5 (R2-3): reconnect attempt spacing matches the reported delays", async () => {
		const subscribeTimes: number[] = [];
		const api = {
			event: {
				subscribe: vi.fn(async () => {
					subscribeTimes.push(Date.now());
					throw new Error("connection refused");
				}),
			},
			// biome-ignore lint/suspicious/noExplicitAny: lightweight mock for unit test
		} as any;
		const stream = track(new SSEStream({ api, baseDelay: 15, maxDelay: 60 }));
		const payloads: Array<{ attempt: number; delay: number }> = [];
		stream.on("reconnecting", (info) => payloads.push(info));
		await connect(stream);
		await waitFor(
			() => subscribeTimes.length >= 5,
			"5 subscribe attempts",
			2000,
		);

		// The delay reported after attempt i must be the time actually slept
		// before attempt i+1 — otherwise a dead server gets hammered in a hot
		// loop while the payload claims backoff. Lower bound is the guard;
		// upper bound is generous for load.
		for (let i = 0; i < 4; i++) {
			// biome-ignore lint/style/noNonNullAssertion: safe — waitFor guarantees 5 entries
			const spacing = subscribeTimes[i + 1]! - subscribeTimes[i]!;
			// biome-ignore lint/style/noNonNullAssertion: safe — one payload precedes each retry
			const reported = payloads[i]!.delay;
			expect(spacing).toBeGreaterThanOrEqual(reported - 3);
			expect(spacing).toBeLessThanOrEqual(reported + 250);
		}
	});

	it("T8: disables the SDK's internal SSE retry loop", async () => {
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = track(new SSEStream({ api }));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		await connect(stream);
		await connected;
		expect(api.event.subscribe).toHaveBeenCalledWith(
			expect.objectContaining({
				sseMaxRetryAttempts: 1,
				onSseError: expect.any(Function),
			}),
		);
	});
});
