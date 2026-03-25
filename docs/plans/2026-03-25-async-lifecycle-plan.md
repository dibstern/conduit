# Async Lifecycle Management Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make every background async operation in the daemon trackable, cancellable, and awaitable — by construction, not convention — so `stop()` fully cleans up and tests never hang.

**Architecture:** A `TrackedService` base class wraps `setInterval`, `setTimeout`, `fetch`, and fire-and-forget promises into tracked versions. A `ServiceRegistry` collects all `TrackedService` instances for bulk drain. The `Daemon` and its child services (PortScanner, InstanceManager, VersionChecker, StorageMonitor, KeepAwake) extend `TrackedService`. `Daemon.stop()` calls `registry.drainAll()` — one call, everything cleaned up.

**Tech Stack:** Node.js EventEmitter, AbortController, Vitest, fast-check

**Design doc:** `docs/plans/2026-03-25-async-lifecycle-design.md`

**Scope:** Daemon-level services only. Relay-level services (SSEConsumer, SessionStatusPoller, etc.) are already cleaned up by `relay.stop()` and can be migrated in a follow-up.

---

### Task 1: Create AsyncTracker, TrackedService, and ServiceRegistry

**Files:**
- Create: `src/lib/daemon/async-tracker.ts`
- Create: `src/lib/daemon/tracked-service.ts`
- Create: `src/lib/daemon/service-registry.ts`
- Test: `test/unit/daemon/async-tracker.test.ts`
- Test: `test/unit/daemon/tracked-service.test.ts`

**Step 1: Write AsyncTracker tests**

```ts
// test/unit/daemon/async-tracker.test.ts
import { describe, it, expect, vi } from "vitest";
import { AsyncTracker } from "../../src/lib/daemon/async-tracker.js";

describe("AsyncTracker", () => {
    it("track() registers and unregisters a promise", async () => {
        const tracker = new AsyncTracker();
        let resolve!: () => void;
        const p = new Promise<void>((r) => { resolve = r; });
        tracker.track(p);
        expect(tracker.pendingCount).toBe(1);
        resolve();
        await p;
        // Give microtask queue time to process .finally()
        await Promise.resolve();
        expect(tracker.pendingCount).toBe(0);
    });

    it("interval() creates a tracked interval", () => {
        const tracker = new AsyncTracker();
        const fn = vi.fn();
        tracker.interval(fn, 100);
        expect(tracker.timerCount).toBe(1);
    });

    it("timeout() creates a tracked timeout that self-removes", async () => {
        const tracker = new AsyncTracker();
        const fn = vi.fn();
        tracker.timeout(fn, 10);
        expect(tracker.timerCount).toBe(1);
        await new Promise((r) => setTimeout(r, 50));
        expect(fn).toHaveBeenCalledTimes(1);
        expect(tracker.timerCount).toBe(0);
    });

    it("drain() aborts the signal", async () => {
        const tracker = new AsyncTracker();
        expect(tracker.signal.aborted).toBe(false);
        await tracker.drain();
        expect(tracker.signal.aborted).toBe(true);
    });

    it("drain() clears all timers", async () => {
        const tracker = new AsyncTracker();
        const fn = vi.fn();
        tracker.interval(fn, 100);
        tracker.timeout(fn, 100);
        expect(tracker.timerCount).toBe(2);
        await tracker.drain();
        expect(tracker.timerCount).toBe(0);
    });

    it("drain() waits for tracked promises to settle", async () => {
        const tracker = new AsyncTracker();
        let resolved = false;
        const p = new Promise<void>((resolve) => {
            setTimeout(() => { resolved = true; resolve(); }, 50);
        });
        tracker.track(p);
        await tracker.drain();
        expect(resolved).toBe(true);
        expect(tracker.pendingCount).toBe(0);
    });

    it("drain() handles rejected promises without throwing", async () => {
        const tracker = new AsyncTracker();
        const p = Promise.reject(new Error("boom"));
        p.catch(() => {}); // prevent unhandled rejection
        tracker.track(p);
        await expect(tracker.drain()).resolves.toBeUndefined();
    });

    it("clearTimer() removes a specific timer", () => {
        const tracker = new AsyncTracker();
        const fn = vi.fn();
        const id = tracker.interval(fn, 100);
        expect(tracker.timerCount).toBe(1);
        tracker.clearTimer(id);
        expect(tracker.timerCount).toBe(0);
    });

    it("signal is aborted after drain", async () => {
        const tracker = new AsyncTracker();
        const signal = tracker.signal;
        await tracker.drain();
        expect(signal.aborted).toBe(true);
    });
});
```

