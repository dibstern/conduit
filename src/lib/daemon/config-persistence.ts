// Handles persistent daemon config at ~/.conduit/daemon.json,
// recent projects at ~/.conduit/recent.json, and crash info at
// ~/.conduit/crash.json. Uses atomic writes (tmp + rename) for
// daemon.json to prevent corruption.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Context, Effect, Layer, Option, Schema } from "effect";
import {
	type ManagedOpenCodeProcessIdentity,
	ManagedOpenCodeProcessIdentitySchema,
} from "../contracts/managed-opencode.js";

import {
	type ProjectShellEnvConfig,
	ProjectShellEnvConfigSchema,
} from "../contracts/project-shell-env.js";

import {
	defaultInstanceIdForDriver,
	isKnownDriverKind,
	migrateLegacyDefaultOpencodeInstanceId,
	type ProviderDriverKind,
	type ProviderInstanceId,
	ProviderInstanceIdSchema,
} from "../contracts/provider-instance.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { RecentProject } from "../types.js";
import { isRecord } from "../utils.js";
import {
	addRecent,
	deserializeRecent,
	serializeRecent,
} from "./recent-projects.js";

/** Days of inactivity before automatic settlement when no value is persisted. */
export const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;

export interface DaemonConfig {
	pid: number;
	port: number;
	pinHash: string | null;
	tls: boolean;
	tailscaleServe?: boolean;
	/** Retry an owned root-handler removal after a transient Tailscale failure. */
	tailscaleServeCleanupPending?: boolean;
	debug: boolean;
	keepAwake: boolean;
	/** Days of inactivity before automatic settlement; null disables it. */
	autoSettleAfterDays?: number | null;
	/** User-provided keep-awake command override (e.g. "systemd-inhibit"). */
	keepAwakeCommand?: string;
	/** Arguments for the keep-awake command override. */
	keepAwakeArgs?: string[];
	dangerouslySkipPermissions: boolean;
	/**
	 * Claude Code config directory (CLAUDE_CONFIG_DIR) for Claude SDK
	 * subprocesses. Applied to process.env at daemon startup; restart to change.
	 */
	claudeConfigDir?: string;
	projects: Array<{
		path: string;
		folders: readonly [string, ...string[]];
		slug: string;
		title?: string;
		addedAt: number;
		instanceId?: string;
		shellEnv?: ProjectShellEnvConfig;
		/** Cached session count from last run — for instant CLI display. */
		sessionCount?: number;
	}>;
	instances?: Array<{
		id: string;
		name: string;
		port: number;
		managed: boolean;
		pid?: number;
		version?: string;
		processIdentity?: ManagedOpenCodeProcessIdentity;
		env?: Record<string, string>;
		url?: string;
		driver?: ProviderDriverKind;
		configDir?: string;
	}>;
}

const ProjectSchema = Schema.Struct({
	path: Schema.String,
	folders: Schema.NonEmptyArray(Schema.String),
	slug: Schema.String,
	title: Schema.optional(Schema.String),
	addedAt: Schema.Number,
	instanceId: Schema.optional(Schema.String),
	shellEnv: Schema.optional(ProjectShellEnvConfigSchema),
	sessionCount: Schema.optional(Schema.Number),
});

/** A project as any daemon version wrote it; older ones have no `folders`, only `directory` or `path`. */
const PersistedProjectSchema = Schema.Struct({
	...ProjectSchema.fields,
	directory: Schema.optional(Schema.String),
	folders: Schema.optional(Schema.NonEmptyArray(Schema.String)),
});
export type PersistedProject = Omit<
	DaemonConfig["projects"][number],
	"folders"
> & {
	directory?: string;
	folders?: readonly string[];
};

const DaemonProjectSchema = Schema.transform(
	PersistedProjectSchema,
	Schema.typeSchema(ProjectSchema),
	{
		strict: true,
		decode: (project) => migrateProjectFolders(project),
		encode: (project) => project,
	},
);

