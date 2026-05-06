# Phase 8: Complete Effect Migration of Daemon Entry Point — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all imperative code from `startDaemonProcess` so it becomes `Layer.launch(makeDaemonLive(options))` — zero mutable variables, zero closures, zero imperative class instances.

**Architecture:** Extract mutable state to `Ref<DaemonRuntimeConfig>` (keystone), then incrementally convert each imperative service to an Effect Layer. Services access dependencies via Context Tags, not closure capture. `DaemonLiveOptions` disappears — `makeDaemonLive` takes `DaemonOptions` directly.

**Tech Stack:** effect 3.21.2, @effect/platform 0.96.1, @effect/platform-node 0.106.0, @effect/vitest, vitest. See `docs/plans/effect-ts-next-wave/conventions.md` — read ONCE before starting.

**Design doc:** `docs/plans/2026-05-07-daemon-effect-phase8-design.md`

**Branch:** Create `feature/effect-phase8` (worktree at `.worktrees/effect-phase8/`).

**Conventions:** See `docs/plans/effect-ts-next-wave/conventions.md` — read ONCE before starting. Key rules:
- `Data.TaggedError` for all errors; expose in `E` type parameter
- `@effect/vitest` with `it.effect` / `it.scoped`; `Layer.fresh()` for stateful tests
- `Effect.forkScoped` for background fibers (not `forkDaemon`)
- `Effect.annotateLogs("entityId", id)` for structured logging
- `Context.Tag` + `Layer.effect/scoped` pattern for service definitions

**Prerequisites:** All Phase 7 tasks completed and merged to main. Run `pnpm check && pnpm test:unit` to verify clean baseline.

---

## Task Dependency Graph

```
Task 1 (DaemonConfigRef) ← keystone
  │
  ├─ Task 2 (ConfigPersistence)  ─┐
  ├─ Task 3 (background svc)      │ parallel after Task 1
  ├─ Task 4 (CrashCounter/Auth)   │
  ├─ Task 5 (TLS)                ─┘
  │
  Task 6 (ProjectRegistry) ← needs Task 2
  │
  Task 7 (InstanceManager) ← needs Task 6
  │
  ├─ Task 8 (IPC handlers)    ─┐
  ├─ Task 9 (Relay factory)    │ parallel after Task 7
  ├─ Task 10 (WS/discovery)   ─┘
  │
  Task 11 (eliminate DaemonLiveOptions) ← needs Tasks 3-10
  │
  Task 12 (Layer.launch) ← needs Task 11
```

---

## Task 1: Extract Mutable Daemon State to DaemonConfigRef

**Goal:** Replace the 8 core mutable `let` variables in `daemon-main.ts` (lines 337-344, 359) with a single `Ref<DaemonRuntimeConfig>` accessible via `DaemonConfigRefTag`. This is the keystone — once done, closures that capture mutable state can be converted to Effects that read/update the Ref.

**Files:**
- Create: `src/lib/effect/daemon-config-ref.ts`
- Test: `test/unit/effect/daemon-config-ref.test.ts`
- Modify: `src/lib/effect/daemon-main.ts` (replace `let` declarations with Ref reads/writes)

**Step 1: Write the failing tests**

```typescript
// test/unit/effect/daemon-config-ref.test.ts
import { describe, expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import {
  DaemonConfigRefTag,
  DaemonConfigRefLive,
  type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";

describe("DaemonConfigRef", () => {
  const defaults: DaemonRuntimeConfig = {
    port: 2633,
    host: "127.0.0.1",
    pinHash: null,
    tlsEnabled: false,
    keepAwake: false,
    keepAwakeCommand: undefined,
    keepAwakeArgs: undefined,
    shuttingDown: false,
    dismissedPaths: new Set(),
  };

  const testLayer = DaemonConfigRefLive(defaults);

  it.effect("provides Ref with initial config", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonConfigRefTag;
      const config = yield* Ref.get(ref);
      expect(config.port).toBe(2633);
      expect(config.host).toBe("127.0.0.1");
      expect(config.pinHash).toBeNull();
      expect(config.tlsEnabled).toBe(false);
      expect(config.shuttingDown).toBe(false);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
  );

  it.effect("updates config via Ref.update", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonConfigRefTag;
      yield* Ref.update(ref, (c) => ({ ...c, port: 3000, tlsEnabled: true }));
      const config = yield* Ref.get(ref);
      expect(config.port).toBe(3000);
      expect(config.tlsEnabled).toBe(true);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
  );

  it.effect("seeds from DaemonOptions with overrides", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonConfigRefTag;
      const config = yield* Ref.get(ref);
      expect(config.keepAwake).toBe(true);
      expect(config.pinHash).toBe("abc123");
    }).pipe(
      Effect.provide(
        Layer.fresh(
          DaemonConfigRefLive({
            ...defaults,
            keepAwake: true,
            pinHash: "abc123",
          }),
        ),
      ),
    ),
  );

  it.effect("dismissedPaths is an independent Set per instance", () =>
    Effect.gen(function* () {
      const ref = yield* DaemonConfigRefTag;
      yield* Ref.update(ref, (c) => ({
        ...c,
        dismissedPaths: new Set([...c.dismissedPaths, "/foo"]),
      }));
      const config = yield* Ref.get(ref);
      expect(config.dismissedPaths.has("/foo")).toBe(true);
    }).pipe(Effect.provide(Layer.fresh(testLayer))),
  );
});
```

**Step 2: Run tests to verify they fail**

```bash
pnpm vitest run test/unit/effect/daemon-config-ref.test.ts -v
```

Expected: FAIL — module `daemon-config-ref.js` does not exist.

**Step 3: Implement DaemonConfigRef**

```typescript
// src/lib/effect/daemon-config-ref.ts
import { Context, Effect, Layer, Ref } from "effect";

export interface DaemonRuntimeConfig {
  readonly port: number;
  readonly host: string;
  readonly pinHash: string | null;
  readonly tlsEnabled: boolean;
  readonly keepAwake: boolean;
  readonly keepAwakeCommand: string | undefined;
  readonly keepAwakeArgs: string[] | undefined;
  readonly shuttingDown: boolean;
  readonly dismissedPaths: ReadonlySet<string>;
}

export class DaemonConfigRefTag extends Context.Tag("DaemonConfigRef")<
  DaemonConfigRefTag,
  Ref.Ref<DaemonRuntimeConfig>
>() {}

export const DaemonConfigRefLive = (initial: DaemonRuntimeConfig) =>
  Layer.effect(DaemonConfigRefTag, Ref.make(initial));

/** Convenience: build initial config from DaemonOptions + disk state. */
export const makeDaemonConfigFromOptions = (options: {
  port?: number;
  host?: string;
  pinHash?: string;
  tlsEnabled?: boolean;
  keepAwake?: boolean;
  keepAwakeCommand?: string;
  keepAwakeArgs?: string[];
  dismissedPaths?: string[];
}): DaemonRuntimeConfig => ({
  port: options.port ?? 2633,
  host: options.host ?? "127.0.0.1",
  pinHash: options.pinHash ?? null,
  tlsEnabled: options.tlsEnabled ?? false,
  keepAwake: options.keepAwake ?? false,
  keepAwakeCommand: options.keepAwakeCommand,
  keepAwakeArgs: options.keepAwakeArgs,
  shuttingDown: false,
  dismissedPaths: new Set(options.dismissedPaths ?? []),
});
```

**Step 4: Run tests to verify they pass**

```bash
pnpm vitest run test/unit/effect/daemon-config-ref.test.ts -v
```

Expected: 4 tests PASS.

**Step 5: Verify no regressions**

```bash
pnpm check && pnpm test:unit
```

**Step 6: Commit**

```bash
git add src/lib/effect/daemon-config-ref.ts test/unit/effect/daemon-config-ref.test.ts
git commit -m "feat(effect): add DaemonConfigRefTag — typed Ref for mutable daemon state"
```

**Step 7: Wire DaemonConfigRefLive into makeDaemonLive**

In `src/lib/effect/daemon-layers.ts`, add `DaemonConfigRefLive` to the composed layer in `makeDaemonLive`. For now, seed it from the existing `DaemonLiveOptions` fields. This is a non-breaking addition — existing consumers don't change yet.

Add to the composed layer after `PinoLoggerLive`:

```typescript
import { DaemonConfigRefLive, makeDaemonConfigFromOptions } from "./daemon-config-ref.js";

// Inside makeDaemonLive, after composing infraLayer + serversLayer + stateLayer:
const configRefLayer = DaemonConfigRefLive(
  makeDaemonConfigFromOptions({
    port: options.ctx.port,
    host: options.ctx.host,
    pinHash: undefined, // will be set by AuthManager layer later
    tlsEnabled: false,  // will be set by TLS layer later
  })
);

// Add to composition:
composed = composed.pipe(Layer.provideMerge(configRefLayer));
```

**Step 8: Verify build and tests**

```bash
pnpm check && pnpm test:unit
```

**Step 9: Commit**

```bash
git add src/lib/effect/daemon-layers.ts
git commit -m "feat(effect): wire DaemonConfigRefLive into makeDaemonLive composition"
```

---

## Task 2: Convert Config Persistence to Effect Layer

**Goal:** Replace the imperative `persistConfig()` / `flushConfigSave()` closures (daemon-main.ts lines 368-429) with a `ConfigPersistenceLive` Layer that subscribes to `DaemonEventBus` for change events and writes config to disk using a debounced fiber.

