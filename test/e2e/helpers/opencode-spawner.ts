import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** Get a random available port. */
async function getEphemeralPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Failed to get ephemeral port")));
			}
		});
		srv.on("error", reject);
	});
}

/** Wait for OpenCode to become healthy. */
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/health`);
			if (res.ok) return;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`OpenCode did not become healthy on port ${port} within ${timeoutMs}ms`,
	);
}

export interface SpawnedOpenCode {
	port: number;
	url: string;
	process: ChildProcess;
	tmpDir: string;
	/** Kill the process and clean up the temp directory. */
	stop(): void;
}

/**
 * Spawn an ephemeral OpenCode instance on a random port with an isolated
 * database directory. Call stop() to kill it and clean up.
 */
export async function spawnOpenCode(opts?: {
	timeoutMs?: number;
	env?: Record<string, string>;
}): Promise<SpawnedOpenCode> {
	const port = await getEphemeralPort();
	const tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-e2e-"));

	const proc = spawn("opencode", ["serve", "--port", String(port)], {
		env: {
			...process.env,
			XDG_DATA_HOME: tmpDir,
			// Isolate config so the ephemeral instance doesn't read the
			// user's ~/.config/opencode/ (which may set auth, providers, etc.)
			XDG_CONFIG_HOME: path.join(tmpDir, "config"),
			// Disable auth — ephemeral instances are localhost-only and
			// short-lived. If the parent process has OPENCODE_SERVER_PASSWORD
			// set, the child would inherit it and reject unauthenticated
			// health checks from the spawner.
			OPENCODE_SERVER_PASSWORD: "",
			...opts?.env,
		},
		stdio: "pipe",
		detached: false,
	});

	// Propagate spawn errors
	const spawnError = new Promise<never>((_, reject) => {
		proc.once("error", reject);
	});

	try {
		await Promise.race([
			waitForHealth(port, opts?.timeoutMs ?? 30_000),
			spawnError,
		]);
	} catch (err) {
		proc.kill("SIGTERM");
		rmSync(tmpDir, { recursive: true, force: true });
		throw err;
	}

	return {
		port,
		url: `http://localhost:${port}`,
		process: proc,
		tmpDir,
		stop() {
			proc.removeAllListeners();
			proc.kill("SIGTERM");
			// Give it a moment to exit gracefully, then force
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 3000);
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		},
	};
}
