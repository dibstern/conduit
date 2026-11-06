import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	Cause,
	type Context,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	Ref,
	Stream,
} from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { SqlClient } from "effect/sql";
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
import {
	makeRelayCacheLive,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { SessionActivityTag } from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	ProjectRpcContextsTag,
	WebSocketRelayRouterLive,
	WebSocketRelayRouterTag,
	WebSocketRoutingLive,
} from "../../../src/lib/domain/server/Layers/ws-routing-layer.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { daemonStorePath } from "../../../src/lib/persistence/project-storage.js";
import { makeWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

const makeProjectStore = (
	configDir: string,
	slug: string,
	sessionId: string,
): void => {
	writeEventStore(
		daemonStorePath(configDir),
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql`INSERT INTO sessions (
				id, provider, title, status, created_at, updated_at, project_id
			) VALUES (${sessionId}, 'opencode', ${sessionId}, 'idle', 1, 1, ${slug})`,
		),
	);
};

type ProjectRpcContext = Effect.Success<
	ReturnType<ProjectRpcContextsTag["Service"]>
>;

/** Test projects run their RPCs on a stand-in relay's handler runtime. */
const standInProjectContexts = Effect.gen(function* () {
	const router = yield* WebSocketRelayRouterTag;
	const cache = yield* RelayCacheTag;
	return (slug: string) =>
		Effect.gen(function* () {
			yield* router.ensureRelayStarted(slug);
			const relay = yield* cache.get(slug);
			const context = relay.rpcWsHandler.context;
			if (!context) return yield* Effect.die("Stand-in relay has no context");
			// The stand-in runtime carries the handler services, not every project part.
			return (yield* context) as Context.Context<unknown> as ProjectRpcContext;
		}).pipe(
			// A disposed stand-in runtime dies; the RPC fails, as a closed project does.
			Effect.catchCause((cause) =>
				Effect.fail(
					new WsRpcError({
						message: `Project "${slug}" unavailable: ${Cause.pretty(cause)}`,
					}),
				),
			),
		);
});

