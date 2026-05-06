// ─── Tests: Daemon TLS Wiring ────────────────────────────────────────────────
//
// Tests cover:
// 1. daemon-lifecycle.ts: startHttpServer creates HTTPS server when TLS certs provided
// 2. daemon-lifecycle.ts: startHttpServer still creates HTTP without TLS (regression)
// 3. daemon.ts: Daemon with tlsEnabled calls ensureCerts and serves HTTPS
// 4. daemon.ts: Daemon with tlsEnabled wires caRootPath so /ca/download works

import { execSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
import type { DaemonLifecycleContext } from "../../../src/lib/daemon/daemon-lifecycle.js";
import { startHttpServer } from "../../../src/lib/daemon/daemon-lifecycle.js";

// ─── Generate test certs (same pattern as server.pbt.test.ts) ────────────────

let testKey: Buffer;
let testCert: Buffer;
let certDir: string;
let caPath: string;
let opensslAvailable = false;

try {
	certDir = mkdtempSync(join(tmpdir(), "daemon-tls-test-"));
	const keyPath = join(certDir, "key.pem");
	const certPath = join(certDir, "cert.pem");
	caPath = join(certDir, "ca.pem");

	execSync(
		`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`,
	);
	execSync(`cp ${certPath} ${caPath}`);

	testKey = Buffer.from(readFileSync(keyPath, "utf-8"));
	testCert = Buffer.from(readFileSync(certPath, "utf-8"));
	opensslAvailable = true;
} catch {
	testKey = Buffer.from(
		"-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n",
	);
	testCert = Buffer.from(
		"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
	);
	certDir = mkdtempSync(join(tmpdir(), "daemon-tls-test-"));
	caPath = join(certDir, "ca.pem");
	writeFileSync(
		caPath,
		"-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n",
	);
}

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

function httpsGet(
	port: number,
	path = "/",
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
				timeout: 5000,
				rejectUnauthorized: false,
			},
			(res) => {
				let data = "";
				res.on("data", (chunk: string) => {
					data += chunk;
				});
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, body: data });
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("HTTPS request timed out"));
		});
		req.end();
	});
}

function httpGet(
	port: number,
	path = "/",
): Promise<{ status: number; body: string }> {
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
					resolve({ status: res.statusCode ?? 0, body: data });
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

// ─── Test: daemon-lifecycle.ts — startHttpServer with TLS ────────────────────

describe("startHttpServer TLS support", () => {
	it.skipIf(!opensslAvailable)(
		"creates HTTPS server when tls certs are provided in context",
		async () => {
			const ctx: DaemonLifecycleContext = {
				port: 0,
				host: "127.0.0.1",
				httpServer: null,
				upgradeServer: null,
				onboardingServer: null,
				ipcServer: null,
				ipcClients: new Set(),
				clientCount: 0,
				socketPath: "/tmp/unused.sock",
				router: {
					handleRequest: async (_req, res) => {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, tls: true }));
					},
				},
				tls: { key: testKey, cert: testCert },
			};

			await startHttpServer(ctx);
			const port = ctx.port;
			expect(port).toBeGreaterThan(0);

			// HTTPS request should succeed
			const { status, body } = await httpsGet(port, "/health");
			expect(status).toBe(200);
			const parsed = JSON.parse(body);
			expect(parsed.tls).toBe(true);

			// Clean up
			await new Promise<void>((resolve) => {
				ctx.httpServer?.close(() => resolve());
			});
		},
	);

	it.skipIf(!opensslAvailable)(
		"still creates HTTP server when no tls in context (regression)",
		async () => {
			const ctx: DaemonLifecycleContext = {
				port: 0,
				host: "127.0.0.1",
				httpServer: null,
				upgradeServer: null,
				onboardingServer: null,
				ipcServer: null,
				ipcClients: new Set(),
				clientCount: 0,
				socketPath: "/tmp/unused.sock",
				router: {
					handleRequest: async (_req, res) => {
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ ok: true, tls: false }));
					},
				},
			};

			await startHttpServer(ctx);
			const port = ctx.port;
			expect(port).toBeGreaterThan(0);

			// HTTP request should succeed
			const { status, body } = await httpGet(port, "/health");
			expect(status).toBe(200);
			const parsed = JSON.parse(body);
			expect(parsed.tls).toBe(false);

			// Clean up
			await new Promise<void>((resolve) => {
				ctx.httpServer?.close(() => resolve());
			});
		},
	);
});

