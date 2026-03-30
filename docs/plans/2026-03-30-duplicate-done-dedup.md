# Duplicate Done Event Dedup Fix

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate duplicate `done` events delivered to the frontend when the status poller's synthetic done races ahead of the SSE-translated done.

**Architecture:** The existing one-directional dedup (`doneDeliveredByPrimary` Set) lets the SSE path suppress the poller path, but the poller's immediate re-poll (triggered by `notifySSEIdle`) can fire before the SSE done is translated and recorded. Fix by recording the done intent *before* the async poll starts, or by making `processAndApplyDone` bidirectional.

**Tech Stack:** TypeScript, Vitest

---

## Background

### The Done Delivery Paths

| # | Path | Trigger | File |
|---|---|---|---|
| 1 | SSE translator | `session.status:idle` SSE event | `sse-wiring.ts:384-394` |
| 2 | SSE idle hint | Same SSE event → `notifySSEIdle` → immediate `poll()` | `sse-wiring.ts:296-303` |
| 3 | Monitoring reducer | Status poller detects busy→idle → `notify-idle` effect → `processAndApplyDone` | `monitoring-reducer.ts` (5 transitions), `effect-executor.ts:38-39`, `monitoring-wiring.ts:140-161` |

### The Race Condition

In `handleSSEEvent` for a `session.status:idle` event, the execution order is:

1. **Line 296-301:** `notifySSEIdle(eventSessionId)` calls `void this.poll()` — the poll is async, starts but yields at `await getSessionStatuses`.
2. **Lines 310-394:** Translation happens. `translateSessionStatus` returns `{type:"done",code:0}`. Pipeline delivers to WebSocket. `onDoneProcessed(sessionId)` records in `doneDeliveredByPrimary`.
3. **Later (async):** The poll from step 1 completes. Monitoring reducer produces `notify-idle`. `processAndApplyDone` checks `doneDeliveredByPrimary` — session IS there — **dedup works**.

**But** the regular 500ms polling cycle can race:

