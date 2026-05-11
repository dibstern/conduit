// ─── Settings Handlers ───────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { Effect } from "effect";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";

const MAX_PROJECT_TITLE_LENGTH = 100;
const MAX_DIR_ENTRIES = 50;

export const handleGetCommands = (
	clientId: string,
	_payload: PayloadMap["get_commands"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const activeSessionId = wsHandler.getClientSession(clientId);
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const activeProviderId =
			activeSessionId &&
			engineOption._tag === "Some" &&
			typeof engineOption.value.getProviderForSession === "function"
				? engineOption.value.getProviderForSession(activeSessionId)
				: undefined;

		if (activeProviderId === "claude" && engineOption._tag === "Some") {
			const result = yield* Effect.either(
				Effect.tryPromise(() =>
					engineOption.value.dispatch({
						type: "discover",
						providerId: "claude",
					}),
				),
			);
			if (result._tag === "Left") {
				const logOption = yield* Effect.serviceOption(LoggerTag);
				if (logOption._tag === "Some") {
					logOption.value.warn(
						`Failed to discover Claude commands: ${result.left instanceof Error ? result.left.message : result.left}`,
					);
				}
				wsHandler.sendTo(clientId, { type: "command_list", commands: [] });
				return;
			}
			const commands = result.right.commands.map((command) => ({
				name: command.name,
				...(command.description ? { description: command.description } : {}),
				...(command.args ? { args: command.args } : {}),
			}));
			wsHandler.sendTo(clientId, { type: "command_list", commands });
			return;
		}

		const commands = yield* Effect.tryPromise(() => client.app.commands());
		wsHandler.sendTo(clientId, { type: "command_list", commands });
	});

export const handleGetProjects = (
	clientId: string,
	_payload: PayloadMap["get_projects"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const config = yield* ConfigTag;

		let projects: ReadonlyArray<{
			slug: string;
			title: string;
			directory: string;
			instanceId?: string;
		}>;
		if (config.getProjects) {
			projects = config.getProjects();
		} else {
			const ocProjects = yield* Effect.tryPromise(() => client.app.projects());
			projects = ocProjects.map((p) => ({
				slug: p.id ?? "unknown",
				title: p.name ?? p.id ?? "Unknown",
				directory: p.path ?? "",
			}));
		}
		wsHandler.sendTo(clientId, {
			type: "project_list",
			projects,
			current: config.slug,
		});
	});

export const handleAddProject = (
	clientId: string,
	payload: PayloadMap["add_project"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const config = yield* ConfigTag;

		const { directory } = payload;
		if (!directory || typeof directory !== "string") {
			wsHandler.sendTo(
				clientId,
				new RelayError("add_project requires a non-empty 'directory' field", {
					code: "INVALID_REQUEST",
				}).toSystemError(),
			);
			return;
		}
		if (!config.addProject) {
			wsHandler.sendTo(
				clientId,
				new RelayError("Adding projects is not supported in this mode", {
					code: "NOT_SUPPORTED",
				}).toSystemError(),
			);
			return;
		}
		const addProject = config.addProject;
		const addResult = yield* Effect.either(
			Effect.tryPromise(() => {
				const { instanceId } = payload;
				return addProject(directory, instanceId);
			}),
		);
		if (addResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					addResult.left,
					"ADD_PROJECT_FAILED",
				).toSystemError(),
			);
			return;
		}
		const project = addResult.right;
		const updatedProjects = config.getProjects
			? config.getProjects()
			: [project];
		wsHandler.sendTo(clientId, {
			type: "project_list",
			projects: updatedProjects,
			current: config.slug,
			addedSlug: project.slug,
		});
	});

export const handleGetTodo = (
	clientId: string,
	_payload: PayloadMap["get_todo"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.sendTo(clientId, { type: "todo_state", items: [] });
	});

