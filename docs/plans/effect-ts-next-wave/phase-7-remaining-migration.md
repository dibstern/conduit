# Phase 7: Remaining Effect Migration

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Complete the Effect.ts migration by wiring consumers to Effect services, deleting old imperative classes, removing bridge layers, and cleaning up dual-dispatch handler code. After this phase the codebase has zero bridge layers, zero EventEmitter classes, and one code path per handler (Effect only).

**Architecture:** The current state has 44 Effect modules coexisting with old imperative classes via bridge layers (`Layer.succeed(Tag, oldInstance)`). This phase rewires `relay-stack.ts` to construct Effect Layers directly, converts the remaining imperative relay/provider glue, and deletes all old code. Each task leaves the codebase compilable and testable.

**Tech Stack:** Same as prior phases — `effect 3.21.2`, `@effect/platform`, `@effect/vitest`, `@effect/rpc 0.75.1`, `@effect/sql`.

**Branch:** `feature/effect-ts-migration` (worktree at `.worktrees/effect-ts-migration/`).

**Conventions:** See [conventions.md](conventions.md) — read ONCE before starting.

**Prerequisites:** All phases 1-6 + 5b completed on the feature branch. Run `pnpm check && pnpm test:unit` to verify clean baseline.

---

## Phase Dependency Graph

```
Task 1: Dead Code Audit & Cleanup (independent)
    │
Task 2: Verify SessionOverrides timers [already done] (independent)
Task 3: Complete InstanceManager health/restart (independent)
    │
    ├─── Task 3 must be done before ────────┐
    │                                       │
Task 4: Self-Constructing Service Layers    │
    │                                       │
Task 5: Relay Stack Layer Conversion ◄──────┘
    │
Task 6: Daemon Entry Point Conversion
    │
Task 7: Handler Cleanup (remove Promise variants)
    │
Task 8: Delete Bridge Layers + Old Classes
    │
Task 9: Relay Imperative Glue Conversion
    │
Task 10: Provider Layer Conversion
    │
Task 11: Metrics Completion
```

Tasks 1, 2, 3 are fully parallel. Tasks 4-11 are sequential.

---

## Scope Exclusions

The following are intentionally NOT converted:

- **Frontend Svelte stores** (`src/lib/frontend/stores/*.svelte.ts`) — Svelte 5 `$state` is the correct tool for reactive UI. The transport layer (`ws.svelte.ts`, `runtime.ts`, `effect-boundary.ts`) already uses Effect. Converting reactive stores would add complexity without benefit.
- **Pure function modules** (`event-pipeline.ts`, `event-translator.ts`, `markdown-renderer.ts`, `truncate-content.ts`, `notification-policy.ts`, `poller-pre-filter.ts`, `opencode-events.ts`) — Already pure, no imperative patterns to convert.
- **Type-only files** (`daemon-types.ts`, `payloads.ts`, handler `types.ts`, provider `types.ts`) — Shared type definitions, no runtime code.
- **OpenCodeAPI class** (`src/lib/instance/opencode-api.ts`) — Wraps external SDK. Stays as `OpenCodeAPITag` via `Layer.succeed`. Converting internals would require rewriting the SDK contract.
- **SDK factory** (`sdk-factory.ts`) — Already returns Effect via `createSdkClientEffect`.

---

## Task 1: Dead Code Audit & Cleanup

**Goal:** Delete old daemon modules that have complete Effect replacements AND zero remaining consumers outside of the Effect replacement itself.

**Files:**
- Delete (after verification): old modules in `src/lib/daemon/`
- Modify: any files that import the deleted modules

**Step 1: Audit consumers for each candidate**

Run these greps from the worktree root. A module is safe to delete when the ONLY imports are from its own Effect replacement or test files.

```bash
# Port scanner — Effect replacement: src/lib/effect/port-scanner-layer.ts
rg "from.*daemon/port-scanner" --type ts -l

# Storage monitor — Effect replacement: src/lib/effect/storage-monitor-layer.ts
rg "from.*daemon/storage-monitor" --type ts -l

# Version check — Effect replacement: src/lib/effect/version-checker-layer.ts
rg "from.*daemon/version-check" --type ts -l

# Keep awake — Effect replacement: src/lib/effect/keep-awake-layer.ts
rg "from.*daemon/keep-awake" --type ts -l

# Config persistence — Effect replacement: src/lib/effect/daemon-config-persistence.ts
rg "from.*daemon/config-persistence" --type ts -l

# Daemon IPC — Effect replacement: src/lib/effect/ipc-dispatch.ts + ipc-handlers.ts
rg "from.*daemon/daemon-ipc" --type ts -l

# Session status poller — Effect replacement: src/lib/effect/session-status-poller.ts
rg "from.*session/session-status-poller" --type ts -l

# Session status SQLite — Effect replacement via read-query-service
rg "from.*session/session-status-sqlite" --type ts -l
```

**Step 2: For each module with zero non-Effect consumers, delete it**

For each module where the grep shows only Effect modules or tests importing it:
1. Delete the old file
2. Update any remaining imports to point at the Effect replacement
3. Run `pnpm check` after each deletion to verify no broken imports

**Step 3: For modules still imported by relay-stack.ts or other consumers**

Do NOT delete yet. Note them as "blocked — will delete in Task 8 after relay conversion." Expected blocked modules:
- `session/session-manager.ts` (imported by relay-stack.ts)
- `session/session-overrides.ts` (imported by relay-stack.ts, daemon-layers.ts)
- `session/session-registry.ts` (imported by relay-stack.ts)
- `instance/instance-manager.ts` (imported by daemon entry)
- `daemon/daemon-lifecycle.ts` (imported by daemon-layers.ts)

> **AUDIT FIX (AP-R2-1):** `daemon-main.ts` (at `src/lib/effect/daemon-main.ts`) directly instantiates `new PortScanner(...)`, `new VersionChecker(...)`, `new KeepAwake(...)`, `new StorageMonitor(...)`. Although it lives under `src/lib/effect/`, it is the active imperative entry point — NOT an Effect consumer. The following modules are also blocked until Task 6 converts daemon-main.ts:
- `daemon/port-scanner.ts` (instantiated by daemon-main.ts)
- `daemon/storage-monitor.ts` (instantiated by daemon-main.ts)
- `daemon/version-check.ts` (instantiated by daemon-main.ts)
- `daemon/keep-awake.ts` (instantiated by daemon-main.ts)

