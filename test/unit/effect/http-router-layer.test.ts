import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { expect } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { TlsCertTag } from "../../../src/lib/domain/daemon/Layers/tls-cert-layer.js";
import { DaemonConfigRefLive } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonHandleTag } from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import {
	ProjectNotFound,
	ProjectRegistryTag,
	type ProjectState,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type Relay,
	RelayCacheTag,
	type RelayStatusSnapshot,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	DaemonHttpRequestHandlerTag,
	makeDaemonHttpRouterLive,
} from "../../../src/lib/domain/server/Layers/http-router-layer.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import type { PushSubscriptionData } from "../../../src/lib/server/push.js";

const baseConfig = {
	port: 2633,
	host: "127.0.0.1",
	pinHash: null,
	tlsEnabled: true,
	keepAwake: false,
	keepAwakeCommand: undefined,
	keepAwakeArgs: undefined,
	shuttingDown: false,
	dismissedPaths: new Set<string>(),
	startTime: Date.now(),
	hostExplicit: false,
	persistedSessionCounts: new Map<string, number>(),
};

const startServer = (handler: {
	readonly handleRequest: (
		req: IncomingMessage,
		res: ServerResponse,
	) => Promise<void>;
}) =>
	Effect.acquireRelease(
		Effect.async<{ readonly server: Server; readonly port: number }>(
			(resume) => {
				const server = createServer((req, res) => {
					void handler.handleRequest(req, res);
				});
				server.listen(0, "127.0.0.1", () => {
					const address = server.address() as AddressInfo;
					resume(Effect.succeed({ server, port: address.port }));
				});
			},
		),
		({ server }) =>
			Effect.async<void>((resume) => {
				server.close(() => resume(Effect.void));
			}),
	);

const makeStaticDir = Effect.acquireRelease(
	Effect.sync(() => {
		const staticDir = mkdtempSync(join(tmpdir(), "conduit-http-router-"));
		writeFileSync(join(staticDir, "index.html"), "<html>app</html>");
		return staticDir;
	}),
	(staticDir) =>
		Effect.sync(() => {
			rmSync(staticDir, { recursive: true, force: true });
		}),
);

const daemonHandleStub = Layer.succeed(DaemonHandleTag, {
	port: Effect.succeed(2633),
	addProject: () => Effect.die("unused"),
	removeProject: (slug: string) => Effect.fail(new ProjectNotFound({ slug })),
	getStatus: () =>
		Effect.succeed({
			ok: true,
			uptime: 0,
			port: 2633,
			host: "127.0.0.1",
			projectCount: 0,
			sessionCount: 0,
			clientCount: 0,
			pinEnabled: false,
			tlsEnabled: true,
			keepAwake: false,
			projects: [],
		}),
	getProjects: () => Effect.succeed([]),
});

const relayWithSnapshot = (
	slug: string,
	snapshot: RelayStatusSnapshot,
): Relay => ({
	slug,
	wsHandler: { handleUpgrade: () => {} },
	rpcWsHandler: { handleUpgrade: () => {} },
	getStatusSnapshot: () => snapshot,
	stop: () => {},
});

