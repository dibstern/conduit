import {
	Context,
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Stream,
} from "effect";
import { hashPin } from "../../../auth.js";
import { AccountChangeRejected } from "../../../contracts/account.js";
import {
	getProviderDriver,
	PROVIDER_DRIVERS,
	PROVIDER_SESSION_CAPABILITIES,
} from "../../../contracts/provider-instance.js";
import { WorkspaceMoveError } from "../../../contracts/session-workspace.js";
import {
	ProjectSaveRejected,
	SetPinRejected,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import {
	loadRecentProjects,
	syncRecentProjects,
} from "../../../daemon/config-persistence.js";
import { getRecent } from "../../../daemon/recent-projects.js";
import { formatErrorDetail } from "../../../errors.js";
import { getLogLevel } from "../../../logger.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import { makeCursorAuth } from "../../../provider/cursor/cursor-auth.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../relay/relay-settings.js";
import {
	getRestartAvailable,
	isServerSupervised,
	SERVER_BUILD_ID,
} from "../../../server/build-update.js";
import {
	BrowserRpcConnectionsTag,
	type DaemonRpcHandlers,
	RpcCaller,
	RpcPinChangeResponse,
	wsRpcHandlers,
} from "../../../server/ws-rpc.js";
import { WS_PROTOCOL_VERSION } from "../../../shared-types.js";
import { getVersion } from "../../../version.js";
import { findFolders } from "../../relay/Services/directory-listing-service.js";
import { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";
import { readSurfacingFeedback } from "../../relay/Services/surfacing-feedback.js";
import { AuthManagerTag } from "../../server/Layers/auth-middleware.js";
import type { AccountDirectory } from "../Services/account-directory.js";
import { CategorySet } from "../Services/category-set.js";
import {
	type ConfigPersistenceTag,
	requestConfigSave,
} from "../Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";
import { DaemonHandleTag } from "../Services/daemon-handle.js";
import { DaemonEvent, DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	findOpenCodeSession,
	listDaemonSessions,
	resolveDaemonOpenCodeSession,
	resolveDaemonSession,
} from "../Services/daemon-session-reader.js";
import { DaemonStateTag } from "../Services/daemon-state.js";
import type { InstanceHealthCheckTag } from "../Services/instance-health-service.js";
import {
	addInstance,
	applyAccountChange,
	discoverInstances,
	getInstance,
	getInstances,
	type InstanceManagerStateTag,
	type PollerFibersTag,
	persistConfig,
	removeInstance,
	requestManagedOpenCodeShutdown,
	updateInstance,
} from "../Services/instance-manager-service.js";
import {
	isSurfacingLoopback,
	MessageSurfacingSettings,
} from "../Services/message-surfacing-settings.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import { persistenceStoreContext } from "../Services/project-read-database.js";
import {
	allProjects,
	broadcastProjectList,
	type ProjectRegistryTag,
	type ProjectSaveLockTag,
	projectInfos,
	removeProjectFromEffectRegistry,
	resolveSessionMode,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";
import { SessionActivityTag } from "../Services/session-activity.js";
import type { SessionDirectory } from "../Services/session-directory.js";
import { Usage } from "../Services/usage.js";
import { KeepAwakeTag } from "./keep-awake-layer.js";
import { PortScannerTag } from "./port-scanner-layer.js";
import {
	applyTailscaleServe,
	isTailscaleServeAvailable,
	type TailscaleCliTag,
} from "./tailscale-serve-layer.js";

export class DaemonWsRpcHandlersTag extends Context.Tag("DaemonWsRpcHandlers")<
	DaemonWsRpcHandlersTag,
	DaemonRpcHandlers
>() {}

export const DaemonWsRpcHandlersLive = Layer.scoped(
	DaemonWsRpcHandlersTag,
	Effect.gen(function* () {
		const { configDir } = yield* Ref.get(yield* DaemonStateTag);
		const baseContext = yield* Effect.context<
			| ProjectRegistryTag
			| SessionDirectory
			| PersistenceStore
			| ProjectSaveLockTag
			| DaemonConfigRefTag
			| DaemonEventBusTag
			| ConfigPersistenceTag
			| RelayCacheTag
			| AccountDirectory
			| InstanceManagerStateTag
			| PollerFibersTag
			| InstanceHealthCheckTag
			| PortScannerTag
			| DaemonHandleTag
			| DaemonStateTag
			| KeepAwakeTag
			| TailscaleCliTag
		>();
		const activity = yield* SessionActivityTag;
		const context = Context.add(baseContext, SessionActivityTag, activity).pipe(
			Context.merge(yield* persistenceStoreContext),
		);
		const bus = yield* DaemonEventBusTag;
		const cache = yield* RelayCacheTag;
		const handle = yield* DaemonHandleTag;
		const openCodeInstances = yield* OpenCodeInstancesTag;
		const usage = yield* Usage;
		const messageSurfacing = yield* MessageSurfacingSettings;
		const categorySet = yield* CategorySet;
		// Serialize process changes together with their config/persistence updates.
		const keepAwakeLock = yield* Effect.makeSemaphore(1);
		const tailscaleServeLock = yield* Effect.makeSemaphore(1);
		const auth = yield* AuthManagerTag;
		const browserConnections = yield* BrowserRpcConnectionsTag;
		const invalidateBrowsers = () => {
			for (const invalidate of browserConnections) invalidate();
		};
		// Every open SubscribeInstances / SubscribeProjects stream, across all
		// connections and projects (conduit-test-ni8.14). A change wakes each
		// one following that list; it re-reads the list itself.
		const listSubscribers = new Set<{
			readonly list: "instances" | "projects" | "serverStatus";
			readonly changed: Queue.Queue<void>;
		}>();
		// Moves when the cross-project session lists went stale; a tab refetches
		// them when it sees a new value (conduit-test-ni8.16.2).
		let sessionsRevision = 0;
		const subscription = yield* PubSub.subscribe(bus);
		yield* Stream.fromQueue(subscription).pipe(
			Stream.runForEach((event) => {
				if (event._tag === "GlobalSettingChanged")
					return Effect.gen(function* () {
						for (const project of yield* allProjects) {
							if (project.slug === event.originSlug) continue;
							const relay = yield* cache.peek(project.slug);
							if (Option.isSome(relay))
								yield* relay.value.syncGlobalSetting(event.tag);
						}
					}).pipe(Effect.provide(context));
				if (event._tag === "DaemonSessionsChanged") sessionsRevision++;
				const list =
					event._tag === "RestartAvailabilityChanged" ||
					event._tag === "DaemonSessionsChanged"
						? "serverStatus"
						: event._tag === "ProjectsChanged"
							? "projects"
							: event._tag === "InstancesChanged" ||
									event._tag === "InstanceStatusChanged"
								? "instances"
								: undefined;
				if (list !== undefined)
					return Effect.sync(() => {
						for (const subscriber of listSubscribers)
							if (subscriber.list === list)
								Queue.unsafeOffer(subscriber.changed, undefined);
					});
				return Effect.void;
			}),
			Effect.forkScoped,
		);
		const run = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				| ProjectRegistryTag
				| SessionDirectory
				| PersistenceStore
				| ProjectSaveLockTag
				| DaemonConfigRefTag
				| DaemonEventBusTag
				| SessionActivityTag
				| ConfigPersistenceTag
				| RelayCacheTag
				| AccountDirectory
				| InstanceManagerStateTag
				| PollerFibersTag
				| InstanceHealthCheckTag
				| PortScannerTag
				| DaemonHandleTag
				| DaemonStateTag
				| KeepAwakeTag
				| TailscaleCliTag
			>,
		) =>
			effect.pipe(
				Effect.provide(context),
				Effect.mapError((error) =>
					error instanceof WsRpcError
						? error
						: new WsRpcError({
								message: formatErrorDetail(error),
							}),
				),
			);

		const mutate = <A, E>(
			id: string,
			effect: Effect.Effect<
				A,
				E,
				| AccountDirectory
				| InstanceManagerStateTag
				| PollerFibersTag
				| ConfigPersistenceTag
				| DaemonEventBusTag
				| SessionActivityTag
			>,
		) =>
			effect.pipe(
				Effect.provide(context),
				Effect.mapError((error) =>
					error instanceof AccountChangeRejected
						? error
						: new AccountChangeRejected({
								id,
								reason: formatErrorDetail(error),
							}),
				),
			);

		const projectList = broadcastProjectList;
		// The project every client's new session prefills: the last one added
		// or given a session. Persisted, and sent out with the project list.
		const rememberNewSessionProject = (slug: string) =>
			Effect.gen(function* () {
				const config = yield* DaemonConfigRefTag;
				if ((yield* Ref.get(config)).newSessionProject === slug) return;
				yield* commitDaemonRuntimeConfig((current) => ({
					...current,
					newSessionProject: slug,
				}));
				yield* PubSub.publish(bus, DaemonEvent.ProjectsChanged());
				yield* requestConfigSave;
			});
		const instanceList = Effect.gen(function* () {
			yield* PubSub.publish(bus, DaemonEvent.InstancesChanged());
			return Array.from(yield* discoverInstances);
		});
		const cursorAuth = yield* makeCursorAuth((authenticated) =>
			run(
				Effect.gen(function* () {
					if (
						authenticated &&
						!(yield* getInstances).some(
							(instance) => instance.driver === "cursor",
						)
					) {
						yield* addInstance({ name: "Cursor", driver: "cursor" });
						yield* persistConfig;
					}
					yield* PubSub.publish(bus, DaemonEvent.InstancesChanged());
				}),
			),
		);
		// Join the subscriber set BEFORE the first read, so a change landing
		// between the two still wakes this stream: snapshot, then a fresh list
		// per change.
		const followList = <A, E>(
			list: "instances" | "projects" | "serverStatus",
			read: Effect.Effect<
				A,
				E,
				| AccountDirectory
				| InstanceManagerStateTag
				| ProjectRegistryTag
				| SessionDirectory
				| PersistenceStore
				| DaemonConfigRefTag
			>,
		) =>
			Stream.unwrapScoped(
				Effect.gen(function* () {
					const subscriber = { list, changed: yield* Queue.sliding<void>(1) };
					yield* Effect.acquireRelease(
						Effect.sync(() => listSubscribers.add(subscriber)),
						() => Effect.sync(() => listSubscribers.delete(subscriber)),
					);
					return Stream.concat(
						Stream.succeed(undefined),
						Stream.fromQueue(subscriber.changed),
					).pipe(Stream.mapEffect(() => run(read)));
				}),
			);

		return {
			SubscribeInstances: () =>
				followList(
					"instances",
					Effect.map(discoverInstances, (instances) => ({
						instances: Array.from(instances),
						providerCapabilities: PROVIDER_SESSION_CAPABILITIES,
						providerTraits: PROVIDER_DRIVERS,
					})),
				),
			SubscribeUsage: () =>
				usage.readings.pipe(Stream.map((readings) => ({ readings }))),
			SubscribeProjects: () =>
				followList(
					"projects",
					Effect.gen(function* () {
						const projects = yield* projectInfos;
						const { newSessionProject } = yield* Ref.get(
							yield* DaemonConfigRefTag,
						);
						return {
							projects,
							...(newSessionProject !== undefined && { newSessionProject }),
						};
					}),
				),
			sessionCreated: (projectSlug) =>
				run(rememberNewSessionProject(projectSlug)).pipe(
					Effect.catchAll((error) =>
						Effect.logWarning(
							`Could not remember the new-session project: ${error.message}`,
						),
					),
				),
			SubscribeServerStatus: () =>
				followList(
					"serverStatus",
					Effect.sync(() => ({
						protocolVersion: WS_PROTOCOL_VERSION,
						buildId: SERVER_BUILD_ID,
						restartAvailable: getRestartAvailable(),
						sessionsRevision,
					})),
				),
			GetStatus: () =>
				run(
					Effect.gen(function* () {
						const { ok: _ok, ...status } = yield* handle.getStatus();
						const config = yield* Ref.get(yield* DaemonConfigRefTag);
						const tailscaleServeAvailable = yield* isTailscaleServeAvailable;
						return {
							...status,
							tailscaleServeEnabled: config.tailscaleServeEnabled ?? false,
							tailscaleServeAvailable,
							// Each browser follows one status feed, even with no project.
							// Counting feeds excludes CLI IPC and the second browser socket.
							clientCount: Array.from(listSubscribers).filter(
								({ list }) => list === "serverStatus",
							).length,
							version: getVersion(),
							logLevel: getLogLevel(),
							supervised: isServerSupervised(),
						};
					}),
				),
			SetPin: (request) =>
				Effect.gen(function* () {
					// Read at call time, outside the saved daemon service context.
					const caller = yield* RpcCaller;
					const afterResponse =
						yield* Effect.serviceOption(RpcPinChangeResponse);
					const currentPinHash = yield* auth.getPinHash();
					if (caller.kind === "browser" && currentPinHash !== null) {
						const result = yield* auth.authenticate(
							request.currentPin ?? "",
							caller.ip,
						);
						if (result.locked) {
							return yield* new SetPinRejected({
								reason: "locked_out",
								...(result.retryAfter !== undefined && {
									retryAfterSeconds: result.retryAfter,
								}),
							});
						}
						if (!result.ok)
							return yield* new SetPinRejected({ reason: "wrong_pin" });
					}
					return yield* run(
						Effect.gen(function* () {
							const state = yield* DaemonStateTag;
							const pinHash =
								request.pin === null ? null : hashPin(request.pin);
							yield* commitDaemonRuntimeConfig((config) => ({
								...config,
								pinHash,
							}));
							yield* Ref.update(state, (current) => ({ ...current, pinHash }));
							if (pinHash !== currentPinHash) {
								yield* Effect.sync(() => {
									if (caller.kind === "browser" && Option.isSome(afterResponse))
										afterResponse.value(invalidateBrowsers);
									else invalidateBrowsers();
								});
							}
							yield* requestConfigSave;
							return { ok: true as const };
						}),
					).pipe(Effect.uninterruptible);
				}),
			SetKeepAwake: (request) =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
						const keepAwake = yield* KeepAwakeTag;
						yield* request.enabled
							? keepAwake.activate()
							: keepAwake.deactivate();
						const supported = yield* keepAwake.isSupported();
						const active = yield* keepAwake.isActive();
						yield* Ref.update(state, (current) => ({
							...current,
							keepAwake: request.enabled,
						}));
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							keepAwake: request.enabled,
						}));
						yield* requestConfigSave;
						return { ok: true as const, supported, active };
					}).pipe(Effect.uninterruptible, keepAwakeLock.withPermits(1)),
				),
			SetTailscaleServe: (request) =>
				run(
					Effect.gen(function* () {
						yield* applyTailscaleServe(request.enabled);
						yield* requestConfigSave;
						return { ok: true as const };
					}).pipe(Effect.uninterruptible, tailscaleServeLock.withPermits(1)),
				),
			SetKeepAwakeCommand: (request) =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
						const keepAwake = yield* KeepAwakeTag;
						yield* keepAwake.setCommand(request.command, request.args);
						const updates = {
							keepAwakeCommand: request.command,
							keepAwakeArgs: [...request.args],
						};
						yield* Ref.update(state, (current) => ({ ...current, ...updates }));
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							...updates,
						}));
						yield* requestConfigSave;
						return { ok: true as const };
					}).pipe(Effect.uninterruptible, keepAwakeLock.withPermits(1)),
				),
			Shutdown: () =>
				run(
					Effect.gen(function* () {
						yield* requestManagedOpenCodeShutdown;
						const state = yield* DaemonStateTag;
						yield* Ref.update(state, (current) => ({
							...current,
							shuttingDown: true,
						}));
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							shuttingDown: true,
						}));
						return { ok: true as const };
					}),
				),
			SetAgent: (request) =>
				run(
					Effect.gen(function* () {
						const relay = yield* cache.get(request.slug);
						const setDefaultAgent = relay.setDefaultAgent;
						if (setDefaultAgent === undefined) {
							return yield* new WsRpcError({
								message: `Relay "${request.slug}" does not support default agent updates`,
							});
						}
						yield* setDefaultAgent(request.agent);
						return { ok: true as const };
					}),
				),
			RestartWithConfig: () =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
						yield* Ref.update(state, (current) => ({
							...current,
							shuttingDown: true,
						}));
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							shuttingDown: true,
						}));
						yield* requestConfigSave;
						return { ok: true as const };
					}),
				),
			GetInstances: () =>
				run(
					discoverInstances.pipe(
						Effect.map((instances) => ({
							instances: Array.from(instances),
							providerCapabilities: PROVIDER_SESSION_CAPABILITIES,
							providerTraits: PROVIDER_DRIVERS,
						})),
					),
				),
			GetCursorAuth: () => cursorAuth.read,
			StartCursorLogin: () => cursorAuth.start,
			CancelCursorLogin: () => cursorAuth.cancel,
			LogoutCursor: () => cursorAuth.logout,
			GetInstanceStatus: (request) =>
				run(
					getInstance(request.instanceId).pipe(
						Effect.map((instance) => ({ instance })),
					),
				),
			GetProjects: (request) =>
				run(
					projectInfos.pipe(
						Effect.map((projects) => ({
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects,
						})),
					),
				),
			ResolveSessionMode: ({ projectSlug }) =>
				run(resolveSessionMode(projectSlug)),
			SaveProject: (request) =>
				Effect.gen(function* () {
					const { kind, project, warnings } = yield* handle.saveProject({
						folders: request.folders,
						...(request.slug !== undefined && { slug: request.slug }),
						...(request.title !== undefined && { title: request.title }),
						...(request.setupScript !== undefined && {
							setupScript: request.setupScript,
						}),
						...(request.sessionMode !== undefined && {
							sessionMode: request.sessionMode,
						}),
						...(request.groupingMode !== undefined && {
							groupingMode: request.groupingMode,
						}),
					});
					// Saving without a slug adds a project; its first session goes there.
					if (request.slug === undefined && kind !== "existing")
						yield* rememberNewSessionProject(project.slug);
					const projects = yield* projectList;
					return {
						kind,
						projectSlug: request.projectSlug,
						...(request.projectSlug ? { current: request.projectSlug } : {}),
						projects,
						savedSlug: project.slug,
						warnings,
					};
				}).pipe(
					Effect.provide(context),
					Effect.mapError((error) =>
						error instanceof ProjectSaveRejected || error instanceof WsRpcError
							? error
							: new WsRpcError({ message: formatErrorDetail(error) }),
					),
				),
			RemoveProject: (request) =>
				run(
					Effect.gen(function* () {
						const removed = (yield* allProjects).find(
							(project) => project.slug === request.slug,
						);
						yield* removeProjectFromEffectRegistry(request.slug);
						// Removed folders feed the dialog's "recent" suggestions. Reversed
						// so the main folder ends up first; a failed write must not fail
						// the removal.
						if (removed)
							yield* Effect.try(() =>
								syncRecentProjects(
									[...removed.folders].reverse().map((folder) => ({
										path: folder,
										slug: removed.slug,
										...(removed.title ? { title: removed.title } : {}),
									})),
									configDir,
								),
							).pipe(Effect.ignore);
						return {
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects: yield* projectList,
						};
					}),
				),
			StartInstance: (request) =>
				run(
					Effect.gen(function* () {
						const instance = yield* getInstance(request.instanceId);
						if (
							getProviderDriver(instance.driver ?? "opencode")
								?.runsOpenCodeServer
						)
							yield* Effect.scoped(openCodeInstances.use(request.instanceId));
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			StopInstance: (request) =>
				run(
					Effect.gen(function* () {
						const instance = yield* getInstance(request.instanceId);
						if (
							getProviderDriver(instance.driver ?? "opencode")
								?.runsOpenCodeServer
						)
							yield* openCodeInstances.stop(request.instanceId);
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			RemoveInstance: (request) =>
				mutate(
					request.instanceId,
					Effect.gen(function* () {
						yield* removeInstance(request.instanceId);
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			RenameInstance: (request) =>
				mutate(
					request.instanceId,
					Effect.gen(function* () {
						yield* updateInstance(request.instanceId, { name: request.name });
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			AddInstance: (request) =>
				mutate(
					request.name,
					Effect.gen(function* () {
						const instance = yield* addInstance(request);
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
							addedInstanceId: instance.id,
						};
					}),
				),
			UpdateInstance: (request) =>
				mutate(
					request.instanceId,
					Effect.gen(function* () {
						yield* updateInstance(request.instanceId, request);
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			SetDefault: (request) =>
				mutate(
					request.instanceId,
					Effect.gen(function* () {
						yield* applyAccountChange({
							_tag: "SetDefault",
							id: request.instanceId,
						});
						yield* persistConfig;
						return { instances: yield* instanceList };
					}),
				),
			GetAutoSettleSetting: (request) =>
				run(wsRpcHandlers.GetAutoSettleSetting(request)),
			GetMessageSurfacing: () => messageSurfacing.get,
			UpdateMessageSurfacing: (request) =>
				Effect.gen(function* () {
					if (request.apiKey !== undefined) {
						const caller = yield* RpcCaller;
						if (
							caller.kind === "browser" &&
							!caller.secure &&
							!isSurfacingLoopback(caller.ip)
						) {
							return yield* new WsRpcError({
								message: "Saving a TypeSafe key requires TLS or loopback",
							});
						}
					}
					return yield* messageSurfacing
						.update(request)
						.pipe(
							Effect.mapError(
								(error) => new WsRpcError({ message: error.message }),
							),
						);
				}),
			SetAutoSettleSetting: (request) =>
				run(wsRpcHandlers.SetAutoSettleSetting(request)),
			GetWorktreeCleanupSetting: (request) =>
				run(wsRpcHandlers.GetWorktreeCleanupSetting(request)),
			SetWorktreeCleanupSetting: (request) =>
				run(wsRpcHandlers.SetWorktreeCleanupSetting(request)),
			CleanUpWorktreesNow: (request) =>
				run(wsRpcHandlers.CleanUpWorktreesNow(request)),
			GetDefaultGroupingMode: (_request) =>
				run(
					Effect.sync(() => ({
						mode:
							loadRelaySettings(configDir).defaultGroupingMode ?? "repository",
					})),
				),
			GetCategorySet: () => categorySet.current(),
			GetSurfacingFeedback: () =>
				run(
					Effect.flatMap(PersistenceStore, (store) =>
						readSurfacingFeedback().pipe(Effect.provide(store)),
					),
				),
			ReplaceCategorySet: ({ expectedVersion, nextSet }) =>
				categorySet.replace(expectedVersion, nextSet),
			SetDefaultGroupingMode: ({ mode }) =>
				run(
					Effect.gen(function* () {
						yield* Effect.try(() =>
							saveRelaySettings({ defaultGroupingMode: mode }, configDir),
						);
						yield* PubSub.publish(
							bus,
							DaemonEvent.GlobalSettingChanged({
								originSlug: "",
								tag: "defaultGroupingMode",
							}),
						);
						yield* PubSub.publish(bus, DaemonEvent.ProjectsChanged());
						return { mode };
					}),
				),
			GetUsageLimitsSetting: (request) =>
				run(wsRpcHandlers.GetUsageLimitsSetting(request)),
			SetUsageLimitsSetting: (request) =>
				run(wsRpcHandlers.SetUsageLimitsSetting(request)),
			SetCursorUsageKeychain: (request) =>
				run(
					wsRpcHandlers
						.SetCursorUsageKeychain(request)
						.pipe(Effect.provideService(Usage, usage)),
				),
			ScanNow: (request) =>
				run(
					Effect.gen(function* () {
						const scanner = yield* PortScannerTag;
						return {
							projectSlug: request.projectSlug,
							...(yield* scanner.scanNow()),
						};
					}),
				),
			ListDaemonSessions: (request) =>
				run(
					listDaemonSessions(configDir, {
						...(request.limit !== undefined ? { limit: request.limit } : {}),
						...(request.roots !== undefined ? { roots: request.roots } : {}),
						...(request.search !== undefined ? { search: request.search } : {}),
						...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
						...(request.scope !== undefined ? { scope: request.scope } : {}),
						...(request.exclude !== undefined
							? { exclude: request.exclude }
							: {}),
					}).pipe(
						Effect.map((result) => ({
							projectSlug: request.projectSlug,
							...result,
						})),
					),
				),
			ResolveSession: (request) =>
				run(
					resolveDaemonSession(request.sessionId).pipe(
						Effect.mapError(
							(error) =>
								new WsRpcError({
									message: error.message,
								}),
						),
						Effect.flatMap((projectSlug) =>
							projectSlug === null
								? Effect.fail(
										new WsRpcError({
											code: "unknown-session",
											message: `Unknown session: ${request.sessionId}`,
										}),
									)
								: Effect.succeed({ projectSlug }),
						),
					),
				),
			OpenCodeUseWorktree: (request) =>
				Effect.gen(function* () {
					const instance = yield* getInstance(request.instanceId);
					if (
						getProviderDriver(instance.driver)?.worktreeMoves !==
							"server-declaration" ||
						!instance.managed
					)
						return yield* new WsRpcError({
							message:
								"Declared worktree moves require a Conduit-managed OpenCode instance",
						});
					const target = yield* resolveDaemonOpenCodeSession(
						request.instanceId,
						request.providerSessionId,
					);
					if (!target)
						return yield* new WsRpcError({
							message:
								"No Conduit session is bound to this OpenCode session and instance",
						});
					const relay = yield* cache.get(target.projectSlug);
					if (!relay.rpcWsHandler.context)
						return yield* new WsRpcError({
							message: "The project relay has no RPC context",
						});
					const relayContext = yield* relay.rpcWsHandler.context;
					return yield* Effect.gen(function* () {
						const sessionId = yield* findOpenCodeSession(
							{ projectIds: [target.projectSlug] },
							request.instanceId,
							request.providerSessionId,
						);
						if (sessionId !== target.sessionId)
							return yield* new WsRpcError({
								message:
									"The OpenCode session binding changed before the workspace move",
							});
						const workspace = yield* SessionWorkspaceTag;
						return {
							directory: yield* workspace.move(
								target.sessionId,
								request.path,
								"agent",
							),
						};
					}).pipe(Effect.provide(relayContext));
				}).pipe(
					Effect.provide(context),
					Effect.mapError((error) =>
						error instanceof WorkspaceMoveError || error instanceof WsRpcError
							? error
							: new WsRpcError({ message: formatErrorDetail(error) }),
					),
				),
			FindFolders: (request) =>
				Effect.gen(function* () {
					const projects = yield* allProjects;
					return yield* findFolders(
						request.query,
						{
							recent: getRecent(loadRecentProjects(configDir)).map(
								(project) => project.directory,
							),
							projectFolders: projects.flatMap((project) => project.folders),
						},
						configDir,
					);
				}).pipe(
					Effect.provide(context),
					Effect.mapError((error) =>
						error instanceof ProjectSaveRejected
							? error
							: new WsRpcError({ message: formatErrorDetail(error) }),
					),
				),
			DetectProxy: wsRpcHandlers.DetectProxy,
			SetLogLevel: wsRpcHandlers.SetLogLevel,
		} satisfies DaemonRpcHandlers;
	}),
);