describe("daemon shared RPC routing", () => {
	it.effect("routes ViewSession across projects on one daemon RPC socket", () =>
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
			makeProjectStore(root, "project-a", "session-a");
			makeProjectStore(root, "project-b", "session-b");
			const projects = [
				{
					slug: "project-a",
					title: "Project A",
					folders: [projectA] as const,
					lastUsed: 2,
				},
				{
					slug: "project-b",
					title: "Project B",
					folders: [projectB] as const,
					lastUsed: 1,
				},
			];
			const activities = new Map<string, SessionActivityTag["Service"]>();
			const startPolling = vi.fn();
			const factory = (slug: string) =>
				Effect.gen(function* () {
					const pollerManager = {
						on: vi.fn(),
						off: vi.fn(),
						isPolling: vi.fn(() => false),
						startPolling,
						stopPolling: vi.fn(),
						notifySSEEvent: vi.fn(),
					};
					const runtime = ManagedRuntime.make(
						Layer.mergeAll(
							makeTestHandlerLayer({
								config: makeMockConfig({ slug }),
								persistenceLayer: makePersistenceEffectLayer(
									daemonStorePath(root),
									slug,
								),
								pollerManager,
							}),
							makeWsTransportLive({ noServer: true }),
						),
					);
					const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
						runtime,
					}).pipe(Effect.provide(yield* runtime.contextEffect));
					activities.set(
						slug,
						yield* Effect.promise(() => runtime.runPromise(SessionActivityTag)),
					);
					return {
						slug,
						rpcWsHandler,
						syncGlobalSetting: () => Effect.void,
						refreshGlobalDefaults: () => Effect.void,
						stop: async () => {
							await rpcWsHandler.drain();
							await runtime.dispose();
						},
					};
				});

			const server = yield* Effect.acquireRelease(
				Effect.callback<Server, Error>((resume) => {
					const server = createServer();
					server.once("error", (error) => resume(Effect.fail(error)));
					server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
				}),
				(server) =>
					Effect.callback<void>((resume) => {
						server.close(() => resume(Effect.void));
					}),
			);
			const upgrades = vi.fn();
			server.on("upgrade", upgrades);
			const routerContext = yield* Layer.build(
				WebSocketRelayRouterLive.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeProjectRegistryLive(projects),
							makeRelayCacheLive(factory),
							DaemonEventBusLive,
							ConfigPersistenceNoopLive,
						),
					),
				),
			);
			const resolve = yield* standInProjectContexts.pipe(
				Effect.provide(routerContext),
			);
			yield* Layer.build(
				WebSocketRoutingLive.pipe(
					Layer.provide(
						makeDaemonRpcTestLayer(projects, factory, { configDir: root }),
					),
					Layer.provide(
						Layer.mergeAll(
							Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
							DaemonConfigRefLive(makeDaemonConfigFromOptions({ port: 0 })),
							makeAuthManagerLive(new AuthManager({ getPinHash: () => null })),
							Layer.succeed(ProjectRpcContextsTag)(resolve),
						),
					),
				),
			);
			const address = server.address();
			if (!address || typeof address === "string") {
				return yield* Effect.fail(new Error("No TCP address"));
			}
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
			yield* rpcClient.SyncInputDraft({
				key: { session: "session-b" },
				text: "saved draft",
			});
			expect(
				yield* rpcClient.ViewSession({
					sessionId: "session-b",
					originId: "daemon-client",
				}),
			).toMatchObject({ ok: true });
			expect(
				yield* Stream.runHead(
					rpcClient.SubscribeInputDraft({ key: { session: "session-b" } }),
				),
			).toEqual(
				Option.some({
					_tag: "synchronized",
					text: "saved draft",
					attachments: [],
				}),
			);
			for (const projectSlug of ["project-a", "project-b"]) {
				expect(yield* rpcClient.GetCommands({ projectSlug })).toMatchObject({
					projectSlug,
					commands: [],
				});
			}
			expect(upgrades).toHaveBeenCalledTimes(1);

			const activityA = activities.get("project-a");
			const activityB = activities.get("project-b");
			if (!activityA || !activityB) {
				return yield* Effect.fail(new Error("Expected both relays to start"));
			}
			expect(activityB.selectedSession("project-b", "daemon-client")).toBe(
				"session-b",
			);
			expect(activityA.selectedSession("project-a", "daemon-client")).toBe(
				undefined,
			);
			expect(startPolling).toHaveBeenCalledWith("session-b");
		}),
	);

	it.effect(
		"adds the first project over one daemon RPC socket without starting a relay",
		() =>
			Effect.gen(function* () {
				const directory = yield* Effect.acquireRelease(
					Effect.sync(() =>
						realpathSync(mkdtempSync(join(tmpdir(), "conduit-first-project-"))),
					),
					(path) =>
						Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const server = yield* Effect.acquireRelease(
					Effect.callback<Server, Error>((resume) => {
						const server = createServer();
						server.once("error", (error) => resume(Effect.fail(error)));
						server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
					}),
					(server) =>
						Effect.callback<void>((resume) => {
							server.close(() => resume(Effect.void));
						}),
				);
				const upgrades = vi.fn();
				server.on("upgrade", upgrades);
				const resolve = vi.fn(() => Effect.die("Must not resolve a project"));
				yield* Layer.build(
					WebSocketRoutingLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								makeDaemonRpcTestLayer(),
								Layer.effect(HttpServerRefTag, Ref.make<Server | null>(server)),
								makeAuthManagerLive(
									new AuthManager({ getPinHash: () => null }),
								),
								Layer.succeed(ProjectRpcContextsTag)(resolve),
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
				const added = yield* client.SaveProject({ folders: [directory] });
				expect(added.savedSlug).toBeTruthy();
				expect((yield* client.GetProjects({})).projects).toMatchObject([
					{ slug: added.savedSlug, folders: [directory] },
				]);
				expect(
					(yield* client.GetProjects({ projectSlug: "not-registered" }))
						.projects,
				).toHaveLength(1);
				expect(resolve).not.toHaveBeenCalled();
				expect(upgrades).toHaveBeenCalledTimes(1);
			}),
	);

	it.effect.each(["/rpc", "/rpc?client=browser"])(
		"routes two projects and recovers from unavailable projects on one %s socket",
		(path) =>
			Effect.gen(function* () {
				const projects = ["project-a", "project-b", "unavailable"].map(
					(slug) => ({
						slug,
						title: slug,
						folders: [`/tmp/${slug}`] as const,
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
									}),
									projectManagementService: {
										list: () =>
											Effect.succeed(
												projects.filter((project) => project.slug === slug),
											),
										save: () => Effect.die(new Error("unused save")),
										remove: () => Effect.die(new Error("unused remove")),
									},
								}),
								makeWsTransportLive({ noServer: true }),
							),
						);
						relays.set(slug, runtime);
						const rpcWsHandler = yield* makeWsRpcWebSocketHandler({
							runtime,
						}).pipe(Effect.provide(yield* runtime.contextEffect));
						return {
							slug,
							wsHandler: {},
							rpcWsHandler,
							syncGlobalSetting: () => Effect.void,
							refreshGlobalDefaults: () => Effect.void,
							stop: async () => {
								await rpcWsHandler.drain();
								await runtime.dispose();
							},
						};
					}),
				);
				const server = yield* Effect.acquireRelease(
					Effect.callback<Server, Error>((resume) => {
						const server = createServer();
						server.once("error", (error) => resume(Effect.fail(error)));
						server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
					}),
					(server) =>
						Effect.callback<void>((resume) => {
							server.close(() => resume(Effect.void));
						}),
				);
				const upgrades = vi.fn();
				server.on("upgrade", upgrades);
				const routerLayer = WebSocketRelayRouterLive.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeProjectRegistryLive(projects),
							makeRelayCacheLive(factory),
							DaemonEventBusLive,
							ConfigPersistenceNoopLive,
						),
					),
				);
				const routerContext = yield* Layer.build(routerLayer);
				const resolve = vi.fn(
					yield* standInProjectContexts.pipe(Effect.provide(routerContext)),
				);
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
								Layer.succeed(ProjectRpcContextsTag)(resolve),
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
					expect(resolve).toHaveBeenCalledWith(slug);
				}
				for (const slug of ["missing-project", "unavailable"]) {
					const result = yield* Effect.result(
						client.GetCommands({ projectSlug: slug }),
					);
					expect(result._tag).toBe("Failure");
					if (result._tag === "Failure") {
						expect(result.failure).toBeInstanceOf(WsRpcError);
						expect(result.failure.message).toContain(slug);
					}
				}
				// A disposed relay fails context acquisition without killing other requests.
				const firstRelay = relays.get("project-a");
				if (!firstRelay) throw new Error("Project A was not started");
				yield* firstRelay.disposeEffect;
				const disposed = yield* Effect.result(
					client.GetCommands({ projectSlug: "project-a" }),
				);
				expect(disposed._tag).toBe("Failure");
				if (disposed._tag === "Failure") {
					expect(disposed.failure).toBeInstanceOf(WsRpcError);
					expect(disposed.failure.message).toContain("project-a");
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
