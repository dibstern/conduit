import { GetStatus, SetPin } from "../../../src/lib/contracts/ws-rpc.js";
/**
 * Integration test: Daemon start/stop lifecycle cleans up all async work.
 *
 * Starts a real foreground daemon, stops it, and verifies
 * no lingering server/socket handles remain and the HTTP server is
 * unreachable. This is the end-to-end proof that the async lifecycle
 * refactor works: the process WILL exit after stop().
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPin } from "../../../src/lib/auth.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { setLogLevel } from "../../../src/lib/logger.js";

// Suppress info-level log noise
setLogLevel("warn");

/** Make an HTTP request and return the status code, or the error code on failure. */
async function httpStatus(url: string): Promise<number | string> {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", (err) => {
			// Return the error code (ECONNREFUSED, ECONNRESET, etc.)
			resolve((err as NodeJS.ErrnoException).code ?? "UNKNOWN");
		});
		req.setTimeout(2000, () => {
			req.destroy();
			resolve("TIMEOUT");
		});
	});
}

describe("Daemon lifecycle (real services, real timers)", () => {
	let tmpDir: string;
	let daemon: ForegroundDaemonHandle | null = null;

	afterEach(async () => {
		if (daemon) {
			try {
				await daemon.stop();
			} catch {
				// already stopped
			}
			daemon = null;
		}
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("stop() closes HTTP server — no more connections accepted", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			port: 0, // OS-assigned
			keepAwake: false,
			smartDefault: false,
		});

		const port = daemon.getStatus().port;

		// Daemon HTTP is alive
		const statusBefore = await httpStatus(`http://127.0.0.1:${port}/health`);
		expect(statusBefore).toBe(200);

		// Stop
		await daemon.stop();
		daemon = null;

		// HTTP server is gone — expect a connection error (refused, reset, etc.)
		const statusAfter = await httpStatus(`http://127.0.0.1:${port}/health`);
		expect(typeof statusAfter).toBe("string"); // error code, not a status number
	}, 15_000);

	it("removes a PIN over RPC immediately and keeps it removed after restart", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-pin-removal-"));
		const options = {
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			port: 0,
			keepAwake: false,
			smartDefault: false,
		};
		daemon = await startForegroundDaemon({
			...options,
			pinHash: hashPin("1234"),
		});
		const baseUrl = `http://127.0.0.1:${daemon.getStatus().port}`;
		const before = await fetch(baseUrl, { redirect: "manual" });
		await before.arrayBuffer();
		expect(before.status).toBe(302);
		expect(before.headers.get("location")).toBe("/auth");
		expect(
			await sendRpcRequest(options.socketPath, new SetPin({ pin: "1234" })),
		).toEqual({ ok: true });
		await expect
			.poll(() => {
				const config: unknown = JSON.parse(
					readFileSync(join(tmpDir, "daemon.json"), "utf-8"),
				);
				return config;
			})
			.toMatchObject({ pinHash: hashPin("1234") });

		expect(
			await sendRpcRequest(options.socketPath, new SetPin({ pin: null })),
		).toEqual({ ok: true });

		const after = await fetch(baseUrl, { redirect: "manual" });
		await after.arrayBuffer();
		expect(after.status).not.toBe(302);
		expect(after.headers.get("location")).not.toBe("/auth");
		expect(await httpStatus(`${baseUrl}/api/projects`)).toBe(200);
		expect(
			await sendRpcRequest(options.socketPath, new GetStatus({})),
		).toMatchObject({
			pinEnabled: false,
		});
		await expect
			.poll(() => {
				const config: unknown = JSON.parse(
					readFileSync(join(tmpDir, "daemon.json"), "utf-8"),
				);
				return config;
			})
			.toMatchObject({ pinHash: null });

		await daemon.stop();
		daemon = null;
		daemon = await startForegroundDaemon(options);
		const restartedUrl = `http://127.0.0.1:${daemon.getStatus().port}`;
		const restarted = await fetch(restartedUrl, { redirect: "manual" });
		await restarted.arrayBuffer();
		expect(restarted.status).not.toBe(302);
		expect(restarted.headers.get("location")).not.toBe("/auth");
		expect(await httpStatus(`${restartedUrl}/api/projects`)).toBe(200);
		expect(
			await sendRpcRequest(options.socketPath, new GetStatus({})),
		).toMatchObject({
			pinEnabled: false,
		});
	}, 30_000);

	it("stop() removes the RPC socket", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));
		const socketPath = join(tmpDir, "relay.sock");

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath,
			port: 0,
			keepAwake: false,
			smartDefault: false,
		});

		expect(existsSync(socketPath)).toBe(true);

		await daemon.stop();
		daemon = null;

		// Cleaned up
		expect(existsSync(socketPath)).toBe(false);
	}, 15_000);

	it("stop() with a registered project cleans up relay services too", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));

		daemon = await startForegroundDaemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			port: 0,
			keepAwake: false,
			smartDefault: false,
		});

		const port = daemon.getStatus().port;

		// Add a project — creates a relay stack with its own services
		await daemon.addProject(process.cwd());

		await vi.waitFor(
			async () => {
				const statusBefore = await httpStatus(
					`http://127.0.0.1:${port}/health`,
				);
				expect(statusBefore).toBe(200);
			},
			{ timeout: 2_000 },
		);

		// Stop everything — daemon + all relay services
		await daemon.stop();
		daemon = null;
		await vi.waitFor(
			async () => {
				const statusAfter = await httpStatus(`http://127.0.0.1:${port}/health`);
				expect(typeof statusAfter).toBe("string"); // error code, not a status number
			},
			{ timeout: 2_000 },
		);
	}, 15_000);
});
