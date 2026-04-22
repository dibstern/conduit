// ─── SDK Factory (Task 3) ──────────────────────────────────────────────────────
// Creates a configured OpencodeClient from @opencode-ai/sdk.
// Wires up retryFetch (from Task 2), auth headers (for both REST and SSE),
// and returns {client, fetch, authHeaders} so GapEndpoints and OpenCodeAPI
// can reuse the same authenticated transport.

import {
	createOpencodeClient,
	type OpencodeClient,
} from "@opencode-ai/sdk/client";
import { ENV } from "../env.js";
import { createRetryFetch, type RetryFetchOptions } from "./retry-fetch.js";

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

export function createSdkClient(options: SdkFactoryOptions): SdkFactoryResult {
	const baseFetch = options.fetch ?? createRetryFetch(options.retry ?? {});

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
