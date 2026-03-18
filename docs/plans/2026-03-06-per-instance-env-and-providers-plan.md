# Per-Instance Environment Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable per-instance XDG_DATA_HOME and env var configuration so each OpenCode instance can have separate auth and provider config, with a smart Default instance that auto-detects managed vs unmanaged mode.

**Architecture:** Extend the existing `env` field (already in types, persistence, and spawning) through the UI and add `instance_update` support. Add smart default detection in `Daemon.start()`. Make health checks per-instance-auth-aware.

**Tech Stack:** TypeScript, Svelte 5 (runes), Playwright E2E tests, Vitest unit tests

---

### Task 1: Add `needsRestart` to `OpenCodeInstance` and `instance_update` to `RelayMessage`

**Files:**
- Modify: `src/lib/shared-types.ts:278-290` (OpenCodeInstance)
- Modify: `src/lib/shared-types.ts:266-272` (RelayMessage union)

**Step 1: Add `needsRestart` field to `OpenCodeInstance`**

In `src/lib/shared-types.ts`, add `needsRestart?: boolean` to the `OpenCodeInstance` interface after the `env` field (line ~286):

```typescript
export interface OpenCodeInstance {
	id: string;
	name: string;
	port: number;
	managed: boolean;
	status: InstanceStatus;
	pid?: number;
	env?: Record<string, string>;
	needsRestart?: boolean;        // ← NEW
	exitCode?: number;
	lastHealthCheck?: number;
	restartCount: number;
	createdAt: number;
}
```

**Step 2: Add `instance_update` to `RelayMessage` union**

After the existing instance messages (line ~272), add:

```typescript
	| { type: "instance_update"; instanceId: string; name?: string; env?: Record<string, string>; port?: number }
```

**Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

**Step 4: Commit**

```
feat: add needsRestart field and instance_update message type
```

---

### Task 2: Add `updateInstance()` to InstanceManager

**Files:**
- Modify: `src/lib/instance-manager.ts` (add method after `removeInstance` at ~line 178)
- Test: `test/unit/instance-manager.test.ts`

**Step 1: Write failing tests for `updateInstance`**

Add a new `describe("updateInstance")` block after the `removeInstance` describe (~line 204). Tests:

```typescript
describe("updateInstance", () => {
	it("updates instance name", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		im.updateInstance("test-1", { name: "Renamed" });
		expect(im.getInstance("test-1")?.name).toBe("Renamed");
	});

	it("updates instance env", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		im.updateInstance("test-1", { env: { XDG_DATA_HOME: "/custom/path" } });
		expect(im.getInstance("test-1")?.env).toEqual({ XDG_DATA_HOME: "/custom/path" });
	});

	it("updates instance port", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		im.updateInstance("test-1", { port: 6000 });
		expect(im.getInstance("test-1")?.port).toBe(6000);
	});

	it("throws for unknown instance", () => {
		const im = new InstanceManager();
		expect(() => im.updateInstance("nope", { name: "X" })).toThrow();
	});

	it("sets needsRestart when env changes on running instance", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		// Simulate running state
		const inst = im.getInstance("test-1")!;
		(inst as any).status = "healthy";
		im.updateInstance("test-1", { env: { FOO: "bar" } });
		expect(im.getInstance("test-1")?.needsRestart).toBe(true);
	});

	it("does not set needsRestart when instance is stopped", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		im.updateInstance("test-1", { env: { FOO: "bar" } });
		expect(im.getInstance("test-1")?.needsRestart).toBeFalsy();
	});

	it("clears needsRestart on stopInstance", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		const inst = im.getInstance("test-1")!;
		(inst as any).status = "healthy";
		(inst as any).needsRestart = true;
		im.stopInstance("test-1");
		expect(im.getInstance("test-1")?.needsRestart).toBeFalsy();
	});

	it("emits status_changed when needsRestart set", () => {
		const im = new InstanceManager();
		im.addInstance("test-1", { name: "Test", port: 5000, managed: true });
		const inst = im.getInstance("test-1")!;
		(inst as any).status = "healthy";
		const events: any[] = [];
		im.on("status_changed", (i) => events.push(i));
		im.updateInstance("test-1", { env: { FOO: "bar" } });
		expect(events).toHaveLength(1);
		expect(events[0].needsRestart).toBe(true);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/instance-manager.test.ts`
