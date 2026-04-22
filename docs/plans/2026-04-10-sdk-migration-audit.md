# SDK Migration Plan Audit

**Date:** 2026-04-10
**Plan:** `docs/plans/2026-04-10-sdk-migration-plan.md`
**Auditors dispatched:** 6 (Tasks 1-2, 3-4, 5, 6-7, 8-12, 13-17)

---

## Amend Plan (5)

### 1. GapEndpoints missing auth headers (Task 4, Task 6)

**Issue:** `GapEndpoints` constructor accepts `headers` but the plan never passes auth headers to it. The old `OpenCodeClient` sends `Authorization: Basic ...` on every request including the gap endpoints (`GET /permission`, `GET /question`, etc.). Without auth, these will return 401.

**Fix:** In Task 6 (relay-stack wiring), when constructing `GapEndpoints`, pass the same auth headers. Either:
- Have `GapEndpoints` accept the same `retryFetch` that already has auth baked in (from sdk-factory), or
- Pass explicit `headers: { Authorization: ... }` to `GapEndpoints` constructor.

The cleanest fix: have sdk-factory return both the SDK client and the configured retryFetch, so GapEndpoints can use the same authenticated fetch.

**Action:** Amend Plan — Add auth header wiring for GapEndpoints in Tasks 4 and 6.

---

### 2. Message normalization dropped silently (Task 5)

**Issue:** The old `OpenCodeClient.getMessages()` normalizes messages from `{ info: { id, role, ... }, parts: [...] }` to flat `{ id, role, parts, ... }`. The plan's `OpenCodeAPI.session.messages()` calls `sdk.session.messages()` and `unwrap()`s the response — but the SDK returns `Array<{ info: Message, parts: Part[] }>`, not flat messages.

