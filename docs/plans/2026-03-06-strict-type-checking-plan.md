# Strict Type Checking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable all remaining strict TypeScript compiler flags, type the handler payload boundary, type RelayMessage unknown fields, and add lint rules to prevent regression.

**Architecture:** Five sequential phases — (1) easy compiler flags, (2) RelayMessage concrete types, (3) typed handler payloads + PayloadMap, (4) remaining index-signature fixes, (5) lint rules. Each phase ends with a commit. TDD where applicable.

**Tech Stack:** TypeScript 5.8, Biome 2.4, Vitest 3

---

### Task 1: Enable `noImplicitReturns` and `noFallthroughCasesInSwitch`

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/lib/public/tsconfig.json`

**Step 1: Add flags to root tsconfig**

In `tsconfig.json`, add to `compilerOptions`:

```json
"noImplicitReturns": true,
"noFallthroughCasesInSwitch": true
```

**Step 2: Add flags to frontend tsconfig**

In `src/lib/public/tsconfig.json`, add the same two flags.

**Step 3: Run type check to see if anything breaks**

Run: `pnpm check`
Expected: PASS (these flags rarely break well-disciplined code)

**Step 4: If any errors, fix them**

- `noImplicitReturns`: Add explicit `return` or `return undefined` at the end of any flagged function.
- `noFallthroughCasesInSwitch`: Add `break` or `return` to any fallthrough case.

**Step 5: Run tests**

Run: `pnpm test`
Expected: PASS (no runtime behavior changes)

**Step 6: Commit**

```bash
git add tsconfig.json src/lib/public/tsconfig.json
# plus any fixed files
git commit -m "feat: enable noImplicitReturns and noFallthroughCasesInSwitch"
```

---

### Task 2: Type the RelayMessage Unknown Fields

**Files:**
- Modify: `src/shared-types.ts`
- Modify: `src/lib/public/types.ts` (if HistoryMessage needs moving)

**Step 1: Define missing interfaces in `shared-types.ts`**

Add near the existing interfaces (around the `PtyInfo` and `SessionInfo` blocks):

```typescript
/** A single message from the OpenCode REST history API */
export interface HistoryMessage {
    id: string;
    role: string;
    content?: string;
    parts?: HistoryMessagePart[];
    createdAt?: string | number;
    [key: string]: unknown;
}

/** Shape of HistoryMessage parts (tool calls, text, etc.) */
export interface HistoryMessagePart {
    id: string;
    type: string;
    text?: string;
    state?: string;
    callID?: string;
    tool?: string;
    time?: number;
    [key: string]: unknown;
}

/** A project in the project list */
export interface ProjectInfo {
    slug: string;
    title: string;
    directory: string;
    instanceId?: string;
}

/** A file version from file history */
export interface FileVersion {
    version: string;
    timestamp: number;
    [key: string]: unknown;
}
```

**Step 2: Update RelayMessage variants**

Replace each `unknown` / `unknown[]` field:

- `tool_executing.input: unknown` → `input: Record<string, unknown> | undefined`
- `session_switched.history.messages: unknown[]` → `messages: HistoryMessage[]`
- `history_page.messages: unknown[]` → `messages: HistoryMessage[]`
- `project_list.projects: unknown[]` → `projects: ProjectInfo[]`
- `pty_list.ptys: unknown[]` → `ptys: PtyInfo[]`
- `file_history_result.versions: unknown[]` → `versions: FileVersion[]`

**Step 3: Run type check**

Run: `pnpm check`
Expected: Some downstream files may need adjustment if they were casting to a different shape. Fix any errors — the casts should become unnecessary or simpler.

**Step 4: Remove now-unnecessary casts in consumers**

Files likely affected:
- `src/lib/public/stores/chat.svelte.ts` — remove `as HistoryMessage[]` casts
- `src/lib/public/stores/project.svelte.ts` — remove `as ProjectInfo[]` cast
- `src/lib/public/stores/terminal.svelte.ts` — remove `as Array<{...}>` cast for pty_list
- `src/lib/public/logic/history-logic.ts` — remove manual `HistoryMessagePart` casts

**Step 5: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/shared-types.ts src/lib/public/
git commit -m "feat: type RelayMessage unknown fields with concrete interfaces"
```

