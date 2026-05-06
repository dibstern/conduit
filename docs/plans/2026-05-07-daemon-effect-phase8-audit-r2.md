# Phase 8 Re-Audit Synthesis (Round 2)

**Date:** 2026-05-07
**Plan:** `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`
**Auditors:** 6 subagents (one per task group), post-amendment re-audit

---

## Audit Quality Note

3 of 6 auditors (Tasks 3-4, 8-10, 11-12) did not read the amendments section (lines 1193-1592) and re-discovered issues already fixed. Their reports are retained for reference but all findings are duplicates. Only findings from auditors that read amendments (Tasks 1-2, Task 5, Tasks 6-7) plus one genuine issue from Tasks 11-12 thinking are included below.

---

## Amend Plan Findings (16)

### Tasks 1-2: DaemonConfigRef + ConfigPersistence

**AP-R2-1: Test defaults missing AP-1 fields.**
Plan lines 73-83 (Task 1) and 309-319 (Task 2) test `defaults` objects lack `startTime`, `hostExplicit`, `persistedSessionCounts`. Will fail typecheck. Fix: add `startTime: Date.now(), hostExplicit: false, persistedSessionCounts: new Map()` to all test defaults.

**AP-R2-2: `makeDaemonConfigFromOptions` not updated for AP-1 fields.**
Plan lines 177-196 function signature and return don't include the three AP-1 fields. Fix: add `startTime?: number` and `persistedSessionCounts?: ReadonlyMap<string, number>` to options; add `startTime: options.startTime ?? Date.now()`, `hostExplicit: options.host !== undefined`, `persistedSessionCounts: new Map(options.persistedSessionCounts ?? [])` to return.

**AP-R2-3: AP-3 test `writes` scoping ambiguity.**
AP-3 rewrites test to use `fullComposedLayer` but references bare `writes` without showing declaration. Fix: rewrite `makeTestLayer()` to return `{ layer: fullComposedLayer, writes }` where `fullComposedLayer = ConfigPersistenceLive.pipe(Layer.provide(Layer.mergeAll(DaemonConfigRefLive(defaults), DaemonEventBusLive, writerLayer)))`.

**AP-R2-4: Step 7 wiring omits `persistedSessionCounts` seeding.**
Plan lines 230-237 seed DaemonConfigRefLive but don't show how persisted session counts are loaded. Fix: add cross-reference: "persistedSessionCounts populated after Task 6 wires disk config loading via ProjectRegistry."

### Task 5: TLS Certificate Loading

**AP-R2-5: `caCertPem` missing from success-path return.**
AP-13 adds `caCertPem` to `TlsCertService` interface but success-path return (plan lines 659-663) doesn't include it. AP-15's early-return does include `caCertPem: null`. Fix: add `caCertPem: certs?.caCertPem ?? null` to success-path return.

**AP-R2-6: `EnsureCertsTag` DI not wired in implementation.**
AP-17 says use `EnsureCertsTag` for test DI, but `TlsCertLive` (plan lines 639-650) calls `ensureCerts` directly via import. Mock tag would have no effect. Fix: add `EnsureCertsTag` Context.Tag and have `TlsCertLive` resolve from context. More Effect-idiomatic than `vi.mock`.

### Tasks 6-7: ProjectRegistry + InstanceManager Wiring

**AP-R2-7: ProjectRegistryLive co-layer requirements undocumented.**
`makeProjectRegistryLive` only provides bare Ref. Free functions also need `DaemonEventBusTag` and `RelayCacheTag`. When ProjectRegistry is wired, `relayFactory` in DaemonLiveOptions must be mandatory. Fix: add note documenting required co-layers.

**AP-R2-8: Missing `isStarting` method in gap list.**
Used at `daemon-main.ts:632` but not listed in AP-18 step 3. Fix: add to gap list, or document replacement: check `getEntry(slug)` returns `_tag === "Registering"`.

**AP-R2-9: InstanceManagementDeps missing 4 methods.**
Existing Effect service has 4 of 7 required methods. Missing: `startInstance`, `stopInstance`, `updateInstance`, `persistConfig`. Fix: add to AP-19 gap list.

**AP-R2-10: `addInstance` return type mismatch.**
Effect `addInstance` returns void. `InstanceManagementDeps.addInstance` returns `OpenCodeInstance`. Fix: modify Effect `addInstance` to return created instance.

**AP-R2-11: `getExternalUrl`/`getInstanceUrl` missing.**
Used at `daemon-main.ts:397,544,550` but not in Effect service or InstanceManagementDeps. Fix: add to gap list or document as pure helper functions.

