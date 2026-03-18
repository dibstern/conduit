# Codebase Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve type safety, organization, readability, and pre-commit bug prevention across the opencode-relay codebase.

**Architecture:** Create a shared-types module importable by both server and frontend. Replace the frontend's loosely-typed `WsMessage` with the server's typed `RelayMessage` discriminated union. Enable stricter TypeScript checks. Remove dead code, wire up planned features, decompose large files, and consolidate error handling.

**Tech Stack:** TypeScript, Svelte 5, Vitest, Biome, lefthook

---

### Task 1: Create shared-types.ts

**Files:**
- Create: `src/lib/shared-types.ts`
- Modify: `src/lib/types.ts`

**Step 1: Create `src/lib/shared-types.ts`**

Move the following types from `src/lib/types.ts` into the new file. These are the types referenced by `RelayMessage` or duplicated in the frontend:

```typescript
// src/lib/shared-types.ts
// ─── Shared Types ─────────────────────────────────────────────────────────
// Types shared between server and frontend. Both sides re-export these.

// ─── Todo ──────────────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	id: string;
	subject: string;
	description?: string;
	status: TodoStatus;
}

// ─── Discovery ─────────────────────────────────────────────────────────────

export interface AgentInfo {
	id: string;
	name: string;
	description?: string;
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	models: ModelInfo[];
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
}

export interface CommandInfo {
	name: string;
	description?: string;
	args?: string;
}

// ─── Session ───────────────────────────────────────────────────────────────

export interface SessionInfo {
	id: string;
	title: string;
	createdAt?: string | number;
	updatedAt?: string | number;
	messageCount?: number;
	processing?: boolean;
}

// ─── File Browser ──────────────────────────────────────────────────────────

export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
	modified?: number;
}

// ─── Questions ─────────────────────────────────────────────────────────────

export interface AskUserQuestion {
	question: string;
	header: string;
	options: { label: string; description?: string }[];
	multiSelect: boolean;
	custom?: boolean;
}

// ─── Usage ─────────────────────────────────────────────────────────────────

export interface UsageInfo {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

// ─── PTY ───────────────────────────────────────────────────────────────────

export interface PtyInfo {
	id: string;
	title: string;
	command: string;
	cwd: string;
	status: string;
	pid: number;
}

// ─── Relay WebSocket messages ──────────────────────────────────────────────

export type RelayMessage =
	// ── Streaming ──────────────────────────────────────────────────────────
	| { type: "delta"; text: string; messageId?: string }
	| { type: "thinking_start"; messageId?: string }
	| { type: "thinking_delta"; text: string; messageId?: string }
	| { type: "thinking_stop"; messageId?: string }
	// ── Tools ──────────────────────────────────────────────────────────────
	| { type: "tool_start"; id: string; name: string; messageId?: string }
	| {
			type: "tool_executing";
			id: string;
			name: string;
			input: unknown;
			messageId?: string;
	  }
	| {
			type: "tool_result";
			id: string;
			content: string;
			is_error: boolean;
			messageId?: string;
	  }
	// ── Permissions / Questions ────────────────────────────────────────────
	| {
			type: "permission_request";
			requestId: string;
			toolName: string;
			toolInput: Record<string, unknown>;
			toolUseId?: string;
	  }
	| { type: "permission_resolved"; requestId: string; decision: string }
	| { type: "ask_user"; toolId: string; questions: AskUserQuestion[] }
	| { type: "ask_user_resolved"; toolId: string }
	// ── Session lifecycle ──────────────────────────────────────────────────
	| {
			type: "result";
			usage: UsageInfo;
			cost: number;
			duration: number;
			sessionId: string;
	  }
	| { type: "status"; status: string }
	| { type: "done"; code: number }
	| {
			type: "session_switched";
			id: string;
			events?: RelayMessage[];
			history?: {
				messages: unknown[];
				hasMore: boolean;
				total?: number;
			};
	  }
	| { type: "session_list"; sessions: SessionInfo[] }
	| {
			type: "history_page";
			sessionId: string;
			messages: unknown[];
			hasMore: boolean;
			total?: number;
	  }
	// ── Model / Agent / Commands ───────────────────────────────────────────
	| { type: "model_info"; model: string; provider: string }
	| { type: "model_list"; providers: ProviderInfo[] }
	| { type: "agent_list"; agents: AgentInfo[] }
	| { type: "command_list"; commands: CommandInfo[] }
	// ── Projects ───────────────────────────────────────────────────────────
	| { type: "project_list"; projects: unknown[]; current?: string }
	// ── File browser ───────────────────────────────────────────────────────
	| { type: "file_list"; path: string; entries: FileEntry[] }
	| { type: "file_content"; path: string; content: string; binary?: boolean }
	| { type: "file_changed"; path: string; changeType: "edited" | "external" }
	// ── Part lifecycle ─────────────────────────────────────────────────────
	| { type: "part_removed"; partId: string; messageId: string }
	| { type: "message_removed"; messageId: string }
	// ── PTY / Terminal ─────────────────────────────────────────────────────
	| { type: "pty_created"; pty: PtyInfo }
	| { type: "pty_output"; ptyId: string; data: string }
	| { type: "pty_exited"; ptyId: string; exitCode: number }
	| { type: "pty_deleted"; ptyId: string }
	| { type: "pty_list"; ptys: unknown[] }
	// ── Todo ──────────────────────────────────────────────────────────────
	| { type: "todo_state"; items: TodoItem[] }
	// ── Cache / Replay ────────────────────────────────────────────────────
	| { type: "user_message"; text: string }
	// ── Misc ──────────────────────────────────────────────────────────────
	| { type: "error"; code: string; message: string }
	| { type: "client_count"; count: number }
	| { type: "input_sync"; text: string; from?: string }
	| { type: "update_available"; version?: string }
	// ── Connection lifecycle (Ticket 6.2 AC1/AC2) ─────────────────────────
	| { type: "connection_status"; status: "disconnected" | "reconnecting" | "connected" };
```

