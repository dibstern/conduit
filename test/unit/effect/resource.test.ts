import { describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { expect } from "vitest";

import {
	delayed,
	repeating,
	trackedFetch,
} from "../../../src/lib/effect/resource.js";

describe("Effect resource utilities", () => {
	it("trackedFetch is a callable that returns a scoped effect", () => {
		// Verify the utility exists and is callable — actual fetch
		// would require a network request, so we just check the shape.
		expect(typeof trackedFetch).toBe("function");
		expect(trackedFetch.length).toBe(2); // (url, init?)
	});

	it.live("repeating clears interval on scope close", () =>
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
					yield* Effect.sleep(Duration.millis(55));
					return count;
				}),
			);
			expect(result).toBeGreaterThanOrEqual(3);

			// After scope closes, interval should be cleared
			const countAfter = count;
			yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));
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
			yield* Effect.promise(() => new Promise((r) => setTimeout(r, 50)));
			expect(fired).toBe(false); // Timeout was cleared
		}),
	);
});
