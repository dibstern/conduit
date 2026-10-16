import {
	RpcClient,
	type RpcMessage,
	RpcSerialization,
	RpcServer,
} from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import {
	Chunk,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Mailbox,
	Option,
	Queue,
	Stream,
	Take,
} from "effect";
import { WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";
import type { WsRpcConnect } from "../../src/lib/frontend/transport/shared-client.js";
import { type StubTable, stubWsRpc } from "./stub-ws-rpc.js";

/** Real schema-aware server engine, with JSON bytes at its transport boundary. */
export const serveRpc = (
	table: StubTable,
	send: (json: string) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const ready =
			yield* Deferred.make<
				(frame: RpcMessage.FromClientEncoded) => Effect.Effect<void>
			>();
		const disconnects = yield* Mailbox.make<number>();
		const parser = RpcSerialization.json.unsafeMake();
		const protocol = RpcServer.Protocol.of({
			run: (handle) =>
				Deferred.succeed(ready, (frame) => handle(0, frame)).pipe(
					Effect.zipRight(Effect.never),
				),
			disconnects,
			send: (_clientId, frame) =>
				Effect.suspend(() => {
					const json = parser.encode(frame);
					if (typeof json !== "string")
						return Effect.dieMessage("Expected JSON RPC serialization");
					return send(json);
				}),
			end: () => Effect.void,
			clientIds: Effect.succeed(new Set([0])),
			initialMessage: Effect.succeed(Option.none()),
			supportsAck: false,
			supportsTransferables: false,
			supportsSpanPropagation: false,
		});
		yield* RpcServer.make(WsRpcGroup).pipe(
			Effect.provide(stubWsRpc(table)),
			Effect.provideService(RpcServer.Protocol, protocol),
			Effect.forkScoped,
		);
		const handle = yield* ready;
		return (json: string) =>
			Effect.forEach(
				parser.decode(json),
				// The JSON parser erases the frame type at this byte boundary.
				(frame) => handle(frame as RpcMessage.FromClientEncoded),
				{ discard: true },
			);
	});

/** One fake wire shared by transport and store tests. Replies come only from serveRpc. */
export function makeRpcWire(
	table: StubTable,
	options?: {
		readonly beforeSend?: (
			frame: RpcMessage.FromClientEncoded,
		) => Effect.Effect<void, RpcClientError>;
	},
) {
	const requests: (RpcMessage.RequestEncoded & { trafficClass: string })[] = [];
	const interrupted: string[] = [];
	const connections: {
		trafficClass: string;
		drop: Effect.Effect<void>;
		tearDown: Effect.Effect<void>;
	}[] = [];
	const connect: WsRpcConnect = ({ trafficClass }) =>
		Effect.gen(function* () {
			const parser = RpcSerialization.json.unsafeMake();
			const receiving = new Set<Fiber.RuntimeFiber<void>>();
			const protocol = RpcClient.Protocol.make((write) =>
				Effect.gen(function* () {
					const handle = yield* serveRpc(table, (json) =>
						Effect.gen(function* () {
							const fiber = yield* Effect.fork(
								Effect.forEach(
									parser.decode(json),
									(frame) => write(frame as RpcMessage.FromServerEncoded),
									{ discard: true },
								),
							);
							receiving.add(fiber);
							yield* Fiber.join(fiber).pipe(
								Effect.ensuring(Effect.sync(() => receiving.delete(fiber))),
							);
						}),
					);
					connections.push({
						trafficClass,
						drop: Effect.suspend(() =>
							write({
								_tag: "ClientProtocolError",
								error: new RpcClientError({
									reason: "Protocol",
									message: "socket closed",
								}),
							}),
						),
						tearDown: Effect.suspend(() =>
							Effect.forEach(receiving, Fiber.interrupt, { discard: true }),
						),
					});
					return {
						send: (frame: RpcMessage.FromClientEncoded) =>
							Effect.suspend(() => {
								if (frame._tag === "Request")
									requests.push({ ...frame, trafficClass });
								if (frame._tag === "Interrupt")
									interrupted.push(frame.requestId);
								const json = parser.encode(frame);
								if (typeof json !== "string")
									return Effect.dieMessage("Expected JSON RPC serialization");
								return (options?.beforeSend?.(frame) ?? Effect.void).pipe(
									Effect.zipRight(handle(json)),
								);
							}),
						supportsAck: false,
						supportsTransferables: false,
					};
				}),
			);
			const context = yield* Layer.build(
				Layer.effect(RpcClient.Protocol, protocol),
			);
			return yield* RpcClient.make(WsRpcGroup, { flatten: true }).pipe(
				Effect.provide(context),
			);
		});
	return { connect, requests, interrupted, connections };
}

/** Queue-backed values, failures and completion for a stream stub. */
export const makeRpcStream = <A, E>() =>
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<Take.Take<A, E>>();
		return {
			stream: Stream.fromQueue(queue).pipe(Stream.flattenTake),
			emit: (...values: readonly A[]) =>
				Queue.offer(queue, Take.chunk(Chunk.fromIterable(values))).pipe(
					Effect.asVoid,
				),
			fail: (error: E) =>
				Queue.offer(queue, Take.fail(error)).pipe(Effect.asVoid),
			die: (defect: unknown) =>
				Queue.offer(queue, Take.die(defect)).pipe(Effect.asVoid),
			end: Queue.offer(queue, Take.end).pipe(Effect.asVoid),
		};
	});
