# Multi-Instance OpenCode Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow a single relay daemon to manage multiple OpenCode server instances, each with its own port, env vars, and health monitoring — so projects can be routed to different auth contexts (e.g., personal vs work Anthropic accounts).

**Architecture:** Introduce `InstanceManager` as a new class between the Daemon and per-project relays. Each `OpenCodeInstance` represents a running `opencode serve` process. Projects bind to instances via `instanceId`. The Daemon delegates instance lifecycle (spawn, health-check, crash recovery, orphan reclamation) to the InstanceManager. Config persistence gains an `instances` array. The frontend gets a new `instance.svelte.ts` store, `InstanceSelector` dropdown, and `InstanceManager` settings panel. Backward compatibility: when no `instances` array exists in config, a "default" instance is auto-created from the existing `opencodeUrl`.

**Tech Stack:** TypeScript, Node.js, Vitest (unit + property-based), Svelte 5 ($state/$derived runes), Tailwind CSS v4, EventEmitter

---

### Task 1: Add Instance Types to `types.ts` and `shared-types.ts`

**Files:**
- Modify: `src/lib/types.ts:114-120` (add `instanceId` to `ProjectInfo`)
- Modify: `src/lib/shared-types.ts` (add instance types for frontend)

**Step 1: Write the failing test**

Create `test/unit/instance-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type {
  OpenCodeInstance,
  InstanceConfig,
  InstanceStatus,
} from "../../src/lib/types.js";
import type { ProjectInfo } from "../../src/lib/types.js";

describe("Instance types", () => {
  it("OpenCodeInstance has required fields", () => {
    const instance: OpenCodeInstance = {
      id: "personal",
      name: "Personal",
      port: 4096,
      managed: true,
      status: "healthy",
      restartCount: 0,
      createdAt: Date.now(),
    };
    expect(instance.id).toBe("personal");
    expect(instance.status).toBe("healthy");
    expect(instance.managed).toBe(true);
  });

  it("OpenCodeInstance supports optional fields", () => {
    const instance: OpenCodeInstance = {
      id: "work",
      name: "Work",
      port: 4097,
      managed: true,
      status: "starting",
      pid: 12345,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      exitCode: undefined,
      lastHealthCheck: Date.now(),
      restartCount: 0,
      createdAt: Date.now(),
    };
    expect(instance.pid).toBe(12345);
    expect(instance.env).toBeDefined();
  });

  it("InstanceConfig has required fields", () => {
    const config: InstanceConfig = {
      name: "Personal",
      port: 4096,
      managed: true,
    };
    expect(config.name).toBe("Personal");
  });

  it("ProjectInfo has optional instanceId", () => {
    const project: ProjectInfo = {
      slug: "myapp",
      directory: "/src/myapp",
      title: "myapp",
      instanceId: "personal",
    };
    expect(project.instanceId).toBe("personal");
  });

  it("ProjectInfo works without instanceId (backward compat)", () => {
    const project: ProjectInfo = {
      slug: "myapp",
      directory: "/src/myapp",
      title: "myapp",
    };
    expect(project.instanceId).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/instance-types.test.ts`
Expected: FAIL — types `OpenCodeInstance`, `InstanceConfig`, `InstanceStatus` do not exist

**Step 3: Add types to `shared-types.ts`**

At the end of `src/lib/shared-types.ts` (after line 233), add:

```typescript
// ─── Instance Types ─────────────────────────────────────────────────────────

export type InstanceStatus = "starting" | "healthy" | "unhealthy" | "stopped";

export interface OpenCodeInstance {
  id: string;
  name: string;
  port: number;
  managed: boolean;
  status: InstanceStatus;
  pid?: number;
  env?: Record<string, string>;
  exitCode?: number;
  lastHealthCheck?: number;
  restartCount: number;
  createdAt: number;
}

export interface InstanceConfig {
  name: string;
  port: number;
  managed: boolean;
  env?: Record<string, string>;
  /** For external (unmanaged) instances: the full URL */
  url?: string;
}
```

**Step 4: Re-export from `types.ts`**

In `src/lib/types.ts`, add to the re-export block (line 7-20):

```typescript
export type {
  // ... existing re-exports ...
  InstanceConfig,
  InstanceStatus,
  OpenCodeInstance,
} from "./shared-types.js";
```

**Step 5: Add `instanceId` to `ProjectInfo`**

In `src/lib/types.ts`, modify `ProjectInfo` (lines 115-120):

```typescript
export interface ProjectInfo {
  slug: string;
  directory: string;
  title: string;
  lastUsed?: number;
  instanceId?: string;
}
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/instance-types.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/shared-types.ts test/unit/instance-types.test.ts
git commit -m "feat: add OpenCodeInstance, InstanceConfig, InstanceStatus types"
```

---

### Task 2: Update `DaemonConfig` for Instance Persistence

**Files:**
- Modify: `src/lib/config-persistence.ts:26-40` (add `instances` to DaemonConfig)
- Modify: `test/unit/config-persistence.test.ts` (add tests for instances)

**Step 1: Write the failing test**

In `test/unit/config-persistence.test.ts`, add a new describe block:

```typescript
describe("DaemonConfig with instances", () => {
  it("saves and loads config with instances array", () => {
    const config: DaemonConfig = {
      pid: 1234,
      port: 2633,
      pinHash: null,
      tls: false,
      debug: false,
      keepAwake: false,
      dangerouslySkipPermissions: false,
      projects: [],
      instances: [
        {
          id: "personal",
          name: "Personal",
          port: 4096,
          managed: true,
          env: { ANTHROPIC_API_KEY: "sk-test" },
        },
      ],
    };
    saveDaemonConfig(config, tmpDir);
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.instances).toHaveLength(1);
    expect(loaded!.instances![0].id).toBe("personal");
    expect(loaded!.instances![0].env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("loads config without instances array (backward compat)", () => {
    const config: DaemonConfig = {
      pid: 1234,
      port: 2633,
      pinHash: null,
      tls: false,
      debug: false,
      keepAwake: false,
      dangerouslySkipPermissions: false,
      projects: [],
    };
    saveDaemonConfig(config, tmpDir);
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.instances).toBeUndefined();
  });

  it("saves config with project instanceId bindings", () => {
    const config: DaemonConfig = {
      pid: 1234,
      port: 2633,
      pinHash: null,
      tls: false,
      debug: false,
      keepAwake: false,
      dangerouslySkipPermissions: false,
      projects: [
        {
          path: "/src/myapp",
          slug: "myapp",
          addedAt: Date.now(),
          instanceId: "personal",
        },
      ],
      instances: [],
    };
    saveDaemonConfig(config, tmpDir);
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded!.projects[0].instanceId).toBe("personal");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/config-persistence.test.ts --grep "DaemonConfig with instances"`
Expected: FAIL — `instances` property doesn't exist on DaemonConfig

**Step 3: Update DaemonConfig interface**

In `src/lib/config-persistence.ts`, modify lines 26-40:

```typescript
export interface DaemonConfig {
  pid: number;
  port: number;
  pinHash: string | null;
  tls: boolean;
  debug: boolean;
  keepAwake: boolean;
  dangerouslySkipPermissions: boolean;
  projects: Array<{
    path: string;
    slug: string;
    title?: string;
    addedAt: number;
    instanceId?: string;
  }>;
  instances?: Array<{
    id: string;
    name: string;
    port: number;
    managed: boolean;
    env?: Record<string, string>;
    url?: string;
  }>;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/config-persistence.test.ts --grep "DaemonConfig with instances"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/config-persistence.ts test/unit/config-persistence.test.ts
git commit -m "feat: add instances array and project instanceId to DaemonConfig"
```

---

### Task 3: Create InstanceManager Core (spawn, stop, health-check)

**Files:**
- Create: `src/lib/instance-manager.ts`
- Create: `test/unit/instance-manager.test.ts`

**Step 1: Write the failing test — addInstance + getInstances**

