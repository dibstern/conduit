// Feed supervision (ni8.5 R5), driven through the shared client over an
// in-memory transport. A test answers each SubscribeShell request the way the
// server would — envelopes, a WsRpcError, a clean end, a defect — and asserts
// only what a consumer sees: the envelopes, the statuses, and when the
// subscription is asked for again.

import { RpcClient, type RpcMessage } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import {
	Chunk,
	Duration,
	Effect,
	Fiber,
	Layer,
	Logger,
	LogLevel,
	Queue,
	Stream,
	TestClock,
} from "effect";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
	makeWsRpcClientsLayer,
	WsRpcClients,
	type WsRpcConnect,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import {
	type FeedStatus,
	retryFeedsNow,
	supervise,
} from "../../../../src/lib/frontend/transport/supervise.js";
import { WsRpcGroup } from "../../../../src/lib/frontend/transport/ws-rpc.js";

/** One subscription request, and the server's side of answering it. */
interface Served {
	readonly emit: (
		...envelopes: readonly [object, ...object[]]
	) => Effect.Effect<void>;
	readonly fail: (message: string) => Effect.Effect<void>;
	readonly end: Effect.Effect<void>;
	readonly die: (message: string) => Effect.Effect<void>;
}

const inMemoryTransport = Effect.gen(function* () {
	const requests = yield* Queue.unbounded<Served>();
	const connect: WsRpcConnect = () =>
		Effect.gen(function* () {
			let write:
				| ((frame: RpcMessage.FromServerEncoded) => Effect.Effect<void>)
				| undefined;
			const answer = (frame: RpcMessage.FromServerEncoded) =>
				Effect.suspend(() =>
					write === undefined ? Effect.dieMessage("not running") : write(frame),
				);
			const exit = (
				requestId: string,
				exit: RpcMessage.ResponseExitEncoded["exit"],
			) => answer({ _tag: "Exit", requestId, exit });
			const protocol = RpcClient.Protocol.make((w) =>
				Effect.sync(() => {
					write = w;
					return {
						send: (request: RpcMessage.FromClientEncoded) =>
							request._tag === "Request"
								? Queue.offer(requests, {
										emit: (...values) =>
											answer({ _tag: "Chunk", requestId: request.id, values }),
										fail: (message) =>
											exit(request.id, {
												_tag: "Failure",
												cause: {
													_tag: "Fail",
													error: { _tag: "WsRpcError", message },
												},
											}),
										end: exit(request.id, {
											_tag: "Success",
											value: undefined,
										}),
										die: (message) =>
											exit(request.id, {
												_tag: "Failure",
												cause: { _tag: "Die", defect: message },
											}),
									})
								: Effect.void,
						supportsAck: false,
						supportsTransferables: false,
					};
				}),
			);
			return yield* Layer.build(
				Layer.effect(RpcClient.Protocol, protocol),
			).pipe(
				Effect.flatMap((ctx) =>
					Effect.provide(RpcClient.make(WsRpcGroup), ctx),
				),
			);
		});
	return { requests, connect };
});

/**
 * Supervises the shell feed for the rest of the test. `request` waits for the
 * next time the feed is asked for; `pending` counts asks nobody has taken.
 */
const superviseShell = Effect.gen(function* () {
	const { requests, connect } = yield* inMemoryTransport;
	const statuses: FeedStatus[] = [];
	const received: object[] = [];
	// Built into the test's scope, so the sockets outlive this setup.
	const clients = yield* Layer.build(makeWsRpcClientsLayer(connect));
	const sockets = yield* Effect.flatMap(WsRpcClients, (shared) =>
		shared.forProject("alpha"),
	).pipe(Effect.provide(clients));
	const consumer = yield* Effect.forkScoped(
		Stream.runForEach(
			supervise(sockets.subscriptions.shell(), (status) => {
				statuses.push(status);
			}),
			(envelope) => Effect.sync(() => received.push(envelope)),
		),
	);
	return {
		request: Queue.take(requests),
		pending: Queue.size(requests),
		statuses,
		received,
		consumer,
	};
});

/** Lets every runnable fiber settle before asserting that nothing happened. */
const settle = Effect.repeatN(Effect.yieldNow(), 50);

/** Waits until the supervisor is parked on its backoff timer. */
const untilWaiting = Effect.gen(function* () {
	while (Chunk.isEmpty(yield* TestClock.sleeps())) yield* Effect.yieldNow();
});

/**
 * Asserts the feed is asked for again exactly `millis` after it went down:
 * not a moment sooner, and without needing anything but the clock.
 */
const restartsAfter = (
	feed: Effect.Effect.Success<typeof superviseShell>,
	millis: number,
) =>
	Effect.gen(function* () {
		yield* untilWaiting;
		yield* TestClock.adjust(Duration.millis(millis - 1));
		yield* settle;
		expect(yield* feed.pending).toBe(0);
		yield* TestClock.adjust(Duration.millis(1));
		return yield* feed.request;
	});

const snapshot = { _tag: "snapshot", rows: [], sequence: 1 };
const synchronized = { _tag: "synchronized" };

