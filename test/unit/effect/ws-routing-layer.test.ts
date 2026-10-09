import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Ref, Scope } from "effect";
import { expect, vi } from "vitest";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { HttpServerRefTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
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
	rpcWsHandler: {},
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
	folders: ["/tmp/test-project"],
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
				wsHandler: {},
				rpcWsHandler: relay.rpcWsHandler,
				syncGlobalSetting: () => Effect.void,
				refreshGlobalDefaults: () => Effect.void,
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
			expect(first.rpcWsHandler).toBe(relay.rpcWsHandler);
			expect(factory).toHaveBeenCalledTimes(1);
			expect(factory.mock.calls[0]?.[0]).toBe("test-project");
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	it.effect("fails unknown slugs without invoking the relay factory", () => {
		const factory = vi.fn((slug: string) =>
			Effect.succeed({
				slug,
				wsHandler: {},
				rpcWsHandler: {},
				syncGlobalSetting: () => Effect.void,
				refreshGlobalDefaults: () => Effect.void,
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
		{ hint: "older", projects: true, fails: false, expected: "older" },
		{ hint: "missing", projects: true, fails: false, expected: "recent" },
		{ hint: undefined, projects: true, fails: false, expected: "recent" },
		{
			hint: "older",
			sessionId: "missing",
			projects: true,
			fails: false,
			expected: "older",
		},
		{ hint: "older", projects: false, fails: false, expected: null },
		{ hint: "older", projects: true, fails: true, expected: null },
	])(
		"AttachProject resolves hint $hint (session $sessionId, fails=$fails) to $expected",
		(scenario) =>
			Effect.gen(function* () {
				const routing = vi.spyOn(
					wsRpcHandlerModule,
					"makeRoutedWsRpcWebSocketHandler",
				);
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => routing.mockRestore()),
				);
				const relay = makeWebSocketRelay();
				yield* Layer.build(
					makeLayer(createServer(), {
						relay,
						projects: scenario.projects
							? [
									{ ...project, slug: "older", lastUsed: 1 },
									{ ...project, slug: "recent", lastUsed: 2 },
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
				const attachProject = routing.mock.calls.at(-1)?.[4];
				if (!attachProject) {
					return yield* Effect.fail(
						new Error("Missing daemon attachProject handler"),
					);
				}
				const result = yield* Effect.either(
					attachProject({
						originId: "unregistered",
						...(scenario.hint ? { projectSlug: scenario.hint } : {}),
						...(scenario.sessionId ? { sessionId: scenario.sessionId } : {}),
					}),
				);
				if (scenario.fails) {
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left).toBeInstanceOf(WsRpcError);
						expect(result.left.message).toContain(
							'Project "older" unavailable',
						);
					}
				} else {
					expect(result._tag).toBe("Right");
					if (result._tag === "Right") {
						expect(result.right).toEqual({ projectSlug: scenario.expected });
					}
				}
			}),
	);

	it.scoped.each([
		"/invalid",
		"/rpc/",
		"/rpc-extra",
		"/ws",
		"/ws?client=browser",
		"/ws/",
		"/ws-extra",
		"/p/test-project/ws",
		"/p/test-project/rpc",
		"/p/test-project/ws?client=browser",
		"/p/test-project/rpc?client=browser",
	])("destroys sockets for invalid websocket path %s", (path) =>
		Effect.gen(function* () {
			const server = createServer();
			const relay = makeWebSocketRelay();
			const ensureRelayStarted = vi.fn();
			const layer = makeLayer(server, { relay, ensureRelayStarted });

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

				yield* waitForAssertion(() => {
					expect(socket.destroy).toHaveBeenCalled();
					expect(ensureRelayStarted).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.scoped.each(["/rpc", "/rpc?client=browser"])(
		"rejects unauthenticated %s upgrades before relay startup",
		(path) =>
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

	it.scoped.each(["/rpc", "/rpc?client=browser"])(
		"destroys %s sockets while daemon shutdown is in progress",
		(path) =>
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
				expect(socket.destroy).not.toHaveBeenCalled();
			}),
	);
});
