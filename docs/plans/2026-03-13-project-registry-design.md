# Project Registry Design

## Problem

The daemon manages project lifecycle with three independent data structures:

- `projects: Map<string, StoredProject>` — metadata registry
- `projectRelays: Map<string, ProjectRelay>` — live relay instances
- `pendingRelaySlugs: Set<string>` — concurrency guard

These structures have no coupling or invariant enforcement. A project can exist in `projects` without a corresponding relay in `projectRelays`. The HTTP router uses `projects` to decide whether to serve a page, while the WS upgrade handler uses `projectRelays` to decide whether to accept a connection. This split causes a race condition: the browser loads the page (project exists) but WebSocket upgrade is silently rejected (relay doesn't exist yet), producing a forever-loading screen.

Additional structural problems:

- **Silent WS failures.** All three WS upgrade rejection paths called `socket.destroy()` with no logging or client feedback, making the race invisible.
- **Fire-and-forget initialization.** `discoverProjects()` runs async after the HTTP server accepts connections. No readiness gate exists.
- **Mutable pass-by-reference context.** `DaemonProjectContext` passes all three data structures by reference to extracted functions in `daemon-projects.ts`, spreading mutation across two files with no lifecycle encapsulation.
- **Untyped EventEmitters.** Four daemon subsystems (`PortScanner`, `StorageMonitor`, `VersionChecker`, `KeepAwake`) define events interfaces but don't wire them to `EventEmitter<T>`, losing type safety at subscription sites.

## Solution

Replace the three data structures with a `ProjectRegistry` class that:

1. Stores a single `Map<string, ProjectEntry>` where `ProjectEntry` is a discriminated union with statuses `"registering"`, `"ready"`, and `"error"`
2. Extends `EventEmitter<ProjectRegistryEvents>` and emits lifecycle events
3. Exposes `waitForRelay(slug, timeoutMs)` — a promise that resolves when the relay becomes ready, eliminating polling
4. Encapsulates all project lifecycle operations
5. Makes it impossible at the type level to access a relay that doesn't exist

## Core Types

```typescript
interface ProjectRegistering {
  readonly status: "registering";
  readonly project: StoredProject;
}

interface ProjectReady {
  readonly status: "ready";
  readonly project: StoredProject;
  readonly relay: ProjectRelay;
}

interface ProjectError {
  readonly status: "error";
  readonly project: StoredProject;
  readonly error: string;
}

type ProjectEntry = ProjectRegistering | ProjectReady | ProjectError;
```

TypeScript enforces that `relay` is only accessible after narrowing through `status === "ready"`. The compiler prevents the class of bug that caused the forever-loading screen.

## ProjectRegistry Class

```typescript
interface ProjectRegistryEvents {
  project_added:   [slug: string, project: StoredProject];
  project_ready:   [slug: string, relay: ProjectRelay];
  project_error:   [slug: string, error: string];
  project_updated: [slug: string, project: StoredProject];
  project_removed: [slug: string];
}

class ProjectRegistry extends EventEmitter<ProjectRegistryEvents> {
  private entries = new Map<string, ProjectEntry>();

  // ── Queries ──────────────────────────────────────────────────
  get(slug: string): ProjectEntry | undefined;
  getProject(slug: string): StoredProject | undefined;       // any status
  getRelay(slug: string): ProjectRelay | undefined;           // only "ready"
  has(slug: string): boolean;
  isReady(slug: string): boolean;
  findByDirectory(directory: string): ProjectEntry | undefined;
  allProjects(): StoredProject[];
  readyEntries(): Array<[string, ProjectReady]>;
  slugs(): IterableIterator<string>;
  get size(): number;

  // ── Lifecycle ────────────────────────────────────────────────
  add(project: StoredProject,
      createRelay: (signal: AbortSignal) => Promise<ProjectRelay>): void;
  addWithoutRelay(project: StoredProject): void;
  startRelay(slug: string,
      createRelay: (signal: AbortSignal) => Promise<ProjectRelay>): void;
  remove(slug: string): Promise<void>;
  replaceRelay(slug: string,
      createRelay: (signal: AbortSignal) => Promise<ProjectRelay>): Promise<void>;
  updateProject(slug: string,
      updates: Partial<Pick<StoredProject, "title" | "instanceId">>): void;

  // ── WS upgrade helper ────────────────────────────────────────
  waitForRelay(slug: string, timeoutMs?: number): Promise<ProjectRelay>;

  // ── Teardown ─────────────────────────────────────────────────
  stopAll(): Promise<void>;
}
```

### Relay factory as callback

The relay factory is a callback (`(signal: AbortSignal) => Promise<ProjectRelay>`), not an internal concern. The registry doesn't know about `OpenCodeClient`, `SSEConsumer`, or any relay internals. The daemon constructs the factory closure, which captures daemon state (httpServer, instanceManager, etc.). This keeps the registry testable with simple stubs.

### waitForRelay implementation

```typescript
waitForRelay(slug: string, timeoutMs = 10_000): Promise<ProjectRelay> {
  return new Promise((resolve, reject) => {
    const entry = this.entries.get(slug);

    if (!entry) {
      reject(new Error(`Project "${slug}" not found`));
      return;
    }
    if (entry.status === "ready") {
      resolve(entry.relay);
      return;
    }
    if (entry.status === "error") {
      reject(new Error(`Project "${slug}" relay failed: ${entry.error}`));
      return;
    }

    // status === "registering" — wait for resolution
    const cleanup = () => {
      this.off("project_ready", onReady);
      this.off("project_error", onError);
      this.off("project_removed", onRemoved);
      clearTimeout(timer);
    };

    const onReady = (readySlug: string, relay: ProjectRelay) => {
      if (readySlug !== slug) return;
      cleanup();
      resolve(relay);
    };
    const onError = (errorSlug: string, error: string) => {
      if (errorSlug !== slug) return;
      cleanup();
      reject(new Error(`Project "${slug}" relay failed: ${error}`));
    };
    const onRemoved = (removedSlug: string) => {
      if (removedSlug !== slug) return;
      cleanup();
      reject(new Error(`Project "${slug}" was removed`));
    };

    this.on("project_ready", onReady);
    this.on("project_error", onError);
    this.on("project_removed", onRemoved);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out waiting for relay "${slug}" (${timeoutMs}ms)`
      ));
    }, timeoutMs);
  });
}
```

Properties: one-shot per call, three exit paths plus timeout, no leaked listeners.

### Cancellation via AbortSignal

Each `add()` / `startRelay()` call creates an `AbortController`. If `remove()` is called mid-creation, the controller is aborted. When the factory resolves after abort, the result is discarded and `relay.stop()` is called to clean up.

## How the Daemon Consumes the Registry

### WS upgrade handler

```typescript
this.httpServer.on("upgrade", async (req, socket, head) => {
  const match = req.url?.match(/^\/p\/([^/]+)\/ws(?:\?|$)/);
  if (!match) { socket.destroy(); return; }
  const slug = match[1]!;

  if (this.auth.hasPin() && !this.router!.checkAuth(req)) {
    this.log.warn({ slug }, "WS upgrade rejected: auth failed");
    socket.destroy();
    return;
  }

  try {
    const relay = await this.registry.waitForRelay(slug, 10_000);
    if (socket.destroyed) return;
    relay.wsHandler.handleUpgrade(req, socket, head);
  } catch {
    this.log.warn({ slug }, "WS upgrade rejected: relay not available");
    socket.destroy();
  }
});
```

No polling. No setTimeout loops. The promise resolves via event listener when the relay becomes ready.

### Event subscriptions

```typescript
// Persist config on every mutation
this.registry.on("project_added", () => this.persistConfig());
this.registry.on("project_ready", () => this.persistConfig());
this.registry.on("project_updated", () => this.persistConfig());
this.registry.on("project_removed", () => this.persistConfig());

