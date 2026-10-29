// Failure modes: overlapping refreshes start duplicate reads; canceling a waiter
// cancels another caller's read; cache ages cross accounts or ignore failed attempts;
// startup hangs beyond five seconds; timed-out resources leak; failures escape.
// Failover failures: saved order is ignored or stale; excluded/removed accounts
// are read; duplicate order entries repeat reads; limited/unavailable wins;
// unknown/stale readings win or configured accounts missing from the order are lost.
// Sampling failures: idle services read; subscribing loses the current snapshot;
// subscribers each start a sampler; one unsubscribe stops other subscribers;
// turn-end bursts duplicate reads or leave full accounts unread without viewers;
// early-free logs omit a window or repeat without a full-to-free transition;
// failures erase the last
// shown reading or lose its stale marker.
// History/forecast failures: too little data produces a forecast; epoch-sized
// timestamps distort the regression; the projection uses the wrong anchor;
// resets mix windows; accounts or window kinds share points; failed reads add
// samples; transport loses endpoints or exceeds 48 points; storage exceeds 2016
// points; restarts lose history; overlapping saves overwrite newer snapshots;
// missing/corrupt files or failed saves break reads.
// Restart failures: a restart shows no reading until the first read lands; a
// restored reading looks fresh (not stale, or read at boot) so failover trusts
// it; a failed read is persisted and shown after the next restart; a removed
// account comes back; a restored reading stops the first refresh from reading;
// a live update is lost on restart; the stored reading does not survive JSON.
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
	Clock,
	Deferred,
	Effect,
	Option as Effect4PollOption,
	Fiber,
	Layer,
	Logger,
	Ref,
	Schema,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/account.js";
import {
	UsageReadingSchema,
	UsageWindowSchema,
} from "../../../../src/lib/contracts/limit-recovery.js";
import { UsageLive } from "../../../../src/lib/domain/daemon/Layers/usage-layer.js";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { makeDaemonStateLive } from "../../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	forecastUsage,
	makeUsage,
	Usage,
	type UsageHistorySnapshot,
	UsageHistorySnapshotSchema,
} from "../../../../src/lib/domain/daemon/Services/usage.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { CodexAccountResources } from "../../../../src/lib/provider/codex/codex-account-resources.js";
import type {
	UsageRead,
	UsageReader,
} from "../../../../src/lib/provider/usage-reader.js";
import { makeMockAccountDirectory } from "../../../helpers/mock-factories.js";

const unavailableReader: UsageReader = {
	read: () =>
		Effect.succeed({
			status: "unavailable",
			windows: [],
			reason: "Usage reader is not available for this harness",
		}),
};

it.effect("returns each account's cache until its maximum age is reached", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: (account) =>
						Effect.sync(() => {
							calls.push(account.id);
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		const [first] = yield* service.refresh({
			accountIds: ["account-1"],
			maxAge: "30 seconds",
		});
		yield* TestClock.adjust("15 seconds");
		yield* service.refresh({ accountIds: ["account-2"], maxAge: "30 seconds" });
		yield* TestClock.adjust("14999 millis");
		expect(
			yield* service.refresh({
				accountIds: ["account-1"],
				maxAge: "30 seconds",
			}),
		).toEqual([first]);
		expect(calls).toEqual(["account-1", "account-2"]);
		yield* TestClock.adjust("1 millis");
		yield* service.refresh({ maxAge: "30 seconds" });
		expect(calls).toEqual(["account-1", "account-2", "account-1"]);
	}),
);

it.effect(
	"does not retry a failed attempt within maxAge and retains stale values",
	() =>
		Effect.gen(function* () {
			let calls = 0;
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.suspend(() => {
								calls++;
								return calls === 1
									? Effect.succeed<UsageRead>({
											status: "available",
											windows: [{ kind: "five_hour", utilization: 41 }],
										})
									: Effect.fail(new Error("Reader failed"));
							}),
					},
				},
			});
			const [previous] = yield* service.refresh({ maxAge: "30 seconds" });
			yield* TestClock.adjust("30 seconds");
			yield* service.refresh({ maxAge: "30 seconds" });
			yield* TestClock.adjust("29999 millis");
			expect(yield* service.refresh({ maxAge: "30 seconds" })).toEqual([
				{ ...previous, stale: true },
			]);
			expect(calls).toBe(2);
			yield* TestClock.adjust("1 millis");
			yield* service.refresh({ maxAge: "30 seconds" });
			expect(calls).toBe(3);
		}),
);

