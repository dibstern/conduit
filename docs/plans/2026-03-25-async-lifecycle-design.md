# Async Lifecycle Management Design

## Problem

The daemon fires background work (port scanning, health polling, project discovery, version checks) via `setInterval`, `setTimeout`, and fire-and-forget `fetch()` calls. `stop()` doesn't reliably cancel all of them, leaving orphaned handles that prevent the Node.js event loop from exiting. This causes `daemon.test.ts` to hang and represents a latent graceful-shutdown bug in production.

## Design

### AsyncTracker

A low-level bookkeeper that tracks timers, promises, and an AbortController:

```ts
class AsyncTracker {
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private timers = new Set<NodeJS.Timeout>();

  get signal(): AbortSignal { return this.controller.signal; }

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
    return promise;
  }

  interval(fn: () => void, ms: number): NodeJS.Timeout {
    const id = setInterval(fn, ms);
    this.timers.add(id);
    return id;
  }

  timeout(fn: () => void, ms: number): NodeJS.Timeout {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  clearTimer(id: NodeJS.Timeout): void {
    clearInterval(id); clearTimeout(id);
    this.timers.delete(id);
  }

  async drain(): Promise<void> {
    this.controller.abort();
    for (const id of this.timers) { clearInterval(id); clearTimeout(id); }
    this.timers.clear();
    await Promise.allSettled([...this.pending]);
  }
}
```

### TrackedService

An abstract base class that gives children safe wrappers for async work. Children never call raw `setInterval`, `setTimeout`, or `fetch` — they use the parent's methods, which automatically track everything.

```ts
abstract class TrackedService {
  private tracker = new AsyncTracker();

  constructor(registry: ServiceRegistry) {
    registry.register(this);
  }

  /** fetch() with automatic abort signal and promise tracking. */
  protected fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.tracker.track(
      fetch(url, { ...init, signal: this.tracker.signal })
    );
  }

  /** Tracked setInterval — cleared automatically on drain. */
  protected repeating(fn: () => void, ms: number): NodeJS.Timeout {
    return this.tracker.interval(fn, ms);
  }

  /** Tracked setTimeout — cleared automatically on drain. */
  protected delayed(fn: () => void, ms: number): NodeJS.Timeout {
    return this.tracker.timeout(fn, ms);
  }

  /** Track a fire-and-forget promise for drain. */
  protected tracked<T>(promise: Promise<T>): Promise<T> {
    return this.tracker.track(promise);
  }

  /** Cancel all work and wait for in-flight operations to settle. */
  async drain(): Promise<void> {
    await this.tracker.drain();
  }
}
```

### ServiceRegistry

Collects all `TrackedService` instances. One `drainAll()` call cleans up the entire tree.

```ts
class ServiceRegistry {
  private components = new Set<TrackedService>();

  register(component: TrackedService): void {
    this.components.add(component);
  }

  async drainAll(): Promise<void> {
    await Promise.allSettled(
      [...this.components].map(c => c.drain())
    );
    this.components.clear();
  }
}
```

### Daemon extends TrackedService

The Daemon is a TrackedService that also owns the registry. It creates the registry, passes it to `super()`, then passes it to children.

```ts
class Daemon extends TrackedService {
  private registry: ServiceRegistry;

  constructor(options: DaemonOptions) {
    const registry = new ServiceRegistry();
    super(registry);
    this.registry = registry;
  }

  async start() {
    this.portScanner = new PortScanner(this.registry);
    this.instanceManager = new InstanceManager(this.registry, ...);
    this.tracked(this.discoverProjects()); // fire-and-forget tracked
  }

  async stop() {
    await this.registry.drainAll(); // drains daemon + all children
    this.httpServer.close();
    this.ipcSocket.close();
  }
}
```

### Components that change

Each component that currently uses raw timers or fire-and-forget fetches extends `TrackedService`:

- **PortScanner**: `setInterval(scan, 30_000)` → `this.repeating(scan, 30_000)`, `fetch(url)` → `this.fetch(url)`
- **InstanceManager**: health polling intervals → `this.repeating(...)`, health check fetches → `this.fetch(...)`
- **VersionChecker**: version check fetch → `this.fetch(...)`
- **Daemon** (loose promises): `void this.discoverProjects()` → `this.tracked(this.discoverProjects())`

### Enforcement

1. **Constructor registration**: `TrackedService` requires a `ServiceRegistry` in its constructor. You cannot create one without registering it.
2. **One drain call**: `registry.drainAll()` drains everything. No list to maintain.
3. **Lint rule (optional)**: Flag raw `setInterval`, `setTimeout`, `global.fetch` in files that extend `TrackedService`.
4. **Diagnostic afterAll**: Tests log `process._getActiveHandles()` if any tracked components have undrained work.

### What goes away

- `_skipPortScanner` option on DaemonOptions (tests don't need it — `stop()` actually cleans up)
- Manual `clearInterval` calls scattered across components
- Fire-and-forget `void this.foo()` patterns (replaced with `this.tracked(this.foo())`)
