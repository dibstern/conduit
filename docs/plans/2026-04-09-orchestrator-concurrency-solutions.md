# Orchestrator Concurrency & Race Condition Solutions

**Date:** 2026-04-09
**Status:** Proposed
**Scope:** Root-cause solutions for all 15 concurrency findings from `2026-04-09-orchestrator-perf-scalability-plan-audit-v3.md`.
**Parent:** `2026-04-05-orchestrator-implementation-plan.md`
**Supersedes:** S1-S3 (tiered write pipeline) from `2026-04-07-orchestrator-performance-scalability-solutions.md`

---

## Guiding Principle

**Optimize for the final architecture, not the transitional state.**

The relay pipeline is deleted in Phase 7. Every concurrency issue in the CRITICAL tier traces to S1-S3's `queueMicrotask` deferral — complexity added to protect a temporary path. This document replaces that approach with designs that make the *permanent* architecture (event store + projections + WebSocket notifications) fast, correct, and simple.

The relay's in-memory processing adds ~0ms to the write path. The persistence overhead (~0.45ms per event) is imperceptible against the end-to-end latency budget (SSE transport: 1-5ms, WS send: 0.1ms, browser render: 16ms). Deferring that 0.45ms to save 2% of latency on a component that's being deleted is not worth the three CRITICAL bugs it introduces.

---

## Design Overview

Five root-cause changes address all 15 findings:

| Change | Fixes | Root Cause Addressed |
|--------|-------|---------------------|
| 1. Synchronous interleaved pipeline | #1, #2, #11 | `queueMicrotask` deferral in write path |
| 2. `EventPipeline` — single append+project entry point | #3 | Direct `eventStore.append()` calls bypassing projection |
| 3. Permission resolution gateway | #4, #7 | Dedup check after side effects; no disconnect handling |
| 4. Async lifecycle guards | #5, #6, #14, #15 | Missing mutex, wrong eviction strategy, no consumer guard |
| 5. `LifecycleCoordinator` | #8, #9, #10, #12, #13 | Ad-hoc reconnect handling, no flag authority model |

---

## Change 1: Synchronous Interleaved Pipeline

**Replaces:** S1-S3 (tiered write pipeline with `queueMicrotask`)
**Fixes:** #1 (stale-event race), #2 (sequence ordering), #11 (silent data gaps)
**Amends:** Tasks 10, 11

### Problem

S1-S3 wraps the entire `onSSEEvent()` (translate + seed + append + project) in `queueMicrotask` for Tier 2 events. This creates three bugs:

1. **Stale events after reconnect.** `onReconnect()` resets the translator synchronously, but queued microtasks from the old connection haven't run yet. They execute with the reset translator, producing duplicate canonical events.
2. **Broken sequence ordering.** Tier 1 events write synchronously mid-batch while Tier 2 events are deferred. A Tier 1 event between two Tier 2 events gets a lower sequence number than the Tier 2 event that arrived before it.
3. **Permanent data gaps.** If a deferred microtask throws, the relay already broadcast the event but the event store never received it. The event is lost permanently — recovery can't replay what was never stored.

### Design

Remove `queueMicrotask` from the write path entirely. Remove `onSSEEventDeferred()`, `shouldWriteSync()`, and `SYNC_TYPES`. All events follow one path: **synchronous translate → synchronous append → relay broadcast → synchronous project**.

The key insight is *interleaving*: process each event fully (persist + broadcast) before moving to the next event in the SSE batch. This bounds first-event latency to ~0.15ms (one translate + one append) regardless of batch size.

For each event in the SSE batch:

```
1. DualWriteHook.onSSEEvent()  [sync: translate + append]     ~0.15ms
2. Relay pipeline              [sync: translate + WS broadcast] ~0.05ms
3. ProjectionRunner.projectEvent()  [sync: project]            ~0.30ms
```

The relay broadcast (step 2) happens between append (step 1) and projection (step 3). This means the browser gets the WS message ~0.15ms after the event arrives from SSE — comparable to the current Tier 2 path's latency and well within one animation frame (16.7ms).

