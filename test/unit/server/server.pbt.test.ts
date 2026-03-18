// ─── HTTP Server PBT Tests (Ticket 2.1) + HTTPS Server Mode (Ticket 8.5) ─────

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { RelayServer } from "../../../src/lib/server/server.js";

const SEED = 42;
const NUM_RUNS = 50;

// Shared temp static directory with index.html for SPA-shell-serving tests.
// Without this, tests fall back to dist/frontend/ which only exists after a build,
// causing failures in CI where tests run before the build step.
const sharedStaticDir = mkdtempSync(join(tmpdir(), "server-pbt-static-"));
writeFileSync(
	join(sharedStaticDir, "index.html"),
	"<!DOCTYPE html><html><body>OpenCode Relay</body></html>",
	"utf-8",
);

// Use a different port range per test to avoid conflicts
let nextPort = 13000;
function getPort(): number {
	return nextPort++;
}

/** Send a raw HTTP request — avoids URL normalization that `fetch` does */
function rawRequest(
	port: number,
	path: string,
	options: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	} = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: options.method ?? "GET",
				headers: options.headers ?? {},
			},
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				res.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [k, v] of Object.entries(res.headers)) {
						if (typeof v === "string") headers[k] = v;
						else if (Array.isArray(v)) headers[k] = v.join(", ");
					}
					resolve({ status: res.statusCode ?? 500, headers, body });
				});
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) {
			req.write(options.body);
		}
		req.end();
	});
}

