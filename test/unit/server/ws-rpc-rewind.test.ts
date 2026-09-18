import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { SessionManagerService } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer RewindSession", () => {
	it.effect(
		"rejects an unknown provider target without reverting or clearing pagination",
		() => {
			const api = makeMockOpenCodeAPI();
			const clearPaginationCursor = vi.fn(() => Effect.void);
			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* Effect.either(
					client.RewindSession({
						projectSlug: "project-a",
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
				expect(clearPaginationCursor).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								sessionManagerService: {
									clearPaginationCursor,
								} as unknown as SessionManagerService,
							}),
						),
					),
				),
			);
		},
	);
	it.effect(
		"reverts the requested session and clears its pagination cursor",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.mocked(api.session.messages).mockResolvedValue([
				{ id: "message-1", sessionID: "session-1", role: "user", parts: [] },
			]);
			const clearPaginationCursor = vi.fn(() => Effect.void);

			return Effect.gen(function* () {
				const client = yield* rpcClient;

				const result = yield* client.RewindSession({
					projectSlug: "project-a",
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
				expect(clearPaginationCursor).toHaveBeenCalledWith("session-1");
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								sessionManagerService: {
									clearPaginationCursor,
								} as unknown as SessionManagerService,
							}),
						),
					),
				),
			);
		},
	);
});
