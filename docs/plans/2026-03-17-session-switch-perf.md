# Session Switch Performance Optimization Plan (v3 — post-audit-v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce perceived latency when switching to inactive sessions from 100-800ms to near-instant by addressing all layers of the latency chain.

**Architecture:** The relay proxies between a browser SPA (Svelte 5) and OpenCode's REST/SSE API. Session switching currently downloads ALL messages, renders markdown client-side, and synchronously highlights every code block. This plan paginates the API, pre-renders markdown on the server, defers syntax highlighting during replay, enables WS compression, and makes metadata non-blocking.

**Tech Stack:** TypeScript, Node.js (relay server), Svelte 5 (`$state` runes, `$derived`), WebSocket, marked + DOMPurify, highlight.js

**Important TypeScript constraints:**
- `exactOptionalPropertyTypes: true` — can't assign `undefined` to optional properties
- `strict: true` — no implicit any, strict null checks
- `MessageHandler` type returns `Promise<void>` — all handlers MUST return `Promise<void>`

---

## Changes NOT Being Made

| ID | Optimization | Why skipped |
|----|-------------|-------------|
| S3 | Reuse loadHistory result for poller seed | Made unnecessary by S1 — paginated API uses `getMessagesPage()` (different path), so `loadHistory()` and the poller's `getMessages()` no longer duplicate |
| S4 | Async `readFile` in MessageCache | Audit found this has terrible complexity/benefit ratio. 3 production callers (session handler, relay-stack broadcast EventEmitter, client-init) all sync. 49 test call sites would break. `loadFromDisk()` calls `loadFromFile()` which would need a dual sync/async split. The sync design is deliberate ("identical to claude-relay's doSendAndRecord pattern"). Benefit is 0-50ms on a cold-cache path that rarely triggers. |
| C2 | Web Worker for markdown | Addressed by C3 (server-side pre-rendering) |
| C4-orig | Virtualize message list (IntersectionObserver) | Audit found 3 critical bugs in the proposed VirtualMessageList: visibleSet never shrinks (defeats purpose), auto-scroll breaks during streaming, rewind mode broken. 4 high issues: observer root, height estimation, $effect thrashing, missing permission/question cards. **Replaced by C4-css** below (CSS `content-visibility: auto`) |
| C5 | Incremental rendering | Subsumed by C4-css |
| C6 | Cache history messages alongside chat messages | Audit found 3 critical architectural gaps: `clearMessages()` in ws-dispatch destroys optimistic restore immediately on server response; no mechanism to pass HistoryView's component-local `$state` to the store for stashing; no mechanism to restore cached history from store back into HistoryView component. Needs a prerequisite refactor (lift history state to store level) before this is viable. |
| A1 | Prefetch on hover | Not requested |
| A2 | Server-side MessageCache warming on startup | **Already implemented** at `relay-stack.ts:176` — `loadFromDisk()` is called immediately after `MessageCache` construction in `createProjectRelay()` |
| A3 | Persistent IndexedDB L2 cache | Depends on C6 which is blocked. Also has its own critical issue: async IndexedDB restore can race with and overwrite fresh server data from `session_switched`. No call site wired for `restoreCachedMessagesAsync()`. |
| A4 | Stream history over WebSocket | Not requested |

---

## Pre-requisite: Verify OpenCode pagination API

**MUST be done before Task 1 (S1). The entire S1 plan rests on this.**

The `getMessagesPage()` method exists in `opencode-client.ts:308-320` and sends `?limit=N&before=ID` to OpenCode. But there is zero evidence the upstream API actually honors these parameters. If OpenCode ignores them, `getMessagesPage({limit: 50})` returns ALL messages — identical to `getMessages()` — silently defeating the optimization.

**Step 1: Test against the running instance**

```bash
# Get a session ID with many messages
SESSION_ID=$(curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  http://localhost:4096/session | python3 -c "
import json, sys
sessions = json.load(sys.stdin)
# Find one with messages — pick the first
if isinstance(sessions, list) and sessions:
    print(sessions[0]['id'])
elif isinstance(sessions, dict):
    for sid in sessions:
        print(sid); break
")

# Full fetch — count messages
FULL_COUNT=$(curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message" | python3 -c "
import json, sys; data = json.load(sys.stdin)
print(len(data) if isinstance(data, list) else 'not-a-list')
")
echo "Full: $FULL_COUNT messages"

# Paginated fetch — should return fewer
PAGED_COUNT=$(curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message?limit=5" | python3 -c "
import json, sys; data = json.load(sys.stdin)
print(len(data) if isinstance(data, list) else 'not-a-list')
")
echo "Paginated (limit=5): $PAGED_COUNT messages"
```

**Step 2: Verify message ordering**

If limit works, also check the ordering of messages returned:

```bash
# Get first message IDs from full response
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message" | python3 -c "
import json, sys; data = json.load(sys.stdin)
if isinstance(data, list):
    for m in data[:3]:
        print(f'{m[\"id\"][:12]}  role={m.get(\"role\",\"?\")}')
    print('...')
    for m in data[-3:]:
        print(f'{m[\"id\"][:12]}  role={m.get(\"role\",\"?\")}')
    print(f'Total: {len(data)}, first.id < last.id: {data[0][\"id\"] < data[-1][\"id\"]}')
"

# Get paginated — check if ordering matches the tail of the full response
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message?limit=5" | python3 -c "
import json, sys; data = json.load(sys.stdin)
if isinstance(data, list):
    for m in data:
        print(f'{m[\"id\"][:12]}  role={m.get(\"role\",\"?\")}')
    print(f'Count: {len(data)}')
"
```

**Step 3: Verify `before` cursor**

```bash
# Pick a message ID from the middle of the full response
CURSOR_ID=$(curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message" | python3 -c "
import json, sys; data = json.load(sys.stdin)
if isinstance(data, list) and len(data) > 5:
    print(data[len(data)//2]['id'])
")

curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" \
  "http://localhost:4096/session/$SESSION_ID/message?limit=5&before=$CURSOR_ID" | python3 -c "
import json, sys; data = json.load(sys.stdin)
if isinstance(data, list):
    print(f'Count: {len(data)}')
    for m in data:
        print(f'{m[\"id\"][:12]}  role={m.get(\"role\",\"?\")}')
"
```

**Step 4: Evaluate results**

- If `PAGED_COUNT == 5` and `FULL_COUNT > 5` **and** ordering is chronological (oldest first, matching tail of full response): API supports pagination. Proceed with S1.
- If `PAGED_COUNT == 5` but ordering is reversed (newest first): S1 needs rewriting to reverse the returned page. Document this.
- If `PAGED_COUNT == FULL_COUNT`: API ignores `limit`. **Abort S1** — keep the current `loadHistory` implementation (it already works correctly with slicing).
- If `before` returns 0 results or ignores the cursor: **Abort cursor-based pagination** — fall back to offset-based slicing on the server.

---

## Task 1: S1 — Use `getMessagesPage()` in `loadHistory()`

**Estimated latency reduction:** 10-200ms (proportional to session size)

**GATED on pre-requisite above. Skip this task if API doesn't paginate.**

