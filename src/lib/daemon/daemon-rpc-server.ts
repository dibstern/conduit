import { lstatSync, unlinkSync } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import type { Socket as NetSocket } from "node:net";
import { SocketServer } from "@effect/platform";
import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Context, Effect, Layer, Option } from "effect";
import { WsRpcGroup } from "../contracts/ws-rpc.js";
import type { WsRpcServerLayer } from "../server/ws-rpc.js";
import { isRecord } from "../utils.js";
import { isDaemonRunning } from "./daemon-utils.js";

type ShutdownTag = "Shutdown" | "RestartWithConfig";

export type OnSuccessfulShutdownResponse = (
	tag: ShutdownTag,
) => Effect.Effect<void>;

/** Share the response boundary between the Unix and browser RPC transports. */
export const withRpcShutdownResponse = (
	protocol: RpcServer.Protocol["Type"],
	onSuccessfulShutdownResponse: OnSuccessfulShutdownResponse,
): RpcServer.Protocol["Type"] => {
	const shutdownRequests = new Map<string, ShutdownTag>();
	const key = (clientId: number, requestId: string) =>
		`${clientId}:${requestId}`;
	return {
		...protocol,
		run: (handle) =>
			protocol.run((clientId, message) => {
				if (
					message._tag === "Request" &&
					(message.tag === "Shutdown" || message.tag === "RestartWithConfig")
				) {
					shutdownRequests.set(key(clientId, message.id), message.tag);
				}
				return handle(clientId, message);
			}),
		send: (clientId, response, transferables) =>
			protocol.send(clientId, response, transferables).pipe(
				// A committed shutdown must finish even if its reply cannot be written.
				Effect.ensuring(
					Effect.suspend(() => {
						if (response._tag !== "Exit") return Effect.void;
						const requestKey = key(clientId, response.requestId);
						const tag = shutdownRequests.get(requestKey);
						shutdownRequests.delete(requestKey);
						return tag && response.exit._tag === "Success"
							? Effect.forkDaemon(onSuccessfulShutdownResponse(tag)).pipe(
									Effect.asVoid,
								)
							: Effect.void;
					}),
				),
			),
	};
};

export interface DaemonRpcSocket {
	readonly socketPath: string;
	readonly drain: Effect.Effect<void>;
}

export class DaemonRpcSocketTag extends Context.Tag("DaemonRpcSocket")<
	DaemonRpcSocketTag,
	DaemonRpcSocket
>() {}

/** Acquires one local Unix listener and its RPC loop in the parent scope. */
export const makeDaemonRpcSocketLayer = <R>(
	socketPath: string,
	handlerLayer: Layer.Layer<
		Layer.Layer.Success<typeof WsRpcServerLayer>,
		never,
		R
	>,
	options: {
		readonly onSuccessfulShutdownResponse?: OnSuccessfulShutdownResponse;
		readonly onClientCountChange?: (count: number) => void;
	} = {},
): Layer.Layer<DaemonRpcSocketTag, unknown, R> =>
	Layer.scoped(
		DaemonRpcSocketTag,
		Effect.gen(function* () {
			const existing = yield* Effect.tryPromise({
				try: () => lstat(socketPath),
				catch: (cause) => cause,
			}).pipe(
				Effect.catchAll((cause) =>
					isRecord(cause) && cause["code"] === "ENOENT"
						? Effect.succeed(null)
						: Effect.fail(cause),
				),
			);
			if (existing !== null) {
				const listening = yield* Effect.tryPromise({
					try: () => isDaemonRunning(socketPath),
					catch: (cause) => cause,
				});
				if (listening) {
					return yield* Effect.fail(
						new Error(
							`A Conduit server is already listening at ${socketPath}.`,
						),
					);
				}
				yield* Effect.try({
					try: () => {
						try {
							const current = lstatSync(socketPath);
							if (
								current.dev === existing.dev &&
								current.ino === existing.ino &&
								current.ctimeMs === existing.ctimeMs
							)
								unlinkSync(socketPath);
						} catch (cause) {
							if (!isRecord(cause) || cause["code"] !== "ENOENT") throw cause;
						}
					},
					catch: (cause) => cause,
				});
			}
			const server = yield* NodeSocketServer.make({ path: socketPath });
			const clients = new Set<NetSocket>();
			const drain = Effect.sync(() => {
				for (const client of clients) client.destroy();
			});
			// Closing the acquired net.Server removes its own Unix socket.
			yield* Effect.addFinalizer(() => drain);
			yield* Effect.tryPromise({
				try: () => chmod(socketPath, 0o600),
				catch: (cause) => cause,
			});
			const trackedServer = SocketServer.SocketServer.of({
				address: server.address,
				run: (handle) =>
					server.run((socket) =>
						Effect.scoped(
							Effect.gen(function* () {
								const client = yield* Effect.serviceOption(
									NodeSocket.NetSocket,
								);
								if (Option.isSome(client)) {
									clients.add(client.value);
									options.onClientCountChange?.(clients.size);
									yield* Effect.addFinalizer(() =>
										Effect.sync(() => {
											clients.delete(client.value);
											options.onClientCountChange?.(clients.size);
										}),
									);
								}
								return yield* handle(socket);
							}),
						),
					),
			});
			const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
				Effect.provideService(SocketServer.SocketServer, trackedServer),
				Effect.provide(RpcSerialization.layerNdjson),
			);
			yield* RpcServer.make(WsRpcGroup, { concurrency: 32 }).pipe(
				Effect.provideService(
					RpcServer.Protocol,
					options.onSuccessfulShutdownResponse
						? withRpcShutdownResponse(
								protocol,
								options.onSuccessfulShutdownResponse,
							)
						: protocol,
				),
				Effect.provide(handlerLayer),
				Effect.interruptible,
				Effect.forkScoped,
			);
			return { socketPath, drain };
		}),
	);
