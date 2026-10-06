import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import type { SaveProjectInput } from "../../../src/lib/contracts/ws-rpc.js";
import {
	ProjectManagementNotSupported,
	ProjectManagementServiceError,
	ProjectManagementServiceLive,
	ProjectManagementServiceTag,
} from "../../../src/lib/domain/relay/Services/project-management-service.js";
import {
	ConfigTag,
	type OpenCodeSettingsService,
	OpenCodeSettingsServiceTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { daemonSessionGitCache } from "../../../src/lib/git/session-git.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

const fixtureDirs: string[] = [];
afterEach(() => {
	for (const directory of fixtureDirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const makeSettingsService = (
	overrides: Partial<OpenCodeSettingsService> = {},
): OpenCodeSettingsService => ({
	listCommands: vi.fn(() => Effect.succeed([])),
	listProjects: vi.fn(() => Effect.succeed([])),
	...overrides,
});

const makeLayer = (
	config = makeMockConfig(),
	settingsService = makeSettingsService(),
) =>
	ProjectManagementServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ConfigTag, config),
				Layer.succeed(OpenCodeSettingsServiceTag, settingsService),
			),
		),
	);

describe("ProjectManagementServiceLive", () => {
	it.effect(
		"adds cached git to listed projects without adding a key to uncached projects",
		() => {
			const directory = mkdtempSync(
				join(tmpdir(), "conduit-project-list-git-"),
			);
			fixtureDirs.push(directory);
			execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
				cwd: directory,
			});
			const config = makeMockConfig({
				getProjects: () => [
					{ slug: "cached", title: "Cached", folders: [directory] as const },
					{
						slug: "uncached",
						title: "Uncached",
						folders: [join(directory, "other")] as const,
					},
				],
			});
			return Effect.gen(function* () {
				const git = yield* Effect.promise(() =>
					daemonSessionGitCache.refresh(directory),
				);
				const service = yield* ProjectManagementServiceTag;
				const projects = yield* service.list();
				expect(
					projects.find((project) => project.slug === "cached")?.git,
				).toEqual(git);
				expect(
					projects.find((project) => project.slug === "uncached"),
				).not.toHaveProperty("git");
				expect(
					projects.find((project) => project.slug === "cached"),
				).toHaveProperty("missing", false);
				expect(
					projects.find((project) => project.slug === "uncached"),
				).toHaveProperty("missing", true);
			}).pipe(Effect.provide(makeLayer(config)));
		},
	);

	it.effect("lists only config-backed projects", () => {
		const settingsService = makeSettingsService({
			listProjects: vi.fn(() => Effect.succeed([])),
		});
		const config = makeMockConfig({
			getProjects: () => [
				{
					slug: "proj-1",
					title: "Project 1",
					folders: ["/work/proj-1"] as const,
					instanceId: "inst-1",
				},
			],
		});
		const layer = makeLayer(config, settingsService);

		return Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			const projects = yield* service.list();

			expect(projects).toEqual([
				{
					slug: "proj-1",
					title: "Project 1",
					instanceId: "inst-1",
					missing: true,
					folders: ["/work/proj-1"],
				},
			]);
			expect(settingsService.listProjects).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"does not import OpenCode projects without a registry getter",
		() => {
			const settingsService = makeSettingsService({
				listProjects: vi.fn(() =>
					Effect.succeed([{ id: "p1", name: "Proj 1", path: "/proj1" }]),
				),
			});
			const config = makeMockConfig();
			const layer = makeLayer(config, settingsService);

			return Effect.gen(function* () {
				const service = yield* ProjectManagementServiceTag;
				const projects = yield* service.list();

				expect(projects).toEqual([]);
				expect(settingsService.listProjects).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("reports unsupported project additions as typed errors", () => {
		const settingsService = makeSettingsService();
		const config = makeMockConfig();
		const layer = makeLayer(config, settingsService);

		return Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			const result = yield* Effect.either(
				service.save({ folders: ["/work/new"] }),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(ProjectManagementNotSupported);
				expect(result.left).toMatchObject({
					operation: "save",
					message: "Saving projects is not supported in this mode",
				});
			}
		}).pipe(Effect.provide(layer));
	});

	it.effect("wraps failed project removals with the operation name", () => {
		const removeError = new Error("cannot remove active project");
		const removeProject = vi.fn(() => {
			throw removeError;
		});
		const layer = makeLayer(makeMockConfig({ removeProject }));

		return Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			const result = yield* Effect.either(service.remove("proj-1"));

			expect(removeProject).toHaveBeenCalledWith("proj-1");
			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left).toBeInstanceOf(ProjectManagementServiceError);
				expect(result.left).toMatchObject({
					operation: "remove",
					cause: removeError,
				});
			}
		}).pipe(Effect.provide(layer));
	});

	it.effect("renames projects and returns the refreshed project list", () => {
		const projects = [
			{
				slug: "proj-1",
				title: "Old Title",
				folders: ["/work/proj-1"] as const,
			},
		];
		const saveProject = vi.fn(async (input: SaveProjectInput) => {
			const project = projects.find(
				(candidate) => candidate.slug === input.slug,
			);
			if (!project) throw new Error("Unknown project");
			project.title = input.title ?? project.title;
			return { project, warnings: [] };
		});
		const layer = makeLayer(
			makeMockConfig({
				getProjects: () => projects,
				saveProject,
			}),
		);

		return Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			const input = {
				slug: "proj-1",
				title: "New Title",
				folders: ["/work/proj-1"],
			};
			const updated = yield* service.save(input);

			expect(saveProject).toHaveBeenCalledWith(input);
			expect(updated.projects).toEqual([
				{
					slug: "proj-1",
					title: "New Title",
					folders: ["/work/proj-1"],
					missing: true,
				},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"reports unsupported project instance binding as a typed error",
		() => {
			const layer = makeLayer();

			return Effect.gen(function* () {
				const service = yield* ProjectManagementServiceTag;
				const result = yield* Effect.either(
					service.setProjectInstance("proj-1", "inst-1"),
				);

				expect(result._tag).toBe("Left");
				if (result._tag === "Left") {
					expect(result.left).toBeInstanceOf(ProjectManagementNotSupported);
					expect(result.left).toMatchObject({
						operation: "setInstance",
						message: "Project instance binding not available",
					});
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"sets project instance and returns the updated project list",
		() => {
			const projects = [
				{
					slug: "proj-1",
					title: "Project 1",
					folders: ["/work/proj-1"] as const,
					instanceId: "old",
				},
			];
			const settingsService = makeSettingsService();
			const setProjectInstance = vi.fn((slug: string, instanceId: string) => {
				const project = projects.find((candidate) => candidate.slug === slug);
				if (project) project.instanceId = instanceId;
			});
			const config = makeMockConfig({
				getProjects: () => projects,
				setProjectInstance,
			});
			const layer = makeLayer(config, settingsService);

			return Effect.gen(function* () {
				const service = yield* ProjectManagementServiceTag;
				const updated = yield* service.setProjectInstance("proj-1", "inst-2");

				expect(setProjectInstance).toHaveBeenCalledWith("proj-1", "inst-2");
				expect(updated).toEqual([
					{
						slug: "proj-1",
						title: "Project 1",
						instanceId: "inst-2",
						missing: true,
						folders: ["/work/proj-1"],
					},
				]);
			}).pipe(Effect.provide(layer));
		},
	);
});
