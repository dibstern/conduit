# SDK Migration Plan Audit v4

**Date:** 2026-04-13
**Plan:** `docs/plans/2026-04-10-sdk-migration-plan.md`
**Scope:** Re-audit after v3 design pivot (dropped throwOnError, rewrote authFetch/sdk()/toRelayError). 3 auditors dispatched.

---

## Amend Plan (1)

### 1. GapEndpoints auth silently missing — single-Request path skips auth

**Severity:** Medium — gap endpoint calls (permissions, questions, skills, paginated messages) fail with 401
**Tasks:** 6

**Issue:** GapEndpoints' `get()` and `post()` methods call `this.fetch(new Request(url, { headers }))` — a single-Request arg. The v3 authFetch treats `input instanceof Request && !init` as the "SDK path" and passes through without adding auth. But GapEndpoints Requests don't go through the SDK's `beforeRequest()` pipeline, so auth is NOT on the Request.

**Fix:** Task 6 must pass `authHeaders` to `GapEndpoints` via its `headers` constructor option. GapEndpoints already merges `options.headers` into `this.headers` (plan line 626), so auth ends up on every Request it creates. The authFetch pass-through then works correctly — auth is already on the Request.

Add explicit construction code to Task 6:

```typescript
const { client, fetch: sdkFetch, authHeaders } = createSdkClient({
    baseUrl: config.opencodeUrl,
    directory: config.projectDir,
});
const gapEndpoints = new GapEndpoints({
    baseUrl: config.opencodeUrl,
    fetch: sdkFetch,
    headers: authHeaders,  // ← critical line
});
const api = new OpenCodeAPI({
    sdk: client,
    gapEndpoints,
    baseUrl: config.opencodeUrl,
    authHeaders,
});
```

**Action:** Amend Plan — add explicit wiring code to Task 6.

---

## Ask User (0)

No design decisions requiring human judgment.

---

## Accept (5)

### A1. authFetch pass-through confirmed correct for SDK path
SDK calls `_fetch(request)` with one arg (client.gen.js:56 confirmed: `const _fetch = opts.fetch; let response = await _fetch(request)`). `input instanceof Request` is true, `init` is undefined. Pass-through works — auth already on Request from config.headers via beforeRequest.

### A2. sdk() error check `result.error !== undefined` is correct
SDK success path (client.gen.js:101-106) returns `{ data, request, response }` — NO `error` property. Error path (client.gen.js:127-133) returns `{ error, request, response }` — NO `data` property. Checking `result.error !== undefined` correctly distinguishes the two cases. `error: undefined` never appears at runtime.

### A3. toRelayError response.url is safe
`Response.url` is always a string in the Fetch API (empty string if not available, never undefined). `new URL("")` would throw, but `response.url` is always the resolved URL after redirects. Safe.

### A4. Plan-wide consistency is clean
0 occurrences of `translateSdkError`, `unwrap`, `this.sdk.` (with trailing dot). 4 `throwOnError` references all in comments explaining the design choice.

### A5. SSE path unaffected
Task 13 SSEStream uses `api.event.subscribe()` → `sdkClient.event.subscribe()` → `fn.sse()` → `createSseClient()`. Independent of throwOnError. Auth via config.headers (confirmed v3 A3).

---

## Summary

| Action | Count | Impact |
|--------|-------|--------|
| **Amend Plan** | 1 | GapEndpoints needs `headers: authHeaders` in Task 6 wiring |
| **Ask User** | 0 | — |
| **Accept** | 5 | authFetch SDK path correct, sdk() error check correct, response.url safe, consistency clean, SSE unaffected |

**Verdict:** 1 Amend Plan finding — simple wiring fix in Task 6. All v3 design changes verified correct. Handing off to plan-audit-fixer.
