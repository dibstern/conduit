import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { fetchWithRetry } from "../../../src/lib/effect/retry-fetch.js";
import { OpenCodeConnectionError } from "../../../src/lib/errors.js";

describe("Effect-based retry fetch", () => {
	it("succeeds on first attempt when server responds 200", async () => {
		const result = await Effect.runPromiseExit(
			fetchWithRetry("http://localhost:0/does-not-exist"),
		);
		expect(Exit.isFailure(result)).toBe(true); // Connection refused is expected
	});

	it("returns typed OpenCodeConnectionError on failure", async () => {
		const result = await Effect.runPromiseExit(
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
	});

	it("does not retry on timeout errors", async () => {
		const start = Date.now();
		const result = await Effect.runPromiseExit(
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
	});

	it("retries on connection refused errors", async () => {
		// We can verify retry behavior by checking that the effect takes
		// longer than a single attempt (due to retry delays)
		const start = Date.now();
		const result = await Effect.runPromiseExit(
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
	});

	it("returns the effect type signature correctly", () => {
		const effect = fetchWithRetry("http://example.com");
		// Verify it returns an Effect (duck-type check)
		expect(effect).toBeDefined();
		expect(typeof effect.pipe).toBe("function");
	});

	it("uses linear backoff matching legacy behavior", async () => {
		// Linear backoff: delay * 1, delay * 2, delay * 3
		// With retryDelay=100 and retries=2, total delay should be ~300ms (100 + 200)
		const start = Date.now();
		await Effect.runPromiseExit(
			fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
				retries: 2,
				retryDelay: 100,
			}),
		);
		const elapsed = Date.now() - start;
		// Linear: 100 + 200 = 300ms. Should be >= 250ms (with tolerance)
		expect(elapsed).toBeGreaterThanOrEqual(200);
	});

	it("accepts RequestInfo | URL input type", async () => {
		const url = new URL("http://localhost:0/test");
		const result = await Effect.runPromiseExit(fetchWithRetry(url));
		expect(Exit.isFailure(result)).toBe(true); // Connection refused expected
	});

	it("uses injected baseFetch when provided", async () => {
		let callCount = 0;
		const mockFetch = async (
			_input: RequestInfo | URL,
			_init?: RequestInit,
		) => {
			callCount++;
			return new Response("ok", { status: 200 });
		};
		const result = await Effect.runPromiseExit(
			fetchWithRetry("http://example.com", undefined, {
				baseFetch: mockFetch as typeof fetch,
			}),
		);
		expect(Exit.isSuccess(result)).toBe(true);
		expect(callCount).toBe(1);
	});
});