---

### Task 3: Create PayloadMap and Typed Handler Infrastructure

**Files:**
- Create: `src/handlers/payloads.ts`
- Modify: `src/handlers/types.ts`
- Modify: `src/handlers/index.ts`

**Step 1: Create `src/handlers/payloads.ts`**

```typescript
/**
 * Type map for all incoming WebSocket message payloads.
 * Each key corresponds to an IncomingMessageType, and the value
 * is the expected shape of the payload for that message type.
 *
 * NOTE: At the dispatch boundary, raw JSON is cast to these types.
 * Phase 2 (Valibot) will add runtime validation.
 */
export interface PayloadMap {
    message: { text: string };
    cancel: Record<string, never>;
    rewind: { messageId?: string; uuid?: string };
    input_sync: { text: string };
    permission_response: { requestId: string; decision: string };
    ask_user_response: { toolId: string; answers: Record<string, string> };
    question_reject: { toolId: string };
    new_session: { title?: string };
    switch_session: { sessionId: string };
    view_session: { sessionId: string };
    delete_session: { sessionId: string };
    rename_session: { sessionId: string; title: string };
    fork_session: { sessionId: string; messageId?: string };
    list_sessions: Record<string, never>;
    search_sessions: { query: string };
    load_more_history: { sessionId?: string; offset: number };
    get_agents: Record<string, never>;
    switch_agent: { agentId: string };
    get_models: Record<string, never>;
    switch_model: { modelId: string; providerId: string };
    set_default_model: { provider: string; model: string };
    get_commands: Record<string, never>;
    get_projects: Record<string, never>;
    add_project: { directory: string; instanceId?: string };
    get_todo: Record<string, never>;
    get_file_list: { path?: string };
    get_file_content: { path: string };
    get_file_tree: Record<string, never>;
    get_tool_content: { toolId: string };
    terminal_command: { action: string; ptyId?: string };
    pty_create: Record<string, never>;
    pty_input: { ptyId: string; data: string };
    pty_resize: { ptyId: string; cols?: number; rows?: number };
    pty_close: { ptyId: string };
    instance_add: {
        name: string;
        url?: string;
        managed?: boolean;
        port?: number;
        env?: Record<string, string>;
    };
    instance_remove: { instanceId: string };
    instance_start: { instanceId: string };
    instance_stop: { instanceId: string };
    instance_update: {
        instanceId: string;
        name?: string;
        port?: number;
        env?: Record<string, string>;
    };
    set_project_instance: { slug: string; instanceId: string };
}
```

**Step 2: Update `MessageHandler` type in `src/handlers/types.ts`**

Change:

```typescript
export type MessageHandler = (
    deps: HandlerDeps,
    clientId: string,
    payload: Record<string, unknown>,
) => Promise<void>;
```

To:

```typescript
import type { PayloadMap } from "./payloads.js";

export type MessageHandler<K extends keyof PayloadMap = keyof PayloadMap> = (
    deps: HandlerDeps,
    clientId: string,
    payload: PayloadMap[K],
) => Promise<void>;
```

**Step 3: Update dispatch in `src/handlers/index.ts`**

The `MESSAGE_HANDLERS` table type stays as `Record<string, MessageHandler>` (using the default generic parameter which is `keyof PayloadMap` — the union).

The `dispatchMessage` function casts at the single trust boundary:

```typescript
export async function dispatchMessage(
    deps: HandlerDeps,
    clientId: string,
    handler: string,
    payload: Record<string, unknown>,
): Promise<void> {
    const fn = MESSAGE_HANDLERS[handler];
    if (fn) {
        // Trust boundary: payload has been parsed from JSON but not validated.
        // Phase 2 (Valibot) will add runtime validation here.
        await fn(deps, clientId, payload as PayloadMap[keyof PayloadMap]);
    }
}
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS — handlers still accept a supertype of what they actually use

**Step 5: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/handlers/payloads.ts src/handlers/types.ts src/handlers/index.ts
git commit -m "feat: add PayloadMap type infrastructure for typed handler payloads"
```

