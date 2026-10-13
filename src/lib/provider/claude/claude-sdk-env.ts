import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import type { ClaudeConfigDir } from "../../contracts/claude-config-dir.js";
import { ClaudeConfigDirSchema as ClaudeConfigDirWireSchema } from "../../contracts/claude-config-dir.js";

export type { ClaudeConfigDir } from "../../contracts/claude-config-dir.js";

import type { Options as SDKOptions } from "./types.js";

const DIRECT_ANTHROPIC_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	// Model-alias overrides: a daemon launched from a shell where Claude Code
	// (or ccs) applied a settings env block would silently reroute every
	// session's alias resolution — e.g. compaction resolving "opus" to a
	// Bedrock inference profile an OAuth session can't use. Sessions must get
	// alias resolution from their config dir, not the daemon's launch shell.
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
] as const;

export const ClaudeConfigDirSchema = ClaudeConfigDirWireSchema.pipe(
	Schema.filter(
		(folder) =>
			folder._tag === "Configured" ||
			basename(resolve(folder.path)) === ".claude",
		{
			message: () => "Claude SDK default folder must be a .claude directory",
		},
	),
);

export const sdkDefaultClaudeConfigDir = (path: string): ClaudeConfigDir => ({
	_tag: "SdkDefault",
	path,
});

export const configuredClaudeConfigDir = (path: string): ClaudeConfigDir => ({
	_tag: "Configured",
	path,
});

/** Whether two launches log in through the same folder; a relative folder resolves against its own workspace. */
export const sameClaudeLogin = (
	a: { readonly configDir: ClaudeConfigDir; readonly root: string },
	b: { readonly configDir: ClaudeConfigDir; readonly root: string },
): boolean =>
	a.configDir._tag === b.configDir._tag &&
	resolve(a.root, a.configDir.path) === resolve(b.root, b.configDir.path);

/** Capture once at a composition root, before daemon startup edits its env. */
export function captureClaudeLaunchLogin(
	baseEnv: Readonly<Record<string, string | undefined>>,
	override?: string,
): ClaudeConfigDir {
	const path = override ?? baseEnv["CLAUDE_CONFIG_DIR"];
	return path === undefined
		? sdkDefaultClaudeConfigDir(join(baseEnv["HOME"] ?? homedir(), ".claude"))
		: configuredClaudeConfigDir(path);
}

export const ClaudeFolderSourceSchema = Schema.Literal(
	"account",
	"implicitDefault",
	"legacyDefault",
);

/** A complete login and the policy for selecting its native folder. */
export interface ClaudeLaunchConfig {
	readonly configDir: ClaudeConfigDir;
	readonly folderSource: typeof ClaudeFolderSourceSchema.Type;
}

export function makeClaudeSdkEnv(
	opts: Pick<ClaudeLaunchConfig, "configDir"> & {
		baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
		accountEnv?: Readonly<Record<string, string>> | undefined;
	},
): NonNullable<SDKOptions["env"]> {
	const env: Record<string, string | undefined> = {
		...(opts.baseEnv ?? process.env),
	};
	for (const key of DIRECT_ANTHROPIC_ENV_KEYS) {
		delete env[key];
	}
	Object.assign(env, opts.accountEnv);
	env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "conduit";
	// claude.ai account connectors (Gmail, Drive, ...) otherwise load into every
	// session, and their "sign in again" notices leak into model replies.
	env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false";
	return makeClaudeTerminalEnv({ configDir: opts.configDir, baseEnv: env });
}

/** Select a login folder without changing the rest of a terminal's shell env. */
export function makeClaudeTerminalEnv(opts: {
	configDir: ClaudeConfigDir;
	baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
}): Record<string, string | undefined> {
	const env = { ...(opts.baseEnv ?? process.env) };
	const configDir = Schema.decodeUnknownSync(ClaudeConfigDirSchema)(
		opts.configDir,
	);
	if (configDir._tag === "SdkDefault") {
		const folder = resolve(configDir.path);
		// An explicit standard root selects different Keychain and global-config
		// locations. Pin HOME so the SDK keeps using the resolved default folder.
		env["HOME"] = dirname(folder);
		delete env["CLAUDE_CONFIG_DIR"];
	} else env["CLAUDE_CONFIG_DIR"] = configDir.path;
	return env;
}
