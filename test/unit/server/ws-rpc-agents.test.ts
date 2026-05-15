import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { setAgent } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetAgents", () => {
	it.effect("returns filtered agents and the active session override", () => {
		const api = makeMockOpenCodeAPI();
		api.app.agents = vi.fn(async () => [
			{ id: "build", name: "build", description: "Build things" },
			{ id: "plan", name: "plan" },
			{ id: "hidden", name: "hidden", hidden: true },
			{ id: "summarize", name: "summarize" },
		]) as typeof api.app.agents;

		return Effect.gen(function* () {
			yield* setAgent("session-1", "plan");
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetAgents({
				projectSlug: "project-a",
				sessionId: "session-1",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				agents: [
					{ id: "build", name: "build", description: "Build things" },
					{ id: "plan", name: "plan" },
				],
				activeAgentId: "plan",
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
