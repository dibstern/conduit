import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { SessionDirectory } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { BrowserRpcConnectionsTag } from "../../../src/lib/server/ws-rpc.js";
import { makeRoutedWsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";

describe("WsRpcWebSocketHandler", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("ends the connection fiber when the client disconnects", async () => {
		const scope = Effect.runSync(Scope.make());
		cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
		// Each live connection holds one entry until its fiber's scope closes.
		let markOpened = () => {};
		let markEnded = () => {};
		const opened = new Promise<void>((resolve) => {
			markOpened = resolve;
		});
		const ended = new Promise<void>((resolve) => {
			markEnded = resolve;
		});
		const connections = new (class extends Set<() => void> {
			override add(entry: () => void) {
				super.add(entry);
				markOpened();
				return this;
			}
			override delete(entry: () => void) {
				const deleted = super.delete(entry);
				if (this.size === 0) markEnded();
				return deleted;
			}
		})();
		const handler = await Effect.runPromise(
			makeRoutedWsRpcWebSocketHandler(() =>
				Effect.fail(new WsRpcError({ message: "unused" })),
			).pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(SessionDirectory)({
							projectOf: () => Effect.succeed(Option.none()),
						}),
						Layer.succeed(BrowserRpcConnectionsTag)(connections),
					),
				),
				Scope.provide(scope),
			),
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
		await opened;
		expect(connections.size).toBe(1);

		ws.close();
		await new Promise<void>((resolve) => ws.once("close", () => resolve()));

		await ended;
		expect(connections.size).toBe(0);
	});
});
