// ─── Config Persistence Module (Ticket 8.3) ─────────────────────────────────
// Handles persistent daemon config at ~/.conduit/daemon.json,
// recent projects at ~/.conduit/recent.json, and crash info at
// ~/.conduit/crash.json. Uses atomic writes (tmp + rename) for
// daemon.json to prevent corruption.

import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { RecentProject } from "../types.js";
import {
	addRecent,
	deserializeRecent,
	serializeRecent,
} from "./recent-projects.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DaemonConfig {
	pid: number;
	port: number;
	pinHash: string | null;
	tls: boolean;
	debug: boolean;
	keepAwake: boolean;
	/** User-provided keep-awake command override (e.g. "systemd-inhibit"). */
	keepAwakeCommand?: string;
	/** Arguments for the keep-awake command override. */
	keepAwakeArgs?: string[];
	dangerouslySkipPermissions: boolean;
	projects: Array<{
		path: string;
		slug: string;
		title?: string;
		addedAt: number;
		instanceId?: string;
	}>;
	instances?: Array<{
		id: string;
		name: string;
		port: number;
		managed: boolean;
		env?: Record<string, string>;
		url?: string;
	}>;
	/** Directories the user explicitly removed — skip in auto-discovery. */
	dismissedPaths?: string[];
}

export interface CrashInfo {
	reason: string;
	timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

function safeUnlink(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
}

// ─── Config Dir ─────────────────────────────────────────────────────────────

/** Return the default config directory (~/.conduit) */
export function getConfigDir(): string {
	return DEFAULT_CONFIG_DIR;
}

// ─── Daemon Config ──────────────────────────────────────────────────────────

/** Read and parse daemon.json. Returns null if missing or corrupt. */
export function loadDaemonConfig(configDir?: string): DaemonConfig | null {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, "daemon.json"), "utf-8");
		return JSON.parse(data) as DaemonConfig;
	} catch {
		return null;
	}
}

/** Atomic write: write to .daemon.json.tmp then rename to daemon.json. */
export function saveDaemonConfig(
	config: DaemonConfig,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	ensureDir(dir);
	const tmpPath = join(dir, ".daemon.json.tmp");
	const finalPath = join(dir, "daemon.json");
	writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}

/** Remove daemon.json, relay.sock, and daemon.pid. Ignores ENOENT. */
export function clearDaemonConfig(configDir?: string): void {
	const dir = resolveDir(configDir);
	safeUnlink(join(dir, "daemon.json"));
	safeUnlink(join(dir, "relay.sock"));
	safeUnlink(join(dir, "daemon.pid"));
}

// ─── Crash Info ─────────────────────────────────────────────────────────────

/** Read crash.json. Returns null if missing or corrupt. */
export function readCrashInfo(configDir?: string): CrashInfo | null {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, "crash.json"), "utf-8");
		return JSON.parse(data) as CrashInfo;
	} catch {
		return null;
	}
}

/** Write crash.json (non-atomic, non-critical). */
export function writeCrashInfo(info: CrashInfo, configDir?: string): void {
	try {
		const dir = resolveDir(configDir);
		ensureDir(dir);
		writeFileSync(join(dir, "crash.json"), JSON.stringify(info), "utf-8");
	} catch {
		// Non-critical — log warning in production, silently ignore here
	}
}

/** Remove crash.json. Ignores ENOENT. */
export function clearCrashInfo(configDir?: string): void {
	const dir = resolveDir(configDir);
	safeUnlink(join(dir, "crash.json"));
}

// ─── Recent Projects Sync ───────────────────────────────────────────────────

/**
 * Sync projects into recent.json by merging with existing entries.
 * - Updates existing entries (matched by directory/path) with new title
 * - Adds new entries
 * - Deduplicates by path
 * - Keeps max 20 entries sorted by lastUsed descending
 * - Integrates with the existing recent-projects module
 */
export function syncRecentProjects(
	projects: Array<{ path: string; slug: string; title?: string }>,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	ensureDir(dir);

	const recentPath = join(dir, "recent.json");

	// Load existing recent projects
	let existing: RecentProject[] = [];
	try {
		const data = readFileSync(recentPath, "utf-8");
		existing = deserializeRecent(data);
	} catch {
		// File doesn't exist or is corrupt — start fresh
	}

	// Merge new projects into existing list using the addRecent function
	let merged = existing;
	const now = Date.now();
	for (const project of projects) {
		merged = addRecent(merged, project.path, project.slug, project.title, now);
	}

	// Write back
	writeFileSync(recentPath, serializeRecent(merged), "utf-8");
}