**Files:**
- Modify: `src/lib/session/session-manager.ts:137-152`
- Modify: `src/lib/handlers/session.ts:312-329` (handleLoadMoreHistory)
- Modify: `src/lib/handlers/payloads.ts:34` (PayloadMap)
- Modify: `src/lib/frontend/components/features/HistoryView.svelte:79-91` (loadMore)
- Modify: `src/lib/bridges/client-init.ts:111` (third call site — REST fallback)
- Update: `test/helpers/mock-factories.ts:106` (loadHistory mock shape)
- Update: `test/unit/session/session-manager.pbt.test.ts` (offset → cursor semantics)
- Update: `test/unit/handlers/handlers-session.test.ts` (loadHistory mock shape)
- Update: `test/unit/handlers/regression-question-on-session-view.test.ts:69,225` (loadHistory mock)
- Update: `test/unit/handlers/message-handlers.test.ts:906,917` (loadHistory call assertions)
- Update: `test/unit/bridges/client-init.test.ts:44,50,121,145,794` (loadHistory mock + assertions)
- Update: `test/unit/regression-question-session-scoping.test.ts:81` (loadHistory mock)
- Update: `test/unit/stores/regression-session-switch-history.test.ts` (history_page shape)
- Update: `test/unit/server/m4-backend.test.ts:147,152` (getMessagesPage assertions)
- Update: `test/e2e/helpers/ws-mock.ts:96-100` (load_more_history → before param)
- Update: `test/e2e/specs/subagent-sessions.spec.ts:315-318` (same)
- Create: `test/unit/session/session-manager-pagination.test.ts`

### Step 1: Write the failing test

Create `test/unit/session/session-manager-pagination.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

describe("SessionManager.loadHistory pagination", () => {
  it("should call getMessagesPage with limit instead of getMessages", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
    }));

    const mockClient = {
      getMessagesPage: vi.fn().mockResolvedValue(messages),
      getMessages: vi.fn().mockResolvedValue(messages),
    };

    const { SessionManager } = await import(
      "../../../src/lib/session/session-manager.js"
    );

    const mgr = new SessionManager({
      client: mockClient as any,
      historyPageSize: 50,
    });
    await mgr.loadHistory("test-session-id");

    expect(mockClient.getMessagesPage).toHaveBeenCalledWith("test-session-id", {
      limit: 50,
    });
    expect(mockClient.getMessages).not.toHaveBeenCalled();
  });

  it("should pass before cursor when provided", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
    }));

    const mockClient = {
      getMessagesPage: vi.fn().mockResolvedValue(page),
      getMessages: vi.fn(),
    };

    const { SessionManager } = await import(
      "../../../src/lib/session/session-manager.js"
    );

    const mgr = new SessionManager({
      client: mockClient as any,
      historyPageSize: 50,
    });

    await mgr.loadHistory("test-session-id", "msg-50");

    expect(mockClient.getMessagesPage).toHaveBeenCalledWith("test-session-id", {
      limit: 50,
      before: "msg-50",
    });
  });

  it("hasMore should be true when page is full, false when partial", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      role: "user" as const,
    }));
    const partialPage = Array.from({ length: 30 }, (_, i) => ({
      id: `msg-${i}`,
      role: "user" as const,
    }));

    const mockClient = {
      getMessagesPage: vi.fn()
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce(partialPage),
      getMessages: vi.fn(),
    };

    const { SessionManager } = await import(
      "../../../src/lib/session/session-manager.js"
    );

    const mgr = new SessionManager({
      client: mockClient as any,
      historyPageSize: 50,
    });

    const result1 = await mgr.loadHistory("s1");
    expect(result1.hasMore).toBe(true);
    expect(result1.messages).toHaveLength(50);

    const result2 = await mgr.loadHistory("s1", "msg-0");
    expect(result2.hasMore).toBe(false);
    expect(result2.messages).toHaveLength(30);
  });

  it("should fall back to getMessages+slice if getMessagesPage fails", async () => {
    const allMessages = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
    }));

    const mockClient = {
      getMessagesPage: vi.fn().mockRejectedValue(new Error("API 400")),
      getMessages: vi.fn().mockResolvedValue(allMessages),
    };

    const { SessionManager } = await import(
      "../../../src/lib/session/session-manager.js"
    );

    const mgr = new SessionManager({
      client: mockClient as any,
      historyPageSize: 50,
    });

    const result = await mgr.loadHistory("s1");
    // Falls back to getMessages + slice from end
    expect(mockClient.getMessages).toHaveBeenCalledWith("s1");
    expect(result.messages).toHaveLength(50);
    expect(result.hasMore).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/session/session-manager-pagination.test.ts`
Expected: FAIL — `loadHistory` currently calls `getMessages` not `getMessagesPage`

### Step 3: Implement the change

Replace `loadHistory` in `src/lib/session/session-manager.ts:126-152`:

```typescript
/**
 * Load a page of message history for a session.
 *
 * Attempts paginated getMessagesPage() first. If the API returns the
 * same count as the page size limit (hinting it might not support
 * pagination), or if the call fails entirely, falls back to the
 * legacy getMessages() + client-side slicing approach.
 *
 * Messages are returned in chronological order (oldest first).
 *
 * NOTE: `hasMore` uses the heuristic `page.length === historyPageSize`.
 * This can produce one extra empty request at exact boundaries — acceptable
 * tradeoff vs. fetching all messages to compute an exact count.
 */
async loadHistory(sessionId: string, beforeCursor?: string): Promise<HistoryPage> {
  try {
    const page = await this.client.getMessagesPage(sessionId, {
      limit: this.historyPageSize,
      ...(beforeCursor != null && { before: beforeCursor }),
    });

    return {
      messages: page as unknown as HistoryMessage[],
      hasMore: page.length === this.historyPageSize,
    };
  } catch {
    // Runtime fallback: if getMessagesPage fails (API doesn't support
    // pagination params, returns 400, etc.), fall back to fetching all
    // messages and slicing client-side. This ensures the feature degrades
    // gracefully rather than breaking session switching entirely.
    return this.loadHistoryFallback(sessionId);
  }
}

/**
 * Fallback: fetch ALL messages and slice from the end.
 * Used when getMessagesPage fails (API doesn't support pagination).
 * This is the original loadHistory implementation.
 */
private async loadHistoryFallback(sessionId: string): Promise<HistoryPage> {
  const all = await this.client.getMessages(sessionId);
  const total = all.length;
  const start = Math.max(0, total - this.historyPageSize);
  const page = all.slice(start, total);

  return {
    messages: page as unknown as HistoryMessage[],
    hasMore: start > 0,
  };
}
```

Key changes from v2:
- **Added runtime fallback** via try/catch → `loadHistoryFallback()` (v2 audit CRITICAL)
- **Separated fallback into its own method** for testability
- **Removed `total` from return** — omitted entirely instead of `total: undefined` (avoids `exactOptionalPropertyTypes` violation)

### Step 4: Update `HistoryPage` type if needed

Check if `HistoryPage` type requires `total`. If so, make it truly optional:

```typescript
// In shared-types.ts or wherever HistoryPage is defined:
export interface HistoryPage {
  messages: HistoryMessage[];
  hasMore: boolean;
  total?: number;  // Only present with fallback path
}
```

### Step 5: Update PayloadMap

In `src/lib/handlers/payloads.ts:34`, change:

```typescript
// Before:
load_more_history: { sessionId?: string; offset: number };

// After:
load_more_history: { sessionId?: string; before?: string };
```

