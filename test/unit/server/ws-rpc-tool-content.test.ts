import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { ToolContentServiceTag } from "../../../src/lib/domain/relay/Services/tool-content-service.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer GetToolContent", () => {
	it.effect("returns full tool content from the service boundary", () => {
		const toolContent = {
			get: vi.fn((toolId: string) =>
				Effect.succeed(toolId === "tool-1" ? "full tool output" : undefined),
			),
		};

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetToolContent({
				projectSlug: "project-a",
				toolId: "tool-1",
			});

			expect(toolContent.get).toHaveBeenCalledWith("tool-1");
			expect(result).toEqual({
				projectSlug: "project-a",
				toolId: "tool-1",
				content: "full tool output",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.merge(
							makeTestHandlerLayer(),
							Layer.succeed(ToolContentServiceTag, toolContent),
						),
					),
				),
			),
		);
	});

	it.effect("fails when full tool content is unavailable", () => {
		const toolContent = {
			get: vi.fn(() => Effect.succeed(undefined)),
		};

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* Effect.either(
				client.GetToolContent({
					projectSlug: "project-a",
					toolId: "missing-tool",
				}),
			);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				expect(result.left.message).toBe("Full tool content not available");
			}
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.merge(
							makeTestHandlerLayer(),
							Layer.succeed(ToolContentServiceTag, toolContent),
						),
					),
				),
			),
		);
	});
});
