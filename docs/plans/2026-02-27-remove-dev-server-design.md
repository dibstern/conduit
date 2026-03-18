# Remove Dev-Server: Design

## Problem

`src/dev-server.ts` uses `createRelayStack()` — a completely different code path from the production `Daemon` class. This means development never exercises:

- Multi-project routing and slug-based WebSocket upgrade
- IPC server and command protocol
- PID file lifecycle
- Crash counter
- `RequestRouter` as wired by the Daemon (vs. by `createRelayStack`)
- Push notification manager initialization
- Config persistence (`saveDaemonConfig`, `syncRecentProjects`)

Bugs in Daemon-specific code are invisible during development.

## Solution

Replace `dev-server.ts` with a `--foreground` CLI flag that runs the actual `Daemon` class in-process (no fork/detach), auto-registers CWD as a project, and is compatible with `tsx watch` for hot reload.

## Key Insight: No Daemon Changes Needed

The crash counter is in-memory (`private crashTimestamps: number[] = []`) and resets on every process restart — tsx watch restarts don't accumulate. The PID file is written on `start()` and cleaned on `stop()`, with stale socket cleanup already in `startIPCServer()`. The Daemon runs identically in foreground mode.

## Design

### 1. New CLI flag: `--foreground`

Add to `cli-core.ts`:

- `parseArgs()`: `--foreground` → `command: "foreground"`
- New handler similar to `--daemon` but:
  - Reads `--port` and `--opencode-url` from CLI args (not env vars)
  - Creates `new Daemon(...)` with those options
  - Calls `daemon.start()`
  - Calls `daemon.addProject(cwd)` to auto-register CWD
  - Logs connection info

### 2. Updated package.json scripts

| Script | New command |
|---|---|
| `dev` | `tsx watch src/bin/cli.ts -- --foreground` |
| `dev:all` | `trap 'kill 0' EXIT; tsx watch src/bin/cli.ts -- --foreground & vite & wait` |
| `dev:frontend` | `vite` (unchanged) |
| `dev:dc` | `./dc dev` (unchanged) |
| `preview:server` | `pnpm build && node dist/src/bin/cli.js` (NEW — tests full production CLI: wizard, detach, IPC) |

### 3. Docker changes

**`Dockerfile.dev` CMD:**
```
CMD ["sh", "-c", "pnpm tsx watch src/bin/cli.ts -- --foreground & pnpm vite --host 0.0.0.0 & wait"]
```

**`docker-compose.yml` relay-dev watch paths:**
- Replace `./src/dev-server.ts` sync with `./src/bin` sync

### 4. Files deleted

- `src/dev-server.ts` — removed entirely

### 5. Code path coverage by command

| Command | Daemon | IPC | Crash counter | PID file | Spawn/detach | Wizard | Hot reload |
|---|---|---|---|---|---|---|---|
| `pnpm dev:all` | Full | Full | Full | Full | No | No | Yes |
| `pnpm preview:server` | Full | Full | Full | Full | Full | Full | No |
| `./dc dev` | Full | Full | Full | Full | No | No | Yes |

Only `Daemon.spawn()` (~40 lines) and the interactive wizard are not exercised by `dev:all`. Both are covered by `preview:server`.

## Testing

- Existing daemon unit tests pass unchanged (Daemon class is not modified)
- Add CLI unit tests for `--foreground` command parsing and handler
- Manual verification: `pnpm dev:all`, `pnpm preview:server`, `./dc dev`
