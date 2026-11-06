import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Option, Ref, Scope } from "effect";
import { expect, type Mock, vi } from "vitest";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";
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
import {
	type ProjectParts,
	ProjectServices,
	ProjectServicesError,
} from "../../../src/lib/domain/daemon/Services/project-services.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	ProjectRpcContextsTag,
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
	WebSocketUpgradeError,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { HttpServerRefTag } from "../../../src/lib/domain/server/Services/http-server-ref.js";
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

const makeLayer = (
	server: Server,
	options?: {
		auth?: AuthManager;
		resolveProject?: Mock<(slug: string) => void>;
		shuttingDown?: boolean;
		projects?: ReadonlyArray<StoredProject>;
	},
) => {
	const resolveProject = options?.resolveProject ?? vi.fn();

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
			// Upgrade tests never reach a project; resolving one records the slug and dies.
			Layer.succeed(ProjectRpcContextsTag)((slug) =>
				Effect.sync(() => resolveProject(slug)).pipe(
					Effect.andThen(Effect.die("No project contexts in this test")),
				),
			),
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
	open: ProjectServices["Service"]["open"],
) =>
	WebSocketRelayRouterLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makeProjectRegistryLive(projects),
				Layer.succeed(ProjectServices)({
					forProject: () => Effect.die("unused"),
					generation: () => Effect.die("unused"),
					open,
					opened: () => Effect.succeedNone,
					close: () => Effect.void,
				}),
				DaemonEventBusLive,
				ConfigPersistenceNoopLive,
			),
		),
	);

describe("WebSocketRelayRouterLive", () => {
	it.effect("opens the asked project and marks it ready", () => {
		const open = vi.fn((_slug: string) =>
			Effect.succeed(Context.empty() as Context.Context<ProjectParts>),
		);
		const layer = makeRouterLayer([project], open);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			yield* router.ensureRelayStarted("test-project");
			yield* router.ensureRelayStarted("test-project");

			// ProjectServices starts a project once however often it is opened.
			expect(open.mock.calls).toEqual([["test-project"], ["test-project"]]);
			const entry = Option.getOrThrow(yield* getEntry("test-project"));
			expect(entry._tag).toBe("Ready");
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	it.effect("fails unknown slugs without opening a project", () => {
		const open = vi.fn((_slug: string) =>
			Effect.succeed(Context.empty() as Context.Context<ProjectParts>),
		);
		const layer = makeRouterLayer([], open);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			const result = yield* Effect.result(
				router.ensureRelayStarted("missing-project"),
			);

			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(WebSocketUpgradeError);
				expect(result.failure.reason).toBe("relay_unavailable");
				expect(result.failure.slug).toBe("missing-project");
			}
			expect(open).not.toHaveBeenCalled();
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});

	it.effect("marks the project failed when its start fails", () => {
		const layer = makeRouterLayer([project], (projectId) =>
			Effect.fail(
				new ProjectServicesError({
					projectId,
					reason: `start failed for ${projectId}`,
				}),
			),
		);

		return Effect.gen(function* () {
			const router = yield* WebSocketRelayRouterTag;
			const result = yield* Effect.result(
				router.ensureRelayStarted("test-project"),
			);
			const entry = yield* getEntry("test-project");

			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") {
				expect(result.failure).toBeInstanceOf(WebSocketUpgradeError);
				expect(result.failure.reason).toBe("relay_unavailable");
				expect(result.failure.slug).toBe("test-project");
			}
			const state = Option.getOrThrow(entry);
			expect(state._tag).toBe("Error");
			if (state._tag === "Error") {
				expect(state.error).toBe("start failed for test-project");
			}
		}).pipe(Effect.provide(Layer.fresh(layer)));
	});
});

describe("WebSocketRoutingLive", () => {
	it.effect.each([
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
			const resolveProject = vi.fn();
			const layer = makeLayer(server, { resolveProject });

			yield* Effect.gen(function* () {
				const socket = makeSocket();
				server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

				yield* waitForAssertion(() => {
					expect(socket.destroy).toHaveBeenCalled();
					expect(resolveProject).not.toHaveBeenCalled();
				});
			}).pipe(Effect.provide(Layer.fresh(layer)));
		}),
	);

	it.effect.each(["/rpc", "/rpc?client=browser"])(
		"rejects unauthenticated %s upgrades before resolving a project",
		(path) =>
			Effect.gen(function* () {
				const server = createServer();
				const resolveProject = vi.fn();
				const auth = new AuthManager({
					getPinHash: () => hashPin("1234"),
				});
				const layer = makeLayer(server, { auth, resolveProject });

				yield* Effect.gen(function* () {
					const socket = makeSocket();
					server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

					yield* waitForAssertion(() => {
						expect(socket.destroy).toHaveBeenCalled();
						expect(resolveProject).not.toHaveBeenCalled();
					});
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}),
	);

	it.effect("removes the upgrade listener on scope close", () =>
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

	it.effect.each(["/rpc", "/rpc?client=browser"])(
		"destroys %s sockets while daemon shutdown is in progress",
		(path) =>
			Effect.gen(function* () {
				const server = createServer();
				const resolveProject = vi.fn();
				const layer = makeLayer(server, {
					resolveProject,
					shuttingDown: true,
				});

				yield* Effect.gen(function* () {
					const socket = makeSocket();
					server.emit("upgrade", makeRequest(path), socket, Buffer.alloc(0));

					yield* waitForAssertion(() => {
						expect(socket.destroy).toHaveBeenCalled();
						expect(resolveProject).not.toHaveBeenCalled();
					});
				}).pipe(Effect.provide(Layer.fresh(layer)));
			}),
	);

	it.effect.each(["/rpc", "/rpc?client=browser"])(
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
				const resolveProject = vi.fn();
				yield* Layer.build(makeLayer(server, { resolveProject }));
				const req = makeRequest(path);
				const socket = makeSocket();
				server.emit("upgrade", req, socket, Buffer.alloc(0));
				yield* waitForAssertion(() =>
					expect(upgrade).toHaveBeenCalledWith(req, socket, expect.any(Buffer)),
				);
				expect(resolveProject).not.toHaveBeenCalled();
				expect(socket.destroy).not.toHaveBeenCalled();
			}),
	);
});