Expected: New tests FAIL (updateInstance not defined)

**Step 3: Implement `updateInstance`**

Add to `InstanceManager` after `removeInstance()` (~line 178):

```typescript
/**
 * Updates a registered instance's configuration.
 * Only name, env, and port can be updated.
 * Sets needsRestart=true if env or port changes while instance is running.
 */
updateInstance(
	id: string,
	updates: { name?: string; env?: Record<string, string>; port?: number },
): OpenCodeInstance {
	const instance = this.instances.get(id);
	if (!instance) throw new Error(`Instance "${id}" not found`);

	const isRunning = instance.status === "healthy" || instance.status === "starting";
	let changed = false;

	if (updates.name !== undefined && updates.name !== instance.name) {
		instance.name = updates.name;
		changed = true;
	}
	if (updates.port !== undefined && updates.port !== instance.port) {
		instance.port = updates.port;
		changed = true;
		if (isRunning) instance.needsRestart = true;
	}
	if (updates.env !== undefined) {
		const oldEnv = JSON.stringify(instance.env ?? {});
		const newEnv = JSON.stringify(updates.env);
		if (oldEnv !== newEnv) {
			instance.env = { ...updates.env };
			changed = true;
			if (isRunning) instance.needsRestart = true;
		}
	}

	if (changed) {
		this.emit("status_changed", instance);
	}

	return instance;
}
```

Also clear `needsRestart` in `stopInstance()` (around line ~335, after setting status to "stopped"):

```typescript
instance.needsRestart = false;
```

And clear it in `startInstance()` (around line ~240, after setting status to "starting"):