**Batch transaction optimization (extends S9).** Steps 1 and 3 across all events in an SSE batch share a single SQLite transaction. The `BEGIN` happens before the first event, `COMMIT` after the last. Per-event cost drops from ~0.45ms (with per-event transaction overhead) to ~0.35ms (amortized). For a 10-event burst, total added latency before the first WS broadcast is ~0.15ms — just one translate + one append inside an open transaction.

```
SSE batch arrives (N events)
│
├── BEGIN TRANSACTION
│
├── Event 1:  translate → append → relay broadcast → project
├── Event 2:  translate → append → relay broadcast → project
├── ...
├── Event N:  translate → append → relay broadcast → project
│
└── COMMIT TRANSACTION
```

### What This Replaces

- **Remove** `DualWriteHook.shouldWriteSync()` — no tier classification needed
- **Remove** `DualWriteHook.onSSEEventDeferred()` — no deferred write path
- **Remove** `SYNC_TYPES` constant — all events are synchronous
- **Remove** conditional placement in `handleSSEEvent()` — the hook is always called in the same position
- **Keep** `onReconnect()` with epoch counter (CH1) — still useful for diagnostics, but no longer racing against microtasks
- **Keep** P11 timing instrumentation (S8) — still measures append/project cost per event
- **Keep** batch projection (`projectBatch()`, S9) — folded into the batch transaction

### Why This Is Fast Enough

| Metric | Value | Budget |
|--------|-------|--------|
| Per-event persistence | ~0.35ms (batched) | 20ms between tokens at 50/sec |
| First-event latency in 10-event burst | ~0.15ms | 16.7ms (one animation frame) |
| Event loop budget consumed at peak | ~1.75% | <5% acceptable |
| Total overhead per second at peak | ~17.5ms | 1000ms available |

After Phase 7 removes the relay, the WS broadcast becomes a lightweight notification ("session X changed"). The UI fetches from projections via HTTP. The synchronous write *is* the UI update — projections are immediately consistent for the next read. No deferred-write window means no stale-projection window.

---

## Change 2: `EventPipeline` — Single Entry Point for Append + Project

**Fixes:** #3 (reconciliation events appended but never projected)
**Amends:** Tasks 10, 21, 54

### Problem

Multiple code paths call `eventStore.append()` directly: the `DualWriteHook`, the reconciliation loop (Task 54), and the staleness safety net. The reconciliation loop appends corrective events but never projects them, leaving the read path stale. The staleness safety net bypasses the event store entirely, mutating projection tables directly. Both patterns violate the CQRS invariant: events are the single source of truth, and projections derive from events.

### Design

Introduce `EventPipeline` as the **sole** entry point for writing canonical events. No code path ever calls `eventStore.append()` or mutates projection tables directly. Every write goes through the pipeline, which guarantees append + project atomicity.

```typescript
interface EventPipeline {
  /** Append a canonical event and project it. Returns the stored event with sequence number. */
  ingest(event: CanonicalEvent): StoredEvent;

  /** Append and project a batch of canonical events within a single transaction. */
  ingestBatch(events: CanonicalEvent[]): StoredEvent[];
}
```

Implementation:

```typescript
class EventPipelineImpl implements EventPipeline {
  constructor(
    private readonly eventStore: EventStore,
    private readonly projectionRunner: ProjectionRunner,
  ) {}

  ingest(event: CanonicalEvent): StoredEvent {
    const stored = this.eventStore.append(event);
    this.projectionRunner.projectEvent(stored);
    return stored;
  }

  ingestBatch(events: CanonicalEvent[]): StoredEvent[] {
    return this.eventStore.db.runInTransaction(() => {
      const stored = events.map(e => this.eventStore.append(e));
      for (const s of stored) {
        this.projectionRunner.projectEvent(s);
      }
      return stored;
    });
  }
}
```

**Consumers that change:**

| Consumer | Before | After |
|----------|--------|-------|
| `DualWriteHook.onSSEEvent()` | `eventStore.append()` + `projectEvent()` | `pipeline.ingest()` |
| `EventSinkImpl.push()` | `eventStore.append()` + `projectEvent()` | `pipeline.ingest()` |
| Reconciliation loop (Task 54) | `eventStore.append()` only | `pipeline.ingest()` |
| Staleness safety net (Task 54) | Direct `db.execute("UPDATE sessions...")` | `pipeline.ingest(makeCanonicalEvent("session.status", ...))` |

