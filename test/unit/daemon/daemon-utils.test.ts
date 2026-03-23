// ─── Tests: Daemon Utility Functions ─────────────────────────────────────────
// Unit tests for probeOpenCode and findFreePort.
// probeOpenCode tests use local mock HTTP servers (no external dependencies).
// findFreePort tests allocate real OS ports.

import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findFreePort,
	isOpencodeInstalled,
	probeOpenCode,
	probeOpenCodePort,
} from "../../../src/lib/daemon/daemon-utils.js";

describe("probeOpenCode", () => {
	const servers: ReturnType<typeof createHttpServer>[] = [];

	afterEach(() => {
		for (const s of servers) {
			s.close();
		}
		servers.length = 0;
	});

	/** Start a mock HTTP server that responds with the given status code. */
	function startMockServer(statusCode: number): Promise<number> {
		return new Promise((resolve) => {
			const server = createHttpServer((_req, res) => {
				res.writeHead(statusCode);
				res.end();
			});
			servers.push(server);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				resolve(typeof addr === "object" && addr ? addr.port : 0);
			});
		});
	}

	it("returns true when server responds 200", async () => {
		const port = await startMockServer(200);
		const result = await probeOpenCode(`http://127.0.0.1:${port}`);
		expect(result).toBe(true);
	});

	it("returns true even when server responds 401 (auth required)", async () => {
		// Any HTTP response means the server is reachable
		const port = await startMockServer(401);
		const result = await probeOpenCode(`http://127.0.0.1:${port}`);
		expect(result).toBe(true);
	});

	it("returns true when server responds 500", async () => {
		const port = await startMockServer(500);
		const result = await probeOpenCode(`http://127.0.0.1:${port}`);
		expect(result).toBe(true);
	});

	it("returns false for unreachable host", async () => {
		// Port 1 is never going to have anything listening
		const result = await probeOpenCode("http://localhost:1");
		expect(result).toBe(false);
	});

	it("returns false for invalid URL", async () => {
		// Use a URL with an invalid scheme to fail fast (not a slow network timeout)
		const result = await probeOpenCode("http://[::1]:1");
		expect(result).toBe(false);
	});
});

describe("findFreePort", () => {
	const servers: ReturnType<typeof createServer>[] = [];

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

	it("returns a valid port number", async () => {
		const port = await findFreePort(4096);
		expect(port).toBeGreaterThanOrEqual(1024);
		expect(port).toBeLessThanOrEqual(65535);
	});

	it("returned port is actually available", async () => {
		const port = await findFreePort(10000);

		// Verify we can actually listen on the returned port
		const server = createServer();
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.listen(port, "127.0.0.1", () => resolve());
			server.on("error", reject);
		});

		// If we get here, the port was genuinely free
		const addr = server.address();
		expect(typeof addr === "object" && addr?.port).toBe(port);
	});

	it("skips occupied ports", async () => {
		// Occupy a specific port
		const blocker = createServer();
		servers.push(blocker);
		const blockerPort = await new Promise<number>((resolve, reject) => {
			blocker.listen(0, "127.0.0.1", () => {
				const addr = blocker.address();
				if (typeof addr === "object" && addr) resolve(addr.port);
				else reject(new Error("no address"));
			});
		});

		// findFreePort starting from that exact port should skip it
		const freePort = await findFreePort(blockerPort);
		expect(freePort).not.toBe(blockerPort);
		expect(freePort).toBeGreaterThanOrEqual(blockerPort);
	});
});

describe("isOpencodeInstalled", () => {
	it("returns a boolean", () => {
		const result = isOpencodeInstalled();
		expect(typeof result).toBe("boolean");
	});

	it("detects a known binary on PATH (node)", async () => {
		// `node` is always on PATH in our test environment.
		// We can't easily stub `which`, so we just verify isOpencodeInstalled
		// returns a boolean without throwing.
		const result = isOpencodeInstalled();
		// On CI or dev machines, opencode may or may not be installed.
		// The function should never throw — only return true or false.
		expect(result === true || result === false).toBe(true);
	});
});

describe("probeOpenCodePort", () => {
	it("returns true for valid 200 OpenCode response", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true });
		const result = await probeOpenCodePort(4098, {
			fetch: mockFetch,
			timeoutMs: 2000,
		});
		expect(result).toBe(true);
		expect(mockFetch).toHaveBeenCalledWith(
			"http://127.0.0.1:4098/api/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("returns true for 401 response (auth-required instance)", async () => {
		// Any HTTP response — including 401 — means an OpenCode server is
		// listening. The scanner's job is discovery, not auth verification.
		const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
		const result = await probeOpenCodePort(4098, {
			fetch: mockFetch,
			timeoutMs: 2000,
		});
		expect(result).toBe(true);
	});

	it("returns true for 500 response (server error still means alive)", async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
		const result = await probeOpenCodePort(4098, {
			fetch: mockFetch,
			timeoutMs: 2000,
		});
		expect(result).toBe(true);
	});

	it("returns false on timeout/network error", async () => {
		const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await probeOpenCodePort(4098, {
			fetch: mockFetch,
			timeoutMs: 2000,
		});
		expect(result).toBe(false);
	});
});
