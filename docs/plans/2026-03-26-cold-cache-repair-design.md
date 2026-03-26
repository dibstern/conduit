# Cold Cache Repair — Design

## Problem

After conduit restarts, the JSONL message cache can contain partial streaming
events from interrupted assistant turns. The existing staleness check
(`countUniqueMessages` vs REST message count) operates at message-level
granularity and passes even when the last assistant message's content is
truncated — a single delta event with `messageId` is enough to count that
message as "present."

Result: the browser shows truncated messages (e.g. "Pre" instead of
"Pre-commit hook passed (build + lint + full test suite)...").

## Root Cause

Two contributing factors:

1. **Unflushed cache writes on shutdown.** `relay.stop()` never calls
   `messageCache.flush()`. The 200ms batched write timer is `.unref()` and
   won't persist pending events on exit. Streaming events queued in
   `pendingAppends` are lost.

2. **Incomplete staleness detection.** The staleness check compares message
   counts but not content completeness. A cache entry with one partial delta
   from an interrupted turn passes the check because its `messageId` registers
   as a unique message.

## Design

### 1. Surgical cache repair on startup

A pure function repairs each session's event cache after loading from disk:

```
repairColdSession(events: RelayMessage[]): { repaired: RelayMessage[], changed: boolean }
```

**Algorithm:**

1. Walk the events backward to find the last terminal event (`done`,
   `result`, or `error`).
2. If the last event IS a terminal event, the cache is complete — no repair.
3. Otherwise, keep everything up to and including the last terminal event.
4. Also keep any `user_message` events that appear after the terminal (the
   user actually sent those; the assistant just never finished responding).
5. Discard all other events after the terminal (`delta`, `thinking_*`,
   `tool_*`). These are from an interrupted assistant turn.
6. If there are no terminal events at all, keep only `user_message` events.

**Properties:**

- Pure function. No I/O, no side effects. Deterministic.
- Conservative: only removes events from incomplete assistant turns. Complete
  turns and user messages are always preserved.
- After repair, the existing staleness check (`countUniqueMessages <
  actualCount`) correctly detects the missing turn and triggers REST fallback
  on the next session view.

**Event ordering guarantee:** Within a session's cache, events are ordered.
SSE events arrive in wire order on a single connection. The poller runs one
poll at a time per session. Both converge on `recordEvent()` which is
synchronous. JSONL ordering matches memory ordering (batched writes preserve
push order). The backward-walk approach is safe.

### 2. Integration: async, non-blocking

`MessageCache` gets a new method:

```typescript
async repairColdSessions(): Promise<void>
```

Iterates loaded sessions, applies the pure repair function, queues rewrites
for changed sessions via the existing `rewriteFile()` path, then flushes once.

Called in `createProjectRelay()` after `loadFromDisk()`:

```typescript
await messageCache.loadFromDisk();
await messageCache.repairColdSessions();
```

CPU cost: one backward array scan per session (microseconds). I/O cost: one
batched `flush()` for all rewrites (existing mechanism).

### 3. Cache flush on graceful stop

`relay.stop()` calls `messageCache.flush()` before tearing down other
components:

```typescript
async stop() {
    await messageCache.flush();
    clearInterval(timeoutTimer);
    // ... existing stop logic
}
```

Defense-in-depth: flush reduces how often incomplete data reaches disk. Repair
fixes whatever incomplete data does make it.

### 4. Testing

The repair function is pure — unit tests cover:

- Complete session (ends with `done`) — no change
- Complete session (ends with `result`) — no change
- Incomplete turn with trailing deltas — truncated at last terminal
- Incomplete turn with trailing tool events — truncated
- `user_message` after terminal — preserved
- `user_message` + deltas after terminal — user_message kept, deltas removed
- No terminal events, has user_messages — only user_messages kept
- No terminal events, only deltas — empty result
- Empty events — no change
- `done` before `result` ordering — both are terminal, last one wins
- `result` before `done` ordering — same

Integration: verify that repaired caches trigger the staleness check correctly
(cached message count < actual count -> REST fallback).

## Files Changed

| File | Change |
|------|--------|
| `src/lib/relay/cold-cache-repair.ts` | New: pure `repairColdSession()` function |
| `src/lib/relay/message-cache.ts` | Add `repairColdSessions()` method |
| `src/lib/relay/relay-stack.ts` | Call repair after `loadFromDisk()`; call flush in `stop()` |
| `src/lib/relay/__tests__/cold-cache-repair.test.ts` | Unit tests for repair function |
| `src/lib/relay/__tests__/message-cache.test.ts` | Integration test for repair + rewrite |
