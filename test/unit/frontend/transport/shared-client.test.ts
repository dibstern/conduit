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
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	ManagedRuntime,
	RuntimeFlags,
	RuntimeFlagsPatch,
	Scope,
	Supervisor,
} from "effect";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
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
		"opens one transport per traffic class, both at the project RPC url",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();

				yield* withClients(connect, (clients) => clients.forProject("alpha"));

				expect(transports.map((t) => t.trafficClass)).toEqual([
					"control",
					"stream",
				]);
				expect(transports.map((t) => t.url)).toEqual([
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("alpha"),
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

	it.effect(
		"replaces the pair when the project changes, holding the ceiling at two",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();

				yield* withClients(connect, (clients) =>
					Effect.gen(function* () {
						yield* clients.forProject("alpha");
						yield* clients.forProject("beta");
						expect(transports.filter((t) => !t.closed)).toHaveLength(2);
					}),
				);

				expect(transports.map((t) => t.url)).toEqual([
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("beta"),
					makeWsRpcUrl("beta"),
				]);
			}),
	);

	it.effect(
		"drops the cache and the half-open pair when a replacement fails",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();
				// beta's control transport opens; its stream transport does not.
				const halfOpen: WsRpcConnect = (options) =>
					options.trafficClass === "stream" &&
					options.url === makeWsRpcUrl("beta")
						? Effect.die(new Error("beta stream refused"))
						: connect(options);

				yield* withClients(halfOpen, (clients) =>
					Effect.gen(function* () {
						const alpha = yield* clients.forProject("alpha");

						const failed = yield* Effect.exit(clients.forProject("beta"));
						expect(Exit.isFailure(failed)).toBe(true);

						// Nothing the failed attempt opened is still running: not the
						// alpha pair it displaced, and not beta's half of a pair.
						expect(transports.filter((t) => !t.closed)).toEqual([]);

						// And the cache does not hand the closed alpha pair back.
						const reopened = yield* clients.forProject("alpha");
						expect(reopened.control).not.toBe(alpha.control);
						expect(transports.filter((t) => !t.closed)).toHaveLength(2);
					}),
				);

				expect(transports.map((t) => t.url)).toEqual([
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("beta"),
					makeWsRpcUrl("alpha"),
					makeWsRpcUrl("alpha"),
				]);
			}),
	);

	it.effect(
		"finishes closing the old pair when replacement is interrupted",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();
				const closing = yield* Deferred.make<void>();
				const releaseClose = yield* Deferred.make<void>();
				const slowClose: WsRpcConnect = (options) =>
					Effect.gen(function* () {
						const client = yield* connect(options);
						if (
							options.url === makeWsRpcUrl("alpha") &&
							options.trafficClass === "stream"
						) {
							// Registered last, so this pauses Scope.close before either
							// transport finalizer runs, after the scope is marked closed.
							yield* Scope.addFinalizer(
								yield* Effect.scope,
								Deferred.succeed(closing, undefined).pipe(
									Effect.zipRight(Deferred.await(releaseClose)),
								),
							);
						}
						return client;
					});
				const runtime = ManagedRuntime.make(makeWsRpcClientsLayer(slowClose));
				const clients = yield* Effect.promise(() =>
					runtime.runPromise(WsRpcClients),
				);
				let openAfterGamma = 0;
				yield* Effect.gen(function* () {
					yield* clients.forProject("alpha");
					const replacement = yield* Effect.fork(clients.forProject("beta"));
					yield* Deferred.await(closing);
					yield* Fiber.interruptFork(replacement);
					yield* Deferred.succeed(releaseClose, undefined);
					expect(Exit.isInterrupted(yield* Fiber.await(replacement))).toBe(
						true,
					);
					yield* clients.forProject("gamma");
					openAfterGamma = transports.filter((t) => !t.closed).length;
				}).pipe(Effect.ensuring(runtime.disposeEffect));
				expect(transports.filter((t) => !t.closed)).toEqual([]);
				expect(openAfterGamma).toBe(2);
			}),
	);

	it.effect(
		"does not leak a replacement interrupted between acquisition and publication",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();
				const acquired = yield* Deferred.make<void>();
				const releaseConnect = yield* Deferred.make<void>();
				const gatedConnect: WsRpcConnect = (options) =>
					Effect.gen(function* () {
						const client = yield* connect(options);
						if (
							options.url === makeWsRpcUrl("beta") &&
							options.trafficClass === "stream"
						) {
							yield* Deferred.succeed(acquired, undefined);
							yield* Deferred.await(releaseConnect);
						}
						return client;
					});
				// Cancelling at the Deferred alone would still be inside connect,
				// which the old onError already covered. Observe open's successful
				// result to interrupt precisely before the cache can publish it.
				class InterruptAcquiredPair extends Supervisor.AbstractSupervisor<void> {
					readonly value = Effect.void;
					triggered = false;
					override onEffect<A, E>(
						fiber: Fiber.RuntimeFiber<A, E>,
						effect: Effect.Effect<unknown, unknown, unknown>,
					): void {
						if (
							this.triggered ||
							!Exit.isExit(effect) ||
							!Exit.isSuccess(effect)
						)
							return;
						const value = effect.value;
						if (
							typeof value === "object" &&
							value !== null &&
							"projectSlug" in value &&
							value.projectSlug === "beta" &&
							"sockets" in value
						) {
							this.triggered = true;
							fiber.unsafeInterruptAsFork(fiber.id());
						}
					}
				}
				const supervisor = new InterruptAcquiredPair();
				const runtime = ManagedRuntime.make(
					makeWsRpcClientsLayer(gatedConnect),
				);
				const clients = yield* Effect.promise(() =>
					runtime.runPromise(WsRpcClients),
				);
				let openAfterGamma = 0;
				yield* Effect.gen(function* () {
					yield* clients.forProject("alpha");
					const replacement = yield* clients
						.forProject("beta")
						.pipe(
							Effect.supervised(supervisor),
							Effect.withRuntimeFlagsPatch(
								RuntimeFlagsPatch.enable(RuntimeFlags.OpSupervision),
							),
							Effect.fork,
						);
					yield* Deferred.await(acquired);
					expect(transports.filter((t) => !t.closed).map((t) => t.url)).toEqual(
						[makeWsRpcUrl("beta"), makeWsRpcUrl("beta")],
					);
					yield* Deferred.succeed(releaseConnect, undefined);
					expect(Exit.isInterrupted(yield* Fiber.await(replacement))).toBe(
						true,
					);
					expect(supervisor.triggered).toBe(true);
					yield* clients.forProject("gamma");
					openAfterGamma = transports.filter((t) => !t.closed).length;
				}).pipe(Effect.ensuring(runtime.disposeEffect));
				expect(transports.filter((t) => !t.closed)).toEqual([]);
				expect(openAfterGamma).toBe(2);
			}),
	);

	it.effect(
		"cancels a slow replacement and closes its partially acquired pair",
		() =>
			Effect.gen(function* () {
				const { transports, connect } = recordingConnect();
				const connecting = yield* Deferred.make<void>();
				const slowConnect: WsRpcConnect = (options) =>
					options.url === makeWsRpcUrl("beta") &&
					options.trafficClass === "stream"
						? Deferred.succeed(connecting, undefined).pipe(
								Effect.zipRight(Effect.never),
							)
						: connect(options);
				yield* withClients(slowConnect, (clients) =>
					Effect.gen(function* () {
						const alpha = yield* clients.forProject("alpha");
						const replacement = yield* Effect.fork(clients.forProject("beta"));
						yield* Deferred.await(connecting);
						expect(
							Exit.isInterrupted(yield* Fiber.interrupt(replacement)),
						).toBe(true);
						expect(transports.filter((t) => !t.closed)).toEqual([]);
						const reopened = yield* clients.forProject("alpha");
						expect(reopened.control).not.toBe(alpha.control);
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

/**
 * The smallest WebSocket `Socket.fromWebSocket` will drive: it reads
 * `readyState`, registers listeners, sends, and closes. Opening synchronously
 * (`readyState === 1`) skips the platform's wait for the `open` event.
 */
class FakeWebSocket {
	readonly sent: Array<string> = [];
	readyState = 1;
	closeCode: number | undefined;
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(readonly url: string) {
		fakeSockets.push(this);
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
				makeWsRpcUrl("alpha"),
				makeWsRpcUrl("alpha"),
			]);
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
});
