# Cross-Platform Keep-Awake Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make the keep-awake feature work cross-platform (macOS + Linux with systemd) with user-configurable fallback, and fix the existing bugs where activation never fires.

**Architecture:** The `KeepAwake` class gains a `resolveCommand()` method that checks user config override, then auto-detects by platform (`caffeinate` on macOS, `systemd-inhibit` on Linux). `DaemonConfig` gets optional `keepAwakeCommand`/`keepAwakeArgs` fields. The CLI settings menu prompts for a custom command when no tool is auto-detected. The `setKeepAwake` IPC handler returns `{ ok, supported, active }` so the CLI knows whether to prompt for a custom command.

**Tech Stack:** Node.js child_process, Vitest, fast-check

**Design doc:** `docs/plans/2026-03-24-cross-platform-keep-awake-design.md`

**Key design decisions:**
- Empty string `keepAwakeCommand` is treated as "no command" (falls through to auto-detect).
- `deactivate()` uses process group kill (`process.kill(-pid)`) to clean up Linux's `systemd-inhibit ... sleep infinity` child tree.
- Setting a custom command via IPC auto-activates if keep-awake is already enabled.

---

### Task 1: Fix `setEnabled(true)` to call `activate()` and add `activate()` at daemon startup

These bugs are already fixed in the worktree (see current diff). This task verifies the fixes are in place.

**Files:**
- Modified: `src/lib/daemon/keep-awake.ts:138-145`
- Modified: `src/lib/daemon/daemon.ts:813-817`
- Modified: `test/unit/daemon/keep-awake.test.ts:249-266` (T7)

**Step 1: Verify the existing fixes**

The `setEnabled(true)` method should call `this.activate()`, and daemon.ts should call `this.keepAwakeManager.activate()` after construction. These changes are already applied.

**Step 2: Run tests to verify**

Run: `pnpm test:unit -- test/unit/daemon/keep-awake.test.ts`
Expected: All 41 tests pass.

**Step 3: Commit**

```bash
git add src/lib/daemon/keep-awake.ts src/lib/daemon/daemon.ts test/unit/daemon/keep-awake.test.ts
git commit -m "fix: setEnabled(true) now activates keep-awake; daemon calls activate() at startup"
```

---

### Task 2: Add `keepAwakeCommand`/`keepAwakeArgs` to config and options

**Files:**
- Modify: `src/lib/daemon/config-persistence.ts:26-51` (DaemonConfig interface)
- Modify: `src/lib/daemon/daemon.ts:102-128` (DaemonOptions interface)
- Modify: `src/lib/daemon/daemon.ts:1279-1294` (buildConfig method)
- Modify: `src/lib/daemon/daemon.ts:230-240` (constructor — store new fields)
- Modify: `src/lib/env.ts:34` (add env key constants for KEEP_AWAKE_COMMAND, KEEP_AWAKE_ARGS)
- Modify: `src/lib/daemon/daemon-spawn.ts:34,90` (propagate new env vars to child daemon)
- Modify: `src/bin/cli-core.ts:119` (read new env vars)
- Test: `test/unit/daemon/config-persistence.test.ts`

**Step 1: Write failing test**

Add tests to `test/unit/daemon/config-persistence.test.ts`. Use the codebase's existing `makeSampleConfig()` helper (not a manual spread):

```ts
it("round-trips keepAwakeCommand and keepAwakeArgs", () => {
    const config = makeSampleConfig({
        keepAwakeCommand: "systemd-inhibit",
        keepAwakeArgs: ["--what=idle", "--who=conduit", "sleep", "infinity"],
    });
    saveDaemonConfig(config, tmpDir);
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded?.keepAwakeCommand).toBe("systemd-inhibit");
    expect(loaded?.keepAwakeArgs).toEqual(["--what=idle", "--who=conduit", "sleep", "infinity"]);
});

it("loads config without keepAwakeCommand fields (backward compat)", () => {
    const config = makeSampleConfig();
    saveDaemonConfig(config, tmpDir);
    const loaded = loadDaemonConfig(tmpDir);
    expect(loaded?.keepAwakeCommand).toBeUndefined();
    expect(loaded?.keepAwakeArgs).toBeUndefined();
});
```

