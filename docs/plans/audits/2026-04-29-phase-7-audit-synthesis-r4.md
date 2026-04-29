# Phase 7 Audit Synthesis — Round 4 (2026-04-29)

Dispatched 8 auditors across 11 tasks (grouped: 1-2, 3, 4-5, 6, 7-8, 9-10, 11, Effect-TS compliance). Each auditor investigated actual branch state at `.worktrees/effect-ts-migration/` and verified Effect 3.21.2 APIs against installed type definitions.

---

## Amend Plan (7 findings)

### AP-R4-1 — Task 3: existing `Date.now()` in `addInstance` not fixed

**File:** `src/lib/effect/instance-manager-service.ts:106`
**Issue:** The plan adds new code using `Clock.currentTimeMillis` (correct), but the existing `addInstance` function at line 106 still uses `Date.now()`. Tests using `TestClock` will produce incorrect timestamps from `addInstance` because `Date.now()` ignores TestClock adjustments.
**Fix:** Replace `Date.now()` at line 106 with `yield* Clock.currentTimeMillis` (requires making `addInstance` an Effect.gen if not already).

### AP-R4-2 — Task 3: tests need `it.scoped`, not `it.effect`

**API verified:** `FiberMap.make<K>()` returns `Effect.Effect<FiberMap<K, A, E>, never, Scope.Scope>` (FiberMap.d.ts:64).
**Issue:** Task 3 tests use `it.effect` but the test Layer includes `FiberMap.make()` which requires `Scope.Scope`. Without `it.scoped`, the Scope requirement is unsatisfied and tests will fail.
**Fix:** Change all `it.effect` in Task 3 tests to `it.scoped`. Update the test code:
```typescript
// WRONG (from plan):
it.effect("detects healthy instance", () => ...)
// RIGHT:
it.scoped("detects healthy instance", () => ...)
```

### AP-R4-3 — Task 6: `makeDaemonLive` already exists — plan must modify, not create

**File:** `src/lib/effect/daemon-layers.ts:320-376`
**Issue:** `makeDaemonLive(options: DaemonLiveOptions)` already exists with comprehensive composition: infrastructure (signal handlers, error handlers, PID file), servers (HTTP, IPC, onboarding), background services, state, DaemonEventBusLive, PinoLoggerLive, and optional relay cache. The plan proposes a simpler `DaemonLive` Layer that omits servers, signal handlers, error handlers, PID file management, and relay cache.
**Fix:** Task 6 should modify the existing `makeDaemonLive` to use `Layer.launch` as the entry point, not create a parallel composition. Add a step: "Read existing `makeDaemonLive` in daemon-layers.ts. Modify the caller in daemon-main.ts to use `Layer.launch(makeDaemonLive(options))` instead of imperative startup."

### AP-R4-4 — Task 6: `DaemonLiveOptions` takes imperative types incompatible with `Layer.launch`

**File:** `src/lib/effect/daemon-layers.ts:284-307`
**Issue:** `DaemonLiveOptions` requires `DaemonLifecycleContext`, `DaemonIPCContext`, `OnboardingServerDeps`, and a `getStatus: () => DaemonStatus` callback — all imperative types from old modules. The plan says "use `Layer.launch(DaemonLive)`" but `Layer.launch` expects a fully self-constructing Layer. The current `makeDaemonLive` is called with imperative values extracted from the 1540-line `daemon-main.ts` startup sequence.
**Fix:** Task 6 needs an explicit step to either: (a) convert `DaemonLiveOptions` fields into Layers/Tags so `makeDaemonLive` becomes self-constructing, or (b) keep the imperative construction for now and defer `Layer.launch` until Task 8 deletes the old lifecycle code. Option (b) is lower risk.

### AP-R4-5 — Task 7: deleting `HandlerDeps` breaks `resolveSession`

**File:** `src/lib/handlers/resolve-session.ts` (3 occurrences of `HandlerDeps`)
**Issue:** `resolveSession` and `resolveSessionForLog` depend on `HandlerDeps`. Task 7 Step 3 says "Delete `HandlerDeps` interface from types.ts." This will break resolve-session.ts (exported from index.ts line 12, used by terminal.ts and other handler files).
**Fix:** Add a sub-step to Task 7: "Convert `resolveSession` and `resolveSessionForLog` to use Effect Tags instead of `HandlerDeps` before deleting the type." Alternatively, retain `HandlerDeps` as a narrower type until all consumers are converted.

### AP-R4-6 — Task 8: `daemon-layers.ts` imports old modules planned for deletion

**File:** `src/lib/effect/daemon-layers.ts:8-25`
**Issue:** `daemon-layers.ts` imports from:
- `daemon-lifecycle.js` — `closeHttpServer`, `closeIPCServer`, `startHttpServer`, `startIPCServer`, `startOnboardingServer`, `closeOnboardingServer`, `DaemonLifecycleContext`, `OnboardingServerDeps`
- `daemon-ipc.js` — `DaemonIPCContext`
- `session-overrides.js` — `SessionOverrides`

Task 8 says "Delete `daemon-lifecycle.ts`" and "Delete `daemon-ipc.ts`". But `daemon-layers.ts` (modified in Task 6, retained) still imports from them. Deleting those files will break compilation.
**Fix:** Task 8 must either (a) first replace imports in daemon-layers.ts with Effect-native alternatives (e.g., the HTTP/IPC server Layers from Phase 5), or (b) exclude daemon-lifecycle.ts and daemon-ipc.ts from deletion, noting they're retained as thin wrappers until fully replaced.

