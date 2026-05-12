import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ConfigTag,
	OpenCodeSettingsServiceTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	handleGetCommands,
	handleGetProjects,
} from "../../../src/lib/handlers/settings.js";
import {
	makeMockConfig,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

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
		"loads OpenCode fallback projects without requiring the Promise OpenCode API tag",
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

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeSettingsServiceTag, settingsService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(ConfigTag, config),
			);

			return handleGetProjects("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(settingsService.listProjects).toHaveBeenCalledOnce();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "project_list",
						projects: [{ slug: "p1", title: "Proj 1", directory: "/proj1" }],
						current: "test-project",
					});
				}),
			);
		},
	);
});
