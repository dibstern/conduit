import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Socket, SocketServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import type { ManagedRuntime } from "effect";
import { Cause, Effect, Runtime } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import type { WebSocket } from "ws";
import {
	type WsTransport,
	WsTransportTag,
} from "../domain/relay/Layers/ws-transport-layer.js";
import { WsRpcGroup, WsRpcServerLayer } from "./ws-rpc.js";

interface RpcWebSocketHandlerOptions {
	readonly runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>;
	readonly maxPayload?: number;
}

type RpcTransportRunFork = <A, E>(
	effect: Effect.Effect<A, E, WsTransportTag>,
) => RuntimeFiber<A, E>;

interface RpcWebSocketHandlerRuntime {
	readonly transport: WsTransport;
	readonly runTransportFork: RpcTransportRunFork;
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

export const makeWsRpcWebSocketHandler = (
	options: RpcWebSocketHandlerOptions,
): Effect.Effect<WsRpcWebSocketHandler, never, WsTransportTag> =>
	Effect.gen(function* () {
		const transport = yield* WsTransportTag;
		const runtime = yield* Effect.runtime<WsTransportTag>();
		return new WsRpcWebSocketHandler(options, {
			transport,
			runTransportFork: Runtime.runFork(runtime),
		});
	});

export class WsRpcWebSocketHandler implements RpcWebSocketHandlerShape {
	private readonly runtime: ManagedRuntime.ManagedRuntime<unknown, unknown>;
	private readonly transport: WsTransport;
	private readonly runTransportFork: RpcTransportRunFork;
	private readonly clients = new Set<WebSocket>();
	private closed = false;

	constructor(
		options: RpcWebSocketHandlerOptions,
		runtime: RpcWebSocketHandlerRuntime,
	) {
		this.runtime = options.runtime;
		this.transport = runtime.transport;
		this.runTransportFork = runtime.runTransportFork;
		this.transport.wss.on("connection", (ws) => this.onConnection(ws));
	}

	handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		this.forkTransport(
			"handleUpgrade",
			this.transport.handleUpgrade(req, socket, head).pipe(
				Effect.catchAll((err) =>
					Effect.sync(() => {
						socket.destroy(err instanceof Error ? err : undefined);
					}),
				),
			),
		);
	}

	async drain(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const ws of this.clients) {
			ws.close();
		}
		this.clients.clear();
	}

	private onConnection(ws: WebSocket): void {
		this.clients.add(ws);
		ws.on("close", () => this.clients.delete(ws));
		this.runtime.runFork(runRpcWebSocketConnection(ws));
	}

	private forkTransport<A, E>(
		op: string,
		effect: Effect.Effect<A, E, WsTransportTag>,
	): RuntimeFiber<unknown, never> {
		return this.runTransportFork(
			effect.pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() =>
						console.error(`[ws-rpc-bridge] ${op} failed:`, Cause.pretty(cause)),
					),
				),
			),
		);
	}
}
