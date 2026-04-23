// ─── IPC Protocol (Ticket 3.2) ──────────────────────────────────────────────
// Command routing and validation for the JSON-lines IPC protocol.

import { Either, Schema } from "effect";
import type { IPCCommand, IPCResponse } from "../types.js";
import { assertNever } from "../utils.js";

// ─── Reusable schema fragments ─────────────────────────────────────────────

const NonEmptyStr = Schema.NonEmptyString;

/** Port number: integer in 1-65535 */
const PortSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 65535));

/** PIN: 4-8 digit string */
const PinSchema = Schema.String.pipe(Schema.pattern(/^\d{4,8}$/));

/** env record: Record<string, string> */
const EnvSchema = Schema.Record({ key: Schema.String, value: Schema.String });

// ─── Per-command schemas ────────────────────────────────────────────────────
// Each command has its own Schema.Struct, discriminated on the "cmd" literal.

const AddProjectSchema = Schema.Struct({
	cmd: Schema.Literal("add_project"),
	directory: NonEmptyStr,
});

const RemoveProjectSchema = Schema.Struct({
	cmd: Schema.Literal("remove_project"),
	slug: NonEmptyStr,
});

const ListProjectsSchema = Schema.Struct({
	cmd: Schema.Literal("list_projects"),
});

const SetProjectTitleSchema = Schema.Struct({
	cmd: Schema.Literal("set_project_title"),
	slug: NonEmptyStr,
	title: Schema.String,
});

const GetStatusSchema = Schema.Struct({
	cmd: Schema.Literal("get_status"),
});

const SetPinSchema = Schema.Struct({
	cmd: Schema.Literal("set_pin"),
	pin: PinSchema,
});

const SetKeepAwakeSchema = Schema.Struct({
	cmd: Schema.Literal("set_keep_awake"),
	enabled: Schema.Boolean,
});

const SetKeepAwakeCommandSchema = Schema.Struct({
	cmd: Schema.Literal("set_keep_awake_command"),
	command: NonEmptyStr,
	args: Schema.optionalWith(Schema.Array(Schema.String), {
		default: () => [],
	}),
});

const ShutdownSchema = Schema.Struct({
	cmd: Schema.Literal("shutdown"),
});

const SetAgentSchema = Schema.Struct({
	cmd: Schema.Literal("set_agent"),
	slug: Schema.String,
	agent: Schema.String,
});

const SetModelSchema = Schema.Struct({
	cmd: Schema.Literal("set_model"),
	slug: Schema.String,
	provider: Schema.String,
	model: Schema.String,
});

const RestartWithConfigSchema = Schema.Struct({
	cmd: Schema.Literal("restart_with_config"),
});

const InstanceListSchema = Schema.Struct({
	cmd: Schema.Literal("instance_list"),
});

// instance_add has complex cross-field validation:
//   - managed instances: require port 1-65535, url forbidden
//   - unmanaged instances: require url or port
//   - url (if present) must be a valid URL
const InstanceAddBaseSchema = Schema.Struct({
	cmd: Schema.Literal("instance_add"),
	name: NonEmptyStr,
	managed: Schema.Boolean,
	port: Schema.optional(PortSchema),
	env: Schema.optional(EnvSchema),
	url: Schema.optional(NonEmptyStr),
});

const InstanceAddSchema = InstanceAddBaseSchema.pipe(
	Schema.filter((cmd) => {
		if (cmd.managed) {
			// Managed instances require a valid port
			if (cmd.port === undefined) {
				return "instance_add requires a valid 'port' (1-65535) for managed instances";
			}
			// Managed instances cannot have a url
			if (cmd.url !== undefined) {
				return "instance_add: 'url' is only valid for unmanaged instances (managed: false)";
			}
		} else {
			// Unmanaged instances need either a url or a port
			if (cmd.url === undefined && cmd.port === undefined) {
				return "instance_add: unmanaged instances require either a 'url' or a valid 'port'";
			}
		}
		// Validate url format if provided
		if (cmd.url !== undefined) {
			try {
				new URL(cmd.url);
			} catch {
				return "instance_add: 'url' must be a valid URL (e.g. http://host:4096)";
			}
		}
		return undefined;
	}),
);