### Step 6: Update handleLoadMoreHistory handler

In `src/lib/handlers/session.ts:312-329`, replace:

```typescript
export async function handleLoadMoreHistory(
  deps: HandlerDeps,
  clientId: string,
  payload: PayloadMap["load_more_history"],
): Promise<void> {
  const sid = payload.sessionId ?? resolveSession(deps, clientId) ?? "";
  if (sid) {
    const page = await deps.sessionMgr.loadHistory(sid, payload.before);
    deps.wsHandler.sendTo(clientId, {
      type: "history_page",
      sessionId: sid,
      messages: page.messages,
      hasMore: page.hasMore,
    });
  }
}
```

### Step 7: Update client-init.ts REST fallback (third call site)

In `src/lib/bridges/client-init.ts:111`, the call is already `loadHistory(activeId)` with no offset, so the signature change (removing offset, adding optional `beforeCursor`) is backwards-compatible. **No code change needed** — but verify the `history.total` usage at line 118:

```typescript
// Line 118 currently:
...(history.total != null && { total: history.total }),
```

This is safe with `exactOptionalPropertyTypes` because `history.total` is typed as `total?: number` and the `!= null` guard handles both `undefined` and missing. **No change needed.**

### Step 8: Update HistoryView frontend

In `src/lib/frontend/components/features/HistoryView.svelte:79-91`, replace `loadMore()`:

```typescript
function loadMore() {
  if (!sessionState.currentId || loading) return;
  loading = true;

  // Cursor-based: send the ID of the oldest message we have
  const oldestId = historyMessages.length > 0
    ? historyMessages[0]?.id
    : undefined;
  wsSend({
    type: "load_more_history",
    sessionId: sessionState.currentId,
    ...(oldestId != null && { before: oldestId }),
  });
}
```

> **Note on `wsSend` typing:** The frontend `wsSend` is typed as `(msg: Record<string, unknown>) => void` — it does NOT use `PayloadMap`. So changing `PayloadMap` won't cause a frontend compile error but also won't catch type mismatches. This is a pre-existing limitation, not introduced by this change.

### Step 9: Update ALL test files

**Complete list of test files needing updates for S1:**

1. **`test/helpers/mock-factories.ts:106`** — Remove `total: 0`:
   ```typescript
   // Before:
   loadHistory: vi.fn().mockResolvedValue({
     messages: [],
     hasMore: false,
     total: 0,
   }),
   // After:
   loadHistory: vi.fn().mockResolvedValue({
     messages: [],
     hasMore: false,
   }),
   ```

2. **`test/unit/session/session-manager.pbt.test.ts`** — Replace offset-based tests with cursor-based:
   - Lines 530-531, 552-553, 562-563, 571-572, 605-606: Change `loadHistory(id, offset)` calls to `loadHistory(id, beforeCursor)` and update assertions

3. **`test/unit/handlers/message-handlers.test.ts:904-917`** — Update `loadHistory` assertions:
   ```typescript
   // Before:
   expect(deps.sessionMgr.loadHistory).toHaveBeenCalledWith("s2", 10);
   // After:
   expect(deps.sessionMgr.loadHistory).toHaveBeenCalledWith("s2", "msg-id");
   ```

4. **`test/unit/handlers/handlers-session.test.ts:230,447`** — Update mock shapes (remove `total`)

5. **`test/unit/handlers/regression-question-on-session-view.test.ts:69,225`** — Update mock shapes

6. **`test/unit/bridges/client-init.test.ts:44,50,121,145,794`** — Update mock shapes and assertions

7. **`test/unit/regression-question-session-scoping.test.ts:81`** — Update mock shape

8. **`test/unit/stores/regression-session-switch-history.test.ts`** — Update `history_page` payload shapes (remove `total`)

9. **`test/unit/server/m4-backend.test.ts:147,152`** — Verify `getMessagesPage` assertions still pass (likely no change needed)

10. **`test/e2e/helpers/ws-mock.ts:96-100`** — Update `load_more_history` handling to read `before` instead of `offset`

11. **`test/e2e/specs/subagent-sessions.spec.ts:315-318`** — Same

### Step 10: Run all tests

Run: `pnpm vitest run test/unit/session/ && pnpm vitest run test/unit/handlers/ && pnpm vitest run test/unit/bridges/ && pnpm vitest run test/unit/stores/ && pnpm check`
Expected: PASS

### Step 11: Commit

```bash
git add src/lib/session/session-manager.ts src/lib/handlers/session.ts \
  src/lib/handlers/payloads.ts \
  src/lib/bridges/client-init.ts \
  src/lib/frontend/components/features/HistoryView.svelte \
  test/unit/session/session-manager-pagination.test.ts \
  test/unit/session/session-manager.pbt.test.ts \
  test/helpers/mock-factories.ts \
  test/unit/handlers/handlers-session.test.ts \
  test/unit/handlers/regression-question-on-session-view.test.ts \
  test/unit/handlers/message-handlers.test.ts \
  test/unit/bridges/client-init.test.ts \
  test/unit/regression-question-session-scoping.test.ts \
  test/unit/stores/regression-session-switch-history.test.ts \
  test/e2e/helpers/ws-mock.ts \
  test/e2e/specs/subagent-sessions.spec.ts
git commit -m "perf(S1): use paginated getMessagesPage() in loadHistory with runtime fallback

Replace getMessages() (fetches ALL messages) with getMessagesPage()
(server-side pagination) in loadHistory(). For a 500-message session,
this reduces data transfer by ~90%.

Switch from offset-based to cursor-based pagination (before param).
Add runtime fallback: if getMessagesPage fails (API doesn't support
pagination), gracefully falls back to getMessages + client-side slice."
```

---

## Task 2: S2 — Fire-and-forget metadata in `handleViewSession`

**Estimated latency reduction:** 20-100ms (unblocks per-client queue)

The `Promise.allSettled` block at the end of `handleViewSession` (lines 92-191) awaits model info, permissions, questions, and session list fetches. These block the `ClientMessageQueue` from processing the next message.

**v3 approach (simpler than v2):** Extract the metadata block into a module-level async function `sendSessionMetadata()`. `handleViewSession` calls it fire-and-forget (without `await`). `handleDeleteSession` calls it directly with `await`. Both handlers keep their `Promise<void>` return type — **no return type change, no dispatch table breakage**.

**Why not the v2 `{ metadataSettled }` approach:** The `MessageHandler` type at `types.ts:83-87` returns `Promise<void>`. Changing `handleViewSession` to return `Promise<{ metadataSettled: Promise<void> }>` would break the `as MessageHandler` cast at `index.ts:155` — it's not assignable to `Promise<void>`. The v2 plan noted this approach but didn't address the type incompatibility. Additionally, `handleSwitchSession` (line 232-238) does `return handleViewSession(...)` — it inherits the return type, so both would need changing. The simpler fire-and-forget pattern avoids all of this.

**Files:**
- Modify: `src/lib/handlers/session.ts:67-191,240-270`
- Update: `test/unit/handlers/handlers-session.test.ts`
- Update: `test/unit/handlers/regression-question-on-session-view.test.ts`
- Update: `test/unit/regression-question-session-scoping.test.ts`
- Update: `test/unit/handlers/message-handlers.test.ts` (if it asserts metadata delivery timing)

