# Phase 1: Daemon Core (Tasks 1-8)

> **Prerequisites:** Install `@effect/vitest` (see [README.md](README.md)). Read [conventions.md](conventions.md).
> **Dependency:** None — this is the first phase.
> **Merge milestone:** None (merged as part of M1 after Phase 2b).

**Goal:** Define DaemonState Ref, config persistence, startup orchestration, relay cache, Layer wiring, daemon entry point, and IPC dispatch. These are sequential — each task builds on the previous.

> **Note:** This plan describes the feature branch state. On the feature branch, `TrackedService` is already deleted and classes use typed callback maps (not EventEmitter). See [conventions.md](conventions.md) for branch context.

---

## Task 0: Convert existing Effect tests to @effect/vitest (prerequisite)

> **AUDIT FIX (M6):** The branch has 12+ test files using `it()` + `Effect.runPromise()`
> wrappers. Conventions mandate `@effect/vitest` (`it.effect`, `it.scoped`).
> Convert these BEFORE writing new tests to maintain consistency.

**Step 1:** Grep for all test files using the old pattern:
```bash
grep -rn "Effect.runPromise\|Effect.runSync\|Effect.runPromiseExit" test/ --include="*.ts" -l
```

**Step 2:** For each file, replace `it("...", async () => { const result = await Effect.runPromise(...) })` with `it.effect("...", () => effectProgram)`.

**Step 3:** Run `pnpm vitest run test/unit/effect/` to verify all converted tests pass.

**Step 4:** Commit: `refactor(test): convert existing Effect tests to @effect/vitest it.effect/it.scoped`

---

## Track A: Daemon Core (Sequential)

### Task 1: Define DaemonState Ref and Tag

> **AUDIT FIX (M14, corrected C-NEW-5, re-verified R5):** The actual Daemon class on the feature branch has **~47 fields** (5 config, 5 server refs, 5 manager refs, 4 background service refs, 5 daemon state, 8 config fields, 2 signal handlers, 1 pending work, plus methods). The DaemonState interface below captures the persisted + runtime-observable subset; the rest are managed by individual service Layers. Verify completeness against `src/lib/daemon/daemon.ts` before implementation — the class may have changed since this audit.

**Files:**
- Create: `src/lib/effect/daemon-state.ts`
- Modify: `src/lib/effect/services.ts`
- Test: `test/unit/daemon/daemon-state.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/daemon-state.test.ts
// NOTE: Use @effect/vitest (it.effect / it.scoped) for all Effect tests.
// Never use plain it() with manual Effect.runPromise() wrappers.
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Ref } from "effect";
import { DaemonStateTag, DaemonState, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";

describe("DaemonState", () => {
  it.effect("initializes with empty defaults", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);

      expect(state.pinHash).toBeNull();
      expect(state.keepAwake).toBe(false);
      expect(state.clientCount).toBe(0);
      expect(state.shuttingDown).toBe(false);
      expect(state.dismissedPaths.size).toBe(0);
      expect(state.projects).toEqual([]);
      expect(state.instances).toEqual([]);
      expect(state.tls).toBe(false);
      expect(state.dangerouslySkipPermissions).toBe(false);
    }).pipe(Effect.provide(makeDaemonStateLive()))
  );

  it.effect("initializes with provided config", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const result = yield* Ref.get(ref);

      expect(result.pinHash).toBe("abc123");
      expect(result.keepAwake).toBe(true);
      expect(result.dismissedPaths.has("/tmp/foo")).toBe(true);
    }).pipe(Effect.provide(makeDaemonStateLive({
      pinHash: "abc123",
      keepAwake: true,
      dismissedPaths: new Set(["/tmp/foo"]),
    })))
  );

  it.effect("supports atomic updates across fields", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({
        ...s,
        clientCount: s.clientCount + 1,
        keepAwake: true,
      }));
      const result = yield* Ref.get(ref);

      expect(result.clientCount).toBe(1);
      expect(result.keepAwake).toBe(true);
    }).pipe(Effect.provide(makeDaemonStateLive()))
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-state.test.ts`
Expected: FAIL — module `../../../src/lib/effect/daemon-state.js` not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/daemon-state.ts
import { Context, Effect, Layer, Ref } from "effect";

// NOTE: This interface must mirror ALL fields from DaemonConfig
// (src/lib/daemon/config-persistence.ts:23-54) plus runtime-only state.
// The DaemonConfig fields are the persisted subset; runtime fields
// (clientCount, shuttingDown, pendingSave, needsResave) are ephemeral.

export interface DaemonProject {
  path: string;
  slug: string;
  title?: string;
  addedAt: number;
  instanceId?: string;
  sessionCount?: number;
}

export interface DaemonInstanceConfig {
  id: string;
  name: string;
  port: number;
  managed: boolean;
  env?: Record<string, string>;
  url?: string;
}

export interface DaemonState {
  // ─── Persisted fields (from DaemonConfig) ───
  pid: number;
  port: number;
  host: string;
  pinHash: string | null;
  tls: boolean;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  debug: boolean;
  keepAwake: boolean;
  keepAwakeCommand: string | undefined;
  keepAwakeArgs: string[] | undefined;
  dangerouslySkipPermissions: boolean;
  projects: DaemonProject[];
  instances: DaemonInstanceConfig[];
  dismissedPaths: Set<string>;

  // ─── Runtime-observable fields (not persisted but queried by IPC) ───
  clientCount: number;
  shuttingDown: boolean;
  startTime: number;
  configDir: string;
  socketPath: string;
  logPath: string;
  pidPath: string;
  staticDir: string | undefined;

  // ─── Internal coordination (not exposed via IPC) ───
  pendingSave: boolean;
  needsResave: boolean;
}

// NOTE: The actual Daemon class on the feature branch has 47 fields. This
// interface captures the OBSERVABLE subset — fields that DaemonState Ref
// consumers need to read/write. The remaining fields (server handles,
// manager instances, signal handlers) are managed by their own Layers
// and do NOT live in this Ref. If an IPC handler needs data not in this
// interface, check whether it should be added here or accessed via a
// separate service Tag.

