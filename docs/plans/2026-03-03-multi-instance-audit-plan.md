# Multi-Instance Comprehensive Audit Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Systematically verify the multi-instance feature across coverage, testing, code review, performance, and architecture dimensions — finding and fixing any remaining bugs, gaps, or quality issues.

**Architecture:** The multi-instance feature spans 8 source files and 10 test files. The audit proceeds in phases: automated analysis first (coverage, static checks), then manual code review (resource leaks, state machine, error handling), then new tests (behavioral, integration, fuzz, stress), then architecture review.

**Tech Stack:** TypeScript (strict + noUncheckedIndexedAccess), Vitest, fast-check (PBT), Biome (linting), tabs for indentation.

**Worktree:** `.worktrees/multi-instance` on branch `feature/multi-instance`

---

## Phase 1: Automated Analysis

### Task 1: Install coverage provider and generate coverage report

**Files:**
- Modify: `.worktrees/multi-instance/package.json` (add `@vitest/coverage-v8`)
- Modify: `.worktrees/multi-instance/vitest.config.ts` (add coverage config)

The project has a `test:coverage` script but no coverage provider installed. This task installs one and generates a focused report for the 8 multi-instance source files.

**Step 1: Install the coverage provider**

Run:
```bash
npm install --save-dev @vitest/coverage-v8
```

**Step 2: Add coverage configuration to vitest.config.ts**

Add a `coverage` block inside the `test` config:

```typescript
test: {
  include: ["test/unit/**/*.test.ts", "test/fixture/**/*.test.ts"],
  testTimeout: 10_000,
  hookTimeout: 10_000,
  coverage: {
    provider: "v8",
    include: [
      "src/lib/instance-manager.ts",
      "src/lib/daemon.ts",
      "src/lib/daemon-ipc.ts",
      "src/lib/ipc-protocol.ts",
      "src/lib/client-init.ts",
      "src/lib/config-persistence.ts",
      "src/lib/public/stores/instance.svelte.ts",
      "src/bin/cli-utils.ts",
      "src/bin/cli-core.ts",
      "src/lib/shared-types.ts",
    ],
    reporter: ["text", "json-summary"],
    thresholds: {
      lines: 70,
      branches: 60,
    },
  },
},
```

**Step 3: Run the coverage report**

Run:
```bash
npx vitest run --coverage 2>&1 | tee /tmp/coverage-report.txt
```

**Step 4: Analyze the report**

Read the coverage output. For each file, note:
- Lines below 80% coverage → list the uncovered line ranges
- Branches below 70% coverage → list the uncovered branch conditions
- Any file below 50% → flag as critical gap

Record findings in a structured list for Task 2.

**Step 5: Do NOT commit** — the coverage provider install is a dev tool, not a feature change. We'll commit coverage config only if we decide to keep it permanently.

---

### Task 2: Write tests to close critical coverage gaps

Based on coverage report from Task 1, write tests for the most significant uncovered code paths. These are the **likely** gaps based on code inspection (adjust based on actual report):

**Files:**
- Modify: `test/unit/instance-manager.test.ts`
- Modify: `test/unit/daemon.test.ts`
- Modify: `test/unit/cli.test.ts`
- Modify: `test/unit/client-init.test.ts`

**Likely gap areas (verify against actual coverage report):**

#### 2a. `instance-manager.ts` — likely uncovered paths:
- `startInstance` when instance is already `"healthy"` → should return early
- `startInstance` when instance is already `"starting"` → should return early
- `startInstance` when instance is `"unhealthy"` → should kill old process, clear polling, then spawn
- `stopInstance` on an already-stopped instance → should return early
- `removeInstance` cascading cleanup (cancels pending restart timers, clears restart timestamps)
- `getInstanceUrl` for instance with external URL vs without
- `addInstance` with invalid URL → should throw
- Health poll interval callback when instance disappears mid-poll
- Health poll callback when status transitions from healthy→unhealthy (unhealthy path of poll)
- `handleProcessExit` with `code === 0` (clean exit)
- `handleProcessExit` backoff timer firing after instance was manually stopped
- `defaultSpawner` — the `proc.once("error")` path

For each gap, write a test following this pattern:

```typescript
it("returns early when instance is already healthy", async () => {
	const mgr = new InstanceManager();
	mgr.setSpawner(async (port) => ({ pid: 1, process: createMockProcess() }));
	mgr.setHealthChecker(async () => true);
	mgr.addInstance("test", { name: "Test", port: 3000, managed: true });
	await mgr.startInstance("test");
	expect(mgr.getInstance("test")?.status).toBe("healthy");
	// Second start should return immediately without re-spawning
	const spawnerCalls: number[] = [];
	mgr.setSpawner(async (port) => {
		spawnerCalls.push(port);
		return { pid: 2, process: createMockProcess() };
	});
	await mgr.startInstance("test");
	expect(spawnerCalls).toHaveLength(0); // No spawn call
});
```

