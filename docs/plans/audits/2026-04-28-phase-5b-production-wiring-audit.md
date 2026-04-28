# Phase 5b Production Wiring — Audit Synthesis (Round 5)

> **Date:** 2026-04-28
> **Plan:** `docs/plans/effect-ts-next-wave/phase-5b-production-wiring.md`
> **Auditors:** 8 parallel subagents (one per task: 38, 39, 40, 41+44, 42, 43, 45, 46)
> **Scope:** Standard audit categories + Effect-TS specific patterns

---

## Amend Plan (5)

### AP-1: Static assets blocked by auth gate — breaks login page (Task 40)

**Category:** Incorrect Code / Implicit Assumptions

The plan puts `GET /*` (staticCatchAll) in the **protected** route group behind `withAuthGate`. But the old router (http-router.ts:234) intentionally lets static files fall through the auth gate:

```
// Static files fall through so the login page can load assets
```

When an unauthenticated user visits `/auth`, the explicit public route serves `index.html`. But the HTML references CSS/JS bundles (e.g., `/assets/app.a1b2c3.js`). Those requests hit the static catch-all which is auth-gated → **401 or 302 redirect** → login page can't load its own CSS/JS → broken UI.

**Fix:** Move the static catch-all to the **public** route group, OR add content-hashed asset paths (`/assets/*`) as an exempt pattern before the auth gate. The old router's approach is: auth gate only blocks API routes and browser routes, static files always pass through.

### AP-2: File paths throughout plan are wrong (Tasks 41, 42, 43)

**Category:** Incorrect Code

The plan references files that don't exist at the stated paths:

| Plan says | Actual file |
|---|---|
| `src/lib/effect/daemon-main.ts` | `src/lib/daemon/daemon.ts` |
| `src/lib/effect/daemon-layers.ts` | Does not exist (no layer split) |
| `src/lib/server/effect-http-router.ts` | Does not exist (Phase 5 prerequisite) |
| `src/lib/server/daemon-lifecycle.ts` | `src/lib/daemon/daemon-lifecycle.ts` |

Additionally:
- The plan references `startDaemonProcess` function — the actual code uses a `class Daemon` with methods
- Line number references (e.g., "lines 1076-1115", "lines 1135-1177") don't match `daemon.ts` — the RequestRouter is created at **line 630**, WS upgrade handler at **line 688**
- `DaemonLifecycleContext.router` type (daemon-lifecycle.ts:57-59) is `{ handleRequest(req, res): Promise<void> } | null` — not `ctx.requestHandler`

**Fix:** Update all file paths, line numbers, and function/class references to match the actual codebase. The daemon is class-based (`this.router`, `this.auth`), not functional.

### AP-3: `handler-deps-wiring.ts` takes concrete `WebSocketHandler` class type (Task 43)

**Category:** Non-Strict Typing / Missing Wiring

`HandlerDepsWiringDeps.wsHandler` (handler-deps-wiring.ts:38) is typed as `WebSocketHandler` — the concrete class, not an interface. The bridge object cannot satisfy this type.

Furthermore, the plan's bridge method mapping is incomplete. A grep for `wsHandler.` found **80+ call sites** across:
- `src/lib/handlers/` — instance.ts, agent.ts, settings.ts, model.ts, permissions.ts, prompt.ts, session.ts, tool-content.ts, reload.ts, resolve-session.ts
- `src/lib/relay/` — monitoring-wiring.ts, poller-wiring.ts, sse-wiring.ts, handler-deps-wiring.ts
- `src/lib/session/` — session-switch.ts

The `HandlerDeps.wsHandler` interface (handlers/types.ts:62-70) has: `broadcast`, `sendTo`, `setClientSession`, `getClientSession`, `getClientsForSession`, `sendToSession`. But the bridge also needs: `broadcastPerSessionEvent`, `markClientBootstrapped`, `getClientCount`, `handleUpgrade`, `close`, plus the EventEmitter `.on()` pattern.

**Fix:** 
1. Extract a `WebSocketHandlerShape` interface from `WebSocketHandler` that covers ALL methods used across the codebase
2. Change `HandlerDepsWiringDeps.wsHandler` type from `WebSocketHandler` to `WebSocketHandlerShape`
3. Verify the bridge satisfies both `HandlerDeps.wsHandler` (handlers) and the full shape (wiring files)

