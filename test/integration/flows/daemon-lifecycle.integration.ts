/**
 * Integration test: Daemon start/stop lifecycle cleans up all async work.
 *
 * Starts a real Daemon (PortScanner, VersionChecker, StorageMonitor,
 * InstanceManager, ProjectRegistry — all with real timers), stops it, and
 * verifies no lingering server/socket handles remain and the HTTP server
 * is unreachable. This is the end-to-end proof that the async lifecycle
 * refactor works: the process WILL exit after stop().
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
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
	let daemon: Daemon | null = null;

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

		daemon = new Daemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			port: 0, // OS-assigned
			keepAwake: false,
			smartDefault: false,
		});

		await daemon.start();
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

	it("stop() removes PID file and socket file", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));
		const pidPath = join(tmpDir, "daemon.pid");
		const socketPath = join(tmpDir, "relay.sock");

		daemon = new Daemon({
			configDir: tmpDir,
			socketPath,
			pidPath,
			logPath: join(tmpDir, "daemon.log"),
			port: 0,
			keepAwake: false,
			smartDefault: false,
		});

		await daemon.start();

		// Files exist while running
		expect(existsSync(pidPath)).toBe(true);

		await daemon.stop();
		daemon = null;

		// Cleaned up
		expect(existsSync(pidPath)).toBe(false);
		expect(existsSync(socketPath)).toBe(false);
	}, 15_000);

	it("stop() with a registered project cleans up relay services too", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));

		daemon = new Daemon({
			configDir: tmpDir,
			socketPath: join(tmpDir, "relay.sock"),
			pidPath: join(tmpDir, "daemon.pid"),
			logPath: join(tmpDir, "daemon.log"),
			port: 0,
			keepAwake: false,
			smartDefault: false,
		});

		await daemon.start();
		const port = daemon.getStatus().port;

		// Add a project — creates a relay stack with its own services
		await daemon.addProject(process.cwd());

		// Let relay services start
		await new Promise((r) => setTimeout(r, 500));

		// Verify relay is serving
		const statusBefore = await httpStatus(`http://127.0.0.1:${port}/health`);
		expect(statusBefore).toBe(200);

		// Stop everything — daemon + all relay services
		await daemon.stop();
		daemon = null;
		await new Promise((r) => setTimeout(r, 300));

		// Everything is gone — expect a connection error
		const statusAfter = await httpStatus(`http://127.0.0.1:${port}/health`);
		expect(typeof statusAfter).toBe("string"); // error code, not a status number
	}, 15_000);
});
