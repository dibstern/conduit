// ─── Retry Fetch Adapter (Task 2) ─────────────────────────────────────────────
// Drop-in `fetch` replacement with retry logic and timeout.
// Extracted from OpenCodeClient.request() so it can be injected into the SDK
// via `createOpencodeClient({ fetch: retryFetch })`.

import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
	retries?: number;
	retryDelay?: number;
	timeout?: number;
	baseFetch?: typeof fetch;
}

export function createRetryFetch(
	options: RetryFetchOptions = {},
): typeof fetch {
	const {
		retries = 2,
		retryDelay = 1000,
		timeout = 10_000,
		baseFetch = globalThis.fetch,
	} = options;

	return async (
		input: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		let lastError: Error | undefined;
		let lastResponse: Response | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);

				const mergedInit: RequestInit = {
					...init,
					signal: controller.signal,
				};

				const response = await baseFetch(input, mergedInit);
				clearTimeout(timer);

				// 4xx client errors: return immediately, no retry
				if (response.status >= 400 && response.status < 500) {
					return response;
				}

				// 5xx server errors: retry if attempts remain
				if (response.status >= 500) {
					lastResponse = response;
					if (attempt < retries) {
						await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
						continue;
					}
					return response;
				}

				return response;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				if (lastError.name === "AbortError") {
					throw new OpenCodeConnectionError(
						`Request timed out after ${timeout}ms`,
						{ cause: lastError },
					);
				}

				if (attempt < retries) {
					await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
				}
			}
		}

		if (lastError) throw lastError;
		if (lastResponse) return lastResponse;

		throw new OpenCodeConnectionError(
			"Unexpected: no response or error after retries",
		);
	};
}
