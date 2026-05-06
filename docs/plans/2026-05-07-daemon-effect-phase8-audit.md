# Phase 8 Audit Synthesis

**Plan:** `docs/plans/2026-05-07-daemon-effect-phase8-plan.md`
**Auditors:** 6 (covering all 12 tasks)
**Date:** 2026-05-07

---

## Amend Plan (42 findings)

### Task 1: DaemonConfigRef
1. Missing `startTime: number` in `DaemonRuntimeConfig` (used by getStatus)
2. Missing `persistedSessionCounts: Map<string, number>` (used by buildConfig)
3. Missing `hostExplicit: boolean` (needed by Task 5 TLS host-override logic)
4. Step 7 wiring references `options.ctx.port` — verify DaemonLifecycleContext field exists

### Task 2: ConfigPersistence
5. Test publishes to wrong PubSub — two `DaemonEventBusLive` instances created
6. ConfigWriter mock parameter type `unknown` should be `DaemonRuntimeConfig`
7. TestClock may not reach forked fiber — use `Effect.provide(Layer.fresh(fullLayer))` not `Layer.build`
8. `persistConfig` reads ProjectRegistry + InstanceManager, not just DaemonConfigRef — note partial implementation
9. Missing test for debounce coalescing behavior

### Task 3: Background Services
10. **VersionCheckerLive config mismatch** — needs `{ getCurrentVersion, fetchLatestVersion, broadcast, checkInterval }`, not `{ enabled }`
11. **StorageMonitorLive config mismatch** — needs `{ getStorageUsage, persistence, checkInterval, highWaterMark }`, not `{ path }`
12. **PortScannerLive config mismatch** — needs `{ probeFn, portRange, scanInterval, removalThreshold, onDiscovered, onLost }`, not `{}`
13. PortScanner callbacks need InstanceManager (Task 7) — dependency ordering problem
14. Must preserve `instanceManager.drain()` and `registry.drain()` calls (only remove VersionChecker/StorageMonitor/Scanner drains)

### Task 4: CrashCounter/AuthManager
15. `CrashCounterImpl` doesn't exist — class is `CrashCounter`
16. `counter.count` doesn't exist — use `counter.getTimestamps().length`
17. `CrashCounterLive` not wired into `makeDaemonLive`
18. `AuthManagerFromConfigLive` not wired into `makeDaemonLive`

### Task 5: TLS
19. Missing `hostExplicit` guard — `c.host === "127.0.0.1"` != `!hostExplicit`
20. `TlsCertService` missing `caCertPem` field (needed by HTTP server)
21. Missing import of `ensureCerts`
22. `ensureCerts` returns `null` (not throws) for most failures — plan only handles the throw case
23. Layer composition order not specified
24. No test code provided — 5 edge cases need coverage

### Task 6: ProjectRegistry
25. **Already implemented** — `project-registry-service.ts` has 495 lines of Effect code. Task should be rewritten as wiring + gap-filling
26. Event names wrong — plan adds `ProjectAdded/Removed/Ready/Error` but existing code uses `InstanceAdded/Removed/StatusChanged/Error`
27. Missing `broadcastToAll`, `waitForRelay`, `evictOldestSessions`, `replaceRelay` in Effect service
28. `makeProjectRegistryLive` exists but not wired into `makeDaemonLive`

### Task 7: InstanceManager
29. **Already implemented** — `instance-manager-service.ts` has 416 lines of Effect code. Task should be rewritten as wiring + gap-filling
30. `InstanceManagerTag` doesn't exist — codebase has `InstanceManagerStateTag` and `InstanceMgmtTag`
31. `makeInstanceManagerStateLive` exists but not wired into `makeDaemonLive`