/** Resolve a project's folders, reading a legacy `directory` or `path` when `folders` is absent. Drops `directory`. */
export const migrateProjectFolders = <
	T extends {
		readonly path: string;
		readonly directory?: string | undefined;
		readonly folders?: readonly string[] | undefined;
	},
>({
	directory: legacyDirectory,
	...project
}: T) => {
	const main = resolve(project.folders?.[0] ?? legacyDirectory ?? project.path);
	return {
		...project,
		path: main,
		folders: [
			main,
			...(project.folders?.slice(1) ?? []).map((folder) => resolve(folder)),
		] as const,
	};
};

const DaemonInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	port: Schema.Number,
	managed: Schema.Boolean,
	pid: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
	version: Schema.optional(Schema.String),
	processIdentity: Schema.optional(ManagedOpenCodeProcessIdentitySchema),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	url: Schema.optional(Schema.String),
	driver: Schema.optional(Schema.String),
	configDir: Schema.optional(Schema.String),
});

export const DaemonConfigSchema = Schema.Struct({
	pid: Schema.Number,
	port: Schema.Number,
	pinHash: Schema.NullOr(Schema.String),
	tls: Schema.Boolean,
	tailscaleServe: Schema.optional(Schema.Boolean),
	tailscaleServeCleanupPending: Schema.optional(Schema.Boolean),
	debug: Schema.Boolean,
	keepAwake: Schema.Boolean,
	autoSettleAfterDays: Schema.optional(
		Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(1, 90))),
	),
	keepAwakeCommand: Schema.optional(Schema.String),
	keepAwakeArgs: Schema.optional(Schema.Array(Schema.String)),
	dangerouslySkipPermissions: Schema.Boolean,
	claudeConfigDir: Schema.optional(Schema.String),
	projects: Schema.Array(DaemonProjectSchema),
	instances: Schema.optional(Schema.Array(DaemonInstanceSchema)),
});

// Process recovery is disposable. A damaged recovery field must not invalidate
// authentication, project registration, or any other daemon setting.
export const sanitizeRestartMetadata = (value: unknown): unknown => {
	if (!isRecord(value) || !Array.isArray(value["instances"])) return value;
	return {
		...value,
		instances: value["instances"].map((instance: unknown) => {
			if (!isRecord(instance)) return instance;
			const pid = instance["pid"];
			const version = instance["version"];
			const identity = instance["processIdentity"];
			const env = instance["env"];
			const invalidAuth =
				instance["managed"] === true &&
				instance["driver"] !== "claude" &&
				isRecord(env) &&
				["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"].some(
					(key) => Object.hasOwn(env, key) && typeof env[key] !== "string",
				);
			const validIdentity =
				identity === undefined ||
				Schema.is(ManagedOpenCodeProcessIdentitySchema)(identity);
			if (
				(pid === undefined ||
					(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0)) &&
				(version === undefined || typeof version === "string") &&
				validIdentity &&
				!invalidAuth
			)
				return instance;
			const {
				pid: _pid,
				version: _version,
				processIdentity: _identity,
				...settings
			} = instance;
			return {
				...settings,
				...(invalidAuth && isRecord(env)
					? {
							env: Object.fromEntries(
								Object.entries(env).filter(
									([key, entry]) =>
										(key !== "OPENCODE_SERVER_PASSWORD" &&
											key !== "OPENCODE_SERVER_USERNAME") ||
										typeof entry === "string",
								),
							),
						}
					: {}),
				...(validIdentity && identity !== undefined
					? { processIdentity: identity }
					: {}),
			};
		}),
	};
};

export class DaemonConfigTag extends Context.Tag("DaemonConfig")<
	DaemonConfigTag,
	DaemonConfig
>() {}

export interface ResolvedProviderInstance {
	id: ProviderInstanceId;
	driver: ProviderDriverKind;
	configDir?: string;
}

