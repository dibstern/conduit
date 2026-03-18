# Code Clarity Audit & Improvement Design

**Date:** 2026-02-26
**Goal:** Improve comprehensibility, testability, and debuggability across the codebase.
**Approach:** Bottom-up extraction — decompose the largest files into focused modules, improving types, logging, and error handling as we go.

## Problem Summary

The codebase has 1518 passing tests and solid architecture, but:

- **relay-stack.ts (1841 lines)** — `createProjectRelay()` is ~1370 lines with a 730-line switch statement, PTY management, mutable closure state, and SSE wiring all in one function scope.
- **Type safety** — 30+ `as` assertions for OpenCode events and WS messages. No type guards or discriminated unions for incoming data.
- **Logging** — `console.log` strings with no session/client context. No way to trace a message through the pipeline.
- **Error handling** — Silent catch blocks in message-cache file ops. Error formatting duplicated across handlers. SSE connection failure not surfaced to clients.
- **Code duplication** — `pty_create` and `terminal_command:create` have ~60 lines of near-identical code.

## Design

### 1. Decompose relay-stack.ts (1841 → ~300 lines)

Extract `createProjectRelay()` into focused modules:

| New Module | Responsibility | ~Lines |
|---|---|---|
| `message-handlers.ts` | Switch statement cases as named functions taking `(deps, clientId, payload)` | ~500 |
| `pty-manager.ts` | `PtyManager` class: `PtySession`, connect, close, replay, scrollback buffer | ~200 |
| `sse-wiring.ts` | SSE event handler: translate, filter by session, cache, broadcast, push notifications | ~150 |
| `client-init.ts` | `client_connected` handler: session restore, model/agent/provider init, PTY replay | ~150 |
| `relay-stack.ts` | Component construction + wiring (slim orchestrator) | ~300 |

**Key decisions:**

- **Message handlers as functions, not closures.** Each handler receives a `HandlerDeps` interface:
  ```typescript
  interface HandlerDeps {
    wsHandler: WebSocketHandler;
    client: OpenCodeClient;
    sessionMgr: SessionManager;
    messageCache: MessageCache;
    permissionBridge: PermissionBridge;
    questionBridge: QuestionBridge;
    overrides: SessionOverrides;
    ptyManager: PtyManager;
    config: ProjectRelayConfig;
    log: (...args: unknown[]) => void;
  }
  ```

- **Mutable state → `SessionOverrides` class.** The closure variables `selectedAgent`, `selectedModel`, `modelUserSelected`, `processingTimer` move to a class with clear methods (`setAgent()`, `setModel()`, `startProcessingTimeout()`, `clear()`).

- **PTY manager as a class.** Encapsulates the `ptySessions` Map, scrollback buffer, upstream WebSocket lifecycle. Eliminates the `null as unknown as WSType` hack.

- **Dedup PTY creation.** `pty_create` and `terminal_command:create` call a shared `createAndConnectPty(deps, clientId)` function.

### 2. Type Safety

**No new dependencies (no Zod).**

- **OpenCode event type guards** in `opencode-events.ts`:
  ```typescript
  interface PartDeltaEvent extends OpenCodeEvent {
    type: "message.part.delta";
    properties: { sessionID: string; messageID: string; partID: string; delta: string; field: string };
  }
  function isPartDeltaEvent(e: OpenCodeEvent): e is PartDeltaEvent { ... }
  ```
  Replace inline `as` casts in event-translator.ts and relay-stack.ts.

- **Discriminated union for incoming WS messages:**
  ```typescript
  type IncomingMessage =
    | { handler: "message"; payload: { text: string } }
    | { handler: "switch_session"; payload: { sessionId: string } }
    | { handler: "permission_response"; payload: { requestId: string; decision: string } }
    | ...
  ```
  Makes the switch statement type-safe and exhaustive.

- **Eliminate `as Record<string, unknown>` patterns** — use proper interfaces for API responses (PTY creation result, provider list, etc.).

### 3. Structured Logging

- **Add context to every log.** Session ID, client ID, and message type where available:
  ```
  Before: [sse] Event: message.part.delta
  After:  [sse] event=message.part.delta session=abc123 part=xyz
  ```

- **Correlation ID for message sends.** When a user sends a message, generate a short request ID that follows through handler → API call → SSE events → broadcast.

- **Log handler entry/exit.** Each extracted message handler logs when it starts and what it broadcasts. This is trivial since each handler is now a named function.

### 4. Error Handling

- **`buildErrorResponse(error, context)` utility.** Centralizes the scattered `if (err instanceof OpenCodeApiError && err.responseBody)` pattern into one function that returns `{ type: "error", code, message }`.

- **Message-cache file ops return `{ ok, error? }`** instead of swallowing errors. Callers decide what to do.

- **SSE connection failure surfaces to clients.** If `sseConsumer.connect()` fails, broadcast an error message rather than silently running with a broken pipeline.

### 5. Documentation for Complex Flows

Targeted documentation (not inline comments everywhere) for the 3 hardest flows:

1. **Session switch** — 3 code paths (cache hit → events, REST fallback → history, error → empty). Decision tree as a comment block at the top of the handler.
2. **PTY lifecycle** — create → notify → connect → scrollback → close. Documented in `pty-manager.ts` module header.
3. **SSE event pipeline** — SSE → translator → session filter → cache → broadcast. Documented in `sse-wiring.ts` module header.

## Non-Goals

- No new dependencies (no Zod, no logging library)
- No architectural changes — the relay pattern stays the same
- No frontend changes — this is backend-only
- No daemon.ts refactoring in this pass (can be a follow-up)

## Risk Mitigation

- **1518 existing tests** catch regressions during extraction
- Extract one module at a time, run full test suite after each
- Types are additive — existing code keeps working as type guards are introduced
- No behavior changes — purely structural refactoring
