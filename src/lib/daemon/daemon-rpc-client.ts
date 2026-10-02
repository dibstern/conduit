import { createConnection, type Socket as NetSocket } from "node:net";
import { Socket } from "@effect/platform";
import { NodeSocket } from "@effect/platform-node";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Cause, Effect, Exit, Option, Schedule } from "effect";
import type { Request } from "effect/Request";
import { WsRpcGroup, type WsRpcRequest } from "../contracts/ws-rpc.js";

export type SendRPC = <R extends WsRpcRequest>(
	request: R,
) => Promise<Request.Success<R>>;

export interface RpcRequestOptions {
	readonly startupRetries?: number;
	readonly requestTimeoutMs?: number;
}

const isNotReady = (error: Error): boolean =>
	"code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");

const connectOnce = (socketPath: string): Promise<NetSocket> =>
	new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`RPC socket connection timed out: ${socketPath}`));
		}, 5_000);
		const onError = (error: Error) => {
			clearTimeout(timeout);
			socket.destroy();
			reject(error);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			clearTimeout(timeout);
			socket.off("error", onError);
			resolve(socket);
		});
	});

const connectWhenReady = async (
	socketPath: string,
	startupRetries: number,
): Promise<NetSocket> => {
	for (let attempt = 0; ; attempt++) {
		try {
			return await connectOnce(socketPath);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!isNotReady(error) ||
				attempt >= startupRetries
			) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
};

/** One connection and one request. Only pre-request connection failures are retried. */
export const sendRpcRequest = <R extends WsRpcRequest>(
	socketPath: string,
	request: R,
	options: RpcRequestOptions = {},
): Promise<Request.Success<R>> =>
	Effect.runPromise(
		Effect.exit(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* Effect.acquireRelease(
						Effect.tryPromise({
							try: () =>
								connectWhenReady(socketPath, options.startupRetries ?? 10),
							catch: (cause) => cause,
						}),
						(socket) => Effect.sync(() => socket.destroy()),
					);
					const socket = yield* NodeSocket.fromDuplex(
						Effect.succeed(connection),
					);
					return yield* Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup, {
							flatten: true,
						});
						// A generic request keeps its tag and payload correlated, while
						// Flat models them as a union of overloads.
						const call = client as <T extends WsRpcRequest>(
							tag: T["_tag"],
							payload: T,
						) => Effect.Effect<Request.Success<T>, unknown>;
						return yield* call(request._tag, request).pipe(
							Effect.timeoutFail({
								duration: options.requestTimeoutMs ?? 10_000,
								onTimeout: () => new Error(`RPC ${request._tag} timed out`),
							}),
						);
					}).pipe(
						Effect.provide(
							RpcClient.layerProtocolSocket({ retrySchedule: Schedule.stop }),
						),
						Effect.provideService(Socket.Socket, socket),
						Effect.provide(RpcSerialization.layerNdjson),
					);
				}),
			),
		),
	).then((exit) =>
		Exit.match(exit, {
			onFailure: (cause) => {
				throw Option.getOrElse(Cause.failureOption(cause), () =>
					Cause.squash(cause),
				);
			},
			onSuccess: (value) => value,
		}),
	);
