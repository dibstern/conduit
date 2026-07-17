import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { getPermissionMode } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer SwitchPermissionMode", () => {
	it.effect("sets, broadcasts, and hydrates the permission mode", () => {
		const wsHandler = makeMockWebSocketHandler();

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.SwitchPermissionMode({
				projectSlug: "project-a",
				sessionId: "session-1",
				mode: "auto",
				originId: "browser-1",
			});

			expect(result).toEqual({ projectSlug: "project-a", mode: "auto" });
			expect(yield* getPermissionMode("session-1")).toBe("auto");
			expect(wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
				type: "permission_mode_info",
				mode: "auto",
			});

			const models = yield* client.GetModels({
				projectSlug: "project-a",
				sessionId: "session-1",
			});
			expect(models.permissionMode).toBe("auto");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							wsHandler,
							log: makeMockLogger(),
						}),
					),
					Layer.provideMerge(Layer.succeed(LoggerTag, makeMockLogger())),
				),
			),
		);
	});
});
