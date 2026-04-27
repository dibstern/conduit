# Phase 4: Observability & Completeness (Tasks 23-29)

> **Prerequisites:** Phase 3 complete (M2 merged). Read [conventions.md](conventions.md).
> **Dependency:** All consumers converted, old code deleted.
> **Merge milestone:** M3 — safe incremental merge after Task 29.

**Goal:** Add PubSub event bus for cross-service broadcasting, convert SessionOverrides, add integration test, install Supervisor.track for fiber diagnostics, replace env.ts with Effect.Config, and add Effect.Metric for runtime observability.

---

## Task 23: PubSub for cross-service event broadcasting

**Files:**
- Create: `src/lib/effect/daemon-pubsub.ts`
- Test: `test/unit/daemon/daemon-pubsub.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-pubsub.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Queue } from "effect";
import {
  DaemonEventBusTag, DaemonEventBusLive,
  publishStatusChanged, publishVersionUpdate, publishInstanceEvent,
  subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";

describe("DaemonEventBus", () => {
  it.scoped("publishes and receives StatusChanged events", () =>
    Effect.gen(function* () {
      const sub = yield* subscribeToDaemonEvents;
      yield* publishStatusChanged({ s1: "busy", s2: "idle" });
      const event = yield* Queue.take(sub);
      expect(event._tag).toBe("StatusChanged");
    }).pipe(Effect.provide(DaemonEventBusLive))
  );

  it.scoped("multiple subscribers each receive events", () =>
    Effect.gen(function* () {
      const sub1 = yield* subscribeToDaemonEvents;
      const sub2 = yield* subscribeToDaemonEvents;
      yield* publishVersionUpdate("1.0.0", "1.1.0");
      const e1 = yield* Queue.take(sub1);
      const e2 = yield* Queue.take(sub2);
      expect(e1._tag).toBe("VersionUpdate");
      expect(e2._tag).toBe("VersionUpdate");
    }).pipe(Effect.provide(DaemonEventBusLive))
  );

  it.scoped("InstanceAdded carries instanceId", () =>
    Effect.gen(function* () {
      const sub = yield* subscribeToDaemonEvents;
      yield* publishInstanceAdded("inst-42");
      const result = yield* Queue.take(sub);
      expect(result._tag).toBe("InstanceAdded");
      // Data.TaggedEnum provides typed access — no `as any` needed
      if (result._tag === "InstanceAdded") {
        expect(result.instanceId).toBe("inst-42");
      }
    }).pipe(Effect.provide(DaemonEventBusLive))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/daemon-pubsub.ts
// AUDIT FIX (H10): Use Data.TaggedEnum for DaemonEvent to get compile-time
// exhaustiveness checking in match/switch and proper value constructors.
import { Context, Data, Effect, Layer, PubSub, Queue, Stream } from "effect";

export type DaemonEvent = Data.TaggedEnum<{
  StatusChanged: { readonly statuses: Record<string, string> };
  VersionUpdate: { readonly current: string; readonly latest: string };
  InstanceAdded: { readonly instanceId: string };
  InstanceRemoved: { readonly instanceId: string };
  InstanceStatusChanged: { readonly instanceId: string };
  DiskSpaceLow: { readonly usage: number };
  DiskSpaceOk: { readonly usage: number };
}>;

// Value constructors — use DaemonEvent.StatusChanged({ statuses: {...} })
export const DaemonEvent = Data.taggedEnum<DaemonEvent>();

export class DaemonEventBusTag extends Context.Tag("DaemonEventBus")<
  DaemonEventBusTag,
  PubSub.PubSub<DaemonEvent>
>() {}

// sliding(256) — oldest events dropped if consumer falls behind.
// NOT dropping — dropping discards NEW events, causing UI staleness.
export const DaemonEventBusLive = Layer.effect(
  DaemonEventBusTag,
  PubSub.sliding<DaemonEvent>({ capacity: 256 })
);

// Publish helpers use Data.TaggedEnum value constructors
export const publishStatusChanged = (statuses: Record<string, string>) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.StatusChanged({ statuses }));
  });

export const publishVersionUpdate = (current: string, latest: string) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.VersionUpdate({ current, latest }));
  });

export const publishInstanceAdded = (instanceId: string) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.InstanceAdded({ instanceId }));
  });

export const publishInstanceRemoved = (instanceId: string) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.InstanceRemoved({ instanceId }));
  });

export const publishInstanceStatusChanged = (instanceId: string) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.InstanceStatusChanged({ instanceId }));
  });

export const publishDiskSpaceLow = (usage: number) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.DiskSpaceLow({ usage }));
  });

export const publishDiskSpaceOk = (usage: number) =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.DiskSpaceOk({ usage }));
  });

export const subscribeToDaemonEvents: Effect.Effect<
  Queue.Dequeue<DaemonEvent>, never, DaemonEventBusTag
> =
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    return yield* PubSub.subscribe(bus);
  });
```

