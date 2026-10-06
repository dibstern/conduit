import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { GetProjects } from "../../../src/lib/contracts/ws-rpc.js";
import { ProjectManagementServiceLive } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { getCommandsForSession } from "../../../src/lib/handlers/settings.js";
import { projectsHandlers } from "../../../src/lib/server/ws-rpc/projects.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("settings reads with Effect-native settings service", () => {
	it.effect(
		"loads OpenCode commands without requiring the Promise OpenCode API tag",
		() => {
			const settingsService = {
				listCommands: vi.fn(() =>
					Effect.succeed([{ name: "build", description: "Run build" }]),
				),
				listProjects: vi.fn(() => Effect.succeed([])),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeSettingsServiceTag, settingsService),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
				Layer.succeed(LoggerTag, makeMockLogger()),
			);

			return getCommandsForSession(undefined).pipe(
				Effect.provide(layer),
				Effect.tap((commands) => {
					expect(settingsService.listCommands).toHaveBeenCalledOnce();
					expect(commands).toEqual([
						{ name: "build", description: "Run build" },
					]);
				}),
			);
		},
	);

	it.effect(
		"returns no projects without a registry getter and does not query OpenCode",
		() => {
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
				configLayer,
			);

			return projectsHandlers
				.GetProjects(new GetProjects({ projectSlug: "test-project" }))
				.pipe(
					Effect.provide(layer),
					Effect.tap((reply) => {
						expect(settingsService.listProjects).not.toHaveBeenCalled();
						expect(reply).toEqual({
							projectSlug: "test-project",
							projects: [],
							current: "test-project",
						});
					}),
				);
		},
	);
});
