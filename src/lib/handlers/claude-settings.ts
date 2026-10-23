import { Data, Effect, Option } from "effect";
import type { AccountRef } from "../contracts/account.js";
import {
	CLAUDE_TRUST_TIERED_SETTINGS_KEYS,
	type ClaudeSettingsOverrides,
	ClaudeSettingsTrustBoundaryError,
} from "../contracts/claude-settings.js";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import { ProjectShellEnvTag } from "../domain/daemon/Layers/project-shell-env-layer.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { publishGlobalProjectSetting } from "../domain/relay/Services/project-settings.js";
import { ConfigTag, LoggerTag } from "../domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import { ClaudeAccountScopes } from "../provider/claude/claude-account-scopes.js";
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
		yield* publishGlobalProjectSetting("claudeSettings");
		log.info(
			`client=${input.clientId} Claude settings overrides updated: ${Object.keys(overrides).length} keys`,
		);
		return overrides;
	});

export const resolveClaudeSettingsForInstance = (
	input: {
		readonly instanceId: string;
		readonly accountRef?: AccountRef | undefined;
		readonly sessionId?: string | undefined;
	},
	runChild?: ClaudeSettingsChildRunner,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const account = yield* (yield* AccountDirectory).resolve(
			input.accountRef ?? { _tag: "Id", id: input.instanceId },
		);
		const requested = input.accountRef ?? { _tag: "Id", id: input.instanceId };
		if (requested._tag === "Id" && account.id !== requested.id)
			return yield* new ClaudeSettingsInstanceError({
				instanceId: requested.id,
				message: `Claude account "${requested.id}" is no longer available`,
			});
		if (
			PROVIDER_DRIVERS[account.driver].accountKind !== "config-directory" ||
			!("folder" in account)
		) {
			return yield* new ClaudeSettingsInstanceError({
				instanceId: input.instanceId,
				message: `Provider instance "${input.instanceId}" is not a Claude instance`,
			});
		}

		const primaryFolder = config.projectDir;
		const workspaceRoot = input.sessionId
			? yield* (yield* SessionWorkspaceTag).get(input.sessionId)
			: primaryFolder;
		const scopes = yield* Effect.serviceOption(ClaudeAccountScopes);
		const shell = yield* Effect.serviceOption(ProjectShellEnvTag);
		const baseEnv = Option.isSome(shell)
			? shell.value.get(workspaceRoot, config.slug)
			: undefined;
		const resolve = (selected: typeof account) =>
			resolveClaudeSettingsFromDisk(
				{
					workspaceRoot,
					...(baseEnv ? { baseEnv } : {}),
					configDir: "folder" in selected ? selected.folder : account.folder,
					...(selected.env ? { accountEnv: selected.env } : {}),
				},
				runChild,
			);
		return yield* Option.isSome(scopes)
			? scopes.value.use(account, ({ account }) => resolve(account))
			: resolve(account);
	});
