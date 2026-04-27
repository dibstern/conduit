# Phase 5b Audit Synthesis

8 auditors dispatched across Tasks 38-46. Findings below.

## Amendments Applied (Round 1)

| Finding | Task | Amendment |
|---------|------|-----------|
| A38-1 | 38 | Added `attemptsLeft: auth.getRemainingAttempts(ip)` to 401 response |
| A38-2 | 38 | Replaced `setHeader` chain with `headers` option in `json()`. Added verification note |
| A39-1 | 39 | Added `Effect.catchTag("SystemError", ...)` returning 500 for FS errors |
| A39-2 | 39 | Added verification note for `HttpServerResponse.uint8Array` with alternatives |
| A40-1 | 40 | Added verification note for `HttpRouter.del` vs `.delete` |
| A40-2 | 40 | Added route ordering note: specific routes before catch-all |
| A41-1 | 41 | Added verification note for `NodeHttpServer.makeHandler` signature |
| A41-2 | 41 | Added explicit relay-stack standalone mode handling instructions |
| A44-1 | 44→41 | Merged Task 44 into Task 41 (auth check + HTTP stack in same commit) |
| U45-1 | 45 | Changed to synchronous eager import per user decision (approach 2) |

---

## Amend Plan (9)

### Task 38: Auth middleware

**A38-1: Missing `attemptsLeft` in auth failure response.**
Plan's `authRoute` returns `{ ok: false }` on wrong PIN. Old `http-router.ts` returns `{ ok: false, attemptsLeft: auth.getRemainingAttempts(ip) }`. Frontend relies on this field.
→ Add `attemptsLeft` to 401 response in authRoute.

**A38-2: `HttpServerResponse.setHeader` return pattern wrong.**
Plan chains `HttpServerResponse.setHeader(...)` inside `Effect.map`. The actual API returns a new response — verify whether `setHeader` is a function on the response or a standalone combinator. The executing agent must check the `@effect/platform` API.
→ Mark as "verify API at implementation time" with both patterns shown.

### Task 39: Static file handler

**A39-1: `PlatformError` from FileSystem operations is unhandled.**
`fs.exists`, `fs.stat`, `fs.readFile` can fail with `PlatformError` (permission denied, etc.). Plan doesn't catch these — they'd bubble as unhandled errors in the router. Old code has try/catch.
→ Add `Effect.catchTag("SystemError", ...)` that returns 500 for unexpected FS errors.

**A39-2: `HttpServerResponse.uint8Array` may not exist.**
Need to verify `@effect/platform` has this constructor. Alternative: `HttpServerResponse.raw(content)` or `HttpServerResponse.file(path)`.
→ Mark as "verify API" — the executing agent must check actual exports.

### Task 40: Complete Effect router

**A40-1: `HttpRouter.del` may not exist.**
The Effect `HttpRouter` module uses `HttpRouter.get`, `HttpRouter.post`, etc. The DELETE method may be `HttpRouter.delete` or `HttpRouter.del`. Must verify.
→ Executing agent must check `HttpRouter` exports for DELETE method.

**A40-2: Route ordering — catch-all `/*` will shadow `/p/:slug/*`.**
In Effect router, route registration order matters. If `staticCatchAll` (`GET /*`) is registered before `projectRoute` (`GET /p/:slug/*`), the catch-all matches first. Plan composition must ensure specific routes come before catch-all.
→ Add explicit ordering note: projectRoute before staticCatchAll.

### Task 41: Replace daemon HTTP stack

**A41-1: `NodeHttpServer.makeHandler` signature needs verification.**
The plan uses `NodeHttpServer.makeHandler(effectRouterWithCors, routerLayer)` but the actual API may differ. The function might take `(httpApp)` and return a Node `(req, res) => void` handler. Layer provision may need to happen differently.
→ Executing agent must read `@effect/platform-node/NodeHttpServer` exports.

**A41-2: relay-stack.ts standalone mode breaks when server.ts is deleted.**
`createRelayStack` (line 824-831) creates `RelayServer` for standalone (non-daemon) mode. Deleting server.ts breaks this. Plan mentions this but doesn't provide a solution.
→ Add explicit handling: either inline minimal server creation in relay-stack, or use Effect HTTP server for standalone mode too.

### Task 44: WS upgrade handler

**A44-1: Task ordering creates compile-broken state.**
Plan says Tasks 38-41 are ATOMIC. Task 41 deletes `http-router.ts` which removes the `router` variable. Task 44 (listed after Tasks 42-43) replaces the `router?.checkAuth(req)` call. Between Task 41 and Task 44, the code won't compile.
→ Move Task 44's auth check replacement INTO Task 41 (they're in the same atomic unit). Remove Task 44 as standalone.

---

## Ask User (1)

### Task 45: Frontend validation

**U45-1: Async validation reorders messages.**
`validateIncomingMessage` is async (lazy import). Using `.then()` in the stream callback can reorder messages if the first call takes longer (schema import). The plan offers two alternatives: (1) async with `.then()` or (2) synchronous with eager import. Option 2 adds ~50KB to main bundle but guarantees ordering. Option 1 saves bundle size but risks first-message reordering.
→ User decision: bundle size vs message ordering guarantee.

---

## Accept (5)

**T38-accept: Cookie parsing reimplemented.** Plan writes its own `parseCookies`. Acceptable — it's 6 lines, no npm dependency needed.

**T39-accept: MIME_TYPES moved from http-router.ts.** Clean relocation, no functional change.

**T42-accept: Dynamic `import("ws")` in Effect Layer.** Pragmatic approach to avoid bundling ws in frontend. The ws package is always available server-side.

**T42-accept: Heartbeat ping uses `(client.ws as any).ping?.()`.** The `ws` library's `ping()` method isn't on the standard WebSocket interface. The `as any` cast is necessary here.

**T46-accept: `daemon-lifecycle.ts` imports from `static-files.ts` for onboarding server.** The onboarding server (port+1, TLS setup page) also serves static files. When `static-files.ts` is deleted, the onboarding server needs updating. This is minor — either keep `static-files.ts` for onboarding or convert onboarding to use Effect static handler.