**Note:** If `makeSampleConfig` doesn't exist, find the actual test helper used in that file and use it.

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/daemon/config-persistence.test.ts`
Expected: Type error — `keepAwakeCommand` doesn't exist on `DaemonConfig`.

**Step 3: Add fields to DaemonConfig**

In `src/lib/daemon/config-persistence.ts`, add to the `DaemonConfig` interface after `keepAwake: boolean`:

```ts
/** User-provided keep-awake command override (e.g. "systemd-inhibit"). */
keepAwakeCommand?: string;
/** Arguments for the keep-awake command override. */
keepAwakeArgs?: string[];
```

**Step 4: Add fields to DaemonOptions**

In `src/lib/daemon/daemon.ts`, add to `DaemonOptions` after `keepAwake?: boolean`:

```ts
/** User-provided keep-awake command (overrides auto-detection). */
keepAwakeCommand?: string;
/** Args for user-provided keep-awake command. */
keepAwakeArgs?: string[];
```

**Step 5: Store in constructor, emit in buildConfig, add private fields**

Add private fields to the Daemon class:

```ts
private keepAwakeCommand?: string;
private keepAwakeArgs?: string[];
```

In constructor (after `this.keepAwake = ...`):

```ts
this.keepAwakeCommand = options?.keepAwakeCommand;
this.keepAwakeArgs = options?.keepAwakeArgs;
```

In `buildConfig()` (after `keepAwake: this.keepAwake`):

```ts
...(this.keepAwakeCommand != null && { keepAwakeCommand: this.keepAwakeCommand }),
...(this.keepAwakeArgs != null && { keepAwakeArgs: this.keepAwakeArgs }),
```

**Step 6: Add env key constants**

In `src/lib/env.ts`, add to `RELAY_ENV_KEYS`:

```ts
KEEP_AWAKE_COMMAND: "CONDUIT_KEEP_AWAKE_COMMAND",
KEEP_AWAKE_ARGS: "CONDUIT_KEEP_AWAKE_ARGS",
```

**Step 7: Propagate env vars in daemon-spawn.ts**

In `src/lib/daemon/daemon-spawn.ts`, in the section that builds the child process env (around line 90 where `CONDUIT_KEEP_AWAKE` is set), add:

```ts
if (options.keepAwakeCommand) {
    env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND] = options.keepAwakeCommand;
}
if (options.keepAwakeArgs) {
    env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS] = JSON.stringify(options.keepAwakeArgs);
}
```

**Step 8: Read env vars in cli-core.ts**

In `src/bin/cli-core.ts` (around line 119 where `keepAwake` is read), add:

```ts
keepAwakeCommand: process.env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND] || undefined,
keepAwakeArgs: process.env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS]
    ? JSON.parse(process.env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS])
    : undefined,
