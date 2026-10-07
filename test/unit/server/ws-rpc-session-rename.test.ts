import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockSessionManagerService,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("WsRpcServerLayer RenameSession", () => {
	it.effect("renames a session without sending to any client", () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			renameSession: vi.fn(() => Effect.void),
		});

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.RenameSession({
				projectSlug: "project-a",
				sessionId: "root-1",
				title: "Renamed Root",
				originId: "browser-1",
			});

			expect(result).toEqual({ ok: true });
			expect(sessionManagerService.renameSession).toHaveBeenCalledWith(
				"root-1",
				"Renamed Root",
			);
			expect(calls).toEqual([]);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});

	it.effect("marks a session unread without sending to any client", () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			markSessionUnread: vi.fn(() => Effect.void),
		});

		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const result = yield* client.MarkSessionUnread({
				projectSlug: "project-a",
				sessionId: "root-1",
				originId: "browser-1",
			});

			expect(result).toEqual({ ok: true });
			expect(sessionManagerService.markSessionUnread).toHaveBeenCalledWith(
				"root-1",
			);
			expect(calls).toEqual([]);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});
});
