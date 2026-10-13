// Tests for the shared two-socket RPC client, at two depths.
//
// `describe("… in memory")` is ni8.5 seam 1: it supplies its own `WsRpcConnect`
// built on `RpcClient.makeNoSerialization`, so it observes exactly what this
// module owns — how many transports exist, which traffic class a caller's
// request left on, and when they are closed. Encoding is out of scope there by
// construction (that is seam 2, S-13).
//
// `describe("… over WebSockets")` drives the real `WsRpcClientsLayer` against a
// stubbed `globalThis.WebSocket`, because the in-memory seam cannot see whether
// the protocol's socket outlives the call that built the client.

import { RpcClient, type RpcMessage } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schedule, TestClock } from "effect";
import { afterAll, beforeAll, beforeEach, expect, vi } from "vitest";
import { connectionState } from "../../../../src/lib/frontend/transport/connection-status.svelte.js";
import {
	disposeRuntime,
	runTransportEffect,
} from "../../../../src/lib/frontend/transport/runtime.js";
import {
	makeWsRpcClientsLayer,
	makeWsRpcUrl,
	type TrafficClass,
	WsRpcClients,
	WsRpcClientsLayer,
	type WsRpcConnect,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import { WsRpcGroup } from "../../../../src/lib/frontend/transport/ws-rpc.js";

/** Marks the stub response so a completed call is distinguishable from a hang. */
const STUB = "shared-client-test-stub";

// The url is derived from the page location; this suite runs under node.
beforeAll(() => {
	Object.defineProperty(globalThis, "location", {
		value: { protocol: "http:", host: "localhost:2633" },
		configurable: true,
	});
});

interface Transport {
	readonly url: string;
	readonly trafficClass: TrafficClass;
	/** RPC tags this transport carried, in order. */
	readonly tags: Array<string>;
	closed: boolean;
}

/**
 * An in-memory `WsRpcConnect` that records every transport it opens, the
 * requests each carried, and whether it was closed. Every request is answered
 * with a defect so calls terminate instead of hanging.
 */
const recordingConnect = () => {
	const transports: Array<Transport> = [];

	const connect: WsRpcConnect = ({ url, trafficClass }) =>
		Effect.gen(function* () {
			const transport: Transport = {
				url,
				trafficClass,
				tags: [],
				closed: false,
			};
			transports.push(transport);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					transport.closed = true;
				}),
			);

			let respond:
				| ((requestId: RpcMessage.RequestId) => Effect.Effect<void>)
				| undefined;
			const built = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
				onFromClient: ({ message }) =>
					message._tag === "Request"
						? Effect.suspend(() => {
								transport.tags.push(message.tag);
								return respond?.(message.id) ?? Effect.void;
							})
						: Effect.void,
			});
			respond = (requestId) =>
				built.write({
					_tag: "Exit",
					clientId: 0,
					requestId,
					exit: Exit.die(STUB),
				});
			return built.client;
		});

	return { transports, connect };
};

const withClients = <A>(
	connect: WsRpcConnect,
	use: (clients: WsRpcClients["Type"]) => Effect.Effect<A>,
) =>
	Effect.scoped(
		Effect.flatMap(WsRpcClients, use).pipe(
			Effect.provide(makeWsRpcClientsLayer(connect)),
		),
	);

