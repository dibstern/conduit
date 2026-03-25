// ─── Tests: Daemon Process (Ticket 3.1) ─────────────────────────────────────
//
// Tests cover:
// T1: Constructor with defaults (AC2)
// T2: PID file write/read/remove (AC1)
// T3: Stale PID detection (AC4)
// T4: getStatus() shape (AC3)
// T5: addProject() / removeProject() (AC2)
// T6: Shutdown cleanup (AC5)
// T7: Signal handlers (AC6)
// T8: Crash counter — resets after 60s, gives up after 3 (AC7)
// T9: isRunning() false for stale/missing (AC4)
// T10: spawn() child config — detached, stdio (AC1)
// T11: clientCount bug fix — error handler decrements clientCount
// T12: isRunning() true case — running daemon
// Integration: IPC commands (get_status, add_project, list_projects, remove_project, set_project_title, shutdown, invalid JSON)
// Integration: HTTP health endpoint

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type DaemonConfig,
	loadDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { Daemon } from "../../../src/lib/daemon/daemon.js";
import { DEFAULT_CONFIG_DIR } from "../../../src/lib/env.js";
import { setLogLevel } from "../../../src/lib/logger.js";

// Suppress info-level pino JSON output during tests — prevents log noise from drowning
// test results. Keep warn/error so tests that inspect pino warn output still work.
setLogLevel("warn");

const SEED = 42;
const NUM_RUNS = 30;

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

