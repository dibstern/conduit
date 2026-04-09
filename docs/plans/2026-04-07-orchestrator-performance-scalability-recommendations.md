# Orchestrator Plan: Performance & Scalability Recommendations

> Companion to the [orchestrator implementation plan](./2026-04-05-orchestrator-implementation-plan.md).
>
> Focus: every performance bottleneck, scalability gap, and missing optimization identified in the plan, with concrete implementation guidance for each fix.
>
> Structured as amendments to be applied inline during implementation or as follow-up tasks after each phase.

---

## Scope

The plan is architecturally sound for single-session, low-volume usage. These recommendations target the scaling path: what breaks at 100K events, 1M events, 3-5 concurrent streaming sessions, and long-running daemons with hundreds of sessions. Each recommendation includes the specific plan code that needs to change, a concrete implementation, and the phase/task where it should be applied.

---

## P1. MessageProjector: Buffer Streaming Deltas Instead of Per-Token JSON Round-Trips

**Phase:** 3 | **Task:** 16 (MessageProjector) | **Severity:** Critical

### Problem

Every `text.delta` event triggers the following synchronous chain inside the MessageProjector:

```
SELECT parts FROM messages WHERE id = ?      → row fetch
SELECT last_applied_seq FROM messages ...     → replay check (alreadyApplied)
JSON.parse(row.parts)                        → deserialize full parts array
validateParts(raw)                           → iterate + validate each part
parts.find(p => p.id === partId)             → linear scan by partId
existing.text += delta                       → string concatenation
parts.filter(p => p.type === "text").map(p => p.text).join("")  → rebuild full text
JSON.stringify(parts)                        → re-serialize full parts array
UPDATE messages SET text = ?, parts = ?, ... → write back
```

At ~50 tokens/sec (streaming speed), this is 50 full read-modify-write cycles per second on the same row. A message with 10 parts (text + thinking + several tools) has a `parts` column that grows to 5-20KB with tool inputs/outputs. Every delta re-parses and re-serializes the entire column.

The `fullText` rebuild is additionally O(P × L) where P is the number of text parts and L is the accumulated text length — run 50 times per second.

t3code avoids this entirely: in the default `"buffered"` delivery mode, `ProviderRuntimeIngestion` accumulates assistant text deltas in a `Cache` (up to 24,000 chars) and only flushes to the orchestration engine on turn completion or buffer overflow (`ProviderRuntimeIngestion.ts:515-606`). The in-memory projector never sees individual token deltas.

### Fix

Add a `ProjectionDeltaBuffer` that accumulates text/thinking deltas in memory and flushes to SQLite on a timer (200ms), on `turn.completed`, on `thinking.end`, or when the buffer exceeds a size threshold.

**New file:** `src/lib/persistence/projectors/projection-delta-buffer.ts`

```typescript
/**
 * Buffers text.delta and thinking.delta events to reduce per-token
 * read-modify-write cycles on the messages table.
 *
 * Instead of 50 SELECT + UPDATE cycles per second during streaming,
 * accumulated deltas are flushed every 200ms (matching the existing
 * JSONL MessageCache flush interval), reducing to ~5 cycles per second.
 *
 * Events still flow into the event store individually (append-only,
 * fast). Only the projection UPDATE is batched.
 */
export class ProjectionDeltaBuffer {
  /** Map<messageId, Map<partId, { type, accumulatedText }>> */
  private pending = new Map<string, Map<string, PendingDelta>>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;

  constructor(opts?: { flushIntervalMs?: number }) {
    this.flushIntervalMs = opts?.flushIntervalMs ?? 200;
  }

  /**
   * Accumulate a delta. Returns false (do NOT project now).
   * The caller should skip the normal readParts/writeParts cycle.
   */
  accumulate(messageId: string, partId: string, type: "text" | "thinking", text: string): void {
    let msgMap = this.pending.get(messageId);
    if (!msgMap) {
      msgMap = new Map();
      this.pending.set(messageId, msgMap);
    }
    const existing = msgMap.get(partId);
    if (existing) {
      existing.accumulatedText += text;
    } else {
      msgMap.set(partId, { type, accumulatedText: text });
    }
  }

  /** Returns true if there are pending deltas for this message. */
  hasPending(messageId: string): boolean {
    return this.pending.has(messageId);
  }

  /**
   * Drain all pending deltas for a message, returning them for
   * application. Called by the MessageProjector on flush or
   * when a non-delta event (tool.started, turn.completed) arrives
   * for the same message.
   */
  drain(messageId: string): PendingDelta[] | undefined {
    const msgMap = this.pending.get(messageId);
    if (!msgMap) return undefined;
    const deltas = [...msgMap.values()];
    this.pending.delete(messageId);
    return deltas;
  }

  /** Drain all pending deltas across all messages. */
  drainAll(): Map<string, PendingDelta[]> {
    const result = new Map<string, PendingDelta[]>();
    for (const [messageId, msgMap] of this.pending) {
      result.set(messageId, [...msgMap.values()]);
    }
    this.pending.clear();
    return result;
  }

  /** Start the periodic flush timer. */
  start(flushFn: (pending: Map<string, PendingDelta[]>) => void): void {
    this.flushTimer = setInterval(() => {
      if (this.pending.size > 0) {
        flushFn(this.drainAll());
      }
    }, this.flushIntervalMs);
  }

  /** Stop the timer and return any remaining pending deltas. */
  stop(): Map<string, PendingDelta[]> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    return this.drainAll();
  }
}

interface PendingDelta {
  type: "text" | "thinking";
  accumulatedText: string;
}
```

