# Multi-Tab Session Isolation

## Problem

`SessionManager.activeSessionId` is a mutable singleton per relay. When multiple tabs view the same project but different sessions, this global state can cause:

1. **Wrong session on reconnect** (`client-init.ts:89`): A reconnecting client without `?session=` gets whichever session another tab last triggered `createSession`/`deleteSession` for.
2. **Wrong fallback in handlers** (`resolve-session.ts:19`): During the brief window between WS connect and the first `view_session`, actions resolve to the global session, not the client's intended session.
3. **Translator state corruption**: The event translator is a single instance with a flat `seenParts` map. `translator.reset()` on session lifecycle events wipes state for ALL sessions, causing duplicate `tool_start` events or missed lifecycle transitions for other tabs.
4. **Poller cap too low**: `MAX_CONCURRENT_POLLERS` is 5, which is tight for multi-tab workflows. Users exceeding it get no visible feedback.

## Design

### Part 1: Eliminate `activeSessionId`

Remove the mutable property entirely. Replace with stateless computation where a default session is needed.

**SessionManager changes:**
- Remove: `activeSessionId` property, `getActiveSessionId()`, `setActiveSessionId()`, `switchSession()`
- Add: `async getDefaultSessionId(): Promise<string>` — queries `listSessions()` and returns `sessions[0]?.id`, or creates a new session if none exist
- `createSession()`: Remove `this.activeSessionId = session.id`. Keep lifecycle event emission (Part 3).
- `deleteSession()`: Remove `activeSessionId` check. Accept a `getViewers: (sessionId: string) => string[]` function. Find clients viewing the deleted session, switch them individually to the most recent remaining session via a new `send` event. If no sessions remain, let the affected clients enter a "no session" state (frontend shows empty/create prompt).
- `initialize()`: Remove `activeSessionId` initialization. Return the default session ID for client-init to use.

**`client-init.ts:89`:**
```typescript
// Before:
const activeId = requestedSessionId || sessionMgr.getActiveSessionId();

// After:
const activeId = requestedSessionId || await sessionMgr.getDefaultSessionId();
```

**`resolve-session.ts`:**
```typescript
// Before:
return deps.wsHandler.getClientSession(clientId)
    ?? deps.sessionMgr.getActiveSessionId()
    ?? undefined;

// After:
return deps.wsHandler.getClientSession(clientId);
```
No fallback. If no per-client mapping exists, return `undefined`. Callers handle this as an error — the client hasn't completed init.

**`sse-wiring.ts`:** Remove `getActiveSessionId()` from log strings. Use a static label or omit session from connection lifecycle logs.

### Part 2: Scope the translator per-session

Replace the flat `seenParts: Map<partID, PartInfo>` with a per-session map: `Map<sessionId, Map<partID, PartInfo>>`.

**Translator changes:**
- `translate(event, { sessionId })`: Look up `seenParts.get(sessionId)` (lazy-create if missing). All `isNew` checks are scoped to that session's map.
- `reset(sessionId?: string)`: If `sessionId` provided, clear only that session's parts. If omitted, clear all (for shutdown/cleanup).
- `rebuildStateFromHistory(sessionId, messages)`: Rebuild only the specified session's map.
- FIFO eviction: Per-session cap (10K parts per session). Independent eviction per session.

**relay-stack.ts `session_changed` handler:**
```typescript
// Before:
translator.reset();            // wipes ALL sessions

// After:
translator.reset(sessionId);   // wipes only the changed session
```

### Part 3: Rename `session_changed` to `session_lifecycle`

The event's meaning changes from "the global active session changed" to "a session was created or deleted."

```typescript
// Before:
session_changed: [{ sessionId: string }];

// After:
session_lifecycle: [
  | { type: "created"; sessionId: string }
  | { type: "deleted"; sessionId: string }
];
```

**relay-stack.ts handler** can then distinguish:
- `created`: `translator.reset(sessionId)` (clear any stale parts), rebuild from history, start poller
- `deleted`: `translator.reset(sessionId)` (clean up), stop poller, switch affected clients

### Part 4: Poller cap increase + UI error

**`message-poller-manager.ts`:**
- Change `MAX_CONCURRENT_POLLERS` from 5 to 10
- Add a `capacity_exceeded` event:
  ```typescript
  interface MessagePollerManagerEvents {
    events: [messages: RelayMessage[], sessionId: string];
    capacity_exceeded: [{ sessionId: string; current: number; max: number }];
  }
  ```
- When `startPolling` is called at capacity, emit `capacity_exceeded` instead of silently logging

**relay-stack.ts:** Wire the event to broadcast an error to all clients:
```typescript
pollerManager.on("capacity_exceeded", ({ sessionId, current, max }) => {
  wsHandler.broadcast({
    type: "error",
    code: "POLLER_CAPACITY",
    message: `Cannot monitor more than ${max} active sessions. Session ${sessionId.slice(0,8)}… is not being monitored.`,
  });
});
```

Frontend already handles `error` messages in `ws-dispatch.ts` — verify it renders visibly on mobile viewports.

## Files changed

| File | Change |
|---|---|
| `src/lib/session/session-manager.ts` | Remove `activeSessionId`, add `getDefaultSessionId()`, remove `switchSession()`, refactor `createSession`/`deleteSession`, rename event |
| `src/lib/handlers/resolve-session.ts` | Remove `getActiveSessionId()` fallback |
| `src/lib/bridges/client-init.ts` | Use `getDefaultSessionId()` instead of `getActiveSessionId()` |
| `src/lib/relay/sse-wiring.ts` | Remove `getActiveSessionId()` from log strings |
| `src/lib/relay/event-translator.ts` | Scope `seenParts` per sessionId, accept `sessionId` in `reset()` |
| `src/lib/relay/relay-stack.ts` | Update `session_lifecycle` handler, wire `capacity_exceeded`, pass `sessionId` to `translator.reset()` |
| `src/lib/relay/message-poller-manager.ts` | Increase cap to 10, add `capacity_exceeded` event |
| `src/lib/session/session-manager.ts` | Event rename: `session_changed` → `session_lifecycle` |
| Tests | Update all tests referencing `activeSessionId`, `switchSession`, `session_changed`, translator reset |

## Not in scope

- Making the translator handle concurrent SSE events from multiple sessions with interleaved parts (the per-session map solves the state isolation, but concurrent translation of events from two sessions sharing the same translator instance is a deeper threading concern for later)
- Frontend changes beyond verifying the error toast renders on mobile
- Removing the `?session=` query param infrastructure (it's still useful for reconnection correctness)
