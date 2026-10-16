// Single source of truth for all environment variables read by the relay.
// Import from here instead of reading process.env directly.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { LogFormat, LogLevel } from "./logger.js";

function resolveConfigDir(
	env: NodeJS.ProcessEnv,
	home: string,
	exists: (path: string) => boolean,
): string {
	if (env["CONDUIT_CONFIG_DIR"] != null) return env["CONDUIT_CONFIG_DIR"];
	if (env["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "conduit");
	const legacyDir = join(home, ".conduit");
	const configHome = join(home, ".config");
	if (!exists(configHome)) return legacyDir;
	const configDir = join(configHome, "conduit");
	// Keep existing data in place when only the legacy directory exists.
	return !exists(configDir) && exists(legacyDir) ? legacyDir : configDir;
}

/** Base config directory. Explicit overrides win; otherwise prefer ~/.config. */
export const DEFAULT_CONFIG_DIR: string = resolveConfigDir(
	process.env,
	homedir(),
	existsSync,
);

export const DEFAULT_PORT = 2633;
export const DEFAULT_OC_PORT = 4096;
export const DEFAULT_TRACE_MAX_BYTES = 10_485_760;
export const DEFAULT_TRACE_MAX_FILES = 10;
export const DEFAULT_TRACE_BATCH_WINDOW_MS = 200;
export const DEFAULT_TRACE_MIN_MS = 5;

export interface TraceEnvConfig {
	readonly enabled: boolean;
	readonly filePath: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly batchWindowMs: number;
	readonly minMs?: number | undefined;
	readonly sessionId?: string | undefined;
}

const parseBoundedInteger = (
	value: string | undefined,
	defaultValue: number,
	min: number,
	max: number,
): number => {
	if (value == null || value.trim() === "") return defaultValue;
	if (!/^\d+$/.test(value.trim())) return defaultValue;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.min(Math.max(parsed, min), max);
};

export const resolveTraceConfig = (
	configDir: string,
	env: NodeJS.ProcessEnv = process.env,
): TraceEnvConfig => {
	const configuredPath = env["CONDUIT_TRACE_FILE"];
	const filePath =
		configuredPath == null || configuredPath.trim() === ""
			? join(configDir, "logs", "server.trace.ndjson")
			: isAbsolute(configuredPath)
				? configuredPath
				: resolve(configDir, configuredPath);

	return {
		enabled: env["CONDUIT_TRACE_ENABLED"] !== "0",
		filePath,
		maxBytes: parseBoundedInteger(
			env["CONDUIT_TRACE_MAX_BYTES"],
			DEFAULT_TRACE_MAX_BYTES,
			1024,
			1_073_741_824,
		),
		maxFiles: parseBoundedInteger(
			env["CONDUIT_TRACE_MAX_FILES"],
			DEFAULT_TRACE_MAX_FILES,
			0,
			100,
		),
		batchWindowMs: parseBoundedInteger(
			env["CONDUIT_TRACE_BATCH_WINDOW_MS"],
			DEFAULT_TRACE_BATCH_WINDOW_MS,
			10,
			60_000,
		),
		minMs: parseBoundedInteger(
			env["CONDUIT_TRACE_MIN_MS"] ?? env["CONDUIT_TRACE_SQL_MIN_MS"],
			DEFAULT_TRACE_MIN_MS,
			0,
			2_147_483_647,
		),
		sessionId: env["CONDUIT_TRACE_SESSION"] || undefined,
	};
};

// Read at process startup. Override via CLI flags or environment.

export const ENV = {
	/** Bind address (default: 127.0.0.1). Set to 0.0.0.0 for all interfaces. */
	host: process.env["HOST"] ?? "127.0.0.1",
	/** True when HOST env var was explicitly set (not defaulted). */
	hostExplicit: process.env["HOST"] != null,
	/** OpenCode server URL */
	opencodeUrl: process.env["OPENCODE_URL"],
	/** OpenCode server HTTP Basic Auth password */
	opencodePassword: process.env["OPENCODE_SERVER_PASSWORD"],
	/** OpenCode server HTTP Basic Auth username (default: "opencode") */
	opencodeUsername: process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode",
	/** Enable debug logging */
	debug: process.env["DEBUG"] === "1",
	/** Log level (default: info). Set via LOG_LEVEL env var. */
	logLevel:
		(process.env["LOG_LEVEL"] as LogLevel | undefined) ?? ("info" as const),
	/** Log format (default: pretty). */
	logFormat: process.env["LOG_FORMAT"] as LogFormat | undefined,
	/** Warn on browser RPC latency; zero disables request instrumentation. */
	slowRpcMs: parseBoundedInteger(
		process.env["CONDUIT_SLOW_RPC_MS"],
		100,
		0,
		2_147_483_647,
	),
	/** Per-project resume sweep; tests use a one-second interval. */
	continuationSweepIntervalMs: parseBoundedInteger(
		process.env["CONDUIT_CONTINUATION_SWEEP_INTERVAL_MS"],
		30_000,
		1,
		2_147_483_647,
	),
	/** Daemon-internal setup deadline; integration fixtures use a short timeout. */
	worktreeSetupTimeoutMs: parseBoundedInteger(
		process.env["CONDUIT_WORKTREE_SETUP_TIMEOUT_MS"],
		600_000,
		1,
		2_147_483_647,
	),
} as const;
