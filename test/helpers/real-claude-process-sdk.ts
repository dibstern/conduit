import { query } from "@anthropic-ai/claude-agent-sdk";
import { defaultClaudeSessionForkSdk } from "../../src/lib/provider/claude/claude-session-fork.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { claudeSdk as fakeClaudeSdk } from "./fake-claude-process-sdk.js";

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query,
	titleQuery: fakeClaudeSdk.titleQuery,
	fork: defaultClaudeSessionForkSdk,
};
