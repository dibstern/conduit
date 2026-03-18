# Design: New Session Performance + Project Right-Click

## Problem

1. **"New Session" perceived latency**: Clicking "New Session" blocks on a server round-trip (HTTP POST to OpenCode API + session list fetch) before the UI updates. Users see a frozen UI for ~100-500ms+.
2. **No right-click on projects**: ProjectSwitcher renders `<div onclick>` — no `<a href>`, so browsers can't offer "Open in New Tab" on right-click.
3. **Multi-project multi-tab safety**: Investigated — architecture already isolates projects across tabs (per-project relays, scoped REST/SSE via `x-opencode-directory` header, independent JS contexts per tab). No code changes needed.

## Item 1: Faster New Session — Typed State Machine + Correlation IDs

### Current Flow (slow path)

```
Click → wsSend("new_session") → [wait for server] → session_switched → UI updates
                                   ↑ 100-500ms+ ↑
```

### New Flow (non-blocking broadcast + correlated)

```
Click → disable button + show spinner → wsSend("new_session", requestId)
                                                ↓
        session_switched(id, requestId) arrives → match requestId → re-enable button → done
        timeout (5s) or error                   → show toast → reset to idle
```

> **Note:** No optimistic UI clearing. The server-side change (non-blocking broadcast) is where the real latency win lives. The existing `session_switched` dispatch handler already handles clearing messages/permissions/todos when the server responds. See implementation plan for rationale.

### Frontend State Machine

New typed state in `session.svelte.ts`:

```typescript
type SessionCreationStatus =
    | { phase: 'idle' }
    | { phase: 'creating'; requestId: string; startedAt: number }
    | { phase: 'error'; message: string; requestId: string };

export const sessionCreation = $state<{ value: SessionCreationStatus }>({ value: { phase: 'idle' } });
```

**Transitions:**
- `idle → creating`: User clicks "New Session". Generate `requestId` via `crypto.randomUUID()`. Disable button and show loading spinner. Send WS message with `requestId`. No optimistic clearing — the server-side non-blocking broadcast is where the latency win lives.
- `creating → idle`: Server responds with `session_switched` containing matching `requestId`. Apply the real session ID and URL.
- `creating → error`: Timeout (5 seconds) or server error. Show toast, reset button.
- `error → idle`: Auto-reset after toast.

**Guard:** `createSession()` rejects (no-op) when `phase !== 'idle'`, preventing double-clicks.

### Correlation ID Protocol

**Payload change:**
```typescript
// PayloadMap addition
new_session: { title?: string; requestId?: string }

// Response augmentation (session_switched already exists)
{ type: "session_switched", id: string, requestId?: string, ... }
```

**Server (`handleNewSession`):**
- Read `requestId` from payload
- Echo it back in `session_switched` response
- Session list broadcast: `.catch(err => log(err))` — logged, not swallowed

**Client (`handleSessionSwitched` in `session.svelte.ts`):**
- `completeNewSession` is called inside `handleSessionSwitched` (co-located, not in the dispatch switch) so the wiring can't be accidentally broken
- If `msg.requestId` matches `sessionCreation.requestId` → completion, transition to `idle`
- If no match → existing behavior (external session switch from another tab or server-initiated)

### Button UI

**Sidebar.svelte** (line 169-178) and **SessionList.svelte** (line 270-277):
- `idle`: Normal button with text/icon
- `creating`: Spinning/loading icon, `disabled` attribute or `pointer-events-none`
- `error`: Normal button (auto-reset), toast shown separately

### Server Optimization

In `handleNewSession` (`handlers/session.ts:166-185`):

```typescript
export async function handleNewSession(deps, clientId, payload) {
    const { title, requestId } = payload;
    const session = await deps.sessionMgr.createSession(title, { silent: true });

    deps.wsHandler.setClientSession(clientId, session.id);
    deps.wsHandler.sendTo(clientId, {
        type: "session_switched",
        id: session.id,
        ...(requestId != null && { requestId }),
    });

    // Session list broadcast — non-blocking, logged on failure
    deps.sessionMgr.listSessions().then(sessions => {
        deps.wsHandler.broadcast({ type: "session_list", sessions });
    }).catch(err => {
        deps.log(`   [session] Failed to broadcast session list: ${err}`);
    });

    deps.log(`   [session] client=${clientId} Created: ${session.id}`);
}
```

