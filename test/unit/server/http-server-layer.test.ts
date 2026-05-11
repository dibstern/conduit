// ─── HTTP Server Layer Tests ────────────────────────────────────────────────
// Tests for the Effect-based HTTP server layer (http-server-layer.ts).
//
// Uses NodeHttpServer.layerTest to spin up a real HTTP server on a random port
// with an HttpClient that knows the server's address. This validates that
// the router is correctly wired through the server layer.
//
// Also tests the new routes added to effect-http-router.ts:
//   POST /api/push/unsubscribe
//   GET  /api/themes
//   GET  /api/setup-info

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	HttpApp,
	HttpClient,
	HttpClientRequest,
	HttpServer,
} from "@effect/platform";
import {
	NodeFileSystem,
	NodeHttpServer,
	NodePath,
} from "@effect/platform-node";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { AuthManagerTag } from "../../../src/lib/effect/auth-middleware.js";
import {
	HttpServerConfigTag,
	HttpServerLive,
} from "../../../src/lib/effect/http-server-layer.js";
import { StaticDirTag } from "../../../src/lib/effect/static-file-handler.js";
import {
	effectRouter,
	effectRouterWithCors,
	ProjectsProvider,
	PushProvider,
	type RouterProjectInfo,
	SetupInfoProvider,
	ThemeProvider,
} from "../../../src/lib/server/effect-http-router.js";

// ─── Test Data ─────────────────────────────────────────────────────────────

const testProjects: RouterProjectInfo[] = [
	{
		slug: "test-project",
		directory: "/tmp/test-project",
		title: "Test Project",
		status: "ready",
		clients: 2,
		sessions: 5,
		isProcessing: false,
	},
];

// ─── Test Layers ───────────────────────────────────────────────────────────

const TestProjectsLayer = Layer.succeed(ProjectsProvider, {
	getProjects: () => testProjects,
});

const TestPushLayer = Layer.succeed(PushProvider, {
	getPublicKey: () => "test-vapid-public-key",
	addSubscription: () => {},
	removeSubscription: () => {},
});

const TestThemeLayer = Layer.succeed(ThemeProvider, {
	loadThemes: async () => ({
		bundled: {
			"test-theme": {
				name: "Test Theme",
				variant: "dark" as const,
				base00: "000000",
				base01: "111111",
				base02: "222222",
				base03: "333333",
				base04: "444444",
				base05: "555555",
				base06: "666666",
				base07: "777777",
				base08: "888888",
				base09: "999999",
				base0A: "AAAAAA",
				base0B: "BBBBBB",
				base0C: "CCCCCC",
				base0D: "DDDDDD",
				base0E: "EEEEEE",
				base0F: "FFFFFF",
			},
		},
		custom: {},
	}),
});

let setupInfoPort = 9999;
let setupInfoIsTls = false;

const TestSetupInfoLayer = Layer.succeed(SetupInfoProvider, {
	getPort: () => setupInfoPort,
	getIsTls: () => setupInfoIsTls,
});

let staticDir = "";

beforeAll(async () => {
	staticDir = await mkdtemp(join(tmpdir(), "conduit-http-layer-"));
});

const baseRouterLayer = () =>
	Layer.mergeAll(
		Layer.succeed(AuthManagerTag, new AuthManager()),
		Layer.succeed(StaticDirTag, staticDir),
		NodeFileSystem.layer,
		NodePath.layer,
	);

// ─── Web Handler Helpers (for unit-style route tests) ──────────────────────

const disposers: Array<() => Promise<void>> = [];

// biome-ignore lint/suspicious/noExplicitAny: Layer type params vary per test
function tracked(layer: Layer.Layer<any, any, never>) {
	const h = HttpApp.toWebHandlerLayer(
		effectRouter,
		Layer.merge(layer, baseRouterLayer()),
	);
	disposers.push(h.dispose);
	return h.handler;
}

afterAll(async () => {
	await Promise.all(disposers.map((d) => d()));
	if (staticDir) await rm(staticDir, { recursive: true, force: true });
});

