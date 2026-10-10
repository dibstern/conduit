// Failure modes: overlapping refreshes start duplicate reads; canceling a waiter
// cancels another caller's read; completed results are reused instead of refreshed;
// startup hangs beyond five seconds; timed-out resources leak; failures escape.
// Failover failures: saved order is ignored or stale; excluded/removed accounts
// are read; duplicate order entries repeat reads; limited/unavailable wins;
// unknown is skipped or configured accounts missing from the order are lost.
// Sampling failures: idle services read; subscribing loses the current snapshot;
// subscribers each start a sampler; one unsubscribe stops other subscribers;
// turn-end bursts duplicate reads or read unwatched; failures erase the last
// shown reading or leak it into decisions.
import { it } from "@effect/vitest";
import {
	Chunk,
	Clock,
	Deferred,
	Effect,
	Fiber,
	Ref,
	Stream,
	TestClock,
} from "effect";
import { expect } from "vitest";
import { makeUsage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import type { UsageReader } from "../../../../src/lib/provider/usage-reader.js";

it.scoped("does not sample with no subscribers", () =>
	Effect.gen(function* () {
		let calls = 0;
		yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				claude: {
					read: () =>
						Effect.sync(() => {
							calls++;
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		yield* TestClock.adjust("15 minutes");
		expect(calls).toBe(0);
	}),
);

it.scoped("emits the current snapshot before refreshing a subscription", () =>
	Effect.gen(function* () {
		let calls = 0;
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				claude: {
					read: () =>
						Effect.sync(() => ({
							status: "available",
							windows: [{ kind: "five_hour", utilization: ++calls * 10 }],
						})),
				},
			},
		});
		const previous = yield* service.refresh();
		const snapshots = yield* Stream.runCollect(
			Stream.take(service.readings, 2),
		);
		expect(Chunk.toArray(snapshots)).toEqual([
			previous,
			[{ ...previous[0], windows: [{ kind: "five_hour", utilization: 20 }] }],
		]);
		expect(calls).toBe(2);
	}),
);

it.scoped("shares a five-minute sampler until the last subscriber leaves", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				claude: {
					read: (account) =>
						Effect.sync(() => {
							calls.push(account.id);
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		const first = yield* Effect.fork(Stream.runDrain(service.readings));
		yield* TestClock.adjust("0 millis");
		expect(calls).toEqual(["account-1", "account-2"]);
		const second = yield* Effect.fork(Stream.runDrain(service.readings));
		yield* TestClock.adjust("0 millis");
		expect(calls).toHaveLength(4);
		yield* TestClock.adjust("299999 millis");
		expect(calls).toHaveLength(4);
		yield* TestClock.adjust("1 millis");
		expect(calls).toHaveLength(6);
		yield* Fiber.interrupt(first);
		yield* TestClock.adjust("5 minutes");
		expect(calls).toHaveLength(8);
		yield* Fiber.interrupt(second);
		yield* TestClock.adjust("10 minutes");
		expect(calls).toHaveLength(8);
	}),
);

it.scoped("debounces turn ends per account only while watched", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				claude: {
					read: (account) =>
						Effect.sync(() => {
							calls.push(account.id);
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		yield* service.turnEnded("account-1");
		yield* TestClock.adjust("10 seconds");
		expect(calls).toEqual([]);
		yield* Effect.fork(Stream.runDrain(service.readings));
		yield* TestClock.adjust("1 millis");
		calls.length = 0;
		yield* service.turnEnded("account-1");
		yield* TestClock.adjust("5 seconds");
		yield* service.turnEnded("account-1");
		yield* service.turnEnded("account-1");
		yield* TestClock.adjust("9999 millis");
		expect(calls).toEqual([]);
		yield* TestClock.adjust("1 millis");
		expect(calls).toEqual(["account-1"]);
		yield* service.turnEnded("account-1");
		yield* service.turnEnded("account-2");
		yield* TestClock.adjust("10 seconds");
		expect(calls.filter((id) => id === "account-1")).toHaveLength(2);
		expect(calls.filter((id) => id === "account-2")).toHaveLength(1);
	}),
);

it.scoped("keeps five-minute sample times independent of read duration", () =>
	Effect.gen(function* () {
		const startedAt: number[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				claude: {
					read: () =>
						Effect.gen(function* () {
							startedAt.push(yield* Clock.currentTimeMillis);
							yield* Effect.sleep("4 seconds");
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		const subscriber = yield* Effect.fork(Stream.runDrain(service.readings));
		yield* TestClock.adjust("4 seconds");
		expect(startedAt).toEqual([0]);
		yield* TestClock.adjust("296 seconds");
		expect(startedAt).toEqual([0, 300000]);
		yield* TestClock.adjust("4 seconds");
		yield* TestClock.adjust("296 seconds");
		expect(startedAt).toEqual([0, 300000, 600000]);
		yield* Fiber.interrupt(subscriber);
	}),
);

it.scoped(
	"retains the last successful reading and readAt when a read fails",
	() =>
		Effect.gen(function* () {
			let failed = false;
			const reader: UsageReader = {
				read: () =>
					failed
						? Effect.fail(new Error("Reader failed"))
						: Effect.succeed({
								status: "available",
								planLabel: "Max",
								windows: [{ kind: "five_hour", utilization: 41 }],
							}),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: { claude: reader },
			});
			const [previous] = yield* service.refresh();
			failed = true;
			yield* TestClock.adjust("1 minute");
			expect(yield* service.refresh()).toMatchObject([{ status: "unknown" }]);
			expect(
				yield* service.readings.pipe(Stream.take(1), Stream.runCollect),
			).toEqual(Chunk.of([{ ...previous, stale: true }]));
			failed = false;
			expect(yield* service.refresh()).toMatchObject([
				{ stale: false, readAt: yield* Clock.currentTimeMillis },
			]);
		}),
);

it.scoped("decides on unknown when a refresh times out after a limit", () =>
	Effect.gen(function* () {
		let timedOut = false;
		const reader: UsageReader = {
			read: () =>
				timedOut
					? Effect.never
					: Effect.succeed({
							status: "limited",
							windows: [{ kind: "seven_day", utilization: 100 }],
						}),
		};
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: { claude: reader },
		});
		const [previous] = yield* service.refresh();
		timedOut = true;
		const pending = yield* Effect.fork(service.refresh());
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(pending)).toMatchObject([{ status: "unknown" }]);
		expect(
			yield* service.readings.pipe(Stream.take(1), Stream.runCollect),
		).toEqual(Chunk.of([{ ...previous, stale: true }]));
		const failover = yield* Effect.fork(service.pickFailover("other"));
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(failover)).toBe("account-1");
	}),
);

it.scoped("treats a harness without a reader as unavailable", () =>
	Effect.gen(function* () {
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "codex-1", harness: "codex" },
				{ id: "cursor-1", harness: "cursor" },
			]),
			readers: {},
		});
		expect(yield* service.refresh()).toMatchObject([
			{
				accountId: "codex-1",
				harness: "codex",
				status: "unavailable",
				windows: [],
			},
			{
				accountId: "cursor-1",
				harness: "cursor",
				status: "unavailable",
				windows: [],
			},
		]);
	}),
);