/** Send an IPC command to a Unix socket and get the response */
function sendIPCCommand(
	socketPath: string,
	command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const client = connect(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			client.destroy();
			reject(new Error("IPC command timed out"));
		}, 5000);

		client.on("connect", () => {
			client.write(`${JSON.stringify(command)}\n`);
		});

		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				clearTimeout(timeout);
				const line = buffer.slice(0, newlineIndex).trim();
				client.destroy();
				try {
					resolve(JSON.parse(line));
				} catch {
					reject(new Error(`Invalid JSON response: ${line}`));
				}
			}
		});

		client.on("error", (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

/** Send raw bytes to a Unix socket and get the response */
function sendRawToSocket(
	socketPath: string,
	raw: string,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const client = connect(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			client.destroy();
			reject(new Error("Raw IPC command timed out"));
		}, 5000);

		client.on("connect", () => {
			client.write(raw);
		});

		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				clearTimeout(timeout);
				const line = buffer.slice(0, newlineIndex).trim();
				client.destroy();
				try {
					resolve(JSON.parse(line));
				} catch {
					reject(new Error(`Invalid JSON response: ${line}`));
				}
			}
		});

		client.on("error", (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

/** Connect to a Unix socket, wait for connection, then return the socket */
function connectToSocket(
	socketPath: string,
): Promise<import("node:net").Socket> {
	return new Promise((resolve, reject) => {
		const client = connect(socketPath);
		const timeout = setTimeout(() => {
			client.destroy();
			reject(new Error("connect timeout"));
		}, 5000);

		client.on("connect", () => {
			clearTimeout(timeout);
			resolve(client);
		});

		client.on("error", (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

/** Make an HTTP GET request and return parsed JSON */
function httpGet(
	port: number,
	path = "/",
): Promise<{ status: number; body: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: "127.0.0.1", port, path, method: "GET", timeout: 5000 },
			(res) => {
				let data = "";
				res.on("data", (chunk: string) => {
					data += chunk;
				});
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
					} catch {
						reject(new Error(`Invalid JSON from HTTP: ${data}`));
					}
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

/** Make an HTTP GET request and return status + headers + raw body text */
function httpGetRaw(
	port: number,
	path = "/",
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
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
						headers: res.headers,
						body: data,
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

// ─── F1 Diagnostic ───────────────────────────────────────────────────────────

afterAll(() => {
	// F1 diagnostic: log active handles if any remain after all tests
	// biome-ignore lint/suspicious/noExplicitAny: undocumented Node.js diagnostic API
	const handles = (process as any)._getActiveHandles?.() ?? [];
	// biome-ignore lint/suspicious/noExplicitAny: undocumented Node.js diagnostic API
	const requests = (process as any)._getActiveRequests?.() ?? [];
	if (handles.length > 0 || requests.length > 0) {
		console.warn(
			`[F1 Diagnostic] Active handles after test suite: ${handles.length} handles, ${requests.length} requests`,
		);
		for (const h of handles) {
			console.warn(`  Handle: ${h.constructor?.name ?? typeof h}`);
		}
	}
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 3.1 — Daemon Process", () => {
	// ─── T1: Constructor with defaults ──────────────────────────────────

	describe("T1: Constructor with defaults (AC2)", () => {
		it("uses default port, configDir, socketPath, logPath, pidPath", () => {
			const d = new Daemon();

			expect(d.port).toBe(2633);
			expect(d.configDir).toBe(DEFAULT_CONFIG_DIR);
			expect(d.socketPath).toBe(join(DEFAULT_CONFIG_DIR, "relay.sock"));
			expect(d.logPath).toBe(join(DEFAULT_CONFIG_DIR, "daemon.log"));
			expect(d.pidPath).toBe(join(DEFAULT_CONFIG_DIR, "daemon.pid"));
		});

		it("accepts custom options", () => {
			const d = new Daemon({
				port: 9999,
				configDir: "/tmp/test-relay",
				socketPath: "/tmp/test-relay/custom.sock",
				logPath: "/tmp/test-relay/custom.log",
				pidPath: "/tmp/test-relay/custom.pid",
			});

			expect(d.port).toBe(9999);
			expect(d.configDir).toBe("/tmp/test-relay");
			expect(d.socketPath).toBe("/tmp/test-relay/custom.sock");
			expect(d.logPath).toBe("/tmp/test-relay/custom.log");
			expect(d.pidPath).toBe("/tmp/test-relay/custom.pid");
		});

		it("property: port defaults to 2633 for any configDir", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 50 }).map((s) => `/tmp/${s}`),
					(configDir) => {
						const d = new Daemon({ configDir });
						expect(d.port).toBe(2633);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("socketPath and logPath derive from configDir when not specified", () => {
			const d = new Daemon({ configDir: "/custom/dir" });

			expect(d.socketPath).toBe("/custom/dir/relay.sock");
			expect(d.logPath).toBe("/custom/dir/daemon.log");
			expect(d.pidPath).toBe("/custom/dir/daemon.pid");
		});
	});

	// ─── T2: PID file write/read/remove ────────────────────────────────

	describe("T2: PID file write/read/remove (AC1)", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-test-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("start() writes PID file with current process PID", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			const pidContent = readFileSync(
				join(tmpDir, "daemon.pid"),
				"utf-8",
			).trim();
			expect(Number.parseInt(pidContent, 10)).toBe(process.pid);

			await d.stop();
		});

		it("stop() removes PID file", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			expect(existsSync(join(tmpDir, "daemon.pid"))).toBe(true);

			await d.stop();
			expect(existsSync(join(tmpDir, "daemon.pid"))).toBe(false);
		});

		it("stop() removes socket file", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			expect(existsSync(join(tmpDir, "relay.sock"))).toBe(true);

			await d.stop();
			expect(existsSync(join(tmpDir, "relay.sock"))).toBe(false);
		});
	});

	// ─── T3: Stale PID detection ──────────────────────────────────────

	describe("T3: Stale PID detection (AC4)", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-stale-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("isRunning() returns false when PID file points to dead process", async () => {
			const pidPath = join(tmpDir, "daemon.pid");
			const socketPath = join(tmpDir, "relay.sock");

			// Write a PID that definitely doesn't exist
			writeFileSync(pidPath, "999999999", "utf-8");

			const result = await Daemon.isRunning(socketPath);
			expect(result).toBe(false);

			// Stale PID file should be cleaned up
			expect(existsSync(pidPath)).toBe(false);
		});

		it("isRunning() returns false when PID file is missing", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const result = await Daemon.isRunning(socketPath);
			expect(result).toBe(false);
		});

		it("isRunning() returns false when PID file contains garbage", async () => {
			const pidPath = join(tmpDir, "daemon.pid");
			const socketPath = join(tmpDir, "relay.sock");

			writeFileSync(pidPath, "not-a-number", "utf-8");
			const result = await Daemon.isRunning(socketPath);
			expect(result).toBe(false);

			// Should clean up stale PID file
			expect(existsSync(pidPath)).toBe(false);
		});
	});

	// ─── T4: getStatus() shape ────────────────────────────────────────

	describe("T4: getStatus() shape (AC3)", () => {
		it("returns expected shape with correct types", () => {
			const d = new Daemon({ port: 4567 });
			const status = d.getStatus();

			expect(status).toHaveProperty("ok", true);
			expect(status).toHaveProperty("uptime");
			expect(typeof status.uptime).toBe("number");
			expect(status.uptime).toBeGreaterThanOrEqual(0);
			expect(status).toHaveProperty("port", 4567);
			expect(status).toHaveProperty("projectCount", 0);
			expect(status).toHaveProperty("clientCount", 0);
		});

		it("projectCount reflects added projects", async () => {
			const d = new Daemon();
			await d.addProject("/home/user/project1");
			await d.addProject("/home/user/project2");

			const status = d.getStatus();
			expect(status.projectCount).toBe(2);
		});

		it("property: port in status always matches constructor port", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1024, max: 65535 }), (port) => {
					const d = new Daemon({ port });
					expect(d.getStatus().port).toBe(port);
				}),
				{ seed: SEED, numRuns: 50, endOnFailure: true },
			);
		});
	});

	// ─── T5: addProject() / removeProject() ──────────────────────────

	describe("T5: addProject() / removeProject() (AC2)", () => {
		it("addProject generates slug from directory", async () => {
			const d = new Daemon();
			const project = await d.addProject("/home/user/my-app");

			expect(project.slug).toBe("my-app");
			expect(project.directory).toBe("/home/user/my-app");
			expect(project.title).toBe("my-app");
			expect(typeof project.lastUsed).toBe("number");
		});

		it("addProject accepts custom slug", async () => {
			const d = new Daemon();
			const project = await d.addProject("/home/user/project", "custom-slug");

			expect(project.slug).toBe("custom-slug");
		});

		it("addProject returns existing project for same directory", async () => {
			const d = new Daemon();
			const p1 = await d.addProject("/home/user/app");
			const p2 = await d.addProject("/home/user/app");

			expect(p1.slug).toBe(p2.slug);
			expect(d.getProjects()).toHaveLength(1);
		});

		it("addProject generates unique slugs for different directories", async () => {
			const d = new Daemon();
			const p1 = await d.addProject("/home/user/app");
			const p2 = await d.addProject("/other/path/app");

			expect(p1.slug).not.toBe(p2.slug);
			expect(d.getProjects()).toHaveLength(2);
		});

		it("removeProject removes a registered project", async () => {
			const d = new Daemon();
			const p = await d.addProject("/home/user/app");
			await d.removeProject(p.slug);

			expect(d.getProjects()).toHaveLength(0);
		});

		it("removeProject throws for unknown slug", async () => {
			const d = new Daemon();

			await expect(d.removeProject("nonexistent")).rejects.toThrow(
				'Project "nonexistent" not found',
			);
		});

		it("property: adding N unique directories yields N projects", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc
						.array(
							fc
								.string({ minLength: 1, maxLength: 30 })
								.map((s) => `/home/user/${s}`),
							{ minLength: 0, maxLength: 20 },
						)
						.map((dirs) => [...new Set(dirs)]),
					async (dirs) => {
						const d = new Daemon();
						for (const dir of dirs) {
							await d.addProject(dir);
						}
						expect(d.getProjects()).toHaveLength(dirs.length);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: remove then getProjects excludes removed slug", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.string({ minLength: 1, maxLength: 30 }).map((s) => `/home/${s}`),
					async (dir) => {
						const d = new Daemon();
						const p = await d.addProject(dir);
						await d.removeProject(p.slug);
						const slugs = d.getProjects().map((proj) => proj.slug);
						expect(slugs).not.toContain(p.slug);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── T6: Shutdown cleanup ─────────────────────────────────────────

	describe("T6: Shutdown cleanup (AC5)", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-shutdown-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("stop() clears projects", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			await d.addProject("/home/user/app1");
			await d.addProject("/home/user/app2");
			expect(d.getProjects()).toHaveLength(2);

			await d.stop();
			expect(d.getProjects()).toHaveLength(0);
		});

		it("stop() removes PID and socket files", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			expect(existsSync(join(tmpDir, "daemon.pid"))).toBe(true);
			expect(existsSync(join(tmpDir, "relay.sock"))).toBe(true);

			await d.stop();
			expect(existsSync(join(tmpDir, "daemon.pid"))).toBe(false);
			expect(existsSync(join(tmpDir, "relay.sock"))).toBe(false);
		});

		it("stop() is idempotent — calling twice does not throw", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			await d.stop();
			await expect(d.stop()).resolves.toBeUndefined();
		});
	});

	// ─── T7: Signal handlers ──────────────────────────────────────────

	describe("T7: Signal handlers (AC6)", () => {
		it("start() installs SIGTERM, SIGINT, SIGHUP handlers", async () => {
			const tmpDir = makeTmpDir("daemon-sig-");
			const onSpy = vi.spyOn(process, "on");

			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const registeredSignals = onSpy.mock.calls.map(([signal]) => signal);
			expect(registeredSignals).toContain("SIGTERM");
			expect(registeredSignals).toContain("SIGINT");
			expect(registeredSignals).toContain("SIGHUP");

			await d.stop();
			onSpy.mockRestore();
			cleanTmpDir(tmpDir);
		});

		it("stop() removes signal handlers", async () => {
			const tmpDir = makeTmpDir("daemon-sig2-");
			const removeSpy = vi.spyOn(process, "removeListener");

			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();
			await d.stop();

			const removedSignals = removeSpy.mock.calls.map(([signal]) => signal);
			expect(removedSignals).toContain("SIGTERM");
			expect(removedSignals).toContain("SIGINT");
			expect(removedSignals).toContain("SIGHUP");

			removeSpy.mockRestore();
			cleanTmpDir(tmpDir);
		});
	});

	// ─── T8: Crash counter ────────────────────────────────────────────

	describe("T8: Crash counter — resets after 60s, gives up after 3 (AC7)", () => {
		it("recordCrashTimestamp accumulates timestamps", () => {
			const d = new Daemon();
			const daemon = d as unknown as {
				crashCounter: { record: () => void; getTimestamps: () => number[] };
			};

			daemon.crashCounter.record();
			expect(d.getCrashTimestamps()).toHaveLength(1);

			daemon.crashCounter.record();
			expect(d.getCrashTimestamps()).toHaveLength(2);
		});

		it("shouldGiveUp is true after 3 crashes within window", () => {
			const d = new Daemon();
			const daemon = d as unknown as {
				crashCounter: {
					record: () => void;
					shouldGiveUp: () => boolean;
				};
			};

			daemon.crashCounter.record();
			daemon.crashCounter.record();
			expect(daemon.crashCounter.shouldGiveUp()).toBe(false);

			daemon.crashCounter.record();
			expect(daemon.crashCounter.shouldGiveUp()).toBe(true);
		});

		it("resetCrashCounter clears all timestamps", () => {
			const d = new Daemon();
			const daemon = d as unknown as {
				crashCounter: { record: () => void };
			};

			daemon.crashCounter.record();
			daemon.crashCounter.record();
			expect(d.getCrashTimestamps().length).toBeGreaterThan(0);

			d.resetCrashCounter();
			expect(d.getCrashTimestamps()).toHaveLength(0);
		});

		it("old crash timestamps are pruned (outside 60s window)", () => {
			const d = new Daemon();
			const daemon = d as unknown as {
				crashCounter: {
					record: () => void;
					// Access private timestamps for testing
					timestamps: number[];
				};
			};

			// Manually inject old timestamps (older than 60s)
			daemon.crashCounter.timestamps = [
				Date.now() - 120_000,
				Date.now() - 90_000,
			];

			// Record a new crash — should prune the old ones
			daemon.crashCounter.record();

			// Only the new one should remain
			expect(d.getCrashTimestamps()).toHaveLength(1);
		});

		it("property: N crashes within window, shouldGiveUp iff N >= 3", () => {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 10 }), (crashCount) => {
					const d = new Daemon();
					const daemon = d as unknown as {
						crashCounter: {
							record: () => void;
							shouldGiveUp: () => boolean;
						};
					};

					for (let i = 0; i < crashCount; i++) {
						daemon.crashCounter.record();
					}

					expect(daemon.crashCounter.shouldGiveUp()).toBe(crashCount >= 3);
				}),
				{ seed: SEED, numRuns: 20, endOnFailure: true },
			);
		});
	});

	// ─── T9: isRunning() false for stale/missing ─────────────────────

	describe("T9: isRunning() false for stale/missing (AC4)", () => {
		it("returns false when no PID file exists", async () => {
			const result = await Daemon.isRunning(
				"/tmp/nonexistent-path-12345/relay.sock",
			);
			expect(result).toBe(false);
		});

		it("returns false for stale PID and cleans up", async () => {
			const tmpDir = makeTmpDir("daemon-isrun-");
			const socketPath = join(tmpDir, "relay.sock");
			const pidPath = join(tmpDir, "daemon.pid");

			// Write stale PID (process that doesn't exist)
			writeFileSync(pidPath, "999999999", "utf-8");
			// Create a dummy socket file
			writeFileSync(socketPath, "", "utf-8");

			const result = await Daemon.isRunning(socketPath);
			expect(result).toBe(false);

			// Cleanup should have removed both files
			expect(existsSync(pidPath)).toBe(false);
			expect(existsSync(socketPath)).toBe(false);

			cleanTmpDir(tmpDir);
		});

		it("isRunning always returns false for nonexistent paths", async () => {
			// Test multiple nonexistent paths
			for (const suffix of ["a", "b", "c", "d"]) {
				const result = await Daemon.isRunning(
					`/tmp/no-such-dir-${suffix}/relay.sock`,
				);
				expect(result).toBe(false);
			}
		});
	});

	// ─── T10: spawn() child config — buildSpawnConfig ─────────────────

	describe("T10: spawn() child config — detached, stdio (AC1)", () => {
		it("buildSpawnConfig returns detached: true", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
			});

			expect(config.options.detached).toBe(true);
		});

		it("buildSpawnConfig sets stdio to ['ignore', 'pipe', 'pipe']", () => {
			const config = Daemon.buildSpawnConfig();

			expect(config.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
		});

		it("buildSpawnConfig sets environment variables for port and configDir", () => {
			const config = Daemon.buildSpawnConfig({
				port: 7777,
				configDir: "/tmp/my-relay",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_PORT"]).toBe("7777");
			expect(env["CONDUIT_CONFIG_DIR"]).toBe("/tmp/my-relay");
		});

		it("buildSpawnConfig uses process.execPath", () => {
			const config = Daemon.buildSpawnConfig();

			expect(config.execPath).toBe(process.execPath);
		});

		it("buildSpawnConfig args include --daemon flag", () => {
			const config = Daemon.buildSpawnConfig();

			expect(config.args).toContain("--daemon");
		});

		it("buildSpawnConfig uses defaults when no options provided", () => {
			const config = Daemon.buildSpawnConfig();
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_PORT"]).toBe("2633");
			expect(env["CONDUIT_CONFIG_DIR"]).toBe(DEFAULT_CONFIG_DIR);
		});

		it("property: buildSpawnConfig always sets detached and CONDUIT_PORT", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1024, max: 65535 }),
					fc.string({ minLength: 1, maxLength: 50 }).map((s) => `/tmp/${s}`),
					(port, configDir) => {
						const config = Daemon.buildSpawnConfig({ port, configDir });
						expect(config.options.detached).toBe(true);
						const env = config.options.env as Record<string, string>;
						expect(env["CONDUIT_PORT"]).toBe(String(port));
						expect(env["CONDUIT_CONFIG_DIR"]).toBe(configDir);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── Integration: IPC command routing ─────────────────────────────

	describe("Integration: IPC command routing via start()", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-ipc-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("IPC get_status returns ok: true with status shape", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			const response = await sendIPCCommand(socketPath, { cmd: "get_status" });
			expect(response["ok"]).toBe(true);
			expect(typeof response["uptime"]).toBe("number");
			expect(typeof response["port"]).toBe("number");
			expect(typeof response["projectCount"]).toBe("number");

			await d.stop();
		});

		it("IPC add_project + list_projects roundtrip", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			const addResp = await sendIPCCommand(socketPath, {
				cmd: "add_project",
				directory: "/home/test/app",
			});
			expect(addResp["ok"]).toBe(true);
			expect(typeof addResp["slug"]).toBe("string");

			const listResp = await sendIPCCommand(socketPath, {
				cmd: "list_projects",
			});
			expect(listResp["ok"]).toBe(true);
			expect(Array.isArray(listResp["projects"])).toBe(true);
			expect((listResp["projects"] as unknown[]).length).toBe(1);

			await d.stop();
		});

		it("IPC list_projects includes sessions field in response", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			await sendIPCCommand(socketPath, {
				cmd: "add_project",
				directory: "/home/test/session-check",
			});

			const listResp = await sendIPCCommand(socketPath, {
				cmd: "list_projects",
			});
			expect(listResp["ok"]).toBe(true);
			const projects = listResp["projects"] as Array<{
				slug: string;
				sessions?: number;
				clients?: number;
			}>;
			expect(projects.length).toBeGreaterThan(0);
			// Every project must have sessions and clients fields (not undefined)
			for (const p of projects) {
				expect(typeof p.sessions).toBe("number");
				expect(typeof p.clients).toBe("number");
			}

			await d.stop();
		});

		it("IPC remove_project removes a previously added project", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Add a project first
			const addResp = await sendIPCCommand(socketPath, {
				cmd: "add_project",
				directory: "/home/test/removable",
			});
			expect(addResp["ok"]).toBe(true);
			const slug = addResp["slug"] as string;

			// Verify it exists
			const listBefore = await sendIPCCommand(socketPath, {
				cmd: "list_projects",
			});
			expect((listBefore["projects"] as unknown[]).length).toBe(1);

			// Remove it
			const removeResp = await sendIPCCommand(socketPath, {
				cmd: "remove_project",
				slug,
			});
			expect(removeResp["ok"]).toBe(true);

			// Verify it's gone
			const listAfter = await sendIPCCommand(socketPath, {
				cmd: "list_projects",
			});
			expect((listAfter["projects"] as unknown[]).length).toBe(0);

			await d.stop();
		});

		it("IPC set_project_title changes the title of an existing project", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Add a project
			const addResp = await sendIPCCommand(socketPath, {
				cmd: "add_project",
				directory: "/home/test/titled-app",
			});
			expect(addResp["ok"]).toBe(true);
			const slug = addResp["slug"] as string;

			// Set a title
			const titleResp = await sendIPCCommand(socketPath, {
				cmd: "set_project_title",
				slug,
				title: "My Custom Title",
			});
			expect(titleResp["ok"]).toBe(true);

			// List and verify the title changed
			const listResp = await sendIPCCommand(socketPath, {
				cmd: "list_projects",
			});
			const projects = listResp["projects"] as Array<{
				slug: string;
				title: string;
			}>;
			const project = projects.find((p) => p.slug === slug);
			expect(project).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(project!.title).toBe("My Custom Title");

			await d.stop();
		});

		it("IPC shutdown causes daemon to stop", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Send shutdown
			const shutdownResp = await sendIPCCommand(socketPath, {
				cmd: "shutdown",
			});
			expect(shutdownResp["ok"]).toBe(true);

			// Wait for the scheduled stop (100ms delay in the implementation)
			await vi.waitFor(
				() => {
					expect(existsSync(socketPath)).toBe(false);
				},
				{ timeout: 1000 },
			);
		});

		it("IPC invalid JSON does not crash the daemon", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Send garbage data
			const response = await sendRawToSocket(
				socketPath,
				"this is not json!!!\n",
			);
			expect(response["ok"]).toBe(false);
			expect(response["error"]).toBeDefined();

			// Daemon should still be able to handle further commands
			const statusResp = await sendIPCCommand(socketPath, {
				cmd: "get_status",
			});
			expect(statusResp["ok"]).toBe(true);

			await d.stop();
		});

		it("set_keep_awake IPC activates/deactivates the KeepAwake manager", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();
			try {
				// Enable keep-awake via IPC
				const enableRes = await sendIPCCommand(d.socketPath, {
					cmd: "set_keep_awake",
					enabled: true,
				});
				expect(enableRes["ok"]).toBe(true);
				expect(enableRes["supported"]).toBe(true); // macOS has caffeinate
				expect(enableRes["active"]).toBe(true);

				// Disable via IPC
				const disableRes = await sendIPCCommand(d.socketPath, {
					cmd: "set_keep_awake",
					enabled: false,
				});
				expect(disableRes["ok"]).toBe(true);
				expect(disableRes["active"]).toBe(false);
			} finally {
				await d.stop();
			}
		});

		it("set_keep_awake_command IPC updates the daemon's keep-awake command", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();
			try {
				const res = await sendIPCCommand(d.socketPath, {
					cmd: "set_keep_awake_command",
					command: "sleep",
					args: ["999"],
				});
				expect(res["ok"]).toBe(true);

				// Verify the command was persisted to config
				const status = await sendIPCCommand(d.socketPath, {
					cmd: "get_status",
				});
				expect(status["keepAwake"]).toBeDefined();
			} finally {
				await d.stop();
			}
		});
	});

	// ─── T11: clientCount bug fix — error handler decrements ───────────

	describe("T11: clientCount bug fix — IPC socket error decrements clientCount", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-clientcount-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("clientCount increments on IPC connect and decrements on normal close", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Initially 0 clients
			expect(d.getStatus().clientCount).toBe(0);

			// Connect a client
			const client = await connectToSocket(socketPath);
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(1);
			});

			// Disconnect normally
			await new Promise<void>((resolve) => {
				client.on("close", () => resolve());
				client.destroy();
			});
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(0);
			});

			await d.stop();
		});

		it("clientCount decrements when IPC socket errors (bug fix)", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Connect a client
			const client = await connectToSocket(socketPath);
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(1);
			});

			// Force an error by destroying the socket abruptly with an error
			// This simulates a network error on the client connection.
			// The 'error' event fires on the server-side socket, followed by 'close'.
			client.destroy(new Error("simulated socket error"));

			// Bug fix: clientCount should be back to 0
			// Before the fix, the error handler did not decrement clientCount
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(0);
			});

			await d.stop();
		});

		it("clientCount stays consistent with multiple clients and mixed disconnects", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Connect 3 clients
			const c1 = await connectToSocket(socketPath);
			const c2 = await connectToSocket(socketPath);
			const c3 = await connectToSocket(socketPath);
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(3);
			});

			// Client 1: normal close
			await new Promise<void>((resolve) => {
				c1.on("close", () => resolve());
				c1.destroy();
			});
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(2);
			});

			// Client 2: error close
			c2.destroy(new Error("forced error"));
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(1);
			});

			// Client 3: normal close
			await new Promise<void>((resolve) => {
				c3.on("close", () => resolve());
				c3.destroy();
			});
			await vi.waitFor(() => {
				expect(d.getStatus().clientCount).toBe(0);
			});

			await d.stop();
		});
	});

	// ─── T12: isRunning() true case ───────────────────────────────────

	describe("T12: isRunning() returns true for a running daemon", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-running-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("isRunning() returns true when daemon is started", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			const running = await Daemon.isRunning(socketPath);
			expect(running).toBe(true);

			await d.stop();
		});

		it("isRunning() returns false after daemon is stopped", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();

			// Should be running
			const runningBefore = await Daemon.isRunning(socketPath);
			expect(runningBefore).toBe(true);

			await d.stop();

			// Should no longer be running
			const runningAfter = await Daemon.isRunning(socketPath);
			expect(runningAfter).toBe(false);
		});
	});

	// ─── Integration: HTTP server ─────────────────────────────────────

	describe("Integration: HTTP server responds to requests", () => {
		let tmpDir: string;
		let staticDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-http-");
			// Create a temp static dir with index.html so SPA-serving tests
			// don't depend on dist/frontend/ (which only exists after a build).
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

		it("HTTP GET / returns HTML dashboard", async () => {
			const d = new Daemon({ ...daemonOpts(tmpDir), staticDir });

			await d.start();
			const port = d.port;

			// Root serves HTML dashboard
			const html = await new Promise<string>((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port,
						path: "/",
						method: "GET",
						timeout: 5000,
					},
					(res) => {
						let data = "";
						res.on("data", (chunk: string) => {
							data += chunk;
						});
						res.on("end", () => resolve(data));
					},
				);
				req.on("error", reject);
				req.end();
			});
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain("Conduit");

			await d.stop();
		});

		it("HTTP GET /health returns valid JSON with status info", async () => {
			const d = new Daemon(daemonOpts(tmpDir));

			await d.start();
			const port = d.port;

			const { status, body } = await httpGet(port, "/health");
			expect(status).toBe(200);
			expect(body["ok"]).toBe(true);
			expect(typeof body["uptime"]).toBe("number");
			expect(typeof body["port"]).toBe("number");
			expect(body["port"]).toBe(port);
			expect(typeof body["projectCount"]).toBe("number");
			expect(typeof body["clientCount"]).toBe("number");

			await d.stop();
		});
	});

	// ─── Enhanced daemon (Ticket 8.7) ─────────────────────────────────

	describe("Enhanced daemon (8.7)", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-87-");
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		// ── getStatus enhanced fields ─────────────────────────────────────

		it("getStatus includes pinEnabled, tlsEnabled, keepAwake fields", () => {
			const d = new Daemon(daemonOpts(tmpDir));
			const status = d.getStatus();

			expect(status).toHaveProperty("pinEnabled", false);
			expect(status).toHaveProperty("tlsEnabled", false);
			expect(status).toHaveProperty("keepAwake", false);
		});

		it("getStatus includes empty projects array when no projects", () => {
			const d = new Daemon(daemonOpts(tmpDir));
			const status = d.getStatus();

			expect(status).toHaveProperty("projects");
			expect(Array.isArray(status.projects)).toBe(true);
			expect(status.projects).toHaveLength(0);
		});

		it("getStatus projects array contains project details after addProject", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();
			await d.addProject("/home/user/my-app");

			const status = d.getStatus();
			expect(status.projects).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(status.projects[0]!.slug).toBe("my-app");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(status.projects[0]!.directory).toBe("/home/user/my-app");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(status.projects[0]!.title).toBe("my-app");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(typeof status.projects[0]!.lastUsed).toBe("number");

			await d.stop();
		});

		it("getStatus pinEnabled is true when pinHash is provided", () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				pinHash: "abc123def456",
			});
			const status = d.getStatus();

			expect(status.pinEnabled).toBe(true);
		});

		it("getStatus tlsEnabled reflects constructor option", () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				tlsEnabled: true,
			});
			expect(d.getStatus().tlsEnabled).toBe(true);
		});

		it("getStatus keepAwake reflects constructor option", () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				keepAwake: true,
			});
			expect(d.getStatus().keepAwake).toBe(true);
		});

		// ── Config persistence on start ────────────────────────────────────

		it("start() saves daemon.json config file", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.pid).toBe(process.pid);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.port).toBeGreaterThan(0); // resolved from OS-assigned ephemeral port
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.pinHash).toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.tls).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.keepAwake).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.debug).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.dangerouslySkipPermissions).toBe(false);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(Array.isArray(config!.projects)).toBe(true);

			await d.stop();
		});

		it("start() clears crash.json", async () => {
			// Write a crash.json first
			writeFileSync(
				join(tmpDir, "crash.json"),
				JSON.stringify({ reason: "test crash", timestamp: Date.now() }),
				"utf-8",
			);
			expect(existsSync(join(tmpDir, "crash.json"))).toBe(true);

			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// crash.json should be cleared
			expect(existsSync(join(tmpDir, "crash.json"))).toBe(false);

			await d.stop();
		});

		// ── Config persistence on project changes ──────────────────────────

		it("addProject saves updated daemon.json", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			await d.addProject("/home/user/test-project");

			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects[0]!.path).toBe("/home/user/test-project");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects[0]!.slug).toBe("test-project");

			await d.stop();
		});

		it("addProject creates recent.json with synced projects", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			await d.addProject("/home/user/synced-app");

			const recentPath = join(tmpDir, "recent.json");
			expect(existsSync(recentPath)).toBe(true);
			const parsed = JSON.parse(readFileSync(recentPath, "utf-8"));
			// recent.json format is { recentProjects: [...] }
			expect(parsed).toHaveProperty("recentProjects");
			expect(Array.isArray(parsed.recentProjects)).toBe(true);
			expect(parsed.recentProjects.length).toBeGreaterThanOrEqual(1);
			const match = parsed.recentProjects.find(
				(r: { directory: string }) => r.directory === "/home/user/synced-app",
			);
			expect(match).toBeDefined();

			await d.stop();
		});

		it("removeProject saves updated daemon.json with fewer projects", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const project = await d.addProject("/home/user/removable");
			const configBefore = loadDaemonConfig(tmpDir);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(configBefore!.projects).toHaveLength(1);

			await d.removeProject(project.slug);

			const configAfter = loadDaemonConfig(tmpDir);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(configAfter!.projects).toHaveLength(0);

			await d.stop();
		});

		it("removeProject syncs recent.json", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const project = await d.addProject("/home/user/temp-project");
			await d.removeProject(project.slug);

			const recentPath = join(tmpDir, "recent.json");
			expect(existsSync(recentPath)).toBe(true);

			await d.stop();
		});

		it("removeProject persists dismissedPaths in daemon.json", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const project = await d.addProject("/home/user/dismissed-project");
			await d.removeProject(project.slug);

			const config = loadDaemonConfig(tmpDir);
			expect(config?.dismissedPaths).toContain("/home/user/dismissed-project");

			await d.stop();
		});

		it("removeProject directory is not re-added by addProject from discovery", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Add then remove — directory should be dismissed
			const project = await d.addProject("/home/user/dismissed");
			await d.removeProject(project.slug);
			expect(d.getProjects()).toHaveLength(0);

			// Simulate what discoverProjects does: call addProject with the same dir
			// Because the dir is dismissed, addProject un-dismisses on explicit add,
			// but discoverProjects checks dismissedPaths BEFORE calling addProject.
			// So we test the dismiss set directly via the config roundtrip.
			const config = loadDaemonConfig(tmpDir);
			expect(config?.dismissedPaths).toContain("/home/user/dismissed");

			await d.stop();
		});

		it("explicit addProject un-dismisses a previously removed directory", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Add, remove, then re-add explicitly
			const project = await d.addProject("/home/user/undismissed");
			await d.removeProject(project.slug);
			expect(d.getProjects()).toHaveLength(0);

			// Explicitly re-add — should un-dismiss
			const reAdded = await d.addProject("/home/user/undismissed");
			expect(reAdded.directory).toBe("/home/user/undismissed");
			expect(d.getProjects()).toHaveLength(1);

			// dismissedPaths should no longer contain the directory
			const config = loadDaemonConfig(tmpDir);
			expect(config?.dismissedPaths ?? []).not.toContain(
				"/home/user/undismissed",
			);

			await d.stop();
		});

		it("dismissedPaths survives daemon restart", async () => {
			// First daemon: add and remove a project
			const d1 = new Daemon(daemonOpts(tmpDir));
			await d1.start();
			const project = await d1.addProject("/home/user/removed-survives");
			await d1.removeProject(project.slug);
			await d1.stop();

			// Second daemon: rehydrate from config
			const d2 = new Daemon(daemonOpts(tmpDir));
			await d2.start();

			// The project should NOT be in the list
			expect(d2.getProjects()).toHaveLength(0);

			// The dismissedPaths should still be persisted
			const config = loadDaemonConfig(tmpDir);
			expect(config?.dismissedPaths).toContain("/home/user/removed-survives");

			await d2.stop();
		});

		// ── REST API: DELETE /api/projects/:slug ────────────────────────────

		it("DELETE /api/projects/:slug removes a project via REST", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const project = await d.addProject("/home/user/rest-delete-test");
			expect(d.getProjects()).toHaveLength(1);

			const port = d.port;
			const res = await fetch(
				`http://localhost:${port}/api/projects/${project.slug}`,
				{ method: "DELETE" },
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.ok).toBe(true);

			expect(d.getProjects()).toHaveLength(0);

			await d.stop();
		});

		it("DELETE /api/projects/:slug returns 404 for unknown slug", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const port = d.port;
			const res = await fetch(
				`http://localhost:${port}/api/projects/nonexistent`,
				{ method: "DELETE" },
			);
			expect(res.status).toBe(404);

			await d.stop();
		});

		// ── Config persistence on stop ──────────────────────────────────────

		it("stop() preserves daemon.json with instance data (Fix #11)", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Verify config exists after start
			expect(existsSync(join(tmpDir, "daemon.json"))).toBe(true);

			await d.stop();

			// daemon.json should still exist after stop (instances survive restart)
			expect(existsSync(join(tmpDir, "daemon.json"))).toBe(true);
			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
		});

		it("stop() preserves project list in daemon.json (Fix #11)", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();
			await d.addProject("/home/user/keep-me");

			await d.stop();

			// Projects should be readable from persisted config after stop
			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects[0]!.path).toBe("/home/user/keep-me");
		});

		// ── setPin via IPC ─────────────────────────────────────────────────

		it("IPC setPin updates pinHash and saves config", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Initially pinEnabled should be false
			expect(d.getStatus().pinEnabled).toBe(false);

			// Set PIN via IPC
			const response = await sendIPCCommand(socketPath, {
				cmd: "set_pin",
				pin: "1234",
			});
			expect(response["ok"]).toBe(true);

			// pinEnabled should now be true
			expect(d.getStatus().pinEnabled).toBe(true);

			// Flush async config save before reading the file
			await d.flushConfigSave();
			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(typeof config!.pinHash).toBe("string");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.pinHash).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect((config!.pinHash as string).length).toBeGreaterThan(0);

			await d.stop();
		});

		// ── setKeepAwake via IPC ────────────────────────────────────────────

		it("IPC setKeepAwake updates keepAwake and saves config", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Initially keepAwake should be false
			expect(d.getStatus().keepAwake).toBe(false);

			// Set keepAwake via IPC
			const response = await sendIPCCommand(socketPath, {
				cmd: "set_keep_awake",
				enabled: true,
			});
			expect(response["ok"]).toBe(true);

			// keepAwake should now be true
			expect(d.getStatus().keepAwake).toBe(true);

			// Flush async config save before reading the file
			await d.flushConfigSave();
			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.keepAwake).toBe(true);

			await d.stop();
		});

		it("IPC setKeepAwake can toggle back to false", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon({
				...daemonOpts(tmpDir),
				keepAwake: true,
			});
			await d.start();

			expect(d.getStatus().keepAwake).toBe(true);

			const response = await sendIPCCommand(socketPath, {
				cmd: "set_keep_awake",
				enabled: false,
			});
			expect(response["ok"]).toBe(true);
			expect(d.getStatus().keepAwake).toBe(false);

			await d.stop();
		});

		// ── restart_with_config via IPC ──────────────────────────────────────

		it("IPC restart_with_config returns ok and schedules shutdown", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const response = await sendIPCCommand(socketPath, {
				cmd: "restart_with_config",
			});
			expect(response["ok"]).toBe(true);

			// Wait for scheduled stop
			await vi.waitFor(
				() => {
					expect(existsSync(socketPath)).toBe(false);
				},
				{ timeout: 1000 },
			);
		});

		// ── IPC get_status enhanced fields ──────────────────────────────────

		it("IPC get_status returns enhanced fields", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			// Add a project so we can check it in status
			await d.addProject("/home/user/status-check");

			const response = await sendIPCCommand(socketPath, {
				cmd: "get_status",
			});

			expect(response["ok"]).toBe(true);
			expect(response["pinEnabled"]).toBe(false);
			expect(response["tlsEnabled"]).toBe(false);
			expect(response["keepAwake"]).toBe(false);
			expect(Array.isArray(response["projects"])).toBe(true);
			const projects = response["projects"] as Array<{
				slug: string;
				directory: string;
			}>;
			expect(projects).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(projects[0]!.slug).toBe("status-check");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(projects[0]!.directory).toBe("/home/user/status-check");

			await d.stop();
		});

		// ── Config shape ─────────────────────────────────────────────────────

		it("saved config has correct shape with projects", async () => {
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			await d.addProject("/home/user/proj-a");
			await d.addProject("/home/user/proj-b");

			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.projects).toHaveLength(2);

			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			for (const proj of config!.projects) {
				expect(typeof proj.path).toBe("string");
				expect(typeof proj.slug).toBe("string");
				expect(typeof proj.title).toBe("string");
				expect(typeof proj.addedAt).toBe("number");
			}

			await d.stop();
		});

		it("constructor defaults pinHash/tlsEnabled/keepAwake correctly", () => {
			const d = new Daemon(daemonOpts(tmpDir));
			const status = d.getStatus();

			expect(status.pinEnabled).toBe(false);
			expect(status.tlsEnabled).toBe(false);
			expect(status.keepAwake).toBe(false);
		});

		// ── buildConfig includes keepAwakeCommand/Args ─────────────────────

		it("passes keepAwakeCommand/Args to KeepAwake constructor via buildConfig", () => {
			const daemon = new Daemon({
				port: 0,
				smartDefault: false,
				keepAwake: true,
				keepAwakeCommand: "my-tool",
				keepAwakeArgs: ["--flag"],
			});
			const config = (
				daemon as unknown as { buildConfig: () => DaemonConfig }
			).buildConfig();
			expect(config.keepAwakeCommand).toBe("my-tool");
			expect(config.keepAwakeArgs).toEqual(["--flag"]);
		});

		it("buildConfig omits keepAwakeCommand/Args when not set", () => {
			const daemon = new Daemon({
				port: 0,
				smartDefault: false,
			});
			const config = (
				daemon as unknown as { buildConfig: () => DaemonConfig }
			).buildConfig();
			expect(config.keepAwakeCommand).toBeUndefined();
			expect(config.keepAwakeArgs).toBeUndefined();
		});

		// ── IPC setKeepAwake returns supported/active status ───────────────

		it("IPC setKeepAwake returns supported and active fields", async () => {
			const socketPath = join(tmpDir, "relay.sock");
			const d = new Daemon(daemonOpts(tmpDir));
			await d.start();

			const response = await sendIPCCommand(socketPath, {
				cmd: "set_keep_awake",
				enabled: true,
			});
			expect(response["ok"]).toBe(true);
			expect(typeof response["supported"]).toBe("boolean");
			expect(typeof response["active"]).toBe("boolean");

			await d.stop();
		});

		// ── KeepAwake constructor receives config command/args ─────────────

		it("start() passes keepAwakeCommand/Args to KeepAwake constructor", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				keepAwake: true,
				keepAwakeCommand: "my-custom-tool",
				keepAwakeArgs: ["--no-sleep"],
			});
			await d.start();

			// Verify through config persistence: the keepAwake fields should round-trip
			const config = loadDaemonConfig(tmpDir);
			expect(config).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.keepAwakeCommand).toBe("my-custom-tool");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(config!.keepAwakeArgs).toEqual(["--no-sleep"]);

			await d.stop();
		});
	});

	// ─── HTTP routing: project redirect + SPA serving ─────────────────

	describe("HTTP routing: project routes and SPA serving", () => {
		let tmpDir: string;
		let staticDir: string;

		beforeEach(() => {
			tmpDir = makeTmpDir("daemon-routing-");
			// Create a mock static dir with a minimal index.html
			staticDir = join(tmpDir, "public");
			mkdirSync(staticDir, { recursive: true });
			writeFileSync(
				join(staticDir, "index.html"),
				"<!DOCTYPE html><html><body>SPA App</body></html>",
				"utf-8",
			);
			// Create a mock CSS file for static serving test
			writeFileSync(
				join(staticDir, "style.css"),
				"body { color: red; }",
				"utf-8",
			);
			// Create a mock assets directory with a hashed JS file
			mkdirSync(join(staticDir, "assets"), { recursive: true });
			writeFileSync(
				join(staticDir, "assets", "index.abc12345.js"),
				"console.log('hello');",
				"utf-8",
			);
		});

		afterEach(() => {
			cleanTmpDir(tmpDir);
		});

		it("GET / with 1 project → 302 redirect to /p/{slug}/", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;
			await d.addProject("/home/user/my-app");

			const result = await httpGetRaw(port, "/");

			expect(result.status).toBe(302);
			expect(result.headers.location).toBe("/p/my-app/");

			await d.stop();
		});

		it("GET /p/{slug}/ with registered project → serves SPA HTML", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;
			await d.addProject("/home/user/my-app");

			const result = await httpGetRaw(port, "/p/my-app/");

			expect(result.status).toBe(200);
			expect(result.body).toContain("SPA App");
			expect(result.body).not.toContain("Conduit"); // Not the dashboard

			await d.stop();
		});

		it("GET /p/{slug}/ with unknown project → 404 JSON", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;

			const result = await httpGetRaw(port, "/p/nonexistent/");

			expect(result.status).toBe(404);
			expect(result.body).toContain("not found");

			await d.stop();
		});

		it("GET /style.css → serves static file with correct MIME type", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;

			const result = await httpGetRaw(port, "/style.css");

			expect(result.status).toBe(200);
			expect(result.body).toContain("color: red");
			expect(result.headers["content-type"]).toContain("text/css");

			await d.stop();
		});

		it("GET /assets/index.abc12345.js → serves with immutable cache header", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;

			const result = await httpGetRaw(port, "/assets/index.abc12345.js");

			expect(result.status).toBe(200);
			expect(result.body).toContain("hello");
			expect(result.headers["cache-control"]).toContain("immutable");

			await d.stop();
		});

		it("GET / with 0 projects → serves SPA index.html", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;

			const result = await httpGetRaw(port, "/");

			expect(result.status).toBe(200);
			expect(result.headers["content-type"]).toContain("text/html");
			expect(result.body).toContain("SPA App");

			await d.stop();
		});

		it("GET / with 2+ projects → serves SPA index.html (no redirect)", async () => {
			const d = new Daemon({
				...daemonOpts(tmpDir),
				staticDir,
			});

			await d.start();
			const port = d.port;
			await d.addProject("/home/user/app1");
			await d.addProject("/home/user/app2");

			const result = await httpGetRaw(port, "/");

			expect(result.status).toBe(200);
			expect(result.headers["content-type"]).toContain("text/html");
			expect(result.body).toContain("SPA App");

			await d.stop();
		});
	});

	// ─── buildSpawnConfig: env var threading ─────────────────────────

	describe("buildSpawnConfig: env var threading", () => {
		it("includes CONDUIT_OC_URL when opencodeUrl is set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
				opencodeUrl: "http://localhost:4096",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_OC_URL"]).toBe("http://localhost:4096");
		});

		it("does not include CONDUIT_OC_URL when opencodeUrl is not set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_OC_URL"]).toBeUndefined();
		});

		it("includes CONDUIT_PIN_HASH when pinHash is set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
				pinHash: "abc123def456",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_PIN_HASH"]).toBe("abc123def456");
		});

		it("does not include CONDUIT_PIN_HASH when pinHash is not set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_PIN_HASH"]).toBeUndefined();
		});

		it("includes CONDUIT_KEEP_AWAKE when keepAwake is true", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
				keepAwake: true,
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_KEEP_AWAKE"]).toBe("1");
		});

		it("does not include CONDUIT_KEEP_AWAKE when keepAwake is not set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_KEEP_AWAKE"]).toBeUndefined();
		});

		it("always includes CONDUIT_TLS=1 (auto-enable)", () => {
			const config = Daemon.buildSpawnConfig({
				port: 3000,
				configDir: "/tmp/test",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_TLS"]).toBe("1");
		});

		it("threads all env vars when all options are set", () => {
			const config = Daemon.buildSpawnConfig({
				port: 5000,
				configDir: "/tmp/all-opts",
				pinHash: "hash123",
				keepAwake: true,
				tlsEnabled: true,
				opencodeUrl: "http://localhost:4096",
			});
			const env = config.options.env as Record<string, string>;

			expect(env["CONDUIT_PORT"]).toBe("5000");
			expect(env["CONDUIT_CONFIG_DIR"]).toBe("/tmp/all-opts");
			expect(env["CONDUIT_PIN_HASH"]).toBe("hash123");
			expect(env["CONDUIT_KEEP_AWAKE"]).toBe("1");
			expect(env["CONDUIT_TLS"]).toBe("1");
			expect(env["CONDUIT_OC_URL"]).toBe("http://localhost:4096");
		});
	});
});