**AP-R2-12: PortScanner callback typing blocks Tag access.**
`PortScannerConfig.onDiscovered/onLost` typed as `Effect.Effect<void, never, never>` — can't use Tags. Fix: construct callbacks as closures over concrete Ref/FiberMap values obtained during Layer construction, before building PortScannerConfig.

**AP-R2-13: DaemonEventBus bridge needs dedicated wiring Layer.**
AP-19 step 6 instance→registry bridge subscription has no specified home. Fix: specify `DaemonWiringLive` Layer that sits above both services, subscribes to DaemonEventBus for cross-cutting concerns.

**AP-R2-14: `drain()` replacement not documented.**
Scope finalization replaces explicit `drain()` calls. Fix: add note that `FiberMap.make` is scoped, fibers interrupted on Layer scope close. No explicit `drain` needed.

**AP-R2-15: PushManagerLive already exists.**
`push-service.ts:37` has complete Layer factory. Fix: amend to wire existing, not create new.

### Tasks 11-12: Layer Composition

**AP-R2-16: AP-37 uses `Layer.provide` which strips transitive deps.**
`services.pipe(Layer.provide(foundation))` outputs only services tags, not foundation tags. Downstream tiers needing `DaemonEventBusTag` or `DaemonConfigRefTag` won't find them. Fix: use `Layer.provideMerge` instead of `Layer.provide` at each tier to pass through outputs.

---

## Ask User Findings (0)

All previous Ask User items resolved in Round 1 amendments.

---

## Accept Findings (8)

- Tasks 1-2: No test for `hostExplicit` derivation (worth adding, not blocking)
- Tasks 1-2: `Stream.debounce` + `TestClock` compatibility verified correct
- Task 5: Dead `certs &&` guard after AP-15 early return (harmless)
- Task 5: `TlsCertService` field duplication (convenience pattern)
- Task 5: Cert chain concatenation deferred to HTTP server layer
- Task 5: Stale config snapshot safe for `hostExplicit` check
- Tasks 6-7: `getInstances` Iterable vs ReadonlyArray (trivial `Array.from`)
- Tasks 6-7: `touchLastUsed` uses `Date.now()` instead of Clock (pre-existing)

---

## Summary

| Action | Count |
|--------|-------|
| Amend Plan | 16 |
| Ask User | 0 |
| Accept | 8 |

**16 Amend Plan findings require plan-audit-fixer.** Most are code snippet consistency issues (6), missing methods in gap lists (5), wiring documentation (3), and a critical Layer composition fix (1). No Ask User items — all design decisions already resolved.

---

## Amendments Applied

All 16 findings resolved in Round 2 amendments appended to plan document.

| Finding | Task | Amendment |
|---------|------|-----------|
| AP-R2-1 | Task 1 | Added explicit test defaults with all 3 AP-1 fields |
| AP-R2-2 | Task 1 | Updated `makeDaemonConfigFromOptions` signature + return |
| AP-R2-3 | Task 2 | Rewrote `makeTestLayer()` to return `{ layer, writes }` with clear scoping |
| AP-R2-4 | Task 2 | Added cross-reference for `persistedSessionCounts` seeding in Task 6 |
| AP-R2-5 | Task 5 | Added `caCertPem` to success-path return object |
| AP-R2-6 | Task 5 | Added `EnsureCertsTag` + `EnsureCertsLive` for DI, updated `TlsCertLive` |
| AP-R2-7 | Task 6 | Documented co-layer requirements (RelayCacheTag mandatory) |
| AP-R2-8 | Task 6 | Added `isStarting` to gap list with Effect helper |
| AP-R2-9 | Task 7 | Added 4 missing InstanceManagementDeps methods to gap list |
| AP-R2-10 | Task 7 | Fixed `addInstance` to return `OpenCodeInstance` |
| AP-R2-11 | Task 7 | Added `getExternalUrl`/`getInstanceUrl` as standalone helpers |
| AP-R2-12 | Task 7 | Fixed PortScanner callback construction — close over Ref, not Tags |
| AP-R2-13 | Task 7 | Specified `DaemonWiringLive` as bridge home Layer in Tier 3 |
| AP-R2-14 | Task 7 | Documented scope-based finalization replacing `drain()` |
| AP-R2-15 | Task 7 | Wire existing `PushManagerLive`, don't create new |
| AP-R2-16 | Task 11 | `Layer.provide` → `Layer.provideMerge` for transitive dep passthrough |