beforeEach(() => {
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:2633" });
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal(
		"document",
		Object.assign(new EventTarget(), { visibilityState: "hidden" }),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("supervise", () => {
	it.scoped(
		"reports cold, then catching up, then live as the feed arrives",
		() =>
			Effect.gen(function* () {
				const feed = yield* superviseShell;
				const served = yield* feed.request;
				yield* settle;
				expect(feed.statuses).toEqual([{ _tag: "cold" }]);

				yield* served.emit(snapshot);
				yield* settle;
				expect(feed.statuses).toEqual([
					{ _tag: "cold" },
					{ _tag: "catchingUp" },
				]);

				yield* served.emit(synchronized);
				yield* settle;
				expect(feed.statuses).toEqual([
					{ _tag: "cold" },
					{ _tag: "catchingUp" },
					{ _tag: "live" },
				]);
				expect(feed.received).toEqual([snapshot, synchronized]);
			}),
	);
	it.scoped(
		"restarts after a server error on a 1s x1.5 backoff capped at 10s",
		() =>
			Effect.gen(function* () {
				const feed = yield* superviseShell;
				let served = yield* feed.request;
				yield* served.emit(snapshot, synchronized);
				yield* served.fail("Project unavailable");
				for (const millis of [
					1000, 1500, 2250, 3375, 5062.5, 7593.75, 10000, 10000,
				]) {
					served = yield* restartsAfter(feed, millis);
					yield* served.fail("Project unavailable");
				}
				yield* settle;
				// The streak began when the feed first went down, at t=0, and every
				// restart since has failed without the feed coming back.
				expect(feed.statuses.at(-1)).toEqual({
					_tag: "failing",
					since: 0,
					lastError: "Project unavailable",
				});
				expect(feed.received).toEqual([snapshot, synchronized]);
			}),
	);
	it.scoped("starts the backoff over once the feed has caught up again", () =>
		Effect.gen(function* () {
			const feed = yield* superviseShell;
			yield* Effect.flatMap(feed.request, (served) => served.fail("busy"));
			yield* Effect.flatMap(restartsAfter(feed, 1000), (served) =>
				served.fail("busy"),
			);
			const recovered = yield* restartsAfter(feed, 1500);
			yield* recovered.emit(snapshot, synchronized);
			yield* settle;
			expect(feed.statuses.at(-1)).toEqual({ _tag: "live" });

			yield* recovered.fail("busy");
			yield* restartsAfter(feed, 1000);
		}),
	);

	it.scoped("treats the feed ending as a failure and restarts it", () =>
		Effect.gen(function* () {
			const feed = yield* superviseShell;
			const served = yield* feed.request;
			yield* served.emit(snapshot, synchronized);
			yield* TestClock.adjust(Duration.seconds(5));
			yield* served.end;
			yield* settle;
			expect(feed.statuses.at(-1)).toEqual({
				_tag: "failing",
				since: 5000,
				lastError: "The feed ended",
			});
			const restarted = yield* restartsAfter(feed, 1000);
			// A fresh snapshot is not recovery; the server saying so is.
			yield* restarted.emit(snapshot);
			yield* settle;
			expect(feed.statuses.at(-1)).toMatchObject({ _tag: "failing" });
			yield* restarted.emit(synchronized);
			yield* settle;
			expect(feed.statuses.at(-1)).toEqual({ _tag: "live" });
			expect(feed.received).toEqual([
				snapshot,
				synchronized,
				snapshot,
				synchronized,
			]);
		}),
	);

	it.scoped("restarts after a defect, logging it as an error", () =>
		Effect.gen(function* () {
			const logged: LogLevel.LogLevel[] = [];
			const feed = yield* superviseShell.pipe(
				Effect.provide(
					Logger.replace(
						Logger.defaultLogger,
						Logger.make(({ logLevel }) => {
							logged.push(logLevel);
						}),
					),
				),
			);
			yield* Effect.flatMap(feed.request, (served) => served.die("boom"));
			yield* restartsAfter(feed, 1000);
			expect(logged).toEqual([LogLevel.Error]);
			expect(feed.statuses.at(-1)).toMatchObject({ _tag: "failing" });
		}),
	);

	const wakeUps = {
		"the tab becoming visible": () => {
			Object.assign(document, { visibilityState: "visible" });
			document.dispatchEvent(new Event("visibilitychange"));
		},
		"the network coming back": () => window.dispatchEvent(new Event("online")),
		"the page being restored from the back/forward cache": () =>
			window.dispatchEvent(
				Object.assign(new Event("pageshow"), { persisted: true }),
			),
		"the user asking to retry": retryFeedsNow,
	};

	for (const [trigger, wake] of Object.entries(wakeUps)) {
		it.scoped(`restarts at once on ${trigger}`, () =>
			Effect.gen(function* () {
				const feed = yield* superviseShell;
				yield* Effect.flatMap(feed.request, (served) => served.fail("busy"));
				yield* untilWaiting;
				wake();
				yield* feed.request;
			}),
		);
	}

	it.scoped("keeps waiting through a tab hiding or a fresh page load", () =>
		Effect.gen(function* () {
			const feed = yield* superviseShell;
			yield* Effect.flatMap(feed.request, (served) => served.fail("busy"));
			yield* untilWaiting;
			document.dispatchEvent(new Event("visibilitychange"));
			window.dispatchEvent(
				Object.assign(new Event("pageshow"), { persisted: false }),
			);
			yield* settle;
			expect(yield* feed.pending).toBe(0);
		}),
	);

	it.scoped("stops for good when the consumer lets go", () =>
		Effect.gen(function* () {
			const feed = yield* superviseShell;
			const served = yield* feed.request;
			yield* served.emit(snapshot, synchronized);
			yield* settle;
			yield* Fiber.interrupt(feed.consumer);
			yield* TestClock.adjust(Duration.minutes(1));
			retryFeedsNow();
			yield* settle;
			expect(yield* feed.pending).toBe(0);
		}),
	);

	it.scoped("stops for good when the consumer lets go mid-backoff", () =>
		Effect.gen(function* () {
			const feed = yield* superviseShell;
			yield* Effect.flatMap(feed.request, (served) => served.fail("busy"));
			yield* untilWaiting;
			yield* Fiber.interrupt(feed.consumer);
			yield* TestClock.adjust(Duration.minutes(1));
			retryFeedsNow();
			yield* settle;
			expect(yield* feed.pending).toBe(0);
		}),
	);
});
