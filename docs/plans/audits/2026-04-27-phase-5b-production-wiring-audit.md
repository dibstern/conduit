# Audit Synthesis: Phase 5b — Production Wiring

**Plan:** `docs/plans/effect-ts-next-wave/phase-5b-production-wiring.md`
**Date:** 2026-04-27
**Auditors dispatched:** 8 (Tasks 38-46, Task 44 merged into 41)
**Method:** Parallel subagent per task + controller verification

---

## Summary

| Action | Count | Tasks |
|--------|-------|-------|
| **Amend Plan** | 7 | 42, 43, 45, 46 |
| **Ask User** | 1 | 45 |
| **Accept** | 3 | 38, 42, 45 |

The plan already contains extensive AUDIT FIX annotations from prior rounds (R2, R3). This round found **4 new critical issues** not covered by existing annotations, plus confirmed Task 45's full report (3 Amend + 1 Ask User).

---

## Amend Plan Findings

### AP-1: Task 46 deletes `static-files.ts` but `daemon-lifecycle.ts` onboarding server depends on it

**Action:** Amend Plan
**Severity:** Build-breaking
**Evidence:** `src/lib/daemon/daemon-lifecycle.ts:22`:
```typescript
import { serveStaticFile, tryServeStatic } from "../server/static-files.js";
```
Used at lines 259 and 291 for the HTTP onboarding server (pre-TLS setup page serving `/setup` and static assets).

**Problem:** Task 46 lists `src/lib/server/static-files.ts` for deletion. This breaks the onboarding server which is a SEPARATE HTTP server from the main daemon — it runs on plain HTTP before TLS is configured.

**Recommendation:** Either:
- (a) Keep `static-files.ts` alive (remove from Task 46 delete list), OR
- (b) Migrate the onboarding server to use `serveStaticFile` from `static-file-handler.ts` (Effect version) — but this requires the onboarding server to run Effect, which may be overkill for a simple setup page, OR
- (c) Extract the 2 functions (`serveStaticFile`, `tryServeStatic`) as a tiny Node-native utility (no Effect dependency) that both the onboarding server and legacy paths can use

---

### AP-2: Task 43 bridge is missing critical methods — `.on()` event system, `handleUpgrade`, `close`, `sendToSession`, `getClientsForSession`

**Action:** Amend Plan
**Severity:** Incomplete bridge — runtime failures
**Evidence:** Full `wsHandler.` method usage across relay files:

| Method | Used in |
|--------|---------|
| `broadcast(msg)` | monitoring, session-lifecycle, sse-wiring, timer, pty-upstream |
| `sendTo(clientId, msg)` | handler-deps-wiring |
| `sendToSession(sessionId, msg)` | monitoring-wiring:131, sse-wiring:365,578 |
| `getClientsForSession(sessionId)` | monitoring-wiring:145, poller-wiring:81, sse-wiring:382 |
| `broadcastPerSessionEvent(sessionId, msg)` | event-pipeline:180 |
| `handleUpgrade(req, socket, head)` | relay-stack:757,766 |
| `close()` | relay-stack:549 |
| `on("client_connected", cb)` | handler-deps-wiring:119 |
| `on("client_disconnected", cb)` | handler-deps-wiring:131 |
| `on("message", cb)` | handler-deps-wiring:201 |
| `markClientBootstrapped` | (referenced in event-pipeline comments) |

**Plan currently bridges:** broadcast, sendTo, broadcastPerSessionEvent, markClientBootstrapped, getClientCount, bindClientSession

**Missing from plan:** `handleUpgrade`, `close`, `sendToSession`, `getClientsForSession`, `on("client_connected")`, `on("client_disconnected")`, `on("message")`

The `.on()` methods come from `TrackedService` base class — an event emitter pattern. The bridge must either:
- Replicate with a simple EventEmitter or Effect PubSub
- Or rewire handler-deps-wiring.ts to use callbacks/hooks instead of events

**Recommendation:** Add complete method list to plan. Bridge section must cover all 11 methods/events. The event system is the hardest part — add explicit design for it.

---

### AP-3: Task 42 heartbeat cannot access `ping()`/`terminate()` through `WsConn` interface

**Action:** Amend Plan
**Severity:** Heartbeat won't compile
**Evidence:** `ws-handler-service.ts` WsConn interface:
```typescript
export interface WsConn {
  send(data: string): void;
  readyState: number;
  close(code?: number, reason?: string): void;
}
```

The heartbeat protocol requires `ws.WebSocket.ping()` and `ws.WebSocket.terminate()`. These are NOT on `WsConn`.

**Existing annotation R2-42-2** flags this but doesn't specify the fix.

**Recommendation:** Extend the plan with concrete solution:
```typescript
// Option A: Extend WsConn interface
export interface WsConn {
  send(data: string): void;
  readyState: number;
  close(code?: number, reason?: string): void;
  ping?(): void;        // Optional — only present on real ws.WebSocket
  terminate?(): void;   // Optional — only present on real ws.WebSocket
}

// Option B: Store raw socket alongside WsConn in ClientState
export interface ClientState {
  ws: WsConn;
  rawSocket: import("ws").WebSocket; // For heartbeat access
  // ...
}
```

Option A is cleaner — optional methods with runtime feature detection.

---

### AP-4: Task 45 wrong import path (from Task 45 auditor report)