**Changes to MessageProjector (Task 16):**

```typescript
// In MessageProjector.project(), replace the text.delta handler:

if (isEventType(event, "text.delta")) {
  // Accumulate in buffer instead of immediate read-modify-write
  this.deltaBuffer.accumulate(event.data.messageId, event.data.partId, "text", event.data.text);
  return;
}

// Before any non-delta event that touches the same message (tool.started,
// tool.running, tool.completed, turn.completed, turn.error), flush:
private flushBeforeModify(db: SqliteClient, messageId: string, sequence: number): void {
  const pending = this.deltaBuffer.drain(messageId);
  if (!pending) return;
  this.applyPendingDeltas(db, messageId, pending, sequence);
}

private applyPendingDeltas(
  db: SqliteClient, messageId: string, deltas: PendingDelta[], sequence: number,
): void {
  const parts = this.readParts(db, messageId);
  for (const delta of deltas) {
    const existing = parts.find(p => p.id === delta.partId && p.type === delta.type);
    if (existing) {
      existing.text = (existing.text ?? "") + delta.accumulatedText;
    } else {
      parts.push({ type: delta.type, id: delta.partId, text: delta.accumulatedText });
    }
  }
  const fullText = parts.filter(p => p.type === "text").map(p => p.text ?? "").join("");
  db.execute(
    "UPDATE messages SET text = ?, parts = ?, last_applied_seq = ?, updated_at = ? WHERE id = ?",
    [fullText, encodeJson(parts), sequence, Date.now(), messageId],
  );
}
```

**Impact:** Reduces per-token SQLite operations from ~3 statements (2 SELECTs + 1 UPDATE) to ~0.2 statements (one batched UPDATE every 200ms). At 50 tokens/sec, this is a 15× reduction in SQL statements for the hottest code path.

**Wiring:** The `ProjectionRunner` or `PersistenceLayer` owns the buffer and wires the periodic flush. On `PersistenceLayer.close()`, call `buffer.stop()` and flush remaining deltas.

---

## P2. Batch Cursor Advances Instead of Per-Projector-Per-Event Writes

**Phase:** 3 | **Task:** 21 (ProjectionRunner) | **Severity:** Critical

### Problem

`ProjectionRunner.projectEvent()` currently:

1. Runs each matching projector in its own `BEGIN/COMMIT` transaction (correct for fault isolation per A4).
2. After matching projectors, advances cursors for ALL non-matching projectors individually:

```typescript
for (const projector of this.projectors) {
  if (!projector.handles.includes(event.type)) {
    this.cursorRepo.upsert(projector.name, event.sequence);
  }
}
```

For a `text.delta` event (handled by 1 of 6 projectors), this executes 5 individual `INSERT ... ON CONFLICT DO UPDATE` statements — one per non-matching projector. At 50 events/sec, that's **250 cursor writes/sec** that serve no purpose except preventing unnecessary replays at startup.

### Fix

**Option A — Lazy cursor advancement (recommended):** Only advance non-matching cursors periodically (every N events or on a timer), not on every event. The recovery mechanism handles the gap: if a non-matching projector's cursor is slightly behind, recovery replays a few extra events that produce no changes (the projector skips them since it doesn't handle that event type).

```typescript
// In ProjectionRunner:
private eventsSinceLastCursorSync = 0;
private readonly CURSOR_SYNC_INTERVAL = 100; // Sync every 100 events

projectEvent(event: StoredEvent): void {
  const matching = this.projectorsByEventType.get(event.type) ?? [];

  // Run matching projectors (each in own txn for fault isolation)
  for (const projector of matching) {
    try {
      this.db.runInTransaction(() => {
        projector.project(event, this.db);
        this.cursorRepo.upsert(projector.name, event.sequence);
      });
    } catch (err) {
      this.recordFailure(projector, event, err);
    }
  }

  // Lazy cursor sync for non-matching projectors
  this.eventsSinceLastCursorSync++;
  if (this.eventsSinceLastCursorSync >= this.CURSOR_SYNC_INTERVAL) {
    this.syncAllCursors(event.sequence);
    this.eventsSinceLastCursorSync = 0;
  }
}

private syncAllCursors(sequence: number): void {
  this.db.runInTransaction(() => {
    for (const projector of this.projectors) {
      this.cursorRepo.upsert(projector.name, sequence);
    }
  });
}
```

