import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	getContextWindow,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("WsRpcServerLayer SwitchContextWindow", () => {
	it.effect("sets the context window and returns the resulting options", () => {
		const contextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		const wsHandler = makeMockWebSocketHandler();
		const engine = withDispatchEffect({
			dispatch: vi.fn(async () => ({
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Claude Sonnet 4.7",
						providerId: "claude",
						contextWindowOptions,
					},
				],
			})),
		} as unknown as OrchestrationEngine);

		return Effect.gen(function* () {
			yield* setModel("session-1", {
				providerID: "claude",
				modelID: "claude-sonnet-4-7",
			});

			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.SwitchContextWindow({
				projectSlug: "project-a",
				sessionId: "session-1",
				contextWindow: "1m",
				originId: "browser-1",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				contextWindow: "1m",
				options: contextWindowOptions,
			});
			expect(yield* getContextWindow("session-1")).toBe("1m");
			expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
				type: "context_window_info",
				contextWindow: "1m",
				options: contextWindowOptions,
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							wsHandler,
							log: makeMockLogger(),
							orchestrationEngine: engine,
						}),
					),
					Layer.provideMerge(Layer.succeed(LoggerTag, makeMockLogger())),
				),
			),
		);
	});
});