it.effect("turn end re-reads a full account without subscribers", () =>
	Effect.gen(function* () {
		let calls = 0;
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: () =>
						Effect.sync(() => ({
							status: ++calls === 1 ? "limited" : "available",
							windows: [
								{ kind: "seven_day", utilization: calls === 1 ? 100 : 20 },
							],
						})),
				},
			},
		});
		yield* service.refresh({ maxAge: "5 minutes" });
		yield* service.turnEnded("account-1");
		yield* service.turnEnded("account-1");
		yield* TestClock.adjust("10 seconds");
		expect(calls).toBe(2);
		expect(yield* service.latest("account-1")).toMatchObject({
			status: "available",
			windows: [{ utilization: 20 }],
		});
		yield* service.turnEnded("account-1");
		yield* TestClock.adjust("10 seconds");
		expect(calls).toBe(2);
	}),
);

it.effect(
	"logs each window becoming free before its previous reset only once",
	() => {
		const messages: unknown[] = [];
		return Effect.gen(function* () {
			let calls = 0;
			const resetsAt = new Date(60_000).toISOString();
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.sync(() => ({
								status: ++calls === 1 ? "limited" : "available",
								windows: [
									{
										kind: "five_hour",
										utilization: calls === 1 ? 100 : 20,
										resetsAt,
									},
									{
										kind: "seven_day",
										utilization: calls === 1 ? 100 : 30,
										resetsAt,
									},
									{ kind: "month", utilization: 100, resetsAt },
								],
							})),
					},
				},
			});
			yield* service.refresh({ maxAge: 0 });
			yield* TestClock.adjust("1 second");
			yield* service.refresh({ maxAge: 0 });
			yield* service.refresh({ maxAge: 0 });
			expect(messages).toEqual([
				[
					"Usage window free before reset",
					{ accountId: "account-1", window: "five_hour", resetsAt },
				],
				[
					"Usage window free before reset",
					{ accountId: "account-1", window: "seven_day", resetsAt },
				],
			]);
		}).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make(({ message }) => {
						messages.push(message);
					}),
				]),
			),
		);
	},
);

it.effect("does not sample with no subscribers", () =>
	Effect.gen(function* () {
		let calls = 0;
		yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
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

it.effect(
	"emits the cached snapshot without re-reading on a fresh subscription",
	() =>
		Effect.gen(function* () {
			let calls = 0;
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.sync(() => ({
								status: "available",
								windows: [{ kind: "five_hour", utilization: ++calls * 10 }],
							})),
					},
				},
			});
			const previous = yield* service.refresh({ maxAge: 0 });
			const snapshots = yield* Stream.runCollect(
				Stream.take(service.readings, 2),
			);
			expect([...snapshots]).toEqual([previous, previous]);
			expect(calls).toBe(1);
		}),
);

it.effect(
	"emits the current snapshot before refreshing an expired subscription",
	() =>
		Effect.gen(function* () {
			let calls = 0;
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.sync(() => ({
								status: "available",
								windows: [{ kind: "five_hour", utilization: ++calls * 10 }],
							})),
					},
				},
			});
			const previous = yield* service.refresh({ maxAge: 0 });
			yield* TestClock.adjust("5 minutes");
			const snapshots = yield* Stream.runCollect(
				Stream.take(service.readings, 2),
			);
			expect([...snapshots]).toEqual([
				previous,
				[
					{
						...previous[0],
						readAt: 300_000,
						windows: [
							{
								kind: "five_hour",
								utilization: 20,
								history: [
									{ at: 0, utilization: 10 },
									{ at: 300_000, utilization: 20 },
								],
							},
						],
					},
				],
			]);
			expect(calls).toBe(2);
		}),
);

it.effect("shares a five-minute sampler until the last subscriber leaves", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: (account) =>
						Effect.sync(() => {
							calls.push(account.id);
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		const first = yield* Effect.forkChild(Stream.runDrain(service.readings), {
			startImmediately: true,
		});
		yield* TestClock.adjust("0 millis");
		expect(calls).toEqual(["account-1", "account-2"]);
		const second = yield* Effect.forkChild(Stream.runDrain(service.readings), {
			startImmediately: true,
		});
		yield* TestClock.adjust("0 millis");
		expect(calls).toHaveLength(2);
		yield* TestClock.adjust("299999 millis");
		expect(calls).toHaveLength(2);
		yield* TestClock.adjust("1 millis");
		expect(calls).toHaveLength(4);
		yield* Fiber.interrupt(first);
		yield* TestClock.adjust("5 minutes");
		expect(calls).toHaveLength(6);
		yield* Fiber.interrupt(second);
		yield* TestClock.adjust("10 minutes");
		expect(calls).toHaveLength(6);
	}),
);