// ─── Daemon PIN Authentication ──────────────────────────────────────────────
// Verifies that the Daemon's HTTP server enforces PIN auth when configured.
// Previously the pinHash field was stored but never checked against requests.

/** Make an HTTP POST request with JSON body */
function httpPost(
	port: number,
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const jsonBody = JSON.stringify(body);
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(jsonBody)),
					...headers,
				},
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
						headers: res.headers,
						body: data,
					});
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("HTTP POST timed out"));
		});
		req.write(jsonBody);
		req.end();
	});
}

/** HTTP GET with custom headers (e.g. Cookie) */
function httpGetWithHeaders(
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<{
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "GET",
				headers,
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
						headers: res.headers,
						body: data,
					});
				});
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("HTTP GET timed out"));
		});
		req.end();
	});
}

describe("Daemon PIN authentication", () => {
	let tmpDir: string;
	let staticDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-auth-");
		staticDir = join(tmpDir, "public");
		mkdirSync(staticDir, { recursive: true });
		writeFileSync(
			join(staticDir, "index.html"),
			"<!DOCTYPE html><html><body>SPA</body></html>",
			"utf-8",
		);
		writeFileSync(
			join(staticDir, "style.css"),
			"body { color: red; }",
			"utf-8",
		);
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	function authOpts(port: number, pinHash?: string) {
		return {
			...daemonOpts(tmpDir, port),
			staticDir,
			...(pinHash != null && { pinHash }),
		};
	}

	it("GET / redirects to /auth when PIN is set", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;
		await d.addProject("/home/user/app");

		const res = await httpGetRaw(port, "/");
		expect(res.status).toBe(302);
		expect(res.headers.location).toBe("/auth");

		await d.stop();
	});

	it("GET /p/{slug}/ redirects to /auth when PIN is set", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;
		await d.addProject("/home/user/app");

		const res = await httpGetRaw(port, "/p/app/");
		expect(res.status).toBe(302);
		expect(res.headers.location).toBe("/auth");

		await d.stop();
	});

	it("POST /auth with correct PIN returns 200 + session cookie", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("5678")));
		await d.start();
		const port = d.port;

		const res = await httpPost(port, "/auth", { pin: "5678" });
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);
		const sc = Array.isArray(res.headers["set-cookie"])
			? res.headers["set-cookie"][0]
			: (res.headers["set-cookie"] ?? "");
		expect(sc).toContain("relay_session=");

		await d.stop();
	});

	it("POST /auth with wrong PIN returns 401", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("5678")));
		await d.start();
		const port = d.port;

		const res = await httpPost(port, "/auth", { pin: "0000" });
		expect(res.status).toBe(401);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(typeof body.attemptsLeft).toBe("number");

		await d.stop();
	});

	it("POST /auth returns 429 after too many failed attempts", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("5678")));
		await d.start();
		const port = d.port;

		for (let i = 0; i < 5; i++) {
			await httpPost(port, "/auth", { pin: "0000" });
		}

		const lockedRes = await httpPost(port, "/auth", { pin: "0000" });
		expect(lockedRes.status).toBe(429);
		const body = JSON.parse(lockedRes.body);
		expect(body.ok).toBe(false);
		expect(body.locked).toBe(true);
		expect(typeof body.retryAfter).toBe("number");

		await d.stop();
	});

	it("GET / with valid session cookie returns 302 (not 401)", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;
		await d.addProject("/home/user/app");

		// Authenticate first
		const authRes = await httpPost(port, "/auth", { pin: "1234" });
		expect(authRes.status).toBe(200);
		const sc = Array.isArray(authRes.headers["set-cookie"])
			? authRes.headers["set-cookie"][0]
			: (authRes.headers["set-cookie"] ?? "");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const match = sc!.match(/relay_session=([^;]+)/);
		expect(match).toBeTruthy();

		// Access root with cookie — should get 302 redirect (single project)
		const res = await httpGetWithHeaders(port, "/", {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			Cookie: `relay_session=${match![1]}`,
		});
		expect(res.status).toBe(302);

		await d.stop();
	});

	it("GET /health remains accessible without auth when PIN is set", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;

		const res = await httpGet(port, "/health");
		expect(res.status).toBe(200);
		expect(res.body["ok"]).toBe(true);

		await d.stop();
	});

	it("GET /setup remains accessible without auth when PIN is set", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;

		const res = await httpGetRaw(port, "/setup");
		expect(res.status).toBe(200);

		await d.stop();
	});

	it("IPC set_pin activates auth enforcement on HTTP routes", async () => {
		const socketPath = join(tmpDir, "relay.sock");
		const d = new Daemon(authOpts(0));
		await d.start();
		const port = d.port;
		await d.addProject("/home/user/app");

		// Before PIN: root returns 302 redirect
		const beforeRes = await httpGetRaw(port, "/");
		expect(beforeRes.status).toBe(302);

		// Set PIN via IPC
		const ipcRes = await sendIPCCommand(socketPath, {
			cmd: "set_pin",
			pin: "4321",
		});
		expect(ipcRes["ok"]).toBe(true);

		// After PIN: root returns 302 redirect to /auth
		const afterRes = await httpGetRaw(port, "/");
		expect(afterRes.status).toBe(302);
		expect(afterRes.headers.location).toBe("/auth");

		await d.stop();
	});

	it("no PIN set serves routes normally without auth", async () => {
		const d = new Daemon(authOpts(0));
		await d.start();
		const port = d.port;
		await d.addProject("/home/user/app");

		const res = await httpGetRaw(port, "/");
		expect(res.status).toBe(302);

		await d.stop();
	});

	it("static CSS files are accessible without auth when PIN is set", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;

		const res = await httpGetRaw(port, "/style.css");
		expect(res.status).toBe(200);
		expect(res.body).toContain("color: red");

		await d.stop();
	});

	it("raw PIN string as pinHash always fails auth (regression for hashing bug)", async () => {
		// Simulate the old bug: passing raw PIN "1234" directly as pinHash
		const d = new Daemon(authOpts(0, "1234"));
		await d.start();
		const port = d.port;

		// Trying to auth with the same raw PIN should fail because the daemon
		// will hash the input "1234" → SHA-256, but compare against raw "1234"
		const res = await httpPost(port, "/auth", { pin: "1234" });
		expect(res.status).toBe(401);

		await d.stop();
	});

	it("properly hashed PIN authenticates successfully", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		// Correct: hash the PIN before passing as pinHash
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;

		const res = await httpPost(port, "/auth", { pin: "1234" });
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(true);

		await d.stop();
	});

	it("wrong PIN response includes attemptsLeft", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("5678")));
		await d.start();
		const port = d.port;

		const res = await httpPost(port, "/auth", { pin: "0000" });
		expect(res.status).toBe(401);
		const body = JSON.parse(res.body);
		expect(body.ok).toBe(false);
		expect(typeof body.attemptsLeft).toBe("number");
		expect(body.attemptsLeft).toBe(4); // 5 max - 1 attempt = 4 left

		await d.stop();
	});

	it("lockout response has locked:true and retryAfter at top level", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("5678")));
		await d.start();
		const port = d.port;

		// Exhaust attempts
		for (let i = 0; i < 5; i++) {
			await httpPost(port, "/auth", { pin: "0000" });
		}

		const lockedRes = await httpPost(port, "/auth", { pin: "0000" });
		expect(lockedRes.status).toBe(429);
		const body = JSON.parse(lockedRes.body);
		expect(body.locked).toBe(true);
		expect(body.retryAfter).toBeGreaterThan(0);
		// Ensure it's flat (not nested under error)
		expect(body.error).toBeUndefined();

		await d.stop();
	});

	it("GET /auth serves SPA when PIN is set (Svelte PinPage renders client-side)", async () => {
		const { hashPin } = await import("../../../src/lib/auth.js");
		const d = new Daemon(authOpts(0, hashPin("1234")));
		await d.start();
		const port = d.port;

		// Root redirects to /auth
		const rootRes = await httpGetRaw(port, "/");
		expect(rootRes.status).toBe(302);
		expect(rootRes.headers.location).toBe("/auth");

		// /auth itself serves index.html (Svelte SPA)
		const authRes = await httpGetRaw(port, "/auth");
		expect(authRes.status).toBe(200);
		expect(authRes.headers["content-type"]).toContain("text/html");

		await d.stop();
	});
});