**Files:**
- Create: `src/lib/effect/config-persistence-layer.ts`
- Test: `test/unit/effect/config-persistence-layer.test.ts`
- Modify: `src/lib/effect/daemon-pubsub.ts` (add `ConfigChanged` event variant)

**Step 1: Add ConfigChanged event to DaemonEvent**

In `src/lib/effect/daemon-pubsub.ts`, add a `ConfigChanged` variant to the `DaemonEvent` TaggedEnum:

```typescript
export type DaemonEvent = Data.TaggedEnum<{
  // ... existing variants ...
  ConfigChanged: {};  // signals that config should be persisted
}>;
```

Add a publish helper:

```typescript
export const publishConfigChanged = Effect.gen(function* () {
  const bus = yield* DaemonEventBusTag;
  yield* PubSub.publish(bus, DaemonEvent.ConfigChanged({}));
});
```

**Step 2: Write the failing tests**

```typescript
// test/unit/effect/config-persistence-layer.test.ts
import { describe, expect } from "@effect/vitest";
import { Duration, Effect, Layer, PubSub, Ref, TestClock } from "effect";
import {
  ConfigPersistenceLive,
  ConfigWriterTag,
} from "../../../src/lib/effect/config-persistence-layer.js";
import {
  DaemonConfigRefTag,
  DaemonConfigRefLive,
  type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";
import {
  DaemonEventBusTag,
  DaemonEventBusLive,
  DaemonEvent,
} from "../../../src/lib/effect/daemon-pubsub.js";

describe("ConfigPersistenceLive", () => {
  const defaults: DaemonRuntimeConfig = {
    port: 2633,
    host: "127.0.0.1",
    pinHash: null,
    tlsEnabled: false,
    keepAwake: false,
    keepAwakeCommand: undefined,
    keepAwakeArgs: undefined,
    shuttingDown: false,
    dismissedPaths: new Set(),
  };

  // Mock writer that records calls
  const makeTestLayer = () => {
    const writes: unknown[] = [];
    const writerLayer = Layer.succeed(ConfigWriterTag, {
      write: (config: unknown) =>
        Effect.sync(() => {
          writes.push(config);
        }),
    });
    const baseLayer = Layer.mergeAll(
      DaemonConfigRefLive(defaults),
      DaemonEventBusLive,
      writerLayer,
    );
    return {
      layer: ConfigPersistenceLive.pipe(Layer.provide(baseLayer)),
      writes,
    };
  };

  it.scoped("writes config to disk on ConfigChanged event", () =>
    Effect.gen(function* () {
      const { layer, writes } = makeTestLayer();
      yield* Layer.build(layer);
      const bus = yield* DaemonEventBusTag;
      yield* PubSub.publish(bus, DaemonEvent.ConfigChanged({}));
      yield* TestClock.adjust(Duration.millis(600));
      expect(writes.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(Layer.fresh(DaemonEventBusLive))),
  );
});
```

**Step 3: Implement ConfigPersistenceLive**

```typescript
// src/lib/effect/config-persistence-layer.ts
import { Context, Duration, Effect, Layer, PubSub, Ref, Stream } from "effect";
import { DaemonConfigRefTag, type DaemonRuntimeConfig } from "./daemon-config-ref.js";
import { DaemonEvent, DaemonEventBusTag } from "./daemon-pubsub.js";

export interface ConfigWriter {
  write: (config: DaemonRuntimeConfig) => Effect.Effect<void>;
}

export class ConfigWriterTag extends Context.Tag("ConfigWriter")<
  ConfigWriterTag,
  ConfigWriter
>() {}

export const ConfigPersistenceLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    const configRef = yield* DaemonConfigRefTag;
    const writer = yield* ConfigWriterTag;
    const sub = yield* PubSub.subscribe(bus);

    yield* Effect.forkScoped(
      Stream.fromQueue(sub).pipe(
        Stream.filter((e) => e._tag === "ConfigChanged"),
        Stream.debounce(Duration.millis(500)),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const config = yield* Ref.get(configRef);
            yield* writer.write(config);
          }).pipe(
            Effect.catchAll((e) =>
              Effect.logWarning("Config persistence failed").pipe(
                Effect.annotateLogs("error", String(e)),
              ),
            ),
          ),
        ),
      ),
    );
  }),
);
```

**Step 4: Run tests, verify, commit**

```bash
pnpm vitest run test/unit/effect/config-persistence-layer.test.ts -v
pnpm check && pnpm test:unit
git add -A && git commit -m "feat(effect): add ConfigPersistenceLive — debounced config writer via DaemonEventBus"
```

---

## Task 3: Wire Background Services Through Existing Layers

**Goal:** Delete imperative `VersionChecker`, `StorageMonitor`, `PortScanner`, and `KeepAwake` class instantiations from `daemon-main.ts` (lines 1407-1446). Pass real configs to `makeDaemonLive` instead of `undefined`. Delete corresponding drain calls from `stop()` (lines 776-787).

**Files:**
- Modify: `src/lib/effect/daemon-main.ts` (delete imperative instantiations, pass configs to DaemonLiveOptions)
- Modify: `src/lib/effect/daemon-layers.ts` (verify Layer composition accepts configs)

**Step 1: Read and understand the current state**

Read `src/lib/effect/daemon-main.ts` lines 1173-1210 to see how `DaemonLiveOptions` is constructed. Note which background service configs are currently `undefined` vs provided.

Read `src/lib/effect/daemon-layers.ts` lines 354-369 to see how optional background services are composed.

**Step 2: Pass real configs to makeDaemonLive**

In `daemon-main.ts`, update the `DaemonLiveOptions` construction (around line 1173) to pass real config objects:

```typescript
const daemonLiveOptions: DaemonLiveOptions = {
  // ... existing fields ...
  keepAwake: keepAwake ? {
    command: keepAwakeCommand,
    args: keepAwakeArgs,
  } : undefined,
  versionCheck: {
    enabled: !process.argv.includes("--no-update"),
  },
  storageMon: {
    path: registry.allProjects()[0]?.directory ?? process.cwd(),
  },
  portScanner: smartDefault ? {
    // PortScannerLive config from port-scanner-layer.ts
  } : undefined,
};
```

**Step 3: Delete imperative instantiations**

Delete lines 1407-1446 (imperative `new VersionChecker(...)`, `new KeepAwake(...)`, `new StorageMonitor(...)` instantiations).

Delete event loop monitor `setInterval` (lines 1447-1455) — replace with comment: `// Event loop monitoring handled by Layer`.

**Step 4: Delete drain calls from stop()**

In `stop()` function (lines 764-790), remove:
```typescript
await versionChecker?.drain();
await storageMonitor?.drain();
await scanner?.drain();
```

And remove the null assignments:
```typescript
scanner = null;
versionChecker = null;
storageMonitor = null;
keepAwakeManager = null;
```

Layer finalizers handle cleanup automatically when `daemonRuntime.dispose()` is called.

**Step 5: Delete mutable variable declarations**

Remove these `let` declarations from lines 350-353:
```typescript
let versionChecker: VersionChecker | null = null;
let keepAwakeManager: KeepAwake | null = null;
let storageMonitor: StorageMonitor | null = null;
let scanner: PortScanner | null = null;
```

**Step 6: Verify build and tests**

```bash
pnpm check && pnpm test:unit
```

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor(effect): wire background services through existing Layers, delete imperative instances"
```

---

## Task 4: CrashCounter and AuthManager to Layers

**Goal:** Move `CrashCounter` and `AuthManager` construction into Layers. `CrashCounterTag` already exists in `daemon-startup.ts`. `AuthManagerTag` already exists in `auth-middleware.ts`. Delete imperative instantiation from `daemon-main.ts`.

**Files:**
- Modify: `src/lib/effect/daemon-main.ts` (delete `new CrashCounter()`, `new AuthManager()`)
- Modify: `src/lib/effect/daemon-layers.ts` (add CrashCounter and AuthManager Layers)
- Modify: `src/lib/effect/auth-middleware.ts` (make `AuthManagerLive` read pinHash from DaemonConfigRef)
- Test: `test/unit/effect/auth-manager-layer.test.ts`

**Step 1: Write failing test for AuthManager Layer**

```typescript
// test/unit/effect/auth-manager-layer.test.ts
import { describe, expect } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { AuthManagerTag } from "../../../src/lib/effect/auth-middleware.js";
import {
  DaemonConfigRefTag,
  DaemonConfigRefLive,
  type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";

describe("AuthManagerLive from DaemonConfigRef", () => {
  const withPin: DaemonRuntimeConfig = {
    port: 2633, host: "127.0.0.1", pinHash: "test-hash",
    tlsEnabled: false, keepAwake: false, keepAwakeCommand: undefined,
    keepAwakeArgs: undefined, shuttingDown: false, dismissedPaths: new Set(),
  };

  it.effect("initializes with pinHash from DaemonConfigRef", () =>
    Effect.gen(function* () {
      const auth = yield* AuthManagerTag;
      expect(auth.hasPin()).toBe(true);
    }).pipe(Effect.provide(/* AuthManagerLive composed with DaemonConfigRefLive(withPin) */)),
  );

  it.effect("initializes without pin when pinHash is null", () =>
    Effect.gen(function* () {
      const auth = yield* AuthManagerTag;
      expect(auth.hasPin()).toBe(false);
    }).pipe(Effect.provide(/* AuthManagerLive composed with DaemonConfigRefLive(noPin) */)),
  );
});
```

**Step 2: Update AuthManagerLive to read from DaemonConfigRef**

In `src/lib/effect/auth-middleware.ts`, modify `makeAuthManagerLive` or create a new Layer factory:

```typescript
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { AuthManager } from "../auth.js";

export const AuthManagerFromConfigLive = Layer.effect(
  AuthManagerTag,
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    const config = yield* Ref.get(configRef);
    const auth = new AuthManager();
    if (config.pinHash) auth.setPinHash(config.pinHash);
    return auth;
  }),
);
```

**Step 3: Wire CrashCounter into Layer composition**

`CrashCounterTag` already exists in `daemon-startup.ts` with a full interface. Create a `CrashCounterLive` Layer that constructs from disk state:

```typescript
// In daemon-startup.ts or a new file
export const CrashCounterLive = Layer.effect(
  CrashCounterTag,
  Effect.gen(function* () {
    const counter = new CrashCounterImpl(); // existing class
    return {
      record: () => Effect.sync(() => {
        counter.record();
        return { count: counter.count, shouldAbort: counter.shouldGiveUp() };
      }),
      reset: () => Effect.sync(() => counter.reset()),
    };
  }),
);
```

**Step 4: Delete imperative instantiation from daemon-main.ts**

Remove lines 325-331 (CrashCounter) and 362-363 (AuthManager).

**Step 5: Verify and commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): move CrashCounter and AuthManager to Effect Layers"
```