**Step 4: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor(effect): delete dead old modules with complete Effect replacements"
```

---

## Task 2: Verify SessionOverrides Effect Service (already implemented)

> **AUDIT FIX (AP-1):** This task was originally "Complete SessionOverrides timer logic." The audit found that `session-overrides-state.ts` already exports `startProcessingTimeout`, `resetProcessingTimeout`, `clearProcessingTimeout`, and `hasActiveProcessingTimeout` using `Effect.forkScoped` + `Fiber.interrupt` + `Ref.modify`. 15+ tests exist at `test/unit/session/session-overrides-effect.test.ts`. No implementation work needed.

**Goal:** Verify existing timer logic passes. Confirm the dependency for Task 4 is satisfied.

**Step 1: Run existing tests**

```bash
pnpm vitest run test/unit/session/session-overrides-effect.test.ts -v
```

Expected: All 15+ tests PASS.

**Step 2: Verify exports exist**

```bash
rg "export.*(startProcessingTimeout|resetProcessingTimeout|clearProcessingTimeout|hasActiveProcessingTimeout)" src/lib/effect/session-overrides-state.ts
```

Expected: All 4 functions exported.

**Step 3: No commit needed — no changes made**

---

## Task 3: Complete InstanceManager Effect Service — Health Polling & Restart

> **AUDIT FIXES applied:** AP-2 (health endpoint), AP-3 (status values), AP-4 (schedule), AP-5 (restart logic), AP-6 (event broadcasting), AP-7 (FiberMap.has API), AU-1 (shared FiberMap with key prefixes).

**Goal:** Add health polling and restart scheduling to `instance-manager-service.ts` using a shared FiberMap + Schedule, replacing the old `setInterval`/`setTimeout` patterns. Broadcast status changes via `DaemonEventBusTag`.

**Files:**
- Modify: `src/lib/effect/instance-manager-service.ts`
- Modify: `src/lib/effect/daemon-pubsub.ts` (extend `DaemonEvent` enum with `InstanceError` variant)
- Modify: `src/lib/effect/services.ts` (extend `InstanceManagerConfig` if needed)
- Test: `test/unit/effect/instance-manager-service.test.ts` (create or modify)

**Key design decisions:**
- **Shared FiberMap with key prefixes:** Poller fibers use key `"poller:{id}"`, restart fibers use `"restart:{id}"`. `removeInstance` interrupts both via `FiberMap.remove` for each prefix. One FiberMap, one cleanup path.
- **Health check via raw HTTP fetch** to per-instance ports (NOT via `OpenCodeAPITag` — each instance runs on a different port).
- **Status values:** `"healthy"` / `"unhealthy"` per the `InstanceStatus` type.
- **Configurable intervals:** `InstanceManagerConfig` extended with `healthPollIntervalMs`, `maxRestartsPerWindow`, `restartWindowMs`.

**Step 0: Fix existing `Date.now()` in `addInstance`**

> **AUDIT FIX (AP-R4-1):** The existing `addInstance` function at line ~106 of `instance-manager-service.ts` uses `Date.now()`, which is invisible to `TestClock`. Replace with `yield* Clock.currentTimeMillis`. If `addInstance` is not already an `Effect.gen`, convert it. This ensures all timestamp logic in the file is TestClock-compatible.

```bash
rg "Date\.now\(\)" src/lib/effect/instance-manager-service.ts
# Replace every occurrence with: yield* Clock.currentTimeMillis
```

**Step 1: Read the old implementation**

Read `src/lib/instance/instance-manager.ts`. Key details:
- `defaultHealthChecker` (line ~627): raw `fetch("http://localhost:{port}/health")`, returns `r.ok`
- Health poll interval default: 5000ms (not 30s)
- Restart logic (lines 527-600): windowed rate-limiting, exponential backoff capped at 30s
- Status transitions: `"unhealthy" → "stopped"` on give-up
- Callbacks: `status_changed`, `instance_error` — replace with `DaemonEventBusTag` PubSub
- Guards: stop polling if instance removed, stop managed instances in stopped/unhealthy state

**Step 2: Extend DaemonEvent enum with InstanceError variant**

> **AUDIT FIX (AP-R2-3):** The `DaemonEvent` TaggedEnum in `daemon-pubsub.ts` has no `InstanceError` variant. Add it so `scheduleRestart` can publish error events when restart limits are exceeded.

```typescript
// In src/lib/effect/daemon-pubsub.ts — add to the DaemonEvent TaggedEnum:
export type DaemonEvent = Data.TaggedEnum<{
  // ... existing variants ...
  InstanceError: { readonly instanceId: string; readonly error: string };
}>;

// Add publisher helper:
export const publishInstanceError = (instanceId: string, error: string) =>
  publish(DaemonEvent.InstanceError({ instanceId, error }));
```

**Step 3: Extend InstanceManagerConfig**

```typescript
// In instance-manager-service.ts — extend existing config
export interface InstanceManagerConfig {
  readonly maxInstances: number;
  readonly healthPollIntervalMs: number;   // default: 5000
  readonly maxRestartsPerWindow: number;   // default: 5
  readonly restartWindowMs: number;        // default: 60_000
}
```

**Step 4: Extend InstanceManagerState**

```typescript
// Add to InstanceManagerState:
readonly restartTimestamps: HashMap<string, ReadonlyArray<number>>;
```

**Step 5: Write the failing tests**

> **AUDIT FIX (AP-R4-2):** All tests in this task MUST use `it.scoped` (not `it.effect`) because `FiberMap.make()` requires `Scope.Scope` in its effect signature (`Effect.Effect<FiberMap<K>, never, Scope.Scope>`). Using `it.effect` will fail with an unsatisfied Scope requirement.

```typescript
// test/unit/effect/instance-manager-service.test.ts
import { describe, expect } from "@effect/vitest";
import { Duration, Effect, FiberMap, HashMap, Layer, PubSub, Ref, TestClock } from "effect";
import {
  startHealthPoller,
  stopHealthPoller,
  scheduleRestart,
  InstanceManagerStateTag,
  PollerFibersTag,
} from "../../../src/lib/effect/instance-manager-service.js";
import { DaemonEventBusTag } from "../../../src/lib/effect/daemon-pubsub.js";