### Step 1: Write the failing test

Add to `test/unit/handlers/handlers-session.test.ts`:

```typescript
it("handleViewSession should resolve before metadata fetches complete", async () => {
  // Create a deferred promise for getSession to control timing
  let resolveGetSession!: () => void;
  const getSessionPromise = new Promise<void>((r) => {
    resolveGetSession = r;
  });
  deps.client.getSession = vi.fn().mockReturnValue(
    getSessionPromise.then(() => ({ modelID: "test-model" })),
  );

  const handlerPromise = handleViewSession(deps, "client-1", {
    sessionId: "session-1",
  });

  // Handler should resolve quickly (before metadata)
  const result = await Promise.race([
    handlerPromise.then(() => "resolved" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
  ]);

  expect(result).toBe("resolved");

  // Clean up — resolve the deferred promise
  resolveGetSession();
  // Flush: let fire-and-forget promises settle
  await new Promise((r) => setTimeout(r, 10));
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: FAIL — handler currently awaits `Promise.allSettled`

### Step 3: Implement the change

In `src/lib/handlers/session.ts`:

**3a.** Extract `sendSessionMetadata` as a module-level function (NOT exported — internal to session handlers):

```typescript
/**
 * Send metadata (model info, permissions, questions, session list) to a client.
 * Independent of session_switched delivery — these are supplementary data.
 *
 * Returns a Promise that resolves when ALL metadata has been sent.
 * - handleViewSession calls this fire-and-forget (no await).
 * - handleDeleteSession awaits it to ensure full delivery before continuing.
 *
 * All errors are caught and logged internally — callers don't need .catch().
 */
async function sendSessionMetadata(
  deps: HandlerDeps,
  clientId: string,
  id: string,
): Promise<void> {
  await Promise.allSettled([
    // Model info
    (async () => {
      const session = await deps.client.getSession(id);
      if (session.modelID) {
        deps.wsHandler.sendTo(clientId, {
          type: "model_info",
          model: session.modelID,
          provider: session.providerID ?? "",
        });
      }
    })().catch((err) =>
      deps.log.warn(
        `Failed to get model info for ${id}: ${err instanceof Error ? err.message : err}`,
      ),
    ),

    // Pending permissions (bridge + API)
    // ... (move unchanged from current handleViewSession lines 110-155)

    // Pending questions
    // ... (move unchanged from current handleViewSession lines 157-178)

    // Session list
    deps.sessionMgr
      .sendDualSessionLists((msg) => deps.wsHandler.sendTo(clientId, msg))
      .catch((err) =>
        deps.log.warn(
          `Failed to send session list to ${clientId}: ${err instanceof Error ? err.message : err}`,
        ),
      ),
  ]);
}
```

**3b.** In `handleViewSession`, replace the `await Promise.allSettled(...)` block (lines 92-191) with:

```typescript
// Fire-and-forget: metadata is not on the critical path for session switching.
// sendTo is safe after disconnect (silently drops messages).
// All errors are caught and logged inside sendSessionMetadata.
// NOTE: This is intentionally NOT awaited — the handler returns immediately
// after sending session_switched, unblocking the ClientMessageQueue.
sendSessionMetadata(deps, clientId, id).catch(() => {
  // Errors already logged inside sendSessionMetadata.
  // This .catch() prevents unhandled promise rejection.
});

deps.log.info(`client=${clientId} Viewing: ${id}`);
```

**3c.** In `handleDeleteSession` (lines 240-270), after the viewer loop, await metadata explicitly:

```typescript
// Switch ALL viewers to the next session (not just the requester)
if (sessions.length > 0) {
  for (const viewerClientId of viewers) {
    await handleViewSession(deps, viewerClientId, {
      // biome-ignore lint/style/noNonNullAssertion: safe — guarded by sessions.length > 0
      sessionId: sessions[0]!.id,
    });
    // handleViewSession fires metadata without await.
    // But deleteSession needs full metadata delivery before broadcasting
    // the updated session list, so await metadata explicitly.
    await sendSessionMetadata(deps, viewerClientId, sessions[0]!.id);
  }
}
```

> **Note:** This means metadata is sent twice for the delete path — once fire-and-forget from `handleViewSession`, once awaited here. This is redundant but harmless: all `sendTo` messages are idempotent (the client just gets duplicate data). The alternative (a `skipMetadata` flag) adds more complexity than the duplication.

**3d.** `handleSwitchSession` (line 232-238) needs **no change** — it just does `return handleViewSession(...)` which still returns `Promise<void>`.

### Step 4: Update tests

Tests that assert metadata delivery timing need to allow time for fire-and-forget to settle:

```typescript
// In tests that check metadata was sent:
await handleViewSession(deps, "client-1", { sessionId: "s1" });
// Add a microtask flush to let fire-and-forget resolve
await new Promise((r) => setTimeout(r, 0));
// Now assert metadata delivery
expect(sendToCalls).toContainEqual(expect.objectContaining({ type: "model_info" }));
```

**Files needing this pattern:**
1. `test/unit/handlers/regression-question-on-session-view.test.ts` — 9 tests asserting question/permission delivery
2. `test/unit/handlers/handlers-session.test.ts` — tests asserting metadata delivery
3. `test/unit/regression-question-session-scoping.test.ts` — 2 tests asserting question delivery
4. `test/unit/handlers/message-handlers.test.ts` — if any tests check metadata timing

### Step 5: Run all tests

Run: `pnpm vitest run test/unit/handlers/ && pnpm vitest run test/unit/regression* && pnpm check`
Expected: PASS

### Step 6: Commit

```bash
git add src/lib/handlers/session.ts \
  test/unit/handlers/handlers-session.test.ts \
  test/unit/handlers/regression-question-on-session-view.test.ts \
  test/unit/regression-question-session-scoping.test.ts \
  test/unit/handlers/message-handlers.test.ts
git commit -m "perf(S2): fire-and-forget metadata in handleViewSession

Extract metadata fetches (model, permissions, questions, sessions) into
sendSessionMetadata(). handleViewSession calls it fire-and-forget,
returning Promise<void> immediately after session_switched is sent.
handleDeleteSession awaits sendSessionMetadata directly to ensure full
delivery. No MessageHandler type change needed — both handlers still
return Promise<void>."
```

---

## Task 3: S5 — Enable WebSocket per-message deflate

**Estimated latency reduction:** Network-dependent (30-60% bandwidth reduction for JSON payloads)

**Files:**
- Modify: `src/lib/server/ws-handler.ts:120-123`

### Step 1: Implement the change

In `src/lib/server/ws-handler.ts:120-123`, add `perMessageDeflate`:

```typescript
this.wss = new WebSocketServerClass({
  ...wssOptions,
  maxPayload: options.maxPayload ?? 1024 * 1024, // 1MB default
  perMessageDeflate: {
    // Compress everything — the threshold option only works with
    // serverNoContextTakeover which destroys the inter-message
    // dictionary, reducing compression ratio for repeated JSON
    // structures. Better to compress all messages with context
    // carryover than to skip small ones with no carryover.
    //
    // Cap server window bits to reduce per-connection memory:
    //   Default (15): ~64KB per connection for zlib state
    //   With 10:      ~6-7KB per connection
    // JSON control messages compress nearly as well with smaller windows.
    serverMaxWindowBits: 10,
    // NOTE: clientMaxWindowBits is NOT set. Setting it to a specific
    // value can reject clients that don't include client_max_window_bits
    // in their extension negotiation offer. Omitting it lets the ws
    // library negotiate with whatever the client supports.
    zlibDeflateOptions: {
      level: 1, // Z_BEST_SPEED — minimal CPU overhead
    },
  },
});
```

Key changes from v2:
- **Removed `clientMaxWindowBits: 10`** — setting this can reject clients that don't send `client_max_window_bits` in their extension offer (v2 audit MEDIUM)
- **Updated memory estimate** — ~6-7KB per connection, not ~4KB (v2 audit LOW)

### Step 2: Run existing tests

Run: `pnpm vitest run test/unit/server/ && pnpm check`
Expected: PASS (perMessageDeflate is transparent to message handling; ws test clients negotiate it automatically)

### Step 3: Commit

```bash
git add src/lib/server/ws-handler.ts
git commit -m "perf(S5): enable WebSocket per-message deflate

