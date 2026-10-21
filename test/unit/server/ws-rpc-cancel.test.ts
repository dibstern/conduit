import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer CancelSession", () => {
	it.effect("routes OpenCode sessions through the orchestration engine", () => {
		const abort = vi.fn(async () => undefined);
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("opencode")),
			dispatchEffect: vi.fn(() => Effect.void),
		});
		const api = makeMockOpenCodeAPI();
		api.session.abort = abort as typeof api.session.abort;

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CancelSession({
				sessionId: "session-1",
				commandId: "cmd-stop-opencode",
			});

			expect(result).toEqual({ ok: true });
			expect(abort).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).toHaveBeenCalledExactlyOnceWith({
				type: "interrupt_turn",
				commandId: "cmd-stop-opencode",
				sessionId: "session-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							orchestrationEngine: engine,
							seedEvents: [
								canonicalEvent("session.created", "session-1", {
									sessionId: "session-1",
									title: "OpenCode session",
									provider: "opencode",
								}),
							],
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("routes Claude sessions through the orchestration engine", () => {
		const abort = vi.fn(async () => undefined);
		const dispatch = vi.fn(async () => ({
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		}));
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch,
		});
		const api = makeMockOpenCodeAPI();
		api.session.abort = abort as typeof api.session.abort;

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CancelSession({
				sessionId: "session-claude",
				commandId: "cmd-stop-1",
			});

			expect(result).toEqual({ ok: true });
			expect(abort).not.toHaveBeenCalled();
			expect(engine.dispatchEffect).toHaveBeenCalledWith({
				type: "interrupt_turn",
				commandId: "cmd-stop-1",
				sessionId: "session-claude",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							orchestrationEngine: engine,
						}),
					),
				),
				{ local: true },
			),
		);
	});
});