const makeDaemonRouterLayer = (
	staticDir: string,
	options: {
		readonly projects: ReadonlyArray<readonly [string, ProjectState]>;
		readonly relaySnapshots?: ReadonlyMap<string, RelayStatusSnapshot>;
		readonly persistedSessionCounts?: ReadonlyMap<string, number>;
		readonly caCertDer?: Buffer;
		readonly pushManager?: {
			readonly getPublicKey: () => string | null;
			readonly addSubscription: (
				endpoint: string,
				subscription: PushSubscriptionData,
			) => void;
			readonly removeSubscription: (endpoint: string) => void;
			readonly sendToAll: (payload: unknown) => Promise<void>;
		};
	},
) =>
	makeDaemonHttpRouterLive(staticDir).pipe(
		Layer.provideMerge(makeAuthManagerLive(new AuthManager())),
		Layer.provideMerge(
			DaemonConfigRefLive({
				...baseConfig,
				persistedSessionCounts: new Map(options.persistedSessionCounts ?? []),
			}),
		),
		Layer.provideMerge(
			Layer.succeed(TlsCertTag, {
				certs: null,
				caRootPath: null,
				caCertDer: options.caCertDer ?? null,
				caCertPem: null,
			}),
		),
		Layer.provideMerge(daemonHandleStub),
		Layer.provideMerge(
			Layer.effect(
				ProjectRegistryTag,
				Ref.make(HashMap.fromIterable(options.projects)),
			),
		),
		Layer.provideMerge(
			Layer.succeed(RelayCacheTag, {
				get: () => Effect.die("daemon project listing must not start relays"),
				peek: (slug: string) => {
					const snapshot = options.relaySnapshots?.get(slug);
					return Effect.succeed(
						snapshot
							? Option.some(relayWithSnapshot(slug, snapshot))
							: Option.none<Relay>(),
					);
				},
				invalidate: () => Effect.void,
			}),
		),
		Layer.provideMerge(
			Layer.succeed(PushManagerTag, {
				subscribe: () => Effect.void,
				unsubscribe: () => Effect.void,
				broadcast: () => Effect.void,
				getPublicKey: Effect.succeed(
					options.pushManager?.getPublicKey() ?? undefined,
				),
				addSubscription: (endpoint, subscription) =>
					Effect.sync(() =>
						options.pushManager?.addSubscription(endpoint, subscription),
					),
				removeSubscription: (endpoint) =>
					Effect.sync(() => options.pushManager?.removeSubscription(endpoint)),
				sendToAll: (payload) =>
					Effect.sync(() => {
						void options.pushManager?.sendToAll(payload);
					}),
				getLegacyManager: Effect.succeed(
					options.pushManager
						? Option.some(options.pushManager)
						: Option.none(),
				),
			}),
		),
	);

