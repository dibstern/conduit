// Failure modes: concurrent requests share counters, routed streams lose SQL
// attribution, stream lifetime is timed, queued time is omitted, or disabling
// the warning still changes request execution.

import { SqliteClient } from "@effect/sql-sqlite-node";
import {
	Deferred,
	Effect,
	Fiber,
	Logger,
	Option,
	Queue,
	References,
	Schema,
	Stream,
} from "effect";
import {
	Rpc,
	RpcGroup,
	type RpcMessage,
	RpcSerialization,
	RpcServer,
} from "effect/rpc";
import { SqlClient, Statement } from "effect/sql";
import { describe, expect, it } from "vitest";
import { withSlowRpcLogging } from "../../../src/lib/server/ws-rpc-handler.js";

const Probe = Rpc.make("Probe", {
	payload: {
		projectSlug: Schema.String,
		sessionId: Schema.String,
		statements: Schema.Number,
	},
	success: Schema.Void,
	error: Schema.String,
});
const SubscribeProbe = Rpc.make("SubscribeProbe", {
	payload: { projectSlug: Schema.String },
	success: Schema.Number,
	error: Schema.String,
	stream: true,
});
const group = RpcGroup.make(Probe, SubscribeProbe);

const connect = (
	handler: (payload: Rpc.Payload<typeof Probe>) => Effect.Effect<void, string>,
	options: {
		readonly thresholdMs?: number;
		readonly concurrency?: number;
		readonly stream?: Stream.Stream<number, string>;
	} = {},
) =>
	Effect.gen(function* () {
		const requests = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
		const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
		const warnings = yield* Queue.unbounded<Record<string, unknown>>();
		const records: Record<string, unknown>[] = [];
		const ready = yield* Deferred.make<void>();
		const disconnects = yield* Queue.make<number>();
		const logger = Logger.make(({ message, fiber }) => {
			if (!Array.isArray(message) || message[0] !== "slow rpc") return;
			const record = { ...fiber.getRef(References.CurrentLogAnnotations) };
			records.push(record);
			Queue.offerUnsafe(warnings, record);
		});
		const protocol = RpcServer.Protocol.of({
			run: (handle) =>
				Deferred.succeed(ready, undefined).pipe(
					Effect.andThen(
						Effect.forever(
							Queue.take(requests).pipe(
								Effect.flatMap((request) => handle(1, request)),
							),
						),
					),
				),
			send: (_clientId, response) =>
				Queue.offer(responses, response).pipe(Effect.asVoid),
			disconnects,
			end: () => Effect.void,
			clientIds: Effect.succeed(new Set([1])),
			initialMessage: Effect.succeed(Option.none()),
			supportsAck: false,
			supportsTransferables: false,
			supportsSpanPropagation: false,
			supportsNotifications: false,
			codecFor: RpcSerialization.json.codecFor,
		});
		yield* RpcServer.make(group, {
			concurrency: options.concurrency ?? 32,
			spanPrefix: "RpcServer",
			disableFatalDefects: true,
		}).pipe(
			Effect.provideService(
				RpcServer.Protocol,
				withSlowRpcLogging(protocol, options.thresholdMs ?? 1),
			),
			Effect.provide(
				group.toLayer({
					Probe: handler,
					SubscribeProbe: () => Rpc.fork(options.stream ?? Stream.never),
				}),
			),
			Effect.provide(Logger.layer([logger])),
			Effect.forkScoped,
		);
		yield* Deferred.await(ready);
		return {
			requests,
			responses,
			warnings,
			records,
			submit: (id: string, sessionId: string, statements = 0) =>
				Queue.offer(requests, {
					_tag: "Request",
					id,
					tag: "Probe",
					payload: { projectSlug: "project", sessionId, statements },
					headers: [],
				}),
		};
	});

