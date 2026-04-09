# Orchestrator Performance & Scalability Solutions

**Date:** 2026-04-07
**Status:** Proposed
**Scope:** High-level design solutions for all performance and scalability gaps identified in the orchestrator plan audit.
**Parent:** `2026-04-05-orchestrator-implementation-plan.md`
**Related:** `2026-04-07-orchestrator-performance-scalability-recommendations-v2.md`, `2026-04-07-orchestrator-performance-fixes.md`

---

## Context

The orchestrator plan has been through several performance review rounds (v1, v2, perf-fixes, concurrency hardening). The original read-modify-write disaster on the `parts` JSON column has been solved by normalizing to `message_parts`. Several other critical issues have been addressed.

This document designs solutions for the remaining gaps, organized by severity. Each solution is described at the architecture level — what the approach is, why it works, and what it touches — without inline code.

---

## Solution 1: Relay-First Write Ordering

**Addresses:** Synchronous dual-write blocks the relay pipeline (the single most architecturally damaging issue).

### Problem

The dual-write hook is called at the TOP of `handleSSEEvent()`, before the relay pipeline. Every SSE event — including the high-frequency `text.delta` at 50+/sec — blocks on synchronous SQLite I/O before the browser receives the WebSocket message. This directly contradicts conduit's core value proposition: low-latency relay to the browser.

If SQLite is slow (WAL checkpoint, disk pressure, large transaction from concurrent eviction), the UI stutters. The relay pipeline was designed to be fast and synchronous — making it wait behind database writes inverts the priority.

### Design

Split the dual-write into two tiers based on whether downstream code reads the projection synchronously after `handleSSEEvent()` returns:

**Tier 1 — Synchronous (rare events).** Permission, question, session status, and session creation events where the relay pipeline or handler code reads the projection immediately after. These continue to write synchronously before the relay pipeline, exactly as today.

**Tier 2 — Deferred (high-frequency events).** Everything else — `text.delta`, `thinking.delta`, `tool.started`, `tool.running`, `tool.completed`, `turn.completed`, `message.created`, etc. These are written after the relay pipeline returns, via `queueMicrotask`.

The tier classification is a static set derived from auditing which handlers read projection state after returning from `handleSSEEvent()`. The set is small and stable:

- `session.status` — SessionStatusPoller reads `sessions.status`
- `session.created` — session list queries
- `session.renamed` — session list queries
- `permission.asked` / `permission.resolved` — PermissionBridge reads `pending_approvals`
- `question.asked` / `question.resolved` — QuestionBridge reads pending state

All `text.delta`, `thinking.*`, `tool.*`, `message.*`, `turn.*` events are Tier 2.

**Placement:** Move the `dualWriteHook.onSSEEvent()` call to AFTER the relay pipeline for Tier 2 events. Wrap it in `queueMicrotask` so it executes after the current microtask queue drains (the relay's WebSocket `send()` calls) but before the next I/O event. This gives the relay pipeline zero additional latency while still writing to SQLite within the same event-loop tick.

For Tier 1 events, keep the call before the relay pipeline.

**Implementation shape:** The `DualWriteHook` gains a `shouldWriteSync(eventType)` method that checks membership in the sync set. `handleSSEEvent()` calls it to decide placement. The async path uses `queueMicrotask(() => dualWriteHook.onSSEEvent(event, sessionId))` with a try/catch inside the microtask.

**Why not `setImmediate`?** `queueMicrotask` runs before I/O callbacks (including the next SSE event), so events are still written in order. `setImmediate` would allow interleaving with incoming SSE events, risking out-of-order writes.

---

## Solution 2: Default-Deferred Projection

**Addresses:** Synchronous projection blocks the event loop during normal streaming.

### Problem

CH2 removed all deferred projection, making every event's projection synchronous inside `onSSEEvent()`. P5 is marked "superseded" with a note to reintroduce if P11 measurements justify it. But there is no mechanism to collect P11 measurements before production, and no ready-to-enable deferred path. The first measurement will come from a live daemon that's already stuttering.

### Design

Invert the default: projections are deferred unless they're in the sync-required set (same set as Solution 1's Tier 1). This is architecturally the same as P5 but applied as the default rather than an optimization to enable later.

**The event-store append is always synchronous.** The append must happen before projection so the event is durable. Append cost is ~0.1-0.3ms per event — acceptable.

