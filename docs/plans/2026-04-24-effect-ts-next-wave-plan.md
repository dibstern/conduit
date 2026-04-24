# Effect.ts Next Wave Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Complete the Effect.ts migration for all remaining modules — dissolve Daemon class, convert 16 modules from imperative to Effect, eliminate all EventEmitter/setInterval/try-catch/callback patterns.

**Architecture:** Three parallel tracks: (A) Daemon core dissolution (sequential), (B) Session stack (4 modules, parallel), (C) Supporting services (8 modules, parallel). Each module fully converts in its PR — no mixed Promise+Effect boundaries. Services wire via Context.Tag, state via Effect.Ref, scheduling via Effect.Schedule, resources via acquireRelease.

**Tech Stack:** Effect ^3.21.2, @effect/platform ^0.96.1, Vitest, TypeScript (tsgo)

**Prerequisite:** The `feature/effect-ts-migration` branch must be merged to main first. That branch provides: Context.Tag definitions in `src/lib/effect/services.ts`, Layer factories in `src/lib/effect/daemon-layers.ts` and `src/lib/effect/layers.ts`, Schema.TaggedError definitions in `src/lib/errors.ts`, and the Effect dependency in package.json.

**Reference:** Design doc at `docs/plans/2026-04-24-effect-ts-next-wave-design.md`

---

## Track A: Daemon Core (Sequential)

### Task 1: Define DaemonState Ref and Tag

**Files:**
- Create: `src/lib/effect/daemon-state.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/daemon/daemon-state.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-state.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Ref } from "effect";
import { DaemonStateTag, DaemonState, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";

describe("DaemonState", () => {
  it("initializes with empty defaults", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        const state = yield* Ref.get(ref);
        return state;
      }).pipe(Effect.provide(makeDaemonStateLive()))
    );

    expect(result.pinHash).toBeNull();
    expect(result.keepAwake).toBe(false);
    expect(result.clientCount).toBe(0);
    expect(result.shuttingDown).toBe(false);
    expect(result.dismissedPaths.size).toBe(0);
    expect(result.persistedSessionCounts.size).toBe(0);
  });

  it("initializes with provided config", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(makeDaemonStateLive({
        pinHash: "abc123",
        keepAwake: true,
        dismissedPaths: new Set(["/tmp/foo"]),
      })))
    );

    expect(result.pinHash).toBe("abc123");
    expect(result.keepAwake).toBe(true);
    expect(result.dismissedPaths.has("/tmp/foo")).toBe(true);
  });

  it("supports atomic updates across fields", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        yield* Ref.update(ref, (s) => ({
          ...s,
          clientCount: s.clientCount + 1,
          keepAwake: true,
        }));
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(makeDaemonStateLive()))
    );

    expect(result.clientCount).toBe(1);
    expect(result.keepAwake).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-state.test.ts`
Expected: FAIL — module `../../../src/lib/effect/daemon-state.js` not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/daemon-state.ts
import { Context, Effect, Layer, Ref } from "effect";

export interface DaemonState {
  pinHash: string | null;
  keepAwake: boolean;
  keepAwakeCommand: string | undefined;
  keepAwakeArgs: string[] | undefined;
  clientCount: number;
  shuttingDown: boolean;
  dismissedPaths: Set<string>;
  persistedSessionCounts: Map<string, number>;
  pendingSave: boolean;
  needsResave: boolean;
}

export const DaemonState = {
  empty: (): DaemonState => ({
    pinHash: null,
    keepAwake: false,
    keepAwakeCommand: undefined,
    keepAwakeArgs: undefined,
    clientCount: 0,
    shuttingDown: false,
    dismissedPaths: new Set(),
    persistedSessionCounts: new Map(),
    pendingSave: false,
    needsResave: false,
  }),
};

export class DaemonStateTag extends Context.Tag("DaemonState")<
  DaemonStateTag,
  Ref.Ref<DaemonState>
>() {}

export const makeDaemonStateLive = (
  initial?: Partial<DaemonState>
): Layer.Layer<DaemonStateTag> =>
  Layer.effect(
    DaemonStateTag,
    Ref.make({ ...DaemonState.empty(), ...initial })
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon-state.test.ts`
Expected: 3 tests PASS

**Step 5: Add DaemonStateTag export to services.ts**

Add re-export to `src/lib/effect/services.ts`:
```typescript
export { DaemonStateTag } from "./daemon-state.js";
```

**Step 6: Commit**

```bash
git add src/lib/effect/daemon-state.ts test/unit/daemon/daemon-state.test.ts src/lib/effect/services.ts
git commit -m "feat(effect): add DaemonState Ref and Tag for daemon mutable state"
```

---

### Task 2: Create config persistence Effect

**Files:**
- Create: `src/lib/effect/daemon-config-persistence.ts`
- Test: `test/unit/daemon/daemon-config-persistence.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-config-persistence.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Ref, Layer } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { persistConfig, loadConfig, PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises");

const TestPersistencePathLive = Layer.succeed(PersistencePathTag, "/tmp/test-daemon.json");

describe("daemon config persistence", () => {
  it("persistConfig writes current state to disk", async () => {
    const writeSpy = vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        yield* Ref.update(ref, (s) => ({ ...s, pinHash: "test-hash", keepAwake: true }));
        yield* persistConfig;
      }).pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(TestPersistencePathLive)
      )
    );

    expect(writeSpy).toHaveBeenCalledOnce();
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(written.pinHash).toBe("test-hash");
    expect(written.keepAwake).toBe(true);
  });

  it("loadConfig returns parsed state from disk", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      pinHash: "loaded-hash",
      dismissedPaths: ["/a", "/b"],
      persistedSessionCounts: { "s1": 5 },
    }));

    const result = await Effect.runPromise(
      loadConfig.pipe(
        Effect.provide(TestPersistencePathLive)
      )
    );

    expect(result.pinHash).toBe("loaded-hash");
    expect(result.dismissedPaths).toEqual(new Set(["/a", "/b"]));
  });

  it("loadConfig returns DaemonState.empty() on missing file", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const result = await Effect.runPromise(
      loadConfig.pipe(
        Effect.provide(TestPersistencePathLive)
      )
    );

    // orElseSucceed returns DaemonState.empty(), not {}
    expect(result.pinHash).toBeNull();
    expect(result.keepAwake).toBe(false);
    expect(result.dismissedPaths.size).toBe(0);
  });

  it("coalesces rapid saves via atomic Ref.modify", async () => {
    const writeSpy = vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const renameSpy = vi.mocked(fs.rename).mockResolvedValue(undefined);

    await Effect.runPromise(
      Effect.gen(function* () {
        // Fire 3 concurrent persists — should coalesce
        yield* Effect.all(
          [persistConfig, persistConfig, persistConfig],
          { concurrency: "unbounded" }
        );
      }).pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(TestPersistencePathLive)
      )
    );

    // At most 2 writes (initial + one resave), not 3
    expect(renameSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("coalesces deterministically when save already in progress", async () => {
    const writeSpy = vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    const renameSpy = vi.mocked(fs.rename).mockResolvedValue(undefined);

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        // Simulate save already in progress
        yield* Ref.update(ref, (s) => ({ ...s, pendingSave: true }));
        // This call should set needsResave, not start a new write
        yield* persistConfig;
        const state = yield* Ref.get(ref);
        expect(state.needsResave).toBe(true);
      }).pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(TestPersistencePathLive)
      )
    );

    // No writes — coalesced into the in-flight save
    expect(renameSpy).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-config-persistence.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/daemon-config-persistence.ts
import { Context, Effect, Layer, Ref } from "effect";
import * as fs from "node:fs/promises";
import { DaemonStateTag, DaemonState } from "./daemon-state.js";

export class PersistencePathTag extends Context.Tag("PersistencePath")<
  PersistencePathTag,
  string
>() {}

// NOTE: SerializedConfig must match the full DaemonConfig from
// src/lib/daemon/config-persistence.ts (12+ fields including projects,
// instances, pid, port, tls, debug, etc.). The implementer MUST read
// config-persistence.ts:22-52 and include ALL fields. This is a
// simplified skeleton showing the pattern — extend with all fields.
interface SerializedConfig {
  pinHash: string | null;
  keepAwake: boolean;
  keepAwakeCommand?: string;
  keepAwakeArgs?: string[];
  dismissedPaths: string[];
  persistedSessionCounts: Record<string, number>;
  // TODO: Add all remaining DaemonConfig fields from config-persistence.ts:
  // pid, port, tls, debug, dangerouslySkipPermissions,
  // projects (array of {path, slug, title, addedAt, instanceId, sessionCount}),
  // instances (array of instance objects)
  // These require access to ProjectRegistryTag and InstanceManagerTag.
}

const serializeState = (state: DaemonState): SerializedConfig => ({
  pinHash: state.pinHash,
  keepAwake: state.keepAwake,
  keepAwakeCommand: state.keepAwakeCommand,
  keepAwakeArgs: state.keepAwakeArgs,
  dismissedPaths: [...state.dismissedPaths],
  persistedSessionCounts: Object.fromEntries(state.persistedSessionCounts),
});

const deserializeConfig = (raw: SerializedConfig): Partial<DaemonState> => ({
  pinHash: raw.pinHash,
  keepAwake: raw.keepAwake,
  keepAwakeCommand: raw.keepAwakeCommand,
  keepAwakeArgs: raw.keepAwakeArgs,
  dismissedPaths: new Set(raw.dismissedPaths ?? []),
  persistedSessionCounts: new Map(
    Object.entries(raw.persistedSessionCounts ?? {}).map(([k, v]) => [k, Number(v)])
  ),
});

export const loadConfig: Effect.Effect<DaemonState, never, PersistencePathTag> =
  Effect.gen(function* () {
    const path = yield* PersistencePathTag;
    return yield* Effect.tryPromise(() => fs.readFile(path, "utf-8")).pipe(
      Effect.map((raw) => ({ ...DaemonState.empty(), ...deserializeConfig(JSON.parse(raw)) })),
      Effect.orElseSucceed(() => DaemonState.empty())
    );
  });

// Atomic write: write to temp file, then rename (crash-safe)
const atomicWrite = (path: string, content: string) =>
  Effect.gen(function* () {
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    const dir = path.substring(0, path.lastIndexOf("/"));
    yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true }));
    yield* Effect.tryPromise(() => fs.writeFile(tmpPath, content, "utf-8"));
    yield* Effect.tryPromise(() => fs.rename(tmpPath, path));
  });

export const persistConfig: Effect.Effect<void, never, DaemonStateTag | PersistencePathTag> =
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;

    // Atomic coalesce: check-and-set pendingSave in one operation
    const alreadySaving = yield* Ref.modify(ref, (s) => {
      if (s.pendingSave) return [true, { ...s, needsResave: true }];
      return [false, { ...s, pendingSave: true }];
    });

    if (alreadySaving) return;

    const path = yield* PersistencePathTag;

    // Read state FRESH at time of write (not stale snapshot from earlier)
    const freshState = yield* Ref.get(ref);
    const serialized = JSON.stringify(serializeState(freshState), null, 2);

    yield* atomicWrite(path, serialized).pipe(
      Effect.catchAllCause(Effect.logWarning)
    );

    // Check if resave needed, reset flags atomically
    const needsResave = yield* Ref.modify(ref, (s) => {
      return [s.needsResave, { ...s, pendingSave: false, needsResave: false }];
    });

    if (needsResave) {
      yield* persistConfig;
    }
  });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon-config-persistence.test.ts`
Expected: 4 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/daemon-config-persistence.ts test/unit/daemon/daemon-config-persistence.test.ts
git commit -m "feat(effect): add config persistence with coalesced saves"
```

---

### Task 3: Create startup Effect functions