```

**Step 9: Add config rehydration in daemon start()**

In `daemon.ts` `start()`, after loading persisted config (where projects and dismissedPaths are rehydrated), also rehydrate keep-awake command:

```ts
if (savedConfig?.keepAwakeCommand) {
    this.keepAwakeCommand = savedConfig.keepAwakeCommand;
}
if (savedConfig?.keepAwakeArgs) {
    this.keepAwakeArgs = savedConfig.keepAwakeArgs;
}
```

**Step 10: Run tests**

Run: `pnpm test:unit -- test/unit/daemon/config-persistence.test.ts`
Expected: All pass.

**Step 11: Run full check**

Run: `pnpm check`
Expected: Clean.

**Step 12: Commit**

```bash
git add src/lib/daemon/config-persistence.ts src/lib/daemon/daemon.ts src/lib/env.ts src/lib/daemon/daemon-spawn.ts src/bin/cli-core.ts test/unit/daemon/config-persistence.test.ts
git commit -m "feat: add keepAwakeCommand/keepAwakeArgs to DaemonConfig, DaemonOptions, env bridge"
```

---

### Task 3: Add `resolveCommand()` to KeepAwake for cross-platform tool detection

**Files:**
- Modify: `src/lib/daemon/keep-awake.ts` (add resolveCommand, update KeepAwakeOptions, update activate, update deactivate for process group kill)
- Test: `test/unit/daemon/keep-awake.test.ts`

**Step 1: Write failing tests**

Add new test section to `test/unit/daemon/keep-awake.test.ts`:

```ts
describe("T16: Cross-platform tool resolution", () => {
    it("uses config command/args when provided (any platform)", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const ka = new KeepAwake({
            _platform: "linux",
            _spawn: mockSpawn,
            command: "systemd-inhibit",
            args: ["--what=idle", "--who=conduit", "sleep", "infinity"],
        });
        ka.activate();
        expect(mockSpawn).toHaveBeenCalledWith(
            "systemd-inhibit",
            ["--what=idle", "--who=conduit", "sleep", "infinity"],
            expect.any(Object),
        );
        expect(ka.isActive()).toBe(true);
    });

    it("auto-detects systemd-inhibit on linux when available", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const ka = new KeepAwake({
            _platform: "linux",
            _spawn: mockSpawn,
            _whichSync: (_cmd: string) => "/usr/bin/systemd-inhibit",
        });
        ka.activate();
        expect(mockSpawn).toHaveBeenCalledWith(
            "systemd-inhibit",
            ["--what=idle", "--who=conduit", "--why=Conduit relay running", "sleep", "infinity"],
            expect.any(Object),
        );
        expect(ka.isActive()).toBe(true);
    });

    it("emits unsupported on linux when systemd-inhibit is not found", () => {
        const mockSpawn = vi.fn() as unknown as typeof import("node:child_process").spawn;
        const ka = new KeepAwake({
            _platform: "linux",
            _spawn: mockSpawn,
            _whichSync: (_cmd: string) => null,
        });
        const events: Array<{ platform: string }> = [];
        ka.on("unsupported", (info) => events.push(info));
        ka.activate();
        expect(events).toEqual([{ platform: "linux" }]);
        expect(ka.isActive()).toBe(false);
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("isSupported() returns true on linux when systemd-inhibit is available", () => {
        const ka = new KeepAwake({
            _platform: "linux",
            _whichSync: () => "/usr/bin/systemd-inhibit",
        });
        expect(ka.isSupported()).toBe(true);
    });

    it("isSupported() returns false on linux when no tool found", () => {
        const ka = new KeepAwake({
            _platform: "linux",
            _whichSync: () => null,
        });
        expect(ka.isSupported()).toBe(false);
    });

    it("config command overrides auto-detection", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const ka = new KeepAwake({
            _platform: "darwin",
            _spawn: mockSpawn,
            command: "my-custom-tool",
            args: ["--no-sleep"],
        });
        ka.activate();
        expect(mockSpawn).toHaveBeenCalledWith(
            "my-custom-tool",
            ["--no-sleep"],
            expect.any(Object),
        );
    });

    it("windows with no config command emits unsupported", () => {
        const mockSpawn = vi.fn() as unknown as typeof import("node:child_process").spawn;
        const ka = new KeepAwake({ _platform: "win32", _spawn: mockSpawn });
        const events: Array<{ platform: string }> = [];
        ka.on("unsupported", (info) => events.push(info));
        ka.activate();
        expect(events).toEqual([{ platform: "win32" }]);
        expect(ka.isActive()).toBe(false);
    });

    it("windows with config command activates", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const ka = new KeepAwake({
            _platform: "win32",
            _spawn: mockSpawn,
            command: "powercfg",
            args: ["/change", "standby-timeout-ac", "0"],
        });
        ka.activate();
        expect(mockSpawn).toHaveBeenCalledWith("powercfg", ["/change", "standby-timeout-ac", "0"], expect.any(Object));
        expect(ka.isActive()).toBe(true);
    });

    it("whichSync is only called once (cached)", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const mockWhich = vi.fn(() => "/usr/bin/systemd-inhibit");
        const ka = new KeepAwake({
            _platform: "linux",
            _spawn: mockSpawn,
            _whichSync: mockWhich,
        });
        ka.activate();
        ka.deactivate();
        ka.activate();
        expect(mockWhich).toHaveBeenCalledTimes(1);
    });

    it("empty string command is treated as no command (auto-detect)", () => {
        const child = createMockChild();
        const mockSpawn = createMockSpawn(child);
        const ka = new KeepAwake({
            _platform: "darwin",
            _spawn: mockSpawn,
            command: "",
        });
        ka.activate();
        // Should fall through to darwin auto-detect, not try to spawn ""
        expect(mockSpawn).toHaveBeenCalledWith("caffeinate", ["-di"], expect.any(Object));
    });
});
```

**Step 2: Update existing tests that will break**

The following existing tests will call the real `which` binary on Linux CI if not updated. Add `_whichSync: () => null` to all existing tests that use non-darwin platforms without `_whichSync`:

- **T8** (line ~270): Add `_whichSync: () => null` to the linux and win32 KeepAwake constructors
- **T12** (line ~515): The `isSupported()` tests for linux/win32/freebsd need `_whichSync: () => null`
- **T14 PBT** (line ~587): The `isSupported()` property test assertion `platform === "darwin"` must change to account for linux+available systemd-inhibit. Simplest fix: inject `_whichSync: () => null` so the PBT only tests the "no tool" case, and test the "tool found" case in T16.
- **T7** updated test (currently in worktree): The linux sub-test "enables but does not activate on unsupported platform" needs `_whichSync: () => null`.

**Step 3: Implement resolveCommand()**

Refactor `src/lib/daemon/keep-awake.ts`:

1. Merge `execFileSync` into the existing `child_process` import:

```ts
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn as defaultSpawn } from "node:child_process";
```

2. Add `_whichSync` to `KeepAwakeOptions`:

```ts
export interface KeepAwakeOptions {
    enabled?: boolean;
    /** User-configured command override. When set (and non-empty), skips auto-detection. */
    command?: string;
    /** User-configured args override. */
    args?: string[];
    /** Injectable platform for testing */
    _platform?: string;
    /** Injectable spawn for testing */
    _spawn?: typeof import("node:child_process").spawn;
    /** Injectable which-sync for testing (returns path or null) */
    _whichSync?: (cmd: string) => string | null;
}
```

3. Add Linux defaults and whichSync helper:

```ts
const LINUX_COMMAND = "systemd-inhibit";
const LINUX_ARGS = ["--what=idle", "--who=conduit", "--why=Conduit relay running", "sleep", "infinity"];