describe("shared two-socket RPC client in memory", () => {
	it.effect(
		"opens one transport per traffic class, both at the daemon RPC url",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();

				yield* withClients(connect, (clients) => clients.forProject("alpha"));

				expect(transports.map((t) => t.trafficClass)).toEqual([
					"control",
					"stream",
				]);
				expect(transports.map((t) => t.url)).toEqual([
					makeWsRpcUrl(),
					makeWsRpcUrl(),
				]);
			}),
	);

	it.effect("sends a request over the transport its caller selected", () =>
		Effect.gen(function* () {
			const { transports, connect } = recordingConnect();

			yield* withClients(connect, (clients) =>
				Effect.gen(function* () {
					const sockets = yield* clients.forProject("alpha");
					yield* Effect.exit(
						sockets.stream.SetLogLevel({
							projectSlug: "alpha",
							level: "debug",
						}),
					);
					yield* Effect.exit(
						sockets.control.ViewSession({
							projectSlug: "alpha",
							sessionId: "s1",
							originId: "o1",
						}),
					);
				}),
			);

			const [control, stream] = transports;
			expect(control?.tags).toEqual(["ViewSession"]);
			expect(stream?.tags).toEqual(["SetLogLevel"]);
		}),
	);

	it.effect("reuses the open pair for the same project", () =>
		Effect.gen(function* () {
			const { transports, connect } = recordingConnect();

			yield* withClients(connect, (clients) =>
				Effect.gen(function* () {
					const first = yield* clients.forProject("alpha");
					const second = yield* clients.forProject("alpha");
					expect(second.control).toBe(first.control);
					expect(second.stream).toBe(first.stream);
				}),
			);

			expect(transports).toHaveLength(2);
		}),
	);

	// The server routes by payload, so a project switch must not reopen the pair:
	// closing it would fail every in-flight call and flip `connected`, which
	// re-ran ChatLayout's effects into a switch-projects ping-pong.
	it.effect(
		"shares one pair across projects, never closing it on a switch",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();

				yield* withClients(connect, (clients) =>
					Effect.gen(function* () {
						const alpha = yield* clients.forProject("alpha");
						const beta = yield* clients.forProject("beta");
						yield* clients.forProject("alpha");
						expect(beta.control).toBe(alpha.control);
						expect(beta.stream).toBe(alpha.stream);
						expect(transports.filter((t) => t.closed)).toEqual([]);
					}),
				);

				expect(transports).toHaveLength(2);
			}),
	);

	it.effect("leaves the cache empty and nothing open when an open fails", () =>
		Effect.gen(function* () {
			const { transports, connect } = recordingConnect();
			// The control transport opens; the stream transport does not.
			let attempts = 0;
			const halfOpen: WsRpcConnect = (options) =>
				++attempts === 2
					? Effect.die(new Error("stream refused"))
					: connect(options);

			yield* withClients(halfOpen, (clients) =>
				Effect.gen(function* () {
					const failed = yield* Effect.exit(clients.forProject("alpha"));
					expect(Exit.isFailure(failed)).toBe(true);
					expect(transports.filter((t) => !t.closed)).toEqual([]);

					yield* clients.forProject("alpha");
					expect(transports.filter((t) => !t.closed)).toHaveLength(2);
				}),
			);

			expect(transports).toHaveLength(3);
		}),
	);

	it.effect("cancels a slow open and closes its partially acquired pair", () =>
		Effect.gen(function* () {
			const { transports, connect } = recordingConnect();
			const connecting = yield* Deferred.make<void>();
			let attempts = 0;
			const slowConnect: WsRpcConnect = (options) =>
				++attempts === 2
					? Deferred.succeed(connecting, undefined).pipe(
							Effect.zipRight(Effect.never),
						)
					: connect(options);
			yield* withClients(slowConnect, (clients) =>
				Effect.gen(function* () {
					const opening = yield* Effect.fork(clients.forProject("alpha"));
					yield* Deferred.await(connecting);
					expect(Exit.isInterrupted(yield* Fiber.interrupt(opening))).toBe(
						true,
					);
					expect(transports.filter((t) => !t.closed)).toEqual([]);
					yield* clients.forProject("alpha");
					expect(transports.filter((t) => !t.closed)).toHaveLength(2);
				}),
			);
			expect(transports.filter((t) => !t.closed)).toEqual([]);
		}),
	);

	it.effect("closes both transports when the owning runtime scope closes", () =>
		Effect.gen(function* () {
			const { transports, connect } = recordingConnect();

			yield* withClients(connect, (clients) => clients.forProject("alpha"));

			expect(transports.map((t) => t.closed)).toEqual([true, true]);
		}),
	);

	it("is reachable from the app-lifetime transport runtime", async () => {
		const clients = await runTransportEffect(
			Effect.flatMap(WsRpcClients, Effect.succeed),
		);
		expect(typeof clients.forProject).toBe("function");
		await disposeRuntime();
	});
});

const fakeSockets: Array<FakeWebSocket> = [];
let onFrame: () => void = () => {};
let dial: (ws: FakeWebSocket) => void = (ws) => ws.open();

/**
 * The smallest WebSocket `Socket.fromWebSocket` will drive: it reads
 * `readyState`, registers listeners, sends, and closes.
 */
