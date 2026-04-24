# Effect.ts Migration Follow-Up Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Complete 5 workstreams missed or out-of-scope in the original Effect.ts migration: delete dead legacy dispatch code, add TransportLayer clarification, migrate sdk-factory to full Effect, convert errors to Schema.TaggedErrorClass, and migrate the full daemon lifecycle to Effect Layers.

**Architecture:** Bottom-up ordering (W1→W5→W3→W2→W4). Each workstream is independently shippable. All work happens in the existing worktree at `.worktrees/effect-ts-migration` on branch `feature/effect-ts-migration`.

**Tech Stack:** `effect` (v3.21.2, includes Schema), `@effect/platform`, `@effect/platform-node`, Vitest, pnpm

**Design doc:** `docs/plans/2026-04-24-effect-ts-migration-followup-design.md`

**Working directory:** `/Users/dstern/src/personal/conduit/.worktrees/effect-ts-migration`

---

## Task 1: Delete dead legacy dispatch code (W1)

**Files:**
- Modify: `src/lib/handlers/index.ts:160-231` (delete MESSAGE_HANDLERS + dispatchMessage)
- Modify: `test/unit/handlers/message-handlers.test.ts:3,36,1674-1756`
- Modify: `test/unit/server/ws-router.pbt.test.ts:20,443`

**Step 1: Delete legacy code and clean up handlers/index.ts**

Delete the `MESSAGE_HANDLERS` record (lines 160-209) and `dispatchMessage()` function (lines 215-231). These are replaced by `EFFECT_MESSAGE_HANDLERS` (lines 318-377) and `dispatchMessageEffect()` (lines 393-410). Also remove their exports.

Additionally clean up:
- **Dead imports (lines 88-110, 112-153):** These import handler functions (handleGetAgents, handleSwitchModel, etc.) used ONLY by the deleted `MESSAGE_HANDLERS` table. Delete them. **Keep** `import type { PayloadMap } from './payloads.js'` (line 111) — still used by `EFFECT_MESSAGE_HANDLERS` and `dispatchMessageEffect`.
- **Stale header comment (lines 1-7):** Remove references to `MESSAGE_HANDLERS` and "legacy dispatchMessage".
- **Stale JSDoc (lines 312-317):** Simplify the comment above `EFFECT_MESSAGE_HANDLERS` — remove the comparison to the deleted `MESSAGE_HANDLERS`.
- **Orphaned section comments (line 86, lines 155-158):** Remove the "Dispatch Table" divider and the trust-boundary comment — they served the deleted code.
- **Export `EFFECT_MESSAGE_HANDLERS`:** Add `export` to the `const EFFECT_MESSAGE_HANDLERS` definition (line 318) so tests can import it.

**Do NOT delete:**
- `EFFECT_MESSAGE_HANDLERS` — active production dispatch table
- `dispatchMessageEffect()` — active production dispatch function
- Any imports used only by the Effect versions

**Step 2: Update message-handlers.test.ts**

Remove the import of `dispatchMessage` (line 3) and `MESSAGE_HANDLERS` (line 36). Delete the test suite "dispatchMessage" (lines 1674-1693) and the test "dispatch table has entries..." (lines 1695-1756). These tested the deleted legacy dispatch path.

If remaining tests in the file reference `dispatchMessage` or `MESSAGE_HANDLERS`, update them to use `dispatchMessageEffect` or `EFFECT_MESSAGE_HANDLERS`.

**Step 3: Update ws-router.pbt.test.ts**

Remove the import of `MESSAGE_HANDLERS` (line 20). Update the test at line 443 that uses `Object.keys(MESSAGE_HANDLERS)` to use `EFFECT_MESSAGE_HANDLERS` instead — or delete the test if it only validated the legacy dispatch table completeness.

**Step 4: Run tests**

Run: `pnpm check && pnpm vitest run test/unit/handlers/message-handlers.test.ts test/unit/server/ws-router.pbt.test.ts`
Expected: All pass. No remaining references to deleted exports.

**Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/lib/handlers/index.ts test/unit/handlers/message-handlers.test.ts test/unit/server/ws-router.pbt.test.ts
git commit -m "chore: delete dead legacy MESSAGE_HANDLERS and dispatchMessage"
```

---

## Task 2: Add TransportLayer.empty clarifying comment (W5)

**Files:**
- Modify: `src/lib/frontend/transport/runtime.ts`

**Step 1: Replace existing comment**

Replace the existing comment on lines 20-21 (which references stale "Task 7.2" from a prior plan) with the following. Do NOT append — the old comment is outdated:

```typescript
// Frontend transport has no async service dependencies.
// ManagedRuntime is needed for fiber lifecycle (interrupt stream on reconnect).
// Extend if async services (logging, metrics) are added later.
```

**Step 2: Commit**

```bash
git add src/lib/frontend/transport/runtime.ts
git commit -m "docs: clarify TransportLayer.empty is intentional"
```

---

## Task 3: Fix Effect retry-fetch behavior gaps (W3)

**Files:**
- Modify: `src/lib/effect/retry-fetch.ts`
- Modify: `test/unit/effect/retry-fetch.test.ts`

**Step 1: Write failing tests for behavior gaps**

Add these tests to `test/unit/effect/retry-fetch.test.ts`:

```typescript
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
  // Linear: 100 + 200 = 300ms. Exponential would be 100 + 200 = 300ms too for 2 retries,
  // but at 3 retries linear=600 vs exponential=700. Test with 3 retries:
  // Actually just verify it's >= 250ms (100 + 200 - tolerance)
  expect(elapsed).toBeGreaterThanOrEqual(200);
});

it("accepts RequestInfo | URL input type", async () => {
  const url = new URL("http://localhost:0/test");
  const result = await Effect.runPromiseExit(fetchWithRetry(url));
  expect(Exit.isFailure(result)).toBe(true); // Connection refused expected
});

it("uses injected baseFetch when provided", async () => {
  let callCount = 0;
  const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
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
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/effect/retry-fetch.test.ts`
Expected: FAIL — `baseFetch` option doesn't exist, signature is `string` not `RequestInfo | URL`.

**Step 3: Fix retry-fetch implementation**

Replace `src/lib/effect/retry-fetch.ts`:

```typescript
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
		try: () => baseFetch(url, { ...init, signal: AbortSignal.timeout(timeout) }),
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
			const lastResponse = err.context?.lastResponse;
			if (lastResponse instanceof Response && lastResponse.status >= 500) {
				return Effect.succeed(lastResponse);
			}
			return Effect.fail(err);
		}),
	);
};
```

Key changes from original:
- `Schedule.exponential` → `Schedule.linear` (matches old linear backoff: delay*1, delay*2, delay*3)
- `url: string` → `url: RequestInfo | URL` (matches old signature)
- Added `baseFetch` option (defaults to `globalThis.fetch`, matches old `baseFetch` injection)

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/effect/retry-fetch.test.ts`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/lib/effect/retry-fetch.ts test/unit/effect/retry-fetch.test.ts
git commit -m "fix: align Effect retry-fetch with legacy behavior (linear backoff, baseFetch, URL types)"
```

---

## Task 4: Convert sdk-factory to Effect (W3)

**Files:**
- Modify: `src/lib/instance/sdk-factory.ts`
- Modify: `src/lib/relay/relay-stack.ts`
- Delete: `src/lib/instance/retry-fetch.ts`
- Delete: `test/unit/instance/retry-fetch.test.ts`
- Test: `test/unit/effect/sdk-factory.test.ts`
- Verify: `test/unit/instance/sdk-factory.test.ts` (existing — must still pass with compat wrapper)

**Step 1: Write the failing test**

Create `test/unit/effect/sdk-factory.test.ts`:

```typescript
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { createSdkClientEffect, type SdkFactoryOptions } from "../../../src/lib/instance/sdk-factory.js";

