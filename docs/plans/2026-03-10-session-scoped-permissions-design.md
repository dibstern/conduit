# Session-Scoped Permission Requests

## Problem

When one session requests permissions, that request is broadcast to all connected WebSocket clients. Every browser tab sees the interactive PermissionCard regardless of which session it's viewing. This is confusing — non-relevant sessions should see a notification with a link, not the full approval UI.

## Design

### Principle

Single source of truth + derived views. One permission list, two lenses. TypeScript enforces completeness at compile time.

### Approach

Add required `sessionId` to the `permission_request` relay message. The relay continues to broadcast to all clients. The frontend decides rendering: PermissionCard for the matching session, aggregated notification for others.

### Why frontend filtering (not relay-side routing)

- The split "card vs. notification" is a presentation decision, not a routing decision
- The same data drives both views
- Questions use `sendToSession` but don't notify other sessions — permission notifications are new behavior either way
- Minimal relay changes: one field addition, no new message types

## Type Changes

### `shared-types.ts` — permission_request message

```typescript
| {
    type: "permission_request";
    requestId: string;
    sessionId: string;          // NEW, required
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId?: string;
  }
```

### `types.ts` — PendingPermission

```typescript
export interface PendingPermission {
  requestId: string;
  sessionId: string;            // NEW, required
  toolName: string;
  toolInput: Record<string, unknown>;
  always: string[];
  timestamp: number;
}
```

### `frontend/types.ts` — PermissionRequest

```typescript
export interface PermissionRequest {
  requestId: string;
  sessionId: string;            // NEW, required
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
}
```

All three layers require sessionId. TypeScript catches omissions at compile time.

## Relay Changes

### `event-translator.ts`

`translatePermission()` accepts a `sessionId` parameter. Returns `null` if absent — events without a session ID are dropped (cannot be routed).

### `permission-bridge.ts`

`onPermissionRequest()` accepts and stores `sessionId` on `PendingPermission`. `recoverPending()` likewise includes sessionId.

### `sse-wiring.ts`

Passes `eventSessionId` to `translatePermission()`. Broadcast behavior unchanged — all clients receive all permission messages.

## Frontend Store

### `permissions.svelte.ts`

`handlePermissionRequest` destructures `sessionId` from the message (TypeScript ensures it's present). No new arrays.

Two new pure getter functions:

```typescript
/** Permissions for the session the user is currently viewing */
export function getLocalPermissions(
  currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
  if (!currentSessionId) return [];
  return permissionsState.pendingPermissions.filter(
    (p) => p.sessionId === currentSessionId,
  );
}

/** Permissions for OTHER sessions */
export function getRemotePermissions(
  currentSessionId: string | null,
): (PermissionRequest & { id: string })[] {
  if (!currentSessionId) return permissionsState.pendingPermissions;
  return permissionsState.pendingPermissions.filter(
    (p) => p.sessionId !== currentSessionId,
  );
}
```

Session switches automatically re-partition via `$derived`. No imperative state synchronization.

## Frontend Components

### `MessageList.svelte`

Switch from `permissionsState.pendingPermissions` to `getLocalPermissions(sessionState.currentId)`.

### `PermissionNotification.svelte` (new)

Dedicated component, rendered outside MessageList (in ChatLayout). Fixed position, top-right of the chat area.

- Shows when `getRemotePermissions(currentSessionId).length > 0`
- Groups remote permissions by sessionId
- Displays session count: "1 session needs permission" / "3 sessions need permission"
- Each session is a clickable link showing the session title (from `sessionState.sessions`)
- Clicking navigates to the session
- No dismiss button — persists until all remote permissions are resolved
- Session title resolution: `sessionState.sessions.find(s => s.id === sessionId)?.title ?? sessionId.slice(0, 8) + "…"`

### `ChatLayout.svelte`

Mount `PermissionNotification` component.

## Bug Resistance

| Risk | Mitigation |
|------|-----------|
| Missing sessionId on a permission message | Required on all three type layers — compile error if omitted |
| Events without sessionId in SSE | Translator returns null — event is dropped |
| Stale notification after resolution | Single list, single filter in `handlePermissionResolved` — both views update |
| Session switch leaves card in wrong view | Derived getters re-partition automatically when `currentId` changes |
| Two lists out of sync | There is only one list — local/remote are derived, not stored |

## Files Touched

| File | Change |
|------|--------|
| `src/lib/shared-types.ts` | Add `sessionId` to `permission_request` |
| `src/lib/types.ts` | Add `sessionId` to `PendingPermission` |
| `src/lib/frontend/types.ts` | Add `sessionId` to `PermissionRequest` |
| `src/lib/relay/event-translator.ts` | Accept `sessionId` param in `translatePermission()` |
| `src/lib/bridges/permission-bridge.ts` | Store `sessionId` on entries |
| `src/lib/relay/sse-wiring.ts` | Pass `eventSessionId` to translator |
| `src/lib/bridges/client-init.ts` | Include `sessionId` in replayed permissions |
| `src/lib/frontend/stores/permissions.svelte.ts` | Add `getLocalPermissions()`, `getRemotePermissions()` |
| `src/lib/frontend/components/chat/MessageList.svelte` | Use `getLocalPermissions()` |
| `src/lib/frontend/components/features/PermissionNotification.svelte` | New component |
| `src/lib/frontend/components/layout/ChatLayout.svelte` | Mount notification component |
