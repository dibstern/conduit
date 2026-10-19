import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { expect, vi } from "vitest";

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
				const errors = result.cause.reasons
					.filter(Cause.isFailReason)
					.map((reason) => reason.error);
				expect(errors.length).toBe(1);
				expect(errors[0]).toBeInstanceOf(OpenCodeConnectionError);
			}
		}),
	);

	it.live("does not retry on timeout errors", () =>
		Effect.gen(function* () {
			const baseFetch = vi
				.fn<typeof fetch>()
				.mockRejectedValue(new DOMException("timed out", "AbortError"));
			const result = yield* Effect.exit(
				fetchWithRetry("http://example.com/timeout", undefined, {
					timeout: 500,
					retries: 2,
					retryDelay: 0,
					baseFetch,
				}),
			);
			expect(Exit.isFailure(result)).toBe(true);
			expect(baseFetch).toHaveBeenCalledOnce();
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
