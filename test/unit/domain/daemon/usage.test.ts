// Failure modes: overlapping refreshes start duplicate reads; canceling a waiter
// cancels another caller's read; completed results are reused instead of refreshed;
// startup hangs beyond five seconds; timed-out resources leak; failures escape.
// Failover failures: saved order is ignored or stale; excluded/removed accounts
// are read; duplicate order entries repeat reads; limited/unavailable wins;
// unknown is skipped or configured accounts missing from the order are lost.
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Ref, TestClock } from "effect";
import { expect } from "vitest";
import { makeUsage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import type { UsageReader } from "../../../../src/lib/provider/usage-reader.js";

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