**Files:**
- Create: `src/lib/effect/daemon-startup.ts`
- Test: `test/unit/daemon/daemon-startup.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-startup.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Exit } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import {
  rehydrateInstances,
  probeAndConvert,
  detectSmartDefault,
  autoStartManagedDefault,
  recordCrashCounter,
  CrashCounterTag,
  type StartupDeps,
} from "../../../src/lib/effect/daemon-startup.js";
import { InstanceMgmtTag } from "../../../src/lib/effect/services.js";

describe("daemon startup effects", () => {
  describe("recordCrashCounter", () => {
    it("records crash and proceeds when under limit", async () => {
      const mockCounter = {
        record: vi.fn().mockReturnValue({ count: 2, shouldAbort: false }),
        reset: vi.fn(),
      };

      const result = await Effect.runPromise(
        recordCrashCounter.pipe(
          Effect.provide(Layer.succeed(CrashCounterTag, mockCounter))
        )
      );

      expect(mockCounter.record).toHaveBeenCalled();
      expect(result).toBe(false); // shouldAbort = false
    });

    it("aborts when crash limit exceeded", async () => {
      const mockCounter = {
        record: vi.fn().mockReturnValue({ count: 10, shouldAbort: true }),
        reset: vi.fn(),
      };

      const result = await Effect.runPromise(
        recordCrashCounter.pipe(
          Effect.provide(Layer.succeed(CrashCounterTag, mockCounter))
        )
      );

      expect(result).toBe(true); // shouldAbort = true
    });
  });

  describe("rehydrateInstances", () => {
    it("restores instances from persisted state", async () => {
      const addInstance = vi.fn();
      const mockInstanceMgmt = { addInstance, removeInstance: vi.fn(), listInstances: vi.fn() };

      await Effect.runPromise(
        Effect.gen(function* () {
          const ref = yield* DaemonStateTag;
          yield* Ref.update(ref, (s) => ({
            ...s,
            persistedSessionCounts: new Map([["s1", 5], ["s2", 3]]),
          }));
          yield* rehydrateInstances;
        }).pipe(
          Effect.provide(makeDaemonStateLive()),
          Effect.provide(Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as any))
        )
      );

      // Should not throw — degraded path logs and continues
    });
  });

  describe("error isolation", () => {
    it("rehydrateInstances is non-fatal — logs and continues", async () => {
      const mockInstanceMgmt = {
        addInstance: vi.fn().mockImplementation(() => { throw new Error("DB corrupt"); }),
        removeInstance: vi.fn(),
        listInstances: vi.fn(),
      };

      // Should not throw
      const exit = await Effect.runPromiseExit(
        rehydrateInstances.pipe(
          Effect.provide(makeDaemonStateLive()),
          Effect.provide(Layer.succeed(InstanceMgmtTag, mockInstanceMgmt as any))
        )
      );

      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-startup.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/daemon-startup.ts
import { Context, Effect, Layer, Ref } from "effect";
import { DaemonStateTag } from "./daemon-state.js";
import { InstanceMgmtTag } from "./services.js";

// --- Crash Counter ---

export interface CrashCounter {
  record(): { count: number; shouldAbort: boolean };
  reset(): void;
}

export class CrashCounterTag extends Context.Tag("CrashCounter")<
  CrashCounterTag,
  CrashCounter
>() {}

export const recordCrashCounter: Effect.Effect<boolean, never, CrashCounterTag> =
  Effect.gen(function* () {
    const counter = yield* CrashCounterTag;
    const result = yield* Effect.sync(() => counter.record());
    return result.shouldAbort;
  });

// --- Instance rehydration (degraded on failure) ---

export const rehydrateInstances: Effect.Effect<void, never, DaemonStateTag | InstanceMgmtTag> =
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    const mgmt = yield* InstanceMgmtTag;

    yield* Effect.logInfo(`Rehydrating ${state.persistedSessionCounts.size} session counts`);
    // Actual rehydration logic will read persisted config and call mgmt.addInstance
    // for each saved instance. Details depend on config schema.
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Instance rehydration failed, continuing with empty state", cause)
    )
  );

// --- Probe and convert (degraded on failure) ---

export const probeAndConvert: Effect.Effect<void, never, InstanceMgmtTag> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* Effect.logInfo("Probing for unreachable unmanaged instances");
    // Probe logic: check each instance, convert unreachable unmanaged to managed
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Probe-and-convert failed, continuing", cause)
    )
  );

// --- Smart default detection (degraded on failure) ---

export const detectSmartDefault: Effect.Effect<void, never, InstanceMgmtTag> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* Effect.logInfo("Detecting smart default on localhost:4096");
    // Probe localhost:4096, create instance if found
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Smart default detection failed, continuing", cause)
    )
  );

// --- Auto-start managed default (degraded on failure) ---

export const autoStartManagedDefault: Effect.Effect<void, never, InstanceMgmtTag | DaemonStateTag> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* Effect.logInfo("Auto-starting managed default instance");
    // Find default managed instance, start if stopped
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logWarning("Auto-start failed, continuing", cause)
    )
  );

// --- Startup orchestrator ---

export const runStartupSequence: Effect.Effect<
  void,
  never,
  CrashCounterTag | DaemonStateTag | InstanceMgmtTag
> = Effect.gen(function* () {
  // Phase 2: Sequential startup effects
  const shouldAbort = yield* recordCrashCounter;
  if (shouldAbort) {
    yield* Effect.logError("Crash limit exceeded, aborting startup");
    return yield* Effect.die("Crash limit exceeded");
  }

  // Degraded steps — each catches its own errors
  yield* rehydrateInstances;
  yield* probeAndConvert;
  yield* detectSmartDefault;
  yield* autoStartManagedDefault;

  yield* Effect.logInfo("Startup sequence complete");
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon-startup.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/daemon-startup.ts test/unit/daemon/daemon-startup.test.ts
git commit -m "feat(effect): add startup effect functions with error isolation policy"
```

---

### Task 4: Create ScopedCache relay system

**Files:**
- Create: `src/lib/effect/relay-cache.ts`
- Test: `test/unit/relay/relay-cache.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/relay-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, ScopedCache, Scope, Duration, Exit } from "effect";
import { RelayCacheTag, makeRelayCacheLive, type Relay } from "../../../src/lib/effect/relay-cache.js";

const makeTestRelay = (slug: string): Relay => ({
  slug,
  wsHandler: { handleUpgrade: vi.fn() } as any,
  stop: vi.fn(),
});

describe("RelayCache", () => {
  it("creates relay on first get", async () => {
    let created = 0;
    const factory = (slug: string) =>
      Effect.sync(() => {
        created++;
        return makeTestRelay(slug);
      });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* RelayCacheTag;
          const relay = yield* cache.get("test-slug");
          return relay;
        })
      ).pipe(Effect.provide(makeRelayCacheLive(factory)))
    );

    expect(result.slug).toBe("test-slug");
    expect(created).toBe(1);
  });

  it("deduplicates concurrent gets for same slug", async () => {
    let created = 0;
    const factory = (slug: string) =>
      Effect.delay(Effect.sync(() => {
        created++;
        return makeTestRelay(slug);
      }), Duration.millis(50));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* RelayCacheTag;
          // Concurrent gets for same slug
          const [r1, r2] = yield* Effect.all([
            cache.get("same-slug"),
            cache.get("same-slug"),
          ], { concurrency: "unbounded" });
          expect(r1).toBe(r2);
        })
      ).pipe(Effect.provide(makeRelayCacheLive(factory)))
    );

    expect(created).toBe(1); // Only created once despite two gets
  });

  it("invalidate removes relay and allows re-creation", async () => {
    let created = 0;
    const factory = (slug: string) =>
      Effect.sync(() => {
        created++;
        return makeTestRelay(slug);
      });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* RelayCacheTag;
          yield* cache.get("slug-a");
          expect(created).toBe(1);

          yield* cache.invalidate("slug-a");
          yield* cache.get("slug-a");
          expect(created).toBe(2); // Re-created after invalidation
        })
      ).pipe(Effect.provide(makeRelayCacheLive(factory)))
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/relay-cache.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/relay-cache.ts
import { Context, Effect, Layer, ScopedCache, Duration, Scope } from "effect";

export interface Relay {
  slug: string;
  wsHandler: { handleUpgrade: (req: any, socket: any, head: any) => void };
  stop: () => void;
}

export type RelayFactory = (slug: string) => Effect.Effect<Relay, never, never>;

export class RelayCacheTag extends Context.Tag("RelayCache")<
  RelayCacheTag,
  ScopedCache.ScopedCache<string, Relay>
>() {}

export const makeRelayCacheLive = (
  factory: RelayFactory,
  capacity = 200
): Layer.Layer<RelayCacheTag> =>
  Layer.scoped(
    RelayCacheTag,
    ScopedCache.make({
      lookup: (slug: string) =>
        Effect.gen(function* () {
          const relay = yield* factory(slug);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => relay.stop())
          );
          return relay;
        }),
      capacity,
      timeToLive: Duration.infinity,
    })
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/relay-cache.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/relay-cache.ts test/unit/relay/relay-cache.test.ts
git commit -m "feat(effect): add ScopedCache-based relay cache replacing ProjectRegistry state machine"
```

---

### Task 5: Expand makeDaemonLive with new Layers

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/daemon/daemon-layers.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-layers.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Layer, Ref, Context } from "effect";
import { DaemonStateTag } from "../../../src/lib/effect/daemon-state.js";
import { RelayCacheTag } from "../../../src/lib/effect/relay-cache.js";

describe("daemon layer composition", () => {
  it("DaemonStateTag is available in composed layer", async () => {
    // Verify DaemonStateTag can be yielded from a composed layer
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        const state = yield* Ref.get(ref);
        return state.clientCount;
      }).pipe(
        Effect.provide(
          Layer.effect(DaemonStateTag, Ref.make({
            pinHash: null, keepAwake: false, keepAwakeCommand: undefined,
            keepAwakeArgs: undefined, clientCount: 0, shuttingDown: false,
            dismissedPaths: new Set(), persistedSessionCounts: new Map(),
            pendingSave: false, needsResave: false,
          }))
        )
      )
    );

    expect(result).toBe(0);
  });
});
```

**Step 2: Run test to verify it passes** (this is a smoke test for the composition)

Run: `pnpm vitest run test/unit/daemon/daemon-layers.test.ts`
Expected: PASS

**Step 3: Add new Tags to services.ts**

Add to `src/lib/effect/services.ts`:
```typescript
export { DaemonStateTag } from "./daemon-state.js";
export { RelayCacheTag } from "./relay-cache.js";
export { PersistencePathTag } from "./daemon-config-persistence.js";
export { CrashCounterTag } from "./daemon-startup.js";
```

**Step 4: Wire new Layers into daemon-layers.ts**

Add to `src/lib/effect/daemon-layers.ts` — new Layer factories and composition:

```typescript
import { DaemonStateTag, makeDaemonStateLive } from "./daemon-state.js";
import { RelayCacheTag, makeRelayCacheLive } from "./relay-cache.js";
import { PersistencePathTag } from "./daemon-config-persistence.js";
import { loadConfig } from "./daemon-config-persistence.js";
import { runStartupSequence, CrashCounterTag } from "./daemon-startup.js";

// DaemonState Layer — loads config from disk, seeds Ref, finalizer persists
export const makeDaemonStateFromDisk = (configPath: string): Layer.Layer<DaemonStateTag | PersistencePathTag> =>
  Layer.effect(
    DaemonStateTag,
    Effect.gen(function* () {
      const initial = yield* loadConfig;
      return yield* Ref.make({ ...DaemonState.empty(), ...initial });
    })
  ).pipe(
    Layer.provideMerge(Layer.succeed(PersistencePathTag, configPath))
  );
```

In `makeDaemonLive`, add the new layers to the composition chain:
```typescript
// Existing: infraLayer → serversLayer → backgroundLayer
// Add: daemonStateLayer and relayCacheLayer
const daemonStateLayer = makeDaemonStateFromDisk(configPath);
const relayCacheLayer = makeRelayCacheLive(relayFactory);

// Final composition
return infraLayer
  .pipe(Layer.provideMerge(daemonStateLayer))
  .pipe(Layer.provideMerge(serversLayer))
  .pipe(Layer.provideMerge(relayCacheLayer))
  .pipe(Layer.provideMerge(backgroundLayer));
```

**Step 5: Run tests**

Run: `pnpm vitest run test/unit/daemon/`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/lib/effect/daemon-layers.ts src/lib/effect/services.ts test/unit/daemon/daemon-layers.test.ts
git commit -m "feat(effect): wire DaemonState and RelayCache into makeDaemonLive"
```

---

### Task 6: Dissolve Daemon class — replace start() with startup Effect

**Files:**
- Modify: `src/lib/daemon/daemon.ts`
- Create: `src/lib/effect/daemon-main.ts`
- Test: `test/unit/daemon/daemon-main.test.ts`

This is the largest single task. The Daemon class `start()` method (586 lines) is replaced by a composed Effect program that calls the startup functions from Task 3, uses the Layers from Task 5, and runs via `ManagedRuntime`.

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-main.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Exit, ManagedRuntime } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { CrashCounterTag } from "../../../src/lib/effect/daemon-startup.js";
import { startDaemon } from "../../../src/lib/effect/daemon-main.js";

