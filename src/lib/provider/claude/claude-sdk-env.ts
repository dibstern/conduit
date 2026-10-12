import { basename, dirname, resolve } from "node:path";
import { Schema } from "effect";
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

const ConfigDirPath = Schema.String.pipe(
	Schema.filter((path) => path.trim().length > 0, {
		message: () => "Claude config directory must be non-empty",
	}),
);

export const ClaudeConfigDirSchema = Schema.Union(
	Schema.TaggedStruct("SdkDefault", {
		path: ConfigDirPath.pipe(
			Schema.filter((path) => basename(resolve(path)) === ".claude", {
				message: () => "Claude SDK default folder must be a .claude directory",
			}),
		),
	}),
	Schema.TaggedStruct("Configured", { path: ConfigDirPath }),
);

export type ClaudeConfigDir = typeof ClaudeConfigDirSchema.Type;

export const sdkDefaultClaudeConfigDir = (path: string): ClaudeConfigDir => ({
	_tag: "SdkDefault",
	path,
});

export const configuredClaudeConfigDir = (path: string): ClaudeConfigDir => ({
	_tag: "Configured",
	path,
});

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
	},
): NonNullable<SDKOptions["env"]> {
	const configDir = Schema.decodeUnknownSync(ClaudeConfigDirSchema)(
		opts.configDir,
	);
	const env: Record<string, string | undefined> = {
		...(opts.baseEnv ?? process.env),
	};
	for (const key of DIRECT_ANTHROPIC_ENV_KEYS) {
		delete env[key];
	}
	env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "conduit";
	// claude.ai account connectors (Gmail, Drive, ...) otherwise load into every
	// session, and their "sign in again" notices leak into model replies.
	env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false";
	if (configDir._tag === "SdkDefault") {
		const folder = resolve(configDir.path);
		// An explicit standard root selects different Keychain and global-config
		// locations. Pin HOME so the SDK keeps using the resolved default folder.
		env["HOME"] = dirname(folder);
		delete env["CLAUDE_CONFIG_DIR"];
	} else env["CLAUDE_CONFIG_DIR"] = configDir.path;
	return env;
}