---

### Task 4: Type Individual Handler Functions

**Files:**
- Modify: `src/handlers/prompt.ts`
- Modify: `src/handlers/permissions.ts`
- Modify: `src/handlers/session.ts`
- Modify: `src/handlers/agent.ts`
- Modify: `src/handlers/model.ts`
- Modify: `src/handlers/settings.ts`
- Modify: `src/handlers/files.ts`
- Modify: `src/handlers/tool-content.ts`
- Modify: `src/handlers/terminal.ts`
- Modify: `src/handlers/instance.ts`

For EACH handler file, change the `payload` parameter type from `Record<string, unknown>` to the specific `PayloadMap[K]` type, and remove manual coercions.

**Step 1: Update `prompt.ts` handlers**

Example — `handleMessage`:
```typescript
// Before:
export async function handleMessage(
    deps: HandlerDeps, clientId: string, payload: Record<string, unknown>
): Promise<void> {
    const text = String(payload.text ?? "");

// After:
import type { PayloadMap } from "./payloads.js";

export async function handleMessage(
    deps: HandlerDeps, clientId: string, payload: PayloadMap["message"]
): Promise<void> {
    const { text } = payload;
```

Similarly for `handleCancel`, `handleRewind`, `handleInputSync`.

**Step 2: Update `permissions.ts` handlers**

Same pattern for `handlePermissionResponse`, `handleAskUserResponse`, `handleQuestionReject`.

**Step 3: Update `session.ts` handlers**

Same pattern for all session handlers. Note: `handleSwitchSession` delegates to `handleViewSession`, so its payload is `PayloadMap["switch_session"]` which is `{ sessionId: string }` — same shape as `view_session`.

**Step 4: Update remaining handler files**

Apply the same pattern to `agent.ts`, `model.ts`, `settings.ts`, `files.ts`, `tool-content.ts`, `terminal.ts`, `instance.ts`.

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS — if any mismatches exist between PayloadMap and actual usage, fix PayloadMap.

**Step 6: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/handlers/
git commit -m "feat: type all handler functions with specific PayloadMap types"
```

---

### Task 5: Enable `exactOptionalPropertyTypes`

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/lib/public/tsconfig.json`
- Modify: ~10 source files, ~3 test files

**Step 1: Add flag to both tsconfigs**

```json
"exactOptionalPropertyTypes": true
```

**Step 2: Run type check to find all errors**

Run: `pnpm check`
Expected: ~25 errors

**Step 3: Fix `src/` violations**

The fix pattern for each violation is one of:

**Pattern A — ternary to conditional spread:**
```typescript
// Before:
const obj = { optionalField: cond ? value : undefined };
// After:
const obj = { ...(cond ? { optionalField: value } : {}) };
// Or shorter if cond is truthy-safe:
const obj = { ...(cond && { optionalField: value }) };
```

**Pattern B — assignment to delete:**
```typescript
// Before:
instance.pid = undefined;
// After:
delete instance.pid;
```

Apply systematically to all flagged locations in:
- `src/instance-manager.ts` (~3 fixes)
- `src/relay-stack.ts` (~4 fixes)
- `src/handlers/instance.ts` (~2 fixes)
- `src/daemon.ts` (~2 fixes)
- `src/lib/public/stores/chat.svelte.ts` (~1 fix)
- `src/lib/public/ws-dispatch.ts` (~1 fix)
- `src/lib/public/stores/todo.svelte.ts` (~1 fix)
- `src/lib/public/logic/group-tools.ts` (~4 fixes)
- `src/lib/public/logic/history-logic.ts` (~4 fixes)

**Step 4: Fix `test/` violations**

~5 test files with `= undefined` patterns. Use `delete` or restructure mock creation.

