# Frontend Status Fix + API Type Safety Design

## Problem

The ProjectRegistry refactor (committed `c6ff53c`) fixed the backend race condition where
WS upgrades were silently rejected during relay creation.  However the loading bug persists
because:

1. **`/api/projects` drops the `status` field.**  The daemon populates `status` on
   `RouterProject` (`daemon.ts:555`), but `http-router.ts:269-276` manually maps projects
   to an untyped literal that omits `status`.
2. **The frontend has zero project-status awareness.**  `ProjectInfo` and `DashboardProject`
   have no `status` field.  `ChatLayout` connects the WS immediately from the URL slug with
   no pre-flight check.  `ConnectOverlay` shows generic "Thinking..." verbs with no
   relay-specific feedback.
3. **Blind 2-second reconnect loop.**  `ws.svelte.ts:148-153` retries every 2 seconds on any
   WS close, with no distinction between "relay not ready" vs "relay crashed" vs "network
   error."

The serialization gap occurred because `dashProjects` was a `.map()` to an untyped literal —
TypeScript had no way to flag the missing field.  This class of bug affects 12 of 14 HTTP
API endpoints in the codebase (only `/api/status` and `/api/themes` have typed responses).

## Solution

Three coordinated changes:

1. **Backend**: Expose `status` in `/api/projects`, add a per-project status endpoint, send
   HTTP 503 on WS rejection instead of silent `socket.destroy()`.
2. **Frontend**: Pre-flight status check before WS connect, status-aware ConnectOverlay,
   dashboard status badges, smarter reconnect logic.
3. **Type safety**: Typed response interfaces for all 14 HTTP API endpoints plus a shared
   `ApiError` envelope type, enforced via `satisfies` and typed serializer functions.

---

## Backend Changes

### B1. `/api/projects` serialization fix

Add `status` to the inline map in `http-router.ts:269-276`.  Once typed response wrappers
are in place (T1-T3), this becomes a compile-time enforced field.

### B2. HTTP 503 on WS rejection

When `waitForRelay()` rejects in the WS upgrade handler (`daemon.ts:610-616`), write an
HTTP 503 response on the raw socket before destroying:

```typescript
catch (err) {
  this.log.warn(
    { slug, error: formatErrorDetail(err) },
    "WS upgrade rejected: relay not available",
  );
  if (!socket.destroyed) {
    if (socket.writable) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    }
    socket.destroy();
  }
}
```

**Audit note (C5):** Must check `socket.writable` before writing.  The `waitForRelay` call
can take up to 10 seconds; the client may disconnect during that window, leaving the socket
in a non-writable state.  Writing to a non-writable socket throws.

This surfaces in browser dev tools as a failed upgrade with 503 instead of a mysterious
connection reset.  The frontend already handles this via the `onerror` → `onclose` path.

### B3. Per-project status endpoint

`GET /p/:slug/api/status` returns:

```typescript
interface ProjectStatusResponse {
  status: "registering" | "ready" | "error";
  error?: string;
}
```

This lets the frontend poll a single project's status without fetching all projects.

**Route placement (audit findings C1, C2):**

The route is handled directly in `http-router.ts` in the project route section (after slug
extraction at line 299), NOT via the `onProjectApiRequest` delegate.  Two reasons:

1. The daemon does NOT provide `onProjectApiRequest` to the router — only the standalone
   `server.ts` wires that callback.  Delegation is a no-op in daemon mode.
2. The auth gate (`http-router.ts:150-191`) classifies all `/p/*` paths as browser routes
   and returns a **302 redirect** to `/auth` for unauthenticated requests.  An API endpoint
   under `/p/:slug/api/` needs a **JSON 401** instead.

Implementation: after the slug is extracted and the project-not-found check runs, check
`subPath === "/api/status"`.  If the route matches:
- Run `checkAuth(req)` explicitly.  If auth fails, return JSON 401 with `ApiError`.
- Find the project in `getProjects()` by slug and return its status.
- Short-circuit before the `onProjectApiRequest` delegation.

```typescript
// Inside the project route section, after slug extraction and 404 check:
if (subPath === "/api/status" && req.method === "GET") {
  // Auth gate — return JSON 401, not 302 redirect
  if (this.auth.hasPin() && !this.checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "PIN required" } }));
    return;
  }
  const project = projects.find((p) => p.slug === slug);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: project?.status ?? "ready",
    ...(project?.error != null && { error: project.error }),
  } satisfies ProjectStatusResponse));
  return;
}
```

