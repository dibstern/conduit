import { describe, it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Exit,
	Fiber,
	Queue,
	Ref,
	Scope,
	Stream,
} from "effect";
import { expect } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import {
	type AdvanceRoute,
	type Envelope,
	type SubscriptionSource,
	stream,
	type VersionRange,
} from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";

// T deliberately has no `id` field: the module never inspects the payload.
interface Row {
	readonly title: string;
}

const advance = (
	version: number,
	sessionIds: readonly string[] = ["session-1"],
	removedSessionIds: readonly string[] = [],
): ReadModelAdvance => ({ version, sessionIds, removedSessionIds });

/** A row the fake read model keys by its own title. */
const row = (title: string) => ({ id: title, row: { title } });

/**
 * A fake read model behind a real {@link SubscriptionSource}: rows keyed by id,
 * stamped with the version that wrote them, and one counter. `read(range)` is
 * the only query, exactly as the real sources have it, so the tests exercise
 * the orchestrator's whole contract — base, catch-up and live are the same call
 * and the assertions on `calls` prove both when it was NOT made and what window
 * it was made over.
 *
 * `gateRead` holds the first read open between `readStarted` and `readGate`,
 * letting a test publish an advance mid-read. The gate opens once and stays
 * open, so later reads run free.
 *
 * `onNextRead` is the other half of that: an effect run ONCE, at the start of
 * the next read, before it takes its state. That is where a commit lands when
 * it arrives after its predecessor's advance was delivered but before the query
 * that advance triggered — the interleaving the reviewer's probes turn on.
 */
const makeFakeSource = <T>(
	options: {
		readonly resume?: "catchUp" | "rebase";
		readonly route?: (advance: ReadModelAdvance) => AdvanceRoute;
		readonly gateRead?: boolean;
	} = {},
) =>
	Effect.gen(function* () {
		const table = yield* Ref.make<
			readonly {
				readonly id: string;
				readonly version: number;
				readonly row: T;
			}[]
		>([]);
		const counter = yield* Ref.make(0);
		const calls = yield* Ref.make<readonly (VersionRange | undefined)[]>([]);
		const readStarted = yield* Deferred.make<void>();
		const readGate = yield* Deferred.make<void>();
		const onNextRead = yield* Ref.make<Effect.Effect<void>>(Effect.void);

		const source: SubscriptionSource<T> = {
			read: (range) =>
				Effect.gen(function* () {
					yield* Ref.update(calls, (seen) => [...seen, range]);
					yield* yield* Ref.getAndSet(onNextRead, Effect.void);
					const floor = range?.after ?? -1;
					const ceiling = range?.through ?? Number.MAX_SAFE_INTEGER;
					const rows = (yield* Ref.get(table))
						.filter(
							(entry) => entry.version > floor && entry.version <= ceiling,
						)
						.map((entry) => ({ item: entry.row, version: entry.version }));
					const version = yield* Ref.get(counter);
					// Consistent state taken; the query is still in flight, which is
					// where a real transaction sits when a commit races it.
					yield* Deferred.succeed(readStarted, undefined);
					if (options.gateRead) yield* Deferred.await(readGate);
					return { rows, version };
				}),
			route:
				options.route ??
				((signal) => ({
					moved: signal.sessionIds.length > 0,
					removed: signal.removedSessionIds,
				})),
			resume: options.resume ?? "rebase",
		};

		/** What a commit leaves behind: rows stamped by id, counter moved. */
		const commit = (
			version: number,
			...entries: readonly { readonly id: string; readonly row: T }[]
		) =>
			Ref.update(table, (rowsSoFar) => [
				...rowsSoFar.filter(
					(existing) => !entries.some((entry) => entry.id === existing.id),
				),
				...entries.map(({ id, row }) => ({ id, version, row })),
			]).pipe(Effect.zipRight(Ref.set(counter, version)));

		/** A deletion: the row is gone, leaving no version behind to query (§8). */
		const drop = (version: number, ...ids: readonly string[]) =>
			Ref.update(table, (rowsSoFar) =>
				rowsSoFar.filter((existing) => !ids.includes(existing.id)),
			).pipe(Effect.zipRight(Ref.set(counter, version)));

		return { source, commit, drop, calls, readStarted, readGate, onNextRead };
	});