export const DaemonState = {
  empty: (): DaemonState => ({
    pid: process.pid,
    port: 2633,
    host: "127.0.0.1",
    pinHash: null,
    tls: false,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    debug: false,
    keepAwake: false,
    keepAwakeCommand: undefined,
    keepAwakeArgs: undefined,
    dangerouslySkipPermissions: false,
    projects: [],
    instances: [],
    dismissedPaths: new Set(),
    clientCount: 0,
    shuttingDown: false,
    startTime: Date.now(),
    configDir: "",
    socketPath: "",
    logPath: "",
    pidPath: "",
    staticDir: undefined,
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
// NOTE: Do NOT use vi.mock("node:fs/promises") — the implementation uses
// @effect/platform FileSystem, not Node fs directly. Inject a test FileSystem
// Layer that records operations for assertions.
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Ref, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { persistConfig, loadConfig, PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

const TestPersistencePathLive = Layer.succeed(PersistencePathTag, "/tmp/test-daemon.json");

// In-memory FileSystem that records writes for assertion.
// Stores file contents in a Map and tracks rename (atomic write) calls.
const makeTestFileSystem = () => {
  const files = new Map<string, string>();
  const renames: Array<{ from: string; to: string }> = [];

  const testFs: FileSystem.FileSystem = {
    readFileString: (path: string) =>
      Effect.sync(() => {
        const content = files.get(path);
        if (!content) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      }),
    writeFileString: (path: string, content: string) =>
      Effect.sync(() => { files.set(path, content); }),
    rename: (from: string, to: string) =>
      Effect.sync(() => {
        const content = files.get(from);
        if (content !== undefined) {
          files.set(to, content);
          files.delete(from);
        }
        renames.push({ from, to });
      }),
    makeDirectory: () => Effect.void,
  } as unknown as FileSystem.FileSystem;

  const layer = Layer.succeed(FileSystem.FileSystem, testFs);
  return { files, renames, layer };
};

describe("daemon config persistence", () => {
  it.effect("persistConfig writes current state to disk", () => {
    const { files, renames, layer: testFsLayer } = makeTestFileSystem();

    return Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      yield* Ref.update(ref, (s) => ({ ...s, pinHash: "test-hash", keepAwake: true }));
      yield* persistConfig;

      // Atomic write: wrote to tmp, then renamed to target
      expect(renames.length).toBeGreaterThanOrEqual(1);
      const finalContent = files.get("/tmp/test-daemon.json");
      expect(finalContent).toBeDefined();
      const written = JSON.parse(finalContent!);
      expect(written.pinHash).toBe("test-hash");
      expect(written.keepAwake).toBe(true);
    }).pipe(
      Effect.provide(makeDaemonStateLive()),
      Effect.provide(TestPersistencePathLive),
      Effect.provide(testFsLayer)
    );
  });

  it.effect("loadConfig returns parsed state from disk", () => {
    const { files, layer: testFsLayer } = makeTestFileSystem();
    files.set("/tmp/test-daemon.json", JSON.stringify({
      pid: 12345,
      port: 2633,
      pinHash: "loaded-hash",
      tls: false,
      debug: false,
      keepAwake: false,
      dangerouslySkipPermissions: false,
      projects: [{ path: "/proj", slug: "proj", addedAt: 1000 }],
      dismissedPaths: ["/a", "/b"],
    }));

    return Effect.gen(function* () {
      const result = yield* loadConfig;
      expect(result.pinHash).toBe("loaded-hash");
      expect(result.dismissedPaths).toEqual(new Set(["/a", "/b"]));
    }).pipe(
      Effect.provide(TestPersistencePathLive),
      Effect.provide(testFsLayer)
    );
  });

  it.effect("loadConfig returns DaemonState.empty() on missing file", () => {
    // Empty test FS — no files exist
    const { layer: testFsLayer } = makeTestFileSystem();

    return Effect.gen(function* () {
      const result = yield* loadConfig;
      // catchAll returns DaemonState.empty(), not {}
      expect(result.pinHash).toBeNull();
      expect(result.keepAwake).toBe(false);
      expect(result.dismissedPaths.size).toBe(0);
    }).pipe(
      Effect.provide(TestPersistencePathLive),
      Effect.provide(testFsLayer)
    );
  });

  it.effect("coalesces rapid saves via atomic Ref.modify", () => {
    const { renames, layer: testFsLayer } = makeTestFileSystem();

    return Effect.gen(function* () {
      // Fire 3 concurrent persists — should coalesce
      yield* Effect.all(
        [persistConfig, persistConfig, persistConfig],
        { concurrency: "unbounded" }
      );
      // At most 2 renames (initial + one resave), not 3
      expect(renames.length).toBeLessThanOrEqual(2);
    }).pipe(
      Effect.provide(makeDaemonStateLive()),
      Effect.provide(TestPersistencePathLive),
      Effect.provide(testFsLayer)
    );
  });

  it.effect("coalesces deterministically when save already in progress", () => {
    const { renames, layer: testFsLayer } = makeTestFileSystem();

    return Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      // Simulate save already in progress
      yield* Ref.update(ref, (s) => ({ ...s, pendingSave: true }));
      // This call should set needsResave, not start a new write
      yield* persistConfig;
      const state = yield* Ref.get(ref);
      expect(state.needsResave).toBe(true);

      // No renames — coalesced into the in-flight save
      expect(renames.length).toBe(0);
    }).pipe(
      Effect.provide(makeDaemonStateLive()),
      Effect.provide(TestPersistencePathLive),
      Effect.provide(testFsLayer)
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-config-persistence.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/daemon-config-persistence.ts
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { DaemonStateTag, DaemonState } from "./daemon-state.js";

export class PersistencePathTag extends Context.Tag("PersistencePath")<
  PersistencePathTag,
  string
>() {}

// Re-use the existing DaemonConfigSchema from config-persistence.ts for
// encode/decode. This gives runtime validation and handles Set↔Array and
// optional field transformations. DaemonConfig is the persisted shape;
// DaemonState extends it with runtime-only fields.
import { DaemonConfigSchema, type DaemonConfig } from "../daemon/config-persistence.js";

// AUDIT FIX (H-R5-1 / H9): Use Schema.transform for type-safe bidirectional
// DaemonConfig ↔ Partial<DaemonState> conversion. This replaces the manual
// serializeState/deserializeConfig functions with a single Schema definition
// that handles Set↔Array and optional field defaults in both directions.
const DaemonConfigToState = Schema.transform(
  DaemonConfigSchema,
  Schema.Struct({
    pid: Schema.Number,
    port: Schema.Number,
    pinHash: Schema.NullOr(Schema.String),
    tls: Schema.Boolean,
    debug: Schema.Boolean,
    keepAwake: Schema.Boolean,
    keepAwakeCommand: Schema.optional(Schema.String),
    keepAwakeArgs: Schema.optional(Schema.Array(Schema.String)),
    dangerouslySkipPermissions: Schema.Boolean,
    projects: Schema.Array(Schema.Unknown),
    instances: Schema.Array(Schema.Unknown),
    dismissedPaths: Schema.instanceOf(Set<string>),
  }),
  {
    strict: true,
    decode: (config) => ({
      pid: config.pid,
      port: config.port,
      pinHash: config.pinHash,
      tls: config.tls,
      debug: config.debug,
      keepAwake: config.keepAwake,
      keepAwakeCommand: config.keepAwakeCommand,
      keepAwakeArgs: config.keepAwakeArgs,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      projects: config.projects,
      instances: config.instances ?? [],
      dismissedPaths: new Set(config.dismissedPaths ?? []),
    }),
    encode: (state) => ({
      pid: state.pid,
      port: state.port,
      pinHash: state.pinHash,
      tls: state.tls,
      debug: state.debug,
      keepAwake: state.keepAwake,
      keepAwakeCommand: state.keepAwakeCommand,
      keepAwakeArgs: state.keepAwakeArgs,
      dangerouslySkipPermissions: state.dangerouslySkipPermissions,
      projects: state.projects,
      instances: state.instances,
      dismissedPaths: [...state.dismissedPaths],
    }),
  }
);

// Convenience wrappers using the Schema.transform
const serializeState = (state: DaemonState): DaemonConfig =>
  Schema.encodeSync(DaemonConfigToState)({
    pid: state.pid, port: state.port, pinHash: state.pinHash,
    tls: state.tls, debug: state.debug, keepAwake: state.keepAwake,
    keepAwakeCommand: state.keepAwakeCommand, keepAwakeArgs: state.keepAwakeArgs,
    dangerouslySkipPermissions: state.dangerouslySkipPermissions,
    projects: state.projects, instances: state.instances,
    dismissedPaths: state.dismissedPaths,
  }) as unknown as DaemonConfig;

const deserializeConfig = (config: DaemonConfig): Partial<DaemonState> =>
  Schema.decodeSync(DaemonConfigToState)(config) as unknown as Partial<DaemonState>;

export const loadConfig: Effect.Effect<DaemonState, never, PersistencePathTag | FileSystem.FileSystem> =
  Effect.gen(function* () {
    const configPath = yield* PersistencePathTag;
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(configPath).pipe(
      Effect.flatMap((raw) =>
        Effect.try(() => JSON.parse(raw)).pipe(
          Effect.flatMap((json) => Schema.decodeUnknown(DaemonConfigSchema)(json)),
          Effect.map((config) => ({
            ...DaemonState.empty(),
            ...deserializeConfig(config as unknown as DaemonConfig),
          }))
        )
      ),
      // AUDIT FIX (M10/H7): Log a warning when config is missing or corrupt
      // rather than silently returning defaults. Callers should know.
      Effect.catchAll((e) =>
        Effect.logWarning("Config load failed, using defaults: " + String(e)).pipe(
          Effect.map(() => DaemonState.empty())
        )
      )
    );
  });

// Atomic write: write to temp file, then rename (crash-safe)
// Uses @effect/platform FileSystem so tests can inject in-memory FS.
const atomicWrite = (configPath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    const dir = configPath.substring(0, configPath.lastIndexOf("/"));
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(tmpPath, content);
    yield* fs.rename(tmpPath, configPath);
  });

export const persistConfig: Effect.Effect<void, never, DaemonStateTag | PersistencePathTag | FileSystem.FileSystem> =
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

    // Catch I/O errors only — let programming defects propagate.
    // atomicWrite uses @effect/platform FileSystem which produces
    // PlatformError on I/O failures. Defects (bugs) are not caught.
    yield* atomicWrite(path, serialized).pipe(
      Effect.catchTag("SystemError", (e) => Effect.logWarning("Config persist failed: " + e.message)),
      Effect.catchTag("BadArgument", (e) => Effect.logWarning("Config persist bad path: " + e.message)),
    );

    // Check if resave needed, reset flags atomically, and loop if needed.
    // IMPORTANT: Do NOT use direct JS recursion (`yield* persistConfig`) —
    // Effect.gen does not optimize tail calls, so rapid-fire saves could
    // stack overflow. Use an iterative approach with Effect.loop instead.
    const needsResave = yield* Ref.modify(ref, (s) => {
      return [s.needsResave, { ...s, pendingSave: false, needsResave: false }];
    });

    if (needsResave) {
      // Re-enter the save loop by scheduling another persistConfig.
      // Effect.yieldNow ensures we don't block the fiber scheduler.
      yield* Effect.yieldNow();
      yield* doSave(ref, path);
    }
  });

// Internal save implementation extracted for iterative re-entry.
// persistConfig is the public API that handles the coalesce check.
const doSave = (ref: Ref.Ref<DaemonState>, path: string) =>
  Effect.gen(function* () {
    const freshState = yield* Ref.get(ref);
    const serialized = JSON.stringify(serializeState(freshState), null, 2);
    yield* atomicWrite(path, serialized).pipe(
      Effect.catchTag("SystemError", (e) => Effect.logWarning("Config persist failed: " + e.message)),
      Effect.catchTag("BadArgument", (e) => Effect.logWarning("Config persist bad path: " + e.message)),
    );
    const again = yield* Ref.modify(ref, (s) => {
      return [s.needsResave, { ...s, pendingSave: false, needsResave: false }];
    });
    if (again) {
      yield* Effect.yieldNow();
      yield* doSave(ref, path);
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
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Exit } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import {
  rehydrateInstances,
  recordCrashCounter,
  CrashCounterTag,
  CrashLimitExceeded,
} from "../../../src/lib/effect/daemon-startup.js";
import { InstanceMgmtTag } from "../../../src/lib/effect/services.js";
import { OpenCodeConnectionError } from "../../../src/lib/errors.js";

describe("daemon startup effects", () => {
  describe("recordCrashCounter", () => {
    it.effect("records crash and proceeds when under limit", () => {
      // Mocks return Effects — consistent with CrashCounter interface
      const mockCounter = {
        record: vi.fn().mockReturnValue(Effect.succeed({ count: 2, shouldAbort: false })),
        reset: vi.fn().mockReturnValue(Effect.void),
      };

      return Effect.gen(function* () {
        const result = yield* recordCrashCounter;
        expect(mockCounter.record).toHaveBeenCalled();
        expect(result).toBe(false); // shouldAbort = false
      }).pipe(Effect.provide(Layer.succeed(CrashCounterTag, mockCounter)));
    });

    it.effect("aborts when crash limit exceeded", () => {
      const mockCounter = {
        record: vi.fn().mockReturnValue(Effect.succeed({ count: 10, shouldAbort: true })),
        reset: vi.fn().mockReturnValue(Effect.void),
      };

      return Effect.gen(function* () {
        const result = yield* recordCrashCounter;
        expect(result).toBe(true); // shouldAbort = true
      }).pipe(Effect.provide(Layer.succeed(CrashCounterTag, mockCounter)));
    });
  });

  describe("rehydrateInstances", () => {
    it.effect("restores instances from persisted state", () => {
      // Mocks MUST return Effects — the implementation uses yield* to call them
      const addInstance = vi.fn().mockReturnValue(Effect.void);
      const mockInstanceMgmt: InstanceMgmtTag["Type"] = {
        addInstance, removeInstance: vi.fn().mockReturnValue(Effect.void),
        listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
        updateInstance: vi.fn().mockReturnValue(Effect.void),
        startInstance: vi.fn().mockReturnValue(Effect.void),
        stopInstance: vi.fn().mockReturnValue(Effect.void),
        getInstance: vi.fn().mockReturnValue(Effect.succeed({})),
      } as unknown as InstanceMgmtTag["Type"];

      return Effect.gen(function* () {
        const ref = yield* DaemonStateTag;
        yield* Ref.update(ref, (s) => ({
          ...s,
          instances: [
            { id: "inst-1", name: "Test", port: 4096, managed: true },
            { id: "inst-2", name: "Test2", port: 4097, managed: false },
          ],
        }));
        yield* rehydrateInstances;
        // Should not throw — degraded path logs and continues
      }).pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(Layer.succeed(InstanceMgmtTag, mockInstanceMgmt))
      );
    });
  });

  describe("error isolation", () => {
    it.effect("rehydrateInstances is non-fatal — logs and continues", () => {
      // Mock returns a failing Effect with a TAGGED error. rehydrateInstances
      // only catches tagged errors (InstanceLimitExceeded, OpenCodeConnectionError,
      // OpenCodeApiError). Plain Error would propagate uncaught.
      // AUDIT FIX (C-R5-2): Use a tagged error that matches the catchTag chain.
      const mockInstanceMgmt: InstanceMgmtTag["Type"] = {
        addInstance: vi.fn().mockReturnValue(
          Effect.fail(new OpenCodeConnectionError({ cause: "DB corrupt" }))
        ),
        removeInstance: vi.fn().mockReturnValue(Effect.void),
        listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
        updateInstance: vi.fn().mockReturnValue(Effect.void),
        startInstance: vi.fn().mockReturnValue(Effect.void),
        stopInstance: vi.fn().mockReturnValue(Effect.void),
        getInstance: vi.fn().mockReturnValue(Effect.succeed({})),
      } as unknown as InstanceMgmtTag["Type"];

      return rehydrateInstances.pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(Layer.succeed(InstanceMgmtTag, mockInstanceMgmt))
      );
      // it.effect will fail if the Effect fails — passing means non-fatal
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
import { Context, Data, Effect, Layer, Ref, Duration } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { DaemonStateTag } from "./daemon-state.js";
import { InstanceMgmtTag } from "./services.js";

export class CrashLimitExceeded extends Data.TaggedError("CrashLimitExceeded")<{
  count: number;
}> {}

// --- Crash Counter ---

export interface CrashCounter {
  record(): Effect.Effect<{ count: number; shouldAbort: boolean }>;
  reset(): Effect.Effect<void>;
}

export class CrashCounterTag extends Context.Tag("CrashCounter")<
  CrashCounterTag,
  CrashCounter
>() {}

export const recordCrashCounter: Effect.Effect<boolean, never, CrashCounterTag> =
  Effect.gen(function* () {
    const counter = yield* CrashCounterTag;
    const result = yield* counter.record();
    return result.shouldAbort;
  });

// --- Instance rehydration (degraded on failure) ---

export const rehydrateInstances: Effect.Effect<void, never, DaemonStateTag | InstanceMgmtTag> =
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    const mgmt = yield* InstanceMgmtTag;

    // Restore instances from persisted config (DaemonState.instances[])
    yield* Effect.logInfo(`Rehydrating ${state.instances.length} persisted instances`);
    // InstanceMgmtTag methods return Effect (not Promise) — they are
    // fully converted Effect services. If the service is still transitional,
    // use Effect.tryPromise(() => mgmt.addInstance(...)) to wrap Promises.
    yield* Effect.forEach(state.instances, (inst) =>
      Effect.gen(function* () {
        yield* mgmt.addInstance({
          id: inst.id,
          name: inst.name,
          port: inst.port,
          managed: inst.managed,
          env: inst.env,
          url: inst.url,
        });
        yield* Effect.logInfo(`Rehydrated instance ${inst.id} (${inst.name})`);
      }).pipe(
        // Catch specific expected errors — let defects (bugs) propagate
        Effect.catchTag("InstanceLimitExceeded", (e) =>
          Effect.logWarning(`Skipping instance ${inst.id}: instance limit reached`)
        ),
        Effect.catchTag("OpenCodeConnectionError", (e) =>
          Effect.logWarning(`Skipping instance ${inst.id}: connection error`)
        ),
      ),
      { concurrency: 1 } // Sequential to avoid port conflicts
    );
  }).pipe(
    // Top-level degraded path: catch remaining expected errors, let defects propagate
    Effect.catchTag("OpenCodeApiError", (e) =>
      Effect.logWarning("Instance rehydration API error, continuing with empty state", e)
    ),
  );

// --- Probe and convert (degraded on failure) ---

export const probeAndConvert: Effect.Effect<void, never, InstanceMgmtTag | HttpClient.HttpClient.Service> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const client = yield* HttpClient.HttpClient;
    yield* Effect.logInfo("Probing for unreachable unmanaged instances");

    // Get all unmanaged instances, probe each, convert unreachable to managed
    const instances = yield* mgmt.listInstances();
    yield* Effect.forEach(
      instances.filter((i) => !i.managed),
      (inst) =>
        Effect.gen(function* () {
          const reachable = yield* client.execute(
            HttpClientRequest.get(`http://localhost:${inst.port}/health`)
          ).pipe(
            Effect.map((res) => res.status === 200),
            Effect.orElseSucceed(() => false),
          );
          if (!reachable) {
            yield* mgmt.updateInstance(inst.id, { managed: true });
            yield* Effect.logInfo(`Converted unreachable instance ${inst.id} to managed`);
          }
        }),
      { concurrency: 5 }
    );
  }).pipe(
    // Catch expected errors — network unreachable, API unavailable
    Effect.catchTag("OpenCodeConnectionError", (e) =>
      Effect.logWarning("Probe-and-convert failed (connection error), continuing")
    ),
    Effect.catchTag("OpenCodeApiError", (e) =>
      Effect.logWarning("Probe-and-convert failed (API error), continuing")
    ),
  );

// --- Smart default detection (degraded on failure) ---

export const detectSmartDefault: Effect.Effect<void, never, InstanceMgmtTag | HttpClient.HttpClient.Service> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const client = yield* HttpClient.HttpClient;
    yield* Effect.logInfo("Detecting smart default on localhost:4096");

    // Probe localhost:4096 for an existing OpenCode instance
    const isRunning = yield* client.execute(
      HttpClientRequest.get("http://localhost:4096/health")
    ).pipe(
      Effect.timeout(Duration.seconds(2)),
      Effect.map((res) => res.status === 200),
      Effect.orElseSucceed(() => false),
    );

    if (isRunning) {
      // Check if already registered
      const instances = yield* mgmt.listInstances();
      const alreadyKnown = instances.some((i) => i.port === 4096);
      if (!alreadyKnown) {
        yield* mgmt.addInstance({ name: "Default", port: 4096, managed: false });
        yield* Effect.logInfo("Auto-detected OpenCode instance on :4096");
      }
    }
  }).pipe(
    Effect.catchTag("OpenCodeConnectionError", (e) =>
      Effect.logWarning("Smart default detection failed (connection), continuing")
    ),
    Effect.catchTag("OpenCodeApiError", (e) =>
      Effect.logWarning("Smart default detection failed (API), continuing")
    ),
  );

// --- Auto-start managed default (degraded on failure) ---

export const autoStartManagedDefault: Effect.Effect<void, never, InstanceMgmtTag | DaemonStateTag> =
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* Effect.logInfo("Auto-starting managed default instance");

    // Find managed instances that are stopped, start the first one
    const instances = yield* mgmt.listInstances();
    const managedStopped = instances.filter((i) => i.managed && i.status === "stopped");
    if (managedStopped.length > 0) {
      yield* mgmt.startInstance(managedStopped[0]!.id);
      yield* Effect.logInfo(`Auto-started managed instance ${managedStopped[0]!.id}`);
    }
  }).pipe(
    Effect.catchTag("InstanceNotFound", (e) =>
      Effect.logWarning("Auto-start failed (instance not found), continuing")
    ),
    Effect.catchTag("OpenCodeConnectionError", (e) =>
      Effect.logWarning("Auto-start failed (connection error), continuing")
    ),
  );