**Step 2: Update `src/lib/types.ts` to re-export from shared**

Replace the definitions of the moved types with re-exports:

```typescript
// At top of src/lib/types.ts
export type {
	RelayMessage,
	AskUserQuestion,
	UsageInfo,
	PtyInfo,
	SessionInfo,
	TodoStatus,
	TodoItem,
	AgentInfo,
	ProviderInfo,
	ModelInfo,
	CommandInfo,
	FileEntry,
} from "./shared-types.js";
```

Remove the original definitions of these types from `src/lib/types.ts`. Keep `ModelEntry`, `FileContentResult`, and all other server-only types in place.

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS — all server imports still resolve via re-exports

**Step 4: Commit**

```bash
git add src/lib/shared-types.ts src/lib/types.ts
git commit -m "refactor: create shared-types.ts with RelayMessage and shared type definitions"
```

---

### Task 2: Wire frontend to shared types

**Files:**
- Modify: `src/lib/public/tsconfig.json`
- Modify: `src/lib/public/types.ts`

**Step 1: Update frontend tsconfig to include shared-types**

In `src/lib/public/tsconfig.json`, add `../../shared-types.ts` to the include array:

```json
"include": ["./**/*.ts", "./**/*.d.ts", "./**/*.svelte", "../../shared-types.ts"]
```

**Step 2: Update `src/lib/public/types.ts`**

Replace duplicated types with imports from shared-types. Replace `WsMessage` with `RelayMessage`:

```typescript
// At top of src/lib/public/types.ts, add:
export type {
	RelayMessage,
	RelayMessage as WsMessage,  // backward compat alias during migration
	AskUserQuestion,
	SessionInfo,
	TodoStatus,
	TodoItem,
	AgentInfo,
	ProviderInfo,
	ModelInfo,
	CommandInfo,
	FileEntry,
	UsageInfo,
	PtyInfo,
} from "../../shared-types.js";
```

Remove the original definitions of these types from the file. Keep all frontend-only types (`ChatMessage`, `TerminalAdapter`, `DateGroups`, `PermissionRequest`, `QuestionRequest`, `HistoryMessagePart`, `Toast`, `BannerConfig`, etc.).

Add the `FileTreeEntry` type that extends the shared `FileEntry`:

```typescript
export interface FileTreeEntry extends FileEntry {
	children?: FileTreeEntry[];
}
```

Update any frontend code that uses `FileEntry` with `children` to use `FileTreeEntry` instead.

Remove the `ConnectionStatus` type and the old `WsMessage` interface definition.

**Step 3: Run type check**

Run: `pnpm check`
Expected: PASS for server. Frontend may have errors from removed types — fix in next steps.

**Step 4: Commit**

```bash
git add src/lib/public/tsconfig.json src/lib/public/types.ts
git commit -m "refactor: wire frontend types to shared-types.ts, alias WsMessage to RelayMessage"
```

---

