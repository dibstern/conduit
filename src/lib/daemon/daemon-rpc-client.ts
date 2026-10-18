import { createConnection, type Socket as NetSocket } from "node:net";
import { NodeSocket } from "@effect/platform-node";
import { Effect, Exit, Option, Schedule } from "effect";
import {
	type Rpc,
	RpcClient,
	type RpcGroup,
	RpcSerialization,
} from "effect/rpc";
import { Socket } from "effect/socket";
import { WsRpcGroup, type WsRpcRequest } from "../contracts/ws-rpc.js";
import * as Failure from "../effect/failure-classification.js";

type RpcSuccess<R extends WsRpcRequest> = Rpc.Success<
	Rpc.ExtractTag<RpcGroup.Rpcs<typeof WsRpcGroup>, R["_tag"]>
>;

export type SendRPC = <R extends WsRpcRequest>(
	request: R,
) => Promise<RpcSuccess<R>>;

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
export const sendRpcRequest = async <R extends WsRpcRequest>(
	socketPath: string,
	request: R,
	options: RpcRequestOptions = {},
): Promise<RpcSuccess<R>> => {
	const exit = await Effect.runPromise(
		Effect.exit(
			Effect.scoped(
				Effect.acquireRelease(
					Effect.tryPromise({
						try: () =>
							connectWhenReady(socketPath, options.startupRetries ?? 10),
						catch: (cause) => cause,
					}),
					(socket) => Effect.sync(() => socket.destroy()),
				).pipe(
					Effect.flatMap((connection) =>
						NodeSocket.fromDuplex(Effect.succeed(connection)),
					),
					Effect.flatMap((socket) =>
						RpcClient.make(WsRpcGroup, {
							flatten: true,
							spanPrefix: "RpcClient",
						}).pipe(
							Effect.flatMap((client) => {
								// A generic request keeps its tag and payload correlated, while
								// Flat models them as a union of overloads.
								const call = client as <T extends WsRpcRequest>(
									tag: T["_tag"],
									payload: T,
								) => Effect.Effect<RpcSuccess<T>, unknown>;
								return call(request._tag, request).pipe(
									Effect.timeoutOrElse({
										duration: options.requestTimeoutMs ?? 10_000,
										orElse: () =>
											Effect.fail(new Error(`RPC ${request._tag} timed out`)),
									}),
								);
							}),
							Effect.provide(
								RpcClient.layerProtocolSocket({
									retryPolicy: Schedule.recurs(0),
								}),
							),
							Effect.provideService(Socket.Socket, socket),
							Effect.provide(RpcSerialization.layerNdjson),
						),
					),
				),
			),
		),
	);
	return Exit.match(exit, {
		onFailure: (cause) => {
			throw Option.getOrElse(Failure.firstFailure(cause), () =>
				Failure.squashCause(cause),
			);
		},
		onSuccess: (value) => value,
	});
};
