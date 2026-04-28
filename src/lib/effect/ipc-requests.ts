// Effect TaggedRequest definitions for daemon IPC.
//
// These are the new wire-level request shapes. The daemon keeps accepting the
// legacy cmd-based format during the transition, but the CLI emits these _tag
// requests by default.

import { Effect, Either, Schema } from "effect";
import type { IPCCommand, IPCResponse } from "../types.js";

const NonEmptyString = Schema.NonEmptyString;
const PinString = Schema.String.pipe(Schema.pattern(/^\d{4,8}$/));
const Port = Schema.Number.pipe(Schema.int(), Schema.between(1, 65535));
const Env = Schema.Record({ key: Schema.String, value: Schema.String });

const OkResponse = Schema.Struct({
	ok: Schema.Literal(true),
});

const OkWithAddedProject = Schema.Struct({
	ok: Schema.Literal(true),
	slug: Schema.String,
	directory: Schema.String,
});

export const IpcProjectSchema = Schema.Struct({
	slug: Schema.String,
	directory: Schema.String,
	title: Schema.optional(Schema.String),
	lastUsed: Schema.optional(Schema.Number),
	instanceId: Schema.optional(Schema.String),
	sessions: Schema.optional(Schema.Number),
	clients: Schema.optional(Schema.Number),
	isProcessing: Schema.optional(Schema.Boolean),
});

export const IpcStatusProjectSchema = Schema.Struct({
	slug: Schema.String,
	directory: Schema.String,
	title: Schema.String,
	status: Schema.optional(Schema.String),
	lastUsed: Schema.optional(Schema.Number),
});

export const IpcInstanceStatusSchema = Schema.Literal(
	"starting",
	"healthy",
	"unhealthy",
	"stopped",
);

export const IpcOpenCodeInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	port: Schema.Number,
	managed: Schema.Boolean,
	status: IpcInstanceStatusSchema,
	pid: Schema.optional(Schema.Number),
	env: Schema.optional(Env),
	needsRestart: Schema.optional(Schema.Boolean),
	exitCode: Schema.optional(Schema.Number),
	lastHealthCheck: Schema.optional(Schema.Number),
	restartCount: Schema.Number,
	createdAt: Schema.Number,
});

export const IpcProjectsResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	projects: Schema.Array(IpcProjectSchema),
});

export const IpcStatusResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	uptime: Schema.Number,
	port: Schema.Number,
	host: Schema.String,
	tailscaleIP: Schema.optional(Schema.String),
	lanIP: Schema.optional(Schema.String),
	projectCount: Schema.Number,
	sessionCount: Schema.Number,
	clientCount: Schema.Number,
	pinEnabled: Schema.Boolean,
	tlsEnabled: Schema.Boolean,
	keepAwake: Schema.Boolean,
	projects: Schema.Array(IpcStatusProjectSchema),
});

export const IpcInstancesResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	instances: Schema.Array(IpcOpenCodeInstanceSchema),
});

const OkWithInstance = Schema.Struct({
	ok: Schema.Literal(true),
	instance: IpcOpenCodeInstanceSchema,
});

export const IpcKeepAwakeResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	supported: Schema.Boolean,
	active: Schema.Boolean,
});

export class IpcError extends Schema.TaggedError<IpcError>()("IpcError", {
	message: Schema.String,
}) {}

export class AddProject extends Schema.TaggedRequest<AddProject>()(
	"AddProject",
	{
		failure: IpcError,
		success: OkWithAddedProject,
		payload: { directory: NonEmptyString },
	},
) {}

export class RemoveProject extends Schema.TaggedRequest<RemoveProject>()(
	"RemoveProject",
	{
		failure: IpcError,
		success: OkResponse,
		payload: { slug: NonEmptyString },
	},
) {}

export class ListProjects extends Schema.TaggedRequest<ListProjects>()(
	"ListProjects",
	{
		failure: IpcError,
		success: IpcProjectsResponseSchema,
		payload: {},
	},
) {}

export class SetProjectTitle extends Schema.TaggedRequest<SetProjectTitle>()(
	"SetProjectTitle",
	{
		failure: IpcError,
		success: OkResponse,
		payload: { slug: NonEmptyString, title: Schema.String },
	},
) {}

export class GetStatus extends Schema.TaggedRequest<GetStatus>()("GetStatus", {
	failure: IpcError,
	success: IpcStatusResponseSchema,
	payload: {},
}) {}

export class SetPin extends Schema.TaggedRequest<SetPin>()("SetPin", {
	failure: IpcError,
	success: OkResponse,
	payload: { pin: PinString },
}) {}

export class SetKeepAwake extends Schema.TaggedRequest<SetKeepAwake>()(
	"SetKeepAwake",
	{
		failure: IpcError,
		success: IpcKeepAwakeResponseSchema,
		payload: { enabled: Schema.Boolean },
	},
) {}