**Option B — Single batch transaction:** Combine the matching projector's cursor update with all non-matching cursor updates into one transaction.

```typescript
projectEvent(event: StoredEvent): void {
  const matching = this.projectorsByEventType.get(event.type) ?? [];

  // Run matching projectors with individual fault isolation
  for (const projector of matching) {
    try {
      this.db.runInTransaction(() => {
        projector.project(event, this.db);
        this.cursorRepo.upsert(projector.name, event.sequence);
      });
    } catch (err) {
      this.recordFailure(projector, event, err);
    }
  }

  // Single transaction for all non-matching cursor advances
  const nonMatching = this.projectors.filter(
    p => !(p.handles as readonly string[]).includes(event.type)
  );
  if (nonMatching.length > 0) {
    this.db.runInTransaction(() => {
      for (const projector of nonMatching) {
        this.cursorRepo.upsert(projector.name, event.sequence);
      }
    });
  }
}
```

**Impact:** Option A reduces cursor writes from 5/event to 6/100-events — a 83× reduction during streaming. Option B reduces from 5 individual transactions to 1 batched transaction — a 5× reduction.

Recommend Option A as the default, with a `syncAllCursors()` call on `PersistenceLayer.close()` to flush the final state.

---

## P3. Eliminate the `alreadyApplied()` SELECT During Normal Operation

**Phase:** 3 | **Task:** 16 (MessageProjector) | **Severity:** High

### Problem

The `alreadyApplied()` replay-safety check runs on every `text.delta` and `thinking.delta` during normal streaming:

```typescript
private alreadyApplied(db: SqliteClient, messageId: string, sequence: number): boolean {
  const row = db.queryOne<{ last_applied_seq: number | null }>(
    "SELECT last_applied_seq FROM messages WHERE id = ?",
    [messageId],
  );
  if (!row) return false;
  return row.last_applied_seq != null && sequence <= row.last_applied_seq;
}
```

During normal (non-replay) operation, this check always returns `false` — events arrive in order and are never replayed. The extra SELECT per delta is pure waste during streaming.

### Fix

Add a `replaying` flag to the `ProjectionRunner` that is `true` only during `recover()`, and pass it through to projectors:

```typescript
// In ProjectionRunner:
private _replaying = false;

recover(): RecoveryResult {
  this._replaying = true;
  try {
    // ... existing recovery loop ...
  } finally {
    this._replaying = false;
  }
}

projectEvent(event: StoredEvent): void {
  // ... existing matching logic ...
  for (const projector of matching) {
    this.db.runInTransaction(() => {
      projector.project(event, this.db, { replaying: this._replaying });
    });
  }
}
```

```typescript
// In Projector interface, add optional context:
export interface ProjectionContext {
  readonly replaying: boolean;
}

export interface Projector {
  readonly name: string;
  readonly handles: readonly CanonicalEventType[];
  project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void;
}
```

```typescript
// In MessageProjector, only check during replay:
if (isEventType(event, "text.delta")) {
  if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;
  // ... rest of handler ...
}
```

**Impact:** Eliminates 1 SELECT per token during normal streaming. At 50 tokens/sec, that's 50 fewer SQL statements per second.

If the delta buffer from P1 is also implemented, this fix becomes even more valuable: the buffer suppresses most delta projections, and the remaining ones (on flush) skip the replay check during normal operation.

---

## P4. Cache Stream Version In-Memory Instead of COALESCE Subquery

**Phase:** 1 | **Task:** 5 (EventStore) | **Severity:** Medium

### Problem

Every `EventStore.append()` computes the next stream version via a correlated subquery:

```sql
COALESCE(
  (SELECT MAX(stream_version) + 1 FROM events WHERE session_id = ?),
  0
)
```

This forces SQLite to seek to the rightmost leaf of the `idx_events_session_version` B-tree on every INSERT. With 100K events per session, the index is 3-4 levels deep — fast, but unnecessary since we already know the next version from the previous append.

### Fix

Add an in-memory version cache to `EventStore`:

```typescript
export class EventStore {
  private readonly versionCache = new Map<string, number>();

  append(event: CanonicalEvent): StoredEvent {
    validateEventPayload(event);

    // Check cache first; fall back to DB query on cache miss
    let nextVersion = this.versionCache.get(event.sessionId);
    if (nextVersion === undefined) {
      nextVersion = this.getNextStreamVersion(event.sessionId);
    }

    const dataJson = JSON.stringify(event.data);
    const metadataJson = JSON.stringify(event.metadata);

    // Use explicit version instead of COALESCE subquery
    const rows = this.db.query<EventRow>(
      `INSERT INTO events (
        event_id, session_id, stream_version, type, data, metadata, provider, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at`,
      [
        event.eventId,
        event.sessionId,
        nextVersion,
        event.type,
        dataJson,
        metadataJson,
        event.provider,
        event.createdAt,
      ],
    );

    // ... row validation ...

    // Update cache
    this.versionCache.set(event.sessionId, nextVersion + 1);

    return this.rowToStoredEvent(rows[0]!);
  }

  /** Clear the version cache (e.g., on SSE reconnect when events may have been inserted externally). */
  resetVersionCache(): void {
    this.versionCache.clear();
  }
}
```

The `(session_id, stream_version)` unique index still provides the concurrency safety net: if the cached version is wrong (stale cache after reconnect), the INSERT fails with a constraint violation. The cache is a performance optimization, not a correctness mechanism.

**Impact:** Eliminates one index lookup per event append. Minor per-event savings, but compounds at high throughput.

---

## P5. Defer Projection Execution Off the SSE Event Handler

**Phase:** 2 | **Task:** 11 (Dual-Write Wiring) | **Severity:** High

### Problem

The full dual-write + projection pipeline runs synchronously inside `handleSSEEvent()`:

```
SSE event → dualWriteHook.onSSEEvent() → translate → seed → append → projectEvent() → relay pipeline
```

For a `tool.started` event, the synchronous chain executes ~10 SQL statements before the WebSocket broadcast can happen. With 3-5 concurrent sessions streaming at 50 events/sec, the accumulated event loop blocking reaches 75-125ms/sec.

The plan explicitly relies on synchronous projection: "the SQLite status column is updated before the event handler returns" (line 12538). But browser reads go through WebSocket round-trips — a microtask delay is invisible to the user.

### Fix

Separate event store append (synchronous, ordering-critical) from projection (deferrable):

```typescript
// In DualWriteHook.onSSEEvent():

// Step 1: Synchronous append (fast — one INSERT per event)
const stored = this.persistence.eventStore.append(enriched as CanonicalEvent);
this._eventsWritten++;

// Step 2: Deferred projection (runs after the SSE handler returns)
queueMicrotask(() => {
  try {
    this.persistence.projectionRunner.projectEvent(stored);
  } catch (err) {
    this._errors++;
    this.log.warn("projection failed (deferred)", {
      sequence: stored.sequence,
      type: stored.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
```

**Trade-off:** Read queries that expect immediate consistency (e.g., "session status just changed") may see a microtask delay. In practice, the microtask executes before the next I/O callback, so browser-observable latency is negligible. If strict synchronous consistency is required for specific event types (e.g., `session.status`), apply selective inline projection:

```typescript
// Hybrid: project session.status synchronously, defer everything else
const SYNC_PROJECT_TYPES = new Set(["session.status", "permission.asked", "permission.resolved"]);

if (SYNC_PROJECT_TYPES.has(stored.type)) {
  this.persistence.projectionRunner.projectEvent(stored);
} else {
  queueMicrotask(() => {
    this.persistence.projectionRunner.projectEvent(stored);
  });
}
```

**Impact:** Reduces the synchronous SSE handler from ~10 SQL statements to ~1 (just the event store INSERT). The event loop is free to process other I/O (incoming SSE, WebSocket heartbeats, HTTP health checks) while projections run in the next microtask.

---

## P6. Add Event Store Eviction and Retention Policy

**Phase:** 7 | **Task:** 51 (Low-disk-space handler replacement) | **Severity:** Critical

### Problem

The `events` table is append-only with no retention policy. The plan hand-waves eviction: Q10 says "Replace with event-store eviction" and Task 51 mentions "event store equivalent `evictOldest()`" but provides no implementation.

At 500-25,000 events per session × 100 sessions = 50K-2.5M events. At 1KB/event average, that's 50MB-2.5GB. The 5 indexes on the events table add ~40% overhead. Startup recovery scans from the min cursor through ALL events.

### Fix

Implement a three-tier retention strategy:

**Tier 1 — Projection compaction (after turn completion):**

Once a message's `is_streaming = 0` and the turn is `completed`, the individual `text.delta`, `thinking.delta`, `tool.running` events that built the projection are no longer needed. The projection row contains the final state. These events can be deleted.

```typescript
// src/lib/persistence/event-store-eviction.ts

export class EventStoreEviction {
  constructor(
    private readonly db: SqliteClient,
    private readonly log?: Logger,
  ) {}

  /**
   * Delete granular streaming events for completed messages.
   * Retains structural events (message.created, turn.completed, session.*)
   * that are needed for replay and debugging.
   *
   * Call periodically (e.g., every 5 minutes) or when disk usage exceeds a threshold.
   */
  compactCompletedMessages(): EvictionResult {
    const deletableTypes = [
      "text.delta",
      "thinking.start",
      "thinking.delta",
      "thinking.end",
      "tool.running",
    ];
    const placeholders = deletableTypes.map(() => "?").join(", ");

    // Find messages that are done streaming
    const completedMessageIds = this.db.query<{ id: string }>(
      "SELECT id FROM messages WHERE is_streaming = 0",
    );

    let totalDeleted = 0;
    for (const { id } of completedMessageIds) {
      // Delete delta events for this message, keeping structural events
      const result = this.db.execute(
        `DELETE FROM events
         WHERE type IN (${placeholders})
           AND json_extract(data, '$.messageId') = ?`,
        [...deletableTypes, id],
      );
      totalDeleted += Number(result.changes);
    }

    return { eventsDeleted: totalDeleted, messagesCompacted: completedMessageIds.length };
  }

  /**
   * Delete all events for sessions older than the retention period.
   * Keeps the session row and projection tables intact (they serve as
   * the queryable history).
   */
  evictOldSessions(retentionMs: number): EvictionResult {
    const cutoff = Date.now() - retentionMs;
    const result = this.db.execute(
      `DELETE FROM events WHERE session_id IN (
         SELECT id FROM sessions WHERE updated_at < ? AND status = 'idle'
       )`,
      [cutoff],
    );
    return { eventsDeleted: Number(result.changes), messagesCompacted: 0 };
  }

  /**
   * Run VACUUM to reclaim disk space after eviction.
   * VACUUM rewrites the entire database — run infrequently (e.g., daily).
   */
  vacuum(): void {
    this.db.execute("VACUUM");
  }
}

interface EvictionResult {
  eventsDeleted: number;
  messagesCompacted: number;
}
```

**Tier 2 — Session-level eviction (for old idle sessions):**

Delete events for sessions that have been idle longer than a configurable retention period (default: 7 days). The projection rows (sessions, messages, turns) remain as the queryable history. Only the event store rows are evicted.

**Tier 3 — Periodic VACUUM:**

After significant eviction, run `VACUUM` to reclaim disk space. SQLite's `DELETE` marks pages as free but doesn't return them to the OS. `VACUUM` rewrites the database file. Run this infrequently (daily or on explicit trigger).

**Wiring:**

```typescript
// In PersistenceLayer:
readonly eviction: EventStoreEviction;

// In Daemon, add a periodic eviction timer:
setInterval(() => {
  const result = persistence.eviction.compactCompletedMessages();
  if (result.eventsDeleted > 0) {
    log.info(`eviction: compacted ${result.eventsDeleted} events from ${result.messagesCompacted} messages`);
  }
}, 5 * 60 * 1000); // Every 5 minutes
```

**Impact:** Keeps the events table bounded to structural events (~5-10% of total event volume). A session with 500 events (mostly deltas) compacts to ~50 retained events. At 100 sessions, the events table stays at ~5,000 rows instead of 50,000.

---

## P7. Per-Projector Recovery Instead of Global Min-Cursor Replay

**Phase:** 3 | **Task:** 22 (Recovery) | **Severity:** High

### Problem

`ProjectionRunner.recover()` replays events from the **global minimum cursor** through ALL projectors:

```typescript
recover(): number {
  const minCursor = this.cursorRepo.minCursor();
  // ... replay all events after minCursor through all projectors ...
}
```

If one projector is at cursor 0 (fresh or failed) and another is at cursor 100,000, recovery replays ALL 100,000 events through ALL projectors. The caught-up projectors waste time on no-op cursor advances or `alreadyApplied()` checks.

At 1M events: recovery processes 2,000 batches × 500 events × 6 projectors = 6M projector invocations. Even at 50μs each, that's 5 minutes of blocking startup.

### Fix

Recover each projector independently from its own cursor:

```typescript
recover(): RecoveryResult {
  const startTime = Date.now();
  const perProjector: ProjectorRecoveryResult[] = [];
  let totalReplayed = 0;

  for (const projector of this.projectors) {
    const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
    const result = this.recoverProjector(projector, cursor);
    perProjector.push(result);
    totalReplayed += result.eventsReplayed;
  }

  return {
    totalReplayed,
    durationMs: Date.now() - startTime,
    perProjector,
  };
}

private recoverProjector(projector: Projector, fromCursor: number): ProjectorRecoveryResult {
  const startTime = Date.now();
  let replayed = 0;
  let cursor = fromCursor;

  while (true) {
    const events = this.eventStore.readFromSequence(cursor, BATCH_SIZE);
    if (events.length === 0) break;

    for (const event of events) {
      // Only run this projector, not all projectors
      if ((projector.handles as readonly string[]).includes(event.type)) {
        try {
          this.db.runInTransaction(() => {
            projector.project(event, this.db, { replaying: true });
            this.cursorRepo.upsert(projector.name, event.sequence);
          });
          replayed++;
        } catch (err) {
          this.recordFailure(projector, event, err);
        }
      } else {
        // Non-matching event: just advance cursor
        this.cursorRepo.upsert(projector.name, event.sequence);
      }
    }

    cursor = events[events.length - 1]!.sequence;
  }

  return {
    projectorName: projector.name,
    startCursor: fromCursor,
    endCursor: cursor,
    eventsReplayed: replayed,
    durationMs: Date.now() - startTime,
  };
}

interface ProjectorRecoveryResult {
  projectorName: string;
  startCursor: number;
  endCursor: number;
  eventsReplayed: number;
  durationMs: number;
}
```

**Additionally, add a fast-path skip:** If all projector cursors are equal to the latest event sequence, skip recovery entirely (common case for clean shutdown):

```typescript
recover(): RecoveryResult {
  // Fast path: check if all cursors are caught up
  const latestSeq = this.db.queryOne<{ max_seq: number | null }>(
    "SELECT MAX(sequence) AS max_seq FROM events"
  )?.max_seq ?? 0;

  const allCursors = this.cursorRepo.listAll();
  const allCaughtUp = allCursors.length === this.projectors.length &&
    allCursors.every(c => c.lastAppliedSeq >= latestSeq);

  if (allCaughtUp) {
    this.log?.info("recovery: all projectors caught up, skipping replay");
    return { totalReplayed: 0, durationMs: 0, perProjector: [] };
  }

  // ... per-projector recovery as above ...
}
```

**Impact:** Typical startup (clean shutdown, all caught up) skips recovery entirely — 0ms. Partial recovery replays only the events the lagging projector missed, not the entire event store. A fresh projector replays only events matching its handled types, ignoring ~80% of events (deltas, etc.) that it doesn't care about.

---

## P8. Add Missing Indexes for Phase 4 Read Queries

**Phase:** 1 | **Task:** 3 (Schema) | **Severity:** High

### Problem

Several Phase 4 `ReadQueryService` queries will use suboptimal access paths:

| Query | Issue |
|-------|-------|
| `turns` lookup by `assistant_message_id` | `turn.completed/error/interrupted` all `WHERE assistant_message_id = ?`. No index exists. |
| `getSessionMessages` cursor pagination with composite `(created_at, id)` | Index is `(session_id, created_at)` — the `id` column is not in the index, requiring table lookups for the `id` filter in the cursor condition. |
| `listSessions` with correlated subquery `(SELECT MAX(m.created_at) FROM messages)` | Runs a subquery per session row. At 100 sessions × 1000 messages each, it's 100 index seeks. |

### Fix

Add the following indexes to migration 001 in `schema.ts`:

```typescript
// In createEventStoreTables(), after the existing turns indexes:
db.execute(
  "CREATE INDEX idx_turns_assistant_message ON turns (assistant_message_id)",
);

// After the existing messages indexes, replace:
//   "CREATE INDEX idx_messages_session_created ON messages (session_id, created_at)"
// with a covering index that includes id for cursor-based pagination:
db.execute(
  "CREATE INDEX idx_messages_session_created ON messages (session_id, created_at DESC, id DESC)",
);
```

For the `listSessions` correlated subquery issue, denormalize `last_message_at` onto the sessions table:

```typescript
// In createEventStoreTables(), add column to sessions table:
db.execute(`
  CREATE TABLE sessions (
    ...existing columns...
    last_message_at  INTEGER,
    ...
  )
`);
```

Update the `MessageProjector` to maintain it:

```typescript
// In MessageProjector, on message.created:
if (isEventType(event, "message.created")) {
  // ... existing INSERT INTO messages ...

  // Denormalize last_message_at on the session
  db.execute(
    "UPDATE sessions SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?",
    [event.createdAt, event.data.sessionId],
  );
  return;
}
```

Then `listSessions` becomes:

```sql
SELECT * FROM sessions ORDER BY COALESCE(last_message_at, updated_at) DESC
```

No correlated subquery needed.

**Impact:** Eliminates full table scans and correlated subqueries for the most common UI queries. The `idx_turns_assistant_message` index is critical — without it, every `turn.completed` event does a full scan of the turns table.

---

## P9. Add Size Limits to Translator and Seeder Maps

**Phase:** 2 | **Task:** 7, 9 (Translator, Seeder) | **Severity:** Low

### Problem

`CanonicalEventTranslator.trackedParts` (Map) and `SessionSeeder.seenSessions` (Set) grow without bound. The existing relay `Translator` has FIFO eviction at 10,000 entries; the canonical translator has none.

### Fix

Add the same FIFO eviction to the canonical translator:

```typescript
// In CanonicalEventTranslator:
private static readonly MAX_TRACKED_PARTS = 10_000;
private static readonly EVICTION_COUNT = 2_000;

private trackPart(partId: string, part: TrackedPart): void {
  this.trackedParts.set(partId, part);
  if (this.trackedParts.size > CanonicalEventTranslator.MAX_TRACKED_PARTS) {
    let evicted = 0;
    for (const key of this.trackedParts.keys()) {
      this.trackedParts.delete(key);
      if (++evicted >= CanonicalEventTranslator.EVICTION_COUNT) break;
    }
  }
}
```

For the SessionSeeder, either add eviction or use periodic clear (sessions are seeded once and rarely need re-seeding):

```typescript
// In SessionSeeder:
private static readonly MAX_SEEN = 10_000;

ensureSession(sessionId: string, provider: string): boolean {
  if (this.seenSessions.has(sessionId)) return false;
  // ... INSERT OR IGNORE ...
  this.seenSessions.add(sessionId);
  if (this.seenSessions.size > SessionSeeder.MAX_SEEN) {
    // Clear and let next access re-seed (INSERT OR IGNORE is idempotent)
    this.seenSessions.clear();
  }
  return true;
}
```

**Impact:** Prevents unbounded memory growth over long daemon lifetimes. Negligible CPU cost.

---

## P10. Use Multi-Row INSERT in appendBatch()

**Phase:** 1 | **Task:** 5 (EventStore) | **Severity:** Medium

### Problem

`appendBatch()` calls `append()` N times inside a transaction. Each call does individual `JSON.stringify` + INSERT + RETURNING. The COALESCE subquery for stream version computation is the main obstacle to a true multi-row INSERT.

### Fix

Since P4 introduces an in-memory version cache, `appendBatch()` can pre-compute all versions and use a single multi-row INSERT:

```typescript
appendBatch(events: readonly CanonicalEvent[]): StoredEvent[] {
  if (events.length === 0) return [];

  return this.db.runInTransaction(() => {
    const results: StoredEvent[] = [];
    // Pre-fetch versions for all sessions in this batch
    const sessionIds = [...new Set(events.map(e => e.sessionId))];
    const versions = new Map<string, number>();
    for (const sid of sessionIds) {
      versions.set(sid, this.versionCache.get(sid) ?? this.getNextStreamVersion(sid));
    }

    for (const event of events) {
      validateEventPayload(event);
      const version = versions.get(event.sessionId)!;
      const dataJson = JSON.stringify(event.data);
      const metadataJson = JSON.stringify(event.metadata);

      const rows = this.db.query<EventRow>(
        `INSERT INTO events (event_id, session_id, stream_version, type, data, metadata, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at`,
        [event.eventId, event.sessionId, version, event.type, dataJson, metadataJson, event.provider, event.createdAt],
      );

      versions.set(event.sessionId, version + 1);
      this.versionCache.set(event.sessionId, version + 1);
      results.push(this.rowToStoredEvent(rows[0]!));
    }
    return results;
  });
}
```

This isn't a true multi-row INSERT (SQLite's `RETURNING` clause with multi-row INSERT is limited), but it eliminates the COALESCE subquery per row and pre-computes versions, reducing index lookups.

**Impact:** Modest improvement for batch operations (e.g., SSE events that produce 2-3 canonical events). The main benefit is eliminating the COALESCE subquery overhead per row.

---

## P11. Add Event Store Write-Rate Observability

**Phase:** 2 | **Task:** 10 (DualWriteHook) or 3.5 (new task) | **Severity:** Medium

### Problem

From the [further recommendations](./2026-04-07-orchestrator-plan-further-recommendations.md) (C2): "EventSinkImpl.push() calls eventStore.append() + projectionRunner.projectEvent() synchronously for every SDK event. During high-throughput periods, there's no visibility into throughput, backpressure, or latency."

The DualWriteHook tracks `eventsReceived/Written/Skipped/errors` but not timing. When the system feels slow, there's no data to determine whether the bottleneck is SQLite writes, JSON serialization, projection, or something upstream.

### Fix

Add timing instrumentation to the DualWriteHook and/or EventStore:

```typescript
// In DualWriteHook, extend DualWriteStats:
export interface DualWriteStats {
  readonly eventsReceived: number;
  readonly eventsWritten: number;
  readonly eventsSkipped: number;
  readonly errors: number;
  // New timing fields:
  readonly totalTranslateMs: number;
  readonly totalAppendMs: number;
  readonly totalProjectMs: number;
  readonly peakAppendMs: number;
  readonly peakProjectMs: number;
}

// In onSSEEvent(), instrument each step:
onSSEEvent(event: OpenCodeEvent, sessionId: string | undefined): DualWriteResult {
  // ... existing checks ...
  const t0 = performance.now();
  const result = this.translator.translate(event, sessionId);
  const t1 = performance.now();
  this._totalTranslateMs += t1 - t0;

  // ... seeding ...

  for (const evt of result.events) {
    const tAppend0 = performance.now();
    const stored = this.persistence.eventStore.append(enriched as CanonicalEvent);
    const tAppend1 = performance.now();

    this.persistence.projectionRunner.projectEvent(stored);
    const tProject1 = performance.now();

    this._totalAppendMs += tAppend1 - tAppend0;
    this._totalProjectMs += tProject1 - tAppend1;
    this._peakAppendMs = Math.max(this._peakAppendMs, tAppend1 - tAppend0);
    this._peakProjectMs = Math.max(this._peakProjectMs, tProject1 - tAppend1);
    this._eventsWritten++;
  }
  // ...
}
```

Wire `getStats()` into `PersistenceDiagnostics.health()` so a single diagnostic call shows the full performance picture.

**Impact:** Transforms debugging from "the system feels slow" to "event store append averages 0.3ms, projection averages 2.1ms, peak projection was 15ms on a tool.started event." Actionable data for identifying which optimization to pursue.

---

## P12. Add Schema CHECK Constraints for Type Safety

**Phase:** 1 | **Task:** 3 (Schema) | **Severity:** Low

### Problem

TEXT columns for `sessions.status`, `messages.role`, `turns.state`, etc. accept any string. The plan defines TypeScript const arrays (`SESSION_STATUSES`, `MESSAGE_ROLES`) but SQLite doesn't enforce them. A projector bug writing `status = 'buzy'` (typo) goes undetected until the UI breaks.

### Fix

Add CHECK constraints to the schema migration:

```typescript
// In createEventStoreTables(), modify the CREATE TABLE statements:

db.execute(`
  CREATE TABLE sessions (
    id              TEXT    PRIMARY KEY,
    provider        TEXT    NOT NULL,
    provider_sid    TEXT,
    title           TEXT    NOT NULL DEFAULT 'Untitled',
    status          TEXT    NOT NULL DEFAULT 'idle'
                    CHECK(status IN ('idle', 'busy', 'retry', 'error')),
    parent_id       TEXT,
    fork_point_event TEXT,
    last_message_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES sessions(id)
  )
`);

db.execute(`
  CREATE TABLE messages (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    turn_id         TEXT,
    role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
    -- ... rest unchanged ...
  )
`);

db.execute(`
  CREATE TABLE turns (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    state           TEXT    NOT NULL DEFAULT 'pending'
                    CHECK(state IN ('pending', 'running', 'completed', 'interrupted', 'error')),
    -- ... rest unchanged ...
  )
`);

db.execute(`
  CREATE TABLE pending_approvals (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL,
    turn_id         TEXT,
    type            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'approved', 'rejected')),
    -- ... rest unchanged ...
  )
