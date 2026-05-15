// ─── Settings Handlers ───────────────────────────────────────────────────────

import { Effect } from "effect";
import { ProjectManagementServiceTag } from "../domain/relay/Services/project-management-service.js";
import {
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import type { TodoItem } from "../shared-types.js";

export const MAX_PROJECT_TITLE_LENGTH = 100;

export const normalizeProjectTitle = (title: string): string =>
	title.trim().slice(0, MAX_PROJECT_TITLE_LENGTH);

export const handleGetCommands = (
	clientId: string,
	_payload: Record<string, never>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const activeSessionId = wsHandler.getClientSession(clientId);
		const commands = yield* getCommandsForSession(activeSessionId);
		wsHandler.sendTo(clientId, { type: "command_list", commands });
	});

export const getCommandsForSession = (activeSessionId: string | undefined) =>
	Effect.gen(function* () {
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		const activeProviderId =
			activeSessionId &&
			engineOption._tag === "Some" &&
			typeof engineOption.value.getProviderForSession === "function"
				? engineOption.value.getProviderForSession(activeSessionId)
				: undefined;

		if (activeProviderId === "claude" && engineOption._tag === "Some") {
			const result = yield* Effect.either(
				engineOption.value.dispatchEffect({
					type: "discover",
					providerId: "claude",
				}),
			);
			if (result._tag === "Left") {
				const logOption = yield* Effect.serviceOption(LoggerTag);
				if (logOption._tag === "Some") {
					logOption.value.warn(
						`Failed to discover Claude commands: ${result.left instanceof Error ? result.left.message : result.left}`,
					);
				}
				return [];
			}
			return result.right.commands.map((command) => ({
				name: command.name,
				...(command.description ? { description: command.description } : {}),
				...(command.args ? { args: command.args } : {}),
			}));
		}

		const settingsService = yield* OpenCodeSettingsServiceTag;
		return yield* settingsService.listCommands();
	});

export const handleGetProjects = (
	clientId: string,
	_payload: Record<string, never>,
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

export const getTodoState = (): Effect.Effect<readonly TodoItem[]> =>
	Effect.succeed([]);
