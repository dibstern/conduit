import { describe, it } from "@effect/vitest";
import { Effect, Struct } from "effect";
import { RpcTest } from "effect/rpc";
import { expect, vi } from "vitest";
import * as Contracts from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import * as Server from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

describe("RPC registration", () => {
	it("registers exactly the RPC group and re-exports every member", () => {
		expect(Object.keys(Server.wsRpcHandlers).sort()).toEqual(
			Array.from(WsRpcGroup.requests.keys()).sort(),
		);
		for (const [name, contract] of Object.entries(Contracts)) {
			expect(Reflect.get(Server, name), name).toBe(contract);
		}
	});

	it("requires a handler for every group member", () => {
		// @ts-expect-error Omitting a group member must fail registration.
		WsRpcGroup.of(Struct.omit(Server.wsRpcHandlers, "GetStatus"));
	});

	it.effect("ignores daemon hooks outside the RPC group", () =>
		Effect.gen(function* () {
			const handlers = yield* DaemonWsRpcHandlersTag;
			const nonRpcHook = vi.fn(() => Effect.void);
			const resolve = vi.fn(() => Effect.die("Unexpected relay resolution"));
			const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
				Effect.provide(
					Server.makeRoutedWsRpcServerLayer(resolve, {
						...handlers,
						nonRpcHook,
					}),
				),
			);
			expect((yield* client.GetProjects({})).projects).toEqual([]);
			expect(nonRpcHook).not.toHaveBeenCalled();
			expect(resolve).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeDaemonRpcTestLayer())),
	);
});