`);
```

Since migration 001 hasn't been applied in production, these can be added directly to the existing migration. No new migration needed.

**Impact:** SQLite catches invalid values at write time with a clear constraint error, preventing corrupt projection state from reaching the database.

---

## Summary: Priority and Phase Mapping

| # | Recommendation | Severity | Phase | Task | Impact |
|---|----------------|----------|-------|------|--------|
| P1 | Buffer streaming deltas | Critical | 3 | 16 | 15× fewer SQL statements during streaming |
| P2 | Batch cursor advances | Critical | 3 | 21 | 83× fewer cursor writes during streaming |
| P3 | Skip `alreadyApplied()` during normal ops | High | 3 | 16 | -50 SELECTs/sec during streaming |
| P4 | Cache stream version in-memory | Medium | 1 | 5 | -1 index lookup per append |
| P5 | Defer projection off SSE handler | High | 2 | 11 | 10× less event loop blocking |
| P6 | Event store eviction | Critical | 7 | 51 | Prevents unbounded DB growth |
| P7 | Per-projector recovery | High | 3 | 22 | 0ms startup for caught-up projectors |
| P8 | Missing indexes | High | 1 | 3 | Prevents table scans on common queries |
| P9 | Translator/seeder map limits | Low | 2 | 7, 9 | Prevents unbounded memory growth |
| P10 | Multi-row batch INSERT | Medium | 1 | 5 | Modest batch-operation improvement |
| P11 | Write-rate observability | Medium | 2 | 10 | Actionable perf diagnostics |
| P12 | Schema CHECK constraints | Low | 1 | 3 | Catches invalid values at write time |

### Recommended Application Order

**During Phase 1 implementation (apply inline):**
- P4 (version cache) — changes EventStore constructor, trivial
- P8 (missing indexes) — add to schema migration before it's first applied
- P12 (CHECK constraints) — add to schema migration before it's first applied

**During Phase 2 implementation (apply inline):**
- P9 (map limits) — trivial addition to translator and seeder
- P11 (observability) — extend DualWriteStats

**During Phase 3 implementation (apply inline):**
- P1 (delta buffer) — affects MessageProjector architecture, must be designed before implementation
- P2 (cursor batching) — affects ProjectionRunner, apply when writing Task 21
- P3 (replay flag) — affects Projector interface, apply when writing Task 14
- P7 (per-projector recovery) — affects Task 22, fundamental change to recovery strategy

**During Phase 2-3 boundary (apply as amendment):**
- P5 (deferred projection) — changes DualWriteHook wiring, can be applied retroactively

**During Phase 7 implementation (apply inline):**
- P6 (eviction) — replaces the hand-waved eviction in Task 51
