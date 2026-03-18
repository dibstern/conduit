# Architecture Reorganisation Design

**Date:** 2026-03-06 (updated 2026-03-08)
**Status:** Approved

## Problem

`src/lib/` contains 61 flat files with no subdirectory grouping. Related files (daemon-*, cli-*, sse-*, session-*) sit alongside unrelated ones. `daemon.ts` is a 1,079-line god class. CLI modules are misplaced in `lib/` instead of a CLI-specific directory. Tests are 113 flat files mirroring the flat source structure.

## Prior Work

Since this design was first written, two related efforts have completed:

- **Strict type checking** (8 commits): Added 4 compiler flags, created `handlers/payloads.ts` with typed handler payloads, typed all `RelayMessage` variants, added `noNonNullAssertion` lint rule. Touched 195 files.
- **Bandaid fix remediation** (11 commits): Created `constants.ts`, `public/ui-constants.ts`, type declarations, `test/helpers/mock-factories.ts`. Replaced casts, silent catches, dead code, magic numbers.
- **ProjectInfo collision resolved**: Server-side type renamed to `StoredProject`. Canonical `ProjectInfo` now in `shared-types.ts`, re-exported by both `types.ts` and `public/types.ts`.

These changes affect file contents and line numbers but do not change the directory structure plan.

## Approach

**Full structural cleanup** — group the flat files into logical subdirectories, decompose the daemon god class, extract misplaced utility, rename `public/` to `frontend/`, and restructure tests to mirror the new source layout. Executed in 5 independent phases.

## New Directory Structure

```
src/lib/
├── shared-types.ts               # Universal relay message types
├── types.ts                      # IPC command/response types, StoredProject, etc.
├── errors.ts                     # Error classes + formatErrorDetail
├── env.ts                        # Environment configuration
├── auth.ts                       # AuthManager + hashPin (3-group: cli, daemon, server)
├── constants.ts                  # DEFAULT_OPENCODE_PORT, DEFAULT_OPENCODE_URL
├── version.ts                    # Package version loader
├── vite-env.d.ts                 # Ambient Vite type declaration
│
├── cli/                          # CLI interactive menu modules
│   ├── cli-menu.ts
│   ├── cli-setup.ts
│   ├── cli-notifications.ts
│   ├── cli-projects.ts
│   ├── cli-settings.ts
│   ├── cli-watcher.ts
│   ├── prompts.ts
│   ├── terminal-render.ts
│   └── tls.ts                    # Tailscale IP detection (only CLI imports it)
│
├── daemon/                       # Background daemon process
│   ├── daemon.ts                 # Daemon class (slimmed ~1079 → ~400 lines)
│   ├── daemon-projects.ts        # NEW: project CRUD + relay wiring
│   ├── daemon-lifecycle.ts       # NEW: start/shutdown/HTTP/IPC lifecycle
│   ├── daemon-ipc.ts
│   ├── daemon-spawn.ts
│   ├── daemon-utils.ts
│   ├── config-persistence.ts
│   ├── crash-counter.ts
│   ├── pid-manager.ts
│   ├── signal-handlers.ts
│   ├── ipc-protocol.ts           # generateSlug() removed → utils.ts
│   ├── keep-awake.ts             # Prevent sleep during agent tasks
│   ├── recent-projects.ts        # Recent project tracking
│   ├── storage-monitor.ts        # Disk space monitoring
│   └── version-check.ts          # npm update checking
│
├── relay/                        # Per-project relay pipeline
│   ├── relay-stack.ts
│   ├── event-pipeline.ts
│   ├── event-translator.ts
│   ├── opencode-events.ts
│   ├── sse-consumer.ts
│   ├── sse-wiring.ts
│   ├── sse-backoff.ts
│   ├── message-cache.ts
│   ├── message-poller.ts
│   ├── message-poller-manager.ts
│   ├── tool-content-store.ts
│   ├── truncate-content.ts
│   ├── pty-manager.ts            # PTY session management
│   └── relay-settings.ts         # Relay settings loader
│
├── server/                       # HTTP/WebSocket server
│   ├── server.ts
│   ├── http-router.ts
│   ├── http-utils.ts
│   ├── ws-handler.ts
│   ├── ws-router.ts
│   ├── static-files.ts
│   ├── push.ts                   # Push notification delivery
│   ├── theme-loader.ts           # Theme file loading
│   └── rate-limiter.ts
│
├── session/                      # Session management
│   ├── session-manager.ts
│   ├── session-overrides.ts
│   └── session-status-poller.ts
│
├── instance/                     # OpenCode instance management
│   ├── instance-manager.ts
│   └── opencode-client.ts
│
├── bridges/                      # Server ↔ frontend bridges
│   ├── permission-bridge.ts
│   ├── question-bridge.ts
│   └── client-init.ts
│
├── handlers/                     # (unchanged) WS message dispatch
│   ├── index.ts
│   ├── payloads.ts               # PayloadMap typed handler infrastructure
│   ├── types.ts
│   └── ... (individual handler files)
│
├── frontend/                     # (renamed from public/) Svelte SPA
│   ├── ui-constants.ts           # Frontend timing constants
│   ├── safari-navigator.d.ts     # Navigator.standalone type
│   └── ... (existing Svelte app)
│
├── themes/                       # (unchanged) Theme JSON files
│
└── utils.ts                      # NEW: generateSlug + cross-cutting utilities
```

### Files at root (8)