describe("Effect-based SDK factory", () => {
  it("returns SdkFactoryResult on success", async () => {
    const options: SdkFactoryOptions = {
      baseUrl: "http://localhost:12345",
    };
    // This will succeed (client creation is synchronous — only fetch is deferred)
    const result = await Effect.runPromiseExit(createSdkClientEffect(options));
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.client).toBeDefined();
      expect(result.value.fetch).toBeInstanceOf(Function);
      expect(result.value.authHeaders).toBeDefined();
    }
  });

  it("includes auth headers when credentials provided", async () => {
    const options: SdkFactoryOptions = {
      baseUrl: "http://localhost:12345",
      auth: { username: "user", password: "pass" },
    };
    const result = await Effect.runPromiseExit(createSdkClientEffect(options));
    expect(Exit.isSuccess(result)).toBe(true);
    if (Exit.isSuccess(result)) {
      expect(result.value.authHeaders["Authorization"]).toMatch(/^Basic /);
    }
  });

  it("legacy createSdkClient still works for daemon compat", async () => {
    // Compat wrapper should work synchronously
    const { createSdkClient } = await import("../../../src/lib/instance/sdk-factory.js");
    const result = createSdkClient({ baseUrl: "http://localhost:12345" });
    expect(result.client).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/effect/sdk-factory.test.ts`
Expected: FAIL — `createSdkClientEffect` does not exist.

**Step 3: Convert sdk-factory.ts to Effect**

Rewrite `src/lib/instance/sdk-factory.ts`:

```typescript
import {
	createOpencodeClient,
	type OpencodeClient,
} from "@opencode-ai/sdk/client";
import { Effect } from "effect";
import { fetchWithRetry, type RetryFetchOptions } from "../effect/retry-fetch.js";
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
 * Effect-based SDK client factory.
 * Creates an authenticated OpencodeClient with Effect-based retry fetch.
 */
export const createSdkClientEffect = (
	options: SdkFactoryOptions,
): Effect.Effect<SdkFactoryResult> =>
	Effect.sync(() => {
		// Build the fetch function: user-provided, or Effect retry-fetch wrapped as Promise
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

		// Auth strategy:
		// - SDK calls _fetch(request) with ONE arg — Request already has auth from config.headers
		// - GapEndpoints call fetch(url, init) with TWO args — add auth manually
		const authFetch: typeof fetch = authValue
			? async (input, init) => {
					if (input instanceof Request && !init) {
						return baseFetch(input);
					}
					const headers = new Headers(init?.headers);
					headers.set("Authorization", authValue);
					return baseFetch(input, { ...init, headers });
				}
			: baseFetch;

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
	});

/**
 * Legacy synchronous wrapper — used by daemon.ts until W4 daemon migration.
 * Delete this function in Task 14 (daemon migration cleanup).
 */
export function createSdkClient(options: SdkFactoryOptions): SdkFactoryResult {
	return Effect.runSync(createSdkClientEffect(options));
}
```

**Step 4: Update relay-stack.ts import**

In `src/lib/relay/relay-stack.ts`, update the import (line 25):

```typescript
// Old:
import { createSdkClient } from "../instance/sdk-factory.js";
// New:
import { createSdkClientEffect } from "../instance/sdk-factory.js";
```

Find where `createSdkClient` is called in relay-stack.ts and replace with `createSdkClientEffect`. Since relay-stack already uses Effect (line 12 imports Effect), wrap the call site:

```typescript
// Old: const { client, fetch: authedFetch, authHeaders } = createSdkClient(sdkOptions);
// New:
const { client, fetch: authedFetch, authHeaders } = Effect.runSync(createSdkClientEffect(sdkOptions));
```

Note: `Effect.runSync` is used here because `createSdkClientEffect` wraps `Effect.sync` (pure computation, no async). In W4, this becomes `yield*` inside the daemon's Effect pipeline.

**Step 5: Delete old retry-fetch.ts and its test**

```bash
rm src/lib/instance/retry-fetch.ts
rm test/unit/instance/retry-fetch.test.ts
```

The old test's behavior is now covered by `test/unit/effect/retry-fetch.test.ts` from Task 3.

Verify no remaining imports:

Run: `grep -rn "from.*instance/retry-fetch" src/ test/`
Expected: No matches (sdk-factory.ts now imports from `../effect/retry-fetch.js`).

**Step 6: Run tests**

Run: `pnpm vitest run test/unit/effect/sdk-factory.test.ts && pnpm vitest run test/unit/effect/retry-fetch.test.ts && pnpm vitest run test/unit/instance/sdk-factory.test.ts`
Expected: All pass. The existing sdk-factory.test.ts must still pass with the compat wrapper.

**Step 7: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 8: Commit**

```bash
git add src/lib/instance/sdk-factory.ts src/lib/relay/relay-stack.ts test/unit/effect/sdk-factory.test.ts
git rm src/lib/instance/retry-fetch.ts test/unit/instance/retry-fetch.test.ts
git commit -m "refactor: convert sdk-factory to Effect, delete old retry-fetch"
```

---

## Task 5: Convert relay errors to Schema.TaggedErrorClass (W2)

**Files:**
- Modify: `src/lib/errors.ts:52-337` (RelayError base + 6 subclasses)
- Test: `test/unit/schema/errors.test.ts`

**Step 1: Write failing tests**

Update `test/unit/schema/errors.test.ts` — add tests that verify Schema.TaggedErrorClass behavior:

```typescript
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  OpenCodeApiError,
  OpenCodeConnectionError,
  SSEConnectionError,
  WebSocketError,
  AuthenticationError,
  ConfigurationError,
} from "../../../src/lib/errors.js";

describe("Schema.TaggedErrorClass errors", () => {
  it("OpenCodeApiError._tag is automatic from class name", () => {
    const err = new OpenCodeApiError({
      message: "Not found",
      endpoint: "/api/test",
      responseStatus: 404,
      responseBody: { detail: "missing" },
    });
    expect(err._tag).toBe("OpenCodeApiError");
  });

  it("OpenCodeApiError is an instance of Error", () => {
    const err = new OpenCodeApiError({
      message: "test",
      endpoint: "/test",
      responseStatus: 500,
      responseBody: null,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("test");
  });

  it("OpenCodeApiError.code returns _tag for wire compat", () => {
    const err = new OpenCodeApiError({
      message: "test",
      endpoint: "/test",
      responseStatus: 500,
      responseBody: null,
    });
    expect(err.code).toBe("OpenCodeApiError");
  });

  it("OpenCodeApiError serializes to JSON", () => {
    const err = new OpenCodeApiError({
      message: "Server error",
      endpoint: "/api/test",
      responseStatus: 500,
      responseBody: null,
      userVisible: true,
    });
    const json = err.toJSON();
    expect(json.error.code).toBe("OpenCodeApiError");
    expect(json.error.message).toBe("Server error");
  });

  it("OpenCodeApiError serializes to WebSocket", () => {
    const err = new OpenCodeApiError({
      message: "Timeout",
      endpoint: "/api/slow",
      responseStatus: 504,
      responseBody: null,
    });
    const ws = err.toWebSocket();
    expect(ws.type).toBe("error");
    expect(ws.code).toBe("OpenCodeApiError");
  });

  it("OpenCodeConnectionError has statusCode 502", () => {
    const err = new OpenCodeConnectionError({ message: "refused" });
    expect(err.statusCode).toBe(502);
  });

  it("userVisible defaults to false", () => {
    const err = new OpenCodeConnectionError({ message: "test" });
    expect(err.userVisible).toBe(false);
  });

  it("userVisible true when set", () => {
    const err = new OpenCodeConnectionError({ message: "test", userVisible: true });
    expect(err.userVisible).toBe(true);
  });

  it("toMessage wraps with sessionId", () => {
    const err = new OpenCodeConnectionError({ message: "test" });
    const msg = err.toMessage("s1");
    expect(msg.sessionId).toBe("s1");
    expect(msg.type).toBe("error");
  });

  it("toSystemError returns system_error type", () => {
    const err = new OpenCodeConnectionError({ message: "test" });
    const sys = err.toSystemError();
    expect(sys.type).toBe("system_error");
  });

  it("fromCaught wraps unknown errors", () => {
    const err = fromCaught(new TypeError("oops"), "INTERNAL_ERROR");
    expect(err._tag).toBeDefined();
    expect(err.message).toContain("oops");
  });

  it("wrapError preserves cause chain", () => {
    const cause = new Error("root cause");
    const wrapped = wrapError(cause, OpenCodeConnectionError);
    expect(wrapped.message).toBe("root cause");
  });
});
```

Also import `fromCaught` and `wrapError` in the test.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/schema/errors.test.ts`
Expected: FAIL — `.code` returns `"OPENCODE_API_ERROR"` not `"OpenCodeApiError"`, no Schema.TaggedErrorClass.

**Step 3: Implement Schema.TaggedErrorClass errors**

Rewrite `src/lib/errors.ts`. Key pattern:

```typescript
import { Schema } from "effect";

// ─── Error Codes (kept for backwards compat) ────────────────────────────────
// ErrorCode type is now derived from _tag values
export type ErrorCode = string;

// ─── Shared fields ──────────────────────────────────────────────────────────
const RelayErrorFields = {
  message: Schema.String,
  userVisible: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  context: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) },
  ),
  // cause MUST be in the schema — Schema.TaggedError validates props through
  // the schema before passing to super(). Unlisted fields are stripped.
  // Without this, Error.cause is always undefined.
  cause: Schema.optionalWith(Schema.Unknown, { default: () => undefined }),
};

// ─── Transport serialization ────────────────────────────────────────────────
// Methods are inlined on each error class (no mixin — Schema.TaggedError
// classes cannot use a shared base class). Each class defines:
//   get code(), toJSON(), toWebSocket(), toMessage(), toSystemError(), toLog()

// ─── Error subclasses ───────────────────────────────────────────────────────

export class OpenCodeConnectionError extends Schema.TaggedError<OpenCodeConnectionError>()(
  "OpenCodeConnectionError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 502; }
  get code() { return this._tag; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, ...redactSensitive(this.context) }; }
}

export class OpenCodeApiError extends Schema.TaggedError<OpenCodeApiError>()(
  "OpenCodeApiError",
  {
    ...RelayErrorFields,
    endpoint: Schema.String,
    responseStatus: Schema.Number,
    responseBody: Schema.Unknown,
  },
) {
  get statusCode() { return this.responseStatus >= 400 ? this.responseStatus : 502; }
  get code() { return this._tag; }
  toJSON() {
    return {
      error: {
        code: this._tag,
        message: this.message,
        details: { endpoint: this.endpoint, status: this.responseStatus },
      },
    };
  }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, endpoint: this.endpoint, status: this.responseStatus, ...redactSensitive(this.context) }; }
}

export class SSEConnectionError extends Schema.TaggedError<SSEConnectionError>()(
  "SSEConnectionError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 502; }
  get code() { return this._tag; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, ...redactSensitive(this.context) }; }
}

export class WebSocketError extends Schema.TaggedError<WebSocketError>()(
  "WebSocketError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 400; }
  get code() { return this._tag; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, ...redactSensitive(this.context) }; }
}

export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
  "AuthenticationError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 401; }
  get code() { return this._tag; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, ...redactSensitive(this.context) }; }
}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 500; }
  get code() { return this._tag; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
  toMessage(sessionId: string) { return { ...this.toWebSocket(), sessionId }; }
  toSystemError() { return { ...this.toWebSocket(), type: "system_error" as const }; }
  toLog() { return { error: this._tag, message: this.message, ...redactSensitive(this.context) }; }
}

// ─── Union type ─────────────────────────────────────────────────────────────
export type RelayError =
  | OpenCodeConnectionError
  | OpenCodeApiError
  | SSEConnectionError
  | WebSocketError
  | AuthenticationError
  | ConfigurationError;

// ─── Utilities ──────────────────────────────────────────────────────────────

export function fromCaught(err: unknown, code: string, prefix?: string): RelayError {
  const message = err instanceof Error ? err.message : String(err);
  const fullMessage = prefix ? `${prefix}: ${message}` : message;
  return new OpenCodeConnectionError({
    message: fullMessage,
    cause: err instanceof Error ? err : undefined,
  });
}

export function wrapError<E extends new (props: { message: string; context?: Record<string, unknown> }) => RelayError>(
  error: unknown,
  ErrorClass: E,
  context?: Record<string, unknown>,
): InstanceType<E> {
  if (error instanceof Error) {
    return new ErrorClass({ message: error.message, context }) as InstanceType<E>;
  }
  return new ErrorClass({ message: String(error), context }) as InstanceType<E>;
}

export { redactSensitive, formatErrorDetail } from "./errors-utils.js";
```

**Important:** Verify the correct Effect 3.x API name — `Schema.TaggedError` vs `Schema.TaggedErrorClass`. Check with `import { Schema } from "effect"; console.log(typeof Schema.TaggedError)` in a test. The `cause` field should NOT be in the Schema fields — it comes from `Error` base class. Remove `cause` from `RelayErrorFields` and pass it via the constructor's second arg or via `{ cause }` option to `super()`.

**Step 4: Update construction sites**

The constructor signature stays the same (single props object) — most sites need no change. The key change is that `RelayError` is no longer a class, so:

1. **Replace `RelayError.fromCaught(err, code)` → `fromCaught(err, code)`.** Search: `grep -rn "RelayError.fromCaught" src/` — update all sites. **Critical: `fromCaught` must preserve the `code` parameter to map to appropriate error subclasses.** The plan's `fromCaught` implementation always creates `OpenCodeConnectionError` — this is WRONG. It must map `code` to the appropriate error class. Implementation:

```typescript
const CODE_TO_CLASS: Record<string, new (props: { message: string }) => RelayError> = {
  OPENCODE_UNREACHABLE: OpenCodeConnectionError,
  SSE_DISCONNECTED: SSEConnectionError,
  WEBSOCKET_ERROR: WebSocketError,
  AUTH_FAILED: AuthenticationError,
  CONFIG_INVALID: ConfigurationError,
};

export function fromCaught(err: unknown, code: string, prefix?: string): RelayError {
  const message = err instanceof Error ? err.message : String(err);
  const fullMessage = prefix ? `${prefix}: ${message}` : message;
  const ErrorClass = CODE_TO_CLASS[code] ?? OpenCodeConnectionError;
  return new ErrorClass({
    message: fullMessage,
    context: { originalCode: code },
    cause: err instanceof Error ? err : undefined,
  });
}
```

For codes like `"INIT_FAILED"`, `"HANDLER_ERROR"`, `"INTERNAL_ERROR"` that don't map to a specific subclass, `OpenCodeConnectionError` is the fallback. The `.code` getter returns the `_tag` name, NOT the original code string. The original code is preserved in `error.context.originalCode` for debugging/logging. Downstream assertions checking `code === "INIT_FAILED"` must be updated to check `code === "OpenCodeConnectionError"` (or use `_tag` directly). If tests need the original code, check `error.context.originalCode`.

2. Remove any `instanceof RelayError` checks. Search: `grep -rn "instanceof RelayError" src/ test/` — update to `_tag` checks or type guards.

3. **Wire format change:** The `code` property now returns `_tag` (e.g., `"OpenCodeApiError"` instead of `"OPENCODE_API_ERROR"`). Search `grep -rn "\.code ===" src/ test/` — update assertions. Check Svelte frontend stores (`grep -rn "\.code" src/lib/frontend/`) for any string comparisons against old error codes. Based on audit, production src/ has no RelayError `.code` checks — only Node.js `ENOENT`/`EADDRINUSE` checks exist. But test files DO check `.code` values (see Task 7).

**Step 5: Run tests**

Run: `pnpm vitest run test/unit/schema/errors.test.ts && pnpm vitest run test/unit/errors.pbt.test.ts`
Expected: Both pass.

**Step 6: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/lib/errors.ts test/unit/schema/errors.test.ts test/unit/errors.pbt.test.ts
git commit -m "refactor: convert relay errors to Schema.TaggedError"
```

---

## Task 6: Convert PersistenceError to Schema.TaggedError (W2)

**Files:**
- Modify: `src/lib/persistence/errors.ts:22-46`
- Modify: `test/unit/schema/errors.test.ts` (add PersistenceError tests)

**Step 1: Add failing tests**

Add to `test/unit/schema/errors.test.ts`:

```typescript
import { PersistenceError } from "../../../src/lib/persistence/errors.js";

it("PersistenceError._tag is PersistenceError", () => {
  const err = new PersistenceError({
    message: "Write failed",
    code: "WRITE_FAILED",
  });
  expect(err._tag).toBe("PersistenceError");
  expect(err.code).toBe("WRITE_FAILED");
});

it("PersistenceError message includes code prefix", () => {
  const err = new PersistenceError({
    message: "disk full",
    code: "APPEND_FAILED",
  });
  expect(err.message).toContain("disk full");
});

it("PersistenceError.toLog returns structured output", () => {
  const err = new PersistenceError({
    message: "test",
    code: "MIGRATION_FAILED",
    context: { table: "events" },
  });
  const log = err.toLog();
  expect(log.error).toBe("PersistenceError");
  expect(log.code).toBe("MIGRATION_FAILED");
});
```

**Step 2: Implement**

Rewrite `src/lib/persistence/errors.ts`:

```typescript
import { Schema } from "effect";

export const PERSISTENCE_ERROR_CODES = [
  "UNKNOWN_EVENT_TYPE",
  "INVALID_RECEIPT_STATUS",
  "APPEND_FAILED",
  "PROJECTION_FAILED",
  "MIGRATION_FAILED",
  "SCHEMA_VALIDATION_FAILED",
  "CURSOR_MISMATCH",
  "DESERIALIZATION_FAILED",
  "SESSION_SEED_FAILED",
  "DUAL_WRITE_FAILED",
  "WRITE_FAILED",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export class PersistenceError extends Schema.TaggedError<PersistenceError>()(
  "PersistenceError",
  {
    message: Schema.String,
    code: Schema.Literal(...PERSISTENCE_ERROR_CODES),
    context: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      { default: () => ({}) },
    ),
  },
) {
  toLog() {
    return {
      error: this._tag,
      code: this.code,
      message: this.message,
      ...this.context,
    };
  }
}
```

**Behavioral note:** The current `PersistenceError` constructor prepends `[CODE]` to the message (e.g., `[APPEND_FAILED] disk full`). The `Schema.TaggedError` version stores the raw message without prefix. This is intentional — the `code` field is available separately via `err.code` and `err.toLog()` includes both. Update any log parsers or alerts that match on `[CODE]` prefix patterns.

**Step 3: Update construction sites (~23 sites)**

PersistenceError constructor already takes `{ code, message, context }` props object — no changes needed at construction sites. Verify with:

Run: `grep -rn "new PersistenceError(" src/lib/persistence/`

Each site should already use the object pattern. If any use positional args, update them.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/schema/errors.test.ts && pnpm vitest run test/unit/persistence/`
Expected: All pass.

**Step 5: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/lib/persistence/errors.ts test/unit/schema/errors.test.ts
git commit -m "refactor: convert PersistenceError to Schema.TaggedError"
```

---

## Task 7: Update PBT and remaining error tests (W2)

**Files:**
- Modify: `test/unit/errors.pbt.test.ts`
- Modify: any test files that reference `RelayError` as a class, `instanceof RelayError`, or old `.code` string constants

**Step 1: Update PBT tests**

In `test/unit/errors.pbt.test.ts`:

1. Remove `instanceof RelayError` checks — replace with `_tag` string membership check
2. Update `errorSubclasses` array (lines 96-102) if constructor shapes changed
3. Update any `.code` assertions to match new `_tag`-derived values (e.g., `"OPENCODE_UNREACHABLE"` → `"OpenCodeConnectionError"`)
4. Remove `RelayError` from imports if it's no longer a class

**Step 2: Search for remaining test references**

Run: `grep -rn "instanceof RelayError\|RelayError.fromCaught\|\.code === " test/`

Update each match:
- `instanceof RelayError` → type guard using `_tag` property
- `RelayError.fromCaught` → `fromCaught` (standalone import)
- `.code === "OLD_VALUE"` → `.code === "NewClassName"` (if any exist)

**Critical: Update INIT_FAILED assertions in client-init.test.ts.** Lines 184, 239, 268, 336, 788 assert `code === "INIT_FAILED"`. After Task 5, `fromCaught(err, "INIT_FAILED")` produces `OpenCodeConnectionError` with `code === "OpenCodeConnectionError"`. Update all these assertions to check for `"OpenCodeConnectionError"` instead of `"INIT_FAILED"`. Search with: `grep -rn "INIT_FAILED\|HANDLER_ERROR\|INTERNAL_ERROR" test/` to find ALL test sites using codes that map to the fallback.

**Step 3: Run all error-related tests**

Run: `pnpm vitest run test/unit/schema/errors.test.ts test/unit/errors.pbt.test.ts test/unit/provider/relay-event-sink.test.ts test/unit/bridges/client-init.test.ts`
Expected: All pass.

**Step 4: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 5: Commit**

```bash
git add test/
git commit -m "test: update error tests for Schema.TaggedError migration"
```

---

## Task 8: Create daemon Context.Tags and SignalHandlerLayer (W4)

**Files:**
- Modify: `src/lib/effect/services.ts` (add daemon-lifecycle Tags)
- Create: `src/lib/effect/daemon-layers.ts`
- Test: `test/unit/effect/daemon-layers.test.ts`

**Step 1: Write the failing test**

Create `test/unit/effect/daemon-layers.test.ts`:

```typescript
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { SignalHandlerLayer, ProcessErrorHandlerLayer } from "../../../src/lib/effect/daemon-layers.js";
import { ShutdownSignalTag } from "../../../src/lib/effect/services.js";

describe("SignalHandlerLayer", () => {
  it("installs signal handlers on layer build", async () => {
    const beforeCount = process.listenerCount("SIGTERM");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const layer = SignalHandlerLayer;
        const scope = yield* Scope.make();
        const ctx = yield* Layer.buildWithScope(layer, scope);
        const newCount = process.listenerCount("SIGTERM");
        expect(newCount).toBe(beforeCount + 1);
        yield* Scope.close(scope, Exit.void);
      }),
    );
    await Effect.runPromise(program);
    // After scope close, listener should be removed
    expect(process.listenerCount("SIGTERM")).toBe(beforeCount);
  });

  it("deferred completes when shutdown signal fires", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* ShutdownSignalTag.pipe(
          Effect.provide(SignalHandlerLayer),
        );
        // Deferred should not be done yet
        const isDone = yield* Deferred.isDone(deferred);
        expect(isDone).toBe(false);
      }),
    );
    await Effect.runPromise(program);
  });
});

