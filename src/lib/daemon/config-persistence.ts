// Handles persistent daemon config at ~/.conduit/daemon.json,
// recent projects at ~/.conduit/recent.json, and crash info at
// ~/.conduit/crash.json. Uses atomic writes (tmp + rename) for
// daemon.json to prevent corruption.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Data, Effect, Either, Schema } from "effect";
import { UsageLimitsSettingSchema } from "../contracts/limit-recovery.js";
import { ManagedOpenCodeProcessIdentitySchema } from "../contracts/managed-opencode.js";
import { SessionModeSchema } from "../contracts/project-file.js";

import { ProjectShellEnvConfigSchema } from "../contracts/project-shell-env.js";

import {
	defaultInstanceIdForDriver,
	isKnownDriverKind,
	KnownProviderDriverKindSchema,
	migrateLegacyDefaultOpencodeInstanceId,
	type ProviderDriverKind,
	type ProviderInstanceId,
	ProviderInstanceIdSchema,
} from "../contracts/provider-instance.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import {
	GroupingModeSchema,
	RepositoryIdentitySchema,
} from "../shared-types.js";
import type { RecentProject } from "../types.js";
import { isRecord } from "../utils.js";
import {
	addRecent,
	deserializeRecent,
	serializeRecent,
} from "./recent-projects.js";

/** Days of inactivity before automatic settlement when no value is persisted. */
export const DEFAULT_AUTO_SETTLE_AFTER_DAYS = 3;

export const CURRENT_CONFIG_VERSION = 1;

const ProjectSchema = Schema.Struct({
	path: Schema.String,
	folders: Schema.NonEmptyArray(Schema.String),
	repositoryIdentities: Schema.optionalWith(
		Schema.Record({ key: Schema.String, value: RepositoryIdentitySchema }),
		{ exact: true },
	),
	slug: Schema.String,
	title: Schema.optionalWith(Schema.String, { exact: true }),
	addedAt: Schema.Number,
	shellEnv: Schema.optionalWith(ProjectShellEnvConfigSchema, { exact: true }),
	setupScript: Schema.optionalWith(Schema.String, { exact: true }),
	sessionMode: Schema.optionalWith(SessionModeSchema, { exact: true }),
	groupingMode: Schema.optionalWith(GroupingModeSchema, { exact: true }),
	sessionCount: Schema.optionalWith(Schema.Number, { exact: true }),
});

/** A project as any daemon version wrote it; older ones have no `folders`, only `directory` or `path`. */
const PersistedProjectSchema = Schema.Struct({
	...ProjectSchema.fields,
	directory: Schema.optionalWith(Schema.String, { exact: true }),
	folders: Schema.optionalWith(Schema.NonEmptyArray(Schema.String), {
		exact: true,
	}),
});
export type PersistedProject = Omit<
	DaemonConfig["projects"][number],
	"folders"
> & {
	directory?: string;
	folders?: readonly string[];
};

export const DaemonProjectSchema = Schema.transform(
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

const DaemonInstanceSchema = Schema.mutable(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		port: Schema.Number,
		managed: Schema.Boolean,
		pid: Schema.optionalWith(
			Schema.Number.pipe(Schema.int(), Schema.positive()),
			{ exact: true },
		),
		version: Schema.optionalWith(Schema.String, { exact: true }),
		processIdentity: Schema.optionalWith(ManagedOpenCodeProcessIdentitySchema, {
			exact: true,
		}),
		env: Schema.optionalWith(
			Schema.mutable(
				Schema.Record({ key: Schema.String, value: Schema.String }),
			),
			{ exact: true },
		),
		url: Schema.optionalWith(Schema.String, { exact: true }),
		driver: Schema.optionalWith(KnownProviderDriverKindSchema, { exact: true }),
		configDir: Schema.optionalWith(Schema.String, { exact: true }),
	}),
);

export const DaemonConfigSchema = Schema.mutable(
	Schema.Struct({
		// Missing versions are legacy; never decode a newer version and discard its fields.
		configVersion: Schema.optionalWith(
			Schema.Number.pipe(
				Schema.int(),
				Schema.between(0, CURRENT_CONFIG_VERSION),
			),
			{ exact: true },
		),
		pid: Schema.Number,
		port: Schema.Number,
		pinHash: Schema.NullOr(Schema.String),
		tls: Schema.Boolean,
		tailscaleServe: Schema.optionalWith(Schema.Boolean, { exact: true }),
		tailscaleServeCleanupPending: Schema.optionalWith(Schema.Boolean, {
			exact: true,
		}),
		debug: Schema.Boolean,
		keepAwake: Schema.Boolean,
		autoSettleAfterDays: Schema.optionalWith(
			Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(1, 90))),
			{ exact: true },
		),
		usageLimits: Schema.optionalWith(UsageLimitsSettingSchema, { exact: true }),
		keepAwakeCommand: Schema.optionalWith(Schema.String, { exact: true }),
		keepAwakeArgs: Schema.optionalWith(
			Schema.mutable(Schema.Array(Schema.String)),
			{ exact: true },
		),
		claudeConfigDir: Schema.optionalWith(Schema.String, { exact: true }),
		newSessionProject: Schema.optionalWith(Schema.String, { exact: true }),
		projects: Schema.mutable(Schema.Array(DaemonProjectSchema)),
		instances: Schema.optionalWith(
			Schema.mutable(Schema.Array(DaemonInstanceSchema)),
			{ exact: true },
		),
	}),
);

export type DaemonConfig = Schema.Schema.Type<typeof DaemonConfigSchema>;

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

