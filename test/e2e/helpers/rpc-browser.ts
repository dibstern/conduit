import { Socket } from "@effect/platform";
import { RpcClient, RpcSchema, RpcSerialization } from "@effect/rpc";
import { Cause, Chunk, Effect, Layer, Schema, Stream } from "effect";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";

/** A real browser client for exercising the mock's WebSocket boundary. */
async function callRpc(tag: string, payload: unknown, take?: number) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup, { flatten: true });
			// These cases are generated from the contract at runtime.
			const call = client as (
				tag: string,
				payload: unknown,
			) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;
			const response = call(tag, payload);
			const result = yield* Effect.exit(
				Effect.isEffect(response)
					? response
					: take === undefined
						? Stream.runDrain(response)
						: Stream.runCollect(Stream.take(response, take)).pipe(
								Effect.map(Chunk.toReadonlyArray),
							),
			);
			if (result._tag === "Success") return { value: result.value };
			const failure = Cause.findErrorOption(result.cause);
			if (failure._tag === "None")
				return { defect: String(Cause.squash(result.cause)) };
			const error = failure.value;
			const rpc = WsRpcGroup.requests.get(tag);
			const stream = rpc && RpcSchema.getStreamSchemas(rpc.successSchema.ast);
			const decoded = rpc
				? Schema.decodeUnknownOption(
						Schema.Union(
							Schema.make(rpc.errorSchema.ast),
							stream?._tag === "Some"
								? Schema.make(stream.value.failure.ast)
								: Schema.Never,
						),
					)(JSON.parse(JSON.stringify(error)))
				: undefined;
			return {
				error: JSON.parse(JSON.stringify(error)) as unknown,
				isInstance:
					decoded?._tag === "Some" &&
					typeof decoded.value === "object" &&
					decoded.value !== null &&
					error instanceof decoded.value.constructor,
			};
		}).pipe(
			Effect.provide(
				RpcClient.layerProtocolSocket().pipe(
					Layer.provide(Socket.layerWebSocket(`ws://${location.host}/rpc`)),
					Layer.provide(Socket.layerWebSocketConstructorGlobal),
					Layer.provide(RpcSerialization.layerJson),
				),
			),
			Effect.scoped,
		),
	);
}

declare global {
	interface Window {
		callRpc: typeof callRpc;
	}
}
window.callRpc = callRpc;
