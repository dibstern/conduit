import { Either, Schema } from "effect";
import type { Account } from "../../contracts/account.js";
import {
	loadDaemonConfigResult,
	resolveClaudeLaunchConfig,
} from "../../daemon/config-persistence.js";
import { isRecord } from "../../utils.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import type {
	RunnerMessage,
	RunnerWireCodec,
} from "../runner/runner-protocol.js";
import type { ClaudeRunnerSettingsSnapshot } from "./claude-runner-upgrade.js";
import {
	type ClaudeConfigDir,
	ClaudeConfigDirSchema,
	ClaudeFolderSourceSchema,
	type ClaudeLaunchConfig,
	claudeLoginFromEnv,
	configuredClaudeConfigDir,
	makeClaudeSdkEnv,
} from "./claude-sdk-env.js";
import type { ClaudeSessionTurn } from "./claude-session-runner.js";
/** Missing legacy folders preserve the carried account, then use the default. Explicit blanks are invalid. */
export function normalizeClaudeLaunchInput<
	T extends {
		readonly account?: Account | undefined;
		readonly configDir?: ClaudeConfigDir | string | undefined;
		readonly folderSource?: ClaudeLaunchConfig["folderSource"] | undefined;
	},
>(
	input: T,
	defaultFolder: () => ClaudeLaunchConfig = () =>
		resolveClaudeLaunchConfig(
			Either.getOrElse(loadDaemonConfigResult(), (error) => {
				if (error._tag === "NotFound") return null;
				throw error;
			}),
		),
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
	input: Omit<ClaudeSessionTurn, "inputId" | "configDir" | "folderSource"> & {
		readonly configDir?: ClaudeConfigDir | string | undefined;
		readonly folderSource?: ClaudeLaunchConfig["folderSource"] | undefined;
		readonly inputId?: string;
		readonly userMessageId?: string;
		readonly commandId?: string;
		readonly turnId?: string;
	},
	defaultFolder?: () => ClaudeLaunchConfig,
): ClaudeSessionTurn & ClaudeLaunchConfig {
	const { inputId, userMessageId, commandId, turnId, ...turn } = input;
	const id = inputId ?? userMessageId ?? commandId ?? turnId;
	if (id === undefined)
		throw new ClaudeBoundaryError({
			operation: "decodeRunnerTurn",
			cause: "Claude turn input id is required",
		});
	return { ...normalizeClaudeLaunchInput(turn, defaultFolder), inputId: id };
}

function normalizeClaudeSnapshotInput(
	snapshot: ClaudeRunnerSettingsSnapshot,
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
	defaultFolder: () => ClaudeLaunchConfig = () =>
		resolveClaudeLaunchConfig(
			Either.getOrElse(loadDaemonConfigResult(), (error) => {
				if (error._tag === "NotFound") return null;
				throw error;
			}),
		),
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
									decoded.command.input,
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
					if (taggedConfigDir) return configDir;
					if (configDir._tag === "Configured") return configDir.path;
					return undefined;
				},
			)}\n`;
		},
	};
}