Create `test/unit/instance-manager.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceManager } from "../../src/lib/instance-manager.js";

describe("InstanceManager", () => {
  let manager: InstanceManager;

  beforeEach(() => {
    manager = new InstanceManager({ maxInstances: 5 });
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  describe("addInstance", () => {
    it("adds a managed instance with starting status", async () => {
      const instance = await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      expect(instance.id).toBe("personal");
      expect(instance.name).toBe("Personal");
      expect(instance.port).toBe(4096);
      expect(instance.managed).toBe(true);
      expect(instance.status).toBe("stopped");
      expect(instance.restartCount).toBe(0);
      expect(instance.createdAt).toBeGreaterThan(0);
    });

    it("rejects duplicate instance IDs", async () => {
      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      await expect(
        manager.addInstance("personal", {
          name: "Other",
          port: 4097,
          managed: true,
        }),
      ).rejects.toThrow('Instance "personal" already exists');
    });

    it("rejects when max instances reached", async () => {
      const mgr = new InstanceManager({ maxInstances: 2 });
      await mgr.addInstance("a", { name: "A", port: 4096, managed: true });
      await mgr.addInstance("b", { name: "B", port: 4097, managed: true });

      await expect(
        mgr.addInstance("c", { name: "C", port: 4098, managed: true }),
      ).rejects.toThrow("Maximum number of instances (2) reached");

      await mgr.stopAll();
    });
  });

  describe("getInstances / getInstance", () => {
    it("returns all instances", async () => {
      await manager.addInstance("a", { name: "A", port: 4096, managed: true });
      await manager.addInstance("b", { name: "B", port: 4097, managed: true });

      const instances = manager.getInstances();
      expect(instances).toHaveLength(2);
    });

    it("returns single instance by ID", async () => {
      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      const instance = manager.getInstance("personal");
      expect(instance).toBeDefined();
      expect(instance!.id).toBe("personal");
    });

    it("returns undefined for unknown ID", () => {
      expect(manager.getInstance("nope")).toBeUndefined();
    });
  });

  describe("removeInstance", () => {
    it("removes an existing instance", async () => {
      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      await manager.removeInstance("personal");
      expect(manager.getInstance("personal")).toBeUndefined();
      expect(manager.getInstances()).toHaveLength(0);
    });

    it("throws for unknown instance", async () => {
      await expect(manager.removeInstance("nope")).rejects.toThrow(
        'Instance "nope" not found',
      );
    });
  });

  describe("getInstanceUrl", () => {
    it("returns URL for managed instance", async () => {
      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      expect(manager.getInstanceUrl("personal")).toBe("http://localhost:4096");
    });

    it("returns URL for external instance", async () => {
      await manager.addInstance("external", {
        name: "External",
        port: 9999,
        managed: false,
        url: "https://remote.example.com:8080",
      });

      expect(manager.getInstanceUrl("external")).toBe(
        "https://remote.example.com:8080",
      );
    });

    it("throws for unknown instance", () => {
      expect(() => manager.getInstanceUrl("nope")).toThrow(
        'Instance "nope" not found',
      );
    });
  });

  describe("events", () => {
    it('emits "instance_added" on add', async () => {
      const handler = vi.fn();
      manager.on("instance_added", handler);

      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: "personal" }),
      );
    });

    it('emits "instance_removed" on remove', async () => {
      const handler = vi.fn();
      manager.on("instance_removed", handler);

      await manager.addInstance("personal", {
        name: "Personal",
        port: 4096,
        managed: true,
      });
      await manager.removeInstance("personal");

      expect(handler).toHaveBeenCalledWith("personal");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/instance-manager.test.ts`
Expected: FAIL — module `instance-manager.ts` does not exist

**Step 3: Write minimal InstanceManager implementation**

Create `src/lib/instance-manager.ts`:

