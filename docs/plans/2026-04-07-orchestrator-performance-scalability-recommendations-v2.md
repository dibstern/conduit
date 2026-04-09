# Orchestrator Plan: Performance & Scalability Recommendations (v2)

> Supersedes [v1](./2026-04-07-orchestrator-performance-scalability-recommendations.md).
>
> v2 re-evaluates every v1 recommendation against the t3code reference implementation, SQLite best practices, and CQRS patterns. Several v1 recommendations were over-engineered or solving symptoms rather than root causes. This revision corrects those, drops premature optimizations, and introduces a normalized `message_parts` table as the primary structural improvement.

---

## What Changed From v1

| v1 | v2 | Why |
|----|----|----|
| P1: ProjectionDeltaBuffer class | **P1: Normalize `message_parts` table** | Buffer reduces frequency of a bad pattern. Normalization eliminates the pattern. |
| P3: `replaying` flag on ProjectionContext | **Folded into P1** | With normalized parts, `text = text \|\| ?` is inherently idempotent. No `alreadyApplied()` check needed for deltas. Flag retained only for tool-part idempotency. |
| P4: In-memory version cache | **P4: Kept but marked measure-first** | COALESCE subquery is ~10μs. Design included for completeness; implement only if P11 data justifies it. |
| P5: Deferred projection via queueMicrotask | **P5: Kept with conservative rollout** | Start synchronous, defer selectively after P11 confirms which event types are safe. |
| P6: Three-tier eviction | **P6: Simplified to age-based session eviction** | Per-message compaction via `json_extract` is a full-table-scan disaster. Session-level eviction is one indexed query. |
| P10: Multi-row batch INSERT | **Dropped** | Marginal gain, depends on P4, adds complexity. |
| P9: Map limits | **Folded into implementation notes** | Correct but trivial — doesn't warrant a named recommendation. |

---

## P1. Normalize Message Parts Into a `message_parts` Table

**Phase:** 1 (Schema), 3 (MessageProjector) | **Severity:** Critical

### Problem (unchanged from v1)

The `parts` JSON column on the `messages` table forces a read-parse-modify-serialize-write cycle on every streaming delta. At 50 tokens/sec, this is 50 full JSON round-trips per second. The v1 fix (ProjectionDeltaBuffer) reduces the frequency to ~5/sec but doesn't eliminate the underlying cost.

### Root Cause

The schema stores a heterogeneous array of typed objects (text blocks, thinking blocks, tool calls) as a single JSON TEXT column. This forces every mutation to deserialize the entire array, find the target element by linear scan, mutate it, and re-serialize everything — even when only one element's text field changed.

t3code avoids this entirely: its messages table has a flat `text` column with no parts concept. Tool calls, thinking, and text are separate domain concepts with their own projection logic. Conduit needs structured parts for the frontend, but the storage should be normalized.

### Fix: `message_parts` Table

**Schema addition (Task 3):**

```sql
CREATE TABLE message_parts (
    id          TEXT    PRIMARY KEY,
    message_id  TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool')),
    text        TEXT    NOT NULL DEFAULT '',
    tool_name   TEXT,
    call_id     TEXT,
    input       TEXT,       -- JSON for tool input
    result      TEXT,       -- JSON for tool result
    duration    REAL,
    status      TEXT,
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id)
);
CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order);
```

**Remove the `parts` TEXT column from the `messages` table.** The `text` column on `messages` remains as a denormalized aggregate of all text-type parts (for full-text search and quick display).

**MessageProjector changes (Task 16):**

The hot path — `text.delta` — becomes two SQL statements with zero JSON:

```typescript
if (isEventType(event, "text.delta")) {
    // Upsert the part row, appending text via SQL concat
    db.execute(
        `INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
         VALUES (?, ?, 'text', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
             text = message_parts.text || excluded.text,
             updated_at = excluded.updated_at`,
        [event.data.partId, event.data.messageId, event.data.text,
         this.getNextSortOrder(db, event.data.messageId),
         event.createdAt, event.createdAt],
    );

    // Update the denormalized text column on the message
    db.execute(
        `UPDATE messages SET text = text || ?, updated_at = ? WHERE id = ?`,
        [event.data.text, event.createdAt, event.data.messageId],
    );
    return;
}
```

Key properties:
- **Zero reads.** No `SELECT parts FROM messages`, no `JSON.parse`, no `readParts()`.
- **Zero JSON.** SQLite handles `text || ?` natively without materializing the old value in Node.js.
- **Inherently idempotent for replay.** The `ON CONFLICT DO UPDATE SET text = text || excluded.text` is idempotent if events are replayed in order (same text appended again). For true idempotency during cursor-rewind replay, the `last_applied_seq` check from v1's P3 can be retained as a guard — but only during recovery, not during normal streaming.
- **O(n) per delta where n is accumulated text length.** SQLite's `text || ?` reads and copies the existing value. Total work across all deltas for a message is O(n²). This is negligible for typical message sizes (5K chars → ~128KB total copies) but would be material for very large streaming outputs (100K+ chars). In practice, large content arrives via `tool.completed` (single write, not streaming deltas), so the quadratic cost is not a concern for real workloads. If profiling reveals this is an issue, replace SQL concat with offset-tracking (store offset + append, reconstruct on read).

**Tool lifecycle becomes direct row operations:**

```typescript
if (isEventType(event, "tool.started")) {
    db.execute(
        `INSERT INTO message_parts
         (id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
         VALUES (?, ?, 'tool', ?, ?, ?, 'started', ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [event.data.partId, event.data.messageId, event.data.toolName,
         event.data.callId, encodeJson(event.data.input),
         this.getNextSortOrder(db, event.data.messageId),
         event.createdAt, event.createdAt],
    );
    return;
}

if (isEventType(event, "tool.completed")) {
    db.execute(
        `UPDATE message_parts
         SET result = ?, duration = ?, status = 'completed', updated_at = ?
         WHERE id = ?`,
        [encodeJson(event.data.result), event.data.duration, event.createdAt, event.data.partId],
    );
    return;
}
```

**Frontend read path (ReadQueryService):**

```typescript
getMessageParts(messageId: string): MessagePartRow[] {
    return this.db.query<MessagePartRow>(
        `SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order`,
        [messageId],
    );
}

getSessionMessagesWithParts(sessionId: string): MessageWithParts[] {
    const messages = this.db.query<MessageRow>(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at`,
        [sessionId],
    );
    // Batch-load all parts for all messages in one query
    const messageIds = messages.map(m => m.id);
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    const parts = this.db.query<MessagePartRow>(
        `SELECT * FROM message_parts WHERE message_id IN (${placeholders}) ORDER BY message_id, sort_order`,
        messageIds,
    );
    // Group parts by message_id
    const partsByMessage = new Map<string, MessagePartRow[]>();
    for (const part of parts) {
        let arr = partsByMessage.get(part.message_id);
        if (!arr) { arr = []; partsByMessage.set(part.message_id, arr); }
        arr.push(part);
    }
    return messages.map(m => ({ ...m, parts: partsByMessage.get(m.id) ?? [] }));
}
```

This batch-loads all parts in one query (single index scan on `idx_message_parts_message`) rather than N+1 queries.

**Sort order tracking:**

```typescript
private getNextSortOrder(db: SqliteClient, messageId: string): number {
    const row = db.queryOne<{ max_order: number | null }>(
        `SELECT MAX(sort_order) AS max_order FROM message_parts WHERE message_id = ?`,
        [messageId],
    );
    return (row?.max_order ?? -1) + 1;
}
```

This is only called on part-creation events (`text.delta` for new parts, `thinking.start`, `tool.started`), not on subsequent deltas for existing parts.

### Replay Idempotency

- `text.delta` / `thinking.delta`: The `ON CONFLICT DO UPDATE SET text = text || excluded.text` will double text on replay. Retain the `last_applied_seq` column on `messages` and the `replaying` context flag from v1's P3. During replay, check before appending. During normal streaming, skip the check.
- `tool.started` / `thinking.start`: `ON CONFLICT DO NOTHING` is naturally idempotent.
- `tool.running` / `tool.completed`: `UPDATE ... WHERE id = ?` with final-state values is naturally idempotent.

### Impact

Eliminates the entire readParts/validateParts/encodeJson/readModifyWrite machinery from the MessageProjector. Per-delta cost drops from ~3 SQL statements + JSON round-trip to 2 simple UPDATEs (or 1 UPSERT + 1 UPDATE for new parts). The `ProjectionDeltaBuffer` class, flush timer, and flush-before-modify protocol are all unnecessary.

---

## P2. Batch Cursor Advances With Lazy Sync

**Phase:** 3 | **Task:** 21 | **Severity:** Critical

### Problem (unchanged)

Non-matching projectors get individual cursor UPSERTs per event — 5 writes/event for `text.delta`.

### Fix: Lazy Sync (v1 Option A) + Global High-Water Mark

Replace per-projector non-matching cursor advances with a single `global_high_water` value:

```typescript
private highWaterMark = 0;
private readonly CURSOR_SYNC_INTERVAL = 100;
private eventsSinceSync = 0;

projectEvent(event: StoredEvent): void {
    const matching = this.projectorsByEventType.get(event.type) ?? [];

    for (const projector of matching) {
        try {
            this.db.runInTransaction(() => {
                projector.project(event, this.db, { replaying: this._replaying });
                this.cursorRepo.upsert(projector.name, event.sequence);
            });
        } catch (err) {
            this.recordFailure(projector, event, err);
        }
    }

    this.highWaterMark = event.sequence;
    this.eventsSinceSync++;
    if (this.eventsSinceSync >= this.CURSOR_SYNC_INTERVAL) {
        this.flushCursors();
    }
}

/** Advance all projector cursors to the high-water mark. */
flushCursors(): void {
    if (this.eventsSinceSync === 0) return;
    this.db.runInTransaction(() => {
        for (const projector of this.projectors) {
            this.cursorRepo.upsert(projector.name, this.highWaterMark);
        }
    });
    this.eventsSinceSync = 0;
}
```

Call `flushCursors()` on `PersistenceLayer.close()` for clean shutdown. After unclean shutdown, recovery replays from the per-projector cursor, which is at most 100 events behind.

### Impact

Reduces non-matching cursor writes from 5/event to 6/100-events.

---

## P3. Replay-Only Idempotency Guard

**Phase:** 3 | **Task:** 14, 16 | **Severity:** High

### Problem (unchanged)

`alreadyApplied()` runs a SELECT per delta during normal streaming.

### Fix

The `replaying` flag from v1 is retained, but its scope is narrower with normalization. It's only needed for the `text || ?` append path (text.delta, thinking.delta), not for tool lifecycle events which are naturally idempotent.

```typescript
export interface ProjectionContext {
    readonly replaying: boolean;
}

// In MessageProjector, for text.delta:
if (isEventType(event, "text.delta")) {
    if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;
    // ... SQL-native append as in P1 ...
}
```

During normal streaming, the check is skipped. During recovery, it prevents text doubling.

---

## P4. In-Memory Stream Version Cache (Measure-First)

**Phase:** 1 | **Task:** 5 | **Severity:** Low (implement only if P11 data warrants it)

### Problem

The COALESCE subquery for stream version computation hits an index on every append.

### Assessment

The B-tree seek is ~10μs. At 50 events/sec, that's 0.5ms/sec — negligible. t3code uses the same COALESCE pattern and doesn't cache.

### Fix (deferred)

The v1 implementation is technically correct. Include it in the codebase behind a flag or as a commented-out optimization:

```typescript
// Optimization: uncomment if P11 profiling shows COALESCE is >1% of append time.
// private readonly versionCache = new Map<string, number>();
```

If P11 shows the COALESCE is a bottleneck (unlikely), enable the cache. Otherwise, leave it.

---

## P5. Selective Deferred Projection (Measure-First)

**Phase:** 2-3 boundary | **Task:** 11 | **Severity:** High

### Problem (unchanged)

Synchronous projection blocks the event loop.

### Fix: Conservative Rollout

**Step 1:** Implement P11 (observability) first. Measure `totalProjectMs` and `peakProjectMs` under real load.

**Step 2:** If peak projection time exceeds 5ms (blocking threshold for smooth WebSocket delivery), introduce selective deferral:

```typescript
// Event types where downstream code reads the projection synchronously:
const SYNC_PROJECT_TYPES = new Set([
    "session.status",
    "session.created",
    "session.renamed",
    "permission.asked",
    "permission.resolved",
    "question.asked",
    "question.resolved",
]);

// In DualWriteHook.onSSEEvent(), after eventStore.append():
if (SYNC_PROJECT_TYPES.has(stored.type)) {
    this.persistence.projectionRunner.projectEvent(stored);
} else {
    queueMicrotask(() => {
        try {
            this.persistence.projectionRunner.projectEvent(stored);
        } catch (err) {
            this.log.warn("deferred projection failed", {
                sequence: stored.sequence, type: stored.type,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
```

**Step 3:** The `SYNC_PROJECT_TYPES` set should be derived from an audit of what reads projections synchronously after `handleSSEEvent()` returns. The current list is a starting point; verify against:
- Permission bridge reads (`pending_approvals`)
- Session list broadcasts (`sessions`)
- Session status notifications (`sessions.status`)

**If P11 shows projection is consistently <2ms**, skip this optimization entirely. The event loop blocking is not a real problem at that latency.

---

## P6. Age-Based Event Store Eviction

**Phase:** 7 | **Task:** 51 | **Severity:** Critical

### Problem (unchanged)

Events table grows unbounded.

### v1 Flaw

v1's `compactCompletedMessages()` uses `json_extract(data, '$.messageId')` in a DELETE — full table scan with JSON parsing per row. At 100K events this takes minutes.

### Fix: Simple Session-Level Age-Based Eviction

One indexed query, no JSON parsing:

```typescript
export class EventStoreEviction {
    constructor(
        private readonly db: SqliteClient,
        private readonly log?: Logger,
    ) {}

    /**
     * Delete events for idle sessions older than the retention period.
     * Projection rows (sessions, messages, turns, message_parts) remain
     * as the queryable history. Only the raw event store rows are evicted.
     *
     * @param retentionMs - How old a session must be before its events are evicted.
     *                      Default: 7 days.
     */
    evictOldSessionEvents(retentionMs: number = 7 * 24 * 60 * 60 * 1000): EvictionResult {
        const cutoff = Date.now() - retentionMs;

        const result = this.db.execute(
            `DELETE FROM events WHERE session_id IN (
                 SELECT id FROM sessions
                 WHERE status = 'idle'
                   AND updated_at < ?
             )`,
            [cutoff],
        );

        const evicted = Number(result.changes);
        if (evicted > 0) {
            this.log?.info(`evicted ${evicted} events from sessions idle since ${new Date(cutoff).toISOString()}`);
        }

        return { eventsDeleted: evicted };
    }

    /**
     * Reclaim disk space after eviction. VACUUM rewrites the entire
     * database file — run infrequently (daily or on explicit trigger).
     */
    vacuum(): void {
        this.db.execute("VACUUM");
    }
}

interface EvictionResult {
    eventsDeleted: number;
}
```

> **Amendment (Perf-Fix-3, Perf-Fix-5):** Eviction now includes `command_receipts` cleanup — deletes receipts older than the retention period, independent of session status. Also, the DELETE is batched with LIMIT to avoid event-loop blocking (see Perf-Fix-3 for `evictSync()`/`evictAsync()` implementation).

**Wiring:**

```typescript
// In Daemon, periodic eviction (e.g., hourly):
setInterval(() => {
    persistence.eviction.evictOldSessionEvents();
}, 60 * 60 * 1000);
```

This uses the `idx_sessions_updated` index on the subquery and the `events.session_id` FK index for the DELETE.

**Future enhancement:** If per-message delta compaction is later needed, add a `message_id` column to the events table (denormalized from JSON payload) and index it. Then:

```sql
DELETE FROM events
WHERE type IN ('text.delta', 'thinking.delta', 'thinking.start', 'thinking.end', 'tool.running')
  AND message_id IN (SELECT id FROM messages WHERE is_streaming = 0)
```

This requires the schema change first and should only be pursued if the age-based eviction proves insufficient.

---

## P7. Per-Projector Recovery With SQL-Level Type Filtering

**Phase:** 3 | **Task:** 22 | **Severity:** High

### Fix (enhanced from v1)

v1's per-projector recovery is correct but reads ALL events and skips non-matching ones in TypeScript. This wastes I/O and deserialization. Filter at the SQL level:

```typescript
private recoverProjector(projector: Projector, fromCursor: number): ProjectorRecoveryResult {
    const startTime = Date.now();
    let replayed = 0;
    let cursor = fromCursor;

    // Build type filter for SQL
    const handledTypes = projector.handles;
    const placeholders = handledTypes.map(() => '?').join(', ');

    while (true) {
        // Only fetch events this projector actually handles
        const events = this.db.query<EventRow>(
            `SELECT * FROM events
             WHERE sequence > ? AND type IN (${placeholders})
             ORDER BY sequence ASC
             LIMIT ?`,
            [cursor, ...handledTypes, BATCH_SIZE],
        );
        if (events.length === 0) break;

        for (const event of events) {
            try {
                this.db.runInTransaction(() => {
                    projector.project(this.rowToStoredEvent(event), this.db, { replaying: true });
                    this.cursorRepo.upsert(projector.name, event.sequence);
                });
                replayed++;
            } catch (err) {
                this.recordFailure(projector, event, err);
            }
        }

        cursor = events[events.length - 1]!.sequence;
    }

    // Advance cursor to the global max (skip all non-matching events)
    const maxSeq = this.db.queryOne<{ max_seq: number | null }>(
        "SELECT MAX(sequence) AS max_seq FROM events",
    )?.max_seq;
    if (maxSeq != null && maxSeq > cursor) {
        this.cursorRepo.upsert(projector.name, maxSeq);
    }

    return {
        projectorName: projector.name,
        startCursor: fromCursor,
        endCursor: maxSeq ?? cursor,
        eventsReplayed: replayed,
        durationMs: Date.now() - startTime,
    };
}
```

The fast-path skip from v1 is retained:

```typescript
recover(): RecoveryResult {
    const latestSeq = this.db.queryOne<{ max_seq: number | null }>(
        "SELECT MAX(sequence) AS max_seq FROM events",
    )?.max_seq ?? 0;

    const allCursors = this.cursorRepo.listAll();
    const allCaughtUp = allCursors.length === this.projectors.length &&
        allCursors.every(c => c.lastAppliedSeq >= latestSeq);

    if (allCaughtUp) {
        this.log?.info("recovery: all projectors caught up, skipping replay");
        return { totalReplayed: 0, durationMs: 0, perProjector: [] };
    }

    // Per-projector recovery
    const perProjector: ProjectorRecoveryResult[] = [];
    let totalReplayed = 0;
    for (const projector of this.projectors) {
        const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
        if (cursor >= latestSeq) continue; // This projector is caught up
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
```

### Impact

Recovery fetches only events matching the projector's `handles` list. For a MessageProjector catching up on 10K events, this skips ~40% of events (session.*, permission.*, question.*) at the SQL level. The `idx_events_type` index makes the filtered query efficient.

---

## P8. Missing Indexes + `last_message_at` Denormalization

**Phase:** 1 | **Task:** 3 | **Severity:** High

### Fix (adjusted from v1)

```sql
-- Index for TurnProjector's WHERE assistant_message_id = ?
CREATE INDEX idx_turns_assistant_message ON turns (assistant_message_id);

-- Covering index for cursor-based message pagination
CREATE INDEX idx_messages_session_created ON messages (session_id, created_at DESC, id DESC);

-- Index for message_parts lookups (from P1)
CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order);
```

**`last_message_at` denormalization — owned by SessionProjector, not MessageProjector:**

v1 had the MessageProjector updating the sessions table, which crosses projector boundaries. Instead, have the SessionProjector handle `message.created` events:

```typescript
// In SessionProjector, add "message.created" to handles:
readonly handles = [
    "session.created",
    "session.renamed",
    "session.status",
    "session.provider_changed",
    "turn.completed",
    "turn.error",
    "message.created",  // ← added for last_message_at
] as const;

// In project():
if (isEventType(event, "message.created")) {
    db.execute(
        `UPDATE sessions SET
            last_message_at = MAX(COALESCE(last_message_at, 0), ?),
            updated_at = ?
         WHERE id = ?`,
        [event.createdAt, event.createdAt, event.data.sessionId],
    );
    return;
}
```

This keeps all session-table mutations in the SessionProjector.

---

## P11. Write-Rate Observability

**Phase:** 2 | **Task:** 10 | **Severity:** Medium

### Fix (unchanged from v1)

Add `performance.now()` timing to the DualWriteHook's `onSSEEvent()`:

```typescript
export interface DualWriteStats {
    readonly eventsReceived: number;
    readonly eventsWritten: number;
    readonly eventsSkipped: number;
    readonly errors: number;
    readonly totalTranslateMs: number;
    readonly totalAppendMs: number;
    readonly totalProjectMs: number;
    readonly peakAppendMs: number;
    readonly peakProjectMs: number;
}
```

This is the prerequisite for validating P4 and P5. If `peakProjectMs` stays under 2ms, P5 is unnecessary. If `totalAppendMs` shows the COALESCE subquery is negligible, P4 is unnecessary.

---

## P12. Schema CHECK Constraints

**Phase:** 1 | **Task:** 3 | **Severity:** Low

### Fix (unchanged from v1)

Add CHECK constraints to all status/role/state/type columns in the schema migration:

```sql
status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'retry', 'error'))
role TEXT NOT NULL CHECK(role IN ('user', 'assistant'))
state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'completed', 'interrupted', 'error'))
```

Free win since the migration hasn't been applied yet.

---

## Dropped Recommendations

| v1 # | Recommendation | Why Dropped |
|-------|---------------|-------------|
| P9 | Translator/seeder map limits | Correct but trivial. Apply as a code review comment, not a numbered recommendation. Copy the existing relay Translator's 10K/2K FIFO eviction pattern. |
| P10 | Multi-row batch INSERT | Marginal gain. The original `appendBatch()` wrapping individual `append()` calls in a transaction is already efficient — WAL mode coalesces the writes at the SQLite level. |

---

## Summary: Priority and Phase Mapping

| # | Recommendation | Severity | Phase | Impact |
|---|----------------|----------|-------|--------|
| P1 | Normalize `message_parts` table | Critical | 1, 3 | Eliminates JSON parse/serialize from hot path. O(n) per delta (see P1 section for analysis). |
| P2 | Lazy cursor sync | Critical | 3 | 83× fewer cursor writes during streaming. |
| P3 | Replay-only idempotency guard | High | 3 | -50 SELECTs/sec during normal streaming. |
| P4 | Stream version cache | Low | 1 | ~0.5ms/sec savings. Implement only if P11 justifies. |
| P5 | Selective deferred projection | High | 2-3 | 10× less event loop blocking. Implement only if P11 justifies. |
| P6 | Age-based session event eviction | Critical | 7 | Prevents unbounded DB growth. One indexed query. |
| P7 | Per-projector recovery + SQL filtering | High | 3 | 0ms startup when caught up. Type-filtered replay. |
| P8 | Missing indexes + `last_message_at` | High | 1 | Prevents table scans on common queries. |
| P11 | Write-rate observability | Medium | 2 | Prerequisite for validating P4 and P5. |
| P12 | Schema CHECK constraints | Low | 1 | Catches invalid values at write time. |

### Recommended Application Order

**During Phase 1 (apply inline to schema before first migration run):**
- P1 schema: add `message_parts` table, remove `parts` column from messages
- P8: add missing indexes, `last_message_at` column
- P12: add CHECK constraints

**During Phase 2 (apply inline):**
- P11: timing instrumentation in DualWriteHook

**During Phase 3 (apply inline):**
- P1 projector: rewrite MessageProjector to use `message_parts` + SQL concat
- P2: lazy cursor sync in ProjectionRunner
- P3: `replaying` flag on ProjectionContext
- P7: per-projector recovery with SQL type filtering

**After Phase 3, based on P11 data:**
- P4: if COALESCE is >1% of append time, enable version cache
- P5: if peak projection >5ms, enable selective deferral

**During Phase 7:**
- P6: age-based session event eviction
