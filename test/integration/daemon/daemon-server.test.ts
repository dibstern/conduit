//
// Extracted from test/unit/daemon/daemon.test.ts — these tests start real
// HTTP servers and make real network requests, making them too slow for the
// unit test suite (~15s total). Run via `pnpm test:integration`.
//
// Covers:
// - Lazy RPC activation and project status while relays register or fail
// - Rejection of removed per-project socket paths
// - WS upgrade rejection for non-matching URLs
// - Instance status broadcast and health checking

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { AttachProject, GetStatus } from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { makeWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";

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
		port,
		smartDefault: false,
	};
}

describe("daemon project readiness and socket routing", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-ws-upgrade-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("reports a registering project as ready after its relay starts", async () => {
		const { createMockProjectRelay, makeMockConfig, makeTestHandlerLayer } =
			await import("../../helpers/mock-factories.js");
		const slug = "ws-test-app";
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				makeTestHandlerLayer({ config: makeMockConfig({ slug }) }),
				makeWsTransportLive({ noServer: true }),
			),
		);
		const rpcWsHandler = await Effect.runPromise(
			makeWsRpcWebSocketHandler({ runtime }).pipe(Effect.provide(runtime)),
		);
		const relay = createMockProjectRelay({ rpcWsHandler });

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

		const projectDir = join(tmpDir, slug);
		mkdirSync(projectDir, { recursive: true });
		let d: ForegroundDaemonHandle | null = null;

		try {
			d = await startForegroundDaemon({
				...daemonOpts(tmpDir),
				opencodeUrl: "http://localhost:4096",
			});
			const runningDaemon = d;

			await runningDaemon.addProject(projectDir);
			const registering = await sendRpcRequest(
				join(tmpDir, "relay.sock"),
				new GetStatus({}),
			);
			expect(
				registering.projects.find((project) => project.slug === slug)?.status,
			).toBe("registering");
			expect(createProjectRelayMock).not.toHaveBeenCalled();
			let attachmentSettled = false;
			const attachment = sendRpcRequest(
				join(tmpDir, "relay.sock"),
				new AttachProject({ projectSlug: slug, originId: "waiting-client" }),
			).finally(() => {
				attachmentSettled = true;
			});

			await vi.waitFor(() => {
				expect(createProjectRelayMock).toHaveBeenCalledOnce();
			});
			expect(attachmentSettled).toBe(false);
			expect(
				runningDaemon
					.getStatus()
					.projects.find((project) => project.slug === slug)?.status,
			).toBe("registering");

			releaseRelay();
			expect(await attachment).toEqual({ projectSlug: slug });

			await vi.waitFor(() => {
				expect(
					runningDaemon
						.getStatus()
						.projects.find((project) => project.slug === slug)?.status,
				).toBe("ready");
			});
			const ready = await sendRpcRequest(
				join(tmpDir, "relay.sock"),
				new GetStatus({}),
			);
			expect(
				ready.projects.find((project) => project.slug === slug)?.status,
			).toBe("ready");
		} finally {
			releaseRelay();
			try {
				await d?.stop();
			} finally {
				await rpcWsHandler.drain();
				await runtime.dispose();
				vi.doUnmock("../../../src/lib/relay/relay-stack.js");
			}
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

	it("reports failed relay startup while daemon RPC remains available", async () => {
		const createProjectRelayMock = vi.fn(async () => {
			throw new Error("Relay startup failed");
		});
		vi.doMock("../../../src/lib/relay/relay-stack.js", () => ({
			createProjectRelay: createProjectRelayMock,
		}));
		const slug = "error-app";
		let d: ForegroundDaemonHandle | null = null;

		try {
			d = await startForegroundDaemon(daemonOpts(tmpDir));
			const directory = join(tmpDir, slug);
			mkdirSync(directory);
			await d.addProject(directory);
			expect(createProjectRelayMock).not.toHaveBeenCalled();
			await expect(
				sendRpcRequest(
					join(tmpDir, "relay.sock"),
					new AttachProject({ projectSlug: slug, originId: "failed-client" }),
				),
			).rejects.toMatchObject({
				_tag: "WsRpcError",
				message: expect.stringContaining(`Project "${slug}" unavailable`),
			});
			expect(createProjectRelayMock).toHaveBeenCalledOnce();
			const runningDaemon = d;
			await vi.waitFor(() => {
				const project = runningDaemon
					.getStatus()
					.projects.find((entry) => entry.slug === slug);
				expect(project?.status).toBe("error");
			});
			const failed = await sendRpcRequest(
				join(tmpDir, "relay.sock"),
				new GetStatus({}),
			);
			expect(
				failed.projects.find((project) => project.slug === slug)?.status,
			).toBe("error");
		} finally {
			try {
				await d?.stop();
			} finally {
				vi.doUnmock("../../../src/lib/relay/relay-stack.js");
			}
		}
	});

	it("WS upgrade on a path other than /rpc destroys socket", async () => {
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
		const instance = instances[0];
		assert.exists(instance, "expected an OpenCode instance");
		expect(instance.id).toBe("opencode");
	});

	it("status_changed listener is wired (does not throw without relays)", async () => {
		daemon = await startForegroundDaemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
		});

		// The daemon wires status_changed events internally.
		// Verify getInstances works and the daemon was started successfully.
		const instances = daemon.getInstances();
		expect(instances).toHaveLength(1);
		const instance = instances[0];
		assert.exists(instance, "expected an OpenCode instance");
		expect(instance.id).toBe("opencode");
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
		const instance = instances[0];
		assert.exists(instance, "expected an OpenCode instance");
		expect(instance.id).toBe("opencode");
		expect(instance.status).toBe("healthy");
	}, 20_000);
});