export function resolveConfiguredInstances(
	config: DaemonConfig,
): ReadonlyArray<ResolvedProviderInstance> {
	const explicitInstances = (config.instances ?? []).map((instance) => ({
		id: ProviderInstanceIdSchema.make(instance.id),
		driver: instance.driver ?? "opencode",
		...(instance.configDir === undefined
			? {}
			: { configDir: instance.configDir }),
	}));
	const explicitIds = new Set(explicitInstances.map(({ id }) => id));
	const defaults: ReadonlyArray<ResolvedProviderInstance> = [
		{
			id: defaultInstanceIdForDriver("opencode"),
			driver: "opencode",
		},
		{
			id: defaultInstanceIdForDriver("claude"),
			driver: "claude",
			...(config.claudeConfigDir === undefined
				? {}
				: { configDir: config.claudeConfigDir }),
		},
	];

	return [
		...explicitInstances,
		...defaults.filter(({ id }) => !explicitIds.has(id)),
	];
}

export function resolveInstanceDriver(
	config: DaemonConfig,
	instanceId: string,
): ProviderDriverKind {
	const configuredInstance = resolveConfiguredInstances(config).find(
		({ id }) => id === instanceId,
	);
	if (configuredInstance !== undefined) {
		return configuredInstance.driver;
	}
	if (isKnownDriverKind(instanceId)) {
		return instanceId;
	}
	return "opencode";
}

export function resolveProviderRoutingDriver(
	config: DaemonConfig | null,
	instanceId: string,
): ProviderDriverKind | undefined {
	const configuredInstance = config
		? resolveConfiguredInstances(config).find(({ id }) => id === instanceId)
		: undefined;
	if (configuredInstance !== undefined) {
		return configuredInstance.driver;
	}
	return isKnownDriverKind(instanceId) ? instanceId : undefined;
}

/**
 * Resolve the server base URL for a NAMED opencode-driver instance.
 * Returns undefined for the default "opencode" id (callers fall back to the
 * project-default client), for non-opencode drivers, and for unknown ids.
 * Managed instances are spawned locally by the daemon; unmanaged instances
 * point at a user-provided external URL.
 */
export function resolveOpenCodeInstanceUrl(
	config: DaemonConfig | null,
	instanceId: string,
): string | undefined {
	if (instanceId === defaultInstanceIdForDriver("opencode")) {
		return undefined;
	}
	const configuredInstance = config
		? config.instances?.find(({ id }) => id === instanceId)
		: undefined;
	if (
		configuredInstance === undefined ||
		(configuredInstance.driver ?? "opencode") !== "opencode"
	) {
		return undefined;
	}
	if (configuredInstance.managed === true) {
		return `http://localhost:${configuredInstance.port}`;
	}
	return configuredInstance.url;
}

export function resolveClaudeInstanceConfigDir(
	config: DaemonConfig | null,
	instanceId: string,
): string | undefined {
	const configuredInstance = config
		? resolveConfiguredInstances(config).find(({ id }) => id === instanceId)
		: undefined;
	return configuredInstance?.driver === "claude"
		? configuredInstance.configDir
		: undefined;
}

/** Default config for first-startup when no daemon.json exists. */
export function defaultDaemonConfig(): DaemonConfig {
	return {
		pid: process.pid,
		port: 2633,
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
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
			const decoded = yield* Schema.decodeUnknown(DaemonConfigSchema)(
				sanitizeRestartMetadata(json),
			);
			return {
				...migrateLegacyInstanceIds(decoded as unknown as DaemonConfig),
				autoSettleAfterDays:
					decoded.autoSettleAfterDays === undefined
						? DEFAULT_AUTO_SETTLE_AFTER_DAYS
						: decoded.autoSettleAfterDays,
			};
		}),
	);

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

/** Return the default config directory (~/.conduit) */
export function getConfigDir(): string {
	return DEFAULT_CONFIG_DIR;
}

