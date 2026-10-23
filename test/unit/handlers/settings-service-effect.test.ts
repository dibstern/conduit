import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect, vi } from "vitest";

import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { ProjectManagementServiceLive } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeSettingsServiceLive,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import {
	getCommandsForSession,
	getDiscoveredSkillForSession,
} from "../../../src/lib/handlers/settings.js";
import { skillRefFor } from "../../../src/lib/provider/skill-discovery.js";
import type { DiscoveredSkill } from "../../../src/lib/provider/types.js";
import { projectsHandlers } from "../../../src/lib/server/ws-rpc/projects.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("settings reads with Effect-native settings service", () => {
	const settingsReadLayer = (
		settingsLayer: Layer.Layer<OpenCodeSettingsServiceTag>,
	) =>
		Layer.mergeAll(
			makeOverridesStateLive(),
			Layer.succeed(AccountDirectory)(makeMockAccountDirectory()),
			settingsLayer,
			Layer.succeed(OrchestrationEngineTag)(
				withDispatchEffect({
					getProviderForSessionEffect: () => Effect.succeed("opencode"),
				}),
			),
			Layer.succeed(LoggerTag)(makeMockLogger()),
			Layer.succeed(ConfigTag)(makeMockConfig()),
			Layer.succeed(SessionWorkspaceTag)({
				renameBranch: () => Effect.die("unused"),
				get: () => Effect.succeed("/workspace"),
				move: () => Effect.succeed("/workspace"),
				inherit: () => Effect.die("unused"),
				resolve: () => Effect.die("unused"),
				preview: () => Effect.die("unused"),
				record: () => Effect.die("unused"),
				claudeWorktreeState: () => Effect.die("unused"),
				withLaunch: (_sessionId, effect) => effect,
				withProjectLaunch: (effect) => effect,
			}),
		);

	it.effect(
		"restarts OpenCode for explicit skill content lookup while passive listing stays stopped",
		() => {
			const api = makeMockOpenCodeAPI();
			const skill: DiscoveredSkill = {
				name: "review",
				source: "project-skill",
				location: {
					_tag: "File",
					path: "/workspace/review/SKILL.md",
					root: "/workspace/review",
				},
			};
			vi.mocked(api.app.skills).mockResolvedValue([
				{ name: "review", location: "/workspace/review/SKILL.md" },
			]);
			const use = vi.fn(() => Effect.succeed(api));
			const settingsLayer = OpenCodeSettingsServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag)(api),
						Layer.succeed(OpenCodeInstancesTag)({
							...makeOpenCodeInstancesStub(),
							use,
							ifRunning: () => Effect.succeed(Option.none()),
						}),
					),
				),
			);
			return Effect.gen(function* () {
				expect(yield* getCommandsForSession("opencode-session")).toEqual([]);
				expect(use).not.toHaveBeenCalled();
				expect(
					yield* getDiscoveredSkillForSession(
						skillRefFor(skill),
						"opencode-session",
					),
				).toEqual(skill);
				expect(use).toHaveBeenCalledWith("opencode", "/workspace");
			}).pipe(
				Effect.provide(settingsReadLayer(settingsLayer), { local: true }),
			);
		},
	);

	it.effect(
		"loads OpenCode commands without requiring the Promise OpenCode API tag",
		() => {
			const settingsService = {
				listCatalog: vi.fn(() =>
					Effect.succeed({
						commands: [{ name: "build", description: "Run build" }],
						skills: [],
					}),
				),
				listProjects: vi.fn(() => Effect.succeed([])),
			};

			const layer = settingsReadLayer(
				Layer.succeed(OpenCodeSettingsServiceTag)(settingsService),
			);

			return getCommandsForSession(undefined).pipe(
				Effect.provide(layer, { local: true }),
				Effect.tap((commands) =>
					Effect.sync(() => {
						expect(settingsService.listCatalog).toHaveBeenCalledOnce();
						expect(commands).toEqual([
							{ name: "build", description: "Run build" },
						]);
					}),
				),
			);
		},
	);

	it.effect(
		"returns no projects without a registry getter and does not query OpenCode",
		() => {
			const settingsService = {
				listCatalog: vi.fn(() => Effect.succeed({ commands: [], skills: [] })),
				listProjects: vi.fn(() =>
					Effect.succeed([{ id: "p1", name: "Proj 1", path: "/proj1" }]),
				),
			};
			const config = makeMockConfig({
				slug: "test-project",
			});
			const settingsLayer = Layer.succeed(OpenCodeSettingsServiceTag)(
				settingsService,
			);
			const configLayer = Layer.succeed(ConfigTag)(config);
			const projectServiceLayer = ProjectManagementServiceLive.pipe(
				Layer.provide(Layer.mergeAll(configLayer, settingsLayer)),
			);

			const layer = Layer.mergeAll(
				settingsLayer,
				projectServiceLayer,
				configLayer,
			);

			return projectsHandlers
				.GetProjects({ _tag: "GetProjects", projectSlug: "test-project" })
				.pipe(
					Effect.provide(layer, { local: true }),
					Effect.tap((reply) =>
						Effect.sync(() => {
							expect(settingsService.listProjects).not.toHaveBeenCalled();
							expect(reply).toEqual({
								projectSlug: "test-project",
								projects: [],
								current: "test-project",
							});
						}),
					),
				);
		},
	);
});