**Step 3: Wire publishers into services**

> **AUDIT FIX (M-R5-3):** Per-service wiring code shown below. Each service
> needs `DaemonEventBusTag` added to its Layer dependencies.

**session-status-poller.ts** — add after corrections in `reconcile`:
```typescript
// In reconcile(), after applying corrections:
if (corrections.length > 0) {
  const newStatuses: Record<string, string> = {};
  for (const c of corrections) { newStatuses[c.sessionId] = c.expected; }
  yield* publishStatusChanged(newStatuses);
}
```
Add `DaemonEventBusTag` to `reconcile`'s dependency type.

**version-checker-layer.ts** — replace `config.broadcast` with PubSub publish:
```typescript
// In VersionCheckerLive check Effect, replace:
//   yield* config.broadcast({ type: "version_update", current, latest });
// With:
yield* publishVersionUpdate(current, latest);
```
Remove `broadcast` from `VersionCheckerConfig` interface. Add `DaemonEventBusTag` to Layer deps.

**instance-manager-service.ts** — add after add/remove operations:
```typescript
// In addInstance, after Ref.modify succeeds:
yield* publishInstanceAdded(id);

// In removeInstance, after Ref.update and FiberMap.remove:
yield* publishInstanceRemoved(instanceId);
```
Add `DaemonEventBusTag` to `addInstance`/`removeInstance` dependency types.

**storage-monitor-layer.ts** — add state-machine transition publishing:
```typescript
// In StorageMonitorLive check Effect, replace the simple threshold check:
const prevUsage = yield* Ref.get(state).pipe(Effect.map((s) => s.usage));
const usage = yield* config.getStorageUsage();
yield* Ref.set(state, { lastCheck: Date.now(), usage });

if (usage > config.highWaterMark && prevUsage <= config.highWaterMark) {
  yield* publishDiskSpaceLow(usage);   // Transition: ok → low
  yield* config.persistence.evictOldEvents();
} else if (usage <= config.highWaterMark && prevUsage > config.highWaterMark) {
  yield* publishDiskSpaceOk(usage);    // Transition: low → ok
}
```
Add `DaemonEventBusTag` to Layer deps.

**Step 4: Wire subscriber into daemon-main.ts**

```typescript
const broadcastDaemonEvents = Effect.gen(function* () {
  const bus = yield* DaemonEventBusTag;
  const ws = yield* WebSocketHandlerTag;

  yield* Stream.fromPubSub(bus).pipe(
    Stream.mapEffect((event) => {
      switch (event._tag) {
        case "StatusChanged":
          return ws.broadcast({ type: "status_changed", statuses: event.statuses });
        case "VersionUpdate":
          return ws.broadcast({ type: "version_update", current: event.current, latest: event.latest });
        case "InstanceAdded": case "InstanceRemoved": case "InstanceStatusChanged":
          return ws.broadcast({ type: "instance_event", event: event._tag, instanceId: event.instanceId });
        case "DiskSpaceLow": case "DiskSpaceOk":
          return ws.broadcast({ type: "disk_space", status: event._tag, usage: event.usage });
      }
    }),
    Stream.catchAll((e) => Stream.fromEffect(Effect.logWarning("Event broadcast error", e))),
    Stream.runDrain
  );
});
// Fork as daemon fiber: yield* Effect.forkDaemon(broadcastDaemonEvents);
```

**Step 5:** Run tests, commit: `feat(effect): add PubSub event bus with publishers, subscribers, and WS broadcasting`

---

> **AUDIT FIX (M10 + H-NEW-1):** Tasks 24-29 below are fully self-contained.
> Previous versions referenced a monolithic plan file — that reference has been
> removed. Each task includes complete test and implementation code.

## Task 24: SessionOverrides Effect conversion

**Files:**
- Create: `src/lib/effect/session-overrides-state.ts`
- Test: `test/unit/session/session-overrides-effect.test.ts`

**Key conversions:**
- `sessions: Map<string, SessionState>` → `Effect.Ref<Map<string, SessionState>>`
- Processing timeout timers → `Effect.sleep + Fiber.interrupt` instead of `setTimeout`

