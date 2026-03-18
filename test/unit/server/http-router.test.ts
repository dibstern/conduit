// ─── HTTP Router Tests ───────────────────────────────────────────────────────
// Tests for the RequestRouter class extracted from server.ts and daemon.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import {
	MIME_TYPES,
	RequestRouter,
	type RequestRouterDeps,
	type RouterProject,
} from "../../../src/lib/server/http-router.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

// Shared temp static directory with index.html for SPA-shell-serving tests.
// Without this, tests fall back to dist/frontend/ which only exists after a build,
// causing failures in CI where tests run before the build step.
const sharedStaticDir = mkdtempSync(join(tmpdir(), "router-static-"));
writeFileSync(
	join(sharedStaticDir, "index.html"),
	"<!DOCTYPE html><html><body>OpenCode Relay</body></html>",
	"utf-8",
);

let nextPort = 18000;
function getPort(): number {
	return nextPort++;
}

/** Create a real HTTP server backed by a RequestRouter for integration testing. */
function createTestServer(overrides: Partial<RequestRouterDeps> = {}): {
	server: Server;
	router: RequestRouter;
	port: number;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	url: (path: string) => string;
} {
	const port = getPort();
	const staticDir =
		overrides.staticDir ?? join(process.cwd(), "dist", "frontend");
	const auth = overrides.auth ?? new AuthManager();
	const projects: RouterProject[] = [];

	const deps: RequestRouterDeps = {
		auth,
		staticDir,
		getProjects: overrides.getProjects ?? (() => projects),
		port,
		isTls: overrides.isTls ?? false,
		...(overrides.pushManager != null && {
			pushManager: overrides.pushManager,
		}),
		...(overrides.authExemptPaths != null && {
			authExemptPaths: overrides.authExemptPaths,
		}),
		...(overrides.getHealthResponse != null && {
			getHealthResponse: overrides.getHealthResponse,
		}),
		...(overrides.onProjectApiRequest != null && {
			onProjectApiRequest: overrides.onProjectApiRequest,
		}),
		...(overrides.caRootPath != null && {
			caRootPath: overrides.caRootPath,
		}),
	};

	const router = new RequestRouter(deps);
	const server = createServer((req, res) => {
		router.handleRequest(req, res).catch((err) => {
			console.error("[test] Request error:", err);
			if (!res.headersSent) {
				res.writeHead(500);
				res.end("Internal Server Error");
			}
		});
	});

	return {
		server,
		router,
		port,
		start: () =>
			new Promise<void>((resolve, reject) => {
				server.on("error", reject);
				server.listen(port, "127.0.0.1", () => resolve());
			}),
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
		url: (path: string) => `http://127.0.0.1:${port}${path}`,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MIME_TYPES", () => {
	it("exports a complete map with all required extensions", () => {
		const required = [
			".html",
			".css",
			".js",
			".mjs",
			".json",
			".png",
			".jpg",
			".jpeg",
			".gif",
			".svg",
			".ico",
			".woff",
			".woff2",
			".ttf",
			".webp",
			".webmanifest",
			".map",
		];
		for (const ext of required) {
			expect(MIME_TYPES[ext]).toBeDefined();
			expect(typeof MIME_TYPES[ext]).toBe("string");
		}
	});

	it("has correct content types for key extensions", () => {
		expect(MIME_TYPES[".html"]).toBe("text/html; charset=utf-8");
		expect(MIME_TYPES[".json"]).toBe("application/json");
		expect(MIME_TYPES[".js"]).toBe("application/javascript; charset=utf-8");
		expect(MIME_TYPES[".svg"]).toBe("image/svg+xml");
		expect(MIME_TYPES[".webmanifest"]).toBe("application/manifest+json");
	});
});