### B4. Add `error` field to `RouterProject`

**Audit finding (C3):** Neither the daemon's `getProjects` closure nor `getStatus()` surfaces
the error message from `ProjectError` entries.  The frontend has no way to display WHY a
relay failed.

Add `error?: string` to the `RouterProject` interface.  The daemon's `getProjects` closure
populates it from `entry.error` when `entry.status === "error"`:

```typescript
result.push({
  slug: entry.project.slug,
  directory: entry.project.directory,
  title: entry.project.title,
  status: entry.status,
  error: entry.status === "error" ? entry.error : undefined,
  clients: relay?.wsHandler.getClientCount() ?? 0,
  sessions: relay?.messageCache.sessionCount() ?? 0,
  isProcessing: relay?.isAnySessionProcessing() ?? false,
});
```

The `DashboardProjectResponse` type also gains `error?: string`.

---

## Frontend Changes

### F1. Add `status` to frontend types

Add `status?: "registering" | "ready" | "error"` to `DashboardProject` (via the shared
`DashboardProjectResponse` type — see T1).

**Audit finding (I1):** Three separate project type hierarchies exist:
- `RouterProject` (server HTTP) — uses `directory` field
- `ProjectInfo` (WebSocket `project_list`) — uses `directory` field, has `clientCount?`
- `DashboardProject` (frontend HTTP) — uses `path` field (mapped from `directory`)

The `path` vs `directory` naming is an intentional API contract; do not unify.
`DashboardProject` in `dashboard-types.ts` becomes an alias of `DashboardProjectResponse`.

**Audit finding (I2):** `ProjectInfo` is used in WebSocket `project_list` messages (a
separate transport path from the HTTP `/api/projects` endpoint).  The `ConnectOverlay`
pre-flight check uses HTTP, not WS, so adding `status` to `ProjectInfo` is deferred —
it is not needed for this fix.

**Audit finding (C4):** Standalone mode (`server.ts:97-102`) does not populate `status`
on projects.  The serializer uses `p.status ?? "ready"` as a fallback, so standalone
projects implicitly appear as `"ready"`.

### F2. Pre-flight status check

In `ws.svelte.ts`, before calling `new WebSocket(url)`, fetch
`/p/${slug}/api/status`.  Three outcomes:

- `"ready"` → connect WS immediately
- `"registering"` → poll `/p/${slug}/api/status` every 1s until `"ready"` or `"error"`,
  updating a new `wsState.relayStatus` field so `ConnectOverlay` can show progress
- `"error"` → don't connect, set `wsState.relayStatus = "error"`, show in overlay

If the pre-flight fetch itself fails (network error, 401, 404), fall through to existing
WS connect behavior (backward compatible with standalone/non-daemon modes).

### F3. ConnectOverlay improvements

Display relay-specific states using a new `wsState.relayStatus` field:

| `relayStatus` | Overlay behavior |
|---|---|
| `undefined` or `"ready"` | Existing behavior: "Thinking..." verbs |
| `"registering"` | "Starting relay..." with the O animation |
| `"error"` | "Relay failed to start" with "Retry" and "Back to dashboard" links |

The overlay already has the "Back to dashboard" escape link (line 279-290).  The
`"error"` state surfaces it immediately instead of after a 4-second delay.

### F4. Dashboard status badges

In `DashboardPage.svelte`, update `statusIcon()` to handle registration states:

```typescript
function statusIcon(project: DashboardProject): string {
  if (project.status === "registering") return "⏳";
  if (project.status === "error") return "❌";
  if (project.isProcessing) return "⚡";
  if (project.clients > 0) return "🟢";
  return "⏸";
}
```

Show a tooltip or subtitle with the error message when status is `"error"`.

### F5. Smarter reconnect logic

Replace the unconditional 2-second reconnect in `ws.svelte.ts:148-153` with:

1. **On WS close (code 1000, normal):** Don't reconnect — the close was intentional
   (navigation, logout, etc.).
2. **On WS close (code 1006, abnormal or other):** Do a status check via
   `/p/${slug}/api/status` first:
   - `"ready"` → reconnect after backoff
   - `"registering"` → poll until ready, then reconnect
   - `"error"` → don't reconnect, show error overlay
   - fetch fails → reconnect after backoff (assume transient network issue)