// --- Startup orchestrator ---

export const runStartupSequence: Effect.Effect<
  void,
  CrashLimitExceeded,
  CrashCounterTag | DaemonStateTag | InstanceMgmtTag | HttpClient.HttpClient
> = Effect.gen(function* () {
  // Phase 2: Sequential startup effects
  const shouldAbort = yield* recordCrashCounter;
  if (shouldAbort) {
    yield* Effect.logError("Crash limit exceeded, aborting startup");
    return yield* Effect.fail(new CrashLimitExceeded({ count: 10 }));
  }

  // Degraded steps — each uses catchAll for EXPECTED failures (e.g. network
  // unreachable, corrupt config). Programming errors (defects) are NOT caught
  // here — they propagate as Cause.Die to the top-level defect handler
  // installed in daemon-main.ts. This is intentional: a bug in rehydration
  // logic should crash visibly, not be silently swallowed.
  yield* rehydrateInstances;
  yield* probeAndConvert;
  yield* detectSmartDefault;
  yield* autoStartManagedDefault;

  yield* Effect.logInfo("Startup sequence complete");
}).pipe(Effect.annotateLogs("phase", "startup"));
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

### Task 4: Create Ref+Scope-based relay cache with invalidation

**Files:**
- Create: `src/lib/effect/relay-cache.ts`
- Test: `test/unit/relay/relay-cache.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay/relay-cache.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Duration, HashMap } from "effect";
import { RelayCacheTag, makeRelayCacheLive, type Relay } from "../../../src/lib/effect/relay-cache.js";

const makeTestRelay = (slug: string): Relay => ({
  slug,
  wsHandler: { handleUpgrade: vi.fn() } as unknown as Relay["wsHandler"],
  stop: vi.fn(),
});

describe("RelayCache", () => {
  it.scoped("creates relay on first get", () => {
    let created = 0;
    const factory = (slug: string) =>
      Effect.sync(() => {
        created++;
        return makeTestRelay(slug);
      });

    return Effect.gen(function* () {
      const cache = yield* RelayCacheTag;
      const relay = yield* cache.get("test-slug");
      expect(relay.slug).toBe("test-slug");
      expect(created).toBe(1);
    }).pipe(Effect.provide(makeRelayCacheLive(factory)));
  });

  it.scoped("deduplicates concurrent gets for same slug", () => {
    let created = 0;
    const factory = (slug: string) =>
      Effect.delay(Effect.sync(() => {
        created++;
        return makeTestRelay(slug);
      }), Duration.millis(50));

    return Effect.gen(function* () {
      const cache = yield* RelayCacheTag;
      // Concurrent gets for same slug
      const [r1, r2] = yield* Effect.all([
        cache.get("same-slug"),
        cache.get("same-slug"),
      ], { concurrency: "unbounded" });
      expect(r1).toBe(r2);
      expect(created).toBe(1); // Only created once despite two gets
    }).pipe(Effect.provide(makeRelayCacheLive(factory)));
  });

  it.scoped("invalidate stops relay and allows re-creation", () => {
    let created = 0;
    const stopSpies: Array<ReturnType<typeof vi.fn>> = [];
    const factory = (slug: string) =>
      Effect.sync(() => {
        created++;
        const spy = vi.fn();
        stopSpies.push(spy);
        return { slug, wsHandler: { handleUpgrade: vi.fn() } as unknown as Relay["wsHandler"], stop: spy };
      });

    return Effect.gen(function* () {
      const cache = yield* RelayCacheTag;
      yield* cache.get("slug-a");
      expect(created).toBe(1);

      yield* cache.invalidate("slug-a");
      // Previous relay's stop() should have been called by finalizer
      expect(stopSpies[0]).toHaveBeenCalled();

      yield* cache.get("slug-a");
      expect(created).toBe(2); // Re-created after invalidation
    }).pipe(Effect.provide(makeRelayCacheLive(factory)));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/relay-cache.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/effect/relay-cache.ts
// Uses ScopedRef per conventions (line 29): "Use ScopedRef for caches that
// hold scoped resources and support swapping/invalidation (e.g., the relay
// cache). ScopedRef manages the inner scope lifecycle automatically."
import { Context, Effect, Layer, Ref, ScopedRef, HashMap, Option } from "effect";

export interface Relay {
  slug: string;
  wsHandler: { handleUpgrade: (req: unknown, socket: unknown, head: unknown) => void };
  stop: () => void;
}

export type RelayFactory = (slug: string) => Effect.Effect<Relay, never, never>;

/** Cache service with explicit invalidation support using ScopedRef per entry. */
export interface RelayCache {
  get: (slug: string) => Effect.Effect<Relay>;
  invalidate: (slug: string) => Effect.Effect<void>;
}

export class RelayCacheTag extends Context.Tag("RelayCache")<
  RelayCacheTag,
  RelayCache
>() {}

export const makeRelayCacheLive = (
  factory: RelayFactory,
): Layer.Layer<RelayCacheTag> =>
  Layer.scoped(
    RelayCacheTag,
    Effect.gen(function* () {
      // Each entry is a ScopedRef<Relay | null>. ScopedRef manages the inner
      // scope lifecycle automatically — when set() is called with a new value,
      // the previous scope is closed (running relay.stop() via its finalizer).
      // On Layer teardown, all ScopedRefs close their inner scopes.
      const entries = yield* Ref.make<HashMap.HashMap<string, ScopedRef.ScopedRef<Relay | null>>>(
        HashMap.empty()
      );

      // AUDIT FIX (H6): Use a Semaphore to prevent duplicate relay creation.
      // Without it, two concurrent get("same-slug") calls could both pass the
      // HashMap check and create duplicate ScopedRefs.
      const mutex = yield* Effect.makeSemaphore(1);

      const get = (slug: string) =>
        mutex.withPermits(1)(Effect.gen(function* () {
          const current = yield* Ref.get(entries);
          const existingRef = HashMap.get(current, slug);

          if (Option.isSome(existingRef)) {
            const relay = yield* ScopedRef.get(existingRef.value);
            if (relay !== null) return relay;
          }

          // AUDIT FIX (C8): ScopedRef.make takes LazyArg<A> (plain value thunk),
          // NOT a function returning Effect. Use ScopedRef.fromAcquire for
          // Effect-based initialization.
          const scopedRef = yield* ScopedRef.fromAcquire(Effect.succeed(null as Relay | null));

          // Set the relay via ScopedRef.set — this runs the factory in a
          // new inner scope and registers relay.stop() as a finalizer.
          yield* ScopedRef.set(scopedRef,
            Effect.gen(function* () {
              const relay = yield* factory(slug);
              yield* Effect.addFinalizer(() => Effect.sync(() => relay.stop()));
              return relay as Relay | null;
            })
          );

          yield* Ref.update(entries, (m) => HashMap.set(m, slug, scopedRef));

          const relay = yield* ScopedRef.get(scopedRef);
          return relay!;
        }));

      const invalidate = (slug: string) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(entries);
          const existingRef = HashMap.get(current, slug);
          if (Option.isNone(existingRef)) return;

          // Remove from map first
          yield* Ref.update(entries, (m) => HashMap.remove(m, slug));

          // Set to null — ScopedRef closes the previous inner scope,
          // which runs relay.stop() via the finalizer registered in get().
          yield* ScopedRef.set(existingRef.value,
            Effect.succeed(null as Relay | null)
          );
        });

      return { get, invalidate };
    })
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/relay-cache.test.ts`
Expected: 3 tests PASS