// ─── WS upgrade integration ─────────────────────────────────────────────────

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

// ─── Multi-instance integration ─────────────────────────────────────────────

describe("multi-instance integration", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-multi-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("daemon creates default instance from opencodeUrl", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});

		const instances = daemon.getInstances();
		expect(instances).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.id).toBe("default");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.port).toBe(4096);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.managed).toBe(false);
	});

	it("daemon creates no instances when opencodeUrl is absent", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
		});

		const instances = daemon.getInstances();
		expect(instances).toHaveLength(0);
	});

	it("getInstances returns instance list with expected shape", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});

		expect(daemon.getInstances()).toBeInstanceOf(Array);
		expect(daemon.getInstances()[0]).toHaveProperty("id");
		expect(daemon.getInstances()[0]).toHaveProperty("status");
	});

	it("default instance name is 'Default'", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(daemon.getInstances()[0]!.name).toBe("Default");
	});

	it("default instance port is extracted from URL", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:8888",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(daemon.getInstances()[0]!.port).toBe(8888);
	});

	it("default instance port falls back to 4096 when URL has no port", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(daemon.getInstances()[0]!.port).toBe(4096);
	});
});

// ─── Instance status broadcast ──────────────────────────────────────────────

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

// ─── addProject with instanceId ─────────────────────────────────────────────