export const handleRemoveProject = (
	clientId: string,
	payload: PayloadMap["remove_project"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const config = yield* ConfigTag;

		const { slug } = payload;
		if (!slug || typeof slug !== "string") {
			wsHandler.sendTo(
				clientId,
				new RelayError("remove_project requires a non-empty 'slug' field", {
					code: "INVALID_REQUEST",
				}).toSystemError(),
			);
			return;
		}
		if (!config.removeProject) {
			wsHandler.sendTo(
				clientId,
				new RelayError("Removing projects is not supported in this mode", {
					code: "NOT_SUPPORTED",
				}).toSystemError(),
			);
			return;
		}
		const removeProject = config.removeProject;
		const removeResult = yield* Effect.either(
			Effect.tryPromise(async () => {
				await removeProject(slug);
			}),
		);
		if (removeResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					removeResult.left,
					"REMOVE_PROJECT_FAILED",
				).toSystemError(),
			);
			return;
		}
		const updatedProjects = config.getProjects ? config.getProjects() : [];
		wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: config.slug,
		});
	});

export const handleRenameProject = (
	clientId: string,
	payload: PayloadMap["rename_project"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const config = yield* ConfigTag;

		const { slug } = payload;
		if (!slug || typeof slug !== "string") {
			wsHandler.sendTo(
				clientId,
				new RelayError("rename_project requires a non-empty 'slug' field", {
					code: "INVALID_REQUEST",
				}).toSystemError(),
			);
			return;
		}
		if (!config.setProjectTitle) {
			wsHandler.sendTo(
				clientId,
				new RelayError("Renaming projects is not supported in this mode", {
					code: "NOT_SUPPORTED",
				}).toSystemError(),
			);
			return;
		}
		let title = (payload.title ?? "").trim();
		if (!title) {
			wsHandler.sendTo(
				clientId,
				new RelayError("rename_project requires a non-empty 'title' field", {
					code: "INVALID_REQUEST",
				}).toSystemError(),
			);
			return;
		}
		title = title.slice(0, MAX_PROJECT_TITLE_LENGTH);
		const setProjectTitle = config.setProjectTitle;
		const renameResult = yield* Effect.either(
			Effect.try(() => setProjectTitle(slug, title)),
		);
		if (renameResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					renameResult.left,
					"RENAME_PROJECT_FAILED",
				).toSystemError(),
			);
			return;
		}
		const updatedProjects = config.getProjects ? config.getProjects() : [];
		wsHandler.broadcast({
			type: "project_list",
			projects: updatedProjects,
			current: config.slug,
		});
	});

export const handleListDirectories = (
	clientId: string,
	payload: PayloadMap["list_directories"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		const rawPath = payload.path ?? "";

		// Resolve ~ to home directory
		let expandedPath = rawPath;
		if (expandedPath.startsWith("~/") || expandedPath === "~") {
			expandedPath = homedir() + expandedPath.slice(1);
		}

		const endsWithSlash = expandedPath.endsWith("/");
		const parentDir = endsWithSlash ? expandedPath : dirname(expandedPath);
		const prefix = endsWithSlash ? "" : basename(expandedPath);
		const showHidden = prefix.startsWith(".");

		let entries: string[] = [];
		const readResult = yield* Effect.either(
			Effect.tryPromise(() => readdir(parentDir, { withFileTypes: true })),
		);
		if (readResult._tag === "Right") {
			const normalizedParent = parentDir.endsWith("/")
				? parentDir
				: `${parentDir}/`;
			entries = readResult.right
				.filter((d) => {
					if (!d.isDirectory()) return false;
					if (!showHidden && d.name.startsWith(".")) return false;
					if (prefix && !d.name.toLowerCase().startsWith(prefix.toLowerCase()))
						return false;
					return true;
				})
				.slice(0, MAX_DIR_ENTRIES)
				.map((d) => `${normalizedParent}${d.name}/`);
		}

		wsHandler.sendTo(clientId, {
			type: "directory_list",
			path: rawPath,
			entries,
		});
	});
