# Phase 3: Integration & Consumer Migration (Tasks 19-22)

> **Prerequisites:** Phases 1, 2a, and 2b ALL complete. Read [conventions.md](conventions.md).
> **Dependency:** All new Effect modules built and tested (Tasks 1-18).
> **Merge milestone:** M2 — codebase is fully Effect-native after this phase.

**Goal:** Wire all new Layers together, convert every consumer to use Effect APIs directly, delete all old imperative implementations, and verify no imperative patterns remain. This is the highest-risk phase — it touches every module.

> **AUDIT FIX:** Create a checkpoint branch before starting:
> ```bash
> git branch checkpoint/pre-consumer-migration
> ```

---

## Task 19: Update daemon-layers.ts with all new Layers

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/daemon/full-layer-composition.test.ts`

**Step 1: Write smoke test for full composition**

```typescript
// test/unit/daemon/full-layer-composition.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { RelayCacheTag, makeRelayCacheLive } from "../../../src/lib/effect/relay-cache.js";
import { SessionManagerStateTag, makeSessionManagerStateLive } from "../../../src/lib/effect/session-manager-state.js";
import { PollerStateTag, makePollerStateLive } from "../../../src/lib/effect/session-status-poller.js";
import { PollerManagerStateTag, makePollerManagerStateLive } from "../../../src/lib/effect/message-poller.js";
import { InstanceManagerStateTag, makeInstanceManagerStateLive } from "../../../src/lib/effect/instance-manager-service.js";
import { RateLimiterTag, RateLimiterLive } from "../../../src/lib/effect/rate-limiter-layer.js";

describe("Full Layer composition", () => {
  const composedLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    makeSessionManagerStateLive(),
    makePollerStateLive(),
    makePollerManagerStateLive(),
    makeInstanceManagerStateLive(),
    makeRelayCacheLive((slug) => Effect.succeed({ slug, wsHandler: {} as any, stop: () => {} })),
    RateLimiterLive({ maxRequests: 10, windowMs: 60_000 }),
  );

  it.scoped("all state Tags are accessible from composed layer", () =>
    Effect.gen(function* () {
      const daemonState = yield* DaemonStateTag;
      const sessionState = yield* SessionManagerStateTag;
      const pollerState = yield* PollerStateTag;
      const pollerManager = yield* PollerManagerStateTag;
      const instanceState = yield* InstanceManagerStateTag;
      const relayCache = yield* RelayCacheTag;
      const limiter = yield* RateLimiterTag;

      expect(daemonState).toBeDefined();
      expect(sessionState).toBeDefined();
      expect(pollerState).toBeDefined();
      expect(pollerManager).toBeDefined();
      expect(instanceState).toBeDefined();
      expect(relayCache).toBeDefined();
      expect(limiter).toBeDefined();
    }).pipe(Effect.provide(composedLayer))
  );
});
```

**Step 2:** Run: `pnpm vitest run test/unit/daemon/full-layer-composition.test.ts`

**Step 2b: Create DaemonEventBusLive (needed by Task 20i)**

> **AUDIT FIX (M5 + H-NEW-7):** The PubSub Layer must exist BEFORE Phase 3
> consumer migration tasks that publish events. Create the PubSub here;
> Phase 4 Task 23 adds the publisher helpers, subscriber wiring, and WS
> broadcasting — NOT the PubSub itself.

Create `src/lib/effect/daemon-pubsub.ts` with ONLY the PubSub definition and Tag:

```typescript
// src/lib/effect/daemon-pubsub.ts
// Phase 3 Task 19: PubSub Tag + Layer only.
// Phase 4 Task 23 adds: publisher helpers, subscriber wiring, WS broadcasting.
import { Context, Data, Effect, Layer, PubSub } from "effect";

export type DaemonEvent = Data.TaggedEnum<{
  StatusChanged: { readonly statuses: Record<string, string> };
  VersionUpdate: { readonly current: string; readonly latest: string };
  InstanceAdded: { readonly instanceId: string };
  InstanceRemoved: { readonly instanceId: string };
  InstanceStatusChanged: { readonly instanceId: string };
  DiskSpaceLow: { readonly usage: number };
  DiskSpaceOk: { readonly usage: number };
}>;

export const DaemonEvent = Data.taggedEnum<DaemonEvent>();

export class DaemonEventBusTag extends Context.Tag("DaemonEventBus")<
  DaemonEventBusTag,
  PubSub.PubSub<DaemonEvent>
>() {}