describe("ProcessErrorHandlerLayer", () => {
  it("attaches and removes error handlers on scope lifecycle", async () => {
    const beforeCount = process.listenerCount("unhandledRejection");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(ProcessErrorHandlerLayer, scope);
        expect(process.listenerCount("unhandledRejection")).toBe(beforeCount + 1);
        yield* Scope.close(scope, Exit.void);
      }),
    );
    await Effect.runPromise(program);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeCount);
  });
});
```

**Step 2: Add daemon Tags to services.ts**

Add to `src/lib/effect/services.ts`:

```typescript
import { Deferred } from "effect";

// ─── Daemon lifecycle Tags ─────────────────────────────────────────────────

/** Shutdown signal — Deferred that completes when SIGTERM/SIGINT received.
 *  Consumer awaits with `yield* shutdownSignal` to block until signal fires. */
export class ShutdownSignalTag extends Context.Tag("ShutdownSignal")<
  ShutdownSignalTag,
  Deferred.Deferred<void>
>() {}
```

**Note:** `DaemonConfigTag` already exists in `src/lib/daemon/config-persistence.ts:100-103` with a `ServerConfigLive` Layer. Do NOT create a duplicate. Import from there if needed.

**Step 3: Create daemon-layers.ts**

Create `src/lib/effect/daemon-layers.ts`:

```typescript
import { Deferred, Effect, Layer } from "effect";
import { ShutdownSignalTag } from "./services.js";

