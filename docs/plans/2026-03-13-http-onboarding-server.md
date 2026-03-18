# HTTP Onboarding Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When TLS is enabled, run a plain HTTP server on `port + 1` so phones/tablets can download the CA certificate and complete the setup wizard without hitting "This connection is not private."

**Architecture:** The daemon creates a second `node:http` server (no TLS) on `port + 1`, bound to the same host as the main server. It serves only: `/ca/download`, `/setup` (the existing Svelte SPA's `index.html`), `/api/setup-info`, and SPA static assets. Everything else 302-redirects to the HTTPS main server's `/setup`. The onboarding server is only created when TLS is active. It shares the same static file directory. On shutdown, it's closed alongside the main server.

**Tech Stack:** `node:http`, existing `DaemonLifecycleContext`, existing `static-files.ts` (`tryServeStatic`, `serveStaticFile`).

---

## Context

### Problem

When a phone accesses `https://100.80.98.50:2633`, the browser shows "This connection is not private" because the device doesn't have the mkcert CA in its trust store. The `/ca/download` endpoint exists on the HTTPS server, but the user can't reach it without bypassing the warning first (which some browsers make very difficult).

### Solution

Mirror claude-relay's dual-port approach:
- HTTPS on port N (e.g., 2633) — the main server
- HTTP on port N+1 (e.g., 2634) — the onboarding server

The QR code and setup links already point to `http://ip:port+1/setup` (see `src/lib/cli/cli-notifications.ts:283-284`). We just need the server behind it.

### How HTTPS verification works (important for understanding the `/info` endpoint)

`SetupPage.svelte:169-188` contains `checkHttps()`, which fetches `${httpsUrl}/info` with `mode: "no-cors"`. This means:
- It fetches from the **HTTPS main server** (not the HTTP onboarding server)
- The main server already has `/info` at `http-router.ts:238-242` and already sets `Access-Control-Allow-Origin: *` on every response (`http-router.ts:117-126`)
- With `mode: "no-cors"`, CORS headers don't matter — the browser makes the request regardless; the fetch succeeding (even with an opaque response) proves the cert is trusted
- **The onboarding server does NOT need its own `/info` endpoint** — the verification targets the HTTPS server directly

### Historical note

Ticket 2.6 previously created an `onboarding.ts` module that was removed during the Svelte migration (see `PROGRESS.md:319`, sprint S8.10). This plan re-introduces the concept differently — as lifecycle functions in `daemon-lifecycle.ts` rather than a standalone module.

### Key existing code

- `src/lib/cli/cli-notifications.ts:283-284` — already constructs `http://${ip}:${port + 1}/setup` URL for QR codes when TLS is active
- `src/lib/frontend/pages/SetupPage.svelte` — full Svelte setup wizard (Tailscale, Certificate, PWA, Push, Done steps); contains `checkHttps()` at line 169 that verifies the HTTPS cert is trusted
- `src/lib/frontend/components/setup/StepCertificate.svelte` — presentational component for the cert download step (no fetch logic)
- `src/lib/server/http-router.ts` — `/setup` at line 199, `/api/setup-info` at line 205, `/info` at line 238, `/ca/download` at line 292
- `src/lib/server/static-files.ts` — `tryServeStatic()` at line 79 (returns `boolean`, usable from plain `node:http`), `serveStaticFile()` at line 22
- `src/lib/daemon/daemon-lifecycle.ts` — `DaemonLifecycleContext` at line 38, `startHttpServer()` at line 56, `closeHttpServer()` at line 90

### Key files to modify

- `src/lib/daemon/daemon-lifecycle.ts` — add `onboardingServer` field, `startOnboardingServer()`, `closeOnboardingServer()`
- `src/lib/daemon/daemon.ts` — add field, call lifecycle functions in `start()` / `stop()`

### Key files to create

- `test/unit/daemon/daemon-onboarding.test.ts` — onboarding server tests

---

## Task 1: Add `onboardingServer` field to `DaemonLifecycleContext`

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts:38-51`

### Step 1: Add the field

Add an optional `onboardingServer` field to the interface:

```ts
export interface DaemonLifecycleContext {
	port: number;
	host: string;
	httpServer: HttpServer | null;
	/** HTTP-only onboarding server on port+1 (only when TLS is active). */
	onboardingServer?: HttpServer | null;
	ipcServer: NetServer | null;
	ipcClients: Set<Socket>;
	clientCount: number;
	socketPath: string;
	router: {
		handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
	} | null;
	/** When provided, the HTTP server is created as HTTPS with these certs. */
	tls?: { key: Buffer; cert: Buffer };
}
```

### Step 2: Run `pnpm check`

Run: `pnpm check`
Expected: PASS (no existing code references the new field yet)

### Step 3: Commit

```bash
git add src/lib/daemon/daemon-lifecycle.ts
git commit -m "feat: add onboardingServer field to DaemonLifecycleContext"
```

---

## Task 2: Write `startOnboardingServer()` and `closeOnboardingServer()` stubs

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts`

### Step 1: Add imports

Add these imports at the top of `daemon-lifecycle.ts` (some may already be imported — only add what's missing):

```ts
import { readFile } from "node:fs/promises";
import { tryServeStatic } from "../server/static-files.js";
```

### Step 2: Write `startOnboardingServer()` stub

Add after `closeHttpServer()` (after line 107):

```ts
// ─── Onboarding Server (HTTP-only, port+1) ─────────────────────────────────

export interface OnboardingServerDeps {
	caRootPath: string | null;
	staticDir: string;
}

/**
 * Start an HTTP-only onboarding server on ctx.port + 1.
 * Only call when ctx.tls is present (TLS active).
 *
 * Serves: /ca/download, /setup (index.html), /api/setup-info, SPA static assets.
 * Everything else 302-redirects to the HTTPS main server.
 */
export function startOnboardingServer(
	ctx: DaemonLifecycleContext,
	deps: OnboardingServerDeps,
): Promise<void> {
	return Promise.resolve(); // stub — implemented in Task 3
}

/** Gracefully close the onboarding server. */
export function closeOnboardingServer(
	ctx: DaemonLifecycleContext,
): Promise<void> {
	return Promise.resolve(); // stub — implemented in Task 3
}
```

### Step 3: Run `pnpm check`

Run: `pnpm check`
Expected: PASS

---

## Task 3: Write failing tests for the onboarding server

**Files:**
- Create: `test/unit/daemon/daemon-onboarding.test.ts`

### Step 1: Write the test file

Use the same patterns as `test/unit/daemon/daemon-tls.test.ts` — ephemeral ports, temp dirs, `httpGet` helper.

```ts
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

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
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

function httpGet(
	port: number,
	path = "/",
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
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

	function makeCtx(overrides?: Partial<DaemonLifecycleContext>): DaemonLifecycleContext {
		return {
			port: 0, // will be set after startHttpServer or manually
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
		const ctx = makeCtx({ port: 0 });
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = ctx.port + 1;

		const { status, body, headers } = await httpGet(port, "/ca/download");
		expect(status).toBe(200);
		expect(body).toContain("BEGIN CERTIFICATE");
		expect(headers["content-type"]).toBe("application/x-pem-file");
		expect(headers["content-disposition"]).toContain("opencode-relay-ca.pem");

		await closeOnboardingServer(ctx);
	});

	it("GET /ca/download returns 404 when caRootPath is null", async () => {
		const ctx = makeCtx({ port: 0 });
		await startOnboardingServer(ctx, { caRootPath: null, staticDir });
		const port = ctx.port + 1;

		const { status } = await httpGet(port, "/ca/download");
		expect(status).toBe(404);

		await closeOnboardingServer(ctx);
	});

	it("GET /setup returns index.html", async () => {
		const ctx = makeCtx({ port: 0 });
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = ctx.port + 1;

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
		const port = ctx.port + 1; // 9201

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

	it("serves static assets needed by the SPA", async () => {
		const ctx = makeCtx({ port: 0 });
		await startOnboardingServer(ctx, { caRootPath: caPath, staticDir });
		const port = ctx.port + 1;

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
		const port = ctx.port + 1;

		// Use raw http.request to avoid following redirects
		const { status, headers } = await httpGet(port, "/anything-else");
		expect(status).toBe(302);
		// Redirect target should be the HTTPS main server's /setup
		expect(headers.location).toMatch(/^https:.*:9200\/setup/);

		await closeOnboardingServer(ctx);
	});

	it("is NOT started when TLS is not active (no tls in context)", async () => {
		const ctx = makeCtx({ tls: undefined });
		await startOnboardingServer(ctx, { caRootPath: null, staticDir });
		// onboardingServer should remain null
		expect(ctx.onboardingServer).toBeNull();
	});
});
```

### Step 2: Run tests, verify they fail

Run: `pnpm test:unit -- test/unit/daemon/daemon-onboarding.test.ts`
Expected: FAIL (stubs return immediately without creating a server)

### Step 3: Commit

```bash
git add test/unit/daemon/daemon-onboarding.test.ts
git commit -m "test: add failing tests for HTTP onboarding server"
```

---

## Task 4: Implement `startOnboardingServer()` and `closeOnboardingServer()`

**Files:**
- Modify: `src/lib/daemon/daemon-lifecycle.ts`

### Step 1: Implement `startOnboardingServer()`

Replace the stub with the full implementation. Key design decisions:
- Uses `tryServeStatic` from `static-files.ts` for serving SPA assets (returns `false` when file doesn't exist, letting us fall through to the 302 redirect)
- Reads CA cert once at server creation time (cached in closure)
- `/api/setup-info` uses `ctx.port` for `httpsUrl` and `ctx.port + 1` for `httpUrl` — these are different ports and must NOT be copied from the main server's pattern verbatim
- When `caRootPath` is null, `/ca/download` returns 404 (mirrors `http-router.ts:553-564`)
- When `ctx.tls` is absent, does nothing (early return)
- Catches `EADDRINUSE` gracefully — logs a warning but doesn't fail daemon startup

```ts
export function startOnboardingServer(
	ctx: DaemonLifecycleContext,
	deps: OnboardingServerDeps,
): Promise<void> {
	// Only start when TLS is active
	if (!ctx.tls) {
		return Promise.resolve();
	}

	const onboardingPort = ctx.port + 1;

	// Pre-read CA cert (if available) so we don't hit disk per request
	let caCertBuf: Buffer | null = null;
	const loadCaCert = deps.caRootPath
		? readFile(deps.caRootPath)
				.then((buf) => {
					caCertBuf = buf;
				})
				.catch(() => {
					log.warn("Onboarding server: CA cert file not readable");
				})
		: Promise.resolve();

	return loadCaCert.then(
		() =>
			new Promise<void>((resolve, reject) => {
				const server = createServer(async (req, res) => {
					const url = new URL(
						req.url ?? "/",
						`http://${req.headers.host ?? "localhost"}`,
					);
					const pathname = url.pathname;

					try {
						// ─── /ca/download ───────────────────────────────────
						if (pathname === "/ca/download" && req.method === "GET") {
							if (!caCertBuf) {
								res.writeHead(404, {
									"Content-Type": "application/json",
								});
								res.end(
									JSON.stringify({
										error: {
											code: "NOT_FOUND",
											message: "No CA certificate available",
										},
									}),
								);
								return;
							}
							res.writeHead(200, {
								"Content-Type": "application/x-pem-file",
								"Content-Disposition":
									'attachment; filename="opencode-relay-ca.pem"',
								"Content-Length": caCertBuf.length,
							});
							res.end(caCertBuf);
							return;
						}

						// ─── /setup ─────────────────────────────────────────
						if (pathname === "/setup") {
							await serveStaticFile(deps.staticDir, res, "index.html");
							return;
						}

						// ─── /api/setup-info ────────────────────────────────
						if (
							pathname === "/api/setup-info" &&
							req.method === "GET"
						) {
							const lanMode =
								url.searchParams.get("mode") === "lan";
							const host =
								req.headers.host ??
								`localhost:${onboardingPort}`;
							const hostBase = host.replace(/:\d+$/, "");
							// httpsUrl uses the MAIN port, httpUrl uses the ONBOARDING port
							const httpsUrl = `https://${hostBase}:${ctx.port}`;
							const httpUrl = `http://${hostBase}:${onboardingPort}`;
							res.writeHead(200, {
								"Content-Type": "application/json",
							});
							res.end(
								JSON.stringify({
									httpsUrl,
									httpUrl,
									hasCert: true,
									lanMode,
								}),
							);
							return;
						}

						// ─── Static assets (JS, CSS, etc. for SPA) ─────────
						// Strip leading slash for file path lookup
						const filePath = pathname.startsWith("/")
							? pathname.slice(1)
							: pathname;
						if (
							filePath &&
							(await tryServeStatic(
								deps.staticDir,
								res,
								filePath,
							))
						) {
							return;
						}

						// ─── Catch-all: 302 redirect to HTTPS /setup ───────
						const redirectHost =
							req.headers.host ??
							`localhost:${onboardingPort}`;
						const redirectHostBase = redirectHost.replace(
							/:\d+$/,
							"",
						);
						res.writeHead(302, {
							Location: `https://${redirectHostBase}:${ctx.port}/setup`,
						});
						res.end();
					} catch (err) {
						log.error("Onboarding server request error:", err);
						if (!res.headersSent) {
							res.writeHead(500, {
								"Content-Type": "text/plain",
							});
							res.end("Internal Server Error");
						}
					}
				});

				server.on("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE") {
						log.warn(
							`Onboarding server: port ${onboardingPort} already in use — skipping`,
						);
						resolve();
						return;
					}
					reject(err);
				});

				server.listen(onboardingPort, ctx.host, () => {
					ctx.onboardingServer = server;
					log.info(
						`Onboarding HTTP server listening on ${ctx.host}:${onboardingPort}`,
					);
					resolve();
				});
			}),
	);
}
```

**Note:** This also requires importing `serveStaticFile` from `static-files.ts`. Update the import added in Task 2 Step 1:

```ts
import { serveStaticFile, tryServeStatic } from "../server/static-files.js";
```

### Step 2: Implement `closeOnboardingServer()`

Replace the stub:

```ts
export function closeOnboardingServer(
	ctx: DaemonLifecycleContext,
): Promise<void> {
	return new Promise((resolve) => {
		if (!ctx.onboardingServer) {
			resolve();
			return;
		}

		const timeout = setTimeout(() => {
			resolve();
		}, SHUTDOWN_TIMEOUT_MS);

		ctx.onboardingServer.close(() => {
			clearTimeout(timeout);
			ctx.onboardingServer = null;
			resolve();
		});
	});
}
```

### Step 3: Run tests, verify they pass

Run: `pnpm test:unit -- test/unit/daemon/daemon-onboarding.test.ts`
Expected: PASS (all 7 tests)

### Step 4: Run full verification

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

### Step 5: Commit

```bash
git add src/lib/daemon/daemon-lifecycle.ts
git commit -m "feat: implement HTTP onboarding server for TLS cert installation"
```

---

## Task 5: Wire onboarding server into the Daemon

**Files:**
- Modify: `src/lib/daemon/daemon.ts`

### Step 1: Add imports

At the top of `daemon.ts`, update the imports from `daemon-lifecycle.ts` (around line 46-50):

```ts
import {
	closeHttpServer as closeHttpServerImpl,
	closeIPCServer as closeIPCServerImpl,
	closeOnboardingServer as closeOnboardingServerImpl,
	type DaemonLifecycleContext,
	startHttpServer as startHttpServerImpl,
	startIPCServer as startIPCServerImpl,
	startOnboardingServer as startOnboardingServerImpl,
} from "./daemon-lifecycle.js";
```

### Step 2: Add `onboardingServer` field to Daemon class

Add after `private httpServer: HttpServer | null = null;` (line 173):

```ts
private onboardingServer: HttpServer | null = null;
```

### Step 3: Update `asLifecycleContext()` to include `onboardingServer`

In `asLifecycleContext()` (around line 893), add get/set accessors for the new field. Add after the `httpServer` accessors:

```ts
get onboardingServer() {
	return self.onboardingServer;
},
set onboardingServer(v) {
	self.onboardingServer = v;
},
```

### Step 4: Start the onboarding server in `start()`

After `await this.startHttpServer();` (line 548), add:

```ts
// Start HTTP onboarding server on port+1 when TLS is active
if (this.tlsEnabled) {
	await this.startOnboardingServer();
}
```

### Step 5: Add `startOnboardingServer` private method

Add near `startHttpServer()` (after line 1043):

```ts
private startOnboardingServer(): Promise<void> {
	return startOnboardingServerImpl(this.asLifecycleContext(), {
		caRootPath: this.tlsCerts?.caRoot ?? null,
		staticDir: this.staticDir,
	});
}
```

### Step 6: Close the onboarding server in `stop()`

In `stop()`, add before `await this.closeHttp();` (before line 793):

```ts
// Close onboarding server
await this.closeOnboarding();
```

### Step 7: Add `closeOnboarding` private method

Add near `closeHttp()` (after line 1047):

```ts
private closeOnboarding(): Promise<void> {
	return closeOnboardingServerImpl(this.asLifecycleContext());
}
```

### Step 8: Run `pnpm check`

Run: `pnpm check`
Expected: PASS

### Step 9: Write integration test

In `test/unit/daemon/daemon-tls.test.ts`, add inside the `"Daemon TLS integration"` describe block (after the last `it` around line 382):

```ts
it.skipIf(!opensslAvailable)(
	"daemon with TLS starts onboarding HTTP server on port+1",
	async () => {
		const daemonCertDir = join(tmpDir, "certs");
		mkdirSync(daemonCertDir, { recursive: true });
		writeFileSync(join(daemonCertDir, "key.pem"), testKey);
		writeFileSync(join(daemonCertDir, "cert.pem"), testCert);

		const d = new Daemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			port: 0,
			staticDir,
			tlsEnabled: true,
			smartDefault: false,
		});

		await d.start();
		const mainPort = d.port;
		const onboardingPort = mainPort + 1;

		// HTTP GET on port+1 /ca/download should return the CA cert
		const ca = await httpGet(onboardingPort, "/ca/download");
		expect(ca.status).toBe(200);
		expect(ca.body).toContain("BEGIN CERTIFICATE");

		// HTTP GET on port+1 /setup should return HTML
		const setup = await httpGet(onboardingPort, "/setup");
		expect(setup.status).toBe(200);
		expect(setup.body).toContain("<!DOCTYPE html>");

		await d.stop();
	},
);
```

### Step 10: Run tests, verify they pass

Run: `pnpm test:unit -- test/unit/daemon/daemon-tls.test.ts`
Expected: PASS

### Step 11: Run full verification

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: PASS

### Step 12: Commit

```bash
git add src/lib/daemon/daemon.ts test/unit/daemon/daemon-tls.test.ts
git commit -m "feat: wire onboarding server into daemon lifecycle"
```

---

## Task 6: Manual verification

### Step 1: Build and restart

```bash
pnpm build
# Stop existing daemon
node dist/src/bin/cli.js --stop
# Start new daemon
node dist/src/bin/cli.js start
```

### Step 2: Verify dual-port from Mac

```bash
# HTTPS main server
curl -sk https://127.0.0.1:2633/health | python3 -m json.tool

