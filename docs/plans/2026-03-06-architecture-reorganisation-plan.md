# Architecture Reorganisation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorganise the flat `src/lib/` (61 files) into logical subdirectories, decompose the daemon god class, extract `generateSlug()`, rename `public/` to `frontend/`, and restructure tests.

**Architecture:** Move files into `cli/`, `daemon/`, `relay/`, `server/`, `session/`, `instance/`, `bridges/` subdirectories, leaving 8 shared files at root. Extract `daemon-projects.ts` and `daemon-lifecycle.ts` from `daemon.ts`. Move `generateSlug()` to `utils.ts`. Rename `public/` → `frontend/`.

**Tech Stack:** TypeScript, Svelte 5, Vite, Vitest, Playwright, pnpm

**Design doc:** `docs/plans/2026-03-06-architecture-reorganisation-design.md`

---

## Prerequisites completed

The following work has been completed since this plan was originally written. It affects file contents, import paths, and line numbers throughout:

1. **Strict type checking** (8 commits, 195 files modified): Added `noImplicitReturns`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` to tsconfig. Created `handlers/payloads.ts` with `PayloadMap` typed handler infrastructure. Typed all `RelayMessage` `unknown` fields. Typed all handler functions. Added `noNonNullAssertion` lint rule.

2. **Bandaid fix remediation** (11 commits): Created `constants.ts`, `public/ui-constants.ts`, `public/safari-navigator.d.ts`, `vite-env.d.ts`. Created `test/helpers/mock-factories.ts`. Replaced production type casts, silent error catches, dead code, magic numbers, console.debug statements. Replaced test `setTimeout` workarounds. Fixed Storybook type patterns.

3. **ProjectInfo collision resolved**: The old collision between `types.ts` (server: `slug, directory, title, lastUsed?, instanceId?`) and `public/types.ts` (frontend: `slug, title, directory, clientCount?, instanceId?`) no longer exists. The server-side type was renamed to `StoredProject` in `types.ts`. A canonical `ProjectInfo` now lives in `shared-types.ts` and is re-exported by both `types.ts` and `public/types.ts`.

**Impact on this plan:**
- File count is now **61** (was 63), due to extractions offset by new file creations
- All line numbers referenced in the original plan have shifted — use grep-based discovery, not fixed line numbers
- Phase 3, Task 3.1 (rename frontend `ProjectInfo`) is **removed** — the collision is already fixed
- New files (`constants.ts`, `vite-env.d.ts`, `handlers/payloads.ts`, etc.) need correct group assignment
- Test count is now **113** (was 108)
- `test/helpers/mock-factories.ts` already exists — import paths in it need updating in Phase 4

---

## Phase 1: Directory Moves + Import Path Updates

This phase is purely mechanical — move files, update all import paths. No logic changes.

**Note:** Use `git mv` for all moves to preserve git history. Line numbers throughout this plan are advisory — always grep for actual import paths rather than relying on fixed line numbers.

### Files remaining at root (8)

These files are imported by 3+ groups or are ambient declarations. They do NOT move:

| File | Reason |
|---|---|
| `shared-types.ts` | Universal — imported everywhere |
| `types.ts` | Universal — used by cli, daemon, relay, server |
| `errors.ts` | Universal — used by cli, daemon, relay, session, instance |
| `env.ts` | Universal — used by cli, daemon, relay, server |
| `auth.ts` | 3 groups: cli (`bin/cli-commands.ts` imports `hashPin`), daemon (`daemon.ts`), server (`server.ts`, `http-router.ts`) |
| `constants.ts` | 2+ groups: daemon, instance/relay (`opencode-client.ts`) |
| `version.ts` | 2+ groups: server (`http-router.ts`), daemon (via `version-check.ts`) |
| `vite-env.d.ts` | Ambient type declaration (consumed by tsconfig, not imported) |

### Task 1.1: Create subdirectory structure

**Step 1:** Create all directories:
```bash
mkdir -p src/lib/{cli,daemon,relay,server,session,instance,bridges}
```

**Step 2:** Verify:
```bash
ls -d src/lib/*/
```
Expected: bridges, cli, daemon, handlers, instance, public, relay, server, session, themes

### Task 1.2: Move CLI files to src/lib/cli/

**Files to move (9):**
- `src/lib/cli-menu.ts` → `src/lib/cli/cli-menu.ts`
- `src/lib/cli-setup.ts` → `src/lib/cli/cli-setup.ts`
- `src/lib/cli-notifications.ts` → `src/lib/cli/cli-notifications.ts`
- `src/lib/cli-projects.ts` → `src/lib/cli/cli-projects.ts`
- `src/lib/cli-settings.ts` → `src/lib/cli/cli-settings.ts`
- `src/lib/cli-watcher.ts` → `src/lib/cli/cli-watcher.ts`
- `src/lib/prompts.ts` → `src/lib/cli/prompts.ts`
- `src/lib/terminal-render.ts` → `src/lib/cli/terminal-render.ts`
- `src/lib/tls.ts` → `src/lib/cli/tls.ts`

**Step 1:** Move all files with `git mv`.

**Step 2:** Update imports in moved files. Files within cli/ referencing each other keep `./` paths. Files referencing root-level or other-group files need updated paths:
- All cli files importing from root lib files: `./env.js` → `../env.js`, `./types.js` → `../types.js`, etc.
- `cli-notifications.ts` imports `./auth.js` → `../auth.js` (auth stays at root)
- `cli-notifications.ts` imports `./tls.js` → stays `./tls.js` (same dir now)
- `cli-setup.ts` imports `./config-persistence.js` → `../daemon/config-persistence.js`
- `cli-setup.ts` imports `./recent-projects.js` → `../daemon/recent-projects.js`
- `cli-watcher.ts` imports `./config-persistence.js` → `../daemon/config-persistence.js`

**Step 3:** Update imports in files that import CLI modules:
- `src/bin/cli-commands.ts`: `../lib/cli-menu.js` → `../lib/cli/cli-menu.js` (and similar for cli-notifications, cli-projects, cli-settings, cli-setup, tls)
- `src/bin/cli-core.ts`: no cli imports (imports daemon, env, errors, types)

**Step 4:** Update test imports:
- `test/unit/cli-menu.test.ts`: `../../src/lib/cli-menu.js` → `../../src/lib/cli/cli-menu.js`
- Same pattern for all cli test files
- `test/unit/tls.test.ts`: update import path

**Step 5:** Run type check:
```bash
pnpm check
```

### Task 1.3: Move daemon files to src/lib/daemon/

**Files to move (13):**
- `src/lib/daemon.ts` → `src/lib/daemon/daemon.ts`
- `src/lib/daemon-ipc.ts` → `src/lib/daemon/daemon-ipc.ts`
- `src/lib/daemon-spawn.ts` → `src/lib/daemon/daemon-spawn.ts`
- `src/lib/daemon-utils.ts` → `src/lib/daemon/daemon-utils.ts`
- `src/lib/config-persistence.ts` → `src/lib/daemon/config-persistence.ts`
- `src/lib/crash-counter.ts` → `src/lib/daemon/crash-counter.ts`
- `src/lib/pid-manager.ts` → `src/lib/daemon/pid-manager.ts`
- `src/lib/signal-handlers.ts` → `src/lib/daemon/signal-handlers.ts`
- `src/lib/ipc-protocol.ts` → `src/lib/daemon/ipc-protocol.ts`
- `src/lib/keep-awake.ts` → `src/lib/daemon/keep-awake.ts`
- `src/lib/recent-projects.ts` → `src/lib/daemon/recent-projects.ts`
- `src/lib/storage-monitor.ts` → `src/lib/daemon/storage-monitor.ts`
- `src/lib/version-check.ts` → `src/lib/daemon/version-check.ts`

**Step 1:** Move all files with `git mv`.

**Step 2:** Update imports within moved files. Files within daemon/ that reference each other keep `./` paths. Files referencing other groups need updated paths:
- `daemon.ts` imports `./auth.js` → `../auth.js` (root)
- `daemon.ts` imports `./http-router.js` → `../server/http-router.js`
- `daemon.ts` imports `./instance-manager.js` → `../instance/instance-manager.js`
- `daemon.ts` imports `./relay-stack.js` → `../relay/relay-stack.js`
- `daemon.ts` imports `./env.js` → `../env.js`
- `daemon.ts` imports `./types.js` → `../types.js`
- `daemon.ts` imports `./constants.js` → `../constants.js`
- `daemon.ts` imports `./push.js` → `../server/push.js`
- `version-check.ts` imports `./version.js` → `../version.js`
- `recent-projects.ts` imports `./types.js` → `../types.js`
- etc. — grep each moved file's imports

**Step 3:** Update external importers:
- `src/bin/cli-core.ts`: `../lib/daemon.js` → `../lib/daemon/daemon.js`
- `src/bin/cli-utils.ts`: `../lib/ipc-protocol.js` → `../lib/daemon/ipc-protocol.js` (if imported; check)
- `src/lib/cli/cli-watcher.ts`: update config-persistence import (already handled in Task 1.2)
- `src/lib/cli/cli-setup.ts`: update config-persistence, recent-projects imports (already handled in Task 1.2)
- `src/lib/relay/relay-stack.ts`: update ipc-protocol import (once relay is moved)

**Step 4:** Update test imports (all `test/unit/daemon*.test.ts`, `test/unit/config-persistence.test.ts`, `test/unit/ipc-protocol*.test.ts`, `test/unit/keep-awake.test.ts`, `test/unit/recent-projects*.test.ts`, `test/unit/storage-monitor.test.ts`, `test/unit/version-check.test.ts`, etc.)

**Step 5:** Run type check:
```bash
pnpm check
```

### Task 1.4: Move relay files to src/lib/relay/

**Files to move (14):**
- `src/lib/relay-stack.ts` → `src/lib/relay/relay-stack.ts`
- `src/lib/event-pipeline.ts` → `src/lib/relay/event-pipeline.ts`
- `src/lib/event-translator.ts` → `src/lib/relay/event-translator.ts`
- `src/lib/opencode-events.ts` → `src/lib/relay/opencode-events.ts`
- `src/lib/sse-consumer.ts` → `src/lib/relay/sse-consumer.ts`
- `src/lib/sse-wiring.ts` → `src/lib/relay/sse-wiring.ts`
- `src/lib/sse-backoff.ts` → `src/lib/relay/sse-backoff.ts`
- `src/lib/message-cache.ts` → `src/lib/relay/message-cache.ts`
- `src/lib/message-poller.ts` → `src/lib/relay/message-poller.ts`
- `src/lib/message-poller-manager.ts` → `src/lib/relay/message-poller-manager.ts`
- `src/lib/tool-content-store.ts` → `src/lib/relay/tool-content-store.ts`
- `src/lib/truncate-content.ts` → `src/lib/relay/truncate-content.ts`
- `src/lib/pty-manager.ts` → `src/lib/relay/pty-manager.ts`
- `src/lib/relay-settings.ts` → `src/lib/relay/relay-settings.ts`

**Step 1:** Move files with `git mv`.

**Step 2:** Update internal imports (relay files referencing each other → `./`).

**Step 3:** Update cross-group imports:
- `relay-stack.ts` is the hub — imports from server/, session/, instance/, bridges/, daemon/, plus root types. All need `../group/file.js` paths.
- `sse-wiring.ts` imports from session, bridges, server (push)
- `event-translator.ts` imports from opencode-events (same group → `./`)
- `relay-settings.ts` imports from `./env.js` → `../env.js`, `./session-overrides.js` → `../session/session-overrides.js`

**Step 4:** Update external importers:
- `src/lib/daemon/daemon.ts`: `./relay-stack.js` → `../relay/relay-stack.js`
- `src/lib/bridges/client-init.ts`: import paths for relay modules
- `src/lib/handlers/types.ts`: update pty-manager import path
- `src/lib/handlers/model.ts`: update relay-settings import path
- `test/helpers/mock-factories.ts`: update tool-content-store import path

**Step 5:** Update test imports. Run type check.

### Task 1.5: Move server files to src/lib/server/

**Files to move (9):**
- `src/lib/server.ts` → `src/lib/server/server.ts`
- `src/lib/http-router.ts` → `src/lib/server/http-router.ts`
- `src/lib/http-utils.ts` → `src/lib/server/http-utils.ts`
- `src/lib/ws-handler.ts` → `src/lib/server/ws-handler.ts`
- `src/lib/ws-router.ts` → `src/lib/server/ws-router.ts`
- `src/lib/static-files.ts` → `src/lib/server/static-files.ts`
- `src/lib/push.ts` → `src/lib/server/push.ts`
- `src/lib/theme-loader.ts` → `src/lib/server/theme-loader.ts`
- `src/lib/rate-limiter.ts` → `src/lib/server/rate-limiter.ts`

Note: `auth.ts` and `tls.ts` do NOT move here — `auth.ts` stays at root (3-group usage), `tls.ts` goes to cli/ (only imported by cli-layer files).

**Step 1:** Move files with `git mv`.

**Step 2:** Update internal imports (server files referencing each other → `./`).

**Step 3:** Update cross-group imports:
- `http-router.ts` imports auth (→ `../auth.js`), static-files (stays `./`), push (stays `./`), version (→ `../version.js`), theme-loader (stays `./`)
- `server.ts` imports auth (→ `../auth.js`), http-router (stays `./`), env (→ `../env.js`), push type (stays `./`)
- `push.ts` imports env (→ `../env.js`)

**Step 4:** Update external importers:
- `src/lib/daemon/daemon.ts`: `./server.js` → `../server/server.js`, `./http-router.js` → `../server/http-router.js`, `./push.js` → `../server/push.js`
- `src/lib/relay/relay-stack.ts`: update server, ws-handler, push imports
- `src/lib/relay/sse-wiring.ts`: update push import
- Various handlers that import ws-handler, ws-router

**Step 5:** Update test imports. Run type check.

### Task 1.6: Move session, instance, and bridges files

**Session files (3):**
- `src/lib/session-manager.ts` → `src/lib/session/session-manager.ts`
- `src/lib/session-overrides.ts` → `src/lib/session/session-overrides.ts`
- `src/lib/session-status-poller.ts` → `src/lib/session/session-status-poller.ts`

**Instance files (2):**
- `src/lib/instance-manager.ts` → `src/lib/instance/instance-manager.ts`
- `src/lib/opencode-client.ts` → `src/lib/instance/opencode-client.ts`

**Bridges files (3):**
- `src/lib/permission-bridge.ts` → `src/lib/bridges/permission-bridge.ts`
- `src/lib/question-bridge.ts` → `src/lib/bridges/question-bridge.ts`
- `src/lib/client-init.ts` → `src/lib/bridges/client-init.ts`

**Step 1:** Move all files with `git mv`.
**Step 2:** Update internal and cross-group imports.
**Step 3:** Update external importers (relay-stack, daemon, handlers, sse-wiring, etc.)
**Step 4:** Update test imports, including `test/helpers/mock-factories.ts` which imports from `client-init.ts`, `sse-wiring.ts`, `handlers/types.ts`, and `tool-content-store.ts`.
**Step 5:** Run type check.

### Task 1.7: Rename public/ → frontend/

**Step 1:** Rename directory:
```bash
git mv src/lib/public src/lib/frontend
```

**Step 2:** Update `vite.config.ts` (4 changes):
- `root: "src/lib/public"` → `root: "src/lib/frontend"`
- Build `outDir: "../../../dist/public"` → `"../../../dist/frontend"`
- Build input index: `"src/lib/public/index.html"` → `"src/lib/frontend/index.html"`
- Build input sw: `"src/lib/public/sw.ts"` → `"src/lib/frontend/sw.ts"`

**Step 3:** Update `tsconfig.json` (root):
- `"exclude": ["node_modules", "dist", "src/lib/public"]` → `"src/lib/frontend"`

**Step 4:** Update `package.json` scripts:
- `check:frontend`: `tsc --noEmit --project src/lib/public/tsconfig.json` → `src/lib/frontend/tsconfig.json`
- `check` script (if it references public path inline)

**Step 5:** Update `.storybook/main.ts`:
- `stories: ["../src/lib/public/**/*.stories.ts"]` → `["../src/lib/frontend/**/*.stories.ts"]`