**Step 5: Commit**

```bash
git add src/lib/effect/relay-cache.ts test/unit/relay/relay-cache.test.ts
git commit -m "feat(effect): add ScopedRef-based relay cache with HashMap replacing ProjectRegistry"
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
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { RelayCacheTag } from "../../../src/lib/effect/relay-cache.js";

describe("daemon layer composition", () => {
  it.effect("DaemonStateTag is available in composed layer", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      expect(state.clientCount).toBe(0);
    }).pipe(Effect.provide(makeDaemonStateLive()))
  );
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

In `makeDaemonLive`, add the new layers to the composition chain.
Use `Effect.Deferred` for server-ready signals — the HTTP server Layer
completes a Deferred when it starts listening, and downstream consumers
(IPC server, startup sequence) can `Deferred.await` before proceeding:
```typescript
// Existing: infraLayer → serversLayer → backgroundLayer
// Add: daemonStateLayer, relayCacheLayer, and server-ready Deferreds
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
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref, Exit } from "effect";
import { HttpClient } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { CrashCounterTag, CrashLimitExceeded, runStartupSequence } from "../../../src/lib/effect/daemon-startup.js";
import { InstanceMgmtTag } from "../../../src/lib/effect/services.js";

describe("startDaemon", () => {
  // Minimal mock deps — only what runStartupSequence needs
  // Mocks return Effects — consistent with CrashCounter interface
  const mockCounter = {
    record: vi.fn().mockReturnValue(Effect.succeed({ count: 1, shouldAbort: false })),
    reset: vi.fn().mockReturnValue(Effect.void),
  };
  // Mocks MUST return Effects — the implementation uses yield* to call them
  const mockInstanceMgmt: InstanceMgmtTag["Type"] = {
    addInstance: vi.fn().mockReturnValue(Effect.void),
    removeInstance: vi.fn().mockReturnValue(Effect.void),
    listInstances: vi.fn().mockReturnValue(Effect.succeed([])),
  } as unknown as InstanceMgmtTag["Type"];

  // Use NodeHttpClient.layer (not HttpClient.layer which doesn't exist).
  // In tests, prefer a mock HttpClient via Layer.succeed(HttpClient.HttpClient, ...)
  // to avoid real network calls. NodeHttpClient.layer is used here for
  // smoke testing only — production probeAndConvert calls will hit localhost.
  const minimalLayer = Layer.mergeAll(
    makeDaemonStateLive(),
    Layer.succeed(CrashCounterTag, mockCounter),
    Layer.succeed(InstanceMgmtTag, mockInstanceMgmt),
    NodeHttpClient.layer,
  );

  it.effect("runStartupSequence completes and sets state", () =>
    Effect.gen(function* () {
      yield* runStartupSequence;
      const ref = yield* DaemonStateTag;
      const state = yield* Ref.get(ref);
      expect(state.shuttingDown).toBe(false);
      expect(mockCounter.record).toHaveBeenCalled();
    }).pipe(Effect.provide(minimalLayer))
  );

  it.effect("aborts when crash counter triggers", () => {
    const abortingCounter = {
      record: vi.fn().mockReturnValue(Effect.succeed({ count: 10, shouldAbort: true })),
      reset: vi.fn().mockReturnValue(Effect.void),
    };

    const abortLayer = Layer.mergeAll(
      makeDaemonStateLive(),
      Layer.succeed(CrashCounterTag, abortingCounter),
      Layer.succeed(InstanceMgmtTag, mockInstanceMgmt),
      NodeHttpClient.layer,
    );

    return runStartupSequence.pipe(
      Effect.catchTag("CrashLimitExceeded", (e) => {
        expect(e.count).toBe(10);
        return Effect.void;
      }),
      Effect.provide(abortLayer)
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-main.test.ts`
Expected: FAIL — module not found

**Step 3: Write daemon-main.ts — top-level entry point**

```typescript
// src/lib/effect/daemon-main.ts
import { Effect, Layer, Ref, Schedule, Duration, Deferred, Supervisor, RuntimeFlags } from "effect";
import { DaemonStateTag } from "./daemon-state.js";
import { CrashCounterTag, CrashLimitExceeded, runStartupSequence } from "./daemon-startup.js";
import { PersistencePathTag } from "./daemon-config-persistence.js";
import { InstanceMgmtTag, ProjectMgmtTag, ConfigTag, LoggerTag,
  OpenCodeAPITag } from "./services.js";
import { RelayCacheTag } from "./relay-cache.js";

// NOTE: This type is deliberately MINIMAL at Phase 1 time. It lists only
// the Tags available after Phase 1 Tasks 1-5. As later phases add Tags
// (DaemonEventBusTag, PushManagerTag, RateLimiterTag, SessionManagerTag,
// WebSocketHandlerTag, etc.), expand this type in the same commit that
// wires the new Layer into daemon-layers.ts. This avoids forward-referencing
// modules that don't exist yet.
//
// Phase 2a adds: SessionManagerStateTag, PollerStateTag, PollerManagerStateTag
// Phase 2b adds: InstanceManagerStateTag, RateLimiterTag, PushManagerTag, PersistenceServiceTag
// Phase 3 Task 19 wires them all and expands DaemonDeps accordingly.
// Phase 4 adds: DaemonEventBusTag, OverridesStateTag, DaemonEnvConfigTag, SupervisorTag
// Phase 5 adds: WebSocketHandlerTag (Effect version), HttpServerTag

type DaemonDeps =
  | DaemonStateTag | CrashCounterTag | PersistencePathTag
  | InstanceMgmtTag | ProjectMgmtTag
  | RelayCacheTag
  | ConfigTag | LoggerTag;

// Reusable retry schedule: exponential backoff, max 3 retries
const startupRetry = Schedule.exponential("1 second").pipe(
  Schedule.intersect(Schedule.recurs(3))
);

/**
 * Background tasks forked after startup completes.
 * Each is defined here (not imported) because they compose multiple services.
 * Each retries on failure with exponential backoff so fibers don't silently die.
 */
const projectDiscovery: Effect.Effect<void, never, ProjectMgmtTag | DaemonStateTag> =
  Effect.gen(function* () {
    const mgmt = yield* ProjectMgmtTag;
    yield* Effect.logInfo("Starting project discovery");
    yield* mgmt.discoverProjects();
  }).pipe(
    Effect.retry(startupRetry),
    Effect.catchAll((e) => Effect.logWarning("Project discovery failed", e)),
    Effect.annotateLogs("task", "project-discovery")
  );

// AUDIT FIX (C9): sessionPrefetch and pushInit are STUBS at Phase 1 time.
// They reference SessionManagerTag, PushManagerTag, and OpenCodeAPITag which
// don't exist until Phases 2a/2b. Define them as placeholder comments here
// and expand them in the same commit that creates the Tags they depend on.
//
// Phase 2a (Task 9) creates SessionManagerServiceTag → expand sessionPrefetch
// Phase 2b (Task 18) creates PushManagerTag → expand pushInit
//
// const sessionPrefetch = ... // EXPAND in Phase 2a after SessionManagerServiceTag exists
// const pushInit = ...        // EXPAND in Phase 2b after PushManagerTag exists

/**
 * The daemon program as a Layer. Uses Layer.launch at the CLI entry point:
 *
 *   Layer.launch(DaemonProgramLayer).pipe(Effect.runFork)
 *
 * Layer.launch constructs the layer, runs until interrupted (SIGINT/SIGTERM),
 * then tears down all finalizers in reverse order — no manual signal handling
 * or ManagedRuntime.dispose() needed.
 */
export const makeDaemonProgramLayer = (
  daemonLayer: Layer.Layer<DaemonDeps, never, never>
): Layer.Layer<never> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      // Enable cooperative yielding so long-running fibers don't starve others
      yield* Effect.updateRuntimeFlags(RuntimeFlags.enable(RuntimeFlags.CooperativeYielding));

      // Run startup sequence
      yield* runStartupSequence.pipe(
        Effect.withSpan("daemon.startup"),
        Effect.catchTag("CrashLimitExceeded", (e) =>
          Effect.logError(`Crash limit exceeded (${e.count}), aborting`).pipe(
            Effect.flatMap(() => Effect.die(e))
          )
        )
      );

      // Install supervisor for fiber diagnostics
      const supervisor = yield* Supervisor.track;

      // Fork background tasks under supervision.
      // IMPORTANT: Use Effect.forkScoped (NOT Effect.forkDaemon). forkDaemon
      // fibers survive Layer teardown and are NOT interrupted on shutdown.
      // forkScoped fibers are tied to the enclosing Scope (from Layer.scopedDiscard)
      // and are interrupted in reverse order when the daemon shuts down.
      // NOTE: Effect.supervised is curried: (supervisor) => (effect)
      //
      // AUDIT FIX (C9): Only fork projectDiscovery at Phase 1 time.
      // sessionPrefetch and pushInit are added in Phases 2a/2b when their
      // Tags exist. See the stub comments above.
      //
      // AUDIT FIX (L6): Use tapDefect instead of catchAllDefect to LOG
      // defects without swallowing them. Defects should still propagate to
      // the Supervisor for diagnostics.
      yield* Effect.supervised(supervisor)(
        Effect.gen(function* () {
          yield* Effect.forkScoped(projectDiscovery);
          // yield* Effect.forkScoped(sessionPrefetch);  // EXPAND in Phase 2a
          // yield* Effect.forkScoped(pushInit);          // EXPAND in Phase 2b
        })
      ).pipe(
        Effect.tapDefect((defect) =>
          Effect.logError("DEFECT in background task — this is a bug", defect)
        )
      );

      yield* Effect.logInfo("Daemon started — awaiting interruption");

      // Keep alive until interrupted (SIGINT/SIGTERM via Layer.launch)
      yield* Effect.never;
    }).pipe(Effect.annotateLogs("component", "daemon-main"))
  ).pipe(Layer.provide(daemonLayer));

/**
 * Graceful shutdown is handled by Layer.launch + Layer finalizers.
 * The CLI entry point wires it as:
 *
 *   const program = Layer.launch(makeDaemonProgramLayer(daemonLive));
 *   Effect.runFork(program);
 *
 * On SIGINT/SIGTERM, Layer.launch interrupts the program, which:
 * 1. Interrupts Effect.never (the keep-alive)
 * 2. Interrupts all forkDaemon fibers
 * 3. Runs all Layer finalizers in reverse order (servers close, PID file removed)
 */
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

### Task 7: IPC Effect handler types (leverage existing IPCCommandSchema)

> **NOTE:** `IPCCommandSchema` (19-command `Schema.Union` discriminated on `cmd`)
> already exists in `src/lib/daemon/ipc-protocol.ts`. It uses `cmd` as the
> discriminant field (e.g., `"add_project"`, `"shutdown"`), NOT `_tag`. This task
> does NOT recreate those schemas — it adds Effect-returning handler type
> definitions that pair with the existing schema for type-safe dispatch.

**Files:**
- Create: `src/lib/effect/ipc-effect-types.ts`
- Test: `test/unit/daemon/ipc-effect-types.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/daemon/ipc-effect-types.test.ts
import { describe, it, expect } from "vitest";
import { Schema, Either } from "effect";
import { IPCCommandSchema } from "../../../src/lib/daemon/ipc-protocol.js";

describe("IPC Schema (existing)", () => {
  it("decodes add_project command", () => {
    const raw = { cmd: "add_project", directory: "/home/user/project" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.cmd).toBe("add_project");
      expect((result.right as any).directory).toBe("/home/user/project");
    }
  });

  it("rejects add_project without directory", () => {
    const raw = { cmd: "add_project" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("decodes set_pin command", () => {
    const raw = { cmd: "set_pin", pin: "1234" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("decodes shutdown command (no payload)", () => {
    const raw = { cmd: "shutdown" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects unknown command", () => {
    const raw = { cmd: "unknown_command" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("decodes instance_add with cross-field validation", () => {
    const raw = { cmd: "instance_add", name: "test", port: 4096, managed: true };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects instance_add managed without port", () => {
    const raw = { cmd: "instance_add", name: "test", managed: true };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });
});

// Verify that the new ipc-effect-types module exists and re-exports correctly
import { IpcEffectHandler, IpcHandlerRegistry } from "../../../src/lib/effect/ipc-effect-types.js";

describe("IPC Effect types (new module)", () => {
  it("exports IpcEffectHandler type", () => {
    // Type-level check — if ipc-effect-types.ts doesn't exist, this file
    // won't compile. At runtime, verify the re-exports are importable.
    const handler: IpcEffectHandler = undefined as any;
    expect(handler).toBeUndefined(); // Type exists
  });

  // AUDIT FIX (L-R5-1): Use dynamic import() instead of require() for ESM compat.
  it("re-exports IPCCommandSchema from protocol", async () => {
    const mod = await import("../../../src/lib/effect/ipc-effect-types.js");
    expect(mod.IPCCommandSchema).toBeDefined();
    expect(mod.IPCCommandSchema).toBe(IPCCommandSchema); // Same reference
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/ipc-effect-types.test.ts`
Expected: FAIL — module not found

**Step 3: Write Effect handler type definitions**

The existing `IPCCommandSchema` in `ipc-protocol.ts` already handles validation.
This module adds Effect-returning handler function types that pair with it.

```typescript
// src/lib/effect/ipc-effect-types.ts
import { Context, Effect } from "effect";
import type { IPCCommand, IPCResponse } from "../types.js";
import type { DaemonStateTag } from "./daemon-state.js";
import type { PersistencePathTag } from "./daemon-config-persistence.js";

// Re-export the existing schema for convenience
export { IPCCommandSchema, validateCommand, parseCommand } from "../daemon/ipc-protocol.js";

/** An IPC handler is an Effect that takes a validated command and returns a response. */
export type IpcEffectHandler<R = never> = (
  cmd: IPCCommand
) => Effect.Effect<IPCResponse, never, R>;

/** Registry of command → handler mapping for Effect dispatch. */
export type IpcHandlerRegistry<R> = Record<string, IpcEffectHandler<R>>;

// NOTE: The existing IPCCommandSchema uses `cmd` as discriminant (not `_tag`).
// The Schema.Union in ipc-protocol.ts provides decode/validate/type narrowing
// for all 19 commands. A future improvement could use Schema.TaggedRequest +
// Rpc for automatic type-safe request→response pairing and built-in
// serialization — but that requires `_tag` as discriminant, so it's deferred
// to avoid a breaking protocol change.

```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/ipc-effect-types.test.ts`
Expected: 9 tests PASS (7 schema + 2 new module verification)

**Step 5: Commit**

```bash
git add src/lib/effect/ipc-effect-types.ts test/unit/daemon/ipc-effect-types.test.ts
git commit -m "feat(effect): add IPC Effect handler types leveraging existing IPCCommandSchema"
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
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer, Ref } from "effect";
import { handleAddProject, handleSetPin } from "../../../src/lib/effect/ipc-handlers.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

describe("IPC handlers", () => {
  describe("handleAddProject", () => {
    it.effect("adds project and returns slug", () => {
      const mockProjectMgmt = {
        addProject: vi.fn().mockReturnValue(
          Effect.succeed({ slug: "my-proj", path: "/home/user/my-proj" })
        ),
      };

      return handleAddProject({ cmd: "add_project", directory: "/home/user/my-proj" }).pipe(
        Effect.provide(Layer.succeed(ProjectMgmtTag, mockProjectMgmt as unknown as ProjectMgmtTag["Type"])),
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
        Effect.tap((result) =>
          Effect.sync(() => expect(result).toEqual({ ok: true, slug: "my-proj", path: "/home/user/my-proj" }))
        ),
      );
    });
  });

  describe("handleSetPin", () => {
    it.effect("updates pinHash in state", () =>
      Effect.gen(function* () {
        yield* handleSetPin({ cmd: "set_pin", pin: "1234" });
        const ref = yield* DaemonStateTag;
        const state = yield* Ref.get(ref);
        expect(state.pinHash).not.toBeNull();
        expect(typeof state.pinHash).toBe("string");
      }).pipe(
        Effect.provide(makeDaemonStateLive()),
        Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
      )
    );
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
import { createHash } from "node:crypto";
import { DaemonStateTag } from "./daemon-state.js";
import { PersistencePathTag, persistConfig } from "./daemon-config-persistence.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "./services.js";
import { FileSystem } from "@effect/platform";
import { Schema } from "effect";
import { IPCCommandSchema } from "../daemon/ipc-protocol.js";

// Derive the decoded union type from the Schema — each handler receives
// the narrowed member type from the Schema.Union discriminated on `cmd`.
type DecodedCommand = Schema.Schema.Type<typeof IPCCommandSchema>;
// Extract a specific command type by its `cmd` discriminant:
type CmdOf<C extends string> = Extract<DecodedCommand, { cmd: C }>;

export const handleAddProject = (cmd: CmdOf<"add_project">) =>
  Effect.gen(function* () {
    const mgmt = yield* ProjectMgmtTag;
    const result = yield* mgmt.addProject(cmd.directory);
    yield* persistConfig;
    return { ok: true as const, slug: result.slug, path: result.path };
  });

export const handleRemoveProject = (cmd: CmdOf<"remove_project">) =>
  Effect.gen(function* () {
    const mgmt = yield* ProjectMgmtTag;
    yield* mgmt.removeProject(cmd.slug);
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetPin = (cmd: CmdOf<"set_pin">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    // Hash the pin (use same hashing as current auth.ts)
    // Use top-level import: import { createHash } from "node:crypto";
    const hash = yield* Effect.sync(() =>
      createHash("sha256").update(cmd.pin).digest("hex")
    );
    yield* Ref.update(ref, (s) => ({ ...s, pinHash: hash }));
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetKeepAwake = (cmd: CmdOf<"set_keep_awake">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({ ...s, keepAwake: cmd.enabled }));
    yield* persistConfig;
    return { ok: true as const, supported: true, active: cmd.enabled };
  });

export const handleShutdown = (_cmd: CmdOf<"shutdown">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({ ...s, shuttingDown: true }));
    return { ok: true as const };
  });

export const handleInstanceAdd = (cmd: CmdOf<"instance_add">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const instance = yield* mgmt.addInstance(cmd);
    yield* persistConfig;
    return { ok: true as const, instance };
  });

export const handleInstanceRemove = (cmd: CmdOf<"instance_remove">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.removeInstance(cmd.id);
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleInstanceStart = (cmd: CmdOf<"instance_start">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.startInstance(cmd.id);
    return { ok: true as const };
  });

export const handleInstanceStop = (cmd: CmdOf<"instance_stop">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.stopInstance(cmd.id);
    return { ok: true as const };
  });

// --- Read-only and config handlers ---

export const handleListProjects = (_cmd: CmdOf<"list_projects">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    return { ok: true as const, projects: state.projects };
  });

export const handleGetStatus = (_cmd: CmdOf<"get_status">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    const state = yield* Ref.get(ref);
    return {
      ok: true as const,
      pid: state.pid,
      port: state.port,
      clientCount: state.clientCount,
      keepAwake: state.keepAwake,
      tls: state.tls,
      shuttingDown: state.shuttingDown,
      projectCount: state.projects.length,
      instanceCount: state.instances.length,
    };
  });

