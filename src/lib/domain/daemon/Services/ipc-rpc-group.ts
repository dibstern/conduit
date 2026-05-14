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
import type { IpcHandlerDeps } from "./ipc-dispatch.js";
import {
	handleAddProject,
	handleGetStatus,
	handleInstanceAdd,
	handleInstanceList,
	handleInstanceRemove,
	handleInstanceStart,
	handleInstanceStatus,
	handleInstanceStop,
	handleInstanceUpdate,
	handleListProjects,
	handleRemoveProject,
	handleRestartWithConfig,
	handleSetAgent,
	handleSetKeepAwake,
	handleSetKeepAwakeCommand,
	handleSetModel,
	handleSetPin,
	handleSetProjectTitle,
	handleShutdown,
} from "./ipc-handlers.js";

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
	IpcHandlerDeps
> = IpcRpcGroup.toLayer({
	AddProject: (request) =>
		handleAddProject({
			cmd: "add_project",
			directory: request.directory,
		}).pipe(
			Effect.flatMap((response) => {
				if (!response.ok) return Effect.fail(failureFromResponse(response));
				if (
					typeof response.slug !== "string" ||
					typeof response.directory !== "string"
				) {
					return Effect.fail(
						ipcFailure("add_project returned an invalid success response"),
					);
				}
				return Effect.succeed({
					ok: true as const,
					slug: response.slug,
					directory: response.directory,
				});
			}),
		),
	RemoveProject: (request) =>
		handleRemoveProject({ cmd: "remove_project", slug: request.slug }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	ListProjects: () =>
		handleListProjects({ cmd: "list_projects" }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? decodeProjectsResponse(response).pipe(
							Effect.mapError(() =>
								ipcFailure("list_projects returned invalid projects"),
							),
						)
					: Effect.fail(failureFromResponse(response)),
			),
		),
	SetProjectTitle: (request) =>
		handleSetProjectTitle({
			cmd: "set_project_title",
			slug: request.slug,
			title: request.title,
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	GetStatus: () =>
		handleGetStatus({ cmd: "get_status" }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? decodeStatus(response).pipe(
							Effect.mapError(() =>
								ipcFailure("get_status returned an invalid status response"),
							),
						)
					: Effect.fail(failureFromResponse(response)),
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
		handleSetAgent({
			cmd: "set_agent",
			slug: request.slug,
			agent: request.agent,
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	SetModel: (request) =>
		handleSetModel({
			cmd: "set_model",
			slug: request.slug,
			provider: request.provider,
			model: request.model,
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
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
		handleInstanceList({ cmd: "instance_list" }).pipe(
			Effect.flatMap((response) => {
				if (!response.ok) return Effect.fail(failureFromResponse(response));
				return decodeInstancesResponse(response).pipe(
					Effect.mapError(() =>
						ipcFailure("instance_list returned invalid instances"),
					),
				);
			}),
		),
	InstanceAdd: (request) =>
		handleInstanceAdd({
			cmd: "instance_add",
			name: request.name,
			managed: request.managed,
			...(request.port !== undefined ? { port: request.port } : {}),
			...(request.env !== undefined ? { env: request.env } : {}),
			...(request.url !== undefined ? { url: request.url } : {}),
		}).pipe(
			Effect.flatMap((response) => {
				if (!response.ok) return Effect.fail(failureFromResponse(response));
				return decodeInstance(response.instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_add returned an invalid instance"),
					),
				);
			}),
		),
	InstanceRemove: (request) =>
		handleInstanceRemove({ cmd: "instance_remove", id: request.id }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	InstanceStart: (request) =>
		handleInstanceStart({ cmd: "instance_start", id: request.id }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	InstanceStop: (request) =>
		handleInstanceStop({ cmd: "instance_stop", id: request.id }).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.succeed({ ok: true as const })
					: Effect.fail(failureFromResponse(response)),
			),
		),
	InstanceUpdate: (request) =>
		handleInstanceUpdate({
			cmd: "instance_update",
			id: request.id,
			...(request.name !== undefined ? { name: request.name } : {}),
			...(request.env !== undefined ? { env: request.env } : {}),
			...(request.port !== undefined ? { port: request.port } : {}),
		}).pipe(
			Effect.flatMap((response) => {
				if (!response.ok) return Effect.fail(failureFromResponse(response));
				return decodeInstance(response.instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_update returned an invalid instance"),
					),
				);
			}),
		),
	InstanceStatus: (request) =>
		handleInstanceStatus({ cmd: "instance_status", id: request.id }).pipe(
			Effect.flatMap((response) => {
				if (!response.ok) return Effect.fail(failureFromResponse(response));
				return decodeInstance(response.instance).pipe(
					Effect.map((instance) => ({
						ok: true as const,
						instance,
					})),
					Effect.mapError(() =>
						ipcFailure("instance_status returned an invalid instance"),
					),
				);
			}),
		),
});