3. **Exponential backoff:** 1s → 2s → 4s → 8s → 16s (cap).  Reset on successful connect.

---

## Type Safety: Typed API Responses

### T1. Shared response types in `shared-types.ts`

Define typed interfaces for all 14 API endpoint responses.  All fields are required (no
optionals for serialized values — use `0`, `false`, `"ready"` defaults).

```typescript
// ─── API Error Envelope ────────────────────────────────────────────────
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// ─── Auth ──────────────────────────────────────────────────────────────
export interface AuthStatusResponse {
  hasPin: boolean;
  authenticated: boolean;
}

export type AuthResponse =
  | { ok: true }
  | { ok: false; locked: true; retryAfter: number }
  | { ok: false; attemptsLeft: number };

// ─── Setup ─────────────────────────────────────────────────────────────
export interface SetupInfoResponse {
  httpsUrl: string;
  httpUrl: string;
  hasCert: boolean;
  lanMode: boolean;
}

// ─── Health / Status ───────────────────────────────────────────────────
export interface HealthResponse {
  ok: boolean;
  projects: number;
  uptime: number;
}

// DaemonStatus already exists — keep it, ensure /api/status uses it.

// ─── Info ──────────────────────────────────────────────────────────────
export interface InfoResponse {
  version: string;
}

// ─── Themes ────────────────────────────────────────────────────────────
export interface ThemesResponse {
  bundled: Record<string, Base16Theme>;
  custom: Record<string, Base16Theme>;
}

// ─── Projects ──────────────────────────────────────────────────────────
export interface DashboardProjectResponse {
  slug: string;
  path: string;
  title: string;
  status: "registering" | "ready" | "error";
  error?: string;                // only present when status === "error"
  sessions: number;
  clients: number;
  isProcessing: boolean;
}

export interface ProjectsListResponse {
  projects: DashboardProjectResponse[];
  version: string;
}

// ─── Project Status ────────────────────────────────────────────────────
export interface ProjectStatusResponse {
  status: "registering" | "ready" | "error";
  error?: string;
}

// ─── Push ──────────────────────────────────────────────────────────────
export interface VapidKeyResponse {
  publicKey: string;
}

export interface PushOkResponse {
  ok: true;
}
```

### T2. Typed serializer functions in `http-router.ts`

Replace inline `JSON.stringify({ ... })` with typed serializer functions:

```typescript
function serializeProject(p: RouterProject): DashboardProjectResponse {
  return {
    slug: p.slug,
    path: p.directory,
    title: p.title || "",
    status: p.status ?? "ready",
    sessions: p.sessions ?? 0,
    clients: p.clients ?? 0,
    isProcessing: p.isProcessing ?? false,
  };
}
```

Each endpoint wraps its response in the appropriate type.  Use `satisfies` as a
belt-and-suspenders check at the `JSON.stringify` call site:

```typescript
res.end(JSON.stringify({
  projects: projects.map(serializeProject),
  version: getVersion(),
} satisfies ProjectsListResponse));
```

### T3. Frontend type unification

- `DashboardProject` in `dashboard-types.ts` becomes
  `export type DashboardProject = DashboardProjectResponse`
  (imported from `shared-types.ts`; single source of truth)
- `DashboardPage.stories.ts` mock data updated to include `status` field
- `ProjectInfo` is NOT changed — it serves the WebSocket `project_list` path, not the
  HTTP `/api/projects` path (see audit finding I2)

### T4. Onboarding server typing

The onboarding server in `daemon-lifecycle.ts` has 2 duplicated endpoints
(`/api/setup-info`, `/ca/download`).  Apply the same `SetupInfoResponse` type.

---

## File Change Summary

