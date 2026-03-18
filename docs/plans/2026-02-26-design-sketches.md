# Design Sketches for All Open Issues

Generated 2026-02-26. These are design-level directions, not full implementation plans.

---

## 🔴 Session Switching: Messages Still Disappearing

**Root cause (confirmed by code trace):**

Two interacting bugs:

### Bug A: HistoryView `$effect` race condition (REST fallback path)

In `ws.svelte.ts` line 321–345, the `session_switched` handler runs synchronously:

```
1. handleSessionSwitched(msg)  → sets sessionState.currentId = "A"
                                  (schedules HistoryView $effect)
2. clearMessages()             → clears chatState.messages
3. dispatch history to         → historyMessages = loaded messages
   HistoryView
--- synchronous execution ends ---
4. Svelte effect flush         → $effect fires: historyMessages = []  ← WIPES DATA
```

The `$effect` in `HistoryView.svelte` lines 121–141 clears `historyMessages` whenever `sessionState.currentId` changes, but it fires AFTER the history data was already loaded in step 3.

### Bug B: False-positive cache hit (cache-hit path)

When the relay receives ANY SSE event for a session (e.g., `session.status: idle` on connect), it records a translated event in the cache. Now `messageCache.getEvents("A")` returns non-null (e.g., `[{ type: "done", code: 0 }]`), so the cache-hit path is taken instead of the REST fallback. The replay produces no visible messages because the cache only has lifecycle events, not actual message content. Historical messages from before the relay started are never loaded.

### Fix (addresses both bugs):

**Option 1 — "Always include history" (recommended):**

Change the `switch_session` handler and `client_connected` handler to ALWAYS fetch REST history, regardless of cache state. Send both:

```typescript
wsHandler.broadcast({
  type: "session_switched",
  id,
  events: cachedEvents ?? undefined,   // for live chat replay
  history: { messages, hasMore, total } // for HistoryView (always present)
});
```

On the frontend, change the `session_switched` handler to:
1. Clear messages
2. Dispatch history to HistoryView (always, from `msg.history`)
3. Replay events into chatState (if `msg.events` present)

Remove the HistoryView `$effect` entirely — stale data clearing is now done explicitly by the `session_switched` handler calling a `resetHistoryView()` function BEFORE dispatching new history.

**Tradeoff:** Extra REST call on every switch, even for cache-hit sessions. Acceptable since session switches are user-initiated and infrequent.

**Option 2 — "Fix the race, fix the cache check":**

Two separate fixes:
- Remove the HistoryView `$effect`. Have the `session_switched` handler call `resetHistoryView()` synchronously before dispatching history.
- Add a `hasChatEvents(sessionId)` method to MessageCache that checks for `user_message`, `delta`, `tool_start`, etc. Only take the cache-hit path if meaningful chat events exist.

**Tradeoff:** More complex cache logic, risk of missing edge cases where the cache appears to have chat events but is actually incomplete.

---

## Still-Open Issues: Design Sketches

### H8: `session_switched` broadcast affects ALL clients

**Problem:** `wsHandler.broadcast()` sends to every connected browser. If Client A switches to session X, Client B (viewing session Y) also gets `session_switched` for X and its view is clobbered.

**Fix:** Change `wsHandler.broadcast(...)` to `wsHandler.sendTo(clientId, ...)` in the `switch_session` handler at lines 764–789 of `relay-stack.ts`. The `clientId` is available from the message handler's destructured args (`{ clientId, handler, payload }`).

For the `sessionMgr.on("broadcast")` path (line 589, used by `createSession`/`deleteSession`): these are legitimately global — a new/deleted session should update all clients' session lists. But `session_switched` from `createSession` should also be per-client. Refactor to emit `send` (with clientId) instead of `broadcast` for session switches.

**Deeper question:** Should the relay support per-client active sessions? Currently there's ONE `activeSessionId` per relay. If Client A switches to X, the relay's active session becomes X, and all SSE events for X are broadcast to all clients. This is the same model as `claude-relay`. True per-client sessions would require each client to track its own active session and the relay to multiplex SSE events per-client — significant architectural change, probably not worth it. Document as known limitation.

### M1: `consumeStream()` try-finally error propagation

