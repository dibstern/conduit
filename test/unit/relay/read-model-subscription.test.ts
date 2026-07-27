import { describe, it } from "@effect/vitest";
import {
	Chunk,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import { expect } from "vitest";
import {
	type Delta,
	type SubscriptionSource,
	stream,
} from "../../../src/lib/domain/relay/Services/read-model-subscription.js";

// T deliberately has no `id` field: the module never inspects the payload.
interface Row {
	readonly title: string;
}

const upsert = <T>(item: T, sequence: number): Delta<T> => ({
	_tag: "upsert",
	item,
	sequence,
});

const remove = (id: string, sequence: number): Delta<never> => ({
	_tag: "remove",
	id,
	sequence,
});

/**
 * Fake SubscriptionSource with hand-controlled interleaving:
 * - `live()` creates its queue at acquisition time, so `pushLive` dies unless
 *   the module really subscribed first (pins the subscribe-before-snapshot
 *   invariant instead of silently buffering).
 * - `gateSnapshot` holds `snapshot()` open between `snapshotStarted` and
 *   `snapshotGate`, letting a test push a racing live delta mid-read.
 * - `gateReplay` holds `replay()` open the same way (`replayStarted` /
 *   `replayGate`) AND asserts, at replay's first pull, that `live()` was
 *   already acquired — dying fast otherwise, so a live-after-replay resume
 *   regression fails deterministically instead of hanging.
 * All sequencing is via Deferred/Queue — no sleeps, no timing assumptions.
 */
const makeFakeSource = <T>(
	options: {
		readonly snapshot?: {
			readonly rows: readonly T[];
			readonly sequence: number;
		};
		readonly replay?: readonly Delta<T>[];
		readonly gateSnapshot?: boolean;
		readonly gateReplay?: boolean;
	} = {},
) =>
	Effect.gen(function* () {
		const liveQueue = yield* Ref.make(Option.none<Queue.Queue<Delta<T>>>());
		const liveAcquired = yield* Deferred.make<void>();
		const liveReleased = yield* Ref.make(false);
		const snapshotStarted = yield* Deferred.make<void>();
		const snapshotGate = yield* Deferred.make<void>();
		const replayStarted = yield* Deferred.make<void>();
		const replayGate = yield* Deferred.make<void>();

		const gatedReplay = Stream.unwrap(
			Effect.gen(function* () {
				// First pull of the resume replay: live MUST already be subscribed,
				// or a delta committed during replay would be lost.
				if (!(yield* Deferred.isDone(liveAcquired))) {
					return yield* Effect.dieMessage(
						"replay consumed before live() was acquired",
					);
				}
				yield* Deferred.succeed(replayStarted, undefined);
				yield* Deferred.await(replayGate);
				return Stream.fromIterable(options.replay ?? []);
			}),
		);

		const source: SubscriptionSource<T> = {
			snapshot: () =>
				Effect.gen(function* () {
					yield* Deferred.succeed(snapshotStarted, undefined);
					if (options.gateSnapshot) yield* Deferred.await(snapshotGate);
					return options.snapshot ?? { rows: [], sequence: 0 };
				}),
			replay: () =>
				options.gateReplay
					? gatedReplay
					: Stream.fromIterable(options.replay ?? []),
			live: () =>
				Effect.gen(function* () {
					const queue = yield* Queue.unbounded<Delta<T>>();
					yield* Effect.addFinalizer(() => Ref.set(liveReleased, true));
					yield* Ref.set(liveQueue, Option.some(queue));
					yield* Deferred.succeed(liveAcquired, undefined);
					return Stream.fromQueue(queue);
				}),
		};

		const pushLive = (...deltas: readonly Delta<T>[]) =>
			Ref.get(liveQueue).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.dieMessage("pushLive before live() was acquired"),
						onSome: (queue) => Queue.offerAll(queue, deltas),
					}),
				),
				Effect.asVoid,
			);

		return {
			source,
			pushLive,
			liveAcquired,
			liveReleased,
			snapshotStarted,
			snapshotGate,
			replayStarted,
			replayGate,
		};
	});