1. Regular 500ms poll fires, gets statuses showing session is idle.
2. Monitoring reducer sees busy→idle, emits `notify-idle`.
3. `processAndApplyDone` — `doneDeliveredByPrimary` is **empty** (SSE hasn't arrived yet) — **duplicate fires**.
4. SSE event arrives moments later. Pipeline sends second done. `onDoneProcessed` records it. **Too late.**

### Observable Symptoms

Frontend debug logs show:
```
[handleDone] turnEpoch=249 phase=streaming   ← real done (from SSE or poller)
[handleDone] turnEpoch=250 phase=idle         ← duplicate (other path)
```

Each duplicate wastes a `turnEpoch` increment. Functionally harmless for shimmer (the comparison still works), but wasteful and confusing for debugging.

### Debug Logging to Confirm the Issue

Add to `src/lib/relay/monitoring-wiring.ts` in `processAndApplyDone` (line 140):

```typescript
processAndApplyDone: (sessionId, isSubagent) => {
    const hadPrimary = doneDeliveredByPrimary.has(sessionId);
    statusLog.info(
        `[processAndApplyDone] session=${sessionId.slice(0, 12)} hadPrimary=${hadPrimary} isSubagent=${isSubagent}`,
    );
    if (hadPrimary) {
        doneDeliveredByPrimary.delete(sessionId);
        statusLog.info(
            `Skipping synthetic done for ${sessionId.slice(0, 12)} — already delivered by primary path`,
        );
        return;
    }
    statusLog.info(
        `[processAndApplyDone] SENDING synthetic done for ${sessionId.slice(0, 12)} — no primary delivery recorded`,
    );
    // ... rest of function
```

Add to `src/lib/relay/sse-wiring.ts` near `onDoneProcessed` call (line 392):

```typescript
if (msg.type === "done" && targetSessionId) {
    log.info(`[SSE] Recording done delivery for ${targetSessionId.slice(0, 12)}`);
    deps.onDoneProcessed?.(targetSessionId);
}
```

Check `~/.opencode/daemon.log` after queuing a message. Look for:
- `[processAndApplyDone] SENDING synthetic done` followed by `[SSE] Recording done delivery` for the same session = duplicate confirmed.
- `[processAndApplyDone] hadPrimary=true` = dedup working.

---

### Task 1: Make dedup bidirectional — SSE records *before* translation

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts:291-394`

**Context:** Currently `onDoneProcessed` is called at line 392 — *after* the done message is translated and delivered to WebSocket clients. The `notifySSEIdle` call at line 300 triggers the async poller before the done is recorded. Fix by recording the done intent when the `session.status:idle` SSE event is first seen, before `notifySSEIdle` fires.

**Step 1: Write the failing test**

Create: `test/unit/relay/done-dedup.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";

describe("Done event dedup", () => {
    it("SSE idle hint records done before triggering poller", () => {
        // Track call order
        const calls: string[] = [];
        const mockOnDoneProcessed = vi.fn((sid: string) => {
            calls.push(`recordDone:${sid}`);
        });
        const mockNotifySSEIdle = vi.fn((sid: string) => {
            calls.push(`notifyIdle:${sid}`);
        });

        // Simulate: session.status:idle SSE event arrives.
        // onDoneProcessed MUST be called BEFORE notifySSEIdle.
        // (The actual test will use the real handleSSEEvent with mocked deps.)
        
        // Assert ordering: recordDone appears before notifyIdle
        // This prevents the poller from racing ahead of the dedup record.
    });
});
```

The test should use the actual `handleSSEEvent` function with mocked dependencies to verify `onDoneProcessed` is called before `notifySSEIdle` for `session.status:idle` events.

**Step 2: Move `onDoneProcessed` call to before `notifySSEIdle`**

In `sse-wiring.ts`, when a `session.status:idle` event is detected (around line 296), call `onDoneProcessed` *before* `notifySSEIdle`:

```typescript
if (event.type === "session.status") {
    const statusType = (
        event.properties?.["status"] as { type?: string } | undefined
    )?.type;
    if (statusType === "idle" && eventSessionId) {
        // Record done delivery BEFORE triggering the poller, so the
        // poller's processAndApplyDone can dedup against it.
        deps.onDoneProcessed?.(eventSessionId);
        
        if (deps.statusPoller) {
            deps.statusPoller.notifySSEIdle(eventSessionId);
        }
    }
}
```

Keep the existing `onDoneProcessed` call at line 392 (for non-SSE done events, like poller-delivered done), but guard it to avoid double-recording:

```typescript
if (msg.type === "done" && targetSessionId) {
    // May already have been recorded for SSE idle hints (line ~300).
    // The Set is idempotent so calling add() twice is safe.
    deps.onDoneProcessed?.(targetSessionId);
}
```

**Step 3: Run tests**

```bash
pnpm test:unit -- --grep "Done event dedup"
pnpm test:unit
```

**Step 4: Verify with debug logging**

Add the debug logging from the Background section above. Check `~/.opencode/daemon.log` after sending a message and waiting for the response to complete. Verify:
- `[processAndApplyDone] hadPrimary=true` (dedup working)
- No more `SENDING synthetic done` for sessions that already received an SSE done

**Step 5: Commit**

```bash
git add src/lib/relay/sse-wiring.ts test/unit/relay/done-dedup.test.ts
git commit -m "fix: record done delivery before SSE idle hint triggers poller

Move onDoneProcessed call before notifySSEIdle in the session.status
handler. This ensures the doneDeliveredByPrimary Set is populated
before the poller's immediate re-poll can race to processAndApplyDone,
preventing duplicate done events from reaching the frontend."
```

---

### Task 2: Guard against 500ms poll racing SSE

**Files:**
- Modify: `src/lib/relay/monitoring-wiring.ts:140-161`

**Context:** Task 1 handles the `notifySSEIdle`-triggered poll race. But the regular 500ms poll can also race: if it detects idle *before* the SSE event arrives, `doneDeliveredByPrimary` is empty and the synthetic done fires. Then the SSE done arrives as a duplicate.

The fix: add a short delay (one tick) in `processAndApplyDone` before checking the dedup Set, using `queueMicrotask` or `setTimeout(0)`. This gives the SSE event handler a chance to record the done before the poller's synthetic check.

**Alternative (simpler):** Since the SSE path now records at `session.status:idle` detection time (Task 1), and the poller's immediate re-poll is triggered by the same SSE event, the ordering is guaranteed for the `notifySSEIdle` path. The 500ms regular poll race is harder to fix without a delay.

**More robust alternative:** Instead of timing-based dedup, make `processAndApplyDone` check if the session's event cache already contains a `done` event for the current turn. If the SSE path already delivered and cached a `done`, the poller path can detect it:

```typescript
processAndApplyDone: (sessionId, isSubagent) => {
    // Check if SSE already delivered done (recorded eagerly at SSE idle detection)
    if (doneDeliveredByPrimary.has(sessionId)) {
        doneDeliveredByPrimary.delete(sessionId);
        return;
    }
    
    // Also check if a done was recently cached (covers the 500ms poll race
    // where SSE arrived and cached but didn't record via onDoneProcessed)
    const cached = messageCache.getEvents(sessionId);
    const lastEvent = cached?.[cached.length - 1];
    if (lastEvent?.type === "done") {
        statusLog.info(`Skipping synthetic done — cache already has done`);
        return;
    }
    
    // No done from any path — send synthetic
    // ... existing code
```

**Step 1: Add cache check to `processAndApplyDone`**

This requires `messageCache` to be accessible in monitoring-wiring. Check if it's already in the deps.

**Step 2: Test with the status-poller-broadcast integration test**

```bash
pnpm test:unit -- --grep "status poller"
```

**Step 3: Commit**

```bash
git add src/lib/relay/monitoring-wiring.ts
git commit -m "fix: check event cache in processAndApplyDone to prevent 500ms poll race

When the regular 500ms poll detects idle before the SSE event arrives,
the doneDeliveredByPrimary Set may be empty. Fall back to checking if
the event cache already contains a done event for the session, which
would have been cached by the SSE pipeline."
```

---

### Task 3: Remove debug logging and final verification

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts` — remove console.debug calls
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` — remove console.debug calls
- Modify: `src/lib/frontend/components/chat/UserMessage.svelte` — remove `$inspect`
- Modify: `src/lib/relay/monitoring-wiring.ts` — remove debug logging from Task 1
- Modify: `src/lib/relay/sse-wiring.ts` — remove debug logging from Task 1

**Step 1: Remove all debug logging**

Remove the four frontend debug sites:
1. `[dispatch]` logging in ws-dispatch.ts
2. `[advanceTurn]` logging in chat.svelte.ts
3. `[handleDone]` logging in chat.svelte.ts
4. `[addUserMessage]` logging in chat.svelte.ts
5. `$inspect` in UserMessage.svelte

Remove server-side debug logging added in Tasks 1 and 2.

**Step 2: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
```

**Step 3: Commit**

```bash
git add -u
git commit -m "chore: remove shimmer and done-dedup debug logging"
```