// Broadcast to browsers via ready relays
this.instanceManager.on("status_changed", (instance) => {
  for (const [, entry] of this.registry.readyEntries()) {
    entry.relay.wsHandler.broadcast(
      { type: "instance_status", ...instance }
    );
  }
});
```

### Rehydration

```typescript
for (const proj of savedConfig.projects) {
  const project: StoredProject = {
    slug: proj.slug, directory: proj.path, ...
  };
  const opencodeUrl = this.resolveOpencodeUrl(project.instanceId);
  if (opencodeUrl) {
    this.registry.add(
      project, this.buildRelayFactory(project, opencodeUrl)
    );
  } else {
    this.registry.addWithoutRelay(project);
  }
}
// No need to await — WS upgrade handler waits via waitForRelay()
```

### Relay factory builder

```typescript
private buildRelayFactory(
  project: StoredProject,
  opencodeUrl: string,
): (signal: AbortSignal) => Promise<ProjectRelay> {
  return async (signal: AbortSignal) => {
    const { createProjectRelay } = await import(
      "../relay/relay-stack.js"
    );
    return createProjectRelay({
      httpServer: this.httpServer!,
      opencodeUrl,
      projectDir: project.directory,
      slug: project.slug,
      noServer: true,
      signal,
      log: createLogger("relay"),
      getProjects: () =>
        this.registry.allProjects().map((p) => ({
          slug: p.slug,
          title: p.title,
          directory: p.directory,
          ...(p.instanceId != null && { instanceId: p.instanceId }),
        })),
      addProject: async (dir: string) => {
        const p = await this.addProject(dir);
        return {
          slug: p.slug,
          title: p.title,
          directory: p.directory,
          ...(p.instanceId != null && { instanceId: p.instanceId }),
        };
      },
      getInstances: () => this.getInstances(),
      addInstance: (id, config) =>
        this.instanceManager.addInstance(id, config),
      removeInstance: (id) => this.instanceManager.removeInstance(id),
      startInstance: (id) => this.instanceManager.startInstance(id),
      stopInstance: (id) => this.instanceManager.stopInstance(id),
      updateInstance: (id, updates) =>
        this.instanceManager.updateInstance(id, updates),
      persistConfig: () => this.persistConfig(),
      ...(this.scanner != null && {
        triggerScan: () => this.scanner!.scan(),
      }),
      setProjectInstance: (slug, instanceId) =>
        this.setProjectInstance(slug, instanceId),
      ...(this.pushManager != null && {
        pushManager: this.pushManager,
      }),
      configDir: this.configDir,
    });
  };
}
```

## What Moves Where

### Functions from daemon-projects.ts

| Current function | New home | Notes |
|---|---|---|
| `addProject(ctx, directory, slug?, instanceId?)` | Daemon method | Business logic: dedup-by-directory, slug generation, instance resolution. Calls `registry.add()`. |
| `removeProject(ctx, slug)` | Daemon method | Calls `registry.remove()`. Config persistence via event subscription. |
| `setProjectInstance(ctx, slug, instanceId)` | Daemon method | Calls `registry.updateProject()` then `registry.replaceRelay()`. |
| `startProjectRelay(ctx, project, opencodeUrl)` | Split | Factory construction -> `Daemon.buildRelayFactory()`. Lifecycle -> `ProjectRegistry.add()` / `startRelay()`. |
| `getProjectOpencodeUrl(ctx, instanceId?)` | Daemon method | Pure lookup against `instanceManager`. |
| `getProjects(ctx)` | Deleted | Replaced by `registry.allProjects()`. |
| `discoverProjects(ctx)` | Daemon method | Queries OpenCode API, calls `this.addProject()` for each. |

`daemon-projects.ts` is deleted. `DaemonProjectContext` interface is deleted.

### IPC handler updates

| IPC command | Current | New |
|---|---|---|
| `addProject` | `addProjectImpl(this.asProjectContext(), dir)` | `this.addProject(dir)` |
| `removeProject` | `removeProjectImpl(this.asProjectContext(), slug)` | `this.removeProject(slug)` |
| `getProjects` | `this.getProjects()` | `this.registry.allProjects()` |
| `getProjectBySlug` | `this.projects.get(slug)` | `this.registry.getProject(slug)` |
| `setProjectTitle` | `this.projects.get(slug)!.title = newTitle` | `this.registry.updateProject(slug, { title: newTitle })` |
| `setProjectInstance` | `setProjectInstanceImpl(...)` | `this.setProjectInstance(slug, id)` |

### Router enrichment

`RouterProject` gains a `status` field:

```typescript
interface RouterProject {
  slug: string;
  title: string;
  directory: string;
  status: "registering" | "ready" | "error";
  clients: number;       // 0 if not ready
  sessions: number;      // 0 if not ready
  isProcessing: boolean; // false if not ready
}
```

The daemon's `getProjects` closure builds this from registry entries.

## AbortSignal Propagation

Add `signal?: AbortSignal` to `ProjectRelayConfig` in `types.ts`. Inside `createProjectRelay()` in `relay-stack.ts`, check the signal before expensive operations:

```typescript
export async function createProjectRelay(
  config: ProjectRelayConfig,
): Promise<ProjectRelay> {
  if (config.signal?.aborted) throw new Error("Relay creation aborted");

  // ... connect to OpenCode, resolve session ...

  if (config.signal?.aborted) throw new Error("Relay creation aborted");

  // ... start SSE, wire handlers ...
}
```

Checks at the two or three `await` boundaries where most time is spent (HTTP probe, session resolution, SSE connect).

## Opportunistic Cleanup: Typed EventEmitters

Wire the 4 daemon subsystems that have events interfaces defined but not connected, plus fix `InstanceManager`:

| Class | Change |
|---|---|
| `PortScanner` | Define `PortScannerEvents`, use `EventEmitter<PortScannerEvents>` |
| `StorageMonitor` | `extends EventEmitter<StorageMonitorEvents>` (interface already exists) |
| `VersionChecker` | `extends EventEmitter<VersionCheckerEvents>` (interface already exists) |
| `KeepAwake` | `extends EventEmitter<KeepAwakeEvents>` (interface already exists) |
| `InstanceManager` | `extends EventEmitter<InstanceManagerEvents>`, delete manual `override emit`/`on` overloads |

Low risk — the interfaces already exist in the correct tuple format.

## Testing Strategy

### Layer 1: ProjectRegistry unit tests

Pure state machine tests. No daemon, no real relay. Relay factory is a stub that resolves/rejects on command.

Test helpers:

```typescript
function immediateRelay():
    (signal: AbortSignal) => Promise<ProjectRelay> {
  return async () => ({
    wsHandler: mockWsHandler(), stop: vi.fn(), ...
  });
}