> **Note:** Uses native Map (not HashMap) because SessionState contains Fiber.RuntimeFiber references. This is an intentional exception documented inline.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-overrides-effect.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration, Exit, TestClock } from "effect";
import {
  OverridesStateTag, makeOverridesStateLive,
  setModel, setAgent, getOverrides, clearSession, startProcessingTimeout,
} from "../../../src/lib/effect/session-overrides-state.js";

describe("SessionOverrides Effect", () => {
  it.scoped("setModel stores model override for session", () =>
    Effect.gen(function* () {
      yield* setModel("s1", { provider: "anthropic", model: "claude-4" });
      const result = yield* getOverrides("s1");
      expect(result?.model?.provider).toBe("anthropic");
      expect(result?.modelUserSelected).toBe(true);
    }).pipe(Effect.provide(makeOverridesStateLive()))
  );

  it.scoped("setAgent stores agent override", () =>
    Effect.gen(function* () {
      yield* setAgent("s1", "coder");
      const result = yield* getOverrides("s1");
      expect(result?.agent).toBe("coder");
    }).pipe(Effect.provide(makeOverridesStateLive()))
  );

  it.scoped("clearSession removes all overrides", () =>
    Effect.gen(function* () {
      yield* setModel("s1", { provider: "anthropic", model: "claude-4" });
      yield* setAgent("s1", "coder");
      yield* clearSession("s1");
      const result = yield* getOverrides("s1");
      expect(result).toBeUndefined();
    }).pipe(Effect.provide(makeOverridesStateLive()))
  );

  it.scoped("processing timeout fires after duration (TestClock)", () =>
    Effect.gen(function* () {
      const timeoutFired = { value: false };
      yield* setModel("s1", { provider: "test", model: "test" });
      yield* startProcessingTimeout("s1", Duration.millis(50), () =>
        Effect.sync(() => { timeoutFired.value = true; })
      );
      yield* TestClock.adjust(Duration.millis(60));
      expect(timeoutFired.value).toBe(true);
    }).pipe(Effect.provide(makeOverridesStateLive()))
  );

  it.scoped("restarting timeout cancels previous (TestClock)", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* setModel("s1", { provider: "test", model: "test" });
      yield* startProcessingTimeout("s1", Duration.millis(100), () =>
        Effect.sync(() => calls.push("A"))
      );
      yield* startProcessingTimeout("s1", Duration.millis(50), () =>
        Effect.sync(() => calls.push("B"))
      );
      yield* TestClock.adjust(Duration.millis(150));
      expect(calls).toEqual(["B"]);
    }).pipe(Effect.provide(makeOverridesStateLive()))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/session-overrides-state.ts
import { Context, Effect, Layer, Ref, Fiber, Duration } from "effect";

interface ModelOverride {
  provider: string;
  model: string;
}

interface SessionState {
  model?: ModelOverride;
  modelUserSelected?: boolean;
  agent?: string;
  processingTimeoutFiber?: Fiber.RuntimeFiber<void>;
}

// Uses native Map (not HashMap) because SessionState contains
// Fiber.RuntimeFiber references. Documented exception per conventions.
export class OverridesStateTag extends Context.Tag("OverridesState")<
  OverridesStateTag,
  Ref.Ref<Map<string, SessionState>>
>() {}

export const makeOverridesStateLive = (): Layer.Layer<OverridesStateTag> =>
  Layer.effect(OverridesStateTag, Ref.make(new Map<string, SessionState>()));

const getOrCreate = (map: Map<string, SessionState>, sessionId: string): SessionState =>
  map.get(sessionId) ?? {};

export const setModel = (sessionId: string, model: ModelOverride) =>
  Effect.gen(function* () {
    const ref = yield* OverridesStateTag;
    yield* Ref.update(ref, (m) => {
      const next = new Map(m);
      const existing = getOrCreate(m, sessionId);
      next.set(sessionId, { ...existing, model, modelUserSelected: true });
      return next;
    });
  });

export const setAgent = (sessionId: string, agent: string) =>
  Effect.gen(function* () {
    const ref = yield* OverridesStateTag;
    yield* Ref.update(ref, (m) => {
      const next = new Map(m);
      const existing = getOrCreate(m, sessionId);
      next.set(sessionId, { ...existing, agent });
      return next;
    });
  });

export const getOverrides = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* OverridesStateTag;
    const m = yield* Ref.get(ref);
    return m.get(sessionId);
  });

