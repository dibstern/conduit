import { describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";

import {
	delayed,
	repeating,
	trackedFetch,
} from "../../../src/lib/domain/relay/Services/resource.js";

describe("Effect resource utilities", () => {
	it("trackedFetch aborts in-flight requests when its scope closes", async () => {
		const baseFetch = vi.spyOn(globalThis, "fetch");
		const started = new Promise<AbortSignal | undefined>((resolve) => {
			baseFetch.mockImplementation((_url, init) => {
				resolve(init?.signal ?? undefined);
				return new Promise<Response>(() => {});
			});
		});
		try {
			const signal = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Effect.forkScoped(trackedFetch("http://example.com"));
						const signal = yield* Effect.promise(() => started);
						expect(signal?.aborted).toBe(false);
						return signal;
					}),
				),
			);
			expect(signal?.aborted).toBe(true);
		} finally {
			baseFetch.mockRestore();
		}
	});

	it.effect("repeating clears interval on scope close", () =>
		Effect.gen(function* () {
			let count = 0;
			const result = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* repeating(
						() =>
							Effect.sync(() => {
								count++;
							}),
						10,
					);
					yield* TestClock.adjust(Duration.millis(55));
					return count;
				}),
			);
			expect(result).toBeGreaterThanOrEqual(3);

			// After scope closes, interval should be cleared
			const countAfter = count;
			yield* TestClock.adjust(Duration.millis(50));
			expect(count).toBe(countAfter); // No more increments
		}),
	);

	it.effect("delayed clears timeout on scope close", () =>
		Effect.gen(function* () {
			let fired = false;
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* delayed(
						() =>
							Effect.sync(() => {
								fired = true;
							}),
						1000,
					);
					// Don't wait for timeout — scope closes immediately
				}),
			);
			yield* TestClock.adjust(Duration.millis(50));
			expect(fired).toBe(false); // Timeout was cleared
		}),
	);
});