it.effect("debounces watched turn ends per account", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
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
		yield* Effect.forkChild(Stream.runDrain(service.readings), {
			startImmediately: true,
		});
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

it.effect("keeps five-minute sample times independent of read duration", () =>
	Effect.gen(function* () {
		const startedAt: number[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
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
		const subscriber = yield* Effect.forkChild(
			Stream.runDrain(service.readings),
			{ startImmediately: true },
		);
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

it.effect(
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
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			const [previous] = yield* service.refresh({ maxAge: 0 });
			failed = true;
			yield* TestClock.adjust("1 minute");
			expect(yield* service.refresh({ maxAge: 0 })).toMatchObject([
				{ status: "unknown" },
			]);
			expect(
				yield* service.readings.pipe(Stream.take(1), Stream.runCollect),
			).toEqual([[{ ...previous, stale: true }]]);
			failed = false;
			expect(yield* service.refresh({ maxAge: 0 })).toMatchObject([
				{ stale: false, readAt: yield* Clock.currentTimeMillis },
			]);
		}),
);

it.effect("retains a cached limit for failover after a read times out", () =>
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
			accountHarness: () => Effect.succeed("claude"),
			readers: {
				claude: reader,
				codex: unavailableReader,
				cursor: unavailableReader,
			},
		});
		const [previous] = yield* service.refresh({ maxAge: 0 });
		timedOut = true;
		const pending = yield* Effect.forkChild(service.refresh({ maxAge: 0 }));
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(pending)).toMatchObject([{ status: "unknown" }]);
		expect(
			yield* service.readings.pipe(Stream.take(1), Stream.runCollect),
		).toEqual([[{ ...previous, stale: true }]]);
		const failover = yield* Effect.forkChild(service.pickFailover("other"));
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(failover)).toBeUndefined();
	}),
);

it.effect("treats a harness without a reader as unavailable", () =>
	Effect.gen(function* () {
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "codex-1", harness: "codex" },
				{ id: "cursor-1", harness: "cursor" },
			]),
			readers: {
				claude: unavailableReader,
				codex: unavailableReader,
				cursor: unavailableReader,
			},
		});
		expect(yield* service.refresh({ maxAge: 0 })).toMatchObject([
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

it.effect(
	"picks proven-free accounts in the live saved order and skips unknown",
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
					{ id: "account-5", harness: "claude" },
				]),
				order: Ref.get(order),
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			expect(yield* service.pickFailover("account-1")).toBe("account-5");
			expect(read).toEqual([
				"account-4",
				"account-3",
				"account-2",
				"account-5",
			]);
			read.length = 0;
			yield* Ref.set(order, ["account-1", "account-2"]);
			expect(yield* service.pickFailover("account-3")).toBe("account-1");
			expect(read).toEqual(["account-1"]);
			read.length = 0;
			yield* Ref.set(order, ["account-3", "account-3"]);
			expect(yield* service.pickFailover("account-1")).toBe("account-5");
			expect(read).toEqual([]);
			yield* TestClock.adjust("30 seconds");
			expect(yield* service.pickFailover("account-1")).toBe("account-5");
			expect(read).toEqual([
				"account-3",
				"account-2",
				"account-4",
				"account-5",
			]);
		}),
);

it.effect("never picks unknown or stale accounts for failover", () =>
	Effect.gen(function* () {
		let failed = false;
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "current", harness: "claude" },
				{ id: "unknown", harness: "claude" },
				{ id: "stale", harness: "claude" },
				{ id: "ready", harness: "claude" },
			]),
			order: Effect.succeed(["unknown", "stale", "ready"]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: (account) =>
						Effect.suspend(() =>
							account.id === "unknown"
								? Effect.succeed<UsageRead>({ status: "unknown", windows: [] })
								: failed && account.id === "stale"
									? Effect.fail(new Error("Usage read failed"))
									: Effect.succeed<UsageRead>({
											status: "available",
											windows: [{ kind: "five_hour", utilization: 20 }],
										}),
						),
				},
			},
		});
		yield* service.refresh({ maxAge: 0 });
		failed = true;
		yield* service.refresh({ accountIds: ["stale"], maxAge: 0 });
		expect(yield* service.latest("stale")).toMatchObject({
			status: "available",
			stale: true,
		});
		expect(yield* service.pickFailover("current")).toBe("ready");
		expect(yield* service.pickFailover("ready")).toBe("current");
	}),
);

it.effect(
	"shares concurrent zero-age reads and survives waiter cancellation",
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
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			const first = yield* Effect.forkChild(
				service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
			);
			yield* Deferred.await(started);
			const second = yield* Effect.forkChild(
				service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
			);
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(first);
			expect(calls).toBe(1);
			yield* Deferred.succeed(release, undefined);
			const expected = [
				{
					accountId: "account-1",
					harness: "claude",
					status: "available",
					planLabel: "Max",
					windows: [
						{
							kind: "five_hour",
							utilization: 37,
							history: [
								{ at: yield* Clock.currentTimeMillis, utilization: 37 },
							],
						},
					],
					readAt: yield* Clock.currentTimeMillis,
					stale: false,
				},
			];
			expect(yield* Fiber.join(second)).toEqual(expected);
			expect(
				yield* service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
			).toEqual([
				{
					...expected[0],
					windows: [
						{
							kind: "five_hour",
							utilization: 37,
							history: [
								{ at: yield* Clock.currentTimeMillis, utilization: 37 },
								{ at: yield* Clock.currentTimeMillis, utilization: 37 },
							],
						},
					],
				},
			]);
			expect(calls).toBe(2);
		}),
);