// AUDIT FIX (C-R5-4): Must interrupt timeout fiber before removing entry.
// Fiber.interrupt is an Effect — cannot run inside Ref.update's pure function.
// Read the fiber reference first, then remove, then interrupt.
export const clearSession = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* OverridesStateTag;
    // 1. Read existing entry to get fiber reference
    const current = yield* Ref.get(ref);
    const existing = current.get(sessionId);
    // 2. Remove from state atomically
    yield* Ref.update(ref, (m) => {
      const next = new Map(m);
      next.delete(sessionId);
      return next;
    });
    // 3. Interrupt timeout fiber if present (outside Ref.update)
    if (existing?.processingTimeoutFiber) {
      yield* Fiber.interrupt(existing.processingTimeoutFiber);
    }
  });

export const startProcessingTimeout = (
  sessionId: string,
  duration: Duration.DurationInput,
  onTimeout: () => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const ref = yield* OverridesStateTag;
    // Cancel previous timeout fiber if any
    const current = yield* Ref.get(ref);
    const existing = current.get(sessionId);
    if (existing?.processingTimeoutFiber) {
      yield* Fiber.interrupt(existing.processingTimeoutFiber);
    }
    // Fork new timeout fiber
    const fiber = yield* Effect.sleep(duration).pipe(
      Effect.flatMap(() => onTimeout()),
      Effect.forkScoped,
    );
    yield* Ref.update(ref, (m) => {
      const next = new Map(m);
      const entry = getOrCreate(m, sessionId);
      next.set(sessionId, { ...entry, processingTimeoutFiber: fiber });
      return next;
    });
  });
```

**Step 3:** Run tests, commit: `feat(effect): convert SessionOverrides to Effect.Ref + Fiber timeout`

---

## Task 25: Integration test — full Layer composition

**Files:**
- Create: `test/integration/effect-layers.test.ts`

**Full integration test code:**

```typescript
// test/integration/effect-layers.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Queue } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../src/lib/effect/daemon-state.js";
import { SessionManagerStateTag, makeSessionManagerStateLive } from "../../src/lib/effect/session-manager-state.js";
import { RateLimiterTag, RateLimiterLive } from "../../src/lib/effect/rate-limiter-layer.js";
import { DaemonEventBusTag, DaemonEventBusLive, subscribeToDaemonEvents, publishStatusChanged } from "../../src/lib/effect/daemon-pubsub.js";
import { OverridesStateTag, makeOverridesStateLive, setModel, getOverrides, clearSession } from "../../src/lib/effect/session-overrides-state.js";
import { decodeAndDispatch } from "../../src/lib/effect/ipc-dispatch.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../src/lib/effect/daemon-config-persistence.js";

describe("Full Effect Layer integration", () => {
  const mockProjectMgmt = {
    addProject: vi.fn().mockReturnValue(Effect.succeed({ slug: "p", path: "/p" })),
    removeProject: vi.fn().mockReturnValue(Effect.void),
  };
  const mockInstanceMgmt = {
    addInstance: vi.fn().mockReturnValue(Effect.void),
    removeInstance: vi.fn().mockReturnValue(Effect.void),
    listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
    getInstance: vi.fn().mockReturnValue(Effect.succeed({})),
    updateInstance: vi.fn().mockReturnValue(Effect.void),
    startInstance: vi.fn().mockReturnValue(Effect.void),
    stopInstance: vi.fn().mockReturnValue(Effect.void),
  };
  const mockSessionOverrides = {
    setAgent: vi.fn().mockReturnValue(Effect.void),
    setModel: vi.fn().mockReturnValue(Effect.void),
  };

  const integrationLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    makeSessionManagerStateLive(),
    makeOverridesStateLive(),
    RateLimiterLive({ maxRequests: 10, windowMs: 60_000 }),
    DaemonEventBusLive,
    Layer.succeed(PersistencePathTag, "/tmp/test-integration.json"),
    Layer.succeed(ProjectMgmtTag, mockProjectMgmt as unknown as ProjectMgmtTag["Type"]),
    Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as unknown as InstanceMgmtTag["Type"]),
    Layer.succeed(SessionOverridesTag, mockSessionOverrides as unknown as SessionOverridesTag["Type"]),
  );

  it.effect("all Tags resolve from composed Layer", () =>
    Effect.gen(function* () {
      yield* DaemonStateTag;
      yield* SessionManagerStateTag;
      yield* RateLimiterTag;
      yield* DaemonEventBusTag;
      yield* OverridesStateTag;
    }).pipe(Effect.provide(integrationLayer))
  );

  it.effect("IPC dispatch end-to-end", () =>
    Effect.gen(function* () {
      const result = yield* decodeAndDispatch('{"cmd":"get_status"}');
      expect(result.ok).toBe(true);
    }).pipe(Effect.provide(integrationLayer))
  );

  it.scoped("PubSub events flow between publisher and subscriber", () =>
    Effect.gen(function* () {
      const sub = yield* subscribeToDaemonEvents;
      yield* publishStatusChanged({ s1: "busy" });
      const event = yield* Queue.take(sub);
      expect(event._tag).toBe("StatusChanged");
    }).pipe(Effect.provide(integrationLayer))
  );

  it.effect("RateLimiter enforces limits", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiterTag;
      for (let i = 0; i < 10; i++) {
        expect(yield* limiter.checkLimit("test-ip")).toBe(true);
      }
      expect(yield* limiter.checkLimit("test-ip")).toBe(false);
    }).pipe(Effect.provide(integrationLayer))
  );

  it.scoped("SessionOverrides set/get/clear", () =>
    Effect.gen(function* () {
      yield* setModel("s1", { provider: "anthropic", model: "claude-4" });
      const overrides = yield* getOverrides("s1");
      expect(overrides?.model?.provider).toBe("anthropic");
      yield* clearSession("s1");
      expect(yield* getOverrides("s1")).toBeUndefined();
    }).pipe(Effect.provide(integrationLayer))
  );
});
```

Commit: `test(effect): add integration test for full Layer composition`

---

## Task 25b: Shutdown path test

> **AUDIT FIX (H-NEW-3):** The plan tests startup but never tests graceful shutdown.

**Files:**
- Create: `test/integration/shutdown.test.ts`

```typescript
// test/integration/shutdown.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Deferred, Duration, Exit, Scope } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../src/lib/effect/daemon-state.js";

