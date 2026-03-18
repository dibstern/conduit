# Instance Auto-Discovery & Provider Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the smart instance creation form with auto-discovery of running OpenCode servers and scenario-based TUI guidance, making the relay UI a monitor/controller rather than a config editor.

**Architecture:** A background PortScanner service in the daemon probes ports 4096-4110 every 10 seconds for running OpenCode servers. Discovered instances are auto-registered as unmanaged in InstanceManager. The web UI replaces the add-instance form with a Getting Started panel showing copyable terminal commands for three setup scenarios (Direct API Key, CCS Proxy, Custom). Project-to-instance assignment (already exists) is surfaced with a dropdown. Instance renaming (already exists via updateInstance) gets a dedicated WS message and UI control.

**Tech Stack:** TypeScript, Svelte 5 (runes), Node.js HTTP probing, WebSocket messages, Vitest

**Prerequisite:** Ship the current `feat/smart-instance-form` branch first, then create a new branch from main for this work.

---

### Task 1: Port Scanner Service — Unit Tests

**Files:**
- Create: `src/lib/daemon/port-scanner.ts`
- Create: `test/unit/daemon/port-scanner.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/daemon/port-scanner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortScanner, type PortScannerConfig } from "../../src/lib/daemon/port-scanner";

describe("PortScanner", () => {
  const defaultConfig: PortScannerConfig = {
    portRange: [4096, 4100],
    intervalMs: 10_000,
    probeTimeoutMs: 2000,
    removalThreshold: 3,
  };

  let scanner: PortScanner;
  let mockProbe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockProbe = vi.fn().mockResolvedValue(false);
    scanner = new PortScanner(defaultConfig, mockProbe);
  });

  afterEach(() => {
    scanner.stop();
    vi.useRealTimers();
  });

  it("probes all ports in range on scan", async () => {
    await scanner.scan();
    expect(mockProbe).toHaveBeenCalledTimes(5); // 4096-4100 inclusive
    expect(mockProbe).toHaveBeenCalledWith(4096);
    expect(mockProbe).toHaveBeenCalledWith(4100);
  });

  it("reports discovered ports", async () => {
    mockProbe.mockImplementation((port: number) => Promise.resolve(port === 4098));
    const result = await scanner.scan();
    expect(result.discovered).toEqual([4098]);
    expect(result.lost).toEqual([]);
  });

  it("reports lost ports after removalThreshold consecutive failures", async () => {
    // First scan: port 4098 is up
    mockProbe.mockImplementation((port: number) => Promise.resolve(port === 4098));
    await scanner.scan();
    expect(scanner.getDiscovered()).toEqual(new Set([4098]));

    // Next 3 scans: port 4098 is down
    mockProbe.mockResolvedValue(false);
    await scanner.scan(); // failure 1
    await scanner.scan(); // failure 2
    const result = await scanner.scan(); // failure 3 = threshold
    expect(result.lost).toEqual([4098]);
    expect(scanner.getDiscovered()).toEqual(new Set());
  });

  it("resets failure count when port comes back", async () => {
    mockProbe.mockImplementation((port: number) => Promise.resolve(port === 4098));
    await scanner.scan(); // discovered

    mockProbe.mockResolvedValue(false);
    await scanner.scan(); // failure 1
    await scanner.scan(); // failure 2

    // Port comes back before threshold
    mockProbe.mockImplementation((port: number) => Promise.resolve(port === 4098));
    await scanner.scan();
    expect(scanner.getDiscovered()).toEqual(new Set([4098]));
  });

  it("skips excluded ports", async () => {
    scanner.excludePorts(new Set([4097, 4098]));
    await scanner.scan();
    expect(mockProbe).toHaveBeenCalledTimes(3); // 4096, 4099, 4100
    expect(mockProbe).not.toHaveBeenCalledWith(4097);
    expect(mockProbe).not.toHaveBeenCalledWith(4098);
  });

  it("start() triggers periodic scans", async () => {
    const onScan = vi.fn();
    scanner.on("scan", onScan);
    scanner.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onScan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onScan).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels periodic scans", async () => {
    const onScan = vi.fn();
    scanner.on("scan", onScan);
    scanner.start();
    scanner.stop();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(onScan).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/port-scanner.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/lib/daemon/port-scanner.ts
import { EventEmitter } from "node:events";

export interface PortScannerConfig {
  portRange: [number, number];
  intervalMs: number;
  probeTimeoutMs: number;
  removalThreshold: number;
}

export interface ScanResult {
  discovered: number[];
  lost: number[];
}

type ProbeFn = (port: number) => Promise<boolean>;

export class PortScanner extends EventEmitter {
  private config: PortScannerConfig;
  private probeFn: ProbeFn;
  private discovered = new Set<number>();
  private failureCounts = new Map<number, number>();
  private excluded = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PortScannerConfig, probeFn: ProbeFn) {
    super();
    this.config = config;
    this.probeFn = probeFn;
  }

  excludePorts(ports: Set<number>): void {
    this.excluded = ports;
  }

  getDiscovered(): Set<number> {
    return new Set(this.discovered);
  }

  async scan(): Promise<ScanResult> {
    const [start, end] = this.config.portRange;
    const ports: number[] = [];
    for (let p = start; p <= end; p++) {
      if (!this.excluded.has(p)) ports.push(p);
    }

    const results = await Promise.all(
      ports.map(async (port) => ({ port, alive: await this.probeFn(port).catch(() => false) })),
    );

    const newlyDiscovered: number[] = [];
    const lost: number[] = [];

    for (const { port, alive } of results) {
      if (alive) {
        if (!this.discovered.has(port)) {
          newlyDiscovered.push(port);
          this.discovered.add(port);
        }
        this.failureCounts.delete(port);
      } else if (this.discovered.has(port)) {
        const count = (this.failureCounts.get(port) ?? 0) + 1;
        if (count >= this.config.removalThreshold) {
          lost.push(port);
          this.discovered.delete(port);
          this.failureCounts.delete(port);
        } else {
          this.failureCounts.set(port, count);
        }
      }
    }

    const result: ScanResult = { discovered: newlyDiscovered, lost };
    this.emit("scan", result);
    return result;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.scan(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/port-scanner.test.ts`
