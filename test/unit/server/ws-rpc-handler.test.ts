import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { makeWsTransportLive } from "../../../src/lib/domain/relay/Layers/ws-transport-layer.js";
import { makeWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

describe("WsRpcWebSocketHandler", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("ends the connection fiber when the client disconnects", async () => {
		const runtime = ManagedRuntime.make(
			Layer.merge(
				makeTestHandlerLayer(),
				makeWsTransportLive({ noServer: true }),
			),
		);
		cleanups.push(() => runtime.dispose());
		const forked: RuntimeFiber<unknown, unknown>[] = [];
		const trackingRuntime = {
			runFork: (effect: Effect.Effect<unknown, unknown, never>) => {
				const fiber = runtime.runFork(effect);
				forked.push(fiber);
				return fiber;
			},
		} as unknown as ManagedRuntime.ManagedRuntime<unknown, unknown>;
		const handler = await runtime.runPromise(
			makeWsRpcWebSocketHandler({ runtime: trackingRuntime }),
		);

		const server = createServer();
		server.on("upgrade", (req, socket, head) =>
			handler.handleUpgrade(req, socket, head),
		);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		cleanups.push(
			() => new Promise<void>((resolve) => server.close(() => resolve())),
		);

		const ws = new WebSocket(
			`ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`,
		);
		await new Promise<void>((resolve) => ws.once("open", () => resolve()));
		await vi.waitFor(() => expect(forked).toHaveLength(1));

		ws.close();
		await new Promise<void>((resolve) => ws.once("close", () => resolve()));

		await expect(
			runtime.runPromise(
				Fiber.await(forked[0] as RuntimeFiber<unknown, unknown>).pipe(
					Effect.timeout("2 seconds"),
				),
			),
		).resolves.toBeDefined();
	});
});
