import {
	RpcClient,
	type RpcGroup,
	type RpcMessage,
	RpcServer,
	RpcTest,
} from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	Cause,
	Chunk,
	Effect,
	Exit,
	Fiber,
	Layer,
	type Mailbox,
	Queue,
	Scope,
	Stream,
	TestClock,
} from "effect";
import { expect } from "vitest";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	canonicalEvent,
	type StoredEvent,
} from "../../../src/lib/persistence/events.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

const events: readonly StoredEvent[] = [1, 2].map((sequence) => ({
	...canonicalEvent(
		"session.deleted",
		`session-${sequence}`,
		{ sessionId: `session-${sequence}` },
		{ provider: "claude", createdAt: sequence },
	),
	eventId: `event-${sequence}`,
	sequence,
	streamVersion: 1,
}));

const snapshotFailure = new ReadQueryEffectError({
	operation: "snapshot",
	cause: "fixture unavailable",
});
const makeLayer = (
	live: ReturnType<SessionEventBus["subscribe"]> = Effect.succeed(
		Stream.fromIterable(events),
	),
	failSnapshot = false,
) =>
	WsRpcServerLayer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(ReadQueryEffectTag, {
					getToolContent: () => Effect.succeed(undefined),
					getSessionStatus: () => Effect.succeed(undefined),
					getSession: () => Effect.succeed(undefined),
					getAllSessionStatuses: () => Effect.succeed({}),
					listSessions: () => Effect.succeed([]),
					getSessionListEntry: () => Effect.succeed(undefined),
					getSessionMessagesWithParts: () => Effect.succeed([]),
					getSessionDetailSnapshot: () =>
						failSnapshot
							? Effect.fail(snapshotFailure)
							: Effect.succeed({ messages: [], sequence: 0 }),
					getSessionListSnapshot: () =>
						failSnapshot
							? Effect.fail(snapshotFailure)
							: Effect.succeed({ rows: [], sequence: 0 }),
					getLatestTurnModelExecution: () => Effect.succeed(undefined),
				}),
				Layer.succeed(EventStoreEffectTag, {
					append: () => Effect.die("unused append"),
					appendBatch: () => Effect.succeed([]),
					readFromSequence: () => Effect.succeed([]),
					readBySession: () => Effect.succeed([]),
					readAllBySession: () => Effect.succeed([]),
					getNextStreamVersion: () => Effect.succeed(1),
				}),
				Layer.succeed(SessionEventBusTag, {
					publish: () => Effect.void,
					subscribe: () => live,
				}),
			),
		),
		Layer.provide(makeTestHandlerLayer()),
	);

// RpcTest exposes only the client. This companion uses the same public
// no-serialization pair to observe envelopes and release acknowledgements.
type Observation =
	| { readonly _tag: "Chunk"; readonly values: ReadonlyArray<unknown> }
	| { readonly _tag: "Exit"; readonly exit: Exit.Exit<unknown, unknown> }
	| { readonly _tag: "Interrupt" };
const makeObservedClient = (
	messages: Observation[],
	acknowledgements?: Queue.Queue<Effect.Effect<void>>,
) =>
	Effect.gen(function* () {
		const responses =
			yield* Queue.unbounded<
				RpcMessage.FromServer<RpcGroup.Rpcs<typeof WsRpcGroup>>
			>();
		const server = yield* RpcServer.makeNoSerialization(WsRpcGroup, {
			onFromServer: (message) =>
				Effect.gen(function* () {
					if (message._tag === "Chunk")
						messages.push({ _tag: "Chunk", values: message.values });
					if (message._tag === "Exit")
						messages.push({ _tag: "Exit", exit: message.exit });
					yield* Queue.offer(responses, message);
				}),
		});
		const { client, write } = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
			supportsAck: true,
			onFromClient: ({ message }) => {
				if (message._tag === "Interrupt") {
					messages.push({ _tag: "Interrupt" });
				}
				return message._tag === "Ack" && acknowledgements
					? Queue.offer(acknowledgements, server.write(0, message)).pipe(
							Effect.asVoid,
						)
					: server.write(0, message);
			},
		});
		yield* Stream.fromQueue(responses).pipe(
			Stream.runForEach(write),
			Effect.forkScoped,
		);
		return client;
	});

const initial = [
	{ _tag: "snapshot", rows: [], sequence: 0 },
	{ _tag: "synchronized" },
];
const deltas = (member: "SubscribeShell" | "SubscribeSessionDetail") =>
	member === "SubscribeShell"
		? [
				{ _tag: "remove", id: "session-1", sequence: 1 },
				{ _tag: "remove", id: "session-2", sequence: 2 },
			]
		: events.map((event) => ({
				_tag: "upsert",
				item: { _tag: "event", event },
				sequence: event.sequence,
			}));