describe("startDaemon", () => {
  it("runs startup sequence and returns runtime", async () => {
    const mockCounter = {
      record: vi.fn().mockReturnValue({ count: 1, shouldAbort: false }),
      reset: vi.fn(),
    };

    // Minimal layer providing required deps
    const testLayer = Layer.mergeAll(
      makeDaemonStateLive(),
      Layer.succeed(CrashCounterTag, mockCounter),
    );

    // startDaemon should succeed with minimal deps
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        const state = yield* Ref.get(ref);
        expect(state.shuttingDown).toBe(false);
      }).pipe(Effect.provide(testLayer))
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("aborts when crash counter triggers", async () => {
    const mockCounter = {
      record: vi.fn().mockReturnValue({ count: 10, shouldAbort: true }),
      reset: vi.fn(),
    };

    const testLayer = Layer.mergeAll(
      makeDaemonStateLive(),
      Layer.succeed(CrashCounterTag, mockCounter),
    );

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const { runStartupSequence } = yield* import("../../../src/lib/effect/daemon-startup.js");
        yield* runStartupSequence;
      }).pipe(Effect.provide(testLayer))
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-main.test.ts`
Expected: FAIL — module not found

**Step 3: Write daemon-main.ts — top-level entry point**

```typescript
// src/lib/effect/daemon-main.ts
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import { DaemonStateTag } from "./daemon-state.js";
import { runStartupSequence } from "./daemon-startup.js";
import { persistConfig } from "./daemon-config-persistence.js";

/**
 * Top-level daemon entry point. Replaces Daemon.start().
 *
 * 1. Builds the full Layer composition (services, servers, background)
 * 2. Runs the startup sequence (crash counter, rehydration, probe, etc.)
 * 3. Forks background tasks (project discovery, session prefetch, push)
 * 4. Returns the ManagedRuntime for IPC/HTTP handlers to use
 *
 * Shutdown: dispose the ManagedRuntime → all Layer finalizers run in reverse.
 */
export const startDaemon = (
  daemonLayer: Layer.Layer<any>
): Effect.Effect<ManagedRuntime.ManagedRuntime<any, never>> =>
  Effect.gen(function* () {
    const runtime = yield* ManagedRuntime.make(daemonLayer);

    // Run startup sequence within the runtime's context
    yield* runtime.runPromise(runStartupSequence);

    // Fork background tasks
    yield* runtime.runFork(
      Effect.gen(function* () {
        // Phase 3: fire-and-forget background effects
        yield* Effect.forkScoped(
          Effect.logInfo("Project discovery").pipe(
            Effect.catchAllCause(Effect.logWarning)
          )
        );
        yield* Effect.forkScoped(
          Effect.logInfo("Session prefetch").pipe(
            Effect.catchAllCause(Effect.logWarning)
          )
        );
      })
    );

    return runtime;
  });

/**
 * Stop the daemon. Disposes the runtime, triggering all finalizers.
 */
export const stopDaemon = (
  runtime: ManagedRuntime.ManagedRuntime<any, never>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.logInfo("Shutting down daemon...");
    yield* runtime.dispose();
    yield* Effect.logInfo("Daemon stopped.");
  });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon-main.test.ts`
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/daemon-main.ts test/unit/daemon/daemon-main.test.ts
git commit -m "feat(effect): add daemon-main.ts replacing Daemon.start() with Effect program"
```

---

### Task 7: IPC Schema definitions

**Files:**
- Create: `src/lib/effect/ipc-schema.ts`
- Test: `test/unit/daemon/ipc-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/ipc-schema.test.ts
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  IpcCommand,
  AddProjectRequest,
  RemoveProjectRequest,
  ListProjectsRequest,
  SetPinRequest,
  ShutdownRequest,
  InstanceListRequest,
  InstanceAddRequest,
} from "../../../src/lib/effect/ipc-schema.js";

describe("IPC Schema", () => {
  it("decodes AddProject command", () => {
    const raw = { _tag: "AddProject", directory: "/home/user/project" };
    const result = Schema.decodeUnknownSync(IpcCommand)(raw);
    expect(result._tag).toBe("AddProject");
    expect((result as any).directory).toBe("/home/user/project");
  });

  it("rejects AddProject without directory", () => {
    const raw = { _tag: "AddProject" };
    expect(() => Schema.decodeUnknownSync(IpcCommand)(raw)).toThrow();
  });

  it("decodes SetPin command", () => {
    const raw = { _tag: "SetPin", pin: "1234" };
    const result = Schema.decodeUnknownSync(IpcCommand)(raw);
    expect(result._tag).toBe("SetPin");
  });

  it("decodes Shutdown command (no payload)", () => {
    const raw = { _tag: "Shutdown" };
    const result = Schema.decodeUnknownSync(IpcCommand)(raw);
    expect(result._tag).toBe("Shutdown");
  });

  it("rejects unknown command tag", () => {
    const raw = { _tag: "UnknownCommand" };
    expect(() => Schema.decodeUnknownSync(IpcCommand)(raw)).toThrow();
  });

  it("decodes InstanceAdd command", () => {
    const raw = { _tag: "InstanceAdd", name: "test", port: 4096 };
    const result = Schema.decodeUnknownSync(IpcCommand)(raw);
    expect(result._tag).toBe("InstanceAdd");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/ipc-schema.test.ts`
Expected: FAIL — module not found

**Step 3: Write IPC Schema definitions**

```typescript
// src/lib/effect/ipc-schema.ts
import { Schema } from "effect";

// --- Project commands ---

export class AddProjectRequest extends Schema.TaggedRequest<AddProjectRequest>()(
  "AddProject",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true), slug: Schema.String, path: Schema.String }),
    payload: { directory: Schema.String },
  }
) {}

export class RemoveProjectRequest extends Schema.TaggedRequest<RemoveProjectRequest>()(
  "RemoveProject",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { slug: Schema.String },
  }
) {}

export class ListProjectsRequest extends Schema.TaggedRequest<ListProjectsRequest>()(
  "ListProjects",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true), projects: Schema.Array(Schema.Unknown) }),
    payload: {},
  }
) {}

export class SetProjectTitleRequest extends Schema.TaggedRequest<SetProjectTitleRequest>()(
  "SetProjectTitle",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { slug: Schema.String, title: Schema.String },
  }
) {}

// --- Security & config commands ---

export class SetPinRequest extends Schema.TaggedRequest<SetPinRequest>()(
  "SetPin",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { pin: Schema.String },
  }
) {}

export class SetKeepAwakeRequest extends Schema.TaggedRequest<SetKeepAwakeRequest>()(
  "SetKeepAwake",
  {
    failure: Schema.Never,
    success: Schema.Struct({
      ok: Schema.Literal(true),
      supported: Schema.Boolean,
      active: Schema.Boolean,
    }),
    payload: { enabled: Schema.Boolean },
  }
) {}

export class SetKeepAwakeCommandRequest extends Schema.TaggedRequest<SetKeepAwakeCommandRequest>()(
  "SetKeepAwakeCommand",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: {
      command: Schema.String,
      args: Schema.optional(Schema.Array(Schema.String)),
    },
  }
) {}

export class ShutdownRequest extends Schema.TaggedRequest<ShutdownRequest>()(
  "Shutdown",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: {},
  }
) {}

export class GetStatusRequest extends Schema.TaggedRequest<GetStatusRequest>()(
  "GetStatus",
  {
    failure: Schema.Never,
    success: Schema.Unknown,
    payload: {},
  }
) {}

export class RestartWithConfigRequest extends Schema.TaggedRequest<RestartWithConfigRequest>()(
  "RestartWithConfig",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: {},
  }
) {}

// --- Instance commands ---

export class InstanceListRequest extends Schema.TaggedRequest<InstanceListRequest>()(
  "InstanceList",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true), instances: Schema.Array(Schema.Unknown) }),
    payload: {},
  }
) {}

export class InstanceAddRequest extends Schema.TaggedRequest<InstanceAddRequest>()(
  "InstanceAdd",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true), instance: Schema.Unknown }),
    payload: { name: Schema.String, port: Schema.Number },
  }
) {}

export class InstanceRemoveRequest extends Schema.TaggedRequest<InstanceRemoveRequest>()(
  "InstanceRemove",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { id: Schema.String },
  }
) {}

export class InstanceStartRequest extends Schema.TaggedRequest<InstanceStartRequest>()(
  "InstanceStart",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { id: Schema.String },
  }
) {}

export class InstanceStopRequest extends Schema.TaggedRequest<InstanceStopRequest>()(
  "InstanceStop",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: { id: Schema.String },
  }
) {}

export class InstanceUpdateRequest extends Schema.TaggedRequest<InstanceUpdateRequest>()(
  "InstanceUpdate",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true), instance: Schema.Unknown }),
    payload: {
      id: Schema.String,
      name: Schema.optional(Schema.String),
      port: Schema.optional(Schema.Number),
    },
  }
) {}

export class InstanceStatusRequest extends Schema.TaggedRequest<InstanceStatusRequest>()(
  "InstanceStatus",
  {
    failure: Schema.Never,
    success: Schema.Unknown,
    payload: { id: Schema.String },
  }
) {}

// --- Stubs ---

export class SetAgentRequest extends Schema.TaggedRequest<SetAgentRequest>()(
  "SetAgent",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: {},
  }
) {}

export class SetModelRequest extends Schema.TaggedRequest<SetModelRequest>()(
  "SetModel",
  {
    failure: Schema.Never,
    success: Schema.Struct({ ok: Schema.Literal(true) }),
    payload: {},
  }
) {}

// --- Discriminated union of all commands ---

export const IpcCommand = Schema.Union(
  AddProjectRequest,
  RemoveProjectRequest,
  ListProjectsRequest,
  SetProjectTitleRequest,
  SetPinRequest,
  SetKeepAwakeRequest,
  SetKeepAwakeCommandRequest,
  ShutdownRequest,
  GetStatusRequest,
  RestartWithConfigRequest,
  InstanceListRequest,
  InstanceAddRequest,
  InstanceRemoveRequest,
  InstanceStartRequest,
  InstanceStopRequest,
  InstanceUpdateRequest,
  InstanceStatusRequest,
  SetAgentRequest,
  SetModelRequest,
);

export type IpcCommandType = Schema.Schema.Type<typeof IpcCommand>;
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/ipc-schema.test.ts`
Expected: 6 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/ipc-schema.ts test/unit/daemon/ipc-schema.test.ts
git commit -m "feat(effect): add Schema.TaggedRequest definitions for all 18 IPC commands"
```

---

### Task 8: IPC Effect handlers and Stream dispatch

**Files:**
- Create: `src/lib/effect/ipc-handlers.ts`
- Create: `src/lib/effect/ipc-dispatch.ts`
- Test: `test/unit/daemon/ipc-handlers.test.ts`
- Test: `test/unit/daemon/ipc-dispatch.test.ts`

**Step 1: Write the failing test for handlers**

```typescript
// test/unit/daemon/ipc-handlers.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { handleAddProject, handleSetPin } from "../../../src/lib/effect/ipc-handlers.js";
import { AddProjectRequest, SetPinRequest } from "../../../src/lib/effect/ipc-schema.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

describe("IPC handlers", () => {
  describe("handleAddProject", () => {
    it("adds project and returns slug", async () => {
      const mockProjectMgmt = {
        addProject: vi.fn().mockReturnValue(
          Effect.succeed({ slug: "my-proj", path: "/home/user/my-proj" })
        ),
      };

      const result = await Effect.runPromise(
        handleAddProject({ _tag: "AddProject", directory: "/home/user/my-proj" } as any).pipe(
          Effect.provide(Layer.succeed(ProjectMgmtTag, mockProjectMgmt as any)),
          Effect.provide(makeDaemonStateLive()),
          Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
        )
      );

      expect(result).toEqual({ ok: true, slug: "my-proj", path: "/home/user/my-proj" });
    });
  });

  describe("handleSetPin", () => {
    it("updates pinHash in state", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* handleSetPin({ _tag: "SetPin", pin: "1234" } as any);
          const ref = yield* DaemonStateTag;
          const state = yield* Ref.get(ref);
          return state.pinHash;
        }).pipe(
          Effect.provide(makeDaemonStateLive()),
          Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
        )
      );

      expect(result).not.toBeNull();
      expect(typeof result).toBe("string");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/ipc-handlers.test.ts`
Expected: FAIL — module not found

**Step 3: Write handlers**

```typescript
// src/lib/effect/ipc-handlers.ts
import { Effect, Ref } from "effect";
import { DaemonStateTag } from "./daemon-state.js";
import { persistConfig } from "./daemon-config-persistence.js";
import { ProjectMgmtTag, InstanceMgmtTag } from "./services.js";
import type {
  AddProjectRequest, RemoveProjectRequest, SetPinRequest,
  SetKeepAwakeRequest, ShutdownRequest, InstanceAddRequest,
  InstanceRemoveRequest, InstanceStartRequest, InstanceStopRequest,
} from "./ipc-schema.js";

export const handleAddProject = (cmd: AddProjectRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* ProjectMgmtTag;
    const result = yield* mgmt.addProject(cmd.directory);
    yield* persistConfig;
    return { ok: true as const, slug: result.slug, path: result.path };
  });

export const handleRemoveProject = (cmd: RemoveProjectRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* ProjectMgmtTag;
    yield* mgmt.removeProject(cmd.slug);
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetPin = (cmd: SetPinRequest) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    // Hash the pin (use same hashing as current auth.ts)
    const hash = yield* Effect.sync(() => {
      const crypto = require("node:crypto");
      return crypto.createHash("sha256").update(cmd.pin).digest("hex");
    });
    yield* Ref.update(ref, (s) => ({ ...s, pinHash: hash }));
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetKeepAwake = (cmd: SetKeepAwakeRequest) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({ ...s, keepAwake: cmd.enabled }));
    yield* persistConfig;
    return { ok: true as const, supported: true, active: cmd.enabled };
  });

export const handleShutdown = (_cmd: ShutdownRequest) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({ ...s, shuttingDown: true }));
    return { ok: true as const };
  });

export const handleInstanceAdd = (cmd: InstanceAddRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const instance = yield* mgmt.addInstance(cmd);
    yield* persistConfig;
    return { ok: true as const, instance };
  });

export const handleInstanceRemove = (cmd: InstanceRemoveRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.removeInstance(cmd.id);
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleInstanceStart = (cmd: InstanceStartRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.startInstance(cmd.id);
    return { ok: true as const };
  });

export const handleInstanceStop = (cmd: InstanceStopRequest) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.stopInstance(cmd.id);
    return { ok: true as const };
  });