---

## Task 5: TLS Certificate Loading as a Layer

**Goal:** Convert the imperative TLS cert loading block (daemon-main.ts lines 1055-1082) to a `TlsCertLive` Layer that loads certs and updates `DaemonConfigRefTag`.

**Files:**
- Create: `src/lib/effect/tls-cert-layer.ts`
- Test: `test/unit/effect/tls-cert-layer.test.ts`
- Modify: `src/lib/effect/daemon-layers.ts` (compose TlsCertLive)
- Modify: `src/lib/effect/daemon-main.ts` (delete imperative TLS block)

**Step 1: Define TlsCertTag**

```typescript
// src/lib/effect/tls-cert-layer.ts
import { Context, Data, Effect, Layer, Ref } from "effect";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";

export interface TlsCertService {
  readonly certs: TlsCerts | null;
  readonly caRootPath: string | null;
  readonly caCertDer: Buffer | null;
}

export class TlsCertTag extends Context.Tag("TlsCert")<
  TlsCertTag,
  TlsCertService
>() {}

export class TlsCertLoadError extends Data.TaggedError("TlsCertLoadError")<{
  cause: unknown;
}> {}

export const TlsCertLive = (configDir: string) =>
  Layer.effect(
    TlsCertTag,
    Effect.gen(function* () {
      const configRef = yield* DaemonConfigRefTag;
      const config = yield* Ref.get(configRef);

      if (!config.tlsEnabled) {
        return { certs: null, caRootPath: null, caCertDer: null };
      }

      const certs = yield* Effect.tryPromise({
        try: () => ensureCerts({ configDir }),
        catch: (cause) => new TlsCertLoadError({ cause }),
      }).pipe(
        Effect.catchTag("TlsCertLoadError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("TLS unavailable — falling back to HTTP");
            yield* Ref.update(configRef, (c) => ({ ...c, tlsEnabled: false }));
            return null;
          }),
        ),
      );

      if (certs) {
        yield* Ref.update(configRef, (c) => ({
          ...c,
          host: c.host === "127.0.0.1" ? "0.0.0.0" : c.host,
        }));
      }

      return {
        certs,
        caRootPath: certs?.caRoot ?? null,
        caCertDer: certs?.caCertDer ?? null,
      };
    }),
  );
```

**Step 2: Write tests, implement, verify, commit**

Test with mock `ensureCerts` — verify TLS fallback updates DaemonConfigRef.

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "feat(effect): add TlsCertLive Layer for cert loading with config fallback"
```

---

## Task 6: ProjectRegistry as Effect Service

**Goal:** Replace the `ProjectRegistry` class (EventEmitter-based, imperative state in `src/lib/daemon/project-registry.ts`) with `ProjectRegistryLive` Layer backed by Effect Ref state. Publish events via `DaemonEventBus` instead of EventEmitter callbacks.

**Files:**
- Modify: `src/lib/effect/project-registry-service.ts` (extend existing — `ProjectRegistryTag` already exists)
- Modify: `src/lib/effect/daemon-pubsub.ts` (add `ProjectAdded`, `ProjectRemoved`, `ProjectReady`, `ProjectError` event variants)
- Test: `test/unit/effect/project-registry-service.test.ts`
- Modify: `src/lib/effect/daemon-main.ts` (delete `new ProjectRegistry()` and event listeners)

**Step 1: Extend DaemonEvent with project events**

In `src/lib/effect/daemon-pubsub.ts`, add:

```typescript
export type DaemonEvent = Data.TaggedEnum<{
  // ... existing variants ...
  ProjectAdded: { readonly slug: string };
  ProjectRemoved: { readonly slug: string };
  ProjectReady: { readonly slug: string };
  ProjectError: { readonly slug: string; readonly error: string };
}>;
```

**Step 2: Implement ProjectRegistryLive**

The existing `ProjectRegistryTag` in `project-registry-service.ts` (line 72) is typed to the old `ProjectRegistry` class. Create a new Effect-native service that wraps the same interface but uses `Ref<HashMap>` internally and publishes to `DaemonEventBus`.

Key methods to convert:
- `add(project, createRelay)` → Effect that updates Ref + publishes `ProjectAdded`
- `remove(slug)` → Effect that updates Ref + publishes `ProjectRemoved`
- `startRelay(slug, factory)` → Effect that creates relay, updates entry status, publishes `ProjectReady`
- `broadcastToAll(message)` → Effect that reads Ref and sends to all relays
- `allProjects()` → Effect that reads Ref
- `findByDirectory(dir)` → Effect that reads Ref

**Step 3: Write comprehensive tests**

Test each method: add, remove, startRelay, broadcastToAll, findByDirectory. Test that DaemonEventBus receives correct events. Test concurrent access safety.

**Step 4: Wire into daemon-main.ts**

Replace `const registry = new ProjectRegistry()` and all event listener registrations (lines 366-475) with `ProjectRegistryLive` in the Layer composition.

**Step 5: Verify and commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): convert ProjectRegistry to Effect Layer with Ref state and DaemonEventBus"
```

---

## Task 7: InstanceManager as Effect Service

**Goal:** Replace `InstanceManager` class with `InstanceManagerLive` Layer. Health polling and restart already exist as Effect services from Phase 7 Task 3. This task wires instance add/remove/probe into Effect, replaces EventEmitter with `DaemonEventBus`.

**Files:**
- Modify: `src/lib/effect/instance-manager-service.ts` (extend existing — has state Tags and health polling)
- Test: `test/unit/effect/instance-manager-service.test.ts` (extend existing)
- Modify: `src/lib/effect/daemon-main.ts` (delete `new InstanceManager()` and event listeners)

**Step 1: Add instance lifecycle methods**

The existing `instance-manager-service.ts` has `InstanceManagerStateTag`, `startHealthPoller`, `scheduleRestart`, `cancelInstanceFibers`. Add:

```typescript
export const addInstance = (id: string, config: InstanceConfig) =>
  Effect.gen(function* () {
    const stateRef = yield* InstanceManagerStateTag;
    const now = yield* Clock.currentTimeMillis;
    const instance: OpenCodeInstance = {
      id, ...config, status: "starting", addedAt: now,
    };
    yield* Ref.update(stateRef, (s) => ({
      ...s,
      instances: HashMap.set(s.instances, id, instance),
    }));
    yield* publishInstanceStatusChanged(id);
    return instance;
  });

export const removeInstance = (id: string) =>
  Effect.gen(function* () {
    yield* cancelInstanceFibers(id);
    const stateRef = yield* InstanceManagerStateTag;
    yield* Ref.update(stateRef, (s) => ({
      ...s,
      instances: HashMap.remove(s.instances, id),
    }));
    yield* publishInstanceRemoved(id);
  });

export const getInstances = Effect.gen(function* () {
  const stateRef = yield* InstanceManagerStateTag;
  const state = yield* Ref.get(stateRef);
  return Array.from(HashMap.values(state.instances));
});

export const getInstance = (id: string) =>
  Effect.gen(function* () {
    const stateRef = yield* InstanceManagerStateTag;
    const state = yield* Ref.get(stateRef);
    return HashMap.get(state.instances, id);
  });
```

**Step 2: Convert probe-and-convert logic**

The probe logic (daemon-main.ts lines 882-962) becomes a startup Effect in the Layer's scoped initialization:

```typescript
export const InstanceManagerLive = Layer.scoped(
  InstanceManagerTag,
  Effect.gen(function* () {
    // ... existing state setup ...
    // Rehydrate instances from DaemonState
    // Probe smart default
    // Start health pollers for all instances
    // Return service interface
  }),
);
```

**Step 3: Write tests, implement, verify, commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): convert InstanceManager to Effect Layer with lifecycle methods"
```

---

## Task 8: IPC Handlers as Effect Programs

**Goal:** Convert the 20+ imperative closures in `ipcContext` (daemon-main.ts lines 965-1039) to Effect programs that read services from Context.

**Files:**
- Create: `src/lib/effect/ipc-handlers-effect.ts`
- Test: `test/unit/effect/ipc-handlers-effect.test.ts`
- Modify: `src/lib/effect/daemon-main.ts` (replace imperative ipcContext)

**Step 1: Define IPC handler Effects**

```typescript
// src/lib/effect/ipc-handlers-effect.ts
import { Effect, Ref } from "effect";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";
import { ProjectRegistryTag } from "./project-registry-service.js";
import { InstanceManagerTag } from "./instance-manager-service.js";
import { AuthManagerTag } from "./auth-middleware.js";
import { publishConfigChanged } from "./daemon-pubsub.js";

