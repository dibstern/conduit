# New Session Performance + Project Right-Click Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make "New Session" faster via server-side non-blocking broadcast + correlation IDs, add button guards to prevent double-clicks, and enable right-click "Open in New Tab" on projects in the ProjectSwitcher.

**Architecture:** Server echoes a `requestId` for correlation and sends `session_switched` immediately (before the session list broadcast completes). Frontend state machine (`SessionCreationStatus`) guards double-clicks and shows a spinner. `completeNewSession` is called inside `handleSessionSwitched` (co-located, not in the dispatch switch statement) so the wiring can't be accidentally broken. A `sendNewSession` helper centralizes the guard + send logic so components are thin wrappers. The existing `session_switched` dispatch handler handles clearing/navigation as it does today — no optimistic UI clearing.

**Design decision — no optimistic clear:** The frontend does NOT optimistically clear messages/permissions/todos before the server responds. The server-side change (non-blocking broadcast) is where the real latency win lives. Optimistic clearing introduces recovery problems (no way to restore the previous session on failure), race conditions (user switches session while creation is in-flight → late-arriving `session_switched` yanks them away), and the existing `session_switched` dispatch handler already handles cleanup when the server responds (`clearMessages`, `clearTodoState`, `clearSessionLocal`).

**Tech Stack:** Svelte 5 (`$state`), TypeScript discriminated unions, branded types (`RequestId`), Vitest

**TypeScript strictness:** This project has `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` enabled. The plan uses conditional spread patterns (not `requestId: requestId ?? undefined`) to comply with `exactOptionalPropertyTypes`, and branded types to prevent accidental ID confusion.

---

## Task 1: Add branded `RequestId` type + update `PayloadMap["new_session"]`

**Files:**
- Modify: `src/lib/shared-types.ts` (add `RequestId` branded type)
- Modify: `src/lib/frontend/types.ts` (re-export `RequestId`)
- Modify: `src/lib/handlers/payloads.ts:15` (the `new_session` entry)

**Why a branded type:** `requestId` and session IDs are both UUID strings. A branded type prevents accidentally passing a session ID where a correlation ID is expected (e.g., `completeNewSession(msg.id)` instead of `completeNewSession(msg.requestId)`). The brand is erased at runtime — zero cost.

**Step 1: Add `RequestId` to `shared-types.ts`**

Near the top of `src/lib/shared-types.ts`, with the other type definitions:

```typescript
/**
 * Branded type for request/response correlation IDs.
 * Prevents accidentally passing a session ID where a correlation ID is expected.
 * Erased at runtime — zero cost.
 */
export type RequestId = string & { readonly __brand: "RequestId" };
```

**Step 2: Re-export from frontend `types.ts`**

In `src/lib/frontend/types.ts`, add `RequestId` to the existing re-export block from `shared-types.ts`:

```typescript
export type {
    AgentInfo,
    AskUserQuestion,
    // ... existing re-exports ...
    RequestId,        // ← ADD
    RelayMessage,
    SessionInfo,
    // ... rest ...
} from "../shared-types.js";
```

**Step 3: Update `PayloadMap` in `payloads.ts`**

In `src/lib/handlers/payloads.ts`, add the import and update the `new_session` entry:

```typescript
// Add import at top of file
import type { RequestId } from "../shared-types.js";

// Change the new_session entry:
// Before
new_session: { title?: string };

// After
new_session: { title?: string; requestId?: RequestId };
```

**Step 4: Run tests to verify nothing breaks**

Run: `pnpm test:unit`
Expected: All tests pass (additive type changes only)

**Step 5: Commit**

```
feat: add branded RequestId type and requestId to new_session payload
```

---

## Task 2: Add `RequestId` to `session_switched` in `RelayMessage`

**Files:**
- Modify: `src/lib/shared-types.ts:288-301` (the `session_switched` variant)

**Step 1: Update the type**

In the `session_switched` variant of `RelayMessage`, add `requestId`:

```typescript
| {
    type: "session_switched";
    id: string;
    /** Correlation ID echoed from new_session request. */
    requestId?: RequestId;
    /** Raw events for client replay (cache hit). */
    events?: RelayMessage[];
    /** Structured messages for HistoryView (REST API fallback). */
    history?: {
        messages: HistoryMessage[];
        hasMore: boolean;
        total?: number;
    };
    /** Current input draft text for this session (from input_sync). */
    inputText?: string;
  }
```

Note: `RequestId` is already imported in `shared-types.ts` (added in Task 1).

**Step 2: Run tests**

Run: `pnpm test:unit`
Expected: All pass (additive type change)

**Step 3: Commit**

```
feat: add requestId to session_switched message type
```

---

## Task 3: Echo `requestId` in `handleNewSession` + non-blocking broadcast

**Files:**
- Modify: `src/lib/handlers/session.ts:166-185`
- Test: `test/unit/handlers/handlers-session.test.ts`

**Context — behavior change:** This task makes two changes to `handleNewSession`:
1. Echo `requestId` in the `session_switched` response (new feature).
2. Make the session list broadcast **non-blocking** (behavior change). Currently, `handleNewSession` awaits `listSessions()` before returning, guaranteeing the session list is updated before the handler completes. The new version uses `.then()/.catch()` so `session_switched` goes to the client immediately, and the broadcast follows asynchronously. This is the primary latency win — the client no longer waits for the extra API round-trip.

**Error path:** If `deps.sessionMgr.createSession()` throws, the error propagates to `dispatchMessage()` (which has a try/catch at the dispatch boundary), no `session_switched` is sent, and the frontend's creation state machine will time out and re-enable the button. This is acceptable.

**Step 1: Write failing tests**