**Step 1:** Write the tests (one `describe` block per gap area)
**Step 2:** Run `npx vitest run test/unit/instance-manager.test.ts` — verify all pass
**Step 3:** Re-run coverage to verify improvement
**Step 4:** Commit: `git add <files> && git commit -m "test: close coverage gaps in instance-manager"`

---

### Task 3: Check for circular imports and dead code

**No file modifications — analysis only.**

**Step 1: Check for circular imports**

Run:
```bash
npx madge --circular --extensions ts src/lib/instance-manager.ts src/lib/daemon.ts src/lib/daemon-ipc.ts src/lib/ipc-protocol.ts src/lib/client-init.ts src/lib/config-persistence.ts
```

If `madge` is not installed, use a simpler check:
```bash
# Check what instance-manager imports
grep -n "from " src/lib/instance-manager.ts
# Check what imports instance-manager
grep -rn "from.*instance-manager" src/
# Repeat for each file — look for A→B→A cycles
```

**Step 2: Check for unused exports**

For each multi-instance source file, check that every `export` is imported somewhere:

```bash
# For each exported symbol in instance-manager.ts:
grep -rn "InstanceSpawner" src/ test/
grep -rn "InstanceHealthChecker" src/ test/
grep -rn "InstanceManagerEvents" src/ test/
grep -rn "InstanceManagerOptions" src/ test/
# ... etc for all exports
```

Flag any export that has 0 external references (only self-reference).

**Step 3: Search for TODO/FIXME/HACK**

```bash
grep -rn "TODO\|FIXME\|HACK\|XXX" src/lib/instance-manager.ts src/lib/daemon.ts src/lib/daemon-ipc.ts src/lib/ipc-protocol.ts src/lib/client-init.ts src/bin/cli-utils.ts src/bin/cli-core.ts src/lib/public/stores/instance.svelte.ts
```

**Step 4:** Record findings. No commit for this task (analysis only).

---

## Phase 2: Code Review — Resource Leaks, State Machine, Error Handling

### Task 4: Resource leak audit

**No file modifications initially — analysis then fix.**

Systematically trace every resource allocation in the multi-instance code and verify cleanup.

#### 4a. Timers

Audit all `setInterval` and `setTimeout` calls in `instance-manager.ts`:

| Resource | Created in | Cleaned up in | Verified? |
|----------|-----------|---------------|-----------|
| `healthIntervals` (setInterval) | `startHealthPolling()` L310 | `stopHealthPolling()` L324 | |
| `pendingRestarts` (setTimeout) | `handleProcessExit()` L389 | `cancelPendingRestart()` L330 | |

Verify cleanup paths:
1. **`removeInstance(id)`** — calls `stopInstance(id)` + `cancelPendingRestart(id)` → ✓ both cleared
2. **`stopInstance(id)`** — calls `cancelPendingRestart(id)` + `stopHealthPolling(id)` → ✓ both cleared
3. **`stopAll()`** — iterates and calls `stopInstance()` for each → ✓ clears all
4. **Edge case: what if `handleProcessExit` fires AFTER `removeInstance`?** — `handleProcessExit` checks `const instance = this.instances.get(id); if (!instance) return;` → ✓ safe
5. **Edge case: what if `startInstance` throws after spawning?** — the `catch` block sets status to "stopped" but does NOT call `stopHealthPolling` or kill the process. **POTENTIAL LEAK.** Check: does the spawner promise rejection mean no process was created? If `spawnFn` throws, no process was stored in `this.processes`, so no leak. But if `healthChecker` throws after spawn, the process IS stored. Let's trace:
   - L266: `const { pid, process: proc } = await spawnFn(...)` — if this throws, catch block runs, no process stored → safe
   - L268: `instance.pid = pid; this.processes.set(id, proc);` — process is stored
   - L274: `const healthy = await checkFn(instance.port);` — if THIS throws, catch runs with process stored but not cleaned up → **LEAK: process + exit listener + no health poll cleanup needed (not started yet), but process and exit listener leak**

Record this finding. If confirmed, fix by adding process cleanup to the catch block:

```typescript
} catch (err) {
	// Clean up process if it was stored before the error
	const proc = this.processes.get(id);
	if (proc) {
		proc.removeAllListeners("exit");
		proc.kill("SIGTERM");
		this.processes.delete(id);
	}
	instance.status = "stopped";
	this.emit("status_changed", instance);
	throw err;
}
```

#### 4b. Event listeners

Audit all `.on()` / `.once()` calls:

| Listener | Registered in | Removed in | Verified? |
|----------|-------------- |-----------|-----------|
| `proc.on("exit", ...)` | `startInstance()` L270 | `stopInstance()` L252 `proc.removeAllListeners("exit")` | |
| `this.instanceManager.on("status_changed", ...)` | `Daemon` constructor L166 | Never explicitly removed | |

