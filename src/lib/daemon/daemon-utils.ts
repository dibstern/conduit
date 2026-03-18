// ─── Daemon Utility Functions ───────────────────────────────────────────────
// Pure utility functions extracted from the Daemon class.

import { execFileSync } from "node:child_process";

/**
 * Check whether the `opencode` binary is available on PATH.
 * Uses `which` (Unix) or `where.exe` (Windows).
 */
export function isOpencodeInstalled(): boolean {
	const cmd = process.platform === "win32" ? "where.exe" : "which";
	try {
		execFileSync(cmd, ["opencode"], { stdio: "ignore" });
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
