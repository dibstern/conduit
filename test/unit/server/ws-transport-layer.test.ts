import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	makeWsTransportLive,
	WsTransportTag,
} from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";

describe("WS transport layer", () => {
	it.effect("creates a WebSocket.Server in noServer mode", () =>
		Effect.gen(function* () {
			const transport = yield* WsTransportTag;
			expect(transport.wss).toBeDefined();
		}).pipe(Effect.provide(makeWsTransportLive({ noServer: true }))),
	);

	it.effect("exposes an upgrade handler", () =>
		Effect.gen(function* () {
			const transport = yield* WsTransportTag;
			expect(transport.handleUpgrade).toBeTypeOf("function");
		}).pipe(Effect.provide(makeWsTransportLive({ noServer: true }))),
	);
});
