import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Scope } from "effect";
import { expect, vi } from "vitest";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";
import { AuthManagerTag } from "../../../src/lib/effect/auth-middleware.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/effect/daemon-config-ref.js";
import { HttpServerRefTag } from "../../../src/lib/effect/relay-factory-layer.js";
import {
	type WebSocketRelay,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
	WebSocketUpgradeError,
} from "../../../src/lib/effect/ws-routing-layer.js";

type TestSocket = Socket & {
	destroyed: boolean;
	writable: boolean;
	write: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};

const makeSocket = (): TestSocket => {
	const socket = {
		destroyed: false,
		writable: true,
		write: vi.fn(),
		destroy: vi.fn(function (this: { destroyed: boolean }) {
			this.destroyed = true;
			return this;
		}),
	} as unknown as TestSocket;
	return socket;
};

const makeRequest = (
	path: string,
	headers: IncomingMessage["headers"] = {},
): IncomingMessage =>
	({
		url: path,
		headers,
		socket: { remoteAddress: "127.0.0.1" },
	}) as IncomingMessage;

const makeLayer = (
	server: Server,
	options?: {
		auth?: AuthManager;
		relay?: WebSocketRelay;
		ensureRelayStarted?: ReturnType<typeof vi.fn>;
		touchLastUsed?: ReturnType<typeof vi.fn>;
		waitForRelay?: (
			slug: string,
			timeoutMs: number,
		) => Effect.Effect<WebSocketRelay, WebSocketUpgradeError>;
		shuttingDown?: boolean;
	},
) => {
	const relay =
		options?.relay ??
		({
			wsHandler: { handleUpgrade: vi.fn() },
		} satisfies WebSocketRelay);
	const ensureRelayStarted = options?.ensureRelayStarted ?? vi.fn();
	const touchLastUsed = options?.touchLastUsed ?? vi.fn();
	const waitForRelay =
		options?.waitForRelay ?? ((_: string, __: number) => Effect.succeed(relay));

	return WebSocketRoutingLive.pipe(
		Layer.provide(
			Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
		),
		Layer.provide(
			DaemonConfigRefLive({
				...makeDaemonConfigFromOptions({ port: 2633 }),
				shuttingDown: options?.shuttingDown ?? false,
			}),
		),
		Layer.provide(
			Layer.succeed(
				AuthManagerTag,
				options?.auth ?? new AuthManager({ getPinHash: () => null }),
			),
		),
		Layer.provide(
			Layer.succeed(WebSocketRelayRouterTag, {
				ensureRelayStarted: (slug) =>
					Effect.sync(() => ensureRelayStarted(slug)),
				waitForRelay,
				touchLastUsed: (slug) => Effect.sync(() => touchLastUsed(slug)),
			}),
		),
	);
};

const waitForAssertion = (assertion: () => void) =>
	Effect.tryPromise({
		try: () => vi.waitFor(assertion),
		catch: (cause) => cause,
	});

describe("WebSocketRoutingLive", () => {
	it.scoped("routes project websocket upgrades through the relay", () =>
		Effect.gen(function* () {
			const server = createServer();
			const relay = {
				wsHandler: { handleUpgrade: vi.fn() },
			} satisfies WebSocketRelay;
			const ensureRelayStarted = vi.fn();
			const touchLastUsed = vi.fn();
			const layer = makeLayer(server, {
				relay,
				ensureRelayStarted,
				touchLastUsed,
			});

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				const req = makeRequest("/p/test-project/ws");
				server.emit("upgrade", req, socket, Buffer.alloc(0));

				yield* waitForAssertion(() => {
					expect(ensureRelayStarted).toHaveBeenCalledWith("test-project");
					expect(touchLastUsed).toHaveBeenCalledWith("test-project");
					expect(relay.wsHandler.handleUpgrade).toHaveBeenCalledWith(
						req,
						socket,
						expect.any(Buffer),
					);
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.scoped("destroys sockets for non-project websocket paths", () =>
		Effect.gen(function* () {
			const server = createServer();
			const relay = {
				wsHandler: { handleUpgrade: vi.fn() },
			} satisfies WebSocketRelay;
			const layer = makeLayer(server, { relay });

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit(
					"upgrade",
					makeRequest("/invalid"),
					socket,
					Buffer.alloc(0),
				);

				yield* waitForAssertion(() => {
					expect(socket.destroy).toHaveBeenCalled();
					expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.scoped(
		"rejects unauthenticated websocket upgrades before relay startup",
		() =>
			Effect.gen(function* () {
				const server = createServer();
				const ensureRelayStarted = vi.fn();
				const auth = new AuthManager({
					getPinHash: () => hashPin("1234"),
				});
				const relay = {
					wsHandler: { handleUpgrade: vi.fn() },
				} satisfies WebSocketRelay;
				const layer = makeLayer(server, { auth, relay, ensureRelayStarted });

				yield* Effect.gen(function* () {
					const socket = makeSocket();
					server.emit(
						"upgrade",
						makeRequest("/p/test-project/ws"),
						socket,
						Buffer.alloc(0),
					);

					yield* waitForAssertion(() => {
						expect(socket.destroy).toHaveBeenCalled();
						expect(ensureRelayStarted).not.toHaveBeenCalled();
						expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
					});
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}),
	);

	it.scoped("writes 503 when the relay cannot become ready", () =>
		Effect.gen(function* () {
			const server = createServer();
			const relay = {
				wsHandler: { handleUpgrade: vi.fn() },
			} satisfies WebSocketRelay;
			const layer = makeLayer(server, {
				relay,
				waitForRelay: (slug) =>
					Effect.fail(
						new WebSocketUpgradeError({
							reason: "relay_unavailable",
							slug,
							cause: new Error("relay failed"),
						}),
					),
			});

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit(
					"upgrade",
					makeRequest("/p/test-project/ws"),
					socket,
					Buffer.alloc(0),
				);

				yield* waitForAssertion(() => {
					expect(socket.write).toHaveBeenCalledWith(
						"HTTP/1.1 503 Service Unavailable\r\n\r\n",
					);
					expect(socket.destroy).toHaveBeenCalled();
					expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.scoped("removes the upgrade listener on scope close", () =>
		Effect.gen(function* () {
			const server = createServer();
			const layer = makeLayer(server);
			const before = server.listenerCount("upgrade");
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(Layer.fresh(layer), scope);
			expect(server.listenerCount("upgrade")).toBe(before + 1);
			yield* Scope.close(scope, Exit.void);
			expect(server.listenerCount("upgrade")).toBe(before);
		}),
	);

	it.scoped("destroys sockets while daemon shutdown is in progress", () =>
		Effect.gen(function* () {
			const server = createServer();
			const ensureRelayStarted = vi.fn();
			const touchLastUsed = vi.fn();
			const relay = {
				wsHandler: { handleUpgrade: vi.fn() },
			} satisfies WebSocketRelay;
			const layer = makeLayer(server, {
				relay,
				ensureRelayStarted,
				touchLastUsed,
				shuttingDown: true,
			});

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit(
					"upgrade",
					makeRequest("/p/test-project/ws"),
					socket,
					Buffer.alloc(0),
				);

				yield* waitForAssertion(() => {
					expect(socket.destroy).toHaveBeenCalled();
					expect(ensureRelayStarted).not.toHaveBeenCalled();
					expect(touchLastUsed).not.toHaveBeenCalled();
					expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);
});
