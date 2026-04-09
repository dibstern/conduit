Plan under audit: Plan: docs/plans/2026-04-05-orchestrator-implementation-plan.md

---

# Concurrency & Race Condition Audit: Orchestrator Implementation Plan

I've done a deep analysis of the plan across all 7 phases, the 5 amendment documents, and the existing concurrency hardening (CH1-CH5). Below are **15 findings** organized by severity — starting with issues the existing amendments **don't cover**.

---

## CRITICAL — Could cause data loss, corruption, or deadlocks

### 1. S1-S3 Tiered Pipeline Reintroduces the Stale-Event Race That CH1 Was Designed to Fix

**The contradiction:** CH2 says *"Remove `queueMicrotask` / deferred projection entirely. All projections synchronous."* S1-S3 then reintroduces `queueMicrotask` — but this time wrapping the **entire** `onSSEEvent()` call (translate + seed + append + project), not just projection:

```typescript
onSSEEventDeferred(event, sessionId): void {
    queueMicrotask(() => {
        try {
            this.onSSEEvent(event, sessionId);  // entire pipeline deferred
        } catch { ... }
    });
}
```

**The race:** SSE reconnect fires `onReconnect()` synchronously in the `"connected"` handler. But Tier 2 events from the old connection that were already dispatched to `queueMicrotask` haven't executed yet. When those microtasks run, they call `onSSEEvent()` which invokes the **already-reset** translator. The reset translator:
- Loses `trackedParts` state → emits duplicate `tool.started` events with new `eventId`s (unique constraint won't catch them because IDs differ)
- Loses `seenSessions` state → re-seeds sessions that already exist (harmless due to `INSERT OR IGNORE`, but produces synthetic `session.created` events)
- Has a cleared `versionCache` → reads version from DB (correct but slower)

CH1's epoch mechanism was supposed to guard the event store write path, but the epoch check is **inside `onSSEEvent()`**, which runs **after** `onReconnect()` has already incremented the epoch. The stale microtask calls `onSSEEvent()` with the new epoch value (since the epoch is read at call time, not at schedule time). The epoch doesn't help here.

**Fix:** Either:
- (a) Capture the epoch at schedule time in `onSSEEventDeferred()` and guard at the start of the microtask: `const scheduledEpoch = this._epoch; queueMicrotask(() => { if (this._epoch !== scheduledEpoch) return; ... })`
- (b) Use a draining mechanism: `onReconnect()` sets a `_draining` flag; pending microtasks check it and discard themselves; after the microtask queue drains (one more microtask), clear the flag
- (c) Don't defer the translate+append, only defer the projection (the original CH2-compatible approach). The ~0.3ms append cost is acceptable synchronously.

### 2. Tier 1/Tier 2 Interleaving Breaks Event Store Sequence Ordering

When the SSE parser delivers a batch of events in one I/O callback, they are processed synchronously in a loop. Consider this sequence:

```
SSE batch: [message.created (Tier 2), permission.asked (Tier 1), text.delta (Tier 2)]

Processing:
1. message.created → relay pipeline → queueMicrotask(write₁)
2. permission.asked → write₂ [sync, gets seq N] → relay pipeline
3. text.delta → relay pipeline → queueMicrotask(write₃)
── sync processing complete ──
4. Microtask queue drains: write₁ [seq N+1], write₃ [seq N+2]
```

**Event store order:** permission.asked (N), message.created (N+1), text.delta (N+2)
**Arrival order:** message.created, permission.asked, text.delta

Tier 1 events "jump the queue" — they get lower sequence numbers than Tier 2 events that arrived earlier. Any downstream consumer that assumes sequence order = arrival order (recovery replay, the TurnProjector's positional matching, A2's `turnId` fallback) will see events out of order.

**Realistic scenario:** An assistant message with a tool call (Tier 2) arrives just before the tool's permission request (Tier 1). The ApprovalProjector sees the permission event at seq N but the tool's message at seq N+1. If it expects the message to exist first (to attach the approval to a turn), the projection fails or produces orphaned approvals.

**Fix:** All events within a batch should write in arrival order. Options:
- (a) Buffer the entire SSE batch, write all events in one synchronous pass (Tier 1 and Tier 2 together), **then** run the relay pipeline. This preserves ordering but loses the "relay-first" latency benefit for Tier 2.
- (b) Give Tier 2 events a `scheduledSequence` counter at schedule time. The event store uses this to ensure correct ordering on write.
- (c) Accept the ordering gap and make all projectors robust to out-of-order events within a small window (simplest, but adds complexity to every projector).

### 3. Reconciliation Loop Synthesized Events Are Appended but Never Projected

Task 54's reconciliation loop detects status mismatches and calls:

```typescript
eventStore.append(makeCanonicalEvent("session.status", sessionId, {
    sessionId, status: polledStatus
}));
```

This writes to the event store but **never calls `projectionRunner.projectEvent()`**. The `sessions` projection table still shows the stale status. The event sits unprojected until the next process restart triggers `recover()`. During that window:
- The read path returns the stale "busy" status from the projection table
- The event store has the corrective "idle" event
- The UI shows a session stuck as "busy"

The staleness safety net has a **different** problem — it directly mutates the projection table with `db.execute("UPDATE sessions SET status = 'idle'")`, bypassing the event store entirely. This means the event store and projection tables diverge: the projection says "idle" but there's no corresponding event.

**Fix:** The reconciliation loop should call a method that both appends and projects, e.g.:

```typescript
const stored = eventStore.append(makeCanonicalEvent(...));
projectionRunner.projectEvent(stored);
```

For the staleness safety net, append a corrective event AND project it, rather than directly mutating the table.

---

## HIGH — Could cause incorrect behavior under realistic conditions

### 4. Permission Resolution Races Through to OpenCode Before SQLite Guard

CH5 documents the `UPDATE ... WHERE status = 'pending'` + `changes === 0` SQL guard for deduplicating permission replies from multiple browser tabs. But the guard is at the **SQLite layer** — the relay pipeline processes the reply **before** the SQL check. The relay sends the permission response to the OpenCode REST API as part of the normal event handling. Then the dual-write hook's SQL check determines whether it was a duplicate.

**Result:** OpenCode receives two `POST /permission/reply` calls. The first one succeeds; the second one may also succeed at the OpenCode level (OpenCode doesn't have the same deduplication), causing undefined behavior. The SQLite guard only prevents duplicate events in the **local** event store, not duplicate API calls to the upstream provider.

**Fix:** The permission deduplication check should happen **before** the relay sends to OpenCode. Move the `pending_approvals` SQL check to the top of the permission reply handler, before the REST call. This requires the permission path to be in the SYNC_TYPES set (it already is — `permission.resolved` is Tier 1).

### 5. `ClaudeAdapter.sendTurn()` Has No Synchronization for Concurrent First-Turn Calls

Task 48 describes: first turn creates a `PromptQueue` + starts `query()`, subsequent turns enqueue into the existing queue. But there's no synchronization:

```
// Two concurrent sendTurn() calls for a new session "s1":
Thread A: checks sessions.has("s1") → false → creates queue, starts query()
Thread B: checks sessions.has("s1") → false → creates queue, starts query()
```

Both create separate SDK sessions for the same session ID. JavaScript is single-threaded, but `sendTurn()` is async — the `await` points (query creation, event sink operations) yield the event loop, allowing a second `sendTurn()` call to interleave.

Q7 says "Queue and process sequentially" but the plan doesn't show the serialization mechanism (e.g., a per-session mutex or queue).

**Fix:** Add a per-session lock/queue. On first call, set a "creating" sentinel in the sessions map before any `await`. Subsequent calls for the same session wait on the sentinel's resolution:

```typescript
async sendTurn(input: SendTurnInput): Promise<TurnResult> {
    const existing = this.sessions.get(input.sessionId);
    if (existing instanceof Promise) {
        await existing; // Wait for first-turn setup to complete
        return this.sendTurn(input); // Retry
    }
    if (!existing) {
        const setup = this.setupNewSession(input);
        this.sessions.set(input.sessionId, setup); // Sentinel
        const ctx = await setup;
        this.sessions.set(input.sessionId, ctx);
    }
    // ... enqueue into existing session
}
```

### 6. `CanonicalEventTranslator.trackedParts` FIFO Eviction During Active Streaming

P9 adds FIFO eviction at 10,000 entries for `trackedParts`. During a long-running session with many tool calls, the earliest parts get evicted. If a late-arriving `message.part.updated` event references an evicted part, the translator:
- Doesn't find the part in `trackedParts`
- Treats it as a **new** part
- Emits a duplicate `tool.started` event

This is realistic for sessions with heavy tool use (e.g., Claude writing code with many file edits). 10,000 tracked parts could be exhausted in a single long session with ~500 tool calls (each tool has ~20 lifecycle events creating ~20 tracked parts).

**Fix:** Use LRU eviction (not FIFO) keyed by `(sessionId, partId)`. Active parts in the current session are touched on every event, keeping them warm. Alternatively, scope eviction to only evict parts from **completed** sessions, not the active one.

### 7. `EventSink.requestPermission` Can Block Forever on UI Disconnect

Task 46's `canUseTool` callback blocks on a Deferred promise resolved by the UI. D3 adds a 10-minute timeout on the **turn** level, but individual permission requests have no timeout. If:
- The browser tab crashes / disconnects
- The WebSocket reconnects to a new relay instance
- The user navigates away

...the permission Deferred is never resolved. The abort signal handles "turn interrupted" but not "UI gone". The callback blocks for up to 10 minutes (the turn timeout).

**Fix:** Add a per-permission timeout (e.g., 2 minutes) that rejects with "deny" and logs a warning. Or wire WebSocket disconnect detection into the permission bridge to auto-deny pending permissions for disconnected clients.

---

## MEDIUM — Could cause degraded behavior or subtle bugs

### 8. Idle WAL Checkpoint Timer Lacks Debounce — Could Queue Multiple Checkpoints

Task 1 / S6: *"when no SSE events have arrived for 5 seconds, trigger `PRAGMA wal_checkpoint(PASSIVE)`"*. The plan says to wire this into the SSE consumer's lifecycle but doesn't show the debounce mechanism. If each SSE event creates a `setTimeout` for the checkpoint without clearing the previous one, a burst of 100 events creates 100 pending checkpoint timers. After the burst, 100 checkpoints fire at 5-second intervals (or nearly simultaneously if the burst was short).

**Fix:** Use a single timer reference, cleared and reset on each SSE event:

```typescript
let checkpointTimer: NodeJS.Timeout | undefined;
function onSSEEvent() {
    clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => db.exec("PRAGMA wal_checkpoint(PASSIVE)"), 5000);
}
```

### 9. `DualWriteAuditor` Snapshot Is Non-Atomic — Inherently Inconsistent

The auditor (Task 10/22.5) builds a `RelaySnapshot` from in-memory relay state (session titles, statuses, message counts) for comparison against SQLite. But snapshot construction reads from multiple data structures that the SSE pipeline is concurrently mutating. The snapshot could show:
- Session A with 5 messages but session B's status from before a status update that happened mid-snapshot

This could cause spurious divergence alerts and circuit breaker trips.

**Fix:** Document this as a known limitation with appropriate tolerance in the comparison. Add a `snapshotAge` field and discard comparisons where the snapshot took longer than a threshold to construct. Or serialize snapshot construction relative to the SSE event loop (run it in a microtask after the current event).

### 10. Circuit Breaker Trip Races with UI Flag Toggle

The `DivergenceCircuitBreaker` trips by mutating `readFlags[name] = "legacy"`. The debug UI allows users to toggle flags at runtime. If both happen in the same event loop tick:
1. User sets `toolContent` to `"sqlite"` via debug UI
2. Circuit breaker trips and sets `toolContent` to `"legacy"`
3. User's intent is silently overridden

There's no priority mechanism, no lock, and no notification to the UI.

**Fix:** Add a `lockedBy` field to the flag. If the user explicitly sets a flag, mark it as `lockedBy: "user"` and have the circuit breaker skip locked flags. Or: have the breaker record its trips separately, and compute the effective mode as `max(userSetting, breakerOverride)` where legacy < shadow < sqlite.

### 11. `onSSEEventDeferred` Microtask Failure Creates Silent Data Gaps

If a Tier 2 event's microtask throws (e.g., DB disk full, constraint violation), the error is caught and logged. But:
- The relay pipeline already completed — the UI shows the event
- The event store doesn't have it — recovery won't replay it
- The projection tables don't have it — read path is stale

This is a **permanent** data gap. The event is lost from the persistence layer with only a log warning. The relay's in-memory state (which is serving the UI) has the event, but on restart, the event is gone.

**Fix:** Track deferred-write failures in `DualWriteStats`. If `deferredErrors` exceeds a threshold, auto-switch all events to synchronous (Tier 1) mode to prevent further silent losses. Log at ERROR level, not WARN. Consider a retry mechanism for transient failures (with a bounded retry count).

### 12. Recovery Not Re-Run on SSE Reconnect — Projection Gaps Accumulate

CH4 ensures `recover()` runs at startup before SSE wiring. But if a projector fails during normal operation (caught by the per-projector error handler), its cursor stops advancing. The event is in the store but the projection is stale. The gap only gets fixed on **process restart** (the next `recover()` call).

If the process runs for days between restarts (production scenario), projection gaps accumulate. SSE reconnects happen frequently but don't trigger recovery.

**Fix:** Run a lightweight recovery check on SSE reconnect — after `onReconnect()`, check `projectorLag()` from `PersistenceDiagnostics`. If any projector is behind, run a targeted `recover()` for that projector only. This adds a small startup cost to reconnects but prevents gap accumulation.

---

## LOW — Edge cases or documentation gaps

### 13. Text Accumulation Cap (S7) Silently Truncates on Stream Interruption

S7 stops SQL-concat for `text.delta` after 200K chars, relying on `tool.completed` for the full content. If the stream is interrupted before `tool.completed` arrives (SSE disconnect, process crash), the message is permanently truncated at 200K with no indication. The relay's in-memory state may have more text, but on restart, the projection shows truncated content.

**Fix:** Add a `truncated_at` column or flag to `message_parts` when the 200K cap is hit. On recovery, if a part is truncated and no `tool.completed` event exists for it, log a warning and mark the part as potentially incomplete.

### 14. `processedCommands` Set on `OrchestrationEngine` Grows Without Bound

Task 41 notes: *"The processedCommands Set will grow unboundedly. In production, this should be backed by the CommandReceiptRepository."* But no migration path or threshold is specified. In a long-running instance processing 1000s of commands, this is a memory leak.

**Fix:** Add interim FIFO eviction (like P9) with a 10,000-entry cap. Or wire to `CommandReceiptRepository` now instead of deferring.

### 15. `PromptQueue` Is Single-Consumer but `[Symbol.asyncIterator]` Returns `this`

Task 44's `PromptQueue` implements `AsyncIterator` by returning `this` from `[Symbol.asyncIterator]()`. If the SDK internally calls `[Symbol.asyncIterator]()` more than once (e.g., in retry logic, or if a `for await` loop is broken and restarted), both iterators share the same buffer and waiter queue. Messages dispatched to one consumer are invisible to the other, causing lost messages.

The test acknowledges this: *"The queue itself IS the iterator, not a new one per call."* But it's asserted as intended behavior without documenting the hazard.

**Fix:** Add a guard that throws on second `[Symbol.asyncIterator]()` call (making the contract explicit), or track iteration count and warn.

---

## Summary Matrix

| # | Finding | Severity | Addressed by existing amendments? | Recommended action |
|---|---------|----------|-----------------------------------|-------------------|
| 1 | S1-S3 reintroduces stale-event race via deferred microtask | CRITICAL | **No** — CH1's epoch doesn't help | Epoch guard at schedule time or don't defer translate+append |
| 2 | Tier 1/2 interleaving breaks event store ordering | CRITICAL | **No** | Buffer-and-flush or per-batch sequencing |
| 3 | Reconciliation events appended but never projected | CRITICAL | **No** | Always project after append |
| 4 | Permission reply reaches OpenCode before SQLite dedup | HIGH | **Partially** (CH5 guards DB only) | Check DB before REST call |
| 5 | Concurrent first-turn `sendTurn()` creates dual sessions | HIGH | **No** (Q7 mentions but doesn't implement) | Per-session mutex |
| 6 | FIFO eviction on trackedParts evicts active parts | HIGH | **No** (P9 addresses unbounded growth only) | LRU or scope-aware eviction |
| 7 | Permission Deferred blocks forever on UI disconnect | HIGH | **Partially** (D3 has turn timeout) | Per-permission timeout |
| 8 | Checkpoint timer lacks debounce | MEDIUM | **No** | Single debounced timer |
| 9 | Auditor snapshot non-atomic | MEDIUM | **No** | Tolerance + staleness check |
| 10 | Circuit breaker races with UI flag toggle | MEDIUM | **No** | Priority/lock mechanism |
| 11 | Tier 2 microtask failure = permanent data gap | MEDIUM | **No** | Error escalation + fallback |
| 12 | Recovery not re-run on SSE reconnect | MEDIUM | **No** (CH4 startup-only) | Lightweight reconnect recovery |
| 13 | Text cap truncates silently on interruption | LOW | **No** | Truncation flag |
| 14 | processedCommands unbounded growth | LOW | **Acknowledged** (not fixed) | Interim eviction |
| 15 | PromptQueue dual-iteration hazard | LOW | **No** | Throw on reuse |

The three most impactful fixes would be:
1. **Fix #1** (stale microtask) — captures the epoch at schedule time in `onSSEEventDeferred()`
2. **Fix #3** (unprojected reconciliation events) — one-line addition of `projectEvent()` after `append()`
3. **Fix #5** (concurrent sendTurn) — per-session creation sentinel in the sessions Map