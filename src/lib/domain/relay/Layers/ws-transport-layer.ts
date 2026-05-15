import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { Context, Effect, HashMap, Layer, Ref } from "effect";
import {
	type ClientState,
	removeClient,
	WsHandlerStateTag,
} from "../Services/ws-handler-service.js";

export interface WsTransport {
	readonly wss: import("ws").WebSocketServer;
	readonly handleUpgrade: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => Effect.Effect<import("ws").WebSocket, Error>;
}

export class WsTransportTag extends Context.Tag("WsTransport")<
	WsTransportTag,
	WsTransport
>() {}

interface WsTransportConfig {
	noServer: boolean;
	maxPayload?: number;
	perMessageDeflate?: boolean | object;
}

const defaultPerMessageDeflate = {
	serverMaxWindowBits: 10,
	zlibDeflateOptions: {
		level: 1,
	},
};

export const makeWsTransportLive = (
	config: WsTransportConfig,
): Layer.Layer<WsTransportTag> =>
	Layer.scoped(
		WsTransportTag,
		Effect.gen(function* () {
			const ws = yield* Effect.try({
				try: () => {
					const require = createRequire(import.meta.url);
					return require("ws") as typeof import("ws");
				},
				catch: (err) => new Error(`Failed to load ws module: ${err}`),
			}).pipe(Effect.orDie);

			const wss = new ws.WebSocketServer({
				noServer: config.noServer,
				maxPayload: config.maxPayload ?? 50 * 1024 * 1024,
				perMessageDeflate: config.perMessageDeflate ?? defaultPerMessageDeflate,
			});

			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					wss.close();
				}),
			);

			const handleUpgrade = (
				req: IncomingMessage,
				socket: Duplex,
				head: Buffer,
			): Effect.Effect<import("ws").WebSocket, Error> =>
				Effect.async<import("ws").WebSocket, Error>((resume) => {
					let resumed = false;
					const onError = (err: Error) => {
						if (resumed) return;
						resumed = true;
						resume(Effect.fail(err));
					};

					socket.on("error", onError);
					wss.handleUpgrade(req, socket, head, (conn) => {
						if (resumed) return;
						resumed = true;
						socket.removeListener("error", onError);
						wss.emit("connection", conn, req);
						resume(Effect.succeed(conn));
					});
				});

			return { wss, handleUpgrade };
		}),
	);

const heartbeatOnce = Effect.fn("ws.heartbeat.tick")(function* () {
	const ref = yield* WsHandlerStateTag;
	const clients = yield* Ref.get(ref);
	const staleClientIds: string[] = [];
	const clientsToPing: Array<[string, ClientState]> = [];

	for (const [clientId, client] of clients) {
		if (!client.isAlive) {
			staleClientIds.push(clientId);
			yield* Effect.sync(() => {
				client.ws.terminate?.();
				if (!client.ws.terminate) client.ws.close();
			}).pipe(Effect.catchAll(() => Effect.void));
			continue;
		}
		clientsToPing.push([clientId, client]);
	}

	if (clientsToPing.length > 0) {
		yield* Ref.update(ref, (map) => {
			let updated = map;
			for (const [clientId, client] of clientsToPing) {
				updated = HashMap.set(updated, clientId, {
					...client,
					isAlive: false,
				});
			}
			return updated;
		});
	}

	for (const [_clientId, client] of clientsToPing) {
		yield* Effect.sync(() => client.ws.ping?.()).pipe(
			Effect.catchAll(() => Effect.void),
		);
	}

	for (const clientId of staleClientIds) {
		yield* removeClient(clientId);
	}
});

export const makeHeartbeatFiber = (intervalMs = 30_000) =>
	Effect.forever(
		Effect.sleep(intervalMs).pipe(Effect.zipRight(heartbeatOnce())),
	).pipe(Effect.annotateLogs("component", "ws-heartbeat"));
