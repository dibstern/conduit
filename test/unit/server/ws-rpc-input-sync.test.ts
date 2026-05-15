import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer SyncInputDraft", () => {
	it.effect("stores and fans out input drafts to session viewers", () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientsForSession: vi.fn(() => ["tab-a", "tab-b"]),
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.SyncInputDraft({
				projectSlug: "project-a",
				sessionId: "session-1",
				text: "draft text",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(wsHandler.getClientsForSession).toHaveBeenCalledWith("session-1");
			expect(calls).toEqual([
				{
					channel: "sendTo",
					clientId: "tab-a",
					message: {
						type: "input_sync",
						text: "draft text",
						from: "browser-tab-a",
					},
				},
				{
					channel: "sendTo",
					clientId: "tab-b",
					message: {
						type: "input_sync",
						text: "draft text",
						from: "browser-tab-a",
					},
				},
			]);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ wsHandler })),
				),
			),
		);
	});
});
