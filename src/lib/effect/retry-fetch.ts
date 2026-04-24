import { Duration, Effect, Schedule } from "effect";
import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
	readonly retries?: number;
	readonly retryDelay?: number;
	readonly timeout?: number;
}

export const fetchWithRetry = (
	url: string,
	init?: RequestInit,
	options: RetryFetchOptions = {},
) => {
	const { retries = 2, retryDelay = 1000, timeout = 10_000 } = options;

	return Effect.tryPromise({
		try: () => fetch(url, { ...init, signal: AbortSignal.timeout(timeout) }),
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
						}),
					)
				: Effect.succeed(res),
		),
		Effect.retry({
			schedule: Schedule.exponential(Duration.millis(retryDelay)).pipe(
				Schedule.compose(Schedule.recurs(retries)),
			),
			while: (err) => !err.message.startsWith("Request timed out"),
		}),
	);
};