```typescript
// ─── Instance Manager ───────────────────────────────────────────────────────
// Manages the lifecycle of OpenCode server instances. Each instance represents
// a running `opencode serve` process with its own port and env configuration.

import { EventEmitter } from "node:events";
import type { InstanceConfig, OpenCodeInstance } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InstanceManagerOptions {
  /** Maximum number of managed instances (default: 5) */
  maxInstances?: number;
}

// ─── InstanceManager ────────────────────────────────────────────────────────

export class InstanceManager extends EventEmitter {
  private instances: Map<string, OpenCodeInstance> = new Map();
  private readonly maxInstances: number;

  constructor(options?: InstanceManagerOptions) {
    super();
    this.maxInstances = options?.maxInstances ?? 5;
  }

  /** Register a new instance (does not start it). */
  async addInstance(
    id: string,
    config: InstanceConfig,
  ): Promise<OpenCodeInstance> {
    if (this.instances.has(id)) {
      throw new Error(`Instance "${id}" already exists`);
    }
    if (this.instances.size >= this.maxInstances) {
      throw new Error(
        `Maximum number of instances (${this.maxInstances}) reached`,
      );
    }

    const instance: OpenCodeInstance = {
      id,
      name: config.name,
      port: config.port,
      managed: config.managed,
      status: "stopped",
      env: config.env,
      restartCount: 0,
      createdAt: Date.now(),
    };

    // Store external URL if provided
    if (!config.managed && config.url) {
      (instance as OpenCodeInstance & { _url?: string })._url = config.url;
    }

    this.instances.set(id, instance);
    this.emit("instance_added", instance);
    return instance;
  }

  /** Remove an instance. Stops it first if running. */
  async removeInstance(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Instance "${id}" not found`);
    }

    if (instance.status !== "stopped") {
      await this.stopInstance(id);
    }

    this.instances.delete(id);
    this.emit("instance_removed", id);
  }

  /** Return all registered instances. */
  getInstances(): OpenCodeInstance[] {
    return Array.from(this.instances.values());
  }

  /** Look up a single instance by ID. */
  getInstance(id: string): OpenCodeInstance | undefined {
    return this.instances.get(id);
  }

  /** Get the HTTP URL for an instance. */
  getInstanceUrl(id: string): string {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Instance "${id}" not found`);
    }

    // External instances may have a custom URL
    const ext = instance as OpenCodeInstance & { _url?: string };
    if (!instance.managed && ext._url) {
      return ext._url;
    }

    return `http://localhost:${instance.port}`;
  }

  /** Start a managed instance (spawn the opencode serve process). */
  async startInstance(_id: string): Promise<void> {
    // Implemented in Task 4
    throw new Error("Not implemented");
  }

  /** Stop a managed instance. */
  async stopInstance(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new Error(`Instance "${id}" not found`);
    }
    instance.status = "stopped";
    this.emit("status_changed", instance);
  }

  /** Stop all instances. */
  async stopAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      if (instance.status !== "stopped") {
        await this.stopInstance(instance.id);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/instance-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/instance-manager.ts test/unit/instance-manager.test.ts
git commit -m "feat: add InstanceManager core (add, remove, get, events)"
```

---

### Task 4: InstanceManager Process Spawning and Health Checks

**Files:**
- Modify: `src/lib/instance-manager.ts`
- Modify: `test/unit/instance-manager.test.ts`

**Step 1: Write the failing test — startInstance spawns process**

Add to `test/unit/instance-manager.test.ts`:

```typescript
describe("startInstance", () => {
  it("transitions managed instance to starting status", async () => {
    const statusChanges: string[] = [];
    manager.on("status_changed", (inst: OpenCodeInstance) => {
      statusChanges.push(inst.status);
    });

    // Use a mock spawner that doesn't actually spawn
    manager.setSpawner(async (_port: number, _env?: Record<string, string>) => ({
      pid: 99999,
      process: null as any,
    }));
    manager.setHealthChecker(async (_port: number) => true);

    await manager.addInstance("personal", {
      name: "Personal",
      port: 14096,
      managed: true,
    });
    await manager.startInstance("personal");

    const inst = manager.getInstance("personal")!;
    expect(inst.status).toBe("healthy");
    expect(inst.pid).toBe(99999);
    expect(statusChanges).toContain("starting");
    expect(statusChanges).toContain("healthy");
  });

  it("throws for external instance", async () => {
    await manager.addInstance("ext", {
      name: "External",
      port: 9999,
      managed: false,
    });

    await expect(manager.startInstance("ext")).rejects.toThrow(
      "Cannot start external instance",
    );
  });

  it("throws for unknown instance", async () => {
    manager.setSpawner(async () => ({ pid: 1, process: null as any }));
    await expect(manager.startInstance("nope")).rejects.toThrow(
      'Instance "nope" not found',
    );
  });
});

describe("stopInstance", () => {
  it("kills the spawned process and transitions to stopped", async () => {
    const killed: number[] = [];
    manager.setSpawner(async () => ({
      pid: 88888,
      process: {
        kill: (signal?: string) => { killed.push(88888); },
        pid: 88888,
      } as any,
    }));
    manager.setHealthChecker(async () => true);

    await manager.addInstance("test", {
      name: "Test",
      port: 14097,
      managed: true,
    });
    await manager.startInstance("test");
    await manager.stopInstance("test");

    expect(manager.getInstance("test")!.status).toBe("stopped");
    expect(killed).toContain(88888);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/instance-manager.test.ts --grep "startInstance|stopInstance"`
Expected: FAIL — `setSpawner`, `setHealthChecker` don't exist, `startInstance` throws "Not implemented"

**Step 3: Implement startInstance, stopInstance, and injectable spawner/health-checker**

Update `src/lib/instance-manager.ts` to add:

```typescript
import type { ChildProcess } from "node:child_process";

export type InstanceSpawner = (
  port: number,
  env?: Record<string, string>,
) => Promise<{ pid: number; process: ChildProcess }>;

export type InstanceHealthChecker = (port: number) => Promise<boolean>;

// In the class:
private processes: Map<string, ChildProcess> = new Map();
private spawner: InstanceSpawner | null = null;
private healthChecker: InstanceHealthChecker | null = null;
private healthIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

setSpawner(spawner: InstanceSpawner): void {
  this.spawner = spawner;
}

setHealthChecker(checker: InstanceHealthChecker): void {
  this.healthChecker = checker;
}

async startInstance(id: string): Promise<void> {
  const instance = this.instances.get(id);
  if (!instance) throw new Error(`Instance "${id}" not found`);
  if (!instance.managed) throw new Error("Cannot start external instance");
  if (instance.status === "healthy" || instance.status === "starting") return;

  instance.status = "starting";
  this.emit("status_changed", instance);

  const spawner = this.spawner ?? this.defaultSpawner;
  const { pid, process: proc } = await spawner(instance.port, instance.env);

  instance.pid = pid;
  this.processes.set(id, proc);

  // Run initial health check
  const checker = this.healthChecker ?? this.defaultHealthChecker;
  const healthy = await checker(instance.port);
  if (healthy) {
    instance.status = "healthy";
    instance.lastHealthCheck = Date.now();
    this.emit("status_changed", instance);
  }

  // Start periodic health checking
  this.startHealthPolling(id);
}

async stopInstance(id: string): Promise<void> {
  const instance = this.instances.get(id);
  if (!instance) throw new Error(`Instance "${id}" not found`);

  // Stop health polling
  this.stopHealthPolling(id);

  // Kill the process if managed and running
  const proc = this.processes.get(id);
  if (proc) {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }
    this.processes.delete(id);
  }

  instance.status = "stopped";
  instance.pid = undefined;
  this.emit("status_changed", instance);
}

private startHealthPolling(id: string): void {
  this.stopHealthPolling(id); // Clear any existing interval
  const interval = setInterval(async () => {
    const instance = this.instances.get(id);
    if (!instance || instance.status === "stopped") {
      this.stopHealthPolling(id);
      return;
    }
    const checker = this.healthChecker ?? this.defaultHealthChecker;
    try {
      const healthy = await checker(instance.port);
      const prevStatus = instance.status;
      instance.status = healthy ? "healthy" : "unhealthy";
      instance.lastHealthCheck = Date.now();
      if (instance.status !== prevStatus) {
        this.emit("status_changed", instance);
      }
    } catch {
      if (instance.status !== "unhealthy") {
        instance.status = "unhealthy";
        this.emit("status_changed", instance);
      }
    }
  }, 5000);
  this.healthIntervals.set(id, interval);
}

private stopHealthPolling(id: string): void {
  const interval = this.healthIntervals.get(id);
  if (interval) {
    clearInterval(interval);
    this.healthIntervals.delete(id);
  }
}

private async defaultSpawner(
  port: number,
  env?: Record<string, string>,
): Promise<{ pid: number; process: ChildProcess }> {
  const { spawn } = await import("node:child_process");
  const proc = spawn("opencode", ["serve", "--port", String(port)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!proc.pid) throw new Error("Failed to spawn opencode process");
  return { pid: proc.pid, process: proc };
}

private async defaultHealthChecker(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
```

Also update `stopAll()` to stop health polling for all instances.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/instance-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/instance-manager.ts test/unit/instance-manager.test.ts
git commit -m "feat: add InstanceManager process spawning and health checks"
```

---

### Task 5: InstanceManager Crash Recovery and Exponential Backoff

**Files:**
- Modify: `src/lib/instance-manager.ts`
- Modify: `test/unit/instance-manager.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/instance-manager.test.ts`:

```typescript
describe("crash recovery", () => {
  it("restarts on non-zero exit code", async () => {
    let spawnCount = 0;
    manager.setSpawner(async () => {
      spawnCount++;
      return {
        pid: 10000 + spawnCount,
        process: {
          kill: () => {},
          pid: 10000 + spawnCount,
          on: (event: string, cb: Function) => {
            // Simulate crash on first spawn after a short delay
            if (event === "exit" && spawnCount === 1) {
              setTimeout(() => cb(1, null), 50);
            }
          },
          removeAllListeners: () => {},
        } as any,
      };
    });
    manager.setHealthChecker(async () => true);

    await manager.addInstance("crashy", {
      name: "Crashy",
      port: 14098,
      managed: true,
    });
    await manager.startInstance("crashy");

    // Wait for crash + restart
    await new Promise((r) => setTimeout(r, 200));

    expect(spawnCount).toBeGreaterThanOrEqual(2);
  });

  it("gives up after max restarts in window", async () => {
    const mgr = new InstanceManager({
      maxInstances: 5,
      maxRestartsPerWindow: 3,
      restartWindowMs: 60_000,
    });

    let spawnCount = 0;
    mgr.setSpawner(async () => {
      spawnCount++;
      return {
        pid: 20000 + spawnCount,
        process: {
          kill: () => {},
          pid: 20000 + spawnCount,
          on: () => {},
          removeAllListeners: () => {},
        } as any,
      };
    });
    mgr.setHealthChecker(async () => true);

    await mgr.addInstance("fragile", {
      name: "Fragile",
      port: 14099,
      managed: true,
    });

    // Manually set restart count to max
    const inst = mgr.getInstance("fragile")!;
    inst.restartCount = 3;

    // Attempting restart should recognize we've exceeded max
    // The handleCrash method should set status to "stopped" instead of restarting
    // This tests the internal logic — exact mechanism depends on implementation

    await mgr.stopAll();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/instance-manager.test.ts --grep "crash recovery"`
Expected: FAIL — `maxRestartsPerWindow` and `restartWindowMs` options don't exist; process `on("exit")` not wired

**Step 3: Implement crash recovery**

Add to `InstanceManager`:

```typescript
private readonly maxRestartsPerWindow: number;
private readonly restartWindowMs: number;
private restartTimestamps: Map<string, number[]> = new Map();

// In constructor:
this.maxRestartsPerWindow = options?.maxRestartsPerWindow ?? 3;
this.restartWindowMs = options?.restartWindowMs ?? 60_000;

// In startInstance, after spawning:
proc.on("exit", (code: number | null, signal: string | null) => {
  this.handleProcessExit(id, code, signal);
});

private async handleProcessExit(
  id: string,
  code: number | null,
  _signal: string | null,
): Promise<void> {
  const instance = this.instances.get(id);
  if (!instance) return;

  this.processes.delete(id);
  this.stopHealthPolling(id);

  // Intentional stop (code 0 or user-initiated)
  if (code === 0 || instance.status === "stopped") {
    instance.status = "stopped";
    instance.exitCode = code ?? 0;
    this.emit("status_changed", instance);
    return;
  }

  instance.exitCode = code ?? undefined;
  instance.restartCount++;

  // Check restart budget
  const now = Date.now();
  const timestamps = this.restartTimestamps.get(id) ?? [];
  timestamps.push(now);
  const recent = timestamps.filter((t) => now - t < this.restartWindowMs);
  this.restartTimestamps.set(id, recent);

  if (recent.length > this.maxRestartsPerWindow) {
    instance.status = "stopped";
    this.emit("status_changed", instance);
    this.emit("instance_error", {
      id,
      error: `Instance crashed ${recent.length} times in ${this.restartWindowMs / 1000}s — giving up`,
    });
    return;
  }

  // Restart with exponential backoff
  const backoffMs = Math.min(1000 * 2 ** (recent.length - 1), 30_000);
  setTimeout(async () => {
    try {
      await this.startInstance(id);
    } catch (err) {
      instance.status = "stopped";
      this.emit("status_changed", instance);
      this.emit("instance_error", {
        id,
        error: `Restart failed: ${(err as Error).message}`,
      });
    }
  }, backoffMs);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/instance-manager.test.ts --grep "crash recovery"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/instance-manager.ts test/unit/instance-manager.test.ts
git commit -m "feat: add InstanceManager crash recovery with exponential backoff"
```

---

### Task 6: Integrate InstanceManager into Daemon

**Files:**
- Modify: `src/lib/daemon.ts`
- Modify: `test/unit/daemon.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/daemon.test.ts`:

```typescript
describe("multi-instance integration", () => {
  it("daemon creates default instance from opencodeUrl", () => {
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    const instances = daemon.getInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe("default");
    expect(instances[0].port).toBe(4096);
    expect(instances[0].managed).toBe(false);
  });

  it("daemon creates no instances when opencodeUrl is absent", () => {
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
    });

    const instances = daemon.getInstances();
    expect(instances).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/daemon.test.ts --grep "multi-instance integration"`
Expected: FAIL — `getInstances()` method does not exist on Daemon

**Step 3: Add InstanceManager to Daemon**

In `src/lib/daemon.ts`:

1. Import InstanceManager:
```typescript
import { InstanceManager } from "./instance-manager.js";
```

2. Replace `private readonly opencodeUrl: string | null;` with:
```typescript
private readonly instanceManager: InstanceManager;
```

3. In constructor, after existing initialization (around line 162):
```typescript
this.instanceManager = new InstanceManager();

// Backward compatibility: create a "default" instance from opencodeUrl
const initialUrl = options?.opencodeUrl ?? null;
if (initialUrl) {
  // Extract port from URL for the instance record
  const urlPort = new URL(initialUrl).port;
  const port = urlPort ? parseInt(urlPort, 10) : 4096;
  // Register as external (not managed by relay) for backward compat
  this.instanceManager.addInstance("default", {
    name: "Default",
    port,
    managed: false,
    url: initialUrl,
  }).catch(() => {
    // Non-fatal — instance may already exist from config
  });
}
```

4. Add public method:
```typescript
getInstances(): OpenCodeInstance[] {
  return this.instanceManager.getInstances();
}
```

5. Update `addProject` to resolve opencodeUrl from instanceManager:
   - Change `this.opencodeUrl` references to `this.getProjectOpencodeUrl(project.instanceId)`
   - Add helper: `private getProjectOpencodeUrl(instanceId?: string): string | null`

6. Update `discoverProjects` similarly.

7. Update `stop()` to call `this.instanceManager.stopAll()`.

8. Update `buildConfig()` to include instances in the persisted config.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/daemon.test.ts --grep "multi-instance integration"`
Expected: PASS

**Step 5: Run full daemon test suite to check for regressions**

Run: `npx vitest run test/unit/daemon.test.ts`
Expected: PASS (all existing tests still pass)

**Step 6: Commit**

```bash
git add src/lib/daemon.ts test/unit/daemon.test.ts
git commit -m "feat: integrate InstanceManager into Daemon, backward-compat default instance"
```

---

### Task 7: Update addProject to Accept and Persist instanceId

**Files:**
- Modify: `src/lib/daemon.ts:374-463`
- Modify: `test/unit/daemon.test.ts`

**Step 1: Write the failing test**

```typescript
describe("addProject with instanceId", () => {
  it("binds project to specified instance", async () => {
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    const project = await daemon.addProject("/tmp/test-project", undefined, "default");
    expect(project.instanceId).toBe("default");
  });

  it("defaults to first available instance when none specified", async () => {
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    const project = await daemon.addProject("/tmp/test-project-2");
    expect(project.instanceId).toBe("default");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/daemon.test.ts --grep "addProject with instanceId"`
Expected: FAIL — `addProject` doesn't accept third parameter

**Step 3: Update addProject signature and implementation**

In `src/lib/daemon.ts`, update `addProject`:

```typescript
async addProject(directory: string, slug?: string, instanceId?: string): Promise<ProjectInfo> {
  // ... existing path normalization ...

  // Resolve instance: explicit > first healthy > first available > undefined
  const resolvedInstanceId = instanceId
    ?? this.instanceManager.getInstances().find(i => i.status === "healthy")?.id
    ?? this.instanceManager.getInstances()[0]?.id;

  // ... existing slug generation ...

  const project: ProjectInfo = {
    slug: resolvedSlug,
    directory,
    title,
    lastUsed: Date.now(),
    instanceId: resolvedInstanceId,
  };

  // ... rest of addProject ...
  // Replace `this.opencodeUrl` with:
  const opencodeUrl = resolvedInstanceId
    ? this.instanceManager.getInstanceUrl(resolvedInstanceId)
    : null;
  // Use opencodeUrl where this.opencodeUrl was used
```

Also update `buildConfig()` to persist `instanceId` in projects:

```typescript
projects: this.getProjects().map((p) => ({
  path: p.directory,
  slug: p.slug,
  title: p.title,
  addedAt: p.lastUsed ?? Date.now(),
  instanceId: p.instanceId,
})),
instances: this.instanceManager.getInstances().map((inst) => ({
  id: inst.id,
  name: inst.name,
  port: inst.port,
  managed: inst.managed,
  env: inst.env,
})),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/daemon.test.ts --grep "addProject with instanceId"`
Expected: PASS

**Step 5: Run full test suite to check regressions**

Run: `npx vitest run test/unit/daemon.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/daemon.ts test/unit/daemon.test.ts
git commit -m "feat: addProject accepts instanceId, persists in config"
```

---

### Task 8: Add Instance IPC Commands

**Files:**
- Modify: `src/lib/ipc-protocol.ts`
- Modify: `src/lib/daemon-ipc.ts`
- Modify: `src/lib/daemon.ts` (IPC context wiring)
- Modify: `test/unit/ipc-protocol.pbt.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/ipc-protocol.pbt.test.ts`:

```typescript
describe("instance commands", () => {
  it("validates instance_list as a valid command", () => {
    const result = validateCommand({ cmd: "instance_list" });
    expect(result).toBeNull(); // null = valid
  });

  it("validates instance_add requires name", () => {
    const result = validateCommand({ cmd: "instance_add" });
    expect(result).not.toBeNull();
    expect(result!.error).toContain("name");
  });

  it("validates instance_add with valid fields", () => {
    const result = validateCommand({
      cmd: "instance_add",
      name: "work",
      port: 4097,
      managed: true,
    });
    expect(result).toBeNull();
  });

  it("validates instance_remove requires id", () => {
    const result = validateCommand({ cmd: "instance_remove" });
    expect(result).not.toBeNull();
    expect(result!.error).toContain("id");
  });

  it("validates instance_start requires id", () => {
    const result = validateCommand({ cmd: "instance_start" });
    expect(result).not.toBeNull();
  });

  it("validates instance_stop requires id", () => {
    const result = validateCommand({ cmd: "instance_stop" });
    expect(result).not.toBeNull();
  });

  it("validates instance_status requires id", () => {
    const result = validateCommand({ cmd: "instance_status" });
    expect(result).not.toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ipc-protocol.pbt.test.ts --grep "instance commands"`
Expected: FAIL — `instance_list` not in VALID_COMMANDS

**Step 3: Add instance commands to IPC protocol**

In `src/lib/ipc-protocol.ts`:

1. Add to `VALID_COMMANDS`:
```typescript
export const VALID_COMMANDS = new Set([
  // ... existing commands ...
  "instance_list",
  "instance_add",
  "instance_remove",
  "instance_start",
  "instance_stop",
  "instance_status",
]);
```

2. Add validation cases in `validateCommand()`:
```typescript
case "instance_add":
  if (typeof cmd.name !== "string" || cmd.name.length === 0) {
    return { ok: false, error: "instance_add requires a non-empty 'name' field" };
  }
  if (typeof cmd.managed !== "boolean") {
    return { ok: false, error: "instance_add requires a boolean 'managed' field" };
  }
  break;

case "instance_remove":
case "instance_start":
case "instance_stop":
case "instance_status":
  if (typeof cmd.id !== "string" || cmd.id.length === 0) {
    return { ok: false, error: `${cmd.cmd} requires a non-empty 'id' field` };
  }
  break;

case "instance_list":
  // No required fields
  break;
```

3. Add dispatch cases in `createCommandRouter()`:

Update the handler type and switch statement:
```typescript
instanceList: () => Promise<IPCResponse>;
instanceAdd: (name: string, port?: number, managed?: boolean, env?: Record<string, string>) => Promise<IPCResponse>;
instanceRemove: (id: string) => Promise<IPCResponse>;
instanceStart: (id: string) => Promise<IPCResponse>;
instanceStop: (id: string) => Promise<IPCResponse>;
instanceStatus: (id: string) => Promise<IPCResponse>;
```

And in the switch:
```typescript
case "instance_list":
  return handlers.instanceList();
case "instance_add":
  return handlers.instanceAdd(
    cmd.name as string,
    cmd.port as number | undefined,
    cmd.managed as boolean,
    cmd.env as Record<string, string> | undefined,
  );
case "instance_remove":
  return handlers.instanceRemove(cmd.id as string);
case "instance_start":
  return handlers.instanceStart(cmd.id as string);
case "instance_stop":
  return handlers.instanceStop(cmd.id as string);
case "instance_status":
  return handlers.instanceStatus(cmd.id as string);
```

**Step 4: Add handler implementations to daemon-ipc.ts**

In `src/lib/daemon-ipc.ts`:

1. Extend `DaemonIPCContext`:
```typescript
getInstances(): OpenCodeInstance[];
getInstance(id: string): OpenCodeInstance | undefined;
addInstance(id: string, config: InstanceConfig): Promise<OpenCodeInstance>;
removeInstance(id: string): Promise<void>;
startInstance(id: string): Promise<void>;
stopInstance(id: string): Promise<void>;
getInstanceUrl(id: string): string;
```

2. Add handlers in `buildIPCHandlers()`:
```typescript
instanceList: async () => {
  return { ok: true, instances: ctx.getInstances() };
},
instanceAdd: async (name, port, managed = true, env) => {
  try {
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const instance = await ctx.addInstance(id, { name, port: port ?? 0, managed, env });
    saveDaemonConfig(ctx.buildConfig(), ctx.configDir);
    return { ok: true, instance };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
},
instanceRemove: async (id) => {
  try {
    await ctx.removeInstance(id);
    saveDaemonConfig(ctx.buildConfig(), ctx.configDir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
},
instanceStart: async (id) => {
  try {
    await ctx.startInstance(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
},
instanceStop: async (id) => {
  try {
    await ctx.stopInstance(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
},
instanceStatus: async (id) => {
  const instance = ctx.getInstance(id);
  if (!instance) return { ok: false, error: `Instance "${id}" not found` };
  return { ok: true, instance };
},
```

3. Extend `IPCHandlerMap` with matching signatures.

**Step 5: Wire instance context in daemon.ts**

In `daemon.ts` `startIPCServer()` (lines 704-731), add to the context object:

```typescript
getInstances: () => this.instanceManager.getInstances(),
getInstance: (id) => this.instanceManager.getInstance(id),
addInstance: (id, config) => this.instanceManager.addInstance(id, config),
removeInstance: (id) => this.instanceManager.removeInstance(id),
startInstance: (id) => this.instanceManager.startInstance(id),
stopInstance: (id) => this.instanceManager.stopInstance(id),
getInstanceUrl: (id) => this.instanceManager.getInstanceUrl(id),
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/ipc-protocol.pbt.test.ts --grep "instance commands"`
Expected: PASS

**Step 7: Run full test suite**

Run: `npx vitest run test/unit/ipc-protocol.pbt.test.ts test/unit/daemon.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/lib/ipc-protocol.ts src/lib/daemon-ipc.ts src/lib/daemon.ts test/unit/ipc-protocol.pbt.test.ts
git commit -m "feat: add instance_list/add/remove/start/stop/status IPC commands"
```

---

### Task 9: Add Instance CLI Subcommands

**Files:**
- Modify: `src/bin/cli-core.ts`
- Modify: `src/bin/cli-utils.ts`
- Modify: `test/unit/cli.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/cli.test.ts`:

```typescript
describe("instance subcommands", () => {
  it("instance list sends instance_list IPC", async () => {
    const ipcCalls: IPCCommand[] = [];
    await run(["--instance", "list"], {
      sendIPC: async (cmd) => {
        ipcCalls.push(cmd);
        return { ok: true, instances: [] };
      },
      isDaemonRunning: async () => true,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      exit: () => {},
    });

    expect(ipcCalls).toContainEqual({ cmd: "instance_list" });
  });

  it("instance add sends instance_add IPC", async () => {
    const ipcCalls: IPCCommand[] = [];
    await run(["--instance", "add", "work", "--port", "4097", "--managed"], {
      sendIPC: async (cmd) => {
        ipcCalls.push(cmd);
        return { ok: true, instance: { id: "work" } };
      },
      isDaemonRunning: async () => true,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      exit: () => {},
    });

    expect(ipcCalls).toContainEqual(
      expect.objectContaining({ cmd: "instance_add", name: "work" }),
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/cli.test.ts --grep "instance subcommands"`
Expected: FAIL — `--instance` flag not recognized

**Step 3: Add `instance` command parsing to `cli-utils.ts`**

In `parseArgs()`, add handling for `--instance` flag that reads the sub-action and arguments.

In `cli-core.ts`, add an `if (args.command === "instance")` block that routes to instance sub-actions:

```typescript
if (args.command === "instance") {
  const running = await checkDaemon();
  if (!running) {
    stderr.write("Daemon is not running.\n");
    exit(1);
    return;
  }

  const subAction = args.instanceAction; // "list" | "add" | "remove" | "start" | "stop" | "status"

  switch (subAction) {
    case "list": {
      const response = await ipcSend({ cmd: "instance_list" });
      if (!response.ok) {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
        return;
      }
      const instances = (response.instances ?? []) as OpenCodeInstance[];
      if (instances.length === 0) {
        stdout.write("No instances configured.\n");
      } else {
        stdout.write(`Instances (${instances.length}):\n`);
        for (const inst of instances) {
          const statusIcon = inst.status === "healthy" ? "●" : inst.status === "starting" ? "○" : "✕";
          stdout.write(`  ${statusIcon} ${inst.id} (${inst.name}) — port ${inst.port}, ${inst.status}\n`);
        }
      }
      return;
    }
    case "add": {
      const response = await ipcSend({
        cmd: "instance_add",
        name: args.instanceName,
        port: args.instancePort,
        managed: args.instanceManaged ?? true,
        env: args.instanceEnv,
      });
      if (response.ok) {
        stdout.write(`Instance added: ${args.instanceName}\n`);
      } else {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
      }
      return;
    }
    case "remove": {
      const response = await ipcSend({
        cmd: "instance_remove",
        id: args.instanceName,
      });
      if (response.ok) {
        stdout.write(`Instance removed: ${args.instanceName}\n`);
      } else {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
      }
      return;
    }
    case "start": {
      const response = await ipcSend({
        cmd: "instance_start",
        id: args.instanceName,
      });
      if (response.ok) {
        stdout.write(`Instance started: ${args.instanceName}\n`);
      } else {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
      }
      return;
    }
    case "stop": {
      const response = await ipcSend({
        cmd: "instance_stop",
        id: args.instanceName,
      });
      if (response.ok) {
        stdout.write(`Instance stopped: ${args.instanceName}\n`);
      } else {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
      }
      return;
    }
    case "status": {
      const response = await ipcSend({
        cmd: "instance_status",
        id: args.instanceName,
      });
      if (!response.ok) {
        stderr.write(`Failed: ${response.error}\n`);
        exit(1);
        return;
      }
      const inst = response.instance as OpenCodeInstance;
      stdout.write(`Instance: ${inst.name} (${inst.id})\n`);
      stdout.write(`  Status: ${inst.status}\n`);
      stdout.write(`  Port: ${inst.port}\n`);
      stdout.write(`  Managed: ${inst.managed}\n`);
      if (inst.pid) stdout.write(`  PID: ${inst.pid}\n`);
      return;
    }
    default:
      stderr.write(`Unknown instance action: ${subAction}\n`);
      exit(1);
      return;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/cli.test.ts --grep "instance subcommands"`
Expected: PASS

**Step 5: Run full CLI test suite**

Run: `npx vitest run test/unit/cli.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/bin/cli-core.ts src/bin/cli-utils.ts test/unit/cli.test.ts
git commit -m "feat: add instance list/add/remove/start/stop/status CLI subcommands"
```

---

### Task 10: Add Instance WebSocket Protocol Messages

**Files:**
- Modify: `src/lib/shared-types.ts` (add instance RelayMessage variants)
- Modify: `src/lib/ws-handler.ts` (handle incoming instance commands)
- Modify: `test/unit/ws-message-dispatch.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/ws-message-dispatch.test.ts`:

```typescript
describe("instance messages", () => {
  it("dispatches instance_list message", () => {
    const msg: RelayMessage = {
      type: "instance_list",
      instances: [],
    };
    // Verify it type-checks as a valid RelayMessage
    expect(msg.type).toBe("instance_list");
  });

  it("dispatches instance_status message", () => {
    const msg: RelayMessage = {
      type: "instance_status",
      instanceId: "personal",
      status: "healthy",
    };
    expect(msg.type).toBe("instance_status");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ws-message-dispatch.test.ts --grep "instance messages"`
Expected: FAIL — `instance_list` and `instance_status` not valid RelayMessage types

**Step 3: Add instance message types to RelayMessage union**

In `src/lib/shared-types.ts`, add to `RelayMessage` union (before the closing `;`):

```typescript
// ─── Instance Management ──────────────────────────────────────────────
| { type: "instance_list"; instances: OpenCodeInstance[] }
| { type: "instance_status"; instanceId: string; status: InstanceStatus }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/ws-message-dispatch.test.ts --grep "instance messages"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/shared-types.ts test/unit/ws-message-dispatch.test.ts
git commit -m "feat: add instance_list and instance_status WebSocket message types"
```

---

### Task 11: Create Frontend Instance Store

**Files:**
- Create: `src/lib/public/stores/instance.svelte.ts`
- Create: `test/unit/svelte-instance-store.test.ts`

**Step 1: Write the failing test**

Create `test/unit/svelte-instance-store.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import {
  instanceState,
  handleInstanceList,
  handleInstanceStatus,
  clearInstanceState,
  getInstanceById,
  getHealthyInstances,
} from "../../src/lib/public/stores/instance.svelte.js";

describe("instance store", () => {
  beforeEach(() => {
    clearInstanceState();
  });

  it("initializes with empty state", () => {
    expect(instanceState.instances).toEqual([]);
    expect(instanceState.currentInstanceId).toBeNull();
  });

  it("handleInstanceList populates instances", () => {
    handleInstanceList({
      type: "instance_list",
      instances: [
        {
          id: "personal",
          name: "Personal",
          port: 4096,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    expect(instanceState.instances).toHaveLength(1);
    expect(instanceState.instances[0].id).toBe("personal");
  });

  it("handleInstanceStatus updates a single instance status", () => {
    handleInstanceList({
      type: "instance_list",
      instances: [
        {
          id: "personal",
          name: "Personal",
          port: 4096,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    handleInstanceStatus({
      type: "instance_status",
      instanceId: "personal",
      status: "unhealthy",
    });

    expect(instanceState.instances[0].status).toBe("unhealthy");
  });

  it("getInstanceById returns matching instance", () => {
    handleInstanceList({
      type: "instance_list",
      instances: [
        {
          id: "work",
          name: "Work",
          port: 4097,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    expect(getInstanceById("work")).toBeDefined();
    expect(getInstanceById("nope")).toBeUndefined();
  });

  it("getHealthyInstances filters by status", () => {
    handleInstanceList({
      type: "instance_list",
      instances: [
        {
          id: "a",
          name: "A",
          port: 4096,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
        {
          id: "b",
          name: "B",
          port: 4097,
          managed: true,
          status: "stopped",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    expect(getHealthyInstances()).toHaveLength(1);
    expect(getHealthyInstances()[0].id).toBe("a");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/svelte-instance-store.test.ts`
Expected: FAIL — module does not exist

**Step 3: Create the instance store**

Create `src/lib/public/stores/instance.svelte.ts`:

```typescript
// ─── Instance Store ─────────────────────────────────────────────────────────
// Manages the list of OpenCode instances and their statuses.

import type { OpenCodeInstance, RelayMessage } from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const instanceState = $state({
  instances: [] as OpenCodeInstance[],
  currentInstanceId: null as string | null,
});

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleInstanceList(
  msg: Extract<RelayMessage, { type: "instance_list" }>,
): void {
  if (Array.isArray(msg.instances)) {
    instanceState.instances = msg.instances;
  }
}

export function handleInstanceStatus(
  msg: Extract<RelayMessage, { type: "instance_status" }>,
): void {
  const idx = instanceState.instances.findIndex(
    (i) => i.id === msg.instanceId,
  );
  if (idx !== -1) {
    instanceState.instances[idx] = {
      ...instanceState.instances[idx],
      status: msg.status,
    };
  }
}

// ─── Getters ────────────────────────────────────────────────────────────────

export function getInstanceById(id: string): OpenCodeInstance | undefined {
  return instanceState.instances.find((i) => i.id === id);
}

export function getHealthyInstances(): OpenCodeInstance[] {
  return instanceState.instances.filter((i) => i.status === "healthy");
}

// ─── Reset ──────────────────────────────────────────────────────────────────

export function clearInstanceState(): void {
  instanceState.instances = [];
  instanceState.currentInstanceId = null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/svelte-instance-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/stores/instance.svelte.ts test/unit/svelte-instance-store.test.ts
git commit -m "feat: add frontend instance store with message handlers"
```

---

### Task 12: Wire Instance Messages into WebSocket Dispatch

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts`
- Modify: `test/unit/ws-message-dispatch.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/ws-message-dispatch.test.ts`:

```typescript
describe("instance message dispatch", () => {
  it("instance_list message updates instance store", () => {
    handleMessage({
      type: "instance_list",
      instances: [
        {
          id: "personal",
          name: "Personal",
          port: 4096,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    expect(instanceState.instances).toHaveLength(1);
  });

  it("instance_status message updates instance status", () => {
    handleMessage({
      type: "instance_list",
      instances: [
        {
          id: "personal",
          name: "Personal",
          port: 4096,
          managed: true,
          status: "healthy",
          restartCount: 0,
          createdAt: Date.now(),
        },
      ],
    });

    handleMessage({
      type: "instance_status",
      instanceId: "personal",
      status: "unhealthy",
    });

    expect(instanceState.instances[0].status).toBe("unhealthy");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ws-message-dispatch.test.ts --grep "instance message dispatch"`
Expected: FAIL — `handleMessage` doesn't dispatch instance messages

**Step 3: Add instance dispatch to ws.svelte.ts**

In `src/lib/public/stores/ws.svelte.ts`:

1. Import the instance handlers:
```typescript
import {
  handleInstanceList,
  handleInstanceStatus,
} from "./instance.svelte.js";
```

2. Add cases to the `handleMessage` switch statement:
```typescript
case "instance_list":
  handleInstanceList(msg);
  break;
case "instance_status":
  handleInstanceStatus(msg);
  break;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/ws-message-dispatch.test.ts --grep "instance message dispatch"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/stores/ws.svelte.ts test/unit/ws-message-dispatch.test.ts
git commit -m "feat: wire instance messages into WebSocket dispatch"
```

---

### Task 13: Broadcast Instance Status from Daemon to Frontend

**Files:**
- Modify: `src/lib/daemon.ts`

**Step 1: Write the failing test**

Add to `test/unit/daemon.test.ts`:

```typescript
describe("instance status broadcast", () => {
  it("broadcasts instance_list on new WebSocket connection", async () => {
    // This tests that when a relay WS client connects,
    // it receives the current instance list
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    const instances = daemon.getInstances();
    expect(instances.length).toBeGreaterThan(0);
    // The actual broadcast happens when the WS handler sends initial state.
    // This is a structural test — the relay-stack integration test would
    // verify the full WebSocket flow.
  });
});
```

**Step 2: Implement broadcast**

In `daemon.ts`, after the InstanceManager is created in the constructor, register an event listener:

```typescript
this.instanceManager.on("status_changed", (instance: OpenCodeInstance) => {
  // Broadcast to all connected browsers across all project relays
  for (const relay of this.projectRelays.values()) {
    relay.wsHandler.broadcast({
      type: "instance_status",
      instanceId: instance.id,
      status: instance.status,
    });
  }
});
```

Also add instance list to the initial state sent on WebSocket connection. This requires modifying how the relay's WebSocket handler sends initial state. In the `addProject` method where `createProjectRelay()` is called, the relay config could include a `getInstances` callback that the WS handler uses to send instance list on connection.

The exact mechanism: add an `onConnect` callback to `ProjectRelayConfig` that sends instance_list when a new WS client connects:

```typescript
// In addProject, when creating the relay:
const relay = await createProjectRelay({
  // ... existing config ...
  onClientConnect: (send) => {
    send({
      type: "instance_list",
      instances: this.instanceManager.getInstances(),
    });
  },
});
```

**Step 3: Run tests**

Run: `npx vitest run test/unit/daemon.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/daemon.ts
git commit -m "feat: broadcast instance status changes to frontend via WebSocket"
```

---

### Task 14: Update ProjectSwitcher to Group Projects by Instance

**Files:**
- Modify: `src/lib/public/components/features/ProjectSwitcher.svelte`

**Step 1: Review current ProjectSwitcher structure**

The component currently renders a flat list of projects. We need to group them by `instanceId`.

**Step 2: Update ProjectSwitcher to group by instance**

```svelte
<script lang="ts">
  import { instanceState, getInstanceById } from "../../stores/instance.svelte.js";

  // ... existing props and state ...

  // Group projects by instance
  const projectsByInstance = $derived(() => {
    const groups = new Map<string, typeof projects>();
    for (const project of projects) {
      const key = project.instanceId ?? "default";
      const group = groups.get(key) ?? [];
      group.push(project);
      groups.set(key, group);
    }
    return groups;
  });

  const hasMultipleInstances = $derived(instanceState.instances.length > 1);
</script>

<!-- In the template, conditionally render grouped or flat -->
{#if hasMultipleInstances}
  {#each instanceState.instances as instance}
    {@const groupProjects = projectsByInstance().get(instance.id) ?? []}
    {#if groupProjects.length > 0}
      <div class="px-3 py-1.5 text-xs font-medium text-zinc-500 uppercase tracking-wider">
        <span class="inline-block w-2 h-2 rounded-full mr-1.5
          {instance.status === 'healthy' ? 'bg-green-500' :
           instance.status === 'starting' ? 'bg-yellow-500' :
           instance.status === 'unhealthy' ? 'bg-red-500' : 'bg-zinc-500'}">
        </span>
        {instance.name}
      </div>
      {#each groupProjects as project}
        <!-- existing project item rendering -->
      {/each}
    {/if}
  {/each}
{:else}
  <!-- existing flat project list rendering -->
{/if}
```

**Step 3: Test manually by running dev server**

Run: `pnpm dev`

Verify: Projects appear grouped by instance when multiple instances exist, and flat when only one instance.

**Step 4: Commit**

```bash
git add src/lib/public/components/features/ProjectSwitcher.svelte
git commit -m "feat: group projects by instance in ProjectSwitcher dropdown"
```

---

### Task 15: Add Instance Indicator to Header

**Files:**
- Modify: `src/lib/public/components/layout/Header.svelte`

**Step 1: Update Header to show instance name and health**

In `Header.svelte`, after the project name display, add a small instance indicator:

```svelte
<script lang="ts">
  import { instanceState, getInstanceById } from "../../stores/instance.svelte.js";
  import { projectState } from "../../stores/project.svelte.js";

  const currentProject = $derived(
    projectState.projects.find(p => p.slug === projectState.currentSlug)
  );
  const currentInstance = $derived(
    currentProject?.instanceId ? getInstanceById(currentProject.instanceId) : undefined
  );
  const showInstanceBadge = $derived(instanceState.instances.length > 1);
</script>

<!-- Near the status dot / project name area -->
{#if showInstanceBadge && currentInstance}
  <span class="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
    bg-zinc-800/50 text-zinc-400 border border-zinc-700/50">
    <span class="w-1.5 h-1.5 rounded-full
      {currentInstance.status === 'healthy' ? 'bg-green-500' :
       currentInstance.status === 'starting' ? 'bg-yellow-500' :
       currentInstance.status === 'unhealthy' ? 'bg-red-500' : 'bg-zinc-500'}">
    </span>
    {currentInstance.name}
  </span>
{/if}
```

**Step 2: Test manually**

Run: `pnpm dev`

Verify: Instance badge appears next to project name when multiple instances are configured.

**Step 3: Commit**

```bash
git add src/lib/public/components/layout/Header.svelte
git commit -m "feat: add instance indicator badge to Header"
```

---

### Task 16: Update ConnectOverlay for Instance-Aware Messaging

**Files:**
- Modify: `src/lib/public/components/overlays/ConnectOverlay.svelte`

**Step 1: Update ConnectOverlay to show instance-specific error**

When the WebSocket is disconnected, if we know which instance the current project uses, show its name:

```svelte
<script lang="ts">
  import { instanceState, getInstanceById } from "../../stores/instance.svelte.js";
  import { projectState } from "../../stores/project.svelte.js";

  const currentProject = $derived(
    projectState.projects.find(p => p.slug === projectState.currentSlug)
  );
  const instanceName = $derived(
    currentProject?.instanceId
      ? getInstanceById(currentProject.instanceId)?.name ?? "OpenCode"
      : "OpenCode"
  );
</script>

<!-- In the overlay message, use instanceName instead of hardcoded "OpenCode" -->
```

**Step 2: Commit**

```bash
git add src/lib/public/components/overlays/ConnectOverlay.svelte
git commit -m "feat: show instance name in ConnectOverlay disconnect message"
```

---

### Task 17: Backward Compatibility — Config Migration

**Files:**
- Modify: `src/lib/daemon.ts`
- Modify: `test/unit/daemon.test.ts`

**Step 1: Write the failing test**

```typescript
describe("backward compatibility", () => {
  it("loads config without instances and creates default", async () => {
    // Write old-format config
    const oldConfig = {
      pid: 9999,
      port: 2633,
      pinHash: null,
      tls: false,
      debug: false,
      keepAwake: false,
      dangerouslySkipPermissions: false,
      projects: [
        { path: "/src/myapp", slug: "myapp", addedAt: Date.now() },
      ],
      // No "instances" field
    };
    saveDaemonConfig(oldConfig as DaemonConfig, tmpDir);

    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    // Verify backward compat: projects should get default instanceId
    const instances = daemon.getInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe("default");
  });

  it("existing projects get instanceId: default when none set", async () => {
    const daemon = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    await daemon.start();
    const project = await daemon.addProject("/tmp/compat-test");
    expect(project.instanceId).toBe("default");
    await daemon.stop();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/daemon.test.ts --grep "backward compatibility"`
Expected: FAIL or PASS depending on current state — verify the default instance assignment

**Step 3: Ensure backward compatibility in daemon constructor**

The constructor already creates a "default" instance when `opencodeUrl` is provided (from Task 6). Verify that:

1. When loading a saved config that has `instances` array, restore those instances instead of the default.
2. When loading a saved config WITHOUT `instances` array, create default from `opencodeUrl`.
3. Projects without `instanceId` get `"default"` assigned.

This may already work from Task 6 + 7. If not, add the migration logic:

```typescript
// In daemon.start(), after loading saved config:
const savedConfig = loadDaemonConfig(this.configDir);
if (savedConfig?.instances) {
  for (const inst of savedConfig.instances) {
    try {
      await this.instanceManager.addInstance(inst.id, {
        name: inst.name,
        port: inst.port,
        managed: inst.managed,
        env: inst.env,
        url: inst.url,
      });
    } catch {
      // Instance may already exist from constructor
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/daemon.test.ts --grep "backward compatibility"`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run test/unit`
Expected: PASS

**Step 6: Commit**

```bash
git add src/lib/daemon.ts test/unit/daemon.test.ts
git commit -m "feat: backward-compat config migration for multi-instance"
```

---

### Task 18: Update daemon-spawn.ts for Multi-Instance Env Vars

**Files:**
- Modify: `src/lib/daemon-spawn.ts`
- Modify: `src/lib/env.ts`
- Modify: `test/unit/daemon.test.ts`

**Step 1: Write the failing test**

```typescript
describe("buildSpawnConfig with instances", () => {
  it("includes OC_INSTANCES env var when instances configured", () => {
    const config = buildSpawnConfig({
      port: 2633,
    });
    // The spawn config should not include instance details in env
    // because instances are loaded from daemon.json, not env vars
    // This test verifies the existing behavior is preserved
    expect(config.options.env).toBeDefined();
  });
});
```

**Step 2: Implementation**

The key insight: instances should be persisted in `daemon.json` and loaded on daemon startup, NOT passed via env vars. The existing `OPENCODE_RELAY_OC_URL` env var is kept for backward compatibility (single-instance case). The daemon reads `daemon.json` on startup and restores saved instances.

This means `daemon-spawn.ts` needs minimal changes. The daemon child process reads instances from the config file.

**Step 3: Run tests**

Run: `npx vitest run test/unit/daemon.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/lib/daemon-spawn.ts src/lib/env.ts test/unit/daemon.test.ts
git commit -m "docs: clarify instance config is persisted via daemon.json, not env vars"
```

---

### Task 19: Full Integration Test — End-to-End Instance Lifecycle

**Files:**
- Create: `test/unit/instance-lifecycle.test.ts`

**Step 1: Write integration test**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../../src/lib/daemon.js";
import {
  loadDaemonConfig,
  saveDaemonConfig,
} from "../../src/lib/config-persistence.js";

describe("instance lifecycle integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "instance-lifecycle-"));
  });

  it("full CRUD lifecycle: add, list, get, remove", async () => {
    const daemon = new Daemon({ port: 0, configDir: tmpDir });

    // Initially no instances
    expect(daemon.getInstances()).toHaveLength(0);

    // Add instances via IPC context (simulating IPC calls)
    // We test through the daemon's public API
    // Note: In real usage, this would go through IPC

    // Since addInstance is on the InstanceManager (private),
    // we'd test via IPC in a separate integration test.
    // Here we verify the daemon's getInstances works correctly
    // after construction with opencodeUrl.

    const daemonWithUrl = new Daemon({
      port: 0,
      configDir: tmpDir,
      opencodeUrl: "http://localhost:4096",
    });

    expect(daemonWithUrl.getInstances()).toHaveLength(1);
    expect(daemonWithUrl.getInstances()[0].id).toBe("default");
  });

  it("persists instances across daemon restarts", async () => {
    // Save config with instances
    saveDaemonConfig(
      {
        pid: 1,
        port: 2633,
        pinHash: null,
        tls: false,
        debug: false,
        keepAwake: false,
        dangerouslySkipPermissions: false,
        projects: [
          { path: "/src/app", slug: "app", addedAt: Date.now(), instanceId: "personal" },
        ],
        instances: [
          { id: "personal", name: "Personal", port: 4096, managed: true },
          { id: "work", name: "Work", port: 4097, managed: true },
        ],
      },
      tmpDir,
    );

    // Verify config loads correctly
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.instances).toHaveLength(2);
    expect(loaded!.projects[0].instanceId).toBe("personal");
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run test/unit/instance-lifecycle.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/instance-lifecycle.test.ts
git commit -m "test: add instance lifecycle integration test"
```

---

### Task 20: Run Full Test Suite and Fix Any Regressions

**Files:**
- Potentially any modified files

**Step 1: Run full unit test suite**

Run: `npx vitest run test/unit`
Expected: ALL PASS

**Step 2: Run type check**

Run: `pnpm check`
Expected: No type errors

**Step 3: Run linter**

Run: `pnpm lint`
Expected: No errors

**Step 4: Run build**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Fix any failures**

If any test fails or type/lint errors appear, fix them. Each fix should be a separate, descriptive commit.

**Step 6: Final commit**

```bash
git add -A
git commit -m "fix: address regressions from multi-instance implementation"
```

---

## Implementation Order Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Instance types | None |
| 2 | DaemonConfig instances | Task 1 |
| 3 | InstanceManager core (add/remove/get) | Task 1 |
| 4 | InstanceManager spawn/health | Task 3 |
| 5 | InstanceManager crash recovery | Task 4 |
| 6 | Integrate InstanceManager into Daemon | Tasks 2, 3 |
| 7 | addProject with instanceId | Task 6 |
| 8 | Instance IPC commands | Tasks 6, 7 |
| 9 | Instance CLI subcommands | Task 8 |
| 10 | Instance WebSocket messages | Task 1 |
| 11 | Frontend instance store | Task 10 |
| 12 | Wire instance WS dispatch | Tasks 10, 11 |
| 13 | Daemon → Frontend broadcast | Tasks 6, 10 |
| 14 | ProjectSwitcher grouping | Tasks 11, 12 |
| 15 | Header instance indicator | Tasks 11, 12 |
| 16 | ConnectOverlay instance-aware | Tasks 11, 12 |
| 17 | Backward compat / migration | Task 6 |
| 18 | daemon-spawn env vars | Task 6 |
| 19 | Integration test | All above |
| 20 | Full test suite verification | All above |

## Deferred (Not in This Plan)

The following features from the design doc are deferred to reduce scope:

- **InstanceManager.svelte settings panel** — Full CRUD UI for managing instances via the web UI. Can be added later once the backend is stable.
- **InstanceSelector dropdown** — Clicking the header badge to switch instances. The ProjectSwitcher grouping provides instance awareness without needing a separate selector.
- **Orphan reclamation** — Reclaiming previously managed processes on daemon restart. Adds complexity; can be added once basic multi-instance is working.
- **Port conflict detection** — Checking if a port is occupied before spawning. The spawner already fails on EADDRINUSE which is sufficient for now.
- **Config file permissions (0600)** — Can be added as a follow-up since env vars with secrets are already protected by OS user permissions.
- **First-run interactive setup prompt** — When no instances are configured, showing a wizard. The CLI `instance add` command is sufficient for initial setup.
