# Codebase Refactoring Design

**Goal:** Improve organization, readability, type safety, debuggability, and pre-commit bug prevention across the opencode-relay codebase.

**Approach:** Type safety first (highest bug-prevention value), then cleanup, then structural decomposition, then error handling consolidation.

---

## Section 1: Frontend Type Safety (WsMessage -> RelayMessage)

**Problem:** The server constructs fully-typed `RelayMessage` values (35+ variant discriminated union in `src/lib/types.ts`) and serializes them to JSON. The frontend deserializes into `WsMessage = { type: string; [key: string]: unknown }` (`src/lib/public/types.ts:336-339`), discarding all type information. Every store handler uses dangerous `as` casts to extract properties — ~120 of them across `chat.svelte.ts` (30), `ws.svelte.ts` (21), `terminal.svelte.ts` (11), `permissions.svelte.ts` (8), etc.

**Fix:**

1. Create `src/lib/shared-types.ts` containing the `RelayMessage` discriminated union and its constituent types. Move these out of `src/lib/types.ts` (which re-exports for backward compat).

2. Update frontend tsconfig to include the shared file:
   ```json
   "include": ["./**/*.ts", "./**/*.d.ts", "./**/*.svelte", "../../shared-types.ts"]
   ```

3. Replace `WsMessage` in `src/lib/public/types.ts`:
   ```typescript
   import type { RelayMessage } from "../../shared-types.js";
   export type WsMessage = RelayMessage;
   ```

4. Update WebSocket `onmessage` in `ws.svelte.ts` — `JSON.parse(event.data) as RelayMessage` becomes the single legitimate assertion point.

5. Update each store's handler functions to accept narrowed types:
   ```typescript
   // Before: dangerous cast
   function handleDelta(msg: WsMessage) {
     const text = msg.text as string;
   }
   // After: zero casts
   function handleDelta(msg: Extract<RelayMessage, { type: "delta" }>) {
     const { text } = msg;  // typed
   }
   ```

6. The `switch (msg.type)` dispatch in `ws.svelte.ts` naturally narrows each case to the specific variant.

**Eliminates:** ~120 dangerous `as` casts. Server-side changes to `RelayMessage` immediately produce frontend compile errors.

---

## Section 2: Shared Types & Deduplication

**Problem:** 9 types duplicated between `src/lib/types.ts` (server) and `src/lib/public/types.ts` (frontend). 6 are exact duplicates. 3 have silently diverged:
- `FileEntry`: Server has `modified?: number`, frontend has `children?: FileEntry[]`
- `SessionInfo`: Server uses `updatedAt: number` (required), frontend uses `updatedAt?: string | number` (optional)
- `AskUserQuestion`: Server requires `description`/`custom`, frontend makes both optional

**Fix:**

1. Move 6 identical types (`TodoStatus`, `TodoItem`, `AgentInfo`, `ProviderInfo`, `CommandInfo`, `ModelInfo`) into `shared-types.ts`. Both side re-export for backward compat.

