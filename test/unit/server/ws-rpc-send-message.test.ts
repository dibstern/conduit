import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { RateLimiterLive } from "../../../src/lib/domain/relay/Layers/rate-limiter-layer.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer SendMessage", () => {
	it.effect("passes commandId through to provider orchestration", () => {
		const dispatch = vi.fn(() =>
			Effect.succeed({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			}),
		);
		const engine = withDispatchEffect({
			getProviderForSession: vi.fn(() => "claude"),
			dispatchEffect: dispatch,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			yield* client.SendMessage({
				projectSlug: "project-a",
				sessionId: "session-1",
				text: "hello",
				originId: "browser-tab-a",
				commandId: "cmd-send-1",
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "send_turn",
					commandId: "cmd-send-1",
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							orchestrationEngine: engine,
						}),
					),
				),
			),
		);
	});

	it.effect("sends prompts through the shared prompt path", () => {
		const prompt = vi.fn(async () => undefined);
		const api = makeMockOpenCodeAPI();
		api.session.prompt = prompt as typeof api.session.prompt;
		const recordMessageActivity = vi.fn(() => Effect.void);
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientsForSession: vi.fn(() => ["tab-a", "tab-b"]),
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.SendMessage({
				projectSlug: "project-a",
				sessionId: "session-1",
				text: "hello",
				images: ["data:image/png;base64,abc"],
				originId: "browser-tab-a",
				commandId: "cmd-send-legacy-test",
			});

			expect(result).toEqual({ ok: true });
			expect(recordMessageActivity).toHaveBeenCalledWith("session-1");
			expect(prompt).toHaveBeenCalledWith("session-1", {
				text: "hello",
				images: ["data:image/png;base64,abc"],
			});
			expect(calls).toContainEqual({
				channel: "sendToSession",
				sessionId: "session-1",
				message: {
					type: "status",
					sessionId: "session-1",
					status: "processing",
				},
			});
			expect(calls).toContainEqual({
				channel: "sendTo",
				clientId: "tab-a",
				message: {
					type: "user_message",
					sessionId: "session-1",
					text: "hello",
					originId: "browser-tab-a",
				},
			});
			expect(calls).toContainEqual({
				channel: "sendTo",
				clientId: "tab-b",
				message: {
					type: "user_message",
					sessionId: "session-1",
					text: "hello",
					originId: "browser-tab-a",
				},
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							wsHandler,
							sessionManagerService: makeMockSessionManagerService({
								recordMessageActivity,
							}),
						}),
					),
				),
			),
		);
	});

	it.effect("applies the relay rate limit when a limiter is available", () => {
		const prompt = vi.fn(async () => undefined);
		const api = makeMockOpenCodeAPI();
		api.session.prompt = prompt as typeof api.session.prompt;

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			yield* client.SendMessage({
				projectSlug: "project-a",
				sessionId: "session-1",
				text: "first",
				originId: "browser-tab-a",
				commandId: "cmd-rate-1",
			});

			const second = yield* Effect.either(
				client.SendMessage({
					projectSlug: "project-a",
					sessionId: "session-1",
					text: "second",
					originId: "browser-tab-a",
					commandId: "cmd-rate-2",
				}),
			);

			expect(second._tag).toBe("Left");
			expect(prompt).toHaveBeenCalledTimes(1);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							makeTestHandlerLayer({ api }),
							RateLimiterLive({ maxRequests: 1, windowMs: 60_000 }),
						),
					),
				),
			),
		);
	});
});
