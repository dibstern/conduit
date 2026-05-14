import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetTodo", () => {
	it.effect("returns the current todo state", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetTodo({
				projectSlug: "project-a",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				items: [],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
			),
		),
	);
});
