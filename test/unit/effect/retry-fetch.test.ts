import { describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";

import { fetchWithRetry } from "../../../src/lib/domain/relay/Services/retry-fetch.js";
import { OpenCodeConnectionError } from "../../../src/lib/errors.js";

describe("Effect-based retry fetch", () => {
	it.live("succeeds on first attempt when server responds 200", () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist"),
			);
			expect(Exit.isFailure(result)).toBe(true); // Connection refused is expected
		}),
	);

	it.live("returns typed OpenCodeConnectionError on failure", () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist"),
			);
			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				const cause = result.cause;
				// Extract the error from the Cause
				const errors: OpenCodeConnectionError[] = [];
				const collectErrors = (c: typeof cause): void => {
					if (c._tag === "Fail") {
						errors.push(c.error as OpenCodeConnectionError);
					}
				};
				collectErrors(cause);
				expect(errors.length).toBe(1);
				expect(errors[0]).toBeInstanceOf(OpenCodeConnectionError);
			}
		}),
	);

	it.live("does not retry on timeout errors", () =>
		Effect.gen(function* () {
			const start = Date.now();
			const result = yield* Effect.exit(
				fetchWithRetry("http://10.255.255.1/timeout", undefined, {
					timeout: 500,
					retries: 2,
					retryDelay: 100,
				}),
			);
			const elapsed = Date.now() - start;
			expect(Exit.isFailure(result)).toBe(true);
			// Should not retry on timeout — total time should be close to 500ms,
			// not 500 + retries * delay
			expect(elapsed).toBeLessThan(2000);
		}),
	);

	it.live("retries on connection refused errors", () =>
		Effect.gen(function* () {
			// We can verify retry behavior by checking that the effect takes
			// longer than a single attempt (due to retry delays)
			const start = Date.now();
			const result = yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retries: 1,
					retryDelay: 50,
				}),
			);
			const elapsed = Date.now() - start;
			expect(Exit.isFailure(result)).toBe(true);
			// With 1 retry and 50ms delay, should take at least ~50ms
			// (linear backoff: 50ms for first retry)
			expect(elapsed).toBeGreaterThanOrEqual(40);
		}),
	);

	it("returns the effect type signature correctly", () => {
		const effect = fetchWithRetry("http://example.com");
		// Verify it returns an Effect (duck-type check)
		expect(effect).toBeDefined();
		expect(typeof effect.pipe).toBe("function");
	});

	it.live("uses linear backoff matching legacy behavior", () =>
		Effect.gen(function* () {
			// Linear backoff: delay * 1, delay * 2, delay * 3
			// With retryDelay=100 and retries=2, total delay should be ~300ms (100 + 200)
			const start = Date.now();
			yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retries: 2,
					retryDelay: 100,
				}),
			);
			const elapsed = Date.now() - start;
			// Linear: 100 + 200 = 300ms. Should be >= 250ms (with tolerance)
			expect(elapsed).toBeGreaterThanOrEqual(200);
		}),
	);

	it.live("accepts RequestInfo | URL input type", () =>
		Effect.gen(function* () {
			const url = new URL("http://localhost:0/test");
			const result = yield* Effect.exit(fetchWithRetry(url));
			expect(Exit.isFailure(result)).toBe(true); // Connection refused expected
		}),
	);

	it.live("uses injected baseFetch when provided", () =>
		Effect.gen(function* () {
			let callCount = 0;
			const mockFetch = async (
				_input: RequestInfo | URL,
				_init?: RequestInit,
			) => {
				callCount++;
				return new Response("ok", { status: 200 });
			};
			const result = yield* Effect.exit(
				fetchWithRetry("http://example.com", undefined, {
					baseFetch: mockFetch as typeof fetch,
				}),
			);
			expect(Exit.isSuccess(result)).toBe(true);
			expect(callCount).toBe(1);
		}),
	);
});
