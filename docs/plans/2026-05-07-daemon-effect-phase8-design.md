# Phase 8: Complete Effect Migration of Daemon Entry Point

## Problem

Phase 7 wired `ManagedRuntime + makeDaemonLive` as the daemon entry point but left ~1200 lines of imperative construction in `startDaemonProcess`. This imperative code creates 16 services via mutable variables, closures, and class instances, then feeds them into `DaemonLiveOptions`. Effect's typed error guarantees stop at this boundary — errors escape via `runPromise`, mutable state is invisible to the type system, and service lifecycle is untracked.

Three bugs shipped because of this:
1. `DaemonLifecycleLayerError` had no `.message` — FiberFailure fell back to "An error has occurred"
2. `ManagedRuntime.runPromise()` rejection went unlogged
3. Port conflicts detected only after child process spawn, not before

All three lived at Effect↔imperative boundaries. Patching boundaries doesn't prevent recurrence — pushing Effect ownership deeper does.

## End State

```typescript
// daemon-main.ts — entire file after Phase 8
export const startDaemonProcess = (options: DaemonOptions) =>
  Effect.runFork(Layer.launch(makeDaemonLive(options)));
```

Zero mutable variables. Zero closures. Zero imperative class instances. Every service is a Layer with typed error channels. `DaemonLiveOptions` disappears — replaced by Layers that construct themselves from `DaemonOptions`.

## Architecture

```
DaemonOptions (CLI input)
  │
  ▼
makeDaemonLive(options)  ← single Layer composition
  │
  ├─ DaemonConfigLive       ← Ref<DaemonConfig> seeded from options + disk
  ├─ AuthManagerLive         ← reads pinHash from DaemonConfigRef
  ├─ TlsCertLive             ← loads certs, updates DaemonConfigRef
  ├─ CrashCounterLive        ← already exists (daemon-startup.ts)
  ├─ ConfigPersistenceLive   ← debounced disk writer reading Ref state
  ├─ ProjectRegistryLive     ← Ref<HashMap> + DaemonEventBus publications
  ├─ InstanceManagerLive     ← Ref<HashMap> + health poller fibers
  ├─ RelayFactoryLive        ← reads Registry + InstanceManager from Context
  ├─ IpcDispatchLive         ← handlers are Effects reading services from Context
  ├─ WebSocketRoutingLive    ← scoped fiber on upgrade events
  ├─ ProjectDiscoveryLive    ← scoped fiber, runs once at startup
  ├─ SessionPrefetchLive     ← scoped fiber, fire-and-forget
  ├─ HttpServerLive          ← already exists
  ├─ IpcServerLive           ← already exists
  ├─ PortScannerLive         ← already exists
  ├─ VersionCheckerLive      ← already exists
  ├─ StorageMonitorLive      ← already exists
  ├─ KeepAwakeLive           ← already exists
  ├─ PinoLoggerLive          ← already exists
  ├─ DaemonEventBusLive      ← already exists
  └─ SignalHandlerLayer      ← already exists
```

Every box is a `Layer.Layer<Service, Error, Dependencies>`. Dependencies satisfied by composition. Errors typed. Finalizers handle cleanup. `Layer.launch` tears down in reverse order on SIGINT/SIGTERM.

## Current State Analysis

### What's already Effect-native (no work needed)
- Signal/error handlers (`SignalHandlerLayer`, `ProcessErrorHandlerLayer`)
- Server lifecycle (`makeHttpServerLive`, `makeIpcServerLive`, `makeOnboardingServerLive`)
- PID file management (`makePidFileLive`)
- Background service Layers (`KeepAwakeLive`, `VersionCheckerLive`, `StorageMonitorLive`, `PortScannerLive`)
- Handler dispatch (`dispatchMessageEffect`)
- Session/poller/PTY state (all `*StateTag` + `*Live` Layers)
- DaemonEventBus, PinoLogger, DaemonState, RelayCache
- Metrics (7 counters/gauges)

### What's still imperative in daemon-main.ts