**Step 2: Implement AsyncTracker**

```ts
// src/lib/daemon/async-tracker.ts

/**
 * Tracks timers, promises, and an AbortController for lifecycle management.
 * Used internally by TrackedService — not used directly by application code.
 */
export class AsyncTracker {
    private controller = new AbortController();
    private pending = new Set<Promise<unknown>>();
    private timers = new Set<ReturnType<typeof setInterval>>();

    /** AbortSignal that is aborted on drain(). Pass to fetch() etc. */
    get signal(): AbortSignal {
        return this.controller.signal;
    }

    /** Number of pending tracked promises. Exposed for testing. */
    get pendingCount(): number {
        return this.pending.size;
    }

    /** Number of tracked timers. Exposed for testing. */
    get timerCount(): number {
        return this.timers.size;
    }

    /** Track a promise. It is removed from the set when it settles. */
    track<T>(promise: Promise<T>): Promise<T> {
        this.pending.add(promise);
        promise.finally(() => this.pending.delete(promise));
        return promise;
    }

    /** Create a tracked setInterval. Cleared automatically on drain(). */
    interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
        const id = setInterval(fn, ms);
        this.timers.add(id);
        return id;
    }

    /** Create a tracked setTimeout. Self-removes when it fires. Cleared on drain(). */
    timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
        const id = setTimeout(() => {
            this.timers.delete(id);
            fn();
        }, ms);
        this.timers.add(id);
        return id;
    }

    /** Clear a specific timer (interval or timeout). */
    clearTimer(id: ReturnType<typeof setInterval>): void {
        clearInterval(id);
        clearTimeout(id);
        this.timers.delete(id);
    }

    /** Abort the signal, clear all timers, and await all pending promises. */
    async drain(): Promise<void> {
        this.controller.abort();
        for (const id of this.timers) {
            clearInterval(id);
            clearTimeout(id);
        }
        this.timers.clear();
        await Promise.allSettled([...this.pending]);
        this.pending.clear();
    }
}
```

**Step 3: Write TrackedService tests**

```ts
// test/unit/daemon/tracked-service.test.ts
import { describe, it, expect, vi } from "vitest";
import { TrackedService } from "../../src/lib/daemon/tracked-service.js";
import { ServiceRegistry } from "../../src/lib/daemon/service-registry.js";

// Concrete implementation for testing
class TestService extends TrackedService<{ tick: [count: number] }> {
    public tickCount = 0;

    startTicking(ms: number): void {
        this.repeating(() => {
            this.tickCount++;
            this.emit("tick", this.tickCount);
        }, ms);
    }

    async doWork(): Promise<string> {
        return this.tracked(
            new Promise<string>((resolve) => setTimeout(() => resolve("done"), 50))
        );
    }

    async doFetch(url: string): Promise<Response> {
        return this.fetch(url);
    }
}

describe("TrackedService", () => {
    it("auto-registers with the ServiceRegistry on construction", () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        expect(registry.size).toBe(1);
    });

    it("repeating() creates a tracked interval", async () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        svc.startTicking(50);
        await new Promise((r) => setTimeout(r, 130));
        expect(svc.tickCount).toBeGreaterThanOrEqual(2);
        await svc.drain();
        const countAfterDrain = svc.tickCount;
        await new Promise((r) => setTimeout(r, 100));
        expect(svc.tickCount).toBe(countAfterDrain); // no more ticks
    });

    it("tracked() registers fire-and-forget promises", async () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        const result = svc.doWork();
        await expect(result).resolves.toBe("done");
    });

    it("drain() cancels the signal for fetch", async () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        await svc.drain();
        await expect(svc.doFetch("http://localhost:1")).rejects.toThrow();
    });

    it("preserves EventEmitter functionality", () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        const events: number[] = [];
        svc.on("tick", (count) => events.push(count));
        svc.emit("tick", 42);
        expect(events).toEqual([42]);
    });
});

describe("ServiceRegistry", () => {
    it("drainAll() drains all registered services", async () => {
        const registry = new ServiceRegistry();
        const svc1 = new TestService(registry);
        const svc2 = new TestService(registry);
        svc1.startTicking(50);
        svc2.startTicking(50);
        await registry.drainAll();
        const c1 = svc1.tickCount;
        const c2 = svc2.tickCount;
        await new Promise((r) => setTimeout(r, 100));
        expect(svc1.tickCount).toBe(c1);
        expect(svc2.tickCount).toBe(c2);
    });

    it("drainAll() clears the registry", async () => {
        const registry = new ServiceRegistry();
        new TestService(registry);
        expect(registry.size).toBe(1);
        await registry.drainAll();
        expect(registry.size).toBe(0);
    });
});
```

