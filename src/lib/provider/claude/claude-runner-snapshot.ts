import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRunnerFileSettings as RunnerFileSettings } from "./claude-runner-settings.js";
import type { ClaudePreWarmSessionInput, Options } from "./types.js";

/** Session launch data stays in memory, including across runner replacement. */
export interface RunnerSettingsSnapshot {
	readonly input: ClaudePreWarmSessionInput;
	readonly claudeSettingsOverrides?: Settings;
	readonly options: Omit<
		Options,
		| "abortController"
		| "canUseTool"
		| "resume"
		| "resumeSessionAt"
		| "forkSession"
		| "sessionId"
	>;
	readonly fileSettings?: RunnerFileSettings;
	/** Retain original launch directories across primary/extra folder swaps. */
	readonly workspaceDirectories?: readonly string[];
	readonly workspacePreviousRoot?: string;
}

/** Mutable SDK controls travel separately from the session's launch snapshot. */
export type RunnerLiveQueryConfiguration = Pick<
	ClaudePreWarmSessionInput,
	"model" | "contextWindow" | "variant" | "permissionMode"
>;

export type { Settings as LegacyRunnerSettings } from "@anthropic-ai/claude-agent-sdk";
export type { ClaudeSDKPermissionMode as LegacyRunnerPermissionMode } from "../../contracts/providers/claude-agent-sdk.js";

export interface RunnerCommandSettings {
	readonly claudeSettingsOverrides?: Settings | undefined;
}