/**
 * Normalize the legacy default OpenCode instance id to the canonical one.
 *
 * Pre-driver-model installs stored the sole OpenCode server as instance id
 * `"default"`; the driver+instance model canonicalizes the default OpenCode
 * instance as `defaultInstanceIdForDriver("opencode") === "opencode"`. A
 * lingering `"default"` id desyncs the config (and every project binding) from
 * the composer rail, which keys OpenCode providers to `"opencode"` — leaving
 * the OpenCode harness unpickable and duplicated. Rewriting the id to the
 * canonical value on load makes the existing code correct end-to-end. URL
 * resolution is preserved: the canonical `"opencode"` instance falls back to
 * the project-default client (`config.opencodeUrl`, which defaults to probing
 * localhost:4096 — the same server the legacy `"default"` instance pointed at).
 *
 * Idempotent; a no-op when there is no legacy OpenCode `"default"` instance or
 * an `"opencode"` instance already exists (never creates a duplicate id).
 */
export function migrateLegacyInstanceIds(config: DaemonConfig): DaemonConfig {
	if (config.instances === undefined) return config;
	const migrated = migrateLegacyDefaultOpencodeInstanceId(
		config.instances,
		config.projects,
	);
	return migrated === null
		? config
		: { ...config, instances: migrated.instances, projects: migrated.projects };
}

/** Read and parse daemon.json. Returns null if missing or corrupt. */
export function loadDaemonConfig(configDir?: string): DaemonConfig | null {
	try {
		const dir = resolveDir(configDir);
		const data = readFileSync(join(dir, "daemon.json"), "utf-8");
		const decoded = Schema.decodeUnknownSync(DaemonConfigSchema)(
			sanitizeRestartMetadata(JSON.parse(data)),
		);
		return {
			...migrateLegacyInstanceIds(decoded as unknown as DaemonConfig),
			autoSettleAfterDays:
				decoded.autoSettleAfterDays === undefined
					? DEFAULT_AUTO_SETTLE_AFTER_DAYS
					: decoded.autoSettleAfterDays,
		};
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
	const projects = config.projects.map(migrateProjectFolders);
	await writeFile(tmpPath, JSON.stringify({ ...config, projects }, null, 2), {
		encoding: "utf-8",
		mode: 0o600,
	});
	await chmod(tmpPath, 0o600);
	await rename(tmpPath, finalPath);
}

/** Rewrite daemon.json once at startup when a project still has the pre-folders shape (`directory`, no `folders`). */
export const migrateDaemonConfigFolders = (configDir?: string) =>
	Effect.gen(function* () {
		const raw = yield* Effect.try(
			() =>
				JSON.parse(
					readFileSync(join(resolveDir(configDir), "daemon.json"), "utf-8"),
				) as unknown,
		).pipe(Effect.orElseSucceed(() => undefined));
		const legacy =
			isRecord(raw) &&
			Array.isArray(raw["projects"]) &&
			raw["projects"].some(
				(project) =>
					isRecord(project) &&
					(!("folders" in project) || "directory" in project),
			);
		const config = legacy ? loadDaemonConfig(configDir) : null;
		if (!config) return;
		yield* Effect.promise(() => saveDaemonConfig(config, configDir));
		yield* Effect.logInfo("Migrated project config to folders", {
			projects: config.projects.map((project) => project.slug),
		});
	}).pipe(
		Effect.catchAllCause((cause) =>
			Effect.logWarning("Project config migration failed", { cause }),
		),
	);

/** Remove daemon.json and relay.sock. Ignores ENOENT. */
export function clearDaemonConfig(configDir?: string): void {
	const dir = resolveDir(configDir);
	safeUnlink(join(dir, "daemon.json"));
	safeUnlink(join(dir, "relay.sock"));
}

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

	// Merge new projects into existing list using the addRecent function
	let merged = loadRecentProjects(dir);
	const now = Date.now();
	for (const project of projects) {
		merged = addRecent(merged, project.path, project.slug, project.title, now);
	}

	// Write back
	writeFileSync(join(dir, "recent.json"), serializeRecent(merged), "utf-8");
}

/** Read recent.json; a missing or corrupt file is an empty list. */
export function loadRecentProjects(configDir?: string): RecentProject[] {
	try {
		return deserializeRecent(
			readFileSync(join(resolveDir(configDir), "recent.json"), "utf-8"),
		);
	} catch {
		return [];
	}
}