it.scoped(
	"picks fresh accounts in the live saved order and allows unknown",
	() =>
		Effect.gen(function* () {
			const order = yield* Ref.make([
				"removed",
				"account-4",
				"account-3",
				"account-2",
				"account-3",
			]);
			const read: string[] = [];
			const reader: UsageReader = {
				read: (account) =>
					Effect.sync(() => {
						read.push(account.id);
						return account.id === "account-3"
							? {
									status: "limited",
									windows: [{ kind: "seven_day", utilization: 100 }],
								}
							: account.id === "account-4"
								? {
										status: "unavailable",
										windows: [],
										reason: "Not logged in",
									}
								: account.id === "account-2"
									? { status: "unknown", windows: [] }
									: { status: "available", windows: [] };
					}),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([
					{ id: "account-1", harness: "claude" },
					{ id: "account-2", harness: "claude" },
					{ id: "account-3", harness: "claude" },
					{ id: "account-4", harness: "claude" },
				]),
				order: Ref.get(order),
				readers: { claude: reader },
			});
			expect(yield* service.pickFailover("account-1")).toBe("account-2");
			expect(read).toEqual(["account-4", "account-3", "account-2"]);
			read.length = 0;
			yield* Ref.set(order, ["account-1", "account-2"]);
			expect(yield* service.pickFailover("account-3")).toBe("account-1");
			expect(read).toEqual(["account-1"]);
			read.length = 0;
			yield* Ref.set(order, ["account-3", "account-3"]);
			expect(yield* service.pickFailover("account-1")).toBe("account-2");
			expect(read).toEqual(["account-3", "account-2"]);
		}),
);