describe("RequestRouter", () => {
	let testServer: ReturnType<typeof createTestServer>;

	afterEach(async () => {
		if (testServer) {
			await testServer.stop();
		}
	});

	// ─── CORS ────────────────────────────────────────────────────────────

	describe("CORS headers", () => {
		it("OPTIONS returns 204 with CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/health"), {
				method: "OPTIONS",
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
			expect(res.headers.get("access-control-allow-headers")).toContain(
				"X-Relay-Pin",
			);
		});

		it("all responses include CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
		});
	});

	// ─── Info endpoint ───────────────────────────────────────────────────

	describe("/info endpoint", () => {
		it("returns version JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { version: string };
			expect(body.version).toBeDefined();
			expect(typeof body.version).toBe("string");
		});

		it("has CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/info"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	// ─── Health endpoint ─────────────────────────────────────────────────

	describe("/health endpoint", () => {
		it("returns default health response", async () => {
			const projects: RouterProject[] = [
				{ slug: "a", directory: "/tmp/a", title: "A" },
				{ slug: "b", directory: "/tmp/b", title: "B" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ok: boolean;
				projects: number;
				uptime: number;
			};
			expect(body.ok).toBe(true);
			expect(body.projects).toBe(2);
			expect(typeof body.uptime).toBe("number");
		});

		it("/api/status also returns health response", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
		});

		it("uses custom getHealthResponse when provided", async () => {
			testServer = createTestServer({
				getHealthResponse: () => ({
					ok: true,
					custom: "status",
					projectCount: 42,
				}),
			});
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			const body = (await res.json()) as {
				ok: boolean;
				custom: string;
				projectCount: number;
			};
			expect(body.custom).toBe("status");
			expect(body.projectCount).toBe(42);
		});
	});

	// ─── Projects API ────────────────────────────────────────────────────

	describe("/api/projects", () => {
		it("returns empty project list", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				projects: unknown[];
				version: string;
			};
			expect(body.projects).toEqual([]);
			expect(typeof body.version).toBe("string");
		});

		it("includes error field for error-state projects", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: { slug: string; error?: string }[];
			};
			expect(body.projects[0]?.error).toBe("Connection refused");
		});

		it("includes status field in response", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
				{
					slug: "live",
					directory: "/tmp/live",
					title: "Live",
					status: "ready",
					clients: 2,
					sessions: 5,
					isProcessing: true,
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{
					slug: string;
					status: string;
					sessions: number;
					clients: number;
					isProcessing: boolean;
				}>;
			};
			const starting = body.projects.find((p) => p.slug === "starting");
			const live = body.projects.find((p) => p.slug === "live");
			expect(starting?.status).toBe("registering");
			expect(live?.status).toBe("ready");
			expect(live?.sessions).toBe(5);
			expect(live?.clients).toBe(2);
			expect(live?.isProcessing).toBe(true);
		});

		it("defaults status to ready when not provided", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{ slug: string; status: string }>;
			};
			expect(body.projects[0]?.status).toBe("ready");
		});

		it("returns registered projects", async () => {
			const projects: RouterProject[] = [
				{ slug: "app-1", directory: "/tmp/app-1", title: "App 1" },
				{ slug: "app-2", directory: "/tmp/app-2", title: "App 2" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: { slug: string; title?: string }[];
			};
			expect(body.projects.length).toBe(2);
			expect(body.projects.map((p) => p.slug)).toContain("app-1");
			expect(body.projects.map((p) => p.slug)).toContain("app-2");
		});
	});

	// ─── Project routes ──────────────────────────────────────────────────

	describe("Project routes /p/{slug}/...", () => {
		it("returns 404 JSON for unknown slugs", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/p/nonexistent/"));
			expect(res.status).toBe(404);
			const body = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("NOT_FOUND");
			expect(body.error.message).toContain("nonexistent");
		});
	});

	// ─── Per-project status API ─────────────────────────────────────────

	describe("/p/:slug/api/status", () => {
		it("returns ready status for a ready project", async () => {
			const projects: RouterProject[] = [
				{
					slug: "my-app",
					directory: "/tmp/my-app",
					title: "My App",
					status: "ready",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/my-app/api/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("ready");
			expect(body.error).toBeUndefined();
		});

		it("returns registering status", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/starting/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("registering");
		});

		it("returns error status with error message", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/broken/api/status"));
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("error");
			expect(body.error).toBe("Connection refused");
		});

		it("returns 404 for unknown slug", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/p/ghost/api/status"));
			expect(res.status).toBe(404);
		});

		it("returns JSON 401 when PIN set and unauthenticated", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				getProjects: () => [
					{
						slug: "secure",
						directory: "/tmp/secure",
						title: "Secure",
						status: "ready",
					},
				],
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/secure/api/status"));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("AUTH_REQUIRED");
		});

		it("defaults status to ready when project has no status field", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/legacy/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("ready");
		});
	});

	// ─── Root routing ────────────────────────────────────────────────────

	describe("Root routing", () => {
		it("single project → redirect to /p/{slug}/", async () => {
			const projects: RouterProject[] = [
				{ slug: "my-app", directory: "/tmp/my-app", title: "My App" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/"), {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/p/my-app/");
		});

		it("no projects → serves SPA shell", async () => {
			testServer = createTestServer({ staticDir: sharedStaticDir });
			await testServer.start();

			const res = await fetch(testServer.url("/"));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("<!DOCTYPE html>");
		});
	});

	// ─── Auth gate ───────────────────────────────────────────────────────

	describe("Auth gate", () => {
		it("redirects browser routes to /auth when PIN is set", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			const projects: RouterProject[] = [
				{ slug: "proj", directory: "/tmp/proj", title: "Proj" },
			];
			testServer = createTestServer({
				auth,
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/"), {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/auth");
		});

		it("returns JSON 401 for API routes when not authenticated", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			expect(res.status).toBe(401);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("AUTH_REQUIRED");
		});

		it("exempts paths in authExemptPaths", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				authExemptPaths: ["/health", "/setup"],
			});
			await testServer.start();

			// /health should be accessible without auth
			const res = await fetch(testServer.url("/health"));
			expect(res.status).toBe(200);
		});

		it("exempts /api/setup-info when in authExemptPaths", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				authExemptPaths: ["/setup", "/api/setup-info"],
			});
			await testServer.start();

			// /api/setup-info should be accessible without auth
			const res = await fetch(testServer.url("/api/setup-info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { hasCert: boolean };
			expect(body).toHaveProperty("hasCert");
		});
	});

	// ─── Setup info ──────────────────────────────────────────────────────

	describe("/api/setup-info", () => {
		it("returns setup configuration JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/setup-info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				httpsUrl: string;
				httpUrl: string;
				hasCert: boolean;
				lanMode: boolean;
			};
			expect(body.httpsUrl).toContain("https://");
			expect(body.httpUrl).toContain("http://");
			expect(body.hasCert).toBe(false);
			expect(body.lanMode).toBe(false);
		});
	});

	// ─── Auth endpoint ───────────────────────────────────────────────────

	describe("POST /auth", () => {
		it("correct PIN returns cookie", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "5678" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
			expect(res.headers.get("set-cookie")).toBeTruthy();
		});

		it("wrong PIN returns 401", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "0000" }),
			});
			expect(res.status).toBe(401);
		});

		it("invalid JSON returns 400", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json{{{",
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("BAD_REQUEST");
		});
	});

	// ─── Static file serving ─────────────────────────────────────────────

	describe("Static file serving", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "router-static-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<!DOCTYPE html><html><body>Test App</body></html>",
			);
			writeFileSync(join(tmpDir, "style.css"), "body { color: red; }");
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("serves static files with correct MIME types", async () => {
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/style.css"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
			const body = await res.text();
			expect(body).toContain("body { color: red; }");
		});

		it("SPA fallback serves index.html for unknown paths", async () => {
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/some/unknown/path"));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Test App");
		});

		it("returns 404 when no index.html exists", async () => {
			const emptyDir = mkdtempSync(join(tmpdir(), "router-empty-"));
			testServer = createTestServer({ staticDir: emptyDir });
			await testServer.start();

			const res = await fetch(testServer.url("/nonexistent.js"));
			expect(res.status).toBe(404);

			rmSync(emptyDir, { recursive: true, force: true });
		});

		it("uses immutable cache for hash-named assets", async () => {
			writeFileSync(join(tmpDir, "app.a1b2c3d4.js"), "console.log('hello');");
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/app.a1b2c3d4.js"));
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toContain("immutable");
		});
	});

	// ─── Theme list API ─────────────────────────────────────────────────

	describe("/api/themes", () => {
		it("returns bundled themes as JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/themes"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");

			const body = (await res.json()) as {
				bundled: Record<string, { name: string; variant: string }>;
				custom: Record<string, unknown>;
			};
			expect(body.bundled).toBeDefined();
			expect(body.custom).toBeDefined();
			// At least 22 bundled themes
			expect(Object.keys(body.bundled).length).toBeGreaterThanOrEqual(22);
			// Spot-check a known theme
			expect(body.bundled["claude"]).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(body.bundled["claude"]!.name).toBe("Claude Dark");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(body.bundled["claude"]!.variant).toBe("dark");
		});

		it("includes CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/themes"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	// ─── CA download ─────────────────────────────────────────────────────

	describe("/ca/download", () => {
		it("returns 404 when no caRootPath is configured", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/ca/download"));
			expect(res.status).toBe(404);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it("serves PEM file when caRootPath is set", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "router-ca-"));
			const caPath = join(tmpDir, "ca.pem");
			writeFileSync(
				caPath,
				"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
			);
			testServer = createTestServer({ caRootPath: caPath });
			await testServer.start();

			const res = await fetch(testServer.url("/ca/download"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/x-pem-file");
			const body = await res.text();
			expect(body).toContain("-----BEGIN CERTIFICATE-----");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	// ─── checkAuth (public method) ───────────────────────────────────────

	describe("checkAuth", () => {
		it("returns true when no PIN is set (auth.hasPin false)", async () => {
			const auth = new AuthManager();
			testServer = createTestServer({ auth });
			await testServer.start();

			// Authenticate and get cookie
			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "" }),
			});
			expect(res.status).toBe(200);
			const setCookie = res.headers.get("set-cookie");
			expect(setCookie).toBeTruthy();
		});
	});

	// ─── Auth status API ─────────────────────────────────────────────────

	describe("/api/auth/status", () => {
		it("returns hasPin=false and authenticated=true when no PIN set", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/auth/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hasPin: boolean;
				authenticated: boolean;
			};
			expect(body.hasPin).toBe(false);
			expect(body.authenticated).toBe(true);
		});

		it("returns hasPin=true and authenticated=false when PIN set and no cookie", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/api/auth/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hasPin: boolean;
				authenticated: boolean;
			};
			expect(body.hasPin).toBe(true);
			expect(body.authenticated).toBe(false);
		});
	});
});
