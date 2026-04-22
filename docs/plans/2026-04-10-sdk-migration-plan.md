# OpenCode SDK Migration Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace the hand-rolled `OpenCodeClient` (691 lines) with `@opencode-ai/sdk`, adopt SDK types as canonical throughout the codebase, and migrate SSE consumption to the SDK's streaming API.

**Architecture:** A thin `OpenCodeAPI` adapter delegates to the SDK for ~35 endpoints and raw-fetch for ~5 gap endpoints. A custom `retryFetch` adapter provides exponential backoff. SDK types (`Session`, `Message`, `Part`, `Event`, `SessionStatus`) replace all hand-rolled equivalents. SSE consumption moves from manual stream parsing to `sdk.event.subscribe()` with a reconnection/health wrapper.

**Tech Stack:** TypeScript (ESM), `@opencode-ai/sdk` v1.3.0, Vitest, Biome

**Design Doc:** `docs/plans/2026-04-10-sdk-migration-design.md`

---

## Phase 1: Foundation

### Task 1: Add SDK dependency

**Files:**
- Modify: `package.json:71-82` (dependencies)

**Step 1: Install the SDK**

Run: `pnpm add @opencode-ai/sdk@^1.3.0`

**Step 2: Verify installation**

Run: `pnpm check`
Expected: PASS — no type errors from the new dependency

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @opencode-ai/sdk dependency"
```

---

### Task 2: Create retryFetch adapter

**Files:**
- Create: `src/lib/instance/retry-fetch.ts`
- Create: `test/unit/instance/retry-fetch.test.ts`

The retry logic is extracted from `OpenCodeClient.request()` (lines 594-666) and adapted to the `fetch` API signature so it can be injected into `createOpencodeClient({ fetch: retryFetch })`.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/retry-fetch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryFetch, type RetryFetchOptions } from "../../../src/lib/instance/retry-fetch.js";

describe("createRetryFetch", () => {
	let callCount: number;
	let mockFetch: typeof fetch;
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
		return async (input: RequestInfo | URL, init?: RequestInit) => {
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
			baseFetch: makeFetch([
				new Response("bad request", { status: 400 }),
			]),
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
		// The last 5xx response is returned (not thrown) — caller sees it
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
		await expect(retryFetch(new Request("http://localhost/test"))).rejects.toThrow("ECONNREFUSED");
		expect(callCount).toBe(2);
	});

	it("uses exponential backoff between retries", async () => {
		const delays: number[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
			if (typeof ms === "number" && ms > 0) delays.push(ms);
			return originalSetTimeout(fn, 0); // execute immediately in test
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
		// Expect delays: 100 * 1 = 100, 100 * 2 = 200
		expect(delays).toContain(100);
		expect(delays).toContain(200);
	});

	it("aborts on timeout", async () => {
		const retryFetch = createRetryFetch({
			...defaultOpts,
			timeout: 50,
			retries: 0,
			baseFetch: async () => {
				await new Promise((r) => setTimeout(r, 200));
				return new Response("late", { status: 200 });
			},
		});
		await expect(retryFetch(new Request("http://localhost/test"))).rejects.toThrow();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/retry-fetch.test.ts`
Expected: FAIL — module `retry-fetch.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/retry-fetch.ts
// Custom fetch adapter with retry logic for the OpenCode SDK.
// Injected via createOpencodeClient({ fetch: retryFetch }).

import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
	retries?: number;
	retryDelay?: number;
	timeout?: number;
	baseFetch?: typeof fetch;
}

/**
 * Create a fetch function with retry-on-failure semantics.
 *
 * - Retries on 5xx responses and network errors
 * - Does NOT retry on 4xx (client errors)
 * - Exponential backoff: retryDelay * (attempt + 1)
 * - Timeout via AbortController
 */
export function createRetryFetch(options: RetryFetchOptions = {}): typeof fetch {
	const {
		retries = 2,
		retryDelay = 1000,
		timeout = 10_000,
		baseFetch = globalThis.fetch,
	} = options;

	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let lastError: Error | undefined;
		let lastResponse: Response | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), timeout);

				// Merge abort signals — respect both timeout and caller's signal
				const mergedInit: RequestInit = {
					...init,
					signal: controller.signal,
				};

				const response = await baseFetch(input, mergedInit);
				clearTimeout(timer);

				// 4xx — don't retry, return immediately
				if (response.status >= 400 && response.status < 500) {
					return response;
				}

				// 5xx — retry
				if (response.status >= 500) {
					lastResponse = response;
					if (attempt < retries) {
						await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
						continue;
					}
					return response;
				}

				// Success
				return response;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				// AbortError from timeout — wrap and throw
				if (lastError.name === "AbortError") {
					throw new OpenCodeConnectionError(
						`Request timed out after ${timeout}ms`,
						{ cause: lastError },
					);
				}

				// Network error — retry
				if (attempt < retries) {
					await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
					continue;
				}
			}
		}

		// Exhausted retries
		if (lastError) throw lastError;
		if (lastResponse) return lastResponse;

		throw new OpenCodeConnectionError("Unexpected: no response or error after retries");
	};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/retry-fetch.test.ts`
Expected: PASS — all 8 tests green

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/instance/retry-fetch.ts test/unit/instance/retry-fetch.test.ts
git commit -m "feat: add retryFetch adapter for SDK with exponential backoff"
```

---

### Task 3: Create SDK factory

**Files:**
- Create: `src/lib/instance/sdk-factory.ts`
- Create: `test/unit/instance/sdk-factory.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/sdk-factory.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSdkClient, type SdkFactoryOptions } from "../../../src/lib/instance/sdk-factory.js";