export class SetKeepAwakeCommand extends Schema.TaggedRequest<SetKeepAwakeCommand>()(
	"SetKeepAwakeCommand",
	{
		failure: IpcError,
		success: OkResponse,
		payload: {
			command: NonEmptyString,
			args: Schema.optionalWith(Schema.Array(Schema.String), {
				default: () => [],
			}),
		},
	},
) {}

export class Shutdown extends Schema.TaggedRequest<Shutdown>()("Shutdown", {
	failure: Schema.Never,
	success: OkResponse,
	payload: {},
}) {}

export class SetAgent extends Schema.TaggedRequest<SetAgent>()("SetAgent", {
	failure: IpcError,
	success: OkResponse,
	payload: { slug: Schema.String, agent: Schema.String },
}) {}

export class SetModel extends Schema.TaggedRequest<SetModel>()("SetModel", {
	failure: IpcError,
	success: OkResponse,
	payload: {
		slug: Schema.String,
		provider: Schema.String,
		model: Schema.String,
	},
}) {}

export class RestartWithConfig extends Schema.TaggedRequest<RestartWithConfig>()(
	"RestartWithConfig",
	{
		failure: IpcError,
		success: OkResponse,
		payload: {
			config: Schema.optional(
				Schema.Record({ key: Schema.String, value: Schema.Unknown }),
			),
		},
	},
) {}

export class InstanceList extends Schema.TaggedRequest<InstanceList>()(
	"InstanceList",
	{
		failure: IpcError,
		success: IpcInstancesResponseSchema,
		payload: {},
	},
) {}

export class InstanceAdd extends Schema.TaggedRequest<InstanceAdd>()(
	"InstanceAdd",
	{
		failure: IpcError,
		success: OkWithInstance,
		payload: {
			name: NonEmptyString,
			managed: Schema.Boolean,
			port: Schema.optional(Port),
			env: Schema.optional(Env),
			url: Schema.optional(NonEmptyString),
		},
	},
) {}

export class InstanceRemove extends Schema.TaggedRequest<InstanceRemove>()(
	"InstanceRemove",
	{
		failure: IpcError,
		success: OkResponse,
		payload: { id: NonEmptyString },
	},
) {}

export class InstanceStart extends Schema.TaggedRequest<InstanceStart>()(
	"InstanceStart",
	{
		failure: IpcError,
		success: OkResponse,
		payload: { id: NonEmptyString },
	},
) {}

export class InstanceStop extends Schema.TaggedRequest<InstanceStop>()(
	"InstanceStop",
	{
		failure: IpcError,
		success: OkResponse,
		payload: { id: NonEmptyString },
	},
) {}

export class InstanceUpdate extends Schema.TaggedRequest<InstanceUpdate>()(
	"InstanceUpdate",
	{
		failure: IpcError,
		success: OkWithInstance,
		payload: {
			id: NonEmptyString,
			name: Schema.optional(Schema.String),
			env: Schema.optional(Env),
			port: Schema.optional(Schema.Number),
		},
	},
) {}

export class InstanceStatus extends Schema.TaggedRequest<InstanceStatus>()(
	"InstanceStatus",
	{
		failure: IpcError,
		success: OkWithInstance,
		payload: { id: NonEmptyString },
	},
) {}

const IpcTaggedRequestUnion = Schema.Union(
	AddProject,
	RemoveProject,
	ListProjects,
	SetProjectTitle,
	GetStatus,
	SetPin,
	SetKeepAwake,
	SetKeepAwakeCommand,
	Shutdown,
	SetAgent,
	SetModel,
	RestartWithConfig,
	InstanceList,
	InstanceAdd,
	InstanceRemove,
	InstanceStart,
	InstanceStop,
	InstanceUpdate,
	InstanceStatus,
);

const instanceAddValidation = (
	request: Schema.Schema.Type<typeof IpcTaggedRequestUnion>,
): string | undefined => {
	if (request._tag !== "InstanceAdd") return undefined;
	if (request.managed) {
		if (request.port === undefined) {
			return "InstanceAdd requires a valid 'port' (1-65535) for managed instances";
		}
		if (request.url !== undefined) {
			return "InstanceAdd: 'url' is only valid for unmanaged instances (managed: false)";
		}
	} else if (request.url === undefined && request.port === undefined) {
		return "InstanceAdd: unmanaged instances require either a 'url' or a valid 'port'";
	}
	if (request.url !== undefined) {
		try {
			new URL(request.url);
		} catch {
			return "InstanceAdd: 'url' must be a valid URL (e.g. http://host:4096)";
		}
	}
	return undefined;
};

export const IpcTaggedRequestSchema = IpcTaggedRequestUnion.pipe(
	Schema.filter(instanceAddValidation),
);

export type IpcTaggedRequest = Schema.Schema.Type<
	typeof IpcTaggedRequestSchema
>;

export const decodeTaggedIpcCommand = (value: unknown) =>
	Schema.decodeUnknown(IpcTaggedRequestSchema)(value).pipe(
		Effect.map(taggedRequestToCommand),
	);

