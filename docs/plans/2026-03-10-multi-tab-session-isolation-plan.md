# Multi-Tab Session Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the `activeSessionId` singleton, scope the translator per-session, and increase the poller cap with UI feedback.

**Architecture:** Remove mutable global state from SessionManager, replacing it with stateless computation via `getDefaultSessionId()`. Scope the translator's `seenParts` map per-session to prevent cross-session state corruption. Rename `session_changed` to `session_lifecycle` with a discriminated payload. Increase the poller cap from 5 to 10 with a `capacity_exceeded` event that surfaces as a UI error.

**Tech Stack:** TypeScript, Vitest, fast-check (PBT), ws, EventEmitter

---

### Task 1: Scope the translator per-session

The translator's `seenParts` map is global. Scope it per-session so `reset(sessionId)` only clears one session's parts.

**Files:**
- Modify: `src/lib/relay/event-translator.ts:510-527,700-726`
- Test: `test/unit/relay/event-translator.pbt.test.ts`
- Test: `test/unit/relay/event-translator.stateful.test.ts`

**Step 1: Write failing tests for per-session translator**

Add tests to `event-translator.pbt.test.ts` in a new section after the existing stateful tests:

```typescript
describe("Per-session scoping", () => {
  it("reset(sessionId) only clears that session's parts", () => {
    const translator = createTranslator();
    // Translate a tool part for session-A
    translator.translate(toolPartEvent("part-a"), { sessionId: "ses-A" });
    // Translate a tool part for session-B
    translator.translate(toolPartEvent("part-b"), { sessionId: "ses-B" });
    // Reset only session-A
    translator.reset("ses-A");
    // session-A part should be unknown (isNew=true again)
    // session-B part should still be tracked
    const seenB = translator.getSeenParts("ses-B");
    expect(seenB?.has("part-b")).toBe(true);
    const seenA = translator.getSeenParts("ses-A");
    expect(seenA?.size ?? 0).toBe(0);
  });

  it("reset() with no arg clears all sessions", () => {
    const translator = createTranslator();
    translator.translate(toolPartEvent("part-a"), { sessionId: "ses-A" });
    translator.translate(toolPartEvent("part-b"), { sessionId: "ses-B" });
    translator.reset();
    expect(translator.getSeenParts("ses-A")?.size ?? 0).toBe(0);
    expect(translator.getSeenParts("ses-B")?.size ?? 0).toBe(0);
  });

  it("rebuildStateFromHistory(sessionId, messages) only rebuilds that session", () => {
    const translator = createTranslator();
    translator.translate(toolPartEvent("part-a"), { sessionId: "ses-A" });
    translator.rebuildStateFromHistory("ses-B", [
      { parts: [{ id: "part-b", type: "tool" as PartType }] },
    ]);
    // session-A untouched
    expect(translator.getSeenParts("ses-A")?.has("part-a")).toBe(true);
    // session-B rebuilt
    expect(translator.getSeenParts("ses-B")?.has("part-b")).toBe(true);
  });

  it("FIFO eviction is per-session", () => {
    const translator = createTranslator();
    // Fill session-A to capacity (10,000 parts)
    for (let i = 0; i < 10_001; i++) {
      translator.translate(
        toolPartEvent(`part-a-${i}`),
        { sessionId: "ses-A" },
      );
    }
    // session-A should have been evicted down
    const seenA = translator.getSeenParts("ses-A");
    expect(seenA!.size).toBeLessThanOrEqual(10_000);
    // session-B should be unaffected
    translator.translate(toolPartEvent("part-b"), { sessionId: "ses-B" });
    expect(translator.getSeenParts("ses-B")?.has("part-b")).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/event-translator.pbt.test.ts --grep "Per-session" -v`
Expected: FAIL — `reset` doesn't accept sessionId, `getSeenParts` doesn't accept sessionId

**Step 3: Update the Translator interface**

In `event-translator.ts`, update the interface (lines 510-523):

```typescript
export interface Translator {
  translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult;
  /** Clear tracked parts. If sessionId provided, only that session. If omitted, all sessions. */
  reset(sessionId?: string): void;
  /** Get tracked parts for a session (or the default/fallback session if no sessionId). */
  getSeenParts(sessionId?: string): ReadonlyMap<string, { type: PartType; status?: ToolStatus }> | undefined;
  /** Rebuild part tracking from REST history for a specific session. */
  rebuildStateFromHistory(
    sessionId: string,
    messages: Array<{
      parts?: Array<{
        id: string;
        type: PartType;
        state?: { status?: ToolStatus };
      }>;
    }>,
  ): void;
}
```