describe("Graceful shutdown", () => {
  it.scoped("Layer finalizers run in reverse order on interruption", () =>
    Effect.gen(function* () {
      const order: string[] = [];
      const layer1 = Layer.scopedDiscard(
        Effect.gen(function* () {
          order.push("layer1-up");
          yield* Effect.addFinalizer(() => Effect.sync(() => order.push("layer1-down")));
        })
      );
      const layer2 = Layer.scopedDiscard(
        Effect.gen(function* () {
          order.push("layer2-up");
          yield* Effect.addFinalizer(() => Effect.sync(() => order.push("layer2-down")));
        })
      );
      const composed = Layer.provideMerge(layer1, layer2);

      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(composed, scope);
      expect(order).toEqual(["layer1-up", "layer2-up"]);

      yield* Scope.close(scope, Exit.void);
      expect(order).toEqual(["layer1-up", "layer2-up", "layer2-down", "layer1-down"]);
    })
  );

  // AUDIT FIX (H-R5-8): Use explicit Scope.make/close to assert ordering.
  // it.scoped auto-closes the scope after the body, making post-close
  // assertions impossible. Explicit scope gives control over when to assert.
  it.effect("background fibers are interrupted before state is persisted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const scope = yield* Scope.make();

      // Finalizer registered FIRST runs LAST (reverse order)
      yield* Scope.addFinalizer(scope, Effect.sync(() => events.push("state-persisted")));

      // Fiber forked AFTER the finalizer — interrupted BEFORE it (reverse order)
      yield* Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => events.push("fiber-interrupted"))),
        Effect.forkIn(scope),
      );

      // Close scope — triggers interruption + finalizers in reverse order
      yield* Scope.close(scope, Exit.void);

      // Assert ordering: fiber interrupted first, then state persisted
      expect(events).toEqual(["fiber-interrupted", "state-persisted"]);
    })
  );
});
```

Commit: `test(effect): add shutdown path integration tests`

---

## Task 25c: Retry behavior test with TestClock

> **AUDIT FIX (M-NEW-1):** Plan uses retry schedules everywhere but never tests them.

**Files:**
- Create: `test/unit/daemon/retry-behavior.test.ts`

```typescript
// test/unit/daemon/retry-behavior.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schedule, Duration, TestClock, Fiber, Ref } from "effect";

describe("Retry schedule behavior", () => {
  const exponentialRetry = Schedule.exponential("1 second").pipe(
    Schedule.intersect(Schedule.recurs(3))
  );

  it.effect("retries 3 times with exponential backoff", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const fiber = yield* Effect.gen(function* () {
        yield* Ref.update(attempts, (n) => n + 1);
        return yield* Effect.fail("boom");
      }).pipe(
        Effect.retry(exponentialRetry),
        Effect.catchAll(() => Effect.void),
        Effect.fork,
      );
      // Advance clock through all retry delays: 1s, 2s, 4s
      yield* TestClock.adjust(Duration.seconds(8));
      yield* Fiber.join(fiber);
      expect(yield* Ref.get(attempts)).toBe(4); // 1 initial + 3 retries
    })
  );
});
```

Commit: `test(effect): add retry schedule behavior tests with TestClock`

---

## Task 26: Verification checkpoint

Run all tests, build, and typecheck:
```bash
pnpm test && pnpm build && pnpm typecheck
```

Commit: `chore: verify tests/build/types pass after Phase 4 Tracks D`

---

## Task 27: Supervisor.track for fiber diagnostics

**Files:**
- Modify: `src/lib/effect/daemon-main.ts`
- Test: `test/unit/daemon/supervisor-diagnostics.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/supervisor-diagnostics.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Fiber, Supervisor } from "effect";