**Step 4: Implement TrackedService and ServiceRegistry**

```ts
// src/lib/daemon/tracked-service.ts
import { EventEmitter } from "node:events";
import { AsyncTracker } from "./async-tracker.js";
import type { ServiceRegistry } from "./service-registry.js";

/**
 * Base class for daemon services that do background async work.
 * Provides tracked wrappers for fetch, setInterval, setTimeout,
 * and fire-and-forget promises. All work is cancellable via drain().
 *
 * Children use this.fetch(), this.repeating(), this.delayed(), this.tracked()
 * instead of raw APIs. Never call raw setInterval/setTimeout/fetch in a
 * TrackedService subclass.
 */
export abstract class TrackedService<
    Events extends Record<string, unknown[]> = Record<string, never[]>,
> extends EventEmitter<Events> {
    private readonly _tracker = new AsyncTracker();

    constructor(registry: ServiceRegistry) {
        super();
        registry.register(this);
    }

    /** fetch() with automatic abort signal and promise tracking. */
    protected fetch(url: string, init?: RequestInit): Promise<Response> {
        return this._tracker.track(
            fetch(url, { ...init, signal: this._tracker.signal }),
        );
    }

    /** Tracked setInterval — cleared automatically on drain(). */
    protected repeating(fn: () => void, ms: number): ReturnType<typeof setInterval> {
        return this._tracker.interval(fn, ms);
    }

    /** Tracked setTimeout — cleared automatically on drain(). */
    protected delayed(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
        return this._tracker.timeout(fn, ms);
    }

    /** Track a fire-and-forget promise for drain. */
    protected tracked<T>(promise: Promise<T>): Promise<T> {
        return this._tracker.track(promise);
    }

    /** Clear a specific tracked timer. */
    protected clearTrackedTimer(id: ReturnType<typeof setInterval>): void {
        this._tracker.clearTimer(id);
    }

    /** Cancel all work and wait for in-flight operations to settle. */
    async drain(): Promise<void> {
        await this._tracker.drain();
    }
}
```

```ts
// src/lib/daemon/service-registry.ts
import type { TrackedService } from "./tracked-service.js";

/**
 * Collects TrackedService instances. One drainAll() call cleans up everything.
 */
export class ServiceRegistry {
    private readonly services = new Set<TrackedService>();

    /** Number of registered services. Exposed for testing. */
    get size(): number {
        return this.services.size;
    }

    /** Register a service. Called automatically by TrackedService constructor. */
    register(service: TrackedService): void {
        this.services.add(service);
    }

    /** Drain all registered services and clear the registry. */
    async drainAll(): Promise<void> {
        await Promise.allSettled(
            [...this.services].map((s) => s.drain()),
        );
        this.services.clear();
    }
}
```

**Step 5: Run tests, verify, commit**

Run: `pnpm check && pnpm lint && pnpm vitest run test/unit/daemon/async-tracker.test.ts test/unit/daemon/tracked-service.test.ts`

```bash
git add src/lib/daemon/async-tracker.ts src/lib/daemon/tracked-service.ts src/lib/daemon/service-registry.ts test/unit/daemon/async-tracker.test.ts test/unit/daemon/tracked-service.test.ts
git commit -m "feat: add AsyncTracker, TrackedService, and ServiceRegistry for lifecycle management"
```

---

### Task 2: PortScanner extends TrackedService