**Projection is deferred for Tier 2 events.** After `eventStore.append()` returns, the `DualWriteHook` queues `projectionRunner.projectEvent(stored)` via `queueMicrotask`. The projection runs within the same event-loop iteration but after the relay pipeline and WebSocket sends complete.

**Projection is synchronous for Tier 1 events.** The small set of events where handlers read projections immediately. These run `projectionRunner.projectEvent(stored)` inline.

**Ordering guarantee:** Because `queueMicrotask` maintains FIFO order and runs before the next I/O event, deferred projections execute in event order. A `text.delta` at sequence 100 will project before a `text.delta` at sequence 101, even though both are deferred.

**Failure handling:** If a deferred projection fails, the event is already in the store. The `ProjectionRunner`'s recovery mechanism catches up on next startup. The P11 failure counter is incremented. This is the same eventual-consistency guarantee the plan already describes for the separate-transaction strategy.

**Why this is safe:** The relay pipeline never reads from SQLite projections for Tier 2 events. It reads from the in-memory relay state (MessageCache, Translator state, etc.). The SQLite projections are consumed by the ReadQueryService in Phase 4, which runs on separate HTTP request handlers, not in the SSE event path.

---

## Solution 3: Tiered Write Pipeline

**Addresses:** Combines Solutions 1 and 2 into a single coherent design.

This is the unified architecture that replaces the current "synchronous everything at the top of handleSSEEvent" approach:

```
SSE Event arrives
    |
    v
extractSessionId()
    |
    +-- Is event in SYNC_TYPES set?
    |       |
    |       YES: dualWriteHook.onSSEEvent() [sync append + sync project]
    |       |
    |       v
    |   Relay pipeline (translate, broadcast, cache)
    |
    NO:
        |
        v
    Relay pipeline (translate, broadcast, cache)  [runs first, zero delay]
        |
        v
    queueMicrotask: dualWriteHook.onSSEEvent() [append + deferred project]
```

The `SYNC_TYPES` set is small (~7 event types). The remaining ~13 event types (including the high-frequency ones) go through the deferred path. Net effect: the relay pipeline runs at the same speed as before dual-write existed, for 95%+ of events.

---

## Solution 4: Interim Eviction for Phases 2-6

**Addresses:** Unbounded database growth during the weeks between Phase 2 and Phase 7.

### Problem

No eviction mechanism exists until Phase 7. A developer running conduit continuously accumulates ~1.4M events/day. Within a week: 2.7GB database. Recovery on restart at 1M events: 5+ minutes. The Perf-Fix-7 `eventCountWarning` logs a warning but takes no action.

### Design

Add a lightweight startup eviction that runs during `PersistenceLayer` initialization, before any relay stacks are created. This is transitional scaffolding that Phase 7's `EventStoreEviction` replaces.

**Behavior:** On startup, if the events table exceeds a configurable threshold (default: 200K rows), delete events for idle sessions older than 24 hours. Use the same batched DELETE pattern from Perf-Fix-3 (synchronous, since this runs before the relay starts). Log the result.

