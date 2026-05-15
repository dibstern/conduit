import type { Options as SDKOptions } from "./types.js";

const DIRECT_ANTHROPIC_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
] as const;

export function makeClaudeSdkEnv(): NonNullable<SDKOptions["env"]> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const key of DIRECT_ANTHROPIC_ENV_KEYS) {
		delete env[key];
	}
	env["CLAUDE_AGENT_SDK_CLIENT_APP"] = "conduit";
	return env;
}
