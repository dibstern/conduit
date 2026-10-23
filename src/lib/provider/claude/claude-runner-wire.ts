import { Result, Schema } from "effect";
import { type AccountsState, resolve } from "../../account-directory.js";
import type { Account } from "../../contracts/account.js";
import { AccountUnroutable } from "../../contracts/limit-recovery.js";
import { isRecord } from "../../utils.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import type {
	RunnerMessage,
	RunnerWireCodec,
} from "../runner/runner-protocol.js";
import type { RunnerSettingsSnapshot } from "../runner/runner-upgrade.js";
import type { SessionTurn } from "../runner/session-runner.js";
import {
	type ClaudeConfigDir,
	ClaudeConfigDirSchema,
	ClaudeFolderSourceSchema,
	type ClaudeLaunchConfig,
	captureClaudeLaunchLogin,
	claudeLoginFromEnv,
	configuredClaudeConfigDir,
	makeClaudeSdkEnv,
} from "./claude-sdk-env.js";

/** Compatibility boundaries resolve defaults from the account owner's snapshot. */
export function claudeLaunchConfigFromAccounts(
	accounts?: AccountsState,
): ClaudeLaunchConfig {
	if (!accounts)
		return {
			configDir: captureClaudeLaunchLogin(process.env),
			folderSource: "implicitDefault",
		};
	const account = Result.getOrElse(
		resolve(accounts, { _tag: "DriverDefault", driver: "claude" }),
		(error) => {
			throw error;
		},
	);
	if (account.driver === "claude")
		return {
			configDir: account.folder,
			folderSource:
				account.configuredFolder === undefined ? "implicitDefault" : "account",
		};
	throw new AccountUnroutable({ ref: { _tag: "Id", id: account.id } });
}
/** Missing legacy folders preserve the carried account, then use the default. Explicit blanks are invalid. */
export function normalizeClaudeLaunchInput<
	T extends {
		readonly account?: Account | undefined;
		readonly configDir?: ClaudeConfigDir | string | undefined;
		readonly folderSource?: ClaudeLaunchConfig["folderSource"] | undefined;
	},
>(
	input: T,
	defaultFolder: () => ClaudeLaunchConfig = claudeLaunchConfigFromAccounts,
): Omit<T, "configDir" | "folderSource"> & ClaudeLaunchConfig {
	const { configDir: folder, folderSource: source, ...payload } = input;
	const launch =
		folder === undefined
			? {
					...(input.account?.driver === "claude"
						? { configDir: input.account.folder }
						: defaultFolder()),
					folderSource: "legacyDefault",
				}
			: {
					folderSource: source ?? "account",
					configDir:
						typeof folder === "string"
							? configuredClaudeConfigDir(folder)
							: folder,
				};
	const configDir = Schema.decodeUnknownSync(ClaudeConfigDirSchema)(
		launch.configDir,
	);
	const folderSource = Schema.decodeUnknownSync(ClaudeFolderSourceSchema)(
		launch.folderSource,
	);
	// Retained snapshots compare their JSON byte-for-byte across an upgrade.
	const normalized = {
		...input,
		...payload,
		...launch,
		configDir,
		folderSource,
	};
	if ("nativeThread" in input && isRecord(input.nativeThread)) {
		const folder = input.nativeThread["configDir"];
		if (folder !== undefined)
			Reflect.set(normalized, "nativeThread", {
				...input.nativeThread,
				configDir: Schema.decodeUnknownSync(ClaudeConfigDirSchema)(
					typeof folder === "string"
						? configuredClaudeConfigDir(folder)
						: folder,
				),
			});
	}
	return normalized;
}

export function normalizeClaudeSessionTurn(
	input: Omit<
		SessionTurn,
		"inputId" | "configDir" | "folderSource" | "continuation"
	> & {
		readonly continuation?: SessionTurn["continuation"] | boolean;
		readonly configDir?: ClaudeConfigDir | string | undefined;
		readonly folderSource?: ClaudeLaunchConfig["folderSource"] | undefined;
		readonly inputId?: string;
		readonly userMessageId?: string;
		readonly commandId?: string;
		readonly turnId?: string;
	},
	defaultFolder?: () => ClaudeLaunchConfig,
): SessionTurn & ClaudeLaunchConfig {
	const { inputId, userMessageId, commandId, turnId, continuation, ...turn } =
		input;
	// Pre-inbox continuations carried `true` and the cut-off id in
	// userMessageId; their own identity was the command id.
	const legacyCutOff = continuation === true ? userMessageId : undefined;
	const id =
		legacyCutOff !== undefined
			? commandId
			: (inputId ?? userMessageId ?? commandId ?? turnId);
	if (id === undefined)
		throw new ClaudeBoundaryError({
			operation: "decodeRunnerTurn",
			cause: "Claude turn input id is required",
		});
	return {
		...normalizeClaudeLaunchInput(turn, defaultFolder),
		inputId: id,
		...(typeof continuation === "object"
			? { continuation }
			: legacyCutOff !== undefined
				? { continuation: { cutOffMessageId: legacyCutOff } }
				: {}),
	};
}

