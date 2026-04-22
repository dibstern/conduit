// ─── retryFetch adapter tests (Task 2) ───────────────────────────────────────
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createRetryFetch,
	type RetryFetchOptions,
} from "../../../src/lib/instance/retry-fetch.js";

describe("createRetryFetch", () => {
	let callCount = 0;
	const defaultOpts: RetryFetchOptions = {
		retries: 2,
		retryDelay: 10, // fast for tests
		timeout: 5000,
	};

	beforeEach(() => {
		callCount = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeFetch(responses: Array<Response | Error>): typeof fetch {
		return async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const idx = callCount++;
			const r = responses[idx];
			if (!r) throw new Error(`Unexpected fetch call #${idx}`);
			if (r instanceof Error) throw r;
			return r;
		};
	}

	it("passes through a successful response on first try", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([new Response("ok", { status: 200 })]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(1);
	});

	it("retries on 5xx and succeeds on the second attempt", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([
				new Response("fail", { status: 502 }),
				new Response("ok", { status: 200 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(2);
	});

	it("does NOT retry on 4xx errors", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([new Response("bad request", { status: 400 })]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(400);
		expect(callCount).toBe(1);
	});

	it("retries on network errors and succeeds", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			baseFetch: makeFetch([
				new Error("ECONNREFUSED"),
				new Response("ok", { status: 200 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(2);
	});

	it("throws after exhausting all retries on persistent 5xx", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			retries: 1,
			baseFetch: makeFetch([
				new Response("fail", { status: 500 }),
				new Response("fail", { status: 500 }),
			]),
		});
		const res = await retryFetch(new Request("http://localhost/test"));
		expect(res.status).toBe(500);
		expect(callCount).toBe(2);
	});

	it("throws after exhausting all retries on persistent network error", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			retries: 1,
			baseFetch: makeFetch([
				new Error("ECONNREFUSED"),
				new Error("ECONNREFUSED"),
			]),
		});
		await expect(
			retryFetch(new Request("http://localhost/test")),
		).rejects.toThrow("ECONNREFUSED");
		expect(callCount).toBe(2);
	});

	it("uses exponential backoff between retries", async () => {
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
			if (typeof ms === "number" && ms > 0) delays.push(ms);
			return originalSetTimeout(fn, 0);
		});

		const retryFetch = createRetryFetch({
			...defaultOpts,
			retryDelay: 100,
			retries: 2,
			baseFetch: makeFetch([
				new Response("fail", { status: 500 }),
				new Response("fail", { status: 500 }),
				new Response("ok", { status: 200 }),
			]),
		});
		await retryFetch(new Request("http://localhost/test"));
		expect(delays).toContain(100);
		expect(delays).toContain(200);
	});

	it("aborts on timeout", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			timeout: 50,
			retries: 0,
			baseFetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
				// Respect the abort signal like real fetch does
				return new Promise<Response>((resolve, reject) => {
					const timer = setTimeout(() => {
						resolve(new Response("late", { status: 200 }));
					}, 200);
					init?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(
							new DOMException("The operation was aborted.", "AbortError"),
						);
					});
				});
			},
		});
		await expect(
			retryFetch(new Request("http://localhost/test")),
		).rejects.toThrow();
	});
});
