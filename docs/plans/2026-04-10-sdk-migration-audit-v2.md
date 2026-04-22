# SDK Migration Plan Audit v2

**Date:** 2026-04-10
**Plan:** `docs/plans/2026-04-10-sdk-migration-plan.md`
**Scope:** Full re-audit of amended plan — 8 auditor areas, verified against SDK source

This audit was performed AFTER the first audit's 5 amendments were applied. It checks whether the amendments are sufficient and finds issues the first audit missed.

---

## Amend Plan (5)

### 1. SSE connections bypass auth-wrapped fetch — will be unauthenticated

**Severity:** Critical — SSE will fail with 401 in any auth-protected deployment
**Tasks:** 3, 13, 14

**Issue:** The plan's auth strategy injects a custom `authFetch` wrapper into `createOpencodeClient({ fetch: authFetch })`. For REST calls, this works — the hey-api client's `request()` method uses `opts.fetch` (client.gen.js line 56). **But for SSE, the SDK's `createSseClient()` (serverSentEvents.gen.js line 20) calls `globalThis.fetch` directly — NOT the injected custom fetch:**

```js
// serverSentEvents.gen.js line 20
const response = await fetch(url, { ...options, headers, signal });
```

The `options` spread includes `headers` from the client config (via `beforeRequest` → `mergeHeaders`), but the plan only sets `x-opencode-directory` in config headers — NOT `Authorization`. Auth is only in the fetch wrapper, which SSE never calls.

**Evidence:** Traced the full call path:
1. `sdk.event.subscribe()` → `this._client.get.sse({ url: "/event" })`
2. `get.sse()` → `beforeRequest()` → merges `_config.headers` (only has `x-opencode-directory`) → calls `createSseClient({ ...opts, headers: opts.headers, url })`
3. `createSseClient()` → `fetch(url, { ...options, headers, signal })` — global fetch, no auth

**Fix:** In `sdk-factory.ts`, add `Authorization` to `config.headers` in addition to the fetch wrapper:

```typescript
const headers: Record<string, string> = {};
if (password) {
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  headers.Authorization = `Basic ${encoded}`;
}

const client = createOpencodeClient({
  baseUrl: options.baseUrl,
  fetch: authFetch as any,
  headers,  // ← SSE uses these headers via opts.headers
  directory: options.directory,
});
```

This ensures both REST (via authFetch) and SSE (via config.headers) get auth.

**Action:** Amend Plan — Update Task 3 to include auth headers in SDK config, not only in the fetch wrapper.

---

### 2. SDK errors silently become wrong-typed data — `unwrap()` never checks for errors

**Severity:** Critical — API errors return garbage data instead of throwing
**Tasks:** 5, 7

**Issue:** The SDK defaults to `responseStyle: "fields"` and `throwOnError: false`. This means:
- **Success:** `{ data: T, request: Request, response: Response }`
- **Error:** `{ error: E, request: Request, response: Response }` (NO `data` property)

The plan's `unwrap()` method:
```typescript
private unwrap<T>(response: { data?: T } | T): T {
    if (response && typeof response === "object" && "data" in response) {
        return (response as { data: T }).data;
    }
    return response as T;
}
```

On error, `"data" in response` is **false** (runtime object has no `data` key). `unwrap()` falls through to `return response as T` — returning `{ error: "Not found", request: ..., response: ... }` typed as `Session[]`. Callers get silently wrong data.

**Additionally:** Callers currently catch `OpenCodeApiError` with `.responseStatus` (e.g., `session-manager.ts` line 284: `err instanceof OpenCodeApiError && err.responseStatus === 400`). The SDK never throws `OpenCodeApiError`. With default settings, errors aren't thrown at all — they're returned as objects.

**Fix:** Set `throwOnError: true` in the SDK config and add error translation in `unwrap()` or a wrapper:

```typescript
const client = createOpencodeClient({
  baseUrl: options.baseUrl,
  fetch: authFetch as any,
  headers,
  directory: options.directory,
  throwOnError: true,  // ← errors throw instead of returning { error }
});
```

Then wrap SDK calls to translate errors to `OpenCodeApiError`:
```typescript
private async call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
  try {
    const res = await fn();
    return res.data;
  } catch (err) {
    // Translate SDK errors to OpenCodeApiError for caller compatibility
    throw this.translateError(err);
  }
}
```

