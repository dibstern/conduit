// ─── Settings Handlers ───────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
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

export async function handleRemoveProject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["remove_project"],
): Promise<void> {
	const { slug } = payload;
	if (!slug || typeof slug !== "string") {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("remove_project requires a non-empty 'slug' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	if (!deps.config.removeProject) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Removing projects is not supported in this mode", {
				code: "NOT_SUPPORTED",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.config.removeProject(slug);
		const updatedProjects = deps.config.getProjects
			? deps.config.getProjects()
			: [];
		deps.wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: deps.config.slug,
		});
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "REMOVE_PROJECT_FAILED").toMessage(),
		);
	}
}

const MAX_PROJECT_TITLE_LENGTH = 100;

export async function handleRenameProject(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["rename_project"],
): Promise<void> {
	const { slug } = payload;
	if (!slug || typeof slug !== "string") {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("rename_project requires a non-empty 'slug' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	if (!deps.config.setProjectTitle) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Renaming projects is not supported in this mode", {
				code: "NOT_SUPPORTED",
			}).toMessage(),
		);
		return;
	}
	let title = (payload.title ?? "").trim();
	if (!title) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("rename_project requires a non-empty 'title' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	title = title.slice(0, MAX_PROJECT_TITLE_LENGTH);
	try {
		deps.config.setProjectTitle(slug, title);
		const updatedProjects = deps.config.getProjects
			? deps.config.getProjects()
			: [];
		deps.wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: deps.config.slug,
		});
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(err, "RENAME_PROJECT_FAILED").toMessage(),
		);
	}
}

const MAX_DIR_ENTRIES = 50;

export async function handleListDirectories(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["list_directories"],
): Promise<void> {
	const rawPath = payload.path ?? "";

	// Resolve ~ to home directory
	let expandedPath = rawPath;
	if (expandedPath.startsWith("~/") || expandedPath === "~") {
		expandedPath = homedir() + expandedPath.slice(1);
	}

	// Split into parent directory and prefix
	const endsWithSlash = expandedPath.endsWith("/");
	const parentDir = endsWithSlash ? expandedPath : dirname(expandedPath);
	const prefix = endsWithSlash ? "" : basename(expandedPath);
	const showHidden = prefix.startsWith(".");

	let entries: string[] = [];
	try {
		const dirents = await readdir(parentDir, { withFileTypes: true });
		const normalizedParent = parentDir.endsWith("/")
			? parentDir
			: `${parentDir}/`;

		entries = dirents
			.filter((d) => {
				if (!d.isDirectory()) return false;
				if (!showHidden && d.name.startsWith(".")) return false;
				if (prefix && !d.name.toLowerCase().startsWith(prefix.toLowerCase()))
					return false;
				return true;
			})
			.slice(0, MAX_DIR_ENTRIES)
			.map((d) => `${normalizedParent}${d.name}/`);
	} catch {
		// Directory doesn't exist or isn't readable — return empty
	}

	deps.wsHandler.sendTo(clientId, {
		type: "directory_list",
		path: rawPath,
		entries,
	});
}
