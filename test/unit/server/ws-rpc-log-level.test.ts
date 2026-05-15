import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { getLogLevel, setLogLevel } from "../../../src/lib/logger.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer log level controls", () => {
	it.effect("sets server logging level through browser RPC", () => {
		const originalLevel = getLogLevel();

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.SetLogLevel({
				projectSlug: "project-a",
				level: "debug",
			});

			expect(result).toEqual({ ok: true });
			expect(getLogLevel()).toBe("debug");
		}).pipe(
			Effect.ensuring(Effect.sync(() => setLogLevel(originalLevel))),
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(makeTestHandlerLayer())),
			),
		);
	});
});