it.effect(
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
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			const first = yield* Effect.forkChild(
				service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
			);
			yield* Deferred.await(started);
			yield* TestClock.adjust("4999 millis");
			expect(
				(yield* Effect.sync(() =>
					Effect4PollOption.fromUndefinedOr(first.pollUnsafe()),
				))._tag,
			).toBe("None");
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
			const retry = yield* Effect.forkChild(
				service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
			);
			yield* TestClock.adjust("5 seconds");
			expect(yield* Fiber.join(retry)).toMatchObject([
				{ status: "unknown", windows: [] },
			]);
			expect(calls).toBe(2);
			expect(released).toBe(2);
		}),
);

it.effect(
	"turns a failed read into unknown and refreshes all known accounts",
	() =>
		Effect.gen(function* () {
			const reader: UsageReader = {
				read: () => Effect.fail(new Error("Reader failed")),
			};
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			expect(yield* service.refresh({ maxAge: 0 })).toEqual([
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

it.effect(
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
				readers: {
					claude: reader,
					codex: unavailableReader,
					cursor: unavailableReader,
				},
			});
			expect(
				yield* service.refresh({
					accountIds: ["removed", "account-1", "account-1"],
					maxAge: 0,
				}),
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

it.effect(
	"keeps old usage payloads and scopes optional fields to plan windows",
	() =>
		Effect.sync(() => {
			const old = {
				accountId: "account-1",
				harness: "claude",
				status: "available",
				windows: [{ kind: "five_hour", utilization: 20 }],
				readAt: 0,
				stale: false,
			};
			expect(Schema.decodeUnknownSync(UsageReadingSchema)(old)).toEqual(old);
			for (const kind of ["five_hour", "seven_day", "month"]) {
				for (const forecast of [
					{ kind: "under", atReset: 40 },
					{ kind: "runs_out", at: 3_600_000 },
				]) {
					const window = {
						kind,
						utilization: 20,
						history: [{ at: 0, utilization: 10 }],
						forecast,
					};
					expect(Schema.decodeUnknownSync(UsageWindowSchema)(window)).toEqual(
						window,
					);
				}
			}
			expect(
				Schema.decodeUnknownSync(UsageWindowSchema)({
					kind: "seven_day_model",
					utilization: 20,
					history: [{ at: 0, utilization: 10 }],
					forecast: { kind: "under", atReset: 40 },
				}),
			).toEqual({ kind: "seven_day_model", utilization: 20 });
		}),
);

it.effect(
	"forecasts with a centered regression and the latest reading as its anchor",
	() =>
		Effect.sync(() => {
			const epoch = 1_800_000_000_000;
			const points = [
				{ at: epoch, utilization: 10 },
				{ at: epoch + 600_000, utilization: 30 },
				{ at: epoch + 1_200_000, utilization: 30 },
			];
			expect(
				forecastUsage(points, 30, epoch + 3_600_000, epoch + 1_200_000),
			).toEqual({
				kind: "under",
				atReset: 70,
			});
			expect(
				forecastUsage(points, 30, undefined, epoch + 1_200_000),
			).toBeUndefined();
			expect(
				forecastUsage(points, 100, epoch + 3_600_000, epoch + 1_200_000),
			).toBeUndefined();
			const flat = points.map((point) => ({ ...point, utilization: 30 }));
			expect(
				forecastUsage(flat, 30, epoch + 3_600_000, epoch + 1_200_000),
			).toEqual({
				kind: "under",
				atReset: 30,
			});
			expect(
				forecastUsage(
					[...points]
						.reverse()
						.map((point, i) => ({ ...point, at: epoch + i * 600_000 })),
					10,
					epoch + 3_600_000,
					epoch + 1_200_000,
				),
			).toEqual({ kind: "under", atReset: 10 });
		}),
);

it.effect(
	"omits forecasts until three readings span at least fifteen minutes",
	() =>
		Effect.gen(function* () {
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.succeed({
								status: "available",
								windows: [
									{
										kind: "five_hour",
										utilization: 10,
										resetsAt: new Date(3_600_000).toISOString(),
									},
								],
							}),
					},
				},
			});
			expect(
				(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
			).not.toHaveProperty("forecast");
			yield* TestClock.adjust("5 minutes");
			expect(
				(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
			).not.toHaveProperty("forecast");
			yield* TestClock.adjust("599999 millis");
			const beforeSpan = (yield* service.refresh({ maxAge: 0 }))[0]?.windows[0];
			expect(beforeSpan).toHaveProperty("history", [
				{ at: 0, utilization: 10 },
				{ at: 300_000, utilization: 10 },
				{ at: 899_999, utilization: 10 },
			]);
			expect(beforeSpan).not.toHaveProperty("forecast");
			yield* TestClock.adjust("1 millis");
			expect(
				(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
			).toHaveProperty("forecast", { kind: "under", atReset: 10 });
		}),
);

it.effect("forecasts a steady low burn separately for each window", () =>
	Effect.gen(function* () {
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: () =>
						Effect.gen(function* () {
							const minutes = (yield* Clock.currentTimeMillis) / 60_000;
							return {
								status: "available",
								windows: [
									{
										kind: "five_hour",
										utilization: 10 + minutes,
										resetsAt: new Date(3_600_000).toISOString(),
									},
									{
										kind: "seven_day",
										utilization: 20 + minutes / 2,
										resetsAt: new Date(7_200_000).toISOString(),
									},
								],
							};
						}),
				},
			},
		});
		yield* service.refresh({ maxAge: 0 });
		yield* TestClock.adjust("20 minutes");
		expect(
			(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
		).not.toHaveProperty("forecast");
		yield* TestClock.adjust("10 minutes");
		const [reading] = yield* service.refresh({ maxAge: 0 });
		expect(reading?.windows[0]).toHaveProperty("forecast", {
			kind: "under",
			atReset: 70,
		});
		expect(reading?.windows[1]).toHaveProperty("forecast", {
			kind: "under",
			atReset: 80,
		});
		expect(reading?.windows[0]).toHaveProperty("history", [
			{ at: 0, utilization: 10 },
			{ at: 1_200_000, utilization: 30 },
			{ at: 1_800_000, utilization: 40 },
		]);
	}),
);

it.effect("forecasts a fast burn reaching the limit before reset", () =>
	Effect.gen(function* () {
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: () =>
						Clock.currentTimeMillis.pipe(
							Effect.map((at) => ({
								status: "available",
								windows: [
									{
										kind: "five_hour",
										utilization: 10 + at / 30_000,
										resetsAt: new Date(3_600_000).toISOString(),
									},
								],
							})),
						),
				},
			},
		});
		yield* service.refresh({ maxAge: 0 });
		yield* TestClock.adjust("10 minutes");
		yield* service.refresh({ maxAge: 0 });
		yield* TestClock.adjust("10 minutes");
		expect(
			(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
		).toHaveProperty("forecast", { kind: "runs_out", at: 2_700_000 });
	}),
);