const InstanceRemoveSchema = Schema.Struct({
	cmd: Schema.Literal("instance_remove"),
	id: NonEmptyStr,
});

const InstanceStartSchema = Schema.Struct({
	cmd: Schema.Literal("instance_start"),
	id: NonEmptyStr,
});

const InstanceStopSchema = Schema.Struct({
	cmd: Schema.Literal("instance_stop"),
	id: NonEmptyStr,
});

const InstanceUpdateSchema = Schema.Struct({
	cmd: Schema.Literal("instance_update"),
	id: NonEmptyStr,
	name: Schema.optional(Schema.String),
	env: Schema.optional(EnvSchema),
	port: Schema.optional(Schema.Number),
});

const InstanceStatusSchema = Schema.Struct({
	cmd: Schema.Literal("instance_status"),
	id: NonEmptyStr,
});

// ─── Combined Schema ────────────────────────────────────────────────────────

/**
 * Schema for validating IPC commands.
 * Replaces the manual validateCommand switch-case with declarative validation.
 * The existing IPCCommand type (types.ts) remains the compile-time contract.
 */
export const IPCCommandSchema = Schema.Union(
	AddProjectSchema,
	RemoveProjectSchema,
	ListProjectsSchema,
	SetProjectTitleSchema,
	GetStatusSchema,
	SetPinSchema,
	SetKeepAwakeSchema,
	SetKeepAwakeCommandSchema,
	ShutdownSchema,
	SetAgentSchema,
	SetModelSchema,
	RestartWithConfigSchema,
	InstanceListSchema,
	InstanceAddSchema,
	InstanceRemoveSchema,
	InstanceStartSchema,
	InstanceStopSchema,
	InstanceUpdateSchema,
	InstanceStatusSchema,
);

// ─── VALID_COMMANDS set (kept for backward compat with existing tests) ──────

export const VALID_COMMANDS = new Set([
	"add_project",
	"remove_project",
	"list_projects",
	"set_project_title",
	"get_status",
	"set_pin",
	"set_keep_awake",
	"set_keep_awake_command",
	"shutdown",
	"set_agent",
	"set_model",
	"restart_with_config",
	"instance_list",
	"instance_add",
	"instance_remove",
	"instance_start",
	"instance_stop",
	"instance_update",
	"instance_status",
]);

/** Parse a raw JSON line into an IPCCommand. Returns null on invalid input. */
export function parseCommand(raw: string): IPCCommand | null {
	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.cmd !== "string"
		) {
			return null;
		}
		// Use Schema to decode and apply defaults (e.g., set_keep_awake_command args)
		const result = Schema.decodeUnknownEither(IPCCommandSchema)(parsed);
		if (Either.isRight(result)) {
			return result.right as IPCCommand;
		}
		// Schema rejected it — fall back to raw parsed for backward compat.
		// The router's validateCommand call will catch field-level issues.
		return parsed as IPCCommand;
	} catch {
		return null;
	}
}

/** Serialize a response to a JSON line */
export function serializeResponse(response: IPCResponse): string {
	return `${JSON.stringify(response)}\n`;
}

/** Validate a command has required fields.
 *  Uses IPCCommandSchema for declarative validation, with the same return
 *  semantics as the original switch-case: null = valid, IPCResponse = error.
 *
 *  Accepts a raw parsed record (not yet narrowed) so it can check for
 *  missing fields that the discriminated union would otherwise guarantee.
 *  Tests and parseCommand pass unvalidated objects, so the input type is broad. */
