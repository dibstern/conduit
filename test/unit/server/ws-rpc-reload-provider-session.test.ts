import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("WsRpcServerLayer ReloadProviderSession", () => {
	it.effect(
		"ends the requested provider session and refreshes browser state",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const api = makeMockOpenCodeAPI();
			api.provider.list = vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [{ id: "gpt-4", name: "GPT-4" }],
					},
				],
			})) as typeof api.provider.list;
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({ models: [], commands: [] })),
			} as unknown as OrchestrationEngine);

			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.ReloadProviderSession({
					projectSlug: "project-a",
					sessionId: "session-1",
					originId: "browser-1",
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					sessionId: "session-1",
				});
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "end_session",
					sessionId: "session-1",
				});
				expect(wsHandler.sendTo).toHaveBeenCalledWith(
					"browser-1",
					expect.objectContaining({ type: "model_list" }),
				);
				expect(wsHandler.sendTo).toHaveBeenCalledWith("browser-1", {
					type: "command_list",
					commands: [],
				});
				expect(wsHandler.sendTo).toHaveBeenCalledWith("browser-1", {
					type: "provider_session_reloaded",
					sessionId: "session-1",
				});
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								wsHandler,
								log: makeMockLogger(),
								orchestrationEngine: engine,
							}),
						),
					),
				),
			);
		},
	);
});