Cross-cutting concerns imported by 3+ groups or ambient declarations: `shared-types.ts`, `types.ts`, `errors.ts`, `env.ts`, `auth.ts`, `constants.ts`, `version.ts`, `vite-env.d.ts`.

### Key group assignment decisions

| File | Group | Rationale |
|---|---|---|
| `auth.ts` | **root** | Imported by cli (`hashPin`), daemon (`AuthManager`), server (`AuthManager`) — 3 groups |
| `tls.ts` | **cli/** | Only imported by `cli-commands.ts` and `cli-notifications.ts` |
| `push.ts` | **server/** | Server infrastructure (VAPID keys, web-push). Type-imported by relay/daemon but runtime import via dynamic `import()` |
| `theme-loader.ts` | **server/** | Only imported by `http-router.ts` (serves themes via HTTP) |
| `pty-manager.ts` | **relay/** | Used by `relay-stack.ts`, `client-init.ts`, `handlers/types.ts` — all relay-layer |
| `relay-settings.ts` | **relay/** | Used by `relay-stack.ts` and `handlers/model.ts` |
| `keep-awake.ts` | **daemon/** | Only used by `daemon.ts` |
| `recent-projects.ts` | **daemon/** | Used by `cli-setup.ts` and `config-persistence.ts` (both daemon-adjacent) |
| `storage-monitor.ts` | **daemon/** | Only used by `daemon.ts` |
| `version-check.ts` | **daemon/** | Only used by `daemon.ts` |

### Rename: public/ → frontend/

`src/lib/public/` → `src/lib/frontend/` to accurately describe the Svelte SPA. Build output `dist/public` → `dist/frontend`. Updates needed in vite.config.ts, server.ts, daemon.ts, storybook config, and package.json scripts.

## Daemon Decomposition

### Extractions from daemon.ts

**daemon-projects.ts (NEW, ~300 lines):**
- `addProject()` — project validation, slug generation, relay wiring config
- `removeProject()` — relay teardown, map cleanup
- `discoverProjects()` — auto-discover from OpenCode's session list
- `getProjectList()` — serialise projects for status/IPC

**daemon-lifecycle.ts (NEW, ~250 lines):**
- `startHttpServer()` — HTTP server creation (use RelayServer or raw createServer)
- `startIpcServer()` — Unix socket IPC server creation
- `shutdown()` — graceful shutdown orchestration
- `closeHttp()`, `closeIPC()` — teardown helpers

**What remains in daemon.ts (~400 lines):**
- Constructor (instance manager, auth, config)
- `start()` — delegates to lifecycle + projects
- `status()` — status reporting
- `buildConfig()` — config serialisation
- Static spawn/isRunning delegation

## Type System Cleanup

### ~~ProjectInfo collision~~ (RESOLVED)

The collision between `types.ts` and `public/types.ts` has been fixed by prior work. The server-side type was renamed to `StoredProject` (with `lastUsed`). A canonical `ProjectInfo` (with `clientCount`) now lives in `shared-types.ts` and is re-exported by both files.

### Re-export boilerplate

Replace manual import-then-re-export in `frontend/types.ts` with direct re-export:
```ts
export type { AgentInfo, ... } from "../shared-types.js";
```

### generateSlug() extraction

Move from `ipc-protocol.ts` to new `src/lib/utils.ts`.

## Test Restructuring

Mirror new `src/lib/` subdirectories in `test/unit/`:

```
test/unit/
├── cli/         ← cli-*.test.ts, prompts.test.ts, tls.test.ts
├── daemon/      ← daemon*.test.ts, config-persistence.test.ts, ipc-protocol*.test.ts,
│                  keep-awake.test.ts, recent-projects*.test.ts, storage-monitor.test.ts,
│                  version-check.test.ts, constants.test.ts
├── relay/       ← event-translator*.test.ts, sse-*.test.ts, message-*.test.ts,
│                  pty-manager.test.ts, relay-settings.test.ts
├── server/      ← http-router.test.ts, ws-*.test.ts, auth*.test.ts,
│                  push*.test.ts, theme-*.test.ts, server*.test.ts
├── session/     ← session-*.test.ts
├── instance/    ← instance-*.test.ts
├── bridges/     ← permission-bridge*.test.ts, question-bridge*.test.ts, client-init.test.ts
├── handlers/    ← handlers-*.test.ts, message-handlers.test.ts, get-tool-content-handler.test.ts
├── stores/      ← svelte-*-store.test.ts (renamed: svelte-chat-store → chat.test.ts)
├── frontend/    ← svelte-*.test.ts (non-store), history-logic, diff, etc.
└── [root]       ← env.test.ts, errors*.test.ts, mock-factories.test.ts
```

Delete empty `test/fixture/` (keep `test/fixtures/`).

Note: `test/helpers/mock-factories.ts` exists and imports from several moved files — its import paths need updating in Phase 4.

## Implementation Phases

| Phase | What | Risk |
|---|---|---|
| P1 | Directory moves + import path updates + public→frontend rename | Low (mechanical) |
| P2 | Daemon decomposition (extract daemon-projects, daemon-lifecycle) | Medium (logic refactor) |
| P3 | Type cleanup (re-export simplification, generateSlug extraction) | Low (rename + move) |
| P4 | Test restructuring (mirror src/, rename svelte-* prefixed tests) | Low (mechanical) |
| P5 | Verify all tests pass, fix breakage, update AGENTS.md | Low (verification) |

Each phase is independently committable and reviewable.
