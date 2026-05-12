// ─── Settings Handlers ───────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { Effect } from "effect";
import {
	type ProjectManagementNotSupported,
	type ProjectManagementServiceError,
	ProjectManagementServiceTag,
} from "../effect/project-management-service.js";
import {
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { type ErrorCode, RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";

const MAX_PROJECT_TITLE_LENGTH = 100;
const MAX_DIR_ENTRIES = 50;

const toProjectSystemError = (
	error: ProjectManagementServiceError | ProjectManagementNotSupported,
	code: ErrorCode,
) => {
	if (error._tag === "ProjectManagementNotSupported") {
		return new RelayError(error.message, {
			code: "NOT_SUPPORTED",
		}).toSystemError();
	}
	return RelayError.fromCaught(error.cause, code).toSystemError();
};

export const handleGetCommands = (
	clientId: string,
	_payload: PayloadMap["get_commands"],
) =>
	Effect.gen(function* () {
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

		const settingsService = yield* OpenCodeSettingsServiceTag;
		const commands = yield* settingsService.listCommands();
		wsHandler.sendTo(clientId, { type: "command_list", commands });
	});

export const handleGetProjects = (
	clientId: string,
	_payload: PayloadMap["get_projects"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const projectService = yield* ProjectManagementServiceTag;
		const projects = yield* projectService
			.list()
			.pipe(Effect.mapError((error) => error.cause));
		const current = yield* projectService.currentSlug();
		wsHandler.sendTo(clientId, {
			type: "project_list",
			projects,
			current,
		});
	});

export const handleAddProject = (
	clientId: string,
	payload: PayloadMap["add_project"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const projectService = yield* ProjectManagementServiceTag;

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
		const addResult = yield* Effect.either(
			projectService.add(directory, payload.instanceId),
		);
		if (addResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				toProjectSystemError(addResult.left, "ADD_PROJECT_FAILED"),
			);
			return;
		}
		const current = yield* projectService.currentSlug();
		wsHandler.sendTo(clientId, {
			type: "project_list",
			projects: addResult.right.projects,
			current,
			addedSlug: addResult.right.project.slug,
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
		const projectService = yield* ProjectManagementServiceTag;

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
		const removeResult = yield* Effect.either(projectService.remove(slug));
		if (removeResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				toProjectSystemError(removeResult.left, "REMOVE_PROJECT_FAILED"),
			);
			return;
		}
		const current = yield* projectService.currentSlug();
		wsHandler.broadcast({
			type: "project_list",
			projects: removeResult.right,
			current,
		});
	});

export const handleRenameProject = (
	clientId: string,
	payload: PayloadMap["rename_project"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const projectService = yield* ProjectManagementServiceTag;

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
		const renameResult = yield* Effect.either(
			projectService.rename(slug, title),
		);
		if (renameResult._tag === "Left") {
			wsHandler.sendTo(
				clientId,
				toProjectSystemError(renameResult.left, "RENAME_PROJECT_FAILED"),
			);
			return;
		}
		const current = yield* projectService.currentSlug();
		wsHandler.broadcast({
			type: "project_list",
			projects: renameResult.right,
			current,
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
