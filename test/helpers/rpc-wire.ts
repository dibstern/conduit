import {
	Cause,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Queue,
	Stream,
} from "effect";
import {
	RpcClient,
	type RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketCloseError } from "effect/socket/Socket";
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
		const disconnects = yield* Queue.make<number>();
		const parser = RpcSerialization.json.makeUnsafe();
		const protocol = RpcServer.Protocol.of({
			run: (handle) =>
				Deferred.succeed(ready, (frame) => handle(0, frame)).pipe(
					Effect.andThen(Effect.never),
				),
			disconnects,
			send: (_clientId, frame) =>
				Effect.suspend(() => {
					const json = parser.encode(frame);
					if (typeof json !== "string")
						return Effect.die(new Error("Expected JSON RPC serialization"));
					return send(json);
				}),
			end: () => Effect.void,
			clientIds: Effect.succeed(new Set([0])),
			initialMessage: Effect.succeed(Option.none()),
			supportsAck: false,
			supportsTransferables: false,
			supportsSpanPropagation: false,
			supportsNotifications: false,
			codecFor: RpcSerialization.json.codecFor,
		});
		yield* RpcServer.make(WsRpcGroup).pipe(
			Effect.provide(stubWsRpc(table)),
			Effect.provideService(RpcServer.Protocol, protocol),
			Effect.forkScoped,
		);
		const handle = yield* Deferred.await(ready);
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
			const parser = RpcSerialization.json.makeUnsafe();
			const receiving = new Set<Fiber.Fiber<void>>();
			const protocol = RpcClient.Protocol.make((write, clientIds) =>
				Effect.gen(function* () {
					let clientId = 0;
					const handle = yield* serveRpc(table, (json) =>
						Effect.gen(function* () {
							const fiber = yield* Effect.forkChild(
								Effect.forEach(
									parser.decode(json),
									(frame) =>
										write(clientId, frame as RpcMessage.FromServerEncoded),
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
							Effect.forEach(
								clientIds,
								(id) =>
									write(id, {
										_tag: "ClientProtocolError",
										error: new RpcClientError({
											reason: new SocketCloseError({
												code: 1006,
												closeReason: "socket closed",
											}),
										}),
									}),
								{ discard: true },
							),
						),
						tearDown: Effect.suspend(() =>
							Effect.forEach(receiving, Fiber.interrupt, { discard: true }),
						),
					});
					return {
						send: (id: number, frame: RpcMessage.FromClientEncoded) =>
							Effect.suspend(() => {
								clientId = id;
								if (frame._tag === "Request")
									requests.push({ ...frame, trafficClass });
								if (frame._tag === "Interrupt")
									interrupted.push(String(frame.requestId));
								const json = parser.encode(frame);
								if (typeof json !== "string")
									return Effect.die(
										new Error("Expected JSON RPC serialization"),
									);
								return (options?.beforeSend?.(frame) ?? Effect.void).pipe(
									Effect.andThen(handle(json)),
								);
							}),
						supportsAck: false,
						supportsTransferables: false,
						codecFor: RpcSerialization.json.codecFor,
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
		const queue = yield* Queue.make<A, E | Cause.Done>();
		return {
			stream: Stream.fromQueue(queue),
			emit: (...values: readonly A[]) =>
				Queue.offerAll(queue, values).pipe(Effect.asVoid),
			fail: (error: E) => Queue.fail(queue, error).pipe(Effect.asVoid),
			die: (defect: unknown) =>
				Queue.failCause(queue, Cause.die(defect)).pipe(Effect.asVoid),
			end: Queue.end(queue).pipe(Effect.asVoid),
		};
	});