**Step 4: Implement per-session seenParts**

Replace `createTranslator()` internals (line 525-726):

- Change `const seenParts = new Map<string, ...>()` to `const sessionParts = new Map<string, Map<string, ...>>()`
- Add helper: `function getOrCreateSessionParts(sessionId: string | undefined)`
  - If sessionId is undefined, use `"__default__"` as the key (backward compat for events without sessionId)
  - Return `sessionParts.get(key)` or create + set a new empty map
- In `translate()`: extract sessionId from `context?.sessionId`, pass the session-specific map to `translatePartDelta`, `handlePartUpdated`, etc.
- `reset(sessionId?)`: If sessionId provided, `sessionParts.delete(sessionId)`. If not, `sessionParts.clear()`.
- `getSeenParts(sessionId?)`: Return `sessionParts.get(sessionId ?? "__default__")`
- `rebuildStateFromHistory(sessionId, messages)`: Clear and rebuild only `sessionParts.get(sessionId)`
- `evictOldestIfNeeded`: Accept the session-specific map, not the global one

**Step 5: Update `rebuildTranslatorFromHistory` helper function**

In `event-translator.ts` line 736-762, update to pass sessionId:

```typescript
export async function rebuildTranslatorFromHistory<M extends ...>(
  translator: Translator,
  getMessages: (sessionId: string) => Promise<M[]>,
  sessionId: string,
  log: (...args: unknown[]) => void,
): Promise<M[] | undefined> {
  try {
    const messages = await getMessages(sessionId);
    const parts = messages.map((m) => {
      const rawParts = (m as { parts?: unknown[] }).parts as
        | Array<{ id: string; type: PartType; state?: { status?: ToolStatus } }>
        | undefined;
      return rawParts != null ? { parts: rawParts } : {};
    });
    translator.rebuildStateFromHistory(sessionId, parts);
    return messages;
  } catch (err) {
    log(`   [session] rebuildStateFromHistory failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}