function normalizeClaudeSnapshotInput(
	snapshot: RunnerSettingsSnapshot,
	defaultFolder: () => ClaudeLaunchConfig,
) {
	return normalizeClaudeLaunchInput(snapshot.input, () => {
		// A retained runner has already launched: preserve its recorded login.
		const configDir = claudeLoginFromEnv(snapshot.options.env ?? {});
		return configDir === undefined
			? defaultFolder()
			: {
					configDir,
					folderSource: "legacyDefault",
				};
	});
}

export function makeClaudeRunnerWire(
	defaultFolder: () => ClaudeLaunchConfig = claudeLaunchConfigFromAccounts,
): RunnerWireCodec {
	return {
		decode(decoded: RunnerMessage): RunnerMessage {
			let message =
				decoded.type === "command" && decoded.command.type === "send-turn"
					? {
							...decoded,
							command: {
								...decoded.command,
								input: normalizeClaudeSessionTurn(
									{
										...decoded.command.input,
										shellConfig:
											decoded.command.input.shellConfig ??
											decoded.command.shellConfig,
									},
									defaultFolder,
								),
							},
						}
					: decoded;
			if (message.type === "command" && message.command.type === "pre-warm") {
				const command = message.command;
				const settingsSnapshot = command.settingsSnapshot
					? {
							...command.settingsSnapshot,
							input: normalizeClaudeSnapshotInput(
								command.settingsSnapshot,
								defaultFolder,
							),
						}
					: undefined;
				message = {
					...message,
					command: {
						...command,
						input: normalizeClaudeLaunchInput(command.input, () =>
							settingsSnapshot
								? {
										configDir: settingsSnapshot.input.configDir,
										folderSource: settingsSnapshot.input.folderSource,
									}
								: defaultFolder(),
						),
						...(settingsSnapshot ? { settingsSnapshot } : {}),
					},
				};
			}
			const state =
				message.type === "hello"
					? message.upgradeState
					: message.type === "upgrade-state"
						? message.state
						: undefined;
			if (state?.snapshot) {
				const normalized = {
					...state,
					snapshot: {
						...state.snapshot,
						input: normalizeClaudeSnapshotInput(state.snapshot, defaultFolder),
					},
				};
				if (message.type === "hello")
					message = { ...message, upgradeState: normalized };
				else if (message.type === "upgrade-state")
					message = { ...message, state: normalized };
			}

			return message;
		},
		encode(message: RunnerMessage, taggedConfigDir: boolean): string {
			let frame =
				message.type === "command" && message.command.type === "send-turn"
					? {
							...message,
							command: {
								...message.command,
								input: {
									...message.command.input,
									turnId: message.command.input.inputId,
									userMessageId:
										message.command.input.continuation?.cutOffMessageId ??
										message.command.input.inputId,
									commandId: message.commandId,
								},
							},
						}
					: message;
			if (
				!taggedConfigDir &&
				frame.type === "command" &&
				(frame.command.type === "send-turn" ||
					frame.command.type === "pre-warm") &&
				frame.command.input.configDir?._tag === "SdkDefault"
			) {
				// Older runners apply the shell env before launching on their default login.
				frame = {
					...frame,
					command: {
						...frame.command,
						shellEnv: makeClaudeSdkEnv({
							configDir: frame.command.input.configDir,
							baseEnv: frame.command.shellEnv,
						}),
					},
				};
			}
			return `${JSON.stringify(
				frame,
				function (this: unknown, key: string, value: unknown) {
					if (
						!taggedConfigDir &&
						key === "nativeThread" &&
						isRecord(value) &&
						isRecord(this) &&
						isRecord(this["configDir"]) &&
						this["configDir"]["_tag"] === "SdkDefault"
					) {
						// Old queries fall back to the native folder when input has none.
						return { ...value, configDir: undefined };
					}
					if (
						key !== "configDir" ||
						!isRecord(value) ||
						(value["_tag"] !== "Configured" && value["_tag"] !== "SdkDefault")
					)
						return value;
					const configDir = Schema.decodeUnknownSync(ClaudeConfigDirSchema)(
						value,
					);
					// Only new runners use this hello metadata; old runners ignore it.
					if (
						taggedConfigDir ||
						(frame.type === "hello" &&
							this === frame.config?.claudeLaunchConfig)
					)
						return configDir;
					if (configDir._tag === "Configured") return configDir.path;
					return undefined;
				},
			)}\n`;
		},
	};
}