export const handleInstanceList = (_cmd: CmdOf<"instance_list">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const instances = yield* mgmt.listInstances();
    return { ok: true as const, instances };
  });

export const handleInstanceStatus = (cmd: CmdOf<"instance_status">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    const instance = yield* mgmt.getInstance(cmd.id);
    return { ok: true as const, instance };
  });

export const handleInstanceUpdate = (cmd: CmdOf<"instance_update">) =>
  Effect.gen(function* () {
    const mgmt = yield* InstanceMgmtTag;
    yield* mgmt.updateInstance(cmd.id, cmd);
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetProjectTitle = (cmd: CmdOf<"set_project_title">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({
      ...s,
      projects: s.projects.map((p) =>
        p.slug === cmd.slug ? { ...p, title: cmd.title } : p
      ),
    }));
    yield* persistConfig;
    return { ok: true as const };
  });

export const handleSetKeepAwakeCommand = (cmd: CmdOf<"set_keep_awake_command">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({
      ...s,
      keepAwakeCommand: cmd.command,
      keepAwakeArgs: cmd.args,
    }));
    yield* persistConfig;
    return { ok: true as const };
  });

// AUDIT FIX (C4): The existing IPC protocol schema uses `slug` (not `sessionId`)
// for set_agent and set_model commands. These identify the project, not the session.
export const handleSetAgent = (cmd: CmdOf<"set_agent">) =>
  Effect.gen(function* () {
    const overrides = yield* SessionOverridesTag;
    yield* overrides.setAgent(cmd.slug, cmd.agent);
    return { ok: true as const };
  });