Add perMessageDeflate with level 1 compression and capped server window
bits (10 instead of default 15) to reduce per-connection memory from
~64KB to ~6-7KB. clientMaxWindowBits left unset to avoid rejecting
clients that don't advertise the extension parameter. JSON payloads
compress 30-60%, especially session replay events."
```

---

## Task 4: C1 — Defer hljs/mermaid/headers during replay

**Estimated latency reduction:** 50-300ms during session switch (proportional to code block count)

**v3 approach:** Guard the entire `postRender()` function (not just `highlightCodeBlocks`). The v2 audit found that `addCodeBlockHeaders` and `renderMermaidBlocks` also run wastefully during replay — mermaid is equally expensive as hljs. Co-locate the guard in the `$effect` body for clarity.

Additionally, when replay ends, ~200 AssistantMessage effects re-fire simultaneously. To avoid a CPU jank spike from all hljs calls landing on one frame, batch them via `requestIdleCallback`.

**Files:**
- Modify: `src/lib/frontend/components/chat/AssistantMessage.svelte:107-130`
- Test: Visual verification

### Step 1: Add `chatState` import

Check if `chatState` is imported in `AssistantMessage.svelte`. Currently it is NOT imported (confirmed by reading the file). Add at the top of the `<script>` block:

```typescript
import { chatState } from "../../stores/chat.svelte.js";
```

### Step 2: Modify the `$effect` to co-locate the replaying guard

Replace the existing `$effect` at lines 125-130:

```typescript
// Before:
$effect(() => {
  // Touch message.html to track dependency
  if (message.html) {
    postRender();
  }
});

// After:
$effect(() => {
  // Track both html content and replaying flag.
  // During replay: skip all post-render work (hljs, code headers, mermaid)
  //   — these are wasted CPU for off-screen blocks rendered during event replay.
  // When replay ends: replaying becomes false, effect re-fires, postRender runs.
  // Only ~15-20 visible AssistantMessages will actually run postRender,
  // because Svelte only renders messages in the DOM.
  const _html = message.html;
  const replaying = chatState.replaying;
  if (_html && !replaying) {
    // Use requestIdleCallback to avoid a jank spike when replay ends
    // and all AssistantMessage effects re-fire on the same frame.
    // During normal streaming (not post-replay), requestIdleCallback
    // fires almost immediately since the main thread is idle between
    // each streamed message.
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => postRender());
    } else {
      // Fallback for environments without requestIdleCallback (SSR, old browsers)
      postRender();
    }
  }
});
```

> **Why requestIdleCallback instead of requestAnimationFrame?** rAF fires before the next paint — if 20 messages all schedule rAF, they ALL run before the next paint, causing the same jank spike. rIC yields to the browser between each callback, spreading the work across idle periods. During normal streaming, rIC fires within ~1ms because the main thread is idle.

> **HistoryView note:** HistoryView also renders AssistantMessage instances. During replay of history-path messages, these instances also skip hljs — this is harmless but intentional. When replay ends, their effects re-fire and hljs runs on visible blocks.

### Step 3: No changes needed to `postRender`, `highlightCodeBlocks`, `addCodeBlockHeaders`, or `renderMermaidBlocks`

The guard is in the `$effect` body, not inside the individual functions. This is cleaner than adding guards to 3 separate functions and means:
- The functions remain pure (no dependency on global state)
- Future callers of these functions outside the effect don't silently get the guard
- The guard is visible at the call site

### Step 4: Run type check

Run: `pnpm check`
Expected: PASS

### Step 5: Visual verification

1. Open a session with code blocks and mermaid diagrams
2. Switch to another session with code blocks — code should still get highlighted after switch
3. During the switch, note that the initial render is faster (no hljs on off-screen blocks)
4. Scroll up to older messages — code blocks rendered during replay should be highlighted (the effect re-fired when replay ended)

### Step 6: Commit

```bash
git add src/lib/frontend/components/chat/AssistantMessage.svelte
git commit -m "perf(C1): skip hljs/mermaid/headers during event replay

Add chatState.replaying guard in the postRender $effect — during event
replay, all post-render work (hljs, code block headers, mermaid) is
skipped. When replay ends, the effect re-fires for visible messages.
Use requestIdleCallback to spread post-replay highlighting across idle
frames, avoiding a CPU jank spike from ~200 effects firing at once."
```

---

## Task 5: C3 — Pre-render markdown on the server

**Estimated latency reduction:** 20-100ms (moves CPU work from client to server)

**v3 approach:** Use `jsdom` (already installed as devDep, promote to production dep) + `dompurify` factory pattern instead of `isomorphic-dompurify`. This avoids the Node version incompatibility (`isomorphic-dompurify` requires Node `^20.19.0 || ^22.12.0 || >=24`, but the project supports `>=18.0.0`). Verified working: `import createDOMPurify from 'dompurify'; import { JSDOM } from 'jsdom'; const purify = createDOMPurify(new JSDOM('').window);` produces correct sanitized HTML.

Centralize the rendering into a single helper function used by all 3 call sites (handleViewSession, handleLoadMoreHistory, client-init.ts) instead of inlining the loop in each.

**Files:**
- Create: `src/lib/relay/markdown-renderer.ts`
- Modify: `src/lib/handlers/session.ts` (render markdown before sending history)
- Modify: `src/lib/bridges/client-init.ts:108-121` (render markdown in REST fallback)
- Modify: `src/lib/shared-types.ts:185-202` (add `renderedHtml` to `HistoryMessagePart`)
- Modify: `src/lib/frontend/utils/history-logic.ts:170-173` (use pre-rendered HTML)
- Modify: `package.json` (promote jsdom from devDep to dep)
- Create: `test/unit/relay/markdown-renderer.test.ts`

### Step 1: Write the failing test

Create `test/unit/relay/markdown-renderer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  renderMarkdownServer,
  preRenderHistoryMessages,
} from "../../../src/lib/relay/markdown-renderer.js";