// sliding(256) — oldest events dropped if consumer falls behind.
export const DaemonEventBusLive = Layer.effect(
  DaemonEventBusTag,
  PubSub.sliding<DaemonEvent>({ capacity: 256 })
);
```

Add to the composed Layer in Task 19's daemon-layers.ts update.

**Step 3: Update services.ts with all new Tag re-exports**

```typescript
// New Tags from next-wave migration
export { DaemonStateTag } from "./daemon-state.js";
export { RelayCacheTag } from "./relay-cache.js";
export { PersistencePathTag } from "./daemon-config-persistence.js";
export { CrashCounterTag } from "./daemon-startup.js";
export { SessionManagerStateTag } from "./session-manager-state.js";
export { PollerStateTag } from "./session-status-poller.js";
export { PollerManagerStateTag } from "./message-poller.js";
export { InstanceManagerStateTag } from "./instance-manager-service.js";
export { RateLimiterTag } from "./rate-limiter-layer.js";
export { PushManagerTag } from "./push-service.js";
export { PersistenceServiceTag } from "./persistence-service.js";
export { IdempotencySetTag } from "./orchestration-service.js";
export { DaemonEventBusTag } from "./daemon-pubsub.js";
```

**Step 4:** Commit: `feat(effect): wire all new Tags into services.ts and verify full composition`

---

## Task 20: Direct consumer conversion

> **No bridges.** Each sub-task updates ALL consumers of a module to use the Effect API directly, then deletes the old imperative implementation.
>
> **This is the highest-risk part of the plan.** Each sub-task touches multiple files. The executing agent should:
> 1. `grep` for ALL import sites BEFORE starting changes
> 2. Update consumers ONE FILE AT A TIME, running typecheck after each
> 3. Only delete the old module AFTER all consumers compile cleanly
> 4. Run full `pnpm vitest run && pnpm build` before committing
>
> **Rollback:** If a sub-task fails after partial conversion, revert: `git checkout -- .` and retry. Each sub-task is independent.

**Prerequisites:** All Tasks 1-19 pass (`pnpm vitest run test/unit/`).

### Task 20a: Convert RateLimiter consumers

> **Expected grep count:** ~3-5 import sites across 2-3 files.

**Step 1:** Find all consumers:
```bash
grep -r "from.*rate-limiter\|RateLimiter\|rateLimiter" src/lib/ --include="*.ts"
```

**Step 2:** Convert each consumer:
- Effect programs: use `yield* RateLimiterTag` directly
- Imperative boundary code: use `runtime.runPromise(limiter.checkLimit(ip))`

**Step 3:** Delete `src/lib/server/rate-limiter.ts`

**Step 4:** Run `pnpm vitest run && pnpm build`

Commit: `refactor(effect): convert RateLimiter consumers, delete old class`

---

### Task 20b: Convert leaf service consumers (StorageMonitor, VersionChecker, PortScanner, KeepAwake)

> **Expected grep count:** ~10-15 import sites across 5-8 files (4 services combined).

```bash
grep -r "from.*storage-monitor\|from.*version-check\|from.*port-scanner\|from.*keep-awake" src/lib/ --include="*.ts"
```

All consumers must use the Effect Tag directly (e.g., `yield* StorageMonitorTag`).

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert leaf service consumers to Effect`

---

### Task 20c: Convert InstanceManager consumers

> **Expected grep count:** ~8-12 import sites across 4-6 files.
> **Scope lifetime:** Operations that fork long-lived fibers (addInstance, startInstance) run within the ManagedRuntime's scope. Do NOT wrap in temporary `Effect.scoped` calls.

```bash
grep -r "from.*instance-manager\|InstanceManager" src/lib/ --include="*.ts"
```

Delete `src/lib/instance/instance-manager.ts`.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert InstanceManager consumers, delete old class`

---

### Task 20d: Convert SessionStatusPoller consumers

> **Expected grep count:** ~3-5 import sites.

```bash
grep -r "from.*session-status-poller\|SessionStatusPoller\|StatusPoller" src/lib/ --include="*.ts"
```

Consumers call `startReconciliationLoop` directly. Verify actual file path with grep before deleting.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert StatusPoller consumers, delete old class`

---

### Task 20e: Convert MessagePoller consumers

> **Expected grep count:** ~5-8 import sites across 3-4 files.

```bash
grep -r "from.*message-poller\|MessagePoller\|PollerManager" src/lib/ --include="*.ts"
```