export const handleAddProject = (directory: string) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistryTag;
    // ... add project logic (from addProject closure)
  });

export const handleRemoveProject = (slug: string) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistryTag;
    const configRef = yield* DaemonConfigRefTag;
    // ... remove project + add to dismissedPaths
    yield* publishConfigChanged;
  });

export const handleSetPinHash = (hash: string) =>
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    const configRef = yield* DaemonConfigRefTag;
    auth.setPinHash(hash);
    yield* Ref.update(configRef, (c) => ({ ...c, pinHash: hash }));
    yield* publishConfigChanged;
  });

export const handleSetKeepAwake = (enabled: boolean) =>
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    yield* Ref.update(configRef, (c) => ({ ...c, keepAwake: enabled }));
    yield* publishConfigChanged;
  });

// ... similar for all other handlers
```

**Step 2: Write tests for each handler**

Test that handlers correctly update state and publish events.

**Step 3: Wire into IPC dispatch**

Replace the imperative `ipcContext` object with an Effect dispatch table. The IPC server Layer calls `runtime.runPromise(handler(args))` for each command.

**Step 4: Verify and commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): convert IPC handlers to Effect programs reading from Context"
```

---

## Task 9: Relay Factory as Effect Service

**Goal:** Convert `buildRelayFactory` (daemon-main.ts lines 556-625) from a closure-capturing function to a `RelayFactoryLive` Layer that accesses dependencies via Context Tags.

**Files:**
- Create: `src/lib/effect/relay-factory-layer.ts`
- Test: `test/unit/effect/relay-factory-layer.test.ts`
- Modify: `src/lib/effect/daemon-layers.ts` (compose RelayFactoryLive)
- Modify: `src/lib/effect/daemon-main.ts` (delete buildRelayFactory)

**Step 1: Define RelayFactoryTag**

```typescript
// src/lib/effect/relay-factory-layer.ts
import { Context, Effect, Layer } from "effect";
import { ProjectRegistryTag } from "./project-registry-service.js";
import { DaemonConfigRefTag } from "./daemon-config-ref.js";

export interface RelayFactory {
  create: (project: StoredProject, opencodeUrl: string) => Effect.Effect<ProjectRelay>;
}

export class RelayFactoryTag extends Context.Tag("RelayFactory")<
  RelayFactoryTag,
  RelayFactory
>() {}

export const RelayFactoryLive = Layer.effect(
  RelayFactoryTag,
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    // ... build factory that reads deps from Context at call time
    return {
      create: (project, opencodeUrl) =>
        Effect.gen(function* () {
          // ... relay construction logic from buildRelayFactory
        }),
    };
  }),
);
```

**Step 2: Write tests, implement, verify, commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): convert relay factory to Effect Layer"
```

---

## Task 10: WebSocket Routing, Project Discovery, Session Prefetch as Scoped Fibers

**Goal:** Convert post-runtime imperative code (WebSocket upgrade handler, project discovery, session prefetch, event loop monitor) to scoped Effect fibers managed by Layers.

**Files:**
- Create: `src/lib/effect/ws-routing-layer.ts`
- Create: `src/lib/effect/project-discovery-layer.ts`
- Test: `test/unit/effect/ws-routing-layer.test.ts`
- Modify: `src/lib/effect/daemon-main.ts` (delete imperative post-runtime code)

**Step 1: WebSocketRoutingLive**

```typescript
// src/lib/effect/ws-routing-layer.ts
export const WebSocketRoutingLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const auth = yield* AuthManagerTag;
    const registry = yield* ProjectRegistryTag;
    const configRef = yield* DaemonConfigRefTag;
    // Get HTTP server from context
    // Attach upgrade handler as scoped resource
    // Handler reads shuttingDown from configRef
  }),
);
```

**Step 2: ProjectDiscoveryLive**

```typescript
// src/lib/effect/project-discovery-layer.ts
export const ProjectDiscoveryLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* ProjectRegistryTag;
    const configRef = yield* DaemonConfigRefTag;
    // Fork scoped fiber that runs once
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        // ... discovery logic from discoverProjects()
      }).pipe(
        Effect.catchAll((e) =>
          Effect.logWarning("Project discovery failed").pipe(
            Effect.annotateLogs("error", String(e)),
          ),
        ),
      ),
    );
  }),
);
```

**Step 3: Verify and commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): convert WS routing, project discovery to scoped Effect fibers"
```

---

## Task 11: Eliminate DaemonLiveOptions and DaemonLifecycleContext

**Goal:** `DaemonLiveOptions` was the bridge between imperative construction and Layer composition. With all services now Layers, delete this interface. `makeDaemonLive` takes `DaemonOptions` directly.

**Files:**
- Modify: `src/lib/effect/daemon-layers.ts` (change `makeDaemonLive` signature, delete `DaemonLiveOptions`)
- Modify: `src/lib/effect/daemon-main.ts` (simplify to pass `DaemonOptions` directly)
- Modify: `src/lib/daemon/daemon-lifecycle.ts` (convert `DaemonLifecycleContext` to Effect Tags)

**Step 1: Change makeDaemonLive signature**

```typescript
// Before:
export const makeDaemonLive = (options: DaemonLiveOptions) => { ... }

// After:
export const makeDaemonLive = (options: DaemonOptions) => {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  const pidPath = options.pidPath ?? join(configDir, "daemon.pid");
  const socketPath = options.socketPath ?? join(configDir, "relay.sock");

  return Layer.mergeAll(
    // Infrastructure
    SignalHandlerLayer,
    ProcessErrorHandlerLayer,
    makePidFileLive(configDir, pidPath, socketPath),
    // Config
    DaemonConfigRefLive(makeDaemonConfigFromOptions(options)),
    // Auth
    AuthManagerFromConfigLive,
    // TLS
    TlsCertLive(configDir),
    // Servers
    HttpServerLive,
    IpcServerLive,
    OnboardingServerLive,
    // Services
    ProjectRegistryLive,
    InstanceManagerLive,
    RelayFactoryLive,
    // IPC
    IpcDispatchLive,
    // Background
    VersionCheckerLive({ enabled: true }),
    StorageMonitorLive({ path: process.cwd() }),
    KeepAwakeLive(options.keepAwake ? { command: options.keepAwakeCommand } : undefined),
    // Wiring
    WebSocketRoutingLive,
    ProjectDiscoveryLive,
    ConfigPersistenceLive,
    // Foundation
    DaemonEventBusLive,
    PinoLoggerLive,
  );
};
```

**Step 2: Delete DaemonLiveOptions interface**

Remove the entire `DaemonLiveOptions` interface from `daemon-layers.ts`.

**Step 3: Convert DaemonLifecycleContext**

Replace the mutable `ctx` object with Tags that server Layers provide:

```typescript
export class HttpServerRefTag extends Context.Tag("HttpServerRef")<
  HttpServerRefTag,
  Ref.Ref<http.Server | null>
>() {}
```

**Step 4: Verify and commit**

```bash
pnpm check && pnpm test:unit
git add -A && git commit -m "refactor(effect): eliminate DaemonLiveOptions — makeDaemonLive takes DaemonOptions directly"
```

---

## Task 12: Collapse startDaemonProcess to Layer.launch

**Goal:** Final task. `startDaemonProcess` becomes a thin shell around `Layer.launch`. Delete ~1200 lines of imperative construction.

**Files:**
- Modify: `src/lib/effect/daemon-main.ts` (massive deletion — target <50 lines)
- Modify: `src/bin/cli-core.ts` (update `--foreground` path to use ManagedRuntime)
- Test: `test/unit/effect/daemon-main.test.ts` (verify Layer.launch works end-to-end)

**Step 1: Replace startDaemonProcess**

```typescript
// src/lib/effect/daemon-main.ts — entire file (simplified)
import { Effect, Layer, ManagedRuntime } from "effect";
import type { DaemonOptions } from "../daemon/daemon-types.js";
import { makeDaemonLive } from "./daemon-layers.js";

export const startDaemonProcess = (options: DaemonOptions) =>
  Effect.runFork(Layer.launch(makeDaemonLive(options)));

// For --foreground mode: returns a handle
export const startDaemonForeground = (options: DaemonOptions) => {
  const runtime = ManagedRuntime.make(makeDaemonLive(options));
  return runtime;
};
```

**Step 2: Update cli-core.ts**

The `--daemon` path (cli-core.ts line 122) calls `startDaemonProcess`. Update to use the new thin version.

The `--foreground` path (cli-core.ts lines 162-176) needs a `DaemonHandle`. Create a `DaemonHandleTag` service that provides the handle interface, accessible via the runtime.

**Step 3: Delete all dead code**

