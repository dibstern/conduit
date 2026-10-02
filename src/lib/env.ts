// Single source of truth for all environment variables read by the relay.
// Import from here instead of reading process.env directly.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { LogFormat, LogLevel } from "./logger.js";

/** Base config directory. Respects CONDUIT_CONFIG_DIR or XDG_CONFIG_HOME if set. */
export const DEFAULT_CONFIG_DIR: string =
	process.env["CONDUIT_CONFIG_DIR"] ??
	(process.env["XDG_CONFIG_HOME"]
		? join(process.env["XDG_CONFIG_HOME"], "conduit")
		: join(homedir(), ".conduit"));

export const DEFAULT_PORT = 2633;
export const DEFAULT_OC_PORT = 4096;
export const DEFAULT_TRACE_MAX_BYTES = 10_485_760;
export const DEFAULT_TRACE_MAX_FILES = 10;
export const DEFAULT_TRACE_BATCH_WINDOW_MS = 200;

export interface TraceEnvConfig {
	readonly enabled: boolean;
	readonly filePath: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly batchWindowMs: number;
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
} as const;