describe("InstanceManager health polling", () => {
  // Test layer: mock HTTP fetch, Ref<state>, FiberMap, PubSub
  // ... build testLayer with Layer.mergeAll(...)

  it.scoped("detects healthy instance via raw HTTP fetch", () =>
    Effect.gen(function* () {
      // Setup: instance on port 3000 in state
      yield* startHealthPoller("inst-1");
      yield* TestClock.adjust(Duration.seconds(5));
      // Verify status updated to "healthy"
      const state = yield* Ref.get(yield* InstanceManagerStateTag);
      const inst = HashMap.get(state.instances, "inst-1");
      expect(inst._tag).toBe("Some");
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("marks instance unhealthy on fetch failure", () =>
    Effect.gen(function* () {
      // Setup: instance on unreachable port
      yield* startHealthPoller("inst-1");
      yield* TestClock.adjust(Duration.seconds(5));
      // Verify status is "unhealthy"
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("stopHealthPoller interrupts the polling fiber", () =>
    Effect.gen(function* () {
      yield* startHealthPoller("inst-1");
      yield* stopHealthPoller("inst-1");
      const fibers = yield* PollerFibersTag;
      const exists = yield* FiberMap.has(fibers, "poller:inst-1");
      expect(exists).toBe(false);
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("publishes status_changed via DaemonEventBusTag on transition", () =>
    Effect.gen(function* () {
      const bus = yield* DaemonEventBusTag;
      // Subscribe before starting
      // Start poller, advance clock, check published events
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("stops polling if instance removed during async check", () =>
    Effect.gen(function* () {
      yield* startHealthPoller("inst-1");
      // Remove instance from state
      // Advance clock — poll should detect removal and exit
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );
});

describe("InstanceManager restart scheduling", () => {
  it.scoped("restarts instance after backoff delay", () =>
    Effect.gen(function* () {
      yield* scheduleRestart("inst-1");
      yield* TestClock.adjust(Duration.seconds(2)); // First backoff: 1s * 2^0 = 1s
      // Verify startInstance was triggered
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("gives up after maxRestartsPerWindow exceeded", () =>
    Effect.gen(function* () {
      // Trigger maxRestartsPerWindow+1 restarts within window
      // Verify instance marked "stopped"
      // Verify instance_error published to DaemonEventBusTag
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );

  it.scoped("removeInstance cancels both poller and restart fibers", () =>
    Effect.gen(function* () {
      yield* startHealthPoller("inst-1");
      yield* scheduleRestart("inst-1");
      // removeInstance should cancel both
      const fibers = yield* PollerFibersTag;
      yield* FiberMap.remove(fibers, "poller:inst-1");
      yield* FiberMap.remove(fibers, "restart:inst-1");
      const pollerExists = yield* FiberMap.has(fibers, "poller:inst-1");
      const restartExists = yield* FiberMap.has(fibers, "restart:inst-1");
      expect(pollerExists).toBe(false);
      expect(restartExists).toBe(false);
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );
});
```

**Step 6: Run tests to verify they fail**

```bash
pnpm vitest run test/unit/effect/instance-manager-service.test.ts -v
```

**Step 7: Implement health polling**

```typescript
// In instance-manager-service.ts:

/** Key prefix scheme for shared FiberMap */
const pollerKey = (id: string) => `poller:${id}`;
const restartKey = (id: string) => `restart:${id}`;

export const startHealthPoller = (instanceId: string) =>
  Effect.gen(function* () {
    const stateRef = yield* InstanceManagerStateTag;
    const fibers = yield* PollerFibersTag;
    // Config is embedded in InstanceManagerState (no separate ConfigTag)
    const { config } = yield* Ref.get(stateRef);

    const pollEffect = Effect.gen(function* () {
      // Read instance from state to get port
      const state = yield* Ref.get(stateRef);
      const instanceOpt = HashMap.get(state.instances, instanceId);
      if (Option.isNone(instanceOpt)) return; // Instance removed, exit

      const instance = instanceOpt.value;

      // Guard: stop polling managed instances in stopped/unhealthy state
      if (instance.managed && (instance.status === "stopped" || instance.status === "unhealthy")) {
        return;
      }

      // Raw HTTP health check to instance port
      const isHealthy = yield* Effect.tryPromise(
        () => fetch(`http://localhost:${instance.port}/health`).then(r => r.ok)
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));

      const newStatus = isHealthy ? "healthy" : "unhealthy";

      // Only update + publish on transition
      if (newStatus !== instance.status) {
        yield* Ref.update(stateRef, (s) => ({
          ...s,
          instances: HashMap.modify(s.instances, instanceId, (inst) => ({
            ...inst,
            status: newStatus,
          })),
        }));
        // AUDIT FIX (AP-R2-2): Use DaemonEvent TaggedEnum helper, not plain objects
        yield* publishInstanceStatusChanged(instanceId);
      }
    }).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning("Health check error").pipe(
          Effect.annotateLogs("instanceId", instanceId)
        )
      )
    );

    // FiberMap.run with poller: prefix — auto-interrupts previous
    yield* FiberMap.run(fibers, pollerKey(instanceId),
      Effect.repeat(pollEffect,
        Schedule.spaced(Duration.millis(config.healthPollIntervalMs))
      )
    );
  }).pipe(Effect.annotateLogs("instanceId", instanceId));

export const stopHealthPoller = (instanceId: string) =>
  Effect.gen(function* () {
    const fibers = yield* PollerFibersTag;
    yield* FiberMap.remove(fibers, pollerKey(instanceId));
  });
```

**Step 8: Implement restart scheduling**

> **AUDIT FIXES:** AP-R2-5 (Clock.currentTimeMillis instead of Date.now()), AP-R2-2/AP-R2-3 (DaemonEvent TaggedEnum helpers), AP-R2-4 (restartInstance defined below).

```typescript
export const scheduleRestart = (instanceId: string) =>
  Effect.gen(function* () {
    const stateRef = yield* InstanceManagerStateTag;
    const fibers = yield* PollerFibersTag;
    // Config is embedded in InstanceManagerState (no separate ConfigTag)
    const { config } = yield* Ref.get(stateRef);

    // AUDIT FIX (AP-R2-5): Use Clock.currentTimeMillis for TestClock compatibility
    const now = yield* Clock.currentTimeMillis;

    // Check restart rate limit
    const state = yield* Ref.get(stateRef);
    const timestamps = Option.getOrElse(
      HashMap.get(state.restartTimestamps, instanceId),
      () => [] as ReadonlyArray<number>
    );
    const recentRestarts = timestamps.filter(t => now - t < config.restartWindowMs);

    if (recentRestarts.length >= config.maxRestartsPerWindow) {
      // Give up — mark stopped, publish error
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        instances: HashMap.modify(s.instances, instanceId, (inst) => ({
          ...inst,
          status: "stopped" as const,
        })),
      }));
      // AUDIT FIX (AP-R2-3): Use DaemonEvent TaggedEnum helper
      yield* publishInstanceError(
        instanceId,
        `Restart limit exceeded (${config.maxRestartsPerWindow} in ${config.restartWindowMs}ms)`,
      );
      yield* Effect.logWarning("Restart limit exceeded, marking stopped");
      return;
    }

    // Record timestamp
    yield* Ref.update(stateRef, (s) => ({
      ...s,
      restartTimestamps: HashMap.set(
        s.restartTimestamps,
        instanceId,
        [...recentRestarts, now],
      ),
    }));

    // Compute backoff: 1s * 2^attempts, capped at 30s
    const backoffMs = Math.min(1000 * Math.pow(2, recentRestarts.length), 30_000);

    // Fork restart fiber — FiberMap.run with restart: prefix
    yield* FiberMap.run(fibers, restartKey(instanceId),
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(backoffMs));
        // Re-check instance still exists and is still unhealthy
        const current = yield* Ref.get(stateRef);
        const instOpt = HashMap.get(current.instances, instanceId);
        if (Option.isNone(instOpt)) return;
        if (instOpt.value.status !== "unhealthy") return;
        // AUDIT FIX (AP-R2-4): restartInstance resets status and re-adds
        yield* restartInstance(instanceId);
        yield* startHealthPoller(instanceId);
      })
    );
  }).pipe(Effect.annotateLogs("instanceId", instanceId));

/**
 * AUDIT FIX (AP-R2-4): Restart an instance by resetting its status to "starting"
 * and re-invoking the opencode process. The old InstanceManager's restart
 * stops the old process, updates status, and starts a new one.
 *
 * Implementation: read the instance's InstanceConfig from state,
 * call removeInstance then addInstance with the same config. This reuses
 * the existing addInstance logic (port allocation, process spawn, status tracking).
 */
export const restartInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const stateRef = yield* InstanceManagerStateTag;
    const state = yield* Ref.get(stateRef);
    const instOpt = HashMap.get(state.instances, instanceId);
    if (Option.isNone(instOpt)) return;
    const inst = instOpt.value;
    // Reset status to "starting" — addInstance handles the rest
    yield* Ref.update(stateRef, (s) => ({
      ...s,
      instances: HashMap.modify(s.instances, instanceId, (i) => ({
        ...i,
        status: "starting" as const,
      })),
    }));
    yield* publishInstanceStatusChanged(instanceId);
    yield* Effect.logInfo("Restarting instance");
  }).pipe(Effect.annotateLogs("instanceId", instanceId));

/** Cancel both poller and restart fibers for an instance */
export const cancelInstanceFibers = (instanceId: string) =>
  Effect.gen(function* () {
    const fibers = yield* PollerFibersTag;
    yield* FiberMap.remove(fibers, pollerKey(instanceId));
    yield* FiberMap.remove(fibers, restartKey(instanceId));
  });
```

**Step 9: Run tests to verify they pass**

```bash
pnpm vitest run test/unit/effect/instance-manager-service.test.ts -v
```

**Step 10: Verify no regressions**

```bash
pnpm check && pnpm test:unit
```

**Step 11: Commit**

```bash
git add -A && git commit -m "feat(effect): add health polling and restart scheduling to InstanceManager Effect service"
```

---

## Task 4: Self-Constructing Service Layers

> **AUDIT FIXES applied:** AP-R2-6 (dual-Tag architecture), AP-R2-7 (name collision), AP-R2-15 (HashMap), AP-R2-16 (deps), AU-R2-1 (user chose Option B: state Tags only).

**Goal:** Ensure each Effect-native state module exports a self-constructing `*Live` Layer. These Layers provide the *Effect-native state Tags* (e.g., `SessionRegistryStateTag`, `OverridesStateTag`, `WsHandlerStateTag`), NOT the bridge Tags (e.g., `SessionRegistryTag`). Bridge Tags remain provided via `Layer.succeed(Tag, oldInstance)` until Task 8 deletes them.

**Architecture (Option B):** The branch has a dual-Tag architecture per service:
- *Bridge Tag* (e.g., `SessionRegistryTag`) — typed to old imperative class, sync methods. Used by existing consumers via `makeHandlerLayer`.
- *Effect-native state Tag* (e.g., `SessionRegistryStateTag`) — typed to `Ref<HashMap>` or similar. Used by Effect handler functions.

This task creates `*Live` Layers for the state Tags. Consumers are progressively converted to use state Tags directly (Tasks 5-7). Bridge Tags + old classes are deleted in Task 8.

**Services — state Tags to ensure have self-constructing Live Layers:**
- `SessionManagerStateTag` — already self-constructing via `makeSessionManagerStateLive()` in `session-manager-state.ts`
- `SessionManagerServiceTag` — already provided by `SessionManagerServiceLive` in `session-manager-service.ts` (4 Effect methods: `listSessions`, `createSession`, `deleteSession`, `recordMessageActivity`; these functions require `SessionManagerStateTag` at call time)
- `SessionRegistryStateTag` — already self-constructing via `makeSessionRegistryStateLive()` in `session-registry-state.ts`
- `OverridesStateTag` — already self-constructing via `makeOverridesStateLive()` in `session-overrides-state.ts`
- `PollerManagerStateTag` — already self-constructing via `makePollerManagerStateLive()` in `message-poller.ts`
- `PollerStateTag` + `PollerPubSubTag` — already self-constructing via `makePollerStateLive()` + `makePollerPubSubLive()` in `session-status-poller.ts`
- `WsHandlerStateTag` — already self-constructing via `makeWsHandlerStateLive()` in `ws-handler-service.ts`
- `InstanceManagerStateTag` + `PollerFibersTag` — already self-constructing via `makeInstanceManagerStateLive()` in `instance-manager-service.ts`
- **NEW:** `PtyManagerStateTag` — needs to be created (no Effect-native module exists yet)

**Files:**
- Verify: existing `*Live` / `make*Live()` exports in all state modules above
- Create: `src/lib/effect/pty-manager-service.ts` (new — define `PtyManagerStateTag` + `PtyManagerStateLive`)
- Test: Existing tests + new Layer composition test

**Step 1: Verify existing state modules already export Live Layers**

```bash
# Each should show a make*Live or *Live export:
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/session-registry-state.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/session-overrides-state.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/message-poller.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/session-status-poller.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/ws-handler-service.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/instance-manager-service.ts
rg "export.*(make.*Live|.*Live\b)" src/lib/effect/session-manager-service.ts
```

If any module is missing a Live Layer export, add one following the existing pattern.

**Step 2: Create PtyManagerStateTag + PtyManagerStateLive**

The old `src/lib/relay/pty-manager.ts` (`PtyManager` class) has no Effect replacement. Create a new Effect-native state module:

```typescript
// src/lib/effect/pty-manager-service.ts
import { Context, Effect, HashMap, Layer, Ref } from "effect";
import type { PtySessionState } from "../relay/pty-manager.js";

export interface PtyManagerState {
  sessions: HashMap.HashMap<string, PtySessionState>;
}

export class PtyManagerStateTag extends Context.Tag("PtyManagerState")<
  PtyManagerStateTag,
  Ref.Ref<PtyManagerState>
>() {}

export const PtyManagerStateLive: Layer.Layer<PtyManagerStateTag> = Layer.effect(
  PtyManagerStateTag,
  Ref.make<PtyManagerState>({ sessions: HashMap.empty() }),
);

// Effect-native functions operating on PtyManagerStateTag:
export const registerPtySession = (sessionId: string, session: PtySessionState) =>
  Effect.gen(function* () {
    const ref = yield* PtyManagerStateTag;
    yield* Ref.update(ref, (s) => ({
      sessions: HashMap.set(s.sessions, sessionId, session),
    }));
  }).pipe(Effect.annotateLogs("sessionId", sessionId));

export const removePtySession = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* PtyManagerStateTag;
    yield* Ref.update(ref, (s) => ({
      sessions: HashMap.remove(s.sessions, sessionId),
    }));
  }).pipe(Effect.annotateLogs("sessionId", sessionId));

export const getPtySession = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* PtyManagerStateTag;
    const state = yield* Ref.get(ref);
    return HashMap.get(state.sessions, sessionId);
  });
```

**Step 3: Verify each module compiles**

```bash
pnpm check
```

**Step 4: Write a composition test**

```typescript
// test/unit/effect/self-constructing-layers.test.ts
import { describe, expect } from "@effect/vitest";
import { Effect, Layer, Ref, HashMap } from "effect";

describe("Self-constructing service layers", () => {
  const testLayer = Layer.mergeAll(
    makeSessionRegistryStateLive(),
    makeOverridesStateLive(),
    makePollerManagerStateLive(),
    makeWsHandlerStateLive(),
    PtyManagerStateLive,
  );

  it.effect("composes all Effect-native state layers", () =>
    Effect.gen(function* () {
      const registryRef = yield* SessionRegistryStateTag;
      const registry = yield* Ref.get(registryRef);
      expect(HashMap.size(registry)).toBe(0);
    }).pipe(Effect.provide(Layer.fresh(testLayer)))
  );
});
```

**Step 5: Verify no regressions**

```bash
pnpm check && pnpm test:unit
```

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(effect): create PtyManagerStateTag + verify all state Tags have Live Layers"
```

---

## Task 5: Relay Stack Layer Conversion

**Goal:** Rewrite `createProjectRelay()` in `relay-stack.ts` to construct Effect Layers directly instead of instantiating old classes and wrapping them in bridge layers. This is the core migration task.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (major rewrite of `createProjectRelay`)
- Modify: `src/lib/relay/effect-relay-runtime.ts` (simplify — no more bridge deps)
- Modify: `src/lib/effect/layers.ts` (replace `makeHandlerLayer` with Layer composition)
- Test: `test/unit/effect/relay-stack-layers.test.ts` (new)

**Step 1: Map the current construction sequence**

Read `relay-stack.ts:403-1026`. Note the construction order:
1. SDK client (already Effect)
2. OpenCodeAPI (class — stays as `Layer.succeed`)
3. OrchestrationLayer (imperative factory)
4. SessionManager (old class, 454-465)
5. SessionOverrides (old class, 468)
6. ReadQueryService (old class, 490-493)
7. StatusPoller (Effect-native, 506-584)
8. SessionRegistry (old class, 587)
9. MessagePollerManager (old class, 591-598)
10. PtyManager (old class, 608)
11. EffectWsHandler (hybrid class, 658-664)
12. QuestionBridge (old class, 689)
13. EffectRuntime (bridge layers, 777-799)
14. Wiring (SSE, monitoring, lifecycle, pollers, timers)

**Step 2: Create `RelayStateLive` — a composed Layer for all Effect-native state Tags**

> **AUDIT FIXES:** AP-R2-8 (enumerate ALL Tags), AP-R2-9 (remove OpenCodeAPILive), AP-R2-10 (include poller layers).

```typescript
// src/lib/effect/relay-layer.ts (new file)
import { Layer } from "effect";

/**
 * Composes all Effect-native state Layers. These provide the state Tags
 * that Effect handler functions use. Bridge Tags (for old imperative consumers)
 * are still provided by makeHandlerLayer in layers.ts during this transition.
 *
 * External deps provided by caller: OpenCodeAPITag, ConfigTag, LoggerTag.
 */
export const RelayStateLive = Layer.mergeAll(
  // Session state
  makeSessionRegistryStateLive(),
  makeOverridesStateLive(),
  makeSessionManagerStateLive(),  // provides SessionManagerStateTag
  // Session manager Effect service (provides SessionManagerServiceTag — needs StateTag at call time)
  SessionManagerServiceLive,
  // Poller state
  makePollerManagerStateLive(),
  makePollerStateLive(),
  makePollerPubSubLive(),
  // WebSocket handler state
  makeWsHandlerStateLive(),
  // PTY state (new from Task 4)
  PtyManagerStateLive,
  // Instance management state
  makeInstanceManagerStateLive(),
  // Event bus
  DaemonEventBusLive,
  // Rate limiter
  RateLimiterLive({ maxRequests: 5, windowMs: 10_000 }),
);
// NOTE: The following Tags are still provided externally via Layer.succeed
// in createProjectRelay (Step 3) during the transition period:
//
// External deps (stay as Layer.succeed):
//   OpenCodeAPITag, ConfigTag, LoggerTag
//
// Bridge Tags (deleted in Task 8 when consumers are converted):
//   SessionManagerTag, SessionRegistryTag, SessionOverridesTag,
//   WebSocketHandlerTag, PtyManagerTag, StatusPollerTag, PollerManagerTag,
//   PermissionBridgeTag, QuestionBridgeTag, ConnectPtyUpstreamTag,
//   ForkMetaTag, OrchestrationEngineTag
//
// Optional persistence/daemon Tags (if enabled):
//   ReadQueryTag, ClaudeEventPersistTag, ProviderStateServiceTag,
//   InstanceMgmtTag, ProjectMgmtTag, ScanDepsTag
```

**Step 3: Rewrite `createProjectRelay` to use `RelayStateLive`**

> **AUDIT FIX (AP-R2-9):** `OpenCodeAPITag` provided via `Layer.succeed` here, not a non-existent `OpenCodeAPILive`.

Replace the imperative construction with:

```typescript
export async function createProjectRelay(config: ProjectRelayConfig): Promise<ProjectRelay> {
  // 1. Create SDK client (already Effect)
  const { client: sdkClient, fetch: sdkFetch, authHeaders } = Effect.runSync(
    createSdkClientEffect({ baseUrl: config.opencodeUrl, ... })
  );

  // 2. OpenCodeAPI — still a class, provided via Layer.succeed
  const api = new OpenCodeAPI({ sdk: sdkClient, gapEndpoints, ... });
  const apiLayer = Layer.succeed(OpenCodeAPITag, api);

  // 3. External deps still provided as bridge layers
  const configLayer = Layer.succeed(ConfigTag, config);
  const loggerLayer = Layer.succeed(LoggerTag, logger);
  // ... other external deps (PermissionBridgeTag, QuestionBridgeTag, etc.)
  //     still instantiated imperatively and provided via Layer.succeed

  // 4. Compose: state layers + external bridge layers
  const fullLayer = RelayStateLive.pipe(
    Layer.provide(apiLayer),
    Layer.provide(configLayer),
    Layer.provide(loggerLayer),
    // ... provide other external bridge layers
  );

  // 5. Create ManagedRuntime from the composed layer
  const runtime = ManagedRuntime.make(fullLayer);

  // 6. Wire event pipeline (SSE, monitoring, pollers)
  // These use the runtime to access services instead of holding class references
  // ...
}
```

**Step 4: Update the relay wiring functions**

The wiring functions (`wireSSEConsumer`, `wireMonitoring`, `wirePollers`, `wireSessionLifecycle`, `wireTimers`) currently take old class instances as deps. Update their signatures to take an Effect runtime or access services via Tags:

```typescript
// Option A: Pass runtime, wire functions call runtime.runPromise(Effect.gen(...))
// Option B: Convert wire functions to Effect programs that run inside the runtime

// AUDIT FIX (AP-R2-11): Use runPromise, not runSync — Layers may involve
// async operations (DB, HTTP). ManagedRuntime.make returns synchronously but
// constructs Layers lazily on first run call. runSync will throw if any
// Layer involves async operations.

// Option A is lower risk for this task:
const wsHandler = await runtime.runPromise(Effect.gen(function* () { return yield* WsHandlerStateTag; }));
const registryRef = await runtime.runPromise(Effect.gen(function* () { return yield* SessionRegistryStateTag; }));
// ... pass extracted refs to wiring functions
wireSSEConsumer({ wsHandler, registryRef, ... }, sseStream);
```

Option A preserves existing wiring function signatures. Option B (full conversion) is Task 9.

**Step 5: Write a test verifying Layer composition works end-to-end**

```typescript
// test/unit/effect/relay-stack-layers.test.ts
import { describe, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";

describe("Relay stack Layer composition", () => {
  it.effect("constructs all services from a single composed Layer", () =>
    Effect.gen(function* () {
      const wsHandler = yield* WebSocketHandlerTag;
      const sessionMgr = yield* SessionManagerTag;
      const registry = yield* SessionRegistryTag;
      // Verify services are available and functional
      const count = yield* wsHandler.getClientCount;
      expect(count).toBe(0);
    }).pipe(Effect.provide(testRelayLayer))
  );
});
```

**Step 6: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor(effect): rewrite relay-stack to use self-constructing Effect Layers"
```

---

## Task 6: Daemon Entry Point Conversion

**Goal:** Wire `daemon-layers.ts` as the actual daemon entry point via `Layer.launch`, replacing the imperative startup in `daemon-main.ts`.

**Files:**
- Modify: `src/lib/effect/daemon-main.ts` (replace imperative startup with `Layer.launch`)
- Modify: `src/lib/effect/daemon-layers.ts` (update to compose relay layers + background services)
- Modify: `src/lib/daemon/daemon-lifecycle.ts` (may be partially retained for server start/stop)
- Test: `test/unit/effect/daemon-main.test.ts`

**Step 1: Read the current daemon-main.ts and daemon-layers.ts**

> **AUDIT FIX (AP-R4-3):** `makeDaemonLive(options: DaemonLiveOptions)` already exists at `daemon-layers.ts:320-376`. It composes infrastructure (signal handlers, error handlers, PID file), servers (HTTP, IPC, onboarding), background services, state, DaemonEventBusLive, PinoLoggerLive, and relay cache. Do NOT create a parallel composition — modify the existing one.

> **AUDIT FIX (AP-R4-4):** `DaemonLiveOptions` requires imperative types (`DaemonLifecycleContext`, `DaemonIPCContext`, `OnboardingServerDeps`, `getStatus` callback) from old modules. A pure `Layer.launch` approach requires all deps to be Layers. This conversion is too large for a single task. Use a **phased approach**: keep imperative option construction in this task, use `Layer.launch(makeDaemonLive(options))` as the entry point. Full conversion of `DaemonLiveOptions` to self-constructing Layers happens when daemon-lifecycle.ts and daemon-ipc.ts are replaced.

Understand the gap between:
- `daemon-main.ts` (imperative entry, 1540 lines — constructs `DaemonLiveOptions` imperatively)
- `daemon-layers.ts` (Layer definitions, 377 lines — `makeDaemonLive` already composes all Layers)

**Step 2: Replace imperative startup with `Layer.launch`**

> **AUDIT FIX (AP-R2-12):** Conventions say "Use `Layer.launch` for the top-level daemon program." `Layer.launch` constructs the Layer, runs until interrupted (SIGINT/SIGTERM), then tears down all finalizers in reverse order — exactly the daemon lifecycle.

The existing `makeDaemonLive(options)` already handles composition. The change is in `daemon-main.ts` — replace the imperative startup sequence with:

```typescript
// daemon-main.ts — keep the imperative DaemonLiveOptions construction for now,
// but replace the startup/shutdown wiring with Layer.launch:

// 1. Build options imperatively (existing code — retain for now)
const options: DaemonLiveOptions = {
  configDir, pidPath, socketPath,
  ctx: lifecycleCtx,
  ipcContext,
  getStatus: () => currentStatus,
  onboarding: onboardingDeps,
  keepAwake: keepAwakeConfig,
  versionCheck: versionCheckConfig,
  storageMon: storageMonConfig,
  portScanner: portScannerConfig,
  configPath: daemonConfigPath,
  relayFactory,
};

// 2. Use Layer.launch instead of manual Deferred.await + signal handlers
const DaemonProgram = Layer.launch(makeDaemonLive(options));
Effect.runFork(DaemonProgram);
```

**Step 3: Delete imperative shutdown/signal wiring from daemon-main.ts**

`Layer.launch` handles SIGINT/SIGTERM → Layer teardown automatically. Delete:
- Manual `process.on("SIGINT", ...)` / `process.on("SIGTERM", ...)` handlers
- Manual `Deferred.await` for server-ready signals
- Manual `await runtime.dispose()` calls
- Any imperative shutdown sequencing

These are now handled by `makeDaemonLive`'s Layer finalizers (which already exist in daemon-layers.ts).

Note: `Layer.launch` returns `Effect<never, E, RIn>`. Background tasks (project discovery, health polling) should be started as fibers inside `Layer.scoped` Layers — they are automatically interrupted on shutdown.

**Step 4: Test the daemon starts and shuts down cleanly**

```typescript
// test/unit/effect/daemon-main.test.ts
describe("Daemon lifecycle", () => {
  it.scoped("starts and stops cleanly via Layer", () =>
    Effect.gen(function* () {
      // Provide test layers with mock deps
      // Start daemon
      // Verify services are running
      // Signal shutdown
      // Verify cleanup ran
    })
  );
});
```

**Step 5: Verify**

```bash
pnpm check && pnpm test:unit && pnpm build
```

**Step 6: Manual smoke test**

```bash
# Start the daemon and verify it serves HTTP + WS
pnpm dev
# Open browser, verify UI loads and WebSocket connects
```

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor(effect): wire daemon entry via Layer.launch, replace imperative startup"
```

---

## Task 7: Handler Cleanup — Remove Promise Variants

**Goal:** Delete the Promise-based handler functions. The Effect variants (`*Effect` suffix) are the only code path via `dispatchMessageEffect()`. The old Promise handlers are dead code.

**Files:**
- Modify: `src/lib/handlers/session.ts`, `prompt.ts`, `agent.ts`, `model.ts`, `settings.ts`, `instance.ts`, `terminal.ts`, `files.ts`, `permissions.ts`, `tool-content.ts`, `reload.ts`
- Modify: `src/lib/handlers/index.ts` (remove old exports)
- Modify: `src/lib/handlers/types.ts` (remove `HandlerDeps`, `MessageHandler` types)
- Test: Existing handler tests

**Step 1: Verify no consumers of Promise handlers remain**

```bash
# Check for imports of old non-Effect handler functions
rg "handleListSessions[^E]" --type ts -l  # Should NOT match anything (only handleListSessionsEffect)
rg "handleMessage[^E]" --type ts -l
rg "handleGetAgents[^E]" --type ts -l
# Check for HandlerDeps usage
rg "HandlerDeps" --type ts -l
```

If any consumers remain outside of test files, update them to use the Effect variants first.

**Step 2: For each handler file, delete the Promise variant**

Pattern for each file (e.g., `session.ts`):
1. Delete `handleListSessions` (Promise-based)
2. Rename `handleListSessionsEffect` → `handleListSessions`
3. Update the `EFFECT_MESSAGE_HANDLERS` dispatch table in `index.ts`
4. Run `pnpm check` after each file

**Step 3: Convert `resolveSession` to use Effect Tags**

> **AUDIT FIX (AP-R4-5):** `resolveSession` and `resolveSessionForLog` in `resolve-session.ts` depend on `HandlerDeps` (3 occurrences). Deleting `HandlerDeps` without converting these functions breaks compilation. Convert them first.

```bash
# Verify dependency:
rg "HandlerDeps" src/lib/handlers/resolve-session.ts
```

Convert both functions to read deps from Effect Tags instead of `HandlerDeps`:
```typescript
// resolve-session.ts — BEFORE:
export function resolveSession(deps: HandlerDeps, clientId: string) { ... }

// AFTER: Effect-native version using Tags
export const resolveSession = (clientId: string) =>
  Effect.gen(function* () {
    const registry = yield* SessionRegistryStateTag;
    // ... resolve session from registry state
  });
```

Update all callers of `resolveSession` to use the Effect version. Run `pnpm check` after.

**Step 4: Clean up types**

- Delete `HandlerDeps` interface from `types.ts`
- Delete `MessageHandler` type
- Delete `EffectHandler` type if the rename makes it redundant

**Step 5: Update index.ts exports**

Remove all old handler exports. Only export Effect-based handlers and `dispatchMessageEffect`.

**Step 6: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor(effect): remove Promise-based handler variants, Effect-only dispatch"
```

---

## Task 8: Delete Bridge Layers & Old Classes

**Goal:** Delete the bridge layer factories (`layers.ts`) and all old imperative classes that have been fully replaced.

**Files:**
- Delete: `src/lib/effect/layers.ts` (bridge layer factories)
- Delete: `src/lib/session/session-manager.ts`
- Delete: `src/lib/session/session-registry.ts`
- Delete: `src/lib/session/session-overrides.ts`
- Delete: `src/lib/session/session-status-poller.ts`
- Delete: `src/lib/session/session-switch.ts`
- Delete: `src/lib/relay/message-poller-impl.ts`
- **RETAIN:** `src/lib/daemon/daemon-lifecycle.ts` — still imported by `daemon-layers.ts` for server start/close functions (`startHttpServer`, `closeHttpServer`, `startIPCServer`, `closeIPCServer`, `startOnboardingServer`, `closeOnboardingServer`, `DaemonLifecycleContext`, `OnboardingServerDeps`). Cannot delete until these are replaced with Effect-native server Layers.
- **RETAIN:** `src/lib/daemon/daemon-ipc.ts` — still imported by `daemon-layers.ts` for `DaemonIPCContext` type. Cannot delete until `DaemonLiveOptions` is refactored to use Effect Tags.
- Delete: Any other old modules identified in Task 1 as "blocked" (except the two above)
- Modify: `src/lib/relay/effect-relay-runtime.ts` (simplify or delete — runtime now created directly)
- Test: Run full test suite

**Step 1: Verify zero imports of bridge layers**

```bash
rg "from.*effect/layers" --type ts -l
rg "makeHandlerLayer\|makeOpenCodeAPILive\|makeSessionManagerLive" --type ts -l
```

Any remaining imports must be updated to use the self-constructing `*Live` Layers.

**Step 2: Delete bridge layer factories**

Delete `src/lib/effect/layers.ts` and `src/lib/relay/effect-relay-runtime.ts` (if relay-stack no longer uses them).

**Step 3: Delete old classes one at a time**

For each old class:
1. Grep for imports: `rg "from.*session/session-manager" --type ts -l`
2. If zero consumers, delete the file
3. Run `pnpm check` after each deletion

**Step 4: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor(effect): delete bridge layers and old imperative classes"
```

---

## Task 9: Relay Imperative Glue Conversion

**Goal:** Convert the remaining imperative relay wiring functions to Effect programs that run inside the relay's ManagedRuntime.

**Files:**
- Modify: `src/lib/relay/timer-wiring.ts` → convert `wireTimers` to Effect
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` → convert `wireSessionLifecycle` to Effect
- Modify: `src/lib/relay/poller-wiring.ts` → convert `wirePollers` to Effect
- Modify: `src/lib/relay/monitoring-wiring.ts` → convert `wireMonitoring` to Effect
- Modify: `src/lib/relay/sse-wiring.ts` → convert `wireSSEConsumer` to Effect
- Test: `test/unit/effect/relay-wiring.test.ts`

**Step 1: Convert `wireTimers` (simplest — just a permission timeout interval)**

Read `src/lib/relay/timer-wiring.ts`. Replace `setInterval` with `Effect.repeat(effect, Schedule.fixed(...))` inside a scoped fiber.

```typescript
// timer-wiring.ts — converted
export const PermissionTimeoutLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const permBridge = yield* PermissionBridgeTag;
    const wsHandler = yield* WebSocketHandlerTag;

    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.gen(function* () {
          const expired = permBridge.expireTimedOut();
          for (const { clientId, message } of expired) {
            yield* wsHandler.sendTo(clientId, message);
          }
        }),
        Schedule.fixed("1 second")
      )
    );
  })
);
```

**Step 2: Convert `wireSessionLifecycle`**

Replace EventEmitter `.on("broadcast")` and `.on("session_lifecycle")` subscriptions with PubSub subscriptions via `DaemonEventBusTag`.

**Step 3: Convert `wirePollers`**

Replace callback-based poller management with FiberMap-based Effect pollers.

**Step 4: Convert `wireMonitoring`**

Replace imperative state tracking with Ref-based state in Effect.

**Step 5: Convert `wireSSEConsumer`**

The SSE stream callback pattern → Effect Stream consumption with `Stream.runForEach`.

**Step 6: Compose wiring Layers into RelayStateLive**

> **AUDIT FIX (AP-R4-7):** Without this step, the 5 wiring Layers exist as dead code — never included in any Layer tree.

Update `relay-layer.ts` (from Task 5) to include all wiring Layers:

```typescript
// src/lib/effect/relay-layer.ts — add wiring Layers to RelayStateLive
export const RelayStateLive = Layer.mergeAll(
  // ...existing state layers from Task 5...
  // Wiring Layers (Task 9 — all independent, use mergeAll)
  PermissionTimeoutLive,
  SessionLifecycleWiringLive,
  PollerWiringLive,
  MonitoringWiringLive,
  SSEWiringLive,
);
```

**Step 7: Test each conversion**

```bash
pnpm vitest run test/unit/effect/relay-wiring.test.ts -v
```

**Step 8: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 9: Commit per wiring function (5 commits)**

```bash
git add -A && git commit -m "refactor(effect): convert wireTimers to Effect Layer"
# ... one commit per wiring function
```

---

## Task 10: Provider Layer Conversion

> **AUDIT FIX (AP-R2-13):** `src/lib/effect/orchestration-service.ts` already exists with `IdempotencySetTag`, `makeIdempotencySetLive()`, and a background eviction fiber. This task extends it, not creates from scratch.

**Goal:** Extend the existing `orchestration-service.ts` to provide the full `OrchestrationEngineTag` service, and convert provider adapters to Effect Layers.

**Files:**
- Modify: `src/lib/effect/orchestration-service.ts` (extend — already has `IdempotencySetTag` + eviction)
- Modify: `src/lib/provider/orchestration-wiring.ts` (replace imperative factory)
- Modify: `src/lib/provider/orchestration-engine.ts` → Effect service
- Modify: `src/lib/provider/opencode-adapter.ts` → Effect service
- Modify: `src/lib/provider/claude/claude-adapter.ts` → already partially Effect
- Test: `test/unit/effect/orchestration.test.ts`

**Step 1: Read existing `orchestration-service.ts` and extend it**

The file already has:
- `IdempotencySetTag` — Ref-backed idempotency set with TTL eviction
- `makeIdempotencySetLive()` — scoped Layer with background eviction fiber
- Uses native `Map` (documented exception — insertion-order iteration for TTL)

Add `OrchestrationEngineLive` to this file, composing with `IdempotencySetTag`:

```typescript
// src/lib/effect/orchestration-service.ts — add below existing code:
export const OrchestrationEngineLive: Layer.Layer<
  OrchestrationEngineTag,
  never,
  OpenCodeAPITag | ConfigTag | IdempotencySetTag
> = Layer.scoped(
  OrchestrationEngineTag,
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const config = yield* ConfigTag;
    const idempotency = yield* IdempotencySetTag;
    // Build provider registry, create adapters, wire engine
    // using existing idempotency set for dedup
    // ...
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => engine.shutdown())
    );
    return engine;
  })
);
```

**Step 2: Convert OpenCodeAdapter to Effect**

Replace Promise-based `sendTurn()` / `interruptTurn()` with Effect programs.

**Step 3: ClaudeAdapter — prompt queue boundary**

Mainline Phase 6.43 made `claude/effect-prompt-queue.ts` genuinely Effect-native: queue construction and producer
operations return Effects, and the Claude adapter yields those effects instead of calling a local runtime bridge.
The remaining adapter work is lifecycle ownership by a Layer finalizer.

**Step 4: Test**

```bash
pnpm vitest run test/unit/effect/orchestration.test.ts -v
```

**Step 5: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor(effect): convert orchestration/provider layer to Effect services"
```

