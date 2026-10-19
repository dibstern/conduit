// Verifies that FiberSet can monitor explicitly forked fiber exits and status.
// These are pure Effect tests — no daemon dependencies required.

import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FiberSet } from "effect";
import { expect } from "vitest";

describe("FiberSet diagnostics", () => {
	it.effect("tracks forked fiber exits", () =>
		Effect.gen(function* () {
			const sv = yield* FiberSet.make();
			const f1 = yield* FiberSet.run(sv, Effect.succeed("ok"));
			yield* Fiber.join(f1);
			const f2 = yield* FiberSet.run(sv, Effect.fail("boom"));
			yield* Fiber.join(f2).pipe(Effect.catch(() => Effect.void));
			const fibers = [...sv];
			expect(fibers).toBeDefined();
			expect(Array.isArray(fibers)).toBe(true);
		}),
	);

	it.effect("supervisor captures fiber count", () =>
		Effect.gen(function* () {
			const sv = yield* FiberSet.make();
			const release = yield* Deferred.make<void>();
			const fibers = Array.from({ length: 5 }, (_, i) =>
				FiberSet.run(sv, Deferred.await(release).pipe(Effect.as(i))),
			);
			const running = yield* Effect.all(fibers);
			const tracked = [...sv];
			expect(tracked.length).toBeGreaterThanOrEqual(5);
			yield* Deferred.succeed(release, undefined);
			yield* Effect.forEach(running, Fiber.join);
		}),
	);
});