// ─── Route Tests: Push Unsubscribe ─────────────────────────────────────────

describe("Effect HTTP Router - Extended Routes", () => {
	describe("POST /api/push/unsubscribe", () => {
		it("removes subscription and returns ok", async () => {
			const removed: string[] = [];
			const trackingPushLayer = Layer.succeed(PushProvider, {
				getPublicKey: () => "key",
				addSubscription: () => {},
				removeSubscription: (endpoint: string) => {
					removed.push(endpoint);
				},
			});

			const handler = tracked(
				Layer.merge(TestProjectsLayer, trackingPushLayer),
			);
			const response = await handler(
				new Request("http://localhost/api/push/unsubscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						endpoint: "https://push.example.com/sub123",
					}),
				}),
			);

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body).toEqual({ ok: true });
			expect(removed).toEqual(["https://push.example.com/sub123"]);
		});

		it("returns 404 when PushProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/push/unsubscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						endpoint: "https://push.example.com/sub123",
					}),
				}),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});
	});

	// ─── Route Tests: Themes ───────────────────────────────────────────────

	describe("GET /api/themes", () => {
		it("returns themes when ThemeProvider present", async () => {
			const handler = tracked(Layer.merge(TestProjectsLayer, TestThemeLayer));
			const response = await handler(
				new Request("http://localhost/api/themes"),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				bundled: Record<string, unknown>;
				custom: Record<string, unknown>;
			};
			expect(body.bundled).toHaveProperty("test-theme");
			expect(body.custom).toEqual({});
		});

		it("returns 404 when ThemeProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/themes"),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});
	});

	// ─── Route Tests: Setup Info ────────────────────────────────────────────

	describe("GET /api/setup-info", () => {
		it("returns setup info when SetupInfoProvider present", async () => {
			setupInfoPort = 9999;
			setupInfoIsTls = false;
			const handler = tracked(
				Layer.merge(TestProjectsLayer, TestSetupInfoLayer),
			);
			const response = await handler(
				new Request("http://localhost:9999/api/setup-info"),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				httpsUrl: string;
				httpUrl: string;
				hasCert: boolean;
				lanMode: boolean;
			};
			expect(body.hasCert).toBe(false);
			expect(body.lanMode).toBe(false);
			expect(body.httpsUrl).toContain("https://");
			expect(body.httpUrl).toContain("http://");
		});

		it("reflects live SetupInfoProvider values", async () => {
			setupInfoPort = 8181;
			setupInfoIsTls = true;
			const handler = tracked(
				Layer.merge(TestProjectsLayer, TestSetupInfoLayer),
			);

			const first = await handler(
				new Request("http://localhost:9999/api/setup-info"),
			);
			const firstBody = (await first.json()) as {
				httpsUrl: string;
				hasCert: boolean;
			};
			expect(firstBody.httpsUrl).toContain(":8181");
			expect(firstBody.hasCert).toBe(true);

			setupInfoPort = 8282;
			setupInfoIsTls = false;
			const second = await handler(
				new Request("http://localhost:9999/api/setup-info"),
			);
			const secondBody = (await second.json()) as {
				httpsUrl: string;
				hasCert: boolean;
			};
			expect(secondBody.httpsUrl).toContain(":8282");
			expect(secondBody.hasCert).toBe(false);
		});

		it("respects ?mode=lan query parameter", async () => {
			setupInfoPort = 9999;
			setupInfoIsTls = false;
			const handler = tracked(
				Layer.merge(TestProjectsLayer, TestSetupInfoLayer),
			);
			const response = await handler(
				new Request("http://localhost:9999/api/setup-info?mode=lan"),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as { lanMode: boolean };
			expect(body.lanMode).toBe(true);
		});

		it("returns 404 when SetupInfoProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/setup-info"),
			);

			expect(response.status).toBe(404);
			const body = (await response.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});
	});
});

// ─── HTTP Server Layer Tests ───────────────────────────────────────────────

