# Phase 8: Testing Gaps & Recommended Tests

> Generated after completing all 12 Phase 8 implementation tasks.

## Summary

Phase 8 added ~60 new tests across 10 test files. Most individual modules are well-tested. The major gaps are in **integration testing** (full Layer composition), **scoped fiber lifecycle**, and **three stub Layers** that need real implementation tests.

---

## Well-Tested Modules (no action needed)

| Module | Test File | Coverage |
|--------|-----------|----------|
| DaemonConfigRef | `daemon-config-ref.test.ts` | 4 tests — init, update, seeding, Set isolation |
| ConfigPersistenceLive | `config-persistence-layer.test.ts` | 4 tests — debounce, coalescing, filtering, state snapshot |
| AuthManagerFromConfigLive | `auth-manager-layer.test.ts` | 8 tests — reactive pinHash, auth flows, CrashCounter |
| TlsCertLive | `tls-cert-layer.test.ts` | 5 tests — disabled, null, throw, host update, explicit host |
| InstanceManager (new methods) | `instance-manager-service.test.ts` | 11 tests — start/stop/update, URLs, persistConfig |
| RelayFactoryLive | `relay-factory-layer.test.ts` | 10 tests — HttpServerRef, factory creation, error paths |
| IPC Handlers | `ipc-handlers.test.ts` | Updated — KeepAwake/ConfigRef/Shutdown delegation |

---

## Critical Gaps (P0 — blocks production confidence)

### 1. WebSocketRoutingLive — NO tests

**File:** `src/lib/effect/ws-routing-layer.ts`
**Current state:** Structural stub — declares deps but upgrade handler is deferred.

**Recommended tests (scoped integration):**
- WS upgrade succeeds when no PIN set
- WS upgrade succeeds with valid cookie
- WS upgrade rejected + socket destroyed on auth failure
- WS upgrade rejected when `shuttingDown` is true
- Relay wait timeout (10s) returns 503 to socket
- `ensureRelayStarted` called for lazy relay startup
- `touchLastUsed` called on successful upgrade

**Test type:** `it.scoped` with mock HTTP server, mock socket, mock AuthManagerTag, mock ProjectRegistryTag. TestClock for timeout.

### 2. ProjectDiscoveryLive — minimal coverage

**File:** `src/lib/effect/project-discovery-layer.ts`
**Current tests:** Layer builds without error, discovers 0 when no instances (trivial).

**Missing tests (Effect integration):**
- Discovery with mock OpenCode API returning 3 projects → 3 registered
- `dismissedPaths` filtering — dismissed dirs are skipped
- Error-state project reset for lazy retry
- API fetch failure → graceful degradation (0 projects, no crash)
- Duplicate directory → skipped (not double-registered)

**Test type:** `it.scoped` with `InstanceManagerStateTag` pre-seeded with a mock instance, `ProjectRegistryTag` Ref for verification. Mock fetch via dependency injection.

### 3. SessionPrefetchLive — minimal coverage

**File:** `src/lib/effect/session-prefetch-layer.ts`
**Current tests:** Layer builds, prefetches 0 when empty (trivial).

**Missing tests (scoped fiber):**
- Prefetch with 2 projects, mock fetch returning session counts → `persistedSessionCounts` updated
- Instance not found → skipped gracefully
- Fetch failure → per-project error isolation (other projects still prefetched)
- Auth header construction (Basic auth with env credentials)

**Test type:** `it.scoped` with pre-seeded ProjectRegistry + InstanceManager. Mock `fetch` via `vi.stubGlobal`.

### 4. makeDaemonLive full composition — NO integration test

**File:** `src/lib/effect/daemon-layers.ts`
**Current tests:** Individual layer tests only (signal handler, error handler, ShutdownAwaiter).

**Missing test (integration):**
- All 6 tiers compose without type errors
- All Tags resolvable from composed Layer
- Scope close tears down in reverse order
- Background service fibers are interrupted on scope close

**Test type:** `it.scoped` building the full `makeDaemonLive(options)` with mock server Layers. Verify each Tag is resolvable via `Context.get`. This is the single most valuable test to add.

---

## High Priority Gaps (P1 — high confidence needed)

### 5. Scoped fiber lifecycle across WS/Discovery/Prefetch

**Gap:** No tests verify that `Effect.forkScoped` fibers are actually interrupted on scope close.

**Recommended test:**
```typescript
it.scoped("fibers are interrupted on scope close", () =>
  Effect.gen(function* () {
    // Build layer with long-running stub
    // Close scope
    // Verify fiber was interrupted (via Deferred side-effect)
  })
);
```

### 6. daemon-startup probe/convert stubs

**Files:** `daemon-startup.ts` — `probeAndConvert`, `detectSmartDefault`
**Gap:** Placeholder implementations with `// TODO` comments.

**Recommended:** Unit tests with mocked HTTP responses for probe behavior.

### 7. Shutdown signal integration

**Gap:** No test verifies full lifecycle: start → SIGTERM → ShutdownAwaiterLive fires → Layers tear down.

**Recommended test:**
```typescript
it.scoped("shutdown signal triggers teardown", () =>
  Effect.gen(function* () {
    const shutdown = yield* ShutdownSignalTag;
    yield* Deferred.succeed(shutdown, void 0);
    // Verify teardown order via finalizer side-effects
  })
);
```

---

## Robustness Gaps (P2)

### 8. Debounce stress test

**Gap:** Only 5 events tested. No boundary conditions.

**Recommended:** Property-based test with 100+ rapid `ConfigChanged` events → exactly 1 write.

### 9. Config persistence error paths

**Gap:** No test for `ConfigWriterTag.write` failure.

**Recommended:** Mock writer that returns `Effect.fail(...)`, verify `logWarning` is called and no crash.

### 10. AuthManager reactive pinHash under concurrent updates

**Gap:** No concurrent read/write test for `DaemonConfigRef` pinHash.

**Recommended:** Fork 10 fibers updating pinHash while 10 fibers call `auth.authenticate()`. Verify no stale reads.

---

## Test Type Guide

| Gap Category | Test Type | Why |
|---|---|---|
| Layer builds correctly | `it.scoped` + `Layer.build` | Verifies scoped resource lifecycle |
| Fiber interrupted on close | `it.scoped` + `Deferred` flag | Side-effect verification |
| Debounce/timing | `it.effect` + `TestClock.adjust` | Deterministic time control |
| Error isolation | `it.effect` + mock services | Verify partial failure handling |
| Full composition | `it.scoped` + `makeDaemonLive(mockOpts)` | Integration verification |
| Concurrent safety | `it.effect` + `Effect.fork` + many fibers | Race condition detection |