describe("ReadModelSubscription", () => {
	it.scoped(
		"cold start emits snapshot, then synchronized, then live deltas",
		() =>
			Effect.gen(function* () {
				const rowA: Row = { title: "a" };
				const rowB: Row = { title: "b" };
				const fake = yield* makeFakeSource<Row>({
					snapshot: { rows: [rowA, rowB], sequence: 5 },
				});

				const fiber = yield* stream({ source: fake.source }).pipe(
					Stream.take(3),
					Stream.runCollect,
					Effect.fork,
				);
				yield* Deferred.await(fake.liveAcquired);
				yield* fake.pushLive(upsert({ title: "c" }, 6));

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got).toEqual([
					{ _tag: "snapshot", rows: [rowA, rowB], sequence: 5 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: { title: "c" }, sequence: 6 },
				]);
			}),
	);

	it.scoped(
		"delivers a delta committed during the snapshot read exactly once, after synchronized",
		() =>
			Effect.gen(function* () {
				const fake = yield* makeFakeSource<Row>({
					snapshot: { rows: [{ title: "base" }], sequence: 5 },
					gateSnapshot: true,
				});

				const fiber = yield* stream({ source: fake.source }).pipe(
					Stream.take(4),
					Stream.runCollect,
					Effect.fork,
				);

				// Snapshot is now in flight; live MUST already be subscribed —
				// pushLive dies if the module had not acquired live() first.
				yield* Deferred.await(fake.snapshotStarted);
				yield* fake.pushLive(upsert({ title: "racer" }, 6));
				yield* Deferred.succeed(fake.snapshotGate, undefined);
				// Sentinel: if "racer" were duplicated it would occupy slot 4.
				yield* fake.pushLive(upsert({ title: "after" }, 7));

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got).toEqual([
					{ _tag: "snapshot", rows: [{ title: "base" }], sequence: 5 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: { title: "racer" }, sequence: 6 },
					{ _tag: "upsert", item: { title: "after" }, sequence: 7 },
				]);
			}),
	);

	it.scoped("drops live deltas at or below the snapshot high-water mark", () =>
		Effect.gen(function* () {
			const fake = yield* makeFakeSource<Row>({
				snapshot: { rows: [{ title: "base" }], sequence: 5 },
			});

			const fiber = yield* stream({ source: fake.source }).pipe(
				Stream.take(4),
				Stream.runCollect,
				Effect.fork,
			);
			yield* Deferred.await(fake.liveAcquired);
			// Queue is FIFO: if a stale delta leaked through it would precede
			// "fresh" in the collected output and fail the exact-order assert.
			yield* fake.pushLive(
				upsert({ title: "stale" }, 4),
				upsert({ title: "boundary" }, 5),
				upsert({ title: "fresh" }, 6),
				remove("session-x", 7),
			);

			const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
			expect(got).toEqual([
				{ _tag: "snapshot", rows: [{ title: "base" }], sequence: 5 },
				{ _tag: "synchronized" },
				{ _tag: "upsert", item: { title: "fresh" }, sequence: 6 },
				{ _tag: "remove", id: "session-x", sequence: 7 },
			]);
		}),
	);

	it.scoped(
		"resume replays strictly-after the cursor, no snapshot envelope, then live with dedup",
		() =>
			Effect.gen(function* () {
				const fake = yield* makeFakeSource<Row>({
					snapshot: { rows: [{ title: "must-not-be-read" }], sequence: 99 },
					replay: [upsert({ title: "missed" }, 6), remove("archived", 7)],
				});

				const fiber = yield* stream({
					source: fake.source,
					resumeFromSequence: 5,
				}).pipe(Stream.take(4), Stream.runCollect, Effect.fork);
				yield* Deferred.await(fake.liveAcquired);
				yield* fake.pushLive(
					upsert({ title: "already-seen" }, 5),
					upsert({ title: "new" }, 8),
				);

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got).toEqual([
					{ _tag: "upsert", item: { title: "missed" }, sequence: 6 },
					{ _tag: "remove", id: "archived", sequence: 7 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: { title: "new" }, sequence: 8 },
				]);
				// Resume must not even consult snapshot().
				expect(yield* Deferred.isDone(fake.snapshotStarted)).toBe(false);
			}),
	);

	it.scoped(
		"resume advances the HWM past the last replayed delta, so live copies in the overlap window are dropped",
		() =>
			Effect.gen(function* () {
				// The (cursor, lastReplayed] window: a delta committed there is
				// delivered by BOTH replay and live. Live's copy must be dropped,
				// even though its sequence exceeds the resume cursor.
				const fake = yield* makeFakeSource<Row>({
					replay: [upsert({ title: "six" }, 6), upsert({ title: "seven" }, 7)],
				});

				const fiber = yield* stream({
					source: fake.source,
					resumeFromSequence: 5,
				}).pipe(Stream.take(4), Stream.runCollect, Effect.fork);
				yield* Deferred.await(fake.liveAcquired);
				yield* fake.pushLive(
					upsert({ title: "six-again" }, 6), // overlap: replay already sent 6
					upsert({ title: "seven-again" }, 7), // boundary: == last replayed
					upsert({ title: "eight" }, 8), // genuinely new
				);

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got).toEqual([
					{ _tag: "upsert", item: { title: "six" }, sequence: 6 },
					{ _tag: "upsert", item: { title: "seven" }, sequence: 7 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: { title: "eight" }, sequence: 8 },
				]);
			}),
	);

	it.scoped(
		"resume acquires live before consuming replay, so a delta arriving during replay is not lost",
		() =>
			Effect.gen(function* () {
				// `gateReplay` dies at replay's first pull unless live() is already
				// acquired — a live-after-replay resume regression fails fast here
				// rather than silently dropping the mid-replay delta.
				const fake = yield* makeFakeSource<Row>({
					replay: [upsert({ title: "r6" }, 6), upsert({ title: "r7" }, 7)],
					gateReplay: true,
				});

				const fiber = yield* stream({
					source: fake.source,
					resumeFromSequence: 5,
				}).pipe(Stream.take(4), Stream.runCollect, Effect.fork);

				// Drive the happy path from a child fiber: replayStarted only fires
				// once the guard passed (live already acquired), at which point we
				// push a delta WHILE replay is blocked — its sequence exceeds the
				// last replayed one, so it must survive dedup — then release replay.
				// Under a live-after-replay regression the guard dies at replay's
				// first pull, this child never proceeds, and `Fiber.join` below
				// surfaces the die immediately (no timeout); the child is
				// interrupted when the test scope closes.
				yield* Effect.forkScoped(
					Deferred.await(fake.replayStarted).pipe(
						Effect.zipRight(fake.pushLive(upsert({ title: "live8" }, 8))),
						Effect.zipRight(Deferred.succeed(fake.replayGate, undefined)),
					),
				);

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got).toEqual([
					{ _tag: "upsert", item: { title: "r6" }, sequence: 6 },
					{ _tag: "upsert", item: { title: "r7" }, sequence: 7 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: { title: "live8" }, sequence: 8 },
				]);
			}),
	);

	it.scoped(
		"closing the enclosing scope releases the live subscription and terminates the stream",
		() =>
			Effect.gen(function* () {
				const fake = yield* makeFakeSource<Row>({
					snapshot: { rows: [], sequence: 0 },
				});
				const scope = yield* Scope.make();

				const fiber = yield* stream({ source: fake.source }).pipe(
					Stream.runDrain,
					Effect.forkIn(scope),
				);
				yield* Deferred.await(fake.liveAcquired);
				expect(yield* Ref.get(fake.liveReleased)).toBe(false);

				yield* Scope.close(scope, Exit.void);

				expect(yield* Ref.get(fake.liveReleased)).toBe(true);
				expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
			}),
	);

	it.scoped(
		"passes snapshot rows, upsert items, and remove ids through untouched",
		() =>
			Effect.gen(function* () {
				const rows = [{ payload: { nested: [1, 2, 3] } }];
				const item = { payload: { nested: ["x"] } };
				const fake = yield* makeFakeSource<{ payload: unknown }>({
					snapshot: { rows, sequence: 1 },
				});

				const fiber = yield* stream({ source: fake.source }).pipe(
					Stream.take(4),
					Stream.runCollect,
					Effect.fork,
				);
				yield* Deferred.await(fake.liveAcquired);
				yield* fake.pushLive(upsert(item, 2), remove("opaque-id-é", 3));

				const got = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
				expect(got.map((e) => e._tag)).toEqual([
					"snapshot",
					"synchronized",
					"upsert",
					"remove",
				]);
				const [snap, , up, rm] = got;
				if (
					snap?._tag !== "snapshot" ||
					up?._tag !== "upsert" ||
					rm?._tag !== "remove"
				) {
					throw new Error("unreachable: tags asserted above");
				}
				// Same references — the module neither clones nor inspects payloads.
				expect(snap.rows).toBe(rows);
				expect(up.item).toBe(item);
				expect(rm.id).toBe("opaque-id-é");
			}),
	);
});
