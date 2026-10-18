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
// History/forecast failures: too little data produces a forecast; epoch-sized
// timestamps distort the regression; the projection uses the wrong anchor;
// resets mix windows; accounts or window kinds share points; failed reads add
// samples; transport loses endpoints or exceeds 48 points; storage exceeds 2016
// points; restarts lose history; overlapping saves overwrite newer snapshots;
// missing/corrupt files or failed saves break reads.
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
	Chunk,
	Clock,
	Deferred,
	Effect,
	Option as Effect4PollOption,
	Fiber,
	Layer,
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
import type {
	UsageRead,
	UsageReader,
} from "../../../../src/lib/provider/usage-reader.js";
import { makeMockAccountDirectory } from "../../../helpers/mock-factories.js";

it.effect("does not sample with no subscribers", () =>
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

it.effect("emits the current snapshot before refreshing a subscription", () =>
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
		expect([...snapshots]).toEqual([
			previous,
			[
				{
					...previous[0],
					windows: [
						{
							kind: "five_hour",
							utilization: 20,
							history: [
								{ at: 0, utilization: 10 },
								{ at: 0, utilization: 20 },
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
				claude: {
					read: (account) =>
						Effect.sync(() => {
							calls.push(account.id);
							return { status: "available", windows: [] };
						}),
				},
			},
		});
		const first = yield* Effect.forkChild(Stream.runDrain(service.readings));
		yield* TestClock.adjust("0 millis");
		expect(calls).toEqual(["account-1", "account-2"]);
		const second = yield* Effect.forkChild(Stream.runDrain(service.readings));
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

it.effect("debounces turn ends per account only while watched", () =>
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
		yield* Effect.forkChild(Stream.runDrain(service.readings));
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

it.effect("decides on unknown when a refresh times out after a limit", () =>
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
			readers: { claude: reader },
		});
		const [previous] = yield* service.refresh();
		timedOut = true;
		const pending = yield* Effect.forkChild(service.refresh());
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(pending)).toMatchObject([{ status: "unknown" }]);
		expect(
			yield* service.readings.pipe(Stream.take(1), Stream.runCollect),
		).toEqual(Chunk.of([{ ...previous, stale: true }]));
		const failover = yield* Effect.forkChild(service.pickFailover("other"));
		yield* TestClock.adjust("5 seconds");
		expect(yield* Fiber.join(failover)).toBe("account-1");
	}),
);

it.effect("treats a harness without a reader as unavailable", () =>
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

it.effect(
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

it.effect(
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
			const first = yield* Effect.forkChild(service.refresh(["account-1"]));
			yield* Deferred.await(started);
			const second = yield* Effect.forkChild(service.refresh(["account-1"]));
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
			expect(yield* service.refresh(["account-1"])).toEqual([
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
				readers: { claude: reader },
			});
			const first = yield* Effect.forkChild(service.refresh(["account-1"]));
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
			const retry = yield* Effect.forkChild(service.refresh(["account-1"]));
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
			expect((yield* service.refresh())[0]?.windows[0]).not.toHaveProperty(
				"forecast",
			);
			yield* TestClock.adjust("5 minutes");
			expect((yield* service.refresh())[0]?.windows[0]).not.toHaveProperty(
				"forecast",
			);
			yield* TestClock.adjust("599999 millis");
			const beforeSpan = (yield* service.refresh())[0]?.windows[0];
			expect(beforeSpan).toHaveProperty("history", [
				{ at: 0, utilization: 10 },
				{ at: 300_000, utilization: 10 },
				{ at: 899_999, utilization: 10 },
			]);
			expect(beforeSpan).not.toHaveProperty("forecast");
			yield* TestClock.adjust("1 millis");
			expect((yield* service.refresh())[0]?.windows[0]).toHaveProperty(
				"forecast",
				{ kind: "under", atReset: 10 },
			);
		}),
);

it.effect("forecasts a steady low burn separately for each window", () =>
	Effect.gen(function* () {
		const service = yield* makeUsage({
			accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
			readers: {
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
		yield* service.refresh();
		yield* TestClock.adjust("20 minutes");
		expect((yield* service.refresh())[0]?.windows[0]).not.toHaveProperty(
			"forecast",
		);
		yield* TestClock.adjust("10 minutes");
		const [reading] = yield* service.refresh();
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
		yield* service.refresh();
		yield* TestClock.adjust("10 minutes");
		yield* service.refresh();
		yield* TestClock.adjust("10 minutes");
		expect((yield* service.refresh())[0]?.windows[0]).toHaveProperty(
			"forecast",
			{ kind: "runs_out", at: 2_700_000 },
		);
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
				yield* first.refresh();
				yield* TestClock.adjust("10 minutes");
				yield* first.refresh();
				yield* TestClock.adjust("10 minutes");
				yield* first.refresh();
			}),
		);
		const second = yield* makeUsage(options);
		yield* TestClock.adjust("10 minutes");
		const window = (yield* second.refresh())[0]?.windows[0];
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

for (const reset of ["later reset time", "utilization drop"] as const) {
	it.effect(`starts fresh history on a ${reset}`, () =>
		Effect.gen(function* () {
			let utilization = 10;
			let resetsAt = new Date(3_600_000).toISOString();
			const service = yield* makeUsage({
				accounts: Effect.succeed([{ id: "account-1", harness: "claude" }]),
				readers: {
					claude: {
						read: () =>
							Effect.sync(() => ({
								status: "available",
								windows: [{ kind: "five_hour", utilization, resetsAt }],
							})),
					},
				},
			});
			yield* service.refresh();
			yield* TestClock.adjust("10 minutes");
			utilization = 20;
			yield* service.refresh();
			yield* TestClock.adjust("10 minutes");
			utilization = 30;
			expect((yield* service.refresh())[0]?.windows[0]).toHaveProperty(
				"forecast",
			);
			yield* TestClock.adjust("1 minute");
			if (reset === "later reset time")
				resetsAt = new Date(7_200_000).toISOString();
			else utilization = 5;
			const window = (yield* service.refresh())[0]?.windows[0];
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
			const first = yield* service.refresh();
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
				yield* service.refresh();
			}
			expect(saves).toBe(1);
			status = "limited";
			yield* service.refresh(["account-1"]);
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
			const window = (yield* service.refresh())[0]?.windows[0];
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
		const first = yield* Effect.forkChild(service.refresh(["account-1"]));
		yield* Deferred.await(started);
		const second = yield* Effect.forkChild(service.refresh(["account-2"]));
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
			expect(yield* service.refresh()).toMatchObject([{ status: "available" }]);
			expect(yield* Ref.get(stored)).toEqual({});
			failed = false;
			status = "unknown";
			yield* service.refresh();
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
					Layer.merge(
						makeDaemonStateLive({ configDir }),
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
				yield* service.refresh();
				yield* TestClock.adjust("10 minutes");
				yield* service.refresh();
				yield* TestClock.adjust("10 minutes");
				yield* service.refresh();
			}).pipe(Effect.provide(layer));
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
				return yield* service.refresh();
			}).pipe(Effect.provide(layer));
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
					return yield* service.refresh();
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
								Layer.merge(
									makeDaemonStateLive({ configDir }),
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
