// ─── Daemon Spawn / Process Management (extracted from daemon.ts) ───────────
// Handles building spawn configuration and launching daemon child processes.
// These were originally static methods on the Daemon class.

import { type ChildProcess, spawn as cpSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, DEFAULT_PORT, RELAY_ENV_KEYS } from "../env.js";
import type { DaemonOptions, SpawnConfig } from "./daemon.js";

// ─── buildSpawnConfig ───────────────────────────────────────────────────────

/**
 * Build spawn configuration without actually spawning.
 * Pure function — testable without mocking or side effects.
 */
export function buildSpawnConfig(options?: DaemonOptions): SpawnConfig {
	const configDir = options?.configDir ?? DEFAULT_CONFIG_DIR;
	const port = options?.port ?? DEFAULT_PORT;
	const _logPath = options?.logPath ?? join(configDir, "daemon.log");

	const filteredEnv = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] != null,
		),
	);
	const env: Record<string, string> = {
		...filteredEnv,
		[RELAY_ENV_KEYS.PORT]: String(port),
		[RELAY_ENV_KEYS.CONFIG_DIR]: configDir,
	};
	if (options?.host) env[RELAY_ENV_KEYS.HOST] = options.host;
	if (options?.pinHash) env[RELAY_ENV_KEYS.PIN_HASH] = options.pinHash;
	if (options?.keepAwake) env[RELAY_ENV_KEYS.KEEP_AWAKE] = "1";
	if (options?.keepAwakeCommand) {
		env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND] = options.keepAwakeCommand;
	}
	if (options?.keepAwakeArgs) {
		env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS] = JSON.stringify(options.keepAwakeArgs);
	}
	// Always enable TLS — the daemon will auto-generate certs via mkcert
	// and gracefully fall back to HTTP if mkcert is not available.
	env[RELAY_ENV_KEYS.TLS] = "1";
	if (options?.opencodeUrl) env[RELAY_ENV_KEYS.OC_URL] = options.opencodeUrl;

	return {
		execPath: process.execPath,
		args: [process.argv[1] ?? "daemon", "--daemon"],
		options: {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
			env,
		},
	};
}

// ─── spawnDaemon ────────────────────────────────────────────────────────────

/**
 * Spawn a new daemon as a detached background process.
 *
 * @param isRunning  A function that checks whether the daemon is connectable
 *                   (injected to avoid a circular dependency on the Daemon class).
 */
export async function spawnDaemon(
	options: DaemonOptions | undefined,
	isRunning: (socketPath: string) => Promise<boolean>,
): Promise<{ pid: number; port: number }> {
	const configDir = options?.configDir ?? DEFAULT_CONFIG_DIR;
	const port = options?.port ?? DEFAULT_PORT;
	const logPath = options?.logPath ?? join(configDir, "daemon.log");
	const socketPath = options?.socketPath ?? join(configDir, "relay.sock");

	// Ensure config directory exists
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Open log file descriptor for stdout/stderr redirection.
	// Must use openSync (returns fd) — spawn rejects WriteStream objects
	// that haven't finished opening (fd: null).
	const logFd = openSync(logPath, "a");

	const spawnFilteredEnv = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] != null,
		),
	);
	const env: Record<string, string> = {
		...spawnFilteredEnv,
		[RELAY_ENV_KEYS.PORT]: String(port),
		[RELAY_ENV_KEYS.CONFIG_DIR]: configDir,
	};
	if (options?.host) env[RELAY_ENV_KEYS.HOST] = options.host;
	if (options?.pinHash) env[RELAY_ENV_KEYS.PIN_HASH] = options.pinHash;
	if (options?.keepAwake) env[RELAY_ENV_KEYS.KEEP_AWAKE] = "1";
	if (options?.keepAwakeCommand) {
		env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND] = options.keepAwakeCommand;
	}
	if (options?.keepAwakeArgs) {
		env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS] = JSON.stringify(options.keepAwakeArgs);
	}
	// Always enable TLS — the daemon will auto-generate certs via mkcert
	// and gracefully fall back to HTTP if mkcert is not available.
	env[RELAY_ENV_KEYS.TLS] = "1";
	if (options?.opencodeUrl) env[RELAY_ENV_KEYS.OC_URL] = options.opencodeUrl;

	const child: ChildProcess = cpSpawn(
		process.execPath,
		[process.argv[1] ?? "daemon", "--daemon"],
		{
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env,
		},
	);

	const pid = child.pid;
	if (!pid) {
		throw new Error("Failed to spawn daemon process");
	}

	// Detach child so parent can exit
	child.unref();

	// Close log fd in parent process (child inherited it)
	try {
		closeSync(logFd);
	} catch {
		// ignore — fd may already be closed
	}

	// Wait for daemon to become ready (IPC socket connectable).
	// The child needs time to start Node, load modules, bind port, and
	// create the Unix socket. Poll every 200ms for up to 5 seconds.
	const POLL_INTERVAL = 200;
	const MAX_WAIT = 5000;
	let waited = 0;

	while (waited < MAX_WAIT) {
		await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL));
		waited += POLL_INTERVAL;

		if (await isRunning(socketPath)) {
			return { pid, port };
		}
	}

	// Daemon didn't become ready in time — check if process is alive
	try {
		process.kill(pid, 0);
	} catch {
		throw new Error(
			`Daemon process (pid ${pid}) exited before becoming ready. Check logs: ${logPath}`,
		);
	}

	// Process is alive but socket not yet ready — return anyway
	// (caller can retry IPC)
	return { pid, port };
}