Delete everything that was between the old function signature and the Layer.launch call:
- All `let` declarations (lines 337-370)
- CrashCounter instantiation (lines 325-331)
- AuthManager instantiation (lines 362-363)
- InstanceManager instantiation (lines 365-535)
- ProjectRegistry instantiation (lines 366-475)
- Config persistence closures (lines 368-429)
- All helper functions (lines 537-761)
- stop() function (lines 764-790)
- DaemonLifecycleContext (lines 793-804)
- Config rehydration (lines 806-880)
- Probe-and-convert (lines 882-962)
- IPC context (lines 965-1039)
- TLS loading (lines 1055-1082)
- HTTP router (lines 1089-1160)
- DaemonLiveOptions construction (lines 1173-1210)
- WebSocket routing (lines 1216-1270)
- Port scanner (lines 1269-1329)
- Session prefetch (lines 1337-1370)
- Project discovery (lines 1389-1512)
- Background services (lines 1407-1446)
- Event loop monitor (lines 1447-1455)
- DaemonHandle return (lines 1519-1539)

**Step 4: Write end-to-end Layer test**

```typescript
// test/unit/effect/daemon-main.test.ts
describe("Daemon lifecycle via Layer.launch", () => {
  it.scoped("starts and stops cleanly", () =>
    Effect.gen(function* () {
      // Provide test layers with mock HTTP server, mock IPC
      // Verify services are available
      // Verify cleanup runs on scope close
    }),
  );
});
```

**Step 5: Full verification**

```bash
pnpm check && pnpm test:unit && pnpm build
pnpm test:all  # full suite
```

**Step 6: Manual smoke test**

Start daemon, verify HTTP + WS + IPC work, shut down cleanly via SIGINT.

**Step 7: Commit**

```bash
git add -A && git commit -m "refactor(effect): collapse startDaemonProcess to Layer.launch — complete Phase 8"
```

---

## Verification

After each task:
```bash
pnpm check && pnpm test:unit
```

After Task 12 (final):
```bash
pnpm test:all
```

Smoke test: start daemon, verify HTTP + WS + IPC all work, shut down cleanly.

## Success Criteria

1. `daemon-main.ts` is <50 lines (just `NodeRuntime.runMain` + exports)
2. Zero `let` declarations in daemon startup path
3. Zero imperative class instantiation (`new ClassName()`)
4. Zero closure capture of mutable state
5. All daemon services discoverable via `Context.Tag`
6. All service errors typed in Layer error channels
7. `NodeRuntime.runMain` + `ShutdownSignalTag` handles full lifecycle (startup → signal → teardown)
8. All existing tests pass (`pnpm test:all`)

---

## Audit Amendments (Round 1)

> **For Agent:** These amendments override the corresponding sections above. Read both — the original text provides context, these amendments provide corrections.

### User Decisions (from Ask User findings)

- **PushNotificationManager** → Create `PushManagerLive` Layer (`PushManagerTag` already exists at `push-service.ts:25`)
- **AuthManager pinHash** → **Reactive approach**: AuthManager reads pinHash from `DaemonConfigRef` on every `authenticate()` call, not dual-write
- **Relay factory conversion** → **Full conversion**: `createProjectRelay` itself gets converted to accept Effect services via Context Tags (not imperative shims)

### Task 1 Amendments

**AP-1: Add missing fields to `DaemonRuntimeConfig`:**

```typescript
export interface DaemonRuntimeConfig {
  // ... existing fields from plan ...
  readonly startTime: number;                              // NEW: used by getStatus()
  readonly hostExplicit: boolean;                          // NEW: tracks if user explicitly set --host
  readonly persistedSessionCounts: ReadonlyMap<string, number>; // NEW: used by buildConfig()
}
```

Update `makeDaemonConfigFromOptions` to accept and set these fields. `startTime` defaults to `Date.now()`. `hostExplicit` is `true` when `options.host` is provided. `persistedSessionCounts` defaults to `new Map()`.

Update test defaults to include these three fields.

**AP-2: Step 7 wiring** — `DaemonLifecycleContext` has `port` and `host` fields directly (verified at `daemon-lifecycle.ts:372-373`). The plan's `options.ctx.port` reference is correct.

### Task 2 Amendments

**AP-3: Fix test PubSub wiring.** Replace the test with:

```typescript
it.scoped("writes config to disk on ConfigChanged event", () =>
  Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.ConfigChanged({}));
    yield* TestClock.adjust(Duration.millis(600));
    expect(writes.length).toBeGreaterThanOrEqual(1);
  }).pipe(Effect.provide(Layer.fresh(fullComposedLayer))),
);
```

Where `fullComposedLayer` = `ConfigPersistenceLive.pipe(Layer.provide(Layer.mergeAll(DaemonConfigRefLive(defaults), DaemonEventBusLive, writerLayer)))`. Do NOT create a second `DaemonEventBusLive` in the outer `Effect.provide`.

**AP-4: Fix ConfigWriter mock type.** Change `write: (config: unknown)` to `write: (config: DaemonRuntimeConfig)`. Type `writes` as `DaemonRuntimeConfig[]`.

**AP-5: Note partial implementation.** `ConfigPersistenceLive` initially reads only `DaemonConfigRef`. After Tasks 6-7, update it to also read `ProjectRegistryTag` and `InstanceManagerTag` for the full config (projects list, instances list). Document this as a follow-up step in Task 6.

**AP-6: Add debounce coalescing test.** Add test: publish 5 `ConfigChanged` events in rapid succession, advance TestClock past debounce window, verify `writes.length === 1`.

### Task 3 Amendments

**AP-7: Fix ALL background service config shapes.** The plan's simple config objects are wrong. Replace with:

**VersionCheckerLive** — requires `VersionCheckerConfig`:
```typescript
versionCheck: {
  getCurrentVersion: () => Effect.succeed(getVersion()),
  fetchLatestVersion: () => Effect.tryPromise(() => fetchLatest()),
  broadcast: (latest: string) => Effect.gen(function* () {
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.VersionUpdate({ current: getVersion(), latest }));
  }),
  checkInterval: Duration.hours(1),
},
```

**StorageMonitorLive** — requires `StorageMonitorConfig`:
```typescript
storageMon: {
  getStorageUsage: () => Effect.tryPromise(() => getUsageForPath(path)),
  persistence: { evictOldEvents: () => /* Effect wrapping registry.evictOldestSessions */ },
  checkInterval: Duration.minutes(5),
  highWaterMark: 0.9,
},
```

**PortScannerLive** — requires `PortScannerConfig`. **Defer PortScanner wiring to after Task 7** (needs InstanceManager for `onDiscovered`/`onLost` callbacks). Pass `undefined` for now; wire in Task 7 as a follow-up step.

**AP-8: Preserve `instanceManager.drain()` and `registry.drain()`.** Only delete drain calls for `versionChecker`, `storageMonitor`, `scanner`. Keep `instanceManager.drain()` and `registry.drain()` until Tasks 6-7.

### Task 4 Amendments

**AP-9: Fix CrashCounter.** Change `new CrashCounterImpl()` to `new CrashCounter()` (from `src/lib/daemon/crash-counter.ts:13`). Change `counter.count` to `counter.getTimestamps().length`.

**AP-10: Wire both Layers into `makeDaemonLive`.** Add explicit step: compose `CrashCounterLive` and `AuthManagerFromConfigLive` into `makeDaemonLive` in `daemon-layers.ts` using `Layer.provideMerge`. `AuthManagerFromConfigLive` needs `DaemonConfigRefTag` — compose after `DaemonConfigRefLive`.

**AP-11: AuthManager reactive pinHash (user decision).** Instead of dual-write, modify `AuthManager` class to accept a `Ref<DaemonRuntimeConfig>` and read `pinHash` from it on every `authenticate()` call:

```typescript
export const AuthManagerFromConfigLive = Layer.effect(
  AuthManagerTag,
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    return new AuthManager({ configRef }); // AuthManager reads pinHash reactively
  }),
);
```

This requires modifying `src/lib/auth.ts` to accept a Ref and call `Ref.get` (synchronous via `Effect.runSync`) in `authenticate()`. The IPC `setPinHash` handler only updates `DaemonConfigRef` — no separate `auth.setPinHash()` call needed.

### Task 5 Amendments

**AP-12: Add `hostExplicit` guard.** Replace `c.host === "127.0.0.1" ? "0.0.0.0" : c.host` with:
```typescript
if (certs && !config.hostExplicit) {
  yield* Ref.update(configRef, (c) => ({ ...c, host: "0.0.0.0" }));
}
```
Requires `hostExplicit` field from Task 1 AP-1.

**AP-13: Add `caCertPem` to `TlsCertService`.** Add `readonly caCertPem: Buffer | null` to the interface. HTTP server layer needs it for cert chain.

**AP-14: Add import.** Add `import { ensureCerts, type TlsCerts } from "../cli/tls.js";` to code snippet.

**AP-15: Handle `ensureCerts` returning `null`.** `ensureCerts` returns `null` (not throws) for most failures. Add after tryPromise:
```typescript
if (!certs) {
  yield* Effect.logWarning("TLS unavailable — mkcert not found, falling back to HTTP");
  yield* Ref.update(configRef, (c) => ({ ...c, tlsEnabled: false }));
  return { certs: null, caRootPath: null, caCertDer: null, caCertPem: null };
}
```

**AP-16: Specify Layer composition order.** Insert `TlsCertLive(configDir)` in `makeDaemonLive` after `DaemonConfigRefLive` and before `serversLayer`. Use `Layer.provideMerge`.

**AP-17: Add 5 test cases.** (a) TLS disabled → null certs, no `ensureCerts` call; (b) enabled, returns null → `tlsEnabled: false` in Ref; (c) enabled, throws → catch, log, `tlsEnabled: false`; (d) enabled, succeeds, host not explicit → host updated to `0.0.0.0`; (e) enabled, succeeds, host explicit → host NOT changed. Use `EnsureCertsTag` service for DI (more Effect-idiomatic than `vi.mock`).

