// Failure modes: overlapping callers start duplicate probes; canceling a waiter
// cancels another caller's probe; completed or timed-out results become stale
// cache entries; startup hangs beyond five seconds; timed-out resources leak.
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, TestClock } from "effect";
import { expect } from "vitest";
import { makeQuotaCheck } from "../../../../src/lib/domain/daemon/Services/quota-check.js";
import type { QuotaCheckResult } from "../../../../src/lib/provider/claude/claude-usage-schema.js";

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
