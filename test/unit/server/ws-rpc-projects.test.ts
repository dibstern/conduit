import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { ProjectManagementService } from "../../../src/lib/domain/relay/Services/project-management-service.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

const project = {
	slug: "proj-1",
	title: "Project 1",
	folders: ["/work/proj-1"] as const,
	missing: true,
};

const makeService = (
	projects: readonly (typeof project)[],
): ProjectManagementService => ({
	currentSlug: () => Effect.succeed(project.slug),
	list: () => Effect.succeed(projects),
	save: vi.fn(() =>
		Effect.succeed({ project: projects[0] ?? project, projects, warnings: [] }),
	),
	remove: vi.fn(() => Effect.succeed(projects)),
});

describe("WsRpcServerLayer project management", () => {
	it.effect(
		"round-trips project git state through the RPC project list",
		() => {
			const projectWithGit = {
				...project,
				git: {
					branch: "feature",
					worktree: "linked",
					dirty: true,
					ahead: 2,
					behind: 1,
				},
			};
			const config = makeMockConfig({
				slug: project.slug,
			});
			const service = makeService([projectWithGit]);
			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const response = yield* client.SaveProject({
					projectSlug: project.slug,
					folders: project.folders,
				});
				expect(response.projects).toEqual([projectWithGit]);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								config,
								projectManagementService: service,
							}),
						),
					),
				),
			);
		},
	);

	it.effect("adds a project and returns the added slug", () => {
		const service = makeService([project]);
		const saveProject = vi.mocked(service.save);
		const config = makeMockConfig({
			slug: "proj-1",
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.SaveProject({
				projectSlug: "proj-1",
				folders: ["/work/proj-1"],
			});

			expect(saveProject).toHaveBeenCalledWith({
				folders: ["/work/proj-1"],
			});
			expect(response).toEqual({
				projectSlug: "proj-1",
				projects: [project],
				current: "proj-1",
				savedSlug: "proj-1",
				warnings: [],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ config, projectManagementService: service }),
					),
				),
			),
		);
	});

	it.effect("removes a project and returns the updated list", () => {
		const service = makeService([]);
		const removeProject = vi.mocked(service.remove);
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.RemoveProject({
				projectSlug: "proj-1",
				slug: "proj-1",
			});

			expect(removeProject).toHaveBeenCalledWith("proj-1");
			expect(response).toEqual({
				projectSlug: "proj-1",
				projects: [],
				current: "proj-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config,
							wsHandler,
							projectManagementService: service,
						}),
					),
				),
			),
		);
	});

	it.effect("renames a project and returns the updated list", () => {
		const renamed = { ...project, title: "Renamed" };
		const service = makeService([renamed]);
		const saveProject = vi.mocked(service.save);
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.SaveProject({
				projectSlug: "proj-1",
				slug: "proj-1",
				title: "Renamed",
				folders: project.folders,
			});

			expect(saveProject).toHaveBeenCalledWith({
				slug: "proj-1",
				title: "Renamed",
				folders: project.folders,
			});
			expect(response.projects).toEqual([renamed]);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							config,
							wsHandler,
							projectManagementService: service,
						}),
					),
				),
			),
		);
	});
});