it.effect("loads history once and forecasts immediately after a restart", () =>
	Effect.gen(function* () {
		const stored = yield* Ref.make<UsageHistorySnapshot>({});
		let loads = 0;
		const options = {
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" as const },
			]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: () =>
						Clock.currentTimeMillis.pipe(
							Effect.map(
								(at): UsageRead => ({
									status: "available",
									windows: [
										{
											kind: "five_hour",
											utilization: 10 + at / 60_000,
											resetsAt: new Date(3_600_000).toISOString(),
										},
									],
								}),
							),
						),
				},
			},
			history: {
				load: Ref.get(stored).pipe(
					Effect.tap(() => Effect.sync(() => loads++)),
				),
				save: (snapshot: UsageHistorySnapshot) => Ref.set(stored, snapshot),
			},
		};
		yield* Effect.scoped(
			Effect.gen(function* () {
				const first = yield* makeUsage(options);
				yield* first.refresh({ maxAge: 0 });
				yield* TestClock.adjust("10 minutes");
				yield* first.refresh({ maxAge: 0 });
				yield* TestClock.adjust("10 minutes");
				yield* first.refresh({ maxAge: 0 });
			}),
		);
		const second = yield* makeUsage(options);
		yield* TestClock.adjust("10 minutes");
		const window = (yield* second.refresh({ maxAge: 0 }))[0]?.windows[0];
		expect(window).toHaveProperty("forecast", { kind: "under", atReset: 70 });
		expect(window).toHaveProperty("history", [
			{ at: 0, utilization: 10 },
			{ at: 600_000, utilization: 20 },
			{ at: 1_200_000, utilization: 30 },
			{ at: 1_800_000, utilization: 40 },
		]);
		expect(loads).toBe(2);
	}),
);