| Service | Lines | Blocking Factor |
|---------|-------|-----------------|
| CrashCounter | 325-331 | None — CrashCounterTag exists |
| AuthManager | 362-363 | None — AuthManagerTag exists |
| InstanceManager | 365-535 | Cross-dep with ProjectRegistry |
| ProjectRegistry | 366-475 | Cross-dep with InstanceManager, persistConfig |
| Config persistence | 368-429 | Captures 8+ mutable variables |
| Relay factory | 556-625 | Closes over 10+ mutable refs |
| IPC context | 965-1039 | 20+ handlers accessing mutable state |
| TLS cert loading | 1055-1082 | Mutates global config state |
| HTTP router | 1089-1160 | Already Layered, just integration glue |
| WebSocket routing | 1216-1266 | Post-runtime event listener |
| Port scanner (imperative) | 1269-1329 | Has Layer equivalent, not wired |
| VersionChecker (imperative) | 1403-1409 | Has Layer equivalent, not wired |
| KeepAwake (imperative) | 1411-1419 | Has Layer equivalent, duplicated |
| StorageMonitor (imperative) | 1422-1441 | Has Layer equivalent, not wired |
| Event loop monitor | 1447-1455 | setInterval, trivial |
| Project discovery | 1389-1512 | Fire-and-forget async |
| Session count prefetch | 1337-1370 | Fire-and-forget fetch |

### The keystone problem

Eight mutable `let` variables (`port`, `host`, `pinHash`, `tlsEnabled`, `keepAwake`, `keepAwakeCommand`, `keepAwakeArgs`, `shuttingDown`, `dismissedPaths`) are captured by closures throughout the file. `persistConfig()`, `getStatus()`, `buildRelayFactory()`, and 20+ IPC handlers all read/write these. This closure web makes incremental migration impossible — extracting any single service requires touching all of them.

**Solution:** Extract mutable state to `Ref<DaemonRuntimeConfig>` first. Once all reads/writes go through the Ref, closures dissolve and services can be extracted independently.

## Task Breakdown

### Task 1: Extract mutable daemon state to DaemonConfigRef

**The keystone.** Create `DaemonConfigRefTag` backed by `Ref<DaemonRuntimeConfig>`:

```typescript
// src/lib/effect/daemon-config-ref.ts
interface DaemonRuntimeConfig {
  port: number;
  host: string;
  pinHash: string | null;
  tlsEnabled: boolean;
  keepAwake: boolean;
  keepAwakeCommand: string | undefined;
  keepAwakeArgs: string[] | undefined;
  shuttingDown: boolean;
  dismissedPaths: ReadonlySet<string>;
}

class DaemonConfigRefTag extends Context.Tag("DaemonConfigRef")<
  DaemonConfigRefTag,
  Ref.Ref<DaemonRuntimeConfig>
>() {}

const DaemonConfigRefLive = (options: DaemonOptions) =>
  Layer.effect(DaemonConfigRefTag, 
    Effect.gen(function* () {
      const disk = yield* loadConfig;
      return yield* Ref.make<DaemonRuntimeConfig>({
        port: options.port ?? DEFAULT_PORT,
        host: options.host ?? "127.0.0.1",
        pinHash: options.pinHash ?? null,
        tlsEnabled: options.tlsEnabled ?? false,
        keepAwake: options.keepAwake ?? false,
        keepAwakeCommand: options.keepAwakeCommand,
        keepAwakeArgs: options.keepAwakeArgs,
        shuttingDown: false,
        dismissedPaths: new Set(disk?.dismissedPaths ?? []),
      });
    })
  );
```

**In daemon-main.ts:** Replace all `let port = ...`, `let host = ...`, etc. with reads/writes to the Ref. Functions that previously captured mutable vars now take `DaemonConfigRefTag` from Context.

**Files:** Create `src/lib/effect/daemon-config-ref.ts`. Modify `src/lib/effect/daemon-main.ts`.

**Test:** Unit test Ref initialization from options + disk config. Verify existing tests pass.

### Task 2: Convert persistConfig to Effect

