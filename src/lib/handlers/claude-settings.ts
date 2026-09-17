import { Data, Effect } from "effect";
import {
	CLAUDE_TRUST_TIERED_SETTINGS_KEYS,
	type ClaudeSettingsOverrides,
	ClaudeSettingsTrustBoundaryError,
} from "../contracts/claude-settings.js";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	type ClaudeSettingsChildRunner,
	resolveClaudeSettingsFromDisk,
} from "../provider/claude/claude-settings-resolver.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";

class RelaySettingsSaveError extends Data.TaggedError(
	"RelaySettingsSaveError",
)<{ readonly cause: unknown }> {}

class ClaudeSettingsInstanceError extends Data.TaggedError(
	"ClaudeSettingsInstanceError",
)<{ readonly instanceId: string; readonly message: string }> {}

export function getClaudeSettingsOverrides(
	configDir?: string,
): ClaudeSettingsOverrides {
	return loadRelaySettings(configDir).claudeSettings ?? {};
}

export const setClaudeSettingsForRelay = (input: {
	readonly clientId: string;
	readonly overrides: ClaudeSettingsOverrides;
}) =>
	Effect.gen(function* () {
		const rejectedKey = Object.keys(input.overrides).find((key) =>
			CLAUDE_TRUST_TIERED_SETTINGS_KEYS.includes(key),
		);
		if (rejectedKey !== undefined) {
			return yield* new ClaudeSettingsTrustBoundaryError({
				key: rejectedKey,
				message: `Claude setting "${rejectedKey}" cannot be overridden because its trust depends on the source tier`,
			});
		}

		const config = yield* ConfigTag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		yield* Effect.try({
			try: () =>
				saveRelaySettings(
					{ claudeSettings: { ...input.overrides } },
					config.configDir,
				),
			catch: (cause) => new RelaySettingsSaveError({ cause }),
		});

		const overrides = getClaudeSettingsOverrides(config.configDir);
		wsHandler.broadcast({ type: "claude_settings_info", overrides });
		log.info(
			`client=${input.clientId} Claude settings overrides updated: ${Object.keys(overrides).length} keys`,
		);
		return overrides;
	});

export const resolveClaudeSettingsForInstance = (
	input: { readonly instanceId: string },
	runChild?: ClaudeSettingsChildRunner,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const daemonConfig = loadDaemonConfig(config.configDir);
		if (
			resolveProviderRoutingDriver(daemonConfig, input.instanceId) !== "claude"
		) {
			return yield* new ClaudeSettingsInstanceError({
				instanceId: input.instanceId,
				message: `Provider instance "${input.instanceId}" is not a Claude instance`,
			});
		}

		return yield* resolveClaudeSettingsFromDisk(
			{
				workspaceRoot: config.projectDir,
				configDir: resolveClaudeInstanceConfigDir(
					daemonConfig,
					input.instanceId,
				),
			},
			runChild,
		);
	});
