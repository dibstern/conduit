// test/unit/effect/idempotency.test.ts
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";

describe("Idempotency tracking with Ref<Set>", () => {
	it("rejects duplicate command IDs", async () => {
		const program = Effect.gen(function* () {
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
			return { r1, r2, r3 };
		});

		const result = await Effect.runPromise(program);
		expect(result.r1).toBe(true);
		expect(result.r2).toBe(false);
		expect(result.r3).toBe(true);
	});

	it("evicts oldest entries when exceeding max size (FIFO)", async () => {
		const program = Effect.gen(function* () {
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
			return { rA, rC, rD, finalSet };
		});

		const result = await Effect.runPromise(program);
		expect(result.rA).toBe(true); // evicted, re-accepted
		expect(result.rC).toBe(false); // still tracked
		expect(result.rD).toBe(false); // still tracked
		expect(result.finalSet.size).toBe(3); // never exceeds maxSize
	});

	it("accepts commands without IDs (no tracking)", async () => {
		const program = Effect.gen(function* () {
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
			return { r1, r2 };
		});

		const result = await Effect.runPromise(program);
		expect(result.r1).toBe(true);
		expect(result.r2).toBe(true);
	});
});