The daemon's `status_changed` listener on `instanceManager` is registered in the constructor and never removed. Since `InstanceManager` is owned by the `Daemon` and has the same lifetime, this is acceptable (GC will collect both together). **Not a leak.**

Check: does `proc.removeAllListeners("exit")` in `stopInstance` interfere with `startInstance`'s "unhealthy" branch (L242-248)? Both paths call `proc.removeAllListeners("exit")` before `proc.kill()` → ✓ consistent.

#### 4c. Child processes

Every `this.processes.set(id, proc)` must have a corresponding cleanup path:
- `stopInstance` → `proc.kill("SIGTERM")` + `this.processes.delete(id)` → ✓
- `startInstance` unhealthy branch → `oldProc.kill("SIGTERM")` + `this.processes.delete(id)` → ✓
- `handleProcessExit` → `this.processes.delete(id)` → ✓ (process already exited)
- `startInstance` catch block → **Missing** (see 4a finding above)

**Step 1:** Write up findings
**Step 2:** If leak confirmed, fix the catch block in `startInstance`
**Step 3:** Write a test:

```typescript
it("cleans up process if health check throws after spawn", async () => {
	const mgr = new InstanceManager();
	const mockProc = createMockProcess();
	const killSpy = vi.spyOn(mockProc, "kill");
	mgr.setSpawner(async () => ({ pid: 1, process: mockProc }));
	mgr.setHealthChecker(async () => { throw new Error("check failed"); });
	mgr.addInstance("test", { name: "Test", port: 3000, managed: true });
	await expect(mgr.startInstance("test")).rejects.toThrow("check failed");
	expect(killSpy).toHaveBeenCalledWith("SIGTERM");
	expect(mgr.getInstance("test")?.status).toBe("stopped");
});
```

**Step 4:** Run tests, verify pass
**Step 5:** Commit: `git add <files> && git commit -m "fix: clean up leaked process when health check throws in startInstance"`

---

### Task 5: State machine correctness audit

**Files:**
- Create: `test/unit/instance-state-machine.test.ts` (new dedicated test file)

Map out every possible `InstanceStatus` transition and verify each is handled correctly.

#### State machine diagram:

```
                    ┌─────────────┐
     addInstance────►   stopped   ◄────── handleProcessExit(code=0)
                    └──────┬──────┘       handleProcessExit(rate-limited)
                           │              stopInstance()
                    startInstance()
                           │
                    ┌──────▼──────┐
                    │  starting   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
          healthCheck OK   │       handleProcessExit(code≠0)
              │            │            │
       ┌──────▼──────┐    │     ┌──────▼──────┐
       │   healthy    │    │     │  unhealthy  │
       └──────┬──────┘    │     └──────┬──────┘
              │            │            │
       healthPoll fail     │     backoff timer
              │            │            │
       ┌──────▼──────┐    │     ┌──────▼──────┐
       │  unhealthy  ├────┘     │   stopped   │──► startInstance()
       └─────────────┘          └─────────────┘
```

#### Transitions to test:

| # | From | Event | To | Tested? |
|---|------|-------|----|---------|
| 1 | (none) | `addInstance()` | `stopped` | ✓ (instance-types.test.ts) |
| 2 | `stopped` | `startInstance()` | `starting` | ✓ (instance-manager.test.ts) |
| 3 | `starting` | health check passes | `healthy` | ✓ |
| 4 | `starting` | health check fails | stays `starting`, poll starts | Partially |
| 5 | `starting` | process exits (code≠0) | `unhealthy` → backoff → `stopped` → restart | ✓ |
| 6 | `starting` | process exits (code=0) | `stopped` | ? |
| 7 | `starting` | `stopInstance()` | `stopped` | ? |
| 8 | `healthy` | `stopInstance()` | `stopped` | ✓ |
| 9 | `healthy` | health poll fails | `unhealthy` | ? |
| 10 | `healthy` | process exits (code≠0) | `unhealthy` → backoff | ✓ |
| 11 | `healthy` | process exits (code=0) | `stopped` | ? |
| 12 | `healthy` | `removeInstance()` | (removed) | ✓ |
| 13 | `unhealthy` | backoff timer fires | `stopped` → `starting` | ✓ |
| 14 | `unhealthy` | `stopInstance()` | `stopped` | ? |
| 15 | `unhealthy` | rate limit hit | `stopped` + error event | ✓ |
| 16 | `unhealthy` | `startInstance()` | kills old, `starting` | ? |
| 17 | `stopped` | `startInstance()` (second time) | `starting` | ? |
| 18 | `stopped` | `removeInstance()` | (removed) | ✓ |
| 19 | `starting` | `startInstance()` again | returns early | ? |
| 20 | `healthy` | `startInstance()` again | returns early | ? |