Add to `test/unit/handlers/handlers-session.test.ts`. Add `handleNewSession` to the existing import from `session.js`, and add the `RequestId` import:

```typescript
import { handleNewSession } from "../../../src/lib/handlers/session.js";
import type { RequestId } from "../../../src/lib/shared-types.js";

describe("handleNewSession", () => {
    let sendToCalls: Array<{ clientId: string; msg: unknown }>;
    let broadcastCalls: unknown[];
    let deps: HandlerDeps;

    beforeEach(() => {
        sendToCalls = [];
        broadcastCalls = [];
        deps = createMockHandlerDeps({
            wsHandler: {
                ...createMockHandlerDeps().wsHandler,
                sendTo: (clientId: string, msg: unknown) => sendToCalls.push({ clientId, msg }),
                broadcast: (msg: unknown) => broadcastCalls.push(msg),
                setClientSession: vi.fn(),
            } as unknown as HandlerDeps["wsHandler"],
        });
    });

    it("echoes requestId in session_switched response", async () => {
        await handleNewSession(deps, "client-1", {
            title: "test",
            requestId: "req-123" as RequestId,
        });

        const switched = sendToCalls.find(c => (c.msg as Record<string, unknown>).type === "session_switched");
        expect(switched).toBeDefined();
        expect((switched!.msg as Record<string, unknown>).requestId).toBe("req-123");
    });

    it("omits requestId when not provided", async () => {
        await handleNewSession(deps, "client-1", { title: "test" });

        const switched = sendToCalls.find(c => (c.msg as Record<string, unknown>).type === "session_switched");
        expect(switched).toBeDefined();
        expect((switched!.msg as Record<string, unknown>).requestId).toBeUndefined();
    });

    it("broadcasts session list after creation (non-blocking)", async () => {
        await handleNewSession(deps, "client-1", { title: "test" });

        // Broadcast is non-blocking — flush the microtask queue.
        // .then() on mockResolvedValue runs as a microtask; setTimeout(0)
        // creates a macrotask that runs after all microtasks drain.
        await new Promise(r => setTimeout(r, 0));

        const listMsg = broadcastCalls.find(c => (c as Record<string, unknown>).type === "session_list");
        expect(listMsg).toBeDefined();
    });

    it("logs but doesn't throw when session list broadcast fails", async () => {
        const logCalls: string[] = [];
        deps.sessionMgr.listSessions = vi.fn().mockRejectedValue(new Error("db down"));
        // Match the real HandlerDeps["log"] signature: (...args: unknown[]) => void
        deps.log = (...args: unknown[]) => logCalls.push(args.map(String).join(" "));

        // Should not throw
        await handleNewSession(deps, "client-1", { title: "test" });
        await new Promise(r => setTimeout(r, 0));

        expect(logCalls.some(m => m.includes("Failed to broadcast"))).toBe(true);
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts -t "handleNewSession"`
Expected: The `requestId` tests FAIL (not echoed yet). The broadcast tests PASS even before changes (the broadcast occurs either way — blocking or non-blocking — these serve as regression guards).

**Step 3: Implement**

In `src/lib/handlers/session.ts`, update `handleNewSession`:

```typescript
export async function handleNewSession(
    deps: HandlerDeps,
    clientId: string,
    payload: PayloadMap["new_session"],
): Promise<void> {
    const { title, requestId } = payload;
    const session = await deps.sessionMgr.createSession(title, { silent: true });

    deps.wsHandler.setClientSession(clientId, session.id);
    deps.wsHandler.sendTo(clientId, {
        type: "session_switched",
        id: session.id,
        // Note: exactOptionalPropertyTypes is enabled. The conditional spread
        // avoids assigning `undefined` to the optional `requestId` property,
        // which that flag forbids. Do NOT use `requestId: requestId ?? undefined`.
        ...(requestId != null && { requestId }),
    });

    // Session list broadcast — non-blocking so session_switched reaches the
    // client immediately without waiting for the listSessions() API call.
    // This is the primary latency win. Errors are logged, not thrown.
    deps.sessionMgr
        .listSessions()
        .then((sessions) => {
            deps.wsHandler.broadcast({ type: "session_list", sessions });
        })
        .catch((err) => {
            deps.log(`   [session] Failed to broadcast session list after new_session: ${err}`);
        });

    deps.log(`   [session] client=${clientId} Created: ${session.id}`);
}
```

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: All pass

**Step 5: Commit**

```
feat: echo requestId in handleNewSession and make session list broadcast non-blocking
```

---

## Task 4: Add `SessionCreationStatus` state machine + `sendNewSession` helper

**Files:**
- Modify: `src/lib/frontend/stores/session.svelte.ts`
- Test: `test/unit/stores/session-store.test.ts`

**Design — co-location and centralization:**
Three structural choices make this hard to break:

1. **`completeNewSession` is called inside `handleSessionSwitched`** — not in the dispatch switch statement. This means the wiring can't be accidentally deleted during dispatch refactoring, and tests genuinely validate the behavior by calling `handleSessionSwitched` directly.
2. **`sendNewSession(send)` centralizes the guard + send** — both Sidebar and SessionList call this one function. If the payload shape or guard logic changes, there's one place to update.
3. **Timeout constants are exported** — tests reference `NEW_SESSION_TIMEOUT_MS` and `ERROR_DISPLAY_MS` instead of magic numbers, so changes to the constants are automatically picked up.

**Step 1: Write failing tests**

Add to `test/unit/stores/session-store.test.ts`.

Note: the existing test file imports `{ beforeEach, describe, expect, it }` from `"vitest"` — add `vi` to that import since the timeout tests use `vi.useFakeTimers()` / `vi.useRealTimers()`.

