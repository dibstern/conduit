# Audit Bug Report — 2026-03-13

Bugs and issues discovered during the full code audit for the frontend status fix design.
None of these block the current design work. Each should be addressed in a separate pass.

---

## B1. `stopAll()` does not emit `project_removed` events

**File:** `src/lib/daemon/project-registry.ts:376-392`
**Severity:** Medium
**Impact:** During daemon shutdown, `stopAll()` deletes all entries from the registry map
and aborts pending relay creations, but never emits `"project_removed"` events. Any
`waitForRelay()` promises that are mid-wait will NOT be notified via their
`"project_removed"` listener. They time out after 10 seconds instead of rejecting promptly.
This creates a window of orphaned sockets during shutdown.

**Fix:** Emit `"project_removed"` for each entry before deleting, or add a bulk
`"registry_cleared"` event that `waitForRelay` also listens for.

---

## B2. Socket not destroyed on `shuttingDown` path in WS upgrade handler

**File:** `src/lib/daemon/daemon.ts:607`
**Severity:** Low
**Impact:** When `waitForRelay` resolves successfully but `this.shuttingDown` is `true`, the
handler returns without destroying the socket. The socket is abandoned — not upgraded, not
destroyed. It is cleaned up shortly after by the HTTP server closure, but there is a brief
resource leak.

**Fix:**
```typescript
if (socket.destroyed || this.shuttingDown) {
    if (!socket.destroyed) socket.destroy();
    return;
}
```

---

## B3. WS upgrade log message is imprecise

**File:** `src/lib/daemon/daemon.ts:611-614`
**Severity:** Low
**Impact:** The log message says `"WS upgrade rejected: relay not available"` for ALL
rejection reasons, including "project not found," "relay failed," and "timeout." The actual
error is included in the structured log via `formatErrorDetail(err)`, but the human-readable
summary is misleading when debugging.

**Fix:** Include the error class or code in the summary message, e.g.:
`"WS upgrade rejected: ${err.message}"`

---

## B4. `discoverProjects()` does not retry error-state projects

**File:** `src/lib/daemon/daemon.ts:957-991`
**Severity:** Medium
**Impact:** `discoverProjects()` is purely additive — it only adds NEW projects via
`addProject()`. If a project was previously added and is now in the `"error"` state (relay
factory failed), `addProject()` returns the existing project via the duplicate-directory
guard (`daemon.ts:856-857`) and does NOT restart its relay. There is no automatic retry
mechanism for failed relays.

**Fix:** After the discovery loop, iterate registry entries in `"error"` state and call
`registry.startRelay()` with a fresh factory. Or add a separate `retryFailedRelays()` method.

---

## B5. Rehydrated projects can stay in `"registering"` forever

**File:** `src/lib/daemon/daemon.ts:621-632`
**Severity:** Medium
**Impact:** During daemon startup, rehydrated projects are added via `addWithoutRelay()`
(status = `"registering"`). The startup loop at lines 621-632 tries to start relays, but
if `resolveOpencodeUrl()` returns `null` (no instances available yet), the project stays in
`"registering"` state indefinitely with no relay and no scheduled retry. The instance manager
may emit `"instance_added"` or `"status_changed"` later, but nothing re-checks stale
`"registering"` projects.

**Fix:** Listen for `instanceManager` status changes and retry `startRelay()` for projects
that are still in `"registering"` state when a new instance becomes available.

---

## B6. `onDisconnect` is exported but never called (dead code)

**File:** `src/lib/frontend/stores/ws.svelte.ts:82-84`
**Severity:** Low
**Impact:** The `onDisconnect(fn)` function is exported and `_onDisconnectFn?.()` is called
in the close handler (line 146), but no code anywhere in the codebase calls `onDisconnect()`
to register a callback. The export and invocation are dead code.

**Fix:** Either remove the dead code, or document it as a public API for future use.

---

## B7. `handleMessage` catch block has misleading error message