**Scope:** Events table only. Projection tables are left alone (they're needed for the read path). Command receipts older than 24h are also cleaned.

**Configuration:** A single `interimEvictionThreshold` field on `PersistenceLayer` options. Set to 0 to disable. Default 200K is approximately 1 day of heavy usage.

**Lifecycle:** This code lives in `PersistenceLayer.open()` and is deleted in Phase 7 when `EventStoreEviction` takes over.

**Why not run eviction periodically?** Startup-only is simpler, predictable, and sufficient for development. The daemon restarts frequently during development. For long-running production daemons, Phase 7's periodic eviction handles it.

---

## Solution 5: Cascade Eviction for Projection Tables

**Addresses:** Projection tables (`message_parts`, `activities`, `turns`, etc.) grow without bound even after event eviction.

### Problem

P6's eviction deletes events and command receipts but explicitly leaves projection rows: "Projection rows remain as the queryable history." Over time, `message_parts` (one row per text chunk, tool call, thinking block) becomes the largest table. With ~100K parts per week of active use, this reaches millions of rows in a month.

### Design

Extend the eviction to cascade through projection tables when a session's events are evicted. The cascade order respects foreign key constraints:

1. `activities` (FK to sessions, turns)
2. `pending_approvals` (FK to sessions, turns)
3. `message_parts` (FK to messages)
4. `messages` (FK to sessions, turns)
5. `turns` (FK to sessions)
6. `session_providers` (FK to sessions)
7. `tool_content` (FK to sessions)
8. `provider_state` (FK to sessions)
9. `sessions` row itself

**When to cascade:** Only when ALL events for a session have been evicted AND the session is idle AND the session is older than the retention period. This is a stricter condition than event eviction alone. A session with some events evicted but still within the retention window keeps its projection rows.

**Implementation shape:** After the event DELETE batch loop completes, run a single query to find sessions with zero remaining events that are idle and old. For each such session, delete projection rows in FK-safe order. Batch the session deletions (e.g., 100 sessions per transaction) to avoid blocking.

**Alternative considered: `ON DELETE CASCADE` on foreign keys.** This would automatically delete child rows when a session is deleted. Rejected because (a) it makes accidental session deletion catastrophic, (b) SQLite cascades are synchronous and can't be batched, and (c) the cascade order for message_parts -> messages -> turns requires careful ordering that explicit DELETE statements handle more transparently.

**Alternative considered: Soft-delete sessions.** Mark sessions as `archived` instead of deleting. Keeps history queryable via explicit filter. More complex but preserves data. Reasonable for a future iteration but overkill for the immediate growth problem.

---

## Solution 6: SQLite Runtime Tuning

**Addresses:** WAL checkpoint latency spikes and page cache pressure at scale.

### Problem

The plan sets `journal_mode = WAL` and `synchronous = NORMAL` but configures nothing else. At scale:
- WAL auto-checkpoints at 1000 pages (~4MB). During heavy streaming, the WAL grows to tens of MB before checkpoint, then a checkpoint adds 50-200ms of write latency.
- The default page cache is 2000 pages (~8MB). For a 500MB+ database, cache hit rates drop, turning indexed lookups into disk reads.

### Design

Add three PRAGMA statements to `SqliteClient.init()` for file-backed databases:

**`PRAGMA cache_size = -65536`** (64MB negative value = KB). Gives SQLite enough page cache to keep hot indexes and recent data in memory. At 64MB, the events table's indexes and the message_parts table's covering index fit comfortably in cache for databases up to ~2GB. Memory cost is bounded and predictable.

**`PRAGMA wal_autocheckpoint = 4000`** (~16MB WAL before auto-checkpoint). Quadruples the default, reducing checkpoint frequency during streaming bursts. Larger WAL files use more disk but amortize checkpoint cost over more writes. 16MB is a good balance: large enough to avoid mid-burst checkpoints, small enough to not waste disk.

**`PRAGMA mmap_size = 268435456`** (256MB). Memory-maps the database file for read-only access, bypassing the page cache for cold reads while the page cache handles hot data. Only effective on file-backed databases. Reduces read syscall overhead for large range scans (recovery replay, session history loads). No effect on in-memory test databases.

**Idle checkpoint:** Add an idle-detection hook: when no SSE events have arrived for 5 seconds, trigger `PRAGMA wal_checkpoint(PASSIVE)`. Passive checkpoints don't block writers and complete in <50ms for typical WAL sizes. This prevents WAL accumulation during quiet periods and keeps the WAL small when the next burst arrives.

Wire the idle checkpoint into the existing SSE consumer's `connected`/`disconnected` lifecycle. On disconnect or after a 5-second timer with no events, run the passive checkpoint.

---

## Solution 7: Text Accumulation Strategy

**Addresses:** O(n^2) total cost of `text || ?` SQL concat for large streaming messages.

### Problem

Each `text.delta` appends to `message_parts.text` via `text = text || excluded.text`. SQLite reads the entire existing value, allocates old+new, copies both, writes. For a 50K-char message across 500 deltas, total bytes copied is ~12.5M. The plan's Perf-Fix-8 documents this as O(n) per delta / O(n^2) total but dismisses it for "typical message sizes."

Conduit's workload includes large tool outputs streamed as deltas and long assistant messages with extensive code. 50-100K chars per message is not exceptional.

### Design

**Approach: Threshold-based strategy switch.**

For message parts below a threshold (default: 32KB of accumulated text), continue using `text || ?`. The cost is negligible at this scale and the implementation is simple.

When a part's text exceeds the threshold, stop appending via SQL concat and switch to a write-ahead approach:

1. On the `text.delta` that crosses the threshold, record the current text length as `frozen_length` on the `message_parts` row.
2. Subsequent deltas for that part are appended to a `text_overflow` column (initially empty) using the same `text || ?` pattern but on a much smaller column.
3. On read, the `ReadQueryService` concatenates `text + text_overflow` to produce the full text.
4. On `turn.completed` or `thinking.end` (end-of-part signals), coalesce `text + text_overflow` into `text` in a single UPDATE and clear `text_overflow`.

**Why this works:** The quadratic cost is bounded by the threshold. A 100K-char message pays O(32K^2) = ~512MB for the first 32K chars (where it's fast anyway), then O(1) per delta for the overflow appends (since `text_overflow` is periodically coalesced). The total overhead for a 100K message drops from ~5GB of memcpy to ~1GB.

**Schema change:** Add `text_overflow TEXT NOT NULL DEFAULT ''` and `frozen_length INTEGER` to `message_parts`. Migration is additive.

**Simpler alternative (if the above is over-engineered):** Just accept the O(n^2) and set a hard cap: stop appending deltas after 200K chars per part. Large tool outputs arrive via `tool.completed` as a single write anyway. The streaming deltas that would hit 200K are rare enough that truncating the streaming view is acceptable — the full content is available on `tool.completed`.

The simpler alternative is recommended for Phase 3. The threshold-based strategy is a Phase 7 optimization if P11 data shows the quadratic cost is material.

---

## Solution 8: P11 Measurement Pipeline

**Addresses:** "Measure-first" recommendations (P4, P5) that have no measurement mechanism, making them effectively "never implement."

### Problem

P11 adds timing fields to `DualWriteStats` (`totalAppendMs`, `peakProjectMs`, etc.). But these are only accessible via `hook.getStats()` — a programmatic API with no consumer. No code reads these stats, logs them periodically, or triggers any action when thresholds are exceeded.

### Design

**Periodic stats logging.** Every 60 seconds (configurable), the `DualWriteHook` logs a structured summary of its P11 stats to the project logger, then resets the counters. The log entry includes:

- Events/sec (eventsWritten / elapsed)
- Avg append time (totalAppendMs / eventsWritten)
- Peak append time
- Avg project time
- Peak project time
- Error count

**Threshold alerts.** When `peakProjectMs` exceeds a configurable threshold (default: 5ms), the log entry is promoted from `debug` to `warn` level. This makes performance regressions visible in daemon logs without requiring active monitoring.

**Diagnostics endpoint.** Expose the current stats via the existing diagnostics health check (`PersistenceDiagnostics.health()`). This makes stats available to the debug panel in the frontend and to CLI health checks.

**Implementation shape:** A `setInterval` in the `DualWriteHook` constructor that calls a private `logStats()` method. The interval is cleared on `PersistenceLayer.close()`. The stats object is reset after each log emission to keep the window fixed.

This is lightweight — one log line per minute, one interval timer, no new dependencies.

---

## Solution 9: Batch Projection for Multi-Event SSE

**Addresses:** Individual transaction per event when a single SSE event produces multiple canonical events.

### Problem

When a single SSE event produces 2-3 canonical events (e.g., a tool first seen as "running" produces both `tool.started` and `tool.running`), each event goes through `eventStore.append()` + `projectionRunner.projectEvent()` individually. Each projection call opens its own transaction. For a 3-event batch, that's 3 transactions where 1 would suffice.

### Design

When the `DualWriteHook` detects that a translation produced multiple events (the `sseBatchId` is already assigned for this case), append all events in a single `appendBatch()` call (already implemented) and then project all of them in a single transaction:

```
translationResult.events.length > 1?
    YES: appendBatch(events) → projectBatch(storedEvents)  [1 transaction for append, 1 for projection]
    NO:  append(event) → projectEvent(stored)  [1 transaction for append, 1 for projection]
```

The `ProjectionRunner` gains a `projectBatch(events: StoredEvent[])` method that wraps all projector calls for all events in a single `runInTransaction()`. Cursor advancement happens once at the end of the batch.

**Impact:** Reduces transaction overhead by 2-3x for multi-event SSE events. These are common: tool lifecycle events, message creation with initial parts, session status changes with concurrent renames.

---

## Solution 10: `readBySession` Safety and `IN` Query Optimization

**Addresses:** Silent truncation from default limits; degraded query plans for large `IN` clauses.

### Two sub-problems:

**10a: `readBySession` default limit.** `EventStore.readBySession()` defaults to 1000 events. A caller that omits the limit for a session with 5000 events silently gets the first 1000. During fork (where all parent events are needed), this loses data.

**Fix:** Remove the default limit from `readBySession()`. Callers that want pagination must pass an explicit limit. The method signature changes from `limit?: number` to `limit: number | undefined`, making the caller explicitly opt into unbounded reads by passing `undefined`. Add a `readAllBySession()` convenience method that passes no limit, making the intent clear.

**10b: `IN` clause for batch part loading.** The `ReadQueryService.getSessionMessagesWithParts()` loads parts via `WHERE message_id IN (?, ?, ?, ...)` with one placeholder per message. For sessions with 100+ messages, this generates a SQL string with 100+ placeholders. SQLite handles this fine up to `SQLITE_MAX_VARIABLE_NUMBER` (default 999), but the query planner may not use the index optimally for large lists.

**Fix:** Replace the `IN` clause with a JOIN-based approach using a temporary table or a CTE:

```sql
WITH target_messages AS (
    SELECT id FROM messages WHERE session_id = ? ORDER BY created_at
)
SELECT mp.* FROM message_parts mp
JOIN target_messages tm ON mp.message_id = tm.id
ORDER BY mp.message_id, mp.sort_order
```

This lets SQLite use the `idx_message_parts_message` index via a nested-loop join, which is consistently efficient regardless of how many messages are in the session. It also avoids the parameter-count limit entirely.

---

## Solution 11: Activities Index for Kind Filtering

**Addresses:** Missing index for activity-kind queries in Phase 4.

### Problem

The `activities` table has `idx_activities_tone` covering `(session_id, tone)` but no index on `(session_id, kind)`. If Phase 4 exposes filtered activity views (e.g., "show all bash executions"), this requires a session-scoped sequential scan.

### Design

Add a composite index: `CREATE INDEX idx_activities_session_kind ON activities (session_id, kind, created_at)`. The `created_at` suffix makes it a covering index for the common query pattern `WHERE session_id = ? AND kind = ? ORDER BY created_at`.

Add this to the schema migration in Task 3. Since the migration hasn't been applied yet, this is a free addition with no migration compatibility concerns.

---

## Solution 12: Foreign Key Cost Accounting

**Addresses:** FK checks adding to per-event budget without being accounted for.

### Problem

`PRAGMA foreign_keys = ON` triggers index lookups on every INSERT into FK-constrained tables. At 50 events/sec, this adds ~0.5ms/sec of overhead. Not worth fixing (FK integrity prevents silent data corruption), but the plan's per-event timing budget doesn't account for it.

### Design

No code change. Document the FK overhead in the P11 timing analysis as a known baseline cost. When analyzing P11 measurements, subtract ~10-15us per event for FK checks before attributing remaining time to application logic.

Add a comment in `SqliteClient.init()` explaining why foreign keys are enabled despite the per-write cost, and that disabling them is not an option (it would allow orphaned events, broken projections, and silent data loss).

---

## Summary: Priority and Phase Mapping

| # | Solution | Severity | Phase | Dependencies |
|---|----------|----------|-------|--------------|
| 1-3 | Tiered Write Pipeline | Critical | 2 (amend Tasks 10-11) | None |
| 4 | Interim Eviction | High | 2 (amend Task 8) | None |
| 5 | Cascade Eviction | High | 7 (amend Task 51) | Solution 4 |
| 6 | SQLite Runtime Tuning | High | 1 (amend Task 1) | None |
| 7 | Text Accumulation | Medium | 3/7 (amend Task 16) | P11 data |
| 8 | P11 Measurement Pipeline | Medium | 2 (amend Task 10) | None |
| 9 | Batch Projection | Medium | 3 (amend Task 21) | Solutions 1-3 |
| 10a | readBySession Safety | Medium | 1 (amend Task 5) | None |
| 10b | IN Query Optimization | Low | 4 (amend Task 23) | None |
| 11 | Activities Kind Index | Low | 1 (amend Task 3) | None |
| 12 | FK Cost Accounting | Info | 1 (documentation) | P11 data |

### Recommended Application Order

**Immediate (apply before Phase 2 implementation begins):**
- Solution 6: SQLite tuning pragmas in Task 1
- Solution 10a: `readBySession` limit safety in Task 5
- Solution 11: Activities kind index in Task 3

**During Phase 2 implementation:**
- Solutions 1-3: Tiered write pipeline in Tasks 10-11
- Solution 4: Interim eviction in Task 8
- Solution 8: P11 measurement pipeline in Task 10

**During Phase 3 implementation:**
- Solution 9: Batch projection in Task 21
- Solution 7 (simple cap): Text accumulation cap in Task 16

**During Phase 7:**
- Solution 5: Cascade eviction in Task 51
- Solution 7 (threshold strategy): If P11 data warrants it
