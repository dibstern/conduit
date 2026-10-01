import { Effect } from "effect";
import {
	ClaudeSettingsResolveError,
	ClaudeSettingsTrustBoundaryError,
} from "../../contracts/claude-settings.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import {
	defaultDaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../daemon/config-persistence.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import {
	getClaudeSettingsOverrides,
	resolveClaudeSettingsForInstance,
	setClaudeSettingsForRelay,
} from "../../handlers/claude-settings.js";
import { setDefaultPermissionModeForRelay } from "../../handlers/permissions.js";
import { setHiddenEntriesForRelay } from "../../handlers/visibility.js";
import { setLogLevel } from "../../logger.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const settingsHandlers = {
	GetAutoSettleSetting: (_request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const persisted = loadDaemonConfig(config.configDir);
			return {
				autoSettleAfterDays:
					persisted?.autoSettleAfterDays === undefined
						? 3
						: persisted.autoSettleAfterDays,
			};
		}),
	SetAutoSettleSetting: (request) =>
		Effect.gen(function* () {
			const days = request.autoSettleAfterDays;
			if (days !== null && (!Number.isInteger(days) || days < 1 || days > 90)) {
				return yield* new WsRpcError({
					message: "Auto-settle days must be an integer from 1 to 90, or Never",
				});
			}
			const config = yield* ConfigTag;
			const persisted =
				loadDaemonConfig(config.configDir) ?? defaultDaemonConfig();
			yield* Effect.tryPromise(() =>
				saveDaemonConfig(
					{ ...persisted, autoSettleAfterDays: days },
					config.configDir,
				),
			);
			return { autoSettleAfterDays: days };
		}).pipe(Effect.catchAll(mapRpcFailure("SetAutoSettleSetting"))),
	SetDefaultPermissionMode: (request) =>
		setDefaultPermissionModeForRelay({
			clientId: request.originId ?? "rpc",
			mode: request.mode,
		}).pipe(
			Effect.map((mode) => ({
				projectSlug: request.projectSlug,
				mode,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetDefaultPermissionMode failed: ${String(error)}`,
					}),
				),
			),
		),
	SetHiddenEntries: (request) =>
		setHiddenEntriesForRelay({
			clientId: request.originId ?? "rpc",
			hiddenModels: request.hiddenModels,
			hiddenAgents: request.hiddenAgents,
		}).pipe(
			Effect.map((entries) => ({
				projectSlug: request.projectSlug,
				hiddenModels: entries.hiddenModels,
				hiddenAgents: entries.hiddenAgents,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetHiddenEntries failed: ${String(error)}`,
					}),
				),
			),
		),
	GetClaudeSettings: (request) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			return {
				projectSlug: request.projectSlug,
				overrides: getClaudeSettingsOverrides(config.configDir),
			};
		}),
	SetClaudeSettings: (request) =>
		setClaudeSettingsForRelay({
			clientId: request.originId ?? "rpc",
			overrides: request.overrides,
		}).pipe(
			Effect.map((overrides) => ({
				projectSlug: request.projectSlug,
				overrides,
			})),
			Effect.mapError((error) =>
				error instanceof ClaudeSettingsTrustBoundaryError
					? error
					: new WsRpcError({
							message: `SetClaudeSettings failed: ${String(error)}`,
						}),
			),
		),
	ResolveClaudeSettings: (request) =>
		resolveClaudeSettingsForInstance({ instanceId: request.instanceId }).pipe(
			Effect.map((resolved) => ({
				projectSlug: request.projectSlug,
				instanceId: request.instanceId,
				resolved,
			})),
			Effect.mapError((error) =>
				error instanceof ClaudeSettingsResolveError
					? error
					: new WsRpcError({
							message: `ResolveClaudeSettings failed: ${String(error)}`,
						}),
			),
		),
	SetLogLevel: (request) =>
		Effect.sync(() => {
			setLogLevel(request.level);
			return { ok: true as const };
		}),
} satisfies Pick<
	WsRpcHandlerMap,
	| "GetAutoSettleSetting"
	| "SetAutoSettleSetting"
	| "SetDefaultPermissionMode"
	| "SetHiddenEntries"
	| "GetClaudeSettings"
	| "SetClaudeSettings"
	| "ResolveClaudeSettings"
	| "SetLogLevel"
>;
