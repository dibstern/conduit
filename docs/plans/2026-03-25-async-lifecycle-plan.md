# Async Lifecycle Management Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make every background async operation in the daemon trackable, cancellable, and awaitable — by construction, not convention — so `stop()` fully cleans up and tests never hang.

**Architecture:** A `TrackedService` base class wraps `setInterval`, `setTimeout`, `fetch`, and fire-and-forget promises into tracked versions. A `ServiceRegistry` collects all `TrackedService` instances for bulk drain. The Daemon's child services (PortScanner, InstanceManager, VersionChecker, StorageMonitor, KeepAwake) extend `TrackedService`. The Daemon itself does NOT extend TrackedService — it owns a `serviceRegistry` field (for child services) and a plain `AsyncTracker` (for its own fire-and-forget promises). `Daemon.stop()` calls `serviceRegistry.drainAll()` then `tracker.drain()` — everything cleaned up.

**Tech Stack:** Node.js EventEmitter, AbortController, Vitest, fast-check

**Design doc:** `docs/plans/2026-03-25-async-lifecycle-design.md`

**Scope:** All services — daemon-level (PortScanner, InstanceManager, VersionChecker, StorageMonitor, KeepAwake) and relay-level (SessionStatusPoller, MessagePoller, MessagePollerManager, SSEConsumer, WebSocketHandler, SessionOverrides, ProjectRegistry, relay-stack timers). Complete migration.

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
import { AsyncTracker } from "../../../src/lib/daemon/async-tracker.js";

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

    it("track() throws after drain()", async () => {
        const tracker = new AsyncTracker();
        await tracker.drain();
        expect(() => tracker.track(Promise.resolve())).toThrow("Cannot track after drain");
    });

    it("interval() throws after drain()", async () => {
        const tracker = new AsyncTracker();
        await tracker.drain();
        expect(() => tracker.interval(() => {}, 100)).toThrow("Cannot track after drain");
    });

    it("timeout() throws after drain()", async () => {
        const tracker = new AsyncTracker();
        await tracker.drain();
        expect(() => tracker.timeout(() => {}, 100)).toThrow("Cannot track after drain");
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
    private drained = false;

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
        if (this.drained) throw new Error("Cannot track after drain");
        this.pending.add(promise);
        promise.finally(() => this.pending.delete(promise));
        return promise;
    }

    /** Create a tracked setInterval. Cleared automatically on drain(). */
    interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
        if (this.drained) throw new Error("Cannot track after drain");
        const id = setInterval(fn, ms);
        this.timers.add(id);
        return id;
    }

    /** Create a tracked setTimeout. Self-removes when it fires. Cleared on drain(). */
    timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
        if (this.drained) throw new Error("Cannot track after drain");
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
        this.drained = true;
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
import { TrackedService } from "../../../src/lib/daemon/tracked-service.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";

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

    it("fetch() merges caller signal with tracker signal", async () => {
        const registry = new ServiceRegistry();
        const svc = new TestService(registry);
        const callerController = new AbortController();
        callerController.abort();
        // Caller signal is already aborted — fetch should reject even though tracker is still active
        await expect(svc.doFetch("http://localhost:1")).rejects.toThrow(); // baseline
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

    /** fetch() with automatic abort signal and promise tracking. Merges caller signal with tracker signal. */
    protected fetch(url: string, init?: RequestInit): Promise<Response> {
        const signal = init?.signal
            ? AbortSignal.any([this._tracker.signal, init.signal])
            : this._tracker.signal;
        return this._tracker.track(
            fetch(url, { ...init, signal }),
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
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry to PortScanner)
- Modify: `test/unit/daemon/port-scanner.test.ts`
- Modify: `test/unit/daemon/daemon-scanner.test.ts`

**Changes:**

1. `PortScanner` changes from `extends EventEmitter<PortScannerEvents>` to `extends TrackedService<PortScannerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter, calls `super(registry)`
3. `start()` replaces `this.timer = setInterval(...)` with `this.timer = this.repeating(...)`
4. `stop()` replaces `clearInterval(this.timer)` with `this.clearTrackedTimer(this.timer)` (keeps the manual stop for API compat)
5. In `daemon.ts`, pass `this.serviceRegistry` to `new PortScanner(this.serviceRegistry, config, probeFn)`

**Test files to update:**
- `test/unit/daemon/port-scanner.test.ts`
- `test/unit/daemon/daemon-scanner.test.ts`
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

In `start()`, where `PortScanner` is constructed, pass `this.serviceRegistry`:
```ts
this.scanner = new PortScanner(this.serviceRegistry, scannerConfig, probeFn);
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
- Modify: `src/lib/daemon/tracked-service.ts` (add `protected get abortSignal()` getter)
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry)
- Modify: `test/unit/daemon/version-check.test.ts` (22 constructor calls)

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

**Test files to update:**
- `test/unit/daemon/version-check.test.ts` (22 constructor calls)
- All `new VersionChecker(options)` → `new VersionChecker(new ServiceRegistry(), options)`

**Step 1-5: Same TDD pattern as Task 2.**

```bash
git commit -m "refactor: VersionChecker extends TrackedService with abort signal on fetch"
```

---

### Task 4: StorageMonitor extends TrackedService

**Files:**
- Modify: `src/lib/daemon/storage-monitor.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry)
- Modify: `test/unit/daemon/storage-monitor.test.ts`
- Modify: `test/unit/daemon/daemon-eviction-chain.test.ts`

**Changes:**

1. `extends EventEmitter<StorageMonitorEvents>` → `extends TrackedService<StorageMonitorEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `start()` replaces `this.timer = setInterval(...)` with `this.timer = this.repeating(...)`, replaces `void this.check()` with `this.tracked(this.check())`
4. `stop()` uses `this.clearTrackedTimer(this.timer)`
5. Remove `.unref()` call — drain handles cleanup now (unref was a workaround for the exact problem we're fixing)

**Test files to update:**
- `test/unit/daemon/storage-monitor.test.ts`
- `test/unit/daemon/daemon-eviction-chain.test.ts`
- Update constructors, add drain test.

```bash
git commit -m "refactor: StorageMonitor extends TrackedService"
```

---

### Task 5: InstanceManager extends TrackedService (includes A2 fix)

**Files:**
- Modify: `src/lib/instance/instance-manager.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry)
- Modify: `test/unit/instance/instance-manager.test.ts`
- Modify: `test/unit/instance/instance-lifecycle.test.ts`
- Modify: `test/unit/instance/instance-types.test.ts`
- Modify: `test/unit/instance/instance-performance.test.ts`
- Modify: `test/unit/instance/instance-state-machine.test.ts`
- Modify: `test/unit/instance/instance-concurrency.test.ts`

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

8. **Add explicit `drain()` override:**

```ts
async drain(): Promise<void> {
    this.stopAll();
    await super.drain();
}
```

This ensures all health polling intervals and pending restarts are cleared when the service registry drains.

**Daemon.ts health checker injection:** The daemon injects a custom `healthChecker` function into InstanceManager. This function uses raw `fetch()` with no abort signal. Two options:
- a) Pass the abort signal from TrackedService to the injected health checker
- b) Make the injected health checker use the InstanceManager's `this.fetch()` by moving it into the class

Option (b) is cleaner. Move the health check logic from the lambda in `daemon.ts:302-320` into `InstanceManager` and use `this.fetch()`.

**Test files to update (~22 constructor calls across these files):**
- `test/unit/instance/instance-manager.test.ts`
- `test/unit/instance/instance-lifecycle.test.ts`
- `test/unit/instance/instance-types.test.ts`
- `test/unit/instance/instance-performance.test.ts`
- `test/unit/instance/instance-state-machine.test.ts`
- `test/unit/instance/instance-concurrency.test.ts`
- Add test that `stopAll()` clears health polling for instances with status "stopped". Add test that health check fetch is aborted on drain.

```bash
git commit -m "refactor: InstanceManager extends TrackedService; fix stopAll() to clear all intervals"
```

---

### Task 6: KeepAwake extends TrackedService

**Files:**
- Modify: `src/lib/daemon/keep-awake.ts`
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry — TWO construction sites)
- Modify: `test/unit/daemon/keep-awake.test.ts` (54 constructor calls)

**Changes:**

1. `KeepAwake` currently extends `EventEmitter` (plain, not typed). Change to `extends TrackedService<KeepAwakeEvents>` — define a `KeepAwakeEvents` type for the events it emits.
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. The child process spawn is not a timer/fetch — it stays as-is (process.kill for cleanup is already correct)
4. `drain()` override: call `this.deactivate()` then `super.drain()` — ensure the child process is killed during drain
5. **Two construction sites in daemon.ts:**
   - The main construction in `start()` — pass `this.serviceRegistry`
   - `daemon.ts:1475` in the `setKeepAwakeCommand` IPC handler also constructs `new KeepAwake(...)` — must pass `this.serviceRegistry`

**Test files to update:**
- `test/unit/daemon/keep-awake.test.ts` (54 constructor calls)
- All T1-T19 tests need `new ServiceRegistry()` passed.

```bash
git commit -m "refactor: KeepAwake extends TrackedService"
```

---

### Task 7: Wire ServiceRegistry through relay-stack

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (accept registry in config, pass to all services)
- Modify: `src/lib/daemon/daemon.ts` (pass serviceRegistry to createProjectRelay)
- Modify: relevant tests (search for files that construct `ProjectRelayConfig`)

**Changes:**

1. Add `registry?: ServiceRegistry` (optional) to `ProjectRelayConfig`
2. In `createProjectRelay()`, store `config.registry` locally for later use by Tasks 8-15. Do NOT change constructor calls yet — service constructors don't accept registry until their respective tasks.
3. In `daemon.ts`, where `createRelay` lambda is defined for `ProjectRegistry.add()`, include `registry: this.serviceRegistry` in the relay config
4. **Standalone path:** Test harnesses (`relay-harness.ts`, `e2e-harness.ts`) also call `createProjectRelay()`. Since `registry` is optional, they work without it. When a service needs a registry and none is provided, each service task (8-15) should handle this by creating a fallback `new ServiceRegistry()` in the constructor if none is passed.

**Why this must come first:** This task establishes the registry parameter in the relay config type. Each subsequent relay service task (8-15) then changes the constructor to accept registry and updates the relay-stack.ts construction site in the same commit.

**Tests:** Update relay-stack integration tests. Verify that `registry.drainAll()` drains relay services.

```bash
git commit -m "feat: wire ServiceRegistry through relay-stack to all relay services"
```

---

### Task 8: SessionStatusPoller extends TrackedService

**Files:**
- Modify: `src/lib/session/session-status-poller.ts`
- Modify: `test/unit/session/session-status-poller.test.ts` (or equivalent)

**Changes (same pattern as Tasks 2-6):**

1. `extends EventEmitter<SessionStatusPollerEvents>` → `extends TrackedService<SessionStatusPollerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter, calls `super(registry)`
3. `start()`: `setInterval(...)` → `this.repeating(...)`, `void this.poll()` → `this.tracked(this.poll())`
4. `stop()`: `clearInterval(this.timer)` → `this.clearTrackedTimer(this.timer)`
5. Remove `.unref()` call — drain handles cleanup
6. The `poll()` method uses `this.client.getSessionStatuses()` which is an OpenCodeClient REST call. The client already has its own AbortController per request, so no change needed inside poll(). However, wrap the poll call: `this.tracked(this.poll())` in the interval callback to track the in-flight promise.

**Tests:** Update all constructors to pass `new ServiceRegistry()`. Add drain test.

```bash
git commit -m "refactor: SessionStatusPoller extends TrackedService"
```

---

### Task 9: MessagePoller extends TrackedService

**Files:**
- Modify: `src/lib/relay/message-poller.ts`
- Modify: `test/unit/relay/message-poller.test.ts` (or equivalent)

**Changes:**

1. `extends EventEmitter<MessagePollerEvents>` → `extends TrackedService<MessagePollerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `startPolling()`: `setInterval(...)` → `this.repeating(...)`, `void this.poll()` → `this.tracked(this.poll())`
4. `stopPolling()`: `clearInterval(this.timer)` → `this.clearTrackedTimer(this.timer)`
5. Remove `.unref()` call
6. The `poll()` method uses `this.client.getMessages(sessionId)` — same as SessionStatusPoller, the client already manages its own abort per request.

**Tests:** Update all constructors. Add drain test.

```bash
git commit -m "refactor: MessagePoller extends TrackedService"
```

---

### Task 10: MessagePollerManager extends TrackedService

**Files:**
- Modify: `src/lib/relay/message-poller-manager.ts`
- Modify: `test/unit/relay/message-poller-manager.test.ts` (or equivalent)

**Changes:**

1. `extends EventEmitter<MessagePollerManagerEvents>` → `extends TrackedService<MessagePollerManagerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter, stores it as `this.serviceRegistry` (use this field name to avoid collision with the parent's private `_tracker` or any inherited fields)
3. `startPolling()` passes the registry to `new MessagePoller(this.serviceRegistry, options)` when creating child pollers
4. `stopAll()` calls `poller.stopPolling()` + `poller.removeAllListeners()` as before — individual poller cleanup is still needed for per-session teardown. The registry is the safety net.
5. Override `drain()`: call `this.stopAll()` then `super.drain()` — ensures all child pollers are stopped before the manager drains.

**Tests:** Update constructors. Add drain test that verifies all child pollers are stopped.

```bash
git commit -m "refactor: MessagePollerManager extends TrackedService"
```

---

### Task 11: SSEConsumer extends TrackedService

**Files:**
- Modify: `src/lib/relay/sse-consumer.ts`
- Modify: `test/unit/relay/sse-consumer.test.ts` (or equivalent)

**Changes:**

1. `extends EventEmitter<SSEConsumerEvents>` → `extends TrackedService<SSEConsumerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter
3. `connect()`: `this.startStream().catch(...)` → `this.tracked(this.startStream().catch(...))`
4. `scheduleReconnect()`: `this.reconnectTimer = setTimeout(...)` → `this.reconnectTimer = this.delayed(...)`. The delayed callback calls `this.startStream()` — wrap it to track the resulting promise:
   ```ts
   this.reconnectTimer = this.delayed(() => {
       this.reconnectTimer = null;
       this.tracked(this.startStream().catch(/* existing error handler */));
   }, delay);
   ```
5. `disconnect()`: `clearTimeout(this.reconnectTimer)` → `this.clearTrackedTimer(this.reconnectTimer)`
6. **SSE fetch already has its own AbortController** (`this.abortController`). Keep it — the consumer manages its own stream lifecycle. The TrackedService's abort signal is a separate concern (daemon shutdown). Override `drain()`: call `this.disconnect()` then `super.drain()`.
7. `startStream()`: The `fetch()` call already uses `this.abortController.signal`. No change needed — `disconnect()` aborts it, and `drain()` calls `disconnect()`.

**Tests:** Update constructors. Add drain test that verifies SSE stream is disconnected.

```bash
git commit -m "refactor: SSEConsumer extends TrackedService"
```

---

### Task 12: WebSocketHandler extends TrackedService

**Files:**
- Modify: `src/lib/server/ws-handler.ts`
- Modify: `test/unit/server/ws-handler.test.ts` (or equivalent)

**Changes:**

1. `extends EventEmitter<WebSocketHandlerEvents>` → `extends TrackedService<WebSocketHandlerEvents>`
2. Constructor adds `registry: ServiceRegistry` as first parameter (before `server` param)
3. `startHeartbeat()`: `setInterval(...)` → `this.repeating(...)`
4. `close()`: `clearInterval(this.heartbeatTimer)` → `this.clearTrackedTimer(this.heartbeatTimer)`
5. Override `drain()`: call `this.close()` then `super.drain()`

**Note:** The heartbeat timer was **never `.unref()`'d** — this was a latent bug that kept the process alive. TrackedService fixes this by construction.

**Tests:** Update constructors. Add drain test.

```bash
git commit -m "refactor: WebSocketHandler extends TrackedService"
```

---

### Task 13: SessionOverrides extends TrackedService

**Files:**
- Modify: `src/lib/session/session-overrides.ts`
- Modify: `test/unit/session/session-overrides.test.ts` (or equivalent)

**Changes:**

`SessionOverrides` currently has no parent class and no EventEmitter. It manages `setTimeout` processing timeouts per session.

1. `class SessionOverrides` → `class SessionOverrides extends TrackedService`
2. Add constructor that takes `registry: ServiceRegistry`, calls `super(registry)`
3. `startProcessingTimeout()`: `setTimeout(...)` → `this.delayed(...)`
4. `resetProcessingTimeout()`: `clearTimeout(state.processingTimer)` + `setTimeout(...)` → `this.clearTrackedTimer(state.processingTimer)` + `this.delayed(...)`
5. `clearProcessingTimeout()`: `clearTimeout(state.processingTimer)` → `this.clearTrackedTimer(state.processingTimer)`
6. `dispose()`: iterate and call `this.clearTrackedTimer(state.processingTimer)` for each. Override `drain()`: call `this.dispose()` then `super.drain()`.

**Tests:** Update constructors. Add drain test verifying all processing timeouts are cleared.

```bash
git commit -m "refactor: SessionOverrides extends TrackedService"
```

---

### Task 14: ProjectRegistry extends TrackedService

**Files:**
- Modify: `src/lib/daemon/project-registry.ts`
- Modify: `test/unit/daemon/project-registry.test.ts` (~48 constructor calls)
- Modify: `src/lib/daemon/daemon.ts` (1 production construction site — handled in Task 16)

**Changes:**

1. `extends EventEmitter<ProjectRegistryEvents>` → `extends TrackedService<ProjectRegistryEvents>`
2. Add constructor that takes `registry: ServiceRegistry`, calls `super(registry)`
3. `add()` and `startRelay()`: The `createRelay(ac.signal).then(...)` fire-and-forget promises → wrap with `this.tracked(...)`
4. `waitForRelay()`: Keep the raw `setTimeout` inside the Promise constructor unchanged — it needs to reject the promise. Instead, wrap the outer Promise with `this.tracked()` so drain awaits it:
   ```ts
   waitForRelay(...): Promise<ProjectRelay> {
       return this.tracked(new Promise((resolve, reject) => {
           // ... existing implementation with raw setTimeout unchanged ...
       }));
   }
   ```
5. The existing `AbortController` pattern for relay creation stays — it's per-operation lifecycle, separate from drain.
6. Override `drain()`: call `this.stopAll()` then `super.drain()` — abort all pending relay creations, stop all running relays, then drain tracked promises.

**Note:** The constructor must accept `ServiceRegistry`. The current `readonly registry = new ProjectRegistry()` inline initializer in `daemon.ts` must be changed to initialize in the constructor body AFTER `this.serviceRegistry` is created — this is handled in Task 16.

**Test files to update:**
- `test/unit/daemon/project-registry.test.ts` (~48 constructor calls)
- Update constructors. Add test that drain stops all relays and aborts pending creations.

```bash
git commit -m "refactor: ProjectRegistry extends TrackedService"
```

---

### Task 15: Relay-stack timers wrapped in RelayTimers TrackedService

**Files:**
- Create: `src/lib/relay/relay-timers.ts`
- Modify: `src/lib/relay/relay-stack.ts`
- Test: `test/unit/relay/relay-timers.test.ts`

**Changes:**

The two standalone `setInterval` calls in `createProjectRelay()` (permission timeout check every 30s, rate limiter cleanup every 60s) are module-scoped closures with no class. Wrap them in a small `RelayTimers` class:

```ts
// src/lib/relay/relay-timers.ts
import { TrackedService } from "../daemon/tracked-service.js";
import type { ServiceRegistry } from "../daemon/service-registry.js";
import type { PermissionBridge } from "../bridges/permission-bridge.js";
import type { RateLimiter } from "../server/rate-limiter.js";

/**
 * Wraps per-relay periodic timers (permission timeout check, rate limiter cleanup)
 * in a TrackedService for lifecycle management.
 */
export class RelayTimers extends TrackedService {
    constructor(
        registry: ServiceRegistry,
        private permissionBridge: PermissionBridge,
        private rateLimiter: RateLimiter,
        private onPermissionTimeout: (id: string) => void,
    ) {
        super(registry);
    }

    start(): void {
        this.repeating(() => {
            const timedOut = this.permissionBridge.checkTimeouts();
            for (const id of timedOut) {
                this.onPermissionTimeout(id);
            }
        }, 30_000);

        this.repeating(() => {
            this.rateLimiter.cleanup();
        }, 60_000);
    }

    /** stop() drains via TrackedService — clears both intervals. */
}
```

In `relay-stack.ts`:
- Remove the two standalone `setInterval` calls and their `.unref()` wrappers
- Create `const relayTimers = new RelayTimers(registry, permissionBridge, rateLimiter, onTimeout)`
- Call `relayTimers.start()`
- In the returned `stop()` function: remove the `clearInterval(timeoutTimer)` and `clearInterval(rateLimitCleanupTimer)` calls — `relayTimers.drain()` is handled by the global registry, but for per-relay teardown add `await relayTimers.drain()`

**Tests:** Unit test that RelayTimers creates tracked intervals and drain clears them.

```bash
git commit -m "refactor: relay-stack timers wrapped in RelayTimers TrackedService"
```

---

### Task 16: Daemon uses ServiceRegistry + AsyncTracker (does NOT extend TrackedService)

**Files:**
- Modify: `src/lib/daemon/daemon.ts`
- Modify: `test/unit/daemon/daemon.test.ts`

**Changes:**

Daemon does **NOT** extend TrackedService. It is a plain class that owns two lifecycle primitives directly:

1. Add fields:
   ```ts
   private serviceRegistry = new ServiceRegistry();
   private tracker = new AsyncTracker();
   private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
   ```

2. **Initialize ProjectRegistry in constructor body** (not as an inline initializer):
   The current `readonly registry = new ProjectRegistry()` inline initializer must move into the constructor body, AFTER `this.serviceRegistry` is created:
   ```ts
   constructor(options?: DaemonOptions) {
       // ... existing setup ...
       this.serviceRegistry = new ServiceRegistry();
       this.tracker = new AsyncTracker();
       this.registry = new ProjectRegistry(this.serviceRegistry);
       // ... rest of existing constructor
   }
   ```
   Note: `this.registry` (ProjectRegistry) keeps its name. `this.serviceRegistry` (ServiceRegistry) is the new field.

3. In `start()`, replace fire-and-forget patterns:
   - `void this.discoverProjects().catch(...)` → `this.tracker.track(this.discoverProjects().catch(...))`
   - `void this.scanner.scan()` → `this.tracker.track(this.scanner.scan())`

4. Pass `this.serviceRegistry` to all child service constructors:
   - `new PortScanner(this.serviceRegistry, ...)`
   - `new VersionChecker(this.serviceRegistry, ...)`
   - `new StorageMonitor(this.serviceRegistry, ...)`
   - `new InstanceManager(this.serviceRegistry, ...)`
   - `new KeepAwake(this.serviceRegistry, ...)` (both construction sites — see Task 6)
   - `new ProjectRegistry(this.serviceRegistry)` (moved to constructor body — see above)

5. **Track the shutdown timeout** (daemon.ts:1487):
   The `scheduleShutdown` in the IPC handler uses raw `setTimeout`. Since Daemon does not extend TrackedService, use raw `setTimeout` with manual tracking:
   ```ts
   // In the IPC handler:
   this.shutdownTimer = setTimeout(() => this.stop(), DAEMON_SHUTDOWN_DELAY_MS);
   // In stop():
   if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }
   ```

6. **Rewrite `stop()`:**

```ts
async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Clear shutdown timer if stop() called through another path
    if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }

    // Remove signal handlers
    removeSignalHandlers();

    // Persist final config so instances survive restart
    saveDaemonConfig(this.buildConfig(), this.configDir);

    // Drain ALL tracked services (PortScanner, InstanceManager, VersionChecker,
    // StorageMonitor, KeepAwake, ProjectRegistry, and all relay services).
    // This aborts all in-flight fetch, clears all intervals/timeouts,
    // and waits for pending promises to settle.
    await this.serviceRegistry.drainAll();

    // Drain Daemon's own tracked promises (discoverProjects, scanner.scan, etc.)
    await this.tracker.drain();

    // Null out service references to prevent zombie usage after drain.
    // Only null fields that are NOT readonly. For readonly fields (like instanceManager),
    // they are drained/inert — check if the field is readonly before nulling.
    // If a field is `readonly`, skip nulling it — drain() made it inert.
    this.scanner = null;
    this.versionChecker = null;
    this.storageMonitor = null;
    this.keepAwakeManager = null;
    // this.instanceManager is readonly — do NOT null it, it's inert after drain

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

The individual `this.versionChecker?.stop()`, `this.scanner?.stop()`, etc. calls are REMOVED — `serviceRegistry.drainAll()` handles everything.

**Note:** `ProjectRegistry.stopAll()` and `instanceManager.stopAll()` are called via their respective `drain()` overrides when `serviceRegistry.drainAll()` fires. Both extend `TrackedService` (Tasks 5, 14), so their `drain()` methods handle teardown automatically.

**Tests:** Daemon tests that check stop behavior need updating. Tests no longer need `_skipPortScanner` (remove it).

```bash
git commit -m "refactor: Daemon uses ServiceRegistry + AsyncTracker; stop() drains all services"
```

---

### Task 17: Remove _skipPortScanner, add F1 diagnostic

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

### Task 18: Final verification

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
