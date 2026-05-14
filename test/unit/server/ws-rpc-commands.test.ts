import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetCommands", () => {
	it.effect("returns OpenCode command metadata", () => {
		const api = makeMockOpenCodeAPI();
		api.app.commands = vi.fn(async () => [
			{ name: "init", description: "Initialize a project" },
			{ name: "review" },
		]) as typeof api.app.commands;

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetCommands({
				projectSlug: "project-a",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				commands: [
					{ name: "init", description: "Initialize a project" },
					{ name: "review" },
				],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ api })),
				),
			),
		);
	});
});
