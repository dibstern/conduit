import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SSEStream } from "../../../src/lib/relay/sse-stream.js";

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
		const api = makeStubApi([]);
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
		const health = stream.getHealth();
		expect(health).toHaveProperty("connected");
		expect(health).toHaveProperty("lastEventAt");
		expect(health).toHaveProperty("reconnectCount");
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
		const api = makeStubApi([]);
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
		const api = makeStubApi([]);
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
		const api = makeStubApi([]);
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
							await new Promise<void>((resolve) => {
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
});
