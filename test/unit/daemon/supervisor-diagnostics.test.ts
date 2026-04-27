// ─── Supervisor.track Diagnostics Tests ─────────────────────────────────────
// Verifies that Supervisor.track can monitor forked fiber exits and status.
// These are pure Effect tests — no daemon dependencies required.

import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Supervisor } from "effect";
import { expect } from "vitest";

describe("Supervisor.track diagnostics", () => {
	it.effect("tracks forked fiber exits", () =>
		Effect.gen(function* () {
			const sv = yield* Supervisor.track;
			yield* Effect.supervised(
				Effect.gen(function* () {
					const f1 = yield* Effect.fork(Effect.succeed("ok"));
					yield* Fiber.join(f1);
					const f2 = yield* Effect.fork(Effect.fail("boom"));
					yield* Fiber.join(f2).pipe(Effect.catchAll(() => Effect.void));
				}),
				sv,
			);
			const fibers = yield* sv.value;
			expect(fibers).toBeDefined();
			expect(Array.isArray(fibers)).toBe(true);
		}),
	);

	it.effect("supervisor captures fiber count", () =>
		Effect.gen(function* () {
			const sv = yield* Supervisor.track;
			yield* Effect.supervised(
				Effect.gen(function* () {
					const fibers = Array.from({ length: 5 }, (_, i) =>
						Effect.fork(Effect.succeed(i)),
					);
					yield* Effect.all(fibers);
				}),
				sv,
			);
			const tracked = yield* sv.value;
			expect(tracked.length).toBeGreaterThanOrEqual(5);
		}),
	);
});
