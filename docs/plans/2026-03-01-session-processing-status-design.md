# Session Processing Status — Design

## Problem

Sessions started from the OpenCode TUI (or any non-active session) never show a processing indicator in the opencode-relay sidebar. Additionally, switching to a busy session doesn't show processing state in the chat view.

### Root causes

1. **`SessionInfo.processing` is never populated.** `toSessionInfoList()` in `session-manager.ts` never sets it. The `GET /session/status` API endpoint exists but isn't called.
2. **`client-init.ts:108` hardcodes `status: "idle"`** on client connect, even if the active session is busy.
3. **`handleSwitchSession` sends no status message** after switching, so the frontend doesn't know if the switched-to session is busy.
4. **SSE events for non-active sessions are not broadcast** (`sse-wiring.ts:211`), so `session.status` events for background sessions never reach the frontend.

## Solution: Server-side polling of `GET /session/status`

### New: `OpenCodeClient.getSessionStatuses()`

Wraps `GET /session/status` — returns `Record<string, SessionStatus>` where `SessionStatus` is `{ type: "idle" } | { type: "busy" } | { type: "retry", attempt, message, next }`.

### New: `SessionStatusPoller`

- Polls `GET /session/status` every 500ms
- Maintains a `Map<sessionId, SessionStatus>` of current state
- On each poll, diffs against previous state
- When any session's status changes, emits a `changed` event
- Exposes `getCurrentStatuses()` for on-demand reads
- Starts on relay boot, stops on shutdown
- On poll failure: logs warning, skips update, retries next tick (stale > empty)

### Modified: `SessionManager.listSessions(statuses?)`

Accepts an optional `statuses` map. When provided, sets `processing: true` on sessions whose status is `"busy"` or `"retry"`.

### Modified: Relay stack wiring

- `SessionStatusPoller.on("changed")` → calls `sessionMgr.listSessions(statuses)` → broadcasts `session_list` to all clients
- Existing `session.updated` SSE handler already broadcasts session list — this continues unchanged

### Modified: `client-init.ts`

- Reads current session status from poller (or calls API directly)
- Sends `status: "processing"` instead of `status: "idle"` when active session is busy
- Passes statuses to `listSessions()` so the initial session list includes processing flags

### Modified: `handleSwitchSession`

- After switching, checks session status
- Sends `status: "processing"` if the switched-to session is busy

### Frontend: No changes needed

- `SessionItem.svelte:66-69` already derives `isProcessing` from `session.processing`
- `chatState.processing` is already set by incoming `status: "processing"` messages
- The pulsing dot CSS animation already exists

## Data flow

```
OpenCode API                    Relay Server                      Browser
─────────────                   ────────────                      ───────
GET /session/status  ←── poll ── SessionStatusPoller (500ms)
  { sess_1: busy }                    │
                                      ├─ diff → changed!
                                      │
                              SessionManager.listSessions(statuses)
                                      │
                              session_list { processing: true }  ──→  SessionItem
                                                                       └─ pulsing dot
```

## Error handling

- Poll failure: log, skip, retry next tick
- API unavailable: keep last known state (stale data > no data)
- No sessions busy: still poll (to detect transitions)