### AP-R4-7 — Task 9: wiring Layers not composed into any Layer tree

**Issue:** Task 9 produces 5 new Layers (PermissionTimeoutLive, session lifecycle Layer, poller Layer, monitoring Layer, SSE Layer) but no step shows composing them into the relay or daemon Layer tree. Without wiring, they exist as dead code.
**Fix:** Add a step to Task 9: "Add all wiring Layers to `RelayStateLive` in `relay-layer.ts` (from Task 5). Use `Layer.mergeAll` since they are independent." Example:
```typescript
export const RelayStateLive = Layer.mergeAll(
  // ...existing state layers...
  PermissionTimeoutLive,
  SessionLifecycleWiringLive,
  PollerWiringLive,
  MonitoringWiringLive,
  SSEWiringLive,
);
```

---

## Accept (12 findings)

1. **Task 1** — Blocked module list correctly identifies daemon-main.ts as imperative consumer of old classes (PortScanner, VersionChecker, KeepAwake, StorageMonitor). AP-R2-1 fix is accurate.
2. **Task 2** — `session-overrides-state.ts` exports all 4 timer functions (`startProcessingTimeout`, `resetProcessingTimeout`, `clearProcessingTimeout`, `hasActiveProcessingTimeout`). Verification-only task is appropriate.
3. **Task 3** — `HashMap.modify` silently no-ops on missing key (safe for concurrent instance removal during health poll).
4. **Task 3** — `publishInstanceStatusChanged` helper already exists in daemon-pubsub.ts. `DaemonEvent` variants include `InstanceStatusChanged`.
5. **Task 4** — All 8 listed `make*Live()` exports verified on branch. `PtySessionState` type exists in pty-manager.ts.
6. **Task 5** — `RelayStateLive` concept is sound. All referenced Layer factories exist.
7. **Task 7** — Dual Promise/Effect handler pattern confirmed across all 14 handler files. `EFFECT_MESSAGE_HANDLERS` dispatch table and `dispatchMessageEffect` function both exist in index.ts.
8. **Task 9** — All 5 wiring files exist: timer-wiring.ts, session-lifecycle-wiring.ts, poller-wiring.ts, monitoring-wiring.ts, sse-wiring.ts.
9. **Task 9** — `Layer.scopedDiscard` confirmed in Effect 3.21.2 (Layer.d.ts:889). Plan's usage is correct.
10. **Task 10** — `orchestration-service.ts` exists with `IdempotencySetTag` + `makeIdempotencySetLive()`. Extending is correct approach.
11. **Task 11** — `metrics.ts` has exactly 7 metrics as claimed. `Metric.increment` works with both Counter and Gauge (Metric.d.ts:405). `Metric.histogram` with `MetricBoundaries.exponential` confirmed.
12. **Effect-TS** — `Layer.launch` confirmed: `(self: Layer<ROut, E, RIn>) => Effect.Effect<never, E, RIn>` (Layer.d.ts:549). Plan's usage is semantically correct.

---

## Effect-TS Skill Compliance Summary

The plan follows Effect-TS best practices in the following areas:
- `Data.TaggedEnum` for DaemonEvent discriminated union
- `FiberMap` for managed fiber collections (replaces manual Map + interrupt)
- `Effect.tryPromise` for rejectable fetch (health check)
- `Effect.annotateLogs` for entity IDs (instanceId, sessionId)
- `Clock.currentTimeMillis` for TestClock-compatible timestamps (in new code)
- `HashMap` in Refs (structural sharing)
- `Layer.provide` for deps, `Layer.mergeAll` for independent
- `Layer.fresh` in tests for state isolation
- `@effect/vitest` (`it.effect` / `it.scoped`) test patterns
- `Effect.forkScoped` for background tasks (not `forkDaemon`)
- `{ discard: true }` on `Effect.forEach` when returns ignored
- `Schedule.spaced` for periodic polling

**One compliance gap found:** existing `Date.now()` in instance-manager-service.ts:106 (AP-R4-1).
**One test pattern issue:** `it.effect` should be `it.scoped` when FiberMap is in scope (AP-R4-2).

---

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| AP-R4-1 | Task 3 | Added Step 0: fix existing `Date.now()` → `Clock.currentTimeMillis` in `addInstance` |
| AP-R4-2 | Task 3 | Changed all `it.effect` to `it.scoped` in test code; added note explaining Scope requirement |
| AP-R4-3 | Task 6 | Rewrote Steps 1-3: modify existing `makeDaemonLive`, not create from scratch |
| AP-R4-4 | Task 6 | Added phased approach: keep imperative `DaemonLiveOptions` construction, use `Layer.launch(makeDaemonLive(options))` as entry |
| AP-R4-5 | Task 7 | Added Step 3: convert `resolveSession`/`resolveSessionForLog` to Effect Tags before deleting `HandlerDeps` |
| AP-R4-6 | Task 8 | Marked `daemon-lifecycle.ts` and `daemon-ipc.ts` as RETAIN — still imported by daemon-layers.ts |
| AP-R4-7 | Task 9 | Added Step 6: compose wiring Layers into `RelayStateLive` in relay-layer.ts |