describe("addProject with instanceId", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-instanceid-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("binds project to specified instance", async () => {
		const d = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const project = await d.addProject(
			"/tmp/test-project",
			undefined,
			"default",
		);
		expect(project.instanceId).toBe("default");
	});

	it("defaults to first available instance when none specified", async () => {
		const d = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const project = await d.addProject("/tmp/test-project-2");
		expect(project.instanceId).toBe("default");
	});

	it("instanceId is undefined when no instances exist", async () => {
		const d = new Daemon({
			port: 0,
			configDir: tmpDir,
		});
		const project = await d.addProject("/tmp/test-project-3");
		expect(project.instanceId).toBeUndefined();
	});

	it("instanceId is persisted in config", async () => {
		const d = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
		});
		await d.start();
		await d.addProject("/tmp/test-project-persist", undefined, "default");

		// Wait for any background config saves (e.g. from discoverProjects)
		await new Promise((r) => setTimeout(r, 50));
		await d.flushConfigSave();

		const config = loadDaemonConfig(tmpDir);
		expect(config).not.toBeNull();
		// discoverProjects runs async on start(), so other projects may exist
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const persisted = config!.projects.find(
			(p) => p.path === "/tmp/test-project-persist",
		);
		expect(persisted).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(persisted!.instanceId).toBe("default");

		await d.stop();
	});
});