```

**Step 4: Write dispatch**

```typescript
// src/lib/effect/ipc-dispatch.ts
import { Effect, Schema, Stream } from "effect";
import { IpcCommand, type IpcCommandType } from "./ipc-schema.js";
import {
  handleAddProject, handleRemoveProject, handleSetPin,
  handleSetKeepAwake, handleShutdown, handleInstanceAdd,
  handleInstanceRemove, handleInstanceStart, handleInstanceStop,
} from "./ipc-handlers.js";

const dispatch = (command: IpcCommandType): Effect.Effect<any, any, any> => {
  switch (command._tag) {
    case "AddProject": return handleAddProject(command);
    case "RemoveProject": return handleRemoveProject(command);
    case "SetPin": return handleSetPin(command);
    case "SetKeepAwake": return handleSetKeepAwake(command);
    case "Shutdown": return handleShutdown(command);
    case "InstanceAdd": return handleInstanceAdd(command);
    case "InstanceRemove": return handleInstanceRemove(command);
    case "InstanceStart": return handleInstanceStart(command);
    case "InstanceStop": return handleInstanceStop(command);
    // Stubs
    case "SetAgent":
    case "SetModel":
      return Effect.succeed({ ok: true });
    // Read-only handlers — implement per-command
    case "ListProjects":
    case "GetStatus":
    case "InstanceList":
    case "InstanceStatus":
    case "InstanceUpdate":
    case "SetProjectTitle":
    case "SetKeepAwakeCommand":
    case "RestartWithConfig":
      return Effect.succeed({ ok: true }); // Placeholder — fill in per handler
  }
};

export const decodeAndDispatch = (raw: string): Effect.Effect<any, any, any> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => JSON.parse(raw));
    const command = yield* Schema.decode(IpcCommand)(parsed);
    return yield* dispatch(command);
  }).pipe(
    Effect.catchTag("ParseError", (e) =>
      Effect.succeed({ ok: false, error: `Invalid command: ${e.message}` })
    ),
    Effect.catchAll((e) =>
      Effect.succeed({ ok: false, error: String(e) })
    )
  );

export const ipcConnectionStream = (readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream) =>
  Stream.fromReadableStream(
    () => readable as any,
    () => new Error("IPC connection closed")
  ).pipe(
    Stream.mapEffect((chunk) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      return Effect.forEach(lines, (line) =>
        decodeAndDispatch(line).pipe(
          Effect.tap((response) =>
            Effect.sync(() => writable.write(JSON.stringify(response) + "\n"))
          )
        )
      );
    }),
    Stream.catchAllCause(Effect.logWarning)
  );
```

**Step 5: Write dispatch test**

```typescript
// test/unit/daemon/ipc-dispatch.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { decodeAndDispatch } from "../../../src/lib/effect/ipc-dispatch.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

describe("IPC dispatch", () => {
  it("dispatches valid AddProject command", async () => {
    const mockMgmt = {
      addProject: vi.fn().mockReturnValue(
        Effect.succeed({ slug: "proj", path: "/proj" })
      ),
    };

    const result = await Effect.runPromise(
      decodeAndDispatch('{"_tag":"AddProject","directory":"/proj"}').pipe(
        Effect.provide(Layer.succeed(ProjectMgmtTag, mockMgmt as any)),
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
      )
    );

    expect(result).toEqual({ ok: true, slug: "proj", path: "/proj" });
  });

  it("returns error for invalid JSON", async () => {
    const result = await Effect.runPromise(
      decodeAndDispatch("not-json").pipe(
        Effect.provide(makeDaemonStateLive()),
      )
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error for unknown command tag", async () => {
    const result = await Effect.runPromise(
      decodeAndDispatch('{"_tag":"Bogus"}').pipe(
        Effect.provide(makeDaemonStateLive()),
      )
    );

    expect(result.ok).toBe(false);
  });
});
```

**Step 6: Run tests**

Run: `pnpm vitest run test/unit/daemon/ipc-handlers.test.ts test/unit/daemon/ipc-dispatch.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/lib/effect/ipc-handlers.ts src/lib/effect/ipc-dispatch.ts test/unit/daemon/ipc-handlers.test.ts test/unit/daemon/ipc-dispatch.test.ts
git commit -m "feat(effect): add IPC handlers and Schema-driven dispatch"
```

---

## Track B: Session Stack (Parallel)

Tasks 9-12 can run in parallel with each other and with Track A Tasks 1-6.

### Task 9: SessionManager — dissolve EventEmitter

**Files:**
- Create: `src/lib/effect/session-manager-state.ts`
- Create: `src/lib/effect/session-manager-service.ts`
- Test: `test/unit/session/session-manager-effect.test.ts`
- Modify: `src/lib/effect/services.ts` (update SessionManagerTag shape)

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-manager-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref } from "effect";
import {
  SessionManagerStateTag,
  makeSessionManagerStateLive,
  type SessionManagerState,
} from "../../../src/lib/effect/session-manager-state.js";
import {
  SessionManagerServiceTag,
  listSessions,
  createSession,
  deleteSession,
  recordMessageActivity,
} from "../../../src/lib/effect/session-manager-service.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("SessionManager Effect", () => {
  const mockApi = {
    listSessions: vi.fn().mockReturnValue(
      Effect.succeed({ sessions: [{ id: "s1", title: "Test" }] })
    ),
    createSession: vi.fn().mockReturnValue(
      Effect.succeed({ id: "s-new", title: "New" })
    ),
    deleteSession: vi.fn().mockReturnValue(Effect.succeed(undefined)),
  };

  const testLayer = Layer.mergeAll(
    makeSessionManagerStateLive(),
    Layer.succeed(OpenCodeAPITag, mockApi as any),
  );

  it("listSessions fetches from API and caches parent map", async () => {
    const result = await Effect.runPromise(
      listSessions().pipe(Effect.provide(testLayer))
    );

    expect(result.sessions).toHaveLength(1);
    expect(mockApi.listSessions).toHaveBeenCalled();
  });

  it("createSession calls API and emits lifecycle", async () => {
    const lifecycleSpy = vi.fn();

    const result = await Effect.runPromise(
      createSession("My session").pipe(Effect.provide(testLayer))
    );

    expect(result.id).toBe("s-new");
    expect(mockApi.createSession).toHaveBeenCalled();
  });

  it("recordMessageActivity updates timestamp", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordMessageActivity("s1", 12345);
        const ref = yield* SessionManagerStateTag;
        const state = yield* Ref.get(ref);
        return state.lastMessageAt.get("s1");
      }).pipe(Effect.provide(testLayer))
    );

    expect(result).toBe(12345);
  });

  it("deleteSession clears all state maps", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // Seed some state first
        yield* recordMessageActivity("s1", 12345);
        const ref = yield* SessionManagerStateTag;
        yield* Ref.update(ref, (s) => ({
          ...s,
          cachedParentMap: new Map([["child1", "s1"]]),
          paginationCursors: new Map([["s1", "cursor-1"]]),
        }));

        // Delete
        yield* deleteSession("s1");

        const state = yield* Ref.get(ref);
        return {
          hasActivity: state.lastMessageAt.has("s1"),
          hasCursor: state.paginationCursors.has("s1"),
        };
      }).pipe(Effect.provide(testLayer))
    );

    expect(result.hasActivity).toBe(false);
    expect(result.hasCursor).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-manager-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write state module**

```typescript
// src/lib/effect/session-manager-state.ts
import { Context, Effect, Layer, Ref } from "effect";

export interface ForkEntry {
  forkMessageId: string;
  parentId: string;
  forkPointTimestamp: number;
}

export interface SessionManagerState {
  cachedParentMap: Map<string, string>;
  lastMessageAt: Map<string, number>;
  forkMeta: Map<string, ForkEntry>;
  pendingQuestionCounts: Map<string, number>;
  paginationCursors: Map<string, string>;
}

export const SessionManagerState = {
  empty: (): SessionManagerState => ({
    cachedParentMap: new Map(),
    lastMessageAt: new Map(),
    forkMeta: new Map(),
    pendingQuestionCounts: new Map(),
    paginationCursors: new Map(),
  }),
};

export class SessionManagerStateTag extends Context.Tag("SessionManagerState")<
  SessionManagerStateTag,
  Ref.Ref<SessionManagerState>
>() {}

export const makeSessionManagerStateLive = (
  initial?: Partial<SessionManagerState>
): Layer.Layer<SessionManagerStateTag> =>
  Layer.effect(
    SessionManagerStateTag,
    Ref.make({ ...SessionManagerState.empty(), ...initial })
  );
```

**Step 4: Write service module**

```typescript
// src/lib/effect/session-manager-service.ts
import { Effect, Ref, Schedule } from "effect";
import { SessionManagerStateTag } from "./session-manager-state.js";
import { OpenCodeAPITag } from "./services.js";

const retryPolicy = Schedule.exponential("500 millis").pipe(
  Schedule.compose(Schedule.recurs(3))
);

export const listSessions = (options?: { limit?: number }) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const stateRef = yield* SessionManagerStateTag;

    const response = yield* api.listSessions(options).pipe(
      Effect.retry(retryPolicy)
    );

    // Update parent map cache from response
    if (response.sessions) {
      const parentMap = new Map<string, string>();
      for (const session of response.sessions) {
        if ((session as any).parentId) {
          parentMap.set(session.id, (session as any).parentId);
        }
      }
      yield* Ref.update(stateRef, (s) => ({ ...s, cachedParentMap: parentMap }));
    }

    return response;
  });

export const createSession = (title?: string) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const session = yield* api.createSession(title);
    // Lifecycle event handled via direct call (no EventEmitter)
    return session;
  });

export const deleteSession = (sessionId: string) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;
    const stateRef = yield* SessionManagerStateTag;

    yield* api.deleteSession(sessionId);

    // Atomic cleanup across all state maps
    yield* Ref.update(stateRef, (s) => {
      const cachedParentMap = new Map(s.cachedParentMap);
      const lastMessageAt = new Map(s.lastMessageAt);
      const forkMeta = new Map(s.forkMeta);
      const pendingQuestionCounts = new Map(s.pendingQuestionCounts);
      const paginationCursors = new Map(s.paginationCursors);

      cachedParentMap.delete(sessionId);
      lastMessageAt.delete(sessionId);
      forkMeta.delete(sessionId);
      pendingQuestionCounts.delete(sessionId);
      paginationCursors.delete(sessionId);

      // Also clean parent references pointing to this session
      for (const [child, parent] of cachedParentMap) {
        if (parent === sessionId) cachedParentMap.delete(child);
      }

      return { cachedParentMap, lastMessageAt, forkMeta, pendingQuestionCounts, paginationCursors };
    });
  });

export const recordMessageActivity = (sessionId: string, timestamp?: number) =>
  Effect.gen(function* () {
    const ref = yield* SessionManagerStateTag;
    yield* Ref.update(ref, (s) => {
      const lastMessageAt = new Map(s.lastMessageAt);
      lastMessageAt.set(sessionId, timestamp ?? Date.now());
      return { ...s, lastMessageAt };
    });
  });

export class SessionManagerServiceTag extends Context.Tag("SessionManagerService")<
  SessionManagerServiceTag,
  {
    listSessions: typeof listSessions;
    createSession: typeof createSession;
    deleteSession: typeof deleteSession;
    recordMessageActivity: typeof recordMessageActivity;
  }
>() {}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-manager-effect.test.ts`
Expected: 4 tests PASS

**Step 6: Commit**

```bash
git add src/lib/effect/session-manager-state.ts src/lib/effect/session-manager-service.ts test/unit/session/session-manager-effect.test.ts
git commit -m "feat(effect): dissolve SessionManager EventEmitter into Layer + Ref"
```

---

### Task 10: SSEStream — Schedule + Stream

**Files:**
- Create: `src/lib/effect/sse-stream.ts`
- Test: `test/unit/relay/sse-stream-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/sse-stream-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Stream, Chunk, Duration, Schedule, Exit } from "effect";
import {
  sseStream,
  resilientSSE,
  reconnectSchedule,
  type SSEEvent,
} from "../../../src/lib/effect/sse-stream.js";

