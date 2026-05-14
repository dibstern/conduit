import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer SwitchAgent", () => {
	it.effect("sets the active agent for the requested session", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			yield* client.SwitchAgent({
				projectSlug: "project-a",
				sessionId: "session-1",
				agentId: "plan",
				originId: "browser-1",
			});

			const agentService = yield* AgentServiceTag;
			const active = yield* agentService.getActiveAgent("session-1");
			expect(active).toBe("plan");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
			),
		),
	);
});