**Step 5: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 6: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add tsconfig.json src/lib/public/tsconfig.json src/ test/
git commit -m "feat: enable exactOptionalPropertyTypes and fix all violations"
```

---

### Task 6: Type Remaining Index Signature Sources

Before enabling `noPropertyAccessFromIndexSignature`, type the remaining data structures that use `[key: string]: unknown` and are accessed with dot notation.

**Files:**
- Modify: `src/lib/opencode-events.ts` — add declared properties to SSE event sub-interfaces
- Modify: `src/lib/public/types.ts` — add declared properties to `HistoryMessagePart` if not already done in Task 2
- Modify: `src/ipc-protocol.ts` — type `IPCCommand` as discriminated union

**Step 1: Type `HistoryMessagePart` declared properties**

If `HistoryMessagePart` still has an index signature without declared properties for `state`, `callID`, `tool`, `time`, add them:

```typescript
export interface HistoryMessagePart {
    id: string;
    type: string;
    text?: string;
    state?: string;
    callID?: string;
    tool?: string;
    time?: number;
    [key: string]: unknown;
}
```

**Step 2: Type `IPCCommand` as discriminated union**

Replace the loose `IPCCommand` type with a discriminated union on the `action` field:

```typescript
export type IPCCommand =
    | { action: "status"; requestId: string }
    | { action: "launch"; requestId: string; name: string; port: number; env?: Record<string, string> }
    | { action: "stop"; requestId: string; name: string }
    | { action: "list"; requestId: string }
    // ... etc based on actual action variants used
```

Check `ipc-protocol.ts` for all `cmd.X` accesses to determine the full set of fields per action.

**Step 3: Type SSE event property accesses in `sse-wiring.ts`**

The `event.properties` accesses before type guards narrow the type need either:
- Moving the type guard check earlier so the properties are declared
- Adding the commonly accessed properties (`id`, `tool`, `permission`, `error`) to the base `OpenCodeEvent` interface with optional types

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/
git commit -m "feat: type index-signature sources with declared properties"
```

---

### Task 7: Enable `noPropertyAccessFromIndexSignature`

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/lib/public/tsconfig.json`
- Fix remaining violations (should be small after Task 6)

**Step 1: Add flag to both tsconfigs**

```json
"noPropertyAccessFromIndexSignature": true
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: Remaining violations should be few after Tasks 3-6 typed the major sources.

**Step 3: Fix remaining violations**

For any remaining violations, either:
- Add declared properties to the interface (preferred)
- Switch to bracket notation where the access truly is dynamic

**Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add tsconfig.json src/lib/public/tsconfig.json src/ test/
git commit -m "feat: enable noPropertyAccessFromIndexSignature"
```

---

### Task 8: Lint Rules and Test Cleanup

**Files:**
- Modify: `biome.json` (or `biome.jsonc`)
- Modify: ~3 test files (any cleanup)

**Step 1: Enable `noNonNullAssertion` warning in Biome**

In the Biome config, change:

```json
"style": {
    "noNonNullAssertion": "warn"
}
```

**Step 2: Fix or suppress the 8 prod non-null assertions**

For each `!` assertion in `src/`, either:
- Replace with a null check + early return
- Replace with `?? defaultValue`
- Add a `// biome-ignore` comment if the assertion is genuinely safe (e.g., guaranteed by prior check)

**Step 3: Clean up test `any` usages**

Replace the 6 `any` usages in test files:
- `[k: string]: any` → `[k: string]: unknown`
- `MockDaemonClass: any` → proper mock type or `unknown`

**Step 4: Run lint**

Run: `pnpm lint`
Expected: PASS (no new errors/warnings)

**Step 5: Run type check and tests**

Run: `pnpm check && pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add biome.json* src/ test/
git commit -m "feat: enable noNonNullAssertion lint rule and clean up test any usages"
```

---

### Task 9: Final Verification

**Step 1: Full check suite**

Run: `pnpm check && pnpm lint && pnpm test`
Expected: All pass

**Step 2: Verify no regressions in strict flags**

Confirm both tsconfigs now have:
```json
{
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true
}
```

**Step 3: Verify Biome rules**

Confirm `noNonNullAssertion` is set to `"warn"`.

**Step 4: Verify zero any in production**

Run: `rg ': any|as any|<any>' src/ --count`
Expected: 0 matches

**Step 5: Verify zero suppression comments**

Run: `rg '@ts-ignore|@ts-expect-error' src/ test/`
Expected: 0 matches