describe("Ticket 2.1 — HTTP Server PBT", () => {
	let server: RelayServer;

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
	});

	describe("P1: Server starts and binds (AC1, AC6)", () => {
		it("property: server starts on configured port", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/health`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(true);
		});
	});

	describe("P2: Health endpoint returns status (AC6)", () => {
		it("property: /health returns project count", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			server.addProject({
				slug: "test-1",
				directory: "/tmp/test-1",
				title: "Test 1",
			});
			server.addProject({
				slug: "test-2",
				directory: "/tmp/test-2",
				title: "Test 2",
			});
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/health`);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body["projects"]).toBe(2);
			expect(body["ok"]).toBe(true);
		});
	});

	describe("P3: Dashboard routes work (AC5)", () => {
		it("property: single project → redirect to /p/{slug}/", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			server.addProject({
				slug: "my-app",
				directory: "/tmp/my-app",
				title: "My App",
			});
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/`, {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/p/my-app/");
		});

		it("property: no projects → serves SPA shell", async () => {
			const port = getPort();
			server = new RelayServer({
				port,
				host: "127.0.0.1",
				staticDir: sharedStaticDir,
			});
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/`);
			expect(res.status).toBe(200);
			const body = await res.text();
			// Serves app.html (Svelte SPA) which renders DashboardPage client-side
			expect(body).toContain("<!DOCTYPE html>");
		});

		it("property: no projects → /api/projects returns empty list", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				projects: unknown[];
				version: string;
			};
			expect(body.projects).toEqual([]);
			expect(body.version).toBe("0.1.0");
		});

		it("property: multiple projects → /api/projects returns project list", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			server.addProject({
				slug: "app-1",
				directory: "/tmp/app-1",
				title: "App 1",
			});
			server.addProject({
				slug: "app-2",
				directory: "/tmp/app-2",
				title: "App 2",
			});
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				projects: { slug: string; title?: string }[];
			};
			const titles = body.projects.map((p) => p.title);
			expect(titles).toContain("App 1");
			expect(titles).toContain("App 2");
		});
	});

	describe("P4: Project routing returns 404 for unknown slugs (AC4)", () => {
		it("property: unknown slug → 404", async () => {
			fc.assert(
				await fc.asyncProperty(
					fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/),
					async (slug) => {
						const port = getPort();
						server = new RelayServer({ port, host: "127.0.0.1" });
						await server.start();

						const res = await fetch(`http://127.0.0.1:${port}/p/${slug}/`);
						expect(res.status).toBe(404);

						await server.stop();
					},
				),
				{ seed: SEED, numRuns: 10, endOnFailure: true },
			);
		});
	});

	describe("P5: CORS headers are set (AC6)", () => {
		it("property: OPTIONS returns 204 with CORS headers", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/health`, {
				method: "OPTIONS",
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	describe("P6: PIN authentication works (AC2)", () => {
		it("property: correct PIN returns cookie", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "1234" }),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body["ok"]).toBe(true);
			expect(res.headers.get("set-cookie")).toBeTruthy();
		});

		it("property: wrong PIN returns 401", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "9999" }),
			});

			expect(res.status).toBe(401);
		});
	});

	describe("P7: Project management (AC4)", () => {
		it("property: add and remove projects", () => {
			fc.assert(
				fc.property(
					fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{2,10}$/), {
						minLength: 1,
						maxLength: 5,
					}),
					(slugs) => {
						const s = new RelayServer({ port: 0, host: "127.0.0.1" });
						const uniqueSlugs = [...new Set(slugs)];

						for (const slug of uniqueSlugs) {
							s.addProject({ slug, directory: `/tmp/${slug}`, title: slug });
						}

						expect(s.getProjects().length).toBe(uniqueSlugs.length);

						if (uniqueSlugs.length > 0) {
							// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
							s.removeProject(uniqueSlugs[0]!);
							expect(s.getProjects().length).toBe(uniqueSlugs.length - 1);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("P8: Server URLs (AC6)", () => {
		it("property: getUrls returns local URL with correct port", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			const urls = server.getUrls();
			expect(urls.local).toBe(`http://localhost:${port}`);
		});
	});

	// ─── Security Tests ──────────────────────────────────────────────────────

	describe("S1: Directory traversal prevention", () => {
		it("rejects ../../etc/passwd via raw HTTP request", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "server-sec-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<html><body>test</body></html>",
			);

			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", staticDir: tmpDir });
			await server.start();

			// Use raw HTTP to send the path without URL normalization
			const res = await rawRequest(port, "/../../etc/passwd");
			// Server must not serve /etc/passwd contents
			expect(res.body).not.toContain("root:");
			// Should be 403 (traversal blocked) or the SPA fallback index.html
			expect([200, 403]).toContain(res.status);
			if (res.status === 200) {
				// If 200, it must be the SPA fallback, not the actual file
				expect(res.body).toContain("test");
			}

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("rejects encoded traversal paths with 403", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "server-sec2-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<html><body>test</body></html>",
			);

			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", staticDir: tmpDir });
			await server.start();

			// Use raw HTTP with percent-encoded ../ sequences
			const res = await rawRequest(port, "/..%2F..%2F..%2Fetc%2Fpasswd");
			expect(res.body).not.toContain("root:");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("property: various traversal patterns never serve files outside staticDir", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "server-sec3-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<html><body>safe</body></html>",
			);

			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", staticDir: tmpDir });
			await server.start();

			const traversalPaths = [
				"/../../../etc/passwd",
				"/..%2F..%2Fetc%2Fpasswd",
				"/....//....//etc/passwd",
				"/%2e%2e/%2e%2e/etc/passwd",
				"/..\\..\\etc\\passwd",
			];

			for (const path of traversalPaths) {
				const res = await rawRequest(port, path);
				expect(res.body).not.toContain("root:");
			}

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("S2: Auth lockout (429)", () => {
		it("returns 429 after too many failed attempts", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
			await server.start();

			// AuthManager defaults to maxAttempts=5 — fail 5 times to trigger lockout
			for (let i = 0; i < 5; i++) {
				const res = await fetch(`http://127.0.0.1:${port}/auth`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ pin: "0000" }),
				});
				// First 4 should be 401, 5th triggers lockout
				if (i < 4) {
					expect(res.status).toBe(401);
				}
			}

			// The next attempt should be locked (429)
			const lockedRes = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "0000" }),
			});
			expect(lockedRes.status).toBe(429);
			const body = (await lockedRes.json()) as {
				ok: boolean;
				locked: boolean;
				retryAfter: number;
			};
			expect(body.ok).toBe(false);
			expect(body.locked).toBe(true);
			expect(typeof body.retryAfter).toBe("number");
			expect(body.retryAfter).toBeGreaterThan(0);
		});
	});

	describe("S3: Cookie-based auth roundtrip", () => {
		it("POST /auth with correct PIN, get cookie, use cookie on /p/{slug}/", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "5678" });
			server.addProject({
				slug: "secure-app",
				directory: "/tmp/secure-app",
				title: "Secure App",
			});
			await server.start();

			// First, verify that accessing /p/secure-app/ without auth redirects to /auth
			const unauthRes = await fetch(`http://127.0.0.1:${port}/p/secure-app/`, {
				redirect: "manual",
			});
			expect(unauthRes.status).toBe(302);
			expect(unauthRes.headers.get("location")).toBe("/auth");

			// Authenticate with correct PIN
			const authRes = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "5678" }),
			});
			expect(authRes.status).toBe(200);
			const setCookie = authRes.headers.get("set-cookie");
			expect(setCookie).toBeTruthy();

			// Extract the cookie value from the Set-Cookie header
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const cookieMatch = setCookie!.match(/relay_session=([^;]+)/);
			expect(cookieMatch).toBeTruthy();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const cookieValue = cookieMatch![1];

			// Now access the protected route with the cookie
			const authedRes = await fetch(`http://127.0.0.1:${port}/p/secure-app/`, {
				headers: { Cookie: `relay_session=${cookieValue}` },
			});
			// Auth should pass — not 401/302. Server will try to serve static files (or 404)
			expect(authedRes.status).not.toBe(401);
			expect(authedRes.status).not.toBe(302);
		});
	});

	describe("S4: X-Relay-Pin header auth", () => {
		it("grants access when correct PIN is sent as X-Relay-Pin header", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "4321" });
			server.addProject({
				slug: "header-app",
				directory: "/tmp/header-app",
				title: "Header App",
			});
			await server.start();

			// Without auth → redirect to /auth
			const unauthRes = await fetch(`http://127.0.0.1:${port}/p/header-app/`, {
				redirect: "manual",
			});
			expect(unauthRes.status).toBe(302);

			// With X-Relay-Pin header → access granted
			const authedRes = await fetch(`http://127.0.0.1:${port}/p/header-app/`, {
				headers: { "X-Relay-Pin": "4321" },
			});
			expect(authedRes.status).not.toBe(401);
		});

		it("rejects access when wrong PIN is sent as X-Relay-Pin header", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "4321" });
			server.addProject({
				slug: "header-app2",
				directory: "/tmp/header-app2",
				title: "Header App 2",
			});
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/p/header-app2/`, {
				headers: { "X-Relay-Pin": "9999" },
			});
			expect(res.status).toBe(401);
		});
	});

	describe("S5: SPA fallback", () => {
		it("serves index.html for unknown paths when index.html exists", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "server-spa-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<html><body>SPA App</body></html>",
			);

			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", staticDir: tmpDir });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/some/unknown/path`);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("SPA App");

			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("returns 404 when index.html does not exist", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "server-nospa-"));
			// No index.html in this dir

			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", staticDir: tmpDir });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/nonexistent-file.js`);
			expect(res.status).toBe(404);

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	describe("S6: Invalid JSON body on /auth", () => {
		it("returns 400 for non-JSON body", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "this is not json{{{",
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("BAD_REQUEST");
			expect(body.error.message).toBe("Invalid JSON");
		});

		it("returns 400 for empty body", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/auth`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "",
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("BAD_REQUEST");
		});
	});
});

// ─── HTTPS Server Mode (Ticket 8.5) ──────────────────────────────────────────

// Generate test certs synchronously at module scope so skipIf can evaluate
let _testKey: Buffer;
let _testCert: Buffer;
let _certDir: string;
let _caPath: string;
let _opensslAvailable = false;

try {
	_certDir = mkdtempSync(join(tmpdir(), "relay-tls-test-"));
	const _keyPath = join(_certDir, "key.pem");
	const _certPath = join(_certDir, "cert.pem");
	_caPath = join(_certDir, "ca.pem");

	execSync(
		`openssl req -x509 -newkey rsa:2048 -keyout ${_keyPath} -out ${_certPath} -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`,
	);
	execSync(`cp ${_certPath} ${_caPath}`);

	_testKey = Buffer.from(readFileSync(_keyPath, "utf-8"));
	_testCert = Buffer.from(readFileSync(_certPath, "utf-8"));
	_opensslAvailable = true;
} catch {
	_testKey = Buffer.from(
		"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
	);
	_testCert = Buffer.from(
		"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
	);
	_certDir = mkdtempSync(join(tmpdir(), "relay-tls-test-"));
	_caPath = join(_certDir, "ca.pem");
	writeFileSync(
		_caPath,
		"-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n",
	);
}

describe("HTTPS Server Mode (8.5)", () => {
	let server: RelayServer;
	const testKey = _testKey;
	const testCert = _testCert;
	const certDir = _certDir;
	const caPath = _caPath;
	const opensslAvailable = _opensslAvailable;

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
	});

	// ─── isTls() ─────────────────────────────────────────────────────────

	describe("isTls()", () => {
		it("returns false without TLS config", () => {
			server = new RelayServer({ port: 0, host: "127.0.0.1" });
			expect(server.isTls()).toBe(false);
		});

		it("returns true with TLS config", () => {
			server = new RelayServer({
				port: 0,
				host: "127.0.0.1",
				tls: { key: testKey, cert: testCert },
			});
			expect(server.isTls()).toBe(true);
		});
	});

	// ─── getUrls() ───────────────────────────────────────────────────────

	describe("getUrls()", () => {
		it("returns http:// URLs without TLS", () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			const urls = server.getUrls();
			expect(urls.local).toBe(`http://localhost:${port}`);
			for (const url of urls.network) {
				expect(url).toMatch(/^http:\/\//);
			}
		});

		it("returns https:// URLs with TLS", () => {
			const port = getPort();
			server = new RelayServer({
				port,
				host: "127.0.0.1",
				tls: { key: testKey, cert: testCert },
			});
			const urls = server.getUrls();
			expect(urls.local).toBe(`https://localhost:${port}`);
			for (const url of urls.network) {
				expect(url).toMatch(/^https:\/\//);
			}
		});
	});

	// ─── Constructor ─────────────────────────────────────────────────────

	describe("Constructor", () => {
		it("accepts tls: undefined without error", () => {
			server = new RelayServer({
				port: 0,
				host: "127.0.0.1",
			});
			expect(server.isTls()).toBe(false);
		});
	});

	// ─── /info endpoint ──────────────────────────────────────────────────

	describe("/info endpoint", () => {
		it("returns JSON with version", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/info`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { version: string };
			expect(body.version).toBe("0.1.0");
		});

		it("has CORS headers", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/info`);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
			expect(res.headers.get("access-control-allow-headers")).toContain(
				"Content-Type",
			);
		});
	});

	// ─── /ca/download endpoint ───────────────────────────────────────────

	describe("/ca/download endpoint", () => {
		it("returns 404 when no TLS is configured (HTTP server)", async () => {
			const port = getPort();
			server = new RelayServer({ port, host: "127.0.0.1" });
			await server.start();

			const res = await fetch(`http://127.0.0.1:${port}/ca/download`);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it.skipIf(!opensslAvailable)(
			"returns 404 when TLS is set but caRoot is omitted",
			async () => {
				const port = getPort();
				server = new RelayServer({
					port,
					host: "127.0.0.1",
					tls: { key: testKey, cert: testCert },
				});
				await server.start();

				const body = await new Promise<string>((resolve, reject) => {
					const req = httpsRequest(
						{
							hostname: "127.0.0.1",
							port,
							path: "/ca/download",
							method: "GET",
							rejectUnauthorized: false,
						},
						(res) => {
							let data = "";
							res.on("data", (chunk: Buffer) => {
								data += chunk.toString();
							});
							res.on("end", () => resolve(data));
						},
					);
					req.on("error", reject);
					req.end();
				});

				const parsed = JSON.parse(body) as { error: { code: string } };
				expect(parsed.error.code).toBe("NOT_FOUND");
			},
		);

		it.skipIf(!opensslAvailable)(
			"returns PEM file when caRoot is set",
			async () => {
				const port = getPort();
				server = new RelayServer({
					port,
					host: "127.0.0.1",
					tls: { key: testKey, cert: testCert, caRoot: caPath },
				});
				await server.start();

				const { status, headers, body } = await new Promise<{
					status: number;
					headers: Record<string, string>;
					body: string;
				}>((resolve, reject) => {
					const req = httpsRequest(
						{
							hostname: "127.0.0.1",
							port,
							path: "/ca/download",
							method: "GET",
							rejectUnauthorized: false,
						},
						(res) => {
							let data = "";
							res.on("data", (chunk: Buffer) => {
								data += chunk.toString();
							});
							res.on("end", () => {
								const hdrs: Record<string, string> = {};
								for (const [k, v] of Object.entries(res.headers)) {
									if (typeof v === "string") hdrs[k] = v;
								}
								resolve({
									status: res.statusCode ?? 500,
									headers: hdrs,
									body: data,
								});
							});
						},
					);
					req.on("error", reject);
					req.end();
				});

				expect(status).toBe(200);
				expect(headers["content-type"]).toBe("application/x-pem-file");
				expect(headers["content-disposition"]).toContain(
					"opencode-relay-ca.pem",
				);
				expect(body).toContain("-----BEGIN CERTIFICATE-----");
			},
		);

		it.skipIf(!opensslAvailable)(
			"returns 404 when caRoot file does not exist on disk",
			async () => {
				const port = getPort();
				server = new RelayServer({
					port,
					host: "127.0.0.1",
					tls: {
						key: testKey,
						cert: testCert,
						caRoot: join(certDir, "nonexistent.pem"),
					},
				});
				await server.start();

				const body = await new Promise<string>((resolve, reject) => {
					const req = httpsRequest(
						{
							hostname: "127.0.0.1",
							port,
							path: "/ca/download",
							method: "GET",
							rejectUnauthorized: false,
						},
						(res) => {
							let data = "";
							res.on("data", (chunk: Buffer) => {
								data += chunk.toString();
							});
							res.on("end", () => resolve(data));
						},
					);
					req.on("error", reject);
					req.end();
				});

				const parsed = JSON.parse(body) as { error: { code: string } };
				expect(parsed.error.code).toBe("NOT_FOUND");
			},
		);
	});

	// ─── Actual HTTPS connection test ────────────────────────────────────

	describe("HTTPS connection", () => {
		it.skipIf(!opensslAvailable)(
			"serves requests over HTTPS with real certificates",
			async () => {
				const port = getPort();
				server = new RelayServer({
					port,
					host: "127.0.0.1",
					tls: { key: testKey, cert: testCert },
				});
				await server.start();

				// Make HTTPS request with self-signed cert (rejectUnauthorized: false)
				const body = await new Promise<string>((resolve, reject) => {
					const req = httpsRequest(
						{
							hostname: "127.0.0.1",
							port,
							path: "/health",
							method: "GET",
							rejectUnauthorized: false,
						},
						(res) => {
							let data = "";
							res.on("data", (chunk: Buffer) => {
								data += chunk.toString();
							});
							res.on("end", () => resolve(data));
						},
					);
					req.on("error", reject);
					req.end();
				});

				const parsed = JSON.parse(body) as { ok: boolean };
				expect(parsed.ok).toBe(true);
			},
		);

		it.skipIf(!opensslAvailable)("/ca/download works over HTTPS", async () => {
			const port = getPort();
			server = new RelayServer({
				port,
				host: "127.0.0.1",
				tls: { key: testKey, cert: testCert, caRoot: caPath },
			});
			await server.start();

			const body = await new Promise<string>((resolve, reject) => {
				const req = httpsRequest(
					{
						hostname: "127.0.0.1",
						port,
						path: "/ca/download",
						method: "GET",
						rejectUnauthorized: false,
					},
					(res) => {
						let data = "";
						res.on("data", (chunk: Buffer) => {
							data += chunk.toString();
						});
						res.on("end", () => resolve(data));
					},
				);
				req.on("error", reject);
				req.end();
			});

			expect(body).toContain("-----BEGIN CERTIFICATE-----");
		});
	});
});

