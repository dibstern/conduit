# Phase 7 — Remaining Migration — Audit Synthesis (Round 2)

**Audited:** 2026-04-28
**Round:** 2 (re-audit after Round 1 fixes)
**Auditors dispatched:** 7 (Task 1, Task 3, Tasks 4-5, Tasks 6-7, Tasks 8-9, Tasks 10-11, Effect-TS compliance)
**Reports written:** 1 of 7 (Tasks 4-5 wrote full report; others completed investigation but did not produce files — findings reconstructed via targeted verification)

---

## Amend Plan (16 findings)

### AP-R2-1: Task 1 — daemon-main.ts consumes old classes, deletion unsafe

**Source:** Task 1 auditor + verification
**Issue:** `daemon-main.ts` (an Effect module at `src/lib/effect/daemon-main.ts`, 1540 lines) directly instantiates `new PortScanner(...)`, `new VersionChecker(...)`, `new KeepAwake(...)`, `new StorageMonitor(...)`. Task 1's grep pattern (`rg "from.*daemon/port-scanner"`) would classify daemon-main.ts as an "Effect module consumer," making these old modules appear safe to delete — but daemon-main.ts is the active production entry point that **creates and uses** these old classes.
**Fix:** Task 1 must classify daemon-main.ts as a blocking consumer (same category as relay-stack.ts). Port-scanner, storage-monitor, version-check, and keep-awake modules are NOT deletable until Task 6 converts daemon-main.ts to use the Effect Layer replacements. Add daemon-main.ts to the "blocked" list in Step 3.

### AP-R2-2: Task 3 — DaemonEvent shape mismatch (plain objects vs TaggedEnum)

**Source:** Task 3 auditor + verification
**Issue:** Plan's code publishes events as plain objects:
```typescript
yield* PubSub.publish(eventBus, {
  type: "instance_status_changed", instanceId, oldStatus, newStatus
});
```
But `DaemonEventBusTag` is typed as `PubSub<DaemonEvent>` where `DaemonEvent` is a `Data.TaggedEnum`. The correct constructor is `DaemonEvent.InstanceStatusChanged({ instanceId })`. Additionally, the `InstanceStatusChanged` variant only has `instanceId: string` — no `oldStatus`/`newStatus` fields.
**Fix:** Replace all `PubSub.publish(eventBus, { type: ... })` calls with the existing publisher helpers from `daemon-pubsub.ts`:
- Status change: `yield* publishInstanceStatusChanged(instanceId)` — OR extend the `InstanceStatusChanged` variant to include `oldStatus`/`newStatus` fields
- Error: see AP-R2-3

### AP-R2-3: Task 3 — "instance_error" event type doesn't exist in DaemonEvent enum

**Source:** Task 3 auditor + verification
**Issue:** `scheduleRestart` publishes `{ type: "instance_error", instanceId, error }` but the `DaemonEvent` TaggedEnum has no `InstanceError` variant. Current variants: `StatusChanged`, `VersionUpdate`, `InstanceAdded`, `InstanceRemoved`, `InstanceStatusChanged`, `DiskSpaceLow`, `DiskSpaceOk`.
**Fix:** Add `InstanceError: { readonly instanceId: string; readonly error: string }` variant to `DaemonEvent` in `daemon-pubsub.ts`, plus a `publishInstanceError` helper. OR use `Effect.logError` without PubSub if no subscribers need this event.

### AP-R2-4: Task 3 — `startInstance` function doesn't exist

**Source:** Verification
**Issue:** `scheduleRestart` calls `yield* startInstance(instanceId)` but `instance-manager-service.ts` only exports: `addInstance`, `removeInstance`, `getInstance`, `getInstances`. There is no `startInstance` function.
**Fix:** Either (a) define `startInstance` that re-invokes the instance process and resets status to "starting", or (b) reference the correct existing function (perhaps `addInstance` with a restart flag). The plan must specify the restart mechanism.

### AP-R2-5: Task 3 — `Date.now()` untestable under TestClock