it.effect(
	"restores each account's last successful reading as stale after a restart",
	() =>
		Effect.gen(function* () {
			const file = yield* Ref.make("{}");
			const json = Schema.fromJsonString(UsageHistorySnapshotSchema);
			let cold = false;
			const options = (ids: readonly string[]) => ({
				accounts: Effect.succeed(
					ids.map((id) => ({ id, harness: "claude" as const })),
				),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: (account: { readonly id: string }) =>
							cold
								? Effect.never
								: account.id === "account-1"
									? Effect.succeed<UsageRead>({
											status: "available",
											planLabel: "Claude Max",
											windows: [{ kind: "five_hour", utilization: 41 }],
										})
									: Effect.fail(new Error("Reader failed")),
					},
				},
				history: {
					load: Ref.get(file).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(json)),
					),
					save: (snapshot: UsageHistorySnapshot) =>
						Schema.encodeEffect(json)(snapshot).pipe(
							Effect.flatMap((text) => Ref.set(file, text)),
						),
				},
			});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const first = yield* makeUsage(options(["account-1", "account-2"]));
					yield* first.refresh({ maxAge: 0 });
					yield* first.update("account-2", "claude", {
						status: "available",
						windows: [{ kind: "seven_day", utilization: 12 }],
					});
				}),
			);
			yield* TestClock.adjust("10 minutes");
			cold = true;
			const second = yield* makeUsage(options(["account-1", "account-2"]));
			const restored = {
				accountId: "account-1",
				harness: "claude",
				status: "available",
				planLabel: "Claude Max",
				readAt: 0,
				stale: true,
			};
			expect(yield* second.latest("account-1")).toMatchObject({
				...restored,
				windows: [{ kind: "five_hour", utilization: 41 }],
			});
			expect(yield* second.latest("account-2")).toMatchObject({
				status: "available",
				stale: true,
				windows: [{ kind: "seven_day", utilization: 12 }],
			});
			expect(
				yield* second.readings.pipe(Stream.take(1), Stream.runCollect),
			).toMatchObject([[restored, { accountId: "account-2", stale: true }]]);
			const pending = yield* Effect.forkChild(
				second.refresh({ accountIds: ["account-1"], maxAge: "5 minutes" }),
			);
			yield* TestClock.adjust("5 seconds");
			expect(yield* Fiber.join(pending)).toMatchObject([{ status: "unknown" }]);
			expect(yield* second.latest("account-1")).toMatchObject(restored);
			const removed = yield* makeUsage(options(["account-2"]));
			expect(yield* removed.latest("account-1")).toBeUndefined();
		}),
);

for (const reset of ["later reset time", "utilization drop"] as const) {
	it.effect(`starts fresh history on a ${reset}`, () =>
		Effect.gen(function* () {
			let utilization = 10;
			let resetsAt = new Date(3_600_000).toISOString();
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.sync(() => ({
								status: "available",
								windows: [{ kind: "five_hour", utilization, resetsAt }],
							})),
					},
				},
			});
			yield* service.refresh({ maxAge: 0 });
			yield* TestClock.adjust("10 minutes");
			utilization = 20;
			yield* service.refresh({ maxAge: 0 });
			yield* TestClock.adjust("10 minutes");
			utilization = 30;
			expect(
				(yield* service.refresh({ maxAge: 0 }))[0]?.windows[0],
			).toHaveProperty("forecast");
			yield* TestClock.adjust("1 minute");
			if (reset === "later reset time")
				resetsAt = new Date(7_200_000).toISOString();
			else utilization = 5;
			const window = (yield* service.refresh({ maxAge: 0 }))[0]?.windows[0];
			expect(window).toHaveProperty("history", [
				{ at: 1_260_000, utilization },
			]);
			expect(window).not.toHaveProperty("forecast");
		}),
	);
}

it.effect(
	"records only successful plan windows, independently per account",
	() =>
		Effect.gen(function* () {
			let status: UsageRead["status"] = "available";
			const stored = yield* Ref.make<UsageHistorySnapshot>({});
			let saves = 0;
			const service = yield* makeUsage({
				accounts: Effect.succeed([
					{ id: "account-1", harness: "claude" },
					{ id: "account-2", harness: "claude" },
				]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: (account) =>
							Effect.sync(() => ({
								status,
								windows: [
									{
										kind: "five_hour",
										utilization: account.id === "account-1" ? 10 : 90,
									},
									{ kind: "seven_day", utilization: 20 },
									{ kind: "month", utilization: 30 },
									{ kind: "seven_day_model", model: "Fable", utilization: 40 },
								],
							})),
					},
				},
				history: {
					load: Ref.get(stored),
					save: (snapshot) =>
						Ref.set(stored, snapshot).pipe(
							Effect.tap(() => Effect.sync(() => saves++)),
						),
				},
			});
			const first = yield* service.refresh({ maxAge: 0 });
			expect(first[0]?.windows[0]).toHaveProperty("history", [
				{ at: 0, utilization: 10 },
			]);
			expect(first[1]?.windows[0]).toHaveProperty("history", [
				{ at: 0, utilization: 90 },
			]);
			expect(first[0]?.windows[2]).not.toHaveProperty("history");
			expect(first[0]?.windows[3]).not.toHaveProperty("history");
			expect(saves).toBe(1);
			for (const failure of ["unknown", "unavailable"] as const) {
				status = failure;
				yield* TestClock.adjust("1 minute");
				yield* service.refresh({ maxAge: 0 });
			}
			expect(saves).toBe(1);
			status = "limited";
			yield* service.refresh({ accountIds: ["account-1"], maxAge: 0 });
			const snapshot = yield* Ref.get(stored);
			expect(snapshot["account-1"]?.five_hour?.points).toEqual([
				{ at: 0, utilization: 10 },
				{ at: 120_000, utilization: 10 },
			]);
			expect(snapshot["account-1"]?.seven_day?.points).toEqual([
				{ at: 0, utilization: 20 },
				{ at: 120_000, utilization: 20 },
			]);
			expect(snapshot["account-2"]?.five_hour?.points).toHaveLength(1);
			expect(saves).toBe(2);
		}),
);

