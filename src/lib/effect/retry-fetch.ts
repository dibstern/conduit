import { Duration, Effect, Schedule } from "effect";
import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
	readonly retries?: number;
	readonly retryDelay?: number;
	readonly timeout?: number;
	readonly baseFetch?: typeof fetch;
}

export const fetchWithRetry = (
	url: RequestInfo | URL,
	init?: RequestInit,
	options: RetryFetchOptions = {},
) => {
	const {
		retries = 2,
		retryDelay = 1000,
		timeout = 10_000,
		baseFetch = globalThis.fetch,
	} = options;

	return Effect.tryPromise({
		try: () =>
			baseFetch(url, { ...init, signal: AbortSignal.timeout(timeout) }),
		catch: (err) => {
			if (err instanceof DOMException && err.name === "AbortError") {
				return new OpenCodeConnectionError({
					message: `Request timed out after ${timeout}ms`,
				});
			}
			return new OpenCodeConnectionError({
				message: err instanceof Error ? err.message : String(err),
			});
		},
	}).pipe(
		Effect.flatMap((res) =>
			res.status >= 500
				? Effect.fail(
						new OpenCodeConnectionError({
							message: `Server error: ${res.status}`,
							context: { lastResponse: res },
						}),
					)
				: Effect.succeed(res),
		),
		Effect.retry({
			schedule: Schedule.linear(Duration.millis(retryDelay)).pipe(
				Schedule.compose(Schedule.recurs(retries)),
			),
			while: (err) => !err.message.startsWith("Request timed out"),
		}),
		// After retry exhaustion on 5xx, return the last Response (not the error).
		// SDK callers check response.ok / response.status — rejecting breaks them.
		Effect.catchTag("OpenCodeConnectionError", (err) => {
			const lastResponse = err.context?.["lastResponse"];
			if (lastResponse instanceof Response && lastResponse.status >= 500) {
				return Effect.succeed(lastResponse);
			}
			return Effect.fail(err);
		}),
	);
};