```typescript
instance.needsRestart = false;
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/instance-manager.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```
feat: add updateInstance() with needsRestart tracking
```

---

### Task 3: Add `handleInstanceUpdate` WS handler

**Files:**
- Modify: `src/lib/handlers/instance.ts` (add handler after `handleInstanceStop`, ~line 161)
- Modify: `src/lib/handlers/types.ts` (add to deps if needed)
- Modify: wherever WS message routing happens (check `src/lib/ws-handler.ts` or `src/lib/relay-stack.ts` for the message switch/dispatch)

**Step 1: Add `handleInstanceUpdate` function**

In `src/lib/handlers/instance.ts`, after `handleInstanceStop` (~line 161):

```typescript
export function handleInstanceUpdate(
	payload: Record<string, unknown>,
	deps: InstanceHandlerDeps,
): void {
	const instanceId = payload.instanceId as string | undefined;
	if (!instanceId) {
		sendError(deps, "instance_update requires instanceId");
		return;
	}

	if (!deps.updateInstance) {
		sendError(deps, "Instance update not supported");
		return;
	}

	const updates: { name?: string; env?: Record<string, string>; port?: number } = {};
	if (typeof payload.name === "string") updates.name = payload.name;
	if (typeof payload.port === "number") updates.port = payload.port;
	if (payload.env !== undefined && typeof payload.env === "object" && !Array.isArray(payload.env)) {
		updates.env = payload.env as Record<string, string>;
	}

	try {
		deps.updateInstance(instanceId, updates);
		broadcastInstanceList(deps);
		deps.persistConfig?.();
	} catch (err: unknown) {
		sendError(deps, `Failed to update instance: ${(err as Error).message}`);
	}
}
```

**Step 2: Add `updateInstance` to handler deps type**

Check `src/lib/handlers/types.ts` for `InstanceHandlerDeps` (or the deps type used by instance handlers). Add:

```typescript
updateInstance?: (id: string, updates: { name?: string; env?: Record<string, string>; port?: number }) => OpenCodeInstance;
```

**Step 3: Wire the handler in the message dispatch**

Find where `instance_add`, `instance_start`, etc. are dispatched (likely in `src/lib/relay-stack.ts` or `src/lib/ws-handler.ts`). Add `instance_update` → `handleInstanceUpdate` alongside the existing instance handlers.

Also wire `updateInstance` in the deps object where `addInstance`, `removeInstance`, etc. are passed (in `src/lib/daemon.ts`, look for `getInstances: () => this.getInstances()` patterns around lines 391 and 636).

**Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 5: Commit**

```
feat: add instance_update WS handler
```

---

### Task 4: Add `instanceUpdate` IPC command

**Files:**
- Modify: `src/lib/daemon-ipc.ts:59-87` (IPCHandlerMap)
- Modify: `src/lib/daemon-ipc.ts:97-254` (buildIPCHandlers)

**Step 1: Add type to `IPCHandlerMap`**

After `instanceStop` (line ~85):

```typescript
instanceUpdate: { instanceId: string; name?: string; env?: Record<string, string>; port?: number };
```

**Step 2: Add handler in `buildIPCHandlers`**

After the `instanceStop` handler (line ~246):

```typescript
instanceUpdate: async (params): Promise<IPCResponse> => {
	const { instanceId, ...updates } = params;
	if (!instanceId) return { ok: false, error: "instanceId required" };
	try {
		ctx.updateInstance(instanceId, updates);
		ctx.saveConfig();
		return { ok: true };
	} catch (err: unknown) {
		return { ok: false, error: (err as Error).message };
	}
},
```

**Step 3: Add `updateInstance` to `DaemonIPCContext`**

In `DaemonIPCContext` interface (line ~42-53), add:

```typescript
updateInstance(id: string, updates: { name?: string; env?: Record<string, string>; port?: number }): OpenCodeInstance;
```

**Step 4: Wire in Daemon**

In `src/lib/daemon.ts`, where the IPC context is built (search for `getInstances:` near lines 972-978), add:

```typescript
updateInstance: (id, updates) => this.instanceManager.updateInstance(id, updates),
```

**Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 6: Commit**

```
feat: add instanceUpdate IPC command
```

---

### Task 5: Per-instance health check auth

**Files:**
- Modify: `src/lib/daemon.ts:173-190` (health checker injection)
- Modify: `src/lib/instance-manager.ts` (health checker signature)
- Test: `test/unit/instance-manager.test.ts` or `test/unit/daemon.test.ts`

**Step 1: Change health checker to receive the instance, not just port**

The current `InstanceHealthChecker` type is `(port: number) => Promise<boolean>`. Change it to `(port: number, instance: OpenCodeInstance) => Promise<boolean>` so the checker can read `instance.env?.OPENCODE_SERVER_PASSWORD`.

In `src/lib/instance-manager.ts`, update the type alias and all call sites:
- Type definition (near top of file)
- `startHealthPolling` where it calls `this.healthChecker(instance.port)` → `this.healthChecker(instance.port, instance)`
- `startInstance` initial health check call

**Step 2: Update daemon health checker to use per-instance password**

In `src/lib/daemon.ts:173-190`, update the injected health checker:

```typescript
const globalPassword = process.env.OPENCODE_SERVER_PASSWORD;
const globalUsername = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";