/**
 * Installs SIGTERM/SIGINT handlers. Completes a Deferred on signal.
 * Finalizer removes handlers to prevent leaks in tests.
 * Also installs SIGHUP handler (placeholder for config reload).
 */
export const SignalHandlerLayer = Layer.scoped(
  ShutdownSignalTag,
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<void>();

    const onShutdown = () => {
      Deferred.unsafeDone(deferred, Effect.void);
    };
    const onReload = () => {
      // SIGHUP — config reload placeholder (matches existing signal-handlers.ts behavior)
    };

    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);
    process.on("SIGHUP", onReload);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.removeListener("SIGTERM", onShutdown);
        process.removeListener("SIGINT", onShutdown);
        process.removeListener("SIGHUP", onReload);
      }),
    );

    return deferred;
  }),
);

/**
 * Attaches unhandledRejection/uncaughtException handlers.
 * Finalizer removes them to prevent listener leaks.
 */
export const ProcessErrorHandlerLayer = Layer.scopedDiscard(
  Effect.gen(function* () {
    const onUnhandled = (reason: unknown) => {
      console.error("[daemon] Unhandled rejection:", reason);
    };
    const onUncaught = (err: Error) => {
      console.error("[daemon] Uncaught exception:", err);
    };

    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.removeListener("unhandledRejection", onUnhandled);
        process.removeListener("uncaughtException", onUncaught);
      }),
    );
  }),
);
```

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/effect/daemon-layers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/effect/services.ts src/lib/effect/daemon-layers.ts test/unit/effect/daemon-layers.test.ts
git commit -m "feat: add SignalHandlerLayer and ProcessErrorHandlerLayer"
```