```typescript
import {
    sessionCreation,
    requestNewSession,
    completeNewSession,
    failNewSession,
    resetSessionCreation,
    sendNewSession,
    clearSessionState,
    NEW_SESSION_TIMEOUT_MS,
    ERROR_DISPLAY_MS,
} from "../../../src/lib/frontend/stores/session.svelte.js";

// ─── SessionCreationStatus state machine ────────────────────────────────────

describe("SessionCreationStatus state machine", () => {
    beforeEach(() => {
        resetSessionCreation();
    });

    it("starts in idle phase", () => {
        expect(sessionCreation.value.phase).toBe("idle");
    });

    it("transitions idle -> creating with requestId", () => {
        const requestId = requestNewSession();
        expect(requestId).toMatch(/^[0-9a-f-]+$/); // UUID format
        expect(sessionCreation.value.phase).toBe("creating");
        if (sessionCreation.value.phase === "creating") {
            expect(sessionCreation.value.requestId).toBe(requestId);
            expect(sessionCreation.value.startedAt).toBeGreaterThan(0);
        }
    });

    it("rejects requestNewSession when not idle", () => {
        requestNewSession();
        const second = requestNewSession();
        expect(second).toBeNull(); // Guard: already creating
    });

    it("transitions creating -> idle on completeNewSession with matching requestId", () => {
        const requestId = requestNewSession()!;
        completeNewSession(requestId);
        expect(sessionCreation.value.phase).toBe("idle");
    });

    it("ignores completeNewSession with non-matching requestId", () => {
        requestNewSession();
        completeNewSession("wrong-id");
        expect(sessionCreation.value.phase).toBe("creating"); // Still creating
    });

    it("transitions creating -> error on failNewSession", () => {
        const requestId = requestNewSession()!;
        failNewSession(requestId, "API timeout");
        expect(sessionCreation.value.phase).toBe("error");
        if (sessionCreation.value.phase === "error") {
            expect(sessionCreation.value.message).toBe("API timeout");
        }
    });

    it("transitions error -> idle on resetSessionCreation", () => {
        const requestId = requestNewSession()!;
        failNewSession(requestId, "fail");
        expect(sessionCreation.value.phase).toBe("error");
        resetSessionCreation();
        expect(sessionCreation.value.phase).toBe("idle");
    });

    // ─── Edge cases (no-ops) ────────────────────────────────────────────

    it("completeNewSession is a no-op when phase is idle", () => {
        completeNewSession("any-id");
        expect(sessionCreation.value.phase).toBe("idle");
    });

    it("completeNewSession is a no-op when phase is error", () => {
        const requestId = requestNewSession()!;
        failNewSession(requestId, "fail");
        completeNewSession(requestId);
        expect(sessionCreation.value.phase).toBe("error"); // Still error
    });

    it("failNewSession is a no-op when phase is idle", () => {
        failNewSession("any-id", "shouldn't matter");
        expect(sessionCreation.value.phase).toBe("idle");
    });

    it("failNewSession is a no-op with wrong requestId", () => {
        const requestId = requestNewSession()!;
        failNewSession("wrong-id", "shouldn't matter");
        expect(sessionCreation.value.phase).toBe("creating");
        if (sessionCreation.value.phase === "creating") {
            expect(sessionCreation.value.requestId).toBe(requestId);
        }
    });

    it("supports re-entrant create/complete cycles", () => {
        const id1 = requestNewSession()!;
        completeNewSession(id1);
        expect(sessionCreation.value.phase).toBe("idle");

        const id2 = requestNewSession()!;
        expect(id2).not.toBe(id1);
        expect(sessionCreation.value.phase).toBe("creating");
        completeNewSession(id2);
        expect(sessionCreation.value.phase).toBe("idle");
    });

    // ─── Timeout (store-level, using exported constants) ────────────────

    it("auto-fails after timeout", () => {
        vi.useFakeTimers();
        requestNewSession();
        expect(sessionCreation.value.phase).toBe("creating");

        vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS);
        expect(sessionCreation.value.phase).toBe("error");
        if (sessionCreation.value.phase === "error") {
            expect(sessionCreation.value.message).toContain("timed out");
        }

        // Auto-resets to idle after ERROR_DISPLAY_MS
        vi.advanceTimersByTime(ERROR_DISPLAY_MS);
        expect(sessionCreation.value.phase).toBe("idle");

        vi.useRealTimers();
    });

    it("timeout is cancelled when session completes before deadline", () => {
        vi.useFakeTimers();
        const requestId = requestNewSession()!;

        vi.advanceTimersByTime(1000); // Not yet timed out
        completeNewSession(requestId);
        expect(sessionCreation.value.phase).toBe("idle");

        vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS); // Past the original deadline
        expect(sessionCreation.value.phase).toBe("idle"); // Should stay idle

        vi.useRealTimers();
    });

    // ─── clearSessionState integration (project switch safety) ──────────

    it("clearSessionState resets creation state (project switch cancels in-flight creation)", () => {
        vi.useFakeTimers();
        requestNewSession();
        expect(sessionCreation.value.phase).toBe("creating");

        clearSessionState();
        expect(sessionCreation.value.phase).toBe("idle");

        // Timeout timer should also be cancelled — advancing past deadline
        // should NOT transition to error
        vi.advanceTimersByTime(NEW_SESSION_TIMEOUT_MS + 1000);
        expect(sessionCreation.value.phase).toBe("idle");

        vi.useRealTimers();
    });
});

// ─── sendNewSession (centralized guard + send) ──────────────────────────────

describe("sendNewSession", () => {
    let sent: Record<string, unknown>[];
    const mockSend = (data: Record<string, unknown>) => sent.push(data);

    beforeEach(() => {
        sent = [];
        resetSessionCreation();
    });

    it("sends new_session with requestId and returns requestId", () => {
        const requestId = sendNewSession(mockSend);
        expect(requestId).not.toBeNull();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual({ type: "new_session", requestId });
    });

    it("transitions to creating phase", () => {
        sendNewSession(mockSend);
        expect(sessionCreation.value.phase).toBe("creating");
    });

    it("returns null and sends nothing when already creating", () => {
        sendNewSession(mockSend);
        sent = [];
        const result = sendNewSession(mockSend);
        expect(result).toBeNull();
        expect(sent).toHaveLength(0);
    });

    // ─── Component guard lifecycle (mirrors Sidebar/SessionList) ────────

    it("mirrors Sidebar button guard: disabled when creating, re-enabled after complete", () => {
        // First click — succeeds, button should be disabled
        const requestId = sendNewSession(mockSend)!;
        expect(sessionCreation.value.phase === "creating").toBe(true);

        // Second click while creating — guard blocks
        expect(sendNewSession(mockSend)).toBeNull();

        // Server responds — button should re-enable
        completeNewSession(requestId);
        expect(sessionCreation.value.phase === "creating").toBe(false);

        // Third click — succeeds again
        sent = [];
        expect(sendNewSession(mockSend)).not.toBeNull();
        expect(sent).toHaveLength(1);
    });
});

// ─── handleSessionSwitched — requestId completion (co-located) ──────────────

describe("handleSessionSwitched — requestId completion", () => {
    beforeEach(() => {
        resetSessionCreation();
        sessionState.currentId = null;
    });

    it("completes session creation when requestId matches", () => {
        const requestId = requestNewSession()!;
        expect(sessionCreation.value.phase).toBe("creating");

        handleSessionSwitched({ type: "session_switched", id: "new-sess", requestId });

        expect(sessionState.currentId).toBe("new-sess");
        expect(sessionCreation.value.phase).toBe("idle");
    });

    it("leaves creation state alone when requestId is absent", () => {
        requestNewSession();
        expect(sessionCreation.value.phase).toBe("creating");

        handleSessionSwitched({ type: "session_switched", id: "other-sess" });

        expect(sessionState.currentId).toBe("other-sess");
        expect(sessionCreation.value.phase).toBe("creating"); // NOT completed
    });

    it("leaves creation state alone when requestId doesn't match", () => {
        requestNewSession();
        expect(sessionCreation.value.phase).toBe("creating");

        handleSessionSwitched({ type: "session_switched", id: "other-sess", requestId: "wrong-id" });

        expect(sessionState.currentId).toBe("other-sess");
        expect(sessionCreation.value.phase).toBe("creating"); // NOT completed
    });

    it("is a no-op for creation state when not in creating phase", () => {
        // Not creating — requestId on msg should be harmless
        handleSessionSwitched({ type: "session_switched", id: "sess-1", requestId: "some-id" });

        expect(sessionState.currentId).toBe("sess-1");
        expect(sessionCreation.value.phase).toBe("idle"); // Still idle
    });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/stores/session-store.test.ts -t "SessionCreationStatus|sendNewSession|requestId completion"`
