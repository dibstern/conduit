import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
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
	it.effect(
		"rejects an unknown transcript target without any OpenCode request",
		() => {
			const api = makeMockOpenCodeAPI();
			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* Effect.result(
					client.RewindSession({
						sessionId: "session-1",
						messageId: "client-only-uuid",
					}),
				);
				// 82tn.51: a rewind is a head move; a row outside the history graph has nowhere to go.
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: { _tag: "SessionBusy", reason: "history_unavailable" },
				});
				for (const request of Object.values(api.session))
					expect(request).not.toHaveBeenCalled();
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
					{ local: true },
				),
			);
		},
	);
	it.effect("records a local rewind without any OpenCode request", () => {
		const api = makeMockOpenCodeAPI();
		return Effect.gen(function* () {
			const client = yield* rpcClient;
			// 82tn.51: a rewind is a head move, so its target must sit in an ended Run's node.
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
				VALUES ('session-1', 'run-1', NULL, 'run-1', 1, 0)`;
			yield* sql`UPDATE messages SET history_node_id = 'run-1' WHERE id = 'message-1'`;
			yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES ('session-1', 'run-1')`;

			const result = yield* client.RewindSession({
				sessionId: "session-1",
				messageId: "message-1",
			});

			expect(result).toEqual({
				ok: true,
				sessionId: "session-1",
				messageId: "message-1",
			});
			for (const request of Object.values(api.session))
				expect(request).not.toHaveBeenCalled();
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
				{ local: true },
			),
		);
	});
});