describe("createSdkClient", () => {
	it("creates an OpencodeClient with the given baseUrl", () => {
		const { client } = createSdkClient({ baseUrl: "http://localhost:4096" });
		expect(client).toBeDefined();
		// The SDK client has namespaced methods
		expect(client.session).toBeDefined();
		expect(client.event).toBeDefined();
	});

	it("applies directory header when provided", () => {
		const { client } = createSdkClient({
			baseUrl: "http://localhost:4096",
			directory: "/home/user/project",
		});
		expect(client).toBeDefined();
	});

	it("uses custom fetch when provided", () => {
		const customFetch = vi.fn(async () => new Response("ok"));
		const { client } = createSdkClient({
			baseUrl: "http://localhost:4096",
			fetch: customFetch,
		});
		expect(client).toBeDefined();
	});

	it("returns authHeaders when auth is configured", () => {
		const { authHeaders } = createSdkClient({
			baseUrl: "http://localhost:4096",
			auth: { username: "user", password: "pass" },
		});
		expect(authHeaders.Authorization).toMatch(/^Basic /);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/sdk-factory.test.ts`
Expected: FAIL — module `sdk-factory.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/sdk-factory.ts
// Single factory for SDK client creation.
// Handles auth, directory header, custom fetch injection, and error mode.

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
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
	/** The auth-wrapped retryFetch — reuse for GapEndpoints so they share auth. */
	fetch: typeof fetch;
	/** Auth headers — reuse for OpenCodeAPI.getAuthHeaders() and PTY upstream. */
	authHeaders: Record<string, string>;
}

/**
 * Create a configured OpencodeClient from the SDK.
 *
 * Wires up:
 * - retryFetch as the transport (unless a custom fetch is provided)
 * - Basic Auth via config.headers (for both REST and SSE) AND a custom
 *   fetch wrapper (for GapEndpoints raw-fetch calls)
 * - x-opencode-directory header for project scoping
 *
 * Auth strategy (Audit v3 design):
 * - config.headers carries Authorization — SDK's beforeRequest() merges it
 *   into every Request, covering both REST and SSE paths.
 * - authFetch handles the SDK's single-Request calling convention (pass-through)
 *   and GapEndpoints' two-arg calling convention (adds auth to init.headers).
 * - We do NOT set throwOnError: true. The SDK's default error-returning mode
 *   gives us { error, response } on failure — response.status is available
 *   directly without interceptor hacks. OpenCodeAPI.sdk() checks for errors
 *   and translates them to OpenCodeApiError with responseStatus.
 *
 * Returns the SDK client, the configured fetch, and the auth headers so
 * GapEndpoints and OpenCodeAPI can reuse the same auth-wrapped transport.
 */
export function createSdkClient(options: SdkFactoryOptions): SdkFactoryResult {
	const baseFetch = options.fetch ?? createRetryFetch({
		retries: options.retry?.retries,
		retryDelay: options.retry?.retryDelay,
		timeout: options.retry?.timeout,
	});

	// Build auth credentials
	const password = options.auth?.password ?? ENV.opencodePassword;
	const username = options.auth?.username ?? ENV.opencodeUsername;

	// Auth headers — passed to config.headers so the SDK's beforeRequest()
	// merges them into every request (REST via Request headers, SSE via
	// opts.headers passed to createSseClient's fetch call).
	const authHeaders: Record<string, string> = {};
	if (password) {
		const encoded = Buffer.from(`${username}:${password}`).toString("base64");
		authHeaders.Authorization = `Basic ${encoded}`;
	}

	// Custom fetch wrapper:
	// - SDK calls _fetch(request) with ONE arg — the Request already has auth
	//   from config.headers via beforeRequest(). Just pass through to baseFetch.
	// - GapEndpoints call fetch(url, init) with TWO args — no SDK pipeline,
	//   so we add auth to init.headers manually.
	const authFetch: typeof fetch = password
		? async (input, init) => {
				if (input instanceof Request && !init) {
					// SDK path: auth already on Request from config.headers
					return baseFetch(input);
				}
				// GapEndpoints path: add auth to init.headers
				const headers = new Headers(init?.headers);
				headers.set("Authorization", authHeaders.Authorization);
				return baseFetch(input, { ...init, headers });
			}
		: baseFetch;

	const client = createOpencodeClient({
		baseUrl: options.baseUrl,
		fetch: authFetch as any,
		headers: authHeaders,   // ← REST + SSE get auth via config.headers
		directory: options.directory,
		// Default throwOnError: false — sdk() wrapper checks errors explicitly
		// and extracts response.status for OpenCodeApiError compatibility.
	});

	return { client, fetch: authFetch, authHeaders };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/sdk-factory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/instance/sdk-factory.ts test/unit/instance/sdk-factory.test.ts
git commit -m "feat: add SDK factory with auth and retry-fetch injection"
```

---

### Task 4: Create gap endpoints

**Files:**
- Create: `src/lib/instance/gap-endpoints.ts`
- Create: `test/unit/instance/gap-endpoints.test.ts`

These are the ~6 endpoints not in the SDK. They use the same authenticated `retryFetch` from the SDK factory for consistency — this ensures auth headers are applied to gap endpoint calls too.

> **Audit fix #1:** GapEndpoints must receive the auth-wrapped fetch from sdk-factory. Without it, gap endpoints (GET /permission, GET /question, etc.) return 401. The `GapEndpoints` constructor accepts a `fetch` option — the relay-stack must pass the same authenticated fetch used by the SDK client. Task 3's `createSdkClient` should also export the configured fetch so GapEndpoints can reuse it.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/gap-endpoints.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { GapEndpoints } from "../../../src/lib/instance/gap-endpoints.js";

describe("GapEndpoints", () => {
	function makeGap(responses: Array<{ status: number; body: unknown }>): GapEndpoints {
		let idx = 0;
		const mockFetch = async () => {
			const r = responses[idx++];
			return new Response(JSON.stringify(r.body), {
				status: r.status,
				headers: { "Content-Type": "application/json" },
			});
		};
		return new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: mockFetch as typeof fetch,
		});
	}

	it("listPendingPermissions returns array from GET /permission", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "p1", type: "bash" }] }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([{ id: "p1", type: "bash" }]);
	});

	it("listPendingPermissions returns empty array on non-array", async () => {
		const gap = makeGap([{ status: 200, body: {} }]);
		const result = await gap.listPendingPermissions();
		expect(result).toEqual([]);
	});

	it("listPendingQuestions returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ id: "q1" }] }]);
		const result = await gap.listPendingQuestions();
		expect(result).toEqual([{ id: "q1" }]);
	});

	it("replyQuestion sends POST /question/{id}/reply", async () => {
		let capturedUrl = "";
		let capturedBody: unknown;
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				capturedBody = await req.json();
				return new Response(null, { status: 204 });
			},
		});
		await gap.replyQuestion("q1", [["yes"]]);
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reply");
		expect(capturedBody).toEqual({ answers: [["yes"]] });
	});

	it("rejectQuestion sends POST /question/{id}/reject", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(null, { status: 204 });
			},
		});
		await gap.rejectQuestion("q1");
		expect(capturedUrl).toBe("http://localhost:4096/question/q1/reject");
	});

	it("listSkills returns array", async () => {
		const gap = makeGap([{ status: 200, body: [{ name: "s1" }] }]);
		const result = await gap.listSkills();
		expect(result).toEqual([{ name: "s1" }]);
	});

	it("getMessagesPage passes limit and before params", async () => {
		let capturedUrl = "";
		const gap = new GapEndpoints({
			baseUrl: "http://localhost:4096",
			fetch: async (input) => {
				const req = input instanceof Request ? input : new Request(input);
				capturedUrl = req.url;
				return new Response(JSON.stringify([]), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		await gap.getMessagesPage("s1", { limit: 10, before: "m5" });
		expect(capturedUrl).toContain("/session/s1/message");
		expect(capturedUrl).toContain("limit=10");
		expect(capturedUrl).toContain("before=m5");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/gap-endpoints.test.ts`
Expected: FAIL — module `gap-endpoints.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/gap-endpoints.ts
// Raw-fetch helpers for endpoints not yet in the @opencode-ai/sdk.
// Uses the same retryFetch for consistency with SDK calls.

export interface GapEndpointsOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: Record<string, string>;
}

/**
 * Wraps endpoints that the SDK doesn't cover yet.
 * When the SDK adds coverage, migrate each method to the SDK and delete it here.
 */
export class GapEndpoints {
	private readonly baseUrl: string;
	private readonly fetch: typeof globalThis.fetch;
	private readonly headers: Record<string, string>;

	constructor(options: GapEndpointsOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
			...options.headers,
		};
	}

	// ─── Permissions ─────────────────────────────────────────────────────

	async listPendingPermissions(): Promise<unknown[]> {
		const res = await this.get("/permission");
		return Array.isArray(res) ? res : [];
	}

	// ─── Questions ───────────────────────────────────────────────────────

	async listPendingQuestions(): Promise<unknown[]> {
		const res = await this.get("/question");
		return Array.isArray(res) ? res : [];
	}

	async replyQuestion(id: string, answers: string[][]): Promise<void> {
		await this.post(`/question/${id}/reply`, { answers });
	}

	async rejectQuestion(id: string): Promise<void> {
		await this.post(`/question/${id}/reject`, {});
	}

	// ─── Skills ──────────────────────────────────────────────────────────

	async listSkills(directory?: string): Promise<Array<{ name: string; description?: string }>> {
		const path = directory
			? `/skill?directory=${encodeURIComponent(directory)}`
			: "/skill";
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	// ─── Paginated Messages ──────────────────────────────────────────────

	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<unknown[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("before", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		const res = await this.get(path);
		return Array.isArray(res) ? res : [];
	}

	// ─── Internal ────────────────────────────────────────────────────────

	private async get(path: string): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "GET",
				headers: this.headers,
			}),
		);
		if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		return res.json();
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.fetch(
			new Request(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.headers,
				body: JSON.stringify(body),
			}),
		);
		if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
		if (res.status === 204) return undefined;
		const ct = res.headers.get("content-type") ?? "";
		if (ct.includes("application/json")) return res.json();
		return undefined;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/gap-endpoints.test.ts`
Expected: PASS — all 7 tests green

**Step 5: Run full Phase 1 check**

Run: `pnpm check && pnpm test:unit`
Expected: PASS — all existing tests still pass, new tests pass

**Step 6: Commit**

```bash
git add src/lib/instance/gap-endpoints.ts test/unit/instance/gap-endpoints.test.ts
git commit -m "feat: add GapEndpoints for SDK-uncovered endpoints"
```

---

## Phase 2: Client Swap

### Task 5: Create OpenCodeAPI adapter

**Files:**
- Create: `src/lib/instance/opencode-api.ts`
- Create: `test/unit/instance/opencode-api.test.ts`

This is the core adapter that wraps the SDK + gap endpoints into a unified namespaced API. Callers will use `api.session.list()` instead of `client.listSessions()`.

**Step 1: Write the failing tests**

```typescript
// test/unit/instance/opencode-api.test.ts
import { describe, expect, it, vi } from "vitest";
import { OpenCodeAPI, type OpenCodeAPIOptions } from "../../../src/lib/instance/opencode-api.js";

// Stub SDK client — we only test that methods delegate correctly
function makeStubSdk() {
	return {
		session: {
			list: vi.fn(async () => ({ data: [{ id: "s1", title: "test" }] })),
			get: vi.fn(async () => ({ data: { id: "s1", title: "test" } })),
			create: vi.fn(async () => ({ data: { id: "s2", title: "new" } })),
			delete: vi.fn(async () => ({ data: undefined })),
			update: vi.fn(async () => ({ data: { id: "s1", title: "updated" } })),
			status: vi.fn(async () => ({ data: { s1: { type: "idle" } } })),
			messages: vi.fn(async () => ({ data: [] })),
			abort: vi.fn(async () => ({ data: undefined })),
			fork: vi.fn(async () => ({ data: { id: "s3" } })),
			revert: vi.fn(async () => ({ data: undefined })),
			unrevert: vi.fn(async () => ({ data: undefined })),
			share: vi.fn(async () => ({ data: { url: "https://share.test" } })),
			summarize: vi.fn(async () => ({ data: undefined })),
			diff: vi.fn(async () => ({ data: { diffs: [] } })),
			promptAsync: vi.fn(async () => ({ data: undefined })),
		},
		config: {
			get: vi.fn(async () => ({ data: {} })),
			update: vi.fn(async () => ({ data: {} })),
			providers: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })),
		},
		pty: {
			list: vi.fn(async () => ({ data: [] })),
			create: vi.fn(async () => ({ data: { id: "pty1" } })),
			remove: vi.fn(async () => ({ data: undefined })),
			update: vi.fn(async () => ({ data: undefined })),
		},
		file: {
			list: vi.fn(async () => ({ data: [] })),
			read: vi.fn(async () => ({ data: { content: "hello" } })),
			status: vi.fn(async () => ({ data: [] })),
		},
		find: {
			text: vi.fn(async () => ({ data: [] })),
			files: vi.fn(async () => ({ data: [] })),
			symbols: vi.fn(async () => ({ data: [] })),
		},
		path: { get: vi.fn(async () => ({ data: { cwd: "/test" } })) },
		vcs: { get: vi.fn(async () => ({ data: { branch: "main" } })) },
		app: { agents: vi.fn(async () => ({ data: [] })) },
		command: { list: vi.fn(async () => ({ data: [] })) },
		event: { subscribe: vi.fn(async () => ({ stream: (async function* () {})() })) },
		postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: undefined })),
	} as any;
}

function makeStubGaps() {
	return {
		listPendingPermissions: vi.fn(async () => []),
		listPendingQuestions: vi.fn(async () => []),
		replyQuestion: vi.fn(async () => {}),
		rejectQuestion: vi.fn(async () => {}),
		listSkills: vi.fn(async () => []),
		getMessagesPage: vi.fn(async () => []),
	} as any;
}

describe("OpenCodeAPI", () => {
	it("session.list() delegates to sdk.session.list()", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		const result = await api.session.list();
		expect(sdk.session.list).toHaveBeenCalled();
		expect(result).toEqual([{ id: "s1", title: "test" }]);
	});

	it("permission.list() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		gaps.listPendingPermissions.mockResolvedValue([{ id: "p1" }]);
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		const result = await api.permission.list();
		expect(gaps.listPendingPermissions).toHaveBeenCalled();
		expect(result).toEqual([{ id: "p1" }]);
	});

	it("question.reply() delegates to gapEndpoints", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.question.reply("q1", [["yes"]]);
		expect(gaps.replyQuestion).toHaveBeenCalledWith("q1", [["yes"]]);
	});

	it("session.prompt() builds parts array from text", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.session.prompt("s1", { text: "hello" });
		expect(sdk.session.promptAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				body: expect.objectContaining({
					parts: [{ type: "text", text: "hello" }],
				}),
			}),
		);
	});

	it("permission.reply() maps decision and delegates to SDK", async () => {
		const sdk = makeStubSdk();
		const gaps = makeStubGaps();
		const api = new OpenCodeAPI({ sdk, gapEndpoints: gaps });
		await api.permission.reply("s1", "perm1", "once");
		expect(sdk.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(
			expect.objectContaining({
				path: { id: "s1", permissionID: "perm1" },
				body: { response: "once" },
			}),
		);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/opencode-api.test.ts`
Expected: FAIL — module `opencode-api.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/instance/opencode-api.ts
// Thin adapter wrapping @opencode-ai/sdk + GapEndpoints into unified namespaced API.
// Callers use api.session.list(), api.permission.reply(), etc.
// Internal gapEndpoints field is visible to maintainers — public API is unified.
//
// Error strategy (Audit v3 design):
// - SDK uses default throwOnError: false — errors return { error, response },
//   not thrown. This gives us response.status directly.
// - The sdk() wrapper checks result.error and translates it into
//   OpenCodeApiError (with responseStatus from response.status) or
//   OpenCodeConnectionError for caller compatibility.
// - This means existing catch blocks like:
//     err instanceof OpenCodeApiError && err.responseStatus === 400
//   continue working unchanged.

import type { OpencodeClient } from "@opencode-ai/sdk/client";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import type { GapEndpoints } from "./gap-endpoints.js";

export interface OpenCodeAPIOptions {
	sdk: OpencodeClient;
	gapEndpoints: GapEndpoints;
	/** Base URL for PTY upstream WebSocket connections (Audit fix #5). */
	baseUrl: string;
	/** Auth headers for PTY upstream connections (Audit fix #5). */
	authHeaders?: Record<string, string>;
}

export interface PromptInput {
	text: string;
	images?: string[];
	agent?: string;
	model?: { providerID: string; modelID: string };
	variant?: string;
}

/**
 * Unified API adapter for OpenCode.
 * Uses SDK for ~35 endpoints, raw-fetch GapEndpoints for ~6 uncovered ones.
 * Public namespaces (session, permission, question, etc.) are unified —
 * callers don't know which implementation backs each method.
 */
export class OpenCodeAPI {
	/** @internal SDK client — visible for maintainer clarity */
	private readonly sdkClient: OpencodeClient;
	/** @internal Gap endpoints — visible for maintainer clarity */
	private readonly gapEndpoints: GapEndpoints;

	constructor(options: OpenCodeAPIOptions) {
		this.sdkClient = options.sdk;
		this.gapEndpoints = options.gapEndpoints;
		this.baseUrl = options.baseUrl;
		this.authHeaders = options.authHeaders ?? {};
	}

	// ─── Session ──────────────────────────────────────────────────────────

	readonly session = {
		list: async (options?: { archived?: boolean; roots?: boolean; limit?: number }) => {
			return this.sdk(() => this.sdkClient.session.list({ query: options }));
		},
		get: async (id: string) => {
			return this.sdk(() => this.sdkClient.session.get({ path: { id } }));
		},
		create: async (options?: { title?: string; agentID?: string; providerID?: string; modelID?: string }) => {
			return this.sdk(() => this.sdkClient.session.create({ body: options }));
		},
		delete: async (id: string) => {
			await this.sdk(() => this.sdkClient.session.delete({ path: { id } }));
		},
		update: async (id: string, updates: { title?: string }) => {
			return this.sdk(() => this.sdkClient.session.update({ path: { id }, body: updates }));
		},
		statuses: async () => {
			return this.sdk(() => this.sdkClient.session.status()) as Record<string, unknown>;
		},
		// NOTE (Audit v1 fix #2): SDK returns Array<{ info: Message, parts: Part[] }>,
		// NOT flat messages. This is intentional — "SDK types everywhere" means
		// callers must access msg.info.id, msg.info.role, etc. Task 7 callers
		// and Task 10 type migration must update all message field access.
		messages: async (id: string) => {
			return this.sdk(() => this.sdkClient.session.messages({ path: { id } }));
		},
		messagesPage: async (id: string, options?: { limit?: number; before?: string }) => {
			return this.gapEndpoints.getMessagesPage(id, options);
		},
		message: async (id: string, messageId: string) => {
			return this.sdk(() => this.sdkClient.session.message({ path: { id, messageID: messageId } }));
		},
		prompt: async (id: string, prompt: PromptInput) => {
			const parts: Array<Record<string, unknown>> = [];
			if (prompt.text) parts.push({ type: "text", text: prompt.text });
			if (prompt.images) {
				for (const img of prompt.images) {
					parts.push({ type: "file", url: img, mime: "image/png" });
				}
			}
			const body: Record<string, unknown> = { parts };
			if (prompt.agent) body["agent"] = prompt.agent;
			if (prompt.model) body["model"] = prompt.model;
			if (prompt.variant) body["variant"] = prompt.variant;
			await this.sdk(() => this.sdkClient.session.promptAsync({ path: { id }, body: body as any }));
		},
		abort: async (id: string) => {
			await this.sdk(() => this.sdkClient.session.abort({ path: { id } }));
		},
		fork: async (id: string, options: { messageID?: string; title?: string }) => {
			return this.sdk(() => this.sdkClient.session.fork({ path: { id }, body: options }));
		},
		revert: async (id: string, messageId: string) => {
			await this.sdk(() => this.sdkClient.session.revert({ path: { id }, body: { messageID: messageId } }));
		},
		unrevert: async (id: string) => {
			await this.sdk(() => this.sdkClient.session.unrevert({ path: { id } }));
		},
		share: async (id: string) => {
			return this.sdk(() => this.sdkClient.session.share({ path: { id } }));
		},
		summarize: async (id: string) => {
			await this.sdk(() => this.sdkClient.session.summarize({ path: { id } }));
		},
		diff: async (id: string, messageId: string) => {
			return this.sdk(() => this.sdkClient.session.diff({ path: { id }, query: { messageID: messageId } }));
		},
	};

	// ─── Permission ───────────────────────────────────────────────────────

	readonly permission = {
		list: async () => {
			return this.gapEndpoints.listPendingPermissions();
		},
		reply: async (sessionId: string, permissionId: string, response: "once" | "always" | "reject") => {
			await this.sdk(() => this.sdkClient.postSessionIdPermissionsPermissionId({
				path: { id: sessionId, permissionID: permissionId },
				body: { response },
			}));
		},
	};

	// ─── Question ─────────────────────────────────────────────────────────

	readonly question = {
		list: async () => {
			return this.gapEndpoints.listPendingQuestions();
		},
		reply: async (id: string, answers: string[][]) => {
			await this.gapEndpoints.replyQuestion(id, answers);
		},
		reject: async (id: string) => {
			await this.gapEndpoints.rejectQuestion(id);
		},
	};

	// ─── Config ───────────────────────────────────────────────────────────

	readonly config = {
		get: async () => {
			return this.sdk(() => this.sdkClient.config.get());
		},
		update: async (config: Record<string, unknown>) => {
			return this.sdk(() => this.sdkClient.config.update({ body: config as any }));
		},
	};

	// ─── Provider ─────────────────────────────────────────────────────────

	// NOTE (Audit v1 fix #3): Use sdk.provider.list() (not config.providers())
	// because it returns { all, default, connected } matching ProviderListResult.
	// NOTE (Audit v2 fix #4): Use SDK's full model type — don't narrow to
	// Record<string, unknown>. The ProviderListResponses["200"] type defines
	// detailed model objects with id, name, cost, limits, modalities, etc.
	// Callers in model.ts, client-init.ts, settings.ts should access these
	// fields using the SDK model shape (Task 10 verifies this).
	readonly provider = {
		list: async () => {
			const data = await this.sdk(() => this.sdkClient.provider.list());
			// data is ProviderListResponse: { all: [...], default: {...}, connected: [...] }
			// Normalize models from Record<string, Model> to Array<Model>
			const providers = (data.all ?? []).map((p: any) => ({
				...p,
				models: p.models && typeof p.models === "object" && !Array.isArray(p.models)
					? Object.values(p.models)
					: p.models ?? [],
			}));
			return { providers, defaults: data.default ?? {}, connected: data.connected ?? [] };
		},
	};

	// ─── PTY ──────────────────────────────────────────────────────────────

	readonly pty = {
		list: async () => {
			return this.sdk(() => this.sdkClient.pty.list());
		},
		create: async (options?: { command?: string; args?: string[]; cwd?: string }) => {
			return this.sdk(() => this.sdkClient.pty.create({ body: options as any }));
		},
		delete: async (id: string) => {
			await this.sdk(() => this.sdkClient.pty.remove({ path: { id } }));
		},
		resize: async (id: string, cols: number, rows: number) => {
			await this.sdk(() => this.sdkClient.pty.update({ path: { id }, body: { size: { cols, rows } } as any }));
		},
	};

	// ─── File ─────────────────────────────────────────────────────────────

	readonly file = {
		list: async (path?: string) => {
			return this.sdk(() => this.sdkClient.file.list({ query: { path: path || "." } }));
		},
		read: async (path: string) => {
			return this.sdk(() => this.sdkClient.file.read({ query: { path } }));
		},
		status: async () => {
			return this.sdk(() => this.sdkClient.file.status());
		},
	};

	// ─── Find ─────────────────────────────────────────────────────────────

	readonly find = {
		text: async (pattern: string) => {
			return this.sdk(() => this.sdkClient.find.text({ query: { pattern } }));
		},
		files: async (query: string) => {
			return this.sdk(() => this.sdkClient.find.files({ query: { query } }));
		},
		symbols: async (query: string) => {
			return this.sdk(() => this.sdkClient.find.symbols({ query: { query } }));
		},
	};

	// ─── App ──────────────────────────────────────────────────────────────

	readonly app = {
		health: async () => {
			await this.sdk(() => this.sdkClient.path.get());
			return { ok: true } as { ok: boolean; version?: string };
		},
		agents: async () => {
			return this.sdk(() => this.sdkClient.app.agents());
		},
		commands: async (directory?: string) => {
			return this.sdk(() => this.sdkClient.command.list({ query: directory ? { directory } : undefined }));
		},
		skills: async (directory?: string) => {
			return this.gapEndpoints.listSkills(directory);
		},
		path: async () => {
			return this.sdk(() => this.sdkClient.path.get());
		},
		vcs: async () => {
			return this.sdk(() => this.sdkClient.vcs.get());
		},
		projects: async () => {
			return this.sdk(() => this.sdkClient.project.list());
		},
		currentProject: async () => {
			return this.sdk(() => this.sdkClient.project.current());
		},
	};

	// ─── Event (SSE) ──────────────────────────────────────────────────────

	readonly event = {
		subscribe: async () => {
			return this.sdkClient.event.subscribe();
		},
	};

	// ─── Connection Info (Audit fix #5) ──────────────────────────────────
	// PTY upstream WebSocket connections need the base URL and auth headers.
	// These replace OpenCodeClient.getBaseUrl() and getAuthHeaders().

	private readonly baseUrl: string;
	private readonly authHeaders: Record<string, string>;

	/** Expose the base URL for PTY upstream WebSocket connections. */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/** Expose auth headers for PTY upstream and other raw connections. */
	getAuthHeaders(): Record<string, string> {
		return { ...this.authHeaders };
	}

	// ─── SDK Call Wrapper (Audit v3 design) ─────────────────────────────
	//
	// With the SDK's default throwOnError: false, success returns
	// { data, response } and errors return { error, response }.
	// We check for errors explicitly and translate them to
	// OpenCodeApiError (with response.status) so callers' existing
	// catch blocks keep working:
	//   err instanceof OpenCodeApiError && err.responseStatus === 400

	/**
	 * Call an SDK method, check for errors, return data.
	 *
	 * The SDK returns { data, response } on success and { error, response }
	 * on failure. This wrapper checks for errors and translates them into
	 * OpenCodeApiError / OpenCodeConnectionError for caller compatibility.
	 * response.status is available directly — no interceptor hacks needed.
	 */
	private async sdk<T>(fn: () => Promise<{ data?: T; error?: unknown; response?: Response }>): Promise<T> {
		try {
			const result = await fn() as { data?: T; error?: unknown; response?: Response };
			if (result.error !== undefined) {
				throw this.toRelayError(result.error, result.response);
			}
			return result.data as T;
		} catch (err) {
			if (err instanceof OpenCodeApiError || err instanceof OpenCodeConnectionError) throw err;
			// Network errors (fetch failures) throw directly — no response
			const message = err instanceof Error ? err.message : String(err);
			throw new OpenCodeConnectionError(message, { cause: err instanceof Error ? err : undefined });
		}
	}

	/** Translate SDK error + Response into relay error types. */
	private toRelayError(error: unknown, response?: Response): Error {
		if (response) {
			const message = (error && typeof error === "object" && "message" in error)
				? String((error as { message: unknown }).message)
				: `API error: ${response.status}`;
			return new OpenCodeApiError(message, {
				endpoint: new URL(response.url).pathname,
				responseStatus: response.status,
				responseBody: error,
			});
		}
		return new OpenCodeConnectionError(String(error));
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/opencode-api.test.ts`
Expected: PASS

**Step 5: Run type check and full tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/instance/opencode-api.ts test/unit/instance/opencode-api.test.ts
git commit -m "feat: add OpenCodeAPI adapter wrapping SDK + gap endpoints"
```

---

### Task 6: Migrate relay-stack.ts to construct OpenCodeAPI

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:15` (import) and construction site (~line 50-60)
- Modify: `src/lib/handlers/types.ts:7-9` (HandlerDeps.client type)

This task changes the central wiring to create `OpenCodeAPI` instead of `OpenCodeClient`. Both are available during migration — `OpenCodeClient` is kept temporarily for SSE consumer (which still uses `getBaseUrl()` and `getAuthHeaders()`).

**Step 1: Update HandlerDeps to accept OpenCodeAPI**

In `src/lib/handlers/types.ts`, change the `client` field type from `OpenCodeClient` to `OpenCodeAPI`. This requires updating the import.

**Step 2: Update relay-stack.ts construction**

Replace the `OpenCodeClient` construction with `OpenCodeAPI` construction using `createSdkClient` + `GapEndpoints`. Keep `OpenCodeClient` temporarily for SSE consumer.

> **Audit v4 fix:** Pass `authHeaders` to GapEndpoints' `headers` option so gap endpoint
> Requests carry auth. GapEndpoints calls `this.fetch(new Request(...))` with one arg,
> which hits authFetch's pass-through path — so auth must already be on the Request.

```typescript
// relay-stack.ts construction (replaces OpenCodeClient)
const { client, fetch: sdkFetch, authHeaders } = createSdkClient({
    baseUrl: config.opencodeUrl,
    directory: config.projectDir,
});

const gapEndpoints = new GapEndpoints({
    baseUrl: config.opencodeUrl,
    fetch: sdkFetch,
    headers: authHeaders,  // ← gap endpoint Requests get auth via constructor headers
});

const api = new OpenCodeAPI({
    sdk: client,
    gapEndpoints,
    baseUrl: config.opencodeUrl,
    authHeaders,
});
```

**Step 3: Run type check**

Run: `pnpm check`
Expected: FAIL — all callers that use `client.listSessions()` etc. now fail because `OpenCodeAPI` uses `client.session.list()` instead.

This is expected — Task 7 will update all callers.

**Step 4: Commit (type errors expected, WIP)**

```bash
git add src/lib/relay/relay-stack.ts src/lib/handlers/types.ts
git commit -m "wip: wire OpenCodeAPI into relay-stack (callers not yet updated)"
```

---

### Task 7: Migrate all caller files to OpenCodeAPI namespaced methods

> **Audit fix #2 note:** `session.messages()` now returns SDK shape `Array<{ info: Message, parts: Part[] }>`, NOT flat messages. When migrating callers that access message fields (session-manager.ts, message-poller.ts, client-init.ts), update field access from `msg.id` to `msg.info.id`, `msg.role` to `msg.info.role`, etc. Full type alignment happens in Task 10, but method call sites must handle the new shape here.

**Files to modify** (one at a time, with type check between each):
- `src/lib/handlers/agent.ts` — `client.listAgents()` → `client.app.agents()`
- `src/lib/handlers/prompt.ts` — `client.sendMessageAsync()` → `client.session.prompt()`, `client.abortSession()` → `client.session.abort()`, `client.revertSession()` → `client.session.revert()`
- `src/lib/handlers/session.ts` — `client.getSession()` → `client.session.get()`, `client.listPendingPermissions()` → `client.permission.list()`, `client.listPendingQuestions()` → `client.question.list()`, `client.forkSession()` → `client.session.fork()`, `client.getMessage()` → `client.session.message()`, `client.getMessagesPage()` → `client.session.messagesPage()`
- `src/lib/handlers/permissions.ts` — `client.replyPermission()` → `client.permission.reply()`, `client.getConfig()` → `client.config.get()`, `client.updateConfig()` → `client.config.update()`, `client.replyQuestion()` → `client.question.reply()`, `client.listPendingQuestions()` → `client.question.list()`, `client.rejectQuestion()` → `client.question.reject()`
- `src/lib/handlers/model.ts` — `client.listProviders()` → `client.provider.list()`, `client.getSession()` → `client.session.get()`, `client.updateConfig()` → `client.config.update()`
- `src/lib/handlers/files.ts` — `client.getFileContent()` → `client.file.read()`, `client.listDirectory()` → `client.file.list()`
- `src/lib/handlers/terminal.ts` — `client.createPty()` → `client.pty.create()`, `client.deletePty()` → `client.pty.delete()`, `client.listPtys()` → `client.pty.list()`, `client.resizePty()` → `client.pty.resize()`
- `src/lib/handlers/settings.ts` — `client.listCommands()` → `client.app.commands()`, `client.listProjects()` → `client.app.projects()`
- `src/lib/session/session-manager.ts` — `client.listSessions()` → `client.session.list()`, `client.getMessages()` → `client.session.messages()`, `client.createSession()` → `client.session.create()`, `client.deleteSession()` → `client.session.delete()`, `client.updateSession()` → `client.session.update()`, `client.getSession()` → `client.session.get()`
- `src/lib/session/session-status-poller.ts` — `client.getSessionStatuses()` → `client.session.statuses()`, `client.getSession()` → `client.session.get()`
- `src/lib/bridges/client-init.ts` — `client.getSession()` → `client.session.get()`, `client.listPendingPermissions()` → `client.permission.list()`, `client.listPendingQuestions()` → `client.question.list()`, `client.listAgents()` → `client.app.agents()`, `client.listProviders()` → `client.provider.list()`
- `src/lib/relay/message-poller.ts` — `client.getMessages()` → `client.session.messages()`
- `src/lib/relay/message-poller-manager.ts` — type import update
- `src/lib/provider/opencode-adapter.ts` — `client.sendMessageAsync()` → `client.session.prompt()`, `client.abortSession()` → `client.session.abort()`
- `src/lib/relay/monitoring-wiring.ts` — type import update
- `src/lib/relay/session-lifecycle-wiring.ts` — type import update
- `src/lib/relay/handler-deps-wiring.ts` — type import update
- `src/lib/relay/monitoring-reducer.ts` — type import update
- `src/lib/relay/monitoring-types.ts` — type import update
- `src/lib/session/session-status-sqlite.ts` — type import update
- `src/lib/session/status-augmentation.ts` — type import update

**Step 0 (Audit v2 fix #3): Rewrite mock-factories.ts FIRST**

> The central mock factory at `test/helpers/mock-factories.ts` has 38 flat-API
> stub methods (`sendMessageAsync`, `getSession`, `listSessions`, etc.) that
> must be restructured to the namespaced shape BEFORE migrating source files.
> Otherwise every test that uses `createMockHandlerDeps()` will fail.

Restructure `createMockClient()` in `test/helpers/mock-factories.ts`:
```typescript
function createMockClient(): HandlerDeps["client"] {
	return {
		session: {
			list: vi.fn().mockResolvedValue([]),
			get: vi.fn().mockResolvedValue({ id: "s1", modelID: "gpt-4", providerID: "openai" }),
			create: vi.fn().mockResolvedValue({ id: "session-new" }),
			delete: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue({ id: "s1" }),
			statuses: vi.fn().mockResolvedValue({}),
			messages: vi.fn().mockResolvedValue([]),
			messagesPage: vi.fn().mockResolvedValue([]),
			message: vi.fn().mockResolvedValue({ id: "msg-1", time: { created: 0 } }),
			prompt: vi.fn().mockResolvedValue(undefined),
			abort: vi.fn().mockResolvedValue(undefined),
			fork: vi.fn().mockResolvedValue({ id: "ses_forked" }),
			revert: vi.fn().mockResolvedValue(undefined),
			unrevert: vi.fn().mockResolvedValue(undefined),
			share: vi.fn().mockResolvedValue({ url: "https://share.test" }),
			summarize: vi.fn().mockResolvedValue(undefined),
			diff: vi.fn().mockResolvedValue({ diffs: [] }),
		},
		permission: {
			list: vi.fn().mockResolvedValue([]),
			reply: vi.fn().mockResolvedValue(undefined),
		},
		question: {
			list: vi.fn().mockResolvedValue([]),
			reply: vi.fn().mockResolvedValue(undefined),
			reject: vi.fn().mockResolvedValue(undefined),
		},
		config: {
			get: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
		},
		provider: {
			list: vi.fn().mockResolvedValue({ providers: [], defaults: {}, connected: [] }),
		},
		pty: {
			list: vi.fn().mockResolvedValue([]),
			create: vi.fn().mockResolvedValue({ id: "pty-1", title: "Terminal", pid: 42 }),
			delete: vi.fn().mockResolvedValue(undefined),
			resize: vi.fn().mockResolvedValue(undefined),
		},
		file: {
			list: vi.fn().mockResolvedValue([]),
			read: vi.fn().mockResolvedValue({ content: "file content", binary: false }),
			status: vi.fn().mockResolvedValue([]),
		},
		find: {
			text: vi.fn().mockResolvedValue([]),
			files: vi.fn().mockResolvedValue([]),
			symbols: vi.fn().mockResolvedValue([]),
		},
		app: {
			health: vi.fn().mockResolvedValue({ ok: true }),
			agents: vi.fn().mockResolvedValue([]),
			commands: vi.fn().mockResolvedValue([]),
			skills: vi.fn().mockResolvedValue([]),
			path: vi.fn().mockResolvedValue({ cwd: "/test" }),
			vcs: vi.fn().mockResolvedValue({ branch: "main" }),
			projects: vi.fn().mockResolvedValue([]),
			currentProject: vi.fn().mockResolvedValue(undefined),
		},
		event: {
			subscribe: vi.fn().mockResolvedValue({ stream: (async function* () {})() }),
		},
		getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
		getAuthHeaders: vi.fn().mockReturnValue({}),
	} as unknown as HandlerDeps["client"];
}
```

Also update `createMockProjectRelay()` to use `sseStream` instead of `sseConsumer` (forward-compatible with Task 14).

**13 test files** that import `OpenCodeClient` need updating:
- `test/helpers/mock-factories.ts` — full rewrite (above)
- `test/unit/provider/opencode-adapter-discover.test.ts`
- `test/unit/provider/orchestration-wiring.test.ts`
- `test/unit/provider/opencode-adapter-actions.test.ts`
- `test/unit/provider/opencode-adapter-send-turn.test.ts`
- `test/unit/session/session-manager.pbt.test.ts`
- `test/unit/session/session-manager-parentid.test.ts`
- `test/unit/session/conduit-owned-fields.test.ts`
- `test/unit/server/m4-backend.test.ts`
- `test/unit/relay/markdown-renderer.test.ts`
- `test/integration/flows/sse-consumer.integration.ts`
- `test/integration/flows/rest-client.integration.ts`
- `test/e2e/fixtures/subagent-snapshot.json`

Run: `pnpm check` — expect some failures from callers not yet migrated (that's fine, Steps 1-2 fix them).

**Step 1: Update each source file**

For each file listed above:
1. Change `import type { OpenCodeClient, ... } from "../instance/opencode-client.js"` to `import type { OpenCodeAPI } from "../instance/opencode-api.js"`
2. Change method calls from flat (e.g. `client.listSessions()`) to namespaced (e.g. `client.session.list()`)
3. Update any `Pick<OpenCodeClient, "getMessages">` patterns to `Pick<OpenCodeAPI["session"], "messages">`

**Step 2: Run type check after all files updated**

Run: `pnpm check`
Expected: PASS — no type errors

**Step 3: Run full test suite**

Run: `pnpm test:unit`
Expected: PASS — mock-factories already restructured in Step 0, so tests should pass

**Step 4: Fix any remaining test-only issues**

If any individual test files construct one-off stubs using the old flat shape, update them too.

**Step 5: Run full verification**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: migrate all callers from OpenCodeClient to OpenCodeAPI namespaced methods"
```

---

## Phase 3: Type Migration

### Task 8: Audit and map all type usages

**Files:**
- Read-only scan of all files importing from `shared-types.ts`, `types.ts`, and `opencode-client.ts`

This is a research task — no code changes. Read every file that imports types we're replacing and note exactly which SDK type replaces each usage.

**Step 1: Search for all imports of replaced types**

Run: `grep -rn "SessionDetail\|HistoryMessage\|HistoryMessagePart\|PartState\|OpenCodeEvent\|SessionStatus\|SessionInfo\|PartType\|ToolStatus" src/lib/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`

Document which files use each type and what SDK type replaces it.

**Step 2: Document the mapping**

Create a checklist of every file + type to change. This informs Tasks 9-12.

**Step 3: No commit needed** — this is research.

---

### Task 9: Replace SessionStatus and SessionDetail types

**Files to modify:**
- `src/lib/instance/opencode-client.ts:37-40` — `SessionStatus` type (note: keep file for now, just update exports)
- `src/lib/instance/opencode-client.ts:98-117` — `SessionDetail` type
- `src/lib/session/session-status-poller.ts` — uses `SessionStatus`
- `src/lib/session/session-manager.ts` — uses `SessionDetail`, `SessionStatus`
- `src/lib/session/session-status-sqlite.ts` — uses `SessionStatus`
- `src/lib/session/status-augmentation.ts` — uses `SessionStatus`
- `src/lib/relay/monitoring-reducer.ts` — uses `SessionStatus`
- `src/lib/relay/monitoring-types.ts` — uses `SessionStatus`

The SDK `SessionStatus` is structurally identical: `{ type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number }`.

The SDK `Session` replaces `SessionDetail` — it has more fields but the existing fields map directly.

**Step 1: Create a re-export bridge file**

Create `src/lib/instance/sdk-types.ts` that re-exports SDK types with any necessary aliases:

```typescript
// src/lib/instance/sdk-types.ts
// Re-export SDK types used throughout the codebase.
// Single import point for SDK types — when SDK types change, only this file updates.
export type {
	Session,
	SessionStatus,
	UserMessage,
	AssistantMessage,
	Message,
	Part,
	TextPart,
	ReasoningPart,
	FilePart,
	ToolPart,
	StepStartPart,
	StepFinishPart,
	SnapshotPart,
	PatchPart,
	AgentPart,
	RetryPart,
	CompactionPart,
	ToolState,
	ToolStatePending,
	ToolStateRunning,
	ToolStateCompleted,
	ToolStateError,
	Permission,
	Event,
	GlobalEvent,
	EventMessageUpdated,
	EventMessageRemoved,
	EventMessagePartUpdated,
	EventMessagePartRemoved,
	EventSessionStatus,
	EventPermissionUpdated,
	EventPermissionReplied,
	EventSessionCreated,
	EventSessionUpdated,
	EventSessionDeleted,
	EventFileEdited,
	EventTodoUpdated,
	EventPtyCreated,
	EventPtyExited,
	EventPtyDeleted,
} from "@opencode-ai/sdk/client";

// Alias for backward compatibility during migration
export type { Session as SessionDetail } from "@opencode-ai/sdk/client";
```

**Step 2: Update session files to import from sdk-types**

Update each file to import `SessionStatus` and `Session` from `../instance/sdk-types.js` instead of `../instance/opencode-client.js`.

**Step 3: Run type check**

Run: `pnpm check`
Expected: Some failures where `SessionDetail` fields don't match `Session` fields — fix field access (e.g. `session.time?.created` instead of `session.createdAt`).

**Step 4: Fix field access mismatches**

Key differences:
- `SessionDetail.createdAt` → `Session.time.created`
- `SessionDetail.updatedAt` → `Session.time.updated`
- `SessionDetail.archived` → `Session.time.archived` (check SDK)
- `SessionDetail.slug` → not in SDK Session (relay-specific, keep if needed)

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: replace SessionDetail and SessionStatus with SDK types"
```

---

### Task 10: Replace Message and Part types

**Files to modify:**
- `src/lib/instance/opencode-client.ts:119-135` — `Message` type
- `src/lib/shared-types.ts` — `HistoryMessage`, `HistoryMessagePart`, `PartType`, `ToolStatus`
- All files importing these types (event-translator.ts, session-manager.ts, message-poller.ts, etc.)

The SDK uses discriminated unions: `Message = UserMessage | AssistantMessage`, `Part = TextPart | ToolPart | ReasoningPart | ...`.

**Step 1: Update imports in event-translator.ts**

This is the most complex file — it accesses part fields heavily. Replace `HistoryMessagePart` access patterns with SDK `Part` discriminated union access using type guards.

**Step 2: Update imports in message-poller.ts**

Replace `Message` references with SDK `Message` (which is `UserMessage | AssistantMessage`).

**Step 3: Update imports in session-manager.ts**

Replace `Message` references.

**Step 4: Update shared-types.ts**

Remove `HistoryMessage`, `HistoryMessagePart`, `PartType`, `ToolStatus` definitions. Keep relay-specific types.

**Step 5: Run type check iteratively**

Run: `pnpm check`
Fix errors one file at a time. The main change pattern is:
- `part.type === "tool"` → works (discriminated union)
- `part.state?.status` → `(part as ToolPart).state.status` (or type guard)
- `part.text` → `(part as TextPart).text` (or type guard)

**Step 6: Run tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace Message and Part types with SDK discriminated unions"
```

---

### Task 11: Replace OpenCodeEvent with SDK Event type

**Files to modify:**
- `src/lib/types.ts` — `BaseOpenCodeEvent`, `OpenCodeEvent`, `GlobalEvent`, `KnownOpenCodeEvent`
- `src/lib/relay/opencode-events.ts` — all typed event interfaces and type guards
- `src/lib/relay/sse-consumer.ts` — emits `OpenCodeEvent`
- `src/lib/relay/sse-wiring.ts` — receives `OpenCodeEvent`
- `src/lib/relay/sse-backoff.ts` — parses into `OpenCodeEvent`
- `src/lib/relay/event-translator.ts` — receives `OpenCodeEvent`

The SDK provides `Event` as a discriminated union of 20+ typed event variants (e.g. `EventMessagePartUpdated`, `EventSessionStatus`). This replaces the generic `{ type: string; properties: Record<string, unknown> }` pattern.

> **Audit fix #4 — SSE event type gap:** The SDK `Event` union does NOT cover all event types the SSE stream delivers. Three critical types are missing:
>
> | SSE event type | SDK equivalent | Status |
> |---|---|---|
> | `message.part.delta` | *(none)* | **Not in SDK** — used for real-time text streaming |
> | `permission.asked` | `permission.updated` | **Different name** — SDK uses `permission.updated` |
> | `question.asked` | *(none)* | **Not in SDK** — used for ask-user flow |
>
> **Strategy:** Create a superset type in `opencode-events.ts`:
> ```typescript
> // Events delivered by SSE but not in SDK Event union
> export interface PartDeltaEvent { type: "message.part.delta"; properties: { ... } }
> export interface PermissionAskedEvent { type: "permission.asked"; properties: { ... } }
> export interface QuestionAskedEvent { type: "question.asked"; properties: { ... } }
> export interface ServerHeartbeatEvent { type: "server.heartbeat"; properties?: Record<string, unknown> }
>
> export type SSEEvent = Event | PartDeltaEvent | PermissionAskedEvent | QuestionAskedEvent | ServerHeartbeatEvent;
> ```
> Use `SSEEvent` (not `Event`) in sse-wiring.ts, event-translator.ts, and sse-stream.ts. Keep the existing type guards for the unmapped types. Delete only the type guards whose events ARE in the SDK union.
>
> **Note (Audit v2 fix #5):** `server.heartbeat` is NOT in the SDK `Event` union despite being emitted by the OpenCode SSE stream. SSEStream explicitly handles it for health tracking. Adding it to the SSEEvent superset ensures type safety in `sse-stream.ts` where it checks `evt.type === "server.heartbeat"`.

**Step 1: Create SSEEvent superset type**

In `opencode-events.ts`, define the 4 missing event types and the `SSEEvent` union. Keep existing type guards for `message.part.delta`, `permission.asked`, `question.asked`, and `server.heartbeat`. Delete type guards for events now covered by SDK Event (e.g., `isPartUpdatedEvent`, `isSessionStatusEvent`, etc.).

**Step 2: Update sse-wiring.ts event handler**

Change `handleSSEEvent(event: OpenCodeEvent)` to `handleSSEEvent(event: SSEEvent)`. For events in the SDK union, use type narrowing: `if (event.type === "message.part.updated") { event.properties.part... }`. For the 3 gap events, use the existing type guards.

**Step 3: Update event-translator.ts**

Replace `OpenCodeEvent` parameter types with `SSEEvent`. The translator already switches on `event.type` — for SDK-covered types it gets full type narrowing. For `message.part.delta`, `permission.asked`, `question.asked`, keep the existing `properties: Record<string, unknown>` access pattern.

**Step 4: Clean up opencode-events.ts**

Delete type guards and interfaces for events now fully covered by SDK Event. Keep only the 3 gap event types + `SSEEvent` union + their type guards.

**Step 4: Update types.ts**

Remove `BaseOpenCodeEvent`, `OpenCodeEvent`, `GlobalEvent` — replaced by SDK equivalents.

**Step 5: Run type check and fix**

Run: `pnpm check`
Expected: Multiple errors — fix each by using SDK event type narrowing.

**Step 6: Run tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace OpenCodeEvent with SDK Event discriminated union"
```

---

### Task 12: Clean up remaining type references

**Files to modify:**
- `src/lib/shared-types.ts` — remove types now in SDK, keep relay-specific ones
- `src/lib/types.ts` — remove replaced types
- `src/lib/instance/opencode-client.ts` — remove type exports that are now in sdk-types.ts
- Any remaining files still importing old types

**Step 1: Audit remaining imports from old type sources**

Run: `grep -rn "from.*opencode-client" src/lib/ --include="*.ts" | grep -v node_modules`
Run: `grep -rn "from.*shared-types" src/lib/ --include="*.ts" | grep -v node_modules`

**Step 2: Remove unused type definitions**

From `shared-types.ts`, remove:
- `PartType` (replaced by `Part["type"]` discriminated union)
- `ToolStatus` (replaced by `ToolState["status"]`)
- `HistoryMessage`, `HistoryMessagePart` (replaced by SDK Message/Part)
- `SessionInfo` (replaced by SDK `Session`)

Keep: `RelayMessage`, `ToolName`, `Base16Theme`, `TodoItem`, `PtyInfo`, `FileEntry`, `ProviderInfo`, `ModelInfo`, `AgentInfo`, `CommandInfo`, and all relay-specific types.

**Step 3: Run type check and tests**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: clean up replaced type definitions from shared-types and types"
```

---

## Phase 4: SSE Migration

### Task 13: Create SSEStream class

**Files:**
- Create: `src/lib/relay/sse-stream.ts`
- Create: `test/unit/relay/sse-stream.test.ts`

Replaces `SSEConsumer` with an SDK-backed implementation that wraps `api.event.subscribe()`.

**Step 1: Write the failing tests**

```typescript
// test/unit/relay/sse-stream.test.ts
import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { SSEStream } from "../../../src/lib/relay/sse-stream.js";

function makeStubApi(events: Array<{ type: string; properties?: unknown }>) {
	return {
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {
					for (const e of events) {
						yield e;
					}
				})(),
			})),
		},
	} as any;
}

describe("SSEStream", () => {
	it("registers itself with ServiceRegistry", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		expect(registry.size).toBe(0);
		new SSEStream(registry, { api });
		expect(registry.size).toBe(1);
	});

	it("emits 'connected' when stream starts", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		// Connect and immediately disconnect after connected event
		stream.connect().catch(() => {});
		await connected;
		await stream.disconnect();
	});

	it("emits events from the SDK stream", async () => {
		const registry = new ServiceRegistry();
		const events = [
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
		];
		const api = makeStubApi(events);
		const stream = new SSEStream(registry, { api });

		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		stream.connect().catch(() => {});
		await connected;

		// Wait for events to propagate
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();

		expect(received).toHaveLength(2);
		expect(received[0]).toEqual(events[0]);
	});

	it("emits heartbeat for server.heartbeat events", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([{ type: "server.heartbeat" }]);
		const stream = new SSEStream(registry, { api });

		let heartbeatSeen = false;
		stream.on("heartbeat", () => { heartbeatSeen = true; });

		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});

		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();

		expect(heartbeatSeen).toBe(true);
	});

	it("reports health state", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const health = stream.getHealth();
		expect(health).toHaveProperty("connected");
		expect(health).toHaveProperty("lastEventAt");
		expect(health).toHaveProperty("reconnectCount");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/sse-stream.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

```typescript
// src/lib/relay/sse-stream.ts
// SSE consumer backed by @opencode-ai/sdk's event.subscribe().
// Replaces the manual SSE parser with SDK streaming + reconnection/health wrapper.

import type { ServiceRegistry } from "../daemon/service-registry.js";
import { TrackedService } from "../daemon/tracked-service.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ConnectionHealth } from "../types.js";
import {
	type BackoffConfig,
	calculateBackoffDelay,
	createHealthTracker,
	type HealthTracker,
} from "./sse-backoff.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEStreamOptions {
	api: { event: { subscribe(): Promise<{ stream: AsyncGenerator<unknown> }> } };
	backoff?: Partial<BackoffConfig>;
	staleThreshold?: number;
	log?: Logger;
}

export type SSEStreamEvents = {
	event: [unknown]; // SDK Event type — consumers cast as needed
	connected: [];
	disconnected: [Error | undefined];
	reconnecting: [{ attempt: number; delay: number }];
	error: [Error];
	heartbeat: [];
};

// ─── SSE Stream ──────────────────────────────────────────────────────────────

export class SSEStream extends TrackedService<SSEStreamEvents> {
	private readonly api: SSEStreamOptions["api"];
	private readonly backoffConfig: BackoffConfig;
	private readonly healthTracker: HealthTracker;
	private readonly log: Logger;

	private running = false;
	private abortController: AbortController | null = null;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(registry: ServiceRegistry, options: SSEStreamOptions) {
		super(registry);
		this.api = options.api;
		this.log = options.log ?? createSilentLogger();

		this.backoffConfig = {
			baseDelay: options.backoff?.baseDelay ?? 1000,
			maxDelay: options.backoff?.maxDelay ?? 30000,
			multiplier: options.backoff?.multiplier ?? 2,
		};

		this.healthTracker = createHealthTracker({
			staleThreshold: options.staleThreshold ?? 60_000,
		});
	}

	/** Start consuming SSE events via SDK. Does not throw — errors are emitted. */
	async connect(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.reconnectAttempt = 0;
		this.tracked(this.consumeLoop().catch((err) => {
			if (!this.running) return;
			const error = err instanceof Error ? err : new Error(String(err));
			this.emit("error", error);
		}));
	}

	/** Stop consuming and clean up */
	async disconnect(): Promise<void> {
		this.running = false;
		if (this.reconnectTimer) {
			this.clearTrackedTimer(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.healthTracker.onDisconnected();
	}

	/** Get connection health snapshot */
	getHealth(): ConnectionHealth & { stale: boolean } {
		return this.healthTracker.getHealth();
	}

	/** Check if actively connected and consuming */
	isConnected(): boolean {
		return this.running && this.healthTracker.getHealth().connected;
	}

	/** Kill stream and drain tracked work. */
	override async drain(): Promise<void> {
		await this.disconnect();
		await super.drain();
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async consumeLoop(): Promise<void> {
		while (this.running) {
			try {
				const { stream } = await this.api.event.subscribe();

				// Connected
				this.reconnectAttempt = 0;
				this.healthTracker.onConnected();
				this.emit("connected");

				for await (const event of stream) {
					if (!this.running) break;

					const evt = event as { type?: string; [key: string]: unknown };

					// Track health
					this.healthTracker.onEvent();

					// Handle heartbeat/connected events
					if (evt.type === "server.heartbeat" || evt.type === "server.connected") {
						this.emit("heartbeat");
						continue;
					}

					// Emit data event
					this.emit("event", event);
				}

				// Stream ended normally — reconnect if still running
				if (this.running) {
					this.healthTracker.onDisconnected();
					this.emit("disconnected", undefined);
				}
			} catch (err) {
				if (!this.running) return;

				const error = err instanceof Error ? err : new Error(String(err));
				if (error.name === "AbortError") return;

				this.healthTracker.onDisconnected();
				this.emit("disconnected", error);
				this.emit("error", error);
			}

			// Reconnect with backoff
			if (this.running) {
				const delay = calculateBackoffDelay(this.reconnectAttempt, this.backoffConfig);
				this.reconnectAttempt++;
				this.healthTracker.onReconnect();
				this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });

				await new Promise<void>((resolve) => {
					this.reconnectTimer = this.delayed(() => {
						this.reconnectTimer = null;
						resolve();
					}, delay);
				});
			}
		}
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/sse-stream.test.ts`
Expected: PASS

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/relay/sse-stream.ts test/unit/relay/sse-stream.test.ts
git commit -m "feat: add SSEStream backed by SDK event.subscribe() with reconnection"
```

---

### Task 14: Wire SSEStream into relay-stack and sse-wiring

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — replace `SSEConsumer` construction with `SSEStream`
- Modify: `src/lib/relay/sse-wiring.ts` — update event type from `OpenCodeEvent` to SDK `Event`

**Step 1: Update relay-stack.ts**

Replace `new SSEConsumer(registry, { baseUrl, authHeaders })` with `new SSEStream(registry, { api })`. Remove the `baseUrl`/`authHeaders` extraction from `OpenCodeClient`.

**Step 2: Update sse-wiring.ts**

Change the event handler to receive SDK `Event` type. Update field access from `event.properties.*` to direct property access on the typed event variants.

**Step 3: Run type check**

Run: `pnpm check`
Expected: Fix any remaining type mismatches in wiring code.

**Step 4: Run full test suite**

Run: `pnpm test:unit`
Expected: PASS — SSE wiring tests may need stub updates

**Step 5: Commit**

```bash
git add src/lib/relay/relay-stack.ts src/lib/relay/sse-wiring.ts
git commit -m "refactor: wire SSEStream into relay-stack replacing SSEConsumer"
```

---

## Phase 5: Cleanup

### Task 15: Delete OpenCodeClient and old SSE consumer

**Files:**
- Delete: `src/lib/instance/opencode-client.ts` (691 lines)
- Delete: `src/lib/relay/sse-consumer.ts` (284 lines)
- Possibly delete: `test/unit/relay/sse-consumer.test.ts` (if fully replaced by sse-stream tests)

**Step 1: Verify no remaining imports**

Run: `grep -rn "from.*opencode-client" src/ --include="*.ts" | grep -v node_modules`
Run: `grep -rn "from.*sse-consumer" src/ --include="*.ts" | grep -v node_modules`

Expected: Zero matches (or only test files)

**Step 2: Delete the files**

```bash
rm src/lib/instance/opencode-client.ts
rm src/lib/relay/sse-consumer.ts
```

**Step 3: Run type check and tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS — if any test files reference deleted modules, update or delete them.

**Step 4: Commit**

```bash
git add -A
git commit -m "cleanup: delete OpenCodeClient (691 lines) and SSEConsumer (284 lines)"
```

---

### Task 16: Clean up unused SSE utilities and type files

**Files to audit:**
- `src/lib/relay/sse-backoff.ts` — check if SSEStream still uses `calculateBackoffDelay`, `createHealthTracker`. Delete unused functions (`parseSSEData`, `parseSSEDataAuto`, `parseGlobalSSEData`, `isKnownEventType`, `classifyEventType`, `eventBelongsToSession`, `filterEventsBySession`, `getSessionIds`).
- `src/lib/relay/opencode-events.ts` — check if type guards are still used. If SDK Event union replaces all, delete.
- `src/lib/types.ts` — remove any remaining dead type exports.
- `src/lib/shared-types.ts` — final cleanup of replaced types.

**Step 1: Check what's still imported from sse-backoff.ts**

Run: `grep -rn "from.*sse-backoff" src/ --include="*.ts" | grep -v node_modules`

**Step 2: Delete unused exports**

Remove functions no longer needed. Keep `calculateBackoffDelay`, `createHealthTracker`, `BackoffConfig`, `HealthTracker` if still used by `SSEStream`.

**Step 3: Check opencode-events.ts**

Run: `grep -rn "from.*opencode-events" src/ --include="*.ts" | grep -v node_modules`

If no imports remain, delete the file.

**Step 4: Run type check, lint, and tests**

Run: `pnpm check && pnpm test:unit && pnpm lint`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "cleanup: remove unused SSE parsing utilities and dead type definitions"
```

---

### Task 17: Final verification and lint

**Step 1: Run full build**

Run: `pnpm build`
Expected: PASS — TypeScript compiles cleanly

**Step 2: Run all tests**

Run: `pnpm test`
Expected: PASS — all unit + fixture tests green

**Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS — no lint/format issues

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Review deleted line count**

Run: `git diff --stat main...HEAD` (or since the first commit of this plan)
Expected: Net reduction of ~800+ lines (691 from OpenCodeClient + 284 from SSEConsumer - new code)

**Step 6: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final verification — SDK migration complete"
```

---

## Summary

| Phase | Tasks | Key outcome |
|-------|-------|-------------|
| 1. Foundation | 1-4 | SDK dep, retryFetch, sdk-factory, gap-endpoints |
| 2. Client Swap | 5-7 | OpenCodeAPI adapter, relay-stack wiring, all callers migrated |
| 3. Type Migration | 8-12 | SDK types canonical, sdk-types.ts re-export bridge, shared-types gutted |
| 4. SSE Migration | 13-14 | SSEStream replaces SSEConsumer, wiring updated |
| 5. Cleanup | 15-17 | Delete old files, remove dead code, final verification |

**Total tasks:** 17
**Estimated net line change:** -800+ lines deleted (simpler codebase)
**Risk mitigation:** System works at every phase boundary. Each commit is independently revertable.
