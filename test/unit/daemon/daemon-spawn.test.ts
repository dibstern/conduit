// ─── Tests: spawnDaemon port pre-flight check ───────────────────────────────
// Verifies that spawnDaemon detects ports already in use (EADDRINUSE) and
// throws a clear, actionable error message before attempting to spawn.

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDaemon } from "../../../src/lib/daemon/daemon-spawn.js";

describe("spawnDaemon port pre-flight check", () => {
	const servers: Server[] = [];

	afterEach(() => {
		for (const s of servers) {
			try {
				s.close();
			} catch {
				// ignore
			}
		}
		servers.length = 0;
	});

	/** Bind a TCP server to a random port on 127.0.0.1, return the assigned port. */
	function bindPort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			servers.push(server);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (typeof addr === "object" && addr) {
					resolve(addr.port);
				} else {
					reject(new Error("Failed to get bound address"));
				}
			});
			server.on("error", reject);
		});
	}

	const stubIsRunning = async (_socketPath: string) => false;

	it("throws EADDRINUSE when port is already in use", async () => {
		const port = await bindPort();

		await expect(
			spawnDaemon(
				{ port, host: "127.0.0.1", configDir: "/tmp/conduit-test-spawn" },
				stubIsRunning,
			),
		).rejects.toThrow("EADDRINUSE");
	});

	it("includes actionable stop instructions in the error message", async () => {
		const port = await bindPort();

		await expect(
			spawnDaemon(
				{ port, host: "127.0.0.1", configDir: "/tmp/conduit-test-spawn" },
				stubIsRunning,
			),
		).rejects.toThrow("npx conduit --stop");
	});

	it("error message contains the port number", async () => {
		const port = await bindPort();

		await expect(
			spawnDaemon(
				{ port, host: "127.0.0.1", configDir: "/tmp/conduit-test-spawn" },
				stubIsRunning,
			),
		).rejects.toThrow(`Port ${port} address already in use`);
	});

	it("error message matches expected format exactly", async () => {
		const port = await bindPort();

		await expect(
			spawnDaemon(
				{ port, host: "127.0.0.1", configDir: "/tmp/conduit-test-spawn" },
				stubIsRunning,
			),
		).rejects.toThrow(
			`EADDRINUSE: Port ${port} address already in use. Stop the existing daemon with: npx conduit --stop`,
		);
	});
});
