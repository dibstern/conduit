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
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer CancelSession", () => {
	it.effect("aborts an OpenCode session", () => {
		const abort = vi.fn(async () => undefined);
		const api = makeMockOpenCodeAPI();
		api.session.abort = abort as typeof api.session.abort;

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CancelSession({
				projectSlug: "project-a",
				sessionId: "session-1",
				commandId: "cmd-stop-opencode",
			});

			expect(result).toEqual({ ok: true });
			expect(abort).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ api })),
				),
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
				projectSlug: "project-a",
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
			),
		);
	});
});