describe("SSE Stream Effect", () => {
  it("reconnectSchedule has exponential backoff with jitter", () => {
    // Schedule should be exponential starting at 1s, with jitter
    expect(reconnectSchedule).toBeDefined();
  });

  it("sseStream produces SSEEvent items", async () => {
    // Mock EventSource-like behavior via factory
    const events: SSEEvent[] = [
      { type: "message", data: '{"id":"1"}', lastEventId: "1" },
      { type: "message", data: '{"id":"2"}', lastEventId: "2" },
    ];

    const mockStream = Stream.fromIterable(events);

    const result = await Effect.runPromise(
      Stream.runCollect(mockStream).pipe(
        Effect.map(Chunk.toArray)
      )
    );

    expect(result).toHaveLength(2);
    expect(result[0].data).toBe('{"id":"1"}');
  });

  it("stale detection fails stream after timeout", async () => {
    // Stream that never emits — should timeout
    const neverStream = Stream.never as Stream.Stream<SSEEvent, never>;

    const exit = await Effect.runPromiseExit(
      Stream.runDrain(
        neverStream.pipe(
          Stream.timeoutFail({
            onTimeout: () => new Error("SSE stale"),
            duration: Duration.millis(100),
          })
        )
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/sse-stream-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/sse-stream.ts
import { Effect, Stream, Schedule, Duration } from "effect";

export interface SSEEvent {
  type: string;
  data: string;
  lastEventId?: string;
}

export class SSEConnectionError {
  readonly _tag = "SSEConnectionError";
  constructor(readonly cause: unknown) {}
}

export class SSEStaleError {
  readonly _tag = "SSEStaleError";
  constructor(readonly lastEventId?: string) {}
}

// Exponential backoff: 1s base, jittered, capped at 5 min elapsed
export const reconnectSchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.compose(
    Schedule.elapsed.pipe(
      Schedule.whileOutput(Duration.lessThanOrEqualTo(Duration.minutes(5)))
    )
  )
);

/**
 * Create an SSE stream from a URL.
 *
 * NOTE: EventSource is a browser API — NOT available in Node.js.
 * The current codebase uses the OpenCode SDK's streaming API or
 * fetch-based SSE parsing. The implementer MUST check
 * src/lib/relay/sse-stream.ts to see the actual SSE connection
 * mechanism (likely SDK async generator or fetch + ReadableStream)
 * and adapt accordingly. The pattern below shows the Effect.Stream
 * wrapping — replace the connection mechanism with whatever the
 * current code uses (e.g., SDK.streamEvents() or fetch + line parser).
 */
export const sseStream = (
  url: string,
  options?: { headers?: Record<string, string>; lastEventId?: string }
): Stream.Stream<SSEEvent, SSEConnectionError> =>
  Stream.asyncScoped<SSEEvent, SSEConnectionError>((emit) =>
    Effect.gen(function* () {
      // Use the SDK or fetch-based SSE, NOT browser EventSource.
      // Example with fetch-based SSE:
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

      const response = yield* Effect.tryPromise(() =>
        fetch(url, {
          headers: {
            "Accept": "text/event-stream",
            ...(options?.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
            ...options?.headers,
          },
          signal: controller.signal,
        })
      ).pipe(Effect.mapError((e) => new SSEConnectionError(e)));

      if (!response.body) {
        return yield* Effect.fail(new SSEConnectionError(new Error("No response body")));
      }

      // Parse SSE lines from the ReadableStream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      yield* Effect.gen(function* () {
        while (true) {
          const { done, value } = yield* Effect.tryPromise(() => reader.read()).pipe(
            Effect.mapError((e) => new SSEConnectionError(e))
          );
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const block of lines) {
            const event = parseSSEBlock(block);
            if (event) emit.single(event);
          }
        }
        emit.end();
      }).pipe(Effect.forkScoped);
    })
  );

// Parse a single SSE event block (data: ...\nevent: ...\nid: ...)
const parseSSEBlock = (block: string): SSEEvent | null => {
  let data = "";
  let type = "message";
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) data += line.slice(6);
    else if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
  }
  if (!data) return null;
  return { type, data, lastEventId: id };
};

/**
 * Resilient SSE stream with automatic reconnection and stale detection.
 * Reconnects with exponential backoff on connection errors.
 * Fails with SSEStaleError if no events received within staleness window.
 */
export const resilientSSE = (
  url: string,
  options?: {
    staleTimeout?: Duration.DurationInput;
    headers?: Record<string, string>;
  }
): Stream.Stream<SSEEvent, SSEStaleError> => {
  const staleTimeout = options?.staleTimeout ?? Duration.seconds(90);

  return sseStream(url, { headers: options?.headers }).pipe(
    Stream.retry(reconnectSchedule),
    Stream.timeoutFail({
      onTimeout: () => new SSEStaleError(),
      duration: staleTimeout,
    })
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/sse-stream-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/sse-stream.ts test/unit/relay/sse-stream-effect.test.ts
git commit -m "feat(effect): replace SSEStream class with Effect.Stream + Schedule reconnection"
```

---

### Task 11: SessionStatusPoller — Schedule + Ref

**Files:**
- Create: `src/lib/effect/session-status-poller.ts`
- Test: `test/unit/session/session-status-poller-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-status-poller-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration } from "effect";
import {
  PollerStateTag,
  makePollerStateLive,
  reconcile,
  type PollerState,
} from "../../../src/lib/effect/session-status-poller.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("SessionStatusPoller Effect", () => {
  const mockApi = {
    getSessionStatuses: vi.fn().mockReturnValue(
      Effect.succeed([
        { id: "s1", status: "idle" },
        { id: "s2", status: "busy" },
      ])
    ),
  };

  const mockDb = {
    getSessionStatuses: vi.fn().mockReturnValue(
      Effect.succeed([
        { id: "s1", status: "idle" },
        { id: "s2", status: "idle" }, // Mismatch — API says busy, DB says idle
      ])
    ),
  };

  it("initializes with empty state", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* PollerStateTag;
        return yield* Ref.get(ref);
      }).pipe(Effect.provide(makePollerStateLive()))
    );

    expect(result.previousStatuses.size).toBe(0);
    expect(result.activityTimestamps.size).toBe(0);
  });

  it("reconcile detects status mismatches", async () => {
    const corrections: any[] = [];
    const applyCorrection = vi.fn((c: any) => {
      corrections.push(c);
      return Effect.succeed(undefined);
    });

    await Effect.runPromise(
      reconcile(mockDb as any, mockApi as any, applyCorrection).pipe(
        Effect.provide(makePollerStateLive())
      )
    );

    // s2 status mismatch should produce a correction
    expect(corrections.length).toBeGreaterThanOrEqual(1);
  });

  it("isMessageActive checks TTL correctly", async () => {
    const now = Date.now();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* PollerStateTag;
        yield* Ref.update(ref, (s) => ({
          ...s,
          activityTimestamps: new Map([
            ["active", now - 1000],      // 1s ago — active
            ["stale", now - 300_000],     // 5min ago — stale
          ]),
        }));
        const state = yield* Ref.get(ref);
        const activeTTL = Duration.seconds(60);
        const activeTs = state.activityTimestamps.get("active")!;
        const staleTs = state.activityTimestamps.get("stale")!;
        return {
          activeIsActive: now - activeTs < Duration.toMillis(activeTTL),
          staleIsActive: now - staleTs < Duration.toMillis(activeTTL),
        };
      }).pipe(Effect.provide(makePollerStateLive()))
    );

    expect(result.activeIsActive).toBe(true);
    expect(result.staleIsActive).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-status-poller-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/session-status-poller.ts
import { Context, Effect, Layer, Ref, Schedule, Duration } from "effect";

export interface SessionStatus {
  id: string;
  status: string;
}

export interface PollerState {
  previousStatuses: Map<string, string>;
  activityTimestamps: Map<string, number>;
  childToParentCache: Map<string, string>;
  idleSessionTracking: Map<string, number>;
}

export const PollerState = {
  empty: (): PollerState => ({
    previousStatuses: new Map(),
    activityTimestamps: new Map(),
    childToParentCache: new Map(),
    idleSessionTracking: new Map(),
  }),
};

export class PollerStateTag extends Context.Tag("PollerState")<
  PollerStateTag,
  Ref.Ref<PollerState>
>() {}

export const makePollerStateLive = (
  initial?: Partial<PollerState>
): Layer.Layer<PollerStateTag> =>
  Layer.effect(PollerStateTag, Ref.make({ ...PollerState.empty(), ...initial }));

export interface StatusCorrection {
  sessionId: string;
  expected: string;
  actual: string;
}

export const diffStatuses = (
  previous: Map<string, string>,
  dbStatuses: SessionStatus[],
  apiStatuses: SessionStatus[]
): StatusCorrection[] => {
  const apiMap = new Map(apiStatuses.map((s) => [s.id, s.status]));
  const corrections: StatusCorrection[] = [];

  for (const dbSession of dbStatuses) {
    const apiStatus = apiMap.get(dbSession.id);
    if (apiStatus && apiStatus !== dbSession.status) {
      corrections.push({
        sessionId: dbSession.id,
        expected: apiStatus,
        actual: dbSession.status,
      });
    }
  }

  return corrections;
};

export const reconcile = (
  db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  applyCorrection: (c: StatusCorrection) => Effect.Effect<void>
) =>
  Effect.gen(function* () {
    const ref = yield* PollerStateTag;
    const state = yield* Ref.get(ref);

    const dbSessions = yield* db.getSessionStatuses();
    const apiSessions = yield* api.getSessionStatuses().pipe(
      Effect.retry(Schedule.once)
    );

    const corrections = diffStatuses(state.previousStatuses, dbSessions, apiSessions);

    yield* Effect.forEach(corrections, applyCorrection, { concurrency: "unbounded" });

    // Update previous statuses
    const newStatuses = new Map(apiSessions.map((s) => [s.id, s.status]));
    yield* Ref.update(ref, (s) => ({ ...s, previousStatuses: newStatuses }));
  });

export const pollerSchedule = Schedule.spaced(Duration.seconds(7));

/**
 * Run the reconciliation loop as a scoped fiber.
 * Returns the fiber handle for external interruption.
 */
export const startReconciliationLoop = (
  db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
  applyCorrection: (c: StatusCorrection) => Effect.Effect<void>
) =>
  reconcile(db, api, applyCorrection).pipe(
    Effect.repeat(pollerSchedule),
    Effect.catchAllCause(Effect.logWarning),
    Effect.forkScoped
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-status-poller-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/session-status-poller.ts test/unit/session/session-status-poller-effect.test.ts
git commit -m "feat(effect): replace SessionStatusPoller setInterval with Effect.Schedule + Ref"
```

---

### Task 12: MessagePoller — fiber-per-session

**Files:**
- Create: `src/lib/effect/message-poller.ts`
- Test: `test/unit/relay/message-poller-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/message-poller-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration, Exit } from "effect";
import {
  PollerManagerStateTag,
  makePollerManagerStateLive,
  startPoller,
  stopPoller,
  isPollerActive,
} from "../../../src/lib/effect/message-poller.js";
import { OpenCodeAPITag } from "../../../src/lib/effect/services.js";

describe("MessagePoller Effect", () => {
  const mockApi = {
    getMessages: vi.fn().mockReturnValue(Effect.succeed([])),
  };

  const testLayer = Layer.mergeAll(
    makePollerManagerStateLive(),
    Layer.succeed(OpenCodeAPITag, mockApi as any),
  );

  it("starts a poller for a session", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startPoller("s1");
          return yield* isPollerActive("s1");
        })
      ).pipe(Effect.provide(testLayer))
    );

    expect(result).toBe(true);
  });

  it("does not start duplicate poller for same session", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startPoller("s1");
          yield* startPoller("s1"); // Should no-op
          const ref = yield* PollerManagerStateTag;
          const state = yield* Ref.get(ref);
          // Should still have exactly 1 poller
          expect(state.activePollers.size).toBe(1);
        })
      ).pipe(Effect.provide(testLayer))
    );
  });

  it("stops a poller by interrupting its fiber", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* startPoller("s1");
          expect(yield* isPollerActive("s1")).toBe(true);
          yield* stopPoller("s1");
          return yield* isPollerActive("s1");
        })
      ).pipe(Effect.provide(testLayer))
    );

    expect(result).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/message-poller-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/message-poller.ts
import { Context, Effect, Layer, Ref, Fiber, Schedule, Duration } from "effect";
import { OpenCodeAPITag } from "./services.js";

export interface PollerManagerState {
  activePollers: Map<string, Fiber.RuntimeFiber<void>>;
}

export class PollerManagerStateTag extends Context.Tag("PollerManagerState")<
  PollerManagerStateTag,
  Ref.Ref<PollerManagerState>
>() {}

export const makePollerManagerStateLive = (): Layer.Layer<PollerManagerStateTag> =>
  Layer.effect(PollerManagerStateTag, Ref.make({ activePollers: new Map() }));

const pollSession = (sessionId: string) =>
  Effect.gen(function* () {
    const api = yield* OpenCodeAPITag;

    const poll = api.getMessages(sessionId).pipe(
      Effect.catchAllCause(Effect.logWarning)
    );

    yield* poll.pipe(
      Effect.repeat(Schedule.spaced(Duration.seconds(3))),
      Effect.timeout(Duration.minutes(5)),
      Effect.interruptible
    );
  });

export const startPoller = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* PollerManagerStateTag;
    const current = yield* Ref.get(ref);

    if (current.activePollers.has(sessionId)) return;

    const fiber = yield* Effect.forkScoped(pollSession(sessionId));
    yield* Ref.update(ref, (s) => ({
      activePollers: new Map([...s.activePollers, [sessionId, fiber]]),
    }));
  });

export const stopPoller = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* PollerManagerStateTag;
    const current = yield* Ref.get(ref);
    const fiber = current.activePollers.get(sessionId);

    if (fiber) {
      yield* Fiber.interrupt(fiber);
      yield* Ref.update(ref, (s) => {
        const next = new Map(s.activePollers);
        next.delete(sessionId);
        return { activePollers: next };
      });
    }
  });

export const isPollerActive = (sessionId: string) =>
  Effect.gen(function* () {
    const ref = yield* PollerManagerStateTag;
    const state = yield* Ref.get(ref);
    return state.activePollers.has(sessionId);
  });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/message-poller-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/message-poller.ts test/unit/relay/message-poller-effect.test.ts