// ─── backward compatibility ─────────────────────────────────────────────────

describe("backward compatibility", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-compat-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("creates default instance from opencodeUrl", () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const instances = daemon.getInstances();
		expect(instances).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.id).toBe("default");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instances[0]!.name).toBe("Default");
	});

	it("projects get default instanceId when none specified", async () => {
		const daemon = new Daemon({
			port: 0,
			configDir: tmpDir,
			opencodeUrl: "http://localhost:4096",
		});
		const project = await daemon.addProject("/tmp/compat-test");
		expect(project.instanceId).toBe("default");
	});

	it("no instances when no opencodeUrl", () => {
		const daemon = new Daemon({ port: 0, configDir: tmpDir });
		expect(daemon.getInstances()).toHaveLength(0);
	});
});

// ─── Instance rehydration on restart ────────────────────────────────────────

describe("instance rehydration on daemon restart", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-rehydrate-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("instances from saved config are rehydrated into instanceManager on start", async () => {
		// Pre-write a daemon.json with saved instances
		const { saveDaemonConfig } = await import(
			"../../../src/lib/daemon/config-persistence.js"
		);
		await saveDaemonConfig(
			{
				pid: 0,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [
					{ id: "alpha", name: "Alpha", port: 4097, managed: false },
					{
						id: "beta",
						name: "Beta",
						port: 4098,
						managed: true,
						env: { FOO: "bar" },
						url: "http://localhost:4098",
					},
				],
			},
			tmpDir,
		);

		const d = new Daemon(daemonOpts(tmpDir));
		await d.start();

		const instances = d.getInstances();
		const ids = instances.map((i) => i.id);
		expect(ids).toContain("alpha");
		expect(ids).toContain("beta");

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const alpha = instances.find((i) => i.id === "alpha")!;
		expect(alpha.name).toBe("Alpha");
		expect(alpha.port).toBe(4097);
		expect(alpha.managed).toBe(false);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const beta = instances.find((i) => i.id === "beta")!;
		expect(beta.name).toBe("Beta");
		expect(beta.port).toBe(4098);
		expect(beta.managed).toBe(true);

		await d.stop();
	});

	it("daemon starts cleanly when saved config has an empty instances array", async () => {
		const { saveDaemonConfig } = await import(
			"../../../src/lib/daemon/config-persistence.js"
		);
		await saveDaemonConfig(
			{
				pid: 0,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [],
			},
			tmpDir,
		);

		const d = new Daemon(daemonOpts(tmpDir));
		await expect(d.start()).resolves.toBeUndefined();

		expect(d.getInstances()).toHaveLength(0);

		await d.stop();
	});

	it("daemon starts cleanly when no config file exists", async () => {
		// No daemon.json written — loadDaemonConfig returns null
		const d = new Daemon(daemonOpts(tmpDir));
		await expect(d.start()).resolves.toBeUndefined();

		expect(d.getInstances()).toHaveLength(0);

		await d.stop();
	});

	it("duplicate instance IDs are swallowed and do not crash startup", async () => {
		// The constructor already registers "default" via opencodeUrl.
		// The saved config also contains "default" — should not throw.
		const { saveDaemonConfig } = await import(
			"../../../src/lib/daemon/config-persistence.js"
		);
		await saveDaemonConfig(
			{
				pid: 0,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [
					{ id: "default", name: "Default", port: 4096, managed: false },
				],
			},
			tmpDir,
		);

		const d = new Daemon({
			...daemonOpts(tmpDir),
			opencodeUrl: "http://localhost:4096",
		});

		await expect(d.start()).resolves.toBeUndefined();

		// "default" should exist exactly once
		const instances = d.getInstances();
		expect(instances.filter((i) => i.id === "default")).toHaveLength(1);

		await d.stop();
	});

	it("rehydrating max instances during start() completes promptly", async () => {
		const { saveDaemonConfig } = await import(
			"../../../src/lib/daemon/config-persistence.js"
		);
		// InstanceManager default maxInstances is 5; test with exactly 5
		const instances = Array.from({ length: 5 }, (_, i) => ({
			id: `perf-${i}`,
			name: `PerfInstance ${i}`,
			port: 5000 + i,
			managed: false,
			url: `http://host${i}:${5000 + i}`,
		}));

		await saveDaemonConfig(
			{
				pid: 0,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances,
			},
			tmpDir,
		);

		const d = new Daemon(daemonOpts(tmpDir));
		const start = performance.now();
		await d.start();
		const elapsed = performance.now() - start;

		expect(d.getInstances()).toHaveLength(5);
		expect(elapsed).toBeLessThan(5000); // Should complete well within 5s

		await d.stop();
	});

	it("log.warn is called when maxInstances is exceeded during rehydration", async () => {
		// Write a config with more instances than the default maxInstances (5).
		// The InstanceManager default maxInstances is 5, so 6 instances will
		// cause the 6th addInstance to throw "Max instances reached".
		const { saveDaemonConfig } = await import(
			"../../../src/lib/daemon/config-persistence.js"
		);
		await saveDaemonConfig(
			{
				pid: 0,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: [],
				instances: [
					{ id: "inst-1", name: "Instance 1", port: 4101, managed: false },
					{ id: "inst-2", name: "Instance 2", port: 4102, managed: false },
					{ id: "inst-3", name: "Instance 3", port: 4103, managed: false },
					{ id: "inst-4", name: "Instance 4", port: 4104, managed: false },
					{ id: "inst-5", name: "Instance 5", port: 4105, managed: false },
					{ id: "inst-6", name: "Instance 6", port: 4106, managed: false },
				],
			},
			tmpDir,
		);

		// Capture pino's output stream to check for warnings.
		// pino writes JSON to its destination, not console.warn.
		const { _getOutputStream } = await import("../../../src/lib/logger.js");
		const outputLines: string[] = [];
		const dest = _getOutputStream();
		const origWrite = dest.write.bind(dest) as (chunk: unknown) => boolean;
		dest.write = ((chunk: Buffer | string) => {
			outputLines.push(chunk.toString());
			return origWrite(chunk);
		}) as typeof dest.write;

		const d = new Daemon(daemonOpts(tmpDir));

		// Daemon should start cleanly despite the overflow
		await expect(d.start()).resolves.toBeUndefined();

		// pino output should contain a warn-level entry for the 6th instance
		const rehydrateWarns = outputLines.filter((line) =>
			line.includes("Failed to rehydrate instance"),
		);
		expect(rehydrateWarns.length).toBeGreaterThanOrEqual(1);

		// The warning message should mention the instance ID that was rejected
		const warningText = rehydrateWarns.join("\n");
		expect(warningText).toContain("inst-6");

		// Exactly 5 instances should have been registered (maxInstances default)
		expect(d.getInstances()).toHaveLength(5);

		await d.stop();
	});
});