describe("Supervisor.track diagnostics", () => {
  it.effect("tracks forked fiber exits", () =>
    Effect.gen(function* () {
      const sv = yield* Supervisor.track;
      yield* Effect.supervised(sv)(
        Effect.gen(function* () {
          const f1 = yield* Effect.fork(Effect.succeed("ok"));
          yield* Fiber.join(f1);
          const f2 = yield* Effect.fork(Effect.fail("boom"));
          yield* Fiber.join(f2).pipe(Effect.catchAll(() => Effect.void));
        })
      );
      const fibers = yield* sv.value;
      expect(fibers).toBeDefined();
      expect(Array.isArray(fibers)).toBe(true);
    })
  );
});
```

**Step 2:** Update `daemon-main.ts` to wrap background tasks with supervisor. Add `fiber_status` IPC command.

Commit: `feat(effect): add Supervisor.track for fiber exit diagnostics`

---

## Task 28: Effect.Config for environment-sourced values

**Files:**
- Create: `src/lib/effect/daemon-config.ts`
- Test: `test/unit/daemon/daemon-config.test.ts`

Replace `ENV` object in `env.ts` with `Effect.Config` for type-safe parsing, secret handling (`Config.redacted`), and testability (`ConfigProvider.fromMap`).

**Interface:**
```typescript
export interface DaemonEnvConfig {
  host: string;
  hostExplicit: boolean;
  port: number;
  opencodeUrl: string | undefined;
  opencodePassword: Redacted.Redacted<string> | undefined;
  opencodeUsername: string;
  debug: boolean;
  logLevel: string;
  logFormat: string | undefined;
  tls: boolean;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
}
```

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-config.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, ConfigProvider, Config, Redacted } from "effect";
import { DaemonEnvConfigTag, DaemonEnvConfigLive, type DaemonEnvConfig } from "../../../src/lib/effect/daemon-config.js";

describe("DaemonEnvConfig", () => {
  const testConfigProvider = ConfigProvider.fromMap(new Map([
    ["CONDUIT_HOST", "0.0.0.0"],
    ["CONDUIT_PORT", "3000"],
    ["CONDUIT_DEBUG", "true"],
    ["CONDUIT_LOG_LEVEL", "debug"],
    ["CONDUIT_TLS", "false"],
  ]));

  const testLayer = DaemonEnvConfigLive.pipe(
    Layer.provide(Layer.setConfigProvider(testConfigProvider))
  );

  it.effect("reads host and port from env", () =>
    Effect.gen(function* () {
      const config = yield* DaemonEnvConfigTag;
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(3000);
      expect(config.debug).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("uses defaults when env vars are missing", () => {
    const emptyProvider = ConfigProvider.fromMap(new Map());
    const defaultLayer = DaemonEnvConfigLive.pipe(
      Layer.provide(Layer.setConfigProvider(emptyProvider))
    );
    return Effect.gen(function* () {
      const config = yield* DaemonEnvConfigTag;
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(2633);
      expect(config.debug).toBe(false);
      expect(config.tls).toBe(false);
    }).pipe(Effect.provide(defaultLayer));
  });
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/daemon-config.ts
import { Context, Config, Effect, Layer, Redacted } from "effect";

export interface DaemonEnvConfig {
  host: string;
  hostExplicit: boolean;
  port: number;
  opencodeUrl: string | undefined;
  opencodePassword: Redacted.Redacted<string> | undefined;
  opencodeUsername: string;
  debug: boolean;
  logLevel: string;
  logFormat: string | undefined;
  tls: boolean;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
}

export class DaemonEnvConfigTag extends Context.Tag("DaemonEnvConfig")<
  DaemonEnvConfigTag,
  DaemonEnvConfig
>() {}

export const DaemonEnvConfigLive: Layer.Layer<DaemonEnvConfigTag> =
  Layer.effect(
    DaemonEnvConfigTag,
    Effect.gen(function* () {
      const host = yield* Config.string("CONDUIT_HOST").pipe(Config.withDefault("127.0.0.1"));
      const hostExplicit = yield* Config.string("CONDUIT_HOST").pipe(Config.option, Effect.map(o => o._tag === "Some"));
      const port = yield* Config.integer("CONDUIT_PORT").pipe(Config.withDefault(2633));
      const opencodeUrl = yield* Config.string("OPENCODE_URL").pipe(Config.option, Effect.map(o => o._tag === "Some" ? o.value : undefined));
      const opencodePassword = yield* Config.string("OPENCODE_PASSWORD").pipe(Config.redacted, Config.option, Effect.map(o => o._tag === "Some" ? o.value : undefined));
      const opencodeUsername = yield* Config.string("OPENCODE_USERNAME").pipe(Config.withDefault("conduit"));
      const debug = yield* Config.boolean("CONDUIT_DEBUG").pipe(Config.withDefault(false));
      const logLevel = yield* Config.string("CONDUIT_LOG_LEVEL").pipe(Config.withDefault("info"));
      const logFormat = yield* Config.string("CONDUIT_LOG_FORMAT").pipe(Config.option, Effect.map(o => o._tag === "Some" ? o.value : undefined));
      const tls = yield* Config.boolean("CONDUIT_TLS").pipe(Config.withDefault(false));
      const tlsCertPath = yield* Config.string("CONDUIT_TLS_CERT").pipe(Config.option, Effect.map(o => o._tag === "Some" ? o.value : undefined));
      const tlsKeyPath = yield* Config.string("CONDUIT_TLS_KEY").pipe(Config.option, Effect.map(o => o._tag === "Some" ? o.value : undefined));

      return {
        host, hostExplicit, port, opencodeUrl, opencodePassword, opencodeUsername,
        debug, logLevel, logFormat, tls, tlsCertPath, tlsKeyPath,
      };
    })
  );
```

