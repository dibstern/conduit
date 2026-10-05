// SDK Factory (Effect-based)
// Creates a configured OpencodeClient from @opencode-ai/sdk/v2.
// Wires up fetchWithRetry (Effect-based), auth headers (for both
// REST and SSE), and returns {client, fetch, authHeaders} so transports and
// OpenCodeAPI can reuse the same authenticated transport.

import {
	createOpencodeClient,
	type OpencodeClient,
} from "@opencode-ai/sdk/v2/client";
import { Effect } from "effect";
import {
	fetchWithRetry,
	type RetryFetchOptions,
} from "../domain/relay/Services/retry-fetch.js";
import { ENV } from "../env.js";
import { OpenCodeApiError } from "../errors.js";

export interface SdkFactoryOptions {
	baseUrl: string;
	directory?: string;
	auth?: { username: string; password: string };
	fetch?: typeof fetch;
	retry?: RetryFetchOptions;
}

export interface SdkFactoryResult {
	client: OpencodeClient;
	fetch: typeof fetch;
	authHeaders: Record<string, string>;
}

function runRetryFetchAtFetchBoundary(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	retry: RetryFetchOptions,
): ReturnType<typeof fetch> {
	return Effect.runPromise(fetchWithRetry(input, init, retry));
}

// The SDK sends SSE requests as a plain Request with no Accept header, so the
// endpoint path is the only signal. Every SDK path ending in /event is SSE.
function isEventStream(request: Request): boolean {
	return new URL(request.url).pathname.endsWith("/event");
}

/**
 * Creates an authenticated OpenCode SDK client.
 *
 * Construction is synchronous; the returned fetch callback remains Promise-shaped
 * because the OpenCode SDK and other transports call the standard Fetch API.
 */
export function createSdkClient(options: SdkFactoryOptions): SdkFactoryResult {
	const baseFetch: typeof fetch =
		options.fetch ??
		((input: RequestInfo | URL, init?: RequestInit) =>
			runRetryFetchAtFetchBoundary(input, init, options.retry ?? {}));

	// The event stream lives for hours, so it must skip fetchWithRetry: its
	// per-attempt timeout would abort the stream, and conduit owns reconnection.
	// Auth already rides on the SDK Request via config.headers.
	const streamFetch: typeof fetch =
		options.fetch ?? options.retry?.baseFetch ?? globalThis.fetch;

	const password = options.auth?.password ?? ENV.opencodePassword;
	const username = options.auth?.username ?? ENV.opencodeUsername;

	const authHeaders: Record<string, string> = {};
	let authValue: string | undefined;
	if (password) {
		const encoded = Buffer.from(`${username}:${password}`).toString("base64");
		authValue = `Basic ${encoded}`;
		authHeaders["Authorization"] = authValue;
	}

	// Auth strategy (Audit v3):
	// - SDK calls _fetch(request) with ONE arg — Request already has auth from config.headers
	// - URL/init calls need auth injected manually
	const authFetch: typeof fetch = authValue
		? async (input, init) => {
				// SDK path: single Request arg, auth already set via config.headers
				if (input instanceof Request && !init) {
					return baseFetch(input);
				}
				// URL/init path: inject auth header
				const headers = new Headers(init?.headers);
				headers.set("Authorization", authValue);
				return baseFetch(input, { ...init, headers });
			}
		: baseFetch;

	// Preserve both SDK Request calls and URL/init calls on the same transport.
	const clientConfig: NonNullable<Parameters<typeof createOpencodeClient>[0]> =
		{
			baseUrl: options.baseUrl,
			fetch: async (input, init) => {
				if (input instanceof Request && isEventStream(input)) {
					return streamFetch(input, init);
				}
				const response = await authFetch(input, init);
				// v2's HTML interceptor discards the response. Preserve HTTP errors
				// and malformed successes before it can lose their status/body.
				if (response.headers.get("Content-Type") === "text/html") {
					throw new OpenCodeApiError({
						message: "OpenCode returned HTML instead of JSON",
						endpoint:
							response.url ||
							(input instanceof Request ? input.url : String(input)),
						responseStatus: response.status,
						responseBody: response.ok
							? { parseDetails: "Expected JSON but received text/html" }
							: await response.text(),
					});
				}
				return response;
			},
			headers: authHeaders,
			// Parse at OpenCodeAPI's validated boundary so malformed JSON retains
			// its HTTP response/status instead of becoming a connection error.
			parseAs: "text",
		};
	if (options.directory) {
		clientConfig.directory = options.directory;
	}
	const client = createOpencodeClient(clientConfig);

	return { client, fetch: authFetch, authHeaders };
}

/**
 * Effect wrapper for call sites that are already inside an Effect program.
 */
export const createSdkClientEffect = (
	options: SdkFactoryOptions,
): Effect.Effect<SdkFactoryResult> =>
	Effect.sync(() => createSdkClient(options));