### Task 6 Amendments — MAJOR REWRITE

**AP-18: Task 6 is already implemented.** `src/lib/effect/project-registry-service.ts` (495 lines) has a complete Effect-native ProjectRegistry with `Ref<HashMap>`, all CRUD operations, DaemonEventBus integration.

**Rewrite Task 6 as: "Wire ProjectRegistry Layer + Fill Gaps"**

Steps:
1. **Verify** existing `project-registry-service.ts` covers all `daemon-main.ts` consumers (read all `registry.*` calls)
2. **Do NOT add** `ProjectAdded/ProjectRemoved/ProjectReady/ProjectError` events — existing `InstanceAdded/InstanceRemoved/InstanceStatusChanged` events are already used by the service
3. **Add missing methods**: `broadcastToAll` (publish `RelayBroadcast` event), `waitForRelay` (using `Deferred` or polling), `evictOldestSessions`, `replaceRelay`
4. **Wire** `makeProjectRegistryLive` into `makeDaemonLive` in `daemon-layers.ts`
5. **Delete** imperative `new ProjectRegistry()` and all event listeners from `daemon-main.ts`
6. **Update ConfigPersistenceLive** (Task 2 follow-up) to also read `ProjectRegistryTag` for project list

### Task 7 Amendments — MAJOR REWRITE

**AP-19: Task 7 is already implemented.** `src/lib/effect/instance-manager-service.ts` (416 lines) has `addInstance`, `removeInstance`, `getInstance`, `getInstances`, health polling, restart, FiberMap-based fiber management.

**Rewrite Task 7 as: "Wire InstanceManager Layer + Fill Gaps + Bridge"**

Steps:
1. **Verify** existing `instance-manager-service.ts` covers all `daemon-main.ts` consumers
2. **Do NOT re-implement** `addInstance`, `removeInstance`, etc. — they already exist
3. **Create `InstanceMgmtLive`** Layer that adapts the existing Effect functions to the `InstanceMgmtTag` interface (from `services.ts:262`) — this Tag is used by 10+ consumers (ipc-handlers, daemon-startup, ipc-dispatch)
4. **Wire** `makeInstanceManagerStateLive` + `InstanceMgmtLive` into `makeDaemonLive`
5. **Wire PortScanner** (deferred from Task 3 AP-7): now that InstanceManager is a Layer, construct `PortScannerConfig.onDiscovered/onLost` callbacks that call InstanceManager via Tags
6. **Decoupling**: Use `DaemonEventBus` for instance→registry wiring (subscribe to `InstanceStatusChanged`, reset error-state projects) — avoids circular Layer dependency
7. **Delete** imperative `new InstanceManager()` and event listeners from `daemon-main.ts`
8. **Add `PushManagerLive`** Layer (user decision: create Layer using existing `PushManagerTag` from `push-service.ts:25`)

### Task 8 Amendments

**AP-20: Add IPC dispatch bridge.** Create `IpcDispatchLive` Layer that builds `IPCHandlerMap` by wrapping each Effect handler in `runtime.runPromise`. Show how `makeIpcServerLive` signature changes:

```typescript
// New: IpcDispatchLive provides DaemonIPCContext by wrapping Effect handlers
export const IpcDispatchLive = Layer.effect(
  IpcContextTag, // new Tag
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime</* all handler deps */>();
    return {
      addProject: (dir) => Runtime.runPromise(runtime)(handleAddProject(dir)),
      // ... all 19 handlers wrapped
    };
  }),
);
```

**AP-21: Enumerate all 19 IPC handlers.** Plan must list: `addProject`, `removeProject`, `getProjects`, `setProjectTitle`, `getPinHash`, `setPinHash`, `getKeepAwake`, `setKeepAwake`, `setKeepAwakeCommand`, `persistConfig`, `scheduleShutdown`, `restartWithConfig`, `getInstances`, `getInstance`, `instanceAdd`, `instanceRemove`, `instanceStart`, `instanceStop`, `instanceUpdate`. Flag `getStatus`, `setKeepAwakeCommand`, `instanceAdd`, `setPinHash`, `scheduleShutdown` as requiring explicit implementation notes.

**AP-22: Fix `handleSetKeepAwake`.** Must call `KeepAwakeTag.activate()`/`deactivate()` directly, not just update Ref:
```typescript
const keepAwake = yield* KeepAwakeTag;
if (enabled) yield* keepAwake.activate();
else yield* keepAwake.deactivate();
const supported = yield* keepAwake.isSupported();
const active = yield* keepAwake.isActive();
```

**AP-23: Design `setKeepAwakeCommand` reconfiguration.** Options: (a) add `reconfigure(command, args)` to KeepAwake service; (b) use `ScopedRef` to swap service. Recommend (a) — extend `KeepAwakeService` interface in `keep-awake-layer.ts`.

**AP-24: `handleSetPinHash` — reactive approach.** Per user decision, only update `DaemonConfigRef`. AuthManager reads pinHash reactively. Remove `auth.setPinHash(hash)` call.

**AP-25: `scheduleShutdown` handler.** Must complete `ShutdownSignalTag` Deferred (after delay) to trigger fiber interruption and Layer teardown. See Task 12 AP-36.

**AP-26: Add testing strategy.** Group handlers: (1) simple state updates → unit test with mock Refs; (2) complex logic (instanceAdd ID generation) → dedicated test cases; (3) service interaction (setKeepAwakeCommand) → mock KeepAwakeTag.

### Task 9 Amendments

**AP-27: Add missing dependencies.** `RelayFactoryLive` must also depend on: `PushManagerTag`, `VersionCheckerTag` (for `getCachedUpdate`), `HttpServerRefTag` (for `ctx.httpServer`).

**AP-28: PersistenceLayer lifecycle.** Each relay creates a SQLite DB. Must be managed as a scoped resource — `Effect.acquireRelease(openDb, closeDb)` inside relay construction.

**AP-29: AbortSignal → Effect Scope.** Replace `(signal: AbortSignal) => Promise<ProjectRelay>` with Effect that adds finalizers via `Effect.addFinalizer`. The factory returns a scoped Effect, not a Promise.

**AP-30: Full `createProjectRelay` conversion (user decision).** Convert `createProjectRelay` to accept Effect services via Context Tags. This is a large sub-task — enumerate the 15+ callback params and map each to a Tag-based access.

**AP-31: Introduce `HttpServerRefTag` here** (not Task 11). Task 9 and Task 10 both need it. Define:
```typescript
export class HttpServerRefTag extends Context.Tag("HttpServerRef")<
  HttpServerRefTag,
  Ref.Ref<http.Server | null>
>() {}
```
Provided by `makeHttpServerLive` — after starting the server, set the Ref.

### Task 10 Amendments

**AP-32: WebSocket routing must preserve all behaviors:**
- Call `ensureRelayStarted(slug)` for lazy relay startup before waiting
- `waitForRelay` with 10s timeout (use `Effect.timeout` + `Deferred`-based wait on `ProjectReady` event)
- Write `HTTP/1.1 503 Service Unavailable\r\n\r\n` on relay wait failure before destroying socket
- Check `shuttingDown` from `DaemonConfigRefTag`
- Read `dismissedPaths` from `DaemonConfigRefTag` in ProjectDiscoveryLive

**AP-33: Add `SessionPrefetchLive`.** Implement with instance credential resolution from `InstanceManagerTag`, Basic auth header construction, `Effect.forkScoped` for fire-and-forget fetch loop.

**AP-34: Add instance-status-to-registry wiring.** Scoped fiber subscribing to `DaemonEventBus` for `InstanceStatusChanged` events → reset error-state projects in ProjectRegistry. Can be a sub-fiber in `ProjectDiscoveryLive` or a separate `InstanceRegistryBridgeLive`.

**AP-35: Add error-state project reset** to `ProjectDiscoveryLive`. After discovery, iterate all error-state projects and reset with `addWithoutRelay(..., { silent: true })`.

**AP-36: Add auth failure path tests.** (1) upgrade succeeds when no PIN set; (2) upgrade succeeds with valid cookie; (3) upgrade rejected + socket destroyed on auth failure; (4) upgrade rejected when `shuttingDown` is true.

### Task 11 Amendments

**AP-37: Replace `Layer.mergeAll` with tiered `Layer.provide` composition:**

```typescript
export const makeDaemonLive = (options: DaemonOptions) => {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;
  
  // Tier 0: Foundation (no inter-dependencies)
  const foundation = Layer.mergeAll(
    DaemonEventBusLive,
    PinoLoggerLive,
    DaemonConfigRefLive(makeDaemonConfigFromOptions(options)),
    SignalHandlerLayer,
    ProcessErrorHandlerLayer,
    makePidFileLive(configDir, pidPath, socketPath),
  );

  // Tier 1: Services needing foundation
  const services = Layer.mergeAll(
    AuthManagerFromConfigLive,
    TlsCertLive(configDir),
    CrashCounterLive,
    ConfigPersistenceLive,
  ).pipe(Layer.provide(foundation));

  // Tier 2: Registries needing services
  const registries = Layer.mergeAll(
    ProjectRegistryLive,
    InstanceManagerLive,
    RelayFactoryLive,
    PushManagerLive,
  ).pipe(Layer.provide(services));

  // Tier 3: Dispatch/routing needing registries
  const dispatch = Layer.mergeAll(
    IpcDispatchLive,
    WebSocketRoutingLive,
    ProjectDiscoveryLive,
    SessionPrefetchLive,
  ).pipe(Layer.provide(registries));

  // Tier 4: Servers + background (needing dispatch)
  const servers = Layer.mergeAll(
    HttpServerLive,
    IpcServerLive,
    OnboardingServerLive,
    VersionCheckerLive(versionConfig),
    StorageMonitorLive(storageConfig),
    KeepAwakeLive(keepAwakeConfig),
    PortScannerLive(portScannerConfig),
  ).pipe(Layer.provide(dispatch));

  return servers;
};
```

