# Phase 8 Tasks 1 & 2 -- Audit Report

**Auditor:** Claude Opus 4  
**Date:** 2026-05-07  
**Plan:** `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`

---

## Task 1: Extract Mutable Daemon State to DaemonConfigRef

**Summary:** The DaemonRuntimeConfig interface misses several mutable variables from the actual source. The code snippets are otherwise correct and the Layer wiring approach is sound.

### Findings

| # | Category | Action | Issue | File:Line | Amendment / Question |
|---|----------|--------|-------|-----------|----------------------|
| 1 | Implicit Assumptions | Amend Plan | `DaemonRuntimeConfig` is missing `startTime: number`. Line 345 declares `let startTime = Date.now()` which is read by `getStatus()` and IPC handlers. Must be captured in the Ref or handled elsewhere. | `src/lib/effect/daemon-main.ts:345` | Add `readonly startTime: number` to `DaemonRuntimeConfig`. Initialize to `Date.now()` in `makeDaemonConfigFromOptions`. |
| 2 | Implicit Assumptions | Ask User | `let pushManager: PushNotificationManager \| null` (line 349) is mutable state not addressed by any task in the plan. Is PushNotificationManager handled by a separate Layer, or should it be included in DaemonRuntimeConfig, or is it slated for removal? | `src/lib/effect/daemon-main.ts:349` | Decision needed: include in config ref, create separate PushNotificationManagerLive Layer, or confirm it's dead code. |
| 3 | Implicit Assumptions | Amend Plan | `const persistedSessionCounts = new Map<string, number>()` (line 358) is mutable shared state used by `buildConfig()` to persist session counts. Not captured in DaemonRuntimeConfig or mentioned in any task. | `src/lib/effect/daemon-main.ts:358` | Either add `readonly persistedSessionCounts: ReadonlyMap<string, number>` to `DaemonRuntimeConfig`, or document that this state will be owned by ProjectRegistryLive (Task 6). The plan should state where this state lands. |
| 4 | Implicit Assumptions | Accept | `let shutdownTimer`, `let _eventLoopTimer`, `let tlsCerts`, `let daemonRuntime`, and the service refs (`versionChecker`, `keepAwakeManager`, `storageMonitor`, `scanner`) are all mutable `let` variables at lines 346-356 that are NOT in `DaemonRuntimeConfig`. This is correct -- they are service/infrastructure refs that will be eliminated by their respective Layer tasks (Tasks 3, 5, 12). No plan change needed, but worth confirming the plan's claim of "8 core mutable let variables" is actually 9 config-relevant variables (8 listed + `startTime`). | `src/lib/effect/daemon-main.ts:345-356` | -- |
| 5 | Missing Wiring | Amend Plan | Step 7 says to add `DaemonConfigRefLive` to `makeDaemonLive` in `daemon-layers.ts` using `Layer.provideMerge(configRefLayer)`. The existing `makeDaemonLive` (line 332) takes `DaemonLiveOptions` which has no `port`/`host` fields directly -- they are nested in `ctx: DaemonLifecycleContext`. The plan snippet references `options.ctx.port` and `options.ctx.host` but `DaemonLifecycleContext` may not have these fields. | `src/lib/effect/daemon-layers.ts:296-319` | Verify `DaemonLifecycleContext` shape. The plan may need to pass port/host via a new field on `DaemonLiveOptions` or extract them from `ctx` differently. |
| 6 | Non-Strict Typing | Accept | The plan uses `ReadonlySet<string>` for `dismissedPaths` in the interface but `new Set()` in test defaults and `makeDaemonConfigFromOptions`. This is fine -- `Set` is assignable to `ReadonlySet`. No issue. | -- | -- |

### No issues found in: State Issues, Incorrect Code (snippets compile correctly), Insufficient Test Coverage (tests cover all fields present in the interface)

---

## Task 2: Convert Config Persistence to Effect Layer

**Summary:** The test has a critical wiring bug that will cause it to always pass vacuously (publishes to a different PubSub than the one ConfigPersistenceLive subscribes to). The `ConfigWriter` mock also has a type mismatch. The implementation snippet is sound.

### Findings

