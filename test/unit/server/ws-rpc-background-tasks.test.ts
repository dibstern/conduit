import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { BackgroundLivenessTag } from "../../../src/lib/domain/relay/Services/services.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("StopBackgroundTask RPC", () => {
	const request = {
		projectSlug: "project-a",
		sessionId: "session-1",
		taskId: "shell",
	};
	const setup = (providerId = "claude") => {
		const stopTaskEffect = vi.fn(
			(
				_sessionId: string,
				_taskId: string,
			): Effect.Effect<void, ProviderInstanceFailure> => Effect.void,
		);
		const interruptTurnEffect = vi.fn(() => Effect.void);
		const provider: ProviderInstance = {
			providerId,
			steering: false,
			discoverEffect: () => Effect.die("unused"),
			sendTurnEffect: () => Effect.die("unused"),
			interruptTurnEffect,
			resolvePermissionEffect: () => Effect.void,
			resolveQuestionEffect: () => Effect.void,
			shutdownEffect: () => Effect.void,
			endSessionEffect: () => Effect.void,
			...(providerId === "claude" ? { stopTaskEffect } : {}),
		};
		const engine = withDispatchEffect({
			getProviderForSessionEffect: () => Effect.succeed(providerId),
			dispatch: vi.fn(async () => undefined),
		});
		let live = true;
		const layer = WsRpcServerLayer.pipe(
			Layer.provideMerge(
				Layer.merge(
					makeTestHandlerLayer({
						providerRegistry: new ProviderRegistry([provider]),
						orchestrationEngine: engine,
					}),
					Layer.succeed(BackgroundLivenessTag, () =>
						live
							? {
									work: "monitoring" as const,
									tasks: [
										{
											id: "shell",
											type: "local_bash",
											description: "Watch",
											firstSeenAt: 0,
										},
									],
								}
							: undefined,
					),
				),
			),
		);
		return {
			stopTaskEffect,
			interruptTurnEffect,
			layer,
			engine,
			finish: () => {
				live = false;
			},
		};
	};

	it.effect("stops the bound task without changing turn orchestration", () => {
		const state = setup();
		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.StopBackgroundTask(request);
			expect(result).toEqual({ ok: true });
			expect(state.stopTaskEffect).toHaveBeenCalledWith("session-1", "shell");
			expect(state.interruptTurnEffect).not.toHaveBeenCalled();
			expect(state.engine.dispatchEffect).not.toHaveBeenCalled();
		}).pipe(Effect.scoped, Effect.provide(state.layer));
	});

	it.effect(
		"treats already-finished tasks and duplicate clients as no-ops",
		() => {
			const state = setup();
			state.finish();
			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const first = yield* client.StopBackgroundTask(request);
				const second = yield* client.StopBackgroundTask(request);
				expect(first).toEqual({ ok: true });
				expect(second).toEqual({ ok: true });
				expect(state.stopTaskEffect).not.toHaveBeenCalled();
			}).pipe(Effect.scoped, Effect.provide(state.layer));
		},
	);

	it.effect(
		"propagates real failures while tolerating a finish racing the SDK call",
		() => {
			const state = setup();
			const error = new ProviderInstanceFailure({
				providerId: "claude",
				operation: "stopTask",
				cause: new Error("SDK failed"),
			});
			state.stopTaskEffect.mockImplementationOnce(() => Effect.fail(error));
			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* Effect.either(client.StopBackgroundTask(request));
				expect(result._tag).toBe("Left");
				state.stopTaskEffect.mockImplementationOnce(() => {
					state.finish();
					return Effect.fail(error);
				});
				const finished = yield* client.StopBackgroundTask(request);
				expect(finished).toEqual({ ok: true });
			}).pipe(Effect.scoped, Effect.provide(state.layer));
		},
	);

	it.effect(
		"refuses providers without per-task stop without cancelling them",
		() => {
			const state = setup("opencode");
			return Effect.gen(function* () {
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* Effect.either(client.StopBackgroundTask(request));
				expect(result._tag).toBe("Left");
				expect(state.stopTaskEffect).not.toHaveBeenCalled();
				expect(state.interruptTurnEffect).not.toHaveBeenCalled();
			}).pipe(Effect.scoped, Effect.provide(state.layer));
		},
	);
});