**AP-38: Convert server Layer factories.** `makeHttpServerLive`, `makeIpcServerLive`, `makeOnboardingServerLive` currently take `DaemonLifecycleContext` params. Convert to read deps from Context Tags (`DaemonConfigRefTag` for port/host, `TlsCertTag` for TLS, `HttpServerRefTag` for server ref, `IpcContextTag` for IPC handlers). This is a significant sub-task — add explicit steps for each server Layer conversion.

### Task 12 Amendments

**AP-39: CRITICAL — Use `NodeRuntime.runMain`, not `Effect.runFork`.** `Layer.launch` does NOT handle SIGINT/SIGTERM. Replace:

```typescript
// daemon-main.ts
import { NodeRuntime } from "@effect/platform-node";

export const startDaemonProcess = (options: DaemonOptions) =>
  NodeRuntime.runMain(Layer.launch(makeDaemonLive(options)));
```

`NodeRuntime.runMain` installs SIGINT/SIGTERM handlers that interrupt the fiber. Additionally, wire `ShutdownSignalTag` Deferred into the daemon program so IPC `shutdown` command can also trigger teardown:

```typescript
// In makeDaemonLive, add a "shutdown awaiter" Layer:
const ShutdownAwaiterLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const shutdown = yield* ShutdownSignalTag;
    yield* Effect.forkScoped(
      Deferred.await(shutdown).pipe(
        Effect.flatMap(() => Effect.interrupt),
      ),
    );
  }),
);
```

**AP-40: Fix `--daemon` path.** `startDaemonProcess` with `NodeRuntime.runMain` never returns (it calls `process.exit` on completion). The `--daemon` cli-core.ts path (line 122) uses `await startDaemonProcess(...)` then `return` — this works because `runMain` keeps the process alive. Change to:

```typescript
// cli-core.ts --daemon path:
startDaemonProcess(options); // no await — runMain handles process lifecycle
return; // unreachable but satisfies TypeScript
```

**AP-41: Define `DaemonHandleTag` for foreground mode.**

```typescript
export interface DaemonHandle {
  readonly port: Effect.Effect<number>;
  readonly addProject: (dir: string, slug?: string, instanceId?: string) => Effect.Effect<StoredProject>;
  readonly removeProject: (slug: string) => Effect.Effect<void>;
  readonly discoverProjects: () => Effect.Effect<void>;
  readonly getStatus: () => Effect.Effect<DaemonStatus>;
  readonly getProjects: () => Effect.Effect<ReadonlyArray<StoredProject>>;
}

export class DaemonHandleTag extends Context.Tag("DaemonHandle")<
  DaemonHandleTag,
  DaemonHandle
>() {}

export const DaemonHandleLive = Layer.effect(
  DaemonHandleTag,
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    const registry = yield* ProjectRegistryTag;
    // ... compose handle from existing Tags
  }),
);
```

For `--foreground` mode:
```typescript
const runtime = ManagedRuntime.make(makeDaemonLive(options));
await runtime.runPromise(Effect.void); // builds layers, starts servers
const handle = await runtime.runPromise(DaemonHandleTag); // get handle
```

**AP-42: IPC shutdown triggers Deferred.** The IPC `scheduleShutdown` handler (Task 8) completes `ShutdownSignalTag` Deferred after delay:

```typescript
export const handleScheduleShutdown = Effect.gen(function* () {
  const shutdown = yield* ShutdownSignalTag;
  yield* Effect.sleep(Duration.millis(DAEMON_SHUTDOWN_DELAY_MS));
  yield* Deferred.succeed(shutdown, void 0);
});
```

**AP-43: Expand test stub.** Must verify: (a) Layer builds with mock deps; (b) shutdown signal triggers teardown; (c) all finalizers run (PID file removed, servers closed); (d) IPC shutdown command triggers teardown via Deferred.

**AP-44: Update conventions doc.** `docs/plans/effect-ts-next-wave/conventions.md` line 78 incorrectly claims `Layer.launch` handles SIGINT/SIGTERM. Correct to: "Use `NodeRuntime.runMain(Layer.launch(...))` for the top-level daemon program — `runMain` handles SIGINT/SIGTERM."

### Dependency Graph Update

Task 3 PortScanner wiring deferred to after Task 7. `HttpServerRefTag` introduced in Task 9 (not Task 11).

```
Task 1 (DaemonConfigRef) ← keystone
  │
  ├─ Task 2 (ConfigPersistence)       ─┐
  ├─ Task 3 (background svc, no PS)    │ parallel after Task 1
  ├─ Task 4 (CrashCounter/Auth)        │
  ├─ Task 5 (TLS)                     ─┘
  │
  Task 6 (ProjectRegistry wiring + gaps) ← needs Task 2
  │
  Task 7 (InstanceManager wiring + gaps + PortScanner) ← needs Task 6
  │
  ├─ Task 8 (IPC handlers + dispatch bridge)  ─┐
  ├─ Task 9 (Relay factory + HttpServerRefTag) │ parallel after Task 7
  ├─ Task 10 (WS/discovery/prefetch)          ─┘
  │
  Task 11 (tiered Layer composition, server Layer conversion) ← needs Tasks 3-10
  │
  Task 12 (NodeRuntime.runMain + DaemonHandleTag) ← needs Task 11
```

---

## Audit Amendments (Round 2)

> **For Agent:** These amendments override Round 1 amendments where they conflict. Read Round 1 first, then apply these corrections on top.

### Task 1 Amendments (Round 2)

**AP-R2-1: Update all test `defaults` objects with AP-1 fields.**

Every test that constructs a `DaemonRuntimeConfig` defaults object must include the three AP-1 fields. Replace all test defaults (Task 1 lines 73-83, Task 2 lines 309-319, and any other test defaults in the plan) with:

```typescript
const defaults: DaemonRuntimeConfig = {
  port: 2633,
  host: "127.0.0.1",
  pinHash: null,
  tlsEnabled: false,
  keepAwake: false,
  keepAwakeCommand: undefined,
  keepAwakeArgs: undefined,
  shuttingDown: false,
  dismissedPaths: new Set(),
  startTime: Date.now(),
  hostExplicit: false,
  persistedSessionCounts: new Map(),
};
```

**AP-R2-2: Update `makeDaemonConfigFromOptions` for AP-1 fields.**

Replace the function at plan lines 177-196 with:

```typescript
export const makeDaemonConfigFromOptions = (options: {
  port?: number;
  host?: string;
  pinHash?: string;
  tlsEnabled?: boolean;
  keepAwake?: boolean;
  keepAwakeCommand?: string;
  keepAwakeArgs?: string[];
  dismissedPaths?: string[];
  startTime?: number;
  persistedSessionCounts?: ReadonlyMap<string, number>;
}): DaemonRuntimeConfig => ({
  port: options.port ?? 2633,
  host: options.host ?? "127.0.0.1",
  pinHash: options.pinHash ?? null,
  tlsEnabled: options.tlsEnabled ?? false,
  keepAwake: options.keepAwake ?? false,
  keepAwakeCommand: options.keepAwakeCommand,
  keepAwakeArgs: options.keepAwakeArgs,
  shuttingDown: false,
  dismissedPaths: new Set(options.dismissedPaths ?? []),
  startTime: options.startTime ?? Date.now(),
  hostExplicit: options.host !== undefined,
  persistedSessionCounts: new Map(options.persistedSessionCounts ?? []),
});
```

### Task 2 Amendments (Round 2)

**AP-R2-3: Fix AP-3 test `writes` scoping.**

Rewrite `makeTestLayer()` to return both the composed layer and the writes array, so AP-3's test body can destructure them:

```typescript
const makeTestLayer = () => {
  const writes: DaemonRuntimeConfig[] = [];
  const writerLayer = Layer.succeed(ConfigWriterTag, {
    write: (config: DaemonRuntimeConfig) =>
      Effect.sync(() => { writes.push(config); }),
  });
  const layer = ConfigPersistenceLive.pipe(
    Layer.provide(Layer.mergeAll(
      DaemonConfigRefLive(defaults),
      DaemonEventBusLive,
      writerLayer,
    )),
  );
  return { layer, writes };
};

// Usage in test:
it.scoped("writes config to disk on ConfigChanged event", () =>
  Effect.gen(function* () {
    const { layer, writes } = makeTestLayer();
    yield* Layer.build(Layer.fresh(layer));
    const bus = yield* DaemonEventBusTag;
    yield* PubSub.publish(bus, DaemonEvent.ConfigChanged({}));
    yield* TestClock.adjust(Duration.millis(600));
    expect(writes.length).toBeGreaterThanOrEqual(1);
  }).pipe(Effect.provide(/* NOTE: bus comes from layer above, not a second one */)),
);
```

**AP-R2-4: Add `persistedSessionCounts` seeding cross-reference.**