All downstream code (session-manager, message-poller, event-translator, client-init) expects flat messages. Without normalization, field access like `message.id` will fail (it's `message.info.id` in SDK format).

**Fix:** Either:
- Add a normalization step in `OpenCodeAPI.session.messages()` that flattens `{ info, parts }` to `{ ...info, parts }`, or
- Since the design chose "SDK types everywhere," update all consumers to use the `{ info, parts }` shape (but this means Task 5 and Tasks 8-12 become tightly coupled).

The design explicitly chose "SDK types everywhere" — so the plan should NOT normalize. Instead, Task 10 must handle this message shape change. But Task 5's adapter should still document that it returns SDK format, and Task 7 callers must be aware they're getting `{ info, parts }` not flat messages.

**Action:** Amend Plan — Add explicit note to Task 5 that `session.messages()` returns `{ info: Message, parts: Part[] }[]` (SDK shape), and that callers updated in Task 7 must access `msg.info.id` instead of `msg.id`. Task 10 should specify the exact consumer changes.

---

### 3. Provider response shape mismatch (Task 5)

**Issue:** The old `OpenCodeClient.listProviders()` does significant response normalization:
- Converts `models` from `Record<string, Model>` to `Array<Model>`
- Extracts `defaults` from `res.default`
- Extracts `connected` from `res.connected`
- Returns `{ providers, defaults, connected }` as `ProviderListResult`

The plan's `OpenCodeAPI.provider.list()` delegates to `sdk.config.providers()` and just `unwrap()`s. The SDK's `ConfigProvidersResponses` type may have a different structure than `ProviderListResult`.

Multiple handlers depend on `ProviderListResult` shape (model.ts, client-init.ts, settings.ts).

**Fix:** Either normalize in the adapter or update all callers. Since "SDK types everywhere" was the design choice, the plan should specify the exact SDK response type for `config.providers()` and update all callers to match.

**Action:** Amend Plan — Task 5 needs to either normalize provider responses to match existing `ProviderListResult`, or Task 7's handler migration must specify the new shape callers should expect.

---

### 4. SSE event type names differ from SDK Event union (Tasks 11-12)

**Issue:** The plan says to replace `OpenCodeEvent` with SDK `Event` (discriminated union). But there's a critical gap: the SSE stream delivers raw events with types like `permission.asked` and `question.asked`, while the SDK Event union has `EventPermissionUpdated` (type: `"permission.updated"`) and no question events at all.

The existing `opencode-events.ts` has type guards like `isPermissionAskedEvent()` checking for `type === "permission.asked"`. The SDK Event union may not include all event types the SSE stream actually delivers.

Events the SSE delivers that may NOT be in the SDK Event union:
- `permission.asked` (SDK has `permission.updated`)
- `question.asked` (not in SDK)
- `session.error` (may differ)
- `message.created` (may differ)

**Fix:** The plan needs a bridge layer between raw SSE events and SDK Event types. Either:
- Keep `opencode-events.ts` type guards for events not in the SDK Event union
- Create a superset type: `type SSEEvent = Event | PermissionAskedEvent | QuestionAskedEvent`
- OR verify that the SDK Event union actually includes all event types the SSE delivers (check the SDK's types.gen.ts exhaustively)

**Action:** Amend Plan — Task 11 must audit exactly which SSE event types match SDK Event variants and which don't. Create a mapping table. Don't delete opencode-events.ts type guards until verified they're subsumed.

---

### 5. PTY and SSE need getBaseUrl/getAuthHeaders during transition (Tasks 6, 14, 15)

**Issue:** The old `OpenCodeClient` exposes `getBaseUrl()` and `getAuthHeaders()` used by:
- `SSEConsumer` (for connecting to `/event` SSE endpoint)
- PTY upstream connections (for WebSocket to PTY endpoints)

Task 13's `SSEStream` uses `api.event.subscribe()` which handles auth internally (via the SDK). But PTY upstream connections still need raw `baseUrl` and auth headers to construct WebSocket URLs.

The plan deletes `OpenCodeClient` in Task 15 without providing a replacement for PTY upstream's auth header needs.

**Fix:** `OpenCodeAPI` or `sdk-factory.ts` should expose `getBaseUrl()` and `getAuthHeaders()` for PTY upstream consumption. These are simple passthrough methods.

**Action:** Amend Plan — Add `getBaseUrl()` and `getAuthHeaders()` methods to `OpenCodeAPI` (or export from sdk-factory). Update Task 5's API surface.

---

## Ask User (0)

No design decisions requiring human judgment were identified.

---

## Accept (4)

### A1. Timer not cleared on retry error path (Task 2)

The `retryFetch` implementation doesn't `clearTimeout(timer)` when `baseFetch` throws a network error. The timer will fire but `controller.abort()` on a dead controller is a no-op. This matches the existing `OpenCodeClient.request()` behavior — minor resource leak, no functional impact.

### A2. `as any` cast in sdk-factory (Task 3)

The `fetch: authFetch as any` cast exists because the SDK's `Config.fetch` type expects `(request: Request) => ReturnType<typeof fetch>` (single-arg) while our wrapper has `(input: RequestInfo | URL, init?: RequestInit)`. This is a cosmetic type mismatch — both are valid fetch signatures. Acceptable during migration.

### A3. SSEStream test timing (Task 13)

Test `makeStubApi` creates a synchronous async generator. Events may yield before the listener attaches. The 50ms `setTimeout` delay mitigates this in practice, but the test is fragile. Could be improved with an explicit event accumulation pattern but won't cause false failures in CI.

### A4. retryFetch drops caller AbortSignal (Task 2)

`retryFetch` overwrites `init.signal` with its own timeout signal. If a caller passes an AbortSignal (e.g., for user-initiated cancellation), it's ignored. In practice, the SDK doesn't pass signals for REST calls, and SSE uses the streaming API. Acceptable tradeoff — the old `OpenCodeClient` had the same limitation.

---

## Summary

| Action | Count | Impact |
|--------|-------|--------|
| **Amend Plan** | 5 | Auth wiring, message normalization, provider shape, SSE event types, PTY baseUrl/authHeaders |
| **Ask User** | 0 | — |
| **Accept** | 4 | Timer leak, as-any cast, test timing, signal override |

**Verdict:** 5 Amend Plan findings must be resolved before execution. Handing off to plan-audit-fixer.

---

## Amendments Applied (v1)

| Finding | Tasks | Amendment |
|---------|-------|-----------|
| GapEndpoints missing auth | 3, 4, 6 | `createSdkClient` now returns `{ client, fetch }` so GapEndpoints reuses the auth-wrapped fetch. Task 4 description updated. |
| Message normalization dropped | 5, 7 | Added note to `session.messages()` documenting SDK `{ info, parts }` shape. Task 7 notes callers must update field access (`msg.info.id` etc). |
| Provider response shape | 5 | Changed `provider.list()` to use `sdk.provider.list()` (not `config.providers()`). Added model normalization from `Record<string, Model>` to `Array<Model>`. |
| SSE event type gap | 11 | Created `SSEEvent` superset type covering 3 missing events (`message.part.delta`, `permission.asked`, `question.asked`). Plan keeps opencode-events.ts type guards for these. |
| PTY getBaseUrl/getAuthHeaders | 5 | Added `getBaseUrl()` and `getAuthHeaders()` methods to `OpenCodeAPI`. Constructor now accepts `baseUrl` and `authHeaders` options. |

## Amendments Applied (v2)

See `2026-04-10-sdk-migration-audit-v2.md` for full analysis.

| Finding | Tasks | Amendment |
|---------|-------|-----------|
| SSE auth bypass (CRITICAL) | 3 | Added `Authorization` header to `config.headers` in `createSdkClient()`. SSE's `createSseClient` uses `globalThis.fetch` (not injected fetch) but DOES forward config headers. Belt-and-suspenders: REST gets auth via fetch wrapper, SSE gets auth via config.headers. |
| Error handling (CRITICAL) | 3, 5 | Set `throwOnError: true` in `createOpencodeClient()`. Replaced `unwrap()` with `sdk()` wrapper that catches thrown errors and translates to `OpenCodeApiError`/`OpenCodeConnectionError` for caller compatibility. |
| Mock factory scope | 7 | Added explicit Step 0: rewrite `test/helpers/mock-factories.ts` (38 flat methods → namespaced shape). Listed all 13 test files needing updates. |
| Provider model type | 5 | Removed narrow `Record<string, unknown>` cast. Now uses SDK's full `ProviderListResponse` type. Added Task 10 note to verify model field access. |
| SSEEvent heartbeat | 11 | Added `ServerHeartbeatEvent` as 4th gap event in `SSEEvent` superset type. |

## Amendments Applied (v3)

See `2026-04-13-sdk-migration-audit-v3.md` for full analysis. Design pivot: dropped `throwOnError: true` in favor of SDK's default error-returning mode.

| Finding | Tasks | Amendment |
|---------|-------|-----------|
| authFetch strips REST headers (CRITICAL) | 3 | Rewrote authFetch for SDK's single-Request calling convention: pass-through when `input instanceof Request && !init` (auth already on Request from config.headers), add auth manually only for GapEndpoints two-arg calls. |
| HTTP status not extractable (CRITICAL) | 3, 5 | **Dropped `throwOnError: true`**. SDK's default mode returns `{ error, response }` on failure — `response.status` available directly. Replaced `translateSdkError()` (50 lines, couldn't get status) with `toRelayError()` (10 lines, uses response.status). |
| sdk() type signature mismatch | 5 | Broadened `fn` param to `Promise<{ data?: T; error?: unknown; response?: Response }>` — compatible with SDK's default union return type. No compile errors. |
| Test destructuring | 3 | Fixed all 3 tests: `const { client } = createSdkClient(...)`. Added 4th test for authHeaders. |

## Amendments Applied (v4)

See `2026-04-13-sdk-migration-audit-v4.md` for full analysis.

| Finding | Tasks | Amendment |
|---------|-------|-----------|
| GapEndpoints auth missing | 6 | Added explicit construction code to Task 6 passing `headers: authHeaders` to `GapEndpoints`. GapEndpoints calls `fetch(new Request(...))` with one arg — hits authFetch pass-through — so auth must be on the Request via constructor headers. |