**Action:** Amend Plan — Task 3 must set `throwOnError: true`. Task 5 must replace `unwrap()` with error-translating wrapper that produces `OpenCodeApiError`/`OpenCodeConnectionError` for caller compatibility.

---

### 3. Mock factory restructuring is ~300 lines across 13 test files — plan underestimates

**Severity:** High — Task 7 will stall without explicit guidance
**Tasks:** 7

**Issue:** Task 7 says "Fix any test stubs" as a vague sub-step. Investigation reveals the true scope:

`test/helpers/mock-factories.ts` contains `createMockClient()` with **38 flat-API stub methods** (e.g., `sendMessageAsync`, `getSession`, `listSessions`, `getMessages`, `listProviders`, etc.). These must be restructured to the namespaced API shape (`session.list()`, `session.get()`, `permission.list()`, etc.).

**13 test files** reference `OpenCodeClient`:
- `test/helpers/mock-factories.ts` — central factory (~80 lines to rewrite)
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

The `createMockProjectRelay()` factory also references `sseConsumer` which becomes `sseStream` after Task 14.

**Fix:** Task 7 should explicitly include a sub-step: "Rewrite `mock-factories.ts` to use namespaced API shape" and list the 13 test files. Consider making mock-factory rewrite a precondition before the file-by-file caller migration.

**Action:** Amend Plan — Task 7 must enumerate test files and mock-factory restructuring as explicit sub-steps with estimated scope (~300 lines across 13 files).

---

### 4. `provider.list()` returns different shape than plan's normalization assumes

**Severity:** Medium — normalization logic has wrong field name
**Tasks:** 5

**Issue:** The v1 audit amendment changed from `config.providers()` to `provider.list()`. The SDK types confirm these ARE different endpoints with different responses:

- `GET /config/providers` (`ConfigProvidersResponses`): `{ providers: Provider[], default: {...} }` — NO `connected` field
- `GET /provider` (`ProviderListResponses`): `{ all: [...], default: {...}, connected: string[] }` — HAS `connected`, uses `all` not `providers`

The plan's code correctly targets `provider.list()` and correctly references `data.all` and `data.connected`. **However**, the plan's normalization casts `models` as `Record<string, unknown>`, but the SDK type shows models is `Record<string, DetailedModelObject>` with id, name, release_date, attachment, reasoning, cost, limit, etc. Callers in `model.ts` and `client-init.ts` may depend on specific model fields that differ from the old relay's `ModelInfo` type.

**Fix:** Task 5's provider normalization should preserve the full SDK model shape (not cast to `Record<string, unknown>`). Task 10 should verify callers access model fields correctly.

**Action:** Amend Plan — Update Task 5 provider normalization to use SDK model type. Add note to Task 10 to verify model field access in `model.ts`, `client-init.ts`, and `settings.ts`.

---

### 5. `server.heartbeat` is not in SDK Event union — SSEEvent superset type is incomplete

**Severity:** Low-Medium — heartbeat detection works via `as` cast but type system is wrong
**Tasks:** 11, 13

**Issue:** The SSEStream implementation handles `server.heartbeat`:
```typescript
if (evt.type === "server.heartbeat" || evt.type === "server.connected") {
    this.emit("heartbeat");
    continue;
}
```

`EventServerConnected` (type `"server.connected"`) IS in the SDK Event union. But `server.heartbeat` is NOT. The v1 audit's SSEEvent superset type lists 3 gap events (`message.part.delta`, `permission.asked`, `question.asked`) but misses `server.heartbeat`.

Currently this works because SSEStream casts events as `{ type?: string }`, but when Task 11 replaces `OpenCodeEvent` with `SSEEvent`, the type system won't recognize heartbeat events in typed code paths.

**Fix:** Add `ServerHeartbeatEvent` to the SSEEvent superset:
```typescript
export interface ServerHeartbeatEvent { type: "server.heartbeat"; properties?: Record<string, unknown> }
export type SSEEvent = Event | PartDeltaEvent | PermissionAskedEvent | QuestionAskedEvent | ServerHeartbeatEvent;
```

**Action:** Amend Plan — Task 11 SSEEvent superset must include `server.heartbeat`.