export function validateCommand(
	cmd: Record<string, unknown> & { cmd: string },
): IPCResponse | null {
	if (!VALID_COMMANDS.has(cmd.cmd)) {
		return { ok: false, error: `Unknown command: ${cmd.cmd}` };
	}

	const result = Schema.decodeUnknownEither(IPCCommandSchema)(cmd);
	if (Either.isRight(result)) {
		// Apply side-effect: copy decoded defaults back to the original object.
		// This preserves the set_keep_awake_command args-defaulting behavior
		// that the old code had (mutating cmd["args"] = []).
		const decoded = result.right;
		if (
			"args" in decoded &&
			cmd.cmd === "set_keep_awake_command" &&
			!("args" in cmd)
		) {
			cmd["args"] = (decoded as { args: readonly string[] }).args;
		}
		return null; // Valid
	}

	// Schema validation failed — produce a human-readable error.
	// Map to the same error messages the old switch-case produced.
	return schemaErrorToIPCResponse(cmd);
}

/**
 * Produce error messages matching the original validateCommand output.
 * This ensures backward compatibility for existing tests and consumers.
 */
function schemaErrorToIPCResponse(
	cmd: Record<string, unknown> & { cmd: string },
): IPCResponse {
	switch (cmd.cmd) {
		case "add_project":
			return {
				ok: false,
				error: "add_project requires a non-empty 'directory' field",
			};

		case "remove_project":
			return {
				ok: false,
				error: "remove_project requires a non-empty 'slug' field",
			};

		case "set_project_title":
			if (typeof cmd["slug"] !== "string" || cmd["slug"].length === 0) {
				return {
					ok: false,
					error: "set_project_title requires a non-empty 'slug' field",
				};
			}
			return {
				ok: false,
				error: "set_project_title requires a 'title' field",
			};

		case "set_pin":
			return { ok: false, error: "set_pin requires a 4-8 digit PIN" };

		case "set_keep_awake":
			return {
				ok: false,
				error: "set_keep_awake requires a boolean 'enabled' field",
			};

		case "set_keep_awake_command":
			return {
				ok: false,
				error: "set_keep_awake_command requires a non-empty 'command' field",
			};

		case "set_agent":
			return {
				ok: false,
				error: "set_agent requires 'slug' and 'agent' fields",
			};

		case "set_model":
			return {
				ok: false,
				error: "set_model requires 'slug', 'provider', and 'model' fields",
			};

		case "instance_add":
			return instanceAddError(cmd);

		case "instance_remove":
		case "instance_start":
		case "instance_stop":
		case "instance_status":
			return {
				ok: false,
				error: `${cmd.cmd} requires a non-empty 'id' field`,
			};

		case "instance_update":
			return {
				ok: false,
				error: "instance_update requires a non-empty 'id' field",
			};

		default:
			return { ok: false, error: `Unknown command: ${cmd.cmd}` };
	}
}

/** Produce the correct instance_add error message, matching the original
 *  validation order: name -> managed -> port (managed) -> url (managed) ->
 *  url format -> url-or-port (unmanaged). */
function instanceAddError(
	cmd: Record<string, unknown> & { cmd: string },
): IPCResponse {
	if (typeof cmd["name"] !== "string" || cmd["name"].length === 0) {
		return {
			ok: false,
			error: "instance_add requires a non-empty 'name' field",
		};
	}
	if (typeof cmd["managed"] !== "boolean") {
		return {
			ok: false,
			error: "instance_add requires a boolean 'managed' field",
		};
	}
	if (
		cmd["managed"] &&
		(typeof cmd["port"] !== "number" || cmd["port"] <= 0 || cmd["port"] > 65535)
	) {
		return {
			ok: false,
			error:
				"instance_add requires a valid 'port' (1-65535) for managed instances",
		};
	}
	if (cmd["managed"] && cmd["url"] !== undefined) {
		return {
			ok: false,
			error:
				"instance_add: 'url' is only valid for unmanaged instances (managed: false)",
		};
	}
	if (cmd["url"] !== undefined) {
		if (typeof cmd["url"] !== "string" || cmd["url"].length === 0) {
			return {
				ok: false,
				error: "instance_add: 'url' must be a non-empty string",
			};
		}
		try {
			new URL(cmd["url"] as string);
		} catch {
			return {
				ok: false,
				error:
					"instance_add: 'url' must be a valid URL (e.g. http://host:4096)",
			};
		}
	}
	if (!cmd["managed"]) {
		if (
			cmd["url"] === undefined &&
			(typeof cmd["port"] !== "number" ||
				cmd["port"] <= 0 ||
				cmd["port"] > 65535)
		) {
			return {
				ok: false,
				error:
					"instance_add: unmanaged instances require either a 'url' or a valid 'port'",
			};
		}
	}
	// Fallback — shouldn't reach here, but satisfies exhaustive return
	return { ok: false, error: "instance_add validation failed" };
}

