import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, type Scope } from "effect";
import { expect } from "vitest";
import type { DaemonLifecycleContext } from "../../../src/lib/daemon/daemon-lifecycle.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";
import {
	makeHttpServerLive,
	makeOnboardingServerLive,
} from "../../../src/lib/effect/daemon-layers.js";
import { HttpServerRefLive } from "../../../src/lib/effect/relay-factory-layer.js";
import {
	EnsureCertsTag,
	TlsCertLive,
	TlsCertTag,
} from "../../../src/lib/effect/tls-cert-layer.js";
import { makeTestTlsCerts } from "../../helpers/tls-cert-fixture.js";

const fixtureCerts = makeTestTlsCerts();

const baseConfig: DaemonRuntimeConfig = {
	port: 0,
	host: "127.0.0.1",
	pinHash: null,
	tlsEnabled: false,
	keepAwake: false,
	keepAwakeCommand: undefined,
	keepAwakeArgs: undefined,
	shuttingDown: false,
	dismissedPaths: new Set(),
	startTime: Date.now(),
	hostExplicit: false,
	persistedSessionCounts: new Map(),
};

const NullTlsLayer = Layer.succeed(TlsCertTag, {
	certs: null,
	caRootPath: null,
	caCertDer: null,
	caCertPem: null,
});

function makeContext(): DaemonLifecycleContext {
	return {
		httpServer: null,
		upgradeServer: null,
		onboardingServer: null,
		ipcServer: null,
		ipcClients: new Set(),
		clientCount: 0,
		socketPath: "/tmp/conduit-http-server-live.sock",
		router: {
			async handleRequest(_req, res) {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("ok");
			},
		},
	};
}

function boundAddress(ctx: DaemonLifecycleContext): AddressInfo {
	const addr = ctx.httpServer?.address();
	if (!addr || typeof addr === "string") {
		throw new Error("HTTP server did not bind to an IP address");
	}
	return addr;
}

function onboardingPort(ctx: DaemonLifecycleContext): number {
	const addr = ctx.onboardingServer?.address();
	if (!addr || typeof addr === "string") {
		throw new Error("Onboarding server did not bind to an IP address");
	}
	return addr.port;
}

function httpGet(
	port: number,
	path: string,
): Promise<{
	status: number;
	body: Buffer;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const req = httpRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
			},
			(res) => {
				res.on("data", (chunk: Buffer) => {
					chunks.push(chunk);
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks),
						headers: res.headers,
					}),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function makeStaticDir(): string {
	return mkdtempSync(join(tmpdir(), "conduit-http-server-live-"));
}

