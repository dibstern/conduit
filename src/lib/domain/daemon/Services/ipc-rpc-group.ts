// @effect/rpc group for daemon IPC requests.
//
// Define endpoints from Schema.TaggedRequest classes using the installed
// @effect/rpc API.

import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, type Layer, Schema } from "effect";
import {
	AddProject,
	GetStatus,
	InstanceAdd,
	InstanceList,
	InstanceRemove,
	InstanceStart,
	InstanceStatus,
	InstanceStop,
	InstanceUpdate,
	IpcError,
	IpcInstancesResponseSchema,
	IpcKeepAwakeResponseSchema,
	IpcOpenCodeInstanceSchema,
	IpcProjectsResponseSchema,
	IpcStatusResponseSchema,
	ListProjects,
	RemoveProject,
	RestartWithConfig,
	SetAgent,
	SetKeepAwake,
	SetKeepAwakeCommand,
	SetModel,
	SetPin,
	SetProjectTitle,
	Shutdown,
} from "../../../contracts/ipc-requests.js";
import { formatErrorDetail } from "../../../errors.js";
import type { ShutdownSignalTag } from "../Layers/daemon-layers.js";
import type { KeepAwakeTag } from "../Layers/keep-awake-layer.js";
import type { ConfigPersistenceTag } from "./config-persistence-service.js";
import type { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { DaemonHandleTag } from "./daemon-handle.js";
import type { DaemonEventBusTag } from "./daemon-pubsub.js";
import type { DaemonStateTag } from "./daemon-state.js";
import {
	addInstance as addEffectInstance,
	getInstance as getEffectInstance,
	getInstances as getEffectInstances,
	type InstanceManagerStateTag,
	type PollerFibersTag,
	removeInstance as removeEffectInstance,
	startInstance as startEffectInstance,
	stopInstance as stopEffectInstance,
	updateInstance as updateEffectInstance,
} from "./instance-manager-service.js";
import {
	handleRestartWithConfig,
	handleSetKeepAwake,
	handleSetKeepAwakeCommand,
	handleSetPin,
	handleShutdown,
} from "./ipc-handlers.js";
import {
	type ProjectRegistryTag,
	updateProject,
} from "./project-registry-service.js";
import { RelayCacheTag } from "./relay-cache.js";

export const IpcRpcGroup = RpcGroup.make(
	Rpc.fromTaggedRequest(AddProject),
	Rpc.fromTaggedRequest(RemoveProject),
	Rpc.fromTaggedRequest(ListProjects),
	Rpc.fromTaggedRequest(SetProjectTitle),
	Rpc.fromTaggedRequest(GetStatus),
	Rpc.fromTaggedRequest(SetPin),
	Rpc.fromTaggedRequest(SetKeepAwake),
	Rpc.fromTaggedRequest(SetKeepAwakeCommand),
	Rpc.fromTaggedRequest(Shutdown),
	Rpc.fromTaggedRequest(SetAgent),
	Rpc.fromTaggedRequest(SetModel),
	Rpc.fromTaggedRequest(RestartWithConfig),
	Rpc.fromTaggedRequest(InstanceList),
	Rpc.fromTaggedRequest(InstanceAdd),
	Rpc.fromTaggedRequest(InstanceRemove),
	Rpc.fromTaggedRequest(InstanceStart),
	Rpc.fromTaggedRequest(InstanceStop),
	Rpc.fromTaggedRequest(InstanceUpdate),
	Rpc.fromTaggedRequest(InstanceStatus),
);

export type IpcRpcGroup = typeof IpcRpcGroup;

const ipcFailure = (message: string) => new IpcError({ message });

const failureFromResponse = (response: { readonly error?: string }) =>
	ipcFailure(response.error ?? "IPC command failed");

const decodeProjectsResponse = (response: unknown) =>
	Schema.decodeUnknown(IpcProjectsResponseSchema)(response);

const decodeInstance = (instance: unknown) =>
	Schema.decodeUnknown(IpcOpenCodeInstanceSchema)(instance);

const decodeInstancesResponse = (response: unknown) =>
	Schema.decodeUnknown(IpcInstancesResponseSchema)(response);

const decodeStatus = (response: unknown) =>
	Schema.decodeUnknown(IpcStatusResponseSchema)(response);

const decodeKeepAwake = (response: unknown) =>
	Schema.decodeUnknown(IpcKeepAwakeResponseSchema)(response);

export const IpcHandlersLayer: Layer.Layer<
	Rpc.ToHandler<RpcGroup.Rpcs<typeof IpcRpcGroup>>,
	never,
	| DaemonHandleTag
	| DaemonStateTag
	| DaemonConfigRefTag
	| ConfigPersistenceTag
	| KeepAwakeTag
	| ShutdownSignalTag
	| InstanceManagerStateTag
	| PollerFibersTag
	| DaemonEventBusTag
	| ProjectRegistryTag
	| RelayCacheTag
> = IpcRpcGroup.toLayer({
	AddProject: (request) =>
		DaemonHandleTag.pipe(
			Effect.flatMap((handle) => handle.addProject(request.directory)),
			Effect.map((project) => ({
				ok: true as const,
				slug: project.slug,
				directory: project.directory,
			})),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	RemoveProject: (request) =>
		DaemonHandleTag.pipe(
			Effect.flatMap((handle) => handle.removeProject(request.slug)),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	ListProjects: () =>
		DaemonHandleTag.pipe(
			Effect.flatMap((handle) => handle.getProjects()),
			Effect.map((projects) => ({
				ok: true as const,
				projects: projects.map((project) => ({
					slug: project.slug,
					directory: project.directory,
					title: project.title,
					...(project.lastUsed !== undefined && {
						lastUsed: project.lastUsed,
					}),
					...(project.instanceId !== undefined && {
						instanceId: project.instanceId,
					}),
				})),
			})),
			Effect.flatMap((response) =>
				decodeProjectsResponse(response).pipe(
					Effect.mapError(() =>
						ipcFailure("list_projects returned invalid projects"),
					),
				),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	SetProjectTitle: (request) =>
		updateProject(request.slug, { title: request.title }).pipe(
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	GetStatus: () =>
		DaemonHandleTag.pipe(
			Effect.flatMap((handle) => handle.getStatus()),
			Effect.flatMap((response) =>
				decodeStatus(response).pipe(
					Effect.mapError(() =>
						ipcFailure("get_status returned an invalid status response"),
					),
				),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	SetPin: (request) =>
		handleSetPin({ cmd: "set_pin", pin: request.pin }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	SetKeepAwake: (request) =>
		handleSetKeepAwake({
			cmd: "set_keep_awake",
			enabled: request.enabled,
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? decodeKeepAwake(response).pipe(
							Effect.mapError(() =>
								ipcFailure("set_keep_awake returned an invalid response"),
							),
						)
					: Effect.fail(failureFromResponse(response)),
			),
		),
	SetKeepAwakeCommand: (request) =>
		handleSetKeepAwakeCommand({
			cmd: "set_keep_awake_command",
			command: request.command,
			args: [...request.args],
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	Shutdown: () =>
		handleShutdown({ cmd: "shutdown" }).pipe(
			Effect.map(() => ({ ok: true as const })),
		),
	SetAgent: (request) =>
		RelayCacheTag.pipe(
			Effect.flatMap((cache) => cache.get(request.slug)),
			Effect.flatMap((relay) => {
				const setDefaultAgent = relay.setDefaultAgent;
				if (setDefaultAgent === undefined) {
					return Effect.fail(
						ipcFailure(
							`Relay "${request.slug}" does not support default agent updates`,
						),
					);
				}
				return Effect.tryPromise({
					try: () => setDefaultAgent(request.agent),
					catch: (cause) => ipcFailure(formatErrorDetail(cause)),
				});
			}),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	SetModel: (request) =>
		RelayCacheTag.pipe(
			Effect.flatMap((cache) => cache.get(request.slug)),
			Effect.flatMap((relay) => {
				const setDefaultModel = relay.setDefaultModel;
				if (setDefaultModel === undefined) {
					return Effect.fail(
						ipcFailure(
							`Relay "${request.slug}" does not support default model updates`,
						),
					);
				}
				return Effect.tryPromise({
					try: () =>
						setDefaultModel({
							providerID: request.provider,
							modelID: request.model,
						}),
					catch: (cause) => ipcFailure(formatErrorDetail(cause)),
				});
			}),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	RestartWithConfig: (request) =>
		handleRestartWithConfig({
			cmd: "restart_with_config",
			...(request.config !== undefined ? { config: request.config } : {}),
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	InstanceList: () =>
		getEffectInstances.pipe(
			Effect.map((instances) => ({
				ok: true as const,
				instances: Array.from(instances),
			})),
			Effect.flatMap((response) =>
				decodeInstancesResponse(response).pipe(
					Effect.mapError(() =>
						ipcFailure("instance_list returned invalid instances"),
					),
				),
			),
		),
	InstanceAdd: (request) =>
		Effect.gen(function* () {
			const existingInstances = Array.from(yield* getEffectInstances);
			let id =
				request.name
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "") || "instance";
			const baseId = id;
			let counter = 2;
			while (existingInstances.some((instance) => instance.id === id)) {
				id = `${baseId}-${counter}`;
				counter++;
			}
			const instance = yield* addEffectInstance({
				id,
				name: request.name,
				port: request.port ?? 0,
				managed: request.managed,
				...(request.env !== undefined ? { env: request.env } : {}),
				...(request.url !== undefined ? { url: request.url } : {}),
			});
			return instance;
		}).pipe(
			Effect.flatMap((instance) =>
				decodeInstance(instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_add returned an invalid instance"),
					),
				),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	InstanceRemove: (request) =>
		getEffectInstance(request.id).pipe(
			Effect.zipRight(removeEffectInstance(request.id)),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	InstanceStart: (request) =>
		getEffectInstance(request.id).pipe(
			Effect.zipRight(startEffectInstance(request.id)),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	InstanceStop: (request) =>
		getEffectInstance(request.id).pipe(
			Effect.zipRight(stopEffectInstance(request.id)),
			Effect.map(() => ({ ok: true as const })),
			Effect.catchAll((error) =>
				Effect.fail(ipcFailure(formatErrorDetail(error))),
			),
		),
	InstanceUpdate: (request) =>
		Effect.gen(function* () {
			yield* getEffectInstance(request.id);
			const updates: {
				name?: string;
				env?: Record<string, string>;
				port?: number;
			} = {};
			if (request.name !== undefined) updates.name = request.name;
			if (request.env !== undefined) updates.env = request.env;
			if (request.port !== undefined) updates.port = request.port;
			yield* updateEffectInstance(request.id, updates);
			return yield* getEffectInstance(request.id);
		}).pipe(
			Effect.flatMap((instance) =>
				decodeInstance(instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_update returned an invalid instance"),
					),
				),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
	InstanceStatus: (request) =>
		getEffectInstance(request.id).pipe(
			Effect.flatMap((instance) =>
				decodeInstance(instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_status returned an invalid instance"),
					),
				),
			),
			Effect.catchAll((error) =>
				Effect.fail(
					error instanceof IpcError
						? error
						: ipcFailure(formatErrorDetail(error)),
				),
			),
		),
});