**Files:**
- Modify: `src/lib/daemon/port-scanner.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass registry to PortScanner)
- Modify: `test/unit/daemon/port-scanner.test.ts`

**Changes:**

1. `PortScanner` changes from `extends EventEmitter<PortScannerEvents>` to `extends TrackedService<PortScannerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter, calls `super(registry)`
3. `start()` replaces `this.timer = setInterval(...)` with `this.timer = this.repeating(...)`
4. `stop()` replaces `clearInterval(this.timer)` with `this.clearTrackedTimer(this.timer)` (keeps the manual stop for API compat)
5. In `daemon.ts`, pass `this.registry` to `new PortScanner(this.registry, config, probeFn)`

**Tests to update:**
- All tests that construct `new PortScanner(config, probeFn)` now need a registry: `new PortScanner(new ServiceRegistry(), config, probeFn)`
- Add test: after `drain()`, interval no longer fires
- Add test: in-flight `scan()` fetch is aborted by drain

**Step 1: Update PortScanner tests (add registry param)**

Update all `new PortScanner(config, probeFn)` calls to `new PortScanner(new ServiceRegistry(), config, probeFn)`. Add import for `ServiceRegistry`.

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/daemon/port-scanner.test.ts`
Expected: Fail — constructor signature mismatch.

**Step 3: Refactor PortScanner**

```ts
import { TrackedService } from "./tracked-service.js";
import type { ServiceRegistry } from "./service-registry.js";

export class PortScanner extends TrackedService<PortScannerEvents> {
    constructor(registry: ServiceRegistry, config: PortScannerConfig, probeFn: ProbeFn) {
        super(registry);
        this.config = config;
        this.probeFn = probeFn;
    }

    start(): void {
        this.stop();
        this.timer = this.repeating(() => void this.scan(), this.config.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            this.clearTrackedTimer(this.timer);
            this.timer = null;
        }
    }
    // scan() unchanged — probeFn already uses AbortController internally
}
```

Remove `import { EventEmitter } from "node:events"`.

**Step 4: Update daemon.ts**

In `start()`, where `PortScanner` is constructed, pass `this.registry`:
```ts
this.scanner = new PortScanner(this.registry, scannerConfig, probeFn);
```

**Step 5: Run tests, verify, commit**

Run: `pnpm check && pnpm vitest run test/unit/daemon/port-scanner.test.ts`

```bash
git commit -m "refactor: PortScanner extends TrackedService"
```

---

### Task 3: VersionChecker extends TrackedService

**Files:**
- Modify: `src/lib/daemon/version-check.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass registry)
- Modify: `test/unit/daemon/version-check.test.ts`

**Changes:**

1. `VersionChecker` changes from `extends EventEmitter<VersionCheckEvents>` to `extends TrackedService<VersionCheckEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `start()` replaces `this.intervalHandle = setInterval(...)` with `this.intervalHandle = this.repeating(...)`
4. `stop()` uses `this.clearTrackedTimer(this.intervalHandle)`
5. `fetchLatestVersion()` — the standalone function takes a signal parameter so TrackedService's abort signal can be threaded through:
   - Add `signal?: AbortSignal` to `fetchLatestVersion()` params
   - Pass it to `fetchFn(url, { headers, signal })`
   - In `check()`, pass `this.signal` (exposed from tracker via a protected getter or passed through)

**For abort signal threading:** Add a protected getter on TrackedService:
```ts
protected get abortSignal(): AbortSignal {
    return this._tracker.signal;
}
```
Then in `check()`:
```ts
const latest = await fetchLatestVersion(this.packageName, this.registryUrl, this.fetchFn, this.abortSignal);
```

**Tests:** Update all `new VersionChecker(options)` to `new VersionChecker(new ServiceRegistry(), options)`.

**Step 1-5: Same TDD pattern as Task 2.**

```bash
git commit -m "refactor: VersionChecker extends TrackedService with abort signal on fetch"
```

---

### Task 4: StorageMonitor extends TrackedService

**Files:**
- Modify: `src/lib/daemon/storage-monitor.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass registry)
- Modify: `test/unit/daemon/storage-monitor.test.ts`

**Changes:**

1. `extends EventEmitter<StorageMonitorEvents>` → `extends TrackedService<StorageMonitorEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `start()` replaces `this.timer = setInterval(...)` with `this.timer = this.repeating(...)`, replaces `void this.check()` with `this.tracked(this.check())`
4. `stop()` uses `this.clearTrackedTimer(this.timer)`
5. Remove `.unref()` call — drain handles cleanup now (unref was a workaround for the exact problem we're fixing)

**Tests:** Update constructors, add drain test.

```bash
git commit -m "refactor: StorageMonitor extends TrackedService"
```

---

### Task 5: InstanceManager extends TrackedService (includes A2 fix)

**Files:**
- Modify: `src/lib/instance/instance-manager.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass registry)
- Modify: `test/unit/instance/instance-manager.test.ts`