### Error Cases

| Scenario | Detection | User Experience |
|----------|-----------|-----------------|
| OpenCode API down | `createSession()` throws → no `session_switched` sent | Timeout → toast "Failed to create session" |
| WS disconnects during creation | `session_switched` never arrives | Timeout → toast; WS reconnect handler resets state |
| Double-click | State machine guard | Second click ignored (button disabled) |
| Click "New Session" then switch session | Correlation ID mismatch | Old `session_switched` processed normally; new session response discarded if it arrives after manual switch |

## Item 2: Right-Click on Projects in ProjectSwitcher

### Current State

`ProjectSwitcher.svelte` renders project items as `<div onclick>` (lines 259 and 296). This was the exact same bug previously fixed in `SessionItem.svelte` (which now uses `<a>` tags with `href`).

| Component | Element | Has href | Right-click works |
|-----------|---------|----------|-------------------|
| SessionItem.svelte | `<a>` | Yes | Yes |
| DashboardPage.svelte | `<a>` | Yes | Yes |
| ProjectSwitcher.svelte | `<div>` | No | **No** |

### Change

Convert `<div onclick>` to `<a href onclick>` in both rendering paths (multi-instance at line 259 and single-instance at line 296).

**`selectProject` signature change:**
```typescript
// Before
function selectProject(slug: string) { ... navigate(...); }

// After
function selectProject(e: MouseEvent, slug: string) {
    // Modifier keys (Cmd/Ctrl+click) trigger onclick but should use native
    // browser behavior (open in new tab). Middle-click and right-click don't
    // fire onclick at all — they're handled by the browser natively via href.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    open = false;
    showAddForm = false;
    closeMobileSidebar();
    navigate(`/p/${slug}/`);
}
```

**Template change (both locations):**
```svelte
<!-- Before -->
<div ... onclick={() => selectProject(project.slug)}>

<!-- After -->
<a href="/p/{project.slug}/" ... onclick={(e) => selectProject(e, project.slug)}>
```

The `href` enables native browser right-click "Open in New Tab". The `e.preventDefault()` in `onclick` preserves SPA navigation for normal clicks.

Remove the a11y suppression comments (`a11y_click_events_have_key_events`, `a11y_no_static_element_interactions`) since `<a>` elements are natively interactive.

### Styling

Add `no-underline` class (same as `SessionItem.svelte:165`) and `color: inherit` to prevent default anchor styling.

## Item 3: Multi-Project Multi-Tab Safety

**No code changes needed.** Investigation summary:

- Each project gets its own `ProjectRelay` with independent `SessionManager`, `OpenCodeClient`, `SSEConsumer`, `MessagePoller`, `WebSocketHandler`
- `OpenCodeClient` scopes all REST calls via `x-opencode-directory` header; SSE events scoped via same header
- WS upgrade handler routes by slug to correct relay's WS handler
- Frontend stores are module-level singletons per JS context — each tab is its own context
- localStorage keys are all global UI preferences, no project-specific conflicts

**Known within-project edge case** (not in scope): `SessionManager.activeSessionId` is per-relay. Two tabs on the same project viewing different sessions can cause the poller to follow the last-switched session. `SessionRegistry` provides per-client routing as the primary mechanism (`resolve-session.ts:17-18`); `activeSessionId` is fallback only.

## Files to Modify

### Item 1
- `src/lib/frontend/stores/session.svelte.ts` — add `SessionCreationStatus` type and `sessionCreation` state
- `src/lib/frontend/stores/ws-dispatch.ts` — no changes needed (`completeNewSession` is co-located inside `handleSessionSwitched`)
- `src/lib/frontend/components/layout/Sidebar.svelte` — button guard + loading state (no optimistic clear)
- `src/lib/frontend/components/features/SessionList.svelte` — button guard + loading state (no optimistic clear)
- `src/lib/handlers/session.ts` — echo `requestId`, fire-and-forget session list
- `src/lib/handlers/types.ts` — add `requestId` to `PayloadMap["new_session"]`
- `src/lib/shared-types.ts` — add `requestId` to session_switched message type (if typed there)
- New tests: state machine transitions, correlation ID matching, timeout behavior

### Item 2
- `src/lib/frontend/components/features/ProjectSwitcher.svelte` — `<div>` → `<a>` (2 locations)
- New/updated tests: right-click behavior, href generation