Current: Stateful closure with `_pendingSave` / `_needsResave` coalescing, captures 8+ mutable vars.

Target: `ConfigPersistenceLive` Layer containing a debounced fiber. Subscribes to `DaemonEventBus` for change events. On trigger: reads `DaemonConfigRefTag`, `ProjectRegistryTag`, `InstanceManagerTag`, serializes to disk.

```typescript
// src/lib/effect/config-persistence-layer.ts
const ConfigPersistenceLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const configRef = yield* DaemonConfigRefTag;
    const bus = yield* DaemonEventBusTag;
    const debounceRef = yield* Ref.make<boolean>(false);
    
    // Subscribe to config-relevant events
    const sub = yield* PubSub.subscribe(bus);
    yield* Effect.forkScoped(
      Stream.fromQueue(sub).pipe(
        Stream.filter(isConfigRelevantEvent),
        Stream.debounce(Duration.millis(500)),
        Stream.runForEach(() => persistToDisk(configRef)),
      )
    );
  })
);
```

**Depends on:** Task 1 (DaemonConfigRef).

**Files:** Create `src/lib/effect/config-persistence-layer.ts`. Delete `persistConfig` / `flushConfigSave` closures from daemon-main.ts.

### Task 3: Wire background services through existing Layers

`VersionChecker`, `StorageMonitor`, `PortScanner` already have Effect Layers (`VersionCheckerLive`, `StorageMonitorLive`, `PortScannerLive`) but daemon-main.ts instantiates the imperative classes AND passes `undefined` to `makeDaemonLive`.

**Change:** Pass real configs to `makeDaemonLive`. Delete imperative class instantiation (lines 1403-1441). Remove `stop()` drain calls for these services — Layer finalizers handle cleanup.

`KeepAwake` is half-done: both Layer AND imperative instance exist. Delete imperative instance, use only Layer.

Delete event loop monitor `setInterval` — replace with a scoped fiber in a lightweight `EventLoopMonitorLive` Layer.

**Depends on:** Independent (can run parallel with Tasks 2, 4, 5).

**Files:** Modify `src/lib/effect/daemon-main.ts`, `src/lib/effect/daemon-layers.ts`.

### Task 4: CrashCounter and AuthManager to Layers

Both trivial. `CrashCounterTag` already exists in `daemon-startup.ts`. `AuthManagerTag` already exists.

**CrashCounter:** Move `crashCounter.record()` + `shouldGiveUp()` check into `CrashCounterLive` Layer. Layer fails with `CrashLimitExceeded` error (already defined). Delete imperative instantiation.

**AuthManager:** `AuthManagerLive` reads initial `pinHash` from `DaemonConfigRefTag`. Subsequent `setPinHash` calls update the Ref. Delete imperative `new AuthManager()`.

**Depends on:** Task 1 (AuthManager needs DaemonConfigRef for pinHash).

**Files:** Modify `src/lib/effect/daemon-startup.ts`, create `src/lib/effect/auth-manager-layer.ts`, modify `daemon-main.ts`.

### Task 5: TLS cert loading as a Layer

Current: Imperative async block (lines 1055-1082) that calls `ensureCerts()`, mutates `tlsEnabled`, `host`, and sets `ctx.tls`.

Target: `TlsCertLive` Layer that:
1. Reads `DaemonConfigRefTag` for initial `tlsEnabled` flag
2. If enabled, loads certs via `ensureCerts()`
3. Updates `DaemonConfigRefTag` if TLS unavailable (fallback to HTTP)
4. Provides `TlsCertTag` service (cert paths + state)

HTTP server Layer and onboarding Layer read from `TlsCertTag` instead of receiving pre-computed values via `DaemonLiveOptions`.

**Depends on:** Task 1 (DaemonConfigRef).

**Files:** Create `src/lib/effect/tls-cert-layer.ts`, modify `daemon-layers.ts`.

### Task 6: ProjectRegistry as Effect service

Replace `ProjectRegistry` class (EventEmitter-based, imperative state) with `ProjectRegistryLive` Layer backed by `Ref<HashMap<string, StoredProject>>`.

