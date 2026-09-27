// ─── Integration Tests: Daemon HTTP/WS Server ──────────────────────────────
//
// Extracted from test/unit/daemon/daemon.test.ts — these tests start real
// HTTP servers and make real network requests, making them too slow for the
// unit test suite (~15s total). Run via `pnpm test:integration`.
//
// Covers:
// - WS attachment waiting on registering projects (waitForRelay)
// - Rejection of removed per-project socket paths
// - WS connections remaining unattached for failed relays
// - WS upgrade rejection for non-matching URLs
// - Instance status broadcast and health checking

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";

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

	it("WS connection attaches when a registering relay becomes ready", async () => {
		const { createMockProjectRelay } = await import(
			"../../helpers/mock-factories.js"
		);
		const relay = createMockProjectRelay();
		const attach = vi.spyOn(relay.wsHandler, "attach");

		let releaseRelay!: () => void;
		const relayGate = new Promise<void>((resolve) => {
			releaseRelay = resolve;
		});
		const createProjectRelayMock = vi.fn(async () => {
			await relayGate;
			return relay;
		});
		vi.doMock("../../../src/lib/relay/relay-stack.js", () => ({
			createProjectRelay: createProjectRelayMock,
		}));

		const slug = "ws-test-app";
		const projectDir = join(tmpDir, slug);
		mkdirSync(projectDir, { recursive: true });
		let d: ForegroundDaemonHandle | null = null;
		let ws: WebSocket | null = null;

		try {
			d = await startForegroundDaemon({
				...daemonOpts(tmpDir),
				opencodeUrl: "http://localhost:4096",
			});
			const runningDaemon = d;
			const port = runningDaemon.port;

			await runningDaemon.addProject(projectDir, slug);
			expect(
				runningDaemon
					.getStatus()
					.projects.find((project) => project.slug === slug)?.status,
			).toBe("registering");

			ws = new WebSocket(
				`ws://127.0.0.1:${port}/ws?p=${slug}&client=waiting-client`,
			);
			const socket = ws;
			await new Promise<void>((resolve, reject) => {
				socket.once("open", resolve);
				socket.once("error", reject);
			});

			await vi.waitFor(() => {
				expect(createProjectRelayMock).toHaveBeenCalled();
			});
			expect(attach).not.toHaveBeenCalled();

			releaseRelay();

			await vi.waitFor(() => {
				expect(
					runningDaemon
						.getStatus()
						.projects.find((project) => project.slug === slug)?.status,
				).toBe("ready");
			});
			await vi.waitFor(() => {
				expect(attach).toHaveBeenCalledWith(expect.any(WebSocket), {
					clientId: "waiting-client",
					skipDefaultSession: true,
				});
			});
		} finally {
			ws?.terminate();
			await d?.stop();
			vi.doUnmock("../../../src/lib/relay/relay-stack.js");
		}
	});

	it.each([
		"/p/ghost/ws",
		"/p/ghost/rpc",
	])("rejects removed socket path %s", async (path) => {
		const d = await startForegroundDaemon(daemonOpts(tmpDir));
		const port = d.port;

		try {
			const error = await new Promise<Error>((resolve) => {
				const req = http.request({
					hostname: "127.0.0.1",
					port,
					path,
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
			expect(error).toMatchObject({ code: "ECONNRESET" });
		} finally {
			await d.stop();
		}
	});

	it("WS stays open without attaching when the relay fails to become ready", async () => {
		const d = await startForegroundDaemon(daemonOpts(tmpDir));
		const port = d.port;

		// Add a project with no usable OpenCode instance. Relay startup should
		// fail through the Effect-owned relay cache without closing the daemon socket.
		await d.addProject("/home/user/error-app", "error-app");
		const slug = "error-app";
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?p=${slug}`);
		const messages: string[] = [];
		ws.on("message", (data) => messages.push(data.toString()));

		try {
			await new Promise<void>((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			});
			await vi.waitFor(() => {
				const project = d
					.getStatus()
					.projects.find((entry) => entry.slug === slug);
				expect(project?.status).toBe("error");
			});
			expect(ws.readyState).toBe(WebSocket.OPEN);
			expect(
				messages.some((message) => message.includes("project_attached")),
			).toBe(false);
		} finally {
			ws.terminate();
			await d.stop();
		}
	});

	it("WS upgrade on a path other than /ws or /rpc destroys socket", async () => {
		const d = await startForegroundDaemon(daemonOpts(tmpDir));
		const port = d.port;

		try {
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
		} finally {
			await d.stop();
		}
	});
});

// ─── Instance Status Broadcast Tests ────────────────────────────────────────

describe("instance status broadcast", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | null = null;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-broadcast-");
	});

	afterEach(async () => {
		try {
			await daemon?.stop();
		} catch {
			// ignore
		}
		daemon = null;
		cleanTmpDir(tmpDir);
	});

	it("getInstances returns registered instances", async () => {
		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
		});
		const instances = daemon.getInstances();
		expect(instances.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.id).toBe("opencode");
	});

	it("status_changed listener is wired (does not throw without relays)", async () => {
		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
		});

		// The daemon wires status_changed events internally.
		// Verify getInstances works and the daemon was started successfully.
		expect(daemon.getInstances()).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(daemon.getInstances()[0]!.id).toBe("opencode");
	});

	it("health checker authenticates with real OpenCode server", async () => {
		// This test uses the real OpenCode server from OPENCODE_URL, falling back
		// to the historical default URL only when no explicit URL is configured.
		// OPENCODE_SERVER_PASSWORD must be set in the environment.
		// Without auth, OpenCode returns 401 and the instance stays unhealthy.
		// With the fix, the daemon injects auth headers into the health checker.

		const password = process.env["OPENCODE_SERVER_PASSWORD"];
		if (!password) {
			return;
		}
		const opencodeUrl = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

		// Verify the server is actually there and requires auth.
		let noAuthRes: Response;
		try {
			noAuthRes = await fetch(`${opencodeUrl}/health`);
		} catch {
			return;
		}
		if (noAuthRes.ok) {
			// Server doesn't require auth — test is meaningless here
			return;
		}
		expect(noAuthRes.status).toBe(401);

		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl,
		});

		// The default instance was added as unmanaged, so health polling
		// starts immediately (every 5s). Wait for it to transition to healthy.
		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				const inst = daemon?.getInstances()[0];
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
		expect(instances[0]!.id).toBe("opencode");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.status).toBe("healthy");
	}, 20_000);
});