**Status:** Reassessed as non-issue. The error from `consumeStream()` propagates to `startStream()`'s catch block, which was fixed in H1 to emit error + schedule reconnect. No fix needed.

### M5: `pnpm check` doesn't validate frontend types

**Problem:** `tsc --noEmit` doesn't process `.svelte` files, so type errors in Svelte components go undetected until runtime.

**Fix:** Add `svelte-check` to the project:
```bash
pnpm add -D svelte-check
```
Add to `package.json`:
```json
"check:svelte": "svelte-check --tsconfig ./tsconfig.json"
```
Update `check` script to run both: `"check": "tsc --noEmit && svelte-check"`.

**Tradeoff:** Adds ~200ms to CI checks. Requires `svelte-check` to be configured to handle the project's path aliases.

### M6: `FileEntry.children` and `SessionInfo.processing` dead fields

**Status:** Reassessed as non-issue. `FileEntry.children` is used by the frontend TreeView component for rendering directory trees. `SessionInfo.processing` is used by the session list to show activity indicators. No fix needed.

### M7: VersionChecker output mismatches frontend `msg.version`

**Problem:** VersionChecker emits `{ current, latest }` but the frontend's `handleBannerMessage` reads `msg.version`. The new translator handler for `installation.update-available` emits `{ type: "update_available", version: props.version }` — this matches what the frontend expects. But the relay's own VersionChecker (for npm updates) uses a different shape.

**Fix:** In `relay-stack.ts`, when the VersionChecker emits `update_available`, map it to the frontend-expected shape:
```typescript
versionChecker.on("update_available", ({ current, latest }) => {
  wsHandler.broadcast({ type: "update_available", version: latest });
});
```

Currently no VersionChecker is wired in relay-stack (it exists in `version-check.ts` but isn't instantiated in the relay pipeline). When it IS wired, use this mapping. Alternatively, just emit a banner-style message.

### M8: No deduplication of cached events on replay

**Problem:** If a client reconnects while events are still streaming, cached events from before the disconnect + live events after reconnect could overlap. The same `tool_start` or `delta` appears twice.

**Fix:** Add a `lastEventIndex` field to the `session_switched` message. On reconnect, the client sends its last-seen index. The server starts replay from that point.

Simpler alternative: Add a monotonic sequence number to each cached event. On replay, the client tracks the highest seen sequence number and ignores events with lower or equal numbers.

**Tradeoff:** Both approaches require protocol changes. The simpler approach (sequence numbers) adds a small overhead per event but is stateless on the server. Given the low frequency of reconnects, this is low priority.

### M9: KeepAwake `setEnabled(true)` does not auto-activate

**Problem:** `KeepAwake` class has `setEnabled(true)` but doesn't call `start()` internally.

**Fix:** In `keep-awake.ts`, make `setEnabled(true)` call `this.start()` if not already active, and `setEnabled(false)` call `this.stop()`:
```typescript
setEnabled(enabled: boolean): void {
  this.enabled = enabled;
  if (enabled && !this.active) this.start();
  if (!enabled && this.active) this.stop();
}
```

Check all call sites to ensure they don't call `start()` separately after `setEnabled(true)` (which would cause a double-start).

### M10: OpenCode revert doesn't immediately remove messages

**Problem:** After `rewind`, the relay calls `client.revertSession()` and clears the cache, but the frontend still shows the reverted messages until the next session refresh.

**Fix:** After `client.revertSession()`, broadcast a `session_switched` with fresh data (re-fetch history from REST API):
```typescript
case "rewind": {
  const messageId = String(payload.messageId ?? payload.uuid ?? "");
  const activeId = sessionMgr.getActiveSessionId();
  if (messageId && activeId) {
    await client.revertSession(activeId, messageId);
    messageCache.remove(activeId);
    // Re-fetch and send updated state
    const history = await sessionMgr.loadHistory(activeId);
    wsHandler.broadcast({
      type: "session_switched",
      id: activeId,
      history: { messages: history.messages, hasMore: history.hasMore, total: history.total },
    });
  }
  break;
}
```

**Dependency:** Requires the session switching fix (Bug A above) so the history data isn't wiped by the $effect.