### Task 8: IPC Handlers
32. No dispatch bridge specified — how does IPC server call Effect handlers?
33. Only 4 of 19 handlers shown — `getStatus`, `setKeepAwakeCommand`, `instanceAdd`, `setPin` need explicit design
34. `handleSetKeepAwake` doesn't interact with KeepAwake Layer — must call `KeepAwakeTag.activate/deactivate`
35. `handleSetKeepAwakeCommand` needs service replacement mechanism — `ScopedRef` or `reconfigure()` method

### Task 9: Relay Factory
36. Missing PushNotificationManager, VersionChecker, PortScanner dependencies
37. Missing httpServer reference — needs `HttpServerRefTag`
38. PersistenceLayer (SQLite) lifecycle not addressed
39. AbortSignal-based lifecycle must convert to Effect Scope

### Task 10: WS Routing/Discovery
40. **HttpServerRefTag dependency problem** — Task 10 needs it but Task 11 introduces it
41. Lost behaviors: 503 response, `waitForRelay` timeout, `ensureRelayStarted` lazy startup, error-state project reset, `dismissedPaths` filtering
42. Missing `SessionPrefetchLive` implementation
43. Missing instance-status-to-registry wiring

### Task 11: Eliminate DaemonLiveOptions
44. **`Layer.mergeAll` is wrong for inter-dependent layers** — needs tiered `Layer.provide` composition
45. Server Layers (`makeHttpServerLive`, `makeIpcServerLive`, `makeOnboardingServerLive`) still take imperative params — conversion not specified

### Task 12: Layer.launch
46. **CRITICAL: `Layer.launch` does NOT handle SIGINT/SIGTERM** — daemon would hang on Ctrl+C. Must use `NodeRuntime.runMain` or wire ShutdownSignal Deferred
47. `--daemon` path: `startDaemonProcess` return type changes from `Promise<DaemonHandle>` to `Fiber` — breaks cli-core.ts call site
48. `DaemonHandleTag` never defined — `--foreground` path broken
49. IPC `shutdown` command has no mechanism to interrupt root fiber
50. Test stub insufficient — must verify shutdown path

---

## Ask User (3 findings)

1. **PushNotificationManager disposition** — include in DaemonConfigRef, create separate Layer, or remove?
2. **AuthManager dual-write** — should AuthManager read pinHash from Ref reactively, or is dual-write (update both) acceptable?
3. **Relay factory conversion depth** — does Task 9 also convert `createProjectRelay` to Effect, or build imperative callback shims?

---

## Accept (8 findings)

1. Service/infrastructure `let` refs (shutdownTimer, _eventLoopTimer, etc.) correctly excluded from DaemonRuntimeConfig
2. `ReadonlySet<string>` / `Set` assignability is fine
3. Event loop monitor deletion is acceptable
4. `bgParts` array `any` type is pre-existing
5. Debounce duration hardcoding is minor
6. ConfigPersistenceLive wiring deferred to Task 11 is acceptable
7. `ProjectRegistryTag` holding `Ref<HashMap>` not imperative class is expected
8. Conventions doc incorrectly claims `Layer.launch` handles signals — informational

---

## Summary

**42 Amend Plan findings, 3 Ask User questions.** Key themes:

1. **Code already exists** — Tasks 6-7 propose re-implementing services that already exist in Effect. Rewrite as wiring + gap-filling tasks.
2. **Config shape mismatches** — Tasks 3's background service configs are completely wrong. Must match actual Layer factory signatures.
3. **Signal handling gap** — `Layer.launch` doesn't handle SIGINT. Must use `NodeRuntime.runMain` or wire Deferred-based shutdown.
4. **Layer composition wrong** — `Layer.mergeAll` doesn't satisfy inter-layer dependencies. Must use tiered `Layer.provide`.
5. **Missing wiring** — Multiple new Layers created but never composed into `makeDaemonLive`.
6. **Lost behaviors** — Tasks 8-10 lose significant functionality (503 responses, waitForRelay, lazy relay startup, error-state reset).

Handing off to plan-audit-fixer to resolve.