**Source:** Effect-TS compliance auditor + skill reference (testing.md lines 77-86)
**Issue:** `scheduleRestart` uses `const now = Date.now()` for restart window timestamps. Per the testing reference: "If production code uses `Date.now()`, it becomes untestable under TestClock." The test for "gives up after maxRestartsPerWindow exceeded" would need real time to pass, defeating TestClock determinism.
**Fix:** Replace `Date.now()` with `yield* Clock.currentTimeMillis` throughout. Import `Clock` from `effect`.

### AP-R2-6: Task 4 — Dual-Tag architecture type incompatibility

**Source:** Tasks 4-5 report (findings #1-5)
**Issue:** Every service listed for conversion has TWO Tags on the branch:
- *Bridge Tag* (e.g., `SessionRegistryTag` typed to imperative `SessionRegistry` class with sync methods like `setClientSession(): void`)
- *Effect-native state Tag* (e.g., `SessionRegistryStateTag` typed to `Ref<HashMap>`)

The plan's `*Live` Layer code returns Effect-based methods (`Ref.update(...)` returning `Effect<void>`), but the bridge Tag service types expect sync return types (`void`, `string | undefined`). This won't compile.
**Fix:** Plan must explicitly address the dual-Tag architecture. The `*Live` Layers should provide the *Effect-native state Tags* (which already have Effect-compatible types), NOT the bridge Tags. The bridge Tags are deleted in Task 8. Update Task 4 to create `*Live` Layers for the state Tags, and update Task 5's `RelayServiceLive` to compose state Tags.

### AP-R2-7: Task 4 — `SessionManagerServiceLive` name collision

**Source:** Tasks 4-5 report (finding #6)
**Issue:** `session-manager-service.ts:173` already exports `SessionManagerServiceLive` providing `SessionManagerServiceTag` (4 methods). Task 4 proposes creating another `SessionManagerServiceLive` providing `SessionManagerTag` (~20 methods). Name collision.
**Fix:** Either rename the proposed Layer or clarify that the existing `SessionManagerServiceLive` is extended to cover all `SessionManagerShape` methods.

### AP-R2-8: Task 5 — `RelayServiceLive` missing ~15 required Tags

**Source:** Tasks 4-5 report (finding #7)
**Issue:** Current `makeHandlerLayer` in `layers.ts` provides 15+ core Tags. Task 5's `RelayServiceLive` only lists 9 layers. Missing at minimum: `PermissionBridgeTag`, `QuestionBridgeTag`, `ConfigTag`, `LoggerTag`, `ConnectPtyUpstreamTag`, `ForkMetaTag`, `OrchestrationEngineTag`, plus optional Tags and Effect-native state Tags.
**Fix:** Enumerate ALL Tags that `RelayServiceLive` must provide, cross-referenced against `makeHandlerLayer` in `layers.ts:177-249`.

### AP-R2-9: Task 5 — `OpenCodeAPILive` referenced but never defined

**Source:** Tasks 4-5 report (finding #8)
**Issue:** Step 2 code uses `Layer.provide(OpenCodeAPILive)` but this export doesn't exist. Step 3 correctly creates `apiLayer = Layer.succeed(OpenCodeAPITag, api)`.
**Fix:** Remove `OpenCodeAPILive` from Step 2. Clarify that `OpenCodeAPITag` is provided externally via `Layer.succeed` in Step 3.

### AP-R2-10: Task 5 — Status poller's separate ManagedRuntime not addressed

**Source:** Tasks 4-5 report (finding #12)
**Issue:** `relay-stack.ts:557-571` creates a separate `pollerManagedRuntime` for the status poller with its own `PollerStateTag` and `PollerPubSubTag`. Task 5's `RelayServiceLive` doesn't include these layers or explain how to merge the poller runtime.
**Fix:** Add `makePollerStateLive()` and `makePollerPubSubLive()` to `RelayServiceLive` composition.

### AP-R2-11: Task 5 — `runtime.runSync` may fail with async Layer construction

**Source:** Tasks 4-5 report (finding #11)
**Issue:** Option A wiring pattern uses `runtime.runSync(Effect.gen(...))` to extract services. But `ManagedRuntime.make(fullLayer)` returns `ManagedRuntime<R, E>` synchronously — the Layer is constructed lazily on first `runPromise`/`runSync` call. If any Layer involves async operations (DB connections, HTTP), `runSync` will throw.
**Fix:** Document that service extraction must use `await runtime.runPromise(...)` not `runtime.runSync(...)`, or that `ManagedRuntime` must be pre-warmed before sync extraction.

### AP-R2-12: Task 6 — Uses `Effect.runPromise` not `Layer.launch` per conventions

**Source:** Effect-TS compliance auditor + verification
**Issue:** Conventions explicitly state: "Use `Layer.launch` for the top-level daemon program." The plan instead uses `Effect.runPromise(DaemonProgram)` with manual `Deferred.await(shutdown)` coordination. `Layer.launch` constructs the Layer, runs until interrupted (SIGINT/SIGTERM), then tears down finalizers — exactly the daemon lifecycle needed.
**Fix:** Replace the `startDaemon` + `Deferred.await` pattern with:
```typescript
const DaemonProgram = DaemonLive.pipe(Layer.launch);
Effect.runFork(DaemonProgram); // or BunRuntime.runMain(DaemonProgram)
```
`Layer.launch` already handles signal-based shutdown and finalizer teardown.

### AP-R2-13: Task 10 — `orchestration-service.ts` already exists with real content

**Source:** Verification
**Issue:** Plan says to create `src/lib/effect/orchestration-layer.ts` and convert `orchestration-engine.ts` to an Effect service. But `src/lib/effect/orchestration-service.ts` already exists (as one of the 45 Effect modules) with `IdempotencySetTag`, `makeIdempotencySetLive()`, and a background eviction fiber. Task 10 should build on this existing module, not create from scratch.
**Fix:** Update Task 10 to reference the existing `orchestration-service.ts` and extend it rather than creating a new file. Document what already exists vs. what needs to be added.

### AP-R2-14: Task 11 — metrics.ts is NOT a stub, already has 7 real metrics

**Source:** Verification
**Issue:** Plan says "Replace the stub `metrics.ts` with real `Effect.Metric` counters and gauges." But `metrics.ts` already has:
- `wsConnectionsGauge`, `activePollersGauge`, `sseReconnectsCounter`, `rateLimitRejectionsCounter`, `ipcCommandsCounter`, `configPersistsCounter`, `ipcLatencyHistogram`
Task 11 would overwrite existing working metrics.
**Fix:** Rewrite Task 11 as "Extend existing metrics + wire into services." List only the NEW metrics to add (sessions, messages, health checks) and specify which service files need `yield* Metric.increment(...)` calls.

### AP-R2-15: Task 4 — Plan example uses `new Map` instead of `HashMap`

**Source:** Tasks 4-5 report (finding #9)
**Issue:** Task 4 `SessionRegistryLive` example uses `Ref.make(new Map<string, string>())`. Conventions say prefer `HashMap`. The existing `session-registry-state.ts` already correctly uses `HashMap.empty<string, string>()`.
**Fix:** Update the example to use `HashMap.empty()` matching the existing code.

### AP-R2-16: Task 4 — `SessionManagerServiceLive` Layer deps incomplete

**Source:** Tasks 4-5 report (finding #13)
**Issue:** Plan says SessionManagerServiceLive deps are `OpenCodeAPITag | ConfigTag`. But `SessionManagerShape` has ~20 methods requiring `SessionManagerStateTag`, `LoggerTag`, event broadcasting, and more.
**Fix:** List all actual dependencies for the SessionManager Live Layer.

---

## Ask User (1 finding)

### AU-R2-1: Task 4 — Fundamental design decision on Tag service types

**Source:** Tasks 4-5 report (finding #10)
**Issue:** Should Task 4 redefine the bridge Tag service types (e.g., `SessionRegistryTag`) to use Effect return types? Or should the `*Live` Layers only provide the Effect-native state Tags (e.g., `SessionRegistryStateTag`)?

**Option A: Redefine bridge Tag service types** — Clean, but requires updating ALL consumers (handlers, relay-stack, wiring functions) to use `yield*` for service method calls. Cascading changes across Tasks 4-9.

**Option B: Keep bridge Tags as-is, only provide state Tags in Live Layers** — Bridge Tags deleted in Task 8. During Tasks 4-7, consumers are progressively converted to use state Tags directly. Less disruptive but temporarily maintains dual-Tag architecture.

**Option C: Drop bridge Tags entirely in Task 4** — Delete bridge Tags from services.ts, update all consumers immediately. Most aggressive but cleanest result. Effectively merges Tasks 4, 7, and 8.

---

## Accept (5 findings)

### A-R2-1: Task 7 — Both handler variants confirmed, cleanup still needed
Both `handleListSessions` (Promise) and `handleListSessionsEffect` variants exist in `session.ts`. `HandlerDeps` and `MessageHandler` types still in `types.ts`. Task 7 accurately describes needed work.

### A-R2-2: Task 9 — Wiring files, Tags, and APIs all exist
All 5 wiring files exist. `PermissionBridgeTag` exists. `Layer.scopedDiscard` confirmed in Effect 3.21. `Schedule.fixed` is appropriate for lightweight sync timer checks (permission expiry is synchronous iteration, not a network call).

### A-R2-3: API correctness — HashMap.modify confirmed
`HashMap.modify` exists in Effect 3.21 (was erroneously flagged during initial investigation). Task 3's `HashMap.modify(s.instances, instanceId, ...)` is valid.

### A-R2-4: API correctness — FiberMap.has returns Effect<boolean>
Confirmed from types. Previous fix AP-7 (Round 1) correctly applied.

### A-R2-5: API correctness — ManagedRuntime.make, MetricState.counter, Layer.launch all exist
`ManagedRuntime.make(layer)` takes `Layer<R, E, never>` ✓. `MetricState.counter` exists ✓. `Layer.launch(layer)` returns `Effect<never, E, RIn>` ✓.

---

## Summary

| Action | Count | Details |
|--------|-------|---------|
| **Amend Plan** | 16 | AP-R2-1 through AP-R2-16 |
| **Ask User** | 1 | AU-R2-1 (Tag service type design decision) |
| **Accept** | 5 | A-R2-1 through A-R2-5 |

### Finding Distribution by Task

| Task | AP | AU | Accept |
|------|----|----|--------|
| Task 1 | 1 | 0 | 0 |
| Task 3 | 4 | 0 | 0 |
| Tasks 4-5 | 8 | 1 | 0 |
| Task 6 | 1 | 0 | 0 |
| Task 7 | 0 | 0 | 1 |
| Tasks 8-9 | 0 | 0 | 2 |
| Tasks 10-11 | 2 | 0 | 0 |
| Cross-cutting | 0 | 0 | 2 |

### Critical Themes

1. **Dual-Tag architecture** (AP-R2-6, AU-R2-1) — the single most consequential issue. Affects Tasks 4-8 and requires a design decision before any implementation can proceed.

2. **DaemonEvent type safety** (AP-R2-2, AP-R2-3) — Task 3's event publishing uses wrong constructors and references a non-existent event variant.

3. **Incomplete enumeration** (AP-R2-8, AP-R2-10) — Task 5's `RelayServiceLive` is missing half the required Tags. The plan needs a complete manifest.

4. **Stale assumptions about existing code** (AP-R2-13, AP-R2-14) — Tasks 10 and 11 assume files are stubs/non-existent when they already have real content.

---

**Routing:** 16 Amend Plan + 1 Ask User findings present. Handing off to plan-audit-fixer.