| File | Action | Scope |
|---|---|---|
| `src/lib/shared-types.ts` | Modified | Add all API response types, `ApiError`, `ProjectStatusResponse`, `DashboardProjectResponse` |
| `src/lib/server/http-router.ts` | Modified | Add `status`+`error` to `/api/projects`, add `/p/:slug/api/status` route with inline JSON 401 auth, typed serializers for all 26 `JSON.stringify` sites, `satisfies` checks, add `error?` to `RouterProject` |
| `src/lib/daemon/daemon.ts` | Modified | HTTP 503 on WS rejection (with `socket.writable` guard), populate `error` field in `getProjects` closure for error-state entries |
| `src/lib/daemon/daemon-lifecycle.ts` | Modified | Typed responses for onboarding endpoints (`SetupInfoResponse`) |
| `src/lib/frontend/stores/ws.svelte.ts` | Modified | Pre-flight status check, smarter reconnect with exponential backoff, `relayStatus` field on `wsState` |
| `src/lib/frontend/components/overlays/ConnectOverlay.svelte` | Modified | Relay-status-aware states: "Starting relay...", error display with retry |
| `src/lib/frontend/pages/DashboardPage.svelte` | Modified | Status badges on project cards, error tooltip |
| `src/lib/frontend/pages/DashboardPage.stories.ts` | Modified | Update mock data to include `status` field |
| `src/lib/frontend/pages/dashboard-types.ts` | Modified | Alias to `DashboardProjectResponse` (from shared-types) |
| `src/lib/frontend/types.ts` | Modified | Re-export `DashboardProjectResponse`, add `relayStatus` to `ConnectionStatus` or `wsState` type |
| `test/unit/server/http-router.test.ts` | Modified | Tests for `/api/projects` status field, `/p/:slug/api/status` endpoint, auth JSON 401 for project API routes |
| `test/unit/daemon/daemon.test.ts` | Modified | Test HTTP 503 on WS rejection |

---

## Testing Strategy

### Backend tests (`http-router.test.ts`)

1. **`/api/projects` response shape** — assert `status` and `error` fields present in JSON
2. **`/api/projects` with typed response** — assert response matches `ProjectsListResponse`
3. **`/p/:slug/api/status`** — test all three status values + 404 for unknown slug
4. **`/p/:slug/api/status` auth** — assert JSON 401 (not 302 redirect) when PIN set and
   unauthenticated.  This is a regression test for audit finding C1.
5. **`/p/:slug/api/status` auth exempt** — assert accessible with valid cookie/header
6. **All typed endpoints** — spot-check that `satisfies` constraints hold (compile-time, but
   verify response shapes in tests too)

### Backend tests (`daemon.test.ts`)

7. **HTTP 503 on WS rejection** — test that raw socket receives 503 when relay not available
8. **HTTP 503 writable guard** — test that destroyed socket does not throw on write
9. **`getProjects` closure** — assert `error` field is populated for error-state projects

### Frontend tests (if Vitest + testing-library configured)

10. **Pre-flight status check** — mock fetch, verify WS connect is deferred when
    `"registering"`, skipped when `"error"`, immediate when `"ready"`
11. **Pre-flight fallback** — verify WS connect proceeds normally when fetch fails (404,
    network error) for backward compatibility with standalone mode
12. **Reconnect backoff** — verify exponential delays and status check on abnormal close
13. **ConnectOverlay states** — verify correct text/UI for each `relayStatus` value

### Integration

14. Start daemon with delayed relay factory → browser navigates to project → overlay shows
    "Starting relay..." → relay becomes ready → WS connects → overlay fades

---

## Audit Amendments

Full code audit performed on all files the design touches.  16 findings total (5 critical,
6 important, 5 minor).  Critical findings incorporated into the design above:

| ID | Finding | Resolution |
|---|---|---|
| C1 | Auth gate 302-redirects `/p/:slug/api/*` instead of JSON 401 | B3 handles auth inline with explicit JSON 401 |
| C2 | Daemon doesn't wire `onProjectApiRequest` | B3 handles route directly in http-router.ts |
| C3 | Error details not surfaced for error-state projects | B4 adds `error?` to `RouterProject` and response |
| C4 | Standalone mode doesn't populate `status` | Serializer uses `?? "ready"` fallback |
| C5 | `socket.writable` not checked before writing 503 | B2 updated with writable guard |

Important findings noted inline (I1: type hierarchy, I2: ProjectInfo deferred, I3: dashboard
polling deferred, I4: stories mock data).

12 unrelated bugs documented in `docs/plans/2026-03-13-audit-bugs.md` (B1-B12).

---

## Out of Scope

- Changing the standalone `RelayServer` in `server.ts` (uses its own `ProjectEntry` type)
- Adding typed responses to WebSocket message handlers (different layer)
- Changing the IPC protocol types (already typed via `IPCResponse`)
- Adding `status` to `ProjectInfo` / WS `project_list` messages (deferred — I2)
- Dashboard auto-refresh polling (deferred — I3, partially addressed in bug doc B11)
- Bugs B1-B12 in `docs/plans/2026-03-13-audit-bugs.md`
