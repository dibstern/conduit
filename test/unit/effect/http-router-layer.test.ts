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
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { TlsCertTag } from "../../../src/lib/domain/daemon/Layers/tls-cert-layer.js";
import { DaemonConfigRefLive } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonHandleTag } from "../../../src/lib/domain/daemon/Services/daemon-handle.js";
import { ProjectNotFound } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { makeAuthManagerLive } from "../../../src/lib/domain/server/Layers/auth-middleware.js";
import {
	DaemonHttpRequestHandlerTag,
	makeDaemonHttpRouterLive,
} from "../../../src/lib/domain/server/Layers/http-router-layer.js";

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

describe("makeDaemonHttpRouterLive", () => {
	it.scoped("serves daemon CA DER material from TlsCertTag", () =>
		Effect.gen(function* () {
			const staticDir = yield* makeStaticDir;
			const caPayload = Buffer.from("daemon-router-ca-der");
			const routerLayer = makeDaemonHttpRouterLive({
				staticDir,
				getProjects: () => [],
				pushManager: null,
			}).pipe(
				Layer.provideMerge(makeAuthManagerLive(new AuthManager())),
				Layer.provideMerge(DaemonConfigRefLive(baseConfig)),
				Layer.provideMerge(
					Layer.succeed(TlsCertTag, {
						certs: null,
						caRootPath: null,
						caCertDer: caPayload,
						caCertPem: null,
					}),
				),
				Layer.provideMerge(
					Layer.succeed(DaemonHandleTag, {
						port: Effect.succeed(2633),
						addProject: () => Effect.die("unused"),
						removeProject: (slug: string) =>
							Effect.fail(new ProjectNotFound({ slug })),
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
					}),
				),
			);

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
			const routerLayer = makeDaemonHttpRouterLive({
				staticDir,
				getProjects: () => [],
				pushManager: null,
			}).pipe(
				Layer.provideMerge(makeAuthManagerLive(new AuthManager())),
				Layer.provideMerge(DaemonConfigRefLive(baseConfig)),
				Layer.provideMerge(
					Layer.succeed(TlsCertTag, {
						certs: null,
						caRootPath: null,
						caCertDer: null,
						caCertPem: null,
					}),
				),
				Layer.provideMerge(
					Layer.succeed(DaemonHandleTag, {
						port: Effect.succeed(2633),
						addProject: () => Effect.die("unused"),
						removeProject: (slug: string) =>
							Effect.fail(new ProjectNotFound({ slug })),
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
					}),
				),
			);

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
});
