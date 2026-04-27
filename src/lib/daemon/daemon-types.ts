// ─── Daemon Types ──────────────────────────────────────────────────────────
// Shared type definitions extracted from daemon.ts so that modules like
// daemon-ipc.ts, daemon-lifecycle.ts, daemon-spawn.ts, and daemon-layers.ts
// can import types without pulling in the full Daemon class (and its heavy
// transitive dependencies).

import type { LogFormat, LogLevel } from "../logger.js";

// ─── DaemonOptions ─────────────────────────────────────────────────────────

export interface DaemonOptions {
	port?: number;
	/** Bind address for the HTTP server (default: "127.0.0.1"). Set to "0.0.0.0" to listen on all interfaces. */
	host?: string;
	configDir?: string;
	socketPath?: string;
	logPath?: string;
	pidPath?: string;
	pinHash?: string;
	tlsEnabled?: boolean;
	keepAwake?: boolean;
	/** User-provided keep-awake command (overrides auto-detection). */
	keepAwakeCommand?: string;
	/** Args for user-provided keep-awake command. */
	keepAwakeArgs?: string[];
	/** OpenCode server URL (e.g., "http://localhost:4096") */
	opencodeUrl?: string;
	/** Override the static file directory (default: dist/frontend relative to cwd) */
	staticDir?: string;
	/**
	 * Enable smart default detection in start().
	 * When true (default) and no opencodeUrl is provided, probes localhost:4096
	 * to decide whether to connect as unmanaged or spawn as managed.
	 * Also controls the port scanner (auto-discovery of OpenCode instances)
	 * and startup project discovery from running instances.
	 * Set to false in tests that don't want network probing.
	 */
	smartDefault?: boolean;
	/** Log level override (default: info). */
	logLevel?: LogLevel;
	/** Log format override (default: json for daemon, pretty for foreground). */
	logFormat?: LogFormat;
}

// ─── DaemonStatus ──────────────────────────────────────────────────────────

export interface DaemonStatus {
	ok: boolean;
	uptime: number;
	port: number;
	host: string;
	/** Tailscale IP if detected, for share URL construction. */
	tailscaleIP?: string;
	/** First LAN IP (non-Tailscale routable address), for share URL construction. */
	lanIP?: string;
	projectCount: number;
	sessionCount: number;
	clientCount: number;
	pinEnabled: boolean;
	tlsEnabled: boolean;
	keepAwake: boolean;
	projects: Array<{
		slug: string;
		directory: string;
		title: string;
		status?: string;
		lastUsed?: number;
	}>;
}

// ─── SpawnConfig ───────────────────────────────────────────────────────────

/** Spawn configuration built by buildSpawnConfig() — testable without mocking */
export interface SpawnConfig {
	execPath: string;
	args: string[];
	options: import("node:child_process").SpawnOptions;
}