### AP-4: `WebSocketHandler` extends `TrackedService` — bridge must register with `ServiceRegistry` (Task 43)

**Category:** Missing Wiring

`WebSocketHandler` extends `TrackedService<WebSocketHandlerEvents>` (ws-handler.ts:89) and its constructor takes `ServiceRegistry` as first parameter (line 110-113). The `ServiceRegistry` is used for daemon health tracking and service lifecycle. The bridge using a plain `EventEmitter` doesn't register with the service registry.

Additionally, `relay-stack.ts:331` passes `serviceRegistry` as the first arg to `new WebSocketHandler(serviceRegistry, ...)`. The bridge creation must either:
- Register with the service registry separately
- Or document why service registry tracking is no longer needed

**Fix:** Add service registry integration to the bridge, or explicitly document in the plan that the bridge opts out of `TrackedService` and explain why this doesn't break daemon health checks.

### AP-5: `ws` import pattern — `createRequire` vs dynamic `import()` (Task 42)

**Category:** Fragile Code

The existing ws-handler.ts (lines 23-28) deliberately uses `createRequire` with a comment explaining why:

```typescript
// Use createRequire to import ws — the ws package is CJS-only and
// named ESM imports behave inconsistently across tsx, vitest, and Node ESM.
const require = createRequire(import.meta.url);
const ws = require("ws");
```

The plan replaces this with `Effect.tryPromise(() => import("ws"))`. While `ws` does have an ESM wrapper (`wrapper.mjs`), the existing comment documents that this approach caused real issues across tsx, vitest, and Node ESM. The plan doesn't acknowledge this known problem.

**Fix:** Either use `createRequire` inside the Effect layer (wrapped in `Effect.sync`), or verify that `import("ws")` works in all three contexts (tsx dev, vitest test, Node ESM production) before relying on it. Document the verification.

---

## Ask User (0)

No findings requiring user decisions.

---

## Accept (6)

### ACC-1: Phase 5 prerequisite modules don't exist yet (All tasks)

The plan states "Prerequisites: Phase 5 complete (M4 merged)" but `src/lib/effect/` directory doesn't exist. Referenced prerequisites (effect-http-router.ts, ws-handler-service.ts, effect-boundary.ts, opencode-response-schemas.ts, ws-message-schemas.ts) are not in the codebase. This is expected — the plan cannot be executed until Phase 5 is merged. Not a plan bug, just a sequencing constraint.

### ACC-2: All test files listed for deletion exist (Task 46)

Confirmed: `server.pbt.test.ts`, `push-routes.test.ts`, `http-router.test.ts`, `ws-handler.pbt.test.ts`, `ws-handler-sessions.test.ts` all exist at the stated paths.

### ACC-3: `static-files.ts` preservation correctly identified (Task 46)

Confirmed: `daemon-lifecycle.ts:22` imports `serveStaticFile` and `tryServeStatic` from `../server/static-files.js`. The plan correctly says DO NOT DELETE.

### ACC-4: `authExemptPaths` configuration exists in daemon.ts (Task 38/40)

The old router receives `authExemptPaths: ["/setup", "/health", "/api/status", "/api/setup-info", "/api/themes"]` from daemon.ts:664. The plan's approach of separating public vs protected route groups implicitly handles this, but the executing agent should verify the exempt list matches.

### ACC-5: `DaemonLifecycleContext.router` interface is minimal (Task 41)

The context expects `{ handleRequest(req, res): Promise<void> }` — the Effect handler just needs to be wrapped in an adapter matching this signature. The plan's R3-41-1 fix correctly identifies this.

### ACC-6: Effect.fn invocation pattern in heartbeat (Task 42)

The plan shows `Effect.fn("ws.heartbeat")(function* () {...})()` with a double-call. The first `()` creates the traced function, the second `()` invokes it. This is syntactically valid but unusual — the executing agent should verify against Effect source that `Effect.fn` returns a callable that returns an Effect when called.

---

## Summary

| Action | Count | Key Issues |
|---|---|---|
| **Amend Plan** | 5 | Auth gate breaks login assets, wrong file paths, bridge type mismatch, TrackedService gap, ws import pattern |
| **Ask User** | 0 | — |
| **Accept** | 6 | Phase 5 prereqs, test files confirmed, static-files preserved |

**Recommendation:** Hand off to plan-audit-fixer for AP-1 through AP-5 before execution.

---

## Amendments Applied (Round 5 Fix)

