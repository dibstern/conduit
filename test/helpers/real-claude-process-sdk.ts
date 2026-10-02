import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { claudeSdk as fakeClaudeSdk } from "./fake-claude-process-sdk.js";

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query,
	titleQuery: fakeClaudeSdk.titleQuery,
};
