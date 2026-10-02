import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { ProjectManagementServiceLive } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	handleGetCommands,
	handleGetProjects,
} from "../../../src/lib/handlers/settings.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("settings handlers with Effect-native settings service", () => {
	it.effect(
		"loads OpenCode commands without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const settingsService = {
				listCommands: vi.fn(() =>
					Effect.succeed([{ name: "build", description: "Run build" }]),
				),
				listProjects: vi.fn(() => Effect.succeed([])),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeSettingsServiceTag, settingsService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
				Layer.succeed(LoggerTag, makeMockLogger()),
			);

			return handleGetCommands("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(settingsService.listCommands).toHaveBeenCalledOnce();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "command_list",
						commands: [{ name: "build", description: "Run build" }],
					});
				}),
			);
		},
	);

	it.effect(
		"returns no projects without a registry getter and does not query OpenCode",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const settingsService = {
				listCommands: vi.fn(() => Effect.succeed([])),
				listProjects: vi.fn(() =>
					Effect.succeed([{ id: "p1", name: "Proj 1", path: "/proj1" }]),
				),
			};
			const config = makeMockConfig({
				slug: "test-project",
			});
			const settingsLayer = Layer.succeed(
				OpenCodeSettingsServiceTag,
				settingsService,
			);
			const configLayer = Layer.succeed(ConfigTag, config);
			const projectServiceLayer = ProjectManagementServiceLive.pipe(
				Layer.provide(Layer.mergeAll(configLayer, settingsLayer)),
			);

			const layer = Layer.mergeAll(
				settingsLayer,
				projectServiceLayer,
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				configLayer,
			);

			return handleGetProjects("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(settingsService.listProjects).not.toHaveBeenCalled();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "project_list",
						projects: [],
						current: "test-project",
					});
				}),
			);
		},
	);
});