Expected: FAIL (functions not exported yet)

**Step 3: Implement the state machine, sendNewSession, and update handleSessionSwitched**

Add to `src/lib/frontend/stores/session.svelte.ts`:

```typescript
import type { RequestId } from "../types.js";

// ─── Session Creation State Machine ──────────────────────────────────────────
// Guards the new-session flow with typed phases. Prevents double-clicks,
// tracks in-flight creation for button state, and handles timeout.
//
// Uses a { value: T } wrapper because Svelte 5's $state creates a reactive
// proxy — you can't reassign a top-level $state variable, only mutate its
// properties. The wrapper lets us swap the entire discriminated union cleanly
// without Object.assign/delete hacks.

/** Exported for tests — avoids magic numbers. */
export const NEW_SESSION_TIMEOUT_MS = 5000;
/** Exported for tests — avoids magic numbers. */
export const ERROR_DISPLAY_MS = 2000;

export type SessionCreationStatus =
    | { phase: "idle" }
    | { phase: "creating"; requestId: RequestId; startedAt: number }
    | { phase: "error"; message: string; requestId: RequestId };

export const sessionCreation = $state<{ value: SessionCreationStatus }>({
    value: { phase: "idle" },
});

/** Active timeout timer — cleared on completion or reset. */
let _creationTimer: ReturnType<typeof setTimeout> | null = null;
let _errorResetTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
    if (_creationTimer) { clearTimeout(_creationTimer); _creationTimer = null; }
    if (_errorResetTimer) { clearTimeout(_errorResetTimer); _errorResetTimer = null; }
}

/**
 * Create a branded RequestId from crypto.randomUUID().
 * Frontend-only — the server receives and echoes RequestIds, never creates them.
 */
function createRequestId(): RequestId {
    return crypto.randomUUID() as RequestId;
}

/**
 * Transition idle -> creating. Returns the requestId, or null if not idle.
 * Starts a timeout that auto-fails after NEW_SESSION_TIMEOUT_MS.
 */
export function requestNewSession(): RequestId | null {
    if (sessionCreation.value.phase !== "idle") return null;
    const requestId = createRequestId();
    sessionCreation.value = {
        phase: "creating",
        requestId,
        startedAt: Date.now(),
    };

    // Timeout: auto-fail if server doesn't respond.
    // Lives in the store (not a component $effect) so it works regardless
    // of which UI panel is visible.
    clearTimers();
    _creationTimer = setTimeout(() => {
        _creationTimer = null;
        if (sessionCreation.value.phase === "creating"
            && sessionCreation.value.requestId === requestId) {
            failNewSession(requestId, "Session creation timed out");
        }
    }, NEW_SESSION_TIMEOUT_MS);

    return requestId;
}

/**
 * Transition creating -> idle when requestId matches (server confirmed).
 */
export function completeNewSession(requestId: string): void {
    if (sessionCreation.value.phase !== "creating") return;
    if (sessionCreation.value.requestId !== requestId) return;
    clearTimers();
    sessionCreation.value = { phase: "idle" };
}

/**
 * Transition creating -> error. Auto-resets to idle after ERROR_DISPLAY_MS.
 */
export function failNewSession(requestId: string, message: string): void {
    if (sessionCreation.value.phase !== "creating") return;
    if (sessionCreation.value.requestId !== requestId) return;
    clearTimers();
    sessionCreation.value = { phase: "error", message, requestId };

    _errorResetTimer = setTimeout(() => {
        _errorResetTimer = null;
        resetSessionCreation();
    }, ERROR_DISPLAY_MS);
}

/**
 * Reset to idle from any phase. Clears all timers.
 */
export function resetSessionCreation(): void {
    clearTimers();
    sessionCreation.value = { phase: "idle" };
}

/**
 * Guard + send in one call. Returns the requestId, or null if already creating.
 * Both Sidebar and SessionList call this — centralizes the guard and payload
 * shape so they can't diverge.
 */
export function sendNewSession(
    send: (data: Record<string, unknown>) => void,
): RequestId | null {
    const requestId = requestNewSession();
    if (!requestId) return null;
    send({ type: "new_session", requestId });
    return requestId;
}
```