describe("RpcTest subscription stream semantics", () => {
	for (const member of ["SubscribeShell", "SubscribeSessionDetail"] as const) {
		const subscribe = (
			client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof WsRpcGroup>>,
		): Stream.Stream<unknown, WsRpcError> =>
			client[member]({ projectSlug: "project", sessionId: "session-1" });
		it.scoped(`${member} preserves multi-element handler chunks`, () =>
			Effect.gen(function* () {
				const messages: Observation[] = [];
				const rpcTest = yield* RpcTest.makeClient(WsRpcGroup);
				const delivered = yield* subscribe(rpcTest).pipe(Stream.runCollect);
				expect(Array.from(delivered)).toEqual([...initial, ...deltas(member)]);
				const client = yield* makeObservedClient(messages);
				const chunks = yield* subscribe(client).pipe(
					Stream.chunks,
					Stream.runCollect,
				);
				expect(messages).toEqual([
					{ _tag: "Chunk", values: initial },
					{ _tag: "Chunk", values: deltas(member) },
					{ _tag: "Exit", exit: Exit.void },
				]);
				expect(Array.from(chunks, Chunk.toReadonlyArray).flat()).toEqual([
					...initial,
					...deltas(member),
				]);
			}).pipe(Effect.provide(makeLayer())),
		);
		it.scoped(`${member} waits for each chunk acknowledgement`, () =>
			Effect.gen(function* () {
				const messages: Observation[] = [];
				const acknowledgements = yield* Queue.unbounded<Effect.Effect<void>>();
				const client = yield* makeObservedClient(messages, acknowledgements);
				const consumer = yield* subscribe(client).pipe(
					Stream.runDrain,
					Effect.forkScoped,
				);
				const firstAck = yield* Queue.take(acknowledgements);
				yield* TestClock.adjust("1 millis");
				// The callback returned, but no Ack has reached the server. A run-ahead
				// server emits the second Chunk (and Exit) here and fails this equality.
				expect(messages).toEqual([{ _tag: "Chunk", values: initial }]);
				yield* firstAck;
				const secondAck = yield* Queue.take(acknowledgements);
				yield* TestClock.adjust("1 millis");
				expect(messages).toEqual([
					{ _tag: "Chunk", values: initial },
					{ _tag: "Chunk", values: deltas(member) },
				]);
				yield* secondAck;
				yield* Fiber.join(consumer);
				expect(messages).toEqual([
					{ _tag: "Chunk", values: initial },
					{ _tag: "Chunk", values: deltas(member) },
					{ _tag: "Exit", exit: Exit.void },
				]);
			}).pipe(Effect.provide(makeLayer())),
		);

		it.scoped(
			`${member} carries the declared failure in the terminal Exit`,
			() =>
				Effect.gen(function* () {
					const expected = Exit.fail(
						new WsRpcError({
							message: `${member} failed: ReadQueryEffectError: An error has occurred`,
						}),
					);
					const rpcTest = yield* RpcTest.makeClient(WsRpcGroup);
					const result = yield* subscribe(rpcTest).pipe(
						Stream.runDrain,
						Effect.exit,
					);
					expect(result).toEqual(expected);
					const messages: Observation[] = [];
					const client = yield* makeObservedClient(messages);
					const observed = yield* subscribe(client).pipe(
						Stream.runDrain,
						Effect.exit,
					);
					expect(messages).toEqual([{ _tag: "Exit", exit: expected }]);
					expect(observed).toEqual(expected);
				}).pipe(Effect.provide(makeLayer(undefined, true))),
		);

		it.scoped(
			`${member} interrupts the handler when the consumer scope closes`,
			() =>
				Effect.gen(function* () {
					for (const transport of ["RpcTest", "observed"] as const) {
						const released: Exit.Exit<unknown, unknown>[] = [];
						const live = Effect.addFinalizer((exit) =>
							Effect.sync(() => {
								released.push(exit);
							}),
						).pipe(Effect.as(Stream.never));
						yield* Effect.gen(function* () {
							const messages: Observation[] = [];
							const client = yield* transport === "RpcTest"
								? RpcTest.makeClient(WsRpcGroup)
								: makeObservedClient(messages);
							const consumerScope = yield* Scope.make();
							yield* Effect.addFinalizer(() =>
								Scope.close(consumerScope, Exit.void),
							);
							const subscription: Effect.Effect<
								Mailbox.ReadonlyMailbox<unknown, WsRpcError>,
								never,
								Scope.Scope
							> = client[member](
								{ projectSlug: "project", sessionId: "session-1" },
								{ asMailbox: true },
							);
							const mailbox = yield* subscription.pipe(
								Effect.provideService(Scope.Scope, consumerScope),
							);
							const [chunk] = yield* mailbox.takeAll;
							expect(Array.from(chunk)).toEqual(initial);
							expect(released).toEqual([]);
							yield* Scope.close(consumerScope, Exit.void);
							yield* TestClock.adjust("1 millis");
							if (transport === "observed") {
								expect(messages.map((message) => message._tag)).toEqual([
									"Chunk",
									"Interrupt",
									"Exit",
								]);
								const terminal = messages.at(-1);
								if (terminal?._tag !== "Exit" || !Exit.isFailure(terminal.exit))
									return yield* Effect.die(
										"Expected interrupted terminal Exit",
									);
								expect(Cause.isInterrupted(terminal.exit.cause)).toBe(true);
							}
							expect(
								released.map(
									(exit) =>
										Exit.isFailure(exit) && Cause.isInterrupted(exit.cause),
								),
							).toEqual([true]);
						}).pipe(Effect.provide(makeLayer(live)));
					}
				}),
		);
	}
});
