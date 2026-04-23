import { Duration, Effect } from "effect";
import { describe, expect, it } from "vitest";

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

	it("repeating clears interval on scope close", async () => {
		let count = 0;
		const program = Effect.scoped(
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
		const result = await Effect.runPromise(program);
		expect(result).toBeGreaterThanOrEqual(3);

		// After scope closes, interval should be cleared
		const countAfter = count;
		await new Promise((r) => setTimeout(r, 50));
		expect(count).toBe(countAfter); // No more increments
	});

	it("delayed clears timeout on scope close", async () => {
		let fired = false;
		const program = Effect.scoped(
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
		await Effect.runPromise(program);
		await new Promise((r) => setTimeout(r, 50));
		expect(fired).toBe(false); // Timeout was cleared
	});
});
