# Forked Session Rendering

## Problem

When a user forks a session, the forked session loads all inherited messages identically to normal messages. There is no visual distinction between the prior conversation (inherited from the parent) and new messages in the fork. The user lands in what looks like a continuation of the same chat with no indication of where the fork happened.

Additionally, forked sessions look nearly identical to regular sessions -- only a tiny git-fork icon in the sidebar and a "Subagent of {parent}" back bar (which mislabels user forks as subagent sessions) differentiate them.

## Design

### Data Layer: Fork Point Tracking

**New field: `forkMessageId`**

Add `forkMessageId?: string` to `SessionInfo` in `shared-types.ts`. This is the OpenCode message ID at which the fork occurred -- everything up to and including this message is inherited prior context.

**Setting the fork point:**

In `handleForkSession` (`src/lib/handlers/session.ts`):
- For "fork from here" (has `messageId`): use the provided `messageId` directly.
- For whole-session forks (no `messageId`): after `forkSession()` returns, fetch one page of history for the newly forked session and use the last message's ID.

**Persistence: `~/.conduit/fork-metadata.json`**

`forkMessageId` is conduit-specific metadata -- OpenCode doesn't know about it. Store it in a dedicated JSON file:

```json
{
  "ses_abc123": "msg_xyz789",
  "ses_def456": "msg_uvw012"
}
```

- Written atomically (tmp + rename, same pattern as `daemon.json`).
- Loaded on daemon startup by the session manager.
- Updated when a fork happens.
- The session manager includes `forkMessageId` in `SessionInfo` when building session lists via `toSessionInfoList`.

**Propagation to frontend:**

- `session_forked` broadcast includes `forkMessageId` in the session object.
- `session_list` messages include `forkMessageId` on sessions that have one.
- Frontend stores it on `SessionInfo` in the session store.

### Frontend: Collapsible Prior Context

When viewing a session that has both `parentID` and `forkMessageId`:

**Finding the fork point in ChatMessage[]:**

Scan the `chatState.messages` array for the last `AssistantMessage` or `ToolMessage` whose `messageId === forkMessageId`. Everything up to and including that message (and its associated thinking, tool, and result messages in the same turn) is "prior context." Everything after is "new in this fork."

**ForkContextBlock component (new):**

Wraps the inherited messages. Two states:

- **Collapsed (default):** A compact bar at the top of the chat: `"Prior conversation (N messages)" [expand chevron]`. Styled subtly -- dimmed text, small, not visually heavy.
- **Expanded:** Renders all inherited messages normally but with a visual signal that they're inherited -- a subtle left border or slightly dimmed background. Full interactivity (copy, scroll, etc.).
- Collapse state persisted in `sessionStorage` keyed by session ID.

**ForkDivider component (new):**

Rendered between the prior context block and new messages:

- Thin horizontal rule spanning the chat width.
- Centered label: `Forked from "{parentTitle}"` in small dimmed text (fieldset legend style).
- Parent title is clickable -- navigates to the parent session (reuses `switchToSession` logic).

**MessageList.svelte changes:**

When the current session has `forkMessageId`:
1. Split `chatState.messages` at the fork point.
2. Render `ForkContextBlock` with inherited messages.
3. Render `ForkDivider`.
4. Render remaining messages normally.

When the session has `parentID` but no `forkMessageId` (subagent sessions): no change, existing behavior.

### Frontend: SubagentBackBar

**Distinguishing user forks from subagent sessions:**

The presence of `forkMessageId` naturally differentiates them:
- `parentID` + `forkMessageId` = **user fork** (created via conduit's fork handler).
- `parentID` + no `forkMessageId` = **subagent session** (created by OpenCode's Task tool).

**Behavior change:**

- User forks: **hide** SubagentBackBar. The ForkDivider provides context and parent navigation.
- Subagent sessions: **keep** SubagentBackBar as-is ("Subagent of {parent}" with ESC shortcut).

### Sidebar

No changes needed. Forked sessions already appear correctly in the main session list (OpenCode's `roots=true` filter includes user forks but excludes subagent sessions). The existing git-fork icon on `SessionItem` continues to indicate forked sessions.

## Files to Change

### Data layer
- `src/lib/shared-types.ts` -- add `forkMessageId` to `SessionInfo` and `session_forked`
- `src/lib/handlers/session.ts` -- store fork point in `handleForkSession`
- `src/lib/session/session-manager.ts` -- load/save fork metadata, include in session lists
- New: `src/lib/daemon/fork-metadata.ts` -- read/write `fork-metadata.json`

### Frontend
- New: `src/lib/frontend/components/chat/ForkContextBlock.svelte`
- New: `src/lib/frontend/components/chat/ForkDivider.svelte`
- `src/lib/frontend/components/chat/MessageList.svelte` -- split messages at fork point
- `src/lib/frontend/components/chat/SubagentBackBar.svelte` -- hide for user forks
- `src/lib/frontend/stores/session.svelte.ts` -- handle `forkMessageId` in session data

## Non-Goals

- Changing how OpenCode handles forks internally.
- Adding fork-point tracking to subagent sessions.
- Nested fork visualization (fork of a fork) -- works naturally since each fork has its own `forkMessageId`.