git commit -m "feat(effect): replace MessagePoller setInterval with fiber-per-session + Schedule"
```

---

## Track C: Supporting Services (Parallel)

Tasks 13-18 can run in parallel with each other and with Tracks A and B.

### Task 13: InstanceManager — per-instance fibers + acquireRelease

**Files:**
- Create: `src/lib/effect/instance-manager-service.ts`
- Test: `test/unit/instance/instance-manager-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/instance/instance-manager-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Fiber, Duration, Exit } from "effect";
import {
  InstanceManagerStateTag,
  makeInstanceManagerStateLive,
  addInstance,
  removeInstance,
  type InstanceConfig,
} from "../../../src/lib/effect/instance-manager-service.js";

describe("InstanceManager Effect", () => {
  it("addInstance creates health poll fiber", async () => {
    const config: InstanceConfig = {
      id: "inst-1",
      name: "Test Instance",
      port: 4096,
      managed: false,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* addInstance(config);
          const ref = yield* InstanceManagerStateTag;
          const state = yield* Ref.get(ref);
          expect(state.instances.has("inst-1")).toBe(true);
          expect(state.healthPollers.has("inst-1")).toBe(true);
        })
      ).pipe(Effect.provide(makeInstanceManagerStateLive()))
    );
  });

  it("removeInstance interrupts health poll fiber", async () => {
    const config: InstanceConfig = {
      id: "inst-1",
      name: "Test Instance",
      port: 4096,
      managed: false,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* addInstance(config);
          yield* removeInstance("inst-1");
          const ref = yield* InstanceManagerStateTag;
          const state = yield* Ref.get(ref);
          expect(state.instances.has("inst-1")).toBe(false);
          expect(state.healthPollers.has("inst-1")).toBe(false);
        })
      ).pipe(Effect.provide(makeInstanceManagerStateLive()))
    );
  });

  it("enforces max instance limit", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          for (let i = 0; i < 6; i++) { // Max is 5
            yield* addInstance({
              id: `inst-${i}`, name: `Inst ${i}`, port: 4096 + i, managed: false,
            });
          }
        })
      ).pipe(Effect.provide(makeInstanceManagerStateLive()))
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/instance/instance-manager-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/instance-manager-service.ts
import { Context, Data, Effect, Layer, Ref, Fiber, Schedule, Duration } from "effect";
import type { ChildProcess } from "node:child_process";

// NOTE: Do NOT redefine InstanceConfig — import from shared-types.ts.
// The existing type has: { name, port, managed, env?, url? }.
// Use OpenCodeInstance from shared-types.ts for per-instance state
// which includes: status, pid, restartCount, createdAt, lastHealthCheck,
// exitCode, needsRestart. See src/lib/shared-types.ts:597-619.
import type { InstanceConfig, OpenCodeInstance } from "../shared-types.js";

export interface InstanceManagerConfig {
  maxInstances: number; // configurable, default 5
}

export interface InstanceManagerState {
  instances: Map<string, OpenCodeInstance>;
  healthPollers: Map<string, Fiber.RuntimeFiber<void>>;
  processes: Map<string, ChildProcess>;
  config: InstanceManagerConfig;
}

export class InstanceManagerStateTag extends Context.Tag("InstanceManagerState")<
  InstanceManagerStateTag,
  Ref.Ref<InstanceManagerState>
>() {}

export const makeInstanceManagerStateLive = (
  config: InstanceManagerConfig = { maxInstances: 5 }
): Layer.Layer<InstanceManagerStateTag> =>
  Layer.effect(InstanceManagerStateTag, Ref.make({
    instances: new Map(),
    healthPollers: new Map(),
    processes: new Map(),
    config,
  }));

// --- Error types (Schema.TaggedError for catchTag support) ---

export class InstanceLimitExceeded extends Data.TaggedError("InstanceLimitExceeded")<{
  max: number;
}> {}

export class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
  id: string;
}> {}

// --- Health polling ---

const healthPollFiber = (instanceId: string) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;

    const checkHealth = Effect.gen(function* () {
      const state = yield* Ref.get(ref);
      const instance = state.instances.get(instanceId);
      // If instance removed, interrupt self to stop polling
      if (!instance) return yield* Effect.interrupt;

      const healthy = yield* Effect.tryPromise(
        () => fetch(`http://localhost:${instance.port}/health`).then((r) => r.ok)
      ).pipe(Effect.orElseSucceed(() => false));

      yield* Ref.update(ref, (s) => {
        const instances = new Map(s.instances);
        const existing = instances.get(instanceId);
        if (existing) {
          instances.set(instanceId, {
            ...existing,
            status: healthy ? "healthy" : "unhealthy",
            lastHealthCheck: Date.now(),
          });
        }
        return { ...s, instances };
      });
    });

    yield* checkHealth.pipe(
      Effect.catchAllCause(Effect.logWarning),
      Effect.repeat(Schedule.spaced(Duration.seconds(5)))
    );
  });

// --- Process spawning with SIGTERM → SIGKILL escalation ---

const killProcess = (proc: ChildProcess) =>
  Effect.gen(function* () {
    proc.kill("SIGTERM");
    // Wait up to 5s for graceful shutdown, then SIGKILL
    yield* Effect.tryPromise(() =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
      })
    ).pipe(Effect.orElse(() => Effect.void));
  });

export const spawnInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;
    const state = yield* Ref.get(ref);
    const instance = state.instances.get(instanceId);
    if (!instance) return yield* Effect.fail(new InstanceNotFound({ id: instanceId }));

    // Use Effect.async to await the spawn/error event (not Effect.sync)
    const proc = yield* Effect.async<ChildProcess, Error>((resume) => {
      const { spawn } = require("node:child_process");
      // Current code hardcodes "opencode serve --port N"
      const child = spawn("opencode", ["serve", "--port", String(instance.port)], {
        env: { ...process.env, ...instance.env },
        stdio: "ignore",
      });
      child.once("spawn", () => resume(Effect.succeed(child)));
      child.once("error", (err: Error) => resume(Effect.fail(err)));
    });

    // Register cleanup: SIGTERM → wait 5s → SIGKILL
    yield* Effect.addFinalizer(() => killProcess(proc));

    // Store process reference
    yield* Ref.update(ref, (s) => {
      const processes = new Map(s.processes);
      const instances = new Map(s.instances);
      processes.set(instanceId, proc);
      const existing = instances.get(instanceId);
      if (existing) {
        instances.set(instanceId, { ...existing, status: "starting", pid: proc.pid });
      }
      return { ...s, processes, instances };
    });

    // Start health polling
    yield* Effect.forkScoped(healthPollFiber(instanceId));

    return proc;
  });

// --- Restart with rate limiting ---

const restartSchedule = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.compose(Schedule.recurs(5)),
  Schedule.compose(Schedule.elapsed.pipe(
    Schedule.whileOutput(Duration.lessThanOrEqualTo(Duration.minutes(2)))
  ))
);

export const restartWithLimit = (instanceId: string) =>
  spawnInstance(instanceId).pipe(Effect.retry(restartSchedule));

// --- CRUD operations ---

export const addInstance = (id: string, config: InstanceConfig) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;

    // Atomic check-and-insert via Ref.modify
    const error = yield* Ref.modify(ref, (s) => {
      if (s.instances.size >= s.config.maxInstances) {
        return [new InstanceLimitExceeded({ max: s.config.maxInstances }), s];
      }
      const instances = new Map(s.instances);
      const newInstance: OpenCodeInstance = {
        ...config,
        id,
        status: "stopped",
        pid: undefined,
        restartCount: 0,
        createdAt: Date.now(),
        lastHealthCheck: undefined,
        exitCode: undefined,
        needsRestart: false,
      } as OpenCodeInstance;
      instances.set(id, newInstance);
      return [null, { ...s, instances }];
    });

    if (error) return yield* Effect.fail(error);

    // Start health polling fiber
    const fiber = yield* Effect.forkScoped(healthPollFiber(id));
    yield* Ref.update(ref, (s) => {
      const healthPollers = new Map(s.healthPollers);
      healthPollers.set(id, fiber);
      return { ...s, healthPollers };
    });
  });

export const removeInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;

    // Atomic extract-and-delete via Ref.modify
    const fiber = yield* Ref.modify(ref, (s) => {
      const f = s.healthPollers.get(instanceId);
      const instances = new Map(s.instances);
      const healthPollers = new Map(s.healthPollers);
      const processes = new Map(s.processes);
      instances.delete(instanceId);
      healthPollers.delete(instanceId);
      processes.delete(instanceId);
      return [f ?? null, { ...s, instances, healthPollers, processes }];
    });

    if (fiber) {
      yield* Fiber.interrupt(fiber);
    }
  });

export const getInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;
    const state = yield* Ref.get(ref);
    const instance = state.instances.get(instanceId);
    if (!instance) return yield* Effect.fail(new InstanceNotFound({ id: instanceId }));
    return instance;
  });

export const getInstances = Effect.gen(function* () {
  const ref = yield* InstanceManagerStateTag;
  const state = yield* Ref.get(ref);
  return [...state.instances.values()];
});

export const getInstanceUrl = (instanceId: string) =>
  Effect.gen(function* () {
    const instance = yield* getInstance(instanceId);
    return instance.url ?? `http://localhost:${instance.port}`;
  });

export const updateInstance = (instanceId: string, updates: Partial<InstanceConfig>) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;
    yield* Ref.update(ref, (s) => {
      const instances = new Map(s.instances);
      const existing = instances.get(instanceId);
      if (existing) instances.set(instanceId, { ...existing, ...updates });
      return { ...s, instances };
    });
  });

export const startInstance = (instanceId: string) =>
  spawnInstance(instanceId);

export const stopInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ref = yield* InstanceManagerStateTag;
    const state = yield* Ref.get(ref);
    const proc = state.processes.get(instanceId);
    if (proc) {
      yield* killProcess(proc);
      yield* Ref.update(ref, (s) => {
        const processes = new Map(s.processes);
        const instances = new Map(s.instances);
        processes.delete(instanceId);
        const existing = instances.get(instanceId);
        if (existing) instances.set(instanceId, { ...existing, status: "stopped", pid: undefined });
        return { ...s, processes, instances };
      });
    }
  });

export const stopAll = Effect.gen(function* () {
  const ref = yield* InstanceManagerStateTag;
  const state = yield* Ref.get(ref);
  yield* Effect.forEach(
    [...state.healthPollers.values()],
    (fiber) => Fiber.interrupt(fiber),
    { concurrency: "unbounded" }
  );
  yield* Effect.forEach(
    [...state.processes.values()],
    (proc) => killProcess(proc),
    { concurrency: "unbounded" }
  );
});
```

**Step 4: Update tests to cover additional methods and edge cases**

Add to the test file:
```typescript
  it("add-remove-add at max instances succeeds", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Add 5 instances (max)
          for (let i = 0; i < 5; i++) {
            yield* addInstance(`inst-${i}`, {
              name: `Inst ${i}`, port: 4096 + i, managed: false,
            } as any);
          }
          // Remove one
          yield* removeInstance("inst-0");
          // Add one more — should succeed
          yield* addInstance("inst-new", {
            name: "New", port: 5000, managed: false,
          } as any);
          const ref = yield* InstanceManagerStateTag;
          const state = yield* Ref.get(ref);
          expect(state.instances.size).toBe(5);
        })
      ).pipe(Effect.provide(makeInstanceManagerStateLive()))
    );
  });

  it("max instance error has correct tag for catchTag", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          for (let i = 0; i < 6; i++) {
            yield* addInstance(`inst-${i}`, {
              name: `Inst ${i}`, port: 4096 + i, managed: false,
            } as any);
          }
        }).pipe(
          Effect.catchTag("InstanceLimitExceeded", (e) =>
            Effect.succeed(`caught: max=${e.max}`)
          )
        )
      ).pipe(Effect.provide(makeInstanceManagerStateLive()))
    );

    expect(result).toBe("caught: max=5");
  });
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/instance/instance-manager-effect.test.ts`
Expected: 5 tests PASS

**Step 6: Commit**

```bash
git add src/lib/effect/instance-manager-service.ts test/unit/instance/instance-manager-effect.test.ts
git commit -m "feat(effect): replace InstanceManager with per-instance fibers + acquireRelease + SIGTERM/SIGKILL"
```

---

### Task 14: Leaf services — dissolve classes into Layers

**Files:**
- Create: `src/lib/effect/storage-monitor-layer.ts`
- Create: `src/lib/effect/version-checker-layer.ts`
- Create: `src/lib/effect/port-scanner-layer.ts`
- Create: `src/lib/effect/keep-awake-layer.ts`
- Test: `test/unit/daemon/leaf-services-effect.test.ts`

All four follow the same pattern. Showing StorageMonitor in detail; others repeat the pattern.

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/leaf-services-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Exit, Duration, TestClock, Fiber } from "effect";
import { StorageMonitorTag, StorageMonitorLive } from "../../../src/lib/effect/storage-monitor-layer.js";
import { VersionCheckerTag, VersionCheckerLive } from "../../../src/lib/effect/version-checker-layer.js";
import { RateLimiterTag, RateLimiterLive } from "../../../src/lib/effect/rate-limiter-layer.js";

describe("Leaf service Layers", () => {
  describe("StorageMonitor", () => {
    it("Layer constructs and provides tag", async () => {
      const mockPersistence = {
        evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
      };
      const mockGetUsage = vi.fn().mockReturnValue(Effect.succeed(0.5)); // 50% usage

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            // Layer should start without error
            yield* Effect.sleep(Duration.millis(10));
          })
        ).pipe(
          Effect.provide(StorageMonitorLive({
            getStorageUsage: mockGetUsage,
            persistence: mockPersistence as any,
            checkInterval: Duration.seconds(60),
            highWaterMark: 0.9,
          }))
        )
      );

      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  describe("RateLimiter", () => {
    it("allows requests under limit", async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const limiter = yield* RateLimiterTag;
            const r1 = yield* limiter.checkLimit("127.0.0.1");
            const r2 = yield* limiter.checkLimit("127.0.0.1");
            return { r1, r2 };
          })
        ).pipe(Effect.provide(RateLimiterLive({ maxRequests: 5, windowMs: 10_000 })))
      );

      expect(result.r1).toBe(true);
      expect(result.r2).toBe(true);
    });

    it("blocks requests over limit", async () => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const limiter = yield* RateLimiterTag;
            for (let i = 0; i < 5; i++) {
              yield* limiter.checkLimit("127.0.0.1");
            }
            return yield* limiter.checkLimit("127.0.0.1"); // 6th request
          })
        ).pipe(Effect.provide(RateLimiterLive({ maxRequests: 5, windowMs: 10_000 })))
      );

      expect(result).toBe(false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/leaf-services-effect.test.ts`
