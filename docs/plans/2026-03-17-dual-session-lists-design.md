# Dual Session Lists (Roots + All)

## Problem

OpenCode's `GET /session` defaults to returning 100 sessions. The relay never passes `roots=true`, so the 100 returned are a mix of root and subagent sessions. The frontend's default `hideSubagentSessions` filter strips out subagent sessions client-side, leaving very few visible (e.g. 8 out of 486 top-level sessions).

## Root Cause

Two compounding issues:

1. **Default limit of 100** on OpenCode's session API — the relay fetches only 100 of potentially thousands of sessions.
2. **Most of the 100 are subagent sessions** — in the current project, 92 of 100 returned sessions have a `parentID`. The frontend hides them by default, leaving only 8 visible.

## Solution

Maintain two pre-cached session lists on the frontend: **roots-only** and **all**. The server sends both (roots immediately, all in background). Toggling the subagent filter switches instantly between the two cached lists.

## Protocol Change

Add `roots?: boolean` to the `session_list` relay message:

```typescript
| { type: "session_list"; sessions: SessionInfo[]; roots?: boolean }
```

- `roots: true` — list contains only root sessions (no `parentID`)
- `roots: false` or absent — list contains all sessions

Add `roots?: boolean` to the `search_sessions` client message payload so search respects the toggle.

## Backend Changes

### `OpenCodeClient` (`src/lib/instance/opencode-client.ts`)

Add `roots` to `SessionListOptions`:

```typescript
export interface SessionListOptions {
  archived?: boolean;
  roots?: boolean;
}
```

Update `listSessions()` to pass `roots` as a query param.

### `SessionManager` (`src/lib/session/session-manager.ts`)

- `listSessions()` accepts and passes `roots` option through to client.
- `searchSessions()` accepts `roots` and passes both `search` and `roots` to the OpenCode API (which supports both natively via query params).
- New helper method to encapsulate the dual-send pattern: send roots immediately, all in background. Avoids duplicating the pattern across all 9 send points.

### All 9 send points

Each sends two `session_list` messages:

1. Roots-only immediately (tagged `roots: true`)
2. All-sessions in background (tagged `roots: false`)

Send points:
1. `client-init.ts:173` — unicast on connection
2. `session.ts:198` — unicast on view_session
3. `session.ts:232` — broadcast on new_session
4. `session.ts:284` — broadcast on delete_session
5. `session.ts:306` — unicast on list_sessions
6. `session.ts:316` — unicast on search_sessions (uses roots from payload)
7. `session.ts:384` — broadcast on fork_session
8. `sse-wiring.ts:221` — broadcast on session.updated SSE
9. `relay-stack.ts:505` — broadcast on status poller change

## Frontend Changes

### Session store (`src/lib/frontend/stores/session.svelte.ts`)

Replace `sessions` with two arrays:

```typescript
rootSessions: [] as SessionInfo[],
allSessions: [] as SessionInfo[],
```

`handleSessionList()` routes to the right array based on `msg.roots`.

`getFilteredSessions()` reads from `rootSessions` when `hideSubagentSessions` is on, `allSessions` otherwise. Search filter still applies on top.

### Search

`search_sessions` message includes `roots: true` when `hideSubagentSessions` is on.

### Subagent toggle

Switching is instant since both lists are pre-cached.

## Data Flow

```
Client connects
  → Server sends session_list { roots: true }     ← immediate
  → Server sends session_list { roots: false }    ← background

User toggles "show subagent sessions"
  → Frontend switches from rootSessions to allSessions (instant, pre-cached)

SSE event / status change / mutation
  → Server broadcasts session_list { roots: true }   ← immediate
  → Server broadcasts session_list { roots: false }  ← background
```

## Scope

- Does NOT change the default limit (stays at 100 per API call).
- Uses `roots=true` to get the right 100 sessions for the default sidebar view.
- Background fetch gets 100 mixed sessions for the subagent-inclusive view.
