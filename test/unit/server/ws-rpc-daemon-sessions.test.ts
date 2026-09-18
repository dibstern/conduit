import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer daemon sessions", () => {
	it.effect("lists daemon sessions through the project-scoped RPC lane", () => {
		const listDaemonSessions = vi.fn(async () => ({
			sessions: [
				{
					id: "session-1",
					title: "Session one",
					updatedAt: 42,
					projectSlug: "project-b",
				},
			],
			availability: [
				{ projectSlug: "project-a", available: true as const },
				{
					projectSlug: "project-b",
					available: false as const,
					error: "unreadable",
				},
			],
		}));
		const config = makeMockConfig({ listDaemonSessions });

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const response = yield* client.ListDaemonSessions({
				projectSlug: "project-a",
				limit: 25,
				roots: true,
			});

			expect(listDaemonSessions).toHaveBeenCalledWith({
				limit: 25,
				roots: true,
			});
			expect(response).toEqual({
				projectSlug: "project-a",
				sessions: [
					{
						id: "session-1",
						title: "Session one",
						updatedAt: 42,
						projectSlug: "project-b",
					},
				],
				availability: [
					{ projectSlug: "project-a", available: true },
					{
						projectSlug: "project-b",
						available: false,
						error: "unreadable",
					},
				],
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ config })),
				),
			),
		);
	});

	it.effect(
		"reports daemon session listing as unsupported without a callback",
		() =>
			Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* Effect.either(
					client.ListDaemonSessions({ projectSlug: "project-a" }),
				);

				expect(Either.isLeft(result)).toBe(true);
				if (Either.isLeft(result)) {
					expect(result.left.message).toContain(
						"Cross-project session listing is not supported in this mode",
					);
				}
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
				),
			),
	);
});