**Changes:**

1. `extends EventEmitter<InstanceManagerEvents>` → `extends TrackedService<InstanceManagerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `startHealthPolling()` replaces `setInterval(...)` with `this.repeating(...)`, stores in `healthIntervals` map
4. `stopHealthPolling()` uses `this.clearTrackedTimer(interval)`
5. `cancelPendingRestart()` uses `this.clearTrackedTimer(timer)`
6. Health check fetch: Replace `fetch(url)` with `this.fetch(url)` (gets abort signal automatically)
7. Restart timeout: Replace `setTimeout(...)` with `this.delayed(...)`

**A2 fix — `stopAll()` clears ALL instances:**

```ts
stopAll(): void {
    // Stop ALL instances — not just non-stopped ones
    for (const instance of this.instances.values()) {
        this.cancelPendingRestart(instance.id);
        this.stopHealthPolling(instance.id);
        if (instance.status !== "stopped") {
            this.stopInstance(instance.id);
        }
    }
}
```

This ensures unmanaged instances (which start as "stopped" but have health polling) get their intervals cleared.

**Daemon.ts health checker injection:** The daemon injects a custom `healthChecker` function into InstanceManager. This function uses raw `fetch()` with no abort signal. Two options:
- a) Pass the abort signal from TrackedService to the injected health checker
- b) Make the injected health checker use the InstanceManager's `this.fetch()` by moving it into the class

Option (b) is cleaner. Move the health check logic from the lambda in `daemon.ts:302-320` into `InstanceManager` and use `this.fetch()`.

**Tests:** Update all constructors. Add test that `stopAll()` clears health polling for instances with status "stopped". Add test that health check fetch is aborted on drain.

```bash
git commit -m "refactor: InstanceManager extends TrackedService; fix stopAll() to clear all intervals"
```

---

### Task 6: KeepAwake extends TrackedService

**Files:**
- Modify: `src/lib/daemon/keep-awake.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass registry)
- Modify: `test/unit/daemon/keep-awake.test.ts`

**Changes:**

1. `KeepAwake` currently extends `EventEmitter` (plain, not typed). Change to `extends TrackedService<KeepAwakeEvents>` — define a `KeepAwakeEvents` type for the events it emits.
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. The child process spawn is not a timer/fetch — it stays as-is (process.kill for cleanup is already correct)
4. `drain()` override: call `this.deactivate()` then `super.drain()` — ensure the child process is killed during drain

**Tests:** Update all constructors. This is the most test-heavy file — all T1-T19 tests need `new ServiceRegistry()` passed.

```bash
git commit -m "refactor: KeepAwake extends TrackedService"
```

---

### Task 7: Daemon extends TrackedService + uses ServiceRegistry

**Files:**
- Modify: `src/lib/daemon/daemon.ts`
- Modify: `test/unit/daemon/daemon.test.ts`

**Changes:**

1. `class Daemon` → `class Daemon extends TrackedService`
2. Constructor creates `ServiceRegistry`, passes to `super(registry)`, stores `this.registry = registry`

```ts
export class Daemon extends TrackedService {
    private registry: ServiceRegistry;

    constructor(options?: DaemonOptions) {
        const registry = new ServiceRegistry();
        super(registry);
        this.registry = registry;
        // ... rest of existing constructor
    }
}
```

3. In `start()`, replace fire-and-forget patterns:
   - `void this.discoverProjects().catch(...)` → `this.tracked(this.discoverProjects().catch(...))`
   - `void this.scanner.scan()` → `this.tracked(this.scanner.scan())`

4. Replace the untracked shutdown timeout:
   - `setTimeout(() => this.stop(), DAEMON_SHUTDOWN_DELAY_MS)` → `this.delayed(() => this.stop(), DAEMON_SHUTDOWN_DELAY_MS)` and store the timer ID so it can be cleared if `stop()` is called through another path

5. **Rewrite `stop()`:**

