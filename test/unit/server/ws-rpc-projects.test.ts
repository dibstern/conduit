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
	instanceId: "inst-1",
};

describe("WsRpcServerLayer project management", () => {
	it.effect("adds a project and returns the added slug", () => {
		const addProject = vi.fn(async () => project);
		const config = makeMockConfig({
			slug: "proj-1",
			addProject,
			getProjects: () => [project],
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.AddProject({
				projectSlug: "proj-1",
				directory: "/work/proj-1",
				instanceId: "inst-1",
			});

			expect(addProject).toHaveBeenCalledWith("/work/proj-1", "inst-1");
			expect(response).toEqual({
				projectSlug: "proj-1",
				projects: [project],
				current: "proj-1",
				addedSlug: "proj-1",
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
		const setProjectTitle = vi.fn(() => undefined);
		const wsHandler = makeMockWebSocketHandler();
		const config = makeMockConfig({
			slug: "proj-1",
			setProjectTitle,
			getProjects: () => [renamed],
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.RenameProject({
				projectSlug: "proj-1",
				slug: "proj-1",
				title: "Renamed",
			});

			expect(setProjectTitle).toHaveBeenCalledWith("proj-1", "Renamed");
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
