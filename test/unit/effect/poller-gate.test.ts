import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";

describe("Poller gating with Ref-based state machine", () => {
	it("tracks SSE active/silent state via Ref<boolean>", async () => {
		const program = Effect.gen(function* () {
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

			return { initial, afterSilent, afterActive };
		});

		const result = await Effect.runPromise(program);
		expect(result).toEqual({
			initial: true,
			afterSilent: false,
			afterActive: true,
		});
	});

	it("overlap guard prevents concurrent polls via Ref<boolean>", async () => {
		const program = Effect.gen(function* () {
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

			return { acquired: r1, count };
		});

		const result = await Effect.runPromise(program);
		expect(result.acquired).toBe(true);
		expect(result.count).toBe(1);
	});

	it("timestamp tracking via Ref<number>", async () => {
		const program = Effect.gen(function* () {
			const lastSSEEventAt = yield* Ref.make(0);
			const lastContentAt = yield* Ref.make(0);

			// Simulate SSE event
			yield* Ref.set(lastSSEEventAt, 1000);

			// Simulate content delivery
			yield* Ref.set(lastContentAt, 1050);

			const sseTs = yield* Ref.get(lastSSEEventAt);
			const contentTs = yield* Ref.get(lastContentAt);

			// Content arrived after SSE — staleness = 50ms
			return { staleness: contentTs - sseTs };
		});

		const result = await Effect.runPromise(program);
		expect(result.staleness).toBe(50);
	});
});
