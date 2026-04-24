// ─── Effect HTTP Router Tests ───────────────────────────────────────────────
// Tests for the Effect-based HTTP router (effect-http-router.ts).
// Uses HttpApp.toWebHandlerLayer to run route handlers against
// the Web Fetch API Request/Response, avoiding a real HTTP server.

import { HttpApp } from "@effect/platform";
import { Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import {
	CaCertProvider,
	effectRouter,
	effectRouterWithCors,
	HealthProvider,
	ProjectsProvider,
	PushProvider,
	type RouterProjectInfo,
} from "../../../src/lib/server/effect-http-router.js";

// ─── Test Layers ────────────────────────────────────────────────────────────

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

const TestProjectsLayer = Layer.succeed(ProjectsProvider, {
	getProjects: () => testProjects,
});

const TestHealthLayer = Layer.succeed(HealthProvider, {
	getHealthResponse: () => ({ ok: true, custom: "daemon-health" }),
});

const TestPushLayer = Layer.succeed(PushProvider, {
	getPublicKey: () => "test-vapid-public-key",
	addSubscription: () => {},
});

const TestCaCertLayer = Layer.succeed(CaCertProvider, {
	caCertDer: Buffer.from("fake-der-cert"),
	caRootPath: undefined,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a web handler from the Effect router with the given layers.
 * Returns { handler, dispose } where handler takes a Request → Promise<Response>.
 */
// biome-ignore lint/suspicious/noExplicitAny: Layer type params vary per test — `any` is intentional
function makeHandler(layer: Layer.Layer<any, any, never>) {
	return HttpApp.toWebHandlerLayer(effectRouter, layer);
}

async function jsonBody(response: Response): Promise<unknown> {
	return response.json();
}

// ─── Handlers with cleanup ─────────────────────────────────────────────────
// Track all handlers so they can be disposed after tests complete.

const disposers: Array<() => Promise<void>> = [];

// biome-ignore lint/suspicious/noExplicitAny: Layer type params vary per test — `any` is intentional
function tracked(layer: Layer.Layer<any, any, never>) {
	const h = makeHandler(layer);
	disposers.push(h.dispose);
	return h.handler;
}

afterAll(async () => {
	await Promise.all(disposers.map((d) => d()));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Effect HTTP Router", () => {
	// ── Health ─────────────────────────────────────────────────────────────

	describe("GET /health", () => {
		it("returns default health response when no HealthProvider", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(new Request("http://localhost/health"));

			expect(response.status).toBe(200);
			const body = (await jsonBody(response)) as Record<string, unknown>;
			expect(body).toHaveProperty("ok", true);
			expect(body).toHaveProperty("projects", 1);
			expect(body).toHaveProperty("uptime");
		});

		it("returns custom health response when HealthProvider is present", async () => {
			const handler = tracked(Layer.merge(TestProjectsLayer, TestHealthLayer));
			const response = await handler(new Request("http://localhost/health"));

			expect(response.status).toBe(200);
			const body = await jsonBody(response);
			expect(body).toEqual({ ok: true, custom: "daemon-health" });
		});
	});

	describe("GET /api/status", () => {
		it("returns same response as /health", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/status"),
			);

			expect(response.status).toBe(200);
			const body = (await jsonBody(response)) as Record<string, unknown>;
			expect(body).toHaveProperty("ok", true);
		});
	});

	// ── Info ──────────────────────────────────────────────────────────────

	describe("GET /info", () => {
		it("returns version info", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(new Request("http://localhost/info"));

			expect(response.status).toBe(200);
			const body = (await jsonBody(response)) as { version: string };
			expect(body).toHaveProperty("version");
			expect(typeof body.version).toBe("string");
		});
	});

	// ── Projects ─────────────────────────────────────────────────────────

	describe("GET /api/projects", () => {
		it("returns serialized project list with version", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/projects"),
			);

			expect(response.status).toBe(200);
			const body = (await jsonBody(response)) as {
				projects: Array<Record<string, unknown>>;
				version: string;
			};
			expect(body.projects).toHaveLength(1);
			expect(body.projects[0]).toEqual({
				slug: "test-project",
				path: "/tmp/test-project",
				title: "Test Project",
				status: "ready",
				sessions: 5,
				clients: 2,
				isProcessing: false,
			});
			expect(body).toHaveProperty("version");
		});
	});

	// ── Push VAPID key ───────────────────────────────────────────────────

	describe("GET /api/push/vapid-key", () => {
		it("returns VAPID public key when PushProvider present", async () => {
			const handler = tracked(Layer.merge(TestProjectsLayer, TestPushLayer));
			const response = await handler(
				new Request("http://localhost/api/push/vapid-key"),
			);

			expect(response.status).toBe(200);
			const body = await jsonBody(response);
			expect(body).toEqual({ publicKey: "test-vapid-public-key" });
		});

		it("returns 404 when PushProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/push/vapid-key"),
			);

			expect(response.status).toBe(404);
			const body = (await jsonBody(response)) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("NOT_AVAILABLE");
		});
	});

	// ── Push subscribe ───────────────────────────────────────────────────

	describe("POST /api/push/subscribe", () => {
		it("accepts valid subscription and returns ok", async () => {
			const subscriptions: Array<{ endpoint: string; sub: unknown }> = [];
			const trackingPushLayer = Layer.succeed(PushProvider, {
				getPublicKey: () => "key",
				addSubscription: (endpoint: string, sub: unknown) => {
					subscriptions.push({ endpoint, sub });
				},
			});

			const handler = tracked(
				Layer.merge(TestProjectsLayer, trackingPushLayer),
			);
			const response = await handler(
				new Request("http://localhost/api/push/subscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						subscription: {
							endpoint: "https://push.example.com/sub123",
							keys: { p256dh: "abc", auth: "def" },
						},
					}),
				}),
			);

			expect(response.status).toBe(200);
			const body = await jsonBody(response);
			expect(body).toEqual({ ok: true });
			expect(subscriptions).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — length asserted above
			expect(subscriptions[0]!.endpoint).toBe(
				"https://push.example.com/sub123",
			);
		});

		it("returns 404 when PushProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/api/push/subscribe", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						subscription: { endpoint: "https://example.com" },
					}),
				}),
			);

			expect(response.status).toBe(404);
		});
	});

	// ── CA certificate ───────────────────────────────────────────────────

	describe("GET /ca/download", () => {
		it("returns DER certificate when available", async () => {
			const handler = tracked(Layer.merge(TestProjectsLayer, TestCaCertLayer));
			const response = await handler(
				new Request("http://localhost/ca/download"),
			);

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"application/x-x509-ca-cert",
			);
			expect(response.headers.get("content-disposition")).toContain(
				"conduit-ca.cer",
			);
		});

		it("returns 404 when CaCertProvider absent", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/ca/download"),
			);

			expect(response.status).toBe(404);
			const body = (await jsonBody(response)) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_FOUND");
		});
	});

	// ── CORS ─────────────────────────────────────────────────────────────

	describe("CORS middleware", () => {
		it("effectRouterWithCors adds CORS headers to responses", async () => {
			const { handler, dispose } = HttpApp.toWebHandlerLayer(
				effectRouterWithCors,
				TestProjectsLayer,
			);
			disposers.push(dispose);

			const response = await handler(new Request("http://localhost/info"));

			expect(response.status).toBe(200);
			// CORS middleware should add the access-control-allow-origin header
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	// ── 404 for unknown routes ───────────────────────────────────────────

	describe("unknown routes", () => {
		it("returns 404 for unregistered paths", async () => {
			const handler = tracked(TestProjectsLayer);
			const response = await handler(
				new Request("http://localhost/does-not-exist"),
			);

			// HttpRouter returns a RouteNotFound error which results in 404
			expect(response.status).toBe(404);
		});
	});
});