**Action:** Amend Plan
**Severity:** Compile error
**Detail:** Plan snippet uses `import { RelayMessageSchema } from "../shared-types.js"` in runtime.ts. Correct path is `../../shared-types.js` — runtime.ts is at `src/lib/frontend/transport/runtime.ts`, two levels below `src/lib/`.

**Note:** The existing plan text (AUDIT FIX R2-45-1) already says correct path is `../../effect-boundary.js` for the decoder import. But the Schema import for the type is separate and also wrong in the plan's inline code.

---

### AP-5: Task 45 empty test skeletons (from Task 45 auditor report)

**Action:** Amend Plan
**Severity:** No test coverage for validation integration
**Detail:** `wsMessageStream with validation` describe block contains only comments. Plan must provide at minimum:
1. Mock WebSocket that emits MessageEvents
2. Assertions consuming the stream
3. Invalid JSON → silently skipped
4. Unknown type → passes through
5. Malformed known type → defined behavior

---

### AP-6: Task 45 `as RelayMessage` cast hides validation failures (from Task 45 auditor report)

**Action:** Amend Plan
**Severity:** Type safety hole defeats purpose of validation
**Detail:** When decode fails, `raw` (which FAILED validation) is cast `as RelayMessage`. Downstream code assumes valid shape. Should either:
- Drop invalid messages (log + skip)
- Or make the unsafety explicit: cast only on Right branch, use `unknown` on Left with runtime `type` field check

---

## Ask User Findings

### AU-1: Task 45 — `effect-boundary.ts` becomes dead code after this task

**Action:** Ask User
**Detail:** Phase 5 Task 36 created `effect-boundary.ts` with async lazy-load decoder. Task 45 creates a separate synchronous eager decoder in `runtime.ts`. After Task 45, `effect-boundary.ts` `validateIncomingMessage` is never imported in production.

**Options:**
- (a) Delete `effect-boundary.ts` in Task 45 or 46
- (b) Keep as alternative entry point for future consumers
- (c) Refactor Task 45 to import decoder from `effect-boundary.ts` instead of duplicating

**Note:** The plan already has annotation R2-45-ASK-1 saying "effect-boundary.ts is kept and used — it is the decoder source." But looking at the actual plan code, Task 45 adds `preloadDecoder` and `decodeMessage` exports TO `effect-boundary.ts` itself, not duplicating it. So this may be a non-issue IF the plan's Step 2 is read carefully — it modifies effect-boundary.ts rather than creating a parallel decoder. **Re-reading the plan confirms: the modifications go INTO effect-boundary.ts.** The auditor may have misread. Downgrade to Accept if confirmed.

---

## Accept Findings

### AC-1: Task 38 — Prior audit fixes comprehensive

The plan already has thorough AUDIT FIX annotations for auth middleware (R2-38-3 test requirements, R3-38-1 non-consuming PIN check, A38-2 HttpServerResponse API). No new issues found beyond what's annotated.

### AC-2: Task 42 — `Schedule.spaced` takes Duration, not string

Already annotated (R2-42-3). Correct usage is `Schedule.spaced(30_000)` or `Schedule.spaced(Duration.millis(30_000))`.

### AC-3: Task 45 — Schema-derived type and manual RelayMessage can diverge

Pre-existing tech debt. `RelayMessageSchema` and `RelayMessage` type union maintained in parallel with no `Schema.Type<>` derivation. Not introduced by this task.

---

## Cross-Task Observations

1. **Atomic groups are correct.** Tasks 38-41 must merge together (HTTP path replacement). Tasks 42-43 must merge together (WS transport replacement). Confirmed by code analysis.

2. **The plan already has ~20 AUDIT FIX annotations from rounds R2 and R3.** These are well-targeted and address real issues. This round found fewer new issues — the plan is maturing.

3. **Task 43 is the highest-risk remaining task** due to the event emitter bridge complexity. The `TrackedService.on()` pattern is deeply wired into `handler-deps-wiring.ts` and drives client lifecycle management.

4. **`@effect/platform-node` not installed yet.** The `node_modules/@effect/platform-node` directory doesn't exist in the main branch. This is expected — Phase 5 would have added it. But the executing agent must verify it's in the worktree/branch dependencies.

---

## Amendments Applied (Round 4)

| Finding | Task | Amendment |
|---------|------|-----------|
| AP-1 | 46 | Removed `static-files.ts` from deletion list; added note that onboarding server depends on it; fixed verification grep expectation |
| AP-2 | 43 | Added COMPLETE bridge method mapping (11 methods/events); added event emitter bridge design with code example; added handler-deps-wiring.ts to files list |
| AP-3 | 42 | Resolved R2-42-2 with concrete WsConn extension: optional `ping?()` and `terminate?()` methods |
| AP-4 | 45 | FALSE POSITIVE — plan already has correct import path `../../effect-boundary.js`. Auditor referenced non-existent snippet. No change. |
| AP-5 | 45 | Strengthened R2-45-3 → R4-45-1 with MockWebSocket class pattern and 7 specific assertions |
| AP-6 | 45 | Added R4-45-2 explaining `as RelayMessage` is intentional for forward compat; added verification instruction for downstream null safety |
| AU-1 | 45 | RESOLVED by user — effect-boundary.ts IS used (plan modifies it, doesn't duplicate). Downgraded to Accept. |