```

**Step 6: Update relay-stack.ts session_changed handler**

In `relay-stack.ts` line 343-361, pass sessionId to translator.reset:

```typescript
sessionMgr.on("session_changed", async ({ sessionId: sid }) => {
  translator.reset(sid);  // was: translator.reset()
  // rest unchanged
});
```

**Step 7: Update existing translator tests**

The existing tests in `event-translator.pbt.test.ts` and `event-translator.stateful.test.ts` call `reset()` and `getSeenParts()` without sessionId. These should continue to work (backward compat via `__default__` key). But `rebuildStateFromHistory` now requires a sessionId arg — update all call sites in tests:
- `translator.rebuildStateFromHistory(messages)` → `translator.rebuildStateFromHistory("test-session", messages)`

Also update `mock-factories.ts` line 171 `createMockTranslator()`:
- Add sessionId parameter to `reset`, `getSeenParts`, `rebuildStateFromHistory` mocks

**Step 8: Run all translator tests**

Run: `pnpm vitest run test/unit/relay/event-translator -v`
Expected: ALL PASS

**Step 9: Run full test suite**

Run: `pnpm test:unit`
Expected: ALL PASS (no regressions)

**Step 10: Commit**

```
feat: scope translator seenParts per-session for multi-tab isolation
```

---

### Task 2: Rename `session_changed` to `session_lifecycle`

Replace the event with a discriminated union payload so handlers can distinguish creation from deletion.

**Files:**
- Modify: `src/lib/session/session-manager.ts:34-35,172,197,213`
- Modify: `src/lib/relay/relay-stack.ts:343`
- Test: `test/unit/session/session-manager.pbt.test.ts`

**Step 1: Write failing tests**

Add to `session-manager.pbt.test.ts`:

```typescript
describe("session_lifecycle event", () => {
  it("emits { type: 'created' } on createSession", async () => {
    const client = createMockClient([]);
    const mgr = new SessionManager({ client });
    const events: Array<{ type: string; sessionId: string }> = [];
    mgr.on("session_lifecycle", (ev) => events.push(ev));
    await mgr.createSession("test");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("created");
  });

  it("emits { type: 'deleted' } on deleteSession", async () => {
    const client = createMockClient([{ id: "ses_1", title: "a", time: { created: 1 } }]);
    const mgr = new SessionManager({ client });
    await mgr.initialize();
    const events: Array<{ type: string; sessionId: string }> = [];
    mgr.on("session_lifecycle", (ev) => events.push(ev));
    await mgr.deleteSession("ses_1", { silent: true });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("deleted");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/session/session-manager.pbt.test.ts --grep "session_lifecycle" -v`
Expected: FAIL — no `session_lifecycle` event exists

**Step 3: Update SessionManager event types**

In `session-manager.ts` line 34-35:

```typescript
// Before:
session_changed: [{ sessionId: string }];

// After:
session_lifecycle: [
  { type: "created"; sessionId: string } | { type: "deleted"; sessionId: string }
];
```

**Step 4: Update emission sites**

- `createSession()` line 172: `this.emit("session_lifecycle", { type: "created", sessionId: session.id })`
- `deleteSession()` line 213: `this.emit("session_lifecycle", { type: "deleted", sessionId })` (emitted always, not just when active was deleted — see Task 3 for the full deleteSession refactor)

**Step 5: Update relay-stack.ts listener**

Line 343:

```typescript
sessionMgr.on("session_lifecycle", async (ev) => {
  translator.reset(ev.sessionId);
  if (ev.type === "created") {
    // Start poller for new session
    const existingMessages = await rebuildTranslatorFromHistory(
      translator, (id) => client.getMessages(id), ev.sessionId, log,
    );
    if (existingMessages) {
      pollerManager.startPolling(ev.sessionId, existingMessages);
    }
  } else if (ev.type === "deleted") {
    pollerManager.stopPolling(ev.sessionId);
    statusPoller.clearMessageActivity(ev.sessionId);
  }
});
```

**Step 6: Update all test references from `session_changed` to `session_lifecycle`**

Search and update in:
- `test/unit/session/session-manager.pbt.test.ts` — all `mgr.on("session_changed", ...)` calls
- `test/helpers/mock-factories.ts` — update `createMockSessionMgr`
- Any other test files referencing `session_changed`

**Step 7: Run all tests**

Run: `pnpm test:unit`
Expected: ALL PASS

**Step 8: Commit**

```
refactor: rename session_changed to session_lifecycle with discriminated payload
```

---

### Task 3: Eliminate `activeSessionId`

Remove the mutable singleton. Replace with `getDefaultSessionId()`.

**Files:**
- Modify: `src/lib/session/session-manager.ts:53,92-94,170,189-198,207-222,294-305`
- Modify: `src/lib/handlers/resolve-session.ts:17-21`
- Modify: `src/lib/bridges/client-init.ts:89`
- Modify: `src/lib/relay/sse-wiring.ts:305,369,378,387`
- Modify: `src/lib/handlers/session.ts:202-226` (deleteSession handler — switch orphaned viewers)
- Test: `test/unit/session/session-manager.pbt.test.ts`
- Test: `test/unit/relay/per-tab-routing-e2e.test.ts`
- Test: `test/helpers/mock-factories.ts`

**Step 1: Write failing tests for `getDefaultSessionId`**

Add to `session-manager.pbt.test.ts`:

```typescript
describe("getDefaultSessionId", () => {
  it("returns most recent session when sessions exist", async () => {
    const client = createMockClient([
      { id: "ses_old", title: "old", time: { created: 1 } },
      { id: "ses_new", title: "new", time: { created: 2 } },
    ]);
    const mgr = new SessionManager({ client });
    await mgr.initialize();
    const defaultId = await mgr.getDefaultSessionId();
    expect(defaultId).toBe("ses_new");
  });

  it("creates a new session when none exist", async () => {
    const client = createMockClient([]);
    const mgr = new SessionManager({ client });
    const defaultId = await mgr.getDefaultSessionId();
    expect(defaultId).toBeTruthy();
    // Verify session was actually created
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(defaultId);
  });
});
```

**Step 2: Run to verify failure**

Run: `pnpm vitest run test/unit/session/session-manager.pbt.test.ts --grep "getDefaultSessionId" -v`
Expected: FAIL — method doesn't exist

**Step 3: Add `getDefaultSessionId` to SessionManager**

```typescript
/** Compute the default session (most recent, or create one). Stateless — no global mutation. */
async getDefaultSessionId(title?: string): Promise<string> {
  const sessions = await this.listSessions();
  if (sessions.length > 0) {
    return sessions[0]!.id;
  }
  const created = await this.client.createSession(title ? { title } : {});
  this.emit("session_lifecycle", { type: "created", sessionId: created.id });
  return created.id;
}
```

**Step 4: Run getDefaultSessionId tests**

Run: `pnpm vitest run test/unit/session/session-manager.pbt.test.ts --grep "getDefaultSessionId" -v`
Expected: PASS

**Step 5: Remove `activeSessionId` and related methods**

In `session-manager.ts`:
- Remove: `private activeSessionId: string | null = null;` (line 53)
- Remove: `getActiveSessionId()` method (lines 92-94)
- Remove: `setActiveSessionId()` method (lines 303-305)
- Remove: `switchSession()` method (lines 189-198) — never called in production
- Update `createSession()`: Remove `this.activeSessionId = session.id;` (line 170). Keep `session_lifecycle` emission.
- Update `deleteSession()`: Remove all `activeSessionId` references (lines 207-222). Always emit `session_lifecycle: { type: "deleted" }`. Do NOT auto-switch sessions — that's the handler's job now.
- Update `initialize()`: Remove `this.activeSessionId = sorted[0]!.id` (line 294) and `this.activeSessionId = session.id` (line 297). Return the session ID directly without storing it.

**Step 6: Update `resolve-session.ts`**

```typescript
export function resolveSession(
  deps: HandlerDeps,
  clientId: string,
): string | undefined {
  return deps.wsHandler.getClientSession(clientId);
}
```

Remove the `getActiveSessionId()` fallback.

**Step 7: Update `client-init.ts:89`**

```typescript
// Before:
const activeId = requestedSessionId || sessionMgr.getActiveSessionId();

// After:
const activeId = requestedSessionId || await sessionMgr.getDefaultSessionId();
```

**Step 8: Update `sse-wiring.ts` log strings**

Replace all `deps.sessionMgr.getActiveSessionId() ?? "?"` with a static label or remove:
- Line 305: `"[sse] Connected to OpenCode event stream"`
- Line 369: `"[sse] Disconnected..."`
- Line 378: `"[sse] Reconnecting..."`
- Line 387: `"[sse] Error..."`

**Step 9: Fix `handleDeleteSession` to switch orphaned viewers**

In `handlers/session.ts` lines 202-226, after deleting the session, find ALL clients viewing it (not just the requesting client) and switch them:

```typescript
export async function handleDeleteSession(
  deps: HandlerDeps,
  clientId: string,
  payload: PayloadMap["delete_session"],
): Promise<void> {
  const { sessionId: id } = payload;
  if (!id) return;

  // Find ALL clients viewing this session before deletion
  const viewers = deps.wsHandler.getClientsForSession(id);

  deps.messageCache.remove(id);
  await deps.sessionMgr.deleteSession(id, { silent: true });

  const sessions = await deps.sessionMgr.listSessions();

  // Switch ALL viewers to the next session (not just the requester)
  if (sessions.length > 0) {
    for (const viewerClientId of viewers) {
      await handleViewSession(deps, viewerClientId, {
        sessionId: sessions[0]!.id,
      });
    }
  }

  deps.wsHandler.broadcast({ type: "session_list", sessions });
  deps.log(`   [session] client=${clientId} Deleted: ${id}`);
}
```

**Step 10: Update mock factories**

In `test/helpers/mock-factories.ts`:
- Remove `getActiveSessionId` from `createMockSessionMgr()` (line 78)
- Remove `setActiveSessionId` from `createMockSessionMgr()`
- Add `getDefaultSessionId: vi.fn().mockResolvedValue("session-1")`
- Remove `switchSession` from `createMockSessionMgr()`

**Step 11: Update all existing tests referencing removed methods**

Search for `getActiveSessionId`, `setActiveSessionId`, `switchSession`, `activeSession` across test files and update:
- `session-manager.pbt.test.ts`: Remove/rewrite P3 (switchSession) and P10 tests that test switchSession. Update P1, P2, P4, P5 that check `getActiveSessionId()`.
- `per-tab-routing-e2e.test.ts`: Update the test at line 392 — the reconnection test should now verify that the client gets the correct session from `getDefaultSessionId()` without the flash.
- `regression-server-cache-pipeline.test.ts`: Update `activeSessionId` references in the test helper.
- `question-answer-flow.test.ts`: Update `activeSession` mock references.

**Step 12: Run full test suite**

Run: `pnpm test:unit`
Expected: ALL PASS

**Step 13: Commit**

```
feat: eliminate activeSessionId singleton — compute default on-demand
```

---

### Task 4: Increase poller cap to 10 + UI error on capacity exceeded

**Files:**
- Modify: `src/lib/relay/message-poller-manager.ts:20,24-27,72-77`
- Modify: `src/lib/relay/relay-stack.ts` (wire new event)
- Test: `test/unit/relay/message-poller-manager.test.ts`

**Step 1: Write failing tests**

Add to `message-poller-manager.test.ts`:

```typescript
it("allows up to 10 concurrent pollers", () => {
  const mgr = new MessagePollerManager({ client: makeMockClient(), log: vi.fn() });
  for (let i = 1; i <= 10; i++) {
    mgr.startPolling(`session-${i}`);
  }
  expect(mgr.size).toBe(10);
});

it("rejects 11th poller with capacity_exceeded event", () => {
  const mgr = new MessagePollerManager({ client: makeMockClient(), log: vi.fn() });
  const exceeded: Array<{ sessionId: string; current: number; max: number }> = [];
  mgr.on("capacity_exceeded", (ev) => exceeded.push(ev));

  for (let i = 1; i <= 10; i++) {
    mgr.startPolling(`session-${i}`);
  }
  mgr.startPolling("session-11");

  expect(mgr.size).toBe(10);
  expect(exceeded).toHaveLength(1);
  expect(exceeded[0]).toEqual({
    sessionId: "session-11",
    current: 10,
    max: 10,
  });
});
```

**Step 2: Run to verify failure**

Run: `pnpm vitest run test/unit/relay/message-poller-manager.test.ts --grep "concurrent|capacity" -v`
Expected: FAIL — cap is still 5, no `capacity_exceeded` event

**Step 3: Update MessagePollerManager**

In `message-poller-manager.ts`:

```typescript
// Line 20: change constant
const MAX_CONCURRENT_POLLERS = 10;

// Lines 24-27: add event type
export interface MessagePollerManagerEvents {
  events: [messages: RelayMessage[], sessionId: string];
  capacity_exceeded: [{ sessionId: string; current: number; max: number }];
}

// Lines 72-77: emit event instead of just logging
if (this.pollers.size >= MAX_CONCURRENT_POLLERS) {
  this.log(
    `   [poller-mgr] MAX POLLERS reached (${MAX_CONCURRENT_POLLERS}), skipping ${sessionId.slice(0, 12)}`,
  );
  this.emit("capacity_exceeded", {
    sessionId,
    current: this.pollers.size,
    max: MAX_CONCURRENT_POLLERS,
  });
  return;
}
```

**Step 4: Wire in relay-stack.ts**

Add after the existing pollerManager event wiring:

```typescript
pollerManager.on("capacity_exceeded", ({ sessionId, max }) => {
  wsHandler.broadcast({
    type: "error",
    code: "POLLER_CAPACITY",
    message: `Cannot monitor more than ${max} active sessions simultaneously. Session ${sessionId.slice(0, 8)}… is not being monitored.`,
  });
  log(`   [poller-mgr] Capacity exceeded: ${sessionId.slice(0, 12)} rejected (${max} max)`);
});
```

**Step 5: Update existing test for old 5-poller cap**

In `message-poller-manager.test.ts`, the test "rejects polling when max concurrent reached" currently uses 6 sessions and expects the 6th to be rejected. Update it to use 11 and expect the 11th to be rejected.

**Step 6: Run all poller tests**

Run: `pnpm vitest run test/unit/relay/message-poller-manager.test.ts -v`
Expected: ALL PASS

**Step 7: Run full test suite**

Run: `pnpm test:unit`
Expected: ALL PASS

**Step 8: Commit**

```
feat: increase poller cap to 10, emit capacity_exceeded error to UI
```

---

### Task 5: Integration verification

Run the full test suite including the per-tab routing E2E tests to verify multi-tab correctness end-to-end.

**Step 1: Run unit tests**

Run: `pnpm test:unit`
Expected: ALL PASS

**Step 2: Run property-based tests**

Run: `pnpm test:pbt`
Expected: ALL PASS

**Step 3: Verify per-tab routing test passes**

Run: `pnpm vitest run test/unit/relay/per-tab-routing-e2e.test.ts -v`
Expected: ALL PASS — reconnection test should now work without the flash of wrong session

**Step 4: Run the full build**

Run: `pnpm build`
Expected: No type errors

**Step 5: Commit (if any fixups needed)**

```
fix: integration test fixups for multi-tab session isolation
```