---

## Task 11: Metrics Completion

> **AUDIT FIX (AP-R2-14):** `metrics.ts` already has 7 real metrics: `wsConnectionsGauge`, `activePollersGauge`, `sseReconnectsCounter`, `rateLimitRejectionsCounter`, `ipcCommandsCounter`, `configPersistsCounter`, `ipcLatencyHistogram`. This task extends (not replaces) the existing file.

**Goal:** Extend the existing `metrics.ts` with additional counters/gauges and wire ALL metrics into service code.

**Files:**
- Modify: `src/lib/effect/metrics.ts` (add new metrics only — do NOT overwrite existing ones)
- Modify: Service files that should emit metrics (ws-handler, session-manager, instance-manager, etc.)
- Test: `test/unit/effect/metrics.test.ts`

**Step 1: Add NEW metrics to existing file**

```typescript
// src/lib/effect/metrics.ts — ADD below existing metrics:

// Session metrics (new)
export const sessionsCreatedCounter = Metric.counter("conduit.sessions.created");
export const sessionsActiveGauge = Metric.gauge("conduit.sessions.active");

// Message metrics (new)
export const messagesDispatchedCounter = Metric.counter("conduit.messages.dispatched");
export const messageErrorsCounter = Metric.counter("conduit.messages.errors");

// Health polling (new)
export const healthCheckFailuresCounter = Metric.counter("conduit.health_check.failures");

// Instance management (new)
export const instanceRestartsCounter = Metric.counter("conduit.instances.restarts");
```