---

## Ask User (1)

### 1. Should `throwOnError: true` be the default, or should OpenCodeAPI handle both paths?

**Context:** Finding #2 above requires a decision. Two approaches:

**Option A (Recommended): `throwOnError: true` + error translation wrapper**
- SDK throws on errors, `OpenCodeAPI` catches and wraps in `OpenCodeApiError`
- Callers' existing `catch (err) { if (err instanceof OpenCodeApiError) }` patterns continue working
- Cleaner — errors are always thrown, never silently returned

**Option B: `responseStyle: "data"` + manual error checking**
- SDK returns data directly on success, `undefined` on error
- Simpler unwrap (just return data) but silently loses error information
- Callers need new error patterns

**Recommendation:** Option A preserves caller compatibility and provides better error diagnostics.

**Action:** Ask User — confirm preferred error handling approach.

---

## Accept (6)

### A1. `as any` casts are contained and documented

The plan has 4 `as any` casts:
- `fetch: authFetch as any` — SDK expects `(request: Request) => ...`, our wrapper has `(input: RequestInfo, init?) => ...`. Cosmetic mismatch.
- `body: body as any` in prompt — plan builds `Record<string, unknown>` matching SDK shape, cast is safe.
- `body: options as any` in pty.create — optional fields, safe.
- `body: config as any` in config.update — passthrough, safe.

All are contained in `sdk-factory.ts` and `opencode-api.ts`. Not ideal but acceptable for SDK migration.

### A2. `postSessionIdPermissionsPermissionId` is fragile but correct

Auto-generated method name. SDK version updates could rename it. Plan correctly uses it for v1.3.0. When SDK adds a `permission` namespace, this can be migrated.

### A3. Task 6 WIP commit with type errors is intentional

The plan explicitly says "Expected: FAIL" for Task 6's type check. Task 7 immediately follows. Risk is acceptable — Tasks 6+7 are practically atomic.

### A4. Prompt body parts format matches SDK types

Plan builds `{ type: "text", text }` and `{ type: "file", url, mime }`. SDK expects `TextPartInput` and `FilePartInput` which accept exactly these fields (with optional extras). Correct.

### A5. Timer not cleared on retry error path (Task 2) — unchanged from v1 audit

`retryFetch` doesn't `clearTimeout(timer)` when `baseFetch` throws. The timer fires but `controller.abort()` on a dead controller is a no-op. Matches old `OpenCodeClient` behavior.

### A6. retryFetch drops caller AbortSignal (Task 2) — unchanged from v1 audit

`retryFetch` overwrites `init.signal` with its timeout signal. In practice, the SDK doesn't pass signals for REST calls. Acceptable.

---

## Summary

| Action | Count | Impact |
|--------|-------|--------|
| **Amend Plan** | 5 | SSE auth bypass (critical), error handling (critical), mock factory scope, provider model shape, SSEEvent heartbeat |
| **Ask User** | 1 | Error handling strategy (throwOnError vs responseStyle) |
| **Accept** | 6 | as-any casts, permission method name, WIP commit, prompt format, timer leak, signal override |

**Verdict:** 5 Amend Plan + 1 Ask User findings must be resolved before execution. The two critical findings (#1 SSE auth, #2 error handling) would cause production failures — SSE won't connect with auth, and API errors will silently return garbage data.

---

## Delta from v1 Audit

| v1 Finding | v2 Status | Notes |
|------------|-----------|-------|
| GapEndpoints missing auth | ✅ Fixed by amendment | Auth-wrapped fetch passed to GapEndpoints |
| Message normalization dropped | ✅ Fixed by amendment | Notes added, callers will update field access |
| Provider response shape | ⚠️ Partially fixed | Correct endpoint now, but model type cast too narrow |
| SSE event type gap | ⚠️ Partially fixed | 3 gaps identified, but `server.heartbeat` missed |
| PTY getBaseUrl/getAuthHeaders | ✅ Fixed by amendment | Methods added to OpenCodeAPI |

**New in v2:**
- SSE auth bypass (CRITICAL — not caught by v1 because it requires tracing SDK internals)
- Error handling parity (CRITICAL — `unwrap()` silently passes through error responses)
- Mock factory scope (v1 didn't quantify test impact)