class FakeWebSocket {
	readonly sent: Array<string> = [];
	readyState = 0;
	closeCode: number | undefined;
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(readonly url: string) {
		fakeSockets.push(this);
		queueMicrotask(() => dial(this));
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	addEventListener(type: string, handler: (event: unknown) => void): void {
		const handlers = this.listeners.get(type) ?? new Set();
		handlers.add(handler);
		this.listeners.set(type, handlers);
	}

	removeEventListener(type: string, handler: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(handler);
	}

	send(data: string): void {
		this.sent.push(data);
		onFrame();
	}

	close(code?: number): void {
		this.closeCode = code;
		this.readyState = 3;
		this.emit("close", { code: code ?? 1000, reason: "" });
	}

	emit(type: string, event: unknown): void {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
}

describe("shared two-socket RPC client over WebSockets", () => {
	const realWebSocket = Object.getOwnPropertyDescriptor(
		globalThis,
		"WebSocket",
	);

	beforeAll(() => {
		Object.defineProperty(globalThis, "WebSocket", {
			value: FakeWebSocket,
			configurable: true,
			writable: true,
		});
	});

	afterAll(() => {
		if (realWebSocket) {
			Object.defineProperty(globalThis, "WebSocket", realWebSocket);
		}
	});

	beforeEach(() => {
		fakeSockets.length = 0;
		onFrame = () => {};
		dial = (ws) => ws.open();
	});

	it.effect("carries a request placed after forProject has returned", () =>
		Effect.gen(function* () {
			const frame = yield* Deferred.make<void>();
			onFrame = () => Deferred.unsafeDone(frame, Effect.void);

			const clients = yield* WsRpcClients;
			const { control } = yield* clients.forProject("alpha");

			yield* Effect.forkScoped(
				Effect.exit(
					control.SetLogLevel({ projectSlug: "alpha", level: "debug" }),
				),
			);
			yield* Deferred.await(frame).pipe(
				Effect.timeoutFail({
					duration: "3 seconds",
					onTimeout: () =>
						new Error("no frame reached a socket — the protocol is closed"),
				}),
			);

			expect(fakeSockets.map((ws) => ws.url)).toEqual([
				makeWsRpcUrl(),
				makeWsRpcUrl(),
			]);
			expect(connectionState.status).toBe("connected");
			expect(connectionState.statusText).toBe("Connected");
			expect(connectionState.attempts).toBe(0);
			expect(fakeSockets.map((ws) => ws.closeCode)).toEqual([
				undefined,
				undefined,
			]);
			expect(
				fakeSockets.filter((ws) =>
					ws.sent.some((sent) => sent.includes("SetLogLevel")),
				),
			).toHaveLength(1);
		}).pipe(Effect.provide(WsRpcClientsLayer), Effect.scoped, Effect.orDie),
	);

	// Wake must reach both sockets, ignore hidden tabs and healthy sockets, and
	// work even when a close has not yet entered its retry delay.
	it.scoped.each(["navigation", "visible", "online", "registration"] as const)(
		"%s wakes both socket retries immediately",
		(reason) =>
			Effect.gen(function* () {
				const document = Object.assign(new EventTarget(), {
					visibilityState: "hidden",
				});
				const window = new EventTarget();
				vi.stubGlobal("document", document);
				vi.stubGlobal("window", window);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => vi.unstubAllGlobals()),
				);
				yield* Effect.gen(function* () {
					const opened = yield* Deferred.make<void>();
					const redialed = yield* Deferred.make<void>();
					onFrame = () => {
						if (
							fakeSockets.length === 2 &&
							fakeSockets.every((socket) =>
								socket.sent.some((frame) => frame.includes("SetLogLevel")),
							)
						)
							Deferred.unsafeDone(opened, Effect.void);
					};
					dial = (socket) => {
						socket.open();
						if (fakeSockets.length === 4)
							Deferred.unsafeDone(redialed, Effect.void);
					};
					const clients = yield* WsRpcClients;
					const { control, stream } = yield* clients.forProject("alpha");
					// A raw open precedes the protocol installing its close listener.
					// Wait for real requests on both transports before dropping them.
					yield* Effect.forkScoped(
						Effect.all(
							[
								control.SetLogLevel({ projectSlug: "alpha", level: "debug" }),
								stream.SetLogLevel({ projectSlug: "alpha", level: "debug" }),
							],
							{ concurrency: 2 },
						).pipe(Effect.ignore),
					);
					yield* Deferred.await(opened);
					expect(fakeSockets).toHaveLength(2);
					yield* clients.wake;
					expect(fakeSockets).toHaveLength(2);
					if (reason === "registration") {
						let armed = true;
						const add = EventTarget.prototype.addEventListener;
						const registration = vi
							.spyOn(EventTarget.prototype, "addEventListener")
							.mockImplementation(function (
								this: EventTarget,
								type,
								listener,
								options,
							) {
								if (type === "wake" && armed) {
									armed = false;
									// Deliver a real wake after the version check, before
									// the waiting child registers its listener.
									Effect.runSync(clients.wake);
								}
								add.call(this, type, listener, options);
							});
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => registration.mockRestore()),
						);
					}
					if (reason === "visible") {
						// WebSocket.close starts CLOSING now and emits close later.
						// The existing visibility listener can initiate that close.
						for (const socket of fakeSockets) socket.readyState = 2;
					} else {
						for (const socket of fakeSockets) socket.close(1006);
					}
					yield* Effect.yieldNow();
					document.dispatchEvent(new Event("visibilitychange"));
					yield* Effect.yieldNow();
					expect(fakeSockets).toHaveLength(2);
					if (reason === "navigation") yield* clients.wake;
					else if (reason === "online")
						window.dispatchEvent(new Event("online"));
					else if (reason === "visible") {
						document.visibilityState = "visible";
						document.dispatchEvent(new Event("visibilitychange"));
						for (const socket of fakeSockets) socket.close(1006);
					}
					yield* Deferred.await(redialed);
					expect(fakeSockets).toHaveLength(4);
					// Ordinary retries still wait; a wake must not leave a latched signal.
					for (const socket of fakeSockets.slice(2)) socket.close(1006);
					yield* Effect.yieldNow();
					expect(fakeSockets).toHaveLength(4);
					yield* TestClock.adjust("1 second");
					expect(fakeSockets).toHaveLength(6);
				}).pipe(Effect.provide(WsRpcClientsLayer));
			}),
	);

	// Live clock: the protocol's redial waits on a real schedule.
	it.live(
		"carries the first request placed once a redialled control socket reports connected",
		() =>
			Effect.gen(function* () {
				const until = (done: () => boolean) =>
					Effect.sync(done).pipe(
						Effect.repeat({
							until: (finished) => finished,
							schedule: Schedule.spaced("1 millis"),
						}),
						Effect.timeoutFail({
							duration: "3 seconds",
							onTimeout: () => new Error("condition never held"),
						}),
					);
				const clients = yield* WsRpcClients;
				const { control } = yield* clients.forProject("alpha");
				yield* until(() => connectionState.status === "connected");

				// The app reads as soon as it sees `connected` (ChatLayout loads the
				// file tree), so place the request at the first moment that holds:
				// right after the redialled socket opens, or on a later poll.
				const outcome = yield* Deferred.make<string>();
				let placed = false;
				const placeIfConnected = () => {
					if (placed || connectionState.status !== "connected") return placed;
					placed = true;
					Effect.runFork(
						control
							.SetLogLevel({ projectSlug: "alpha", level: "debug" })
							.pipe(
								Effect.catchAll((error) =>
									Deferred.succeed(outcome, String(error)),
								),
							),
					);
					return placed;
				};
				onFrame = () => {
					if (
						fakeSockets.some((ws) =>
							ws.sent.some((frame) => frame.includes("SetLogLevel")),
						)
					)
						Deferred.unsafeDone(outcome, Effect.succeed("sent"));
				};
				dial = (ws) => {
					ws.open();
					placeIfConnected();
				};

				// The daemon restarts: both sockets drop and redial.
				for (const ws of fakeSockets) ws.close(1006);
				yield* until(placeIfConnected);

				expect(
					yield* Deferred.await(outcome).pipe(
						Effect.timeoutFail({
							duration: "3 seconds",
							onTimeout: () => new Error("the request neither sent nor failed"),
						}),
					),
				).toBe("sent");
			}).pipe(Effect.provide(WsRpcClientsLayer), Effect.scoped, Effect.orDie),
	);
});