**Step 2: Wire metrics into service code**

Specific wiring locations:
- `ws-handler-service.ts`: `yield* Metric.increment(wsConnectionsGauge)` on `addClient`, decrement on `removeClient`
- `session-manager-service.ts`: `yield* Metric.increment(sessionsCreatedCounter)` on `createSession`
- `instance-manager-service.ts`: `yield* Metric.increment(healthCheckFailuresCounter)` on health check failure, `yield* Metric.increment(instanceRestartsCounter)` on restart
- `ipc-dispatch.ts`: `ipcCommandsCounter` already wired — verify
- `ipc-handlers.ts`: `ipcLatencyHistogram` already wired — verify

**Step 3: Test**

```typescript
it.effect("increments ws connection counter on addClient", () =>
  Effect.gen(function* () {
    yield* addClient("c1", mockWs);
    const count = yield* Metric.value(wsConnectionsTotal);
    expect(count).toEqual(MetricState.counter(1));
  }).pipe(Effect.provide(Layer.fresh(testLayer)))
);
```

**Step 4: Verify**

```bash
pnpm check && pnpm test:unit
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(effect): complete metrics with real counters and gauges"
```

---

## Merge Milestone M6

After all Phase 7 tasks are complete:

```bash
pnpm check && pnpm test && pnpm build && pnpm test:e2e && pnpm dev
```