**Step 1:** Create `test/unit/instance-state-machine.test.ts` with a test for each transition marked `?` above.

For each transition, the test pattern is:
```typescript
it("transition: healthy → stopInstance → stopped", () => {
	// Setup: get instance to 'healthy' state
	const mgr = new InstanceManager({ healthPollIntervalMs: 999_999 });
	mgr.setSpawner(async (port) => ({ pid: 1, process: createMockProcess() }));
	mgr.setHealthChecker(async () => true);
	mgr.addInstance("t", { name: "T", port: 3000, managed: true });
	await mgr.startInstance("t");
	expect(mgr.getInstance("t")?.status).toBe("healthy");

	// Act
	const events: string[] = [];
	mgr.on("status_changed", (i) => events.push(i.status));
	mgr.stopInstance("t");

	// Assert
	expect(mgr.getInstance("t")?.status).toBe("stopped");
	expect(events).toEqual(["stopped"]);
});
```

**Step 2:** Run tests: `npx vitest run test/unit/instance-state-machine.test.ts`
**Step 3:** Fix any failing tests (indicates a bug in the state machine)
**Step 4:** Commit: `git add test/unit/instance-state-machine.test.ts && git commit -m "test: comprehensive state machine transition coverage"`

---

### Task 6: Error handling audit

**No file modifications initially — analysis then fix.**

Trace every `throw` and `catch` in multi-instance code. For each:
1. Is the error caught somewhere?
2. Is the error message user-friendly (not a raw stack trace)?
3. Does the error leave state in a consistent condition?

#### 6a. `instance-manager.ts` throws:

| Location | Throw condition | Caught where? | User-friendly? |
|----------|----------------|---------------|----------------|
| `addInstance` | Duplicate ID | `daemon-ipc.ts` `instanceAdd` catch | ✓ |
| `addInstance` | Max instances | `daemon-ipc.ts` `instanceAdd` catch | ✓ |
| `addInstance` | Invalid URL | `daemon-ipc.ts` `instanceAdd` catch | ✓ |
| `removeInstance` | Not found | `daemon-ipc.ts` `instanceRemove` catch | ✓ |
| `startInstance` | Not found | `daemon-ipc.ts` `instanceStart` catch | ✓ |
| `startInstance` | Not managed | `daemon-ipc.ts` `instanceStart` catch | ✓ |
| `startInstance` | Spawn fails | `daemon-ipc.ts` `instanceStart` catch | ✓ |
| `stopInstance` | Not found | `daemon-ipc.ts` `instanceStop` catch | ✓ |
| `getInstanceUrl` | Not found | `daemon.ts` `getProjectOpencodeUrl` catch → returns null | ✓ |

#### 6b. `daemon.ts` error paths:

| Location | Error condition | Handling |
|----------|----------------|---------|
| `start()` rehydration | `addInstance` throws (maxInstances) | `console.warn` + continue | ✓ |
| `start()` push manager | `init()` throws | `console.warn` + null | ✓ |
| `addProject` relay creation | `createProjectRelay` throws | `console.error` + continue | ✓ |
| `stop()` relay stop | `relay.stop()` throws | caught + ignored | ✓ |

#### 6c. `ipc-protocol.ts` validation:

Check that every IPC command has proper validation before reaching handlers:
- `instance_add`: validates `name` (non-empty string), `managed` (boolean), `port` (valid range for managed), URL (valid format for unmanaged), rejects url+managed, requires url-or-port for unmanaged → ✓ comprehensive
- `instance_remove/start/stop/status`: validates `id` (non-empty string) → ✓

**Potential issue:** `instance_add` with `managed: false, port: 0` — is port 0 valid? `validateCommand` checks `port > 0` for managed, and for unmanaged requires `url` or valid port. Port 0 (`<= 0`) without URL would fail validation. **But** `daemon-ipc.ts` `instanceAdd` defaults port to `port ?? 0` — if someone passes `managed: false, url: "http://..."` without port, the instance gets `port: 0`. Is this okay? Yes — `getInstanceUrl` will return the external URL, not `http://localhost:0`. **But** the `OpenCodeInstance` type has `port: number` (required). A port of 0 is technically valid (means "OS-assigned") but semantically odd for an unmanaged instance. **Minor issue — document or validate.**

**Step 1:** Write up findings
**Step 2:** If the port-0-for-unmanaged issue is deemed worth fixing, add a comment or default to a sentinel. Otherwise note as accepted behavior.
**Step 3:** No commit unless a fix is needed.

---

## Phase 3: Behavioral & Integration Testing

### Task 7: IPC round-trip fuzz testing

**Files:**
- Modify: `test/unit/ipc-protocol.pbt.test.ts`

