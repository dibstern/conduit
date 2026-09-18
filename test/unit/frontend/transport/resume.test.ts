// Client-side resume (ni8.5 T-3), driven at the shared client.
//
// The fake here is a fake `RpcClient.Protocol`, not a fake RPC client, so a drop
// can be injected in both shapes a real socket produces it. A socket that dies
// while idle writes a `ClientProtocolError` frame (`drop`). A socket that dies
// while a chunk is still being handed into the client's 16-deep mailbox
// interrupts that handover instead, and the mailbox closes on the interruption
// before any frame is written (`tearDown`, against a consumer held still).
// Nothing in these tests reaches into the resume implementation — a drop is
// injected at the wire and the assertions are the request frames the client sent
// and the envelopes the consumer saw.

import { RpcClient, type RpcMessage } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { describe, it } from "@effect/vitest";
import {
	Cause,
	Channel,
	Chunk,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Ref,
	Stream,
	TestClock,
} from "effect";
import { beforeAll, expect } from "vitest";
import { resumeStream } from "../../../../src/lib/frontend/transport/resume.js";
import {
	makeWsRpcClientsLayer,
	WsRpcClients,
	type WsRpcConnect,
	type WsRpcSockets,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import { WsRpcGroup } from "../../../../src/lib/frontend/transport/ws-rpc.js";

beforeAll(() => {
	Object.defineProperty(globalThis, "location", {
		value: { protocol: "http:", host: "localhost:2633" },
		configurable: true,
	});
});

interface RequestFrame {
	readonly tag: string;
	readonly id: string;
	readonly payload: unknown;
}

/** One fake socket: what the client sent, and what we push back at it. */
interface FakeLink {
	/** Blocks until the client sends its next request frame. */
	readonly takeRequest: Effect.Effect<RequestFrame>;
	/** How many request frames this link has carried so far. */
	readonly requestCount: Effect.Effect<number>;
	/** Blocks until a send is rejected because the socket is down. */
	readonly takeRejection: Effect.Effect<void>;
	/** Rejected sends not yet taken — a re-issue spinning shows up here. */
	readonly pendingRejections: Effect.Effect<number>;
	/**
	 * Deliver one envelope on the most recent request. Sequenced envelopes are
	 * also kept, and a later request is answered from that history the way the
	 * server answers one — everything past its `resumeFromSequence`, everything
	 * if it names none. So asking from the wrong point shows up as a duplicate
	 * or a gap at the consumer, not as a silent pass.
	 */
	readonly emit: (envelope: unknown) => Effect.Effect<void>;
	/**
	 * Keep an envelope without delivering it: the server produced it, the socket
	 * died before it arrived, and replay is where the consumer will first see it.
	 */
	readonly stage: (envelope: unknown) => Effect.Effect<void>;
	/** End the most recent request with a declared (domain) failure. */
	readonly failRequest: (message: string) => Effect.Effect<void>;
	/** Report the socket as gone, failing every in-flight request. */
	readonly drop: Effect.Effect<void>;
	/**
	 * Push envelopes from a fiber standing in for the socket's receive loop, so
	 * the handover suspends against a stalled consumer instead of the test.
	 */
	readonly emitDetached: (envelopes: readonly unknown[]) => Effect.Effect<void>;
	/**
	 * Kill that receive loop with no protocol frame at all — a socket torn down
	 * mid-handover, which is what backpressure turns every real drop into.
	 */
	readonly tearDown: Effect.Effect<void>;
	/** While down, sends fail immediately — as they do before a socket reopens. */
	readonly setDown: (down: boolean) => Effect.Effect<void>;
}

const resumePointOf = (payload: unknown): number | undefined =>
	typeof payload === "object" &&
	payload !== null &&
	"resumeFromSequence" in payload &&
	typeof payload.resumeFromSequence === "number"
		? payload.resumeFromSequence
		: undefined;

const sequenceOf = (envelope: unknown): number | undefined =>
	typeof envelope === "object" &&
	envelope !== null &&
	"sequence" in envelope &&
	typeof envelope.sequence === "number"
		? envelope.sequence
		: undefined;

const fakeTransport = () => {
	const links: Array<FakeLink> = [];

	const connect: WsRpcConnect = () =>
		Effect.gen(function* () {
			const sent = yield* Queue.unbounded<RequestFrame>();
			const rejected = yield* Queue.unbounded<void>();
			const latest = yield* Ref.make<RequestFrame | undefined>(undefined);
			const down = yield* Ref.make(false);
			const count = yield* Ref.make(0);
			const history: Array<{
				readonly sequence: number;
				readonly envelope: unknown;
			}> = [];
			const connectionScope = yield* Effect.scope;
			const receiving: Array<Fiber.RuntimeFiber<void, never>> = [];
			let write:
				| ((data: RpcMessage.FromServerEncoded) => Effect.Effect<void>)
				| undefined;

			const protocol = RpcClient.Protocol.make((w) =>
				Effect.sync(() => {
					write = w;
					return {
						send: (request: RpcMessage.FromClientEncoded) =>
							request._tag === "Request"
								? Effect.flatMap(Ref.get(down), (isDown) =>
										isDown
											? Effect.zipRight(
													Queue.offer(rejected, undefined),
													Effect.fail(
														new RpcClientError({
															reason: "Protocol",
															message: "socket is down",
														}),
													),
												)
											: Effect.gen(function* () {
													const frame: RequestFrame = {
														tag: request.tag,
														id: request.id,
														payload: request.payload,
													};
													yield* Ref.set(latest, frame);
													yield* Ref.update(count, (n) => n + 1);
													yield* Queue.offer(sent, frame);
													const resume = resumePointOf(request.payload);
													const backlog = history.filter(
														(entry) =>
															resume === undefined || entry.sequence > resume,
													);
													for (const entry of backlog) {
														yield* write?.({
															_tag: "Chunk",
															requestId: frame.id,
															values: [entry.envelope],
														}) ?? Effect.void;
													}
													// The server closes every replay with
													// `synchronized`, an empty replay included
													// (read-model-subscription.ts). A request without a
													// cursor is a cold start, whose `snapshot` +
													// `synchronized` the test scripts instead: the fake
													// holds a history, not a read model, so it has no
													// snapshot to serve.
													if (resume !== undefined) {
														yield* write?.({
															_tag: "Chunk",
															requestId: frame.id,
															values: [{ _tag: "synchronized" }],
														}) ?? Effect.void;
													}
												}),
									)
								: Effect.void,
						supportsAck: false,
						supportsTransferables: false,
					};
				}),
			);

			// Layer.build, not Effect.provide: the protocol forks its run loop into
			// the layer's scope, which must be this connection's scope.
			const client = yield* Layer.build(
				Layer.effect(RpcClient.Protocol, protocol),
			).pipe(
				Effect.flatMap((ctx) =>
					Effect.provide(RpcClient.make(WsRpcGroup), ctx),
				),
			);

			const push = (frame: (id: string) => RpcMessage.FromServerEncoded) =>
				Effect.flatMap(Ref.get(latest), (request) =>
					request === undefined || write === undefined
						? Effect.dieMessage("no request to answer")
						: write(frame(request.id)),
				);

			links.push({
				takeRequest: Queue.take(sent),
				requestCount: Ref.get(count),
				takeRejection: Queue.take(rejected),
				pendingRejections: Queue.size(rejected),
				emit: (envelope) =>
					Effect.suspend(() => {
						const sequence = sequenceOf(envelope);
						if (sequence !== undefined) {
							history.push({ sequence, envelope });
						}
						return push((id) => ({
							_tag: "Chunk",
							requestId: id,
							values: [envelope],
						}));
					}),
				stage: (envelope) =>
					Effect.sync(() => {
						const sequence = sequenceOf(envelope);
						if (sequence !== undefined) history.push({ sequence, envelope });
					}),
				failRequest: (message) =>
					push((id) => ({
						_tag: "Exit",
						requestId: id,
						exit: {
							_tag: "Failure",
							cause: {
								_tag: "Fail",
								error: { _tag: "WsRpcError", message },
							},
						},
					})),
				drop: Effect.suspend(() =>
					write === undefined
						? Effect.dieMessage("protocol not running")
						: write({
								_tag: "ClientProtocolError",
								error: new RpcClientError({
									reason: "Protocol",
									message: "Error in socket",
								}),
							}),
				),
				emitDetached: (envelopes) =>
					Effect.gen(function* () {
						for (const envelope of envelopes) {
							const sequence = sequenceOf(envelope);
							if (sequence !== undefined) history.push({ sequence, envelope });
						}
						receiving.push(
							yield* Effect.forkIn(connectionScope)(
								Effect.forEach(
									envelopes,
									(envelope) =>
										push((id) => ({
											_tag: "Chunk",
											requestId: id,
											values: [envelope],
										})),
									{ discard: true },
								),
							),
						);
					}),
				tearDown: Effect.suspend(() =>
					Effect.forEach(receiving.splice(0), Fiber.interrupt, {
						discard: true,
					}),
				),
				setDown: (isDown) => Ref.set(down, isDown),
			});

			return client;
		});

	return { links, connect };
};

/** Opens the pair for one project over the fake transport. Links are [control, stream]. */
const withSockets = <A, E>(
	use: (
		sockets: WsRpcSockets,
		links: { readonly control: FakeLink; readonly stream: FakeLink },
	) => Effect.Effect<A, E>,
) =>
	Effect.gen(function* () {
		const { links, connect } = fakeTransport();
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const clients = yield* WsRpcClients;
				const sockets = yield* clients.forProject("alpha");
				const [control, stream] = links;
				if (control === undefined || stream === undefined) {
					return yield* Effect.dieMessage("the pair did not open");
				}
				return yield* use(sockets, { control, stream });
			}).pipe(Effect.provide(makeWsRpcClientsLayer(connect))),
		);
	});

