import { Socket, SocketServer } from "@effect/platform";
import { Effect } from "effect";

/** One connection, matching ws-rpc-handler.ts, with bytes instead of OS sockets. */
export const makeFakeSocketServer = Effect.gen(function* () {
	const clientFrames: string[] = [];
	const serverFrames: string[] = [];
	const toServer = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			clientFrames.push(new TextDecoder().decode(chunk));
			controller.enqueue(chunk);
		},
	});
	const toClient = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			serverFrames.push(new TextDecoder().decode(chunk));
			controller.enqueue(chunk);
		},
	});
	const socket = yield* Socket.fromTransformStream(
		Effect.succeed({
			readable: toServer.readable,
			writable: toClient.writable,
		}),
	);
	const clientSocket = yield* Socket.fromTransformStream(
		Effect.succeed({
			readable: toClient.readable,
			writable: toServer.writable,
		}),
	);
	const socketServer = SocketServer.SocketServer.of({
		address: { _tag: "TcpAddress", hostname: "websocket", port: 0 },
		run: (handler) =>
			handler(socket).pipe(Effect.orDie, Effect.zipRight(Effect.never)),
	});
	return { socketServer, clientSocket, clientFrames, serverFrames };
});