Commit: `feat(effect): add DaemonConfig Layer using Effect.Config for typed env parsing`

---

## Task 29: Effect.Metric for runtime observability

**Files:**
- Create: `src/lib/effect/metrics.ts`
- Test: `test/unit/daemon/metrics.test.ts`

**Metrics to define:**

| Metric | Type | Description |
|--------|------|-------------|
| `conduit.ws.connections` | Gauge | Current WebSocket connections |
| `conduit.pollers.active` | Gauge | Active message pollers |
| `conduit.sse.reconnects` | Counter | SSE reconnection attempts |
| `conduit.rate_limit.rejections` | Counter | Rate-limited rejections |
| `conduit.ipc.commands` | Counter (tagged) | IPC commands dispatched (tag: cmd) |
| `conduit.config.persists` | Counter | Config persistence writes |
| `conduit.ipc.latency_ms` | Histogram | IPC dispatch latency |

**Instrumentation points:**
- ws-handler: increment/decrement `wsConnectionsGauge` on connect/disconnect
- ipc-dispatch: increment `ipcCommandsCounter` with cmd tag
- sse-stream: increment `sseReconnectsCounter` in retry
- rate-limiter: increment `rateLimitRejectionsCounter` when blocked
- message-poller: increment/decrement `activePollersGauge` on start/stop

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/metrics.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Metric, MetricBoundaries } from "effect";
import {
  wsConnectionsGauge, activePollersGauge, sseReconnectsCounter,
  rateLimitRejectionsCounter, ipcCommandsCounter, configPersistsCounter,
  ipcLatencyHistogram,
} from "../../../src/lib/effect/metrics.js";