describe("slow browser RPC warnings", () => {
	it("isolates SQL across concurrent request fibers without a file tracer", async () => {
		let transformed = 0;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const started = yield* Deferred.make<void>();
					let active = 0;
					const server = yield* connect((payload) =>
						Effect.gen(function* () {
							if (++active === 2) yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(started);
							yield* Effect.sleep("5 millis");
							const child = yield* Effect.forkChild(
								Effect.forEach(
									Array.from({ length: payload.statements }),
									() => sql`SELECT 1`.pipe(Effect.orDie),
									{ discard: true },
								),
							);
							yield* Fiber.join(child);
						}),
					);
					yield* server.submit("1", "first", 2);
					yield* server.submit("2", "second", 5);
					yield* sql`SELECT 2`;
					const warnings = yield* Effect.all([
						Queue.take(server.warnings),
						Queue.take(server.warnings),
					]);
					for (const [sessionId, sqlCount] of [
						["first", 2],
						["second", 5],
					] as const) {
						const warning = warnings.find(
							(value) => value["sessionId"] === sessionId,
						);
						expect(warning).toMatchObject({
							method: "Probe",
							projectSlug: "project",
							sessionId,
							sqlCount,
							outcome: "success",
							kind: "request",
						});
						expect(warning?.["sqlMs"]).toBeGreaterThan(0);
						expect(warning?.["queuedMs"]).toBeGreaterThanOrEqual(0);
						expect(warning?.["totalMs"]).toBeGreaterThanOrEqual(
							Number(warning?.["queuedMs"]),
						);
					}
					expect(transformed).toBe(8);
				}),
			).pipe(
				Effect.provideService(Statement.CurrentTransformer, (statement) =>
					Effect.sync(() => {
						transformed++;
						return statement;
					}),
				),
				Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
			),
		);
	});

	it("counts routed-stream SQL and logs startup once before cancellation", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const context = yield* Effect.context<never>();
					const stream = Stream.fromEffect(
						sql`SELECT 1`.pipe(
							Effect.orDie,
							Effect.andThen(Effect.sleep("5 millis")),
							Effect.as(1),
						),
					).pipe(Stream.provideContext(context), Stream.concat(Stream.never));
					const server = yield* connect(() => Effect.void, { stream });
					yield* Queue.offer(server.requests, {
						_tag: "Request",
						id: "1",
						tag: "SubscribeProbe",
						payload: { projectSlug: "project" },
						headers: [],
					});
					expect(yield* Queue.take(server.responses)).toMatchObject({
						_tag: "Chunk",
					});
					expect(yield* Queue.take(server.warnings)).toMatchObject({
						method: "SubscribeProbe",
						requestId: "1",
						sqlCount: 1,
						kind: "stream-startup",
						outcome: "success",
					});
					yield* Effect.sleep("25 millis");
					yield* Queue.offer(server.requests, {
						_tag: "Interrupt",
						requestId: "1",
					});
					expect(yield* Queue.take(server.responses)).toMatchObject({
						_tag: "Exit",
					});
					yield* Effect.yieldNow;
					expect(server.records).toHaveLength(1);
				}),
			).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
		);
	});

	it("distinguishes terminal failures and interruption", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* connect((payload) =>
						Effect.sleep("5 millis").pipe(
							Effect.andThen(
								payload.sessionId === "failure"
									? Effect.fail("expected rejection")
									: Effect.interrupt,
							),
						),
					);
					for (const [id, outcome] of [
						["1", "failure"],
						["2", "interrupt"],
					] as const) {
						yield* server.submit(id, outcome);
						expect(yield* Queue.take(server.responses)).toMatchObject({
							_tag: "Exit",
							exit: { _tag: "Failure" },
						});
						expect(yield* Queue.take(server.warnings)).toMatchObject({
							requestId: id,
							outcome,
						});
					}
				}),
			),
		);
	});

	it("times a stream that fails before emitting its first chunk", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* connect(() => Effect.void, {
						stream: Stream.fromEffect(
							Effect.sleep("5 millis").pipe(
								Effect.andThen(Effect.fail("unavailable")),
							),
						),
					});
					yield* Queue.offer(server.requests, {
						_tag: "Request",
						id: "1",
						tag: "SubscribeProbe",
						payload: { projectSlug: "project" },
						headers: [],
					});
					expect(yield* Queue.take(server.responses)).toMatchObject({
						_tag: "Exit",
						exit: { _tag: "Failure" },
					});
					expect(yield* Queue.take(server.warnings)).toMatchObject({
						method: "SubscribeProbe",
						requestId: "1",
						kind: "stream-startup",
						outcome: "failure",
					});
				}),
			),
		);
	});

	it("includes the time waiting for the RPC concurrency permit", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* connect(() => Effect.sleep("30 millis"), {
						concurrency: 1,
					});
					yield* server.submit("1", "first");
					yield* server.submit("2", "second");
					const first = yield* Queue.take(server.warnings);
					const second = yield* Queue.take(server.warnings);
					expect(first["requestId"]).toBe("1");
					expect(second["requestId"]).toBe("2");
					expect(second["queuedMs"]).toBeGreaterThanOrEqual(20);
					expect(second["queuedMs"]).toBeGreaterThan(Number(first["queuedMs"]));
					expect(second["totalMs"]).toBeGreaterThan(Number(second["queuedMs"]));
				}),
			),
		);
	});

	it("disables warnings with a zero threshold", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const server = yield* connect(() => Effect.sleep("5 millis"), {
						thresholdMs: 0,
					});
					yield* server.submit("1", "disabled");
					expect(yield* Queue.take(server.responses)).toMatchObject({
						_tag: "Exit",
						exit: { _tag: "Success" },
					});
					yield* Effect.yieldNow;
					expect(server.records).toEqual([]);
				}),
			),
		);
	});
});
