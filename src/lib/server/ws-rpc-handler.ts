import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Socket, SocketServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, ManagedRuntime } from "effect";
import type { WebSocket } from "ws";
import {
	makeWsTransportLive,
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
import { WsRpcGroup, WsRpcServerLayer } from "./ws-rpc.js";

interface RpcWebSocketHandlerOptions {
	readonly runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>;
	readonly maxPayload?: number;
}

export interface RpcWebSocketHandlerShape {
	readonly handleUpgrade: (
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
	) => void;
	readonly drain: () => Promise<void>;
}

const runRpcWebSocketConnection = (ws: WebSocket) =>
	Effect.scoped(
		Effect.gen(function* () {
			// The `ws` package is EventTarget-compatible at runtime, but its
			// types are narrower than the browser WebSocket type expected here.
			const socket = yield* Socket.fromWebSocket(
				Effect.succeed(ws as unknown as globalThis.WebSocket),
			);
			const socketServer = SocketServer.SocketServer.of({
				address: { _tag: "TcpAddress", hostname: "websocket", port: 0 },
				run: (handler) =>
					handler(socket).pipe(Effect.orDie, Effect.zipRight(Effect.never)),
			});

			yield* RpcServer.make(WsRpcGroup, { concurrency: 32 }).pipe(
				Effect.provide(RpcServer.layerProtocolSocketServer),
				Effect.provideService(SocketServer.SocketServer, socketServer),
				Effect.provide(WsRpcServerLayer),
				Effect.provide(RpcSerialization.layerJson),
			);
		}),
	);

export class WsRpcWebSocketHandler implements RpcWebSocketHandlerShape {
	private readonly runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>;
	private readonly transportRuntime: ManagedRuntime.ManagedRuntime<
		WsTransportTag,
		never
	>;
	private readonly transport: WsTransport;
	private readonly clients = new Set<WebSocket>();
	private closed = false;

	constructor(options: RpcWebSocketHandlerOptions) {
		this.runtime = options.runtime;
		this.transportRuntime = ManagedRuntime.make(
			makeWsTransportLive({
				noServer: true,
				...(options.maxPayload != null && { maxPayload: options.maxPayload }),
			}),
		);
		this.transport = this.transportRuntime.runSync(WsTransportTag);
		this.transport.wss.on("connection", (ws) => this.onConnection(ws));
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.transportRuntime
			.runPromise(this.transport.handleUpgrade(req, socket, head))
			.catch((err) => {
				socket.destroy(err instanceof Error ? err : undefined);
			});
	}

	async drain(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const ws of this.clients) {
			ws.close();
		}
		this.clients.clear();
		await this.transportRuntime.dispose();
	}

	private onConnection(ws: WebSocket): void {
		this.clients.add(ws);
		ws.on("close", () => this.clients.delete(ws));
		this.runtime.runFork(runRpcWebSocketConnection(ws));
	}
}