Use fast-check to generate malformed/unexpected IPC commands and verify the system handles them gracefully (returns error responses, never crashes).

**Step 1:** Add fuzz tests:

```typescript
import fc from "fast-check";
import { parseCommand, validateCommand, createCommandRouter } from "@/lib/ipc-protocol.js";

describe("IPC fuzz testing", () => {
	it("parseCommand never throws on arbitrary strings", () => {
		fc.assert(
			fc.property(fc.string(), (raw) => {
				const result = parseCommand(raw);
				// Should return IPCCommand or null, never throw
				expect(result === null || typeof result === "object").toBe(true);
			}),
			{ numRuns: 1000 },
		);
	});

	it("validateCommand never throws on arbitrary objects", () => {
		fc.assert(
			fc.property(
				fc.record({
					cmd: fc.oneof(fc.string(), fc.constant(undefined)),
					name: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
					port: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined), fc.constant(-1), fc.constant(0), fc.constant(99999)),
					managed: fc.oneof(fc.boolean(), fc.string(), fc.constant(undefined)),
					id: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
					url: fc.oneof(fc.string(), fc.constant(undefined)),
				}),
				(obj) => {
					const result = validateCommand(obj as any);
					// Should return null (valid) or an error response, never throw
					expect(result === null || (typeof result === "object" && "ok" in result)).toBe(true);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("command router returns error responses for malformed commands, never throws", async () => {
		// Create a router with stub handlers that should never be called for invalid commands
		const handlers = {
			// ... all handlers throwing to verify they're not reached
		};
		const router = createCommandRouter(handlers as any);

		await fc.assert(
			fc.asyncProperty(
				fc.record({
					cmd: fc.constantFrom(...VALID_COMMANDS, "invalid_cmd", ""),
					// Random fields
					name: fc.oneof(fc.string(), fc.constant(undefined)),
					port: fc.oneof(fc.integer(), fc.constant(undefined)),
					managed: fc.oneof(fc.boolean(), fc.constant(undefined)),
				}),
				async (obj) => {
					const result = await router(obj as any);
					expect(result).toHaveProperty("ok");
				},
			),
			{ numRuns: 500 },
		);
	});
});
```

**Step 2:** Run: `npx vitest run test/unit/ipc-protocol.pbt.test.ts`
**Step 3:** Fix any failures
**Step 4:** Commit: `git add test/unit/ipc-protocol.pbt.test.ts && git commit -m "test: IPC round-trip fuzz testing with fast-check"`

---

### Task 8: WebSocket message contract testing

**Files:**
- Modify: `test/unit/ws-message-dispatch.test.ts`

Verify that `instance_list` and `instance_status` messages have the exact shape expected by the frontend store.

**Step 1:** Add contract-style tests:

```typescript
describe("instance WS message contracts", () => {
	it("instance_list message matches store handler expectation", () => {
		const msg = {
			type: "instance_list" as const,
			instances: [
				{
					id: "test",
					name: "Test",
					port: 3000,
					managed: true,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		};
		// Verify the message is accepted by handleInstanceList
		handleInstanceList(msg);
		expect(instanceState.instances).toHaveLength(1);
		expect(instanceState.instances[0]).toMatchObject({
			id: "test",
			name: "Test",
			status: "healthy",
		});
	});

	it("instance_status message updates the correct instance", () => {
		// Pre-populate
		instanceState.instances = [
			{ id: "a", name: "A", port: 1, managed: true, status: "healthy", restartCount: 0, createdAt: 1 },
			{ id: "b", name: "B", port: 2, managed: true, status: "stopped", restartCount: 0, createdAt: 2 },
		];
		const msg = {
			type: "instance_status" as const,
			instanceId: "b",
			status: "starting" as const,
		};
		handleInstanceStatus(msg);
		expect(instanceState.instances.find(i => i.id === "b")?.status).toBe("starting");
		expect(instanceState.instances.find(i => i.id === "a")?.status).toBe("healthy"); // unchanged
	});

	it("instance_status for unknown instance is a no-op", () => {
		instanceState.instances = [
			{ id: "a", name: "A", port: 1, managed: true, status: "healthy", restartCount: 0, createdAt: 1 },
		];
		handleInstanceStatus({
			type: "instance_status" as const,
			instanceId: "nonexistent",
			status: "stopped" as const,
		});
		expect(instanceState.instances).toHaveLength(1);
		expect(instanceState.instances[0]?.status).toBe("healthy");
	});
});
```

**Step 2:** Run: `npx vitest run test/unit/ws-message-dispatch.test.ts`
**Step 3:** Fix any failures
**Step 4:** Commit: `git add test/unit/ws-message-dispatch.test.ts && git commit -m "test: WebSocket message contract tests for instance_list and instance_status"`

---

### Task 9: Concurrency stress test

**Files:**
- Create: `test/unit/instance-concurrency.test.ts`

