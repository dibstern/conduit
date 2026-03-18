// ─── Settings Handlers ───────────────────────────────────────────────────────

import { RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetCommands(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_commands"],
): Promise<void> {
	const commands = await deps.client.listCommands();
	deps.wsHandler.sendTo(clientId, { type: "command_list", commands });
}

export async function handleGetProjects(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_projects"],
): Promise<void> {
	let projects: ReadonlyArray<{
		slug: string;
		title: string;
		directory: string;
		instanceId?: string;
	}>;
	if (deps.config.getProjects) {
		projects = deps.config.getProjects();
	} else {
		const ocProjects = await deps.client.listProjects();
		projects = ocProjects.map((p) => ({
			slug: p.id ?? "unknown",
			title: p.name ?? p.id ?? "Unknown",
			directory: p.path ?? "",
		}));
	}
	deps.wsHandler.sendTo(clientId, {
		type: "project_list",
		projects,
		current: deps.config.slug,
	});
}

export async function handleAddProject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["add_project"],
): Promise<void> {
	const { directory } = payload;
	if (!directory || typeof directory !== "string") {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("add_project requires a non-empty 'directory' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	if (!deps.config.addProject) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Adding projects is not supported in this mode", {
				code: "NOT_SUPPORTED",
			}).toMessage(),
		);
		return;
	}
	try {
		const { instanceId } = payload;
		const project = await deps.config.addProject(directory, instanceId);
		// Send back the updated project list with addedSlug so the frontend
		// can auto-navigate to the newly created project.
		const updatedProjects = deps.config.getProjects
			? deps.config.getProjects()
			: [project];
		deps.wsHandler.sendTo(clientId, {
			type: "project_list",
			projects: updatedProjects,
			current: deps.config.slug,
			addedSlug: project.slug,
		});
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "ADD_PROJECT_FAILED").toMessage(),
		);
	}
}

export async function handleGetTodo(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_todo"],
): Promise<void> {
	deps.wsHandler.sendTo(clientId, { type: "todo_state", items: [] });
}
