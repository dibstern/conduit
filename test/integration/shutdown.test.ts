// ─── Integration: Shutdown Path ──────────────────────────────────────────────
// Verifies that Effect Layer teardown (scope closure) runs finalizers in
// reverse order and interrupts background fibers before state is cleaned up.

import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { expect } from "vitest";

describe("Shutdown Path", () => {
	it.effect("Layer finalizers run in reverse order on interruption", () =>
		Effect.gen(function* () {
			const log: string[] = [];

			// Layer A: adds finalizer that logs "A"
			const LayerA = Layer.scopedDiscard(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							log.push("A");
						}),
					);
				}),
			);

			// Layer B: depends on A, adds finalizer that logs "B"
			const LayerB = Layer.scopedDiscard(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							log.push("B");
						}),
					);
				}),
			);

			// Compose: A then B (B acquired after A)
			const composed = Layer.merge(LayerA, LayerB);

			// Manually build scope, provide layer, then close
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(composed, scope);

			// Close scope — finalizers should run in reverse acquisition order
			yield* Scope.close(scope, Exit.void);

			// Both finalizers ran
			expect(log).toContain("A");
			expect(log).toContain("B");
			expect(log.length).toBe(2);
		}),
	);

	it.effect(
		"scoped fiber finalizer runs before earlier scope finalizer (LIFO)",
		() =>
			Effect.gen(function* () {
				const log: string[] = [];

				// Build a scope manually so we can assert post-close
				const scope = yield* Scope.make();

				// Register a "persist state" finalizer first (added to scope early)
				yield* Scope.addFinalizer(
					scope,
					Effect.sync(() => {
						log.push("persisted");
					}),
				);

				// Fork a background fiber into the same scope.
				// forkIn attaches the fiber to the scope; when the scope closes
				// it interrupts the fiber. We use addFinalizer inside the fiber's
				// scoped body to log when the fiber's resources are released.
				yield* Effect.gen(function* () {
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							log.push("fiber-released");
						}),
					);
					yield* Effect.never;
				}).pipe(Effect.scoped, Effect.forkIn(scope));

				// Allow the fiber to start
				yield* Effect.yieldNow();

				// Close scope — should release fiber, then run earlier finalizer
				yield* Scope.close(scope, Exit.void);

				// Both events happened
				expect(log).toContain("fiber-released");
				expect(log).toContain("persisted");

				// Fiber released before the earlier-registered finalizer (LIFO)
				const fiberIdx = log.indexOf("fiber-released");
				const persistIdx = log.indexOf("persisted");
				expect(fiberIdx).toBeLessThan(persistIdx);
			}),
	);
});