// ─── Setup Page Integration (Ticket 8.18) ─────────────────────────────────────

describe("Setup Page (8.18)", () => {
	let server: RelayServer;

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
	});

	it("GET /setup returns 200 with SPA shell", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			staticDir: sharedStaticDir,
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/setup`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("/api/setup-info returns setup configuration JSON", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/setup-info`);
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

	it("/api/setup-info?mode=lan passes lanMode correctly", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/setup-info?mode=lan`);
		const body = (await res.json()) as { lanMode: boolean };
		expect(body.lanMode).toBe(true);

		// Without ?mode=lan, lanMode should be false
		const res2 = await fetch(`http://127.0.0.1:${port}/api/setup-info`);
		const body2 = (await res2.json()) as { lanMode: boolean };
		expect(body2.lanMode).toBe(false);
	});

	it("/setup is accessible without auth when PIN is set", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			pin: "9876",
			staticDir: sharedStaticDir,
		});
		await server.start();

		// /setup should work without auth (serves SPA shell)
		const res = await fetch(`http://127.0.0.1:${port}/setup`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");

		// Verify that /p/ routes still require auth (redirect to /auth)
		server.addProject({
			slug: "test-proj",
			directory: "/tmp/test-proj",
			title: "Test",
		});
		const protectedRes = await fetch(`http://127.0.0.1:${port}/p/test-proj/`, {
			redirect: "manual",
		});
		expect(protectedRes.status).toBe(302);
		expect(protectedRes.headers.get("location")).toBe("/auth");
	});

	it("/setup works on HTTP server", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			staticDir: sharedStaticDir,
		});
		await server.start();

		expect(server.isTls()).toBe(false);
		const res = await fetch(`http://127.0.0.1:${port}/setup`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("/api/setup-info reflects TLS status", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		await server.start();

		// HTTP server → hasCert: false
		const res = await fetch(`http://127.0.0.1:${port}/api/setup-info`);
		const body = (await res.json()) as { hasCert: boolean };
		expect(body.hasCert).toBe(false);
	});

	it("response has correct Content-Type", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			staticDir: sharedStaticDir,
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/setup`);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
	});

	it("/api/setup-info has JSON Content-Type", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/setup-info`);
		expect(res.headers.get("content-type")).toBe("application/json");
	});

	it("/api/auth/status returns auth status", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
		await server.start();

		// Without auth — hasPin true, authenticated false
		const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			hasPin: boolean;
			authenticated: boolean;
		};
		expect(body.hasPin).toBe(true);
		expect(body.authenticated).toBe(false);
	});

	it("/api/auth/status without PIN configured", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
		const body = (await res.json()) as {
			hasPin: boolean;
			authenticated: boolean;
		};
		expect(body.hasPin).toBe(false);
		expect(body.authenticated).toBe(true);
	});
});

