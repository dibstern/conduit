import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Ref } from "effect";
import { expect, vi } from "vitest";
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
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { makeWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("daemon shared RPC routing", () => {
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
							wsHandler: { handleUpgrade: vi.fn() },
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