describe("makeDaemonHttpRouterLive", () => {
	it.scoped("serves daemon CA DER material from TlsCertTag", () =>
		Effect.gen(function* () {
			const staticDir = yield* makeStaticDir;
			const caPayload = Buffer.from("daemon-router-ca-der");
			const routerLayer = makeDaemonRouterLayer(staticDir, {
				projects: [],
				caCertDer: caPayload,
			});

			yield* Effect.gen(function* () {
				const handler = yield* DaemonHttpRequestHandlerTag;
				const { port } = yield* startServer(handler);

				const response = yield* Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${port}/ca/download`),
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toBe(
					"application/x-x509-ca-cert",
				);
				const body = Buffer.from(
					yield* Effect.tryPromise(() => response.arrayBuffer()),
				);
				expect(body).toEqual(caPayload);
			}).pipe(Effect.provide(Layer.fresh(routerLayer)));
		}),
	);

	it.scoped("serves daemon themes from the production theme loader", () =>
		Effect.gen(function* () {
			const staticDir = yield* makeStaticDir;
			const routerLayer = makeDaemonRouterLayer(staticDir, { projects: [] });

			yield* Effect.gen(function* () {
				const handler = yield* DaemonHttpRequestHandlerTag;
				const { port } = yield* startServer(handler);

				const response = yield* Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${port}/api/themes`),
				);
				expect(response.status).toBe(200);
				const body = (yield* Effect.tryPromise(() =>
					response.json(),
				)) as unknown;
				expect(body).toMatchObject({
					bundled: expect.any(Object),
					custom: expect.any(Object),
				});
			}).pipe(Effect.provide(Layer.fresh(routerLayer)));
		}),
	);

	it.scoped(
		"serves daemon project list from Effect-owned registry and relay snapshots",
		() =>
			Effect.gen(function* () {
				const staticDir = yield* makeStaticDir;
				const routerLayer = makeDaemonRouterLayer(staticDir, {
					projects: [
						[
							"alpha",
							{
								_tag: "Ready",
								project: {
									slug: "alpha",
									directory: "/work/alpha",
									title: "Alpha",
									lastUsed: 200,
								},
							},
						],
						[
							"broken",
							{
								_tag: "Error",
								project: {
									slug: "broken",
									directory: "/work/broken",
									title: "Broken",
									lastUsed: 100,
								},
								error: "relay failed",
							},
						],
					],
					relaySnapshots: new Map([
						["alpha", { sessionCount: 7, clients: 3, isProcessing: true }],
					]),
					persistedSessionCounts: new Map([["broken", 5]]),
				});

				yield* Effect.gen(function* () {
					const handler = yield* DaemonHttpRequestHandlerTag;
					const { port } = yield* startServer(handler);

					const response = yield* Effect.tryPromise(() =>
						fetch(`http://127.0.0.1:${port}/api/projects`),
					);
					expect(response.status).toBe(200);
					const body = (yield* Effect.tryPromise(() => response.json())) as {
						projects: Array<{
							slug: string;
							path: string;
							title: string;
							status: string;
							error?: string;
							sessions: number;
							clients: number;
							isProcessing: boolean;
						}>;
					};
					expect(body.projects).toEqual([
						{
							slug: "alpha",
							path: "/work/alpha",
							title: "Alpha",
							status: "ready",
							sessions: 7,
							clients: 3,
							isProcessing: true,
						},
						{
							slug: "broken",
							path: "/work/broken",
							title: "Broken",
							status: "error",
							error: "relay failed",
							sessions: 5,
							clients: 0,
							isProcessing: false,
						},
					]);
				}).pipe(Effect.provide(Layer.fresh(routerLayer)));
			}),
	);

	it.scoped(
		"uses daemon-owned projects for root redirect and project status",
		() =>
			Effect.gen(function* () {
				const staticDir = yield* makeStaticDir;
				const routerLayer = makeDaemonRouterLayer(staticDir, {
					projects: [
						[
							"solo",
							{
								_tag: "Ready",
								project: {
									slug: "solo",
									directory: "/work/solo",
									title: "Solo",
									lastUsed: 1,
								},
							},
						],
					],
				});

				yield* Effect.gen(function* () {
					const handler = yield* DaemonHttpRequestHandlerTag;
					const { port } = yield* startServer(handler);

					const rootResponse = yield* Effect.tryPromise(() =>
						fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }),
					);
					expect(rootResponse.status).toBe(302);
					expect(rootResponse.headers.get("location")).toBe("/p/solo/");

					const statusResponse = yield* Effect.tryPromise(() =>
						fetch(`http://127.0.0.1:${port}/p/solo/api/status`),
					);
					expect(statusResponse.status).toBe(200);
					expect(yield* Effect.tryPromise(() => statusResponse.json())).toEqual(
						{
							status: "ready",
						},
					);

					const missingResponse = yield* Effect.tryPromise(() =>
						fetch(`http://127.0.0.1:${port}/p/missing/api/status`),
					);
					expect(missingResponse.status).toBe(404);
					expect(
						yield* Effect.tryPromise(() => missingResponse.json()),
					).toEqual({
						error: {
							code: "NOT_FOUND",
							message: 'Project "missing" not found',
						},
					});
				}).pipe(Effect.provide(Layer.fresh(routerLayer)));
			}),
	);

	it.scoped("serves push routes from the Effect-owned push manager", () =>
		Effect.gen(function* () {
			const staticDir = yield* makeStaticDir;
			const added: Array<{
				readonly endpoint: string;
				readonly subscription: PushSubscriptionData;
			}> = [];
			const removed: string[] = [];
			const routerLayer = makeDaemonRouterLayer(staticDir, {
				projects: [],
				pushManager: {
					getPublicKey: () => "daemon-vapid-key",
					addSubscription: (endpoint, subscription) => {
						added.push({ endpoint, subscription });
					},
					removeSubscription: (endpoint) => {
						removed.push(endpoint);
					},
					sendToAll: async () => {},
				},
			});

			yield* Effect.gen(function* () {
				const handler = yield* DaemonHttpRequestHandlerTag;
				const { port } = yield* startServer(handler);

				const keyResponse = yield* Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${port}/api/push/vapid-key`),
				);
				expect(keyResponse.status).toBe(200);
				expect(yield* Effect.tryPromise(() => keyResponse.json())).toEqual({
					publicKey: "daemon-vapid-key",
				});

				const subscribeResponse = yield* Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${port}/api/push/subscribe`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							subscription: {
								endpoint: "https://push.example/sub",
								keys: { p256dh: "p256dh", auth: "auth" },
							},
						}),
					}),
				);
				expect(subscribeResponse.status).toBe(200);
				expect(added).toEqual([
					{
						endpoint: "https://push.example/sub",
						subscription: {
							endpoint: "https://push.example/sub",
							keys: { p256dh: "p256dh", auth: "auth" },
						},
					},
				]);

				const unsubscribeResponse = yield* Effect.tryPromise(() =>
					fetch(`http://127.0.0.1:${port}/api/push/unsubscribe`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ endpoint: "https://push.example/sub" }),
					}),
				);
				expect(unsubscribeResponse.status).toBe(200);
				expect(removed).toEqual(["https://push.example/sub"]);
			}).pipe(Effect.provide(Layer.fresh(routerLayer)));
		}),
	);
});