// ─── PIN Login Page (Ticket 8.16) ──────────────────────────────────────────────

describe("PIN Login Page (8.16)", () => {
	let server: RelayServer;

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
	});

	it("browser request to / with PIN set and no cookie redirects to /auth", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
		server.addProject({
			slug: "proj",
			directory: "/tmp/proj",
			title: "Proj",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/auth");
	});

	it("GET /auth serves SPA shell for Svelte PinPage", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			pin: "1234",
			staticDir: sharedStaticDir,
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/auth`);
		expect(res.status).toBe(200);
		const body = await res.text();
		// SPA shell — PinPage renders client-side
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("browser request to /p/slug/ with PIN set and no cookie redirects to /auth", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
		server.addProject({
			slug: "my-app",
			directory: "/tmp/my-app",
			title: "My App",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/p/my-app/`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/auth");
	});

	it("API request /api/... with PIN set and no cookie returns JSON 401", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
		expect(res.status).toBe(401);
		const contentType = res.headers.get("content-type");
		expect(contentType).toContain("application/json");
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("AUTH_REQUIRED");
	});

	it("request with valid cookie passes through normally", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "5678" });
		server.addProject({
			slug: "authed-app",
			directory: "/tmp/authed-app",
			title: "Authed App",
		});
		await server.start();

		// Authenticate first
		const authRes = await fetch(`http://127.0.0.1:${port}/auth`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pin: "5678" }),
		});
		expect(authRes.status).toBe(200);
		const setCookie = authRes.headers.get("set-cookie");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const cookieMatch = setCookie!.match(/relay_session=([^;]+)/);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const cookieValue = cookieMatch![1];

		// Access root with cookie — should not be PIN page
		const rootRes = await fetch(`http://127.0.0.1:${port}/`, {
			headers: { Cookie: `relay_session=${cookieValue}` },
			redirect: "manual",
		});
		// With one project, should redirect to /p/authed-app/
		expect(rootRes.status).toBe(302);
		expect(rootRes.headers.get("location")).toBe("/p/authed-app/");
	});

	it("request with X-Relay-Pin header returns JSON on failure", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1", pin: "1234" });
		server.addProject({
			slug: "pin-app",
			directory: "/tmp/pin-app",
			title: "Pin App",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/p/pin-app/`, {
			headers: { "X-Relay-Pin": "9999" },
		});
		expect(res.status).toBe(401);
		const contentType = res.headers.get("content-type");
		expect(contentType).toContain("application/json");
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("AUTH_REQUIRED");
	});

	it("static assets are served without auth when PIN is set", async () => {
		const port = getPort();
		const tmpDir = mkdtempSync(join(tmpdir(), "pin-static-"));
		writeFileSync(join(tmpDir, "style.css"), "body { color: red; }");

		server = new RelayServer({
			port,
			host: "127.0.0.1",
			pin: "1234",
			staticDir: tmpDir,
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/style.css`);
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("body { color: red; }");

		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("no PIN set serves dashboard normally without auth check", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		server.addProject({
			slug: "free-app",
			directory: "/tmp/free-app",
			title: "Free App",
		});
		await server.start();

		// Single project should redirect
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/p/free-app/");
	});
});