**What's safe:** All old imperative classes deleted. Zero bridge layers. Single Effect-only handler dispatch path. All relay wiring runs as Effect programs. Provider layer is Effect-native.

**What remains:** Frontend Svelte stores (intentionally excluded — correct tool for the job). OpenCodeAPI wrapper class (wraps external SDK). Pure function modules (no conversion needed).

---

## Audit Fixes Incorporated

### Round 1 (2026-04-28)

**Amend Plan (7 findings):**

- **AP-1** — Task 2 already implemented on branch. Converted to verification-only step.
- **AP-2** — Task 3 health check used non-existent `api.app.health()`. Fixed: raw HTTP fetch to `http://localhost:{port}/health` per instance port.
- **AP-3** — Task 3 used wrong status values `"running"/"error"`. Fixed: `"healthy"/"unhealthy"` per `InstanceStatus` type.
- **AP-4** — Task 3 used `Schedule.fixed("30 seconds")`. Fixed: `Schedule.spaced(Duration.millis(config.healthPollIntervalMs))` with 5s default, per codebase convention.
- **AP-5** — Task 3 `scheduleRestart` was a placeholder. Fixed: full restart logic with windowed rate-limiting, exponential backoff capped at 30s, crash counter, give-up transition to "stopped", error publishing.
- **AP-6** — Task 3 missing status change broadcasting. Fixed: added `DaemonEventBusTag` with `PubSub.publish` on status transitions and restart errors.
- **AP-7** — Task 3 test treated `FiberMap.has` as sync. Fixed: `const exists = yield* FiberMap.has(...)`.