this.instanceManager.setHealthChecker(async (port: number, instance: OpenCodeInstance) => {
	const password = instance.env?.OPENCODE_SERVER_PASSWORD ?? globalPassword;
	if (!password) {
		// No auth — bare health check
		try {
			const res = await fetch(`http://localhost:${port}/health`);
			return res.ok;
		} catch { return false; }
	}
	const username = instance.env?.OPENCODE_SERVER_USERNAME ?? globalUsername;
	const encoded = Buffer.from(`${username}:${password}`).toString("base64");
	try {
		const res = await fetch(`http://localhost:${port}/health`, {
			headers: { Authorization: `Basic ${encoded}` },
		});
		return res.ok;
	} catch { return false; }
});
```

Note: Remove the `if (password)` guard that currently wraps the whole injection. Always inject the checker — it now handles the no-password case internally.

**Step 3: Inject `OPENCODE_SERVER_PASSWORD` into managed instance env**

In `InstanceManager.startInstance()`, after the XDG_DATA_HOME handling (line ~266), add:

```typescript
// Ensure managed instances inherit the global OPENCODE_SERVER_PASSWORD
if (!effectiveEnv.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_SERVER_PASSWORD) {
	effectiveEnv.OPENCODE_SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD;
}
```

**Step 4: Run existing tests**

Run: `pnpm vitest run test/unit/instance-manager.test.ts test/unit/daemon.test.ts`
Expected: All PASS (update any tests that call the health checker with the new signature)

**Step 5: Commit**

```
feat: per-instance health check auth with global fallback
```

---

### Task 6: Smart Default Instance Detection

**Files:**
- Modify: `src/lib/daemon.ts:203-220` (constructor Default instance creation)
- Modify: `src/lib/daemon.ts:229-271` (start method)
- Test: `test/unit/daemon.test.ts`

**Step 1: Write failing tests**

Add a new `describe("smart default instance")` block:

```typescript
describe("smart default instance", () => {
	it("creates unmanaged default when OpenCode is reachable", async () => {
		// Mock fetch to return 200 for the probe
		// Create daemon without opencodeUrl, with default probe URL
		// Verify default instance exists, is unmanaged
	});

	it("creates managed default when OpenCode is not reachable", async () => {
		// Mock fetch to throw/reject for the probe
		// Create daemon, start it
		// Verify default instance exists, is managed
	});
});
```

The exact test implementation depends on how the daemon constructor is currently tested — follow the existing patterns in `test/unit/daemon.test.ts` (look at the "multi-instance integration" and "backward compatibility" describes starting at line 2209).

**Step 2: Implement smart detection**

Move the Default instance creation from the constructor (lines 203-220) into the `start()` method (before instance rehydration at line 250). Make it async:

```typescript
// Smart default detection: probe OPENCODE_URL to decide managed vs unmanaged
if (!this.instanceManager.getInstance("default")) {
	const probeUrl = this.options?.opencodeUrl ?? "http://localhost:4096";
	const reachable = await this.probeOpenCode(probeUrl);

	if (reachable) {
		// OpenCode is running — connect as unmanaged
		const urlPort = (() => {
			try { return new URL(probeUrl).port; }
			catch { return ""; }
		})();
		const port = urlPort ? parseInt(urlPort, 10) : 4096;
		this.instanceManager.addInstance("default", {
			name: "Default",
			port,
			managed: false,
			url: probeUrl,
		});
	} else {
		// OpenCode not running — spawn as managed
		const port = await this.findFreePort(4096);
		this.instanceManager.addInstance("default", {
			name: "Default",
			port,
			managed: true,
		});
		// Will be started after rehydration completes
	}
}
```

Add helper methods to Daemon:

```typescript
private async probeOpenCode(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) });
		return true; // Any response (200, 401, etc.) means reachable
	} catch {
		return false;
	}
}

private async findFreePort(startFrom: number): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(startFrom, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : startFrom;
			server.close(() => resolve(port));
		});
		server.on("error", () => {
			// Port in use, try next
			resolve(this.findFreePort(startFrom + 1));
		});
	});
}
```

After rehydration, start any managed instances that should auto-start (the Default managed instance):

```typescript
// Auto-start managed default instance if it was just created
const defaultInst = this.instanceManager.getInstance("default");
if (defaultInst?.managed && defaultInst.status === "stopped") {
	try {
		await this.instanceManager.startInstance("default");
	} catch (err) {
		console.warn("[daemon] Failed to auto-start default instance:", err);
	}
}
```

**Step 3: Remove old constructor Default creation**

Remove lines 203-220 from the constructor (the `if (initialUrl)` block).

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/daemon.test.ts`
Expected: All PASS (some existing "backward compatibility" tests may need adjustment since Default creation moved to `start()`)

**Step 5: Commit**

```
feat: smart default instance — probe then spawn or connect
```

---

### Task 7: Env Var Editor UI in SettingsPanel

**Files:**
- Modify: `src/lib/public/components/overlays/SettingsPanel.svelte`

**Step 1: Add env var state to the form**

In the script block (around line 33), add:

```typescript
let formEnvVars = $state<Array<{ key: string; value: string }>>([]);
```

In `resetForm()` (line 50-55), add: `formEnvVars = [];`

**Step 2: Add env var editor to the "Add Instance" form**

After the Managed checkbox section (~line 279) and before the Create/Cancel buttons (~line 280), add the env var editor:

```svelte
<!-- Environment Variables -->
<div class="flex flex-col gap-2">
	<label class="text-xs text-text-secondary">Environment Variables</label>
	{#each formEnvVars as envVar, idx}
		<div class="flex gap-1">
			<input
				type="text"
				class="flex-1 px-2 py-1 text-xs rounded bg-bg border border-border text-text"
				placeholder="Key"
				bind:value={envVar.key}
			/>
			<input
				type="text"
				class="flex-1 px-2 py-1 text-xs rounded bg-bg border border-border text-text"
				placeholder="Value"
				bind:value={envVar.value}
			/>
			<button
				type="button"
				class="px-2 py-1 text-xs rounded bg-error/10 text-error hover:bg-error/20 cursor-pointer"
				onclick={() => { formEnvVars = formEnvVars.filter((_, i) => i !== idx); }}
			>
				<Icon name="x" size={12} />
			</button>
		</div>
	{/each}
	<button
		type="button"
		class="text-xs text-accent hover:text-accent/80 cursor-pointer self-start"
		onclick={() => { formEnvVars = [...formEnvVars, { key: "", value: "" }]; }}
	>
		+ Add Variable
	</button>
</div>
```

**Step 3: Send env in `handleCreate`**

In `handleCreate()` (line ~62-78), add env to the message:

```typescript
const env: Record<string, string> = {};
for (const { key, value } of formEnvVars) {
	if (key.trim()) env[key.trim()] = value;
}
if (Object.keys(env).length > 0) msg.env = env;
```

**Step 4: Add edit mode for existing instances**

Add state for editing:

```typescript
let editingInstanceId = $state<string | null>(null);
let editName = $state("");
let editPort = $state("");
let editEnvVars = $state<Array<{ key: string; value: string }>>([]);
```

Add `handleEdit` and `handleSave` functions:

```typescript
function handleEdit(inst: OpenCodeInstance) {
	editingInstanceId = inst.id;
	editName = inst.name;
	editPort = String(inst.port);
	editEnvVars = Object.entries(inst.env ?? {}).map(([key, value]) => ({ key, value }));
}

function handleSave() {
	if (!editingInstanceId) return;
	const env: Record<string, string> = {};
	for (const { key, value } of editEnvVars) {
		if (key.trim()) env[key.trim()] = value;
	}
	wsSend({
		type: "instance_update",
		instanceId: editingInstanceId,
		name: editName,
		port: Number(editPort) || undefined,
		env,
	});
	editingInstanceId = null;
}
```

In the expanded instance section (~line 179-203), add an "Edit" button and conditionally show the edit form with the same env var editor pattern.

**Step 5: Show `needsRestart` indicator**

In the instance list rendering, after the status dot, add:

```svelte
{#if inst.needsRestart}
	<span class="text-[10px] text-warning ml-1">⟳ Restart required</span>
{/if}
```

**Step 6: Build and verify**

Run: `pnpm run build`
Expected: Clean build

**Step 7: Commit**

```
feat: env var editor in settings panel with edit mode
```

---

### Task 8: E2E Tests for Env Editor and Instance Update

**Files:**
- Modify: `test/e2e/specs/multi-instance.spec.ts`

**Step 1: Add test for env vars in instance creation form**

Add to the "Instance Management Settings" describe block:

```typescript
test("add instance form includes env var editor", async ({ page, wsMock }) => {
	// Setup WS with standard instance_list
	// Open settings → click "Add Instance"
	// Click "+ Add Variable"
	// Fill key/value
	// Click Create
	// Verify WS message includes env field
});

test("edit instance sends instance_update with env", async ({ page, wsMock }) => {
	// Setup WS with instance that has env
	// Open settings → expand instance → click Edit
	// Modify env var
	// Click Save
	// Verify instance_update WS message
});

test("needsRestart indicator shows when env changes on running instance", async ({ page, wsMock }) => {
	// Setup WS with healthy instance
	// Send instance_list with needsRestart: true
	// Verify "Restart required" indicator visible
});
```

**Step 2: Run E2E tests**

Run: `pnpm run build && pnpm test:multi-instance`
Expected: All tests PASS (including new ones)

**Step 3: Commit**

```
test: E2E tests for env editor and instance update
```

---

### Task 9: Final Verification

**Step 1: Type check**
Run: `npx tsc --noEmit`
Expected: Clean

**Step 2: Unit tests**
Run: `pnpm vitest run test/unit/`
Expected: All PASS

**Step 3: Multi-instance E2E tests**
Run: `pnpm run build && pnpm test:multi-instance`
Expected: All PASS

**Step 4: Daemon E2E tests**
Run: `pnpm test:daemon`
Expected: All PASS

**Step 5: Commit**

```
chore: final verification — all tests green
```