/** Simple command router that dispatches to handler functions */
export function createCommandRouter(handlers: {
	addProject: (directory: string) => Promise<IPCResponse>;
	removeProject: (slug: string) => Promise<IPCResponse>;
	listProjects: () => Promise<IPCResponse>;
	setProjectTitle: (slug: string, title: string) => Promise<IPCResponse>;
	getStatus: () => Promise<IPCResponse>;
	setPin: (pin: string) => Promise<IPCResponse>;
	setKeepAwake: (enabled: boolean) => Promise<IPCResponse>;
	setKeepAwakeCommand: (
		command: string,
		args: string[],
	) => Promise<IPCResponse>;
	shutdown: () => Promise<IPCResponse>;
	setAgent: (slug: string, agent: string) => Promise<IPCResponse>;
	setModel: (
		slug: string,
		provider: string,
		model: string,
	) => Promise<IPCResponse>;
	restartWithConfig: () => Promise<IPCResponse>;
	instanceList: () => Promise<IPCResponse>;
	instanceAdd: (
		name: string,
		port?: number,
		managed?: boolean,
		env?: Record<string, string>,
		url?: string,
	) => Promise<IPCResponse>;
	instanceRemove: (id: string) => Promise<IPCResponse>;
	instanceStart: (id: string) => Promise<IPCResponse>;
	instanceStop: (id: string) => Promise<IPCResponse>;
	instanceUpdate: (
		instanceId: string,
		name?: string,
		env?: Record<string, string>,
		port?: number,
	) => Promise<IPCResponse>;
	instanceStatus: (id: string) => Promise<IPCResponse>;
}) {
	return async function handleCommand(cmd: IPCCommand): Promise<IPCResponse> {
		const validationError = validateCommand(
			cmd as Record<string, unknown> & { cmd: string },
		);
		if (validationError) return validationError;

		switch (cmd.cmd) {
			case "add_project":
				return handlers.addProject(cmd.directory);
			case "remove_project":
				return handlers.removeProject(cmd.slug);
			case "list_projects":
				return handlers.listProjects();
			case "set_project_title":
				return handlers.setProjectTitle(cmd.slug, cmd.title);
			case "get_status":
				return handlers.getStatus();
			case "set_pin":
				return handlers.setPin(cmd.pin);
			case "set_keep_awake":
				return handlers.setKeepAwake(cmd.enabled);
			case "set_keep_awake_command":
				return handlers.setKeepAwakeCommand(cmd.command, cmd.args);
			case "shutdown":
				return handlers.shutdown();
			case "set_agent":
				return handlers.setAgent(cmd.slug, cmd.agent);
			case "set_model":
				return handlers.setModel(cmd.slug, cmd.provider, cmd.model);
			case "restart_with_config":
				return handlers.restartWithConfig();
			case "instance_list":
				return handlers.instanceList();
			case "instance_add":
				return handlers.instanceAdd(
					cmd.name,
					cmd.port,
					cmd.managed,
					cmd.env,
					cmd.url,
				);
			case "instance_remove":
				return handlers.instanceRemove(cmd.id);
			case "instance_start":
				return handlers.instanceStart(cmd.id);
			case "instance_stop":
				return handlers.instanceStop(cmd.id);
			case "instance_update":
				return handlers.instanceUpdate(cmd.id, cmd.name, cmd.env, cmd.port);
			case "instance_status":
				return handlers.instanceStatus(cmd.id);
			default:
				return assertNever(cmd);
		}
	};
}
