# Effect.ts Migration Follow-Up — Audit Synthesis

**Plan:** `docs/plans/2026-04-24-effect-ts-migration-followup.md`
**Auditors dispatched:** 13 (Tasks 1, 3-14)
**Date:** 2026-04-24

---

## Amend Plan (28 findings)

### Task 1: Delete dead dispatch (5 findings)

1. **EFFECT_MESSAGE_HANDLERS not exported** — `const` at line 318, not `export const`. Plan tells test to import it but it can't. Either export it or delete the test (TypeScript `Record<keyof PayloadMap, ...>` enforces completeness at compile time).

2. **Dead imports after deletion** — Lines 88-153 import handler functions used only by deleted `MESSAGE_HANDLERS`. `pnpm check` will fail. Delete lines 88-110 and 112-153, keep `PayloadMap` import at line 111.

3. **Stale header comment** — Lines 1-7 reference `MESSAGE_HANDLERS` and "legacy dispatchMessage". Update after deletion.

4. **Stale JSDoc** — Lines 312-317 compare `EFFECT_MESSAGE_HANDLERS` to deleted `MESSAGE_HANDLERS`. Simplify.

5. **Orphaned section comments** — Line 86 "Dispatch Table" divider and lines 155-158 trust-boundary comment serve deleted code. Remove.

### Task 4: Convert sdk-factory (3 findings)

6. **Missing test deletion** — Deleting `src/lib/instance/retry-fetch.ts` breaks `test/unit/instance/retry-fetch.test.ts`. Add `git rm` for that test file.

7. **Missing test run** — `test/unit/instance/sdk-factory.test.ts` imports `createSdkClient` (compat wrapper). Add to Step 6 test commands.

8. **Stale Files list** — `src/lib/effect/services.ts` listed but no step modifies it. Remove from Files list.

### Task 5: Relay errors (4 findings)

9. **Schema.TaggedError vs TaggedErrorClass** — Plan uses both names inconsistently. Must verify correct Effect 3.x API name. Test with actual import.

10. **fromCaught ignores `code` parameter** — Plan's `fromCaught` always creates `OpenCodeConnectionError` regardless of `code` arg. This breaks ~10 call sites using `fromCaught(err, "INIT_FAILED")`, `fromCaught(err, "HANDLER_ERROR")`, etc. Wire format changes from `"INIT_FAILED"` to `"OpenCodeConnectionError"`. Must either preserve code-to-class mapping or create appropriate error subclasses.

11. **Wire format change affects frontend** — `.code` values change (e.g., `"OPENCODE_UNREACHABLE"` → `"OpenCodeConnectionError"`). Check Svelte stores for string comparisons.

12. **`cause` field support** — Schema.TaggedError may not support `cause` in schema fields. `cause` is an Error property, not a schema field. May need `Schema.optionalWith(Schema.Unknown, ...)` or separate handling.

### Task 7: PBT/error tests (1 finding)

13. **INIT_FAILED assertions break** — `client-init.test.ts` lines 184, 239, 268, 336, 788 assert `code === "INIT_FAILED"`. After Task 5, `fromCaught(err, "INIT_FAILED")` produces `OpenCodeConnectionError` with `_tag === "OpenCodeConnectionError"` and `code === "OpenCodeConnectionError"`. These tests all break. Must update assertions or fix `fromCaught` to map codes to error classes.

### Task 8: Daemon Tags + SignalHandler (8 findings)

14. **DaemonConfigTag already exists** — `config-persistence.ts:100-103` already defines it with `ServerConfigLive` Layer. Adding a second one to `services.ts` creates duplicate. Remove from plan.

15. **SignalHandlerLayer blocks forever (CRITICAL)** — `Effect.promise(() => new Promise(resolve => { ... }))` suspends layer construction indefinitely. Promise only resolves on SIGTERM. Daemon hangs on startup. Must use `Effect.Deferred` pattern.

16. **ShutdownSignalTag wrong type** — Should be `Deferred.Deferred<void>` not `Effect.Effect<void>`. Deferred is the correct "waitable" handle.

17. **No signal handler cleanup** — Plan says "can't easily clean up" but should use `Effect.addFinalizer` with `process.removeListener`.

18. **No consumer of ShutdownSignalTag** — Task 12 uses `Layer.launch` but nothing reads the shutdown signal to trigger exit. Shutdown flow from signal to process exit is not wired.

19. **SIGHUP handler dropped** — Existing `signal-handlers.ts:30` installs SIGHUP for config reload. Plan only handles SIGTERM/SIGINT. Regression.

20. **Placeholder tests** — Both test cases contain `expect(true).toBe(true)`. Violates TDD requirement.

21. **Signal handler ordering** — `Layer.mergeAll` builds concurrently. Signal handlers could be installed after servers start. Use `Layer.provide` for ordering if needed.

### Task 9: Leaf services (7 findings)