function delayedRelay(ms: number):
    (signal: AbortSignal) => Promise<ProjectRelay> {
  return async (signal) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    });
    return { wsHandler: mockWsHandler(), stop: vi.fn(), ... };
  };
}

function failingRelay(error: string):
    (signal: AbortSignal) => Promise<ProjectRelay> {
  return async () => { throw new Error(error); };
}
```

Test cases:

| Category | Test | Asserts |
|---|---|---|
| Lifecycle basics | `add()` sets status to "registering", emits `project_added` | entry status, event fired |
| | Relay factory resolves -> status "ready", emits `project_ready` | entry status, relay accessible via `getRelay()` |
| | Relay factory rejects -> status "error", emits `project_error` | entry status, error message |
| | `remove()` on ready project calls `relay.stop()`, emits `project_removed` | stop called, entry gone |
| | `remove()` on registering project aborts factory, discards result | signal aborted, entry gone |
| | `updateProject()` updates project fields, emits `project_updated` | new title/instanceId |
| Queries | `getRelay()` returns relay only for "ready" entries | undefined for registering/error |
| | `getProject()` returns project regardless of status | always defined if entry exists |
| | `allProjects()` returns all, `readyEntries()` returns only ready | correct filtering |
| | `findByDirectory()` finds by path regardless of status | dedup works |
| waitForRelay | Already ready -> resolves immediately | no delay |
| | Registering -> resolves when relay factory completes | timing correct |
| | Error -> rejects immediately | error message propagated |
| | Non-existent slug -> rejects immediately | descriptive error |
| | Timeout while registering -> rejects with timeout error | listener cleaned up |
| | Multiple concurrent waiters all resolve | all promises resolve |
| Concurrency | `add()` for existing slug throws | no duplicate entries |
| | `remove()` during registering, factory resolves -> relay stopped and discarded | no leaked relays |
| | `replaceRelay()` stops old, transitions to registering, then ready | correct sequence |
| | `startRelay()` on error entry retries -> can become ready | recovery works |
| Edge cases | `stopAll()` stops all ready relays, aborts all registering | clean shutdown |
| | `add()` then immediate `remove()` before factory starts | no race |

### Layer 2: Property-based tests

Random sequences of operations. Assert invariants always hold after any sequence:

1. Every entry with status "ready" has a non-null relay
2. Every entry with status "registering" or "error" has no relay accessible via `getRelay()`
3. `registry.size` equals the number of entries in the map
4. `allProjects().length` equals `size`
5. `readyEntries().length` is less than or equal to `size`
6. No slug appears twice
7. After `stopAll()`, `size` equals 0

Using fast-check commands: `AddProject`, `RemoveProject`, `UpdateProject`, `StartRelay`, `ReplaceRelay`, `WaitForRelay`.

### Layer 3: Stateful model-based test

A simplified model (plain Map of status strings) runs the same operations in parallel. After each step, assert the registry's state matches the model.

### Layer 4: Integration with daemon

Existing `daemon.test.ts` tests adapted to use the registry. Key test: start daemon, WS upgrade arrives before relay is ready, connection succeeds via `waitForRelay`.

### Layer 5: Regression test

1. Create a registry
2. Add a project with a delayed relay factory (500ms)
3. Immediately call `waitForRelay()`
4. Assert the promise resolves after the factory completes
5. Assert no polling was involved (event-driven)

## File Change Summary

| File | Action |
|---|---|
| `src/lib/daemon/project-registry.ts` | New — `ProjectRegistry` class, `ProjectEntry` union, `ProjectRegistryEvents` |
| `src/lib/daemon/daemon-projects.ts` | Deleted — all logic moves to registry or daemon methods |
| `src/lib/daemon/daemon.ts` | Modified — replace 3 fields with `registry`, add `buildRelayFactory`, `addProject`, `removeProject`, `setProjectInstance` methods, update IPC handlers, update event subscriptions |
| `src/lib/types.ts` | Modified — add `signal?: AbortSignal` to `ProjectRelayConfig`, add `status` to `RouterProject` |
| `src/lib/server/http-router.ts` | Modified — `RouterProject` gets `status` field |
| `src/lib/relay/relay-stack.ts` | Modified — check `config.signal` at await boundaries |
| `src/lib/daemon/port-scanner.ts` | Modified — wire `EventEmitter<T>` |
| `src/lib/daemon/storage-monitor.ts` | Modified — wire `EventEmitter<T>` |
| `src/lib/daemon/version-check.ts` | Modified — wire `EventEmitter<T>` |
| `src/lib/daemon/keep-awake.ts` | Modified — wire `EventEmitter<T>` |
| `src/lib/instance/instance-manager.ts` | Modified — switch to `EventEmitter<T>`, delete manual overloads |
| `test/unit/daemon/project-registry.test.ts` | New — layers 1-3 of testing strategy |
| `test/unit/daemon/daemon-projects-wiring.test.ts` | Deleted — replaced by registry tests |
| `test/unit/daemon/daemon.test.ts` | Modified — update project/relay assertions to use registry |
| `test/helpers/mock-factories.ts` | Modified — add `createMockProjectRelay()` shared factory |

## Audit Amendments

Post-design audit of daemon.ts revealed additional consumption sites and testing gaps.

### Scope: daemon-only

This design covers the daemon mode (`Daemon` class in `daemon.ts`). Two parallel implementations exist:

- `RelayServer` in `src/lib/server/server.ts` has its own `ProjectEntry` type (with `onUpgrade`/`onApiRequest` callbacks) and its own `projects: Map<string, ProjectEntry>`. This is the standalone server mode.
- `createProjectRelay()` in `src/lib/relay/relay-stack.ts` has local `relays: Map` + `pendingSlugs: Set` used by standalone `addProjectRelay()`.

Both are out of scope for this refactor. The standalone server may adopt `ProjectRegistry` in a future pass.

### Additional daemon methods that access project/relay state

| Method | Current access | Registry replacement |
|---|---|---|
| `getStatus()` | `this.projects.size` | `this.registry.size` |
| `buildConfig()` | `this.getProjects()` | `this.registry.allProjects()` |
| `stop()` | `this.projects.clear()` + iterates `this.projectRelays.values()` | `this.registry.stopAll()` |
| Constructor `instanceManager` handler (lines 285-293) | Iterates `this.projectRelays.values()` | `this.registry.readyEntries()` |

### DaemonIPCContext

`DaemonIPCContext` is a separate interface from `DaemonProjectContext`, defined inline in `daemon.ts` `startIPCServer()` method. Two closures directly access `this.projects`:

- `getProjectBySlug`: `this.projects.get(slug)` → `this.registry.getProject(slug)`
- `setProjectTitle`: `this.projects.get(slug)!.title = newTitle` → `this.registry.updateProject(slug, { title: newTitle })`

These must go through the registry.

### Config persistence in IPC handlers

Several IPC handlers call `saveDaemonConfig(ctx.buildConfig(), ctx.configDir)`:

- `set_project_title`, `instance_add`, `instance_remove`, `instance_update`

For project-related saves, the registry's event subscriptions handle persistence automatically. Instance-related saves remain explicit since they're outside the registry's scope.

### WS upgrade handler tests

**No daemon-level WS upgrade handler tests exist today.** This is the exact code path where the forever-loading bug lived. The testing strategy should include Layer 4 tests that verify:

1. WS upgrade arrives when relay is ready → accepted
2. WS upgrade arrives when relay is registering → waits and accepts when ready
3. WS upgrade arrives for unknown slug → rejected
4. WS upgrade arrives when relay errors → rejected
5. WS upgrade arrives after auth failure → rejected

## Audit Amendments

Post-design audit of daemon.ts revealed additional consumption sites and testing gaps.

### Scope: daemon-only

This design covers the daemon mode (`Daemon` class in `daemon.ts`). Two parallel implementations exist:

- `RelayServer` in `src/lib/server/server.ts` has its own `ProjectEntry` type (with `onUpgrade`/`onApiRequest` callbacks) and its own `projects: Map<string, ProjectEntry>`. This is the standalone server mode.
- `createProjectRelay()` in `src/lib/relay/relay-stack.ts` has local `relays: Map` + `pendingSlugs: Set` used by standalone `addProjectRelay()`.

Both are out of scope for this refactor. The standalone server may adopt `ProjectRegistry` in a future pass.

### Additional daemon methods that access project/relay state

| Method | Current access | Registry replacement |
|---|---|---|
| `getStatus()` | `this.projects.size` | `this.registry.size` |
| `buildConfig()` | `this.getProjects()` | `this.registry.allProjects()` |
| `stop()` | `this.projects.clear()` + iterates `this.projectRelays.values()` | `this.registry.stopAll()` |
| Constructor `instanceManager` handler (lines 285-293) | Iterates `this.projectRelays.values()` | `this.registry.readyEntries()` |

### DaemonIPCContext

`DaemonIPCContext` is a separate interface from `DaemonProjectContext`, defined inline in `daemon.ts` `startIPCServer()` method. Two closures directly access `this.projects`:

- `getProjectBySlug`: `this.projects.get(slug)` → `this.registry.getProject(slug)`
- `setProjectTitle`: `this.projects.get(slug)!.title = newTitle` → `this.registry.updateProject(slug, { title: newTitle })`

These must go through the registry.

### Config persistence in IPC handlers

Several IPC handlers call `saveDaemonConfig(ctx.buildConfig(), ctx.configDir)`:

- `set_project_title`, `instance_add`, `instance_remove`, `instance_update`

For project-related saves, the registry's event subscriptions handle persistence automatically. Instance-related saves remain explicit since they're outside the registry's scope.

### WS upgrade handler tests

**No daemon-level WS upgrade handler tests exist today.** This is the exact code path where the forever-loading bug lived. The testing strategy should include Layer 4 tests that verify:

1. WS upgrade arrives when relay is ready → accepted
2. WS upgrade arrives when relay is registering → waits and accepts when ready
3. WS upgrade arrives for unknown slug → rejected
4. WS upgrade arrives when relay errors → rejected
5. WS upgrade arrives after auth failure → rejected
