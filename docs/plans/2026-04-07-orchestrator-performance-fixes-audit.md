# Orchestrator Performance Fixes — Audit Synthesis

> **Plan:** `docs/plans/2026-04-07-orchestrator-performance-fixes.md`
> **Auditor reports:** `docs/plans/audits/orchestrator-performance-fixes-task-{1,2,3,4}.md`, `docs/plans/audits/orchestrator-performance-fixes-tasks-6-7.md`
> **Date:** 2026-04-07

## Audit Summary

Dispatched 5 auditors across 7 tasks. Found **16 Amend Plan**, **1 Ask User**, and **11 Accept** findings.

---

## Amend Plan (16)

### Task 1: getNextSortOrder

| # | Finding | Amendment |
|---|---------|-----------|
| T1-1 | Plan incorrectly claims SQLite skips the COALESCE subquery on the ON CONFLICT path. SQLite always evaluates all VALUES expressions before conflict detection. | Correct prose at line 34 and code comments at lines 138-140. The benefit is eliminating a Node.js round-trip, not the SQL query itself. |
| T1-7 | No replay test for sort_order stability with `{ replaying: true }` context. | Add test: replay a `thinking.delta` for an existing part, verify sort_order unchanged. Minor gap. |

### Task 2: LRU Cache

| # | Finding | Amendment |
|---|---------|-----------|
| T2-1 | Test asserts `statementCacheSize === 4` after inserting into a `maxCacheSize: 3` cache. Will always be 3 (eviction is synchronous). | Fix assertion to `toBe(3)`. |
| T2-2 | Test does not distinguish LRU from FIFO. Both strategies end at size 3 — the test passes under either. | Add `hasCachedStatement(sql): boolean` test-only method and assert which specific statement was evicted. |

### Task 3: Batched Eviction

| # | Finding | Amendment |
|---|---------|-----------|
| T3-1 | `evictAsync` test expects `batchesExecuted: 4, yieldCount: 3` but termination condition `deleted < batchSize` runs one extra empty batch for evenly divisible counts (200/50). | Fix to `batchesExecuted: 5, yieldCount: 4`, or use non-divisible count (e.g., 190 events). |
| T3-2 | `evictSync` test masks the same trailing-batch issue (12000/5000 isn't divisible). | Add a test with an exactly-divisible count. |
| T3-3 | Uses `events.rowid` but rest of codebase uses `events.sequence`. | Replace `rowid` with `sequence` for consistency (functionally identical). |
| T3-8 | File named `eviction.ts` but parent plan says `event-store-eviction.ts`. | Add explicit rename note, or use consistent name. |
| T3-10 | No test for command_receipts surviving when their session's events are evicted. | Add a test showing receipts are evicted by timestamp, not session. |

### Task 4: Async Recovery

| # | Finding | Amendment |
|---|---------|-----------|
| T4-1 | Constructor uses `ProjectionRunnerOptions` but parent plan defines `ProjectionRunnerConfig`. | Rename to match parent plan, add `recoveryBatchSize?: number` to the interface. |
| T4-2 | `recoverAsync()` returns `{ totalReplayed, durationMs, perProjector }` which doesn't match `RecoveryResult` type. | Define `AsyncRecoveryResult` or make return match `RecoveryResult`. |
| T4-4 | "Same end state" test is bogus — creates unusable `syncRunner`, never exercises it. | Delete or rewrite the test. |
| T4-5 | No CH4 guard test for `recoverAsync()` path (only happy path tested). | Add test: construct runner, don't call `recoverAsync()`, verify `projectEvent()` throws. |
| T4-7 | `seedSessionAndEvents()` creates `text.delta` events without a `message.created` event, violating FK. | Prepend a `canonicalEvent("message.created", ...)` in the seed function. |

### Tasks 6-7: Pagination + Diagnostics

| # | Finding | Amendment |
|---|---------|-----------|
| T6-1 | Parent plan test at line 11660 uses `beforeMessageId: "m2"` which Task 6 removes. | Update parent plan test to use `beforeCreatedAt`/`beforeId`. |
| T6-2 | Over-fetch `LIMIT + 1` from amendment I7 is silently dropped, breaking `hasMore` detection. | Restore `LIMIT pageSize + 1` or document the change for callers. |
| T6-3 | Cursor branch returns DESC order but other branches return ASC. Inconsistent for callers. | Wrap cursor query in subquery and re-sort ASC. |
| T7-4 | `PRAGMA page_count` type annotation claims `{ page_count: number; page_size: number }` but PRAGMAs return single-column results. | Fix PRAGMA queries and type annotations. |
| T7-5 | Tests insert events with `session_id = 's1'` without creating the session row (FK violation). | Seed session row first. |

---

## Ask User (1)

| # | Finding | Question |
|---|---------|----------|
| T7-6 | The existing `PersistenceDiagnostics.health()` method already returns `totalEvents`. Task 7 adds a new `getHealthCheck()` method with overlapping data. | **Should these be merged into one method, or is the separation intentional?** |

---

## Accept (11)

- T1-2: "Eliminates 50 queries" slightly overstated (eliminates 50 round-trips). Accurate enough.
- T1-3: Parameter order correct across all 4 handlers.
- T1-4: Sort_order test coverage adequate for normal path.
- T1-5: `getNextSortOrder` is private, safe to delete.
- T1-6: `MAX(sort_order)` uses covering index.
- T2-3: Inline test comments are messy but harmless.
- T2-4: delete+re-insert safe for StatementSync.
- T2-5: LRU Map pattern is standard and correct.
- T3-4,5: FK/JOIN semantics correct for eviction.
- T3-6,7: State changes between async batches are safe.
- T3-9,11: In-memory DB perf differences and bigint precision are non-issues.
- T4-3: SSE cannot arrive during recovery (wiring order is safe).
- T4-6: `createProjectRelay()` confirmed async.
- T4-8: `recoveryBatchSize` default 500 matches parent plan.

---

## Next Steps

16 Amend Plan + 1 Ask User findings. Handing off to plan-audit-fixer to resolve.