**Ownership:** `EventPipeline` lives in `src/lib/persistence/event-pipeline.ts`. `PersistenceLayer` constructs it and exposes it as `persistence.pipeline`. The `eventStore` remains accessible for reads (`readFromSequence`, `readBySession`), but its `append` method is no longer called directly by application code.

### Design Constraint

`eventStore.append()` is not made private (projector recovery calls it during replay). But application-level code (anything outside `EventPipeline` and `ProjectionRunner.recover()`) must go through the pipeline. This is enforced by convention and documented in a coding guideline added to the parent plan's Task 5.

---

## Change 3: Permission Resolution Gateway

**Fixes:** #4 (permission reply races to OpenCode before SQLite dedup), #7 (permission blocks forever on UI disconnect)
**Amends:** Tasks 34, 46

### Problem

Two separate issues in permission handling:

1. **Dedup after side effects.** CH5's `UPDATE ... WHERE status = 'pending'` + `changes === 0` guard runs at the SQLite layer, but the relay pipeline has already sent the permission reply to OpenCode. Duplicate REST calls reach the upstream provider.

2. **Blocking forever.** Task 46's `canUseTool` callback blocks on a Deferred resolved by the UI. D3 adds a 10-minute turn timeout, but individual permissions have no timeout or disconnect detection. A crashed browser tab leaves the callback blocked until the turn times out.

### Design

**Part A: Check-before-send.** Move the deduplication check to the top of the permission reply handler, before any REST call. The handler becomes:

```
Permission reply arrives (WS message from browser)
│
├── 1. UPDATE pending_approvals SET status = 'resolved'
│      WHERE request_id = ? AND status = 'pending'
│
├── 2. Check db.changes === 0?
│      YES → Duplicate. Log, return ack to browser, stop.
│      NO  → First reply. Continue.
│
├── 3. Send POST /permission/reply to OpenCode (or resolve SDK deferred)
│
└── 4. Emit permission.resolved canonical event via EventPipeline
```

This requires the `pending_approvals` table to be populated before the permission reply can arrive, which is already guaranteed: `permission.asked` is a Tier 1 event that writes synchronously. With Change 1 removing tiers, all events write synchronously, so the approval row is always present before a browser can reply.

**Part B: Connection-aware permission lifecycle.** Add a `PermissionLifecycleManager` that tracks which WebSocket connections are watching each session. When all connections for a session disconnect:

1. Wait a grace period (configurable, default: 30 seconds) to allow reconnects.
2. If no reconnect occurs, auto-deny all pending permissions for that session.
3. Log at WARN level with session ID and permission request IDs.

This is more robust than a per-permission timeout because it's event-driven (no polling) and handles the common case (browser tab closed, network drop) directly. The grace period handles transient disconnects (page refresh, network blip) without prematurely denying permissions.

For the Claude adapter (Task 46), the same `PermissionLifecycleManager` resolves the `canUseTool` Deferred with `{ behavior: "deny" }`, unblocking the SDK callback. The existing abort signal handler (for turn interruption) remains as a separate mechanism.

**Fallback timeout.** If no WebSocket disconnect is detected (e.g., the connection stays open but the UI is unresponsive), a per-permission timeout of 5 minutes fires as a safety net. This is longer than the grace-period path (which resolves in ~30s) but shorter than D3's 10-minute turn timeout.

---

## Change 4: Async Lifecycle Guards

**Fixes:** #5 (concurrent `sendTurn()`), #6 (FIFO eviction evicts active parts), #14 (unbounded `processedCommands`), #15 (PromptQueue dual-iteration)
**Amends:** Tasks 7, 9, 41, 44, 48

These four findings share a common theme: missing guards on stateful async resources. Each gets a targeted fix that follows a standard pattern.

### 4a: Per-Session Mutex for `sendTurn()` (fixes #5)

`ClaudeAdapter.sendTurn()` is async. Two concurrent calls for the same new session both see `sessions.has(id) === false` and both create SDK sessions. The fix is a **Promise sentinel** — a standard Node.js pattern for async mutual exclusion without actual locks.