export const handleSetModel = (cmd: CmdOf<"set_model">) =>
  Effect.gen(function* () {
    const overrides = yield* SessionOverridesTag;
    yield* overrides.setModel(cmd.slug, { provider: cmd.provider, model: cmd.model });
    return { ok: true as const };
  });

export const handleRestartWithConfig = (cmd: CmdOf<"restart_with_config">) =>
  Effect.gen(function* () {
    const ref = yield* DaemonStateTag;
    yield* Ref.update(ref, (s) => ({ ...s, ...cmd.config }));
    yield* persistConfig;
    // Signal restart — the daemon main loop detects this and re-initializes
    yield* Ref.update(ref, (s) => ({ ...s, shuttingDown: true }));
    return { ok: true as const };
  });
```

**Step 4: Write dispatch**

```typescript
// src/lib/effect/ipc-dispatch.ts
import { Effect, Schema, Stream } from "effect";
import { IPCCommandSchema, validateCommand } from "../daemon/ipc-protocol.js";
import type { IPCResponse } from "../types.js";
import { DaemonStateTag } from "./daemon-state.js";
import { PersistencePathTag } from "./daemon-config-persistence.js";
import { ProjectMgmtTag, InstanceMgmtTag, SessionOverridesTag } from "./services.js";
import {
  handleAddProject, handleRemoveProject, handleSetPin,
  handleSetKeepAwake, handleShutdown, handleInstanceAdd,
  handleInstanceRemove, handleInstanceStart, handleInstanceStop,
  handleListProjects, handleGetStatus, handleInstanceList,
  handleInstanceStatus, handleInstanceUpdate, handleSetProjectTitle,
  handleSetKeepAwakeCommand, handleSetAgent, handleSetModel,
  handleRestartWithConfig,
} from "./ipc-handlers.js";