/**
 * Runs a subscription into a queue for the rest of the enclosing scope, and
 * hands back the exit so a test can assert how the stream ended.
 */
const collect = <A, E>(stream: Stream.Stream<A, E>) =>
	Effect.gen(function* () {
		const received = yield* Queue.unbounded<A>();
		const ended = yield* Effect.forkScoped(
			Stream.runForEach(stream, (item) => Queue.offer(received, item)),
		);
		return { received, ended };
	});

describe("client-side resume at the shared client", () => {
	it.effect("re-issues from the last sequence proven complete", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { received } = yield* collect(
						sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
					);

					const first = yield* links.stream.takeRequest;
					expect(first.payload).toEqual({
						projectSlug: "alpha",
						sessionId: "s1",
					});

					yield* links.stream.emit({
						_tag: "snapshot",
						rows: [],
						sequence: 11,
					});
					yield* links.stream.emit({ _tag: "remove", id: "m1", sequence: 12 });
					yield* links.stream.emit({ _tag: "remove", id: "m2", sequence: 13 });
					yield* Queue.take(received);
					yield* Queue.take(received);
					yield* Queue.take(received);

					yield* links.stream.drop;

					// 13 is still open — nothing has yet proven it had no siblings — so
					// the cursor sits on 12, which 13 itself proved complete.
					const reissued = yield* links.stream.takeRequest;
					expect(reissued.payload).toEqual({
						projectSlug: "alpha",
						sessionId: "s1",
						resumeFromSequence: 12,
					});
				}),
			),
		),
	);

	// Seam 3's acceptance, in the spec's own words: "the consumer observes one
	// uninterrupted stream with no repeated items". The interesting drops are the
	// ones around a group of siblings sharing a sequence, because that is the one
	// place the wire and the consumer see different things — the server replays
	// the whole group (it has to; the alternative loses siblings) and the client
	// drops the members it already delivered.
	//
	// The one thing that does come round again is `synchronized`, which closes
	// every replay: a marker, not an item, and the deliberate "you are live
	// again" signal. It is the first thing the consumer sees after each resume.
	const synchronized = { _tag: "synchronized" };
	const script: readonly unknown[] = [
		{ _tag: "snapshot", rows: [], sequence: 11 },
		{ _tag: "remove", id: "a", sequence: 12 },
		{ _tag: "remove", id: "b", sequence: 12 },
		{ _tag: "remove", id: "c", sequence: 13 },
		synchronized,
	];

	for (const point of [
		{ where: "before the group's first member", delivered: 1, resumeFrom: 11 },
		{ where: "between the group's members", delivered: 2, resumeFrom: 11 },
		{
			where: "after the group's last member, before the next sequence",
			delivered: 3,
			resumeFrom: 11,
		},
		{ where: "after `synchronized`", delivered: 5, resumeFrom: 13 },
	]) {
		it.effect(
			`one stream, no repeats, when the socket dies ${point.where}`,
			() =>
				withSockets((sockets, links) =>
					Effect.scoped(
						Effect.gen(function* () {
							const { received } = yield* collect(
								sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
							);
							yield* links.stream.takeRequest;

							for (const envelope of script.slice(0, point.delivered)) {
								yield* links.stream.emit(envelope);
							}
							const before = yield* Effect.replicateEffect(
								Queue.take(received),
								point.delivered,
							);

							// The drop lands with the consumer up to date, so the cursor under
							// test is the one it really reached.
							yield* links.stream.drop;
							expect((yield* links.stream.takeRequest).payload).toEqual({
								projectSlug: "alpha",
								sessionId: "s1",
								resumeFromSequence: point.resumeFrom,
							});

							// The fake answers that request from its history the way the
							// server does — everything past the named sequence, group members
							// already delivered included, then `synchronized` — and the
							// script carries on from there.
							for (const envelope of script.slice(point.delivered)) {
								yield* links.stream.emit(envelope);
							}
							const after = yield* Effect.replicateEffect(
								Queue.take(received),
								script.length - point.delivered + 1,
							);

							// Every member of the replayed group was already delivered, so
							// the marker closing that replay is the first thing through.
							expect(after[0]).toEqual(synchronized);
							expect([...before, ...after]).toEqual([
								...script.slice(0, point.delivered),
								synchronized,
								...script.slice(point.delivered),
							]);
							// Nothing lost, and nothing over: a repeat would be sitting here.
							yield* TestClock.adjust("1 milli");
							expect(yield* Queue.size(received)).toBe(0);
						}),
					),
				),
		);
	}

	it.effect(
		"a drop that delivered nothing keeps the caller's resume point",
		() =>
			withSockets((sockets, links) =>
				Effect.scoped(
					Effect.gen(function* () {
						const { received } = yield* collect(
							sockets.subscriptions.sessionDetail({
								sessionId: "s1",
								resumeFromSequence: 7,
							}),
						);

						const first = yield* links.stream.takeRequest;
						expect(first.payload).toEqual({
							projectSlug: "alpha",
							sessionId: "s1",
							resumeFromSequence: 7,
						});
						expect(yield* Queue.take(received)).toEqual(synchronized);

						yield* links.stream.drop;

						expect((yield* links.stream.takeRequest).payload).toEqual(
							first.payload,
						);
						// Nothing was delivered in between, so the whole of what the
						// consumer sees across the drop is the marker saying it is live
						// again — the one thing a resume repeats, and idempotent.
						expect(yield* Queue.take(received)).toEqual(synchronized);
					}),
				),
			),
	);

	it.effect("a drop before the first envelope still asks for a snapshot", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { received } = yield* collect(sockets.subscriptions.shell());

					yield* links.control.takeRequest;
					yield* links.control.drop;

					expect((yield* links.control.takeRequest).payload).toEqual({
						projectSlug: "alpha",
					});

					// No cursor means no replay to close, so this re-issue is a cold
					// start and the answer is a fresh snapshot — scripted here, since
					// the fake keeps a history rather than a read model — closed by the
					// same marker every resume ends with.
					yield* links.control.emit({
						_tag: "snapshot",
						rows: [],
						sequence: 4,
					});
					yield* links.control.emit(synchronized);
					expect([
						yield* Queue.take(received),
						yield* Queue.take(received),
					]).toEqual([
						{ _tag: "snapshot", rows: [], sequence: 4 },
						synchronized,
					]);
				}),
			),
		),
	);

	it.effect("a domain failure surfaces instead of being re-issued", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { ended } = yield* collect(
						sockets.subscriptions.sessionDetail({ sessionId: "gone" }),
					);

					yield* links.stream.takeRequest;
					yield* links.stream.failRequest("no such session");

					const exit = yield* ended.await;
					expect(Exit.isFailure(exit)).toBe(true);
					expect(exit).toMatchObject({
						cause: {
							error: { _tag: "WsRpcError", message: "no such session" },
						},
					});
					expect(yield* links.stream.requestCount).toBe(1);
				}),
			),
		),
	);

	// Not through the fake: the protocol has no way to say "and something threw
	// on the way down". `resumeStream` is asked directly, because the shape that
	// matters — a cause carrying a defect where a transport failure would sit —
	// only grows in-process.
	//
	// The failure mode being pinned is the tempting one: a defect looks enough
	// like a dead socket to be retried, and retrying it means an infinite loop
	// around a bug instead of a stack trace.
	it.effect("a defect surfaces instead of being re-issued", () =>
		Effect.gen(function* () {
			const issued = yield* Ref.make(0);
			const exit = yield* Stream.runDrain(
				resumeStream<{ readonly _tag: string }>(() =>
					Stream.unwrap(
						Effect.as(
							Ref.update(issued, (n) => n + 1),
							Stream.fromEffect(Effect.die("the projector blew up")),
						),
					),
				),
			).pipe(Effect.exit);

			expect(yield* Ref.get(issued)).toBe(1);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Chunk.toReadonlyArray(Cause.defects(exit.cause))).toContain(
					"the projector blew up",
				);
			}
		}),
	);

	// A retryable failure and a defect in one cause. Most ways of getting a cause
	// into a stream collapse it to the typed failure first, but a channel hands
	// it over whole — and then the defect decides, or a bug would be retried
	// forever behind an `RpcClientError` that happened to travel with it.
	it.effect("a defect beside a retryable failure still stops the stream", () =>
		Effect.gen(function* () {
			const issued = yield* Ref.make(0);
			const exit = yield* Stream.runDrain(
				resumeStream<{ readonly _tag: string }>(() =>
					Stream.unwrap(
						Effect.as(
							Ref.update(issued, (n) => n + 1),
							Stream.fromChannel(
								Channel.failCause(
									Cause.sequential(
										Cause.fail(
											new RpcClientError({
												reason: "Protocol",
												message: "socket is down",
											}),
										),
										Cause.die("the projector blew up"),
									),
								),
							),
						),
					),
				),
			).pipe(Effect.exit);

			expect(yield* Ref.get(issued)).toBe(1);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				expect(Chunk.toReadonlyArray(Cause.defects(exit.cause))).toContain(
					"the projector blew up",
				);
			}
		}),
	);

	it.effect(
		"backs off rather than spinning while the socket is still down",
		() =>
			withSockets((sockets, links) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* collect(
							sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
						);
						yield* links.stream.takeRequest;

						// The socket is gone and has not come back, so every send fails at
						// once. The immediate re-issue is rejected; an unpaced one would
						// burn the CPU until the transport reconnects, so the next attempt
						// waits — even after the socket is quietly usable again.
						yield* links.stream.setDown(true);
						yield* links.stream.drop;
						yield* links.stream.takeRejection;
						yield* TestClock.adjust("40 millis");
						expect(yield* links.stream.pendingRejections).toBe(0);

						yield* links.stream.setDown(false);
						expect(yield* links.stream.requestCount).toBe(1);

						yield* TestClock.adjust("10 millis");
						expect((yield* links.stream.takeRequest).payload).toEqual({
							projectSlug: "alpha",
							sessionId: "s1",
						});
					}),
				),
			),
	);

	it.effect("a drop between siblings sharing a sequence loses neither", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					// A session tombstone cascades: the parent's `remove` and each
					// child's carry the SAME store sequence. Server replay is exclusive,
					// so a cursor that moved to 10 on the parent would never see the
					// child.
					const { received } = yield* collect(
						sockets.subscriptions.shell({ resumeFromSequence: 9 }),
					);

					yield* links.control.takeRequest;
					// Subscribing with a cursor is a resume like any other: the server
					// drains replay — empty here — and says so.
					expect(yield* Queue.take(received)).toEqual(synchronized);
					yield* links.control.emit({
						_tag: "remove",
						id: "parent",
						sequence: 10,
					});
					const parent = yield* Queue.take(received);

					// The server sent the child too. The socket died first, so it is
					// still the server's to hand over, and replay is the only place it
					// can now arrive: everything at sequence 10 afterwards is behind the
					// server's own live filter.
					yield* links.control.stage({
						_tag: "remove",
						id: "child",
						sequence: 10,
					});
					yield* links.control.drop;
					expect((yield* links.control.takeRequest).payload).toEqual({
						projectSlug: "alpha",
						resumeFromSequence: 9,
					});

					// Replay re-folds event 10 in full — parent, child, marker. The
					// parent is the half already delivered and stops here; the child is
					// the half that was lost, and is why the cursor lagged.
					expect([
						parent,
						yield* Queue.take(received),
						yield* Queue.take(received),
					]).toEqual([
						{ _tag: "remove", id: "parent", sequence: 10 },
						{ _tag: "remove", id: "child", sequence: 10 },
						synchronized,
					]);
					// Once each: a second child would be sitting here.
					yield* TestClock.adjust("1 milli");
					expect(yield* Queue.size(received)).toBe(0);
				}),
			),
		),
	);

	// Live, not TestClock: the point is a real race — the handover has to be
	// parked inside the client's buffer at the instant the socket dies.
	it.live("resumes when the socket dies mid-handover, with no frame", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					// Hold the consumer on its first envelope so the client's mailbox
					// fills and the socket's handover suspends inside it.
					const release = yield* Deferred.make<void>();
					const received = yield* Queue.unbounded<unknown>();
					yield* Effect.forkScoped(
						Stream.runForEach(
							sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
							(item) =>
								Effect.zipRight(
									Queue.offer(received, item),
									Deferred.await(release),
								),
						),
					);

					yield* links.stream.takeRequest;
					yield* links.stream.emitDetached(
						Array.from({ length: 100 }, (_, index) => ({
							_tag: "remove",
							id: `m${index + 1}`,
							sequence: index + 1,
						})),
					);
					yield* Effect.sleep("50 millis");
					yield* links.stream.tearDown;
					yield* Deferred.succeed(release, undefined);

					const seen: Array<number> = [];
					let highest = 0;
					while (highest < 100) {
						const sequence = sequenceOf(yield* Queue.take(received));
						if (sequence === undefined) continue;
						seen.push(sequence);
						highest = Math.max(highest, sequence);
					}
					expect([...new Set(seen)].sort((a, b) => a - b)).toEqual(
						Array.from({ length: 100 }, (_, index) => index + 1),
					);
					expect(yield* links.stream.requestCount).toBeGreaterThan(1);
				}),
			),
		),
	);

	it.effect("stops for good when the consumer unsubscribes", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					const consumer = yield* Effect.fork(
						Stream.runForEach(
							sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
							() => Effect.void,
						),
					);
					yield* links.stream.takeRequest;
					yield* links.stream.emit({
						_tag: "remove",
						id: "m1",
						sequence: 1,
					});

					yield* Fiber.interrupt(consumer);
					yield* TestClock.adjust("5 seconds");

					expect(yield* links.stream.requestCount).toBe(1);
					expect(yield* links.stream.pendingRejections).toBe(0);
				}),
			),
		),
	);

	// Live, and deliberately awkward: in the ordinary consumer shapes the runtime
	// unwinds past the handler without ever offering it the cause, so the guard
	// looks like dead code. It is not. Pulling by hand inside an uninterruptible
	// region is the shape that reaches it — the cancellation is recorded on this
	// fiber but not yet delivered, so the handler runs with the consumer already
	// gone, and re-issuing there would talk to nobody, forever.
	it.live("does not re-issue an interruption the consumer itself caused", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					const pulled = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();

					// A daemon, so that a wrong answer below fails on its assertion
					// rather than wedging the test at scope close: an uninterruptible
					// fiber that re-issues has nothing left to interrupt it with.
					const consumer = yield* Effect.forkDaemon(
						Effect.scoped(
							Effect.gen(function* () {
								const pull = yield* Stream.toPull(
									sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
								);
								yield* Effect.uninterruptible(
									Effect.gen(function* () {
										yield* pull;
										yield* Deferred.succeed(pulled, undefined);
										yield* Deferred.await(release);
										// Drains what is buffered and then meets the transport's
										// interruption. Terminates on it — unless the guard is
										// wrong, in which case this re-issues and hangs, which
										// is a failure by another name.
										yield* Effect.ignore(Effect.forever(pull));
									}),
								);
							}),
						),
					);

					yield* links.stream.takeRequest;
					yield* links.stream.emitDetached(
						Array.from({ length: 40 }, (_, index) => ({
							_tag: "remove",
							id: `m${index + 1}`,
							sequence: index + 1,
						})),
					);
					yield* Deferred.await(pulled);
					yield* Effect.sleep("20 millis");

					// Cancel while the consumer cannot take it, then kill the socket
					// under it, so the two arrive at the handler together.
					yield* Effect.fork(Fiber.interrupt(consumer));
					yield* Effect.sleep("20 millis");
					yield* links.stream.tearDown;
					yield* Deferred.succeed(release, undefined);
					yield* Effect.sleep("100 millis");

					expect(yield* links.stream.requestCount).toBe(1);
				}),
			),
		),
	);

	it.effect("puts the shell on control and session detail on stream", () =>
		withSockets((sockets, links) =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* collect(sockets.subscriptions.shell());
					yield* collect(
						sockets.subscriptions.sessionDetail({ sessionId: "s1" }),
					);

					expect((yield* links.control.takeRequest).tag).toBe("SubscribeShell");
					expect((yield* links.stream.takeRequest).tag).toBe(
						"SubscribeSessionDetail",
					);
				}),
			),
		),
	);
});