Delete `src/lib/relay/message-poller.ts` and `src/lib/relay/message-poller-manager.ts`.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert MessagePoller consumers, delete old classes`

---

### Task 20f: Convert SSEStream consumers

> **Expected grep count:** ~4-6 import sites.

```bash
grep -r "from.*sse-stream\|SSEStream" src/lib/ --include="*.ts"
```

Consumers use `resilientSSE()` as an `Effect.Stream`. Delete `src/lib/relay/sse-stream.ts`.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert SSEStream consumers, delete old class`

---

### Task 20g: Convert SessionManager consumers

> **Expected grep count:** ~10-15 import sites (SessionManager is heavily used).

```bash
grep -r "from.*session-manager\|SessionManager" src/lib/ --include="*.ts"
```

Delete `src/lib/session/session-manager.ts`.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): convert SessionManager consumers, delete old class`

---

### Task 20h: Replace daemon.ts with Effect entry point

> **CAPSTONE TASK — highest risk.** Create checkpoint:
> ```bash
> git branch checkpoint/pre-daemon-dissolution
> ```

> **AUDIT FIX (M11):** This is the highest-risk task but previously had no
> implementation code. The CLI entry point pattern is shown below.

**Files:**
- Modify: `src/lib/daemon/daemon.ts` → delete the class
- Modify: `src/bin/cli.ts` (or `cli-core.ts`) to call `startDaemon()` directly

**Changes:**
1. `start()` method → `startDaemon(daemonLayer)` from `daemon-main.ts`
2. `stop()` method → `stopDaemon(runtime)` from `daemon-main.ts`
3. IPC handling → `runtime.runPromise(decodeAndDispatch(raw))` from `ipc-dispatch.ts`
4. Delete `src/lib/daemon/daemon.ts` entirely
5. CLI entry point constructs the full Layer and calls `Layer.launch`
6. Use `Effect.Deferred` for server-ready signals

**CLI entry point pattern:**
```typescript
// src/bin/cli.ts (or cli-core.ts)
import { Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { makeDaemonProgramLayer } from "../lib/effect/daemon-main.js";
import { makeDaemonLive } from "../lib/effect/daemon-layers.js";

// Construct the full daemon Layer from CLI args
const daemonLayer = makeDaemonLive({
  configDir: resolvedConfigDir,
  port: parsedPort,
  host: parsedHost,
  // ... other CLI args
});

// Layer.launch: constructs the layer, runs until SIGINT/SIGTERM,
// then tears down all finalizers in reverse order.
const program = Layer.launch(makeDaemonProgramLayer(daemonLayer));

// Use NodeRuntime.runMain for proper signal handling and exit codes
NodeRuntime.runMain(program);
```

**Server-ready signals with Deferred:**
```typescript
// In daemon-layers.ts, the HTTP server Layer:
const serverReady = yield* Deferred.make<void>();

// After server starts listening:
yield* Deferred.succeed(serverReady, void 0);

// In startup sequence, wait for server:
yield* Deferred.await(serverReady);
yield* Effect.logInfo("Server ready, starting IPC...");
```

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): dissolve Daemon class, wire CLI to Layer.launch`

---

> **AUDIT FIX (M13):** Tasks 20i-20m below are where the bulk of the
> migration risk lives. Each needs careful implementation with:
> 1. Full grep of ALL import sites before making any changes
> 2. Consumer-by-consumer conversion with typecheck after each file
> 3. Deletion of old module ONLY after all consumers compile
> 4. Full `pnpm vitest run && pnpm build` before each commit
>
> The descriptions below are intentionally terse — the executing agent
> should read the actual source files on the feature branch to understand
> each module's full interface before converting.

### Task 20i: ProjectRegistry — dissolve class into Effect Layer

> **Not covered by RelayCache (Phase 1 Task 4).** RelayCache handles relay lifecycle, but ProjectRegistry also manages 5 event types, discriminated union state, and lazy relay startup.
>
> **NOTE:** File is at `src/lib/daemon/project-registry.ts`. On the feature branch, it uses typed callback maps (not EventEmitter).

**Files:**
- Create: `src/lib/effect/project-registry-service.ts`
- Delete: `src/lib/daemon/project-registry.ts`
- Test: `test/unit/relay/project-registry-effect.test.ts`

**Key conversions:**
- Callback maps → `Layer.scoped` + `Ref`
- 5 event types → direct `PubSub` publish calls. **NOTE:** `DaemonEventBusTag`
  was created in Task 19 (Step 2b). This task publishes to it via
  `PubSub.publish(bus, DaemonEvent.InstanceAdded({ instanceId }))`. Phase 4
  Task 23 adds the publisher helper functions and WS subscriber wiring.
- Discriminated union state → `Ref<HashMap<string, ProjectState>>`
- AbortController → `Scope` per project
- `startRelay()` → `RelayCacheTag.get(slug)`

Commit: `feat(effect): dissolve ProjectRegistry class into Effect Layer`

---

### Task 20j: SessionRegistry — convert to Effect.Ref

> Must complete before Phase 5 Task 32 (WS handler conversion).

**Files:**
- Create: `src/lib/effect/session-registry-state.ts`
- Delete: `src/lib/session/session-registry.ts`
- Test: `test/unit/session/session-registry-effect.test.ts`

**Key conversions:**
- `Map<clientId, sessionId>` → `Ref<HashMap<string, string>>`
- Methods → pure Effect functions

Commit: `feat(effect): convert SessionRegistry to Effect.Ref with HashMap`

---

### Task 20k: Auth middleware — convert PIN verification to Effect

**Files:**
- Modify: `src/lib/auth.ts`
- Test: `test/unit/auth-effect.test.ts`

**Key conversions:**
- `verifyPin(hash, pin)` → `Effect.Effect<boolean>` using `Effect.sync` for crypto
- WS auth middleware → `Effect.Effect<boolean, AuthenticationError>`

Commit: `feat(effect): convert auth middleware to Effect with AuthenticationError`

---

### Task 20l: Test helper updates

**Files:**
- Modify: All files in `test/helpers/`
- Replace `new SessionManager(...)` → `makeSessionManagerStateLive()`
- Replace `new InstanceManager(...)` → `makeInstanceManagerStateLive()`
- Replace `createMockDaemon()` → composed test Layer

**Must run:** `pnpm test` — all existing tests must still pass.

Commit: `refactor(test): update test helpers to use Effect Layers`

---

### Task 20m: Persistence projectors + event-store — migrate to @effect/sql

> **Prerequisite:** Phase 2b Task 15 (@effect/sql installed).

**Files:**
- Modify: `src/lib/persistence/event-store.ts` → use `SqlClient`
- Modify: `src/lib/persistence/projectors/*.ts` → use `SqlClient` template literals
- Modify: `src/lib/persistence/projection-runner.ts` → use `SqlClient.withTransaction`
- Delete: `src/lib/persistence/sqlite-client.ts`
- Test: `test/unit/persistence/projectors-effect.test.ts`

**Pattern:** Replace `db.prepare(sql).run(...)` with `yield* sql\`...\``. Remove all `node:sqlite` imports.

Commit: `refactor(effect): migrate projectors and event-store to @effect/sql, delete node:sqlite wrapper`

---

## Task 21: Update relay stack to use Effect Layers

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `src/lib/relay/sse-wiring.ts`
- Modify: `src/lib/relay/monitoring-wiring.ts`
- Modify: `src/lib/effect/layers.ts`

Extend `makeHandlerLayer()` with new Tags (DaemonStateTag, SessionManagerStateTag, PollerManagerStateTag). Replace direct class instantiation with Layer provision.

Run: `pnpm vitest run && pnpm build`
Commit: `refactor(effect): wire relay stack through Effect Layers`

---

## Task 22: Final cleanup — verify no imperative patterns remain

> **Prerequisite:** Tasks 20a-20h completed.

**Step 1: Verification greps** (scope to migrated directories):

```bash
# No EventEmitter in migrated modules
grep -r "EventEmitter" src/lib/effect/ src/lib/daemon/ src/lib/relay/ src/lib/session/ src/lib/instance/ src/lib/server/ --include="*.ts" | wc -l
# Expected: 0

# No setInterval/setTimeout
grep -r "setInterval\|setTimeout" src/lib/effect/ src/lib/daemon/ src/lib/relay/ src/lib/session/ src/lib/instance/ --include="*.ts" | wc -l
# Expected: 0

# No try/catch in Effect modules
grep -r "try {" src/lib/effect/ --include="*.ts" | wc -l
# Expected: 0

# No TrackedService/AsyncTracker/ServiceRegistry
grep -r "TrackedService\|AsyncTracker\|ServiceRegistry" src/lib/ --include="*.ts" | wc -l
# Expected: 0

# No old class instantiations
grep -r "new SessionManager\|new SSEStream\|new InstanceManager\|new RateLimiter\|new MessagePoller\|new Daemon\|new ProjectRegistry\|new SessionRegistry" src/lib/ --include="*.ts" | wc -l
# Expected: 0
```

**Step 2:** Run: `pnpm test && pnpm build && pnpm test:e2e`

**Step 3:** This is **merge milestone M2**.

Commit: `chore: verify Effect.ts migration complete — no imperative patterns remain`
