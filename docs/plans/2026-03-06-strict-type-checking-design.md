# Strict Type Checking Improvements

## Context

The codebase already has strong type discipline: `strict: true`, `noUncheckedIndexedAccess: true`, zero `any` in production code, zero `@ts-ignore`/`@ts-expect-error`, 23+ hand-rolled type guards, and triple-layer enforcement (pre-commit + CI + build).

This design captures the remaining opportunities to tighten type checking further, organized into five sections.

## Phase 1 (This Session)

### Section 1: Additional Compiler Flags

Add to both `tsconfig.json` and `src/lib/public/tsconfig.json`:

| Flag | Purpose | Estimated fixes |
|------|---------|-----------------|
| `noImplicitReturns` | Catch functions that forget to return on all paths | ~0 |
| `noFallthroughCasesInSwitch` | Catch missing `break`/`return` in switch cases | ~0 |
| `exactOptionalPropertyTypes` | Prevent assigning `undefined` to optional properties (must omit or `delete`) | ~25 (20 src, 5 test) |
| `noPropertyAccessFromIndexSignature` | Require bracket notation for index-sig properties (or type them properly) | ~110 (most eliminated by Section 3) |

**`exactOptionalPropertyTypes` fix pattern:**

```typescript
// Before:
const obj = { optionalField: cond ? value : undefined };

// After:
const obj = { ...(cond && { optionalField: value }) };
```

```typescript
// Before:
instance.pid = undefined;

// After:
delete instance.pid;
```

### Section 2: Type the RelayMessage Unknown Fields

Replace `unknown`/`unknown[]` with concrete types in `shared-types.ts`:

| Variant | Field | Current | New Type |
|---------|-------|---------|----------|
| `tool_executing` | `input` | `unknown` | `Record<string, unknown> \| undefined` |
| `session_switched` | `history.messages` | `unknown[]` | `HistoryMessage[]` |
| `history_page` | `messages` | `unknown[]` | `HistoryMessage[]` |
| `project_list` | `projects` | `unknown[]` | `ProjectInfo[]` |
| `pty_list` | `ptys` | `unknown[]` | `PtyInfo[]` (already defined) |
| `file_history_result` | `versions` | `unknown[]` | `FileVersion[]` |

New interfaces to define in `shared-types.ts`:

```typescript
export interface HistoryMessage {
  id: string;
  role: string;
  content?: string;
  parts?: HistoryMessagePart[];
  createdAt?: string | number;
  [key: string]: unknown;
}

export interface ProjectInfo {
  slug: string;
  title: string;
  directory: string;
  instanceId?: string;
}

export interface FileVersion {
  version: string;
  timestamp: number;
  [key: string]: unknown;
}
```

Zero runtime changes — consumers already assume these shapes.

### Section 3: Typed Handler Payloads

The architectural centerpiece. Currently all handlers receive `payload: Record<string, unknown>` and manually coerce each property. This creates ~60 of the `noPropertyAccessFromIndexSignature` violations and requires defensive `String(payload.x ?? "")` patterns.

**Add a `PayloadMap` type** mapping each message type to its concrete payload:

```typescript
// handlers/payloads.ts
export interface PayloadMap {
  message: { text: string };
  cancel: {};
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
  list_sessions: {};
  search_sessions: { query: string };
  load_more_history: { sessionId?: string; offset: number };
  get_agents: {};
  switch_agent: { agentId: string };
  get_models: {};
  switch_model: { modelId: string; providerId: string };
  set_default_model: { provider: string; model: string };
  get_commands: {};
  get_projects: {};
  add_project: { directory: string; instanceId?: string };
  get_todo: {};
  get_file_list: { path?: string };
  get_file_content: { path: string };
  get_file_tree: {};
  get_tool_content: { toolId: string };
  terminal_command: { action: string; ptyId?: string };
  pty_create: {};
  pty_input: { ptyId: string; data: string };
  pty_resize: { ptyId: string; cols?: number; rows?: number };
  pty_close: { ptyId: string };
  cancel: {};
  rewind: { messageId?: string; uuid?: string };
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

**Update `MessageHandler`** to be generic over the payload type:

```typescript
export type MessageHandler<K extends keyof PayloadMap = keyof PayloadMap> = (
  deps: HandlerDeps,
  clientId: string,
  payload: PayloadMap[K],
) => Promise<void>;
```

**Update `dispatchMessage`** to cast at a single boundary:

```typescript
export async function dispatchMessage(
  deps: HandlerDeps,
  clientId: string,
  handler: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const fn = MESSAGE_HANDLERS[handler];
  if (fn) {
    // Single trust boundary — Phase 2 adds Valibot validation here
    await fn(deps, clientId, payload as PayloadMap[typeof handler & keyof PayloadMap]);
  }
}
```

**Effect:** Each handler function signature changes from `payload: Record<string, unknown>` to e.g. `payload: PayloadMap["switch_model"]`, and all manual `String(payload.x ?? "")` coercions become direct property access with the correct type.

### Section 4: Lint Rules

| Rule | From | To | Effect |
|------|------|----|--------|
| `style/noNonNullAssertion` (Biome) | `off` | `warn` | Flags 8 prod `!` assertions; blocks new ones |
| Test `any` cleanup | 6 usages | 0 | Replace with `unknown` or proper mock types |

Not adding an "explicit return types on all exports" rule — would affect ~440 functions for minimal gain given `strict: true` already infers correctly.

### Section 5: Remaining Index Signature Fixes

After Section 3 eliminates ~60 handler payload violations, ~50 remain:

| File(s) | Pattern | Fix |
|---------|---------|-----|
| `sse-wiring.ts` (~14) | `event.properties.X` before type guard | Add declared properties to SSE event interfaces |
| `history-logic.ts` (~10) | `part.state/callID/tool/time` on `HistoryMessagePart` | Add declared optional properties to `HistoryMessagePart` |
| `ipc-protocol.ts` (~20) | `cmd.name/port/url` on `IPCCommand` | Type `IPCCommand` as discriminated union on `action` |
| `ws-router.ts` (~6) | `IncomingMessage` accesses | Handled by type narrowing in `routeMessage` |

Same philosophy as Section 3: type the data, don't bracket-notate the accesses.

## Phase 2 (Deferred)

Add Valibot runtime validation at the WebSocket trust boundary:
- Validate incoming client messages (~33 types) in `dispatchMessage` before calling handlers
- Replace the single `as` cast with `v.parse(schema, payload)`
- Optional: validate outgoing `RelayMessage` in dev mode
- Optional: replace hand-rolled type guards in `opencode-events.ts` with Valibot schemas

## Success Criteria

- `pnpm check` passes with all 4 new compiler flags enabled
- `pnpm test` passes
- `pnpm lint` passes (with `noNonNullAssertion: warn`)
- Zero new `any` in production code
- Zero `@ts-ignore` / `@ts-expect-error`
- All handler functions receive typed payloads instead of `Record<string, unknown>`
- All `RelayMessage` variants have concrete types (no `unknown[]`)