describe("HTTP Server Layer", () => {
	// The NodeHttpServer.layerTest provides:
	// 1. An HTTP server on port 0 (random)
	// 2. An HttpClient with the server URL prepended
	// 3. Platform context (FileSystem, Etag, Path)
	//
	// We combine this with HttpServer.serve(router) and our test service layers.

	const AllTestLayers = Layer.mergeAll(
		TestProjectsLayer,
		TestPushLayer,
		TestThemeLayer,
		TestSetupInfoLayer,
		baseRouterLayer(),
	);

	// Build a test layer: layerTest provides HttpServer + HttpClient,
	// HttpServer.serve wires the router into the server.
	const TestServerLayer = HttpServer.serve(effectRouterWithCors).pipe(
		Layer.provideMerge(NodeHttpServer.layerTest),
		Layer.provideMerge(AllTestLayers),
	);

	it.scoped("health endpoint responds via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* client.get("/health");
			expect(response.status).toBe(200);
			const data = (yield* response.json) as Record<string, unknown>;
			expect(data).toHaveProperty("ok", true);
			expect(data).toHaveProperty("projects", 1);
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("info endpoint responds via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* client.get("/info");
			expect(response.status).toBe(200);
			const data = (yield* response.json) as Record<string, unknown>;
			expect(data).toHaveProperty("version");
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("projects endpoint responds via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* client.get("/api/projects");
			expect(response.status).toBe(200);
			const data = (yield* response.json) as {
				projects: Array<Record<string, unknown>>;
				version: string;
			};
			expect(data.projects).toHaveLength(1);
			expect(data.projects[0]).toHaveProperty("slug", "test-project");
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("themes endpoint responds via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* client.get("/api/themes");
			expect(response.status).toBe(200);
			const data = (yield* response.json) as {
				bundled: Record<string, unknown>;
				custom: Record<string, unknown>;
			};
			expect(data.bundled).toHaveProperty("test-theme");
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("CORS headers present on responses", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* client.get("/info");
			expect(response.status).toBe(200);
			expect(response.headers["access-control-allow-origin"]).toBe("*");
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("push subscribe works via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* HttpClientRequest.post(
				"/api/push/subscribe",
			).pipe(
				HttpClientRequest.bodyJson({
					subscription: {
						endpoint: "https://push.example.com/sub",
						keys: { p256dh: "abc", auth: "def" },
					},
				}),
				Effect.flatMap(client.execute),
			);
			expect(response.status).toBe(200);
			const body = yield* response.json;
			expect(body).toEqual({ ok: true });
		}).pipe(Effect.provide(TestServerLayer)),
	);

	it.scoped("push unsubscribe works via real HTTP server", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;
			const response = yield* HttpClientRequest.post(
				"/api/push/unsubscribe",
			).pipe(
				HttpClientRequest.bodyJson({
					endpoint: "https://push.example.com/sub",
				}),
				Effect.flatMap(client.execute),
			);
			expect(response.status).toBe(200);
			const body = yield* response.json;
			expect(body).toEqual({ ok: true });
		}).pipe(Effect.provide(TestServerLayer)),
	);
});

// ─── HttpServerLive Layer Construction Test ────────────────────────────────

describe("HttpServerLive layer construction", () => {
	it.scoped("can construct and start a server on port 0", () =>
		Effect.gen(function* () {
			// Provide a minimal config with port 0 to let the OS pick a free port.
			const configLayer = Layer.succeed(HttpServerConfigTag, {
				port: 0,
				host: "127.0.0.1",
				tls: false,
				tlsCertPath: undefined,
				tlsKeyPath: undefined,
			});

			// HttpServerLive wires effectRouterWithCors into the server.
			// We need to provide all router dependencies.
			const fullLayer = HttpServerLive.pipe(
				Layer.provide(configLayer),
				Layer.provide(TestProjectsLayer),
				Layer.provide(baseRouterLayer()),
			);

			// Layer.build constructs the layer within the current scope,
			// verifying the server starts successfully. The scoped test
			// will tear it down when the scope closes.
			yield* Layer.build(fullLayer);
		}),
	);
});