it.effect(
	"caps stored history and thins transport while keeping both endpoints",
	() =>
		Effect.gen(function* () {
			const points = Array.from({ length: 2016 }, (_, i) => ({
				at: i * 60_000,
				utilization: 10,
			}));
			const stored = yield* Ref.make<UsageHistorySnapshot>({
				"account-1": { five_hour: { points } },
			});
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.succeed({
								status: "available",
								windows: [{ kind: "five_hour", utilization: 10 }],
							}),
					},
				},
				history: {
					load: Ref.get(stored),
					save: (snapshot) => Ref.set(stored, snapshot),
				},
			});
			yield* TestClock.setTime(2016 * 60_000);
			const window = (yield* service.refresh({ maxAge: 0 }))[0]?.windows[0];
			if (!window || window.kind === "seven_day_model")
				throw new Error("Missing plan window");
			expect(window.history).toHaveLength(48);
			expect(window.history?.[0]).toEqual(points[1]);
			expect(window.history?.at(-1)).toEqual({
				at: 2016 * 60_000,
				utilization: 10,
			});
			expect(
				window.history?.every(
					(point, i, history) =>
						i === 0 || point.at > (history[i - 1]?.at ?? -1),
				),
			).toBe(true);
			expect(
				(yield* Ref.get(stored))["account-1"]?.five_hour?.points,
			).toHaveLength(2016);
		}),
);

it.effect("serializes saves without losing concurrent account history", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const stored = yield* Ref.make<UsageHistorySnapshot>({});
		const snapshots: UsageHistorySnapshot[] = [];
		const service = yield* makeUsage({
			accounts: Effect.succeed([
				{ id: "account-1", harness: "claude" },
				{ id: "account-2", harness: "claude" },
			]),
			readers: {
				codex: unavailableReader,
				cursor: unavailableReader,
				claude: {
					read: () =>
						Effect.succeed({
							status: "available",
							windows: [{ kind: "five_hour", utilization: 10 }],
						}),
				},
			},
			history: {
				load: Ref.get(stored),
				save: (snapshot) =>
					Effect.gen(function* () {
						snapshots.push(snapshot);
						if (snapshots.length === 1) {
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(release);
						}
						yield* Ref.set(stored, snapshot);
					}),
			},
		});
		const first = yield* Effect.forkChild(
			service.refresh({ accountIds: ["account-1"], maxAge: 0 }),
		);
		yield* Deferred.await(started);
		const second = yield* Effect.forkChild(
			service.refresh({ accountIds: ["account-2"], maxAge: 0 }),
		);
		yield* Effect.yieldNow;
		yield* Deferred.succeed(release, undefined);
		yield* Fiber.join(first);
		yield* Fiber.join(second);
		expect(snapshots).toHaveLength(2);
		expect(Object.keys(snapshots[0] ?? {})).toEqual(["account-1"]);
		expect(Object.keys(yield* Ref.get(stored))).toEqual([
			"account-1",
			"account-2",
		]);
	}),
);

it.effect(
	"swallows save failures and retries the history on a later refresh",
	() =>
		Effect.gen(function* () {
			let failed = true;
			let status: UsageRead["status"] = "available";
			const stored = yield* Ref.make<UsageHistorySnapshot>({});
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					codex: unavailableReader,
					cursor: unavailableReader,
					claude: {
						read: () =>
							Effect.sync(() => ({
								status,
								windows: [{ kind: "five_hour", utilization: 10 }],
							})),
					},
				},
				history: {
					load: Ref.get(stored),
					save: (snapshot) =>
						failed
							? Effect.fail(new Error("Disk full"))
							: Ref.set(stored, snapshot),
				},
			});
			expect(yield* service.refresh({ maxAge: 0 })).toMatchObject([
				{ status: "available" },
			]);
			expect(yield* Ref.get(stored)).toEqual({});
			failed = false;
			status = "unknown";
			yield* service.refresh({ maxAge: 0 });
			expect((yield* Ref.get(stored))["account-1"]?.five_hour?.points).toEqual([
				{ at: 0, utilization: 10 },
			]);
		}),
);