**Ask User (1 finding — resolved):**

- **AU-1** — Restart fiber management: user chose **same FiberMap with key prefixes** (`"poller:{id}"` / `"restart:{id}"`). One FiberMap, one cleanup path. `cancelInstanceFibers` removes both.

**Accept (3 findings):**

- Minor race window in SessionOverrides timers (unlikely, serialized per-session)
- PollerFibersTag not re-exported from services.ts (internal concern, acceptable)
- Dual-tag bridge pattern expected at this phase (resolved in Tasks 4/8)

**Incomplete audits (5 of 7):**

Tasks 1, 4-5, 6-8, 9-11, and Effect-TS compliance auditors completed investigation but did not produce written report files. The executing agent should verify each task's code against actual codebase state before implementing.

### Round 4 (2026-04-29)

**Amend Plan (7 findings):**

- **AP-R4-1** — Task 3: existing `Date.now()` at instance-manager-service.ts:106 in `addInstance` breaks TestClock. Fixed: added Step 0 to replace with `Clock.currentTimeMillis`.
- **AP-R4-2** — Task 3: tests used `it.effect` but `FiberMap.make()` requires `Scope.Scope`. Fixed: changed all to `it.scoped`.
- **AP-R4-3** — Task 6: plan proposed creating `DaemonLive` from scratch, but `makeDaemonLive(options)` already exists at daemon-layers.ts:320-376 with full composition. Fixed: rewrote to modify existing function.
- **AP-R4-4** — Task 6: `DaemonLiveOptions` takes imperative types incompatible with pure `Layer.launch`. Fixed: phased approach — keep imperative construction, use `Layer.launch(makeDaemonLive(options))`.
- **AP-R4-5** — Task 7: deleting `HandlerDeps` breaks `resolveSession`/`resolveSessionForLog` in resolve-session.ts (3 occurrences). Fixed: added Step 3 to convert these functions to Effect Tags before deletion.
- **AP-R4-6** — Task 8: `daemon-layers.ts` imports from `daemon-lifecycle.ts` (server start/close) and `daemon-ipc.ts` (IPC context type). Fixed: marked both as RETAIN — cannot delete until imports replaced.
- **AP-R4-7** — Task 9: wiring Layers not composed into any Layer tree. Fixed: added Step 6 to compose into `RelayStateLive` in relay-layer.ts.