describe("Server-side markdown rendering", () => {
  it("should render basic markdown to HTML", () => {
    const result = renderMarkdownServer("**bold** text");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("text");
  });

  it("should sanitize dangerous HTML", () => {
    const result = renderMarkdownServer('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
  });

  it("should handle code blocks", () => {
    const result = renderMarkdownServer("```js\nconst x = 1;\n```");
    expect(result).toContain("<code");
    expect(result).toContain("const x = 1;");
  });

  it("should handle empty string", () => {
    const result = renderMarkdownServer("");
    expect(result).toBe("");
  });
});

describe("preRenderHistoryMessages", () => {
  it("should add renderedHtml to assistant text parts", () => {
    const messages = [
      {
        id: "m1",
        role: "user" as const,
        parts: [{ id: "p1", type: "text" as const, text: "hello" }],
      },
      {
        id: "m2",
        role: "assistant" as const,
        parts: [
          { id: "p2", type: "text" as const, text: "**bold**" },
          { id: "p3", type: "tool" as const, text: "ignored" },
        ],
      },
    ];

    preRenderHistoryMessages(messages);

    // User message parts: no renderedHtml
    expect((messages[0]!.parts![0]! as any).renderedHtml).toBeUndefined();
    // Assistant text part: has renderedHtml
    expect(messages[1]!.parts![0]!.renderedHtml).toContain("<strong>bold</strong>");
    // Assistant tool part: no renderedHtml
    expect((messages[1]!.parts![1]! as any).renderedHtml).toBeUndefined();
  });

  it("should skip parts with no text", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant" as const,
        parts: [{ id: "p1", type: "text" as const }],
      },
    ];

    preRenderHistoryMessages(messages);
    expect((messages[0]!.parts![0]! as any).renderedHtml).toBeUndefined();
  });
});
```

### Step 2: Run to verify it fails

Run: `pnpm vitest run test/unit/relay/markdown-renderer.test.ts`
Expected: FAIL — module doesn't exist

### Step 3: Promote jsdom to production dependency

```bash
pnpm remove jsdom && pnpm add jsdom && pnpm add -D @types/jsdom
```

Wait — check if `@types/jsdom` exists or if types are bundled:

```bash
pnpm list @types/jsdom 2>/dev/null
```

Actually, `jsdom@28` bundles its own types. The project already has it as devDep. To promote:

```bash
# Remove from devDeps and add to deps
pnpm add jsdom@^28.1.0
```

> **Size impact:** jsdom is ~4.6MB on disk but is already installed (just moving from devDep to dep). No new dependencies pulled.

### Step 4: Create server-side markdown renderer

Create `src/lib/relay/markdown-renderer.ts`:

```typescript
// ─── Server-Side Markdown Rendering ──────────────────────────────────────────
// Renders markdown to sanitized HTML on the server so clients don't have to.
// Uses the same marked config as the frontend for visual parity.
// Does NOT run hljs (CPU-intensive) — that's handled lazily on the client.
//
// Uses jsdom + dompurify factory pattern because:
// - isomorphic-dompurify requires Node ^20.19.0 — project supports >=18.0.0
// - dompurify's default export crashes in Node without a window object
// - The factory pattern (createDOMPurify(window)) works with dompurify 3.3.1

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { Marked } from "marked";

import type { HistoryMessage } from "../shared-types.js";

// Create a single JSDOM window for DOMPurify — reused across all calls.
// This is safe because DOMPurify is synchronous and single-threaded in Node.
const jsdomWindow = new JSDOM("").window;
const purify = createDOMPurify(jsdomWindow);

// Use a dedicated Marked instance (not the global singleton) to avoid
// shared-state conflicts if other server-side code imports marked.
// Config mirrors the frontend's marked.use({ gfm: true, breaks: false }).
const serverMarked = new Marked({ gfm: true, breaks: false });

/**
 * Render markdown text to sanitized HTML.
 * Server-side equivalent of the frontend's renderMarkdown().
 *
 * @param text Raw markdown text
 * @returns Sanitized HTML string, or empty string for falsy input
 */
export function renderMarkdownServer(text: string): string {
  if (!text) return "";
  // { async: false } ensures synchronous return (Marked.parse returns
  // string | Promise<string> — without this flag, TypeScript can't
  // narrow the return type to string).
  const html = serverMarked.parse(text, { async: false }) as string;
  return purify.sanitize(html);
}

/**
 * Pre-render markdown for all assistant text parts in a message array.
 * Mutates the messages in-place (adds `renderedHtml` to text parts).
 *
 * Used by all 3 history-sending call sites:
 * - handleViewSession (REST fallback path)
 * - handleLoadMoreHistory
 * - client-init.ts (initial connection REST fallback)
 */
export function preRenderHistoryMessages(messages: HistoryMessage[]): void {
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.parts) {
      for (const part of msg.parts) {
        if (part.type === "text" && part.text) {
          part.renderedHtml = renderMarkdownServer(part.text);
        }
      }
    }
  }
}
```

### Step 5: Add `renderedHtml` to HistoryMessagePart type

In `src/lib/shared-types.ts:185-202`, add the field:

```typescript
export interface HistoryMessagePart {
  id: string;
  type: PartType;
  text?: string;
  /** Server-pre-rendered HTML for text parts. When present, the frontend
   *  can skip client-side markdown rendering. */
  renderedHtml?: string;
  state?: {
    status?: ToolStatus;
    input?: unknown;
    output?: string;
    error?: string;
    [key: string]: unknown;
  };
  callID?: string;
  tool?: string;
  time?: unknown;
  [key: string]: unknown;
}
```

### Step 6: Wire into handleViewSession (REST fallback path)

In `src/lib/handlers/session.ts`, import the renderer:

```typescript
import { preRenderHistoryMessages } from "../relay/markdown-renderer.js";
```

In the REST fallback branch (lines 41-53), after `loadHistory` and before `sendTo`:

```typescript
try {
  const draft = getSessionInputDraft(id);
  const history = await deps.sessionMgr.loadHistory(id);
  preRenderHistoryMessages(history.messages);
  deps.wsHandler.sendTo(clientId, {
    type: "session_switched",
    id,
    history: {
      messages: history.messages,
      hasMore: history.hasMore,
      ...(history.total != null && { total: history.total }),
    },
    ...(draft && { inputText: draft }),
  });
} catch (err) {
  // ... unchanged
}
```

### Step 7: Wire into handleLoadMoreHistory

In `handleLoadMoreHistory`, after loading the page:

```typescript
export async function handleLoadMoreHistory(
  deps: HandlerDeps,
  clientId: string,
  payload: PayloadMap["load_more_history"],
): Promise<void> {
  const sid = payload.sessionId ?? resolveSession(deps, clientId) ?? "";
  if (sid) {
    const page = await deps.sessionMgr.loadHistory(sid, payload.before);
    preRenderHistoryMessages(page.messages);
    deps.wsHandler.sendTo(clientId, {
      type: "history_page",
      sessionId: sid,
      messages: page.messages,
      hasMore: page.hasMore,
    });
  }
}
```

### Step 8: Wire into client-init.ts (third call site)

In `src/lib/bridges/client-init.ts`, import the renderer:

```typescript
import { preRenderHistoryMessages } from "../relay/markdown-renderer.js";
```

In the REST fallback branch (lines 108-121), after `loadHistory`:

```typescript
} else {
  // Cache miss (session from before relay started): REST API fallback
  try {
    const history = await sessionMgr.loadHistory(activeId);
    preRenderHistoryMessages(history.messages);
    wsHandler.sendTo(clientId, {
      type: "session_switched",
      id: activeId,
      history: {
        messages: history.messages,
        hasMore: history.hasMore,
        ...(history.total != null && { total: history.total }),
      },
      ...(draft && { inputText: draft }),
    });
  } catch {
    // ... unchanged
  }
}
```

### Step 9: Update frontend to use pre-rendered HTML

In `src/lib/frontend/utils/history-logic.ts:170-173`, modify `convertAssistantParts` to prefer `renderedHtml`:

```typescript
case "text": {
  const rawText = part.text ?? "";
  if (!rawText) break;
  // Prefer server-pre-rendered HTML; fall back to client-side rendering
  const html = part.renderedHtml ?? (renderHtml ? renderHtml(rawText) : rawText);
  result.push({
    type: "assistant",
    uuid: generateUuid(),
    rawText,
    html,
    finalized: true,
  } satisfies AssistantMessage);
  break;
}
```

`part.renderedHtml` is typed on `HistoryMessagePart` (step 5) so no cast needed.

### Step 10: Run tests

Run: `pnpm vitest run test/unit/relay/markdown-renderer.test.ts && pnpm vitest run test/unit/handlers/ && pnpm vitest run test/unit/bridges/ && pnpm check`
Expected: PASS

### Step 11: Commit

```bash
git add src/lib/relay/markdown-renderer.ts src/lib/shared-types.ts \
  src/lib/handlers/session.ts src/lib/bridges/client-init.ts \
  src/lib/frontend/utils/history-logic.ts \
  test/unit/relay/markdown-renderer.test.ts package.json pnpm-lock.yaml