it.scoped(
	"shares only in-flight reads and keeps them alive when one waiter cancels",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let calls = 0;
			const reader: UsageReader = {
				read: () =>
					Effect.gen(function* () {
						calls++;
						yield* Deferred.succeed(started, undefined);
						yield* Deferred.await(release);
						return {
							status: "available",
							planLabel: "Max",
							windows: [{ kind: "five_hour", utilization: 37 }],
						};
					}),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([
					{ id: "account-1", harness: "claude", configDir: "/account-1" },
				]),
				readers: { claude: reader },
			});
			const first = yield* Effect.fork(service.refresh(["account-1"]));
			yield* Deferred.await(started);
			const second = yield* Effect.fork(service.refresh(["account-1"]));
			yield* Effect.yieldNow();
			yield* Fiber.interrupt(first);
			expect(calls).toBe(1);
			yield* Deferred.succeed(release, undefined);
			const expected = [
				{
					accountId: "account-1",
					harness: "claude",
					status: "available",
					planLabel: "Max",
					windows: [{ kind: "five_hour", utilization: 37 }],
					readAt: yield* Clock.currentTimeMillis,
					stale: false,
				},
			];
			expect(yield* Fiber.join(second)).toEqual(expected);
			expect(yield* service.refresh(["account-1"])).toEqual(expected);
			expect(calls).toBe(2);
		}),
);

it.scoped(
	"bounds the entire read at five seconds, releases it, and retries fresh",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			let calls = 0;
			let released = 0;
			const reader: UsageReader = {
				read: () =>
					Effect.gen(function* () {
						calls++;
						yield* Deferred.succeed(started, undefined);
						return yield* Effect.never;
					}).pipe(Effect.ensuring(Effect.sync(() => released++))),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: { claude: reader },
			});
			const first = yield* Effect.fork(service.refresh(["account-1"]));
			yield* Deferred.await(started);
			yield* TestClock.adjust("4999 millis");
			expect((yield* Fiber.poll(first))._tag).toBe("None");
			yield* TestClock.adjust("1 millis");
			expect(yield* Fiber.join(first)).toEqual([
				{
					accountId: "account-1",
					harness: "claude",
					status: "unknown",
					windows: [],
					readAt: yield* Clock.currentTimeMillis,
					stale: false,
					reason: "Usage read timed out",
				},
			]);
			expect(released).toBe(1);
			const retry = yield* Effect.fork(service.refresh(["account-1"]));
			yield* TestClock.adjust("5 seconds");
			expect(yield* Fiber.join(retry)).toMatchObject([
				{ status: "unknown", windows: [] },
			]);
			expect(calls).toBe(2);
			expect(released).toBe(2);
		}),
);

it.scoped(
	"turns a failed read into unknown and refreshes all known accounts",
	() =>
		Effect.gen(function* () {
			const reader: UsageReader = {
				read: () => Effect.fail(new Error("Reader failed")),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: { claude: reader },
			});
			expect(yield* service.refresh()).toEqual([
				{
					accountId: "account-1",
					harness: "claude",
					status: "unknown",
					windows: [],
					readAt: yield* Clock.currentTimeMillis,
					stale: false,
					reason: "Usage read failed",
				},
			]);
		}),
);

it.scoped(
	"returns unavailable for removed accounts and de-duplicates requested IDs",
	() =>
		Effect.gen(function* () {
			const read: string[] = [];
			const reader: UsageReader = {
				read: (account) =>
					Effect.sync(() => {
						read.push(account.id);
						return { status: "available", windows: [] };
					}),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: { claude: reader },
			});
			expect(
				yield* service.refresh(["removed", "account-1", "account-1"]),
			).toMatchObject([
				{
					accountId: "removed",
					status: "unavailable",
					reason: "Claude account is not configured",
				},
				{ accountId: "account-1", status: "available" },
			]);
			expect(read).toEqual(["account-1"]);
		}),
);
