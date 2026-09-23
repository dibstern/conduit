import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Scope,
} from "effect";
import { expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";
import { HttpServerRefTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { DaemonWsClientRegistryTag } from "../../../src/lib/domain/daemon/Services/daemon-ws-client-registry.js";
import {
	getEntry,
	makeProjectRegistryLive,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { makeRelayCacheLive } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	type WebSocketRelay,
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
	WebSocketUpgradeError,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import * as wsRpcHandlerModule from "../../../src/lib/server/ws-rpc-handler.js";
import { WsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import type { StoredProject } from "../../../src/lib/types.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

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

const makeWebSocketRelay = (): WebSocketRelay => ({
	attach: vi.fn(() => () => {}),
	wsHandler: { handleUpgrade: vi.fn() },
	rpcWsHandler: { handleUpgrade: vi.fn() },
});

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
		projects?: ReadonlyArray<StoredProject>;
	},
) => {
	const relay = options?.relay ?? makeWebSocketRelay();
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
			makeAuthManagerLive(
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
		Layer.provideMerge(makeDaemonRpcTestLayer(options?.projects)),
	);
};

const waitForAssertion = (assertion: () => void) =>
	Effect.tryPromise({
		try: () => vi.waitFor(assertion),
		catch: (cause) => cause,
	});

const project: StoredProject = {
	slug: "test-project",
	title: "Test Project",
	directory: "/tmp/test-project",
	lastUsed: 1,
};

const makeRouterLayer = (
	projects: ReadonlyArray<StoredProject>,
	factory: Parameters<typeof makeRelayCacheLive>[0],
) =>
	WebSocketRelayRouterLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makeProjectRegistryLive(projects),
				makeRelayCacheLive(factory),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
			),
		),
	);

