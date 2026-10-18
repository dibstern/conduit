import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer RewindSession", () => {
	it.effect("rejects an unknown transcript target without reverting", () => {
		const api = makeMockOpenCodeAPI();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const result = yield* Effect.result(
				client.RewindSession({
					sessionId: "session-1",
					messageId: "client-only-uuid",
				}),
			);
			expect(result).toMatchObject({
				_tag: "Left",
				left: {
					_tag: "WsRpcError",
					message: expect.stringContaining("not found"),
				},
			});
			expect(api.session.revert).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							seedEvents: [
								canonicalEvent(
									"session.created",
									"session-1",
									{
										sessionId: "session-1",
										title: "Rewind",
										provider: "opencode",
									},
									{ provider: "opencode" },
								),
							],
						}),
					),
				),
			),
		);
	});
	it.effect("reverts the requested session", () => {
		const api = makeMockOpenCodeAPI();
		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.RewindSession({
				sessionId: "session-1",
				messageId: "message-1",
			});

			expect(result).toEqual({
				ok: true,
				sessionId: "session-1",
				messageId: "message-1",
			});
			expect(api.session.revert).toHaveBeenCalledWith("session-1", {
				messageID: "message-1",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							seedEvents: [
								canonicalEvent(
									"session.created",
									"session-1",
									{
										sessionId: "session-1",
										title: "Rewind",
										provider: "opencode",
									},
									{ provider: "opencode" },
								),
								canonicalEvent(
									"message.created",
									"session-1",
									{
										messageId: "message-1",
										sessionId: "session-1",
										role: "user",
									},
									{ provider: "opencode" },
								),
							],
						}),
					),
				),
			),
		);
	});
});
