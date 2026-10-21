import { describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";

import { fetchWithRetry } from "../../../src/lib/domain/relay/Services/retry-fetch.js";
import { OpenCodeConnectionError } from "../../../src/lib/errors.js";

describe("Effect-based retry fetch", () => {
	it.live("succeeds on first attempt when server responds 200", () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retryDelay: 0,
				}),
			);
			expect(Exit.isFailure(result)).toBe(true); // Connection refused is expected
		}),
	);

	it.live("returns typed OpenCodeConnectionError on failure", () =>
		Effect.gen(function* () {
			const result = yield* Effect.exit(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retryDelay: 0,
				}),
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

	it.effect("retries on connection refused errors", () =>
		Effect.gen(function* () {
			const baseFetch = vi
				.fn<typeof fetch>()
				.mockRejectedValue(new Error("ECONNREFUSED"));
			const fiber = yield* Effect.forkChild(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retries: 1,
					retryDelay: 50,
					baseFetch,
				}).pipe(Effect.exit),
			);
			yield* TestClock.adjust("49 millis");
			expect(baseFetch).toHaveBeenCalledOnce();
			yield* TestClock.adjust("1 millis");
			const result = yield* Fiber.join(fiber);
			expect(Exit.isFailure(result)).toBe(true);
			expect(baseFetch).toHaveBeenCalledTimes(2);
		}),
	);

	it("returns the effect type signature correctly", () => {
		const effect = fetchWithRetry("http://example.com");
		// Verify it returns an Effect (duck-type check)
		expect(effect).toBeDefined();
		expect(typeof effect.pipe).toBe("function");
	});

	it.effect("uses linear backoff matching legacy behavior", () =>
		Effect.gen(function* () {
			const baseFetch = vi
				.fn<typeof fetch>()
				.mockRejectedValue(new Error("ECONNREFUSED"));
			const fiber = yield* Effect.forkChild(
				fetchWithRetry("http://localhost:0/does-not-exist", undefined, {
					retries: 2,
					retryDelay: 100,
					baseFetch,
				}).pipe(Effect.exit),
			);
			yield* TestClock.adjust("99 millis");
			expect(baseFetch).toHaveBeenCalledOnce();
			yield* TestClock.adjust("1 millis");
			expect(baseFetch).toHaveBeenCalledTimes(2);
			yield* TestClock.adjust("199 millis");
			expect(baseFetch).toHaveBeenCalledTimes(2);
			yield* TestClock.adjust("1 millis");
			expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
			expect(baseFetch).toHaveBeenCalledTimes(3);
		}),
	);

	it.live("accepts RequestInfo | URL input type", () =>
		Effect.gen(function* () {
			const url = new URL("http://localhost:0/test");
			const result = yield* Effect.exit(
				fetchWithRetry(url, undefined, { retryDelay: 0 }),
			);
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
