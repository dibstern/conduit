// ─── IPC Protocol (Ticket 3.2) ──────────────────────────────────────────────
// Command routing and validation for the JSON-lines IPC protocol.

import type { IPCCommand, IPCResponse } from "../types.js";
import { assertNever } from "../utils.js";

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
 *  Accepts a raw parsed record (not yet narrowed) so it can check for
 *  missing fields that the discriminated union would otherwise guarantee.
 *  Tests and parseCommand pass unvalidated objects, so the input type is broad. */
export function validateCommand(
	cmd: Record<string, unknown> & { cmd: string },
): IPCResponse | null {
	if (!VALID_COMMANDS.has(cmd.cmd)) {
		return { ok: false, error: `Unknown command: ${cmd.cmd}` };
	}

	switch (cmd.cmd) {
		case "add_project":
			if (
				typeof cmd["directory"] !== "string" ||
				cmd["directory"].length === 0
			) {
				return {
					ok: false,
					error: "add_project requires a non-empty 'directory' field",
				};
			}
			break;

		case "remove_project":
			if (typeof cmd["slug"] !== "string" || cmd["slug"].length === 0) {
				return {
					ok: false,
					error: "remove_project requires a non-empty 'slug' field",
				};
			}
			break;

		case "set_project_title":
			if (typeof cmd["slug"] !== "string" || cmd["slug"].length === 0) {
				return {
					ok: false,
					error: "set_project_title requires a non-empty 'slug' field",
				};
			}
			if (typeof cmd["title"] !== "string") {
				return {
					ok: false,
					error: "set_project_title requires a 'title' field",
				};
			}
			break;

		case "set_pin":
			if (typeof cmd["pin"] !== "string" || !/^\d{4,8}$/.test(cmd["pin"])) {
				return { ok: false, error: "set_pin requires a 4-8 digit PIN" };
			}
			break;

		case "set_keep_awake":
			if (typeof cmd["enabled"] !== "boolean") {
				return {
					ok: false,
					error: "set_keep_awake requires a boolean 'enabled' field",
				};
			}
			break;

		case "set_keep_awake_command":
			if (typeof cmd["command"] !== "string" || cmd["command"].length === 0) {
				return {
					ok: false,
					error: "set_keep_awake_command requires a non-empty 'command' field",
				};
			}
			if (!Array.isArray(cmd["args"])) {
				// Default to empty array if not provided
				cmd["args"] = [];
			}
			break;

		case "set_agent":
			if (typeof cmd["slug"] !== "string" || typeof cmd["agent"] !== "string") {
				return {
					ok: false,
					error: "set_agent requires 'slug' and 'agent' fields",
				};
			}
			break;

		case "set_model":
			if (
				typeof cmd["slug"] !== "string" ||
				typeof cmd["provider"] !== "string" ||
				typeof cmd["model"] !== "string"
			) {
				return {
					ok: false,
					error: "set_model requires 'slug', 'provider', and 'model' fields",
				};
			}
			break;

		case "restart_with_config":
			// No required fields — restarts daemon with current config
			break;

		case "instance_add":
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
				(typeof cmd["port"] !== "number" ||
					cmd["port"] <= 0 ||
					cmd["port"] > 65535)
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
				// Unmanaged instances need either a url or a port
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
			break;

		case "instance_remove":
		case "instance_start":
		case "instance_stop":
		case "instance_status":
			if (typeof cmd["id"] !== "string" || cmd["id"].length === 0) {
				return {
					ok: false,
					error: `${cmd.cmd} requires a non-empty 'id' field`,
				};
			}
			break;

		case "instance_update":
			if (typeof cmd["id"] !== "string" || cmd["id"].length === 0) {
				return {
					ok: false,
					error: "instance_update requires a non-empty 'id' field",
				};
			}
			break;

		case "instance_list":
			break;
	}

	return null; // Valid
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