export interface ResolvedProviderInstance {
	id: ProviderInstanceId;
	driver: ProviderDriverKind;
	configDir?: string;
}

export function resolveConfiguredInstances(
	config: DaemonConfig,
): ReadonlyArray<ResolvedProviderInstance> {
	const explicitInstances = (config.instances ?? []).map((instance) => {
		const configDir =
			instance.id === defaultInstanceIdForDriver("claude")
				? (instance.configDir ?? config.claudeConfigDir)
				: instance.configDir;
		return {
			id: ProviderInstanceIdSchema.make(instance.id),
			driver: instance.driver ?? "opencode",
			...(configDir === undefined ? {} : { configDir }),
		};
	});
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
	if (
		configuredInstance?.driver !== "claude" ||
		configuredInstance.configDir === undefined
	)
		return undefined;
	// The default account uses the environment resolved at boot. Reading its
	// saved folder here would apply a pending edit to the very next turn.
	return instanceId === defaultInstanceIdForDriver("claude")
		? process.env["CLAUDE_CONFIG_DIR"]
		: configuredInstance.configDir;
}

/** Keep legacy explicit default folders in the daemon's single stored home. */
function normalizeDefaultClaudeConfig(config: DaemonConfig): DaemonConfig {
	const defaultId = defaultInstanceIdForDriver("claude");
	const explicit = config.instances?.find(({ id }) => id === defaultId);
	if (explicit?.configDir === undefined) return config;
	return {
		...config,
		claudeConfigDir: explicit.configDir,
		instances: (config.instances ?? []).map((instance) => {
			if (instance.id !== defaultId) return instance;
			const { configDir: _configDir, ...metadata } = instance;
			return metadata;
		}),
	};
}

/** Default config for first-startup when no daemon.json exists. */
export function defaultDaemonConfig(): DaemonConfig {
	return {
		configVersion: CURRENT_CONFIG_VERSION,
		pid: process.pid,
		port: 2633,
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
		projects: [],
	};
}

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
 * lingering `"default"` id desyncs the config from
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
	const migrated = migrateLegacyDefaultOpencodeInstanceId(config.instances);
	return migrated === null ? config : { ...config, instances: migrated };
}

export class DaemonConfigNotFound extends Data.TaggedError("NotFound")<{
	readonly path: string;
	readonly cause: unknown;
}> {
	override get message(): string {
		return `Daemon config not found at ${this.path}: ${String(this.cause)}`;
	}
}

export class DaemonConfigUnreadable extends Data.TaggedError("Unreadable")<{
	readonly path: string;
	readonly cause: unknown;
}> {
	override get message(): string {
		return `Unreadable daemon config at ${this.path}: ${String(this.cause)}`;
	}
}

export class DaemonConfigInvalid extends Data.TaggedError("Invalid")<{
	readonly path: string;
	readonly cause: unknown;
}> {
	override get message(): string {
		return `Invalid daemon config at ${this.path}: ${String(this.cause)}`;
	}
}

export type DaemonConfigLoadError =
	| DaemonConfigNotFound
	| DaemonConfigUnreadable
	| DaemonConfigInvalid;

/** Read once and distinguish first startup from a file that must be preserved. */
export function loadDaemonConfigResult(
	configDir?: string,
): Either.Either<DaemonConfig, DaemonConfigLoadError> {
	const path = join(resolveDir(configDir), "daemon.json");
	const data = Either.try({
		try: () => readFileSync(path, "utf-8"),
		catch: (cause) =>
			cause instanceof Error && "code" in cause && cause.code === "ENOENT"
				? new DaemonConfigNotFound({ path, cause })
				: new DaemonConfigUnreadable({ path, cause }),
	});
	if (Either.isLeft(data)) return Either.left(data.left);
	return Either.try({
		try: () => {
			const decoded = Schema.decodeUnknownSync(DaemonConfigSchema)(
				sanitizeRestartMetadata(JSON.parse(data.right)),
			);
			return {
				...normalizeDefaultClaudeConfig(migrateLegacyInstanceIds(decoded)),
				autoSettleAfterDays:
					decoded.autoSettleAfterDays === undefined
						? DEFAULT_AUTO_SETTLE_AFTER_DAYS
						: decoded.autoSettleAfterDays,
			};
		},
		catch: (cause) => new DaemonConfigInvalid({ path, cause }),
	});
}

/** Compatibility for callers moved to typed loading in the next ticket. */
export function loadDaemonConfig(configDir?: string): DaemonConfig | null {
	return Either.getOrNull(loadDaemonConfigResult(configDir));
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
	const normalized = normalizeDefaultClaudeConfig(config);
	const projects = normalized.projects.map(migrateProjectFolders);
	await writeFile(
		tmpPath,
		JSON.stringify(
			{ ...normalized, configVersion: CURRENT_CONFIG_VERSION, projects },
			null,
			2,
		),
		{
			encoding: "utf-8",
			mode: 0o600,
		},
	);
	await chmod(tmpPath, 0o600);
	await rename(tmpPath, finalPath);
}

/** Persist decode migrations once, using the same snapshot that seeds startup. */
export const migrateDaemonConfig = (config: DaemonConfig, configDir: string) =>
	Effect.gen(function* () {
		if (config.configVersion === CURRENT_CONFIG_VERSION) return;
		yield* Effect.tryPromise(() => saveDaemonConfig(config, configDir));
		yield* Effect.logInfo("Migrated daemon config", {
			configVersion: CURRENT_CONFIG_VERSION,
		});
	});

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
