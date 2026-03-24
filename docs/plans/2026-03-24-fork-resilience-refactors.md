# Fork Resilience Refactors

Two structural issues in the relay make fork-related bugs easy to introduce and hard to debug. Both have been mitigated with workarounds, but the underlying patterns remain and will cause problems in other features too.

## Problem 1: Bare `session_switched` sends bypass message loading

### What happened

`handleForkSession` sent a raw `session_switched` message with only the session `id`:

```typescript
deps.wsHandler.sendTo(clientId, { type: "session_switched", id: forked.id });
```

The client received this, cleared its messages, and showed an empty chat. The user had to navigate away and back (which triggers `handleViewSession`, the correct path) to see messages.

### Why it was easy to introduce

Nothing prevents any handler from sending `session_switched` directly via `wsHandler.sendTo`. The message type accepts `id` alone — `events` and `history` are optional. TypeScript is happy, linting passes, and the bug only manifests at runtime when a user forks.

### Why a structural fix helps

`handleViewSession` is the only function that correctly loads messages (from cache or REST), sets the client-session association, syncs processing status, seeds pollers, and sends metadata. Every session switch needs all of this. Currently 4+ call sites construct `session_switched` manually, each a potential bug.

### Proposed fix: Centralize session switching

Make `handleViewSession` the single entry point for all session switches. Remove the ability to send `session_switched` directly from handler code.

**Approach:**
1. Audit all places that send `session_switched` (grep for `type: "session_switched"`)
2. Replace each with a call to `handleViewSession`
3. Consider making `session_switched` a type that can only be constructed inside `handleViewSession` (e.g., a private helper that `wsHandler.sendTo` doesn't accept from outside)

**Scope:** Medium — touches every handler that switches sessions (fork, delete, create, view, switch). Each call site may have slightly different needs (e.g., `handleDeleteSession` switches to the next session after deleting).

## Problem 2: `session_list` replaces conduit-owned fields

### What happened

When a user forks a session, conduit stores `parentID` and `forkMessageId` on the session. These are conduit-specific — OpenCode doesn't know about `forkMessageId`, and OpenCode doesn't set `parentID` on user-initiated forks (only on subagent sessions).

The flow:
1. `session_forked` broadcast adds the session to `allSessions` with `parentID` and `forkMessageId` ✓
2. `session_list` (roots: false) arrives and **replaces `allSessions` entirely** with data from OpenCode
3. OpenCode's data has no `parentID` for user forks → `parentID` is lost
4. The fork divider's parent link stops working

`forkMessageId` survived because `toSessionInfoList` enriches sessions from fork metadata. But `parentID` was only coming from OpenCode's `SessionDetail.parentID`, which is null for user forks.

### Why it was easy to introduce

The `handleSessionList` function in the frontend store does a full array replacement:

```typescript
sessionState.allSessions = sessions;
```

Any conduit-owned field that was set by an earlier message (`session_forked`, etc.) is silently destroyed. There's no merge, no warning, and no way to know that fields were lost.

### Why a structural fix helps

As conduit adds more relay-owned metadata (fork info, UI preferences, pinned sessions, custom labels), the "replace everything" pattern will keep destroying data. Every new feature that stores metadata on sessions will hit this same bug.

### Proposed fix: Merge conduit-owned fields during session list updates

**Approach:**
1. Define which fields are "conduit-owned" vs "OpenCode-sourced" (e.g., `forkMessageId` and `parentID` on forked sessions are conduit-owned)
2. In `toSessionInfoList` (server-side), always enrich from conduit's metadata stores — this is partially done for `forkMessageId` already, now also done for `parentID`
3. In `handleSessionList` (client-side), consider a merge strategy: when replacing `allSessions`, preserve conduit-owned fields from the previous array if the new data doesn't include them

**Server-side approach (preferred):** The server already has the fork metadata. `toSessionInfoList` should be the single point where conduit-owned fields are applied. This is simpler and more reliable than client-side merging.

**What's already done:** `parentID` and `forkMessageId` are now both served from fork metadata in `toSessionInfoList`. The immediate bug is fixed. But the architectural principle — "conduit-owned fields must survive session list refreshes" — should be documented and enforced as more metadata is added.

**Scope:** Small for server-side (document the pattern, ensure all conduit-owned fields go through `toSessionInfoList`). Medium for client-side merge (if pursued, needs careful handling of stale data).