export function decodeTaggedIpcCommandEither(
	value: unknown,
): Either.Either<IPCCommand, unknown> {
	const decoded = Schema.decodeUnknownEither(IpcTaggedRequestSchema)(value);
	if (Either.isLeft(decoded)) return Either.left(decoded.left);
	return Either.right(taggedRequestToCommand(decoded.right));
}

export function taggedRequestToCommand(request: IpcTaggedRequest): IPCCommand {
	switch (request._tag) {
		case "AddProject":
			return { cmd: "add_project", directory: request.directory };
		case "RemoveProject":
			return { cmd: "remove_project", slug: request.slug };
		case "ListProjects":
			return { cmd: "list_projects" };
		case "SetProjectTitle":
			return {
				cmd: "set_project_title",
				slug: request.slug,
				title: request.title,
			};
		case "GetStatus":
			return { cmd: "get_status" };
		case "SetPin":
			return { cmd: "set_pin", pin: request.pin };
		case "SetKeepAwake":
			return { cmd: "set_keep_awake", enabled: request.enabled };
		case "SetKeepAwakeCommand":
			return {
				cmd: "set_keep_awake_command",
				command: request.command,
				args: [...request.args],
			};
		case "Shutdown":
			return { cmd: "shutdown" };
		case "SetAgent":
			return { cmd: "set_agent", slug: request.slug, agent: request.agent };
		case "SetModel":
			return {
				cmd: "set_model",
				slug: request.slug,
				provider: request.provider,
				model: request.model,
			};
		case "RestartWithConfig":
			return {
				cmd: "restart_with_config",
				...(request.config !== undefined ? { config: request.config } : {}),
			};
		case "InstanceList":
			return { cmd: "instance_list" };
		case "InstanceAdd":
			return {
				cmd: "instance_add",
				name: request.name,
				managed: request.managed,
				...(request.port !== undefined ? { port: request.port } : {}),
				...(request.env !== undefined ? { env: request.env } : {}),
				...(request.url !== undefined ? { url: request.url } : {}),
			};
		case "InstanceRemove":
			return { cmd: "instance_remove", id: request.id };
		case "InstanceStart":
			return { cmd: "instance_start", id: request.id };
		case "InstanceStop":
			return { cmd: "instance_stop", id: request.id };
		case "InstanceUpdate":
			return {
				cmd: "instance_update",
				id: request.id,
				...(request.name !== undefined ? { name: request.name } : {}),
				...(request.env !== undefined ? { env: request.env } : {}),
				...(request.port !== undefined ? { port: request.port } : {}),
			};
		case "InstanceStatus":
			return { cmd: "instance_status", id: request.id };
	}
}

export function commandToTaggedRequestPayload(command: IPCCommand): unknown {
	switch (command.cmd) {
		case "add_project":
			return { _tag: "AddProject", directory: command.directory };
		case "remove_project":
			return { _tag: "RemoveProject", slug: command.slug };
		case "list_projects":
			return { _tag: "ListProjects" };
		case "set_project_title":
			return {
				_tag: "SetProjectTitle",
				slug: command.slug,
				title: command.title,
			};
		case "get_status":
			return { _tag: "GetStatus" };
		case "set_pin":
			return { _tag: "SetPin", pin: command.pin };
		case "set_keep_awake":
			return { _tag: "SetKeepAwake", enabled: command.enabled };
		case "set_keep_awake_command":
			return {
				_tag: "SetKeepAwakeCommand",
				command: command.command,
				args: command.args,
			};
		case "shutdown":
			return { _tag: "Shutdown" };
		case "set_agent":
			return { _tag: "SetAgent", slug: command.slug, agent: command.agent };
		case "set_model":
			return {
				_tag: "SetModel",
				slug: command.slug,
				provider: command.provider,
				model: command.model,
			};
		case "restart_with_config":
			return {
				_tag: "RestartWithConfig",
				...(command.config !== undefined ? { config: command.config } : {}),
			};
		case "instance_list":
			return { _tag: "InstanceList" };
		case "instance_add":
			return {
				_tag: "InstanceAdd",
				name: command.name,
				managed: command.managed,
				...(command.port !== undefined ? { port: command.port } : {}),
				...(command.env !== undefined ? { env: command.env } : {}),
				...(command.url !== undefined ? { url: command.url } : {}),
			};
		case "instance_remove":
			return { _tag: "InstanceRemove", id: command.id };
		case "instance_start":
			return { _tag: "InstanceStart", id: command.id };
		case "instance_stop":
			return { _tag: "InstanceStop", id: command.id };
		case "instance_update":
			return {
				_tag: "InstanceUpdate",
				id: command.id,
				...(command.name !== undefined ? { name: command.name } : {}),
				...(command.env !== undefined ? { env: command.env } : {}),
				...(command.port !== undefined ? { port: command.port } : {}),
			};
		case "instance_status":
			return { _tag: "InstanceStatus", id: command.id };
	}
}

export function isIpcResponse(value: unknown): value is IPCResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		typeof value.ok === "boolean"
	);
}
