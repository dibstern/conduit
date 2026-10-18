import type { Rpc, RpcGroup } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect, Either, Option } from "effect";
import type { WsRpcGroup } from "../../contracts/ws-rpc.js";
import * as Failure from "../../effect/failure-classification.js";
import { runTransportEffect } from "./runtime.js";
import { WsRpcClients } from "./shared-client.js";

export type { GoalDetails } from "../../contracts/ws-rpc.js";
// Keep the public URL helper available to existing callers.
export { makeWsRpcUrl, type WsRpcLocation } from "./shared-client.js";

type Rpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type UnaryTag = {
	[T in Rpcs["_tag"]]: [Rpc.IsStream<Rpcs, T>] extends [never] ? T : never;
}[Rpcs["_tag"]];
type Payload<T extends UnaryTag> = Rpc.PayloadConstructor<
	Rpc.ExtractTag<Rpcs, T>
>;
type Success<T extends UnaryTag> = Rpc.Success<Rpc.ExtractTag<Rpcs, T>>;
type Declared<T extends UnaryTag> = Rpc.Error<Rpc.ExtractTag<Rpcs, T>>;

/** Call a unary RPC on the shared control socket, sending the payload as given. */
export function rpcEffect<T extends UnaryTag>(
	tag: T,
	payload: Payload<T>,
): Effect.Effect<Success<T>, Declared<T> | RpcClientError, WsRpcClients>;
export function rpcEffect<T extends UnaryTag>(tag: T, payload: Payload<T>) {
	return Effect.gen(function* () {
		const clients = yield* WsRpcClients;
		const { control } = yield* clients.forProject("");
		return yield* control(tag, payload);
	}).pipe(
		Effect.catchAllCause((cause) =>
			Effect.flatMap(Failure.isInterruptedByCaller, (byCaller) => {
				if (byCaller) return Effect.failCause(cause);
				const failure = Failure.soleFailure(cause);
				if (Option.isSome(failure)) return Effect.fail(failure.value);
				return Effect.fail(
					new RpcClientError({
						reason: "Unknown",
						message: "RPC call failed",
						cause: Failure.squashCause(cause),
					}),
				);
			}),
		),
	);
}

export async function rpc<T extends UnaryTag>(
	tag: T,
	payload: Payload<T>,
): Promise<Success<T>> {
	const result = await runTransportEffect(
		Effect.either(rpcEffect(tag, payload)),
	);
	if (Either.isLeft(result)) throw result.left;
	return result.right;
}