Add to Task 1 Step 7 (after the wiring code at plan lines 230-237):

> **Note:** `persistedSessionCounts` is populated when disk config is loaded. This happens during Task 6 when `ProjectRegistryLive` rehydrates from disk state. Until then, defaults to empty Map.

### Task 5 Amendments (Round 2)

**AP-R2-5: Add `caCertPem` to success-path return.**

Replace plan lines 659-663 return object with:

```typescript
return {
  certs,
  caRootPath: certs?.caRoot ?? null,
  caCertDer: certs?.caCertDer ?? null,
  caCertPem: certs?.caCertPem ?? null,
};
```

**AP-R2-6: Add `EnsureCertsTag` to implementation and tests.**

Add a Context Tag for `ensureCerts` DI so tests can mock it:

```typescript
export interface EnsureCertsService {
  ensureCerts: (opts: { configDir: string }) => Effect.Effect<TlsCerts | null, TlsCertLoadError>;
}

export class EnsureCertsTag extends Context.Tag("EnsureCerts")<
  EnsureCertsTag,
  EnsureCertsService
>() {}

// Production layer:
export const EnsureCertsLive = Layer.succeed(EnsureCertsTag, {
  ensureCerts: (opts) => Effect.tryPromise({
    try: () => ensureCerts(opts),
    catch: (cause) => new TlsCertLoadError({ cause }),
  }),
});
```

Update `TlsCertLive` to resolve from context instead of importing directly:

```typescript
// Replace: yield* Effect.tryPromise({ try: () => ensureCerts({ configDir }), ... })
// With:
const certService = yield* EnsureCertsTag;
const certs = yield* certService.ensureCerts({ configDir }).pipe(
  Effect.catchTag("TlsCertLoadError", (e) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("TLS unavailable — falling back to HTTP");
      yield* Ref.update(configRef, (c) => ({ ...c, tlsEnabled: false }));
      return null;
    }),
  ),
);
```

`TlsCertLive` now depends on `EnsureCertsTag`. Compose with `EnsureCertsLive` in `makeDaemonLive`. Tests provide mock `EnsureCertsTag` directly.

### Task 6 Amendments (Round 2)

**AP-R2-7: Document ProjectRegistryLive co-layer requirements.**

Add to AP-18 step 4 (wiring into makeDaemonLive):

> **Required co-layers:** `ProjectRegistryLive` free functions require `DaemonEventBusTag` and `RelayCacheTag` at call sites. `DaemonEventBusLive` is already composed. `RelayCacheLayer` (from `makeRelayCacheLayer`) must also be composed — `relayFactory` option in `DaemonLiveOptions` must be mandatory when ProjectRegistry is wired. If no relay factory is available during testing, provide a stub `RelayCacheLayer` via `Layer.succeed(RelayCacheTag, ...)`.

**AP-R2-8: Add `isStarting` to gap list.**

Add to AP-18 step 3 missing methods:

> - `isStarting(slug)` — used at `daemon-main.ts:632`. Replace with: check `getEntry(slug)` returns entry with `_tag === "Registering"`. Add helper: `export const isStarting = (slug: string) => getEntry(slug).pipe(Effect.map(Option.map(e => e._tag === "Registering")), Effect.map(Option.getOrElse(() => false)))`.

### Task 7 Amendments (Round 2)

**AP-R2-9: Add missing InstanceManagementDeps methods to gap list.**

Add to AP-19 step 3 before building `InstanceMgmtLive` adapter:

> **Fill gaps first.** The existing Effect service is missing 4 of 7 `InstanceManagementDeps` methods:
> - `startInstance(id)` — spawn instance process, update status to "running"
> - `stopInstance(id)` — interrupt instance fiber, update status to "stopped"
> - `updateInstance(id, partial)` — `Ref.update` with partial field merge
> - `persistConfig()` — delegate to `ConfigPersistenceLive` by publishing `ConfigChanged` event
>
> Implement these before building the adapter.

**AP-R2-10: Fix `addInstance` return type.**

> Modify Effect `addInstance` to return `OpenCodeInstance` instead of `void`. After `Ref.update`, read back the created instance via `HashMap.get` and return it. The `InstanceMgmtLive` adapter can then pass through directly.

**AP-R2-11: Add `getExternalUrl`/`getInstanceUrl` to gap list.**

> Add to AP-19 gap list:
> - `getExternalUrl(id)` — used at `daemon-main.ts:397`. Pure helper: construct URL from `instance.port` + daemon host.
> - `getInstanceUrl(id)` — used at `daemon-main.ts:544,550`. Pure helper: construct URL from `instance.port` + localhost.
>
> Implement as standalone Effect functions (not methods on the service interface).

**AP-R2-12: Fix PortScanner callback construction.**

Replace AP-19 step 5 PortScanner wiring guidance:

> **PortScanner callbacks must close over concrete values, not Tags.** `PortScannerConfig.onDiscovered/onLost` are typed `(port: number) => Effect.Effect<void>` (zero requirements — `R = never`). You cannot use `yield* InstanceManagerStateTag` inside these callbacks.
>
> Instead, obtain concrete Ref/FiberMap values during Layer construction and close over them:
>
> ```typescript
> // Inside a Layer.scoped that has access to both services:
> const stateRef = yield* InstanceManagerStateTag;
> const fibers = yield* PollerFibersTag;
>
> const portScannerConfig: PortScannerConfig = {
>   // ...
>   onDiscovered: (port) => Effect.gen(function* () {
>     // Close over stateRef directly — no Tag access needed
>     yield* Ref.update(stateRef, (s) => ({ ... }));
>   }),
>   onLost: (port) => Effect.gen(function* () {
>     yield* Ref.update(stateRef, (s) => ({ ... }));
>   }),
> };
> ```

**AP-R2-13: Specify DaemonEventBus bridge home.**

Add to AP-19 step 6:

> Create dedicated `DaemonWiringLive` Layer that sits above both `ProjectRegistryLive` and `InstanceManagerLive` in the composition tier. This Layer:
> 1. Subscribes to `DaemonEventBus` for `InstanceStatusChanged` events
> 2. Resets error-state projects in ProjectRegistry when instances become healthy
> 3. Manages the subscription fiber via `Effect.forkScoped`
>
> Place in Tier 3 (dispatch/routing) of the tiered composition from AP-37.

**AP-R2-14: Document `drain()` replacement.**

Add to AP-19 step 7:

> **Note:** `instanceManager.drain()` and `registry.drain()` are replaced by scope-based finalization. `FiberMap.make` is scoped — all fibers are interrupted when the Layer scope closes. `Ref` state is garbage collected. No explicit `drain` method is needed on the Effect services.

**AP-R2-15: Wire existing PushManagerLive.**

Replace AP-19 step 8:

> Wire existing `PushManagerLive` from `push-service.ts:37` into `makeDaemonLive`. Provide a concrete `sendPush` implementation (or stub if push notifications are not yet wired). Do NOT create a new Layer — the existing one is complete.

### Task 11 Amendments (Round 2)

**AP-R2-16: Use `Layer.provideMerge` instead of `Layer.provide` in tiered composition.**

AP-37's tiered composition uses `Layer.provide` which strips transitive deps. `services.pipe(Layer.provide(foundation))` outputs only service tags — downstream tiers cannot access foundation tags like `DaemonEventBusTag` or `DaemonConfigRefTag`.

Replace all `Layer.provide` with `Layer.provideMerge` in the tiered composition:

```typescript
export const makeDaemonLive = (options: DaemonOptions) => {
  const configDir = options.configDir ?? DEFAULT_CONFIG_DIR;

  // Tier 0: Foundation (no inter-dependencies)
  const foundation = Layer.mergeAll(
    DaemonEventBusLive,
    PinoLoggerLive,
    DaemonConfigRefLive(makeDaemonConfigFromOptions(options)),
    SignalHandlerLayer,
    ProcessErrorHandlerLayer,
    makePidFileLive(configDir, pidPath, socketPath),
  );

  // Tier 1: Services needing foundation
  // provideMerge passes foundation output through
  const services = Layer.mergeAll(
    AuthManagerFromConfigLive,
    TlsCertLive(configDir),
    CrashCounterLive,
    ConfigPersistenceLive,
    EnsureCertsLive,
  ).pipe(Layer.provideMerge(foundation));

  // Tier 2: Registries needing foundation + services
  const registries = Layer.mergeAll(
    ProjectRegistryLive,
    InstanceManagerLive,
    RelayFactoryLive,
    PushManagerLive,
  ).pipe(Layer.provideMerge(services));

  // Tier 3: Dispatch/routing/wiring needing all above
  const dispatch = Layer.mergeAll(
    IpcDispatchLive,
    WebSocketRoutingLive,
    ProjectDiscoveryLive,
    SessionPrefetchLive,
    DaemonWiringLive,
  ).pipe(Layer.provideMerge(registries));

  // Tier 4: Servers + background (needing dispatch)
  const servers = Layer.mergeAll(
    HttpServerLive,
    IpcServerLive,
    OnboardingServerLive,
    VersionCheckerLive(versionConfig),
    StorageMonitorLive(storageConfig),
    KeepAwakeLive(keepAwakeConfig),
    PortScannerLive(portScannerConfig),
    ShutdownAwaiterLive,
  ).pipe(Layer.provideMerge(dispatch));

  return servers;
};
```

Key difference: `Layer.provideMerge(a)(b)` outputs `a.Output | b.Output`, so downstream tiers can access all upstream tags.
