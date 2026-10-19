import { Effect, Option, Result } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
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
type Payloads = {
	[T in UnaryTag]: Rpc.PayloadConstructor<Extract<Rpcs, { readonly _tag: T }>>;
};
type Payload<T extends UnaryTag> = Payloads[T];
type Success<T extends UnaryTag> = Rpc.Success<
	Extract<Rpcs, { readonly _tag: T }>
>;
type Declared<T extends UnaryTag> = Rpc.Error<
	Extract<Rpcs, { readonly _tag: T }>
>;

class RpcCallFailed extends RpcClientError {
	override get message(): string {
		return "RPC call failed";
	}

	override get cause(): unknown {
		return this.reason.cause;
	}
}

/** Call a unary RPC on the shared control socket, sending the payload as given. */
export function rpcEffect<T extends UnaryTag>(
	tag: T,
	payload: Payload<T>,
): Effect.Effect<Success<T>, Declared<T> | RpcClientError, WsRpcClients>;
export function rpcEffect(tag: UnaryTag, payload: Payload<UnaryTag>) {
	return Effect.gen(function* () {
		const clients = yield* WsRpcClients;
		const { control } = yield* clients.forProject("");
		return yield* control(tag, payload);
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.flatMap(Failure.isInterruptedByCaller, (byCaller) => {
				if (byCaller) return Effect.failCause(cause);
				const failure = Failure.soleFailure(cause);
				if (Option.isSome(failure)) return Effect.fail(failure.value);
				return Effect.fail(
					new RpcCallFailed({
						reason: new RpcClientDefect({
							message: "RPC call failed",
							cause: Failure.squashCause(cause),
						}),
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
		Effect.result(rpcEffect(tag, payload)),
	);
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}