git commit -m "perf(C3): pre-render markdown on the server for history messages

Add server-side markdown rendering using jsdom + dompurify factory
pattern (compatible with Node >=18, unlike isomorphic-dompurify which
requires >=20.19). Centralize pre-rendering into preRenderHistoryMessages()
called by all 3 history-sending paths: handleViewSession, handleLoadMoreHistory,
and client-init. Frontend uses renderedHtml when available, falling back
to client-side rendering for cache-path (SSE) messages."
```

---

## Task 6: C4-css — CSS `content-visibility: auto` for message containers

**Estimated latency reduction:** Significant rendering savings for long message lists, with ~10% of the complexity of full JS virtualization.

**v3 approach:** Instead of adding an extra wrapper `<div class="msg-container">` around every message (which the v2 audit found creates duplicate `data-uuid`, clips rewind outlines, and adds unnecessary nesting), add the `msg-container` class to the existing wrappers:
- For user/assistant messages in MessageList: add `msg-container` to the existing `rewind-point` wrapper divs
- For other message types in MessageList: add a minimal wrapper (these don't have rewind-point divs)
- For HistoryView: add a wrapper (HistoryView doesn't have rewind-point wrappers)

Also add a `requestAnimationFrame` re-scroll after initial session load to handle `scrollHeight` inaccuracy from the 100px placeholder estimate.

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte:147-169`
- Modify: `src/lib/frontend/components/features/HistoryView.svelte:171-187`
- Modify: `src/lib/frontend/style.css`
- Test: Visual verification

### Step 1: Add CSS class

In `src/lib/frontend/style.css`, add after the rewind styles (after line 712):

```css
/* ─── Content Visibility Optimization ──────────────────────────────────────── */
/* Tells the browser to skip rendering (layout, paint, style) for off-screen
   message containers. The browser maintains scroll height via the intrinsic
   size estimate. Unlike JS virtualization, elements remain in the DOM so
   rewind mode, auto-scroll, and accessibility all work unchanged.
   
   The `auto` keyword in contain-intrinsic-size tells the browser: "use 100px
   as the initial estimate, but once you've rendered this element, remember its
   actual size." This avoids layout shift after first render.
   
   Browser support: Chrome 85+, Edge 85+, Firefox 125+, Safari 18+.
   Older browsers ignore these properties (progressive enhancement). */
.msg-container {
  content-visibility: auto;
  contain-intrinsic-size: auto 100px;
}
```

### Step 2: Apply to MessageList message wrappers

In `MessageList.svelte:147-169`, modify the existing template to add `msg-container` to existing wrappers where possible:

```svelte
{#each groupedMessages as msg, i (msg.uuid)}
  {#if msg.type === "user"}
    <div class="msg-container" class:rewind-point={uiState.rewindActive}>
      <UserMessage message={msg as UserMsg} />
    </div>
  {:else if msg.type === "assistant"}
    <div class="msg-container" class:rewind-point={uiState.rewindActive}>
      <AssistantMessage message={msg as AssistantMsg} />
    </div>
  {:else if msg.type === "thinking"}
    <div class="msg-container">
      <ThinkingBlock message={msg as ThinkingMessage} />
    </div>
  {:else if msg.type === "tool-group"}
    <div class="msg-container">
      <ToolGroupCard group={msg as ToolGroup} />
    </div>
  {:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
    <div class="msg-container">
      <SkillItem message={msg as ToolMessage} />
    </div>
  {:else if msg.type === "tool"}
    <div class="msg-container">
      <ToolItem message={msg as ToolMessage} />
    </div>
  {:else if msg.type === "result"}
    <div class="msg-container">
      <ResultBar message={msg as ResultMessage} />
    </div>
  {:else if msg.type === "system"}
    <div class="msg-container">
      <SystemMessage message={msg as SystemMsg} />
    </div>
  {/if}
{/each}
```

> **Note on `data-uuid`:** The `data-uuid` attribute stays on `UserMessage.svelte:15` and `AssistantMessage.svelte:336` (the inner components). The `.msg-container` wrapper does NOT get `data-uuid`. Rewind click delegation uses `target.closest("[data-uuid]")` which traverses INTO the wrapper to find the component's root element — this works correctly because `closest()` traverses upward from the click target, and the click target is inside the component.

> **Note on rewind outline clipping:** The `rewind-point` class uses `outline` (not `border`), and outlines are painted OUTSIDE the element's box. CSS `content-visibility: auto` applies `contain: layout style paint` which clips overflow. However, `outline` is explicitly NOT affected by `overflow: hidden` or `contain: paint` in the CSS spec — outlines always paint outside the containing block. So the rewind outline is NOT clipped by the `.msg-container`'s containment. **No issue.**

### Step 3: Apply to HistoryView

In `HistoryView.svelte:171-187`:

```svelte
{#each groupedMessages as msg, i (msg.uuid)}
  <div class="msg-container">
    {#if msg.type === "user"}
      <UserMessage message={msg as UserMsg} />
    {:else if msg.type === "assistant"}
      <AssistantMessage message={msg as AssistantMsg} />
    {:else if msg.type === "thinking"}
      <ThinkingBlock message={msg as ThinkingMessage} />
    {:else if msg.type === "tool-group"}
      <ToolGroupCard group={msg as ToolGroup} />
    {:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
      <SkillItem message={msg as ToolMessage} />
    {:else if msg.type === "tool"}
      <ToolItem message={msg as ToolMessage} />
    {:else if msg.type === "result"}
      <ResultBar message={msg as ResultMessage} />
    {/if}
  </div>
{/each}
```

### Step 4: Add RAF re-scroll for initial session load

The 100px placeholder estimate means `scrollHeight` is wrong during the initial render of a long message list. Auto-scroll (which scrolls to the bottom on session switch) may undershoot because the actual heights haven't been computed yet.

