// ─── Tests: Onboarding HTTP Server ──────────────────────────────────────────
//
// Tests cover:
// 1. GET /ca/download returns CA PEM with correct headers
// 2. GET /ca/download returns 404 when caRootPath is null
// 3. GET /setup returns index.html (200, text/html)
// 4. GET /api/setup-info returns JSON with correct ports
// 5. Static assets (.js, .css) are served for the SPA
// 6. Unknown routes 302-redirect to HTTPS setup URL
// 7. Onboarding server is not started when TLS is not active

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonLifecycleContext } from "../../../src/lib/daemon/daemon-lifecycle.js";
import {
	closeOnboardingServer,
	startOnboardingServer,
} from "../../../src/lib/daemon/daemon-lifecycle.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function cleanTmpDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

/** Get the actual bound port from the onboarding server. */
function getOnboardingPort(ctx: DaemonLifecycleContext): number {
	const addr = ctx.onboardingServer?.address() as AddressInfo | null;
	if (!addr) throw new Error("Onboarding server not bound");
	return addr.port;
}

function httpGet(
	port: number,
	path = "/",
): Promise<{
	status: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
				timeout: 5000,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: string) => {
					data += chunk;
				});
				res.on("end", () => {
					resolve({
						status: res.statusCode ?? 0,
						body: data,
						headers: res.headers,
					});
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("HTTP request timed out"));
		});
		req.end();
	});
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("startOnboardingServer", () => {
	let tmpDir: string;
	let staticDir: string;
	let caPath: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("onboarding-test-");
		staticDir = join(tmpDir, "public");
		mkdirSync(staticDir, { recursive: true });
		writeFileSync(
			join(staticDir, "index.html"),
			"<!DOCTYPE html><html><body>Setup</body></html>",
			"utf-8",
		);
		// Write a fake static asset for SPA asset test
		writeFileSync(
			join(staticDir, "app.abc12345.js"),
			"console.log('app');",
			"utf-8",
		);
		writeFileSync(
			join(staticDir, "style.def67890.css"),
			"body { color: red; }",
			"utf-8",
		);
		// Write a fake CA cert
		caPath = join(tmpDir, "ca.pem");
		writeFileSync(
			caPath,
			"-----BEGIN CERTIFICATE-----\nfake-ca-cert\n-----END CERTIFICATE-----\n",
			"utf-8",
		);
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	function makeCtx(
		overrides?: Partial<DaemonLifecycleContext>,
	): DaemonLifecycleContext {
		return {
			port: 0,
			host: "127.0.0.1",
			httpServer: null,
			onboardingServer: null,
			ipcServer: null,
			ipcClients: new Set(),
			clientCount: 0,
			socketPath: join(tmpDir, "unused.sock"),
			router: null,
			tls: { key: Buffer.from("unused"), cert: Buffer.from("unused") },
			...overrides,
		};
	}

	it("GET /ca/download returns CA PEM with correct headers", async () => {
		const ctx = makeCtx();
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = getOnboardingPort(ctx);

		const { status, body, headers } = await httpGet(port, "/ca/download");
		expect(status).toBe(200);
		expect(body).toContain("BEGIN CERTIFICATE");
		expect(headers["content-type"]).toBe("application/x-pem-file");
		expect(headers["content-disposition"]).toContain("opencode-relay-ca.pem");

		await closeOnboardingServer(ctx);
	});

	it("GET /ca/download returns 404 when caRootPath is null", async () => {
		const ctx = makeCtx();
		await startOnboardingServer(ctx, { caRootPath: null, staticDir });
		const port = getOnboardingPort(ctx);

		const { status } = await httpGet(port, "/ca/download");
		expect(status).toBe(404);

		await closeOnboardingServer(ctx);
	});

	it("GET /setup returns index.html", async () => {
		const ctx = makeCtx();
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = getOnboardingPort(ctx);

		const { status, body, headers } = await httpGet(port, "/setup");
		expect(status).toBe(200);
		expect(body).toContain("<!DOCTYPE html>");
		expect(headers["content-type"]).toContain("text/html");

		await closeOnboardingServer(ctx);
	});

	it("GET /api/setup-info returns JSON with correct port values", async () => {
		// Use a known main port so we can verify the URLs use different ports
		const ctx = makeCtx({ port: 9200 });
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		expect(ctx.onboardingServer).not.toBeNull();
		// The onboarding server listens on port 9201 (ctx.port + 1)
		const port = 9201;

		const { status, body } = await httpGet(port, "/api/setup-info");
		expect(status).toBe(200);
		const parsed = JSON.parse(body);
		// httpsUrl should use the main port (9200), not onboarding port (9201)
		expect(parsed.httpsUrl).toContain(":9200");
		expect(parsed.httpsUrl).toMatch(/^https:/);
		// httpUrl should use the onboarding port (9201)
		expect(parsed.httpUrl).toContain(":9201");
		expect(parsed.httpUrl).toMatch(/^http:/);
		expect(parsed.hasCert).toBe(true);

		await closeOnboardingServer(ctx);
	});

	it("GET /api/setup-info returns lanMode true when ?mode=lan", async () => {
		const ctx = makeCtx();
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = getOnboardingPort(ctx);

		const { status, body } = await httpGet(port, "/api/setup-info?mode=lan");
		expect(status).toBe(200);
		const parsed = JSON.parse(body);
		expect(parsed.lanMode).toBe(true);

		await closeOnboardingServer(ctx);
	});

	it("serves static assets needed by the SPA", async () => {
		const ctx = makeCtx();
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = getOnboardingPort(ctx);

		const js = await httpGet(port, "/app.abc12345.js");
		expect(js.status).toBe(200);
		expect(js.body).toContain("console.log");
		expect(js.headers["content-type"]).toContain("javascript");

		const css = await httpGet(port, "/style.def67890.css");
		expect(css.status).toBe(200);
		expect(css.body).toContain("body");
		expect(css.headers["content-type"]).toContain("css");

		await closeOnboardingServer(ctx);
	});

	it("unknown routes 302-redirect to HTTPS setup URL", async () => {
		const ctx = makeCtx({ port: 9200 });
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		expect(ctx.onboardingServer).not.toBeNull();
		// Onboarding listens on 9201
		const port = 9201;

		// Use raw http.request to avoid following redirects
		const { status, headers } = await httpGet(port, "/anything-else");
		expect(status).toBe(302);
		// Redirect target should be the HTTPS main server's /setup
		expect(headers["location"]).toMatch(/^https:.*:9200\/setup/);

		await closeOnboardingServer(ctx);
	});

	it("is NOT started when TLS is not active (no tls in context)", async () => {
		const ctx = makeCtx();
		// Remove tls to simulate non-TLS mode
		delete ctx.tls;
		await startOnboardingServer(ctx, { caRootPath: null, staticDir });
		// onboardingServer should remain null
		expect(ctx.onboardingServer).toBeNull();
	});
});