```ts
async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Remove signal handlers
    removeSignalHandlers();

    // Persist final config so instances survive restart
    saveDaemonConfig(this.buildConfig(), this.configDir);

    // Drain ALL tracked services (PortScanner, InstanceManager, VersionChecker,
    // StorageMonitor, KeepAwake, and Daemon's own tracked promises).
    // This aborts all in-flight fetch, clears all intervals/timeouts,
    // and waits for pending promises to settle.
    await this.registry.drainAll();

    // Close IPC clients
    for (const client of this.ipcClients) {
        try { client.destroy(); } catch { /* already closed */ }
    }
    this.ipcClients.clear();

    // Close servers
    await this.closeIPC();
    await this.closeOnboarding();
    await this.closeHttp();

    // Remove files
    removePidFile(this.pidPath);
    removeSocketFile(this.socketPath);

    this.shuttingDown = false;
}
```

The individual `this.versionChecker?.stop()`, `this.scanner?.stop()`, etc. calls are REMOVED — `drainAll()` handles everything.

**Note:** `registry.stopAll()` (ProjectRegistry) and `instanceManager.stopAll()` are still called by `drainAll()` via their respective `drain()` methods. But `ProjectRegistry` doesn't extend `TrackedService` yet (it's relay-level, out of scope). So keep the explicit `await this.registry.stopAll()` before `drainAll()` for now, OR call it inside the Daemon's own `drain()` override.

**Tests:** Daemon tests that check stop behavior need updating. Tests no longer need `_skipPortScanner` (remove it).

```bash
git commit -m "refactor: Daemon extends TrackedService; stop() uses registry.drainAll()"
```

---

### Task 8: Remove _skipPortScanner, add F1 diagnostic

**Files:**
- Modify: `src/lib/daemon/daemon.ts` (remove `_skipPortScanner` from DaemonOptions, remove the guard)
- Modify: `test/unit/daemon/daemon.test.ts` (remove `_skipPortScanner: true` from `daemonOpts`)
- Create or modify: `test/unit/daemon/setup.ts` or `vitest.setup.ts` (add active handle diagnostic)

**Step 1: Remove _skipPortScanner**

In `daemon.ts`:
- Remove `_skipPortScanner?: boolean` from `DaemonOptions`
- Remove `private readonly skipPortScanner: boolean`
- Remove `this.skipPortScanner = options?._skipPortScanner ?? false`
- Remove the `if (!this.skipPortScanner)` guard around PortScanner creation — PortScanner always starts, `drainAll()` always cleans it up

In `daemon.test.ts`:
- Remove `_skipPortScanner: true` from `daemonOpts()`

**Step 2: Add F1 diagnostic**

Add an `afterAll` hook to `daemon.test.ts` (or a shared setup file):

```ts
afterAll(() => {
    // F1 diagnostic: log active handles if any remain after all tests
    // This surfaces leaked timers/connections immediately
    const handles = (process as any)._getActiveHandles?.() ?? [];
    const requests = (process as any)._getActiveRequests?.() ?? [];
    if (handles.length > 0 || requests.length > 0) {
        console.warn(
            `[F1 Diagnostic] Active handles after test suite: ${handles.length} handles, ${requests.length} requests`,
        );
        for (const h of handles) {
            console.warn(`  Handle: ${h.constructor?.name ?? typeof h}`);
        }
    }
});
```

**Step 3: Run full test suite, verify no hangs**

Run: `pnpm test:unit`
Expected: All tests pass, process exits cleanly.

```bash
git commit -m "chore: remove _skipPortScanner; add F1 active-handle diagnostic"
```

---

### Task 9: Final verification

**Step 1: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All clean. Process exits without hanging.

**Step 2: Verify no raw timer/fetch usage in TrackedService subclasses**

Search for any remaining raw `setInterval`, `setTimeout`, or `fetch(` calls in files that extend `TrackedService`:

```bash
rg "setInterval|setTimeout" src/lib/daemon/port-scanner.ts src/lib/daemon/version-check.ts src/lib/daemon/storage-monitor.ts src/lib/instance/instance-manager.ts src/lib/daemon/keep-awake.ts
rg "(?<!this\.)fetch\(" src/lib/daemon/version-check.ts src/lib/instance/instance-manager.ts
```

Expected: No raw calls remain (only `this.repeating`, `this.delayed`, `this.fetch`, `this.tracked`).