```typescript
private readonly sessionLocks = new Map<string, Promise<ClaudeSessionContext>>();

async sendTurn(input: SendTurnInput): Promise<TurnResult> {
  // If session setup is in flight, wait for it
  const pending = this.sessionLocks.get(input.sessionId);
  if (pending) {
    await pending;
    return this.sendTurn(input); // Retry with established session
  }

  const existing = this.sessions.get(input.sessionId);
  if (!existing) {
    // Set sentinel BEFORE any await
    const setup = this.createSession(input);
    this.sessionLocks.set(input.sessionId, setup);
    try {
      const ctx = await setup;
      this.sessions.set(input.sessionId, ctx);
    } finally {
      this.sessionLocks.delete(input.sessionId);
    }
  }
  // ... enqueue into existing session
}
```

The sentinel is set synchronously (before any `await`), so concurrent callers always see it. The `finally` block ensures the sentinel is cleaned up even on error. Retries are bounded by the turn timeout (D3).

### 4b: Session-Scoped LRU Eviction for `trackedParts` (fixes #6)

P9's FIFO eviction clears the entire `trackedParts` map at 10,000 entries. This evicts parts from the *active* session's current turn, causing duplicate `tool.started` events when subsequent updates arrive for evicted parts.

Replace FIFO with **session-scoped LRU eviction**:

1. Key `trackedParts` by `sessionId:partId` (already the case).
2. On eviction trigger (>10,000 entries), identify sessions with no events in the last 60 seconds (idle sessions).
3. Evict all parts belonging to idle sessions, oldest-idle-first.
4. If still over capacity after idle eviction, evict the oldest parts from non-active sessions (sessions other than the one in the current `onSSEEvent()` call).
5. **Never evict parts from the session currently being processed.** Pass the current `sessionId` to the eviction function as a protected parameter.

This guarantees that in-progress tool calls always have their parts tracked, while completed sessions' parts are reclaimed.

The same session-scoped approach applies to `SessionSeeder.seenSessions` (P9): clear entries for idle sessions rather than the entire set.

### 4c: Bounded `processedCommands` with Receipt Delegation (fixes #14)

`OrchestrationEngine.processedCommands` is an in-memory `Set<string>` that grows without bound. The plan acknowledges this but defers the fix.

Wire it to `CommandReceiptRepository` now:

```typescript
class OrchestrationEngine {
  private isProcessed(commandId: string): boolean {
    return this.receiptRepo.findByCommandId(commandId) !== undefined;
  }

  private markProcessed(commandId: string, status: "completed" | "failed"): void {
    this.receiptRepo.save({ commandId, status, createdAt: Date.now() });
  }
}
```

`CommandReceiptRepository` already exists (Task 6). The receipts table is already evicted by S4/P6. No new infrastructure needed — just wire what's already built.

### 4d: Single-Consumer Guard on `PromptQueue` (fixes #15)

`PromptQueue.[Symbol.asyncIterator]()` returns `this`, meaning multiple `for await` loops share the same buffer. Add an explicit consumption guard:

```typescript
private _iterating = false;

[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
  if (this._iterating) {
    throw new Error(
      "PromptQueue is single-consumer. Cannot iterate more than once."
    );
  }
  this._iterating = true;
  return this;
}
```

This makes the contract explicit and fails fast rather than silently losing messages.

---

## Change 5: `LifecycleCoordinator`

**Fixes:** #8 (checkpoint timer), #9 (non-atomic auditor snapshot), #10 (circuit breaker vs UI toggle), #12 (no reconnect recovery), #13 (silent text truncation)
**Amends:** Tasks 1, 10, 12, 16, 22.5, 24, 24.5, 54

These five findings share a root cause: lifecycle events (reconnect, disconnect, idle) trigger work across multiple components, but each component manages its own lifecycle independently. The fix is a single coordinator that owns all cross-cutting lifecycle behavior.

### Design

`LifecycleCoordinator` is constructed with references to all stateful components and exposes three lifecycle methods: `onReconnect()`, `onDisconnect()`, and `onIdle()`. It replaces the ad-hoc `DualWriteHook.onReconnect()` (CH1) and absorbs the checkpoint timer, reconnect recovery, and flag authority responsibilities.