function defaultWhichSync(cmd: string): string | null {
    try {
        const result = execFileSync("which", [cmd], { encoding: "utf-8", timeout: 2000 });
        return result.trim() || null;
    } catch {
        return null;
    }
}
```

4. Replace private fields. Remove `private readonly command` and `private readonly args`. Add:

```ts
private readonly whichSync: (cmd: string) => string | null;
private readonly configCommand: string | undefined;
private readonly configArgs: string[] | undefined;
// undefined = not yet resolved; null = resolved to "no tool available"
private resolvedCommand: { command: string; args: string[] } | null | undefined;
```

5. Update constructor:

```ts
constructor(options?: KeepAwakeOptions) {
    super();
    this.enabled = options?.enabled ?? true;
    // Treat empty string as "no command" — fall through to auto-detect
    this.configCommand = options?.command?.trim() || undefined;
    this.configArgs = options?.args;
    this.platform = options?._platform ?? process.platform;
    this.spawnFn = options?._spawn ?? defaultSpawn;
    this.whichSync = options?._whichSync ?? defaultWhichSync;
}
```

6. Add `resolveCommand()`:

```ts
/**
 * Resolve the command+args to use. Returns null if no tool available.
 * Cached after first call — per-instance lifetime (construct new instance to re-resolve).
 */