**Then update the existing `handleSessionSwitched` function** (already in the same file) to call `completeNewSession` internally:

```typescript
// BEFORE (existing code):
export function handleSessionSwitched(
    msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
    const { id } = msg;
    if (id) {
        sessionState.currentId = id;
    }
}

// AFTER:
export function handleSessionSwitched(
    msg: Extract<RelayMessage, { type: "session_switched" }>,
): void {
    const { id, requestId } = msg;
    if (id) {
        sessionState.currentId = id;
    }
    // Co-located: complete the creation state machine if this session_switched
    // is the response to our new_session request. This is inside
    // handleSessionSwitched (not in the dispatch switch) so it can't be
    // accidentally separated from the state update.
    if (requestId) {
        completeNewSession(requestId);
    }
}
```

**Then update `clearSessionState`** (already in the same file) to cancel any in-flight creation on project switch:

```typescript
// BEFORE (existing code):
export function clearSessionState(): void {
    sessionState.sessions = [];
    sessionState.currentId = null;
    sessionState.searchQuery = "";
    sessionState.hasMore = false;
}

// AFTER:
export function clearSessionState(): void {
    resetSessionCreation(); // Cancel any in-flight creation (project switch safety)
    sessionState.sessions = [];
    sessionState.currentId = null;
    sessionState.searchQuery = "";
    sessionState.hasMore = false;
}
```

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/stores/session-store.test.ts`
Expected: All pass (including existing `handleSessionSwitched` tests, which don't pass `requestId` and are unaffected)

**Step 5: Commit**

```
feat: add SessionCreationStatus state machine with sendNewSession helper
```

---

## Task 5: Verify dispatch integration (no code changes needed)

`completeNewSession` is now called inside `handleSessionSwitched` (Task 4), so `ws-dispatch.ts` does **not** need any changes. The dispatch already calls `handleSessionSwitched(msg)` on line 163, which now internally handles creation completion when `msg.requestId` is present.

**Step 1: Run full test suite to confirm**

Run: `pnpm test:unit`
Expected: All pass

**Step 2: Verify no import changes needed in ws-dispatch.ts**

Check that `ws-dispatch.ts` imports `handleSessionSwitched` from `./session.svelte.js` (it does — line 51). No additional imports needed since `completeNewSession` is called internally.

No commit needed for this task.

---

## Task 6: Add button guard + loading spinner to New Session buttons

**Files:**
- Modify: `src/lib/frontend/components/layout/Sidebar.svelte:38-40`
- Modify: `src/lib/frontend/components/features/SessionList.svelte:80-83`

**Design decision:** No optimistic clearing. Both components call `sendNewSession(wsSend)` (from Task 4) which handles the guard + send in one call. The existing `session_switched` dispatch handler handles clearing messages/permissions/todos when the server responds. The timeout lives in the store (Task 4), not in a component `$effect`, so it works regardless of which sidebar panel is visible.

**Step 1: Update Sidebar.svelte handleNewSession**

`Sidebar.svelte` already imports `wsSend` from `../../stores/ws.svelte.js` — use the existing import. Add only the new imports needed:

```typescript
// Add to existing imports at top of <script>
import { sendNewSession, sessionCreation } from "../../stores/session.svelte.js";

// Replace handleNewSession (currently on line ~38)
function handleNewSession() {
    sendNewSession(wsSend);
}
```

**Step 2: Update SessionList.svelte handleNewSession**

`SessionList.svelte` already imports `wsSend` from `../../stores/ws.svelte.js` and several exports from `../../stores/session.svelte.js` — use the existing imports. Add `sendNewSession` and `sessionCreation` to the existing `session.svelte.js` import (don't create a second import from the same module).

```typescript
// Add sendNewSession and sessionCreation to the EXISTING import from session.svelte.js:
import {
    sessionState,
    getFilteredSessions,
    getDateGroups,
    setSearchQuery,
    setCurrentSession,
    switchToSession,
    sendNewSession,      // ← ADD
    sessionCreation,     // ← ADD
} from "../../stores/session.svelte.js";

