// ─── SDK Factory (Effect-based, Task 4) ─────────────────────────────────────────
// Creates a configured OpencodeClient from @opencode-ai/sdk.
// Wires up fetchWithRetry (Effect-based, from Task 3), auth headers (for both
// REST and SSE), and returns {client, fetch, authHeaders} so GapEndpoints and
// OpenCodeAPI can reuse the same authenticated transport.

import {
	createOpencodeClient,
	type OpencodeClient,
} from "@opencode-ai/sdk/client";
import { Effect } from "effect";
import {
	fetchWithRetry,
	type RetryFetchOptions,
} from "../effect/retry-fetch.js";
import { ENV } from "../env.js";

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

/**
 * Creates an authenticated OpenCode SDK client.
 *
 * Construction is synchronous; the returned fetch callback remains Promise-shaped
 * because the OpenCode SDK and GapEndpoints both call the standard Fetch API.
 */
export function createSdkClient(options: SdkFactoryOptions): SdkFactoryResult {
	const baseFetch: typeof fetch =
		options.fetch ??
		((input: RequestInfo | URL, init?: RequestInit) =>
			Effect.runPromise(fetchWithRetry(input, init, options.retry ?? {})));

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
	// - GapEndpoints call fetch(url, init) with TWO args — add auth manually
	const authFetch: typeof fetch = authValue
		? async (input, init) => {
				// SDK path: single Request arg, auth already set via config.headers
				if (input instanceof Request && !init) {
					return baseFetch(input);
				}
				// GapEndpoints path: (url, init) — inject auth header
				const headers = new Headers(init?.headers);
				headers.set("Authorization", authValue);
				return baseFetch(input, { ...init, headers });
			}
		: baseFetch;

	// The SDK's fetch type is (request: Request) => ReturnType<typeof fetch>,
	// but createOpencodeClient internally wraps it. We pass our dual-signature
	// authFetch which handles both SDK (single Request) and GapEndpoints (url, init) calls.
	const clientConfig: Parameters<typeof createOpencodeClient>[0] = {
		baseUrl: options.baseUrl,
		fetch: authFetch as (request: Request) => ReturnType<typeof fetch>,
		headers: authHeaders,
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
