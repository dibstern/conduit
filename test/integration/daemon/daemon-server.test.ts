// ─── Integration Tests: Daemon HTTP/WS Server ──────────────────────────────
//
// Extracted from test/unit/daemon/daemon.test.ts — these tests start real
// HTTP servers and make real network requests, making them too slow for the
// unit test suite (~15s total). Run via `pnpm test:integration`.
//
// Covers:
// - WS upgrade blocking on registering projects (waitForRelay)
// - WS upgrade for non-existent slugs
// - WS upgrade returning 503 for failed relays
// - WS upgrade rejection for non-matching URLs
// - Instance status broadcast and health checking

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../../src/lib/daemon/daemon.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function daemonOpts(tmpDir: string, port = 0) {
	return {
		configDir: tmpDir,
		socketPath: join(tmpDir, "relay.sock"),
		pidPath: join(tmpDir, "daemon.pid"),
		logPath: join(tmpDir, "daemon.log"),
		port,
		smartDefault: false,
	};
}

// ─── WS Upgrade Tests ───────────────────────────────────────────────────────

describe("Daemon WS upgrade — waitForRelay integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-ws-upgrade-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("WS upgrade blocks on registering project, calls handleUpgrade when relay becomes ready", async () => {
		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();
		const port = d.port;

		// Add project without relay (simulates no OpenCode instance available)
		await d.addProject("/home/user/ws-test-app");
		const slug = "ws-test-app";

		// Project should be registering (no relay yet)
		expect(d.registry.get(slug)?.status).toBe("registering");

		const { createMockProjectRelay } = await import(
			"../../helpers/mock-factories.js"
		);

		// Prepare a mock relay with handleUpgrade that completes the WS handshake
		const relay = createMockProjectRelay();
		(relay.wsHandler as unknown as Record<string, unknown>)["handleUpgrade"] =
			vi.fn();

		// Send a raw HTTP upgrade request — it will block on waitForRelay
		// while the project is still registering
		const upgradeReq = http.request({
			hostname: "127.0.0.1",
			port,
			path: `/p/${slug}/ws`,
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		// Suppress socket errors from teardown (ECONNRESET when daemon stops)
		upgradeReq.on("error", () => {});
		upgradeReq.end();

		// Give the upgrade request time to reach the daemon handler
		await new Promise((r) => setTimeout(r, 50));

		// Now start the relay — this should unblock the pending waitForRelay
		d.registry.startRelay(slug, async () => relay);

		// Wait for relay to become ready
		await vi.waitFor(() => {
			expect(d.registry.isReady(slug)).toBe(true);
		});

		// Wait for the upgrade handler to process
		await vi.waitFor(() => {
			expect(relay.wsHandler.handleUpgrade).toHaveBeenCalled();
		});

		// Clean up
		upgradeReq.destroy();
		await d.stop();
	});

	it("WS upgrade for non-existent slug destroys socket immediately", async () => {
		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();
		const port = d.port;

		const error = await new Promise<Error>((resolve) => {
			const req = http.request({
				hostname: "127.0.0.1",
				port,
				path: "/p/ghost/ws",
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				},
			});
			const timeout = setTimeout(() => {
				req.destroy();
				resolve(new Error("timed out"));
			}, 5000);
			req.on("error", (err) => {
				clearTimeout(timeout);
				resolve(err);
			});
			req.end();
		});

		// Socket should be destroyed by the daemon (connection reset or closed)
		expect(error).toBeDefined();

		await d.stop();
	});

	it("WS upgrade returns HTTP 503 when relay fails to become ready", async () => {
		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();
		const port = d.port;

		// Add a project, then make it enter "error" state
		await d.addProject("/home/user/error-app");
		const slug = "error-app";

		// Start relay with a factory that rejects — this transitions to "error" state
		d.registry.startRelay(slug, async () => {
			throw new Error("simulated relay failure");
		});

		// Wait for the project to enter error state
		await vi.waitFor(() => {
			expect(d.registry.get(slug)?.status).toBe("error");
		});

		// Now send a WS upgrade — should get HTTP 503
		const result = await new Promise<{ statusCode: number } | { error: Error }>(
			(resolve) => {
				const req = http.request({
					hostname: "127.0.0.1",
					port,
					path: `/p/${slug}/ws`,
					headers: {
						Connection: "Upgrade",
						Upgrade: "websocket",
						"Sec-WebSocket-Version": "13",
						"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
					},
				});
				const timeout = setTimeout(() => {
					req.destroy();
					resolve({ error: new Error("timed out") });
				}, 5000);
				req.on("response", (res) => {
					clearTimeout(timeout);
					resolve({ statusCode: res.statusCode ?? 0 });
					res.resume();
				});
				req.on("error", (err) => {
					clearTimeout(timeout);
					resolve({ error: err });
				});
				req.end();
			},
		);

		// The daemon should have written "HTTP/1.1 503 Service Unavailable"
		// which Node sees as a regular response (not an upgrade)
		expect("statusCode" in result).toBe(true);
		if ("statusCode" in result) {
			expect(result.statusCode).toBe(503);
		}

		await d.stop();
	});

	it("WS upgrade on URL that does not match /p/{slug}/ws destroys socket", async () => {
		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();
		const port = d.port;

		const error = await new Promise<Error>((resolve) => {
			const req = http.request({
				hostname: "127.0.0.1",
				port,
				path: "/invalid",
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				},
			});
			const timeout = setTimeout(() => {
				req.destroy();
				resolve(new Error("timed out"));
			}, 5000);
			req.on("error", (err) => {
				clearTimeout(timeout);
				resolve(err);
			});
			req.end();
		});

		expect(error).toBeDefined();

		await d.stop();
	});
});

// ─── Instance Status Broadcast Tests ────────────────────────────────────────

describe("instance status broadcast", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-broadcast-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("getInstances returns registered instances", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const instances = daemon.getInstances();
		expect(instances.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.id).toBe("default");
	});

	it("status_changed listener is wired (does not throw without relays)", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});

		// The instanceManager emits status_changed events internally.
		// Verify the daemon constructor wired the listener without errors
		// by checking getInstances works and the daemon was created successfully.
		expect(daemon.getInstances()).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(daemon.getInstances()[0]!.status).toBe("stopped");
	});

	it("health checker authenticates with real OpenCode server", async () => {
		// This test uses the real OpenCode server running at localhost:4096.
		// OPENCODE_SERVER_PASSWORD must be set in the environment.
		// Without auth, OpenCode returns 401 and the instance stays unhealthy.
		// With the fix, the daemon injects auth headers into the health checker.

		const password = process.env["OPENCODE_SERVER_PASSWORD"];
		if (!password) {
			// Skip in CI or environments without a running OpenCode server
			return;
		}

		// Verify the server is actually there and requires auth
		const noAuthRes = await fetch("http://localhost:4096/health");
		if (noAuthRes.ok) {
			// Server doesn't require auth — test is meaningless here
			return;
		}
		expect(noAuthRes.status).toBe(401);

		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});

		// The default instance was added as unmanaged, so health polling
		// starts immediately (every 5s). Wait for it to transition to healthy.
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				const inst = daemon.getInstances()[0];
				if (inst && inst.status === "healthy") {
					clearInterval(check);
					resolve();
				}
			}, 200);
			setTimeout(() => {
				clearInterval(check);
				resolve();
			}, 15_000);
		});

		const instances = daemon.getInstances();
		expect(instances).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.id).toBe("default");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.status).toBe("healthy");
	}, 20_000);
});