**Step 6:** Update `staticDir` defaults (runtime paths to built output):
- `src/lib/server/server.ts`: `join(process.cwd(), "dist", "public")` → `"dist", "frontend"`
- `src/lib/daemon/daemon.ts`: `join(process.cwd(), "dist", "public")` → `"dist", "frontend"`
- Any test helpers that reference `dist/public`

**Step 7:** Update ~30 test files that import from `../../src/lib/public/` → `../../src/lib/frontend/`.

**Step 8:** Frontend internal imports (`../shared-types.js`) stay unchanged since the relative path from `frontend/` to `src/lib/` root is the same as from `public/`.

**Step 9:** Note: New files `safari-navigator.d.ts`, `ui-constants.ts`, and `vite-env.d.ts` (if it's in `public/`) move with the rename — no separate action needed.

**Step 10:** Run full check:
```bash
pnpm check && pnpm check:frontend
```

### Task 1.8: Full verification and commit

**Step 1:** Run type checks:
```bash
pnpm check && pnpm check:frontend
```

**Step 2:** Run unit tests:
```bash
pnpm test:unit
```

**Step 3:** Run lint:
```bash
pnpm lint
```

**Step 4:** Fix any lint/type errors from the moves.

**Step 5:** Commit:
```bash
git add -A
git commit -m "refactor: reorganise src/lib/ into logical subdirectories

Move 53 files into cli/, daemon/, relay/, server/, session/,
instance/, bridges/ subdirectories. 8 shared files remain at root.
Rename public/ to frontend/. All import paths updated. No logic changes."
```

---

## Phase 2: Daemon Decomposition

daemon.ts is currently 1,079 lines. Earlier decomposition (commit cc8c105) already extracted `crash-counter.ts`, `pid-manager.ts`, `signal-handlers.ts`, and `daemon-utils.ts` for infrastructure concerns. This phase extracts the remaining domain logic.

### Task 2.1: Extract daemon-projects.ts

**Files:**
- Create: `src/lib/daemon/daemon-projects.ts`
- Modify: `src/lib/daemon/daemon.ts`
- Test: existing daemon tests should still pass

**Step 1:** Read `daemon.ts` methods: `addProject()`, `removeProject()`, `discoverProjects()`, and `getProjectList()` helper. Identify all dependencies on `this`.

**Step 2:** Create `src/lib/daemon/daemon-projects.ts` with:
- A `DaemonProjectContext` interface (the deps needed from Daemon)
- `addProject(ctx, directory, instanceId?)` function
- `removeProject(ctx, slugOrDir)` function
- `discoverProjects(ctx)` function
- `getProjectList(ctx)` function

**Step 3:** Update `daemon.ts` to import and delegate to the new functions, passing `this` context through the interface.

**Step 4:** Run tests:
```bash
pnpm test:unit -- --grep daemon
```

**Step 5:** Commit:
```bash
git commit -m "refactor: extract project management from daemon into daemon-projects.ts"
```

### Task 2.2: Extract daemon-lifecycle.ts

**Files:**
- Create: `src/lib/daemon/daemon-lifecycle.ts`
- Modify: `src/lib/daemon/daemon.ts`

**Step 1:** Read `daemon.ts` methods: `start()` (HTTP + IPC setup), `shutdown()`, `closeHttp()`, `closeIPC()`.

**Step 2:** Create `src/lib/daemon/daemon-lifecycle.ts` with:
- `startHttpServer(ctx)` — HTTP server creation
- `startIpcServer(ctx)` — IPC Unix socket server
- `shutdownDaemon(ctx)` — graceful shutdown orchestration
- `closeHttpServer(server)` — HTTP teardown
- `closeIpcServer(server, clients)` — IPC teardown

**Step 3:** Update `daemon.ts` to delegate lifecycle to the new module.

**Step 4:** Run tests:
```bash
pnpm test:unit -- --grep daemon
```

**Step 5:** Commit:
```bash
git commit -m "refactor: extract daemon lifecycle management into daemon-lifecycle.ts"
```

### Task 2.3: Verify daemon decomposition

**Step 1:** Check `daemon.ts` line count — should be ~400 lines.

**Step 2:** Run full test suite:
```bash
pnpm test
```

**Step 3:** Commit if any fixups needed.

---

## Phase 3: Type System Cleanup

### Task 3.1: Clean up re-export boilerplate in frontend/types.ts

**Files:**
- Modify: `src/lib/frontend/types.ts`

**Step 1:** Replace the two-step import-then-re-export block with a direct re-export:
```ts
// Before:
import type { AgentInfo, ... } from "../shared-types.js";
export type { AgentInfo, ... };

// After:
export type { AgentInfo, AskUserQuestion, CommandInfo, FileEntry, FileVersion, HistoryMessage, HistoryMessagePart, InstanceStatus, ModelInfo, OpenCodeInstance, ProjectInfo, ProviderInfo, PtyInfo, RelayMessage, SessionInfo, TodoItem, TodoStatus, UsageInfo } from "../shared-types.js";
```

**Step 2:** Run type check:
```bash
pnpm check:frontend
```

**Step 3:** Commit:
```bash
git commit -m "refactor: simplify shared-types re-exports in frontend/types.ts"
```

### Task 3.2: Extract generateSlug to utils.ts

**Files:**
- Create: `src/lib/utils.ts`
- Modify: `src/lib/daemon/ipc-protocol.ts`
- Modify: files that import `generateSlug` from `ipc-protocol.ts`

**Step 1:** Create `src/lib/utils.ts` with the `generateSlug()` function (copy from ipc-protocol.ts).

**Step 2:** Remove `generateSlug()` from `ipc-protocol.ts`.

**Step 3:** Update importers:
```bash
rg 'generateSlug' src/
```
Update their imports to point to `../utils.js` or `./utils.js` as appropriate.

**Step 4:** Run tests:
```bash
pnpm test:unit
```

**Step 5:** Commit:
```bash
git commit -m "refactor: extract generateSlug from ipc-protocol to utils.ts"
```

---

## Phase 4: Test Restructuring

### Task 4.1: Create test subdirectories and move files

**Step 1:** Create directories:
```bash
mkdir -p test/unit/{cli,daemon,relay,server,session,instance,bridges,handlers,stores,frontend}
```

**Step 2:** Move test files to match source structure. Use `git mv` for all moves. Examples:
```bash
# CLI tests
git mv test/unit/cli-menu.test.ts test/unit/cli/
git mv test/unit/cli-setup.test.ts test/unit/cli/
git mv test/unit/cli.test.ts test/unit/cli/
git mv test/unit/cli-foreground.test.ts test/unit/cli/
git mv test/unit/cli-watcher.test.ts test/unit/cli/
git mv test/unit/prompts.test.ts test/unit/cli/
git mv test/unit/tls.test.ts test/unit/cli/
# ... etc

# Daemon tests
git mv test/unit/daemon.test.ts test/unit/daemon/
git mv test/unit/daemon-ipc.test.ts test/unit/daemon/ (if exists)
git mv test/unit/config-persistence.test.ts test/unit/daemon/
git mv test/unit/ipc-protocol*.test.ts test/unit/daemon/
git mv test/unit/keep-awake.test.ts test/unit/daemon/
git mv test/unit/recent-projects*.test.ts test/unit/daemon/
git mv test/unit/storage-monitor.test.ts test/unit/daemon/
git mv test/unit/version-check.test.ts test/unit/daemon/
# ... etc

# Relay tests
git mv test/unit/event-translator*.test.ts test/unit/relay/
git mv test/unit/sse-*.test.ts test/unit/relay/
git mv test/unit/message-*.test.ts test/unit/relay/
git mv test/unit/pty-manager.test.ts test/unit/relay/
git mv test/unit/relay-settings.test.ts test/unit/relay/
# ... etc

# Server tests
git mv test/unit/http-router.test.ts test/unit/server/
git mv test/unit/ws-*.test.ts test/unit/server/
git mv test/unit/auth*.test.ts test/unit/server/
git mv test/unit/push*.test.ts test/unit/server/
git mv test/unit/theme-*.test.ts test/unit/server/
git mv test/unit/server*.test.ts test/unit/server/
# ... etc

# Store tests (rename svelte- prefix)
git mv test/unit/svelte-chat-store.test.ts test/unit/stores/chat.test.ts
git mv test/unit/svelte-session-store.test.ts test/unit/stores/session.test.ts
# ... etc for all svelte-*-store.test.ts files

# Frontend tests
git mv test/unit/svelte-diff.test.ts test/unit/frontend/diff.test.ts
git mv test/unit/svelte-history-logic.test.ts test/unit/frontend/history-logic.test.ts
git mv test/unit/svelte-notifications.test.ts test/unit/frontend/notifications.test.ts
git mv test/unit/svelte-discovery-store.test.ts test/unit/frontend/discovery-store.test.ts
git mv test/unit/svelte-ui-store.test.ts test/unit/frontend/ui-store.test.ts
# ... etc

# New test files from bandaid work
git mv test/unit/constants.test.ts test/unit/daemon/  # or root, since constants stays at root
git mv test/unit/mock-factories.test.ts test/unit/  # stays at root (tests test/helpers/)
```

**Step 3:** Update import paths in all moved test files (`../../src/lib/foo.js` → `../../../src/lib/group/foo.js` for subdirectory tests, or `../../src/lib/group/foo.js` for root tests).

**Step 4:** Update `test/helpers/mock-factories.ts` import paths — this file imports from `../../src/lib/handlers/types.js`, `../../src/lib/sse-wiring.js`, `../../src/lib/client-init.js`, and `../../src/lib/tool-content-store.js`. Update to new locations:
- `../../src/lib/sse-wiring.js` → `../../src/lib/relay/sse-wiring.js`
- `../../src/lib/client-init.js` → `../../src/lib/bridges/client-init.js`
- `../../src/lib/tool-content-store.js` → `../../src/lib/relay/tool-content-store.js`
- `../../src/lib/handlers/types.js` → unchanged (handlers stays in place)

**Step 5:** Delete empty `test/fixture/` directory:
```bash
rmdir test/fixture
```

**Step 6:** Run all tests:
```bash
pnpm test
```

**Step 7:** Commit:
```bash
git commit -m "refactor: restructure test/unit/ to mirror src/lib/ subdirectories"
```

---

## Phase 5: Final Verification

### Task 5.1: Full test suite

**Step 1:** Run all tests and checks:
```bash
pnpm check && pnpm check:frontend && pnpm test && pnpm lint
```

**Step 2:** Build:
```bash
pnpm build
```

**Step 3:** Fix any remaining issues.

### Task 5.2: Update AGENTS.md

**Step 1:** Update AGENTS.md to reflect new directory structure and any changed test commands.

**Step 2:** Commit:
```bash
git commit -m "docs: update AGENTS.md for new directory structure"
```