Key conversions:
- `registry.on("project_added", ...)` → `DaemonEventBus` publication of `ProjectAdded` event
- `registry.on("project_ready", ...)` → `DaemonEventBus` publication of `ProjectReady` event
- `registry.broadcastToAll(msg)` → Effect that reads Ref and sends to all connected clients
- `registry.startRelay(slug, factory)` → Effect that creates relay and updates Ref
- `registry.allProjects()` → `Ref.get` + `HashMap.values`

Config persistence trigger (currently an event listener) becomes a PubSub subscription in `ConfigPersistenceLive` (Task 2).

**Depends on:** Task 2 (ConfigPersistence needs to subscribe to registry events).

**Files:** Create `src/lib/effect/project-registry-layer.ts`, modify `daemon-main.ts`, modify `daemon-layers.ts`.

### Task 7: InstanceManager as Effect service

Replace `InstanceManager` class with `InstanceManagerLive` Layer. Health polling and restart scheduling already exist as Effect services from Phase 7 Task 3 (`startHealthPoller`, `scheduleRestart`).

This task wires:
- `addInstance` / `removeInstance` → Effect programs updating `Ref<HashMap<string, Instance>>`
- `setHealthChecker` → injected via Context (health check is an Effect, not a callback)
- EventEmitter `status_changed` → `DaemonEventBus` publication
- Cross-dependency with ProjectRegistry → both available as Tags in shared Context

Probe-and-convert logic (lines 882-962 — `probeOpenCode`, `isOpencodeInstalled`, `findFreePort`) becomes a startup Effect in the Layer's scoped initialization.

**Depends on:** Task 6 (ProjectRegistry must be a Layer for shared Context).

**Files:** Modify `src/lib/effect/instance-manager-service.ts`, modify `daemon-main.ts`.

### Task 8: IPC handlers as Effect programs

Currently 20+ closures in `ipcContext` (lines 965-1039). Convert each to an Effect program reading services from Context.

```typescript
// Before (closure):
addProject: (dir: string) => addProject(dir),

// After (Effect):
const handleAddProject = (dir: string) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistryTag;
    const configRef = yield* DaemonConfigRefTag;
    // ... add project, update config, return result
  });
```

IPC dispatch Layer calls `runtime.runPromise(handler(args))` for each command. `DaemonIPCContext` type changes from closure bag to Effect dispatch table.

**Depends on:** Tasks 6, 7 (handlers need ProjectRegistry and InstanceManager as Tags).

**Files:** Create `src/lib/effect/ipc-handlers-layer.ts`, modify `daemon-layers.ts`.

### Task 9: Relay factory as Effect service

`buildRelayFactory` (lines 556-625) currently closes over `ctx`, `registry`, `instanceManager`, and 10+ other values. Convert to `RelayFactoryLive` Layer.

The factory becomes an Effect that accesses all dependencies via Context Tags:

```typescript
const createRelay = (slug: string) =>
  Effect.gen(function* () {
    const registry = yield* ProjectRegistryTag;
    const instanceMgr = yield* InstanceManagerTag;
    const configRef = yield* DaemonConfigRefTag;
    // ... build relay, return ProjectRelay
  });
```

`DaemonLiveOptions.relayFactory` field disappears — `RelayFactoryLive` provides itself via Context.

**Depends on:** Tasks 6, 7 (needs ProjectRegistry and InstanceManager as Tags).

**Files:** Create `src/lib/effect/relay-factory-layer.ts`, modify `daemon-layers.ts`.

### Task 10: WebSocket routing, project discovery, session prefetch as scoped fibers

**WebSocket routing** (lines 1216-1266): `WebSocketRoutingLive` Layer attaches upgrade handler inside `Layer.scoped`, reading `AuthManagerTag` and `ProjectRegistryTag` from Context. The `shuttingDown` check reads `DaemonConfigRefTag`.