Test rapid parallel operations to surface race conditions.

**Step 1:** Create the stress test file:

```typescript
import { describe, expect, it, vi } from "vitest";
import { InstanceManager } from "@/lib/instance-manager.js";

function createMockProcess() {
	// ... standard mock process factory
}

describe("InstanceManager concurrency", () => {
	it("survives rapid add/remove cycles without orphaned state", async () => {
		const mgr = new InstanceManager({ maxInstances: 100 });
		const ops: Promise<void>[] = [];

		for (let i = 0; i < 50; i++) {
			ops.push(
				(async () => {
					const id = `inst-${i}`;
					mgr.addInstance(id, { name: `I${i}`, port: 3000 + i, managed: true });
					mgr.removeInstance(id);
				})(),
			);
		}

		await Promise.all(ops);
		expect(mgr.getInstances()).toHaveLength(0);
	});

	it("survives rapid start/stop cycles on the same instance", async () => {
		const mgr = new InstanceManager({ healthPollIntervalMs: 999_999 });
		mgr.setSpawner(async (port) => ({ pid: 1, process: createMockProcess() }));
		mgr.setHealthChecker(async () => true);
		mgr.addInstance("rapid", { name: "Rapid", port: 3000, managed: true });

		for (let i = 0; i < 10; i++) {
			await mgr.startInstance("rapid");
			mgr.stopInstance("rapid");
		}

		expect(mgr.getInstance("rapid")?.status).toBe("stopped");
	});

	it("concurrent startInstance calls don't double-spawn", async () => {
		const mgr = new InstanceManager({ healthPollIntervalMs: 999_999 });
		let spawnCount = 0;
		mgr.setSpawner(async (port) => {
			spawnCount++;
			await new Promise((r) => setTimeout(r, 10)); // simulate delay
			return { pid: spawnCount, process: createMockProcess() };
		});
		mgr.setHealthChecker(async () => true);
		mgr.addInstance("dup", { name: "Dup", port: 3000, managed: true });

		// Two concurrent starts
		await Promise.all([
			mgr.startInstance("dup"),
			mgr.startInstance("dup"),
		]);

		// The second call should have returned early (status was "starting")
		// But note: there's a potential race — the first call sets status to "starting"
		// synchronously, so the second call sees "starting" and returns early.
		// This test verifies that assumption.
		expect(spawnCount).toBe(1);
	});

	it("adding instances up to maxInstances works, one more throws", () => {
		const mgr = new InstanceManager({ maxInstances: 3 });
		mgr.addInstance("a", { name: "A", port: 3001, managed: true });
		mgr.addInstance("b", { name: "B", port: 3002, managed: true });
		mgr.addInstance("c", { name: "C", port: 3003, managed: true });
		expect(() =>
			mgr.addInstance("d", { name: "D", port: 3004, managed: true }),
		).toThrow("Max instances reached (3)");
	});
});
```

**Step 2:** Run: `npx vitest run test/unit/instance-concurrency.test.ts`
**Step 3:** Fix any failures (they indicate real race conditions)
**Step 4:** Commit: `git add test/unit/instance-concurrency.test.ts && git commit -m "test: concurrency stress tests for InstanceManager"`

---

### Task 10: Test isolation audit

**No file modifications — analysis only.**

Check whether any instance-related test files share mutable state or depend on execution order.

**Step 1:** Run each test file in isolation:

```bash
npx vitest run test/unit/instance-manager.test.ts --reporter=verbose
npx vitest run test/unit/instance-types.test.ts --reporter=verbose
npx vitest run test/unit/instance-lifecycle.test.ts --reporter=verbose
npx vitest run test/unit/svelte-instance-store.test.ts --reporter=verbose
npx vitest run test/unit/daemon-ipc.test.ts --reporter=verbose
npx vitest run test/unit/ws-message-dispatch.test.ts --reporter=verbose
npx vitest run test/unit/client-init.test.ts --reporter=verbose
npx vitest run test/unit/daemon.test.ts --reporter=verbose
npx vitest run test/unit/cli.test.ts --reporter=verbose
npx vitest run test/unit/ipc-protocol.pbt.test.ts --reporter=verbose
```

All should pass when run individually.

**Step 2:** Check for shared mutable state. Look for:
- Global `let` / `const` objects modified in tests without `beforeEach` reset
- `instanceState` (the Svelte store) — is it reset between tests via `clearInstanceState()`?
- `vi.useFakeTimers()` without `vi.useRealTimers()` in `afterEach`

```bash
grep -n "instanceState" test/unit/svelte-instance-store.test.ts
grep -n "beforeEach\|afterEach\|clearInstanceState" test/unit/svelte-instance-store.test.ts
```

**Step 3:** Run tests in reverse order to catch order-dependent failures:

