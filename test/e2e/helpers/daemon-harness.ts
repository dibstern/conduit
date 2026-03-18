// ─── Daemon E2E Harness ──────────────────────────────────────────────────────
// Starts a real Daemon pointed at a real OpenCode instance.
// Unlike E2EHarness (which wraps RelayStack), this provides the full daemon
// experience: project routing, instance management, health polling, and the
// dashboard. Browser tests connect to the daemon's own HTTP server.
//
// Requires:
//   - OpenCode running at localhost:4096 (or OPENCODE_URL)
//   - OPENCODE_SERVER_PASSWORD set (for auth-aware health checks)
//   - Project built (`pnpm run build`) — daemon serves dist/frontend/

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Daemon } from "../../../src/lib/daemon/daemon.js";

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

export interface DaemonHarness {
	/** The running Daemon instance */
	daemon: Daemon;
	/** The daemon's HTTP port (OS-assigned) */
	port: number;
	/** Base URL for Playwright navigation (e.g. "http://127.0.0.1:54321") */
	baseUrl: string;
	/** The slug of the added project */
	projectSlug: string;
	/** Full project URL (e.g. "http://127.0.0.1:54321/p/opencode-relay/") */
	projectUrl: string;
	/** Project URL path (e.g. "/p/opencode-relay/") */
	projectPath: string;
	/** Stop daemon and clean up temp directories */
	stop(): Promise<void>;
}

export interface DaemonHarnessOptions {
	/** OpenCode server URL (default: OPENCODE_URL env or http://localhost:4096) */
	opencodeUrl?: string;
	/** Directory to register as a project (default: process.cwd()) */
	projectDir?: string;
	/** Custom slug for the project (default: auto-generated from directory) */
	projectSlug?: string;
	/** Max ms to wait for healthy instance (default: 15_000) */
	healthTimeout?: number;
}

/** Check whether the OpenCode server is reachable (any HTTP response counts). */
export async function isOpenCodeReachable(url?: string): Promise<boolean> {
	try {
		await fetch(`${url ?? OPENCODE_URL}/health`, {
			signal: AbortSignal.timeout(3_000),
		});
		// Any response (200, 401, etc.) means the server is reachable
		return true;
	} catch {
		return false;
	}
}

/** Check whether OPENCODE_SERVER_PASSWORD is available. */
export function hasOpenCodePassword(): boolean {
	return !!process.env["OPENCODE_SERVER_PASSWORD"];
}

/**
 * Create a daemon E2E harness pointed at a real OpenCode instance.
 *
 * Starts a Daemon with:
 * - Ephemeral port (port: 0)
 * - Temp directory for config/socket/pid/log
 * - Built frontend from dist/frontend/
 * - One project registered (cwd by default)
 * - Waits for the default instance to become healthy
 *
 * Call `stop()` to tear down the daemon and clean up temp files.
 */
export async function createDaemonHarness(
	opts?: DaemonHarnessOptions,
): Promise<DaemonHarness> {
	const opencodeUrl = opts?.opencodeUrl ?? OPENCODE_URL;
	const projectDir = opts?.projectDir ?? process.cwd();
	const healthTimeout = opts?.healthTimeout ?? 15_000;
	const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");

	// Create temp directory for daemon config, socket, PID file, and logs
	const tmpDir = mkdtempSync(join(tmpdir(), "e2e-daemon-"));

	const daemon = new Daemon({
		port: 0,
		host: "127.0.0.1",
		configDir: tmpDir,
		socketPath: join(tmpDir, "relay.sock"),
		pidPath: join(tmpDir, "daemon.pid"),
		logPath: join(tmpDir, "daemon.log"),
		opencodeUrl,
		staticDir,
	});

	await daemon.start();

	// Register a project so the browser has a route to navigate to
	const project = await daemon.addProject(projectDir, opts?.projectSlug);
	const projectSlug = project.slug;

	// Wait for the default instance to become healthy.
	// The daemon constructor injects an auth-aware health checker that reads
	// OPENCODE_SERVER_PASSWORD from process.env, so this should succeed when
	// the password is configured.
	await waitForHealthy(daemon, healthTimeout);

	const port = daemon.port;
	const baseUrl = `http://127.0.0.1:${port}`;
	const projectPath = `/p/${projectSlug}/`;
	const projectUrl = `${baseUrl}${projectPath}`;

	return {
		daemon,
		port,
		baseUrl,
		projectSlug,
		projectUrl,
		projectPath,
		async stop(): Promise<void> {
			await daemon.stop();
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		},
	};
}

// ─── Internal ────────────────────────────────────────────────────────────────

/** Poll daemon instances until at least one is healthy. */
async function waitForHealthy(
	daemon: Daemon,
	timeoutMs: number,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const instances = daemon.getInstances();
		if (instances.some((i) => i.status === "healthy")) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	const status = daemon.getInstances()[0]?.status ?? "no instance";
	throw new Error(
		`Daemon instance did not become healthy within ${timeoutMs}ms (status: ${status})`,
	);
}
