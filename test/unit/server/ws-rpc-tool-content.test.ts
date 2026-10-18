import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	PartVersion,
	ToolCallId,
	type ToolDetail,
} from "../../../src/lib/contracts/tool-wire.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	ToolContentServiceError,
	ToolContentServiceTag,
} from "../../../src/lib/domain/relay/Services/tool-content-service.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const detail: ToolDetail = {
	toolId: ToolCallId.make("tool-1"),
	version: PartVersion.make(7),
	settled: true,
	input: { _tag: "whole", value: { command: "ls" } },
	output: { _tag: "whole", text: "full tool output" },
};

const serve = (
	details: (
		sessionId: string,
		ids: readonly string[],
	) => Effect.Effect<readonly ToolDetail[], ToolContentServiceError>,
) =>
	WsRpcServerLayer.pipe(
		Layer.provideMerge(
			Layer.merge(
				makeTestHandlerLayer(),
				Layer.succeed(ToolContentServiceTag, { details }),
			),
		),
	);

describe("WsRpcServerLayer GetToolDetails", () => {
	it.effect("returns each known tool's full detail in one response", () => {
		const details = vi.fn((_sessionId: string, ids: readonly string[]) =>
			Effect.succeed(ids.includes("tool-1") ? [detail] : []),
		);
		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.GetToolDetails({
				sessionId: "session-a",
				toolIds: [ToolCallId.make("tool-1"), ToolCallId.make("missing")],
			});
			expect(details).toHaveBeenCalledWith("session-a", ["tool-1", "missing"]);
			expect(result).toEqual({ projectSlug: "test-project", tools: [detail] });
		}).pipe(Effect.scoped, Effect.provide(serve(details)));
	});

	it.effect("fails the request when the read fails", () =>
		Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* Effect.result(
				client.GetToolDetails({
					sessionId: "session-a",
					toolIds: [ToolCallId.make("tool-1")],
				}),
			);
			expect(result._tag).toBe("Left");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				serve((sessionId, toolIds) =>
					Effect.fail(
						new ToolContentServiceError({
							operation: "details",
							sessionId,
							toolIds,
							cause: "db gone",
						}),
					),
				),
			),
		),
	);
});
