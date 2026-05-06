// ─── Config Persistence Module (Ticket 8.3) ─────────────────────────────────
// Handles persistent daemon config at ~/.conduit/daemon.json,
// recent projects at ~/.conduit/recent.json, and crash info at
// ~/.conduit/crash.json. Uses atomic writes (tmp + rename) for
// daemon.json to prevent corruption.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";

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
		/** Cached session count from last run — for instant CLI display. */
		sessionCount?: number;
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

// ─── Schema ─────────────────────────────────────────────────────────────────

const DaemonProjectSchema = Schema.Struct({
	path: Schema.String,
	slug: Schema.String,
	title: Schema.optional(Schema.String),
	addedAt: Schema.Number,
	instanceId: Schema.optional(Schema.String),
	sessionCount: Schema.optional(Schema.Number),
});

const DaemonInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	port: Schema.Number,
	managed: Schema.Boolean,
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	url: Schema.optional(Schema.String),
});

export const DaemonConfigSchema = Schema.Struct({
	pid: Schema.Number,
	port: Schema.Number,
	pinHash: Schema.NullOr(Schema.String),
	tls: Schema.Boolean,
	debug: Schema.Boolean,
	keepAwake: Schema.Boolean,
	keepAwakeCommand: Schema.optional(Schema.String),
	keepAwakeArgs: Schema.optional(Schema.Array(Schema.String)),
	dangerouslySkipPermissions: Schema.Boolean,
	projects: Schema.Array(DaemonProjectSchema),
	instances: Schema.optional(Schema.Array(DaemonInstanceSchema)),
	dismissedPaths: Schema.optional(Schema.Array(Schema.String)),
});

// ─── Service Tag & Layer ────────────────────────────────────────────────────

export class DaemonConfigTag extends Context.Tag("DaemonConfig")<
	DaemonConfigTag,
	DaemonConfig
>() {}

/** Default config for first-startup when no daemon.json exists. */
function defaultDaemonConfig(): DaemonConfig {
	return {
		pid: process.pid,
		port: 2633,
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		dangerouslySkipPermissions: false,
		projects: [],
	};
}

/**
 * Layer that reads daemon.json (or creates defaults on first startup),
 * validates through DaemonConfigSchema, and provides the result via
 * DaemonConfigTag. Write-path functions remain imperative.
 */
export const ServerConfigLive = (configDir?: string) =>
	Layer.effect(
		DaemonConfigTag,
		Effect.gen(function* () {
			const dir = configDir ?? DEFAULT_CONFIG_DIR;
			const raw = yield* Effect.try(() =>
				readFileSync(join(dir, "daemon.json"), "utf-8"),
			).pipe(Effect.option);
			if (Option.isNone(raw)) {
				const defaults = defaultDaemonConfig();
				yield* Effect.try(() => {
					mkdirSync(dir, { recursive: true });
					writeFileSync(
						join(dir, "daemon.json"),
						JSON.stringify(defaults, null, 2),
						"utf-8",
					);
				});
				return defaults;
			}
			const json = yield* Effect.try(() => JSON.parse(raw.value));
			// Cast: Schema.optional produces `T | undefined` but
			// DaemonConfig uses exact optional properties (key absent, never
			// undefined). The schema guarantees structural correctness.
			const decoded = yield* Schema.decodeUnknown(DaemonConfigSchema)(json);
			return decoded as unknown as DaemonConfig;
		}),
	);

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

/** Atomic write: write to a unique tmp file then rename to daemon.json. */
export async function saveDaemonConfig(
	config: DaemonConfig,
	configDir?: string,
): Promise<void> {
	const dir = resolveDir(configDir);
	ensureDir(dir);
	const tmpPath = join(dir, `.daemon.json.tmp.${process.pid}.${Date.now()}`);
	const finalPath = join(dir, "daemon.json");
	await writeFile(tmpPath, JSON.stringify(config, null, 2), "utf-8");
	await rename(tmpPath, finalPath);
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
