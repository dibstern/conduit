# SDK Migration Plan Audit v3

**Date:** 2026-04-13
**Plan:** `docs/plans/2026-04-10-sdk-migration-plan.md`
**Scope:** Re-audit after v2 amendments (5 fixes applied). 6 focused auditors dispatched.

---

## Amend Plan (4)

### 1. authFetch strips all REST headers — SDK calls fetch with single Request arg

**Severity:** Critical — every authenticated REST call loses Content-Type, x-opencode-directory, etc.
**Tasks:** 3
**Source:** Task 3 auditor (Finding #1)

**Issue:** The SDK's internal fetch type is `(request: Request) => ReturnType<typeof fetch>`. The hey-api client calls `_fetch(request)` with a single `Request` argument (client.gen.js line 56). In the plan's `authFetch`, `init` is therefore always `undefined`:

```typescript
async (input, init) => {
    // input = Request with all headers from beforeRequest
    // init = undefined (SDK calls with 1 arg!)
    const headers = new Headers(init?.headers); // EMPTY Headers
    headers.set("Authorization", authHeaders.Authorization); // only Auth
    return baseFetch(input, { ...init, headers });
    // Node fetch: init.headers REPLACES request.headers → loses everything
}
```

**Fix:** Rewrite `authFetch` to handle the single-Request calling convention:

```typescript
const authFetch: typeof fetch = async (input, init) => {
    if (input instanceof Request && !init) {
        const headers = new Headers(input.headers);
        headers.set("Authorization", authHeaders.Authorization);
        return baseFetch(new Request(input, { headers }));
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authHeaders.Authorization);
    return baseFetch(input, { ...init, headers });
};
```

**Action:** Amend Plan — rewrite authFetch in Task 3.

---

### 2. translateSdkError cannot extract HTTP status — all API errors become OpenCodeConnectionError

**Severity:** Critical — breaks session-manager pagination fallback and any caller checking error status
**Tasks:** 3, 5
**Source:** Task 5 auditor (Finding #1)

**Issue:** With `throwOnError: true`, the SDK throws the **parsed JSON error body** (client.gen.js line 125: `throw finalError`). OpenCode's error types have NO `status` field:

- `BadRequestError` (400): `{ data: unknown, errors: [...], success: false }` — no status
- `NotFoundError` (404): `{ name: "NotFoundError", data: { message } }` — no status

The plan's `translateSdkError` checks `e.status` / `e.statusCode` — neither exists. Every API error falls through to `OpenCodeConnectionError`. Session-manager's `err instanceof OpenCodeApiError && err.responseStatus === 400` will NEVER match.

**Fix:** Register an error interceptor on the SDK client (in Task 3) that attaches the HTTP status to the thrown error:

```typescript
// In createSdkClient(), after creating the client:
const rawClient = createClient(config);
rawClient.interceptors.error.use((error, response, _request, _opts) => {
    if (response && error && typeof error === "object") {
        (error as any).__httpStatus = response.status;
    }
    return error;
});
```

Then in `translateSdkError`, check `e.__httpStatus`:

```typescript
const status = typeof e.__httpStatus === "number" ? e.__httpStatus : undefined;
```

**Note:** This requires calling `createClient()` directly + registering interceptors + constructing `OpencodeClient({ client })` manually, instead of using `createOpencodeClient()` which hides the raw client. The plan's Task 3 should be restructured accordingly.

**Action:** Amend Plan — Add error interceptor in Task 3, update translateSdkError in Task 5.

---

### 3. sdk() wrapper TypeScript signature won't compile — SDK methods default ThrowOnError to false

**Severity:** Medium — compile error on every SDK call site
**Tasks:** 5
**Source:** Task 5 auditor (Finding #2)

**Issue:** The `sdk<T>()` wrapper expects:
```typescript
fn: () => Promise<{ data: T; request: Request; response: Response }>
```

But SDK methods default `ThrowOnError = false`, producing a union:
```typescript
Promise<({ data: T; error: undefined } | { data: undefined; error: E }) & { request; response }>
```

TypeScript will reject this mismatch at compile time for all ~37 call sites.

**Fix (recommended):** Broaden the wrapper's `fn` type:
```typescript
private async sdk<T>(fn: () => Promise<{ data?: T; [key: string]: unknown }>): Promise<T> {
    try {
        const result = await fn();
        return result.data as T; // runtime: throwOnError ensures data is present on success
    } catch (err: unknown) {
        throw this.translateSdkError(err);
    }
}
```

**Action:** Amend Plan — broaden sdk() fn parameter type in Task 5.

---

### 4. Task 3 tests destructure wrong level — will fail immediately

**Severity:** Low — test-only, easy fix
**Tasks:** 3
**Source:** Task 3 auditor (Finding #2)

**Issue:** Tests do `const client = createSdkClient(...)` then check `client.session`. But `createSdkClient` returns `SdkFactoryResult { client, fetch, authHeaders }`, not `OpencodeClient`. Should be `const { client } = createSdkClient(...)`.

**Action:** Amend Plan — fix test destructuring in Task 3.

---

## Ask User (0)

No design decisions requiring human judgment.

---

## Accept (8)

### A1. Auth duplication on REST is harmless
REST calls get Authorization from both config.headers (via beforeRequest) and authFetch wrapper. `Headers.set()` is idempotent — second set wins. No duplicate header values.

### A2. throwOnError only affects REST, not SSE
SSE goes through `fn.sse()` → `createSseClient()`, which always throws on errors regardless of throwOnError. This is fine — SSEStream already handles errors.

### A3. SSE auth flow confirmed working end-to-end
Full trace verified: config.headers → createClient → _config.headers → beforeRequest → mergeHeaders → opts.headers → createSseClient → fetch(url, { headers }). Authorization header propagates correctly.

### A4. 204 responses return `{ data: {} }` not typed data
For void methods (delete, abort, summarize), the plan correctly discards the return value. No callers inspect it.

### A5. event.subscribe() correctly bypasses sdk() wrapper
Returns `{ stream }` not `{ data }`, goes through `fn.sse()` not `request()`. Correct.

### A6. Provider list data.all shape confirmed correct
`ProviderListResponses["200"]` has `{ all, default, connected }`. Plan accesses all three correctly.

### A7. Mock factory Step 0 ordering is acceptable
Step 0 rewrites mocks before source migration. Some tests may fail transiently, but Task 7's Steps 1-5 fix them immediately. No CI breakage since Task 6+7 are committed together.

### A8. SSEEvent heartbeat — harmless even if never emitted
If `server.heartbeat` is only an SSE comment (not a data event), the SDK won't yield it and `ServerHeartbeatEvent` is dead code. But it's harmless in the union type and provides forward compatibility.

---

## Summary

| Action | Count | Impact |
|--------|-------|--------|
| **Amend Plan** | 4 | authFetch header stripping (critical), HTTP status extraction (critical), sdk() type signature (medium), test destructuring (low) |
| **Ask User** | 0 | — |
| **Accept** | 8 | Auth duplication, throwOnError scope, SSE auth confirmed, 204 handling, event.subscribe bypass, provider shape, mock ordering, heartbeat |

**Verdict:** 4 Amend Plan findings. The two critical findings (#1 authFetch, #2 HTTP status) would cause production failures. Finding #3 (type signature) would cause compile errors. Finding #4 (test destructuring) is trivial. Handing off to plan-audit-fixer.

---

## Delta from v2 Audit

| v2 Finding | v3 Status | Notes |
|------------|-----------|-------|
| SSE auth bypass | ✅ SSE auth flow confirmed working | config.headers propagation traced end-to-end |
| Error handling (unwrap) | ⚠️ Partially fixed | throwOnError + sdk() wrapper correct in concept, but translateSdkError can't get HTTP status |
| Mock factory scope | ✅ Fixed | Step 0 is explicit and complete |
| Provider model type | ✅ Fixed | data.all shape verified against SDK types |
| SSEEvent heartbeat | ✅ Fixed | ServerHeartbeatEvent added (harmless even if dead code) |

**New in v3:**
- authFetch header stripping (SDK single-arg calling convention not handled)
- HTTP status not available on thrown errors (need error interceptor)
- sdk() TypeScript signature mismatch (ThrowOnError default = false)
- Test destructuring bug (SdkFactoryResult vs OpencodeClient)