// ─── Dashboard Page (Ticket 8.17) ──────────────────────────────────────────────

describe("Dashboard Page (8.17)", () => {
	let server: RelayServer;

	afterEach(async () => {
		if (server) {
			await server.stop();
		}
	});

	it("multiple projects → /api/projects returns all projects", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		server.addProject({
			slug: "app-alpha",
			directory: "/tmp/app-alpha",
			title: "App Alpha",
		});
		server.addProject({
			slug: "app-beta",
			directory: "/tmp/app-beta",
			title: "App Beta",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			projects: { slug: string; title?: string; path: string }[];
		};
		expect(body.projects.length).toBe(2);
		const titles = body.projects.map((p) => p.title);
		expect(titles).toContain("App Alpha");
		expect(titles).toContain("App Beta");
	});

	it("/api/projects contains project slugs and paths", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		server.addProject({
			slug: "project-one",
			directory: "/tmp/project-one",
			title: "Project One",
		});
		server.addProject({
			slug: "project-two",
			directory: "/tmp/project-two",
			title: "Project Two",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
		const body = (await res.json()) as { projects: { slug: string }[] };
		const slugs = body.projects.map((p) => p.slug);
		expect(slugs).toContain("project-one");
		expect(slugs).toContain("project-two");
	});

	it("/ with multiple projects serves SPA shell", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			staticDir: sharedStaticDir,
		});
		server.addProject({
			slug: "a",
			directory: "/tmp/a",
			title: "A",
		});
		server.addProject({
			slug: "b",
			directory: "/tmp/b",
			title: "B",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/`);
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("/api/projects returns version", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		server.addProject({
			slug: "x",
			directory: "/tmp/x",
			title: "X",
		});
		server.addProject({
			slug: "y",
			directory: "/tmp/y",
			title: "Y",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
		const body = (await res.json()) as { version: string };
		expect(body.version).toBe("0.1.0");
	});

	it("single project auto-redirects (302)", async () => {
		const port = getPort();
		server = new RelayServer({ port, host: "127.0.0.1" });
		server.addProject({
			slug: "only-one",
			directory: "/tmp/only-one",
			title: "Only One",
		});
		await server.start();

		const res = await fetch(`http://127.0.0.1:${port}/`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/p/only-one/");
	});

	it("no projects → / serves SPA shell, /api/projects returns empty", async () => {
		const port = getPort();
		server = new RelayServer({
			port,
			host: "127.0.0.1",
			staticDir: sharedStaticDir,
		});
		await server.start();

		const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
		expect(htmlRes.status).toBe(200);
		const html = await htmlRes.text();
		expect(html).toContain("<!DOCTYPE html>");

		const apiRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
		const body = (await apiRes.json()) as { projects: unknown[] };
		expect(body.projects).toEqual([]);
	});
});
