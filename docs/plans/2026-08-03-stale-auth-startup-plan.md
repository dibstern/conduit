# Stale Authentication Startup Recovery Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Stop indefinite browser startup retries by routing stale authenticated project pages to the PIN page immediately.

**Architecture:** Reuse the existing non-blocking project status request as the authentication signal. A `401` replaces the current route with `/auth`; the existing Svelte route lifecycle owns WebSocket cleanup.

**Tech Stack:** TypeScript, Svelte 5 stores, Vitest, Playwright visual acceptance.

---

### Task 1: Recover From Stale Authentication

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts:17-24,127-148`
- Test: `test/unit/frontend/ws-reconnect-stream.test.ts`
- Test: `test/unit/components/chat-layout-ws.test.ts`

**Step 1: Write the failing test**

Extend the existing browser globals with complete `fetch` responses and observable history replacement. Import the real `routerState`, `slugState`, `syncSlugState`, and `wsState`; set `/p/conduit/` before each test and reset the singleton route and stubs afterward.

Add these store cases:

- A `401` response changes the real route to `/auth`, sets `slugState.current` to `null`, and calls `history.replaceState` once.
- A `200` `{ "status": "ready" }` response sets `wsState.relayStatus` to `ready` without replacing the route.
- A deferred `401` from an obsolete same-slug connection generation does not replace the route after a newer `connect()` call.
- A `200` response whose JSON body resolves after a newer same-slug connection cannot overwrite the newer connection's relay status.
- `disconnect()` cancels an already-scheduled reconnect timer.

Use real `Response` objects rather than partial response mocks. Model the delayed JSON case with a real `Response` backed by a controllable `ReadableStream` body.

In `chat-layout-ws.test.ts`, render on a project route, call the real `replaceRoute("/auth")`, flush Svelte updates, and assert that the layout effect calls `disconnect()` once without calling `connect()` again. This test exercises the real router and component lifecycle; the WebSocket module remains mocked because the test's seam is layout cleanup.

**Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run test/unit/frontend/ws-reconnect-stream.test.ts`

Expected: the new test fails because the route remains the project route.

**Step 3: Implement the minimal fix**

Import `replaceRoute` from the router store. Pass the current connection generation into `fetchRelayStatus`. Before inspecting a response, return unless both `_currentSlug === slug` and `generation === _connectionGeneration`. Then handle `res.status === 401` by calling `replaceRoute("/auth")` and returning `null`. After parsing a successful response body, apply the same slug-and-generation guard again before mutating `wsState`. Leave all other status handling unchanged.

Update the status-fetch comments: it remains non-blocking for relay readiness, but it also initiates authentication recovery.

**Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run test/unit/frontend/ws-reconnect-stream.test.ts test/unit/components/chat-layout-ws.test.ts`

Expected: all tests pass with no warnings.

**Step 5: Review the implementation**

Confirm no helper or new interface is needed. The existing router module is the correct seam because it already synchronizes `routerState` and `slugState`. Confirm the generation guard prevents stale status responses from changing current navigation.

**Step 6: Verify affected surfaces**

Run:

```bash
pnpm check
pnpm lint
pnpm acceptance:visual
```

Then repeat the browser feedback loop:

- Authenticated/no-PIN cold startup still reaches `ws:open`.
- Warm reload timing does not regress.
- A `401` status response transitions to `/auth` rather than scheduling another reconnect.

No commit is included because the user did not request one.