**Project discovery** (lines 1389-1512): `ProjectDiscoveryLive` Layer forks a scoped fiber that runs once at startup, calling the OpenCode SDK and adding projects to registry. Already has an Effect version in `daemon-main.ts:102-113` — use that instead of the imperative function.

**Session count prefetch** (lines 1337-1370): `SessionPrefetchLive` Layer forks a scoped fire-and-forget fiber.

**Depends on:** Tasks 6, 7 (needs ProjectRegistry and InstanceManager as Tags).

**Files:** Create `src/lib/effect/ws-routing-layer.ts`, `src/lib/effect/project-discovery-layer.ts`. Modify `daemon-main.ts`.

### Task 11: Eliminate DaemonLiveOptions and DaemonLifecycleContext

`DaemonLiveOptions` was the bridge between imperative construction and Layer composition. With all services now Layers, this interface disappears.

`makeDaemonLive` changes signature:

```typescript
// Before:
export const makeDaemonLive = (options: DaemonLiveOptions) => ...

// After:
export const makeDaemonLive = (options: DaemonOptions) => ...
```

`DaemonLifecycleContext` (mutable object for server refs) is replaced by server Layers providing their own state via Tags. HTTP server provides its `Server` instance via a Tag. IPC server provides its socket via a Tag.

**Depends on:** Tasks 3-10 (all services must be Layers).

**Files:** Modify `src/lib/effect/daemon-layers.ts`. Delete `DaemonLiveOptions` interface. Modify `daemon-lifecycle.ts` to remove `DaemonLifecycleContext` (or convert to Effect).

### Task 12: Collapse startDaemonProcess to Layer.launch

Final task. `startDaemonProcess` becomes:

```typescript
export const startDaemonProcess = (options: DaemonOptions) =>
  Effect.runFork(Layer.launch(makeDaemonLive(options)));
```

`DaemonHandle` (returned for `--foreground` mode) becomes an Effect service accessible via `ManagedRuntime`:

```typescript
// For --foreground mode in cli-core.ts:
const runtime = ManagedRuntime.make(makeDaemonLive(options));
await runtime.runPromise(Effect.void); // starts daemon
const handle = await runtime.runPromise(DaemonHandleTag);
// use handle for foreground operations
```

Delete all dead code — the ~1200 lines of imperative construction, helper closures, mutable variables.

**Depends on:** Task 11.

**Files:** Modify `src/lib/effect/daemon-main.ts` (massive deletion). Modify `src/bin/cli-core.ts` (foreground path).

## Dependency Graph

```
Task 1 (DaemonConfigRef) ← keystone
  │
  ├─ Task 2 (persistConfig)     ─┐
  ├─ Task 3 (background svc)     │ parallel
  ├─ Task 4 (CrashCounter/Auth)  │
  ├─ Task 5 (TLS)               ─┘
  │
  Task 6 (ProjectRegistry) ← needs Task 2
  │
  Task 7 (InstanceManager) ← needs Task 6
  │
  ├─ Task 8 (IPC handlers)    ─┐
  ├─ Task 9 (Relay factory)    │ parallel
  ├─ Task 10 (WS/discovery)   ─┘
  │
  Task 11 (eliminate DaemonLiveOptions) ← needs Tasks 3-10
  │
  Task 12 (Layer.launch) ← needs Task 11
```

## Scope Exclusions

Unchanged from Phase 7:
- **Frontend Svelte stores** — Svelte 5 `$state` is correct for reactive UI
- **Pure function modules** — already pure, no imperative patterns
- **Type-only files** — no runtime code
- **OpenCodeAPI class** — wraps external SDK, stays as `Layer.succeed`

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

1. `daemon-main.ts` is <50 lines (just `Layer.launch` + exports)
2. Zero `let` declarations in daemon startup path
3. Zero imperative class instantiation (`new ClassName()`)
4. Zero closure capture of mutable state
5. All daemon services discoverable via `Context.Tag`
6. All service errors typed in Layer error channels
7. `Layer.launch` handles full lifecycle (startup → signal → teardown)
8. All existing tests pass (`pnpm test:all`)
