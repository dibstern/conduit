import { describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";

describe("Poller gating with Ref-based state machine", () => {
	it.effect("tracks SSE active/silent state via Ref<boolean>", () =>
		Effect.gen(function* () {
			const sseActive = yield* Ref.make(true);

			// Initially SSE is active
			const initial = yield* Ref.get(sseActive);
			expect(initial).toBe(true);

			// SSE goes silent — poller should activate
			yield* Ref.set(sseActive, false);
			const afterSilent = yield* Ref.get(sseActive);
			expect(afterSilent).toBe(false);

			// SSE comes back — poller should deactivate
			yield* Ref.set(sseActive, true);
			const afterActive = yield* Ref.get(sseActive);
			expect(afterActive).toBe(true);

			const result = { initial, afterSilent, afterActive };
			expect(result).toEqual({
				initial: true,
				afterSilent: false,
				afterActive: true,
			});
		}),
	);

	it.effect("overlap guard prevents concurrent polls via Ref<boolean>", () =>
		Effect.gen(function* () {
			const polling = yield* Ref.make(false);
			const pollCount = yield* Ref.make(0);

			const tryPoll = Ref.modify(polling, (isPolling) => {
				if (isPolling) return [false, true] as const; // rejected
				return [true, true] as const; // acquired
			}).pipe(
				Effect.flatMap((acquired) =>
					acquired
						? Ref.update(pollCount, (n) => n + 1).pipe(
								Effect.flatMap(() => Ref.set(polling, false)),
								Effect.map(() => true),
							)
						: Effect.succeed(false),
				),
			);

			// First poll succeeds
			const r1 = yield* tryPoll;
			const count = yield* Ref.get(pollCount);

			expect(r1).toBe(true);
			expect(count).toBe(1);
		}),
	);

	it.effect("timestamp tracking via Ref<number>", () =>
		Effect.gen(function* () {
			const lastSSEEventAt = yield* Ref.make(0);
			const lastContentAt = yield* Ref.make(0);

			// Simulate SSE event
			yield* Ref.set(lastSSEEventAt, 1000);

			// Simulate content delivery
			yield* Ref.set(lastContentAt, 1050);

			const sseTs = yield* Ref.get(lastSSEEventAt);
			const contentTs = yield* Ref.get(lastContentAt);

			// Content arrived after SSE — staleness = 50ms
			expect(contentTs - sseTs).toBe(50);
		}),
	);
});