Expected: PASS (7 tests)

**Step 5: Commit**

```
feat: add PortScanner service with discovery and removal threshold
```

---

### Task 2: OpenCode Health Probe Function

**Files:**
- Modify: `src/lib/daemon/daemon-utils.ts` — add `probeOpenCode(port)`
- Modify: `test/unit/daemon/daemon-utils.test.ts` — add probe tests

**Step 1: Write the failing test**

```typescript
// Add to test/unit/daemon/daemon-utils.test.ts
describe("probeOpenCode", () => {
  it("returns true for valid OpenCode response", async () => {
    // Mock fetch to return a valid response
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const result = await probeOpenCode(4098, { fetch: mockFetch, timeoutMs: 2000 });
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4098/api/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false for non-200 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    const result = await probeOpenCode(4098, { fetch: mockFetch, timeoutMs: 2000 });
    expect(result).toBe(false);
  });

  it("returns false on timeout/network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeOpenCode(4098, { fetch: mockFetch, timeoutMs: 2000 });
    expect(result).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon/daemon-utils.test.ts`
Expected: FAIL — `probeOpenCode` not found

**Step 3: Write minimal implementation**

```typescript
// Add to src/lib/daemon/daemon-utils.ts
interface ProbeOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export async function probeOpenCode(
  port: number,
  options: ProbeOptions = {},
): Promise<boolean> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 2000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchFn(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon/daemon-utils.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add probeOpenCode health check utility for port scanning
```

---

### Task 3: Integrate Port Scanner into Daemon

**Files:**
- Modify: `src/lib/daemon/daemon.ts` — add scanner to `start()`, wire scan results to InstanceManager
- Add tests to `test/unit/daemon/daemon.test.ts` or create `test/unit/daemon/daemon-scanner.test.ts`

**Step 1: Write the failing test**

Test that the daemon starts a port scanner on startup and registers discovered instances.

