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
import { DEFAULT_USAGE_LIMITS } from "../../../contracts/limit-recovery.js";
import { ProjectSaveRejected, WsRpcError } from "../../../contracts/ws-rpc.js";
import {
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadRecentProjects,
	syncRecentProjects,
} from "../../../daemon/config-persistence.js";
import { getRecent } from "../../../daemon/recent-projects.js";
import { formatErrorDetail } from "../../../errors.js";
import {
	getRestartAvailable,
	SERVER_BUILD_ID,
} from "../../../server/build-update.js";
import {
	type DaemonRpcHandlers,
	wsRpcHandlers,
} from "../../../server/ws-rpc.js";
import {
	type RelayMessage,
	WS_PROTOCOL_VERSION,
} from "../../../shared-types.js";
import { findFolders } from "../../relay/Services/directory-listing-service.js";
import { makeInstanceId } from "../../relay/Services/instance-management-service.js";
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
	listDaemonSessions,
	resolveDaemonSession,
} from "../Services/daemon-session-reader.js";
import { DaemonStateTag } from "../Services/daemon-state.js";
import { DaemonWsClientRegistryTag } from "../Services/daemon-ws-client-registry.js";
import type { InstanceHealthCheckTag } from "../Services/instance-health-service.js";
import {
	addInstance,
	getInstance,
	getInstances,
	type InstanceManagerStateTag,
	type PollerFibersTag,
	persistConfig,
	removeInstance,
	requestManagedOpenCodeShutdown,
	updateInstance,
} from "../Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../Services/opencode-instances-service.js";
import {
	allProjects,
	broadcastProjectList,
	type ProjectRegistryTag,
	type ProjectSaveLockTag,
	projectInfos,
	removeProjectFromEffectRegistry,
	replaceRelay,
	updateProject,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";
import { KeepAwakeTag } from "./keep-awake-layer.js";
import { PortScannerTag } from "./port-scanner-layer.js";

export class DaemonWsRpcHandlersTag extends Context.Tag("DaemonWsRpcHandlers")<
	DaemonWsRpcHandlersTag,
	DaemonRpcHandlers
>() {}

export const DaemonWsRpcHandlersLive = Layer.scoped(
	DaemonWsRpcHandlersTag,
	Effect.gen(function* () {
		const { configDir } = yield* Ref.get(yield* DaemonStateTag);
		const context = yield* Effect.context<
			| ProjectRegistryTag
			| ProjectSaveLockTag
			| DaemonConfigRefTag
			| DaemonEventBusTag
			| DaemonWsClientRegistryTag
			| ConfigPersistenceTag
			| RelayCacheTag
			| InstanceManagerStateTag
			| PollerFibersTag
			| InstanceHealthCheckTag
			| PortScannerTag
			| DaemonHandleTag
			| DaemonStateTag
			| KeepAwakeTag
		>();
		const bus = yield* DaemonEventBusTag;
		const daemonWsClients = yield* DaemonWsClientRegistryTag;
		const cache = yield* RelayCacheTag;
		const handle = yield* DaemonHandleTag;
		const openCodeInstances = yield* OpenCodeInstancesTag;
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
				return event._tag === "RelayBroadcast"
					? Effect.gen(function* () {
							yield* daemonWsClients.broadcastUnattached(
								event.message as RelayMessage,
							);
							for (const project of yield* allProjects) {
								const relay = yield* cache.peek(project.slug);
								if (Option.isSome(relay)) {
									relay.value.wsHandler.broadcast?.(
										event.message as RelayMessage,
									);
								}
							}
						}).pipe(Effect.provide(context))
					: Effect.void;
			}),
			Effect.forkScoped,
		);
		const run = <A, E>(
			effect: Effect.Effect<
				A,
				E,
				| ProjectRegistryTag
				| ProjectSaveLockTag
				| DaemonConfigRefTag
				| DaemonEventBusTag
				| DaemonWsClientRegistryTag
				| ConfigPersistenceTag
				| RelayCacheTag
				| InstanceManagerStateTag
				| PollerFibersTag
				| InstanceHealthCheckTag
				| PortScannerTag
				| DaemonHandleTag
				| DaemonStateTag
				| KeepAwakeTag
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

		const projectList = broadcastProjectList;
		const instanceList = Effect.gen(function* () {
			yield* PubSub.publish(bus, DaemonEvent.InstancesChanged());
			return Array.from(yield* getInstances);
		});
		// Join the subscriber set BEFORE the first read, so a change landing
		// between the two still wakes this stream: snapshot, then a fresh list
		// per change.
		const followList = <A, E>(
			list: "instances" | "projects" | "serverStatus",
			read: Effect.Effect<A, E, InstanceManagerStateTag | ProjectRegistryTag>,
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
					Effect.map(getInstances, (instances) => ({
						instances: Array.from(instances),
					})),
				),
			SubscribeProjects: () =>
				followList(
					"projects",
					Effect.map(projectInfos, (projects) => ({ projects })),
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
						return status;
					}),
				),
			SetPin: (request) =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
						const pinHash = request.pin === null ? null : hashPin(request.pin);
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							pinHash,
						}));
						yield* Ref.update(state, (current) => ({ ...current, pinHash }));
						yield* requestConfigSave;
						return { ok: true as const };
					}),
				),
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
					}),
				),
			SetKeepAwakeCommand: (request) =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
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
					}),
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
						yield* Effect.tryPromise({
							try: () => setDefaultAgent(request.agent),
							catch: (cause) =>
								new WsRpcError({ message: formatErrorDetail(cause) }),
						});
						return { ok: true as const };
					}),
				),
			RestartWithConfig: (request) =>
				run(
					Effect.gen(function* () {
						const state = yield* DaemonStateTag;
						const update = request.config;
						const tls =
							typeof update?.["tls"] === "boolean" ? update["tls"] : undefined;
						const updates = {
							shuttingDown: true,
							...(typeof update?.["port"] === "number"
								? { port: update["port"] }
								: {}),
							...(typeof update?.["pinHash"] === "string" ||
							update?.["pinHash"] === null
								? { pinHash: update["pinHash"] }
								: {}),
							...(typeof update?.["keepAwake"] === "boolean"
								? { keepAwake: update["keepAwake"] }
								: {}),
							...(typeof update?.["keepAwakeCommand"] === "string"
								? { keepAwakeCommand: update["keepAwakeCommand"] }
								: {}),
							...(Array.isArray(update?.["keepAwakeArgs"]) &&
							update["keepAwakeArgs"].every((arg) => typeof arg === "string")
								? { keepAwakeArgs: [...update["keepAwakeArgs"]] }
								: {}),
						};
						yield* Ref.update(state, (current) => ({
							...current,
							...updates,
							...(tls !== undefined && { tls }),
						}));
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							...updates,
							...(tls !== undefined && { tlsEnabled: tls }),
						}));
						yield* requestConfigSave;
						return { ok: true as const };
					}),
				),
			GetInstances: () =>
				run(
					getInstances.pipe(
						Effect.map((instances) => ({ instances: Array.from(instances) })),
					),
				),
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
			SaveProject: (request) =>
				Effect.gen(function* () {
					const { project, warnings } = yield* handle.saveProject({
						folders: request.folders,
						...(request.slug !== undefined && { slug: request.slug }),
						...(request.title !== undefined && { title: request.title }),
						...(request.instanceId !== undefined && {
							instanceId: request.instanceId,
						}),
					});
					const projects = yield* projectList;
					return {
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
			SetProjectInstance: (request) =>
				run(
					Effect.gen(function* () {
						yield* updateProject(request.slug, {
							instanceId: request.instanceId,
						});
						yield* replaceRelay(request.slug);
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
						// Claude instances have no process to start.
						if (instance.driver !== "claude")
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
						yield* getInstance(request.instanceId);
						yield* openCodeInstances.stop(request.instanceId);
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			RemoveInstance: (request) =>
				run(
					Effect.gen(function* () {
						yield* getInstance(request.instanceId);
						yield* removeInstance(request.instanceId);
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			RenameInstance: (request) =>
				run(
					Effect.gen(function* () {
						const name = request.name.trim();
						if (!name)
							return yield* new WsRpcError({
								message: "RenameInstance failed: name is required",
							});
						yield* getInstance(request.instanceId);
						yield* updateInstance(request.instanceId, { name });
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			AddInstance: (request) =>
				run(
					Effect.gen(function* () {
						const name = request.name.trim();
						if (!name)
							return yield* new WsRpcError({
								message: "AddInstance failed: name is required",
							});
						const driver = request.driver ?? "opencode";
						const url = request.url;
						const managed =
							request.managed ?? (driver !== "claude" && url === undefined);
						if (driver === "claude") {
							if (managed)
								return yield* new WsRpcError({
									message: "InstanceAdd: Claude instances must not be managed",
								});
							if (request.port !== undefined)
								return yield* new WsRpcError({
									message:
										"InstanceAdd: Claude instances must not include 'port'",
								});
							if (url !== undefined)
								return yield* new WsRpcError({
									message:
										"InstanceAdd: Claude instances must not include 'url'",
								});
						} else {
							const validPort =
								request.port !== undefined &&
								Number.isInteger(request.port) &&
								request.port >= 1 &&
								request.port <= 65535;
							if (request.port !== undefined && !validPort)
								return yield* new WsRpcError({
									message: "InstanceAdd requires a valid 'port' (1-65535)",
								});
							if (managed) {
								if (!validPort)
									return yield* new WsRpcError({
										message:
											"InstanceAdd requires a valid 'port' (1-65535) for managed instances",
									});
								if (url !== undefined)
									return yield* new WsRpcError({
										message:
											"InstanceAdd: 'url' is only valid for unmanaged instances (managed: false)",
									});
							} else if (url === undefined && !validPort) {
								return yield* new WsRpcError({
									message:
										"InstanceAdd: unmanaged instances require either a 'url' or a valid 'port'",
								});
							}
							if (url !== undefined) {
								yield* Effect.try({
									try: () => new URL(url),
									catch: () =>
										new WsRpcError({
											message:
												"InstanceAdd: 'url' must be a valid URL (e.g. http://host:4096)",
										}),
								});
							}
						}
						const id = makeInstanceId(name, Array.from(yield* getInstances));
						yield* addInstance({
							id,
							name,
							port: request.port ?? 0,
							managed,
							...(url !== undefined ? { url } : {}),
							...(request.env !== undefined ? { env: { ...request.env } } : {}),
							...(request.driver !== undefined
								? { driver: request.driver }
								: {}),
							...(request.configDir !== undefined
								? { configDir: request.configDir }
								: {}),
						});
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
							addedInstanceId: id,
						};
					}),
				),
			UpdateInstance: (request) =>
				run(
					Effect.gen(function* () {
						yield* getInstance(request.instanceId);
						yield* updateInstance(request.instanceId, {
							...(request.driver !== undefined
								? { driver: request.driver }
								: {}),
							...(request.name !== undefined ? { name: request.name } : {}),
							...(request.port !== undefined ? { port: request.port } : {}),
							...(request.env !== undefined ? { env: { ...request.env } } : {}),
							...(request.configDir !== undefined
								? { configDir: request.configDir }
								: {}),
						});
						yield* persistConfig;
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			GetAutoSettleSetting: () =>
				run(
					Effect.gen(function* () {
						const config = yield* DaemonConfigRefTag;
						const days = (yield* Ref.get(config)).autoSettleAfterDays;
						return {
							autoSettleAfterDays:
								days === undefined ? DEFAULT_AUTO_SETTLE_AFTER_DAYS : days,
						};
					}),
				),
			SetAutoSettleSetting: (request) =>
				run(
					Effect.gen(function* () {
						const days = request.autoSettleAfterDays;
						if (
							days !== null &&
							(!Number.isInteger(days) || days < 1 || days > 90)
						) {
							return yield* new WsRpcError({
								message:
									"Auto-settle days must be an integer from 1 to 90, or Never",
							});
						}
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							autoSettleAfterDays: days,
						}));
						yield* persistConfig;
						return { autoSettleAfterDays: days };
					}),
				),
			GetUsageLimitsSetting: () =>
				run(
					Effect.gen(function* () {
						const config = yield* DaemonConfigRefTag;
						return {
							usageLimits:
								(yield* Ref.get(config)).usageLimits ?? DEFAULT_USAGE_LIMITS,
						};
					}),
				),
			SetUsageLimitsSetting: ({ usageLimits }) =>
				run(
					Effect.gen(function* () {
						yield* commitDaemonRuntimeConfig((config) => ({
							...config,
							usageLimits,
						}));
						yield* persistConfig;
						return { usageLimits };
					}),
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
					}).pipe(
						Effect.map((result) => ({
							projectSlug: request.projectSlug,
							...result,
						})),
					),
				),
			ResolveSession: (request) =>
				run(
					resolveDaemonSession(configDir, request.sessionId).pipe(
						Effect.map((projectSlug) => ({ projectSlug })),
					),
				),
			FindFolders: (request) =>
				run(
					Effect.gen(function* () {
						const projects = yield* allProjects;
						return yield* findFolders(request.query, {
							recent: getRecent(loadRecentProjects(configDir)).map(
								(project) => project.directory,
							),
							projectFolders: projects.flatMap((project) => project.folders),
						});
					}),
				),
			DetectProxy: wsRpcHandlers.DetectProxy,
			SetLogLevel: wsRpcHandlers.SetLogLevel,
		} satisfies DaemonRpcHandlers;
	}),
);