function withStaticDir<A, E, R>(
	use: (staticDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> {
	return Effect.acquireRelease(Effect.sync(makeStaticDir), (staticDir) =>
		Effect.sync(() => rmSync(staticDir, { recursive: true, force: true })),
	).pipe(Effect.flatMap(use));
}

function activeTlsLayer(caCertDer: Buffer | null = null) {
	return Layer.succeed(TlsCertTag, {
		certs: fixtureCerts,
		caRootPath: null,
		caCertDer,
		caCertPem: null,
	});
}

describe("makeHttpServerLive", () => {
	it.scoped("binds to the host from DaemonConfigRefTag", () => {
		const ctx = makeContext();
		const configLayer = DaemonConfigRefLive({
			...baseConfig,
			host: "127.0.0.1",
			port: 0,
		});
		const testLayer = makeHttpServerLive(ctx).pipe(
			Layer.provideMerge(configLayer),
			Layer.provide(NullTlsLayer),
			Layer.provide(HttpServerRefLive),
		);

		return Effect.sync(() => {
			const addr = boundAddress(ctx);
			expect(addr.address).toBe("127.0.0.1");
			expect(addr.port).toBeGreaterThan(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer)));
	});

	it.scoped("writes the actual bound port back to the config Ref", () => {
		const ctx = makeContext();
		const configLayer = DaemonConfigRefLive({
			...baseConfig,
			port: 0,
		});
		const testLayer = makeHttpServerLive(ctx).pipe(
			Layer.provideMerge(configLayer),
			Layer.provide(NullTlsLayer),
			Layer.provide(HttpServerRefLive),
		);

		return Effect.gen(function* () {
			const ref = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(ref);
			const addr = boundAddress(ctx);

			expect(config.port).toBe(addr.port);
			expect(config.port).toBeGreaterThan(0);
		}).pipe(Effect.provide(Layer.fresh(testLayer)));
	});

	it.scoped(
		"uses TLS material from TlsCertTag and starts the upgrade server",
		() => {
			const ctx = makeContext();
			const configLayer = DaemonConfigRefLive({
				...baseConfig,
				port: 0,
				host: "127.0.0.1",
				tlsEnabled: true,
			});
			const tlsLayer = Layer.succeed(TlsCertTag, {
				certs: fixtureCerts,
				caRootPath: null,
				caCertDer: null,
				caCertPem: null,
			});
			const testLayer = makeHttpServerLive(ctx).pipe(
				Layer.provideMerge(configLayer),
				Layer.provide(tlsLayer),
				Layer.provide(HttpServerRefLive),
			);

			return Effect.sync(() => {
				expect(ctx.upgradeServer).not.toBeNull();
				expect(boundAddress(ctx).port).toBeGreaterThan(0);
			}).pipe(Effect.provide(Layer.fresh(testLayer)));
		},
	);

	it.scoped(
		"uses real TlsCertLive handoff and binds TLS to 0.0.0.0 when host was not explicit",
		() => {
			const ctx = makeContext();
			const configLayer = DaemonConfigRefLive({
				...baseConfig,
				host: "127.0.0.1",
				port: 0,
				tlsEnabled: true,
				hostExplicit: false,
			});
			const ensureCertsLayer = Layer.succeed(EnsureCertsTag, {
				ensureCerts: () => Effect.succeed(fixtureCerts),
			});
			const tlsLayer = TlsCertLive("/tmp/conduit-http-server-live").pipe(
				Layer.provideMerge(configLayer),
				Layer.provide(ensureCertsLayer),
			);
			const testLayer = makeHttpServerLive(ctx).pipe(
				Layer.provideMerge(tlsLayer),
				Layer.provide(HttpServerRefLive),
			);

			return Effect.gen(function* () {
				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				const addr = boundAddress(ctx);

				expect(config.host).toBe("0.0.0.0");
				expect(addr.address).toBe("0.0.0.0");
				expect(ctx.upgradeServer).not.toBeNull();
			}).pipe(Effect.provide(Layer.fresh(testLayer)));
		},
	);
});

describe("makeOnboardingServerLive", () => {
	it.scoped("skips when TlsCertTag has no certs", () => {
		return withStaticDir((staticDir) => {
			const ctx = makeContext();
			const configLayer = DaemonConfigRefLive(baseConfig);
			const testLayer = makeOnboardingServerLive(ctx, {
				staticDir,
				caRootPath: null,
				caCertDer: null,
			}).pipe(Layer.provideMerge(configLayer), Layer.provide(NullTlsLayer));

			return Effect.sync(() => {
				expect(ctx.onboardingServer).toBeNull();
			}).pipe(Effect.provide(Layer.fresh(testLayer)));
		});
	});

	it.scoped(
		"binds to the host from DaemonConfigRefTag when TLS is active",
		() => {
			return withStaticDir((staticDir) => {
				const ctx = makeContext();
				const configLayer = DaemonConfigRefLive({
					...baseConfig,
					host: "127.0.0.1",
					port: 0,
				});
				const testLayer = makeOnboardingServerLive(ctx, {
					staticDir,
					caRootPath: null,
					caCertDer: null,
				}).pipe(
					Layer.provideMerge(configLayer),
					Layer.provide(activeTlsLayer()),
				);

				return Effect.sync(() => {
					const addr = ctx.onboardingServer?.address();
					if (!addr || typeof addr === "string") {
						throw new Error("Onboarding server did not bind");
					}
					expect(addr.address).toBe("127.0.0.1");
					expect(addr.port).toBeGreaterThan(0);
				}).pipe(Effect.provide(Layer.fresh(testLayer)));
			});
		},
	);

	it.scoped("serves CA DER material from TlsCertTag", () => {
		return withStaticDir((staticDir) => {
			const ctx = makeContext();
			const caPayload = Buffer.from("test-ca-der");
			const configLayer = DaemonConfigRefLive({
				...baseConfig,
				host: "127.0.0.1",
				port: 0,
			});
			const testLayer = makeOnboardingServerLive(ctx, {
				staticDir,
				caRootPath: null,
				caCertDer: null,
			}).pipe(
				Layer.provideMerge(configLayer),
				Layer.provide(activeTlsLayer(caPayload)),
			);

			return Effect.gen(function* () {
				const response = yield* Effect.promise(() =>
					httpGet(onboardingPort(ctx), "/ca/download"),
				);
				expect(response.status).toBe(200);
				expect(response.body).toEqual(caPayload);
				expect(response.headers["content-type"]).toBe(
					"application/x-x509-ca-cert",
				);
			}).pipe(Effect.provide(Layer.fresh(testLayer)));
		});
	});

	it.scoped(
		"uses the actual main-server port in composed setup-info when HTTP started with port 0",
		() => {
			return withStaticDir((staticDir) => {
				const ctx = makeContext();
				const configLayer = DaemonConfigRefLive({
					...baseConfig,
					host: "127.0.0.1",
					port: 0,
					tlsEnabled: true,
				});
				const upstream = Layer.merge(configLayer, activeTlsLayer());
				const httpLayer = makeHttpServerLive(ctx).pipe(
					Layer.provideMerge(upstream),
					Layer.provide(HttpServerRefLive),
				);
				const testLayer = makeOnboardingServerLive(ctx, {
					staticDir,
					caRootPath: null,
					caCertDer: null,
				}).pipe(Layer.provideMerge(httpLayer));

				return Effect.gen(function* () {
					const mainPort = boundAddress(ctx).port;
					const response = yield* Effect.promise(() =>
						httpGet(onboardingPort(ctx), "/api/setup-info"),
					);
					const body = JSON.parse(response.body.toString("utf8")) as {
						httpsUrl: string;
					};

					expect(response.status).toBe(200);
					expect(body.httpsUrl).toContain(`:${mainPort}`);
					expect(body.httpsUrl).not.toContain(":0");
				}).pipe(Effect.provide(Layer.fresh(testLayer)));
			});
		},
	);
});