**Step 2: Implement integration**

In `daemon.start()`, after instance rehydration (L283–304):
1. Create a PortScanner with `probeOpenCode` as the probe function
2. Set excluded ports to those already occupied by managed instances
3. Wire `scanner.on("scan", result => ...)` to:
   - For `discovered` ports: call `instanceManager.addInstance()` with unmanaged config
   - For `lost` ports: call `instanceManager.removeInstance()` if the instance is unmanaged
4. Call `scanner.start()`
5. Store scanner on `this.scanner` for cleanup in `stop()`

**Step 3: Run tests, commit**

```
feat: integrate port scanner into daemon startup
```

---

### Task 4: `scan_now` WS Message Handler

**Files:**
- Modify: `src/lib/server/ws-router.ts` — add `scan_now` to types/set
- Create handler in `src/lib/handlers/` (or add to existing instance handler)
- Modify: `src/lib/shared-types.ts` — add `scan_result` outbound message
- Add tests

**Step 1: Write failing test for handler**

```typescript
describe("handleScanNow", () => {
  it("triggers a scan and returns results", async () => {
    const mockScanner = { scan: vi.fn().mockResolvedValue({ discovered: [4098], lost: [] }) };
    const deps = createMockHandlerDeps({ scanner: mockScanner });
    await handleScanNow({}, deps);
    expect(mockScanner.scan).toHaveBeenCalled();
  });
});
```

**Step 2: Implement**

- Add `"scan_now"` to `IncomingMessageType` and `VALID_MESSAGE_TYPES`
- Add `| { type: "scan_result"; discovered: number[]; lost: number[] }` to `RelayMessage`
- Handler calls `deps.scanner.scan()` and broadcasts updated instance list
- Update handler list in `message-handlers.test.ts` and `ws-router.pbt.test.ts`

**Step 3: Run tests, commit**

```
feat: add scan_now WS message to trigger immediate port scan
```

---

### Task 5: `instance_rename` WS Message Handler

**Files:**
- Modify: `src/lib/server/ws-router.ts` — add `instance_rename`
- Modify: `src/lib/handlers/instance.ts` — add rename handler
- Modify: `src/lib/handlers/payloads.ts` — add rename payload
- Add tests

**Note:** Instance renaming already works via `instanceManager.updateInstance(id, { name })`. This task just adds a dedicated WS message type for it (cleaner than reusing `instance_update` which also handles env/port changes).

**Step 1: Write failing test**

```typescript
describe("handleInstanceRename", () => {
  it("renames an existing instance", async () => {
    const deps = createMockHandlerDeps();
    deps.instanceManager.addInstance("inst-1", { name: "old", port: 4098, managed: false });
    await handleInstanceRename({ instanceId: "inst-1", name: "work" }, deps);
    expect(deps.instanceManager.getInstance("inst-1")?.name).toBe("work");
  });

  it("rejects empty name", async () => {
    const deps = createMockHandlerDeps();
    await handleInstanceRename({ instanceId: "inst-1", name: "" }, deps);
    // Should send error message
  });
});
```

**Step 2: Implement handler + wire into ws-router**

**Step 3: Run tests, commit**

```
feat: add instance_rename WS message for renaming instances
```

---

### Task 6: Replace Smart Form with Getting Started Panel