```typescript
class LifecycleCoordinator {
  constructor(private readonly deps: {
    dualWriteHook: DualWriteHook;
    projectionRunner: ProjectionRunner;
    diagnostics: PersistenceDiagnostics;
    flagAuthority: FlagAuthority;
    sqliteClient: SqliteClient;
    log: Logger;
  }) {}

  /** Called on SSE reconnect. Resets all stateful components atomically. */
  onReconnect(): void { /* ... */ }

  /** Called when no SSE events for N seconds. Runs maintenance. */
  onIdle(): void { /* ... */ }

  /** Called on SSE disconnect. Cleans up timers. */
  onDisconnect(): void { /* ... */ }
}
```

### 5a: Debounced Idle Checkpoint (fixes #8)

The checkpoint timer moves from ad-hoc `setTimeout` wiring in `sse-wiring.ts` into the coordinator. A single `_idleTimer` reference is reset on every SSE event (via an `onEvent()` hook) and fires `onIdle()` after 5 seconds of silence.

```typescript
private _idleTimer: NodeJS.Timeout | undefined;

/** Called by sse-wiring.ts on every SSE event. */
onEvent(): void {
  clearTimeout(this._idleTimer);
  this._idleTimer = setTimeout(() => this.onIdle(), 5_000);
}

onIdle(): void {
  this.deps.sqliteClient.execute("PRAGMA wal_checkpoint(PASSIVE)");
  this.deps.log.debug("idle checkpoint completed");
}

onDisconnect(): void {
  clearTimeout(this._idleTimer);
  this._idleTimer = undefined;
}
```

One timer, one owner, one cleanup path.

### 5b: Reconnect-Triggered Projection Recovery (fixes #12)

CH4 ensures `recover()` runs at startup. But if a projector fails during normal operation, its cursor stops advancing and the gap persists until restart. The coordinator checks projector health on reconnect and runs targeted recovery when needed.

```typescript
onReconnect(): void {
  // 1. Reset stateful components (CH1)
  this.deps.dualWriteHook.resetTranslatorState();
  this._epoch++;

  // 2. Check for projection gaps
  const lag = this.deps.diagnostics.projectorLag();
  if (lag.maxLag > 0) {
    this.deps.log.warn("projection gap detected on reconnect", {
      maxLag: lag.maxLag,
      lagging: lag.projectors,
    });
    // Targeted recovery — only replays events that lagging projectors missed
    this.deps.projectionRunner.recoverLagging(lag.projectors);
  }

  // 3. Reset idle timer
  clearTimeout(this._idleTimer);
}
```