22. **Layer doesn't call start()/activate()** — `makeKeepAwakeLive` creates instance but never calls `activate()`. Same for `start()` on VersionChecker, StorageMonitor, PortScanner. Services sit inert.

23. **Second KeepAwake construction site missed** — `daemon.ts:1674` in `setKeepAwakeCommand` IPC handler reconstructs `new KeepAwake(registry, {...})`. Will break.

24. **PortScanner drained flag** — Finalizer must call `instance.drain()`, not inline logic. `drain()` sets internal `drained = true` that suppresses callbacks.

25. **PortScanner has 3 constructor args** — `(registry, config, probeFn)`. Plan should note updated signature `(config, probeFn)`.

26. **Layer factory signatures missing for 3 services** — Only KeepAwake shown. Need PortScanner, StorageMonitor, VersionChecker signatures.

27. **Registry integration tests break** — `keep-awake.test.ts:1112-1144` and `port-scanner.test.ts:164-180` test registry behavior. Need deletion/rewrite.

28. **Drain gap between Tasks 9 and 12** — After removing registry registration but before Layers manage lifecycle, daemon `stop()` won't drain these 4 services. Need manual drain calls as bridge.

### Task 10: EventEmitter → PubSub (4 findings)

29. **PubSub.publish with Effect.runSync** — Plan suggests `Effect.runSync(PubSub.publish(...))`. PubSub.publish may require async runtime. Verify.

30. **Subscriber conversion pattern not shown** — `.on("event", handler)` → PubSub.subscribe returns Queue, need Queue.take or Stream.fromQueue. Pattern not specified.

31. **Sync → async sites not enumerated** — Plan acknowledges concern but doesn't identify specific sites where emit-then-check patterns exist.

32. **Test file enumeration incomplete** — Plan mentions 12+ test files but doesn't list all of them with specific changes needed.

### Task 11: Server Layers (3 findings)

33. **DaemonLifecycleContext is shared mutable state** — Multiple Layers reading/writing same `ctx` object. Not a race condition in practice (sequential server startup), but should be documented.

34. **OnboardingServer conditional** — Only starts when TLS active. Layer must handle `ctx.tls` being undefined gracefully.

35. **Server ordering** — HTTP must be ready before WebSocket upgrade. Use `Layer.provide` not `Layer.mergeAll`.

### Task 12: DaemonLive composition (4 findings)

36. **Layer.mergeAll doesn't express dependencies** — PortScanner depends on config, ProjectRegistry depends on InstanceManager. Should use `Layer.provide` chains.

37. **Startup logic beyond service creation** — daemon.ts start() does config rehydration, localhost probing, auto-start, session prefetch, project discovery. Plan doesn't specify where these go.

38. **Daemon mutable state** — clientCount, dismissedPaths, persistedSessionCounts, shuttingDown — not addressed in Layer design.

39. **Layer.launch blocking behavior** — Current daemon returns to event loop after setup. `Layer.launch` blocks. Different behavior.

### Tasks 13-14: Cleanup (3 findings)

40. **relay-stack.ts creates own ServiceRegistry** — Line 152: `new ServiceRegistry()`. Not just daemon.ts. Must also update relay-stack.

41. **Not all Drainable services migrated by Task 13** — Plan migrates 4 leaf + 7 EventEmitter = 11 services. But SessionOverrides and RelayTimers (also Drainable) may not be covered in Tasks 9/10.

42. **Drainable interface imported by many files** — Deleting service-registry.ts removes the `Drainable` interface. All files importing it need updating. Plan doesn't enumerate them.

---

## Accept (7 findings)

- Task 3: Schedule.linear behavior verified, baseFetch mock realistic
- Task 4: Effect.runPromise inside lambda is correct (not called during sync eval)
- Task 4: Effect.runSync(createSdkClientEffect) is safe (pure sync)
- Task 4: Auth path test coverage matches pre-existing level
- Task 4: daemon.ts dynamic import works with compat wrapper
- Task 9: VersionChecker drain via AbortController is correct
- Task 9: Registry drainAll still works with fewer services

---

## Summary

**Amend Plan: 42** findings across 11 tasks
**Accept: 7** findings

**Critical blockers (must fix before execution):**
1. SignalHandlerLayer blocks forever (Task 8, #15)
2. fromCaught ignores code parameter → breaks INIT_FAILED assertions (Task 5/7, #10/#13)
3. DaemonConfigTag duplicate (Task 8, #14)

**High priority (will cause test failures):**
4. Dead imports after deletion → pnpm check fails (Task 1, #2)
5. EFFECT_MESSAGE_HANDLERS not exported (Task 1, #1)
6. Missing test deletion for retry-fetch (Task 4, #6)
7. Layer doesn't call start()/activate() (Task 9, #22)
8. Drain gap between Tasks 9-12 (Task 9, #28)

Handing off to plan-audit-fixer to resolve.
