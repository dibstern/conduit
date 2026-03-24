# Cross-Platform Keep-Awake Design

## Problem

The keep-awake feature uses macOS `caffeinate -di` and is a silent no-op on Linux and Windows. Two bugs also prevent it from working even on macOS: `setEnabled(true)` doesn't call `activate()`, and the daemon never calls `activate()` at startup.

## Design

### Tool Resolution

When keep-awake is enabled, `KeepAwake` resolves which command to spawn in priority order:

1. **User-configured command** from persisted config (`keepAwakeCommand` / `keepAwakeArgs`) — always wins.
2. **Auto-detected platform tool:**
   - macOS: `caffeinate -di` (ships with every Mac).
   - Linux: `systemd-inhibit --what=idle --who=conduit --why="Conduit relay running" sleep infinity` (probed via `which systemd-inhibit`).
   - Windows / other: no auto-detection.
3. **No tool found** — keep-awake cannot activate.

Auto-detection runs once at construction and caches the result.

### UX When No Tool Is Found

Only triggered interactively — when the user enables keep-awake via CLI settings or the first-run wizard and no tool is auto-detected:

1. CLI prompts: *"No keep-awake tool detected for your platform. Enter a command to prevent sleep (or leave blank to skip):"*
2. If the user provides a command, it's persisted in config under `keepAwakeCommand` / `keepAwakeArgs`.
3. If the user skips, keep-awake is set to `enabled: false` and a log message explains why.

On non-interactive daemon restart with `keepAwake: true` but no tool: log a warning and disable silently.

### Config Schema Change

```ts
interface DaemonConfig {
  keepAwake: boolean;           // existing
  keepAwakeCommand?: string;    // new — e.g. "caffeinate"
  keepAwakeArgs?: string[];     // new — e.g. ["-di"]
}
```

### KeepAwake Class Changes

- Constructor accepts optional `command`/`args` override from config.
- New private `resolveCommand()`: checks config override → auto-detects by platform.
- `activate()` uses the resolved command instead of hardcoded `caffeinate`.
- `isSupported()` returns `true` if a tool is resolved (not just `platform === "darwin"`).
- Linux tool probe: synchronous `child_process.execFileSync('which', ['systemd-inhibit'])` (fast, runs once).
- Bug fix: `setEnabled(true)` calls `activate()`.
- Bug fix: daemon calls `activate()` after constructing `KeepAwake`.

### What Stays The Same

- `activate()` / `deactivate()` / `setEnabled()` public API.
- Event model: `activated`, `deactivated`, `error`, `unsupported`.
- Daemon wiring in `daemon.ts` (already fixed in this branch).
- IPC protocol: `set_keep_awake` command unchanged.