`recoverLagging(projectors)` is a new method on `ProjectionRunner` that runs recovery for specific projectors only (using P7's SQL-level type filtering). It's fast because it only replays the gap, not the entire event store.

### 5c: `FlagAuthority` — Source-Tracked Read Flags (fixes #10)

The circuit breaker and the debug UI both mutate `readFlags` directly. If both act in the same tick, the user's intent is silently overridden. Replace the mutable `ReadFlags` object with a `FlagAuthority` that tracks the source of each value and enforces priority.

```typescript
type FlagSource = "default" | "config" | "breaker" | "user";

interface FlagEntry {
  mode: ReadFlagMode;
  source: FlagSource;
  updatedAt: number;
}

class FlagAuthority {
  private readonly entries = new Map<string, FlagEntry>();

  /** Set a flag. Higher-priority sources override lower-priority ones. */
  set(name: string, mode: ReadFlagMode, source: FlagSource): boolean {
    const existing = this.entries.get(name);
    if (existing && PRIORITY[existing.source] > PRIORITY[source]) {
      // User override beats breaker; breaker beats config; etc.
      return false; // Rejected — higher-priority source already set
    }
    this.entries.set(name, { mode, source, updatedAt: Date.now() });
    return true;
  }

  /** Get the effective mode for a flag. */
  get(name: string): ReadFlagMode {
    return this.entries.get(name)?.mode ?? "legacy";
  }

  /** Reset a breaker-set flag (called when breaker resets). */
  resetBreaker(name: string): void {
    const entry = this.entries.get(name);
    if (entry?.source === "breaker") {
      this.entries.delete(name);
    }
  }
}

const PRIORITY: Record<FlagSource, number> = {
  default: 0,
  config: 1,
  breaker: 2,
  user: 3,  // User always wins
};
```

The `DivergenceCircuitBreaker` calls `flagAuthority.set(name, "legacy", "breaker")` — which is rejected if the user has explicitly set the flag. The debug UI calls `flagAuthority.set(name, mode, "user")` — which always succeeds and overrides any breaker trip.

The `ShadowReadComparator`'s `getMode()` getter reads from `flagAuthority.get(name)` instead of accessing `readFlags[name]` directly.

### 5d: Event-Loop-Aware Auditor Snapshots (fixes #9)

The `DualWriteAuditor` builds a `RelaySnapshot` from in-memory state while the SSE pipeline is mutating that state. The snapshot can be internally inconsistent.

Fix: schedule snapshot construction via `setImmediate` so it runs between I/O callbacks — never mid-batch. Add a `snapshotSequence` (the global event store sequence at snapshot time) and discard comparisons where more than N events (default: 50) have been ingested between snapshot and comparison.

```typescript
class DualWriteAuditor {
  audit(): void {
    // Defer to next I/O boundary — never runs mid-SSE-batch
    setImmediate(() => {
      const snapshot = this.buildRelaySnapshot();
      const storeSeq = this.eventStore.latestSequence();

      // If too many events arrived during snapshot construction, discard
      if (storeSeq - snapshot.atSequence > this.maxSnapshotDrift) {
        this.log.debug("audit snapshot too stale, skipping", {
          snapshotSeq: snapshot.atSequence,
          currentSeq: storeSeq,
        });
        return;
      }

      this.compare(snapshot);
    });
  }
}
```

This doesn't make the snapshot perfectly atomic, but it eliminates the worst case (snapshot taken mid-batch with half-updated state) and makes staleness measurable.

### 5e: Text Accumulation Completeness Tracking (fixes #13)

S7 stops SQL-concat for `text.delta` after 200K chars. If the stream is interrupted before `tool.completed` arrives, the part is permanently truncated with no indication.

Add a `status` column to `message_parts` with three states:

```sql
ALTER TABLE message_parts ADD COLUMN status TEXT NOT NULL DEFAULT 'streaming'
  CHECK (status IN ('streaming', 'complete', 'truncated'));
```

- **`streaming`**: Part is receiving deltas. Default state.
- **`complete`**: Terminal event received (`tool.completed`, `thinking.end`, `text.completed`).
- **`truncated`**: 200K cap hit and no terminal event has arrived yet.

The `MessageProjector` sets `status = 'truncated'` when the cap is hit, and `status = 'complete'` when the terminal event arrives (which also replaces the truncated text with the full content from the terminal event).

On recovery, `PersistenceDiagnostics.checkIntegrity()` reports parts with `status = 'truncated'` as a warning. The `ReadQueryService` includes the status in query results so the UI can display a "content may be incomplete" indicator.

---

## Amendment Mapping

All changes are amendments to existing tasks in the parent plan. No new phases or tasks are added.

| Change | Parent Plan Tasks Amended | What Changes |
|--------|--------------------------|--------------|
| 1 | **10** (DualWriteHook) | Remove `SYNC_TYPES`, `shouldWriteSync()`, `onSSEEventDeferred()`. All writes synchronous. |
| 1 | **11** (SSE wiring) | Remove conditional Tier 1/Tier 2 placement. Single hook call position. Batch transaction wraps SSE batch. |
| 1 | **S1-S3** (amendment header) | **Superseded.** Replace with reference to this document. |
| 2 | **10** (DualWriteHook) | Use `pipeline.ingest()` instead of `eventStore.append()` + `projectEvent()`. |
| 2 | **21** (ProjectionRunner) | Document that `eventStore.append()` is not called directly by application code. |
| 2 | **54** (Reconciliation) | Replace `eventStore.append()` with `pipeline.ingest()`. Remove direct `db.execute("UPDATE sessions...")`. |
| 2 | **8** (PersistenceLayer) | Expose `pipeline` field alongside existing `eventStore` and `projectionRunner`. |
| 3 | **34** (Pending approvals) | Permission reply handler checks `pending_approvals` table BEFORE sending to provider. |
| 3 | **46** (PermissionBridge) | Wire `PermissionLifecycleManager` for disconnect-aware auto-deny with grace period. |
| 3 | **12** (SSE wiring) | Wire WS disconnect events into `PermissionLifecycleManager`. |
| 4a | **48** (Claude sendTurn) | Add `sessionLocks` Map with Promise sentinel pattern for async mutex. |
| 4b | **7** (CanonicalEventTranslator) | Replace FIFO eviction on `trackedParts` with session-scoped LRU. |
| 4b | **9** (SessionSeeder) | Replace FIFO eviction on `seenSessions` with idle-session-scoped eviction. |
| 4c | **41** (OrchestrationEngine) | Wire `processedCommands` to `CommandReceiptRepository` instead of in-memory Set. |
| 4d | **44** (PromptQueue) | Add single-consumer guard on `[Symbol.asyncIterator]()`. |
| 5a | **1** (SqliteClient), **11** (SSE wiring) | Move checkpoint timer into `LifecycleCoordinator` with single debounced reference. |
| 5b | **21** (ProjectionRunner), **12** (SSE wiring) | Add `recoverLagging()` method. Wire reconnect recovery into coordinator. |
| 5c | **24** (ReadFlags), **24.5** (wiring) | Replace mutable `ReadFlags` with `FlagAuthority`. Wire into circuit breaker and debug UI. |
| 5d | **22.5** (Diagnostics) | Schedule auditor snapshots via `setImmediate`. Add `maxSnapshotDrift` staleness guard. |
| 5e | **3** (Schema), **16** (MessageProjector) | Add `status` column to `message_parts`. Set on cap hit and terminal events. |

---

## Superseded Amendments

The following existing amendments are **superseded** by this document:

| Amendment | Status | Replacement |
|-----------|--------|-------------|
| S1-S3 (Tiered write pipeline) | **Superseded entirely** | Change 1 — synchronous interleaved pipeline |
| CH2 note "reintroduce deferred projection selectively if P11 > 5ms" | **Withdrawn** | No deferred projection. Batch transactions address the same performance concern without concurrency risk. |
| P5 "selective deferred projection" | **Superseded entirely** | Was already marked superseded by CH2; now also superseded by Change 1's batch approach. |
| P9 FIFO eviction on `trackedParts` and `seenSessions` | **Superseded** | Change 4b — session-scoped LRU eviction |
| CH5 (permission resolution atomicity) | **Expanded** | Change 3 moves the SQL check before the REST call, making CH5's guard the first line of defense rather than a post-hoc dedup. |

---

## Audit Coverage Matrix

Every finding from `2026-04-09-orchestrator-perf-scalability-plan-audit-v3.md` is addressed:

| # | Finding | Severity | Change | Resolution |
|---|---------|----------|--------|------------|
| 1 | Stale-event race from deferred microtask | CRITICAL | 1 | Eliminated — no microtask in write path |
| 2 | Tier 1/2 interleaving breaks sequence ordering | CRITICAL | 1 | Eliminated — all writes synchronous in arrival order |
| 3 | Reconciliation events appended but never projected | CRITICAL | 2 | All writes go through `EventPipeline.ingest()` |
| 4 | Permission reply races to OpenCode before dedup | HIGH | 3A | SQL check before REST call |
| 5 | Concurrent `sendTurn()` creates dual sessions | HIGH | 4a | Promise sentinel mutex |
| 6 | FIFO eviction evicts active parts | HIGH | 4b | Session-scoped LRU eviction |
| 7 | Permission blocks forever on UI disconnect | HIGH | 3B | Connection-aware auto-deny with grace period |
| 8 | Checkpoint timer lacks debounce | MEDIUM | 5a | Single debounced timer in `LifecycleCoordinator` |
| 9 | Auditor snapshot non-atomic | MEDIUM | 5d | `setImmediate` scheduling + staleness guard |
| 10 | Circuit breaker races with UI flag toggle | MEDIUM | 5c | `FlagAuthority` with source-tracked priority |
| 11 | Microtask failure = permanent data gap | MEDIUM | 1 | Eliminated — no microtask in write path |
| 12 | Recovery not re-run on SSE reconnect | MEDIUM | 5b | Targeted `recoverLagging()` on reconnect |
| 13 | Text cap truncates silently | LOW | 5e | `status` column on `message_parts` |
| 14 | `processedCommands` unbounded growth | LOW | 4c | Wired to `CommandReceiptRepository` |
| 15 | PromptQueue dual-iteration hazard | LOW | 4d | Single-consumer guard throws on reuse |
