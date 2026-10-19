import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const sessionLayer = () =>
	makeTestHandlerLayer({
		seedEvents: [
			canonicalEvent("session.created", "root-1", {
				sessionId: "root-1",
				title: "Original",
				provider: "opencode",
			}),
		],
	});

describe("WsRpcServerLayer RenameSession", () => {
	it.effect("renames a session", () => {
		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.RenameSession({
				sessionId: "root-1",
				title: "Renamed Root",
				originId: "browser-1",
			});

			expect(result).toEqual({ ok: true });
			const readQuery = yield* ReadQueryEffectTag;
			expect((yield* readQuery.getSession("root-1"))?.title).toBe(
				"Renamed Root",
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(sessionLayer())),
				{ local: true },
			),
		);
	});

	it.effect("marks a session unread", () => {
		return Effect.gen(function* () {
			const client = yield* RpcTest.makeClient(WsRpcGroup);
			const readQuery = yield* ReadQueryEffectTag;
			expect((yield* readQuery.getSession("root-1"))?.unread).toBe(0);
			const result = yield* client.MarkSessionUnread({
				sessionId: "root-1",
				originId: "browser-1",
			});

			expect(result).toEqual({ ok: true });
			expect((yield* readQuery.getSession("root-1"))?.unread).toBe(1);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(Layer.provideMerge(sessionLayer())),
				{ local: true },
			),
		);
	});
});
