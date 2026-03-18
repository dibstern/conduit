# WebSocket Connection Lifecycle Observability

## Problem

The frontend WebSocket connection code has no lifecycle logging. When a connection hangs, there are no breadcrumbs to determine whether the problem is server-side (relay not ready) or client-side (code path stuck). The recent connection bug was invisible for 12 tasks because all observability pointed at the server while the client never progressed past an async pre-flight.

## Goal

Make connection issues self-diagnosing: every state transition is logged, timing is visible, and a debug panel can be activated even when the UI is stuck.

## Design

### 1. Feature Flags (`src/lib/frontend/stores/feature-flags.svelte.ts`)

A typed, extensible feature flag system with three activation paths:

```ts
type FeatureFlag = "debug";  // extend this union for future flags

export const featureFlags = $state({ debug: false });

export function initFeatureFlags(): void;     // reads URL + localStorage
export function isFeatureEnabled(flag: FeatureFlag): boolean;
export function enableFeature(flag: FeatureFlag): void;
export function disableFeature(flag: FeatureFlag): void;
export function toggleFeature(flag: FeatureFlag): void;
export function getEnabledFeatures(): FeatureFlag[];
```

**Activation paths:**
1. **URL**: `?feats=debug` (comma-separated, validated against `FeatureFlag` type, persisted to localStorage)
2. **localStorage**: key `feature-flags` (JSON array of flag names)
3. **Settings dialog**: "Debug" tab toggle calls `toggleFeature("debug")`
4. **Keyboard shortcut**: `Ctrl+Shift+D` / `Cmd+Shift+D` calls `toggleFeature("debug")`

Invalid flag names in URLs are silently ignored.

### 2. Debug Store (`src/lib/frontend/stores/ws-debug.svelte.ts`)

Ring buffer of timestamped lifecycle events:

```ts
interface WsDebugEvent {
  time: number;              // Date.now()
  event: string;             // "connect", "ws:open", "ws:close", etc.
  detail?: string;           // "slug=my-project", "delay=1500ms"
  state: ConnectionStatus;   // state AFTER this event
}
```

- **Ring buffer**: last 50 events, always recording regardless of debug flag
- **`wsDebugLog(event, detail?)`**: pushes to ring buffer; when `featureFlags.debug` is true, also calls `console.debug("[ws]", ...)`
- **`window.__wsDebug()`**: always registered, returns JSON-serializable snapshot of current state + full ring buffer

### 3. Console Breadcrumbs

`wsDebugLog()` calls inserted at every lifecycle point in `ws.svelte.ts`:

| Event | Location | Detail |
|-------|----------|--------|
| `connect` | `connect()` entry | slug, attempt# |
| `ws:create` | after `new WebSocket()` | URL |
| `ws:open` | `open` listener | — |
| `ws:close` | `close` listener | code, reason |
| `ws:error` | `error` listener | — |
| `ws:message` | `message` listener | first + every 100th |
| `timeout` | connect timeout fires | — |
| `reconnect:schedule` | `scheduleReconnect()` | delay |
| `reconnect:fire` | reconnect timer fires | — |
| `disconnect` | `disconnect()` called | — |
| `relay:status` | `fetchRelayStatus()` result | status value |
| `self-heal` | self-healing onmessage path | — |

### 4. Debug Panel (`src/lib/frontend/components/debug/DebugPanel.svelte`)

Floating panel, bottom-right, shown when `featureFlags.debug` is true:

- **Current state**: status, statusText, time-in-state (live counter), attempts, relayStatus
- **Transition log**: scrollable, last ~20 events with relative timestamps ("+0ms connect slug=x", "+12ms ws:create wss://...")
- **Close button**: hides panel but keeps debug mode on, ring buffer still records
- ~300px wide, max 250px tall, semi-transparent background, small monospace font

### 5. Header Integration

The existing hidden debug button (`#debug-menu-wrap` in Header.svelte) is shown when `featureFlags.debug` is true. Clicking it toggles the debug panel visibility (not the debug mode itself).

### 6. Settings Tab

New "Debug" tab in `SettingsPanel.svelte` with:
- Toggle: "Connection debug panel" → calls `toggleFeature("debug")`
- Info text: "Also available via URL param `?feats=debug` or keyboard shortcut `Ctrl+Shift+D`"

## Files

| File | Change |
|------|--------|
| `src/lib/frontend/stores/feature-flags.svelte.ts` | **New** — typed feature flag system |
| `src/lib/frontend/stores/ws-debug.svelte.ts` | **New** — debug store, ring buffer, `window.__wsDebug()` |
| `src/lib/frontend/stores/ws.svelte.ts` | Add `wsDebugLog()` calls at 12 lifecycle points |
| `src/lib/frontend/components/debug/DebugPanel.svelte` | **New** — floating debug panel |
| `src/lib/frontend/components/layout/Header.svelte` | Show debug button when enabled, wire click |
| `src/lib/frontend/components/layout/ChatLayout.svelte` | Mount DebugPanel, `initFeatureFlags()`, keyboard shortcut |
| `src/lib/frontend/components/overlays/SettingsPanel.svelte` | Add "Debug" tab |

## What This Catches

- **Connection stuck in pre-flight**: Ring buffer shows `connect` event but no `ws:create` — gap is immediately visible
- **WebSocket never opens**: `ws:create` present but no `ws:open` before `timeout` — server-side issue
- **Rapid reconnect loop**: Buffer fills with `ws:close` → `reconnect:schedule` → `connect` cycles
- **Relay not ready**: `relay:status` event shows "registering" — expected delay, not a bug
- **Self-healing activated**: `self-heal` event shows onmessage path corrected a missed onopen
