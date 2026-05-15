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
	it.effect("renames a session and broadcasts refreshed session lists", () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			renameSession: vi.fn(() => Effect.void),
			sendDualSessionLists: vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Renamed Root",
								updatedAt: 100,
								messageCount: 2,
							},
						],
						roots: true,
					});
					send({
						type: "session_list",
						sessions: [
							{
								id: "child-1",
								title: "Child Session",
								updatedAt: 200,
								messageCount: 4,
								parentID: "root-1",
							},
						],
						roots: false,
					});
				}),
			),
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
			expect(calls.map((call) => call.message)).toEqual([
				{
					type: "session_list",
					sessions: [
						{
							id: "root-1",
							title: "Renamed Root",
							updatedAt: 100,
							messageCount: 2,
						},
					],
					roots: true,
				},
				{
					type: "session_list",
					sessions: [
						{
							id: "child-1",
							title: "Child Session",
							updatedAt: 200,
							messageCount: 4,
							parentID: "root-1",
						},
					],
					roots: false,
				},
			]);
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