| # | Category | Action | Issue | File:Line | Amendment / Question |
|---|----------|--------|-------|-----------|----------------------|
| 7 | Incorrect Code | Amend Plan | **Test publishes to wrong PubSub.** The test creates `DaemonEventBusLive` in two places: (1) inside `makeTestLayer()` via `baseLayer`, and (2) in the outer `Effect.provide(Layer.fresh(DaemonEventBusLive))`. `ConfigPersistenceLive` subscribes to the bus from (1), but the test body resolves `DaemonEventBusTag` from (2) -- a completely separate PubSub instance. The `PubSub.publish` in the test never reaches the subscriber fiber, so the test would pass vacuously (writes stays empty, but `toBeGreaterThanOrEqual(1)` would fail -- actually it would correctly fail, but for the wrong reason if fixed incorrectly). | Plan Task 2, Step 2 test code | Remove the outer `Effect.provide(Layer.fresh(DaemonEventBusLive))`. Instead, the test should provide the `layer` from `makeTestLayer()` which already includes `DaemonEventBusLive`, and the test body should access the same bus. Restructure as: `Effect.gen(...).pipe(Effect.provide(Layer.fresh(layer)))` where `layer` is the full composed layer including ConfigPersistenceLive + its deps. |
| 8 | Incorrect Code | Amend Plan | **ConfigWriter mock type mismatch.** The test mock declares `write: (config: unknown) => Effect.sync(...)` but the `ConfigWriter` interface specifies `write: (config: DaemonRuntimeConfig) => Effect.Effect<void>`. TypeScript would reject `unknown` parameter in a contravariant position when assigned to `ConfigWriterTag`. | Plan Task 2, Step 2 test code | Change mock to `write: (config: DaemonRuntimeConfig) => Effect.sync(() => { writes.push(config); })` and type `writes` as `DaemonRuntimeConfig[]`. |
| 9 | Implicit Assumptions | Amend Plan | **ConfigChanged not added to DaemonEvent in Step 1 TaggedEnum.** The existing `DaemonEvent` (daemon-pubsub.ts:15-28) has 11 variants. The plan says to add `ConfigChanged: {}` but does not show the full updated TaggedEnum definition. The implementer must also add `ConfigChanged` to the `Data.taggedEnum<DaemonEvent>()` call at line 30 (this happens automatically since it derives from the type, but the type definition must be updated). The plan's Step 1 snippet is correct but incomplete -- it shows `// ... existing variants ...` which is fine as long as the implementer adds to the existing type, not replaces it. | `src/lib/effect/daemon-pubsub.ts:15-28` | Accept as-is, but add explicit instruction: "Add ConfigChanged variant to the existing TaggedEnum type definition. Do NOT replace existing variants." |
| 10 | State Issues | Amend Plan | **TestClock.adjust may not drive Stream.debounce in scoped test.** `Stream.debounce` internally uses `Effect.sleep` which respects `TestClock`. However, the test uses `it.scoped` which provides a `Scope` but the `ConfigPersistenceLive` layer is built manually via `Layer.build(layer)`. The built layer's fibers may not share the same `TestClock` instance as the test body. The test needs to ensure the forked fiber inside `ConfigPersistenceLive` uses the test's clock. | Plan Task 2, Step 2 test code | Use `it.scoped` with `Effect.provide(Layer.fresh(fullLayer))` so the ConfigPersistence fiber runs within the test's scope and inherits its TestClock. Do not use `Layer.build` manually -- let `Effect.provide` handle it. Alternatively, use `it.effect` with `TestContext.TestContext` layer and provide all deps together. |
| 11 | Implicit Assumptions | Amend Plan | **buildConfig() reads from ProjectRegistry and InstanceManager, not just DaemonConfigRef.** The existing `persistConfig` closure (lines 372-411) calls `buildConfig()` which reads `registry.allProjects()` and `instanceManager.getInstances()`. The plan's `ConfigPersistenceLive` only reads `DaemonConfigRefTag` via `Ref.get(configRef)`. The full config includes project list and instance list. Either the `ConfigWriter.write` must also receive registry/instance data, or `DaemonRuntimeConfig` must be expanded, or `ConfigPersistenceLive` must also depend on `ProjectRegistryTag` and `InstanceManagerTag`. | `src/lib/effect/daemon-main.ts:372-411` | Add `ProjectRegistryTag` and `InstanceManagerTag` (or a composed config builder) as dependencies of `ConfigPersistenceLive`, or document that this will be addressed when those services become Layers (Tasks 6-7). Since Task 2 runs before Tasks 6-7, the plan should note this is a partial implementation that will be completed later. |
| 12 | Fragile Code | Accept | The debounce duration of 500ms is hardcoded in the implementation. Per conventions.md, "Schedule intervals and timeouts MUST be configurable via the Layer config, not hardcoded." This should be a parameter of `ConfigPersistenceLive`. | Plan Task 2, Step 3 | Consider making debounce duration configurable, e.g., `ConfigPersistenceLive(options?: { debounceMs?: number })`. |
| 13 | Missing Wiring | Amend Plan | **ConfigPersistenceLive not composed into makeDaemonLive.** Task 2 creates the layer and tests it, but does not add a step to wire it into `makeDaemonLive` in `daemon-layers.ts`. It only appears in the Task 11 final composition. Since Task 2 is meant to be independently functional, it should either document that wiring happens later or add a wiring step. | `src/lib/effect/daemon-layers.ts` | Add a note: "ConfigPersistenceLive will be composed into makeDaemonLive in Task 11. For now it is tested standalone." Or add a wiring step similar to Task 1's Step 7. |
| 14 | Insufficient Test Coverage | Amend Plan | **No test for debounce coalescing behavior.** The existing imperative `persistConfig` has coalescing logic (`_pendingSave` / `_needsResave`). The plan replaces this with `Stream.debounce` but the test only verifies a single write happens. There should be a test that publishes multiple `ConfigChanged` events rapidly and verifies only one write occurs (the debounce behavior). | Plan Task 2, Step 2 | Add test: publish 5 ConfigChanged events in rapid succession, advance TestClock past debounce window, verify `writes.length === 1`. |

### No issues found in: Non-Strict Typing (no `any` or loose types in Task 2 snippets)

---

## Summary of Required Actions

**Amend Plan (8 items):** Findings 1, 3, 5, 7, 8, 10, 11, 14  
**Ask User (1 item):** Finding 2 (PushNotificationManager disposition)  
**Accept (4 items):** Findings 4, 6, 9, 12, 13
