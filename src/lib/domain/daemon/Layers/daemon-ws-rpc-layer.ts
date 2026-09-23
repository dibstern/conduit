import { Context, Effect, Layer, Option, PubSub, Stream } from "effect";
import { WsRpcError } from "../../../contracts/ws-rpc.js";
import { normalizeProjectTitle } from "../../../handlers/settings.js";
import {
	type DaemonRpcHandlers,
	wsRpcHandlers,
} from "../../../server/ws-rpc.js";
import type { RelayMessage } from "../../../shared-types.js";
import { listDirectoryEntries } from "../../relay/Services/directory-listing-service.js";
import { makeInstanceId } from "../../relay/Services/instance-management-service.js";
import type { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import type { DaemonConfigRefTag } from "../Services/daemon-config-ref.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	listDaemonSessions,
	resolveDaemonSession,
} from "../Services/daemon-session-reader.js";
import { DaemonWsClientRegistryTag } from "../Services/daemon-ws-client-registry.js";
import {
	addInstance,
	getInstances,
	type InstanceManagerStateTag,
	type PollerFibersTag,
	persistConfig,
	removeInstance,
	startInstance,
	stopInstance,
	updateInstance,
} from "../Services/instance-manager-service.js";
import {
	addProjectToEffectRegistry,
	allProjects,
	broadcastToAll,
	type ProjectRegistryTag,
	remove,
	replaceRelay,
	updateProject,
} from "../Services/project-registry-service.js";
import { RelayCacheTag } from "../Services/relay-cache.js";
import { PortScannerTag } from "./port-scanner-layer.js";

export class DaemonWsRpcHandlersTag extends Context.Tag("DaemonWsRpcHandlers")<
	DaemonWsRpcHandlersTag,
	DaemonRpcHandlers
>() {}

export const DaemonWsRpcHandlersLive = Layer.scoped(
	DaemonWsRpcHandlersTag,
	Effect.gen(function* () {
		const context = yield* Effect.context<
			| ProjectRegistryTag
			| DaemonConfigRefTag
			| DaemonEventBusTag
			| DaemonWsClientRegistryTag
			| ConfigPersistenceTag
			| RelayCacheTag
			| InstanceManagerStateTag
			| PollerFibersTag
			| PortScannerTag
		>();
		const bus = yield* DaemonEventBusTag;
		const daemonWsClients = yield* DaemonWsClientRegistryTag;
		const cache = yield* RelayCacheTag;
		const subscription = yield* PubSub.subscribe(bus);
		yield* Stream.fromQueue(subscription).pipe(
			Stream.runForEach((event) =>
				event._tag === "RelayBroadcast"
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
					: Effect.void,
			),
			Effect.forkScoped,
		);
		const run = <A, E>(
			operation: string,
			effect: Effect.Effect<
				A,
				E,
				| ProjectRegistryTag
				| DaemonConfigRefTag
				| DaemonEventBusTag
				| DaemonWsClientRegistryTag
				| ConfigPersistenceTag
				| RelayCacheTag
				| InstanceManagerStateTag
				| PollerFibersTag
				| PortScannerTag
			>,
		) =>
			effect.pipe(
				Effect.provide(context),
				Effect.mapError((error) =>
					error instanceof WsRpcError
						? error
						: new WsRpcError({
								message: `${operation} failed: ${String(error)}`,
							}),
				),
			);

		const projectList = Effect.gen(function* () {
			const projects = yield* allProjects;
			yield* broadcastToAll({ type: "project_list", projects });
			return projects;
		});
		const instanceList = Effect.gen(function* () {
			const instances = Array.from(yield* getInstances);
			yield* broadcastToAll({ type: "instance_list", instances });
			return instances;
		});

		return {
			GetProjects: (request) =>
				run(
					"GetProjects",
					allProjects.pipe(
						Effect.map((projects) => ({
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects,
						})),
					),
				),
			AddProject: (request) =>
				run(
					"AddProject",
					Effect.gen(function* () {
						const project = yield* addProjectToEffectRegistry(
							request.directory,
							request.instanceId,
						);
						const projects = yield* projectList;
						return {
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects,
							addedSlug: project.slug,
						};
					}),
				),
			RemoveProject: (request) =>
				run(
					"RemoveProject",
					Effect.gen(function* () {
						yield* remove(request.slug);
						return {
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects: yield* projectList,
						};
					}),
				),
			RenameProject: (request) =>
				run(
					"RenameProject",
					Effect.gen(function* () {
						const title = normalizeProjectTitle(request.title);
						if (!title)
							return yield* new WsRpcError({
								message: "RenameProject failed: title is required",
							});
						yield* updateProject(request.slug, { title });
						return {
							projectSlug: request.projectSlug,
							...(request.projectSlug ? { current: request.projectSlug } : {}),
							projects: yield* projectList,
						};
					}),
				),
			SetProjectInstance: (request) =>
				run(
					"SetProjectInstance",
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
					"StartInstance",
					Effect.gen(function* () {
						yield* startInstance(request.instanceId);
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			StopInstance: (request) =>
				run(
					"StopInstance",
					Effect.gen(function* () {
						yield* stopInstance(request.instanceId);
						return {
							projectSlug: request.projectSlug,
							instances: yield* instanceList,
						};
					}),
				),
			RemoveInstance: (request) =>
				run(
					"RemoveInstance",
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
				run(
					"RenameInstance",
					Effect.gen(function* () {
						const name = request.name.trim();
						if (!name)
							return yield* new WsRpcError({
								message: "RenameInstance failed: name is required",
							});
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
					"AddInstance",
					Effect.gen(function* () {
						const name = request.name.trim();
						if (!name)
							return yield* new WsRpcError({
								message: "AddInstance failed: name is required",
							});
						const id = makeInstanceId(name, Array.from(yield* getInstances));
						const hasUrl =
							typeof request.url === "string" && request.url.length > 0;
						yield* addInstance({
							id,
							name,
							port: request.port ?? 0,
							managed: request.managed ?? !hasUrl,
							...(hasUrl && request.url !== undefined
								? { url: request.url }
								: {}),
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
						};
					}),
				),
			UpdateInstance: (request) =>
				run(
					"UpdateInstance",
					Effect.gen(function* () {
						yield* updateInstance(request.instanceId, {
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
			ScanNow: (request) =>
				run(
					"ScanNow",
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
					"ListDaemonSessions",
					listDaemonSessions({
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
					"ResolveSession",
					resolveDaemonSession(request.sessionId).pipe(
						Effect.map((projectSlug) => ({ projectSlug })),
					),
				),
			ListDirectories: (request) =>
				listDirectoryEntries(request.path).pipe(
					Effect.map((result) => ({
						projectSlug: request.projectSlug,
						...result,
						entries: [...result.entries],
					})),
				),
			DetectProxy: wsRpcHandlers.DetectProxy,
			SetLogLevel: wsRpcHandlers.SetLogLevel,
		} satisfies DaemonRpcHandlers;
	}),
);
