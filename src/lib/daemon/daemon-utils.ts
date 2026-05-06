// ─── Daemon Utility Functions ───────────────────────────────────────────────
// Pure utility functions extracted from the Daemon class.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import { cleanupStalePidFiles } from "./pid-manager.js";

const execFileAsync = promisify(execFile);

/**
 * Check whether the `opencode` binary is available on PATH.
 * Uses `which` (Unix) or `where.exe` (Windows).
 */
export async function isOpencodeInstalled(): Promise<boolean> {
	const cmd = process.platform === "win32" ? "where.exe" : "which";
	try {
		await execFileAsync(cmd, ["opencode"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Probe an OpenCode URL to see if anything is listening.
 * Any response (200, 401, etc.) means reachable — only connection
 * failure means unreachable.
 */
export async function probeOpenCode(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/health`, {
			signal: AbortSignal.timeout(3_000),
		});
		return true;
	} catch {
		return false;
	}
}

interface ProbePortOptions {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

/**
 * Probe a specific port for a running OpenCode server.
 * Any HTTP response (including 401, 500, etc.) means a server is listening.
 * Only connection failures / timeouts return false.
 * Used by PortScanner for auto-discovery.
 */
export async function probeOpenCodePort(
	port: number,
	options: ProbePortOptions = {},
): Promise<boolean> {
	const fetchFn = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 2000;

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		await fetchFn(`http://127.0.0.1:${port}/api/health`, {
			signal: controller.signal,
		});
		clearTimeout(timeout);
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a free TCP port starting from `startFrom`.
 */
export async function findFreePort(startFrom: number): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(startFrom, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : startFrom;
			server.close(() => resolve(port));
		});
		server.on("error", () => {
			// Port in use, try next
			resolve(findFreePort(startFrom + 1));
		});
	});
}

/**
 * Check if a daemon is already running by probing the PID file and IPC socket.
 *
 * Extracted from Daemon.isRunning() so callers don't need the full Daemon class.
 * The static method `Daemon.isRunning` delegates here.
 */
export async function isDaemonRunning(socketPath?: string): Promise<boolean> {
	const resolvedSocketPath =
		socketPath ?? join(DEFAULT_CONFIG_DIR, "relay.sock");
	const pidPath = resolvedSocketPath.replace(/relay\.sock$/, "daemon.pid");

	// Check PID file
	let pid: number | null = null;
	try {
		const content = readFileSync(pidPath, "utf-8").trim();
		pid = Number.parseInt(content, 10);
	} catch {
		// No PID file — try socket directly (PID file may have been
		// cleaned up while the daemon is still running)
	}

	if (pid !== null && !Number.isNaN(pid)) {
		// Check if PID is alive
		try {
			process.kill(pid, 0);
		} catch {
			// Process doesn't exist — stale
			cleanupStalePidFiles(pidPath, resolvedSocketPath);
			return false;
		}
	}

	// Verify via socket connection (works even without PID file)
	const { connect } = await import("node:net");
	return new Promise((resolve) => {
		const client = connect(resolvedSocketPath);
		const timeout = setTimeout(() => {
			client.destroy();
			resolve(false);
		}, 2000);

		client.on("connect", () => {
			clearTimeout(timeout);
			client.destroy();
			resolve(true);
		});

		client.on("error", () => {
			clearTimeout(timeout);
			if (pid !== null) {
				cleanupStalePidFiles(pidPath, resolvedSocketPath);
			}
			resolve(false);
		});
	});
}
