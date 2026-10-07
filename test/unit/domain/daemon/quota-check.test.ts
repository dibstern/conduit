// Failure modes: overlapping callers start duplicate probes; canceling a waiter
// cancels another caller's probe; completed or timed-out results become stale
// cache entries; startup hangs beyond five seconds; timed-out resources leak.
// Failover failures: saved order is ignored or stale; excluded/removed accounts
// are probed; duplicate order entries repeat probes; Limited/Unavailable wins;
// Unknown is skipped or configured accounts missing from the order are lost.
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, TestClock } from "effect";
import { expect } from "vitest";
import { makeQuotaCheck } from "../../../../src/lib/domain/daemon/Services/quota-check.js";
import type { QuotaCheckResult } from "../../../../src/lib/provider/claude/claude-usage-schema.js";

it.scoped(
	"picks fresh accounts in the live saved order and allows Unknown",
	() =>
		Effect.gen(function* () {
			const order = yield* Ref.make([
				"removed",
				"account-4",
				"account-3",
				"account-2",
				"account-3",
			]);
			const probed: string[] = [];
			const service = yield* makeQuotaCheck({
				instances: Effect.succeed([
					{ id: "account-1" },
					{ id: "account-2" },
					{ id: "account-3" },
					{ id: "account-4" },
				]),
				order: Ref.get(order),
				probe: {
					probe: (account) =>
						Effect.sync(() => {
							probed.push(account.id);
							return account.id === "account-3"
								? ({
										_tag: "Limited",
										rateLimitType: "seven_day",
									} satisfies QuotaCheckResult)
								: account.id === "account-4"
									? ({
											_tag: "Unavailable",
											reason: "Not logged in",
										} satisfies QuotaCheckResult)
									: account.id === "account-2"
										? ({ _tag: "Unknown" } satisfies QuotaCheckResult)
										: ({ _tag: "Available" } satisfies QuotaCheckResult);
						}),
				},
			});
			expect(yield* service.pickFailover("account-1")).toBe("account-2");
			expect(probed).toEqual(["account-4", "account-3", "account-2"]);
			probed.length = 0;
			yield* Ref.set(order, ["account-1", "account-2"]);
			expect(yield* service.pickFailover("account-3")).toBe("account-1");
			expect(probed).toEqual(["account-1"]);
			probed.length = 0;
			yield* Ref.set(order, ["account-3", "account-3"]);
			expect(yield* service.pickFailover("account-1")).toBe("account-2");
			expect(probed).toEqual(["account-3", "account-2"]);
		}),
);

it.scoped(
	"shares only in-flight probes and keeps them alive when one waiter cancels",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			let calls = 0;
			const service = yield* makeQuotaCheck({
				instances: Effect.succeed([
					{ id: "account-1", configDir: "/account-1" },
				]),
				probe: {
					probe: () =>
						Effect.gen(function* () {
							calls++;
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(release);
							return { _tag: "Available" } satisfies QuotaCheckResult;
						}),
				},
			});
			const first = yield* Effect.fork(service.check("account-1"));
			yield* Deferred.await(started);
			const second = yield* Effect.fork(service.check("account-1"));
			yield* Effect.yieldNow();
			yield* Fiber.interrupt(first);
			expect(calls).toBe(1);
			yield* Deferred.succeed(release, undefined);
			expect(yield* Fiber.join(second)).toEqual({ _tag: "Available" });
			expect(yield* service.check("account-1")).toEqual({ _tag: "Available" });
			expect(calls).toBe(2);
		}),
);

it.scoped(
	"bounds the entire probe at five seconds, releases it, and retries fresh",
	() =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			let calls = 0;
			let released = 0;
			const service = yield* makeQuotaCheck({
				instances: Effect.succeed([{ id: "account-1" }]),
				probe: {
					probe: () =>
						Effect.gen(function* () {
							calls++;
							yield* Deferred.succeed(started, undefined);
							return yield* Effect.never;
						}).pipe(Effect.ensuring(Effect.sync(() => released++))),
				},
			});
			const first = yield* Effect.fork(service.check("account-1"));
			yield* Deferred.await(started);
			yield* TestClock.adjust("4999 millis");
			expect((yield* Fiber.poll(first))._tag).toBe("None");
			yield* TestClock.adjust("1 millis");
			expect(yield* Fiber.join(first)).toEqual({ _tag: "Unknown" });
			expect(released).toBe(1);
			const retry = yield* Effect.fork(service.check("account-1"));
			yield* TestClock.adjust("5 seconds");
			expect(yield* Fiber.join(retry)).toEqual({ _tag: "Unknown" });
			expect(calls).toBe(2);
			expect(released).toBe(2);
		}),
);