/**
 * Run a subscription into a queue. Taking the opening envelopes proves the base
 * read finished, so a test can commit and publish with no race to lose.
 */
const subscribe = <T>(options: {
	readonly source: SubscriptionSource<T>;
	readonly bus: SessionEventBus;
	readonly resumeFromSequence?: number;
}) =>
	Effect.gen(function* () {
		const queue = yield* Queue.unbounded<Envelope<T>>();
		const fiber = yield* Effect.forkScoped(
			Stream.runForEach(stream(options), (envelope) =>
				Queue.offer(queue, envelope),
			),
		);
		return { queue, fiber };
	});

const withBus = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.provide(effect, SessionEventBusLive);

describe("ReadModelSubscription", () => {
	it.scoped("cold start emits snapshot, synchronized, then re-queries", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("a"), row("b"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "snapshot",
					rows: [{ title: "a" }, { title: "b" }],
					sequence: 5,
				});
				expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });

				yield* fake.commit(6, row("c"));
				yield* bus.publishAdvance(advance(6));

				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "c" },
					sequence: 6,
				});
				// Base over everything, then one window per advance, bounded at both
				// ends by the versions that define it. One question, asked twice.
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 6 },
				]);
			}),
		),
	);

	it.scoped(
		"delivers an advance published during the base read once, after synchronized",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({ gateRead: true });
					yield* fake.commit(5, row("base"));

					const { queue } = yield* subscribe({ source: fake.source, bus });

					// The base read has taken its state and is still in flight — it will
					// not see this commit. The advance subscription must already exist
					// or the publish goes nowhere and the row is lost for good.
					yield* Deferred.await(fake.readStarted);
					yield* fake.commit(6, row("racer"));
					yield* bus.publishAdvance(advance(6));
					yield* Deferred.succeed(fake.readGate, undefined);

					expect(yield* Queue.take(queue)).toEqual({
						_tag: "snapshot",
						rows: [{ title: "base" }],
						sequence: 5,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "racer" },
						sequence: 6,
					});

					// Sentinel: a duplicated "racer" would occupy this slot.
					yield* fake.commit(7, row("after"));
					yield* bus.publishAdvance(advance(7));
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "after" },
						sequence: 7,
					});
				}),
			),
	);

	it.scoped("ignores an advance at or below the base's version", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("base"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				yield* Queue.take(queue);
				yield* Queue.take(queue);

				// Stale and boundary: both are already in the base by definition.
				yield* bus.publishAdvance(advance(4, [], ["base"]));
				yield* bus.publishAdvance(advance(5, [], ["base"]));
				yield* fake.commit(6, row("fresh"));
				yield* bus.publishAdvance(advance(6));

				// FIFO: a leaked advance would surface ahead of "fresh".
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "fresh" },
					sequence: 6,
				});
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 6 },
				]);
			}),
		),
	);

	it.scoped(
		"does not query for an advance that touches nothing it serves",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({
						route: (signal) => ({
							moved: signal.sessionIds.includes("mine"),
							removed: [],
						}),
					});
					yield* fake.commit(5, row("base"));

					const { queue } = yield* subscribe({ source: fake.source, bus });
					yield* Queue.take(queue);
					yield* Queue.take(queue);

					yield* bus.publishAdvance(advance(6, ["someone-else"]));
					yield* fake.commit(7, row("mine-moved"));
					yield* bus.publishAdvance(advance(7, ["mine"]));

					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "mine-moved" },
						sequence: 7,
					});
					// The unrouted advance cost nothing: no read for version 6 at all.
					expect(yield* Ref.get(fake.calls)).toEqual([
						undefined,
						{ after: 5, through: 7 },
					]);
				}),
			),
	);

	it.scoped("queries a removal-only window before advancing seen", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("a"), row("b"));
				const { queue } = yield* subscribe({ source: fake.source, bus });
				yield* Queue.take(queue);
				yield* Queue.take(queue);
				yield* fake.commit(6, { id: "a", row: { title: "a-renamed" } });
				yield* fake.drop(7, "b");
				// A silent write can precede the only routed signal, a removal.
				yield* bus.publishAdvance(advance(7, [], ["b"]));
				const first = yield* Queue.take(queue);
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 7 },
				]);
				const second = yield* Queue.take(queue);
				expect([first, second]).toEqual(
					expect.arrayContaining([
						{ _tag: "upsert", item: { title: "a-renamed" }, sequence: 6 },
						{ _tag: "remove", id: "b", sequence: 7 },
					]),
				);
			}),
		),
	);

	it.scoped("reports removals after querying their window", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("base"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				yield* Queue.take(queue);
				yield* Queue.take(queue);

				yield* bus.publishAdvance(advance(6, [], ["gone-a", "gone-b"]));

				expect(yield* Queue.take(queue)).toEqual({
					_tag: "remove",
					id: "gone-a",
					sequence: 6,
				});
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "remove",
					id: "gone-b",
					sequence: 6,
				});
				// The query covers any earlier rows before this removal closes the window.
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 6 },
				]);
			}),
		),
	);

	it.scoped(
		"carries upserts and removes from one advance at one sequence",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>();
					yield* fake.commit(5, row("base"));

					const { queue } = yield* subscribe({ source: fake.source, bus });
					yield* Queue.take(queue);
					yield* Queue.take(queue);

					// One commit that renamed a parent and deleted its child: the client's
					// resume cursor may only advance past the pair together (T-3).
					yield* fake.commit(6, row("renamed"));
					yield* bus.publishAdvance(advance(6, ["parent"], ["child"]));

					// Removals lead the group, so a drop and a re-create that land
					// together settle on the row that survived.
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "remove",
						id: "child",
						sequence: 6,
					});
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "renamed" },
						sequence: 6,
					});
				}),
			),
	);

	it.scoped(
		"resume on a catch-up source replays past the cursor, no base",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({ resume: "catchUp" });
					yield* fake.commit(5, row("already-held"));
					yield* fake.commit(6, row("missed"));
					yield* fake.commit(7, row("also-missed"));

					const { queue } = yield* subscribe({
						source: fake.source,
						bus,
						resumeFromSequence: 5,
					});

					// Exclusive: the cursor's own version is what the client already has.
					// Each replayed row carries the version it was first delivered at,
					// not the counter the replay happened to read — that is the identity
					// the client's cursor recognises a repeat by.
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "missed" },
						sequence: 6,
					});
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "also-missed" },
						sequence: 7,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					expect(yield* Ref.get(fake.calls)).toEqual([{ after: 5 }]);

					// And the resume point is the number the envelopes carry, so live
					// picks up from there with no gap and no repeat.
					yield* fake.commit(8, row("live"));
					yield* bus.publishAdvance(advance(8));
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "live" },
						sequence: 8,
					});
				}),
			),
	);

	it.scoped(
		"resume on a rebase source re-reads the whole set as a snapshot",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({ resume: "rebase" });
					yield* fake.commit(5, row("still-here"));
					yield* fake.commit(6, row("new"));

					const { queue } = yield* subscribe({
						source: fake.source,
						bus,
						resumeFromSequence: 5,
					});

					// Absence is the removal: only a full re-read can tell a reconnecting
					// client that a row it still shows is gone.
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "snapshot",
						rows: [{ title: "still-here" }, { title: "new" }],
						sequence: 6,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					expect(yield* Ref.get(fake.calls)).toEqual([undefined]);
				}),
			),
	);

	it.scoped("gives each advance its own window and its own sequence", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("base"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				yield* Queue.take(queue);
				yield* Queue.take(queue);

				// Two commits land before either advance arrives. The read for 6 is
				// bounded above by 6, so it cannot report "seven" — and therefore
				// cannot claim to have delivered what the advance at 7 still owes.
				yield* fake.commit(6, row("six"));
				yield* fake.commit(7, row("seven"));
				yield* bus.publishAdvance(advance(6));
				yield* bus.publishAdvance(advance(7));

				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "six" },
					sequence: 6,
				});
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "seven" },
					sequence: 7,
				});

				yield* fake.commit(8, row("eight"));
				yield* bus.publishAdvance(advance(8));
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "eight" },
					sequence: 8,
				});
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 6 },
					{ after: 6, through: 7 },
					{ after: 7, through: 8 },
				]);
			}),
		),
	);

	// ─── The reviewer's two probes ───────────────────────────────────────────
	// Both turn on the same interleaving: a commit lands after an advance has
	// been delivered but before the query that advance triggered runs. A
	// watermark taken from that query's own counter jumps past advances still
	// queued; bounding the query by the advance is what stops it.

	it.scoped("keeps a removal an overtaking commit would have swallowed", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("a"), row("b"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "snapshot",
					rows: [{ title: "a" }, { title: "b" }],
					sequence: 5,
				});
				expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });

				// Commit 6 renames A. Commit 7 deletes B and lands before the re-query
				// for advance 6 runs. Treating that read's counter as seen would
				// retire the queued removal, and nothing could recover it: B no
				// longer exists to be found (§8).
				yield* fake.commit(6, { id: "a", row: { title: "a-renamed" } });
				yield* Ref.set(fake.onNextRead, fake.drop(7, "b"));
				yield* bus.publishAdvance(advance(6, ["a"]));
				yield* bus.publishAdvance(advance(7, [], ["b"]));

				expect(yield* Queue.take(queue)).toEqual({
					_tag: "upsert",
					item: { title: "a-renamed" },
					sequence: 6,
				});
				expect(yield* Queue.take(queue)).toEqual({
					_tag: "remove",
					id: "b",
					sequence: 7,
				});
				// Both routed advances query their bounded window.
				expect(yield* Ref.get(fake.calls)).toEqual([
					undefined,
					{ after: 5, through: 6 },
					{ after: 6, through: 7 },
				]);
			}),
		),
	);

	it.scoped("orders a removal before the re-creation that follows it", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				yield* fake.commit(5, row("a"), row("b"));

				const { queue } = yield* subscribe({ source: fake.source, bus });
				yield* Queue.take(queue);
				yield* Queue.take(queue);

				// Commit 6 updates A and deletes B; commit 7 re-creates B and lands
				// before the re-query for 6. The stale removal must not outrank the
				// re-creation, and advance 7 must not be skipped for it.
				yield* fake.commit(6, { id: "a", row: { title: "a-updated" } });
				yield* fake.drop(6, "b");
				yield* Ref.set(
					fake.onNextRead,
					fake.commit(7, { id: "b", row: { title: "b-recreated" } }),
				);
				yield* bus.publishAdvance(advance(6, ["a"], ["b"]));
				yield* bus.publishAdvance(advance(7, ["b"]));

				const delivered = [
					yield* Queue.take(queue),
					yield* Queue.take(queue),
					yield* Queue.take(queue),
				];
				expect(delivered).toEqual([
					{ _tag: "remove", id: "b", sequence: 6 },
					{ _tag: "upsert", item: { title: "a-updated" }, sequence: 6 },
					{ _tag: "upsert", item: { title: "b-recreated" }, sequence: 7 },
				]);
				// Monotonic non-decreasing, which is what a client reads as "the
				// previous group is complete".
				const sequences = delivered.map((envelope) =>
					envelope._tag === "synchronized" ? -1 : envelope.sequence,
				);
				expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
			}),
		),
	);

	it.scoped(
		"rebases when the sliding bus loses a removal during the base read",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({ gateRead: true });
					yield* fake.commit(5, row("b"));
					const { queue } = yield* subscribe({ source: fake.source, bus });
					yield* Deferred.await(fake.readStarted);
					yield* fake.drop(6, "b");
					yield* bus.publishAdvance(advance(6, [], ["b"]));
					// Exactly 256 more publications evict the deletion from the default bus.
					for (let version = 7; version <= 262; version++) {
						yield* fake.commit(version, { id: "a", row: { title: "a" } });
						yield* bus.publishAdvance(advance(version, ["a"]));
					}
					yield* Deferred.succeed(fake.readGate, undefined);
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "snapshot",
						rows: [{ title: "b" }],
						sequence: 5,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "snapshot",
						rows: [{ title: "a" }],
						sequence: 262,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					yield* fake.commit(263, row("after"));
					yield* bus.publishAdvance(advance(263));
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "after" },
						sequence: 263,
					});
				}),
			),
	);

	it.scoped(
		"rebases after a live read stalls even when surviving advances are unrouted",
		() =>
			withBus(
				Effect.gen(function* () {
					const bus = yield* SessionEventBusTag;
					const fake = yield* makeFakeSource<Row>({
						route: (signal) => ({
							moved: signal.sessionIds.includes("mine"),
							removed: signal.removedSessionIds,
						}),
					});
					yield* fake.commit(5, row("b"));
					const { queue } = yield* subscribe({ source: fake.source, bus });
					yield* Queue.take(queue);
					yield* Queue.take(queue);
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					yield* Ref.set(
						fake.onNextRead,
						Effect.zipRight(
							Deferred.succeed(entered, undefined),
							Deferred.await(release),
						),
					);
					yield* fake.commit(6, row("a"));
					yield* bus.publishAdvance(advance(6, ["mine"]));
					yield* Deferred.await(entered);
					yield* fake.drop(7, "b");
					yield* bus.publishAdvance(advance(7, [], ["b"]));
					for (let version = 8; version <= 263; version++) {
						yield* fake.commit(version, row("a"));
						yield* bus.publishAdvance(advance(version, ["someone-else"]));
					}
					yield* Deferred.succeed(release, undefined);
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "snapshot",
						rows: [{ title: "a" }],
						sequence: 263,
					});
					expect(yield* Queue.take(queue)).toEqual({ _tag: "synchronized" });
					yield* fake.commit(264, row("after"));
					yield* bus.publishAdvance(advance(264, ["mine"]));
					expect(yield* Queue.take(queue)).toEqual({
						_tag: "upsert",
						item: { title: "after" },
						sequence: 264,
					});
				}),
			),
	);

	it.scoped("closing the enclosing scope terminates the stream", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<Row>();
				const scope = yield* Scope.make();

				const fiber = yield* Stream.runDrain(
					stream({ source: fake.source, bus }),
				).pipe(Effect.forkIn(scope));
				yield* Deferred.await(fake.readStarted);

				yield* Scope.close(scope, Exit.void);

				expect(Exit.isInterrupted(yield* Fiber.await(fiber))).toBe(true);
			}),
		),
	);

	it.scoped("passes rows, items and ids through untouched", () =>
		withBus(
			Effect.gen(function* () {
				const bus = yield* SessionEventBusTag;
				const fake = yield* makeFakeSource<{ payload: unknown }>();
				const item = { payload: { nested: ["x"] } };
				yield* fake.commit(1, {
					id: "p",
					row: { payload: { nested: [1, 2, 3] } },
				});

				const { queue } = yield* subscribe({ source: fake.source, bus });
				const snapshot = yield* Queue.take(queue);
				yield* Queue.take(queue);

				yield* fake.commit(2, { id: "q", row: item });
				yield* bus.publishAdvance(advance(2, ["s"], ["opaque-id-é"]));
				// Removals lead the group.
				const removed = yield* Queue.take(queue);
				const upsert = yield* Queue.take(queue);

				if (
					snapshot._tag !== "snapshot" ||
					upsert._tag !== "upsert" ||
					removed._tag !== "remove"
				) {
					throw new Error("unreachable: tags asserted by the envelopes above");
				}
				// Same reference — the module neither clones nor inspects payloads.
				expect(upsert.item).toBe(item);
				expect(snapshot.rows[0]).toEqual({ payload: { nested: [1, 2, 3] } });
				expect(removed.id).toBe("opaque-id-é");
			}),
		),
	);
});