```bash
# Run the full suite twice — once normally, once with shuffle
npx vitest run test/unit/instance-*.test.ts --sequence.shuffle
```

**Step 4:** Record findings. If isolation issues found, fix with `beforeEach`/`afterEach` cleanup.

---

## Phase 4: Performance & Scalability

### Task 11: Health check overhead test

**Files:**
- Create: `test/unit/instance-performance.test.ts`

Test behavior with many instances to verify health polling doesn't create excessive resource usage.

**Step 1:** Create performance test:

```typescript
describe("InstanceManager performance", () => {
	it("handles 50 instances without excessive timer accumulation", async () => {
		const mgr = new InstanceManager({
			maxInstances: 50,
			healthPollIntervalMs: 60_000, // Long interval to avoid actual polling
		});
		mgr.setSpawner(async (port) => ({ pid: port, process: createMockProcess() }));
		mgr.setHealthChecker(async () => true);

		// Add and start 50 instances
		for (let i = 0; i < 50; i++) {
			mgr.addInstance(`i${i}`, { name: `I${i}`, port: 3000 + i, managed: true });
			await mgr.startInstance(`i${i}`);
		}

		expect(mgr.getInstances()).toHaveLength(50);
		expect(mgr.getInstances().every(i => i.status === "healthy")).toBe(true);

		// Stop all — verify all timers cleaned up
		mgr.stopAll();
		expect(mgr.getInstances().every(i => i.status === "stopped")).toBe(true);
		// Access private healthIntervals via reflection to verify cleanup
		// (or verify by checking no timers leak via vi.getTimerCount if using fake timers)
	});

	it("saveDaemonConfig handles large instance lists", () => {
		// Build a config with 50 instances
		const instances = Array.from({ length: 50 }, (_, i) => ({
			id: `inst-${i}`,
			name: `Instance ${i}`,
			port: 3000 + i,
			managed: true,
		}));

		const config = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances,
		};

		// saveDaemonConfig should not throw or be excessively slow
		const start = performance.now();
		saveDaemonConfig(config, tmpDir);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(100); // Should be well under 100ms
	});
});
```

**Step 2:** Run: `npx vitest run test/unit/instance-performance.test.ts`
**Step 3:** Commit: `git add test/unit/instance-performance.test.ts && git commit -m "test: performance tests for instance scaling"`

---

### Task 12: Startup rehydration blocking test

**Files:**
- Modify: `test/unit/daemon.test.ts`

Verify that rehydrating many instances doesn't block daemon startup excessively.

**Step 1:** Add test:

```typescript
it("rehydrating 20 instances during start() completes promptly", async () => {
	// Pre-seed config with 20 instances
	const instances = Array.from({ length: 20 }, (_, i) => ({
		id: `inst-${i}`,
		name: `Instance ${i}`,
		port: 3000 + i,
		managed: false,
		url: `http://host${i}:${3000 + i}`,
	}));

	saveDaemonConfig(
		{
			pid: 1, port: 2633, pinHash: null, tls: false,
			debug: false, keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [], instances,
		},
		tmpDir,
	);

	const daemon = new Daemon({ configDir: tmpDir, port: 0, socketPath: tmpSock });
	const start = performance.now();
	await daemon.start();
	const elapsed = performance.now() - start;

	expect(daemon.getInstances()).toHaveLength(20);
	expect(elapsed).toBeLessThan(5000); // Should complete well within 5s

	await daemon.stop();
});
```

**Step 2:** Run: `npx vitest run test/unit/daemon.test.ts`
**Step 3:** Commit if new tests added.

---

## Phase 5: Architecture Review

### Task 13: Separation of concerns and dependency direction audit

**No file modifications — analysis only.**

#### 13a. Dependency graph (should be top→down, never circular)

Expected dependency direction:
```
CLI layer (cli-utils.ts, cli-core.ts)
    ↓
Daemon layer (daemon.ts, daemon-ipc.ts)
    ↓
Core layer (instance-manager.ts, ipc-protocol.ts, config-persistence.ts)
    ↓
Types layer (shared-types.ts, types.ts)