### Task 3: Migrate ws.svelte.ts to typed dispatch

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts`

**Step 1: Update imports**

Change:
```typescript
import type { ConnectionStatus, WsMessage } from "../types.js";
```
To:
```typescript
import type { RelayMessage } from "../types.js";
// Keep ConnectionStatus if still used, otherwise remove
```

**Step 2: Update the parse boundary**

In `connect()` (line 164), change:
```typescript
const msg = JSON.parse(event.data) as WsMessage;
```
To:
```typescript
const msg = JSON.parse(event.data) as RelayMessage;
```

**Step 3: Update `handleMessage` signature**

Change:
```typescript
export function handleMessage(msg: WsMessage): void {
```
To:
```typescript
export function handleMessage(msg: RelayMessage): void {
```

Each `case` in the switch now narrows `msg` to the specific variant. TypeScript knows the exact shape — no `as` casts needed in the dispatch itself.

**Step 4: Update `triggerNotifications`**

Change signature from `(type: string, msg: WsMessage)` to `(msg: RelayMessage)`. The `type` parameter is redundant since `msg.type` is available and narrowed. Update the switch inside to use `msg.type` directly and access properties without casts:

```typescript
function triggerNotifications(msg: RelayMessage): void {
	if (!NOTIF_TYPES.has(msg.type)) return;
	// ... rest of function, using msg.type to switch
	// In each case, msg is narrowed, e.g.:
	// case "error": body = msg.message;  // no cast needed
	// case "permission_request": body = msg.toolName;  // no cast needed
}
```

**Step 5: Update `replayEvents`**

Change parameter type from `WsMessage[]` to `RelayMessage[]`. Remove `as` casts inside:

```typescript
function replayEvents(events: RelayMessage[]): void {
	// Each case narrows, e.g.:
	// case "user_message": addUserMessage(event.text);  // no cast
}
```

**Step 6: Update `handleChatError` and `handleBannerMessage`**

Change parameter from `WsMessage` to `RelayMessage`. Remove `as` casts — properties are now typed.

**Step 7: Update listener type**

Change `MessageListener` from `(msg: WsMessage) => void` to `(msg: RelayMessage) => void`. Update all listener registry types.

**Step 8: Fix `session_switched` handler**

The inline casts at lines 322-354 become unnecessary. `msg.id` is typed as `string`, `msg.events` as `RelayMessage[] | undefined`, `msg.history` as the structured object. Remove all `as` casts.

**Step 9: Run type check + tests**

Run: `pnpm check && pnpm test:unit`
Expected: Type errors in store handlers that still expect `WsMessage` — fix in Tasks 4-7.

**Step 10: Commit**

```bash
git add src/lib/public/stores/ws.svelte.ts
git commit -m "refactor: migrate ws.svelte.ts dispatch to typed RelayMessage"
```

---

### Task 4: Migrate chat.svelte.ts handlers to typed messages

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts`

**Step 1: Update imports and handler signatures**

Replace `WsMessage` import with specific `Extract` types from `RelayMessage`:

```typescript
import type { RelayMessage } from "../types.js";
```

Update each handler to accept the narrowed variant:

```typescript
export function handleDelta(msg: Extract<RelayMessage, { type: "delta" }>): void {
	const { text, messageId } = msg;  // both typed, no casts
	// ...
}

export function handleThinkingStart(_msg: Extract<RelayMessage, { type: "thinking_start" }>): void { ... }
export function handleThinkingDelta(msg: Extract<RelayMessage, { type: "thinking_delta" }>): void { ... }
export function handleThinkingStop(_msg: Extract<RelayMessage, { type: "thinking_stop" }>): void { ... }
export function handleToolStart(msg: Extract<RelayMessage, { type: "tool_start" }>): void { ... }
export function handleToolExecuting(msg: Extract<RelayMessage, { type: "tool_executing" }>): void { ... }
export function handleToolResult(msg: Extract<RelayMessage, { type: "tool_result" }>): void { ... }
export function handleResult(msg: Extract<RelayMessage, { type: "result" }>): void { ... }
export function handleDone(_msg: Extract<RelayMessage, { type: "done" }>): void { ... }
export function handleStatus(msg: Extract<RelayMessage, { type: "status" }>): void { ... }
export function handleError(msg: Extract<RelayMessage, { type: "error" }>): void { ... }
export function handlePartRemoved(msg: Extract<RelayMessage, { type: "part_removed" }>): void { ... }
export function handleMessageRemoved(msg: Extract<RelayMessage, { type: "message_removed" }>): void { ... }
```

**Step 2: Remove all `as` casts**

In each handler body, replace `msg.text as string` with just `msg.text`, `msg.id as string` with `msg.id`, etc. TypeScript knows the types from the narrowed variant.

For `handleResult`, the `usage` field is now typed as `UsageInfo` directly — no cast needed.

For `handleError`, `msg.code` and `msg.message` are typed strings — remove the `as string | undefined` casts.

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/chat.test.ts`
Expected: Tests may need updating if they pass untyped objects. Update test mocks to include required fields.

**Step 4: Commit**

```bash
git add src/lib/public/stores/chat.svelte.ts
git commit -m "refactor: remove 30 as-casts from chat store — typed RelayMessage handlers"
```

---

### Task 5: Migrate terminal.svelte.ts handlers

**Files:**
- Modify: `src/lib/public/stores/terminal.svelte.ts`

Same pattern as Task 4. Update each handler (`handlePtyList`, `handlePtyCreated`, `handlePtyOutput`, `handlePtyExited`, `handlePtyDeleted`, `handlePtyError`) to accept the narrowed `Extract<RelayMessage, { type: "..." }>` variant. Remove all `as` casts.

**Step 1: Update handler signatures and remove casts**

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/terminal.test.ts`

**Step 3: Commit**

```bash
git add src/lib/public/stores/terminal.svelte.ts
git commit -m "refactor: remove as-casts from terminal store — typed RelayMessage handlers"
```

---

### Task 6: Migrate permissions.svelte.ts handlers

**Files:**
- Modify: `src/lib/public/stores/permissions.svelte.ts`

Same pattern. Update `handlePermissionRequest`, `handlePermissionResolved`, `handleAskUser`, `handleAskUserResolved` to use narrowed types.

Note: `handlePermissionRequest` takes a second arg `wsSend` — keep that. Just change the first arg type.

**Step 1: Update handler signatures and remove casts**

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/permissions.test.ts`

**Step 3: Commit**

```bash
git add src/lib/public/stores/permissions.svelte.ts
git commit -m "refactor: remove as-casts from permissions store — typed RelayMessage handlers"
```

---

### Task 7: Migrate remaining stores and components

**Files:**
- Modify: `src/lib/public/stores/discovery.svelte.ts`
- Modify: `src/lib/public/stores/session.svelte.ts`
- Modify: `src/lib/public/stores/project.svelte.ts`
- Modify: `src/lib/public/stores/ui.svelte.ts`
- Modify: any Svelte components that import `WsMessage`

Same pattern for each. Update handler signatures, remove `as` casts.

For `session.svelte.ts`: `handleSessionList` and `handleSessionSwitched` use narrowed types.
For `discovery.svelte.ts`: `handleAgentList`, `handleModelList`, `handleModelInfo`, `handleCommandList`.
For `project.svelte.ts`: `handleProjectList`.
For `ui.svelte.ts`: `setClientCount` is called from ws.svelte.ts directly — no handler change needed.

After all stores are migrated, search for remaining `WsMessage` imports across the frontend. Update any Svelte components (e.g., `HistoryView.svelte`, `FileBrowser.svelte`, `PlanMode.svelte`) that use listener callbacks typed as `(msg: WsMessage) => void`.

**Step 1: Update all remaining stores**

**Step 2: Search for remaining WsMessage usage**

Run: `grep -r "WsMessage" src/lib/public/` and fix any remaining references.

**Step 3: Remove the `WsMessage` backward-compat alias from `types.ts`**

Once no code references `WsMessage`, remove the alias from `src/lib/public/types.ts`:
```typescript
// Remove this line:
RelayMessage as WsMessage,
```

**Step 4: Run full type check + tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/public/
git commit -m "refactor: complete frontend migration to typed RelayMessage — zero WsMessage references"
```

---

### Task 8: Enable noUncheckedIndexedAccess + frontend type checking

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/lib/public/tsconfig.json`
- Modify: `package.json`

**Step 1: Add `check:frontend` script to `package.json`**

```json
"check:frontend": "tsc --noEmit --project src/lib/public/tsconfig.json"
```

**Step 2: Update `check` script to include frontend**

```json
"check": "tsc --noEmit && tsc --noEmit --project src/lib/public/tsconfig.json"
```

**Step 3: Run `pnpm check` to verify both pass before enabling stricter settings**

Run: `pnpm check`
Expected: PASS

**Step 4: Enable `noUncheckedIndexedAccess` in root `tsconfig.json`**

Add to `compilerOptions`:
```json
"noUncheckedIndexedAccess": true
```

**Step 5: Fix resulting server-side type errors**

Run: `pnpm check` (server only: `tsc --noEmit`)
Fix each error — typically adding `!` assertions where the value is known to exist, or adding null checks where it might not.

**Step 6: Enable `noUncheckedIndexedAccess` in frontend `tsconfig.json`**

Add to `compilerOptions`:
```json
"noUncheckedIndexedAccess": true
```

**Step 7: Fix resulting frontend type errors**

Run: `pnpm check:frontend`
Fix each error.

**Step 8: Run full suite**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 9: Commit**

```bash
git add tsconfig.json src/lib/public/tsconfig.json package.json src/
git commit -m "refactor: enable noUncheckedIndexedAccess, add frontend type checking to pre-commit"
```

---

### Task 9: Delete dead code

**Files:**
- Delete: `src/lib/input-sync.ts`
- Delete: `test/unit/input-sync.pbt.test.ts`
- Delete: `src/lib/public/mockup.html` and all `mockup-*.html` files (10 total)
- Modify: `src/lib/message-handlers.ts` (remove `handleFileCommand`)
- Modify: `src/lib/ws-router.ts` (remove `file_command` from `VALID_MESSAGE_TYPES`)

**Step 1: Delete dead files**

```bash
rm src/lib/input-sync.ts test/unit/input-sync.pbt.test.ts
rm src/lib/public/mockup*.html
```

**Step 2: Remove `handleFileCommand` from `message-handlers.ts`**

Delete the `handleFileCommand` function (lines ~665-695) and remove `file_command: handleFileCommand` from the `MESSAGE_HANDLERS` dispatch table.

**Step 3: Remove `file_command` from `ws-router.ts`**

Remove `"file_command"` from the `VALID_MESSAGE_TYPES` set.

**Step 4: Run tests**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove dead code — input-sync, mockup HTMLs, duplicate file_command handler"
```

---

### Task 10: Wire VersionChecker into daemon

**Files:**
- Modify: `src/lib/daemon.ts`

**Step 1: Write the test**

In `test/unit/daemon.test.ts`, add a test that verifies VersionChecker is started on daemon start and stopped on daemon stop. Use the existing daemon test patterns (injectable options). The VersionChecker accepts `_fetch` for testing — inject a mock that returns a known version.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/daemon.test.ts --grep "VersionChecker"`

**Step 3: Add import and field to Daemon class**

In `src/lib/daemon.ts`, add:
```typescript
import { VersionChecker } from "./version-check.js";
```

Add field:
```typescript
private versionChecker: VersionChecker | null = null;
```

**Step 4: Start VersionChecker in `start()` method**

After the existing initialization (after `saveDaemonConfig`), add:

```typescript
// Start version checker (non-fatal if it fails)
this.versionChecker = new VersionChecker({
	enabled: !process.argv.includes("--no-update"),
});
this.versionChecker.on("update_available", ({ current, latest }) => {
	// Broadcast to all connected browsers
	for (const relay of this.projectRelays.values()) {
		relay.wsHandler.broadcast(
			JSON.stringify({ type: "update_available", version: latest }),
		);
	}
});
this.versionChecker.start();
```

**Step 5: Stop VersionChecker in `stop()` method**

Before closing relays, add:
```typescript
this.versionChecker?.stop();
this.versionChecker = null;
```

**Step 6: Run test to verify it passes**

Run: `pnpm vitest run test/unit/daemon.test.ts --grep "VersionChecker"`

**Step 7: Commit**

```bash
git add src/lib/daemon.ts test/unit/daemon.test.ts
git commit -m "feat: wire VersionChecker into daemon — checks npm on startup + every 4h"
```

---

### Task 11: Wire KeepAwake into daemon

**Files:**
- Modify: `src/lib/daemon.ts`

**Step 1: Write the test**

In `test/unit/daemon.test.ts`, add tests:
- KeepAwake is instantiated with `enabled` from `DaemonOptions.keepAwake`
- KeepAwake is stopped on daemon stop
- The IPC `set_keep_awake` command calls `setEnabled()` on the KeepAwake instance

**Step 2: Run test to verify it fails**

**Step 3: Add import and field**

```typescript
import { KeepAwake } from "./keep-awake.js";
```

Add field:
```typescript
private keepAwakeManager: KeepAwake | null = null;
```

**Step 4: Instantiate in `start()`**

After VersionChecker initialization:
```typescript
// Initialize keep-awake (macOS caffeinate)
this.keepAwakeManager = new KeepAwake({
	enabled: this.keepAwake,
});
```

**Step 5: Wire the existing IPC `set_keep_awake` handler**

The daemon already has a `keepAwake` boolean field and an IPC handler at ~line 725-729. Update it to also call `setEnabled()` on the manager:

```typescript
// In the IPC set_keep_awake handler:
this.keepAwake = enabled;
this.keepAwakeManager?.setEnabled(enabled);
```

**Step 6: Stop in `stop()`**

```typescript
this.keepAwakeManager?.deactivate();
this.keepAwakeManager = null;
```

**Step 7: Run tests**

Run: `pnpm vitest run test/unit/daemon.test.ts --grep "KeepAwake"`

**Step 8: Commit**

```bash
git add src/lib/daemon.ts test/unit/daemon.test.ts
git commit -m "feat: wire KeepAwake into daemon — caffeinate on macOS during processing"
```

---

### Task 12: Wire isPermissionRepliedEvent type guard

**Files:**
- Modify: `src/lib/sse-wiring.ts`

**Step 1: Update import**

Add `isPermissionRepliedEvent` to the imports from `opencode-events.js`:

```typescript
import { isPermissionRepliedEvent, /* existing imports */ } from "./opencode-events.js";
```

**Step 2: Replace raw string check**

At `src/lib/sse-wiring.ts:146-150`, replace:
```typescript
if (event.type === "permission.replied") {
	const id =
		typeof event.properties.id === "string" ? event.properties.id : undefined;
	if (id) permissionBridge.onPermissionReplied(id);
}
```

With:
```typescript
if (isPermissionRepliedEvent(event)) {
	permissionBridge.onPermissionReplied(event.properties.id);
}
```

The type guard already validates that `event.properties.id` is a string.

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/sse-wiring.test.ts`

**Step 4: Commit**

```bash
git add src/lib/sse-wiring.ts
git commit -m "refactor: use isPermissionRepliedEvent type guard instead of raw string check"
```

---

### Task 13: Decompose message-handlers.ts

**Files:**
- Create: `src/lib/handlers/sessions.ts`
- Create: `src/lib/handlers/terminal.ts`
- Create: `src/lib/handlers/discovery.ts`
- Create: `src/lib/handlers/files.ts`
- Create: `src/lib/handlers/permissions.ts`
- Create: `src/lib/handlers/projects.ts`
- Create: `src/lib/handlers/session-actions.ts`
- Create: `src/lib/handlers/chat.ts`
- Modify: `src/lib/message-handlers.ts` (becomes barrel)

**Step 1: Extract handlers by domain**

Move each group of handler functions into its own file. Each file imports `HandlerDeps` from `message-handlers.ts` (or a shared types file). Export the handler functions.

**sessions.ts**: `handleNewSession`, `handleSwitchSession`, `handleDeleteSession`, `handleRenameSession`, `handleListSessions`, `handleSearchSessions`, `handleLoadMoreHistory`
**terminal.ts**: `createAndConnectPty`, `handleTerminalCommand`, `handlePtyCreate`, `handlePtyInput`, `handlePtyResize`, `handlePtyClose`
**discovery.ts**: `handleGetAgents`, `handleSwitchAgent`, `handleGetModels`, `handleSwitchModel`, `handleGetCommands` (including `filterAgents`)
**files.ts**: `handleGetFileList`, `handleGetFileContent`
**permissions.ts**: `handlePermissionResponse`, `handleAskUserResponse`, `handleQuestionReject`
**projects.ts**: `handleGetProjects`, `handleAddProject`
**session-actions.ts**: `handleCancel`, `handleRewind`, `handleInputSync`, `handleGetTodo`
**chat.ts**: `handleMessage` (the chat message send handler)

**Step 2: Update `message-handlers.ts` to import and re-export**

`message-handlers.ts` becomes a barrel file (~80 lines):
- Defines `HandlerDeps` interface
- Imports all handlers from `./handlers/`
- Assembles and exports `MESSAGE_HANDLERS` dispatch table
- Exports `dispatchMessage()`

**Step 3: Run tests**

Run: `pnpm check && pnpm test:unit`
All existing `message-handlers.test.ts` tests should still pass since the barrel re-exports everything.

**Step 4: Commit**

```bash
git add src/lib/handlers/ src/lib/message-handlers.ts
git commit -m "refactor: decompose message-handlers.ts into domain-grouped handler modules"
```

---

### Task 14: Decompose daemon.ts

**Files:**
- Create: `src/lib/daemon-ipc.ts`
- Create: `src/lib/daemon-spawn.ts`
- Modify: `src/lib/daemon.ts`

**Step 1: Extract IPC server to `daemon-ipc.ts`**

Move the IPC server creation, command routing, socket management (~150 lines) into `daemon-ipc.ts`. Export a function like `createIPCServer(daemon, options)` or a class that the Daemon delegates to.

**Step 2: Extract static methods to `daemon-spawn.ts`**

Move `Daemon.isRunning()`, `Daemon.buildSpawnConfig()`, `Daemon.spawn()` into standalone functions in `daemon-spawn.ts`. These are all static and don't depend on instance state.

**Step 3: Update `daemon.ts` to import from extracted modules**

**Step 4: Run tests**

Run: `pnpm check && pnpm vitest run test/unit/daemon.test.ts`

**Step 5: Commit**

```bash
git add src/lib/daemon.ts src/lib/daemon-ipc.ts src/lib/daemon-spawn.ts
git commit -m "refactor: extract daemon IPC and spawn logic into separate modules"
```

---

### Task 15: Decompose cli-core.ts

**Files:**
- Create: `src/lib/cli-commands.ts`
- Create: `src/lib/cli-daemon-handlers.ts`
- Create: `src/lib/cli-utils.ts`
- Modify: `src/bin/cli-core.ts`

**Step 1: Extract utilities to `cli-utils.ts`**

Move `sendIPCCommand()`, `getNetworkAddress()`, `generateQR()`, `formatUptime()`, `openUrl()` into `cli-utils.ts`.

**Step 2: Extract IPC commands to `cli-commands.ts`**

Move the 7 IPC-based handlers (`status`, `stop`, `pin`, `add`, `remove`, `list`, `title`) into `cli-commands.ts`. Also extract:
- `findSlugForCwd()` — deduplicate the identical lookup in `remove` and `title`
- `ensureDaemonRunning()` — the guard that appears in 7 handlers

**Step 3: Extract daemon/foreground handlers to `cli-daemon-handlers.ts`**

Move `daemon` and `foreground` command handlers.

**Step 4: Update `cli-core.ts` to import and dispatch**

The `run()` function becomes a thin dispatcher calling into the extracted modules.

**Step 5: Run tests**

Run: `pnpm check && pnpm vitest run test/unit/cli.test.ts`

**Step 6: Commit**

```bash
git add src/bin/cli-core.ts src/lib/cli-commands.ts src/lib/cli-daemon-handlers.ts src/lib/cli-utils.ts
git commit -m "refactor: decompose cli-core.ts into commands, daemon handlers, and utilities"
```

---

### Task 16: Decompose ws.svelte.ts

**Files:**
- Create: `src/lib/public/stores/ws-dispatch.ts`
- Create: `src/lib/public/stores/ws-notifications.ts`
- Modify: `src/lib/public/stores/ws.svelte.ts`

**Step 1: Extract dispatch to `ws-dispatch.ts`**

Move `handleMessage()`, `replayEvents()`, `handleChatError()`, `handleBannerMessage()` and the listener registries into `ws-dispatch.ts`. Export them.

**Step 2: DRY up listener registries**

Replace the 6 copy-pasted listener sets with a factory:

```typescript
function createListenerSet() {
	const listeners = new Set<(msg: RelayMessage) => void>();
	return {
		add(fn: (msg: RelayMessage) => void) { listeners.add(fn); return () => listeners.delete(fn); },
		notify(msg: RelayMessage) { for (const fn of listeners) fn(msg); },
	};
}

const historyPageListeners = createListenerSet();
const planModeListeners = createListenerSet();
// ... etc

export const onHistoryPage = historyPageListeners.add;
export const onPlanMode = planModeListeners.add;
// ... etc
```

**Step 3: Extract notifications to `ws-notifications.ts`**

Move `NOTIF_TYPES`, `triggerNotifications()`, push-active tracking (`_pushActive`, `setPushActive`, `isPushActive`).

**Step 4: Update `ws.svelte.ts`**

Import from the extracted modules. `ws.svelte.ts` retains only: connection state, `connect()`, `disconnect()`, `wsSend()`, `setStatus()`, callbacks.

**Step 5: Run tests**

Run: `pnpm check && pnpm test:unit`

**Step 6: Commit**

```bash
git add src/lib/public/stores/
git commit -m "refactor: extract ws dispatch, notifications, and DRY listener registries"
```

---

### Task 17: Decompose SetupPage.svelte

**Files:**
- Create: `src/lib/public/components/features/SetupStepTailscale.svelte`
- Create: `src/lib/public/components/features/SetupStepCert.svelte`
- Create: `src/lib/public/components/features/SetupStepPwa.svelte`
- Create: `src/lib/public/components/features/SetupStepPush.svelte`
- Create: `src/lib/public/components/features/SetupStepDone.svelte`
- Create: `src/lib/public/components/shared/StatusBadge.svelte`
- Create: `src/lib/public/components/features/SetupProgress.svelte`
- Create: `src/lib/public/utils/setup-utils.ts`
- Modify: `src/lib/public/pages/SetupPage.svelte`

**Step 1: Extract shared components**

Create `StatusBadge.svelte` (the repeated ok/warn/pending badge pattern) and `SetupProgress.svelte` (progress bar).

**Step 2: Extract each step**

Create one component per wizard step. Each receives the step state as props and emits events for state changes.

**Step 3: Extract non-component logic**

Move platform detection and step list builder into `setup-utils.ts`.

**Step 4: Simplify SetupPage.svelte**

Reduce to a thin step router (~100 lines) that manages state and renders the active step component.

**Step 5: Run type check + storybook smoke test**

Run: `pnpm check`
If SetupPage has a story, verify it still renders.

**Step 6: Commit**

```bash
git add src/lib/public/
git commit -m "refactor: decompose SetupPage into step components — 990 lines to ~100"
```

---

### Task 18: Consolidate error handling (Part A)

**Files:**
- Modify: `src/lib/errors.ts`
- Modify: `src/lib/error-response.ts`
- Modify: `src/lib/message-handlers.ts` (or `src/lib/handlers/*.ts`)
- Modify: `src/lib/relay-stack.ts`
- Modify: `src/lib/client-init.ts`
- Create or modify: `src/lib/shared-types.ts` (add `ErrorCode`)

**Step 1: Add ErrorCode union to shared-types.ts**

```typescript
export type ErrorCode =
	| "NO_SESSION"
	| "INVALID_REQUEST"
	| "NOT_SUPPORTED"
	| "API_ERROR"
	| "HANDLER_ERROR"
	| "PTY_CONNECT_FAILED"
	| "PTY_NOT_FOUND"
	| "SESSION_NOT_FOUND"
	| "PERMISSION_NOT_FOUND"
	| "QUESTION_NOT_FOUND"
	| "RETRY";
```

Update the `error` variant in `RelayMessage` to use it:
```typescript
| { type: "error"; code: ErrorCode; message: string }
```

**Step 2: Update error variant in RelayMessage**

**Step 3: Replace inline error objects in handlers**

Find all `{ type: "error", code: "...", message: "..." }` patterns in handler files. Replace with:
```typescript
new WebSocketError("NO_SESSION", "No active session").toWebSocket()
```

**Step 4: Remove `buildErrorResponse` from `error-response.ts`**

Keep `formatErrorDetail` (it's useful). Remove `buildErrorResponse`. Update callers to use error classes directly.

**Step 5: Run tests**

Run: `pnpm check && pnpm test:unit`

**Step 6: Commit**

```bash
git add src/lib/
git commit -m "refactor: consolidate error handling — ErrorCode union, typed error classes in handlers"
```

---

### Task 19: Ticket 6.2 AC1+AC2 — OpenCode connection lifecycle

**Files:**
- Modify: `src/lib/sse-wiring.ts` or `src/lib/sse-consumer.ts`
- Modify: `src/lib/relay-stack.ts`
- Modify: `src/lib/public/stores/ws.svelte.ts` (or `ws-dispatch.ts`)
- Modify: `src/lib/public/stores/ui.svelte.ts`

**Step 1: Write tests**

Test that when SSE connection drops, a `connection_status` message is broadcast to WebSocket clients. Test that when SSE reconnects, a `connected` message is broadcast.

**Step 2: Add connection state broadcasting**

In the SSE wiring (where `SSEConsumer` events are handled), broadcast `{ type: "connection_status", status: "disconnected" }` when the SSE connection drops, and `{ type: "connection_status", status: "connected" }` when it reconnects.

**Step 3: Handle on frontend**

In the ws dispatch, add a case for `connection_status`. Update `ui.svelte.ts` to show/hide a banner:
- `"disconnected"` → show "OpenCode disconnected, retrying..."
- `"reconnecting"` → show "Reconnecting to OpenCode..."
- `"connected"` → hide the banner

**Step 4: Run tests**

Run: `pnpm check && pnpm test:unit`

**Step 5: Commit**

```bash
git add src/lib/ src/lib/public/
git commit -m "feat: broadcast OpenCode connection status to browsers (ticket 6.2 AC1+AC2)"
```

---

### Task 20: Ticket 6.2 AC3+AC4+AC6 — Verify existing behavior

**Files:**
- Create or modify tests as needed

**Step 1: Verify AC3 — Browser reconnection replay**

Write an integration-style test (or unit test with mocks) that:
- Simulates a client connecting, receiving events, disconnecting, and reconnecting
- Verifies `client-init.ts` replays cached events
- Verifies pending permissions are re-sent

If it already works, add the test to document the behavior. If it doesn't, fix it.

**Step 2: Verify AC4 — Duplicate permission dedup**

Write a unit test for `PermissionBridge` that:
- Sends a permission response for the same `requestId` twice
- Verifies only the first is forwarded to OpenCode

If it already works, add the test. If not, fix it.

**Step 3: Verify AC6 — Invalid WebSocket messages**

Write a unit test for `ws-router.ts` that:
- Sends malformed JSON
- Verifies an error response is returned
- Verifies the connection is NOT closed

If it already works, add the test. If not, fix it.

**Step 4: Run all tests**

Run: `pnpm check && pnpm test:unit`

**Step 5: Commit**

```bash
git add test/
git commit -m "test: verify browser reconnection, permission dedup, invalid WS handling (ticket 6.2)"
```

---

### Task 21: Final verification

**Step 1: Run full suite**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

**Step 2: Verify pre-commit hook**

Make a trivial change and commit to verify lefthook runs both server and frontend type checks.

**Step 3: Review for any remaining `WsMessage` or `as` casts**

```bash
grep -r "WsMessage" src/lib/public/
grep -r " as " src/lib/public/stores/ | wc -l
```

The `as` cast count in frontend stores should be dramatically lower than the original ~120.

**Step 4: Commit any final fixups**

```bash
git add -A
git commit -m "refactor: final cleanup — verify pre-commit, remove remaining type noise"
```