# HTTP onboarding: CA cert download
curl -s http://127.0.0.1:2634/ca/download | head -1
# Expected: -----BEGIN CERTIFICATE-----

# HTTP onboarding: setup page
curl -s http://127.0.0.1:2634/setup | head -1
# Expected: <!DOCTYPE html>

# HTTP onboarding: setup-info with correct ports
curl -s http://127.0.0.1:2634/api/setup-info | python3 -m json.tool
# Expected: httpsUrl contains :2633, httpUrl contains :2634, hasCert: true

# HTTP onboarding: unknown route redirects to HTTPS
curl -sI http://127.0.0.1:2634/anything
# Expected: 302 with Location: https://127.0.0.1:2633/setup
```

### Step 3: Verify from phone over Tailscale

1. Open `http://100.80.98.50:2634/setup` on the phone — should load the setup wizard over HTTP
2. Certificate step should offer CA download and show platform-specific install instructions
3. After installing the CA cert, the HTTPS verification should pass (this fetches `https://100.80.98.50:2633/info` from the browser)
4. After cert step, `nextStep()` in `SetupPage.svelte:148-154` redirects to `https://100.80.98.50:2633/setup` — should work without warnings

---

## Notes

- The onboarding server does NOT need auth/PIN protection — it only serves the CA cert, setup page, and SPA assets. No session data is exposed.
- The onboarding server does NOT need its own `/info` endpoint — the HTTPS verification in `SetupPage.svelte:176` fetches directly from the HTTPS main server, which already has `/info` with CORS headers.
- The onboarding server should NOT serve the main SPA routes (only `/setup` and assets needed for it). Unknown routes redirect to HTTPS.
- If `port + 1` is not available (`EADDRINUSE`), the server logs a warning but does not fail daemon startup.
- The existing `cli-notifications.ts:283-284` already constructs the correct `http://ip:port+1/setup` URL in the CLI QR code. No frontend changes needed.
- The in-app QR share modal (`QrModal.svelte`) shares the current session URL for devices that already have access — this is unrelated to onboarding and needs no changes.
