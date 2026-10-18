import { Effect, Option, Ref } from "effect";
import {
	ClaudeSettingsResolveError,
	ClaudeSettingsTrustBoundaryError,
} from "../../contracts/claude-settings.js";
import {
	AccountUnroutable,
	DEFAULT_USAGE_LIMITS,
} from "../../contracts/limit-recovery.js";
import { DEFAULT_WORKTREE_CLEANUP } from "../../contracts/worktree.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { DEFAULT_AUTO_SETTLE_AFTER_DAYS } from "../../daemon/config-persistence.js";
import { ConfigPersistenceTag } from "../../domain/daemon/Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../../domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../../domain/daemon/Services/daemon-pubsub.js";
import {
	getProject,
	ProjectRegistryTag,
	updateProject,
} from "../../domain/daemon/Services/project-registry-service.js";
import {
	cleanUpWorktreesNow,
	requestWorktreeCleanup,
} from "../../domain/daemon/Services/worktree-cleanup-service.js";
import { publishGlobalProjectSetting } from "../../domain/relay/Services/project-settings.js";
import { ConfigTag } from "../../domain/relay/Services/services.js";
import {
	getClaudeSettingsOverrides,
	resolveClaudeSettingsForInstance,
	setClaudeSettingsForRelay,
} from "../../handlers/claude-settings.js";
import { setDefaultPermissionModeForRelay } from "../../handlers/permissions.js";
import { setHiddenEntriesForRelay } from "../../handlers/visibility.js";
import { setLogLevel } from "../../logger.js";
import { saveRelaySettings } from "../../relay/relay-settings.js";
import { mapRpcFailure, type WsRpcHandlerMap } from "./shared.js";

export const settingsHandlers = {
	GetWorktreeCleanupSetting: ({ projectSlug }) =>
		Effect.gen(function* () {
			const config = yield* Ref.get(yield* DaemonConfigRefTag);
			if (projectSlug === undefined)
				return { global: config.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP };
			const registry = yield* Effect.serviceOption(ProjectRegistryTag);
			if (Option.isNone(registry))
				return yield* new WsRpcError({
					message: "Project worktree cleanup settings require the daemon",
				});
			const project = yield* getProject(projectSlug).pipe(
				Effect.provideService(ProjectRegistryTag, registry.value),
			);
			return {
				global: config.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP,
				project: project.worktreeCleanup ?? null,
			};
		}).pipe(Effect.catchAll(mapRpcFailure("GetWorktreeCleanupSetting"))),
	SetWorktreeCleanupSetting: (request) =>
		Effect.gen(function* () {
			if (request.scope === "global") {
				yield* commitDaemonRuntimeConfig((config) => ({
					...config,
					worktreeCleanup: request.rules,
				}));
			} else {
				const registry = yield* Effect.serviceOption(ProjectRegistryTag);
				const bus = yield* Effect.serviceOption(DaemonEventBusTag);
				if (Option.isNone(registry) || Option.isNone(bus))
					return yield* new WsRpcError({
						message: "Project worktree cleanup settings require the daemon",
					});
				yield* updateProject(request.projectSlug, {
					worktreeCleanup: request.override ?? undefined,
				}).pipe(
					Effect.provideService(ProjectRegistryTag, registry.value),
					Effect.provideService(DaemonEventBusTag, bus.value),
				);
			}
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.requestSave;
			yield* persistence.flush;
			yield* requestWorktreeCleanup(
				request.scope === "project" ? request.projectSlug : undefined,
			);
			const config = yield* Ref.get(yield* DaemonConfigRefTag);
			return {
				global: config.worktreeCleanup ?? DEFAULT_WORKTREE_CLEANUP,
				...(request.scope === "project" ? { project: request.override } : {}),
			};
		}).pipe(Effect.catchAll(mapRpcFailure("SetWorktreeCleanupSetting"))),
	CleanUpWorktreesNow: ({ projectSlug }) => cleanUpWorktreesNow(projectSlug),
	GetAutoSettleSetting: (_request) =>
		Effect.gen(function* () {
			const config = yield* Ref.get(yield* DaemonConfigRefTag);
			return {
				autoSettleAfterDays:
					config.autoSettleAfterDays === undefined
						? DEFAULT_AUTO_SETTLE_AFTER_DAYS
						: config.autoSettleAfterDays,
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
			yield* commitDaemonRuntimeConfig((config) => ({
				...config,
				autoSettleAfterDays: days,
			}));
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.requestSave;
			yield* persistence.flush;
			return { autoSettleAfterDays: days };
		}).pipe(Effect.catchAll(mapRpcFailure("SetAutoSettleSetting"))),
	GetUsageLimitsSetting: (_request) =>
		Effect.gen(function* () {
			const config = yield* Ref.get(yield* DaemonConfigRefTag);
			return {
				usageLimits: config.usageLimits ?? DEFAULT_USAGE_LIMITS,
			};
		}),
	SetUsageLimitsSetting: ({ usageLimits }) =>
		Effect.gen(function* () {
			yield* commitDaemonRuntimeConfig((config) => ({
				...config,
				usageLimits,
			}));
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.requestSave;
			yield* persistence.flush;
			return { usageLimits };
		}).pipe(Effect.catchAll(mapRpcFailure("SetUsageLimitsSetting"))),
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
	SetDefaultSessionMode: ({ mode }) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			yield* Effect.try({
				try: () =>
					saveRelaySettings({ defaultSessionMode: mode }, config.configDir),
				catch: (cause) =>
					new WsRpcError({
						message: `SetDefaultSessionMode failed: ${String(cause)}`,
					}),
			});
			yield* publishGlobalProjectSetting("defaultSessionMode");
			return { mode };
		}),
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
		Effect.flatMap(ConfigTag, (config) =>
			resolveClaudeSettingsForInstance(request).pipe(
				Effect.map((resolved) => ({
					projectSlug: config.slug,
					instanceId: request.instanceId,
					resolved,
				})),
				Effect.mapError((error) =>
					error instanceof ClaudeSettingsResolveError ||
					error instanceof AccountUnroutable
						? error
						: new WsRpcError({
								message: `ResolveClaudeSettings failed: ${String(error)}`,
							}),
				),
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
	| "GetWorktreeCleanupSetting"
	| "SetWorktreeCleanupSetting"
	| "CleanUpWorktreesNow"
	| "GetUsageLimitsSetting"
	| "SetUsageLimitsSetting"
	| "SetDefaultPermissionMode"
	| "SetDefaultSessionMode"
	| "SetHiddenEntries"
	| "GetClaudeSettings"
	| "SetClaudeSettings"
	| "ResolveClaudeSettings"
	| "SetLogLevel"
>;