2. For `SessionInfo` and `AskUserQuestion`, make the shared definition the superset (union of both sides' fields, looser optionality):
   ```typescript
   export interface SessionInfo {
     id: string;
     title: string;
     createdAt?: string | number;
     updatedAt?: string | number;
     messageCount?: number;
     processing?: boolean;
   }
   ```

3. For `FileEntry`, keep as two distinct types since they're semantically different:
   ```typescript
   // shared-types.ts
   export interface FileEntry {
     name: string;
     type: "file" | "directory";
     size?: number;
     modified?: number;
   }
   // src/lib/public/types.ts (frontend-only)
   export interface FileTreeEntry extends FileEntry {
     children?: FileTreeEntry[];
   }
   ```

---

## Section 3: Stricter TypeScript Configuration & Pre-commit

**Problem:** Three gaps:
1. `noUncheckedIndexedAccess` off — `record[key]` returns `T` instead of `T | undefined`
2. `pnpm check` only validates server types (root tsconfig excludes `src/lib/public/`)
3. Pre-commit hook misses frontend type errors

**Fix:**

1. Enable `noUncheckedIndexedAccess: true` in both tsconfigs. Fix resulting errors (~20-40 expected).

2. Add script:
   ```json
   "check:frontend": "tsc --noEmit --project src/lib/public/tsconfig.json"
   ```

3. Update existing script:
   ```json
   "check": "tsc --noEmit && tsc --noEmit --project src/lib/public/tsconfig.json"
   ```
   Lefthook pre-commit runs `pnpm check`, so frontend type checking is automatically included.

---

## Section 4: Dead Code Removal + Feature Wiring

### Delete (truly dead)

| Item | Location | Reason |
|------|----------|--------|
| `input-sync.ts` + test | `src/lib/input-sync.ts`, `test/unit/input-sync.pbt.test.ts` | Zero production imports. Feature works via `handleInputSync` in `message-handlers.ts` |
| 10 mockup HTML files | `src/lib/public/mockup*.html` (~185KB) | Design artifacts, never referenced |
| `handleFileCommand` + `file_command` type | `src/lib/message-handlers.ts:665-695`, `src/lib/ws-router.ts` | Duplicates `handleGetFileList`/`handleGetFileContent` which frontend actually uses |

### Wire up (planned features, complete implementations)

| Item | Location | How |
|------|----------|-----|
| `VersionChecker` | `src/lib/version-check.ts` | Instantiate in daemon, call `start()` on startup, broadcast `update_available` to browsers. Ticket 3.4. |
| `KeepAwake` | `src/lib/keep-awake.ts` | Instantiate in daemon, `activate()` when session processes, `deactivate()` when done. IPC/config scaffolding already exists. Ticket 3.5. |
| `isPermissionRepliedEvent()` | `src/lib/opencode-events.ts:163-176` | Replace raw string check in `sse-wiring.ts:146` with type guard, matching pattern for all other events. |

### Keep (planned for error handling — Section 6)

`WebSocketError`, `AuthenticationError`, `ConfigurationError`, `wrapError()`, `redactSensitive()` — all from `errors.ts`. Planned for adoption in Section 6.

### Check

`cli-watcher.ts` — exists but never imported by `cli-core.ts`. Verify if planned or dead.

---

## Section 5: Large File Decomposition

### 5A. SetupPage.svelte (990 lines) -> ~100 line parent

| Extract to | ~Lines | Contents |
|-----------|--------|----------|
| `SetupStepTailscale.svelte` | 130 | Tailscale detection, instructions, status |
| `SetupStepCert.svelte` | 150 | Certificate install per-platform |
| `SetupStepPwa.svelte` | 220 | PWA install with platform-specific icons/instructions |
| `SetupStepPush.svelte` | 80 | Push notification subscription |
| `SetupStepDone.svelte` | 20 | Completion screen |
| `StatusBadge.svelte` | 30 | Shared ok/warn/pending badge (currently copy-pasted 4x) |
| `SetupProgress.svelte` | 15 | Progress bar |
| `setup-utils.ts` | 90 | Platform detection, step list builder |

### 5B. ws.svelte.ts (630 lines) -> ~250 line core

| Extract to | ~Lines | Contents |
|-----------|--------|----------|
| `ws-dispatch.ts` | 250 | `handleMessage()` switch + `replayEvents()` + error/banner handlers |
| `ws-notifications.ts` | 70 | `triggerNotifications()`, `NOTIF_TYPES`, push-active tracking |
| Listener factory (inline) | 30 | Replace 6 copy-pasted listener registries with `createListenerSet()` |

### 5C. daemon.ts (934 lines) -> ~450 line core

| Extract to | ~Lines | Contents |
|-----------|--------|----------|
| `daemon-ipc.ts` | 150 | IPC server setup, command routing, socket management |
| `daemon-spawn.ts` | 170 | Static methods: `isRunning()`, `buildSpawnConfig()`, `spawn()` |

VersionChecker + KeepAwake wiring (Section 4) gets added to daemon.ts as part of this.

### 5D. message-handlers.ts (923 lines) -> ~80 line barrel

| Extract to | ~Lines | Handlers |
|-----------|--------|----------|
| `handlers/sessions.ts` | 170 | new, switch, delete, rename, list, search, loadMoreHistory |
| `handlers/terminal.ts` | 200 | createAndConnectPty, terminalCommand, ptyCreate/Input/Resize/Close |
| `handlers/discovery.ts` | 120 | getAgents, switchAgent, getModels, switchModel, getCommands |
| `handlers/files.ts` | 65 | getFileList, getFileContent |
| `handlers/permissions.ts` | 65 | permissionResponse, askUserResponse, questionReject |
| `handlers/projects.ts` | 70 | getProjects, addProject |
| `handlers/session-actions.ts` | 60 | cancel, rewind, inputSync, getTodo |
| `handlers/chat.ts` | 60 | handleMessage |

### 5E. cli-core.ts (1006 lines) -> ~525 line core

| Extract to | ~Lines | Contents |
|-----------|--------|----------|
| `cli-commands.ts` | 220 | 7 IPC-based handlers (status, stop, pin, add, remove, list, title) + `findSlugForCwd()` + `ensureDaemonRunning()` |
| `cli-daemon-handlers.ts` | 50 | daemon + foreground command handlers |
| `cli-utils.ts` | 80 | `sendIPCCommand()`, `getNetworkAddress()`, `generateQR()`, `formatUptime()`, `openUrl()` |

---

## Section 6: Error Handling — Consolidation + Ticket 6.2 (AC1-4, AC6)

### Part A: Infrastructure Consolidation

**Problem:** Three patterns coexist for WebSocket error responses:
1. Typed error classes (`errors.ts`) with `.toWebSocket()` — classes exist but are never used
2. `buildErrorResponse()` helper (`error-response.ts`) — used by handlers
3. Inline `{ type: "error", code, message }` objects — scattered across handlers

**Fix:**
1. Remove `buildErrorResponse()` from `error-response.ts`
2. Use error classes in handlers: `new WebSocketError("NO_SESSION", "...").toWebSocket()`
3. Add `ErrorCode` string literal union to `shared-types.ts`
4. Wire `redactSensitive()` into error logging path

### Part B: Ticket 6.2 (AC1, AC2, AC3, AC4, AC6)

**AC1 + AC2 — OpenCode connection lifecycle:**
- Add connection state tracking that broadcasts `{ type: "connection_status", status: "disconnected" | "reconnecting" | "connected" }` to browsers when SSE state changes
- Frontend handles this to show/hide banner ("OpenCode disconnected, retrying..." / "Reconnected")
- On startup with no OpenCode, show error state with guidance ("Start OpenCode with: `opencode serve`")

**AC3 — Browser reconnection:**
- Verify `client-init.ts` replays cached events on reconnect
- Verify pending permissions/questions re-sent
- Add integration test if missing

**AC4 — Duplicate permissions:**
- Verify `PermissionBridge` ignores duplicate responses
- Add unit test if missing

**AC6 — Invalid WebSocket messages:**
- Verify `ws-router.ts` returns error without disconnecting
- Ensure errors use standardized error classes from Part A

### Deferred (AC5, AC7, AC8)
- AC5: Large tool result truncation
- AC7: Rate limiting on message sends
- AC8: Disk space monitoring + cache eviction

---

## Implementation Order

1. **Section 2** — shared-types.ts (foundation for everything else)
2. **Section 1** — RelayMessage on frontend (depends on shared-types)
3. **Section 3** — Stricter tsconfig + pre-commit (after type migration settles)
4. **Section 4** — Dead code removal + feature wiring
5. **Section 5** — File decomposition
6. **Section 6** — Error handling consolidation + ticket 6.2
