// ─── Centralized Environment Configuration ──────────────────────────────────
// Single source of truth for all environment variables read by the relay.
// Import from here instead of reading process.env directly.

import { homedir } from "node:os";
import { join } from "node:path";

import type { LogFormat, LogLevel } from "./logger.js";

// ─── Config Directory ───────────────────────────────────────────────────────

/** Base config directory. Respects OPENCODE_RELAY_CONFIG_DIR or XDG_CONFIG_HOME if set. */
export const DEFAULT_CONFIG_DIR: string =
	process.env["OPENCODE_RELAY_CONFIG_DIR"] ??
	(process.env["XDG_CONFIG_HOME"]
		? join(process.env["XDG_CONFIG_HOME"], "opencode-relay")
		: join(homedir(), ".opencode-relay"));

// ─── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_PORT = 2633;
export const DEFAULT_OC_PORT = 4096;

// ─── Daemon IPC Environment Variables ───────────────────────────────────────
// These are set by the parent process (via daemon-spawn.ts) and read by the
// child daemon process (via cli-core.ts). They are an internal IPC mechanism,
// not user-facing configuration.

export const RELAY_ENV_KEYS = {
	PORT: "OPENCODE_RELAY_PORT",
	HOST: "OPENCODE_RELAY_HOST",
	CONFIG_DIR: "OPENCODE_RELAY_CONFIG_DIR",
	PIN_HASH: "OPENCODE_RELAY_PIN_HASH",
	KEEP_AWAKE: "OPENCODE_RELAY_KEEP_AWAKE",
	TLS: "OPENCODE_RELAY_TLS",
	OC_URL: "OPENCODE_RELAY_OC_URL",
} as const;

// ─── User-Facing Environment Variables ──────────────────────────────────────
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
	/** Log format (default: auto — pretty for foreground, json for daemon). */
	logFormat: process.env["LOG_FORMAT"] as LogFormat | undefined,
} as const;