### Round 2 (2026-04-29)

**Amend Plan (16 findings):**

- **AP-R2-1** — Task 1: daemon-main.ts instantiates old classes (PortScanner, VersionChecker, KeepAwake, StorageMonitor). Added to blocked list — not deletable until Task 6.
- **AP-R2-2** — Task 3: event publishing used plain objects instead of `DaemonEvent` TaggedEnum constructors. Fixed: use `publishInstanceStatusChanged(instanceId)` helper from daemon-pubsub.ts.
- **AP-R2-3** — Task 3: `instance_error` event type missing from `DaemonEvent` enum. Fixed: added step to extend enum with `InstanceError` variant + `publishInstanceError` helper.
- **AP-R2-4** — Task 3: `startInstance` function doesn't exist. Fixed: defined `restartInstance` function that resets status to "starting" and publishes status change.
- **AP-R2-5** — Task 3: `Date.now()` untestable under TestClock. Fixed: replaced with `yield* Clock.currentTimeMillis`.
- **AP-R2-6** — Task 4: dual-Tag architecture type incompatibility. Fixed: rewrote Task 4 to use Option B (state Tags only). `*Live` Layers provide Effect-native state Tags, not bridge Tags.
- **AP-R2-7** — Task 4: `SessionManagerServiceLive` name collision. Fixed: Task 4 now verifies existing Live Layers rather than creating duplicates.
- **AP-R2-8** — Task 5: `RelayServiceLive` missing ~15 required Tags. Fixed: renamed to `RelayStateLive`, enumerated all state Tag layers, documented externally-provided bridge Tags.
- **AP-R2-9** — Task 5: `OpenCodeAPILive` referenced but never defined. Fixed: removed, clarified `OpenCodeAPITag` provided externally via `Layer.succeed`.
- **AP-R2-10** — Task 5: status poller's separate `ManagedRuntime` not addressed. Fixed: added `makePollerStateLive()` and `makePollerPubSubLive()` to `RelayStateLive`.
- **AP-R2-11** — Task 5: `runtime.runSync` may fail with async Layer construction. Fixed: changed to `await runtime.runPromise(...)`.
- **AP-R2-12** — Task 6: used `Effect.runPromise` + manual `Deferred.await` instead of `Layer.launch`. Fixed: use `Layer.launch(DaemonLive)` per conventions.
- **AP-R2-13** — Task 10: assumed `orchestration-service.ts` doesn't exist. Fixed: references existing `IdempotencySetTag` + `makeIdempotencySetLive()`, extends rather than creates.
- **AP-R2-14** — Task 11: assumed `metrics.ts` is a stub. Fixed: it already has 7 real metrics. Task now extends existing file.
- **AP-R2-15** — Task 4: plan example used `new Map` instead of `HashMap`. Fixed: Task 4 rewritten to verify existing state modules which already use `HashMap`.
- **AP-R2-16** — Task 4: `SessionManagerServiceLive` deps incomplete. Fixed: Task 4 now documents existing `SessionManagerServiceTag` (4 methods) and notes the gap vs full `SessionManagerShape` (~20 methods).

**Ask User (1 finding — resolved):**

- **AU-R2-1** — Tag service type design decision: user chose **Option B (state Tags only)**. `*Live` Layers provide Effect-native state Tags. Bridge Tags stay as-is until Task 8 deletes them. Consumers progressively converted in Tasks 5-7.

**Accept (5 findings):**

- Task 7 handler cleanup confirmed needed (both Promise and Effect variants exist)
- Task 9 wiring files, Tags, and APIs all confirmed to exist
- `HashMap.modify` confirmed in Effect 3.21 (erroneously flagged during investigation)
- `FiberMap.has` returns `Effect<boolean>` (Round 1 fix AP-7 correctly applied)
- `ManagedRuntime.make`, `MetricState.counter`, `Layer.launch` all confirmed in Effect 3.21

### Round 3 (2026-04-29)

**Amend Plan (6 findings):**

- **AP-R3-1** — Task 3: `InstanceManagerConfigTag` doesn't exist. Config is embedded in `InstanceManagerState.config`. Fixed: replaced `yield* InstanceManagerConfigTag` with `const { config } = yield* Ref.get(stateRef)`.
- **AP-R3-2** — Task 4: wrong Tag attribution. Plan said `SessionManagerStateTag` is "provided by `SessionManagerServiceLive`" — wrong, it's from `makeSessionManagerStateLive()` in `session-manager-state.ts`. Fixed.
- **AP-R3-3** — Task 4: `PtySession` type doesn't exist, actual type is `PtySessionState`. Fixed: all occurrences replaced.
- **AP-R3-4** — Task 5: `RelayStateLive` missing `makeSessionManagerStateLive()`. `SessionManagerServiceLive` only packages function references — the functions need `SessionManagerStateTag` at call time. Fixed: added to composition.
- **AP-R3-5** — Task 5: NOTE listing externally-provided bridge Tags was incomplete (8 of 22). Fixed: expanded to list all bridge Tags, external deps, and optional Tags.
- **AP-R3-6** — Task 6: background service Layers (`KeepAwakeLive`, `VersionCheckerLive`, `StorageMonitorLive`, `PortScannerLive`) are functions requiring config arguments, not bare values. Fixed: call with `()` / `(config)`.

**Accept (2 findings):**

- Task 5 test code uses bridge Tags — acceptable as transition-period smoke test
- `SessionManagerServiceLive` has zero declared Layer requirements (deferred to call site) — correct Effect behavior, confusion resolved by fixing AP-R3-2 and AP-R3-4