it.effect(
	"persists daemon-wide history atomically and reloads it through UsageLive",
	() =>
		Effect.gen(function* () {
			const configDir = yield* Effect.acquireRelease(
				Effect.tryPromise(() =>
					mkdtemp(join(tmpdir(), "conduit-usage-history-")),
				),
				(dir) =>
					Effect.promise(() => rm(dir, { recursive: true, force: true })),
			);
			const layer = UsageLive({
				prepareQuery: async () => {},
				queryFactory: () => ({
					initializationResult: async () => ({
						account: { tokenSource: "oauth" },
					}),
					usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
						async () => ({
							rate_limits_available: true,
							rate_limits: {
								five_hour: {
									utilization: 10,
									resets_at: new Date(3_600_000).toISOString(),
								},
							},
						}),
					close: () => {},
				}),
			}).pipe(
				Layer.provide(
					Layer.mergeAll(
						makeDaemonStateLive({ configDir }),
						Layer.succeed(CodexAccountResources)({
							use: () => Effect.die("Unexpected Codex account use"),
						}),
						Layer.succeed(AccountDirectory)(
							makeMockAccountDirectory([
								{
									id: AccountIdSchema.make("account-1"),
									name: "Personal",
									driver: "claude",
									folder: configuredClaudeConfigDir(join(configDir, "login")),
									usageEligible: true,
								},
							]),
						),
					),
				),
			);
			yield* Effect.gen(function* () {
				const service = yield* Usage;
				yield* service.refresh({ maxAge: 0 });
				yield* TestClock.adjust("10 minutes");
				yield* service.refresh({ maxAge: 0 });
				yield* TestClock.adjust("10 minutes");
				yield* service.refresh({ maxAge: 0 });
			}).pipe(Effect.provide(layer, { local: true }));
			const file = join(configDir, "usage-history.json");
			const snapshot = yield* Effect.tryPromise(() =>
				readFile(file, "utf8"),
			).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(
						Schema.fromJsonString(UsageHistorySnapshotSchema),
					),
				),
			);
			expect(snapshot["account-1"]?.five_hour?.points).toHaveLength(3);
			expect((yield* Effect.tryPromise(() => stat(file))).mode & 0o777).toBe(
				0o600,
			);
			expect(yield* Effect.tryPromise(() => readdir(configDir))).toEqual([
				"usage-history.json",
			]);
			const readings = yield* Effect.gen(function* () {
				const service = yield* Usage;
				return yield* service.refresh({ maxAge: 0 });
			}).pipe(Effect.provide(layer, { local: true }));
			expect(readings[0]?.windows[0]).toHaveProperty("forecast", {
				kind: "under",
				atReset: 10,
			});
			expect(readings[0]?.windows[0]).toHaveProperty("history", [
				{ at: 0, utilization: 10 },
				{ at: 600_000, utilization: 10 },
				{ at: 1_200_000, utilization: 10 },
				{ at: 1_200_000, utilization: 10 },
			]);
		}),
);

it.effect(
	"treats missing, corrupt JSON, and invalid history files as empty",
	() =>
		Effect.gen(function* () {
			const configDir = yield* Effect.acquireRelease(
				Effect.tryPromise(() =>
					mkdtemp(join(tmpdir(), "conduit-usage-history-")),
				),
				(dir) =>
					Effect.promise(() => rm(dir, { recursive: true, force: true })),
			);
			for (const contents of [
				undefined,
				"{broken",
				'{"account-1":{"five_hour":{"points":[{"at":0,"utilization":101}]}}}',
			]) {
				if (contents !== undefined)
					yield* Effect.tryPromise(() =>
						writeFile(join(configDir, "usage-history.json"), contents),
					);
				const readings = yield* Effect.gen(function* () {
					const service = yield* Usage;
					return yield* service.refresh({ maxAge: 0 });
				}).pipe(
					Effect.provide(
						UsageLive({
							prepareQuery: async () => {},
							queryFactory: () => ({
								initializationResult: async () => ({
									account: { tokenSource: "oauth" },
								}),
								usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
									async () => ({
										rate_limits_available: true,
										rate_limits: { five_hour: { utilization: 10 } },
									}),
								close: () => {},
							}),
						}).pipe(
							Layer.provide(
								Layer.mergeAll(
									makeDaemonStateLive({ configDir }),
									Layer.succeed(CodexAccountResources)({
										use: () => Effect.die("Unexpected Codex account use"),
									}),
									Layer.succeed(AccountDirectory)(
										makeMockAccountDirectory([
											{
												id: AccountIdSchema.make("account-1"),
												name: "Personal",
												driver: "claude",
												folder: configuredClaudeConfigDir(
													join(configDir, "login"),
												),
												usageEligible: true,
											},
										]),
									),
								),
							),
						),
					),
				);
				expect(readings[0]?.windows[0]).toHaveProperty("history", [
					{ at: 0, utilization: 10 },
				]);
				expect(readings[0]?.windows[0]).not.toHaveProperty("forecast");
			}
		}),
);
