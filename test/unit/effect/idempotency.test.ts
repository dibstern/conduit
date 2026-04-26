// test/unit/effect/idempotency.test.ts

import { describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";

describe("Idempotency tracking with Ref<Set>", () => {
	it.effect("rejects duplicate command IDs", () =>
		Effect.gen(function* () {
			const processed = yield* Ref.make(new Set<string>());
			const maxSize = 5;

			const tryProcess = (id: string) =>
				Ref.modify(processed, (set) => {
					if (set.has(id)) return [false, set] as const;
					const next = new Set(set);
					next.add(id);
					if (next.size > maxSize) {
						const first = next.values().next().value;
						if (first) next.delete(first);
					}
					return [true, next] as const;
				});

			const r1 = yield* tryProcess("cmd-1");
			const r2 = yield* tryProcess("cmd-1"); // duplicate
			const r3 = yield* tryProcess("cmd-2");
			expect(r1).toBe(true);
			expect(r2).toBe(false);
			expect(r3).toBe(true);
		}),
	);

	it.effect("evicts oldest entries when exceeding max size (FIFO)", () =>
		Effect.gen(function* () {
			const processed = yield* Ref.make(new Set<string>());
			const maxSize = 3;

			const tryProcess = (id: string) =>
				Ref.modify(processed, (set) => {
					if (set.has(id)) return [false, set] as const;
					const next = new Set(set);
					next.add(id);
					if (next.size > maxSize) {
						const first = next.values().next().value;
						if (first) next.delete(first);
					}
					return [true, next] as const;
				});

			// Fill to capacity
			yield* tryProcess("a");
			yield* tryProcess("b");
			yield* tryProcess("c");

			// This should evict "a" (oldest) => set is now {b, c, d}
			yield* tryProcess("d");

			// "a" was evicted, so it should be accepted again
			const rA = yield* tryProcess("a");
			// "c" should still be tracked (b was evicted when a was re-added)
			const rC = yield* tryProcess("c");
			// "d" should still be tracked
			const rD = yield* tryProcess("d");

			// Snapshot to verify set contents
			const finalSet = yield* Ref.get(processed);
			expect(rA).toBe(true); // evicted, re-accepted
			expect(rC).toBe(false); // still tracked
			expect(rD).toBe(false); // still tracked
			expect(finalSet.size).toBe(3); // never exceeds maxSize
		}),
	);

	it.effect("accepts commands without IDs (no tracking)", () =>
		Effect.gen(function* () {
			const processed = yield* Ref.make(new Set<string>());

			const tryProcess = (id: string | undefined) => {
				if (!id) return Effect.succeed(true);
				return Ref.modify(processed, (set) => {
					if (set.has(id)) return [false, set] as const;
					const next = new Set(set);
					next.add(id);
					return [true, next] as const;
				});
			};

			const r1 = yield* tryProcess(undefined);
			const r2 = yield* tryProcess(undefined);
			expect(r1).toBe(true);
			expect(r2).toBe(true);
		}),
	);
});