---

## Task 9: Migrate leaf Drainable services to Effect Layers (W4)

**Files:**
- Modify: `src/lib/daemon/keep-awake.ts`
- Modify: `src/lib/daemon/version-check.ts`
- Modify: `src/lib/daemon/storage-monitor.ts`
- Modify: `src/lib/daemon/port-scanner.ts`
- Modify: `src/lib/relay/session-overrides.ts` (SessionOverrides — simple timer-based drain)
- Modify: `src/lib/effect/daemon-layers.ts` (add Layer definitions)
- Modify: `src/lib/effect/services.ts` (add Tags)
- Test: existing tests for each service (verify still pass)

These 5 services use callback patterns (not EventEmitter) and have simple drain() methods. They are the lowest-risk migration targets.

**Note:** `RelayTimers` also implements `Drainable` but has no instantiation sites in `src/` (test-only or dormant). Check with `grep -rn "new RelayTimers" src/` — if zero matches, remove `implements Drainable` from it inline during this task. If it IS instantiated somewhere, add it to the migration list.

**Pattern for each service:**

1. Remove `implements Drainable` and `ServiceRegistry` from constructor
2. Replace constructor `registry.register(this)` with nothing (Layer handles lifecycle)
3. Keep all internal logic unchanged
4. Add `static layer(...)` factory method or standalone `make*Live` function that returns `Layer.scoped`
5. Move `drain()` logic to `Effect.addFinalizer()`

**Step 1: Add Tags to services.ts**

```typescript
export class KeepAwakeTag extends Context.Tag("KeepAwake")<KeepAwakeTag, KeepAwake>() {}
export class VersionCheckerTag extends Context.Tag("VersionChecker")<VersionCheckerTag, VersionChecker>() {}
export class StorageMonitorTag extends Context.Tag("StorageMonitor")<StorageMonitorTag, StorageMonitor>() {}
export class PortScannerTag extends Context.Tag("PortScanner")<PortScannerTag, PortScanner>() {}
export class SessionOverridesTag extends Context.Tag("SessionOverrides")<SessionOverridesTag, SessionOverrides>() {}
```

**Step 2: Migrate KeepAwake (template for others)**

In `src/lib/daemon/keep-awake.ts`:

1. Remove `import type { Drainable, ServiceRegistry } from "./service-registry.js"`
2. Change class declaration: remove `implements Drainable`
3. Change constructor: remove `registry: ServiceRegistry` parameter and `registry.register(this)` call
4. Keep `drain()` as a public method (called by finalizer)

In `src/lib/effect/daemon-layers.ts`, add Layer factories for all 4 services. Each Layer must:
1. Create the instance
2. Call `start()` or `activate()` to begin periodic work
3. Add a finalizer that calls `instance.drain()` (NOT inlined — PortScanner.drain() sets an internal `drained` flag that suppresses callbacks)

```typescript
import { KeepAwake, type KeepAwakeOptions } from "../daemon/keep-awake.js";
import { VersionChecker, type VersionCheckOptions } from "../daemon/version-check.js";
import { StorageMonitor, type StorageMonitorOptions } from "../daemon/storage-monitor.js";
import { PortScanner, type PortScannerConfig } from "../daemon/port-scanner.js";
import { KeepAwakeTag, VersionCheckerTag, StorageMonitorTag, PortScannerTag } from "./services.js";

export const makeKeepAwakeLive = (options?: KeepAwakeOptions) =>
  Layer.scoped(
    KeepAwakeTag,
    Effect.gen(function* () {
      const instance = new KeepAwake(options);
      instance.activate();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => instance.drain()),
      );
      return instance;
    }),
  );

export const makeVersionCheckerLive = (options?: VersionCheckOptions) =>
  Layer.scoped(
    VersionCheckerTag,
    Effect.gen(function* () {
      const instance = new VersionChecker(options);
      instance.start();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => instance.drain()),
      );
      return instance;
    }),
  );

export const makeStorageMonitorLive = (options: StorageMonitorOptions) =>
  Layer.scoped(
    StorageMonitorTag,
    Effect.gen(function* () {
      const instance = new StorageMonitor(options);
      instance.start();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => instance.drain()),
      );
      return instance;
    }),
  );

export const makePortScannerLive = (config: PortScannerConfig, probeFn: (port: number) => Promise<boolean>) =>
  Layer.scoped(
    PortScannerTag,
    Effect.gen(function* () {
      const instance = new PortScanner(config, probeFn);
      instance.start();
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => instance.drain()),
      );
      return instance;
    }),
  );
```

**Step 3: Apply constructor changes to all 4 services**

For each service class:
1. Remove `Drainable`/`ServiceRegistry` from imports, constructor, and `implements`
2. Remove `registry: ServiceRegistry` as first constructor parameter
3. Remove `registry.register(this)` from constructor body
4. Keep `drain()` as a public method (called by Layer finalizer)

**Constructor signature changes:**
- `KeepAwake(registry, options?)` → `KeepAwake(options?)`
- `VersionChecker(registry, options?)` → `VersionChecker(options?)`
- `StorageMonitor(registry, options)` → `StorageMonitor(options)`
- `PortScanner(registry, config, probeFn)` → `PortScanner(config, probeFn)`
- `SessionOverrides(registry)` → `SessionOverrides()` (instantiated in relay-stack.ts:226)

**Step 4: Update daemon.ts construction sites**

In `src/lib/daemon/daemon.ts`, update ALL construction sites:
- Line ~744: `new PortScanner(this.serviceRegistry, config, probeFn)` → `new PortScanner(config, probeFn)`
- Line ~894: `new VersionChecker(this.serviceRegistry, options)` → `new VersionChecker(options)`
- Line ~907: `new KeepAwake(this.serviceRegistry, options)` → `new KeepAwake(options)`
- Line ~919: `new StorageMonitor(this.serviceRegistry, options)` → `new StorageMonitor(options)`
- **Line ~1674:** `new KeepAwake(this.serviceRegistry, {...})` in `setKeepAwakeCommand` IPC handler — also remove `this.serviceRegistry` arg.

**Step 4a: Add bridge drain calls to daemon.ts stop()**

Until Task 12 wires DaemonLive, these 4 services are no longer registered with ServiceRegistry but are also not yet managed by Effect Layers. Add explicit drain calls in `stop()` BEFORE `serviceRegistry.drainAll()`:

```typescript
// Bridge: manual drain for services removed from registry (Tasks 9→12)
await this.keepAwakeManager?.drain();
await this.versionChecker?.drain();
await this.storageMonitor?.drain();
await this.scanner?.drain();
// Then drain remaining registry services
await this.serviceRegistry.drainAll();
```

These manual drain calls are removed in Task 12 when Layers take over.

**Step 5: Run existing tests for each service**

Run: `pnpm vitest run test/unit/daemon/keep-awake.test.ts test/unit/daemon/version-check.test.ts test/unit/daemon/storage-monitor.test.ts test/unit/daemon/port-scanner.test.ts`

Update test constructors to remove `ServiceRegistry` argument. Also delete/rewrite tests that verify ServiceRegistry integration:
- `keep-awake.test.ts` T20 — "registers with the ServiceRegistry" and "drainAll on registry kills the child process" sub-tests
- `port-scanner.test.ts` — drain tests that create a registry and check registration
Replace with equivalent Layer-based tests in `test/unit/effect/daemon-layers.test.ts` if needed.

**Step 6: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/lib/daemon/keep-awake.ts src/lib/daemon/version-check.ts src/lib/daemon/storage-monitor.ts src/lib/daemon/port-scanner.ts src/lib/effect/daemon-layers.ts src/lib/effect/services.ts test/unit/daemon/
git commit -m "refactor: migrate leaf Drainable services to Effect Layers"
```

---

## Task 10: Migrate EventEmitter services to PubSub + Effect Layers (W4)

**Files:**
- Modify: `src/lib/instance/instance-manager.ts` (14 emit sites, 4 event types)
- Modify: `src/lib/daemon/project-registry.ts` (10 emit sites, 5 event types)
- Modify: `src/lib/server/ws-handler.ts` (6 emit sites, 4 event types)
- Modify: `src/lib/relay/sse-stream.ts` (8 emit sites, 6 event types)
- Modify: `src/lib/session/session-status-poller.ts` (1 emit site, 1 event type)
- Modify: `src/lib/relay/message-poller.ts` (2 emit sites)
- Modify: `src/lib/relay/message-poller-manager.ts` (1 emit site)
- Modify: `src/lib/effect/daemon-layers.ts` (add Layer definitions)
- Modify: `src/lib/effect/services.ts` (add Tags)
- Test: existing tests for each service

**This is the largest single task.** Do one service at a time, commit after each.

**Approach: Direct calls for sync-critical + PubSub for broadcast (Option 3)**

Each emit site must be classified before migration:
- **Sequential** — caller reads state or calls functions after emit that assume the handler already ran → replace with direct `yield*` function call inside Effect pipeline
- **Broadcast** — "FYI" notification where caller doesn't depend on handler completion → replace with `PubSub.publish()`

**Step 0 (per service): Classify emit sites**

For each `.emit()` call in the service, check the 3 lines after it:
- If next lines read state that the handler modifies → **Sequential** (direct call)
- If next lines are unrelated or return immediately → **Broadcast** (PubSub)

Run: `grep -A3 "\.emit(" src/lib/<service-file>` to identify patterns.

**Pattern for sequential emit sites (direct calls):**

```typescript
// Old:
this.emit("instance_added", instance);
this.broadcastSessionList(); // assumes handler updated state