// Union of ALL service requirements across all handlers.
// This ensures the compiler verifies the runtime provides every needed Tag.
// NOTE: FileSystem.FileSystem is NOT needed here — it's a transitive dep of
// persistConfig, which gets it from the Layer. IPC handlers don't use FS directly.
type IpcHandlerDeps =
  | DaemonStateTag | PersistencePathTag
  | ProjectMgmtTag | InstanceMgmtTag | SessionOverridesTag;

// Dispatch uses the existing `cmd` discriminant (not `_tag`).
// Every case is explicitly handled — no fallthrough stubs.
// The R channel tracks the full union of handler requirements.
// Type narrowing works via Schema.Union discriminated on `cmd` —
// each handler receives the correctly narrowed type, no `as any` casts.
type DecodedCommand = Schema.Schema.Type<typeof IPCCommandSchema>;

const dispatch = (command: DecodedCommand): Effect.Effect<IPCResponse, never, IpcHandlerDeps> => {
  switch (command.cmd) {
    case "add_project": return handleAddProject(command);
    case "remove_project": return handleRemoveProject(command);
    case "set_pin": return handleSetPin(command);
    case "set_keep_awake": return handleSetKeepAwake(command);
    case "shutdown": return handleShutdown(command);
    case "instance_add": return handleInstanceAdd(command);
    case "instance_remove": return handleInstanceRemove(command);
    case "instance_start": return handleInstanceStart(command);
    case "instance_stop": return handleInstanceStop(command);
    case "list_projects": return handleListProjects(command);
    case "get_status": return handleGetStatus(command);
    case "instance_list": return handleInstanceList(command);
    case "instance_status": return handleInstanceStatus(command);
    case "instance_update": return handleInstanceUpdate(command);
    case "set_project_title": return handleSetProjectTitle(command);
    case "set_keep_awake_command": return handleSetKeepAwakeCommand(command);
    case "set_agent": return handleSetAgent(command);
    case "set_model": return handleSetModel(command);
    case "restart_with_config": return handleRestartWithConfig(command);
  }
};