Frontend layer (instance.svelte.ts) → types only
```

Verify:
1. `instance-manager.ts` should NOT import from `daemon.ts`, `daemon-ipc.ts`, `cli-*.ts`
2. `ipc-protocol.ts` should NOT import from `daemon.ts`, `daemon-ipc.ts`
3. `config-persistence.ts` should NOT import from `daemon.ts`
4. `daemon-ipc.ts` should NOT import from `cli-*.ts`
5. `instance.svelte.ts` should only import types

```bash
grep "from " src/lib/instance-manager.ts
grep "from " src/lib/ipc-protocol.ts
grep "from " src/lib/config-persistence.ts
grep "from " src/lib/daemon-ipc.ts
grep "from " src/lib/public/stores/instance.svelte.ts
```

#### 13b. Single responsibility check

For each file, assess whether it has a single clear responsibility:

| File | Responsibility | Assessment |
|------|---------------|------------|
| `instance-manager.ts` | Instance CRUD + lifecycle + health + crash recovery | Arguably too many responsibilities — but they're all tightly coupled around instance lifecycle. Acceptable for now. |
| `daemon.ts` | Daemon orchestration | Large file (1033 lines) but it's the composition root — expected to be large. |
| `daemon-ipc.ts` | IPC handler construction | Clean. Single purpose. |
| `ipc-protocol.ts` | Command parsing, validation, routing, slug generation | Slug generation could be extracted, but it's small. Acceptable. |
| `client-init.ts` | Client connection init handler | Clean. |
| `cli-utils.ts` | Arg parsing + IPC client + formatting | Multiple utilities, but they're all CLI concerns. Acceptable. |
| `instance.svelte.ts` | Frontend instance store | Clean and minimal. |
| `config-persistence.ts` | Config file I/O | Clean. |

#### 13c. Extensibility assessment

"Could someone add a new instance type or status without touching 15 files?"

**Adding a new InstanceStatus (e.g., "paused"):**
1. `shared-types.ts` — add to union type ✓ (1 file)
2. `instance-manager.ts` — add transition logic (1 file)
3. `instance.svelte.ts` — add color mapping (1 file)
4. Tests — add coverage (N test files)

**Total: 3 source files + tests.** This is reasonable extensibility.

**Adding a new instance type (e.g., "docker"):**
1. `shared-types.ts` — add to InstanceConfig (1 file)
2. `instance-manager.ts` — add spawning logic (1 file)
3. `daemon-ipc.ts` — thread new config fields (1 file)
4. `ipc-protocol.ts` — add validation (1 file)
5. `cli-utils.ts` — add CLI flag (1 file)
6. `cli-core.ts` — thread to IPC command (1 file)

**Total: 6 source files.** Acceptable — each layer needs minimal changes.

**Step 1:** Run the dependency checks above
**Step 2:** Write up findings
**Step 3:** No commit (analysis only)

---

### Task 14: Backward compatibility verification

**No new files — run existing tests and verify manually.**

**Step 1:** Run the full existing test suite:

```bash
npx vitest run
```

All 2286+ tests must pass.

**Step 2:** Verify single-instance (no `--instance` flag) behavior:

Check that `Daemon` created without `opencodeUrl` has zero instances:
```typescript
// Already tested, but verify:
const daemon = new Daemon({ port: 0, configDir: tmpDir, socketPath: tmpSock });
expect(daemon.getInstances()).toHaveLength(0);
```

Check that `Daemon` created WITH `opencodeUrl` creates exactly one "default" instance:
```typescript
const daemon = new Daemon({ port: 0, configDir: tmpDir, socketPath: tmpSock, opencodeUrl: "http://localhost:4096" });
expect(daemon.getInstances()).toHaveLength(1);
expect(daemon.getInstances()[0]?.id).toBe("default");
```

**Step 3:** Verify CLI without `--instance` flag works normally:

```typescript
const args = parseArgs(["--port", "3000"]);
expect(args.command).toBe("default"); // NOT "instance"
expect(args.port).toBe(3000);
expect(args.instanceAction).toBeUndefined();
```

**Step 4:** Run typecheck: `npx tsc --noEmit`
**Step 5:** Run linter: `npx biome check .`

---

### Task 15: Final coverage report and gap analysis

**Step 1:** Re-run coverage with all new tests:

```bash
npx vitest run --coverage
```

**Step 2:** Compare with Task 1 baseline. Document improvement.

**Step 3:** For any remaining gaps below 70% line coverage, document why they're acceptable (e.g., `defaultSpawner` spawns real processes, `defaultHealthChecker` makes HTTP calls — these are integration-tested, not unit-tested).

**Step 4:** Write a summary of all findings from the entire audit:
- Bugs found and fixed
- Coverage before/after
- Resource leaks found and fixed
- State machine gaps found and tested
- Performance characteristics
- Architecture assessment

---

## Summary of Expected Deliverables

| Phase | Tasks | Expected Commits |
|-------|-------|-----------------|
| Phase 1: Automated Analysis | Tasks 1-3 | 1-2 commits (coverage gaps, analysis) |
| Phase 2: Code Review | Tasks 4-6 | 1-2 commits (resource leak fix, state machine tests) |
| Phase 3: Behavioral Testing | Tasks 7-10 | 2-3 commits (fuzz, contract, concurrency tests) |
| Phase 4: Performance | Tasks 11-12 | 1 commit (performance tests) |
| Phase 5: Architecture | Tasks 13-15 | 0 commits (analysis only) + final report |

**Total: 15 tasks, ~5-8 commits, comprehensive audit coverage.**