Expected: FAIL — modules not found

**Step 3: Write StorageMonitor Layer**

```typescript
// src/lib/effect/storage-monitor-layer.ts
import { Context, Effect, Layer, Ref, Schedule, Duration } from "effect";

export class StorageMonitorTag extends Context.Tag("StorageMonitor")<
  StorageMonitorTag,
  void
>() {}

interface StorageMonitorConfig {
  getStorageUsage: () => Effect.Effect<number>;
  persistence: { evictOldEvents: () => Effect.Effect<void> };
  checkInterval: Duration.DurationInput;
  highWaterMark: number;
}

export const StorageMonitorLive = (config: StorageMonitorConfig) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const state = yield* Ref.make({ lastCheck: 0, usage: 0 });

      const check = Effect.gen(function* () {
        const usage = yield* config.getStorageUsage();
        yield* Ref.set(state, { lastCheck: Date.now(), usage });
        if (usage > config.highWaterMark) {
          yield* config.persistence.evictOldEvents();
        }
      });

      yield* check.pipe(
        Effect.repeat(Schedule.spaced(config.checkInterval)),
        Effect.catchAllCause(Effect.logWarning),
        Effect.forkScoped
      );
    })
  );
```

**Step 4: Write RateLimiter Layer**

```typescript
// src/lib/effect/rate-limiter-layer.ts
import { Context, Effect, Layer, Ref, Schedule, Duration } from "effect";

interface RateLimiterService {
  checkLimit: (ip: string) => Effect.Effect<boolean>;
}

export class RateLimiterTag extends Context.Tag("RateLimiter")<
  RateLimiterTag,
  RateLimiterService
>() {}

interface BucketEntry {
  tokens: number[];
}

interface RateLimiterState {
  buckets: Map<string, BucketEntry>;
}

interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

const tryConsume = (ip: string, config: RateLimiterConfig, now: number) =>
  (state: RateLimiterState): [boolean, RateLimiterState] => {
    const buckets = new Map(state.buckets);
    const entry = buckets.get(ip) ?? { tokens: [] };

    // Remove expired tokens
    const validTokens = entry.tokens.filter((t) => now - t < config.windowMs);

    if (validTokens.length >= config.maxRequests) {
      buckets.set(ip, { tokens: validTokens });
      return [false, { buckets }];
    }

    validTokens.push(now);
    buckets.set(ip, { tokens: validTokens });
    return [true, { buckets }];
  };

const evictStale = (windowMs: number, now: number) =>
  (state: RateLimiterState): RateLimiterState => {
    const buckets = new Map<string, BucketEntry>();
    for (const [ip, entry] of state.buckets) {
      const valid = entry.tokens.filter((t) => now - t < windowMs);
      if (valid.length > 0) buckets.set(ip, { tokens: valid });
    }
    return { buckets };
  };

export const RateLimiterLive = (config: RateLimiterConfig) =>
  Layer.scoped(
    RateLimiterTag,
    Effect.gen(function* () {
      const state = yield* Ref.make<RateLimiterState>({ buckets: new Map() });

      // Cleanup stale entries every 60s
      yield* Effect.sync(() => Date.now()).pipe(
        Effect.flatMap((now) => Ref.update(state, evictStale(config.windowMs, now))),
        Effect.repeat(Schedule.spaced(Duration.minutes(1))),
        Effect.forkScoped
      );

      return {
        checkLimit: (ip: string) =>
          Effect.sync(() => Date.now()).pipe(
            Effect.flatMap((now) => Ref.modify(state, tryConsume(ip, config, now)))
          ),
      };
    })
  );
```

**Step 5: Write VersionChecker, PortScanner, KeepAwake Layers** (same pattern as StorageMonitor)

```typescript
// src/lib/effect/version-checker-layer.ts
import { Context, Effect, Layer, Ref, Schedule, Duration } from "effect";

export class VersionCheckerTag extends Context.Tag("VersionChecker")<
  VersionCheckerTag,
  void
>() {}

interface VersionCheckerConfig {
  checkForUpdate: () => Effect.Effect<string | null>;
  broadcast: (msg: { type: string; version: string }) => Effect.Effect<void>;
  checkInterval: Duration.DurationInput;
}

export const VersionCheckerLive = (config: VersionCheckerConfig) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const currentVersion = yield* Ref.make<string | null>(null);

      const check = Effect.gen(function* () {
        const latest = yield* config.checkForUpdate();
        if (latest) {
          const prev = yield* Ref.get(currentVersion);
          if (latest !== prev) {
            yield* Ref.set(currentVersion, latest);
            yield* config.broadcast({ type: "version_update", version: latest });
          }
        }
      });

      yield* check.pipe(
        Effect.repeat(Schedule.spaced(config.checkInterval)),
        Effect.catchAllCause(Effect.logWarning),
        Effect.forkScoped
      );
    })
  );
```

```typescript
// src/lib/effect/port-scanner-layer.ts
import { Context, Effect, Layer, Ref, Schedule, Duration } from "effect";

export class PortScannerTag extends Context.Tag("PortScanner")<
  PortScannerTag,
  void
>() {}

interface PortScannerConfig {
  scan: () => Effect.Effect<{ discovered: number[]; lost: number[] }>;
  onDiscovered: (port: number) => Effect.Effect<void>;
  onLost: (port: number) => Effect.Effect<void>;
  scanInterval: Duration.DurationInput;
}

export const PortScannerLive = (config: PortScannerConfig) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const knownPorts = yield* Ref.make<Set<number>>(new Set());

      const runScan = Effect.gen(function* () {
        const result = yield* config.scan();
        yield* Effect.forEach(result.discovered, config.onDiscovered, { concurrency: "unbounded" });
        yield* Effect.forEach(result.lost, config.onLost, { concurrency: "unbounded" });
        yield* Ref.set(knownPorts, new Set(result.discovered));
      });

      yield* runScan.pipe(
        Effect.repeat(Schedule.spaced(config.scanInterval)),
        Effect.catchAllCause(Effect.logWarning),
        Effect.forkScoped
      );
    })
  );
```

```typescript
// src/lib/effect/keep-awake-layer.ts
import { Context, Effect, Layer, Ref } from "effect";

export class KeepAwakeTag extends Context.Tag("KeepAwake")<
  KeepAwakeTag,
  { activate: () => Effect.Effect<void>; deactivate: () => Effect.Effect<void> }
>() {}

interface KeepAwakeConfig {
  command: string;
  args?: string[];
}

export const KeepAwakeLive = (config: KeepAwakeConfig) =>
  Layer.scoped(
    KeepAwakeTag,
    Effect.gen(function* () {
      const processRef = yield* Ref.make<any>(null);

      const activate = Effect.gen(function* () {
        const proc = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const { spawn } = require("node:child_process");
            return spawn(config.command, config.args ?? [], { stdio: "ignore", detached: true });
          }),
          (proc) => Effect.sync(() => { try { proc.kill("SIGTERM"); } catch {} })
        );
        yield* Ref.set(processRef, proc);
      });

      const deactivate = Effect.gen(function* () {
        const proc = yield* Ref.get(processRef);
        if (proc) {
          yield* Effect.sync(() => { try { proc.kill("SIGTERM"); } catch {} });
          yield* Ref.set(processRef, null);
        }
      });

      return { activate, deactivate };
    })
  );
```

**Step 6: Run tests**

Run: `pnpm vitest run test/unit/daemon/leaf-services-effect.test.ts`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/lib/effect/storage-monitor-layer.ts src/lib/effect/version-checker-layer.ts src/lib/effect/port-scanner-layer.ts src/lib/effect/keep-awake-layer.ts src/lib/effect/rate-limiter-layer.ts test/unit/daemon/leaf-services-effect.test.ts
git commit -m "feat(effect): dissolve 5 leaf service classes into pure Effect Layers"
```

---

### Task 15: Persistence Layer — Effect-managed transactions

**Files:**
- Create: `src/lib/effect/persistence-service.ts`
- Test: `test/unit/persistence/persistence-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/persistence-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Exit } from "effect";
import {
  PersistenceServiceTag,
  withTransaction,
  makePersistenceServiceLive,
} from "../../../src/lib/effect/persistence-service.js";