private resolveCommand(): { command: string; args: string[] } | null {
    if (this.resolvedCommand !== undefined) return this.resolvedCommand;

    // 1. User-configured command takes priority
    if (this.configCommand != null) {
        this.resolvedCommand = {
            command: this.configCommand,
            args: this.configArgs ?? [],
        };
        return this.resolvedCommand;
    }

    // 2. Auto-detect by platform
    if (this.platform === "darwin") {
        this.resolvedCommand = { command: DEFAULT_COMMAND, args: [...DEFAULT_ARGS] };
        return this.resolvedCommand;
    }

    if (this.platform === "linux") {
        const path = this.whichSync(LINUX_COMMAND);
        if (path) {
            this.resolvedCommand = { command: LINUX_COMMAND, args: [...LINUX_ARGS] };
            return this.resolvedCommand;
        }
    }

    // 3. No tool found
    this.resolvedCommand = null;
    return null;
}
```

7. Update `activate()` to use `resolveCommand()`:

```ts
activate(): void {
    if (!this.enabled) return;
    if (this.active) return;

    const resolved = this.resolveCommand();
    if (!resolved) {
        this.emit("unsupported", { platform: this.platform });
        return;
    }

    try {
        const child = this.spawnFn(resolved.command, resolved.args, {
            stdio: "ignore",
            detached: true, // Changed: use process group for clean kill
        });
        // ... rest of activate() is unchanged (child event handlers, etc.)
```

8. Update `deactivate()` to use process group kill:

```ts
deactivate(): void {
    if (!this.active || !this.child) return;

    const child = this.child;
    this.active = false;
    this.child = null;

    try {
        // Kill the process group (handles systemd-inhibit's child `sleep infinity`)
        if (child.pid) {
            process.kill(-child.pid, "SIGTERM");
        } else {
            child.kill();
        }
    } catch {
        // Process may already be dead
    }

    this.emit("deactivated");
}
```

9. Update `isSupported()`:

```ts
isSupported(): boolean {
    return this.resolveCommand() !== null;
}
```

**Step 4: Run tests**

Run: `pnpm test:unit -- test/unit/daemon/keep-awake.test.ts`
Expected: All tests pass (old + new).

**Step 5: Run full check**

Run: `pnpm check && pnpm lint`
Expected: Clean.

**Step 6: Commit**

```bash
git add src/lib/daemon/keep-awake.ts test/unit/daemon/keep-awake.test.ts
git commit -m "feat: cross-platform keep-awake tool resolution (macOS + Linux systemd-inhibit + custom)"
```

---

### Task 4: Wire config fields through daemon startup and IPC, update setKeepAwake response

This task also fixes the IPC response disconnect: `setKeepAwake` must return `{ ok, supported, active }` so the CLI knows whether the platform has a tool.

**Files:**
- Modify: `src/lib/daemon/daemon.ts:813-817` (pass config command to KeepAwake constructor)
- Modify: `src/lib/daemon/daemon.ts:1421-1426` (setKeepAwake returns status)
- Modify: `src/lib/daemon/daemon-ipc.ts:18-56` (DaemonIPCContext — setKeepAwake return type)
- Modify: `src/lib/daemon/daemon-ipc.ts:159-162` (handler passes through status)
- Test: `test/unit/daemon/daemon.test.ts`

**Step 1: Write failing tests**

In `test/unit/daemon/daemon.test.ts`, in the keep-awake section:

```ts
it("passes keepAwakeCommand/Args to KeepAwake constructor via buildConfig", () => {
    const daemon = new Daemon({
        port: 0,
        smartDefault: false,
        keepAwake: true,
        keepAwakeCommand: "my-tool",
        keepAwakeArgs: ["--flag"],
    });
    const config = (daemon as any).buildConfig();
    expect(config.keepAwakeCommand).toBe("my-tool");
    expect(config.keepAwakeArgs).toEqual(["--flag"]);
});
```

**Step 2: Update DaemonIPCContext.setKeepAwake return type**

In `src/lib/daemon/daemon-ipc.ts`, change:

```ts
// Before:
setKeepAwake(enabled: boolean): void;

// After:
setKeepAwake(enabled: boolean): { supported: boolean; active: boolean };
```

**Step 3: Update daemon context implementation**

In `src/lib/daemon/daemon.ts` (around line 1422):

```ts
setKeepAwake: (enabled) => {
    this.keepAwake = enabled;
    this.keepAwakeManager?.setEnabled(enabled);
    this.persistConfig();
    return {
        supported: this.keepAwakeManager?.isSupported() ?? false,
        active: this.keepAwakeManager?.isActive() ?? false,
    };
},
```

**Step 4: Update IPC handler to include status in response**

In `src/lib/daemon/daemon-ipc.ts` (around line 159):

```ts
setKeepAwake: async (enabled: boolean): Promise<IPCResponse> => {
    const result = ctx.setKeepAwake(enabled);
    return { ok: true, supported: result.supported, active: result.active };
},
```

**Step 5: Wire KeepAwake construction with config command**

In `daemon.ts` `start()`, update the KeepAwake construction:

```ts
this.keepAwakeManager = new KeepAwake({
    enabled: this.keepAwake,
    ...(this.keepAwakeCommand != null && { command: this.keepAwakeCommand }),
    ...(this.keepAwakeArgs != null && { args: this.keepAwakeArgs }),
});
this.keepAwakeManager.activate();
```

**Step 6: Run tests**

Run: `pnpm test:unit -- test/unit/daemon/daemon.test.ts`
Expected: All pass.

**Step 7: Commit**

```bash
git add src/lib/daemon/daemon.ts src/lib/daemon/daemon-ipc.ts test/unit/daemon/daemon.test.ts
git commit -m "feat: wire keepAwakeCommand/Args to KeepAwake; return supported/active from setKeepAwake IPC"
```

---

### Task 5: CLI settings — prompt for custom command when no tool detected

**Files:**
- Modify: `src/lib/cli/cli-settings.ts` (remove macOS gates, add custom command prompt, add promptText import)
- Test: `test/unit/cli/cli-settings.test.ts`

**Step 1: Update imports**

In `src/lib/cli/cli-settings.ts`, add `promptText` to the import:

```ts
import { promptPin, promptSelect, promptText } from "./prompts.js";
```

**Step 2: Add setKeepAwakeCommand to SettingsMenuOptions**

```ts
export interface SettingsMenuOptions extends PromptOptions {
    // ... existing ...
    /** IPC: toggle keep-awake. Returns supported/active status. */
    setKeepAwake: (enabled: boolean) => Promise<{ ok: boolean; supported?: boolean; active?: boolean; error?: string }>;
    /** IPC: set custom keep-awake command. */
    setKeepAwakeCommand?: (command: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;
    // ... rest ...
}
```

**Step 3: Remove macOS gates**

1. In `renderSettingsStatus` (line 91): Remove the `if (isMacOS)` gate on the keep-awake status line — show it unconditionally.
2. In menu building (line 139): Remove the `if (isMacOS)` gate — show keep-awake toggle on all platforms.

**Step 4: Update the "awake" case handler**

Replace the current handler (lines 206-209):

```ts
case "awake": {
    const result = await opts.setKeepAwake(!info.keepAwake);
    if (!info.keepAwake && result.supported === false && opts.setKeepAwakeCommand) {
        // Enabling, but no tool auto-detected — prompt for custom command
        log(`${sym.bar}  ${a.yellow}No keep-awake tool detected for your platform.${a.reset}`, opts.stdout);
        log(`${sym.bar}  ${a.dim}Enter a command to prevent sleep, e.g.: caffeinate -di${a.reset}`, opts.stdout);
        const cmdPromise = new Promise<void>((cmdResolve) => {
            promptText("Command", "", async (val) => {
                if (val && val.trim()) {
                    const parts = val.trim().split(/\s+/);
                    const command = parts[0]!;
                    const args = parts.slice(1);
                    await opts.setKeepAwakeCommand!(command, args);
                    await opts.setKeepAwake(true);
                    log(`${sym.done}  ${a.green}Keep awake configured${a.reset}`, opts.stdout);
                } else {
                    // User skipped — disable keep awake
                    await opts.setKeepAwake(false);
                    log(`${sym.done}  ${a.dim}Keep awake disabled${a.reset}`, opts.stdout);
                }
                cmdResolve();
            }, { stdin: opts.stdin, stdout: opts.stdout, exit: opts.exit });
        });
        await cmdPromise;
    }
    await showSettingsMenu(opts);
    resolve();
    break;
}
```

**Step 5: Remove or deprecate isMacOS option**

The `isMacOS` option in `SettingsMenuOptions` is no longer used for gating. Keep it for now as it may still be used for display text, but remove the gate logic.

**Step 6: Update existing tests that assert macOS-only behavior**

In `test/unit/cli/cli-settings.test.ts`, find and update:
- Tests that assert keep-awake is hidden when `isMacOS: false` — update to assert it IS shown.
- Tests that navigate menus by item index — update indices since keep-awake is now always present.
- Tests that check `renderSettingsStatus` output without keep-awake on non-macOS — update to expect the keep-awake line.

**Step 7: Run tests**

Run: `pnpm test:unit -- test/unit/cli/cli-settings.test.ts`
Expected: All pass.

**Step 8: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All clean, all pass.

**Step 9: Commit**

```bash
git add src/lib/cli/cli-settings.ts test/unit/cli/cli-settings.test.ts
git commit -m "feat: show keep-awake on all platforms, prompt for custom command when unsupported"
```

---

### Task 6: Wire IPC for `setKeepAwakeCommand`

**Files:**
- Modify: `src/lib/types.ts` (add IPC message type to union)
- Modify: `src/lib/daemon/ipc-protocol.ts` (add to VALID_COMMANDS, validateCommand switch, createCommandRouter)
- Modify: `src/lib/daemon/daemon-ipc.ts` (add to DaemonIPCContext, IPCHandlerMap, buildIPCHandlers)
- Modify: `src/lib/daemon/daemon.ts` (add context method — deactivate old, reconstruct, activate)
- Modify: `src/bin/cli-commands.ts` (wire CLI-side IPC call for settings menu)
- Modify: `test/helpers/arbitraries.ts` (add `set_keep_awake_command` to PBT command arbitrary)
- Test: `test/unit/daemon/daemon-ipc.test.ts`

**Step 1: Add IPC message type**

In `src/lib/types.ts`, add to the IPC command union:

```ts
| { cmd: "set_keep_awake_command"; command: string; args: string[] }
```

**Step 2: Add to ipc-protocol.ts**

1. Add `"set_keep_awake_command"` to the `VALID_COMMANDS` set
2. In `validateCommand`, add a case for `set_keep_awake_command`:
   - Require `command` as a non-empty string (reject empty string)
   - Require `args` as an array of strings (default to `[]` if missing)
3. In `createCommandRouter`, add the route to call `handlers.setKeepAwakeCommand(msg.command, msg.args)`

**Step 3: Add to daemon-ipc.ts**

1. Add to `DaemonIPCContext`:

```ts
/** Set custom keep-awake command, recreate manager, persist config. */
setKeepAwakeCommand(command: string, args: string[]): void;
```

2. Add to `IPCHandlerMap`:

```ts
setKeepAwakeCommand: (command: string, args: string[]) => Promise<IPCResponse>;
```

3. Add to `buildIPCHandlers`:

```ts
setKeepAwakeCommand: async (command: string, args: string[]): Promise<IPCResponse> => {
    try {
        ctx.setKeepAwakeCommand(command, args);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: formatErrorDetail(err) };
    }
},
```

**Step 4: Implement daemon context method**

In `src/lib/daemon/daemon.ts`, add to the context object:

```ts
setKeepAwakeCommand: (command, args) => {
    this.keepAwakeCommand = command;
    this.keepAwakeArgs = args;

    // Deactivate old manager to clean up spawned processes
    this.keepAwakeManager?.deactivate();

    // Reconstruct with new command
    this.keepAwakeManager = new KeepAwake({
        enabled: this.keepAwake,
        command,
        args,
    });

    // Auto-activate if currently enabled
    if (this.keepAwake) {
        this.keepAwakeManager.activate();
    }

    this.persistConfig();
},
```

**Step 5: Wire CLI-side IPC call**

In `src/bin/cli-commands.ts`, where the settings menu is wired, add the `setKeepAwakeCommand` callback that sends IPC `{ cmd: "set_keep_awake_command", command, args }`.

**Step 6: Add to PBT arbitrary**

In `test/helpers/arbitraries.ts`, add `set_keep_awake_command` to the command arbitrary:

```ts
fc.record({
    cmd: fc.constant("set_keep_awake_command" as const),
    command: fc.string({ minLength: 1, maxLength: 50 }),
    args: fc.array(fc.string({ minLength: 0, maxLength: 30 }), { maxLength: 5 }),
}),
```

**Step 7: Write tests**

In `test/unit/daemon/daemon-ipc.test.ts`:

```ts
it("set_keep_awake_command persists command and args", async () => {
    let storedCommand: string | undefined;
    let storedArgs: string[] | undefined;
    const ctx = { ...baseCtx,
        setKeepAwakeCommand: (command: string, args: string[]) => {
            storedCommand = command;
            storedArgs = args;
        },
    };
    const handlers = buildIPCHandlers(ctx, () => baseStatus);
    const result = await handlers.setKeepAwakeCommand("my-tool", ["--flag"]);
    expect(result).toEqual({ ok: true });
    expect(storedCommand).toBe("my-tool");
    expect(storedArgs).toEqual(["--flag"]);
});
```

**Step 8: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All clean, all pass.

**Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/daemon/ipc-protocol.ts src/lib/daemon/daemon-ipc.ts src/lib/daemon/daemon.ts src/bin/cli-commands.ts test/helpers/arbitraries.ts test/unit/daemon/daemon-ipc.test.ts
git commit -m "feat: add set_keep_awake_command IPC for custom command persistence"
```

---

### Task 7: Update CLI setup wizard to show keep-awake on all platforms

**Files:**
- Modify: `src/lib/cli/cli-setup.ts:269-281` (remove macOS gate, update prompt text)
- Test: `test/unit/cli/cli-setup.test.ts`

**Step 1: Remove macOS gate**

Change the keep-awake setup step (lines 269-281) from:

```ts
if (isMacOS) {
    keepAwake = await new Promise<boolean>((resolve) => { ... });
}
```

To unconditional, with updated prompt text:

```ts
keepAwake = await new Promise<boolean>((resolve) => {
    promptToggle(
        "Keep awake?",
        "Prevent the system from sleeping while the relay is running",
        false,
        resolve,
        promptOpts,
    );
});
```

**Step 2: Update tests that will break**

The following tests in `test/unit/cli/cli-setup.test.ts` will break or hang:

1. Tests that use `isMacOS: false` and only send 3 steps of keystrokes (disclaimer, port, PIN) — they now need a 4th keystroke for the keep-awake toggle. Search for tests that use `createMockIO()` with default (non-macOS) settings and verify they send enough keystrokes.

2. Tests that explicitly assert "does not prompt for keep-awake on non-macOS" (around lines 787-800) — update to assert it IS prompted.

3. Tests around lines 725-728 that assert `keepAwake: false` when `isMacOS: false` — update since keep-awake is now always prompted.

**Step 3: Clean up isMacOS**

The `isMacOS` field in `SetupOptions` is now only used for display purposes (if at all). If no other code reads it, remove it. If tests inject it, update them.

**Step 4: Run tests**

Run: `pnpm test:unit -- test/unit/cli/cli-setup.test.ts`
Expected: All pass after updates.

**Step 5: Commit**

```bash
git add src/lib/cli/cli-setup.ts test/unit/cli/cli-setup.test.ts
git commit -m "feat: show keep-awake prompt on all platforms in setup wizard"
```

---

### Task 8: Final integration verification

**Step 1: Run full verification suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All clean, 172+ test files, 3440+ tests passing.

**Step 2: Manual smoke test (if daemon is running)**

```bash
# Check that the feature toggle works in CLI settings
# Verify caffeinate spawns on macOS after enable
pgrep caffeinate
```
