// ─── Retry Schedule Behavior Tests ───────────────────────────────────────────
// Verifies that Effect retry schedules with TestClock produce the expected
// number of attempts with correct exponential backoff timing.

import { describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Ref, Schedule, TestClock } from "effect";
import { expect } from "vitest";

describe("Retry Behavior with TestClock", () => {
	it.scoped("retries 3 times with exponential backoff", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);

			// Schedule: exponential(1s) intersected with recurs(3)
			// This means up to 3 retries with delays: 1s, 2s, 4s
			const schedule = Schedule.intersect(
				Schedule.exponential(Duration.seconds(1)),
				Schedule.recurs(3),
			);

			// An effect that always fails, counting each attempt
			const failing = Effect.gen(function* () {
				yield* Ref.update(attempts, (n) => n + 1);
				return yield* Effect.fail("always-fails");
			});

			// Fork the retrying effect so we can control time
			const fiber = yield* failing.pipe(
				Effect.retry(schedule),
				Effect.catchAll(() => Effect.void),
				Effect.fork,
			);

			// Initial attempt runs immediately
			yield* TestClock.adjust(Duration.millis(0));
			expect(yield* Ref.get(attempts)).toBe(1);

			// After 1s: first retry (delay = 1s)
			yield* TestClock.adjust(Duration.seconds(1));
			expect(yield* Ref.get(attempts)).toBe(2);

			// After 2s more: second retry (delay = 2s)
			yield* TestClock.adjust(Duration.seconds(2));
			expect(yield* Ref.get(attempts)).toBe(3);

			// After 4s more: third retry (delay = 4s)
			yield* TestClock.adjust(Duration.seconds(4));
			expect(yield* Ref.get(attempts)).toBe(4);

			// Wait for fiber to complete
			yield* Fiber.join(fiber);

			// Total: 1 initial + 3 retries = 4 attempts
			expect(yield* Ref.get(attempts)).toBe(4);
		}),
	);

	it.scoped("no retries when schedule has zero recurrences", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);

			const schedule = Schedule.recurs(0);

			const failing = Effect.gen(function* () {
				yield* Ref.update(attempts, (n) => n + 1);
				return yield* Effect.fail("fail");
			});

			yield* failing.pipe(
				Effect.retry(schedule),
				Effect.catchAll(() => Effect.void),
			);

			// Only the initial attempt
			expect(yield* Ref.get(attempts)).toBe(1);
		}),
	);

	it.scoped("succeeding on second attempt stops retrying", () =>
		Effect.gen(function* () {
			const attempts = yield* Ref.make(0);

			const schedule = Schedule.intersect(
				Schedule.exponential(Duration.seconds(1)),
				Schedule.recurs(5),
			);

			// Fails on first attempt, succeeds on second
			const sometimesFailing = Effect.gen(function* () {
				const n = yield* Ref.modify(attempts, (n) => [n + 1, n + 1]);
				if (n === 1) {
					return yield* Effect.fail("first-attempt-fails");
				}
				return "success";
			});

			const fiber = yield* sometimesFailing.pipe(
				Effect.retry(schedule),
				Effect.fork,
			);

			// Initial attempt fails
			yield* TestClock.adjust(Duration.millis(0));
			expect(yield* Ref.get(attempts)).toBe(1);

			// After 1s: retry succeeds
			yield* TestClock.adjust(Duration.seconds(1));
			expect(yield* Ref.get(attempts)).toBe(2);

			const result = yield* Fiber.join(fiber);
			expect(result).toBe("success");

			// No further retries occurred
			expect(yield* Ref.get(attempts)).toBe(2);
		}),
	);
});