In `MessageList.svelte`, find the auto-scroll logic and add a one-shot RAF correction after session switch. This should be in the existing scroll-to-bottom effect:

```typescript
// After the existing scrollToBottom() call:
// content-visibility: auto means scrollHeight may be underestimated
// on first render (100px placeholders vs actual heights). Schedule a
// correction after the browser has computed actual heights.
requestAnimationFrame(() => {
  if (!getUserScrolledUp()) {
    scrollToBottom();
  }
});
```

This is a minimal change — just one extra scroll after the browser paints the first frame with actual sizes.

### Step 5: Run type check

Run: `pnpm check`
Expected: PASS

### Step 6: Visual verification

Open the relay in a browser, load a session with many messages (100+), and verify:
1. Messages render correctly (no visible layout shift)
2. Scrolling is smooth
3. Rewind mode still works (outline visible, click detection works through wrapper)
4. Auto-scroll works during streaming — bottom stays pinned
5. Session switch scrolls to bottom correctly (not undershooting)
6. Permission/question cards still appear at the bottom
7. In Chrome DevTools Elements panel: `.msg-container` elements show `content-visibility: auto` in Computed styles

### Step 7: Commit

```bash
git add src/lib/frontend/components/chat/MessageList.svelte \
  src/lib/frontend/components/features/HistoryView.svelte \
  src/lib/frontend/style.css
git commit -m "perf(C4-css): add content-visibility:auto to message containers

Wrap each message in a div with content-visibility:auto. The browser
skips layout/paint/style for off-screen messages while keeping them in
the DOM. Unlike JS virtualization, this preserves auto-scroll, rewind
mode, and accessibility. contain-intrinsic-size:auto 100px provides a
size estimate that auto-updates after first render. Add RAF re-scroll
to correct scrollHeight inaccuracy from placeholder estimates."
```

---

## Execution Order & Dependencies

```
Pre-req: Verify OpenCode pagination API
  └─→ S1 (paginated API)     ─┐
                               ├── Server-side (S1 gates on pre-req)
S2 (fire-and-forget meta)    ─┤
S5 (WS deflate)              ─┘

C1 (skip hljs during replay)  ─┐
C3 (server markdown)          ─┤── Client-side (independent)
C4-css (content-visibility)   ─┘
```

**Recommended execution order:**
1. **Pre-req** — verify pagination API (5 minutes, gates S1)
2. **S5** — smallest change, lowest risk (one config object)
3. **C1** — small, isolated change (1 file)
4. **C4-css** — small CSS + wrapper divs (3 files)
5. **S2** — moderate complexity (extract helper, update 4+ test files)
6. **C3** — moderate complexity (new module, type changes, 3 call sites, promote jsdom)
7. **S1** — largest change, most test updates (15+ files), gated on pre-req

All tasks are independent of each other (no task requires another to be done first), except S1 which requires the pre-req.

**Merge conflict note (v2 audit finding):** S1 and C3 both modify `handleViewSession` and `handleLoadMoreHistory` in `session.ts`. If implemented by parallel agents, they will conflict. Execute S1 before C3 (or vice versa) to avoid textual merge conflicts. S2 also modifies `session.ts` — execute it before or after S1/C3, not in parallel with either.

---

## Verification

After all tasks:

```bash
pnpm check          # TypeScript compilation
pnpm lint           # Linting
pnpm test:unit      # Unit tests (3170+ tests)
```

For integration verification, test session switching in the browser:
1. Open a session with many messages (100+)
2. Switch to another session and back — should feel faster
3. Check DevTools Performance tab during session switch — no long tasks from hljs
4. Inspect Network tab — WebSocket frames should show smaller (compressed) payloads
5. Verify rewind mode, permission cards, auto-scroll all work normally

---

## Audit History

### v1 → v2 (11 parallel subagents)

10 tasks audited, issues found in every task. Key outcomes:
- S4 DROPPED (49 test sites, complexity/benefit terrible)
- C4-orig REPLACED with C4-css (3 critical bugs in virtualization)
- C6 DROPPED (store-component boundary, no restore mechanism)
- A2 DROPPED (already implemented)
- A3 DROPPED (depends on C6, own race condition)

### v2 → v3 (7 parallel subagents)

6 tasks audited with specific severity ratings. Key changes:

| Task | v2 Audit Finding | v3 Resolution |
|------|-----------------|---------------|
| S1 | CRITICAL: No verification of message ordering. CRITICAL: No runtime fallback if API ignores pagination. HIGH: Only 3 of 15+ test files listed. HIGH: `client-init.ts` unlisted as call site. | Added ordering verification in pre-req. Added try/catch → `loadHistoryFallback()`. Listed all 15 test files. Added `client-init.ts` as explicit call site. |
| S2 | CRITICAL: `Promise<{ metadataSettled }>` not assignable to `Promise<void>` (MessageHandler type). CRITICAL: `handleSwitchSession` inherits incompatible return type. HIGH: Early `return` won't compile. HIGH: Unhandled promise rejection from fire-and-forget. | Abandoned return-type-change entirely. Extract `sendSessionMetadata()` as module-level function. `handleViewSession` calls fire-and-forget with `.catch()`. `handleDeleteSession` awaits directly. No type change needed. |
| S5 | MEDIUM: `clientMaxWindowBits: 10` can reject clients without extension offer. LOW: Memory estimate wrong (~6-7KB not ~4KB). | Removed `clientMaxWindowBits`. Fixed memory estimate in comments. |
| C1 | HIGH: Guard only in `highlightCodeBlocks` — `addCodeBlockHeaders` and `renderMermaidBlocks` also run wastefully. HIGH: ~200 fire-and-forget `postRender()` calls when replay ends create jank spike. MEDIUM: Missing `chatState` import. | Guard moved to `$effect` body (skips entire `postRender`). Added `requestIdleCallback` batching. Added `chatState` import. |
| C3 | CRITICAL: `isomorphic-dompurify` requires Node >=20.19. CRITICAL: `dompurify >= 3.3.3` required. HIGH: `client-init.ts` not covered. HIGH: `Marked.parse()` returns `string \| Promise<string>` without `{ async: false }`. HIGH: 3 call sites need rendering loop (duplication). | Use jsdom + dompurify factory pattern (verified working with 3.3.1 + Node 22). Added `{ async: false }`. Centralized into `preRenderHistoryMessages()` used by all 3 call sites. Promote jsdom from devDep to dep. |
| C4-css | HIGH: Duplicate `data-uuid` on wrapper + inner. HIGH: Rewind outline clipped by `contain: paint`. MEDIUM: Unnecessary extra nesting. MEDIUM: Auto-scroll undershoots on initial load. | `data-uuid` stays on inner components only (no duplication). Outlines are NOT clipped by contain:paint (CSS spec). Added `msg-container` class to existing rewind-point wrappers for user/assistant (minimal nesting). Added RAF re-scroll for initial load. |
| Cross-task | HIGH: S1 + C3 textual merge conflicts in session.ts. MEDIUM: C1 + C4-css — hljs runs on content-visibility-skipped elements. | Added merge conflict note in execution order. C1+C4-css interaction is benign: content-visibility-skipped elements don't paint hljs but the CPU work is already skipped by the C1 replaying guard. |
