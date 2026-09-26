import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Ref } from "effect";
import { expect, vi } from "vitest";
import WebSocket from "ws";
import { AuthManager } from "../../../src/lib/auth.js";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { HttpServerRefTag } from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { makeRelayCacheLive } from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { makeWsHandlerStateLive } from "../../../src/lib/domain/relay/Services/ws-handler-service.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { makeEffectWsHandler } from "../../../src/lib/server/effect-ws-handler.js";
import { makeWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const makeProjectStore = (directory: string, sessionId: string): void => {
	const conduitDirectory = join(directory, ".conduit");
	mkdirSync(conduitDirectory, { recursive: true });
	const database = SqliteClient.open(join(conduitDirectory, "events.db"));
	try {
		runMigrations(database, schemaMigrations);
		database.execute(
			`INSERT INTO sessions (
				id, provider, title, status, created_at, updated_at
			) VALUES (?, 'opencode', ?, 'idle', ?, ?)`,
			[sessionId, sessionId, 1, 1],
		);
	} finally {
		database.close();
	}
};

const waitForOpen = (ws: WebSocket) =>
	Effect.async<void, Error>((resume) => {
		ws.once("open", () => resume(Effect.void));
		ws.once("error", (error) => resume(Effect.fail(error)));
	});

const waitFor = (assertion: () => void) =>
	Effect.tryPromise({
		try: () => vi.waitFor(assertion),
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});

describe("daemon shared RPC routing", () => {
	it.scoped.each(["ViewSession", "AttachProject"] as const)(
		"reattaches one daemon event socket when %s moves across projects",
		(operation) =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "conduit-daemon-ws-"))),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const projectA = join(root, "project-a");
				const projectB = join(root, "project-b");
				mkdirSync(projectA);
				mkdirSync(projectB);
				makeProjectStore(projectA, "session-a");
				makeProjectStore(projectB, "session-b");
				const projects = [
					{
						slug: "project-a",
						title: "Project A",
						directory: projectA,
						lastUsed: 2,
					},
					{
						slug: "project-b",
						title: "Project B",
						directory: projectB,
						lastUsed: 1,
					},
				];
				const handlers = new Map<
					string,
					Effect.Effect.Success<ReturnType<typeof makeEffectWsHandler>>
				>();
				const ptyMessages = new Map<string, ReturnType<typeof vi.fn>>();
				const factory = (slug: string) =>
					Effect.gen(function* () {
						const runtime = ManagedRuntime.make(
							Layer.mergeAll(
								makeTestHandlerLayer({
									config: makeMockConfig({ slug }),
								}),
								makeWsTransportLive({ noServer: true }),
								makeWsHandlerStateLive(),
							),
						);
						const wsHandler = yield* makeEffectWsHandler({
							heartbeatInterval: 300_000,
						}).pipe(Effect.provide(runtime));
						const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
							runtime,
						}).pipe(Effect.provide(runtime));
						const ptyMessage = vi.fn();
						ptyMessages.set(slug, ptyMessage);
						handlers.set(slug, wsHandler);
						wsHandler.on("message", ptyMessage);
						wsHandler.on(
							"client_connected",
							({ clientId, requestedSessionId }) => {
								if (requestedSessionId) {
									wsHandler.setClientSession(clientId, requestedSessionId);
								}
								wsHandler.sendTo(clientId, {
									type: "session_list",
									sessions: [
										{
											id: requestedSessionId ?? `${slug}-default`,
											title: `${slug} bootstrap`,
										},
									],
									roots: true,
								});
							},
						);
						return {
							slug,
							attach: (
								ws: WebSocket,
								options: Parameters<typeof wsHandler.attach>[1],
							) => wsHandler.attach(ws, options),
							wsHandler,
							rpcWsHandler,
							stop: async () => {
								await wsHandler.drain();
								await rpcWsHandler.drain();
								await runtime.dispose();
							},
						};
					});

				const server = yield* Effect.acquireRelease(
					Effect.async<Server, Error>((resume) => {
						const server = createServer();
						server.once("error", (error) => resume(Effect.fail(error)));
						server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
					}),
					(server) =>
						Effect.async<void>((resume) => {
							server.close(() => resume(Effect.void));
						}),
				);
				const routerContext = yield* Layer.build(
					WebSocketRelayRouterLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								makeProjectRegistryLive(projects),
								makeRelayCacheLive(factory),
								DaemonEventBusLive,
								ConfigPersistenceNoopLive,
							),
						),
					),
				);
				const relayRouter = yield* WebSocketRelayRouterTag.pipe(
					Effect.provide(routerContext),
				);
				yield* Layer.build(
					WebSocketRoutingLive.pipe(
						Layer.provide(makeDaemonRpcTestLayer(projects, factory)),
						Layer.provide(
							Layer.mergeAll(
								Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
								DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
								makeAuthManagerLive(
									new AuthManager({ getPinHash: () => null }),
								),
								Layer.succeed(WebSocketRelayRouterTag, relayRouter),
							),
						),
					),
				);
				const address = server.address();
				if (!address || typeof address === "string") {
					return yield* Effect.fail(new Error("No TCP address"));
				}
				const eventMessages: Record<string, unknown>[] = [];
				const eventSocket = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new WebSocket(
								`ws://127.0.0.1:${address.port}/ws?client=daemon-client&session=session-a`,
							),
					),
					(ws) => Effect.sync(() => ws.close()),
				);
				eventSocket.on("message", (data) => {
					eventMessages.push(
						JSON.parse(data.toString()) as Record<string, unknown>,
					);
				});
				yield* waitForOpen(eventSocket);
				yield* waitFor(() => {
					expect(
						eventMessages.some(
							(message) =>
								message["type"] === "session_list" &&
								JSON.stringify(message).includes("project-a bootstrap"),
						),
					).toBe(true);
				});
				const attachedA = eventMessages.findIndex(
					(message) =>
						message["type"] === "project_attached" &&
						message["slug"] === "project-a",
				);
				const bootstrapA = eventMessages.findIndex(
					(message) =>
						message["type"] === "session_list" &&
						JSON.stringify(message).includes("project-a bootstrap"),
				);
				expect(attachedA).toBeGreaterThanOrEqual(0);
				expect(bootstrapA).toBeGreaterThan(attachedA);

				const rpcContext = yield* Layer.build(
					RpcClient.layerProtocolSocket().pipe(
						Layer.provide(
							Socket.layerWebSocket(`ws://127.0.0.1:${address.port}/rpc`),
						),
						Layer.provide(Socket.layerWebSocketConstructorGlobal),
						Layer.provide(RpcSerialization.layerJson),
					),
				);
				const rpcClient = yield* RpcClient.make(WsRpcGroup).pipe(
					Effect.provide(rpcContext),
				);
				expect(
					yield* operation === "ViewSession"
						? rpcClient.ViewSession({
								projectSlug: "project-b",
								sessionId: "session-b",
								originId: "daemon-client",
							})
						: rpcClient.AttachProject({
								projectSlug: "project-b",
								originId: "daemon-client",
							}),
				).toEqual({ ok: true });
				yield* waitFor(() => {
					expect(
						eventMessages.some(
							(message) =>
								message["type"] === "session_list" &&
								JSON.stringify(message).includes("project-b bootstrap"),
						),
					).toBe(true);
				});
				const attachedB = eventMessages.findIndex(
					(message) =>
						message["type"] === "project_attached" &&
						message["slug"] === "project-b",
				);
				const bootstrapB = eventMessages.findIndex(
					(message) =>
						message["type"] === "session_list" &&
						JSON.stringify(message).includes("project-b bootstrap"),
				);
				expect(bootstrapB).toBeGreaterThan(attachedB);
				expect(attachedB).toBeGreaterThan(bootstrapA);
				expect(eventSocket.readyState).toBe(WebSocket.OPEN);
				expect(
					eventMessages.filter((message) => message["type"] === "session_list"),
				).toEqual([
					{
						type: "session_list",
						sessions: [{ id: "session-a", title: "project-a bootstrap" }],
						roots: true,
					},
					{
						type: "session_list",
						sessions: [
							{
								id:
									operation === "ViewSession"
										? "session-b"
										: "project-b-default",
								title: "project-b bootstrap",
							},
						],
						roots: true,
					},
				]);

				const handlerA = handlers.get("project-a");
				const handlerB = handlers.get("project-b");
				if (!handlerA || !handlerB) {
					return yield* Effect.fail(new Error("Expected both relays to start"));
				}
				handlerA.broadcast({
					type: "banner",
					config: { id: "from-a", text: "from-a" },
				});
				handlerB.broadcast({
					type: "banner",
					config: { id: "from-b", text: "from-b" },
				});
				yield* waitFor(() => {
					expect(
						eventMessages.some(
							(message) =>
								message["type"] === "banner" &&
								JSON.stringify(message).includes("from-b"),
						),
					).toBe(true);
				});
				expect(
					eventMessages.some(
						(message) =>
							message["type"] === "banner" &&
							JSON.stringify(message).includes("from-a"),
					),
				).toBe(false);

				eventSocket.send(
					JSON.stringify({
						type: "pty_input",
						ptyId: "pty-b",
						data: "x",
					}),
				);
				yield* waitFor(() => {
					expect(ptyMessages.get("project-b")).toHaveBeenCalledWith(
						expect.objectContaining({
							clientId: "daemon-client",
							handler: "pty_input",
						}),
					);
				});
				expect(ptyMessages.get("project-a")).not.toHaveBeenCalled();
			}),
	);

	it.scoped(
		"adds the first project over one daemon RPC socket without starting a relay",
		() =>
			Effect.gen(function* () {
				const directory = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "conduit-first-project-")),
					),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const server = yield* Effect.acquireRelease(
					Effect.async<Server, Error>((resume) => {
						const server = createServer();
						server.once("error", (error) => resume(Effect.fail(error)));
						server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
					}),
					(server) =>
						Effect.async<void>((resume) => {
							server.close(() => resume(Effect.void));
						}),
				);
				const upgrades = vi.fn();
				server.on("upgrade", upgrades);
				const ensure = vi.fn(() => Effect.die("Must not start a relay"));
				const wait = vi.fn(() => Effect.die("Must not resolve a relay"));
				const touch = vi.fn(() => Effect.die("Must not touch a relay"));
				yield* Layer.build(
					WebSocketRoutingLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								makeDaemonRpcTestLayer(),
								Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
								makeAuthManagerLive(
									new AuthManager({ getPinHash: () => null }),
								),
								Layer.succeed(WebSocketRelayRouterTag, {
									ensureRelayStarted: ensure,
									waitForRelay: wait,
									touchLastUsed: touch,
								}),
							),
						),
					),
				);
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("No TCP address");
				const clientContext = yield* Layer.build(
					RpcClient.layerProtocolSocket().pipe(
						Layer.provide(
							Socket.layerWebSocket(`ws://127.0.0.1:${address.port}/rpc`),
						),
						Layer.provide(Socket.layerWebSocketConstructorGlobal),
						Layer.provide(RpcSerialization.layerJson),
					),
				);
				const client = yield* RpcClient.make(WsRpcGroup).pipe(
					Effect.provide(clientContext),
				);
				expect((yield* client.GetProjects({})).projects).toEqual([]);
				const added = yield* client.AddProject({ directory });
				expect(added.addedSlug).toBeTruthy();
				expect((yield* client.GetProjects({})).projects).toMatchObject([
					{ slug: added.addedSlug, directory },
				]);
				expect(
					(yield* client.GetProjects({ projectSlug: "not-registered" }))
						.projects,
				).toHaveLength(1);
				expect(ensure).not.toHaveBeenCalled();
				expect(wait).not.toHaveBeenCalled();
				expect(touch).not.toHaveBeenCalled();
				expect(upgrades).toHaveBeenCalledTimes(1);
			}),
	);

	it.scoped.each(["/rpc", "/rpc?client=browser"])(
		"routes two projects and recovers from unavailable projects on one %s socket",
		(path) =>
			Effect.gen(function* () {
				const projects = ["project-a", "project-b", "unavailable"].map(
					(slug) => ({
						slug,
						title: slug,
						directory: `/tmp/${slug}`,
						lastUsed: 1,
					}),
				);
				const relays = new Map<
					string,
					ManagedRuntime.ManagedRuntime<unknown, unknown>
				>();
				const factory = vi.fn((slug: string) =>
					Effect.gen(function* () {
						if (slug === "unavailable")
							return yield* Effect.fail(new Error("startup failed"));
						const runtime = ManagedRuntime.make(
							Layer.merge(
								makeTestHandlerLayer({
									config: makeMockConfig({
										slug,
										getProjects: () =>
											projects.filter((project) => project.slug === slug),
									}),
								}),
								makeWsTransportLive({ noServer: true }),
							),
						);
						relays.set(slug, runtime);
						const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
							runtime,
						}).pipe(Effect.provide(runtime));
						return {
							slug,
							attach: () => () => {},
							wsHandler: {},
							rpcWsHandler,
							stop: async () => {
								await rpcWsHandler.drain();
								await runtime.dispose();
							},
						};
					}),
				);
				const server = yield* Effect.acquireRelease(
					Effect.async<Server, Error>((resume) => {
						const server = createServer();
						server.once("error", (error) => resume(Effect.fail(error)));
						server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
					}),
					(server) =>
						Effect.async<void>((resume) => {
							server.close(() => resume(Effect.void));
						}),
				);
				const upgrades = vi.fn();
				server.on("upgrade", upgrades);
				const routerLayer = WebSocketRelayRouterLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeProjectRegistryLive(projects),
							makeRelayCacheLive(factory),
							DaemonEventBusLive,
							ConfigPersistenceNoopLive,
						),
					),
				);
				const routerContext = yield* Layer.build(routerLayer);
				const router = yield* WebSocketRelayRouterTag.pipe(
					Effect.provide(routerContext),
				);
				const ensure = vi.fn(router.ensureRelayStarted);
				const wait = vi.fn(router.waitForRelay);
				const touch = vi.fn(router.touchLastUsed);
				yield* Layer.build(
					WebSocketRoutingLive.pipe(
						Layer.provide(makeDaemonRpcTestLayer()),
						Layer.provide(
							Layer.mergeAll(
								Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
								DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
								makeAuthManagerLive(
									new AuthManager({ getPinHash: () => null }),
								),
								Layer.succeed(WebSocketRelayRouterTag, {
									ensureRelayStarted: ensure,
									waitForRelay: wait,
									touchLastUsed: touch,
								}),
							),
						),
					),
				);
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("No TCP address");
				const clientContext = yield* Layer.build(
					RpcClient.layerProtocolSocket().pipe(
						Layer.provide(
							Socket.layerWebSocket(`ws://127.0.0.1:${address.port}${path}`),
						),
						Layer.provide(Socket.layerWebSocketConstructorGlobal),
						Layer.provide(RpcSerialization.layerJson),
					),
				);
				const client = yield* RpcClient.make(WsRpcGroup).pipe(
					Effect.provide(clientContext),
				);
				const results = yield* Effect.all(
					[
						client.GetCommands({ projectSlug: "project-a" }),
						client.GetCommands({ projectSlug: "project-b" }),
					],
					{ concurrency: 2 },
				);
				for (const [index, slug] of ["project-a", "project-b"].entries()) {
					expect(results[index]).toMatchObject({
						projectSlug: slug,
						commands: [],
					});
					expect(ensure).toHaveBeenCalledWith(slug);
					expect(wait).toHaveBeenCalledWith(slug, 10_000);
					expect(touch).toHaveBeenCalledWith(slug);
				}
				for (const slug of ["missing-project", "unavailable"]) {
					const result = yield* Effect.either(
						client.GetCommands({ projectSlug: slug }),
					);
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left).toBeInstanceOf(WsRpcError);
						expect(result.left.message).toContain(slug);
					}
				}
				// A disposed relay fails context acquisition without killing other requests.
				const firstRelay = relays.get("project-a");
				if (!firstRelay) throw new Error("Project A was not started");
				yield* firstRelay.disposeEffect;
				const disposed = yield* Effect.either(
					client.GetCommands({ projectSlug: "project-a" }),
				);
				expect(disposed._tag).toBe("Left");
				if (disposed._tag === "Left") {
					expect(disposed.left).toBeInstanceOf(WsRpcError);
					expect(disposed.left.message).toContain("project-a");
				}
				expect(
					yield* client.GetCommands({ projectSlug: "project-b" }),
				).toMatchObject({ projectSlug: "project-b", commands: [] });
				expect(upgrades).toHaveBeenCalledTimes(1);
				expect(factory.mock.calls.map(([slug]) => slug)).not.toContain(
					"missing-project",
				);
			}),
	);
});