// ─── Keep-awake config rehydration on restart ───────────────────────────────

describe("keep-awake config rehydration on daemon restart", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir("daemon-ka-rehydrate-");
	});

	afterEach(() => {
		cleanTmpDir(tmpDir);
	});

	it("keepAwakeCommand/keepAwakeArgs survive daemon restart", async () => {
		// Daemon 1: start with custom keep-awake command
		const d1 = new Daemon({
			...daemonOpts(tmpDir),
			keepAwake: true,
			keepAwakeCommand: "sleep",
			keepAwakeArgs: ["999"],
		});
		await d1.start();
		await d1.stop();

		// Daemon 2: start from same config dir — should rehydrate
		const d2 = new Daemon(daemonOpts(tmpDir));
		await d2.start();
		try {
			// biome-ignore lint/suspicious/noExplicitAny: testing private method
			const config = (d2 as any).buildConfig();
			expect(config.keepAwakeCommand).toBe("sleep");
			expect(config.keepAwakeArgs).toEqual(["999"]);
		} finally {
			await d2.stop();
		}
	});
});

// ─── instanceAdd handler: url threading ──────────────────────────────────────

describe("instanceAdd handler — url threading", () => {
	async function makeHandlers(
		onAdd: (
			id: string,
			config: import("../../../src/lib/shared-types.js").InstanceConfig,
		) => import("../../../src/lib/shared-types.js").OpenCodeInstance,
	) {
		const { buildIPCHandlers } = await import(
			"../../../src/lib/daemon/daemon-ipc.js"
		);
		const ctx = {
			addInstance: onAdd,
			persistConfig: () => {},
			addProject: async () => ({
				slug: "test",
				directory: "/tmp",
				title: "test",
			}),
			removeProject: async () => {},
			getProjects: () => [],
			setProjectTitle: () => {},
			getPinHash: () => null,
			setPinHash: () => {},
			getKeepAwake: () => false,
			setKeepAwake: () => ({ supported: false, active: false }),
			scheduleShutdown: () => {},
			getInstances: () => [],
			getInstance: () => undefined,
			removeInstance: () => {},
			startInstance: async () => {},
			stopInstance: () => {},
			updateInstance: () =>
				({}) as import("../../../src/lib/shared-types.js").OpenCodeInstance,
		} as unknown as import("../../../src/lib/daemon/daemon-ipc.js").DaemonIPCContext;
		return buildIPCHandlers(ctx, () => ({
			ok: true,
			uptime: 0,
			port: 3000,
			host: "127.0.0.1",
			projectCount: 0, sessionCount: 0,
			clientCount: 0,
			pinEnabled: false,
			tlsEnabled: false,
			keepAwake: false,
			projects: [],
		}));
	}

	it("passes url to addInstance when provided", async () => {
		let capturedConfig:
			| import("../../../src/lib/shared-types.js").InstanceConfig
			| null = null;

		const handlers = await makeHandlers((id, config) => {
			capturedConfig = config;
			return {
				id,
				name: config.name,
				port: config.port,
				managed: config.managed,
				status: "stopped",
				restartCount: 0,
				createdAt: Date.now(),
			};
		});

		const response = await handlers.instanceAdd(
			"ext",
			undefined,
			false,
			undefined,
			"http://host:4096",
		);
		expect(response.ok).toBe(true);
		expect(capturedConfig).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedConfig!.url).toBe("http://host:4096");
	});

	it("passes undefined url to addInstance when not provided", async () => {
		let capturedConfig:
			| import("../../../src/lib/shared-types.js").InstanceConfig
			| null = null;

		const handlers = await makeHandlers((id, config) => {
			capturedConfig = config;
			return {
				id,
				name: config.name,
				port: config.port,
				managed: config.managed,
				status: "stopped",
				restartCount: 0,
				createdAt: Date.now(),
			};
		});

		const response = await handlers.instanceAdd("work", 4097, true);
		expect(response.ok).toBe(true);
		expect(capturedConfig).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedConfig!.url).toBeUndefined();
	});
});
