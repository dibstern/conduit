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
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { MessageWithParts } from "../../../src/lib/persistence/read-model-types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

type Member = "SubscribeShell" | "SubscribeSessionDetail";

// The only thing a subscription listens to is the read-model advance. The shell
// is driven by removals (which need no query at all) and detail by a routed
// advance (which re-reads `version > lastSeen`); between them the fixture
// exercises both arms of the orchestrator over the real RPC transport.
const advancesFor = (member: Member): readonly ReadModelAdvance[] =>
	member === "SubscribeShell"
		? [
				{ version: 1, sessionIds: [], removedSessionIds: ["session-1"] },
				{ version: 2, sessionIds: [], removedSessionIds: ["session-2"] },
			]
		: [
				{ version: 1, sessionIds: ["session-1"], removedSessionIds: [] },
				{ version: 2, sessionIds: ["session-1"], removedSessionIds: [] },
			];

const messageRow = (id: string, version = 0): MessageWithParts => ({
	id,
	version,
	session_id: "session-1",
	turn_id: null,
	role: "assistant",
	text: id,
	cost: null,
	tokens_in: null,
	tokens_out: null,
	tokens_cache_read: null,
	tokens_cache_write: null,
	context_window: null,
	is_streaming: 0,
	created_at: 1,
	updated_at: 1,
	parts: [],
});

const historyMessage = (id: string) => ({
	id,
	role: "assistant",
	time: { created: 1, completed: 1 },
	text: id,
	parts: [],
});

const readFailure = new ReadQueryEffectError({
	operation: "snapshot",
	cause: "fixture unavailable",
});

const makeLayer = (options: {
	readonly member: Member;
	readonly advances?: ReturnType<SessionEventBus["subscribeAdvances"]>;
	readonly failRead?: boolean;
}) =>
	WsRpcServerLayer.pipe(
		Layer.provide(
			Layer.mergeAll(
				makeSessionManagerStateLive(),
				Layer.succeed(ReadQueryEffectTag, {
					getToolContent: () => Effect.succeed(undefined),
					getSessionStatus: () => Effect.succeed(undefined),
					getSession: () => Effect.succeed(undefined),
					getAllSessionStatuses: () => Effect.succeed({}),
					listSessions: () => Effect.succeed([]),
					getSessionMessagesWithParts: () => Effect.succeed([]),
					// The catch-up read answers from its floor, so the version it
					// reports is the one the caller will next carry — stateless, and
					// identical for every subscriber that asks the same question.
					readSessionTranscript: (
						_sessionId: string,
						range?: { readonly after?: number; readonly through?: number },
					) =>
						options.failRead
							? Effect.fail(readFailure)
							: Effect.succeed(
									range?.after === undefined
										? { messages: [], version: 0 }
										: {
												messages: [
													messageRow(
														`message-${range.after + 1}`,
														range.after + 1,
													),
												],
												version: range.after + 1,
											},
								),
					readSessionList: () =>
						options.failRead
							? Effect.fail(readFailure)
							: Effect.succeed({ rows: [], version: 0 }),
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
					publishAdvance: () => Effect.void,
					subscribe: () => Effect.succeed(Stream.empty),
					subscribeAdvances: () =>
						options.advances ??
						Effect.succeed(Stream.fromIterable(advancesFor(options.member))),
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
const deltas = (member: Member) =>
	member === "SubscribeShell"
		? [
				// A removal carries no version of its own, so the advance is the whole
				// answer: a remove envelope without a database round trip.
				{ _tag: "remove", id: "session-1", sequence: 1 },
				{ _tag: "remove", id: "session-2", sequence: 2 },
			]
		: [1, 2].map((version) => ({
				_tag: "upsert",
				item: {
					_tag: "transcriptMessage",
					message: historyMessage(`message-${version}`),
				},
				sequence: version,
			}));

describe("RpcTest subscription stream semantics", () => {
	for (const member of ["SubscribeShell", "SubscribeSessionDetail"] as const) {
		// SubscribeShell's fork-lineage mapEffect emits singleton wire chunks.
		// Client mailbox reads may combine them. Session detail keeps source
		// chunks: the opening pair, then one chunk per advance that routes here.
		const handlerChunks =
			member === "SubscribeShell"
				? [...initial, ...deltas(member)].map((envelope) => [envelope])
				: [initial, ...deltas(member).map((envelope) => [envelope])];
		const chunkMessages = handlerChunks.map((values) => ({
			_tag: "Chunk" as const,
			values,
		}));
		const subscribe = (
			client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof WsRpcGroup>>,
		): Stream.Stream<unknown, WsRpcError> =>
			client[member]({ projectSlug: "project", sessionId: "session-1" });
		it.scoped(`${member} preserves handler chunking`, () =>
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
					...chunkMessages,
					{ _tag: "Exit", exit: Exit.void },
				]);
				expect(Array.from(chunks, Chunk.toReadonlyArray).flat()).toEqual([
					...initial,
					...deltas(member),
				]);
			}).pipe(Effect.provide(makeLayer({ member }))),
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
				for (let index = 0; index < chunkMessages.length; index++) {
					const ack = yield* Queue.take(acknowledgements);
					yield* TestClock.adjust("1 millis");
					// The callback returned, but this Ack has not reached the server.
					// Any next Chunk or terminal Exit must wait for its release.
					expect(messages).toEqual(chunkMessages.slice(0, index + 1));
					yield* ack;
				}
				yield* Fiber.join(consumer);
				expect(messages).toEqual([
					...chunkMessages,
					{ _tag: "Exit", exit: Exit.void },
				]);
			}).pipe(Effect.provide(makeLayer({ member }))),
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
				}).pipe(Effect.provide(makeLayer({ member, failRead: true }))),
		);

		it.scoped(
			`${member} interrupts the handler when the consumer scope closes`,
			() =>
				Effect.gen(function* () {
					for (const transport of ["RpcTest", "observed"] as const) {
						const released: Exit.Exit<unknown, unknown>[] = [];
						const advances = Effect.addFinalizer((exit) =>
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
							// RpcTest buffers both initial envelopes before this read;
							// the observed transport yields at its response queue.
							expect(Array.from(chunk)).toEqual(
								transport === "RpcTest" ? initial : handlerChunks[0],
							);
							if (transport === "observed" && member === "SubscribeShell") {
								const [synchronized] = yield* mailbox.takeAll;
								expect(Array.from(synchronized)).toEqual([initial[1]]);
							}
							expect(released).toEqual([]);
							yield* Scope.close(consumerScope, Exit.void);
							yield* TestClock.adjust("1 millis");
							if (transport === "observed") {
								expect(
									messages.filter((message) => message._tag === "Chunk"),
								).toEqual(
									chunkMessages.slice(0, member === "SubscribeShell" ? 2 : 1),
								);
								expect(messages.map((message) => message._tag)).toEqual([
									"Chunk",
									...(member === "SubscribeShell" ? ["Chunk"] : []),
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
						}).pipe(Effect.provide(makeLayer({ member, advances })));
					}
				}),
		);
	}
});