**File:** `src/lib/frontend/stores/ws.svelte.ts:161-168`
**Severity:** Low
**Impact:** The catch block logs `"[ws] Failed to parse message:"` for ALL errors, including
cases where `JSON.parse()` succeeded but the handler function threw. This is misleading when
debugging handler bugs — the log implies a parse failure when the real error is in business
logic.

**Fix:** Separate the parse and handle steps:
```typescript
let msg: RelayMessage;
try {
    msg = JSON.parse(event.data) as RelayMessage;
} catch {
    console.warn("[ws] Failed to parse message:", event.data);
    return;
}
try {
    handleMessage(msg);
} catch (err) {
    console.warn("[ws] Handler error for", msg.type, err);
}
```

---

## B8. ConnectOverlay `cachedMultiInstance` is sticky (never resets to false)

**File:** `src/lib/frontend/components/overlays/ConnectOverlay.svelte:86-88`
**Severity:** Low
**Impact:** The `$effect` sets `cachedMultiInstance = true` when
`instanceState.instances.length > 1`, but never resets it to `false` if instances are
removed. Once multi-instance mode is detected, the "Start Instance" / "Switch Instance"
action buttons remain available for the entire session lifetime, even if the user removes
all but one instance.

**Fix:** Track the actual count: `cachedMultiInstance = instanceState.instances.length > 1`
(set to false when count drops). Or keep it sticky if that is the intended UX.

---

## B9. CA download silently swallows read errors

**File:** `src/lib/server/http-router.ts:575`
**Severity:** Low
**Impact:** The `catch` block for `readFile(this.caRootPath)` silently swallows the error
with no logging. If the certificate file exists but is unreadable (permissions, corruption),
the user sees a generic "CA certificate file not found" 404 with no server-side log of the
actual I/O error.

**Fix:** Log the error at `warn` level inside the catch block.

---

## B10. Auth error responses use a different shape from all other errors

**File:** `src/lib/server/http-router.ts:425-434`
**Severity:** Low (API consistency)
**Impact:** Auth failure responses use `{ ok: false, locked: true, retryAfter: number }` and
`{ ok: false, attemptsLeft: number }` (Shape B), while every other error in the codebase
uses `{ error: { code: string, message: string } }` (Shape A). Clients need two different
parsers. The `{ ok: true }` success envelope is also inconsistent with other endpoints that
return domain data directly.

**Fix:** Future API versioning pass could unify these, but it is a breaking change for any
existing clients that parse auth responses. Low priority — document the inconsistency for now.

---

## B11. Dashboard has no polling or refresh mechanism

**File:** `src/lib/frontend/pages/DashboardPage.svelte:59-80`
**Severity:** Low (UX)
**Impact:** Projects are fetched once on mount via `fetchProjects()` and never refreshed.
If a project transitions from `"registering"` to `"ready"` while the dashboard is open,
the user won't see the change. They must manually refresh the page. The dashboard also
doesn't reflect changes in session count, client count, or processing status.

**Fix:** Add a polling interval (e.g., 5s) while the dashboard is visible. Or use a
lightweight SSE/WS connection for dashboard updates. The current design adds polling
only while `"registering"` projects exist (see design doc F4/I3), which partially addresses
this.

---

## B12. Standalone mode always shows 0 sessions / 0 clients on dashboard

**File:** `src/lib/server/server.ts:97-102`
**Severity:** Low (known limitation)
**Impact:** The standalone server's `getProjects` closure only returns
`{ slug, directory, title }`. The optional `clients`, `sessions`, and `isProcessing` fields
on `RouterProject` are never populated. The dashboard always shows `0 sessions · 0 clients`
for all projects in standalone mode.

**Fix:** Wire up the standalone `getProjects` closure to read client count from each relay's
`wsHandler.getClientCount()` and session count from `messageCache.sessionCount()`, similar
to how the daemon does it at `daemon.ts:556-558`.