| Finding | Task | Amendment |
|---------|------|-----------|
| AP-1: Static assets behind auth gate | Task 40 | Moved `staticCatchAll` out of protected routes to public. Added `R5-40-1` note explaining old router behavior. Updated test expectations. |
| AP-2: Wrong file paths | Tasks 41, 44, Goal | Changed `src/lib/effect/daemon-main.ts` → `src/lib/daemon/daemon.ts`. Changed `src/lib/server/daemon-lifecycle.ts` → `src/lib/daemon/daemon-lifecycle.ts`. Updated `startDaemonProcess` → `Daemon.start()` class method. Fixed line numbers (1076→630, 1135→688). Fixed `router`/`auth` to `this.router`/`this.auth`. Added `R5-41-1` and `R5-41-2` notes. |
| AP-3: Concrete WebSocketHandler type | Task 43 | Added Step 0: extract `WebSocketHandlerShape` interface to `ws-handler-shape.ts`. Listed all files needing type import update. Added full interface definition with all methods found via grep (80+ call sites). Added `R5-43-1` note. |
| AP-4: TrackedService/ServiceRegistry gap | Task 43 | Added `R5-43-2` note requiring executing agent to check TrackedService API, verify ServiceRegistry integration needs, and either register bridge or document opt-out. |
| AP-5: ws import via dynamic import() | Task 42 | Replaced `Effect.tryPromise(() => import("ws"))` with `Effect.try(() => createRequire(...))`. Added `createRequire` import. Added `R5-42-1` note documenting known CJS/ESM inconsistency. |

---

## Re-Audit (Round 6) — Verification of Round 5 Amendments

> **Date:** 2026-04-28
> **Scope:** Targeted re-audit of R5-40-1, R5-41-1, R5-41-2, R5-42-1, R5-43-1, R5-43-2

### Amend Plan (1)

**R6-41-1:** R5-41-1 note incorrectly states "class Daemon extends TrackedService" — the actual class is `export class Daemon {` (plain class, no superclass). Fixed inline.

### Accept (7)

1. **R5-40-1 verified:** Static catch-all in public routes is safe. Static files contain no sensitive data (SPA client-side code). All data access goes through auth-gated API routes. Old router behavior (http-router.ts:234) confirmed: static files intentionally bypass auth gate.

2. **R5-41-1/R5-41-2 verified:** File paths now correct (`src/lib/daemon/daemon.ts`, `src/lib/daemon/daemon-lifecycle.ts`). Line numbers approximate but accurate (~630, ~688). `DaemonLifecycleContext.router` type confirmed as `{ handleRequest(req, res): Promise<void> } | null`. The wrapper pattern matches.

3. **R5-42-1 verified:** `createRequire` + `Effect.try` is the correct pattern. `require("ws")` is synchronous, so `Effect.try` (not `Effect.tryPromise`) is right. Project uses ESM (`import.meta.url` works). Pattern matches existing ws-handler.ts:23-28.

4. **R5-43-1 verified:** WebSocketHandlerShape interface is complete for external consumers. `getClientIds()` is only used internally (ws-handler.ts:303) and not by any external consumer — correctly omitted from shape. `IncomingMessageType` is a string union; using `string` in the shape is intentionally wider for forward compatibility.

5. **R5-43-2 verified:** `ServiceRegistry` is simple — only provides `register(Drainable)` and `drainAll()`. `TrackedService` auto-registers and provides `drain()` via `AsyncTracker`. The bridge needs to implement `Drainable.drain()` for graceful shutdown coordination. The R5-43-2 guidance correctly directs the executing agent to investigate and decide.

6. **Event shapes verified:** `client_connected` and `client_disconnected` event callback shapes match `WebSocketHandlerEvents` in ws-handler.ts:56-84. `clientCount` and optional `requestedSessionId`/`sessionId` fields are present.

7. **No stale references:** No remaining mentions of `daemon-main.ts`, `daemon-layers.ts`, `startDaemonProcess`, or `src/lib/server/daemon-lifecycle.ts` outside the corrective R5-41-1 note.

### Summary

| Action | Count |
|---|---|
| **Amend Plan** | 1 (minor: Daemon class inheritance claim — fixed inline) |
| **Ask User** | 0 |
| **Accept** | 7 |

**Result:** All 5 round-5 amendments verified correct. One minor factual error fixed inline (R6-41-1). Audit is clean.
