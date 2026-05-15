import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, TestClock } from "effect";
import { expect } from "vitest";
import {
	makeHeartbeatFiber,
	makeWsTransportLive,
	WsTransportTag,
} from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import {
	addClient,
	getClientCount,
	getClientSession,
	makeWsHandlerStateLive,
	type WsConn,
} from "../../../src/lib/domain/relay/Services/ws-handler-service.js";

function mockWs(): WsConn & {
	closed: boolean;
	pingCount: number;
	terminated: boolean;
} {
	return {
		closed: false,
		pingCount: 0,
		readyState: 1,
		terminated: false,
		send() {},
		close() {
			this.closed = true;
			this.readyState = 3;
		},
		ping() {
			this.pingCount++;
		},
		terminate() {
			this.terminated = true;
			this.readyState = 3;
		},
	};
}

const stateLayer = () => Layer.fresh(makeWsHandlerStateLive());

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

describe("WS heartbeat", () => {
	it.effect("pings connected clients on schedule", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			const fiber = yield* Effect.fork(makeHeartbeatFiber(30_000));
			yield* TestClock.adjust("30 seconds");
			yield* Fiber.interrupt(fiber);

			expect(ws.pingCount).toBe(1);
			expect(ws.terminated).toBe(false);
			const session = yield* getClientSession("c1");
			expect(Option.isNone(session)).toBe(true);
			expect(yield* getClientCount).toBe(1);
		}).pipe(Effect.provide(stateLayer())),
	);

	it.effect("terminates and removes dead clients on the next tick", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			const fiber = yield* Effect.fork(makeHeartbeatFiber(30_000));
			yield* TestClock.adjust("30 seconds");
			expect(ws.pingCount).toBe(1);

			yield* TestClock.adjust("30 seconds");
			yield* Fiber.interrupt(fiber);

			expect(ws.terminated).toBe(true);
			expect(yield* getClientCount).toBe(0);
		}).pipe(Effect.provide(stateLayer())),
	);
});
