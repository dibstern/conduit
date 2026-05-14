import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetProjects", () => {
	it.effect("returns project list and current project slug", () => {
		const config = makeMockConfig({
			slug: "project-a",
			getProjects: () => [
				{
					slug: "project-a",
					title: "Project A",
					directory: "/tmp/project-a",
					clientCount: 2,
				},
				{
					slug: "project-b",
					title: "Project B",
					directory: "/tmp/project-b",
					instanceId: "inst-1",
				},
			],
		});

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetProjects({
				projectSlug: "project-a",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				current: "project-a",
				projects: [
					{
						slug: "project-a",
						title: "Project A",
						directory: "/tmp/project-a",
						clientCount: 2,
					},
					{
						slug: "project-b",
						title: "Project B",
						directory: "/tmp/project-b",
						instanceId: "inst-1",
					},
				],
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
});