// Replace handleNewSession (currently on line ~80)
function handleNewSession() {
    if (!sendNewSession(wsSend)) return; // Guard: already creating
    closeMobileSidebar();
}
```

**Step 3: Add loading indicator to buttons**

In `Sidebar.svelte`, update the New Session button:

```svelte
<button
    id="new-session-btn"
    class="session-action-btn flex items-center gap-2 w-full py-2 px-3 border-none rounded-[10px] bg-transparent text-text-secondary font-sans text-sm cursor-pointer disabled:cursor-default transition-[background,color] duration-100 text-left hover:bg-sidebar-hover hover:text-text"
    onclick={handleNewSession}
    disabled={sessionCreation.value.phase === "creating"}
>
    {#if sessionCreation.value.phase === "creating"}
        <Icon name="loader-2" size={16} class="shrink-0 animate-spin" />
    {:else}
        <Icon name="plus" size={16} class="shrink-0" />
    {/if}
    <span class="overflow-hidden text-ellipsis whitespace-nowrap">New session</span>
</button>
```

In `SessionList.svelte`, update the "+" button (find the existing new-session button in the header area and apply the same pattern). Add `disabled:cursor-default` to the existing class string:

```svelte
<button
    title="New session"
    onclick={handleNewSession}
    disabled={sessionCreation.value.phase === "creating"}
    class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer disabled:cursor-default transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
>
    {#if sessionCreation.value.phase === "creating"}
        <Icon name="loader-2" size={14} class="animate-spin" />
    {:else}
        <Icon name="plus" size={14} />
    {/if}
</button>
```

**Step 4: Run build to verify no type errors**

Run: `pnpm build`
Expected: Build succeeds

**Step 5: Commit**

```
feat: add button guard with loading spinner for new session creation
```

---

## Task 7: Convert ProjectSwitcher items to `<a>` tags

**Files:**
- Modify: `src/lib/frontend/components/features/ProjectSwitcher.svelte:82-87, 259-288, 296-326`

**Step 1: Update `selectProject` to accept MouseEvent**

The `<a>` tag needs `preventDefault()` on normal left-click so the SPA router handles navigation instead of a full page reload. Modifier-key clicks should fall through to the browser's native "open in new tab" behavior.

```typescript
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

**Step 2: Convert multi-instance project items (lines ~259-288)**

Replace the `<div>` with `<a>`. The `a11y_click_events_have_key_events` and `a11y_no_static_element_interactions` suppression comments are no longer needed since `<a>` is natively interactive.

Important styling notes:
- Add `no-underline` to prevent default `<a>` underline
- Add `text-inherit` to prevent default link color
- Add `visited:text-inherit` to prevent `:visited` color change (browsers apply visited styling to `<a>` tags, which `<div>` tags didn't have)

```svelte
<a
    href="/p/{project.slug}/"
    data-testid="project-item"
    class={"flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-black/[0.04] border-l-[3px] no-underline text-inherit visited:text-inherit" +
        (isActive
            ? " border-l-accent bg-accent/[0.06]"
            : " border-l-transparent")}
    onclick={(e) => selectProject(e, project.slug)}
>
    <!-- Indicator dot -->
    <span
        class={"w-1.5 h-1.5 rounded-full shrink-0" +
            (isActive ? " bg-accent" : " bg-text-dimmer/40")}
    ></span>
    <!-- Name -->
    <span
        class={"flex-1 text-[13px] truncate" +
            (isActive
                ? " font-semibold text-text"
                : " text-text-secondary")}
    >
        {project.title}
    </span>
    <!-- Client count -->
    {#if project.clientCount && project.clientCount > 0}
        <span
            class="shrink-0 text-xs text-text-dimmer tabular-nums"
        >
            {project.clientCount}
        </span>
    {/if}
</a>
```

**Step 3: Convert single-instance project items (lines ~296-326)**

Apply the **identical** transformation — `<div>` to `<a>` with all the same class additions (`no-underline text-inherit visited:text-inherit`) and `data-testid="project-item"`. The full markup:

```svelte
<a
    href="/p/{project.slug}/"
    data-testid="project-item"
    class={"flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-black/[0.04] border-l-[3px] no-underline text-inherit visited:text-inherit" +
        (isActive
            ? " border-l-accent bg-accent/[0.06]"
            : " border-l-transparent")}
    onclick={(e) => selectProject(e, project.slug)}
>
    <!-- Indicator dot -->
    <span
        class={"w-1.5 h-1.5 rounded-full shrink-0" +
            (isActive ? " bg-accent" : " bg-text-dimmer/40")}
    ></span>
    <!-- Name -->
    <span
        class={"flex-1 text-[13px] truncate" +
            (isActive
                ? " font-semibold text-text"
                : " text-text-secondary")}
    >
        {project.title}
    </span>
    <!-- Client count -->
    {#if project.clientCount && project.clientCount > 0}
        <span
            class="shrink-0 text-xs text-text-dimmer tabular-nums"
        >
            {project.clientCount}
        </span>
    {/if}
</a>
```

**Step 4: Run build**

Run: `pnpm build`
Expected: Build succeeds, no a11y warnings for these elements (since `<a>` is natively interactive)

**Step 5: Verify manually (if possible)**

Right-click on a project in the switcher dropdown. The browser context menu should show "Open in New Tab" / "Open Link in New Tab". Cmd+click (Mac) / Ctrl+click (Windows) should also open in a new tab.

**Step 6: Commit**

```
fix: enable right-click "Open in New Tab" on project switcher items
```

---

## Task 8: Add `wsSendTyped` typed WebSocket send function

**Files:**
- Modify: `src/lib/frontend/tsconfig.json` (add `payloads.ts` to include)
- Modify: `src/lib/frontend/types.ts` (re-export `PayloadMap`)
- Modify: `src/lib/frontend/stores/ws-send.svelte.ts` (add `wsSendTyped`)
- Modify: `src/lib/frontend/stores/ws.svelte.ts` (re-export `wsSendTyped`)
- Test: `test/unit/stores/ws-send-typed.test.ts`

**Why:** `wsSend` accepts `Record<string, unknown>` — no compile-time validation that the payload matches `PayloadMap`. You can write `wsSend({ type: "new_session", requesttId: id })` (typo) and TypeScript won't catch it. `wsSendTyped` closes this gap for all future WebSocket sends.

**Note:** `sendNewSession` (Task 4) already centralizes the `new_session` payload construction, so it isn't affected by this change. `wsSendTyped` is for direct sends from components and for all other message types. Migrating all existing `wsSend` callsites to `wsSendTyped` is a follow-up ticket.

**Step 1: Add `payloads.ts` to frontend tsconfig include**

In `src/lib/frontend/tsconfig.json`, add `"../handlers/payloads.ts"` to the include array so the TypeScript compiler can resolve the import. `payloads.ts` is a pure type definition file with no runtime code, so this is safe:

```json
"include": [
    "./**/*.ts",
    "./**/*.d.ts",
    "./**/*.svelte",
    "../shared-types.ts",
    "../handlers/payloads.ts",
    "../vite-env.d.ts"
]
```

**Step 2: Re-export `PayloadMap` from frontend `types.ts`**

In `src/lib/frontend/types.ts`, add a re-export so frontend code can import `PayloadMap` from the canonical frontend types module:

```typescript
export type { PayloadMap } from "../handlers/payloads.js";
```

**Step 3: Write tests**

Create `test/unit/stores/ws-send-typed.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { RequestId } from "../../../src/lib/shared-types.js";

/**
 * Compile-time type safety tests for wsSendTyped.
 *
 * These verify that TypeScript catches payload errors at compile time.
 * The @ts-expect-error annotations prove that incorrect calls fail to compile.
 * If any @ts-expect-error is "unused" (no error), the test file itself fails
 * to compile, catching regressions.
 */
describe("wsSendTyped compile-time safety", () => {
    // Simulate the function signature for compile-time checking.
    // The runtime function is tested via wsSend delegation.
    type WsSendTyped = <T extends keyof PayloadMap>(type: T, payload: PayloadMap[T]) => void;
    const wsSendTyped: WsSendTyped = (() => {}) as WsSendTyped;

    it("accepts correct payloads (compile-time verified)", () => {
        // These must compile — if they don't, the test won't run
        wsSendTyped("cancel", {});
        wsSendTyped("new_session", {});
        wsSendTyped("new_session", { requestId: "id" as RequestId });
        wsSendTyped("new_session", { title: "test" });
        wsSendTyped("message", { text: "hello" });
        wsSendTyped("switch_session", { sessionId: "s1" });
    });

    it("rejects wrong payload shapes (compile-time verified)", () => {
        // @ts-expect-error — wrong payload shape for new_session
        wsSendTyped("new_session", { text: "wrong" });
        // @ts-expect-error — missing required field for message
        wsSendTyped("message", {});
        // @ts-expect-error — plain string is not RequestId (branded type)
        wsSendTyped("new_session", { requestId: "plain-string" });
        // @ts-expect-error — unknown message type
        wsSendTyped("nonexistent_type", {});
    });
});
```

**Step 4: Implement `wsSendTyped` in `ws-send.svelte.ts`**

Add to `src/lib/frontend/stores/ws-send.svelte.ts`:

```typescript
import type { PayloadMap } from "../types.js";

/**
 * Type-safe WebSocket send. Ensures the payload matches the expected shape
 * for the given message type at compile time, catching typos and wrong
 * property types that `wsSend(Record<string, unknown>)` misses.
 *
 * Delegates to wsSend for rate limiting (chat messages) and offline queuing.
 *
 * Usage:
 *   wsSendTyped("new_session", { requestId });       // typed payload
 *   wsSendTyped("cancel", {});                        // empty payload required
 *   wsSendTyped("message", { text: "hello" });        // text required
 *   wsSendTyped("new_session", { requestId: "typo" }); // ERROR: string ≠ RequestId
 *
 * Follow-up: migrate existing wsSend callsites to wsSendTyped.
 */
export function wsSendTyped<T extends keyof PayloadMap>(
    type: T,
    payload: PayloadMap[T],
): void {
    // Cast payload to Record<string, unknown> before spreading to avoid
    // impossible intersections with Record<string, never> entries (e.g. "cancel").
    wsSend({ type, ...(payload as Record<string, unknown>) });
}
```

**Step 5: Re-export from `ws.svelte.ts`**

In `src/lib/frontend/stores/ws.svelte.ts`, add `wsSendTyped` to the re-exports from `ws-send.svelte.js` (find the existing `wsSend` re-export and add `wsSendTyped` next to it).

**Step 6: Run tests**

Run: `pnpm vitest run test/unit/stores/ws-send-typed.test.ts`
Expected: All pass (the `@ts-expect-error` lines should each suppress exactly one error)

Run: `pnpm build`
Expected: Build succeeds

**Step 7: Commit**

```
feat: add wsSendTyped for compile-time WebSocket payload validation
```

---

## Task 9: Add contract test for `requestId` protocol

**Files:**
- New: `test/unit/handlers/request-id-contract.test.ts`

**Why:** The `requestId` field is used on both the server side (`PayloadMap`, `handleNewSession`) and the frontend side (`RelayMessage`, `handleSessionSwitched`). A contract test verifies both sides agree on the field name and type, catching drift if someone renames the field on one side but not the other.

**Step 1: Write the test**

Create `test/unit/handlers/request-id-contract.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { RelayMessage, RequestId } from "../../../src/lib/shared-types.js";

/**
 * Contract tests for the requestId correlation protocol.
 *
 * These verify that both sides of the protocol (client→server payload and
 * server→client response) agree on the field name and branded type.
 * If someone renames or removes requestId on one side, these tests fail
 * to compile — catching the drift before it reaches runtime.
 */
describe("requestId protocol contract", () => {
    it("PayloadMap['new_session'] accepts requestId as RequestId", () => {
        // Compile-time: requestId must be assignable as RequestId
        const payload: PayloadMap["new_session"] = {
            requestId: "test-uuid" as RequestId,
        };
        expect(payload.requestId).toBe("test-uuid");
    });

    it("PayloadMap['new_session'] allows omitting requestId", () => {
        // Compile-time: requestId is optional
        const payload: PayloadMap["new_session"] = { title: "test" };
        expect(payload.requestId).toBeUndefined();
    });

    it("session_switched RelayMessage accepts requestId as RequestId", () => {
        // Compile-time: requestId must be assignable as RequestId
        const msg: Extract<RelayMessage, { type: "session_switched" }> = {
            type: "session_switched",
            id: "sess-1",
            requestId: "test-uuid" as RequestId,
        };
        expect(msg.requestId).toBe("test-uuid");
    });

    it("session_switched RelayMessage allows omitting requestId", () => {
        // Compile-time: requestId is optional
        const msg: Extract<RelayMessage, { type: "session_switched" }> = {
            type: "session_switched",
            id: "sess-1",
        };
        expect(msg.requestId).toBeUndefined();
    });

    it("RequestId is not assignable from plain string (branded)", () => {
        // This is the key contract: plain strings can't be used as RequestId.
        // @ts-expect-error — plain string is not assignable to RequestId
        const _payload: PayloadMap["new_session"] = { requestId: "plain-string" };
        // Runtime: the value is still a string, but the type system prevents misuse
        expect(_payload.requestId).toBe("plain-string");
    });
});
```

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/handlers/request-id-contract.test.ts`
Expected: All pass

**Step 3: Commit**

```
test: add contract tests for requestId correlation protocol
```

---

## Task 10: Run full test suite and verify

**Step 1: Run unit tests**

Run: `pnpm test:unit`
Expected: All pass

**Step 2: Run build**

Run: `pnpm build`
Expected: Build succeeds with no type errors

**Step 3: Final commit (if any fixups needed)**

---

## Known Limitations

| Scenario | Behavior | Accepted? |
|----------|----------|-----------|
| Server `createSession()` throws | No `session_switched` sent; button stays in "creating" until 5s timeout fires, then auto-resets to idle | Yes — acceptable fallback |
| User switches session while creation is in-flight | Both `session_switched` messages arrive; the later one wins and sets `currentId`. The user may be briefly redirected. | Yes — rare edge case; the `requestId` correlation exists for future use if we want to gate this |
| Session list broadcast fails | Logged server-side; sidebar may briefly show stale list until next `list_sessions` call | Yes — non-critical |
| User switches project while creation is in-flight | `clearSessionState()` calls `resetSessionCreation()`, cancelling the in-flight creation and its timeout timer | Yes — correct behavior, tested |

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/lib/shared-types.ts` | Add branded `RequestId` type; add `requestId?: RequestId` to `session_switched` |
| `src/lib/handlers/payloads.ts` | Import `RequestId`; add `requestId?: RequestId` to `new_session` |
| `src/lib/frontend/types.ts` | Re-export `RequestId` and `PayloadMap` |
| `src/lib/frontend/tsconfig.json` | Add `../handlers/payloads.ts` to include |
| `src/lib/handlers/session.ts` | Echo `requestId`, make session list broadcast non-blocking |
| `src/lib/frontend/stores/session.svelte.ts` | Add `SessionCreationStatus` state machine with branded `RequestId`; `handleSessionSwitched` calls `completeNewSession` internally; `clearSessionState` calls `resetSessionCreation` |
| `src/lib/frontend/stores/ws-dispatch.ts` | No changes needed (`completeNewSession` is co-located inside `handleSessionSwitched`) |
| `src/lib/frontend/stores/ws-send.svelte.ts` | Add `wsSendTyped` typed send function |
| `src/lib/frontend/stores/ws.svelte.ts` | Re-export `wsSendTyped` |
| `src/lib/frontend/components/layout/Sidebar.svelte` | Button guard + spinner via `sendNewSession` (no optimistic clear) |
| `src/lib/frontend/components/features/SessionList.svelte` | Button guard + spinner via `sendNewSession` (no optimistic clear) |
| `src/lib/frontend/components/features/ProjectSwitcher.svelte` | `<div>` to `<a href>` with `no-underline text-inherit visited:text-inherit` |
| `test/unit/handlers/handlers-session.test.ts` | Tests for requestId echoing + non-blocking broadcast |
| `test/unit/stores/session-store.test.ts` | Tests for state machine, sendNewSession guard, component lifecycle, clearSessionState, wiring |
| `test/unit/stores/ws-send-typed.test.ts` | Compile-time safety tests for `wsSendTyped` |
| `test/unit/handlers/request-id-contract.test.ts` | Contract tests for requestId protocol (both sides agree on type) |

## Follow-up Tickets

| Ticket | Description |
|--------|-------------|
| Migrate `wsSend` → `wsSendTyped` | Convert all existing `wsSend({ type: "...", ... })` callsites across the frontend to use `wsSendTyped` for compile-time payload validation |