**Files:**
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte` — major refactor

**This is the largest UI task. Key changes:**

1. **Remove:** Preset bar, create form, edit form, env editor snippet, proxy detection
2. **Remove:** `instance-env.ts` imports and usage (compileEnv, extractStructuredEnv, KNOWN_FLAGS)
3. **Keep:** Instance list with status indicators, start/stop buttons, expand/collapse
4. **Add:** "Getting Started" panel when no instances (three collapsible scenario cards with copyable commands)
5. **Add:** "Scan Now" button in instance list header
6. **Add:** Inline instance name editing (click to edit)
7. **Add:** Instance dropdown for project assignment (in project view, not settings panel)

**Sub-steps:**

**Step 1:** Remove the add form section (L596–797) and replace with Getting Started component
**Step 2:** Remove the edit form section from expanded instances (L424–556)
**Step 3:** Add "Scan Now" button that sends `{ type: "scan_now" }` WS message
**Step 4:** Add inline name editing on instance cards
**Step 5:** Add copy-to-clipboard buttons on terminal commands in Getting Started

**Step 6: Commit**

```
feat: replace smart form with Getting Started guided paths
```

---

### Task 7: Getting Started — CCS Proxy Detection Status

**Files:**
- Keep existing `proxy_detect` WS message (or reuse scanner)
- Modify Getting Started panel to show CCS status

**Step 1:** When Getting Started panel renders, check if CCS proxy is detected on port 8317
**Step 2:** If detected, show green checkmark on the CCS guided path
**Step 3:** If not detected, show neutral state (no error, just no checkmark)

**Step 4: Commit**

```
feat: show CCS detection status in Getting Started panel
```

---

### Task 8: Frontend — Scan Now Button + Instance List Updates

**Files:**
- Modify: `src/lib/frontend/stores/instance.svelte.ts` — handle `scan_result` message
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` — route `scan_result`
- Modify SettingsPanel to add scan button

**Step 1: Write test for ws-dispatch handling scan_result**

**Step 2: Implement**
- Add `scan_result` handler to `ws-dispatch.ts`
- Add `startScan(sendFn)` to instance store (sends `{ type: "scan_now" }`)
- Add scan button to instance list header in SettingsPanel

**Step 3: Commit**

```
feat: wire Scan Now button to frontend with scan_result handling
```

---

### Task 9: Project-to-Instance Dropdown

**Files:**
- Modify project view (ChatLayout.svelte or Header.svelte) — add instance dropdown
- The `set_project_instance` WS message already exists in ws-router.ts

**Step 1:** Find current project instance assignment UI (if any) or add new dropdown
**Step 2:** Render dropdown with all instances + status indicators
**Step 3:** On change, send `{ type: "set_project_instance", instanceId, projectPath }` WS message
**Step 4:** Show current instance name in project header

**Step 5: Commit**

```
feat: add instance selector dropdown in project header
```

---

### Task 10: Cleanup — Remove Unused Smart Form Code

**Files:**
- Remove or simplify: `src/lib/frontend/utils/instance-env.ts` (may still be useful for TUI, keep if so)
- Remove: `proxy_detect` handler if replaced by scanner-based detection
- Remove: Unused form state variables from SettingsPanel
- Update: E2E tests that reference the smart form

**Step 1:** Identify dead code from the form removal
**Step 2:** Remove unused imports, variables, and test assertions
**Step 3:** Update E2E tests to match new UI

**Step 4: Commit**

```
refactor: remove unused smart form code and update E2E tests
```

---

### Task 11: E2E Tests for Auto-Discovery Flow

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts` — update/add E2E tests

**Tests to add:**
1. Getting Started panel shows when no instances are discovered
2. Scan Now button triggers scan and refreshes instance list
3. Instance rename works via inline editing
4. Instance dropdown in project header switches instance assignment
5. Getting Started disappears when instances are discovered

**Step 1:** Write Playwright E2E tests
**Step 2:** Run and verify
**Step 3: Commit**

```
test: add E2E tests for auto-discovery flow and Getting Started panel
```

---

## Implementation Order Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | PortScanner service + tests | None |
| 2 | probeOpenCode health check | None |
| 3 | Integrate scanner into daemon | Tasks 1, 2 |
| 4 | `scan_now` WS message | Task 3 |
| 5 | `instance_rename` WS message | None |
| 6 | Getting Started panel (UI) | None |
| 7 | CCS detection in Getting Started | Task 6 |
| 8 | Scan Now button frontend | Tasks 4, 6 |
| 9 | Project-instance dropdown | None |
| 10 | Cleanup dead code | Tasks 6, 8 |
| 11 | E2E tests | Tasks 6, 8, 9 |

**Parallelizable:** Tasks 1+2 (backend), 5 (backend), 6 (frontend), 9 (frontend) can all start in parallel.