// New: call handler directly inside Effect pipeline
yield* onInstanceAdded(instance)
yield* broadcastSessionList()
```

Extract handler logic into standalone Effect functions. Dependencies become explicit — if you miss one, the type system catches it.

**Pattern for broadcast emit sites (PubSub):**

1. Create a typed event union:
   ```typescript
   type InstanceBroadcast =
     | { _tag: "status_changed"; instance: OpenCodeInstance }
     | { _tag: "instance_error"; id: string; error: string };
   ```
2. Add a PubSub field: `readonly broadcasts: PubSub.PubSub<InstanceBroadcast>`
3. Replace broadcast emits: `yield* PubSub.publish(this.broadcasts, { _tag: "status_changed", instance })`
4. Replace subscribers:
   ```typescript
   const sub = yield* PubSub.subscribe(service.broadcasts);
   yield* Stream.fromQueue(sub).pipe(
     Stream.filter((e) => e._tag === "status_changed"),
     Stream.runForEach((e) => Effect.sync(() => handleStatusChange(e.instance))),
     Effect.forkScoped,
   );
   ```

**Important API note:** Use `PubSub.publish()` (returns Effect) inside Effect pipelines. Do NOT use `PubSub.unsafeOffer` — verify whether this API exists in Effect 3.21.2 before using. If emit sites are outside Effect context, wrap with `Effect.runFork(PubSub.publish(...))` for fire-and-forget.

**Other patterns:**

5. Remove `extends EventEmitter<Events>`
6. Remove `implements Drainable` and `ServiceRegistry` from constructor
7. Move `drain()` to `Effect.addFinalizer` in the Layer
8. Add `PubSub.shutdown(this.broadcasts)` to the finalizer

**Subscriber cleanup:** PubSub subscribers need explicit Scope. Wrap subscriber creation in `Effect.scoped` or ensure the subscriber is created inside a scoped Layer. Wiring functions (`handler-deps-wiring.ts`, `poller-wiring.ts`, `session-lifecycle-wiring.ts`, `sse-wiring.ts`) must either be inside Effect context or create scoped subscriptions.

**Order of migration (simplest first):**
1. SessionStatusPoller (1 emit site)
2. MessagePoller (2 emit sites)
3. MessagePollerManager (1 emit site, forwards from child)
4. SSEStream (8 emit sites)
5. WebSocketHandler (6 emit sites)
6. InstanceManager (14 emit sites)
7. ProjectRegistry (10 emit sites)

**Step 1: For each service, update the class and its callers**

Follow the pattern above. For each service:
- Update class definition
- Update all `.on()` subscriber sites (find with `grep -rn "serviceName\.on(" src/`)
- Update all `.emit()` sites
- Update the corresponding test file
- Run that service's tests
- Commit

**Step 2: After all 7 services migrated, run full suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 3: Commit per service (7 commits)**

```bash
# Example for first:
git commit -m "refactor: migrate SessionStatusPoller from EventEmitter to PubSub"
```

---

## Task 11: Create server Layers (W4)

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/daemon/daemon-lifecycle.ts` (minimal — keep functions, wrap in Layer)

**Note on DaemonLifecycleContext:** `DaemonLifecycleContext` is a shared mutable object that multiple server functions read/write (`ctx.httpServer`, `ctx.port`, `ctx.upgradeServer`). This is safe because servers start sequentially (HTTP before WebSocket upgrade before onboarding), not concurrently. Use `Layer.provide` chains (not `Layer.mergeAll`) to enforce this ordering.

**Step 1: Create HttpServerLayer**

```typescript
export const makeHttpServerLive = (ctx: DaemonLifecycleContext) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      yield* Effect.promise(() => startHttpServer(ctx));
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => closeHttpServer(ctx)),
      );
    }),
  );
```

**Step 2: Create IpcServerLayer and OnboardingServerLayer**

Same pattern — `acquireRelease` wrapping existing `start*Server`/`close*Server` functions from daemon-lifecycle.ts.

**OnboardingServer conditional:** Only starts when TLS is active (`ctx.tls` is present). The existing `startOnboardingServer` already returns `Promise.resolve()` when `!ctx.tls`, so the Layer handles this gracefully — it becomes a no-op Layer when TLS is disabled.

**Step 3: Create PID/socket file cleanup Layer**

```typescript
export const makePidFileLive = (pidPath: string, socketPath: string) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      yield* Effect.sync(() => writePidFile(pidPath));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removePidFile(pidPath);
          removeSocketFile(socketPath);
        }),
      );
    }),
  );
```

**Step 4: Run tests, commit**

```bash
git commit -m "feat: create Effect Layers for HTTP, IPC, and Onboarding servers"
```

---

## Task 12: Compose DaemonLive and wire Layer.launch (W4)

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (major refactor)
- Modify: `src/lib/effect/daemon-layers.ts`
- Test: `test/integration/flows/daemon-lifecycle.integration.ts` (if exists)

**Step 1: Create DaemonLive Layer composition**

In `src/lib/effect/daemon-layers.ts`. Use `Layer.provide` chains (NOT `Layer.mergeAll`) to express service dependencies:

```typescript
export const makeDaemonLive = (options: DaemonOptions) => {
  // Leaf layers (no deps on other services)
  const configLayer = makeConfigLive(options);
  const signalLayer = SignalHandlerLayer;
  const errorLayer = ProcessErrorHandlerLayer;
  const pidLayer = makePidFileLive(options.pidPath, options.socketPath);

  // Server layers (sequential: HTTP → WS upgrade → onboarding)
  const serversLayer = makeHttpServerLive(options.ctx).pipe(
    Layer.provideMerge(makeIpcServerLive(options.ctx)),
    Layer.provideMerge(makeOnboardingServerLive(options.ctx, options.onboarding)),
  );

  // Background services (depend on config)
  const backgroundLayer = Layer.mergeAll(
    makeKeepAwakeLive(options.keepAwake),
    makeVersionCheckerLive(options.versionCheck),
    makeStorageMonitorLive(options.storageMon),
    makePortScannerLive(options.portScanner),
  );

  // Core services (InstanceManager, ProjectRegistry depend on config + servers)
  const coreLayer = Layer.mergeAll(
    makeInstanceManagerLive(options.instanceMgr),
    makeProjectRegistryLive(options.projectRegistry),
  );

  return Layer.mergeAll(signalLayer, errorLayer, pidLayer).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(serversLayer),
    Layer.provideMerge(backgroundLayer),
    Layer.provideMerge(coreLayer),
  );
};
```

**Step 2: Migrate daemon startup logic**

`daemon.ts:start()` does more than service creation — it also:
- Rehydrates config from disk (instances, projects, dismissed paths, keep-awake)
- Probes localhost:4096 for smart-default detection
- Auto-starts managed "default" instance
- Prefetches session counts
- Discovers projects

These initialization steps become Effect programs that run AFTER Layer construction but BEFORE the daemon blocks waiting for shutdown. They should be placed in the main program, not in Layers:

```typescript
const startupEffects = Effect.gen(function* () {
  // Config rehydration already done by ConfigLayer
  // Probe-and-convert, auto-start, prefetch, discovery:
  yield* probeSmartDefault(options);
  yield* autoStartDefaultInstance(options);
  yield* prefetchSessionCounts(options);
  yield* discoverProjects(options);
});
```

**Daemon mutable state** (clientCount, dismissedPaths, persistedSessionCounts) can be managed via `Ref` inside the appropriate Layer, or kept as plain fields on a service class managed by a Layer.

**Step 3: Update CLI entry point**

The entry point blocks on the shutdown Deferred, then exits:

```typescript
const DaemonLive = makeDaemonLive(options);

const program = Effect.gen(function* () {
  // Run startup effects (probe, auto-start, prefetch, discover)
  // These run inside the provided Layer context — no double-provide
  yield* probeSmartDefault(options);
  yield* autoStartDefaultInstance(options);
  yield* prefetchSessionCounts(options);
  yield* discoverProjects(options);

  // Block until shutdown signal
  const shutdown = yield* ShutdownSignalTag;
  yield* Deferred.await(shutdown);
  // Scope close triggers all Layer finalizers (reverse order)
}).pipe(
  Effect.scoped,
  Effect.provide(DaemonLive),  // Single provide — Layer memoization works correctly
  Effect.catchAllCause((cause) =>
    Effect.logError("Fatal", Cause.pretty(cause)),
  ),
);

Effect.runFork(program);
```

Note: `DaemonLive` is provided ONCE. Startup effects and the shutdown wait share the same Layer context. `discoverProjects` is fully rewritten as an Effect function (uses `createSdkClientEffect` internally, not the legacy `createSdkClient`).

**Step 4: Run full test suite and manual smoke test**

Run: `pnpm check && pnpm test:unit`
Then: `pnpm dev` — verify daemon starts, serves requests, shuts down cleanly on SIGTERM.

**Step 5: Commit**

```bash
git commit -m "refactor: compose DaemonLive Layer, wire Layer.launch entry point"
```

---

## Task 13: Delete legacy lifecycle infrastructure (W4)

**Files:**
- Delete: `src/lib/daemon/service-registry.ts`
- Delete: `src/lib/daemon/async-tracker.ts`
- Modify: `src/lib/daemon/daemon.ts` (remove ServiceRegistry/AsyncTracker usage)
- Delete: `test/unit/daemon/tracked-service.test.ts` (if exists)

**Step 1: Remove ServiceRegistry and AsyncTracker from daemon.ts**

Remove:
- `private serviceRegistry = new ServiceRegistry()` (line 240)
- `private tracker = new AsyncTracker()` (line 241)
- `await this.serviceRegistry.drainAll()` (line 998)
- `await this.tracker.drain()` (line 1001)
- All `this.tracker.track(...)` calls (lines 816, 879-886)
- All `this.serviceRegistry` passes to service constructors
- The manual bridge drain calls added in Task 9 Step 4a (no longer needed — Layers handle lifecycle)

**Step 2: Also update relay-stack.ts**

`src/lib/relay/relay-stack.ts:152` creates its own `new ServiceRegistry()` as fallback. Remove this and update `createProjectRelay` to not accept/create a registry.

**Step 3: Verify ALL Drainable services are migrated (BLOCKING pre-check)**

Before deleting, run: `grep -rn "implements Drainable" src/`

Every match MUST have been migrated to Effect Layers in Tasks 9-10. Known services:
- Task 9: KeepAwake, VersionChecker, StorageMonitor, PortScanner (4)
- Task 10: InstanceManager, ProjectRegistry, WebSocketHandler, SSEStream, SessionStatusPoller, MessagePoller, MessagePollerManager (7)
- **Must also check:** SessionOverrides, RelayTimers — these may implement Drainable but are NOT listed in Tasks 9/10. If they still implement Drainable:
  - Either add them to Task 9 (simple drain) or Task 10 (EventEmitter) BEFORE proceeding
  - OR migrate them inline in this task before deleting ServiceRegistry
  - Do NOT proceed with deletion until grep returns zero matches for `implements Drainable`

**Step 4: Delete files**

```bash
rm src/lib/daemon/service-registry.ts
rm src/lib/daemon/async-tracker.ts
```

**Step 5: Remove Drainable imports from ALL files**

Run: `grep -rn "from.*service-registry\|Drainable" src/`

Update EVERY file that imports `Drainable` or `ServiceRegistry` — remove the import. This includes service classes (already migrated in Tasks 9-10), relay-stack.ts, daemon.ts, and any test files.

**Step 4: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 5: Commit**

```bash
git rm src/lib/daemon/service-registry.ts src/lib/daemon/async-tracker.ts
git add src/lib/daemon/daemon.ts
git commit -m "chore: delete ServiceRegistry and AsyncTracker (replaced by Effect Layers)"
```

---

## Task 14: Delete sdk-factory compat wrapper (W4)

**Files:**
- Modify: `src/lib/instance/sdk-factory.ts` (delete `createSdkClient` compat function)
- Verify: `src/lib/daemon/daemon.ts` (should already use Effect version after Task 12)
- Delete: `test/unit/instance/sdk-factory.test.ts` (imports deleted function)
- Modify: `test/unit/effect/sdk-factory.test.ts` (remove compat test case)

**Step 1: Verify daemon.ts no longer references `createSdkClient`**

Task 12 fully rewrites `discoverProjects` internals to use `createSdkClientEffect` inside an Effect pipeline. Verify with: `grep -rn "createSdkClient[^E]" src/lib/daemon/daemon.ts` — expected: no matches. If matches remain, replace them with `yield* createSdkClientEffect(options)` inside the Effect context.

**Step 2: Delete compat wrapper**

In `src/lib/instance/sdk-factory.ts`, delete the `createSdkClient` function and its export. Only `createSdkClientEffect` remains.

**Step 3: Delete old test file and compat test case**

- Delete `test/unit/instance/sdk-factory.test.ts` — all 4 test cases import `createSdkClient`. Coverage is subsumed by `test/unit/effect/sdk-factory.test.ts` (created in Task 4).
- In `test/unit/effect/sdk-factory.test.ts`, remove the `"legacy createSdkClient still works for daemon compat"` test case — it dynamically imports the now-deleted function.

**Step 4: Run full test suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass.

**Step 5: Commit**

```bash
git rm test/unit/instance/sdk-factory.test.ts
git add src/lib/instance/sdk-factory.ts test/unit/effect/sdk-factory.test.ts
git commit -m "chore: delete createSdkClient compat wrapper and legacy tests"
```

---

## Task 15: Final verification

**Step 1: Run all test suites**

```bash
pnpm check
pnpm test:unit
pnpm build
```

**Step 2: Manual smoke test**

- Start with `pnpm dev`
- Verify daemon starts without errors
- Open browser, check WebSocket connects
- Send a message, verify streaming works
- Kill with SIGTERM, verify clean shutdown (no leaked handles)
- Check no "unhandled rejection" or "listener leak" warnings

**Step 3: Verify no dead imports**

Run: `grep -rn "service-registry\|async-tracker\|retry-fetch\|TrackedService\|MESSAGE_HANDLERS[^_]" src/`
Expected: No matches.

**Step 4: Commit any remaining fixes**

```bash
git commit -m "chore: final cleanup after Effect.ts migration follow-up"
```
