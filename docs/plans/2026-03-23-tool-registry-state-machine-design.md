# Tool Registry State Machine Design

## Problem

Tool lifecycle state in the frontend is managed ad-hoc across multiple handlers in `chat.svelte.ts`. Each handler (`handleToolStart`, `handleToolExecuting`, `handleToolResult`, `handleDone`) independently mutates tool status with no guards against invalid transitions. This created a race condition where `handleDone` cleared `toolUuidMap`, causing late-arriving `tool_result` events to be silently dropped and leaving tool cards permanently stuck.

The deeper issue: nothing in the codebase prevents backward state transitions (e.g. `completed -> running`), and silent drops make debugging impossible.

## Approach: Centralized ToolRegistry (Approach A)

A `ToolRegistry` class that owns all tool state transitions and the callID-to-UUID mapping. Handlers become thin dispatchers that call registry methods, pattern-match the result, and apply mutations to `chatState.messages`.

### What changes

| File | Change |
|------|--------|
| `src/lib/frontend/stores/tool-registry.ts` | New. ToolRegistry class + factory. |
| `src/lib/frontend/stores/chat.svelte.ts` | Handlers become thin dispatchers. `toolUuidMap` deleted. `handleDone` calls `registry.finalizeAll()`. `clearMessages` calls `registry.clear()`. |
| `src/lib/frontend/stores/ws-dispatch.ts` | `handleToolContentResponse` uses `registry.getUuid(toolId)` instead of scanning by `.id`. |

### What doesn't change

- `chatState.messages` stays as the reactive source
- `ToolMessage` interface unchanged -- no component changes
- Server-side code (event-translator, message-poller, sse-wiring) untouched
- `groupMessages`, history-logic, all rendering components untouched

## Design

### Valid transition table

```
pending   -> running, completed, error   (forward only)
running   -> completed, error            (forward only)
completed -> (terminal)
error     -> (terminal)
```

### Registry API

```typescript
interface ToolRegistry {
  start(id: string, name: string, messageId?: string): ToolTransitionResult;
  executing(id: string, input?: unknown, metadata?: Record<string, unknown>): ToolTransitionResult;
  complete(id: string, content: string, isError: boolean, extras?: TruncationExtras): ToolTransitionResult;
  finalizeAll(messages: readonly ChatMessage[]): FinalizationResult;
  clear(): void;
  getUuid(callId: string): string | undefined;
}
```

### Return types

```typescript
type ToolTransitionResult =
  | { action: "create"; tool: ToolMessage }
  | { action: "update"; uuid: string; tool: ToolMessage }
  | { action: "reject"; reason: string }
  | { action: "duplicate" }

type FinalizationResult =
  | { action: "finalized"; indices: number[] }
  | { action: "none" }
```

### Transition enforcement

The registry maintains an internal `Map<string, { uuid: string; status: ToolStatus }>` keyed by callID. On each method call it:

1. Looks up current status for the callID
2. Checks the transition against the valid table
3. If valid: updates internal state, returns `{ action: "update", ... }`
4. If invalid: logs a dev warning, returns `{ action: "reject", reason }`
5. If unknown callID on `executing`/`complete`: logs a warning, returns `{ action: "reject" }`

### Handler integration pattern

Handlers in `chat.svelte.ts` become:

```typescript
export function handleToolExecuting(msg) {
  const result = registry.executing(msg.id, msg.input, msg.metadata);
  switch (result.action) {
    case "update":
      applyToolUpdate(result.uuid, result.tool);
      break;
    // "reject" logged internally by registry
  }
}
```

Shared helpers `applyToolCreate(tool)` and `applyToolUpdate(uuid, tool)` consolidate the immutable-array-replacement boilerplate.

### handleDone integration

```typescript
export function handleDone(_msg) {
  // ... flush assistant render ...
  const result = registry.finalizeAll(chatState.messages);
  if (result.action === "finalized") {
    // apply force-completions at the returned indices
  }
  chatState.streaming = false;
  chatState.processing = false;
  chatState.currentAssistantText = "";
  // registry is NOT cleared here -- late events can still arrive
}
```

### Diagnostics

Three levels, gated by `import.meta.env.DEV`:

- **warn** (backward transition): `Rejected transition: tool "Edit" (toolu_abc) completed -> running`
- **info** (dedup): `Duplicate tool_start for "Read" (toolu_xyz), re-registered UUID`
- **warn** (orphan): `tool_result for unknown tool ID "toolu_???". No matching tool_start received.`

Production: first N warnings per session only (avoid console spam).

### Assistant-text finalization

`handleToolStart` currently flushes the streaming assistant text buffer before inserting a tool. This logic stays in `chat.svelte.ts` since it concerns assistant message state, not tool lifecycle. The registry's `start()` method only handles tool state; the caller handles assistant finalization before calling it.

## Test strategy

Unit tests for the registry in isolation:
- Happy path: start -> executing -> complete
- Backward transitions rejected: complete -> running, error -> pending
- Orphan events: executing/complete without start
- Dedup: duplicate tool_start returns `{ action: "duplicate" }`
- finalizeAll: forces pending/running to completed, returns indices
- clear: resets all state

Existing integration and unit tests continue passing since external behavior is identical.
