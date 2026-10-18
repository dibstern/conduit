import { Effect, Exit, type Layer, Schema, Stream } from "effect";
import { Rpc, type RpcGroup, RpcSchema } from "effect/rpc";
import { WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";

type Rpcs = RpcGroup.Rpcs<typeof WsRpcGroup>;
type Tag = Rpcs["_tag"];
type Member<T extends Tag> = Rpc.ExtractTag<Rpcs, T>;
export type WsRpcHandlers = Rpc.ToHandler<Rpcs>;
export type StubTable = {
	readonly [T in Tag]?: (
		payload: Rpc.Payload<Member<T>>,
	) => Rpc.Success<Member<T>> extends Stream.Stream<infer A, infer E>
		? Stream.Stream<A, E>
		: Rpc.Success<Member<T>> | Promise<Rpc.Success<Member<T>>>;
};

/** A browser-safe alternative to the daemon's routed handler layer. */
export function stubWsRpc(table: StubTable): Layer.Layer<WsRpcHandlers> {
	const stubs: Readonly<
		Record<string, ((payload: never) => unknown) | undefined>
	> = table;
	const handlers: Record<
		string,
		(
			payload: never,
		) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>
	> = {};
	for (const rpc of WsRpcGroup.requests.values()) {
		// exitSchema includes stream failures as well as unary declared errors.
		const isDeclared = Schema.is(Schema.make(Rpc.exitSchema(rpc).ast));
		const classify = (error: unknown) =>
			isDeclared(Exit.fail(error)) ? Effect.fail(error) : Effect.die(error);
		if (RpcSchema.isStreamSchema(rpc.successSchema)) {
			handlers[rpc._tag] = (payload) =>
				Stream.unwrap(
					Effect.try({
						try: () => {
							// The stream-schema discriminant establishes this handler's result.
							const stub = stubs[rpc._tag] as
								| ((payload: never) => Stream.Stream<unknown, unknown>)
								| undefined;
							return stub ? stub(payload) : Stream.never;
						},
						catch: (error) => error,
					}).pipe(Effect.catchAll(classify)),
				);
		} else {
			handlers[rpc._tag] = (payload) =>
				Effect.suspend(() => {
					const stub = stubs[rpc._tag];
					if (!stub) return Effect.never;
					return Effect.tryPromise({
						try: async () => stub(payload),
						catch: (error) => error,
					}).pipe(Effect.catchAll(classify));
				});
		}
	}
	// Iterating the group loses tag/handler correlation. Each entry above is
	// constructed from that same RPC; callers remain checked by StubTable.
	return WsRpcGroup.toLayer(
		handlers as {
			[T in Tag]: (
				payload: Rpc.Payload<Member<T>>,
			) => Rpc.Success<Member<T>> extends Stream.Stream<infer A, infer E>
				? Stream.Stream<A, E>
				: Effect.Effect<Rpc.Success<Member<T>>, Rpc.Error<Member<T>>>;
		},
	);
}