describe("WebSocketRelayRouterLive", () => {
	it.effect("returns a cached relay and does not create duplicates", () => {
		const relay = makeWebSocketRelay();
		const factory = vi.fn((slug: string) =>
			Effect.succeed({
				slug,
				attach: relay.attach,
				wsHandler: relay.wsHandler,
				rpcWsHandler: relay.rpcWsHandler,
				stop: vi.fn(),
			}),
		);
		const layer = makeRouterLayer([project], factory);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			yield* router.ensureRelayStarted("test-project");
			const first = yield* router.waitForRelay("test-project", 10);
			yield* router.ensureRelayStarted("test-project");
			const second = yield* router.waitForRelay("test-project", 10);

			expect(first).toBe(second);
			expect(first.wsHandler).toBe(relay.wsHandler);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(factory).toHaveBeenCalledWith("test-project");
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	it.effect("fails unknown slugs without invoking the relay factory", () => {
		const factory = vi.fn((slug: string) =>
			Effect.succeed({
				slug,
				attach: vi.fn(() => () => {}),
				wsHandler: { handleUpgrade: vi.fn() },
				rpcWsHandler: { handleUpgrade: vi.fn() },
				stop: vi.fn(),
			}),
		);
		const layer = makeRouterLayer([], factory);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			const result = yield* Effect.either(
				router.ensureRelayStarted("missing-project"),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(WebSocketUpgradeError);
				expect(result.left.reason).toBe("relay_unavailable");
				expect(result.left.slug).toBe("missing-project");
			}
			expect(factory).not.toHaveBeenCalled();
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	it.effect("marks the project failed when relay creation fails", () => {
		const factory = vi.fn((slug: string) =>
			Effect.fail(new Error(`factory failed for ${slug}`)),
		);
		const layer = makeRouterLayer([project], factory);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			const result = yield* Effect.either(
				router.ensureRelayStarted("test-project"),
			);
			const entry = yield* getEntry("test-project");

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(WebSocketUpgradeError);
				expect(result.left.reason).toBe("relay_unavailable");
				expect(result.left.slug).toBe("test-project");
			}
			const state = Option.getOrThrow(entry);
			expect(state._tag).toBe("Error");
			if (state._tag === "Error") {
				expect(state.error).toBe("factory failed for test-project");
			}
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});
});

describe("WebSocketRoutingLive", () => {
	it.scoped.each([
		{ query: "?p=older", projects: true, fails: false, expected: "older" },
		{ query: "?p=missing", projects: true, fails: false, expected: "recent" },
		{ query: "", projects: true, fails: false, expected: "recent" },
		{
			query: "?session=missing&p=older",
			projects: true,
			fails: false,
			expected: "older",
		},
		{ query: "", projects: false, fails: false, expected: null },
		{ query: "?p=older", projects: true, fails: true, expected: null },
	])(
		"selects a daemon attachment for $query (projects=$projects, fails=$fails)",
		(scenario) =>
			Effect.gen(function* () {
				const relay = makeWebSocketRelay();
				const context = yield* Layer.build(
					makeLayer(createServer(), {
						relay,
						projects: scenario.projects
							? [
									{
										slug: "older",
										title: "Older",
										directory: "/nonexistent/conduit-older",
										lastUsed: 1,
									},
									{
										slug: "recent",
										title: "Recent",
										directory: "/nonexistent/conduit-recent",
										lastUsed: 2,
									},
								]
							: [],
						waitForRelay: (slug) =>
							scenario.fails
								? Effect.fail(
										new WebSocketUpgradeError({
											reason: "relay_unavailable",
											slug,
										}),
									)
								: Effect.succeed(relay),
					}),
				);
				const registry = yield* DaemonWsClientRegistryTag.pipe(
					Effect.provide(context),
				);
				const socket = Object.assign(new EventEmitter(), {
					readyState: WebSocket.OPEN,
					send: vi.fn(),
					close: vi.fn(),
				});
				registry.server.emit(
					"connection",
					socket,
					makeRequest(`/ws${scenario.query}`),
				);
				yield* Effect.yieldNow();
				yield* waitForAssertion(() => {
					if (scenario.expected) {
						expect(socket.send).toHaveBeenCalledWith(
							JSON.stringify({
								type: "project_attached",
								slug: scenario.expected,
							}),
						);
						expect(relay.attach).toHaveBeenCalledTimes(1);
					} else {
						expect(socket.send).not.toHaveBeenCalled();
						expect(relay.attach).not.toHaveBeenCalled();
					}
				});
				expect(socket.close).not.toHaveBeenCalled();
			}),
	);

	it.scoped.each([
		{ initial: "project-a", originId: "browser", reattaches: true },
		{ initial: null, originId: "browser", reattaches: true },
		{ initial: "project-b", originId: "browser", reattaches: false },
		{ initial: "project-a", originId: "unknown", reattaches: false },
	])(
		"AttachProject from $initial for $originId reattaches=$reattaches without requesting a session",
		(scenario) =>
			Effect.gen(function* () {
				const routing = vi.spyOn(
					wsRpcHandlerModule,
					"makeRoutedWsRpcWebSocketHandler",
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => routing.mockRestore()),
				);
				const calls: string[] = [];
				const detach = vi.fn(() => calls.push("detach"));
				const relay = makeWebSocketRelay();
				vi.mocked(relay.attach).mockImplementation(() => {
					calls.push("attach");
					return detach;
				});
				const context = yield* Layer.build(
					makeLayer(createServer(), {
						relay,
						projects: scenario.initial
							? [{ ...project, slug: scenario.initial }]
							: [],
					}),
				);
				const registry = yield* DaemonWsClientRegistryTag.pipe(
					Effect.provide(context),
				);
				const socket = Object.assign(new EventEmitter(), {
					readyState: WebSocket.OPEN,
					send: vi.fn(() => calls.push("project_attached")),
					close: vi.fn(),
				});
				registry.server.emit(
					"connection",
					socket,
					makeRequest("/ws?client=browser"),
				);
				yield* Effect.yieldNow();
				if (scenario.initial) {
					yield* waitForAssertion(() =>
						expect(relay.attach).toHaveBeenCalledTimes(1),
					);
				}
				calls.length = 0;
				vi.mocked(relay.attach).mockClear();
				socket.send.mockClear();
				const reattach = routing.mock.calls.at(-1)?.[3];
				if (!reattach) {
					return yield* Effect.fail(
						new Error("Missing daemon reattach handler"),
					);
				}
				expect(
					yield* reattach({
						projectSlug: "project-b",
						originId: scenario.originId,
					}),
				).toBe(scenario.reattaches);
				if (scenario.reattaches) {
					expect(calls).toEqual([
						...(scenario.initial ? ["detach"] : []),
						"project_attached",
						"attach",
					]);
					expect(socket.send).toHaveBeenCalledWith(
						JSON.stringify({ type: "project_attached", slug: "project-b" }),
					);
					expect(relay.attach).toHaveBeenCalledWith(socket, {
						clientId: "browser",
					});
					const entry = yield* registry.get("browser");
					expect(Option.isSome(entry) && entry.value.slug).toBe("project-b");
				} else {
					expect(calls).toEqual([]);
				}
				expect(socket.close).not.toHaveBeenCalled();
			}),
	);

	it.scoped.each(["new-project", "original-project", "replacement-socket"])(
		"ignores a slow attachment superseded by %s",
		(scenario) =>
			Effect.gen(function* () {
				const routing = vi.spyOn(
					wsRpcHandlerModule,
					"makeRoutedWsRpcWebSocketHandler",
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => routing.mockRestore()),
				);
				const pendingRelay = yield* Deferred.make<WebSocketRelay>();
				const relay = makeWebSocketRelay();
				const waitForRelay = vi.fn((slug: string) =>
					slug === "project-b"
						? Deferred.await(pendingRelay)
						: Effect.succeed(relay),
				);
				const context = yield* Layer.build(
					makeLayer(createServer(), {
						relay,
						projects: [{ ...project, slug: "project-a" }],
						waitForRelay,
					}),
				);
				const registry = yield* DaemonWsClientRegistryTag.pipe(
					Effect.provide(context),
				);
				const socket = Object.assign(new EventEmitter(), {
					readyState: WebSocket.OPEN,
					send: vi.fn(),
					close: vi.fn(),
				});
				registry.server.emit(
					"connection",
					socket,
					makeRequest("/ws?client=browser"),
				);
				yield* waitForAssertion(() =>
					expect(relay.attach).toHaveBeenCalledTimes(1),
				);
				const reattach = routing.mock.calls.at(-1)?.[3];
				if (!reattach)
					return yield* Effect.fail(
						new Error("Missing daemon reattach handler"),
					);
				const pending = yield* reattach({
					projectSlug: "project-b",
					sessionId: "session-b",
					originId: "browser",
				}).pipe(Effect.forkScoped);
				yield* waitForAssertion(() =>
					expect(waitForRelay).toHaveBeenCalledWith(
						"project-b",
						expect.any(Number),
					),
				);
				if (scenario === "replacement-socket") {
					const replacement = Object.assign(new EventEmitter(), {
						readyState: WebSocket.OPEN,
						send: vi.fn(),
						close: vi.fn(),
					});
					registry.server.emit(
						"connection",
						replacement,
						makeRequest("/ws?client=browser"),
					);
					yield* waitForAssertion(() =>
						expect(relay.attach).toHaveBeenCalledTimes(2),
					);
				} else {
					yield* reattach({
						projectSlug: scenario === "new-project" ? "project-c" : "project-a",
						originId: "browser",
					});
				}
				const attachments = vi.mocked(relay.attach).mock.calls.length;
				yield* Deferred.succeed(pendingRelay, relay);
				// True marks a stale ViewSession as handled instead of falling
				// through to the old project's relay handler.
				expect(yield* Fiber.join(pending)).toBe(true);
				expect(relay.attach).toHaveBeenCalledTimes(attachments);
				const entry = yield* registry.get("browser");
				expect(Option.isSome(entry) && entry.value.slug).toBe(
					scenario === "new-project" ? "project-c" : "project-a",
				);
			}),
	);

	it.scoped("routes project websocket upgrades through the relay", () =>
		Effect.gen(function* () {
			const server = createServer();
			const relay = makeWebSocketRelay();
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

	it.scoped(
		"routes project RPC websocket upgrades through the RPC handler",
		() =>
			Effect.gen(function* () {
				const server = createServer();
				const relay = makeWebSocketRelay();
				const ensureRelayStarted = vi.fn();
				const touchLastUsed = vi.fn();
				const layer = makeLayer(server, {
					relay,
					ensureRelayStarted,
					touchLastUsed,
				});

				yield* Effect.gen(function* () {
					const socket = makeSocket();
					const req = makeRequest("/p/test-project/rpc");
					server.emit("upgrade", req, socket, Buffer.alloc(0));

					yield* waitForAssertion(() => {
						expect(ensureRelayStarted).toHaveBeenCalledWith("test-project");
						expect(touchLastUsed).toHaveBeenCalledWith("test-project");
						expect(relay.rpcWsHandler.handleUpgrade).toHaveBeenCalledWith(
							req,
							socket,
							expect.any(Buffer),
						);
						expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
					});
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}),
	);

	it.scoped.each(["/invalid", "/rpc/", "/rpc-extra", "/ws/", "/ws-extra"])(
		"destroys sockets for invalid websocket path %s",
		(path) =>
			Effect.gen(function* () {
				const server = createServer();
				const relay = makeWebSocketRelay();
				const layer = makeLayer(server, { relay });

				yield* Effect.gen(function* () {
					const socket = makeSocket();
					server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

					yield* waitForAssertion(() => {
						expect(socket.destroy).toHaveBeenCalled();
						expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
					});
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}),
	);

	it.scoped.each([
		"/p/test-project/ws",
		"/p/test-project/rpc",
		"/rpc",
		"/rpc?client=browser",
		"/ws",
		"/ws?client=browser",
	])("rejects unauthenticated %s upgrades before relay startup", (path) =>
		Effect.gen(function* () {
			const server = createServer();
			const ensureRelayStarted = vi.fn();
			const auth = new AuthManager({
				getPinHash: () => hashPin("1234"),
			});
			const relay = makeWebSocketRelay();
			const layer = makeLayer(server, { auth, relay, ensureRelayStarted });

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

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
			const relay = makeWebSocketRelay();
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

	it.scoped.each([
		"/p/test-project/ws",
		"/p/test-project/rpc",
		"/rpc",
		"/rpc?client=browser",
		"/ws",
		"/ws?client=browser",
	])("destroys %s sockets while daemon shutdown is in progress", (path) =>
		Effect.gen(function* () {
			const server = createServer();
			const ensureRelayStarted = vi.fn();
			const touchLastUsed = vi.fn();
			const relay = makeWebSocketRelay();
			const layer = makeLayer(server, {
				relay,
				ensureRelayStarted,
				touchLastUsed,
				shuttingDown: true,
			});

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

				yield* waitForAssertion(() => {
					expect(socket.destroy).toHaveBeenCalled();
					expect(ensureRelayStarted).not.toHaveBeenCalled();
					expect(touchLastUsed).not.toHaveBeenCalled();
					expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.scoped.each(["/rpc", "/rpc?client=browser"])(
		"accepts %s without resolving a project at upgrade time",
		(path) =>
			Effect.gen(function* () {
				const upgrade = vi
					.spyOn(WsRpcWebSocketHandler.prototype, "handleUpgrade")
					.mockImplementation(() => {});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => upgrade.mockRestore()),
				);
				const server = createServer();
				const ensureRelayStarted = vi.fn();
				const relay = makeWebSocketRelay();
				yield* Layer.build(makeLayer(server, { relay, ensureRelayStarted }));
				const req = makeRequest(path);
				const socket = makeSocket();
				server.emit("upgrade", req, socket, Buffer.alloc(0));
				yield* waitForAssertion(() =>
					expect(upgrade).toHaveBeenCalledWith(req, socket, expect.any(Buffer)),
				);
				expect(ensureRelayStarted).not.toHaveBeenCalled();
				expect(relay.rpcWsHandler.handleUpgrade).not.toHaveBeenCalled();
				expect(socket.destroy).not.toHaveBeenCalled();
			}),
	);

	it.scoped.each(["/ws", "/ws?client=browser"])(
		"accepts daemon event socket %s without resolving a project before upgrade",
		(path) =>
			Effect.gen(function* () {
				const upgrade = vi
					.spyOn(WebSocketServer.prototype, "handleUpgrade")
					.mockImplementation(() => {});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => upgrade.mockRestore()),
				);
				const server = createServer();
				const ensureRelayStarted = vi.fn();
				const relay = makeWebSocketRelay();
				yield* Layer.build(makeLayer(server, { relay, ensureRelayStarted }));
				const req = makeRequest(path);
				const socket = makeSocket();
				server.emit("upgrade", req, socket, Buffer.alloc(0));
				yield* waitForAssertion(() =>
					expect(upgrade).toHaveBeenCalledWith(
						req,
						socket,
						expect.any(Buffer),
						expect.any(Function),
					),
				);
				expect(ensureRelayStarted).not.toHaveBeenCalled();
				expect(relay.wsHandler.handleUpgrade).not.toHaveBeenCalled();
				expect(socket.destroy).not.toHaveBeenCalled();
			}),
	);
});