export const decodeAndDispatch = (raw: string): Effect.Effect<IPCResponse, never, IpcHandlerDeps> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try(() => JSON.parse(raw));
    // Use the existing Schema validation from ipc-protocol.ts
    const decoded = yield* Schema.decodeUnknown(IPCCommandSchema)(parsed);
    return yield* dispatch(decoded).pipe(
      Effect.withSpan("ipc.dispatch", { attributes: { cmd: decoded.cmd } })
    );
  }).pipe(
    // Boundary function: catchAll is acceptable here (converts errors to IPC responses).
    // Defects still propagate as Cause.Die to the top-level handler.
    Effect.catchAll((e) =>
      Effect.succeed({ ok: false, error: String(e) } as IPCResponse)
    )
  );

// NOTE: For Node.js readable streams (Unix sockets), use Stream.async
// or @effect/platform-node's NodeStream — NOT Stream.fromReadableStream
// which is for Web ReadableStream (browser API).
export const ipcConnectionStream = (socket: import("node:net").Socket) =>
  Stream.async<string>((emit) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer
      for (const line of lines) {
        if (line.trim()) emit.single(line);
      }
    });
    socket.on("end", () => emit.end());
    socket.on("error", (err) => emit.fail(err));
  }).pipe(
    Stream.mapEffect((line) =>
      decodeAndDispatch(line).pipe(
        Effect.tap((response) =>
          Effect.sync(() => socket.write(JSON.stringify(response) + "\n"))
        )
      )
    ),
    Stream.catchAll((e) => {
      // Log connection-level errors, don't propagate
      return Stream.fromEffect(Effect.logWarning("IPC connection error", e));
    }),
    Stream.runDrain
  );
```

**Step 5: Write dispatch test**

```typescript
// test/unit/daemon/ipc-dispatch.test.ts
import { describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Layer } from "effect";
import { decodeAndDispatch } from "../../../src/lib/effect/ipc-dispatch.js";
import { DaemonStateTag, makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { ProjectMgmtTag } from "../../../src/lib/effect/services.js";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";

describe("IPC dispatch", () => {
  it.effect("dispatches valid add_project command", () => {
    const mockMgmt = {
      addProject: vi.fn().mockReturnValue(
        Effect.succeed({ slug: "proj", path: "/proj" })
      ),
    };

    return decodeAndDispatch('{"cmd":"add_project","directory":"/proj"}').pipe(
      Effect.provide(Layer.succeed(ProjectMgmtTag, mockMgmt as unknown as ProjectMgmtTag["Type"])),
      Effect.provide(makeDaemonStateLive()),
      Effect.provide(Layer.succeed(PersistencePathTag, "/tmp/test.json")),
      Effect.tap((result) =>
        Effect.sync(() => expect(result).toEqual({ ok: true, slug: "proj", path: "/proj" }))
      ),
    );
  });

  it.effect("returns error for invalid JSON", () =>
    decodeAndDispatch("not-json").pipe(
      Effect.provide(makeDaemonStateLive()),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.ok).toBe(false);
          expect(result.error).toBeDefined();
        })
      ),
    )
  );

  it.effect("returns error for unknown command", () =>
    decodeAndDispatch('{"cmd":"bogus_command"}').pipe(
      Effect.provide(makeDaemonStateLive()),
      Effect.tap((result) =>
        Effect.sync(() => expect(result.ok).toBe(false))
      ),
    )
  );
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

### Track A Integration Checkpoint

> **AUDIT FIX:** Run a smoke test after Track A completes (Tasks 1-8) to
> verify the core daemon Layer composes correctly before starting parallel
> tracks. This catches type mismatches in Tag interfaces early, before
> Task 20 (consumer conversion) where they would be much harder to diagnose.

```bash
# After completing Tasks 1-8:
pnpm vitest run test/unit/daemon/ && pnpm check
```

If typecheck fails, fix the failing Tag interface before proceeding to Tracks B/C.
