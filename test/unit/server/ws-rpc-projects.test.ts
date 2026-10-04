import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
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
	directory: "/work/proj-1",
	folders: ["/work/proj-1"],
	instanceId: "inst-1",
	missing: true,
};

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
				saveProject: vi.fn(async () => ({
					project: projectWithGit,
					warnings: [],
				})),
				getProjects: () => [projectWithGit],
			});
			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const response = yield* client.SaveProject({
					projectSlug: project.slug,
					folders: project.folders,
					instanceId: project.instanceId,
				});
				expect(response.projects).toEqual([projectWithGit]);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(makeTestHandlerLayer({ config })),
					),
				),
			);
		},
	);

	it.effect("adds a project and returns the added slug", () => {
		const saveProject = vi.fn(async () => ({ project, warnings: [] }));
		const config = makeMockConfig({
			slug: "proj-1",
			saveProject,
			getProjects: () => [project],
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.SaveProject({
				projectSlug: "proj-1",
				folders: ["/work/proj-1"],
				instanceId: "inst-1",
			});

			expect(saveProject).toHaveBeenCalledWith({
				folders: ["/work/proj-1"],
				instanceId: "inst-1",
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
					Layer.provideMerge(makeTestHandlerLayer({ config })),
				),
			),
		);
	});

	it.effect("removes a project and broadcasts the updated list", () => {
		const removeProject = vi.fn(async () => undefined);
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
			removeProject,
			getProjects: () => [],
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
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "project_list",
				projects: [],
				current: "proj-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ config, wsHandler })),
				),
			),
		);
	});

	it.effect("renames a project and broadcasts the updated list", () => {
		const renamed = { ...project, title: "Renamed" };
		const saveProject = vi.fn(async () => ({ project: renamed, warnings: [] }));
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
			saveProject,
			getProjects: () => [renamed],
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
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "project_list",
				projects: [renamed],
				current: "proj-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ config, wsHandler })),
				),
			),
		);
	});

	it.effect("sets a project instance and broadcasts the updated list", () => {
		const rebound = { ...project, instanceId: "inst-2" };
		const setProjectInstance = vi.fn(async () => undefined);
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
			setProjectInstance,
			getProjects: () => [rebound],
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.SetProjectInstance({
				projectSlug: "proj-1",
				slug: "proj-1",
				instanceId: "inst-2",
			});

			expect(setProjectInstance).toHaveBeenCalledWith("proj-1", "inst-2");
			expect(response.projects).toEqual([rebound]);
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "project_list",
				projects: [rebound],
				current: "proj-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ config, wsHandler })),
				),
			),
		);
	});
});