// ─── Test: Daemon integration — TLS end-to-end ──────────────────────────────

describe("Daemon TLS integration", () => {
	let tmpDir: string;
	let staticDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-tls-int-");
		staticDir = join(tmpDir, "public");
		mkdirSync(staticDir, { recursive: true });
		writeFileSync(
			join(staticDir, "index.html"),
			"<!DOCTYPE html><html><body>Conduit</body></html>",
			"utf-8",
		);
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it.skipIf(!opensslAvailable)(
		"daemon with tlsEnabled serves HTTPS when certs exist",
		async () => {
			// Place certs in the daemon's config dir where ensureCerts would put them
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
			const port = d.port;

			// HTTPS GET /health should work
			const { status, body } = await httpsGet(port, "/health");
			expect(status).toBe(200);
			const parsed = JSON.parse(body);
			expect(parsed.ok).toBe(true);
			expect(parsed.tlsEnabled).toBe(true);

			await d.stop();
		},
	);

	it.skipIf(!opensslAvailable)(
		"daemon with tlsEnabled wires /ca/download endpoint",
		async () => {
			// Place certs + CA in the daemon's config dir
			const daemonCertDir = join(tmpDir, "certs");
			mkdirSync(daemonCertDir, { recursive: true });
			writeFileSync(join(daemonCertDir, "key.pem"), testKey);
			writeFileSync(join(daemonCertDir, "cert.pem"), testCert);
			// Self-signed cert is its own CA — place as rootCA.pem for
			// the fallback CA root lookup when mkcert is not installed.
			writeFileSync(join(daemonCertDir, "rootCA.pem"), testCert);

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
			const port = d.port;

			// /ca/download should return the CA certificate (DER-encoded for iOS)
			const { status, body } = await httpsGet(port, "/ca/download");
			expect(status).toBe(200);
			// DER is binary, so it won't contain PEM markers. Just verify it's non-empty.
			expect(body.length).toBeGreaterThan(0);

			await d.stop();
		},
	);

	it.skipIf(!opensslAvailable)(
		"daemon with tlsEnabled auto-binds to 0.0.0.0 (all interfaces)",
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
				// No explicit host — should auto-bind to 0.0.0.0
			});

			await d.start();

			const status = d.getStatus();
			expect(status.host).toBe("0.0.0.0");

			await d.stop();
		},
	);

	it("daemon without TLS stays bound to 127.0.0.1", async () => {
		const d = new Daemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			port: 0,
			staticDir,
			tlsEnabled: false,
			smartDefault: false,
		});

		await d.start();

		const status = d.getStatus();
		expect(status.host).toBe("127.0.0.1");

		await d.stop();
	});

	it.skipIf(!opensslAvailable)(
		"explicit host is not overridden by TLS auto-bind",
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
				host: "127.0.0.1", // Explicit host — should NOT be overridden
				staticDir,
				tlsEnabled: true,
				smartDefault: false,
			});

			await d.start();

			const status = d.getStatus();
			expect(status.host).toBe("127.0.0.1");

			await d.stop();
		},
	);

	it.skipIf(!opensslAvailable)(
		"daemon with TLS starts onboarding HTTP server on port+1",
		async () => {
			const daemonCertDir = join(tmpDir, "certs");
			mkdirSync(daemonCertDir, { recursive: true });
			writeFileSync(join(daemonCertDir, "key.pem"), testKey);
			writeFileSync(join(daemonCertDir, "cert.pem"), testCert);
			writeFileSync(join(daemonCertDir, "rootCA.pem"), testCert);

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

			// HTTP GET on port+1 /ca/download should return the CA cert (DER-encoded)
			const ca = await httpGet(onboardingPort, "/ca/download");
			expect(ca.status).toBe(200);
			expect(ca.body.length).toBeGreaterThan(0);

			// HTTP GET on port+1 /setup should return HTML
			const setup = await httpGet(onboardingPort, "/setup");
			expect(setup.status).toBe(200);
			expect(setup.body).toContain("<!DOCTYPE html>");

			await d.stop();
		},
	);
});