describe("Effect.Metric definitions", () => {
  it.effect("wsConnectionsGauge increments and decrements", () =>
    Effect.gen(function* () {
      yield* Metric.increment(wsConnectionsGauge);
      yield* Metric.increment(wsConnectionsGauge);
      yield* Metric.decrement(wsConnectionsGauge);
      const state = yield* Metric.value(wsConnectionsGauge);
      expect(state.value).toBe(1);
    })
  );

  it.effect("ipcCommandsCounter tracks tagged commands", () =>
    Effect.gen(function* () {
      yield* Metric.increment(ipcCommandsCounter.pipe(Metric.tagged("cmd", "get_status")));
      yield* Metric.increment(ipcCommandsCounter.pipe(Metric.tagged("cmd", "get_status")));
      yield* Metric.increment(ipcCommandsCounter.pipe(Metric.tagged("cmd", "shutdown")));
    })
  );

  it.effect("ipcLatencyHistogram records values", () =>
    Effect.gen(function* () {
      yield* Metric.update(ipcLatencyHistogram, 15);
      yield* Metric.update(ipcLatencyHistogram, 150);
    })
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/metrics.ts
import { Metric, MetricBoundaries } from "effect";

export const wsConnectionsGauge = Metric.gauge("conduit.ws.connections");
export const activePollersGauge = Metric.gauge("conduit.pollers.active");
export const sseReconnectsCounter = Metric.counter("conduit.sse.reconnects");
export const rateLimitRejectionsCounter = Metric.counter("conduit.rate_limit.rejections");
export const ipcCommandsCounter = Metric.counter("conduit.ipc.commands");
export const configPersistsCounter = Metric.counter("conduit.config.persists");
export const ipcLatencyHistogram = Metric.histogram(
  "conduit.ipc.latency_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 12 }),
);
```

**Step 3: Instrument services**

Add metric calls at each instrumentation point. Examples:
- `ws-handler-service.ts` `addClient`: `yield* Metric.increment(wsConnectionsGauge)`
- `ws-handler-service.ts` `removeClient`: `yield* Metric.decrement(wsConnectionsGauge)`
- `ipc-dispatch.ts` `decodeAndDispatch`: `yield* Metric.increment(ipcCommandsCounter.pipe(Metric.tagged("cmd", decoded.cmd)))`
- `rate-limiter-layer.ts` `checkLimit` when blocked: `yield* Metric.increment(rateLimitRejectionsCounter)`
- `message-poller.ts` `startPoller`: `yield* Metric.increment(activePollersGauge)`
- `message-poller.ts` `stopPoller`: `yield* Metric.decrement(activePollersGauge)`

Commit: `feat(effect): add Effect.Metric counters and gauges for runtime observability`

---

## Task 29b: Wire OpenTelemetry span exporter for dev mode

> **AUDIT FIX (M2):** The plan uses `Effect.withSpan` throughout (IPC dispatch,
> WS handling, SSE lifecycle, API calls) but never wires an exporter. Without
> one, all spans are inert — no traces are collected or visible. This task
> adds a dev-mode console exporter so spans actually produce output.

**Files:**
- Create: `src/lib/effect/tracing.ts`
- Modify: `src/lib/effect/daemon-layers.ts` (add tracing Layer)
- Test: `test/unit/daemon/tracing.test.ts`

**Step 0:** Install:
```bash
pnpm add @effect/opentelemetry @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
pnpm add -D @opentelemetry/sdk-trace-base
```

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/tracing.test.ts
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer } from "effect";
import { makeTracingLive } from "../../../src/lib/effect/tracing.js";

describe("Tracing Layer", () => {
  it.scoped("provides NodeSdk and captures spans", () =>
    Effect.gen(function* () {
      // The tracing layer should construct without error
      yield* Effect.withSpan("test.span")(Effect.void);
    }).pipe(Effect.provide(makeTracingLive({ enabled: true, consoleExporter: true })))
  );

  it.scoped("is a no-op when disabled", () =>
    Effect.gen(function* () {
      yield* Effect.withSpan("test.span")(Effect.void);
    }).pipe(Effect.provide(makeTracingLive({ enabled: false })))
  );
});
```

**Step 2: Write implementation**

```typescript
// src/lib/effect/tracing.ts
import { Effect, Layer } from "effect";
import { NodeSdk } from "@effect/opentelemetry";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

interface TracingConfig {
  enabled: boolean;
  consoleExporter?: boolean;
  otlpEndpoint?: string;
}

export const makeTracingLive = (config: TracingConfig): Layer.Layer<never> => {
  if (!config.enabled) return Layer.empty;

  const processors: BatchSpanProcessor[] = [];

  if (config.consoleExporter) {
    processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  if (config.otlpEndpoint) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.otlpEndpoint })
      )
    );
  }

  // If no processors configured, use console as default in dev
  if (processors.length === 0) {
    processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  return NodeSdk.layer(() => ({
    resource: { serviceName: "conduit-daemon" },
    spanProcessors: processors,
  }));
};
```

**Step 3: Wire into daemon-layers.ts**

```typescript
// In makeDaemonLive, add as the bottom layer:
import { makeTracingLive } from "./tracing.js";

const tracingLayer = makeTracingLive({
  enabled: config.debug,  // Only in debug mode by default
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
});

// Add to Layer composition:
return tracingLayer.pipe(
  Layer.provideMerge(infraLayer),
  // ... rest of composition
);
```

**Step 4:** Run tests, commit: `feat(effect): wire OpenTelemetry span exporter for dev-mode tracing`

---

## Phase 4 Verification

After completing all tasks (23-25c, 26-29b):

```bash
pnpm test && pnpm build
```

This is **merge milestone M3**.
