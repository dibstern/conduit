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

export function makeClaudeSdkEnv(opts?: {
	configDir?: string | undefined;
	baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
}): NonNullable<SDKOptions["env"]> {
	const env: Record<string, string | undefined> = {
		...(opts?.baseEnv ?? process.env),
	};
	for (const key of DIRECT_ANTHROPIC_ENV_KEYS) {
		delete env[key];
	}
	env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "conduit";
	// claude.ai account connectors (Gmail, Drive, ...) otherwise load into every
	// session, and their "sign in again" notices leak into model replies.
	env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false";
	if (opts?.configDir !== undefined && opts.configDir.length > 0) {
		env["CLAUDE_CONFIG_DIR"] = opts.configDir;
	}
	return env;
}