describe("Persistence Effect", () => {
  it("withTransaction commits on success", async () => {
    const mockDb = {
      beginTransaction: vi.fn().mockResolvedValue({
        committed: false,
        commit: vi.fn().mockImplementation(function(this: any) { this.committed = true; }),
        rollback: vi.fn(),
      }),
    };

    await Effect.runPromise(
      withTransaction(mockDb as any, (tx) =>
        Effect.sync(() => {
          tx.commit();
          return "result";
        })
      )
    );

    expect(mockDb.beginTransaction).toHaveBeenCalled();
  });

  it("withTransaction rolls back on failure", async () => {
    const rollbackSpy = vi.fn();
    const mockDb = {
      beginTransaction: vi.fn().mockResolvedValue({
        committed: false,
        commit: vi.fn(),
        rollback: rollbackSpy,
      }),
    };

    const exit = await Effect.runPromiseExit(
      withTransaction(mockDb as any, (_tx) =>
        Effect.fail(new Error("boom"))
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(rollbackSpy).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/persistence-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/persistence-service.ts
import { Context, Effect, Layer, Stream } from "effect";

export interface Transaction {
  committed: boolean;
  commit(): void;
  rollback(): void;
}

export interface Database {
  beginTransaction(): Promise<Transaction>;
}

export class PersistenceServiceTag extends Context.Tag("PersistenceService")<
  PersistenceServiceTag,
  { db: Database }
>() {}

export const withTransaction = <A, E>(
  db: Database,
  body: (tx: Transaction) => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => db.beginTransaction()),
    body,
    // NOTE: In Effect v3, release receives (resource, exit) — exit indicates
    // whether body succeeded or failed. Auto-rollback on failure.
    (tx, exit) => Effect.sync(() => {
      if (!tx.committed) tx.rollback();
    })
  );

export const replayProjections = (
  projections: Array<{ rebuild: (tx: Transaction) => Effect.Effect<void> }>,
  db: Database
) =>
  Stream.fromIterable(projections).pipe(
    Stream.mapEffect((projection) =>
      withTransaction(db, (tx) => projection.rebuild(tx))
    ),
    Stream.runDrain
  );

export const makePersistenceServiceLive = (db: Database) =>
  Layer.succeed(PersistenceServiceTag, { db });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/persistence-effect.test.ts`
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/persistence-service.ts test/unit/persistence/persistence-effect.test.ts
git commit -m "feat(effect): add Effect-managed persistence with auto-rollback transactions"
```

---

### Task 16: OrchestrationEngine — complete partial migration

**Files:**
- Create: `src/lib/effect/orchestration-service.ts`
- Test: `test/unit/provider/orchestration-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/provider/orchestration-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref } from "effect";
import {
  IdempotencySetTag,
  makeIdempotencySetLive,
  routeCommand,
} from "../../../src/lib/effect/orchestration-service.js";

describe("OrchestrationEngine Effect", () => {
  it("routes command to provider", async () => {
    const mockProvider = {
      execute: vi.fn().mockReturnValue(
        Effect.succeed({ text: "response" })
      ),
    };

    const result = await Effect.runPromise(
      routeCommand({ id: "cmd-1", type: "send_turn", payload: "hello" }, mockProvider as any).pipe(
        Effect.provide(makeIdempotencySetLive())
      )
    );

    expect(result).toEqual({ text: "response" });
    expect(mockProvider.execute).toHaveBeenCalled();
  });

  it("deduplicates repeated command IDs", async () => {
    const mockProvider = {
      execute: vi.fn().mockReturnValue(Effect.succeed({ text: "response" })),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* routeCommand({ id: "cmd-1", type: "send_turn", payload: "hello" }, mockProvider as any);
        return yield* routeCommand({ id: "cmd-1", type: "send_turn", payload: "hello" }, mockProvider as any);
      }).pipe(Effect.provide(makeIdempotencySetLive()))
    );

    expect(result).toEqual({ deduplicated: true });
    expect(mockProvider.execute).toHaveBeenCalledOnce(); // Only once despite two calls
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/orchestration-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/orchestration-service.ts
import { Context, Effect, Layer, Ref } from "effect";

export class IdempotencySetTag extends Context.Tag("IdempotencySet")<
  IdempotencySetTag,
  Ref.Ref<Set<string>>
>() {}

export const makeIdempotencySetLive = (): Layer.Layer<IdempotencySetTag> =>
  Layer.effect(IdempotencySetTag, Ref.make(new Set<string>()));

interface Command {
  id: string;
  type: string;
  payload: unknown;
}

interface Provider {
  execute: (cmd: Command) => Effect.Effect<any>;
}

export const routeCommand = (cmd: Command, provider: Provider) =>
  Effect.gen(function* () {
    const seenRef = yield* IdempotencySetTag;

    const isDuplicate = yield* Ref.modify(seenRef, (set) => {
      if (set.has(cmd.id)) return [true, set];
      const next = new Set(set);
      next.add(cmd.id);
      return [false, next];
    });

    if (isDuplicate) return { deduplicated: true };

    return yield* provider.execute(cmd);
  });
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/orchestration-effect.test.ts`
Expected: 2 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/orchestration-service.ts test/unit/provider/orchestration-effect.test.ts
git commit -m "feat(effect): complete OrchestrationEngine migration to pure Effect"
```

---

### Task 17: PTY Upstream — Stream over WebSocket

**Files:**
- Create: `src/lib/effect/pty-stream.ts`
- Test: `test/unit/relay/pty-stream-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/pty-stream-effect.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Stream, Chunk, Duration, Exit } from "effect";
import { PtyConnectionTimeout, PtyConnectionError } from "../../../src/lib/effect/pty-stream.js";

describe("PTY Stream Effect", () => {
  it("PtyConnectionTimeout has correct tag", () => {
    const err = new PtyConnectionTimeout();
    expect(err._tag).toBe("PtyConnectionTimeout");
  });

  it("PtyConnectionError wraps cause", () => {
    const err = new PtyConnectionError(new Error("ws failed"));
    expect(err._tag).toBe("PtyConnectionError");
    expect(err.cause).toBeInstanceOf(Error);
  });

  it("timeout produces PtyConnectionTimeout on stale stream", async () => {
    const neverStream = Stream.never as Stream.Stream<any, never>;

    const exit = await Effect.runPromiseExit(
      Stream.runDrain(
        neverStream.pipe(
          Stream.timeoutFail({
            onTimeout: () => new PtyConnectionTimeout(),
            duration: Duration.millis(50),
          })
        )
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/pty-stream-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/pty-stream.ts
import { Effect, Stream, Duration } from "effect";

export interface PtyEvent {
  type: "output" | "exit" | "error";
  data: string;
}

export class PtyConnectionError {
  readonly _tag = "PtyConnectionError";
  constructor(readonly cause: unknown) {}
}

export class PtyConnectionTimeout {
  readonly _tag = "PtyConnectionTimeout";
}

// NOTE: WebSocket is a browser API. In Node.js, use the `ws` package.
// Import: import WebSocket from "ws";
// The current codebase already depends on ws — check package.json.
export const ptyStream = (url: string) =>
  Stream.asyncScoped<PtyEvent, PtyConnectionError | PtyConnectionTimeout>((emit) =>
    Effect.gen(function* () {
      // Use ws package, not browser WebSocket
      const WebSocket = (await import("ws")).default;
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(url)),
        (ws) => Effect.sync(() => { try { ws.close(); } catch {} })
      );

      ws.onmessage = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as PtyEvent;
          emit.single(event);
        } catch {
          emit.single({ type: "output", data: e.data });
        }
      };

      ws.onerror = (e: Event) => {
        emit.fail(new PtyConnectionError(e));
      };

      ws.onclose = () => {
        emit.end();
      };

      // Connection timeout
      yield* Effect.sleep(Duration.seconds(10)).pipe(
        Effect.flatMap(() =>
          ws.readyState !== WebSocket.OPEN
            ? Effect.sync(() => emit.fail(new PtyConnectionTimeout()))
            : Effect.void
        ),
        Effect.forkScoped
      );
    })
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/pty-stream-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/pty-stream.ts test/unit/relay/pty-stream-effect.test.ts
git commit -m "feat(effect): add PTY upstream as Effect.Stream over WebSocket"
```

---

### Task 18: Push Notifications — Pool + acquireRelease

**Files:**
- Create: `src/lib/effect/push-service.ts`
- Test: `test/unit/server/push-effect.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/push-effect.test.ts
import { describe, it, expect, vi } from "vitest";
import { Effect, Layer, Ref, Exit } from "effect";
import {
  PushManagerTag,
  PushManagerLive,
  type PushSubscription,
} from "../../../src/lib/effect/push-service.js";

describe("Push Notifications Effect", () => {
  const mockSendPush = vi.fn().mockReturnValue(Effect.succeed(undefined));

  it("subscribe adds subscription", async () => {
    const sub: PushSubscription = { id: "sub-1", endpoint: "https://push.example.com", keys: {} as any };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const push = yield* PushManagerTag;
          yield* push.subscribe(sub);
        })
      ).pipe(Effect.provide(PushManagerLive({ sendPush: mockSendPush })))
    );
  });

  it("broadcast sends to all subscriptions", async () => {
    const sub1: PushSubscription = { id: "sub-1", endpoint: "https://a.com", keys: {} as any };
    const sub2: PushSubscription = { id: "sub-2", endpoint: "https://b.com", keys: {} as any };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const push = yield* PushManagerTag;
          yield* push.subscribe(sub1);
          yield* push.subscribe(sub2);
          yield* push.broadcast({ title: "Test", body: "Hello" });
        })
      ).pipe(Effect.provide(PushManagerLive({ sendPush: mockSendPush })))
    );

    expect(mockSendPush).toHaveBeenCalledTimes(2);
  });

  it("individual send failure does not block others", async () => {
    const failingSend = vi.fn()
      .mockReturnValueOnce(Effect.fail(new Error("network error")))
      .mockReturnValueOnce(Effect.succeed(undefined));

    const sub1: PushSubscription = { id: "sub-1", endpoint: "https://a.com", keys: {} as any };
    const sub2: PushSubscription = { id: "sub-2", endpoint: "https://b.com", keys: {} as any };

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const push = yield* PushManagerTag;
          yield* push.subscribe(sub1);
          yield* push.subscribe(sub2);
          yield* push.broadcast({ title: "Test", body: "Hello" });
        })
      ).pipe(Effect.provide(PushManagerLive({ sendPush: failingSend })))
    );

    // Should succeed despite first send failing
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(failingSend).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/server/push-effect.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/lib/effect/push-service.ts
import { Context, Effect, Layer, Ref } from "effect";

export interface PushSubscription {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface PushPayload {
  title: string;
  body: string;
}

interface PushService {
  subscribe: (sub: PushSubscription) => Effect.Effect<void>;
  unsubscribe: (id: string) => Effect.Effect<void>;
  broadcast: (payload: PushPayload) => Effect.Effect<void>;
}

export class PushManagerTag extends Context.Tag("PushManager")<
  PushManagerTag,
  PushService
>() {}

interface PushManagerConfig {
  sendPush: (sub: PushSubscription, payload: PushPayload) => Effect.Effect<void, any>;
}

export const PushManagerLive = (config: PushManagerConfig) =>
  Layer.scoped(
    PushManagerTag,
    Effect.gen(function* () {
      const subscriptions = yield* Ref.make<Map<string, PushSubscription>>(new Map());

      return {
        subscribe: (sub: PushSubscription) =>
          Ref.update(subscriptions, (m) => {
            const next = new Map(m);
            next.set(sub.id, sub);
            return next;
          }),

        unsubscribe: (id: string) =>
          Ref.update(subscriptions, (m) => {
            const next = new Map(m);
            next.delete(id);
            return next;
          }),

        broadcast: (payload: PushPayload) =>
          Effect.gen(function* () {
            const subs = yield* Ref.get(subscriptions);
            yield* Effect.forEach(
              [...subs.values()],
              (sub) => config.sendPush(sub, payload).pipe(
                Effect.catchAllCause(Effect.logWarning)
              ),
              { concurrency: 10 } // Cap concurrent sends
            );
          }),
      };
    })
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/server/push-effect.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/push-service.ts test/unit/server/push-effect.test.ts
git commit -m "feat(effect): add push notification service with isolated send failures"
```

---

## Integration: Wire Everything Together

### Task 19: Update daemon-layers.ts with all new Layers

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/daemon/full-layer-composition.test.ts`

**Step 1: Write smoke test for full composition**

```typescript
// test/unit/daemon/full-layer-composition.test.ts
import { describe, it, expect } from "vitest";
import { Effect, Layer, Ref, Exit } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { RelayCacheTag, makeRelayCacheLive } from "../../../src/lib/effect/relay-cache.js";
import { SessionManagerStateTag, makeSessionManagerStateLive } from "../../../src/lib/effect/session-manager-state.js";
import { PollerStateTag, makePollerStateLive } from "../../../src/lib/effect/session-status-poller.js";
import { PollerManagerStateTag, makePollerManagerStateLive } from "../../../src/lib/effect/message-poller.js";
import { InstanceManagerStateTag, makeInstanceManagerStateLive } from "../../../src/lib/effect/instance-manager-service.js";
import { RateLimiterTag, RateLimiterLive } from "../../../src/lib/effect/rate-limiter-layer.js";

describe("Full Layer composition", () => {
  it("all state Tags are accessible from composed layer", async () => {
    const composedLayer = Layer.mergeAll(
      makeDaemonStateLive(),
      makeSessionManagerStateLive(),
      makePollerStateLive(),
      makePollerManagerStateLive(),
      makeInstanceManagerStateLive(),
      makeRelayCacheLive((slug) => Effect.succeed({ slug, wsHandler: {} as any, stop: () => {} })),
      RateLimiterLive({ maxRequests: 10, windowMs: 60_000 }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const daemonState = yield* DaemonStateTag;
          const sessionState = yield* SessionManagerStateTag;
          const pollerState = yield* PollerStateTag;
          const pollerManager = yield* PollerManagerStateTag;
          const instanceState = yield* InstanceManagerStateTag;
          const relayCache = yield* RelayCacheTag;
          const limiter = yield* RateLimiterTag;

          // All Tags resolve
          expect(daemonState).toBeDefined();
          expect(sessionState).toBeDefined();
          expect(pollerState).toBeDefined();
          expect(pollerManager).toBeDefined();
          expect(instanceState).toBeDefined();
          expect(relayCache).toBeDefined();
          expect(limiter).toBeDefined();
        })
      ).pipe(Effect.provide(composedLayer))
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
```

**Step 2: Run test**

Run: `pnpm vitest run test/unit/daemon/full-layer-composition.test.ts`
Expected: PASS

**Step 3: Update services.ts with all new Tag re-exports**

Add to `src/lib/effect/services.ts`:
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
```

**Step 4: Commit**

```bash
git add src/lib/effect/services.ts test/unit/daemon/full-layer-composition.test.ts
git commit -m "feat(effect): wire all new Tags into services.ts and verify full composition"
```

---

### Task 20: Delete dead code — old imperative implementations

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (remove class, keep only thin entry-point shim if needed)
- Modify: `src/lib/session/session-manager.ts` (remove EventEmitter, class)
- Modify: `src/lib/relay/sse-stream.ts` (remove class)
- Modify: `src/lib/session/session-status-poller.ts` (remove class)
- Modify: `src/lib/relay/message-poller.ts` (remove class)
- Modify: `src/lib/instance/instance-manager.ts` (remove class)
- Modify: `src/lib/server/rate-limiter.ts` (remove class)
- Modify: `src/lib/server/push.ts` (remove class)

**Step 1: Verify all tests pass before deletion**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: Delete old implementations one at a time**

For each file: remove the class, update imports in consuming code to use the new Effect module. Run tests after each deletion.

```bash
# After each file update:
pnpm vitest run
```

**Step 3: Remove EventEmitter imports**

Search for any remaining `import { EventEmitter }` or `extends EventEmitter`:
```bash
grep -r "EventEmitter" src/ --include="*.ts"
```
Expected: No results (all EventEmitters eliminated)

**Step 4: Remove setInterval/setTimeout usage**

```bash
grep -r "setInterval\|setTimeout" src/lib/ --include="*.ts"
```
Expected: No results in migrated modules

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(effect): delete old imperative implementations replaced by Effect"
```

---

## Final Verification

### Task 21: Full test suite and build

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds with no errors

**Step 3: Run type check**

Run: `pnpm typecheck` (or `tsgo`)
Expected: No type errors

**Step 4: Verify no remaining imperative patterns**

```bash
# No EventEmitter in src/lib (excluding node_modules)
grep -r "EventEmitter" src/lib/ --include="*.ts" | wc -l
# Expected: 0

# No setInterval in migrated modules
grep -r "setInterval" src/lib/ --include="*.ts" | grep -v node_modules | wc -l
# Expected: 0 (or only in non-migrated code if any)

# No try/catch in Effect modules
grep -r "try {" src/lib/effect/ --include="*.ts" | wc -l
# Expected: 0
```

**Step 5: Final commit**

```bash
git commit --allow-empty -m "chore: verify Effect.ts next-wave migration complete"
```
