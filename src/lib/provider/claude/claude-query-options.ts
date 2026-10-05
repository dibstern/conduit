import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import type { PreWarmSessionInput } from "../types.js";
import { claudeApiModelId } from "./claude-api-model-id.js";
import { makeClaudeSdkEnv } from "./claude-sdk-env.js";
import { buildClaudeFlagSettings } from "./claude-sdk-settings.js";
import { validateOptionsJsonShape } from "./claude-sdk-validation.js";
import { toSdkPermissionMode } from "./permission-mode-map.js";
import type { CanUseTool, Options as SDKOptions } from "./types.js";

/** The same launch options are used by idle pre-warming and the first send. */
export function buildClaudeQueryOptions(
	input: PreWarmSessionInput,
	abortController: AbortController,
	canUseTool: CanUseTool,
	claudeSettingsOverrides: Settings | undefined,
	shellEnv: Readonly<Record<string, string | undefined>> | undefined,
): SDKOptions {
	const model = claudeApiModelId(input.model?.modelId, input.contextWindow);
	if (model === undefined)
		throw new ClaudeRuntimeError({
			message: "Claude model is required before query creation",
		});
	const resumeSessionId =
		typeof input.providerState["resumeSessionId"] === "string"
			? input.providerState["resumeSessionId"]
			: undefined;
	// Older durable commands and launch snapshots predate extra folders.
	const extraFolders = input.extraFolders ?? [];
	return validateOptionsJsonShape({
		cwd: input.workspaceRoot,
		...(extraFolders.length > 0
			? { additionalDirectories: [...extraFolders] }
			: {}),
		abortController,
		env: makeClaudeSdkEnv({
			configDir:
				input.configDir ??
				(typeof input.providerState["claudeConfigDir"] === "string"
					? input.providerState["claudeConfigDir"]
					: undefined),
			baseEnv: shellEnv,
		}),
		includePartialMessages: true,
		forwardSubagentText: true,
		settings: buildClaudeFlagSettings(claudeSettingsOverrides),
		settingSources: ["user", "project", "local"],
		canUseTool,
		model,
		// Opt in so the live query can later choose the full-access mode.
		allowDangerouslySkipPermissions: true,
		// Always send a mode: since SDK 0.3.286 an omitted one defers to the
		// user's settings defaultMode, which can be auto and skip conduit's asks.
		permissionMode: toSdkPermissionMode(input.permissionMode ?? "ask"),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(input.agent ? { agent: input.agent } : {}),
		...(input.variant
			? { effort: input.variant as NonNullable<SDKOptions["effort"]> }
			: {}),
	});
}
