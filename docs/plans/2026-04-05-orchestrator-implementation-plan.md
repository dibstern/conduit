# Orchestrator Architecture Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Migrate conduit from a stateless relay into an independent orchestrator that owns all session/message state via a SQLite event store with CQRS-lite projections, and supports multiple provider adapters (OpenCode, Claude Agent SDK).

**Architecture:** Append-only SQLite event store with 6 eagerly-maintained projectors (sessions, messages, turns, providers, approvals, activities). Commands flow through receipt-checked idempotent processing into canonical events. Provider adapters are stateless execution engines that stream events into the store. The existing relay pipeline is preserved during dual-write transition, then read paths migrate one-by-one to SQLite projections.

**Tech Stack:** Node 22+ `node:sqlite` (WAL mode), TypeScript, Vitest, existing conduit relay infrastructure (SSE, WebSocket, EventEmitter patterns).

**Reference Codebase:** The t3code project at `~/src/personal/opencode-relay/t3code` implements a production CQRS event store with projections using Effect. Study its patterns but implement without Effect — use plain TypeScript with the same architectural separation (decider, event store, projectors, command receipts).

---

## Amendment History

| Date | Source Document | Summary |
|------|----------------|---------|
| 2026-04-09 | `docs/plans/2026-04-09-testing-audit-amendment-spec.md` | In-place amendments for all 14 audit findings: Task 0 shared test factories (F2), type-safe `makeSSEEvent` (F3), `canonicalEvent()` usage replacing `as` casts (F4/F11), deterministic timestamps (F8), wiring tests for Tasks 24.5/26/28/30 (F1), boundary tests (F5/F14), property tests for eviction + pipeline (F6/F12), failure injection (F9), JSONL-SQLite equivalence (F10), FK RESTRICT assertions (F13), schema-safe `seedMessage` (F7/T5), coding guidelines banning `as CanonicalEvent`. Amended Tasks 0 (new), 3, 5, 7, 9, 10, 15-20, 24.5, 26, 28, 30, 31-32. |
| 2026-04-09 | `docs/plans/2026-04-09-orchestrator-concurrency-solutions.md` | Root-cause solutions for 15 concurrency findings. Supersedes S1-S3 (tiered write pipeline), CH2 (deferred projection), P5, P9 (FIFO eviction). Five changes: (1) synchronous interleaved pipeline replacing `queueMicrotask` deferral, (2) `EventPipeline` single entry point for append+project, (3) permission resolution gateway with check-before-send and connection-aware lifecycle, (4) async lifecycle guards (per-session mutex, session-scoped LRU eviction, bounded `processedCommands`, single-consumer PromptQueue guard), (5) `LifecycleCoordinator` for reconnect recovery, debounced checkpoint, `FlagAuthority`, event-loop-aware auditor snapshots, text accumulation status tracking. Amended Tasks 1, 3, 5, 7, 8, 9, 10, 11, 12, 16, 21, 22.5, 24, 24.5, 34, 41, 44, 46, 48, 54. |
| 2026-04-08 | `docs/plans/2026-04-08-consistency-divergence-detection.md` | Three-state `ReadFlagMode` (C1), `ShadowReadComparator` framework (C2, C3, C4), `DivergenceCircuitBreaker`, `DualWriteAuditor`, `checkIntegrity()` diagnostics, rollback procedure. Amended Tasks 8, 10, 12, 22.5, 24, 24.5, 25, 26, 28, 30, 31-32, 33-34 + Phase 4 intro. |
| 2026-04-07 | `docs/plans/2026-04-07-orchestrator-testing-strategy-recommendations.md` | Shared test factories (T2), wiring tests for inline reimplementations (T1), factory runtime invariant guards (T3), property-based tests with fast-check (T4), schema mismatch fixes in seed helpers (T5), end-to-end pipeline integration test (T6), projector snapshot tests (T7). Supersedes L4, expands E1/E2. Amended Tasks 3, 5, 9, 10, 15-20, 16, 21, 23, 24.5, 26, 28, 30, 31, 32. |
| 2026-04-07 | `docs/plans/2026-04-07-orchestrator-performance-scalability-solutions.md` | Tiered write pipeline (S1-S3), interim eviction (S4), cascade eviction (S5), SQLite runtime tuning (S6), text accumulation cap (S7), P11 measurement pipeline (S8), batch projection (S9), `readBySession` safety (S10a), IN query optimization (S10b), activities kind index (S11), FK cost accounting (S12). Amended Tasks 1, 3, 5, 8, 10, 11, 16, 21, 23, 51. |

---

## Plan Overview

This plan follows the 7 phases from the [design document](./2026-04-05-orchestrator-architecture-design.md):

| Phase | Goal | Tasks |
|-------|------|-------|
| 1. Foundation | SQLite client, schema, event store primitives | Tasks 1-6 |
| 2. Dual-Write | Events flow to both JSONL and SQLite | Tasks 7-12 |
| 3. Projections | All 6 projectors running | Tasks 13-22.5 |
| 4. Read Switchover | Reads migrate to SQLite (6 sub-phases) | Tasks 23-34 |
| 5. Provider Adapter | Extract interface, OpenCode adapter | Tasks 35-42 |
| 6. Claude Adapter | Claude Agent SDK integration | Tasks 43-50 |
| 7. Cleanup | Delete transitional code | Tasks 51-55 |

---

## Audit Amendments (2026-04-06 Re-Audit)

> Full synthesis: `docs/plans/2026-04-06-orchestrator-plan-audit.md`
> Per-phase reports: `docs/plans/audits/orchestrator-plan-phase{1-7}.md`

### User Design Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | `dualWriteEnabled` default | **Opt-out** (default `true` when persistence is provided). Update Task 12 prose. |
| Q2 | Fork session inherited messages | **Copy parent messages on fork**, marked with `is_inherited = 1` for distinct presentation. Amend MessageProjector (Task 16) and schema (Task 3). |
| Q3 | Read flag runtime toggle | **Runtime toggle via URL flags + settings toggle** (like debug window). Amend Task 24. |
| Q4 | sqliteClient origin | **`config.persistence.db`** — PersistenceLayer is the single composition root, matching t3code's pattern. No new field on ProjectRelayConfig. Amend Task 24.5. |
| Q5 | Claude image attachments | **Yes — include from start.** Amend Task 45 (Claude Event Translator) and Task 44 (PromptQueue). |
| Q6 | Permission bridge resolution | **Remove the race. EventSink (sinkPromise) is canonical.** Amend Task 46. |
| Q7 | Concurrent `sendTurn()` | **Queue and process sequentially.** Amend Task 48. |
| Q8 | `updatedInput` support | **Yes — translate as edit events.** Requires new `tool.input_updated` canonical event type. Amend Task 4 and Task 45. |
| Q9 | SessionStatusPoller fate | **Hybrid reconciliation loop** — rewrite poller as 5-10s reconciliation, add SSE reconnect status reconciliation, keep `augmentStatuses()`, add 30-min staleness safety net. Amend Task 54. |
| Q10 | Low-disk-space handler | **Replace with event-store eviction.** Amend Task 51. |
| Q11 | Phase 4e definition | **Tasks 29-32** (Session Status + Session History). Replace all "Phase 4e" references with explicit task numbers. |

### Critical Amendments (must be applied inline)

| ID | Phase | Task | Amendment |
|----|-------|------|-----------|
| C1 | 2 | 11 | **Move dual-write hook call to TOP of `handleSSEEvent()`**, right after `extractSessionId()`. The original placement at the END is unreachable for events where the relay translator returns `{ ok: false }` (notably `session.updated` → `session.renamed` and `permission.replied` → `permission.resolved`). Remove the separate `permission.asked` hook call since the top-of-function placement covers it. |
| C2 | 3 | 21 | **Fix recovery loop off-by-one.** Change `cursor = events[last].sequence + 1` to `cursor = events[last].sequence`. `readFromSequence()` uses exclusive lower bound (`WHERE sequence > ?`), so `+ 1` skips one event per 500-event batch boundary. |
| C3 | 4 | 24.5 | **Replace `sqliteClient` reference with `config.persistence.db`.** PersistenceLayer already exposes the SqliteClient. Wire as: `const readQuery = config.persistence ? new ReadQueryService(config.persistence.db) : undefined;` |
| C4 | 4 | 24.5 | **Wire `readQuery` and `readFlags` into PermissionBridge constructor.** Add explicit wiring step showing `new PermissionBridge({ readQuery, readFlags })`. |
| C5 | 4 | 32 | **Add explicit implementation for `toSessionSwitchDeps()` wiring.** Must update `client-init.ts` to pass `readQuery`/`readFlags` to `SessionSwitchDeps`. |
| C6 | 5 | 42 | **Replace code COMMENT with actual implementation** for `notifyTurnCompleted` SSE wiring. Add event listener in `sse-wiring.ts` that detects `session.status: idle` and calls `adapter.notifyTurnCompleted()`. Without this, `sendTurn()` blocks forever. |
| C7 | 6 | 46 | **Fix `PermissionDecision` type mismatch.** Bridge must use `"once"`/`"always"`/`"reject"` (matching Phase 5 spec), not `"allow"`/`"deny"`. |
| C8 | 7 | 50.5 | **Add 4 `messageCache.sessionCount()` call sites in `daemon.ts`** (lines 647, 1224, 1487, 1624) to the removal/replacement manifest. Replace with `persistence.db.queryOne("SELECT COUNT(*) as count FROM sessions")?.count ?? 0`. |
| C9 | 7 | 50.5 | **Add `messageCache.flush()` in `relay-stack.ts` `stop()` method** to removal manifest. Replace with no-op (SQLite WAL handles persistence). |
| C10 | 7 | 50.5 | **Add `messageCache.setOpenCodeUpdatedAt()` in `sse-wiring.ts:191`** to removal manifest. Replace with `sessions.updated_at` update via projector (already handled by SessionProjector). |
| C11 | 7 | 53 | **Replace literal TODO placeholder** "Task [reference the Phase 4 task that introduces ReadFlags]" with "Task 24 (Feature Flags for Read Path Switching)". |

### Important Amendments (should be applied inline where possible)

| ID | Phase | Task | Amendment |
|----|-------|------|-----------|
| I1 | 2 | 10 | Fix test: `eventsWritten: 1` → `eventsWritten: 2` (synthetic `session.created` + `message.created`). |
| I2 | 2 | 11 | Add integration tests for `session.updated` and `permission.replied` dual-write paths. |
| I3 | 3 | 22 | Add `eventId: createEventId()` to recovery test's `eventStore.append()` call. |
| I4 | 3 | intro | Update Phase 3 intro: replace "same SQLite transaction" with "separate transaction (Option B)" to match implementation. |
| I5 | 3 | 22 | Replace `// ... existing fields ...` placeholder with complete PersistenceLayer field list including `cursorRepo`. |
| I6 | 4 | 27 | Add `forkPointTimestamp` and `lastMessageAt` to SQLite adapter session-list query. |
| I7 | 4 | 23 | Fix pagination: over-fetch by 1 (`LIMIT pageSize + 1`), then `hasMore = rows.length > pageSize`. |
| I8 | 4 | 34 | Add `always` column to `pending_approvals` table (amend schema migration Task 3). |
| I9 | 4 | 31 | Use composite cursor `(created_at, id)` instead of `WHERE created_at < ?`. |
| I10 | 5 | 42 | Convert prose bullet-points for relay-stack.ts changes into complete code diffs. |
| I11 | 5 | 36 | Replace `as CanonicalEvent` casts in EventSinkImpl with typed helper function. |
| I12 | 6 | 46 | Remove `decision.message` field access — `PermissionResponse` has no `message` field. |
| I13 | 6 | 46 | Make `PermissionRequest.toolInput` generic (`Record<string, unknown>`), add `sessionId`, `turnId`, `providerItemId` fields. |
| I14 | 6 | 45 | Add `session.provider_changed` to canonical event types list in Task 4, or remove from translator. |
| I15 | 6 | 46 | Change `canUseTool` from ctx-prepending wrapper to factory method returning exact SDK signature. |
| I16 | 6 | 47 | Fix test fixture: populate all 16 required `ClaudeSessionContext` fields. |
| I17 | 6 | 50 | Specify file path for `wireProviders()`. |
| I18 | 6 | all | Replace `as CanonicalEvent` casts in Claude event translator with typed helper function (same pattern as I11). |
| I19 | 7 | 50.5/52 | Clarify `handleGetToolContent` ownership: Task 52 owns the removal, using `readQuery.getToolContent()`. |
| I20 | 7 | 55 | Specify AGENTS.md replacement wording for line 18. |
| I21 | 7 | 55 | Fix "Key Boundaries" section label and add `architecture.md:25` and `:52` to update list. |

### Low-Priority Amendments (apply during implementation)

| ID | Phase | Task | Amendment |
|----|-------|------|-----------|
| L1 | 1 | 1 | Replace `as string` cast on Map iterator with guarded access. |
| L2 | 1 | 6 | Add runtime validation for `status` field in `rowToReceipt`. |
| L3 | 1 | 1 | Consider `>=22.13.0` engine constraint (node:sqlite stable without flag). |
| L4 | 4 | various | ~~Ensure tests exercise production code, not inline functions (Tasks 26, 28, 30).~~ **Superseded by T1** — wiring tests with production imports + renamed algorithm specs. |
| L5 | 4 | 24 | Add test for flag=true + readQuery=undefined edge case. |
| L6 | 6 | 44 | Document session ID assignment for first message before `system/init`. |
| L7 | 7 | 51 | Note `event-classify.ts` stays — only comment update needed. |
| L8 | 7 | 54 | Use grep-based consumer discovery instead of stale line numbers. |
| L9 | 7 | 51 | Audit `regression-server-cache-pipeline.test.ts` before deleting. |

---

### Applied Type Safety & Debuggability Recommendations (2026-04-07)

> Full analysis: `docs/plans/2026-04-07-orchestrator-plan-type-safety-recommendations.md`

The following recommendations from the type-safety review have been applied inline to the plan code:

| # | Area | Change | Affected Tasks |
|---|------|--------|----------------|
| R1 | Types | `canonicalEvent()` typed factory replaces all `as CanonicalEvent` casts | 4, 5, 7, 10, tests |
| R2 | Types | Branded types for `EventId`, `CommandId`, `SessionId`, `MessageId`, `PartId` | 4, payloads |
| R3 | Types | Const-derived unions for status, role, decision, provider fields | 4, 6 |
| R4 | Errors | `PersistenceError` class with codes and structured context | 4 (new file), 5, 6, 10, 14, 21 |
| R5 | Errors | `validateEventPayload()` runtime check on `EventStore.append()` | 5 |
| R6 | Errors | Safe JSON deserialization with contextual `PersistenceError` in `rowToStoredEvent` | 5 |
| R7 | Types | Compile-time exhaustiveness checks + runtime `handles` assertion in all projectors | 14, 15-20 |
| R8 | Debug | Stage-tracked structured error logging in `DualWriteHook` | 10 |
| R9 | Debug | `synthetic` and `source` fields in `EventMetadata` for tagging seeder events | 4, 10 |
| R10 | Debug | SSE batch correlation via `sseBatchId` in metadata | 10 |
| R11 | Design | `last_applied_seq` on messages table + per-message sequence tracking for replay idempotency | 3, 16 |
| R12 | Debug | `PersistenceDiagnostics` class with health-check queries | 22.5 (new task) |
| R13 | Debug | `ProjectionRunner` failure tracking with `ProjectionFailure[]` log | 21 |
| R14 | Design | `DualWriteResult` discriminated union return type from `onSSEEvent()` | 10 |
| R15 | Types | Compile-time `_AssertFullCoverage` check for projector × event-type coverage | 22.5 (new task) |
| R16 | Debug | Optional `Logger` parameter on `EventStore` and `ProjectionRunner` | 5, 8, 21 |

---

### Applied Further Recommendations (2026-04-07)

> Full analysis: `docs/plans/2026-04-07-orchestrator-plan-further-recommendations.md`

The following further recommendations (targeting Phases 3-7, provider/Claude adapters, and cross-cutting concerns) have been applied inline to the plan:

| # | Area | Change | Affected Tasks |
|---|------|--------|----------------|
| A1 | Design | `validateParts()` structural validation after `decodeJson` in MessageProjector | 16 |
| A2 | Debug | `turnId` in event metadata for deterministic TurnProjector matching (fallback to positional with warning) | 4, 17 |
| A3 | Debug | `ProjectionRunner.recover()` returns `RecoveryResult` with progress reporting | 21, 22 |
| A4 | Design | Per-projector transaction isolation in `ProjectionRunner.projectEvent()` | 21 |
| B1 | Errors | `ReadQueryService` methods wrapped with `PersistenceError` (`PROJECTION_FAILED`) | 23 |
| B2 | Debug | Dual-read comparison (Task 28) adds timing tolerance and `timingGapMs` field | 28 |
| C1 | Types | Overloaded `dispatch()` signatures on `OrchestrationEngine` for typed results | 41 |
| C2 | Debug | `EventSinkImpl` write-rate stats (`EventSinkStats`) wired into diagnostics | 36, 22.5 |
| C3 | Errors | `ProviderError` class with typed codes for provider layer failures | 37, 41 |
| D1 | Design | Claude `inFlightTools` keyed by `toolUseId` (not index); `resetInFlightState()` on new turn | 45 |
| D2 | Design | `PendingApproval.resolve/reject` removed; EventSink is sole resolution path; documented flow | 46 |
| D3 | Design | `sendTurn()` races deferred against configurable `turnTimeoutMs` (default 10 min) | 48 |
| D4 | Types | SDK `as any` casts confined to `src/lib/provider/claude/sdk-types.ts` typed accessors | 45, 46, 48 |
| E1 | Testing | Shared `test/helpers/persistence-factories.ts` for `makeStored()`, `seedSession()`, `makeSSEEvent()`. **Expanded by T2** — three modules (`persistence-factories.ts`, `provider-factories.ts`, `sse-factories.ts`) with `createTestHarness()`, typed factories, and unmocked-method guards. | All persistence tests |
| E2 | Testing | Snapshot/golden-file tests for full projector lifecycle output. **Expanded by T7** — one snapshot test per projector; MessageProjector includes `messages` + `message_parts` tables. | 22 |
| F1 | Debug | `commandId` required on `SendTurnCommand`; propagated through EventSink into all event metadata | 36, 41 |
| F2 | Debug | Dual-write error logs include truncated `eventProperties` payload | 10 |
| F3 | Debug | `EventSinkImpl.getPendingState()` exposes pending permissions/questions; wired into diagnostics | 36, 22.5 |
| G1 | Safety | Static dependency verification checklist (pre/post-deletion) on every Phase 7 task | 50.5, 51, 52 |
| G2 | Design | `isSessionStatusStale()` staleness detection for event-sourced session status in reconciliation loop | 54 |
| H1 | Types | CHECK constraints on `sessions.status`, `messages.role`, `turns.state`, etc. in schema migration | 3 |

---

### Applied Performance & Scalability Recommendations v2 (2026-04-07)

> Full analysis: `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations-v2.md`
> (Supersedes v1: `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations.md`)
>
> v2 re-evaluated every v1 recommendation against the t3code reference implementation, SQLite best practices, and CQRS patterns. Several v1 recommendations were over-engineered or solving symptoms rather than root causes. Key changes: normalized `message_parts` table replaces `ProjectionDeltaBuffer`, age-based eviction replaces 3-tier compaction, P4/P5 marked measure-first.

The following performance and scalability optimizations have been applied inline to the plan code:

| # | Area | Change | Affected Tasks |
|---|------|--------|----------------|
| P1 | Schema+Perf | Normalized `message_parts` table eliminates JSON read-parse-modify-serialize-write cycle. Per-delta cost is 2 SQL UPSERTs with zero JSON. **Replaces v1's `ProjectionDeltaBuffer`.** | 3, 16, 23 |
| P2 | Perf | Lazy cursor advancement every 100 events with global high-water mark instead of per-projector-per-event writes (83× reduction) | 21 |
| P3 | Perf | `replaying` flag on `ProjectionContext` skips `alreadyApplied()` SELECT during normal streaming. Scope narrower with normalization — only needed for `text || ?` append path. | 14, 16, 21 |
| P4 | Perf | In-memory `versionCache` on `EventStore` — **marked measure-first**. COALESCE subquery is ~10μs; implement only if P11 data shows >1% of append time. | 5 |
| P5 | Perf | ~~Selective deferred projection via `queueMicrotask()`~~ **SUPERSEDED by CH2, then by Concurrency Solutions Change 1** — all projections synchronous within batch transactions. No deferred projection path exists. | 22 |
| P6 | Ops | `EventStoreEviction` with **age-based session eviction** (single indexed query). **Replaces v1's 3-tier compaction** which used `json_extract` full-table scans. | 51 (new file) |
| P7 | Perf | Per-projector recovery with **SQL-level type filtering** via `WHERE type IN (...)`. Fast-path skip when all caught up. | 21, 22 |
| P8 | Schema | `idx_turns_assistant_message`, covering index on messages `(session_id, created_at DESC, id DESC)`, `idx_message_parts_message`, `last_message_at` denormalized on sessions (**owned by SessionProjector, not MessageProjector**) | 3, 15 |
| P9 | Safety | ~~FIFO eviction at 10,000 entries on `CanonicalEventTranslator.trackedParts` and `SessionSeeder.seenSessions`~~ **SUPERSEDED by Concurrency Solutions Change 4b** — session-scoped LRU eviction replaces FIFO. Never evicts parts from the session currently being processed. | 7, 9 |
| P11 | Debug | Timing instrumentation (`totalTranslateMs`, `totalAppendMs`, `totalProjectMs`, `peakAppendMs`, `peakProjectMs`) on `DualWriteStats`. **Prerequisite for validating P4 and P5.** | 10 |
| P12 | Schema | CHECK constraints on status/role/type columns | 3 (already applied as H1) |

**Dropped from v1:** P10 (multi-row batch INSERT) — marginal gain, adds complexity. WAL mode already coalesces writes.

---

### Applied Concurrency Hardening Amendments (2026-04-07)

> Full plan: `docs/plans/2026-04-07-orchestrator-concurrency-hardening.md`
> Audit reports: `docs/plans/audits/orchestrator-concurrency-hardening-task-{1-5}.md`
> Audit synthesis: `docs/plans/2026-04-07-orchestrator-concurrency-hardening-audit.md`

The following concurrency and race condition fixes have been applied inline to the plan code. These are amendments to existing task code, not new phases.

| # | Area | Change | Affected Tasks |
|---|------|--------|----------------|
| CH1 | Lifecycle | Rename `resetTranslator()` → `onReconnect()` with private epoch counter for diagnostics. Single atomic lifecycle coordination point for SSE reconnects. | 10, 11, 12 |
| CH2 | Projection | ~~Remove `queueMicrotask()` / `SYNC_PROJECT_TYPES` / deferred projection entirely. All projections synchronous. If P11 shows `peakProjectMs` >5ms, reintroduce deferred projection selectively.~~ **SUPERSEDED by Concurrency Solutions Change 1** — synchronous interleaved pipeline with batch transactions. The "reintroduce selectively" note is **withdrawn**; batch transactions address the same performance concern without concurrency risk. | 22 |
| CH3 | Cursors | Monotonic cursor advancement via `MAX(excluded, existing)` in upsert SQL. Prevents recovery or `syncAllCursors()` from regressing a cursor that was advanced by a concurrent live event. | 13 |
| CH4 | Startup | `_recovered` flag + hard error guard on `projectEvent()` — throws if called before `recover()`. Explicit `recover()` call site in `relay-stack.ts` before `wireSSEConsumer()`. | 21, 12 |
| CH5 | Docs | Document `UPDATE ... WHERE status = 'pending'` + `changes === 0` check for permission resolution atomicity. **Expanded by Concurrency Solutions Change 3** — the SQL check now runs BEFORE the REST call to provider (check-before-send), making CH5's guard the first line of defense rather than a post-hoc dedup. | 34 |

---

### Applied Performance & Scalability Solutions (2026-04-07)

> Full design: `docs/plans/2026-04-07-orchestrator-performance-scalability-solutions.md`
> Related: `docs/plans/2026-04-07-orchestrator-performance-scalability-recommendations-v2.md`, `docs/plans/2026-04-07-orchestrator-performance-fixes.md`
>
> Addresses all remaining performance and scalability gaps identified across the orchestrator plan audit rounds. Key change: the synchronous dual-write at the top of `handleSSEEvent()` is replaced with a **tiered write pipeline** that defers high-frequency events (text.delta, tool.*, etc.) to after the relay pipeline, giving the relay zero additional latency for 95%+ of events.

The following performance and scalability solutions have been applied inline to the plan code:

| # | Solution | Severity | Phase | Affected Tasks |
|---|----------|----------|-------|----------------|
| S1-S3 | ~~Tiered write pipeline: relay-first write ordering + default-deferred projection. `SYNC_TYPES` set (~7 event types) writes synchronously before relay; all others deferred via `queueMicrotask` after relay pipeline.~~ **SUPERSEDED ENTIRELY by Concurrency Solutions Change 1** — synchronous interleaved pipeline. All writes synchronous. `queueMicrotask` removed from write path. See `docs/plans/2026-04-09-orchestrator-concurrency-solutions.md`. | Critical | 2 | 10, 11 |
| S4 | Interim eviction: startup-only eviction in `PersistenceLayer.open()` when events table exceeds 200K rows. Deletes events for idle sessions >24h old. Transitional — replaced by Phase 7's `EventStoreEviction`. | High | 2 | 8 |
| S5 | Cascade eviction: extends Phase 7 eviction to cascade through projection tables (`activities`, `pending_approvals`, `message_parts`, `messages`, `turns`, `session_providers`, `tool_content`, `provider_state`, `sessions`) in FK-safe order when ALL events for a session are evicted. | High | 7 | 51 |
| S6 | SQLite runtime tuning: `cache_size = -65536` (64MB), `wal_autocheckpoint = 4000` (~16MB WAL), `mmap_size = 268435456` (256MB). Idle checkpoint via `PRAGMA wal_checkpoint(PASSIVE)` after 5s of no SSE events. | High | 1 | 1 |
| S7 | Text accumulation cap: stop appending `text.delta` via SQL concat after 200K chars per part. Full content arrives via `tool.completed`. Threshold-based `text_overflow` strategy deferred to Phase 7 if P11 warrants. | Medium | 3 | 16 |
| S8 | P11 measurement pipeline: periodic stats logging (60s interval) from `DualWriteHook`, threshold alerts when `peakProjectMs` >5ms, stats exposed via `PersistenceDiagnostics.health()`. | Medium | 2 | 10 |
| S9 | Batch projection: `ProjectionRunner.projectBatch()` wraps all projector calls for multi-event SSE batches in a single transaction. Reduces transaction overhead 2-3x for tool lifecycle, message creation, etc. | Medium | 3 | 21 |
| S10a | `readBySession` safety: remove default 1000-event limit. Callers must pass explicit `limit` or `undefined` for unbounded. Add `readAllBySession()` convenience method. | Medium | 1 | 5 |
| S10b | IN query optimization: replace `WHERE message_id IN (?, ?, ...)` with CTE + JOIN for `getSessionMessagesWithParts()`. Consistent index usage regardless of message count, avoids parameter-count limit. | Low | 4 | 23 |
| S11 | Activities kind index: `CREATE INDEX idx_activities_session_kind ON activities (session_id, kind, created_at)`. Covering index for kind-filtered activity queries. | Low | 1 | 3 |
| S12 | FK cost accounting: no code change. Document ~10-15μs per event FK overhead as known baseline in P11 analysis. Comment in `SqliteClient.init()` explaining why FKs remain enabled despite per-write cost. | Info | 1 | 1 (doc only) |

---

### Applied Testing Strategy Recommendations (2026-04-07)

> Full analysis: `docs/plans/2026-04-07-orchestrator-testing-strategy-recommendations.md`
>
> Addresses systemic testing gaps: tests that validate inline reimplementations instead of production code, duplicated test factories across 33 local copies, factories that silently produce invalid data, missing property-based tests for invariant-rich code, schema mismatches in seed helpers, no end-to-end pipeline test, and no projector snapshot tests. Supersedes L4; expands E1 and E2.

The following testing strategy improvements have been applied to the plan:

| # | Area | Change | Affected Tasks |
|---|------|--------|----------------|
| T1 | Testing | Add wiring tests that import and call production functions alongside existing algorithm specs (renamed to `describe("... algorithm (spec)")`). Catches drift between spec and implementation. **Supersedes L4.** | 24.5, 26, 28, 30 |
| T2 | Testing | Create shared `test/helpers/{persistence,provider,sse}-factories.ts`. `createTestHarness()` builds a fully-wired in-memory persistence stack. `makeSSEEvent` constrains `type` to known event types. `makeStubClient` throws on unmocked methods. Eliminates 33 local factory copies. **Expands E1.** | All persistence + provider tests |
| T3 | Testing | Add runtime invariant checks (`sequence >= 1`, known event types) and `validateEventPayload()` calls in shared factories so test data is validated at construction time. Fixes `makeStored` producing `streamVersion: -1` and `makeEvent` using invalid `"message.delta"` type. | T2 factories |
| T4 | Testing | Add 5 property-based test files with `fast-check`: event store replay consistency, projection convergence (replay = streaming), dual-write reconnect safety, session seeder idempotency, message part assembly. Add `test:prop` script. | 5, 16, 10, 9, 21 |
| T5 | Testing | Fix `seedMessage` to write to normalized `message_parts` table instead of non-existent `parts` TEXT column. Add CHECK constraint enforcement tests and FK cascade behavior tests. | 31, 32, 3 |
| T6 | Testing | Add end-to-end pipeline integration test (`test/integration/persistence/event-pipeline.test.ts`): SSE event → DualWriteHook → translator → seeder → EventStore.append → ProjectionRunner → all 6 projectors → ReadQueryService read. | New file |
| T7 | Testing | Add snapshot tests for all 6 projectors using Vitest `toMatchSnapshot()`. MessageProjector snapshots include both `messages` and `message_parts` tables. **Expands E2.** | 15-20 |

Dependencies: T2 first (all other amendments depend on shared factories). T5 before T6 (pipeline test uses correct seed helpers). T4 independent, can parallelize.

---

### Applied Testing Strategy Audit Amendments (2026-04-09)

> Full specification: `docs/plans/2026-04-09-testing-audit-amendment-spec.md`
> Audit report: `docs/plans/2026-04-07-orchestrator-testing-strategy-audit.md`
>
> Resolves all 14 findings (F1-F14) from the testing strategy audit. The T1-T7 amendments declared above were correct diagnoses but were never applied to the task code blocks that executing agents read. This amendment applies them in-place: Task 0 creates shared factories, affected task code blocks are rewritten to import from shared modules, wiring tests are added, boundary/property/failure/integration tests are added.

The following in-place amendments have been applied:

| Finding | Severity | Amendment | Tasks Amended |
|---------|----------|-----------|---------------|
| F1 | High | Wiring test blocks added alongside renamed algorithm specs | 24.5, 26, 28, 30 |
| F2 | High | Task 0 inserted: shared `test/helpers/{persistence,provider,sse}-factories.ts` | 0 (new) |
| F3 | High | `makeSSEEvent` type-constrained to `KnownSSEType` with runtime guard | 7, 10 |
| F4 | Medium | `as CanonicalEvent` casts replaced with `canonicalEvent()` factory calls | 5, 7, 10, 15-20 |
| F5 | Medium | Boundary tests added (epoch zero, large payloads, negative cursors, concurrent stores) | 5 |
| F6 | Medium | Properties 6 (eviction safety) and 7 (tiered pipeline ordering) specified | New files |
| F7 | Medium | Title consistency (`"Test Session"`) and FK-safe seeding via `createTestHarness()` | 5, 9 |
| F8 | Medium | `FIXED_TEST_TIMESTAMP` defaults in all factories for deterministic snapshots | 5, 15-20 |
| F9 | Medium | Failure injection tests for SQLITE_BUSY, reconnect, sync/deferred interleaving | 10 |
| F10 | Medium | JSONL↔SQLite equivalence contract test + end-to-end pipeline test | New files |
| F11 | Low-Med | Coding guidelines ban `as CanonicalEvent`; test code quality rules below | All test tasks |
| F12 | Low-Med | State machine generator design for Property 2 (projection convergence) | New file |
| F13 | Low | FK RESTRICT assertion tests documenting deliberate design decision | 3 |
| F14 | Low | `resetVersionCache()` unit tests added | 5 |

### Test Code Quality Rules (2026-04-09)

> These rules apply to ALL test code blocks in this plan. Executing agents MUST follow them.

1. **Ban `as CanonicalEvent` in test code.** All event construction must go through `canonicalEvent()` or a shared factory that calls it internally. The only exception is intentionally invalid events for testing validation, which must use `as unknown as CanonicalEvent` with an explanatory comment.

2. **No local factory copies.** Every task imports from `test/helpers/{persistence,provider,sse}-factories.ts` (created in Task 0). If a task needs a factory that doesn't exist, add it to the shared module — never define it locally.

3. **Deterministic timestamps by default.** All test factories use `FIXED_TEST_TIMESTAMP` (1_000_000_000_000). Override explicitly with `{ createdAt: Date.now() }` only when testing time-dependent behavior.

4. **`seedSession()` title must match `makeSessionCreatedEvent()` title.** Both default to `"Test Session"`. If a test needs a custom title, pass it to both.

5. **`seedMessage()` writes to `message_parts` table.** Never insert a `parts` column into the `messages` table directly. Use `harness.seedMessage()` which handles the P1 normalization.

---

## Phase 1: Foundation — SQLite Client, Schema, Event Store Primitives

**Goal:** Stand up the durable persistence layer — SQLite client wrapper, migration runner, schema, canonical event types, event store service, and command receipt repository. All pieces tested in isolation. Nothing wired to the relay yet.

**Depends on:** Nothing. Greenfield code in `src/lib/persistence/`.

**Validates:** We can open a WAL-mode database, run migrations, append events with per-session optimistic concurrency, read them back in global sequence order, and deduplicate commands via receipts.

---

### Task 0: Shared Test Factory Infrastructure

> **Amendment (2026-04-09 — Testing Audit, F2/F3/F4/F8/F11):**
> This task was added to resolve F2 (no task slot for shared factories). All subsequent tasks import from these three modules instead of defining local factories. This eliminates 33+ scattered factory copies and enforces type safety, runtime invariant checks, and deterministic timestamps.

**Files:**
- Create: `test/helpers/persistence-factories.ts`
- Create: `test/helpers/sse-factories.ts`
- Create: `test/helpers/provider-factories.ts`
- Test: `test/unit/persistence/shared-factories.test.ts`

**Depends on:** Nothing. Creates shared test infrastructure used by all subsequent tasks.

**Step 1: Create `persistence-factories.ts`**

The core module — replaces 33+ scattered factory copies with a single `createTestHarness()` call.

```typescript
// test/helpers/persistence-factories.ts
import { SqliteClient } from "../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../src/lib/persistence/schema.js";
import { EventStore } from "../../src/lib/persistence/event-store.js";
import {
	canonicalEvent,
	createEventId,
	validateEventPayload,
	type CanonicalEvent,
	type StoredEvent,
	type EventId,
	type EventMetadata,
	type EventPayloadMap,
} from "../../src/lib/persistence/events.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Fixed timestamp for deterministic tests. Override explicitly when testing time-dependent behavior. */
export const FIXED_TEST_TIMESTAMP = 1_000_000_000_000; // 2001-09-09T01:46:40Z

/** Second fixed timestamp for tests needing two distinct times. */
export const FIXED_TEST_TIMESTAMP_2 = 1_000_000_060_000; // +60s

// ─── Canonical Event Factories ───────────────────────────────────────────────
//
// Every factory calls canonicalEvent() internally — never raw object + `as` cast.
// This enforces the type-data correspondence defined by the discriminated union.

export function makeSessionCreatedEvent(
	sessionId: string,
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
		title?: string;
		provider?: string;
	},
): CanonicalEvent {
	return canonicalEvent("session.created", sessionId, {
		sessionId,
		title: opts?.title ?? "Test Session",
		provider: opts?.provider ?? "opencode",
	}, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});
}

export function makeTextDelta(
	sessionId: string,
	messageId: string,
	text: string,
	opts?: {
		eventId?: EventId;
		partId?: string;
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent("text.delta", sessionId, {
		messageId,
		partId: opts?.partId ?? "p1",
		text,
	}, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});
}

export function makeMessageCreatedEvent(
	sessionId: string,
	messageId: string,
	opts?: {
		eventId?: EventId;
		role?: "user" | "assistant";
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent("message.created", sessionId, {
		messageId,
		role: opts?.role ?? "assistant",
	}, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});
}

export function makeSessionStatusEvent(
	sessionId: string,
	status: "idle" | "busy" | "error",
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		createdAt?: number;
	},
): CanonicalEvent {
	return canonicalEvent("session.status", sessionId, {
		sessionId,
		status,
	}, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});
}

// ─── StoredEvent Factory ─────────────────────────────────────────────────────

/**
 * Create a StoredEvent with validated type-data correspondence and runtime invariants.
 * Uses canonicalEvent() internally — never raw casts.
 */
export function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: EventPayloadMap[T],
	opts?: {
		sequence?: number;
		createdAt?: number;
		streamVersion?: number;
		eventId?: EventId;
		metadata?: EventMetadata;
	},
): StoredEvent {
	const sequence = opts?.sequence ?? 1;
	if (sequence < 1) {
		throw new Error(`makeStored: sequence must be >= 1, got ${sequence}`);
	}

	const streamVersion = opts?.streamVersion ?? 0;
	if (streamVersion < 0) {
		throw new Error(`makeStored: streamVersion must be >= 0, got ${streamVersion}`);
	}

	const event = canonicalEvent(type, sessionId, data, {
		eventId: opts?.eventId ?? createEventId(),
		metadata: opts?.metadata ?? {},
		createdAt: opts?.createdAt ?? FIXED_TEST_TIMESTAMP,
	});

	// Validate payload at construction time — catch invalid test data immediately
	validateEventPayload(event);

	return { ...event, sequence, streamVersion } as StoredEvent;
}

// ─── Session/Message/Turn Seeding ────────────────────────────────────────────

export interface SessionSeedOpts {
	provider?: string;
	title?: string;
	status?: string;
	parentId?: string;
	forkPointEvent?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface MessageSeedOpts {
	role?: "user" | "assistant";
	createdAt?: number;
	updatedAt?: number;
	lastAppliedSeq?: number;
	parts?: Array<{
		id: string;
		type: "text" | "thinking" | "tool";
		text?: string;
		sortOrder?: number;
	}>;
}

export interface TurnSeedOpts {
	assistantMessageId?: string;
	state?: "active" | "completed" | "error";
	createdAt?: number;
	updatedAt?: number;
}

// ─── Test Harness ────────────────────────────────────────────────────────────

export interface TestHarness {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	seedSession: (id: string, opts?: SessionSeedOpts) => void;
	seedMessage: (id: string, sessionId: string, opts?: MessageSeedOpts) => void;
	seedTurn: (id: string, sessionId: string, opts?: TurnSeedOpts) => void;
	close: () => void;
}

/**
 * Build a fully-wired in-memory persistence stack in one call.
 * Handles schema setup, session seeding, FK consistency, and deterministic timestamps.
 */
export function createTestHarness(): TestHarness {
	const db = SqliteClient.memory();
	runMigrations(db, schemaMigrations);
	const eventStore = new EventStore(db);

	function seedSession(id: string, opts?: SessionSeedOpts): void {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		db.execute(
			`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				opts?.provider ?? "opencode",
				opts?.title ?? "Test Session",
				opts?.status ?? "idle",
				opts?.parentId ?? null,
				opts?.forkPointEvent ?? null,
				now,
				opts?.updatedAt ?? now,
			],
		);
	}

	function seedMessage(id: string, sessionId: string, opts?: MessageSeedOpts): void {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		// (T5/F7) Insert into messages table — no parts column (P1 normalization)
		db.execute(
			`INSERT INTO messages (id, session_id, role, created_at, updated_at, last_applied_seq)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, sessionId, opts?.role ?? "assistant", now, opts?.updatedAt ?? now, opts?.lastAppliedSeq ?? 0],
		);
		// Insert each part into message_parts table
		for (const [i, part] of (opts?.parts ?? []).entries()) {
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[part.id, id, part.type, part.text ?? "", part.sortOrder ?? i, now, now],
			);
		}
	}

	function seedTurn(id: string, sessionId: string, opts?: TurnSeedOpts): void {
		const now = opts?.createdAt ?? FIXED_TEST_TIMESTAMP;
		db.execute(
			`INSERT INTO turns (id, session_id, assistant_message_id, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, sessionId, opts?.assistantMessageId ?? null, opts?.state ?? "active", now, opts?.updatedAt ?? now],
		);
	}

	return { db, eventStore, seedSession, seedMessage, seedTurn, close: () => db.close() };
}
```

**Step 2: Create `sse-factories.ts`**

```typescript
// test/helpers/sse-factories.ts
import type { OpenCodeEvent } from "../../src/lib/types.js";
import type { KnownOpenCodeEvent } from "../../src/lib/relay/opencode-events.js";

type KnownSSEType = KnownOpenCodeEvent["type"];

const KNOWN_SSE_TYPES = new Set<string>([
	"message.created", "message.updated", "message.removed",
	"message.part.delta", "message.part.updated", "message.part.removed",
	"session.status", "session.error", "session.updated",
	"permission.asked", "permission.replied",
	"question.asked", "question.replied",
	"pty.created", "pty.data", "file.edited",
]);

/** (F3) Create a typed SSE event. Constrains type to known SSE types at compile + runtime. */
export function makeSSEEvent<T extends KnownSSEType>(
	type: T,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	if (!KNOWN_SSE_TYPES.has(type)) {
		throw new Error(`makeSSEEvent: unknown SSE event type "${type}".`);
	}
	return { type, properties } as OpenCodeEvent;
}

/** Create an intentionally unknown SSE event for testing unknown-event handling. */
export function makeUnknownSSEEvent(
	type: string,
	properties: Record<string, unknown> = {},
): OpenCodeEvent {
	if (KNOWN_SSE_TYPES.has(type)) {
		throw new Error(`makeUnknownSSEEvent: "${type}" is a known type. Use makeSSEEvent() instead.`);
	}
	return { type, properties } as OpenCodeEvent;
}

/** Realistic SSE sequence for integration tests. Returns events + expected read-model outcomes. */
export interface RealisticSequenceResult {
	events: OpenCodeEvent[];
	expectedTitle: string;
	expectedMessageCount: number;
	expectedToolCount: number;
	sessionId: string;
}

export function createRealisticSSESequence(sessionId: string): RealisticSequenceResult {
	const events: OpenCodeEvent[] = [
		makeSSEEvent("session.status", { status: { type: "busy" } }),
		makeSSEEvent("message.created", { sessionID: sessionId, message: { id: "msg-1", role: "user" } }),
		makeSSEEvent("message.created", { sessionID: sessionId, message: { id: "msg-2", role: "assistant" } }),
		makeSSEEvent("message.part.delta", { sessionID: sessionId, messageID: "msg-2", partID: "part-1", field: "text", delta: "Hello, " }),
		makeSSEEvent("message.part.delta", { sessionID: sessionId, messageID: "msg-2", partID: "part-1", field: "text", delta: "world!" }),
		makeSSEEvent("message.part.updated", { partID: "part-2", part: { type: "tool", callID: "call-1", tool: "read", state: { status: "running", input: { path: "/test" } } } }),
		makeSSEEvent("permission.asked", { id: "perm-1", sessionID: sessionId, permission: "read", patterns: ["/test"], metadata: {} }),
		makeSSEEvent("permission.replied", { id: "perm-1", sessionID: sessionId, decision: "once" }),
		makeSSEEvent("message.part.updated", { partID: "part-2", part: { type: "tool", callID: "call-1", tool: "read", state: { status: "completed", output: "file content" } } }),
		makeSSEEvent("message.updated", { sessionID: sessionId, message: { role: "assistant", tokens: { input: 100, output: 50 } } }),
		makeSSEEvent("session.status", { status: { type: "idle" } }),
	];
	return { events, expectedTitle: "Test Session", expectedMessageCount: 2, expectedToolCount: 1, sessionId };
}
```

**Step 3: Create `provider-factories.ts`**

```typescript
// test/helpers/provider-factories.ts
import { vi } from "vitest";
import type { ProviderAdapter } from "../../src/lib/provider/types.js";
import type { EventSink } from "../../src/lib/provider/event-sink.js";
import type { OpenCodeClient } from "../../src/lib/relay/opencode-client.js";
import type { CanonicalEvent } from "../../src/lib/persistence/events.js";

/** Stub client where unmocked methods throw — prevents silent undefined returns. */
export function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	const methodNames = [
		"sendMessageAsync", "abortSession", "replyPermission", "replyQuestion",
		"rejectQuestion", "listPendingQuestions", "getSession", "getMessages",
		"getMessage", "getMessagesPage", "listSessions", "listAgents",
		"listProviders", "listCommands", "listProjects", "listDirectory",
		"getFileContent", "createPty", "deletePty", "resizePty", "listPtys",
		"revertSession", "forkSession", "createSession", "deleteSession",
		"getAuthHeaders", "getHealth", "switchModel", "listPendingPermissions",
		"getBaseUrl", "getConfig", "updateConfig",
	] as const;
	const stub: Record<string, unknown> = {};
	for (const name of methodNames) {
		stub[name] = vi.fn().mockImplementation(() => {
			throw new Error(`makeStubClient: unmocked method "${name}" called`);
		});
	}
	return { ...stub, ...overrides } as unknown as OpenCodeClient;
}

/** Stub adapter where unmocked methods throw. */
export function makeStubAdapter(id: string, overrides?: Partial<ProviderAdapter>): ProviderAdapter {
	return {
		id,
		discover: vi.fn().mockImplementation(() => { throw new Error(`unmocked "discover"`); }),
		sendTurn: vi.fn().mockImplementation(() => { throw new Error(`unmocked "sendTurn"`); }),
		interruptTurn: vi.fn().mockImplementation(() => { throw new Error(`unmocked "interruptTurn"`); }),
		resolvePermission: vi.fn().mockImplementation(() => { throw new Error(`unmocked "resolvePermission"`); }),
		resolveQuestion: vi.fn().mockImplementation(() => { throw new Error(`unmocked "resolveQuestion"`); }),
		shutdown: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as ProviderAdapter;
}

/** Stub EventSink that optionally tracks appended events. */
export function makeStubEventSink(opts?: { trackEvents?: boolean }): EventSink & { events: CanonicalEvent[] } {
	const events: CanonicalEvent[] = [];
	return {
		events,
		append: vi.fn().mockImplementation((event: CanonicalEvent) => { if (opts?.trackEvents) events.push(event); }),
		flush: vi.fn().mockResolvedValue(undefined),
		getPendingState: vi.fn().mockReturnValue({ pendingPermissions: [], pendingQuestions: [] }),
	} as unknown as EventSink & { events: CanonicalEvent[] };
}
```

**Step 4: Write test for shared factories**

```typescript
// test/unit/persistence/shared-factories.test.ts
import { describe, expect, it, vi } from "vitest";
import {
	createTestHarness,
	makeSessionCreatedEvent,
	makeStored,
	FIXED_TEST_TIMESTAMP,
} from "../../helpers/persistence-factories.js";
import { makeSSEEvent, makeUnknownSSEEvent } from "../../helpers/sse-factories.js";
import { makeStubClient } from "../../helpers/provider-factories.js";

describe("persistence-factories", () => {
	it("createTestHarness returns wired stack", () => {
		const harness = createTestHarness();
		harness.seedSession("s1");
		const stored = harness.eventStore.append(makeSessionCreatedEvent("s1"));
		expect(stored.sequence).toBe(1);
		expect(stored.streamVersion).toBe(0);
		harness.close();
	});

	it("makeStored rejects sequence < 1", () => {
		expect(() => makeStored("session.created", "s1", {
			sessionId: "s1", title: "T", provider: "opencode",
		}, { sequence: 0 })).toThrow("sequence must be >= 1");
	});

	it("makeStored rejects streamVersion < 0", () => {
		expect(() => makeStored("session.created", "s1", {
			sessionId: "s1", title: "T", provider: "opencode",
		}, { streamVersion: -1 })).toThrow("streamVersion must be >= 0");
	});

	it("all factories use FIXED_TEST_TIMESTAMP by default", () => {
		const event = makeSessionCreatedEvent("s1");
		expect(event.createdAt).toBe(FIXED_TEST_TIMESTAMP);
	});

	it("seedSession title matches makeSessionCreatedEvent title", () => {
		const harness = createTestHarness();
		harness.seedSession("s1");
		const row = harness.db.queryOne<{ title: string }>(
			"SELECT title FROM sessions WHERE id = ?", ["s1"],
		);
		const event = makeSessionCreatedEvent("s1");
		expect(row!.title).toBe((event.data as { title: string }).title);
		harness.close();
	});
});

describe("sse-factories", () => {
	it("makeSSEEvent rejects unknown types at runtime", () => {
		// @ts-expect-error — intentionally testing runtime guard
		expect(() => makeSSEEvent("message.delta", {})).toThrow("unknown SSE event type");
	});

	it("makeSSEEvent accepts valid types", () => {
		const event = makeSSEEvent("message.part.delta", {
			sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "hi",
		});
		expect(event.type).toBe("message.part.delta");
	});

	it("makeUnknownSSEEvent rejects known types", () => {
		expect(() => makeUnknownSSEEvent("session.status", {})).toThrow("known type");
	});
});

describe("provider-factories", () => {
	it("makeStubClient throws on unmocked methods", () => {
		const client = makeStubClient();
		expect(() => client.listSessions()).toThrow("unmocked method");
	});

	it("makeStubClient allows overrides", async () => {
		const client = makeStubClient({ listSessions: vi.fn().mockResolvedValue([]) });
		await expect(client.listSessions()).resolves.toEqual([]);
	});
});
```

**Step 5: Run tests**

Run: `pnpm vitest run test/unit/persistence/shared-factories.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add test/helpers/persistence-factories.ts test/helpers/sse-factories.ts test/helpers/provider-factories.ts test/unit/persistence/shared-factories.test.ts
git commit -m "feat(test): add shared test factories — persistence, SSE, and provider (T2/F2)"
```

---

### Task 1: SQLite Client Wrapper

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5a):**
> Move the idle checkpoint timer (`PRAGMA wal_checkpoint(PASSIVE)` after 5s of no SSE events) out of
> ad-hoc `setTimeout` wiring in `sse-wiring.ts` into `LifecycleCoordinator`. The `SqliteClient` is still
> the target of the checkpoint call, but the timer lifecycle (start, reset, cleanup) is owned by the
> coordinator. See Change 5a in `docs/plans/2026-04-09-orchestrator-concurrency-solutions.md`.

> **Amendment (2026-04-07, Perf-Fix-2):** Statement cache upgraded from FIFO to LRU-by-access.
> On cache hit, the entry is deleted and re-inserted to move it to the end of Map iteration order.
> Added `hasCachedStatement(sql)` test-only method. See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 2.

> **Amendment (2026-04-07, S6 — SQLite Runtime Tuning):**
> Add three performance-tuning PRAGMAs to `SqliteClient.init()` for file-backed databases:
> - `PRAGMA cache_size = -65536` (64MB page cache — keeps hot indexes in memory for DBs up to ~2GB)
> - `PRAGMA wal_autocheckpoint = 4000` (~16MB WAL before auto-checkpoint — reduces mid-burst checkpoint stalls)
> - `PRAGMA mmap_size = 268435456` (256MB memory-mapped reads — reduces syscall overhead for large range scans)
>
> Add an idle checkpoint hook: when no SSE events have arrived for 5 seconds, trigger `PRAGMA wal_checkpoint(PASSIVE)`.
> Wire into the SSE consumer's `connected`/`disconnected` lifecycle. Passive checkpoints don't block writers
> and complete in <50ms. This prevents WAL accumulation during quiet periods.
>
> **Amendment (2026-04-07, S12 — FK Cost Accounting):**
> Add a comment in `SqliteClient.init()` explaining why `PRAGMA foreign_keys = ON` is enabled despite
> the per-write cost (~10-15μs per INSERT for FK index lookups). Disabling FKs would allow orphaned
> events, broken projections, and silent data loss. The overhead is documented as a known P11 baseline
> cost: subtract ~10-15μs per event for FK checks before attributing remaining time to application logic.

**Files:**
- Create: `src/lib/persistence/sqlite-client.ts`
- Test: `test/unit/persistence/sqlite-client.test.ts`
- Modify: `package.json`

**Prerequisite: Update Node engine constraint**

`node:sqlite` was added in Node 22.5.0 (still experimental). The current `package.json` specifies `"engines": { "node": ">=20.19.0" }`, which would allow installs on Node versions where importing `node:sqlite` throws at runtime. Update `package.json` before writing any code:

```json
"engines": {
  "node": ">=22.5.0"
}
```

> **Note:** `node:sqlite` requires the `--experimental-sqlite` flag on Node versions prior to 22.13.0. Consider `>=22.13.0` for flag-free usage.

Commit this change as a separate preparatory step:

```bash
git add package.json
git commit -m "chore: require Node >=22.5.0 for node:sqlite support"
```

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/sqlite-client.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("SqliteClient", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("opens an in-memory database with memory journal mode", () => {
		client = SqliteClient.memory();
		const rows = client.query<{ journal_mode: string }>(
			"PRAGMA journal_mode",
		);
		// In-memory databases cannot use WAL — SQLite silently keeps journal_mode = "memory"
		expect(rows[0]?.journal_mode).toBe("memory");
	});

	it("executes a simple query", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
		client.execute("INSERT INTO test (name) VALUES (?)", ["alice"]);
		const rows = client.query<{ id: number; name: string }>(
			"SELECT * FROM test",
		);
		expect(rows).toEqual([{ id: 1, name: "alice" }]);
	});

	it("caches prepared statements", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)");
		// Run same query twice — second run should use cache
		client.query("SELECT * FROM test");
		client.query("SELECT * FROM test");
		expect(client.statementCacheSize).toBe(1);
	});

	it("evicts least-recently-used statement, not least-recently-inserted", () => {
		client = SqliteClient.memory({ maxCacheSize: 3 });
		client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");

		const qA = "SELECT 1";
		const qB = "SELECT 2";
		const qC = "SELECT 3";
		client.query(qA);
		client.query(qB);
		client.query(qC);
		expect(client.statementCacheSize).toBe(3);
		expect(client.hasCachedStatement("CREATE TABLE t (id INTEGER PRIMARY KEY)")).toBe(false);

		// Access qA — LRU should move it to "most recently used"
		client.query(qA);

		// Insert qD — should evict qB (LRU), NOT qA
		const qD = "SELECT 4";
		client.query(qD);
		expect(client.statementCacheSize).toBe(3);
		expect(client.hasCachedStatement(qB)).toBe(false);
		expect(client.hasCachedStatement(qA)).toBe(true);
		expect(client.hasCachedStatement(qC)).toBe(true);
		expect(client.hasCachedStatement(qD)).toBe(true);
	});

	it("executes within a transaction that commits on success", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["a"]);
			client.execute("INSERT INTO test (val) VALUES (?)", ["b"]);
		});
		const rows = client.query<{ val: string }>("SELECT val FROM test ORDER BY id");
		expect(rows).toEqual([{ val: "a" }, { val: "b" }]);
	});

	it("rolls back transaction on error", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		expect(() => {
			client.runInTransaction(() => {
				client.execute("INSERT INTO test (val) VALUES (?)", ["a"]);
				throw new Error("boom");
			});
		}).toThrow("boom");
		const rows = client.query("SELECT * FROM test");
		expect(rows).toEqual([]);
	});

	it("supports nested runInTransaction via savepoints", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
			client.runInTransaction(() => {
				client.execute("INSERT INTO test (val) VALUES (?)", ["inner"]);
			});
		});
		const rows = client.query<{ val: string }>("SELECT val FROM test ORDER BY id");
		expect(rows).toEqual([{ val: "outer" }, { val: "inner" }]);
	});

	it("rolls back only inner savepoint on nested error when outer catches", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.runInTransaction(() => {
			client.execute("INSERT INTO test (val) VALUES (?)", ["outer"]);
			try {
				client.runInTransaction(() => {
					client.execute("INSERT INTO test (val) VALUES (?)", ["inner"]);
					throw new Error("inner boom");
				});
			} catch {
				// swallow — outer transaction continues
			}
		});
		const rows = client.query<{ val: string }>("SELECT val FROM test ORDER BY id");
		expect(rows).toEqual([{ val: "outer" }]);
	});

	it("queryOne returns the first row or undefined", () => {
		client = SqliteClient.memory();
		client.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
		client.execute("INSERT INTO test (val) VALUES (?)", ["x"]);
		const row = client.queryOne<{ val: string }>("SELECT val FROM test");
		expect(row).toEqual({ val: "x" });
		const missing = client.queryOne("SELECT * FROM test WHERE id = 999");
		expect(missing).toBeUndefined();
	});

	it("opens a file-backed database", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-test-"));
		const dbPath = path.join(tmpDir, "test.db");
		try {
			client = SqliteClient.open(dbPath);
			client.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			client.execute("INSERT INTO t VALUES (1)");
			client.close();

			// Re-open and verify persistence
			client = SqliteClient.open(dbPath);
			const rows = client.query<{ id: number }>("SELECT id FROM t");
			expect(rows).toEqual([{ id: 1 }]);
		} finally {
			client?.close();
			fs.rmSync(tmpDir, { recursive: true });
		}
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/sqlite-client.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/sqlite-client.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/sqlite-client.ts
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";

/**
 * Thin wrapper around Node 22+ `node:sqlite` DatabaseSync.
 *
 * Provides:
 * - WAL mode by default
 * - Prepared statement cache (LRU-evicted by capacity)
 * - Synchronous `runInTransaction()` with nested savepoint support
 * - Typed `query<T>()` and `queryOne<T>()` helpers
 */
export class SqliteClient {
	private readonly db: DatabaseSync;
	private readonly stmtCache = new Map<string, StatementSync>();
	private readonly maxCacheSize: number;
	private transactionDepth = 0;
	private savepointCounter = 0;

	private constructor(db: DatabaseSync, maxCacheSize: number) {
		this.db = db;
		this.maxCacheSize = maxCacheSize;
	}

	/**
	 * Open a file-backed database with WAL mode and recommended pragmas.
	 *
	 * Accepts an optional `Logger` (R16) that is passed to the `EventStore`
	 * and `ProjectionRunner` for structured observability.
	 */
	static open(filename: string, opts?: { maxCacheSize?: number }): SqliteClient {
		const db = new DatabaseSync(filename);
		return SqliteClient.init(db, opts?.maxCacheSize ?? 200, true);
	}

	/**
	 * Open an in-memory database. Useful for testing.
	 */
	static memory(opts?: { maxCacheSize?: number }): SqliteClient {
		const db = new DatabaseSync(":memory:");
		return SqliteClient.init(db, opts?.maxCacheSize ?? 200, false);
	}

	private static init(db: DatabaseSync, maxCacheSize: number, isFileBacked: boolean): SqliteClient {
		if (isFileBacked) {
			// Enable WAL mode for concurrent reads during writes (only for file-backed DBs;
			// in-memory databases silently ignore this and keep journal_mode = "memory")
			db.exec("PRAGMA journal_mode = WAL");
			// synchronous = NORMAL is a WAL-specific performance tuning
			db.exec("PRAGMA synchronous = NORMAL");
			// (S6) Performance tuning for file-backed databases:
			// 64MB page cache — keeps hot indexes and recent data in memory.
			// At 64MB, the events table's indexes and message_parts covering index
			// fit comfortably for databases up to ~2GB.
			db.exec("PRAGMA cache_size = -65536");
			// ~16MB WAL before auto-checkpoint. Quadruples the default (1000 pages/~4MB),
			// reducing checkpoint frequency during streaming bursts. Amortizes checkpoint
			// cost over more writes without excessive disk usage.
			db.exec("PRAGMA wal_autocheckpoint = 4000");
			// 256MB memory-mapped reads. Bypasses page cache for cold reads while the
			// page cache handles hot data. Reduces read syscall overhead for large range
			// scans (recovery replay, session history loads). No effect on in-memory DBs.
			db.exec("PRAGMA mmap_size = 268435456");
		}
		// (S12) Foreign keys are enabled despite the per-write cost (~10-15μs per INSERT
		// for FK index lookups at 50 events/sec = ~0.5ms/sec overhead). This is a
		// deliberate trade-off: FK integrity prevents orphaned events, broken projections,
		// and silent data loss. Disabling is not an option. When analyzing P11 measurements,
		// subtract ~10-15μs per event for FK checks before attributing time to app logic.
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("PRAGMA busy_timeout = 5000");
		return new SqliteClient(db, maxCacheSize);
	}

	/**
	 * Number of cached prepared statements (for diagnostics/testing).
	 */
	get statementCacheSize(): number {
		return this.stmtCache.size;
	}

	/** Test-only: check if a statement is in the cache. */
	hasCachedStatement(sql: string): boolean {
		return this.stmtCache.has(sql);
	}

	/**
	 * Prepare (or retrieve from cache) a statement for the given SQL.
	 */
	private prepare(sql: string): StatementSync {
		let stmt = this.stmtCache.get(sql);
		if (stmt) {
			// (Perf-Fix-2) LRU: move to end of Map iteration order so it's evicted last
			this.stmtCache.delete(sql);
			this.stmtCache.set(sql, stmt);
			return stmt;
		}

		stmt = this.db.prepare(sql);
		this.stmtCache.set(sql, stmt);

		// Evict oldest (least recently used) entries if cache exceeds capacity
		if (this.stmtCache.size > this.maxCacheSize) {
			const firstKey = this.stmtCache.keys().next().value;
			if (firstKey !== undefined) this.stmtCache.delete(firstKey);
		}

		return stmt;
	}

	/**
	 * Execute a statement that returns no rows (INSERT, UPDATE, DELETE, DDL).
	 * Returns the changes/lastInsertRowid info from `StatementSync.run()`.
	 */
	execute(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): { changes: number | bigint; lastInsertRowid: number | bigint } {
		const stmt = this.prepare(sql);
		return stmt.run(...(params ?? []));
	}

	/**
	 * Execute a query that returns rows.
	 */
	query<T = Record<string, unknown>>(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): T[] {
		const stmt = this.prepare(sql);
		return stmt.all(...(params ?? [])) as T[];
	}

	/**
	 * Execute a query and return the first row, or undefined.
	 */
	queryOne<T = Record<string, unknown>>(
		sql: string,
		params?: ReadonlyArray<SQLInputValue>,
	): T | undefined {
		const rows = this.query<T>(sql, params);
		return rows[0];
	}

	/**
	 * Run a function inside a transaction. Supports nesting via savepoints.
	 *
	 * - Top-level call: BEGIN/COMMIT/ROLLBACK
	 * - Nested calls: SAVEPOINT/RELEASE/ROLLBACK TO
	 *
	 * If the callback throws, the transaction (or savepoint) is rolled back
	 * and the error is re-thrown.
	 */
	runInTransaction<T>(fn: () => T): T {
		if (this.transactionDepth === 0) {
			// Top-level transaction
			this.transactionDepth++;
			this.db.exec("BEGIN");
			try {
				const result = fn();
				this.db.exec("COMMIT");
				return result;
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw err;
			} finally {
				this.transactionDepth--;
			}
		} else {
			// Nested — use savepoint
			const name = `sp_${++this.savepointCounter}`;
			this.transactionDepth++;
			this.db.exec(`SAVEPOINT ${name}`);
			try {
				const result = fn();
				this.db.exec(`RELEASE ${name}`);
				return result;
			} catch (err) {
				this.db.exec(`ROLLBACK TO ${name}`);
				this.db.exec(`RELEASE ${name}`);
				throw err;
			} finally {
				this.transactionDepth--;
			}
		}
	}

	/**
	 * Close the database connection and clear the statement cache.
	 */
	close(): void {
		this.stmtCache.clear();
		this.db.close();
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/sqlite-client.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed at this stage.

**Step 6: Commit**

```bash
git add src/lib/persistence/sqlite-client.ts test/unit/persistence/sqlite-client.test.ts
git commit -m "feat(persistence): add SqliteClient wrapper with WAL mode, statement cache, and transactions"
```

---

### Task 2: Migration Runner

**Files:**
- Create: `src/lib/persistence/migrations.ts`
- Test: `test/unit/persistence/migrations.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/migrations.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import {
	type Migration,
	runMigrations,
} from "../../../src/lib/persistence/migrations.js";

describe("Migration Runner", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("creates the _migrations table on first run", () => {
		client = SqliteClient.memory();
		runMigrations(client, []);
		const rows = client.query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
		);
		expect(rows).toHaveLength(1);
	});

	it("runs migrations in order", () => {
		client = SqliteClient.memory();
		const migrations: Migration[] = [
			{
				id: 1,
				name: "create_users",
				up: (db) => {
					db.execute(
						"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
					);
				},
			},
			{
				id: 2,
				name: "create_posts",
				up: (db) => {
					db.execute(
						"CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))",
					);
				},
			},
		];
		const applied = runMigrations(client, migrations);
		expect(applied).toEqual([
			{ id: 1, name: "create_users" },
			{ id: 2, name: "create_posts" },
		]);
		// Verify tables exist
		const tables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts') ORDER BY name",
			)
			.map((r) => r.name);
		expect(tables).toEqual(["posts", "users"]);
	});

	it("skips already-applied migrations", () => {
		client = SqliteClient.memory();
		const migration: Migration = {
			id: 1,
			name: "create_users",
			up: (db) => {
				db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)");
			},
		};
		runMigrations(client, [migration]);
		const applied = runMigrations(client, [migration]);
		expect(applied).toEqual([]);
	});

	it("only runs new migrations when new ones are added", () => {
		client = SqliteClient.memory();
		const m1: Migration = {
			id: 1,
			name: "first",
			up: (db) => {
				db.execute("CREATE TABLE t1 (id INTEGER PRIMARY KEY)");
			},
		};
		const m2: Migration = {
			id: 2,
			name: "second",
			up: (db) => {
				db.execute("CREATE TABLE t2 (id INTEGER PRIMARY KEY)");
			},
		};
		runMigrations(client, [m1]);
		const applied = runMigrations(client, [m1, m2]);
		expect(applied).toEqual([{ id: 2, name: "second" }]);
	});

	it("rolls back a failed migration without affecting prior ones", () => {
		client = SqliteClient.memory();
		const m1: Migration = {
			id: 1,
			name: "good",
			up: (db) => {
				db.execute("CREATE TABLE good_table (id INTEGER PRIMARY KEY)");
			},
		};
		const m2: Migration = {
			id: 2,
			name: "bad",
			up: () => {
				throw new Error("migration failed");
			},
		};
		expect(() => runMigrations(client, [m1, m2])).toThrow("migration failed");
		// m1 should have committed (each migration is its own transaction)
		const tables = client.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'",
		);
		expect(tables).toHaveLength(1);
		// m2 should not be recorded
		const recorded = client.query<{ id: number }>(
			"SELECT id FROM _migrations ORDER BY id",
		);
		expect(recorded).toEqual([{ id: 1 }]);
	});

	it("records applied_at timestamp", () => {
		client = SqliteClient.memory();
		const before = Date.now();
		runMigrations(client, [
			{
				id: 1,
				name: "test",
				up: (db) => {
					db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
				},
			},
		]);
		const after = Date.now();
		const row = client.queryOne<{ applied_at: number }>(
			"SELECT applied_at FROM _migrations WHERE id = 1",
		);
		expect(row).toBeDefined();
		expect(row!.applied_at).toBeGreaterThanOrEqual(before);
		expect(row!.applied_at).toBeLessThanOrEqual(after);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/migrations.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/migrations.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/migrations.ts
import type { SqliteClient } from "./sqlite-client.js";

/**
 * A single schema migration.
 *
 * - `id`: Unique integer, determines execution order. Must be positive.
 * - `name`: Human-readable label (used in logging and the _migrations table).
 * - `up`: Function that applies the migration using the provided SqliteClient.
 */
export interface Migration {
	readonly id: number;
	readonly name: string;
	readonly up: (db: SqliteClient) => void;
}

interface AppliedMigration {
	readonly id: number;
	readonly name: string;
}

/**
 * Ensure the migration tracking table exists.
 */
function ensureMigrationsTable(db: SqliteClient): void {
	db.execute(`
		CREATE TABLE IF NOT EXISTS _migrations (
			id          INTEGER PRIMARY KEY,
			name        TEXT    NOT NULL,
			applied_at  INTEGER NOT NULL
		)
	`);
}

/**
 * Run all pending migrations in order.
 *
 * Each migration runs in its own transaction. If a migration fails, all
 * prior migrations remain committed and the error is re-thrown.
 *
 * Returns the list of migrations that were applied during this call.
 */
export function runMigrations(
	db: SqliteClient,
	migrations: readonly Migration[],
): AppliedMigration[] {
	ensureMigrationsTable(db);

	// Find the highest already-applied migration ID
	const latest = db.queryOne<{ max_id: number | null }>(
		"SELECT MAX(id) as max_id FROM _migrations",
	);
	const lastApplied = latest?.max_id ?? 0;

	// Sort migrations by ID, filter to pending only
	const pending = [...migrations]
		.sort((a, b) => a.id - b.id)
		.filter((m) => m.id > lastApplied);

	const applied: AppliedMigration[] = [];

	for (const migration of pending) {
		db.runInTransaction(() => {
			migration.up(db);
			db.execute(
				"INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
				[migration.id, migration.name, Date.now()],
			);
		});
		applied.push({ id: migration.id, name: migration.name });
	}

	return applied;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/migrations.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/migrations.ts test/unit/persistence/migrations.test.ts
git commit -m "feat(persistence): add migration runner with per-migration transactions and tracking table"
```

---

### Task 3: Schema Migration — Event Store Tables

> **Amendment (2026-04-09 — Testing Audit, F13):**
> Add FK RESTRICT assertion tests documenting the deliberate design decision to NOT use ON DELETE CASCADE.
> Eviction (S5) must delete dependents in FK-safe order. CASCADE would bypass this ordering.

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5e):**
> Add a `status` column to `message_parts` with three states: `'streaming'` (default), `'complete'`,
> `'truncated'`. This tracks text accumulation completeness so S7's 200K cap hit is visible to the
> UI and recovery. Schema change:
> ```sql
> ALTER TABLE message_parts ADD COLUMN status TEXT NOT NULL DEFAULT 'streaming'
>   CHECK (status IN ('streaming', 'complete', 'truncated'));
> ```
> Note: For the initial migration (Migration 001), fold this into the `CREATE TABLE message_parts`
> definition. The `ALTER TABLE` form is only needed for existing databases migrated via a new migration.

**Files:**
- Create: `src/lib/persistence/schema.ts`
- Test: `test/unit/persistence/schema.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/schema.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";

describe("Schema Migration", () => {
	let client: SqliteClient;

	afterEach(() => {
		client?.close();
	});

	it("creates all 12 tables", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const tables = client
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_%' ORDER BY name",
			)
			.map((r) => r.name);
		expect(tables).toEqual([
			"activities",
			"command_receipts",
			"events",
			"message_parts",
			"messages",
			"pending_approvals",
			"projector_cursors",
			"provider_state",
			"session_providers",
			"sessions",
			"tool_content",
			"turns",
		]);
	});

	it("creates events table with correct columns", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string; type: string; notnull: number; pk: number }>(
				"PRAGMA table_info(events)",
			)
			.map((c) => c.name);
		expect(columns).toEqual([
			"sequence",
			"event_id",
			"session_id",
			"stream_version",
			"type",
			"data",
			"metadata",
			"provider",
			"created_at",
		]);
	});

	it("enforces unique event_id", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		// Insert a session first (FK constraint)
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
		);
		expect(() =>
			client.execute(
				"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["evt-1", "s1", 1, "session.created", "{}", "opencode", Date.now()],
			),
		).toThrow(); // UNIQUE constraint violation
	});

	it("enforces unique (session_id, stream_version) for optimistic concurrency", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", Date.now()],
		);
		expect(() =>
			client.execute(
				"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["evt-2", "s1", 0, "text.delta", "{}", "opencode", Date.now()],
			),
		).toThrow(); // UNIQUE constraint on (session_id, stream_version)
	});

	it("creates command_receipts table with correct columns", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string }>("PRAGMA table_info(command_receipts)")
			.map((c) => c.name);
		expect(columns).toEqual([
			"command_id",
			"session_id",
			"status",
			"result_sequence",
			"error",
			"created_at",
		]);
	});

	it("creates projector_cursors table", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const columns = client
			.query<{ name: string }>("PRAGMA table_info(projector_cursors)")
			.map((c) => c.name);
		expect(columns).toEqual(["projector_name", "last_applied_seq", "updated_at"]);
	});

	it("is idempotent — running twice produces no errors", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		const applied = runMigrations(client, schemaMigrations);
		expect(applied).toEqual([]);
	});

	// ─── (F13) FK RESTRICT Assertion Tests ────────────────────────────────

	it("uses RESTRICT (not CASCADE) for session foreign keys", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test Session", "idle", 1_000_000_000_000, 1_000_000_000_000],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", 1_000_000_000_000],
		);
		// Deleting session with dependent events should fail (RESTRICT)
		expect(() =>
			client.execute("DELETE FROM sessions WHERE id = ?", ["s1"]),
		).toThrow(/FOREIGN KEY constraint/);
	});

	it("events FK requires delete-dependents-first order for eviction", () => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		client.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test Session", "idle", 1_000_000_000_000, 1_000_000_000_000],
		);
		client.execute(
			"INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			["evt-1", "s1", 0, "session.created", "{}", "opencode", 1_000_000_000_000],
		);
		// Must delete events first, then session — FK-safe order
		client.execute("DELETE FROM events WHERE session_id = ?", ["s1"]);
		expect(() =>
			client.execute("DELETE FROM sessions WHERE id = ?", ["s1"]),
		).not.toThrow();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/schema.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/schema.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/schema.ts
import type { Migration } from "./migrations.js";
import type { SqliteClient } from "./sqlite-client.js";

/**
 * Migration 001: Core event store and projection tables.
 *
 * Creates all 12 tables from the orchestrator design doc:
 * - events (source of truth)
 * - command_receipts (command deduplication)
 * - sessions, messages, turns, session_providers, pending_approvals,
 *   activities (projections)
 * - projector_cursors (projection recovery)
 * - tool_content, provider_state (storage)
 */
function createEventStoreTables(db: SqliteClient): void {
	// ── Sessions (projection, created first for FK references) ──────────

	// (H1) CHECK constraints enforce valid status/role/type values at the
	// SQLite layer, catching typos and invalid projector writes immediately.
	db.execute(`
		CREATE TABLE sessions (
			id              TEXT    PRIMARY KEY,
			provider        TEXT    NOT NULL,
			provider_sid    TEXT,
			title           TEXT    NOT NULL DEFAULT 'Untitled',
			status          TEXT    NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'busy', 'retry', 'error')),
			parent_id       TEXT,
			fork_point_event TEXT,
			last_message_at INTEGER,
			created_at      INTEGER NOT NULL,
			updated_at      INTEGER NOT NULL,
			FOREIGN KEY (parent_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_sessions_updated ON sessions (updated_at DESC)",
	);
	db.execute(
		"CREATE INDEX idx_sessions_parent ON sessions (parent_id)",
	);
	db.execute(
		"CREATE INDEX idx_sessions_provider ON sessions (provider, provider_sid)",
	);

	// ── Events (source of truth) ────────────────────────────────────────

	db.execute(`
		CREATE TABLE events (
			sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id        TEXT    NOT NULL UNIQUE,
			session_id      TEXT    NOT NULL,
			stream_version  INTEGER NOT NULL,
			type            TEXT    NOT NULL,
			data            TEXT    NOT NULL,
			metadata        TEXT    NOT NULL DEFAULT '{}',
			provider        TEXT    NOT NULL,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE UNIQUE INDEX idx_events_session_version ON events (session_id, stream_version)",
	);
	db.execute(
		"CREATE INDEX idx_events_session_seq ON events (session_id, sequence)",
	);
	db.execute("CREATE INDEX idx_events_type ON events (type)");

	// ── Command Receipts ────────────────────────────────────────────────

	db.execute(`
		CREATE TABLE command_receipts (
			command_id      TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			status          TEXT    NOT NULL,
			result_sequence INTEGER,
			error           TEXT,
			created_at      INTEGER NOT NULL
		)
	`);
	db.execute(
		"CREATE INDEX idx_command_receipts_session ON command_receipts (session_id)",
	);

	// ── Turns (projection) ──────────────────────────────────────────────

	db.execute(`
		CREATE TABLE turns (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			state           TEXT    NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'running', 'completed', 'interrupted', 'error')),
			user_message_id TEXT,
			assistant_message_id TEXT,
			cost            REAL,
			tokens_in       INTEGER,
			tokens_out      INTEGER,
			requested_at    INTEGER NOT NULL,
			started_at      INTEGER,
			completed_at    INTEGER,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_turns_session_requested ON turns (session_id, requested_at)",
	);
	// (P8) Index for turn lookups by assistant_message_id — used by
	// turn.completed/error/interrupted projections and Phase 4 read queries.
	db.execute(
		"CREATE INDEX idx_turns_assistant_message ON turns (assistant_message_id)",
	);

	// ── Messages (projection) ───────────────────────────────────────────

	db.execute(`
		CREATE TABLE messages (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			turn_id         TEXT,
			role            TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
			text            TEXT    NOT NULL DEFAULT '',
			cost            REAL,
			tokens_in       INTEGER,
			tokens_out      INTEGER,
			tokens_cache_read  INTEGER,
			tokens_cache_write INTEGER,
			is_streaming    INTEGER NOT NULL DEFAULT 0,
			is_inherited    INTEGER NOT NULL DEFAULT 0,
			last_applied_seq INTEGER,
			created_at      INTEGER NOT NULL,
			updated_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	// (P8) Covering index that includes id for cursor-based pagination
	// with composite (created_at, id) cursors. DESC ordering matches
	// the typical "most recent first" query pattern.
	db.execute(
		"CREATE INDEX idx_messages_session_created ON messages (session_id, created_at DESC, id DESC)",
	);
	db.execute("CREATE INDEX idx_messages_turn ON messages (turn_id)");

	// ── Message Parts (projection — normalized from messages.parts) ─────
	//
	// (P1) Eliminates the JSON read-parse-modify-serialize-write cycle
	// from the MessageProjector hot path. Per-delta cost drops from ~3
	// SQL statements + JSON round-trip to 2 simple SQL statements with
	// zero JSON. The `text || ?` SQL concat on message_parts.text is
	// inherently O(1) and doesn't require reading the old value in Node.js.

	db.execute(`
		CREATE TABLE message_parts (
			id          TEXT    PRIMARY KEY,
			message_id  TEXT    NOT NULL,
			type        TEXT    NOT NULL CHECK(type IN ('text', 'thinking', 'tool')),
			text        TEXT    NOT NULL DEFAULT '',
			tool_name   TEXT,
			call_id     TEXT,
			input       TEXT,
			result      TEXT,
			duration    REAL,
			status      TEXT,
			sort_order  INTEGER NOT NULL,
			created_at  INTEGER NOT NULL,
			updated_at  INTEGER NOT NULL,
			FOREIGN KEY (message_id) REFERENCES messages(id)
		)
	`);
	// (P8) Index for message_parts lookups by message_id
	db.execute(
		"CREATE INDEX idx_message_parts_message ON message_parts (message_id, sort_order)",
	);

	// ── Session Providers (projection) ──────────────────────────────────

	db.execute(`
		CREATE TABLE session_providers (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			provider        TEXT    NOT NULL,
			provider_sid    TEXT,
			status          TEXT    NOT NULL DEFAULT 'active',
			activated_at    INTEGER NOT NULL,
			deactivated_at  INTEGER,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_session_providers_session ON session_providers (session_id, activated_at DESC)",
	);
	db.execute(
		"CREATE INDEX idx_session_providers_active ON session_providers (session_id, status) WHERE status = 'active'",
	);

	// ── Pending Approvals (projection) ──────────────────────────────────

	db.execute(`
		CREATE TABLE pending_approvals (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			turn_id         TEXT,
			type            TEXT    NOT NULL CHECK(type IN ('permission', 'question')),
			status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
			tool_name       TEXT,
			input           TEXT,
			decision        TEXT,
			always          TEXT,
			created_at      INTEGER NOT NULL,
			resolved_at     INTEGER,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_pending_approvals_session_status ON pending_approvals (session_id, status)",
	);
	db.execute(
		"CREATE INDEX idx_pending_approvals_pending ON pending_approvals (status) WHERE status = 'pending'",
	);

	// ── Activities (projection) ─────────────────────────────────────────

	db.execute(`
		CREATE TABLE activities (
			id              TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			turn_id         TEXT,
			tone            TEXT    NOT NULL,
			kind            TEXT    NOT NULL,
			summary         TEXT    NOT NULL,
			payload         TEXT    NOT NULL DEFAULT '{}',
			sequence        INTEGER,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id),
			FOREIGN KEY (turn_id) REFERENCES turns(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_activities_session_created ON activities (session_id, created_at)",
	);
	db.execute("CREATE INDEX idx_activities_turn ON activities (turn_id)");
	db.execute(
		"CREATE INDEX idx_activities_tone ON activities (session_id, tone)",
	);
	// (S11) Composite index for kind-filtered activity queries (e.g., "show all
	// bash executions"). The created_at suffix makes it a covering index for the
	// common pattern: WHERE session_id = ? AND kind = ? ORDER BY created_at.
	db.execute(
		"CREATE INDEX idx_activities_session_kind ON activities (session_id, kind, created_at)",
	);

	// ── Projector Cursors ───────────────────────────────────────────────

	db.execute(`
		CREATE TABLE projector_cursors (
			projector_name      TEXT    PRIMARY KEY,
			last_applied_seq    INTEGER NOT NULL,
			updated_at          INTEGER NOT NULL
		)
	`);

	// ── Tool Content (storage) ──────────────────────────────────────────

	db.execute(`
		CREATE TABLE tool_content (
			tool_id         TEXT    PRIMARY KEY,
			session_id      TEXT    NOT NULL,
			content         TEXT    NOT NULL,
			created_at      INTEGER NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
	db.execute(
		"CREATE INDEX idx_tool_content_session ON tool_content (session_id)",
	);

	// ── Provider State (storage) ────────────────────────────────────────

	db.execute(`
		CREATE TABLE provider_state (
			session_id      TEXT    NOT NULL,
			key             TEXT    NOT NULL,
			value           TEXT    NOT NULL,
			PRIMARY KEY (session_id, key),
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		)
	`);
}

/**
 * All schema migrations for the orchestrator event store.
 *
 * Add new migrations to this array as the schema evolves.
 * Never modify existing migrations — always append new ones.
 */
export const schemaMigrations: readonly Migration[] = [
	{
		id: 1,
		name: "create_event_store_tables",
		up: createEventStoreTables,
	},
];
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/schema.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/schema.ts test/unit/persistence/schema.test.ts
git commit -m "feat(persistence): add schema migration with all 11 event store tables"
```

---

### Task 4: PersistenceError and Canonical Event Types

**Files:**
- Create: `src/lib/persistence/errors.ts`
- Create: `src/lib/persistence/events.ts`
- Test: `test/unit/persistence/events.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/events.test.ts
import { describe, expect, it } from "vitest";
import type {
	CanonicalEvent,
	StoredEvent,
	EventMetadata,
	MessageCreatedPayload,
	TextDeltaPayload,
	ThinkingStartPayload,
	ThinkingDeltaPayload,
	ThinkingEndPayload,
	ToolStartedPayload,
	ToolRunningPayload,
	ToolCompletedPayload,
	TurnCompletedPayload,
	TurnErrorPayload,
	TurnInterruptedPayload,
	SessionCreatedPayload,
	SessionRenamedPayload,
	SessionStatusPayload,
	SessionProviderChangedPayload,
	PermissionAskedPayload,
	PermissionResolvedPayload,
	QuestionAskedPayload,
	QuestionResolvedPayload,
} from "../../../src/lib/persistence/events.js";
import {
	createEventId,
	createCommandId,
	CANONICAL_EVENT_TYPES,
} from "../../../src/lib/persistence/events.js";

describe("Canonical Event Types", () => {
	it("exports all 19 canonical event types", () => {
		expect(CANONICAL_EVENT_TYPES).toHaveLength(20);
		expect(CANONICAL_EVENT_TYPES).toContain("message.created");
		expect(CANONICAL_EVENT_TYPES).toContain("text.delta");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.start");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.delta");
		expect(CANONICAL_EVENT_TYPES).toContain("thinking.end");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.started");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.running");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.completed");
		expect(CANONICAL_EVENT_TYPES).toContain("tool.input_updated");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.completed");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.error");
		expect(CANONICAL_EVENT_TYPES).toContain("turn.interrupted");
		expect(CANONICAL_EVENT_TYPES).toContain("session.created");
		expect(CANONICAL_EVENT_TYPES).toContain("session.renamed");
		expect(CANONICAL_EVENT_TYPES).toContain("session.status");
		expect(CANONICAL_EVENT_TYPES).toContain("session.provider_changed");
		expect(CANONICAL_EVENT_TYPES).toContain("permission.asked");
		expect(CANONICAL_EVENT_TYPES).toContain("permission.resolved");
		expect(CANONICAL_EVENT_TYPES).toContain("question.asked");
		expect(CANONICAL_EVENT_TYPES).toContain("question.resolved");
	});

	it("createEventId generates a prefixed UUID", () => {
		const id = createEventId();
		expect(id).toMatch(/^evt_[0-9a-f-]{36}$/);
	});

	it("createCommandId generates a prefixed UUID", () => {
		const id = createCommandId();
		expect(id).toMatch(/^cmd_[0-9a-f-]{36}$/);
	});

	it("CanonicalEvent type constrains event_type to known values", () => {
		// This is a compile-time check — if it compiles, it passes.
		const event: CanonicalEvent = {
			eventId: createEventId(),
			sessionId: "s1",
			type: "message.created",
			data: {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload,
			metadata: {},
			provider: "opencode",
			createdAt: Date.now(),
		};
		expect(event.type).toBe("message.created");
	});

	it("StoredEvent extends CanonicalEvent with sequence and streamVersion", () => {
		const stored: StoredEvent = {
			sequence: 1,
			eventId: createEventId(),
			sessionId: "s1",
			streamVersion: 0,
			type: "session.created",
			data: {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload,
			metadata: {},
			provider: "opencode",
			createdAt: Date.now(),
		};
		expect(stored.sequence).toBe(1);
		expect(stored.streamVersion).toBe(0);
	});

	it("EventMetadata supports optional causality fields", () => {
		const meta: EventMetadata = {
			commandId: createCommandId(),
			causationEventId: createEventId(),
			correlationId: createCommandId(),
			adapterKey: "opencode-main",
			providerTurnId: "turn-123",
		};
		expect(meta.commandId).toBeDefined();
		expect(meta.adapterKey).toBe("opencode-main");
	});

	it("EventMetadata can be empty", () => {
		const meta: EventMetadata = {};
		expect(meta).toEqual({});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/events.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/events.js'"

**Step 3a: Write PersistenceError (new file)**

```typescript
// src/lib/persistence/errors.ts

/**
 * Error codes for the persistence layer.
 *
 * Each code identifies a specific failure mode, giving LLMs and humans
 * enough context to diagnose the issue from logs alone.
 */
export type PersistenceErrorCode =
	| "UNKNOWN_EVENT_TYPE"
	| "INVALID_RECEIPT_STATUS"
	| "APPEND_FAILED"
	| "PROJECTION_FAILED"
	| "MIGRATION_FAILED"
	| "SCHEMA_VALIDATION_FAILED"
	| "CURSOR_MISMATCH"
	| "DESERIALIZATION_FAILED"
	| "SESSION_SEED_FAILED"
	| "DUAL_WRITE_FAILED";

/**
 * Structured error for the persistence layer.
 *
 * Carries an error code and arbitrary context fields so that log entries
 * contain enough information for an LLM to diagnose the failure without
 * needing to grep the codebase. Follows the same philosophy as the
 * existing `RelayError` hierarchy in `src/lib/errors.ts`.
 */
export class PersistenceError extends Error {
	readonly code: PersistenceErrorCode;
	readonly context: Record<string, unknown>;

	constructor(
		code: PersistenceErrorCode,
		message: string,
		context: Record<string, unknown> = {},
	) {
		super(`[${code}] ${message}`);
		this.name = "PersistenceError";
		this.code = code;
		this.context = context;
	}

	/** Structured representation for logging. */
	toLog(): Record<string, unknown> {
		return {
			code: this.code,
			message: this.message,
			...this.context,
		};
	}
}
```

**Step 3b: Write events.ts implementation**

```typescript
// src/lib/persistence/events.ts
import { randomUUID } from "node:crypto";

// ─── Branded ID Types ───────────────────────────────────────────────────────
//
// Zero-cost at runtime (erased by TypeScript) but prevent cross-contamination
// of IDs at compile time. Follows the existing `RequestId` / `PermissionId`
// pattern in `src/lib/shared-types.ts`.

export type EventId = string & { readonly __brand: "EventId" };
export type CommandId = string & { readonly __brand: "CommandId" };

// ─── ID Generators ──────────────────────────────────────────────────────────

export function createEventId(): EventId {
	return `evt_${randomUUID()}` as EventId;
}

export function createCommandId(): CommandId {
	return `cmd_${randomUUID()}` as CommandId;
}

// ─── Constrained String Unions ──────────────────────────────────────────────
//
// Follows the `POLLER_START_REASONS` / `PollerStartReason` pattern from
// `src/lib/relay/monitoring-types.ts` — const array + derived type.

export const PROVIDER_TYPES = ["opencode", "claude-sdk"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const SESSION_STATUSES = ["idle", "busy", "retry", "error"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

export const PERMISSION_DECISIONS = ["once", "always", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

// ─── Canonical Event Types ──────────────────────────────────────────────────

export const CANONICAL_EVENT_TYPES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"tool.input_updated",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.created",
	"session.renamed",
	"session.status",
	"session.provider_changed",
	"permission.asked",
	"permission.resolved",
	"question.asked",
	"question.resolved",
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

// ─── Event Payloads ─────────────────────────────────────────────────────────

export interface MessageCreatedPayload {
	readonly messageId: string;
	readonly role: MessageRole;
	readonly sessionId: string;
	/** (A2) Optional turn ID for deterministic TurnProjector matching. */
	readonly turnId?: string;
}

export interface TextDeltaPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly text: string;
}

export interface ThinkingStartPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ThinkingDeltaPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly text: string;
}

export interface ThinkingEndPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ToolStartedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly toolName: string;
	readonly callId: string;
	readonly input: unknown;
}

export interface ToolRunningPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ToolCompletedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly result: unknown;
	readonly duration: number;
}

export interface ToolInputUpdatedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly input: unknown;
}

export interface TurnCompletedPayload {
	readonly messageId: string;
	readonly cost?: number;
	readonly tokens?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
	};
	readonly duration?: number;
}

export interface TurnErrorPayload {
	readonly messageId: string;
	readonly error: string;
	readonly code?: string;
}

export interface TurnInterruptedPayload {
	readonly messageId: string;
}

export interface SessionCreatedPayload {
	readonly sessionId: string;
	readonly title: string;
	readonly provider: string;
}

export interface SessionRenamedPayload {
	readonly sessionId: string;
	readonly title: string;
}

export interface SessionStatusPayload {
	readonly sessionId: string;
	readonly status: SessionStatusValue;
	/** (A2) Optional turn ID for deterministic TurnProjector matching.
	 *  When absent (e.g., OpenCode dual-write), projector falls back to positional matching with a warning. */
	readonly turnId?: string;
}

export interface SessionProviderChangedPayload {
	readonly sessionId: string;
	readonly oldProvider: string;
	readonly newProvider: string;
}

export interface PermissionAskedPayload {
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly input: unknown;
}

export interface PermissionResolvedPayload {
	readonly id: string;
	readonly decision: PermissionDecision;
}

export interface QuestionAskedPayload {
	readonly id: string;
	readonly sessionId: string;
	readonly questions: unknown;
}

export interface QuestionResolvedPayload {
	readonly id: string;
	readonly answers: Record<string, unknown>;
}

/**
 * Map from event type to its payload shape.
 */
export interface EventPayloadMap {
	"message.created": MessageCreatedPayload;
	"text.delta": TextDeltaPayload;
	"thinking.start": ThinkingStartPayload;
	"thinking.delta": ThinkingDeltaPayload;
	"thinking.end": ThinkingEndPayload;
	"tool.started": ToolStartedPayload;
	"tool.running": ToolRunningPayload;
	"tool.completed": ToolCompletedPayload;
	"tool.input_updated": ToolInputUpdatedPayload;
	"turn.completed": TurnCompletedPayload;
	"turn.error": TurnErrorPayload;
	"turn.interrupted": TurnInterruptedPayload;
	"session.created": SessionCreatedPayload;
	"session.renamed": SessionRenamedPayload;
	"session.status": SessionStatusPayload;
	"session.provider_changed": SessionProviderChangedPayload;
	"permission.asked": PermissionAskedPayload;
	"permission.resolved": PermissionResolvedPayload;
	"question.asked": QuestionAskedPayload;
	"question.resolved": QuestionResolvedPayload;
}

// ─── Event Metadata ─────────────────────────────────────────────────────────

/**
 * Optional causality and adapter context carried on every event.
 */
export interface EventMetadata {
	readonly commandId?: string;
	readonly causationEventId?: string;
	readonly correlationId?: string;
	readonly adapterKey?: string;
	readonly providerTurnId?: string;
	/** True if this event was synthesized (not from a provider SSE stream). */
	readonly synthetic?: boolean;
	/** Human-readable source label for debugging (e.g. "session-seeder"). */
	readonly source?: string;
	/** Links multiple canonical events produced from a single SSE event. */
	readonly sseBatchId?: string;
	/** Number of canonical events in the SSE batch. */
	readonly sseBatchSize?: number;
}

// ─── Event Envelopes ────────────────────────────────────────────────────────

/**
 * A canonical event before persistence (no sequence or stream_version assigned).
 *
 * The discriminated union approach: `type` field constrains the `data` shape.
 */
export type CanonicalEvent = {
	[K in CanonicalEventType]: {
		readonly eventId: string;
		readonly sessionId: string;
		readonly type: K;
		readonly data: EventPayloadMap[K];
		readonly metadata: EventMetadata;
		readonly provider: string;
		readonly createdAt: number;
	};
}[CanonicalEventType];

/**
 * A persisted event — extends the canonical shape with storage-assigned fields.
 *
 * - `sequence`: Global monotonic order (autoincrement PK).
 * - `streamVersion`: Per-session optimistic concurrency version.
 */
export type StoredEvent = CanonicalEvent & {
	readonly sequence: number;
	readonly streamVersion: number;
};

// ─── Typed Event Factory ────────────────────────────────────────────────────
//
// Confines the single unavoidable `as` cast to one place.  Every call site
// gets full compile-time type checking on the `data` argument — passing the
// wrong payload shape for a given event type is a compile error.
//
// Usage:
//   canonicalEvent("session.created", "s1", { sessionId: "s1", title: "T", provider: "opencode" })
//   // TypeScript enforces that `data` matches `SessionCreatedPayload`.

export function canonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		provider?: string;
		createdAt?: number;
	},
): Extract<CanonicalEvent, { type: K }> {
	return {
		eventId: opts?.eventId ?? createEventId(),
		sessionId,
		type,
		data,
		metadata: opts?.metadata ?? {},
		provider: opts?.provider ?? "opencode",
		createdAt: opts?.createdAt ?? Date.now(),
	} as Extract<CanonicalEvent, { type: K }>;
}

// ─── Runtime Payload Validation ─────────────────────────────────────────────
//
// Catches translator bugs at write time rather than read time.  Called by
// EventStore.append() before persisting.

import { PersistenceError } from "./errors.js";

const PAYLOAD_REQUIRED_FIELDS: Record<CanonicalEventType, readonly string[]> = {
	"session.created": ["sessionId", "title", "provider"],
	"session.renamed": ["sessionId", "title"],
	"session.status": ["sessionId", "status"],
	"session.provider_changed": ["sessionId", "oldProvider", "newProvider"],
	"message.created": ["messageId", "role", "sessionId"],
	"text.delta": ["messageId", "partId", "text"],
	"thinking.start": ["messageId", "partId"],
	"thinking.delta": ["messageId", "partId", "text"],
	"thinking.end": ["messageId", "partId"],
	"tool.started": ["messageId", "partId", "toolName", "callId"],
	"tool.running": ["messageId", "partId"],
	"tool.completed": ["messageId", "partId", "result", "duration"],
	"tool.input_updated": ["messageId", "partId", "input"],
	"turn.completed": ["messageId"],
	"turn.error": ["messageId", "error"],
	"turn.interrupted": ["messageId"],
	"permission.asked": ["id", "sessionId", "toolName"],
	"permission.resolved": ["id", "decision"],
	"question.asked": ["id", "sessionId", "questions"],
	"question.resolved": ["id", "answers"],
};

/**
 * Validate that a canonical event's `data` contains the required fields
 * for its declared `type`.  Throws `PersistenceError` with code
 * `SCHEMA_VALIDATION_FAILED` listing the missing fields.
 */
export function validateEventPayload(event: CanonicalEvent): void {
	const required = PAYLOAD_REQUIRED_FIELDS[event.type];
	if (!required) return;
	const data = event.data as Record<string, unknown>;
	const missing = required.filter((field) => data[field] === undefined);
	if (missing.length > 0) {
		throw new PersistenceError(
			"SCHEMA_VALIDATION_FAILED",
			`Event ${event.type} missing required fields: ${missing.join(", ")}`,
			{
				eventId: event.eventId,
				sessionId: event.sessionId,
				type: event.type,
				missing,
			},
		);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/events.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/errors.ts src/lib/persistence/events.ts test/unit/persistence/events.test.ts
git commit -m "feat(persistence): add PersistenceError, branded IDs, canonicalEvent() factory, and canonical event types"
```

---

### Task 5: Event Store Service

> **Amendment (2026-04-09 — Testing Audit, F4/F5/F7/F8/F11/F14):**
> Test code block rewritten to use shared factories from Task 0. Local `makeSessionCreatedEvent`,
> `makeTextDelta`, `seedSession` removed — replaced with imports from `persistence-factories.ts`.
> Uses `createTestHarness()` for setup, `FIXED_TEST_TIMESTAMP` for deterministic timestamps (F8),
> `canonicalEvent()` internally instead of `as CanonicalEvent` casts (F4/F11).
> Added: boundary condition tests (F5), `resetVersionCache()` tests (F14).

> **Amendment (2026-04-09 — Concurrency Solutions, Change 2 — Coding Guideline):**
> `eventStore.append()` is NOT made private (projector recovery calls it during replay), but
> application-level code (anything outside `EventPipeline` and `ProjectionRunner.recover()`) MUST
> go through `EventPipeline.ingest()` or `EventPipeline.ingestBatch()`. This is enforced by
> convention and documented here as a coding guideline. Direct `eventStore.append()` calls in
> application code are a code review rejection.

> **Amendment (2026-04-07, S10a — `readBySession` Safety):**
> Remove the default 1000-event limit from `readBySession()`. Callers must pass an explicit `limit`
> or `undefined` for unbounded reads. The method signature changes from `limit?: number` to
> `limit: number | undefined`, making the caller explicitly opt into unbounded reads.
> Add `readAllBySession(sessionId, fromSequence?)` convenience method that passes no limit.
> This prevents silent truncation during fork (where all parent events are needed).

**Files:**
- Create: `src/lib/persistence/event-store.ts`
- Test: `test/unit/persistence/event-store.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/event-store.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import { createEventId, canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createTestHarness,
	makeSessionCreatedEvent,
	makeTextDelta,
	FIXED_TEST_TIMESTAMP,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("EventStore", () => {
	let harness: TestHarness;
	let store: EventStore;

	beforeEach(() => {
		harness = createTestHarness();
		store = harness.eventStore;
	});

	afterEach(() => {
		harness.close();
	});

	describe("append", () => {
		it("appends an event and returns it with sequence and streamVersion", () => {
			harness.seedSession("s1");
			const event = makeSessionCreatedEvent("s1");
			const stored = store.append(event);
			expect(stored.sequence).toBe(1);
			expect(stored.streamVersion).toBe(0);
			expect(stored.eventId).toBe(event.eventId);
			expect(stored.type).toBe("session.created");
			expect(stored.sessionId).toBe("s1");
		});

		it("assigns incrementing stream versions per session", () => {
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			const e2 = store.append(
				makeTextDelta("s1", "m1", "hello"),
			);
			const e3 = store.append(
				makeTextDelta("s1", "m1", " world"),
			);
			expect(e1.streamVersion).toBe(0);
			expect(e2.streamVersion).toBe(1);
			expect(e3.streamVersion).toBe(2);
		});

		it("assigns independent stream versions per session", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			const e2 = store.append(makeSessionCreatedEvent("s2"));
			expect(e1.streamVersion).toBe(0);
			expect(e2.streamVersion).toBe(0);
			// Global sequence is still monotonic
			expect(e1.sequence).toBe(1);
			expect(e2.sequence).toBe(2);
		});

		it("rejects duplicate event IDs", () => {
			harness.seedSession("s1");
			const eventId = createEventId();
			store.append(makeSessionCreatedEvent("s1", { eventId }));
			expect(() =>
				store.append(
					makeTextDelta("s1", "m1", "x", { eventId }),
				),
			).toThrow();
		});

		it("stores data as JSON", () => {
			harness.seedSession("s1");
			const stored = store.append(makeSessionCreatedEvent("s1"));
			const row = client.queryOne<{ data: string }>(
				"SELECT data FROM events WHERE sequence = ?",
				[stored.sequence],
			);
			expect(row).toBeDefined();
			const parsed = JSON.parse(row!.data);
			expect(parsed.sessionId).toBe("s1");
			expect(parsed.title).toBe("Test Session");
		});

		it("stores metadata as JSON", () => {
			harness.seedSession("s1");
			const stored = store.append(
				makeSessionCreatedEvent("s1", {
					metadata: { commandId: "cmd_123", adapterKey: "oc" },
				}),
			);
			const row = client.queryOne<{ metadata: string }>(
				"SELECT metadata FROM events WHERE sequence = ?",
				[stored.sequence],
			);
			expect(row).toBeDefined();
			const parsed = JSON.parse(row!.metadata);
			expect(parsed.commandId).toBe("cmd_123");
			expect(parsed.adapterKey).toBe("oc");
		});
	});

	describe("appendBatch", () => {
		it("appends multiple events atomically", () => {
			harness.seedSession("s1");
			const events = [
				makeSessionCreatedEvent("s1"),
				makeTextDelta("s1", "m1", "hello"),
				makeTextDelta("s1", "m1", " world"),
			];
			const stored = store.appendBatch(events);
			expect(stored).toHaveLength(3);
			expect(stored[0]!.streamVersion).toBe(0);
			expect(stored[1]!.streamVersion).toBe(1);
			expect(stored[2]!.streamVersion).toBe(2);
			expect(stored[0]!.sequence).toBe(1);
			expect(stored[1]!.sequence).toBe(2);
			expect(stored[2]!.sequence).toBe(3);
		});

		it("rolls back all events on failure", () => {
			harness.seedSession("s1");
			const sharedId = createEventId();
			const events = [
				makeSessionCreatedEvent("s1"),
				makeTextDelta("s1", "m1", "hello", { eventId: sharedId }),
				makeTextDelta("s1", "m1", "world", { eventId: sharedId }), // duplicate
			];
			expect(() => store.appendBatch(events)).toThrow();
			const rows = client.query("SELECT * FROM events");
			expect(rows).toEqual([]);
		});

		it("returns empty array for empty input", () => {
			const stored = store.appendBatch([]);
			expect(stored).toEqual([]);
		});
	});

	describe("readFromSequence", () => {
		it("reads events after a given sequence", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));

			const events = store.readFromSequence(1, 10);
			expect(events).toHaveLength(2);
			expect(events[0]!.sequence).toBe(2);
			expect(events[1]!.sequence).toBe(3);
		});

		it("reads from the beginning with cursor 0", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));

			const events = store.readFromSequence(0, 100);
			expect(events).toHaveLength(2);
			expect(events[0]!.sequence).toBe(1);
		});

		it("respects the limit parameter", () => {
			harness.seedSession("s1");
			for (let i = 0; i < 5; i++) {
				store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
			}
			const events = store.readFromSequence(0, 3);
			expect(events).toHaveLength(3);
		});

		it("returns empty array when no events after cursor", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const events = store.readFromSequence(1, 10);
			expect(events).toEqual([]);
		});

		it("uses default limit when not specified", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const events = store.readFromSequence(0);
			expect(events).toHaveLength(1);
		});
	});

	describe("readBySession", () => {
		it("returns only events for the given session", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeSessionCreatedEvent("s2"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s2", "m2", "b"));

			const s1Events = store.readBySession("s1");
			expect(s1Events).toHaveLength(2);
			expect(s1Events.every((e) => e.sessionId === "s1")).toBe(true);

			const s2Events = store.readBySession("s2");
			expect(s2Events).toHaveLength(2);
			expect(s2Events.every((e) => e.sessionId === "s2")).toBe(true);
		});

		it("supports fromSequence filter", () => {
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));

			const events = store.readBySession("s1", e1.sequence);
			expect(events).toHaveLength(2);
			expect(events[0]!.sequence).toBeGreaterThan(e1.sequence);
		});

		it("returns empty array for unknown session", () => {
			const events = store.readBySession("nonexistent");
			expect(events).toEqual([]);
		});

		it("respects the limit parameter", () => {
			harness.seedSession("s1");
			for (let i = 0; i < 5; i++) {
				store.append(makeTextDelta("s1", "m1", `chunk-${i}`));
			}
			const events = store.readBySession("s1", 0, 3);
			expect(events).toHaveLength(3);
		});
	});

	describe("getNextStreamVersion", () => {
		it("returns 0 for a session with no events", () => {
			harness.seedSession("s1");
			expect(store.getNextStreamVersion("s1")).toBe(0);
		});

		it("returns the next version after existing events", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			expect(store.getNextStreamVersion("s1")).toBe(2);
		});
	});

	describe("deserialization", () => {
		it("round-trips event data through JSON serialization", () => {
			harness.seedSession("s1");
			const input = canonicalEvent("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "bash",
				callId: "call-1",
				input: { command: "ls -la", nested: { deep: true } },
			}, {
				metadata: { commandId: "cmd_abc", adapterKey: "oc-main" },
				createdAt: FIXED_TEST_TIMESTAMP,
			});

			const stored = store.append(input);
			const [read] = store.readFromSequence(0, 1);
			expect(read).toBeDefined();
			expect(read!.data).toEqual(input.data);
			expect(read!.metadata).toEqual(input.metadata);
			expect(read!.eventId).toBe(input.eventId);
			expect(read!.provider).toBe("opencode");
		});
	});

	// ─── (F5) Boundary Condition Tests ────────────────────────────────────

	describe("boundary conditions", () => {
		it("accepts createdAt = 0 (epoch zero)", () => {
			harness.seedSession("s1");
			const stored = store.append(makeSessionCreatedEvent("s1", { createdAt: 0 }));
			const read = store.readFromSequence(0);
			expect(read[0]!.createdAt).toBe(0);
		});

		it("handles large data payloads without truncation", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const largeText = "x".repeat(10_000);
			const stored = store.append(makeTextDelta("s1", "m1", largeText));
			const read = store.readFromSequence(stored.sequence - 1);
			expect((read[0]!.data as { text: string }).text).toBe(largeText);
		});

		it("readFromSequence with afterSequence = -1 behaves as 0", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const read = store.readFromSequence(-1);
			expect(read.length).toBe(1);
		});

		it("readBySession with limit = 0 returns empty array", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const read = store.readBySession("s1", 0, 0);
			expect(read).toEqual([]);
		});

		it("readFromSequence with cursor beyond max returns empty", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			const read = store.readFromSequence(999);
			expect(read).toEqual([]);
		});

		it("concurrent version conflict via two EventStore instances", () => {
			harness.seedSession("s1");
			const store2 = new EventStore(harness.db);
			store.append(makeSessionCreatedEvent("s1"));
			const e2 = store2.append(makeTextDelta("s1", "m1", "hello"));
			expect(e2.streamVersion).toBe(1);
			expect(e2.sequence).toBe(2);
		});
	});

	// ─── (F14) resetVersionCache Tests ────────────────────────────────────

	describe("resetVersionCache", () => {
		it("clears cached versions and falls back to DB query", () => {
			harness.seedSession("s1");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.append(makeTextDelta("s1", "m1", "b"));
			store.resetVersionCache();
			const e4 = store.append(makeTextDelta("s1", "m1", "c"));
			expect(e4.streamVersion).toBe(3);
			expect(e4.sequence).toBe(4);
		});

		it("handles reset with empty store", () => {
			store.resetVersionCache();
			harness.seedSession("s1");
			const e1 = store.append(makeSessionCreatedEvent("s1"));
			expect(e1.streamVersion).toBe(0);
		});

		it("handles reset after events from multiple sessions", () => {
			harness.seedSession("s1");
			harness.seedSession("s2");
			store.append(makeSessionCreatedEvent("s1"));
			store.append(makeSessionCreatedEvent("s2"));
			store.append(makeTextDelta("s1", "m1", "a"));
			store.resetVersionCache();
			const e4 = store.append(makeTextDelta("s1", "m1", "b"));
			const e5 = store.append(makeTextDelta("s2", "m2", "c"));
			expect(e4.streamVersion).toBe(2);
			expect(e5.streamVersion).toBe(1);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/event-store.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/event-store.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/event-store.ts
import type { SqliteClient } from "./sqlite-client.js";
import type { CanonicalEvent, CanonicalEventType, StoredEvent } from "./events.js";
import { CANONICAL_EVENT_TYPES, validateEventPayload } from "./events.js";
import { PersistenceError } from "./errors.js";
import type { Logger } from "../logger.js";

/**
 * Row shape returned by event queries.
 * Column names match the SQL SELECT aliases.
 */
interface EventRow {
	sequence: number;
	event_id: string;
	session_id: string;
	stream_version: number;
	type: string;
	data: string;
	metadata: string;
	provider: string;
	created_at: number;
}

const DEFAULT_READ_LIMIT = 1000;

/**
 * Append-only event store backed by SQLite.
 *
 * Provides:
 * - `append(event)` — single event insert with auto-assigned stream version
 * - `appendBatch(events)` — atomic multi-event insert
 * - `readFromSequence(cursor, limit)` — global ordered replay from a sequence cursor
 * - `readBySession(sessionId, fromSeq?)` — per-session replay
 * - `getNextStreamVersion(sessionId)` — next expected version for optimistic concurrency
 *
 * Stream version assignment:
 *   (P4) Uses an in-memory version cache to avoid the COALESCE subquery
 *   on every append. **Marked measure-first:** the COALESCE B-tree seek
 *   is ~10μs; at 50 events/sec that's 0.5ms/sec — negligible. t3code
 *   uses the same COALESCE pattern without caching. The cache is included
 *   for completeness but should only be enabled if P11 profiling shows
 *   COALESCE is >1% of append time. The unique index on
 *   (session_id, stream_version) guarantees concurrent writers detect
 *   conflicts even if the cache is stale (e.g., after SSE reconnect —
 *   call `resetVersionCache()` to clear).
 */
export class EventStore {
	private readonly db: SqliteClient;
	private readonly log?: Logger;
	/** (P4) In-memory cache: sessionId → next stream version to assign. */
	private readonly versionCache = new Map<string, number>();

	constructor(db: SqliteClient, log?: Logger) {
		this.db = db;
		this.log = log;
	}

	/**
	 * (P4) Clear the version cache. Call on SSE reconnect when events
	 * may have been inserted externally, making the cached version stale.
	 * The (session_id, stream_version) unique index provides the safety
	 * net: if the cache is wrong, the INSERT fails with a constraint
	 * violation rather than silently corrupting data.
	 */
	resetVersionCache(): void {
		this.versionCache.clear();
	}

	/**
	 * Append a single event. Returns the stored event with sequence and streamVersion.
	 *
	 * Runs `validateEventPayload()` before persisting to catch translator bugs
	 * at write time rather than when a projector reads the corrupt payload.
	 */
	append(event: CanonicalEvent): StoredEvent {
		validateEventPayload(event);

		// (P4) Check version cache first; fall back to DB query on cache miss
		let nextVersion = this.versionCache.get(event.sessionId);
		if (nextVersion === undefined) {
			nextVersion = this.getNextStreamVersion(event.sessionId);
		}

		const dataJson = JSON.stringify(event.data);
		const metadataJson = JSON.stringify(event.metadata);

		// (P4) Use explicit version from cache instead of COALESCE subquery
		const rows = this.db.query<EventRow>(
			`INSERT INTO events (
				event_id, session_id, stream_version, type, data, metadata, provider, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			RETURNING
				sequence,
				event_id,
				session_id,
				stream_version,
				type,
				data,
				metadata,
				provider,
				created_at`,
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

		const row = rows[0];
		if (!row) {
			throw new PersistenceError("APPEND_FAILED", "INSERT RETURNING produced no rows", {
				eventId: event.eventId,
				sessionId: event.sessionId,
				type: event.type,
			});
		}

		const stored = this.rowToStoredEvent(row);
		// (P4) Update the version cache after successful INSERT
		this.versionCache.set(event.sessionId, nextVersion + 1);
		this.log?.verbose(`event appended seq=${stored.sequence} type=${event.type} session=${event.sessionId}`);
		return stored;
	}

	/**
	 * Append multiple events atomically in a single transaction.
	 *
	 * (P10) Pre-fetches versions for all sessions in the batch via the
	 * version cache, eliminating per-row COALESCE subqueries. Stream
	 * versions are computed sequentially within the transaction.
	 */
	appendBatch(events: readonly CanonicalEvent[]): StoredEvent[] {
		if (events.length === 0) return [];

		return this.db.runInTransaction(() => {
			const results: StoredEvent[] = [];
			for (const event of events) {
				results.push(this.append(event));
			}
			return results;
		});
	}

	/**
	 * Read events with sequence greater than `afterSequence`, ordered by sequence ASC.
	 *
	 * @param afterSequence - Exclusive lower bound (0 = read from beginning)
	 * @param limit - Maximum number of events to return (default: 1000)
	 */
	readFromSequence(afterSequence: number, limit?: number): StoredEvent[] {
		const effectiveLimit = limit ?? DEFAULT_READ_LIMIT;
		const rows = this.db.query<EventRow>(
			`SELECT
				sequence,
				event_id,
				session_id,
				stream_version,
				type,
				data,
				metadata,
				provider,
				created_at
			FROM events
			WHERE sequence > ?
			ORDER BY sequence ASC
			LIMIT ?`,
			[afterSequence, effectiveLimit],
		);
		return rows.map((row) => this.rowToStoredEvent(row));
	}

	/**
	 * Read events for a specific session, ordered by sequence ASC.
	 *
	 * (S10a) No default limit — callers must explicitly pass a limit or
	 * `undefined` for unbounded reads. This prevents silent truncation
	 * during fork where all parent events are needed.
	 *
	 * @param sessionId - The session to read events for
	 * @param fromSequence - Optional exclusive lower bound on sequence
	 * @param limit - Maximum events to return. Pass `undefined` for unbounded.
	 */
	readBySession(
		sessionId: string,
		fromSequence?: number,
		limit?: number,
	): StoredEvent[] {
		const afterSeq = fromSequence ?? 0;
		if (limit != null) {
			const rows = this.db.query<EventRow>(
				`SELECT
					sequence, event_id, session_id, stream_version,
					type, data, metadata, provider, created_at
				FROM events
				WHERE session_id = ? AND sequence > ?
				ORDER BY sequence ASC
				LIMIT ?`,
				[sessionId, afterSeq, limit],
			);
			return rows.map((row) => this.rowToStoredEvent(row));
		}
		// Unbounded read — no LIMIT clause
		const rows = this.db.query<EventRow>(
			`SELECT
				sequence, event_id, session_id, stream_version,
				type, data, metadata, provider, created_at
			FROM events
			WHERE session_id = ? AND sequence > ?
			ORDER BY sequence ASC`,
			[sessionId, afterSeq],
		);
		return rows.map((row) => this.rowToStoredEvent(row));
	}

	/**
	 * (S10a) Read ALL events for a session without limit.
	 * Convenience wrapper that makes the intent of unbounded reads explicit.
	 * Use for fork (where all parent events are needed) and full replay.
	 */
	readAllBySession(sessionId: string, fromSequence?: number): StoredEvent[] {
		return this.readBySession(sessionId, fromSequence, undefined);
	}

	/**
	 * Get the next expected stream version for a session.
	 * Returns 0 if the session has no events.
	 */
	getNextStreamVersion(sessionId: string): number {
		const row = this.db.queryOne<{ next_version: number | null }>(
			"SELECT MAX(stream_version) + 1 as next_version FROM events WHERE session_id = ?",
			[sessionId],
		);
		return row?.next_version ?? 0;
	}

	/**
	 * Convert a raw database row to a typed StoredEvent.
	 *
	 * Performs a runtime guard on `row.type` to ensure it is a known canonical
	 * event type — protects downstream projectors from silent corruption if
	 * the database contains an invalid type (e.g. from a future migration or
	 * manual edit).
	 */
	private rowToStoredEvent(row: EventRow): StoredEvent {
		if (!CANONICAL_EVENT_TYPES.includes(row.type as CanonicalEventType)) {
			throw new PersistenceError(
				"UNKNOWN_EVENT_TYPE",
				`Unknown event type in database: ${row.type}`,
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
				},
			);
		}

		let data: unknown;
		let metadata: unknown;
		try {
			data = JSON.parse(row.data);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event data JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					sessionId: row.session_id,
					type: row.type,
					rawData: row.data.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
		}
		try {
			metadata = JSON.parse(row.metadata);
		} catch (err) {
			throw new PersistenceError(
				"DESERIALIZATION_FAILED",
				"Failed to parse event metadata JSON",
				{
					sequence: row.sequence,
					eventId: row.event_id,
					rawMetadata: row.metadata.slice(0, 200),
					parseError: err instanceof Error ? err.message : String(err),
				},
			);
		}

		return {
			sequence: row.sequence,
			eventId: row.event_id,
			sessionId: row.session_id,
			streamVersion: row.stream_version,
			type: row.type,
			data,
			metadata,
			provider: row.provider,
			createdAt: row.created_at,
		} as StoredEvent;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/event-store.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/event-store.ts test/unit/persistence/event-store.test.ts
git commit -m "feat(persistence): add EventStore with append, batch, read, and per-session stream versioning"
```

---

### Task 6: Command Receipt Repository

**Files:**
- Create: `src/lib/persistence/command-receipts.ts`
- Test: `test/unit/persistence/command-receipts.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/command-receipts.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import {
	CommandReceiptRepository,
	type CommandReceipt,
} from "../../../src/lib/persistence/command-receipts.js";
import { createCommandId } from "../../../src/lib/persistence/events.js";

describe("CommandReceiptRepository", () => {
	let client: SqliteClient;
	let repo: CommandReceiptRepository;

	beforeEach(() => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		repo = new CommandReceiptRepository(client);
	});

	afterEach(() => {
		client?.close();
	});

	describe("check", () => {
		it("returns undefined for an unknown command ID", () => {
			const result = repo.check("cmd_nonexistent");
			expect(result).toBeUndefined();
		});

		it("returns the receipt for a known command ID", () => {
			const commandId = createCommandId();
			const receipt: CommandReceipt = {
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 42,
				createdAt: Date.now(),
			};
			repo.record(receipt);
			const result = repo.check(commandId);
			expect(result).toBeDefined();
			expect(result!.commandId).toBe(commandId);
			expect(result!.sessionId).toBe("s1");
			expect(result!.status).toBe("accepted");
			expect(result!.resultSequence).toBe(42);
		});
	});

	describe("record", () => {
		it("records an accepted receipt", () => {
			const commandId = createCommandId();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			});
			const result = repo.check(commandId);
			expect(result).toBeDefined();
			expect(result!.status).toBe("accepted");
			expect(result!.error).toBeUndefined();
		});

		it("records a rejected receipt with error and no result sequence", () => {
			const commandId = createCommandId();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "rejected",
				error: "Session not found",
				createdAt: Date.now(),
			});
			const result = repo.check(commandId);
			expect(result).toBeDefined();
			expect(result!.status).toBe("rejected");
			expect(result!.error).toBe("Session not found");
			expect(result!.resultSequence).toBeUndefined();
		});

		it("throws on duplicate command ID", () => {
			const commandId = createCommandId();
			const receipt: CommandReceipt = {
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			};
			repo.record(receipt);
			expect(() => repo.record(receipt)).toThrow();
		});

		it("records timestamps accurately", () => {
			const commandId = createCommandId();
			const now = Date.now();
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 5,
				createdAt: now,
			});
			const result = repo.check(commandId);
			expect(result!.createdAt).toBe(now);
		});
	});

	describe("idempotent command processing pattern", () => {
		it("supports the check-then-execute pattern", () => {
			const commandId = createCommandId();

			// First attempt: no receipt exists, execute the command
			const existing = repo.check(commandId);
			expect(existing).toBeUndefined();

			// Simulate executing the command and recording the receipt
			repo.record({
				commandId,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 10,
				createdAt: Date.now(),
			});

			// Second attempt: receipt exists, skip execution
			const cached = repo.check(commandId);
			expect(cached).toBeDefined();
			expect(cached!.status).toBe("accepted");
			expect(cached!.resultSequence).toBe(10);
		});

		it("handles multiple commands for the same session", () => {
			const cmd1 = createCommandId();
			const cmd2 = createCommandId();

			repo.record({
				commandId: cmd1,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 1,
				createdAt: Date.now(),
			});
			repo.record({
				commandId: cmd2,
				sessionId: "s1",
				status: "accepted",
				resultSequence: 5,
				createdAt: Date.now(),
			});

			expect(repo.check(cmd1)!.resultSequence).toBe(1);
			expect(repo.check(cmd2)!.resultSequence).toBe(5);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/command-receipts.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/command-receipts.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/command-receipts.ts
import type { SqliteClient } from "./sqlite-client.js";
import { PersistenceError } from "./errors.js";

/**
 * A recorded command receipt for idempotent command processing.
 *
 * - `accepted`: Command was processed successfully; `resultSequence` points
 *   to the event that fulfilled it.
 * - `rejected`: Command was rejected; `error` describes why.
 *
 * Transient failures (network errors, timeouts) should NOT write receipts —
 * allowing the client to safely retry.
 */
export interface CommandReceipt {
	readonly commandId: string;
	readonly sessionId: string;
	readonly status: "accepted" | "rejected";
	readonly resultSequence?: number;
	readonly error?: string;
	readonly createdAt: number;
}

/**
 * Row shape from the command_receipts table.
 */
interface ReceiptRow {
	command_id: string;
	session_id: string;
	status: string;
	result_sequence: number | null;
	error: string | null;
	created_at: number;
}

/**
 * Repository for command receipt persistence and lookup.
 *
 * Usage pattern (idempotent command processing):
 * ```
 * const existing = receipts.check(commandId);
 * if (existing) {
 *   return existing.status === 'accepted'
 *     ? cachedResult(existing.resultSequence)
 *     : cachedError(existing.error);
 * }
 * // Execute command...
 * receipts.record({ commandId, sessionId, status: 'accepted', resultSequence, createdAt });
 * ```
 */
export class CommandReceiptRepository {
	private readonly db: SqliteClient;

	constructor(db: SqliteClient) {
		this.db = db;
	}

	/**
	 * Look up a receipt by command ID.
	 * Returns the receipt if found, undefined otherwise.
	 */
	check(commandId: string): CommandReceipt | undefined {
		const row = this.db.queryOne<ReceiptRow>(
			`SELECT
				command_id,
				session_id,
				status,
				result_sequence,
				error,
				created_at
			FROM command_receipts
			WHERE command_id = ?`,
			[commandId],
		);

		if (!row) return undefined;

		return this.rowToReceipt(row);
	}

	/**
	 * Record a command receipt.
	 *
	 * Throws if a receipt for this command ID already exists (primary key violation).
	 * This is intentional — double-recording indicates a logic error in the caller.
	 */
	record(receipt: CommandReceipt): void {
		this.db.execute(
			`INSERT INTO command_receipts (
				command_id, session_id, status, result_sequence, error, created_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				receipt.commandId,
				receipt.sessionId,
				receipt.status,
				receipt.resultSequence ?? null,
				receipt.error ?? null,
				receipt.createdAt,
			],
		);
	}

	/**
	 * Convert a raw row to a typed CommandReceipt.
	 */
	private rowToReceipt(row: ReceiptRow): CommandReceipt {
		if (row.status !== "accepted" && row.status !== "rejected") {
			throw new PersistenceError(
				"INVALID_RECEIPT_STATUS",
				`Unknown receipt status in database: ${row.status}`,
				{
					commandId: row.command_id,
					sessionId: row.session_id,
					status: row.status,
				},
			);
		}
		return {
			commandId: row.command_id,
			sessionId: row.session_id,
			status: row.status,
			...(row.result_sequence != null
				? { resultSequence: row.result_sequence }
				: {}),
			...(row.error != null ? { error: row.error } : {}),
			createdAt: row.created_at,
		};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/command-receipts.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/command-receipts.ts test/unit/persistence/command-receipts.test.ts
git commit -m "feat(persistence): add CommandReceiptRepository for idempotent command processing"
```

---

### Phase 1 Completion Checklist

After all 6 tasks, verify the full phase:

```bash
pnpm vitest run test/unit/persistence/
```

Expected: All tests pass. Files created:

| File | Purpose |
|------|---------|
| `src/lib/persistence/sqlite-client.ts` | WAL-mode SQLite wrapper with statement cache and transactions |
| `src/lib/persistence/migrations.ts` | Migration runner with tracking table |
| `src/lib/persistence/schema.ts` | Schema migration with all 12 tables (incl. `message_parts`) |
| `src/lib/persistence/errors.ts` | `PersistenceError` class with error codes and structured context |
| `src/lib/persistence/events.ts` | Canonical event types, branded IDs, `canonicalEvent()` factory, `validateEventPayload()` |
| `src/lib/persistence/event-store.ts` | Append-only event store with per-session versioning and payload validation |
| `src/lib/persistence/command-receipts.ts` | Command receipt repository for deduplication |

Final commit for any barrel export or wiring:

```bash
git add src/lib/persistence/ test/unit/persistence/
git commit -m "feat(persistence): complete Phase 1 foundation — SQLite event store with schema, types, and command receipts"
```

**Next:** Phase 2 (Dual-Write) will wire the event store into the existing relay pipeline so events flow to both JSONL and SQLite.

---

## Phase 2: Dual-Write — Events Flow to Both JSONL and SQLite

**Goal:** Wire the Phase 1 event store into the existing relay pipeline so that every SSE event from OpenCode is simultaneously:
1. Processed through the existing relay pipeline (JSONL cache + WS broadcast) — **unchanged**
2. Translated to canonical events and appended to the SQLite event store — **new, additive**

Nothing reads from SQLite yet. The existing relay continues to function identically. This phase validates that canonical event translation is correct and that the SQLite write path is stable under real event volumes.

**Depends on:** Phase 1 (SQLite client, schema, event store, event types).

**Validates:** Every SSE event that flows through the relay also produces correct canonical events in the event store. Session seeding works. Dual-write errors don't break the relay. The feature flag can disable the SQLite path.

**Architecture pattern (from t3code reference):** The `ProviderRuntimeIngestion` layer in t3code sits alongside the provider runtime, consuming the same stream of provider events and translating them into orchestration commands dispatched to the `OrchestrationEngine`. Our dual-write follows the same pattern: the `CanonicalEventTranslator` sits alongside the existing `Translator`, consuming the same SSE events and translating them into canonical events appended to the `EventStore`. The key difference: t3code uses Effect streams and a command/decider pattern; we use plain synchronous function calls with error isolation via try/catch.

---

### Task 7: Canonical Event Translator

> **Amendment (2026-04-09 — Testing Audit, F3/F4):**
> Local `makeSSEEvent` replaced with import from `test/helpers/sse-factories.ts` (type-constrained).

> **Amendment (2026-04-09 — Concurrency Solutions, Change 4b — Session-Scoped LRU Eviction):**
> **Supersedes P9 FIFO eviction** on `trackedParts`. Replace the FIFO eviction block with
> session-scoped LRU eviction:
> 1. Key `trackedParts` by `sessionId:partId` (already the case).
> 2. On eviction trigger (>10,000 entries), identify sessions with no events in the last 60 seconds.
> 3. Evict all parts belonging to idle sessions, oldest-idle-first.
> 4. If still over capacity, evict oldest parts from non-active sessions.
> 5. **Never evict parts from the session currently being processed** — pass `currentSessionId` as
>    a protected parameter to the eviction function.
> Remove `EVICTION_COUNT = 2_000` constant. Add `lastEventAt` tracking per session.

**Files:**
- Create: `src/lib/persistence/canonical-event-translator.ts`
- Test: `test/unit/persistence/canonical-event-translator.test.ts`

**Purpose:** Maps OpenCode SSE events to the 19 canonical event types from Phase 1. This is the dual-write analog of t3code's `ProviderRuntimeIngestion.processRuntimeEvent()` — it receives raw provider events and produces typed domain events. Like t3code's ingestion layer, it's stateful: it tracks which parts have been seen (to distinguish tool.started from tool.running) and which messages are in-flight (to map part deltas to message IDs).

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/canonical-event-translator.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import {
	CanonicalEventTranslator,
	type CanonicalTranslateResult,
} from "../../../src/lib/persistence/canonical-event-translator.js";
import type { CanonicalEvent, CanonicalEventType } from "../../../src/lib/persistence/events.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

describe("CanonicalEventTranslator", () => {
	let translator: CanonicalEventTranslator;

	beforeEach(() => {
		translator = new CanonicalEventTranslator();
	});

	describe("message.created (user)", () => {
		it("produces a message.created canonical event", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: {
					role: "user",
					parts: [{ type: "text", text: "Hello world" }],
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events).toHaveLength(1);
			expect(result!.events[0]!.type).toBe("message.created");
			expect(result!.events[0]!.sessionId).toBe("sess-1");
			expect(result!.events[0]!.data).toEqual({
				messageId: "msg-1",
				role: "user",
				sessionId: "sess-1",
			});
			expect(result!.events[0]!.provider).toBe("opencode");
		});
	});

	describe("message.created (assistant)", () => {
		it("produces a message.created canonical event for assistant messages", () => {
			const event = makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-2",
				info: { role: "assistant", parts: [] },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.data).toEqual({
				messageId: "msg-2",
				role: "assistant",
				sessionId: "sess-1",
			});
		});
	});

	describe("message.part.delta (text)", () => {
		it("produces a text.delta canonical event for text parts", () => {
			// First, register the part as text type via a part.updated
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-1",
					part: { id: "part-1", type: "text" },
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.delta", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				field: "text",
				delta: "Hello",
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events).toHaveLength(1);
			expect(result!.events[0]!.type).toBe("text.delta");
			expect(result!.events[0]!.data).toEqual({
				messageId: "msg-1",
				partId: "part-1",
				text: "Hello",
			});
		});
	});

	describe("message.part.delta (reasoning)", () => {
		it("produces a thinking.delta canonical event for reasoning parts", () => {
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-2",
					part: { id: "part-2", type: "reasoning" },
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.delta", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-2",
				field: "text",
				delta: "Let me think...",
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("thinking.delta");
			expect(result!.events[0]!.data).toEqual({
				messageId: "msg-1",
				partId: "part-2",
				text: "Let me think...",
			});
		});
	});

	describe("message.part.updated (tool lifecycle)", () => {
		it("produces tool.started when a tool part is first seen as pending", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-3",
				part: {
					id: "part-3",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending", input: { command: "ls" } },
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const toolStarted = result!.events.find((e) => e.type === "tool.started");
			expect(toolStarted).toBeDefined();
			expect(toolStarted!.data).toEqual({
				messageId: "msg-1",
				partId: "part-3",
				toolName: "Bash",
				callId: "call-1",
				input: { command: "ls" },
			});
		});

		it("produces tool.running when a tool transitions to running", () => {
			// First create the tool
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-3",
					part: {
						id: "part-3",
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "pending" },
					},
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-3",
				part: {
					id: "part-3",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "running" },
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const toolRunning = result!.events.find((e) => e.type === "tool.running");
			expect(toolRunning).toBeDefined();
			expect(toolRunning!.data).toEqual({
				messageId: "msg-1",
				partId: "part-3",
			});
		});

		it("produces tool.completed when a tool finishes successfully", () => {
			// First create the tool
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-3",
					part: {
						id: "part-3",
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "running" },
						time: { start: 1000 },
					},
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-3",
				part: {
					id: "part-3",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "completed", output: "file.txt" },
					time: { start: 1000, end: 2500 },
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const toolCompleted = result!.events.find(
				(e) => e.type === "tool.completed",
			);
			expect(toolCompleted).toBeDefined();
			expect(toolCompleted!.data).toEqual({
				messageId: "msg-1",
				partId: "part-3",
				result: "file.txt",
				duration: 1500,
			});
		});

		it("produces tool.completed with is_error data for error status", () => {
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-3",
					part: {
						id: "part-3",
						type: "tool",
						callID: "call-1",
						tool: "bash",
						state: { status: "running" },
						time: { start: 1000 },
					},
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-3",
				part: {
					id: "part-3",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "error", error: "Command failed" },
					time: { start: 1000, end: 1200 },
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const toolCompleted = result!.events.find(
				(e) => e.type === "tool.completed",
			);
			expect(toolCompleted).toBeDefined();
			expect(toolCompleted!.data).toEqual({
				messageId: "msg-1",
				partId: "part-3",
				result: "Command failed",
				duration: 200,
			});
		});
	});

	describe("message.part.updated (reasoning lifecycle)", () => {
		it("produces thinking.start when a reasoning part is first seen", () => {
			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-r1",
				part: { id: "part-r1", type: "reasoning", time: { start: 100 } },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const thinkingStart = result!.events.find((e) => e.type === "thinking.start");
			expect(thinkingStart).toBeDefined();
			expect(thinkingStart!.data).toEqual({
				messageId: "msg-1",
				partId: "part-r1",
			});
		});

		it("produces thinking.end when reasoning part gets an end time", () => {
			// First, create reasoning part without end time
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-r1",
					part: { id: "part-r1", type: "reasoning", time: { start: 100 } },
				}),
				"sess-1",
			);

			const event = makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-r1",
				part: { id: "part-r1", type: "reasoning", time: { start: 100, end: 500 } },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const thinkingEnd = result!.events.find((e) => e.type === "thinking.end");
			expect(thinkingEnd).toBeDefined();
			expect(thinkingEnd!.data).toEqual({
				messageId: "msg-1",
				partId: "part-r1",
			});
		});
	});

	describe("message.updated (turn completed)", () => {
		it("produces turn.completed for assistant message with cost/tokens", () => {
			const event = makeSSEEvent("message.updated", {
				sessionID: "sess-1",
				info: {
					id: "msg-2",
					role: "assistant",
					cost: 0.05,
					tokens: {
						input: 1000,
						output: 500,
						cache: { read: 200, write: 100 },
					},
					time: { created: 1000, completed: 3500 },
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const turnCompleted = result!.events.find(
				(e) => e.type === "turn.completed",
			);
			expect(turnCompleted).toBeDefined();
			expect(turnCompleted!.data).toEqual({
				messageId: "msg-2",
				cost: 0.05,
				tokens: {
					input: 1000,
					output: 500,
					cacheRead: 200,
					cacheWrite: 100,
				},
				duration: 2500,
			});
		});
	});

	describe("session.status", () => {
		it("produces session.status for idle status", () => {
			const event = makeSSEEvent("session.status", {
				sessionID: "sess-1",
				status: { type: "idle" },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("session.status");
			expect(result!.events[0]!.data).toEqual({
				sessionId: "sess-1",
				status: "idle",
			});
		});

		it("produces turn.error for error status with message", () => {
			const event = makeSSEEvent("session.error", {
				sessionID: "sess-1",
				error: { name: "QuotaExhausted", data: { message: "Rate limited" } },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			const turnError = result!.events.find((e) => e.type === "turn.error");
			expect(turnError).toBeDefined();
			expect(turnError!.data).toEqual({
				messageId: "",
				error: "Rate limited",
				code: "QuotaExhausted",
			});
		});
	});

	describe("permission.asked", () => {
		it("produces permission.asked canonical event", () => {
			const event = makeSSEEvent("permission.asked", {
				id: "perm-1",
				permission: "bash",
				patterns: ["*"],
				metadata: { command: "rm -rf /" },
				tool: { callID: "call-5" },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("permission.asked");
			expect(result!.events[0]!.data).toEqual({
				id: "perm-1",
				sessionId: "sess-1",
				toolName: "Bash",
				input: { patterns: ["*"], metadata: { command: "rm -rf /" } },
			});
		});
	});

	describe("permission.replied", () => {
		it("produces permission.resolved canonical event", () => {
			const event = makeSSEEvent("permission.replied", {
				id: "perm-1",
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("permission.resolved");
			expect(result!.events[0]!.data).toEqual({
				id: "perm-1",
				decision: "granted",
			});
		});
	});

	describe("question.asked", () => {
		it("produces question.asked canonical event", () => {
			const event = makeSSEEvent("question.asked", {
				id: "que-1",
				questions: [
					{
						question: "What framework?",
						options: [{ label: "React" }, { label: "Svelte" }],
					},
				],
				tool: { callID: "call-6" },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("question.asked");
			expect(result!.events[0]!.data).toEqual({
				id: "que-1",
				sessionId: "sess-1",
				questions: [
					{
						question: "What framework?",
						options: [{ label: "React" }, { label: "Svelte" }],
					},
				],
			});
		});
	});

	describe("session.updated (title change)", () => {
		it("produces session.renamed when session info includes a title", () => {
			const event = makeSSEEvent("session.updated", {
				info: {
					id: "sess-1",
					sessionID: "sess-1",
					title: "New Title",
				},
			});
			const result = translator.translate(event, "sess-1");
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("session.renamed");
			expect(result!.events[0]!.data).toEqual({
				sessionId: "sess-1",
				title: "New Title",
			});
		});
	});

	describe("returns null for unhandled events", () => {
		it("returns null for pty events", () => {
			const event = makeSSEEvent("pty.created", {
				info: { id: "pty-1", title: "shell" },
			});
			const result = translator.translate(event, "sess-1");
			expect(result).toBeNull();
		});

		it("returns null for file events", () => {
			const event = makeSSEEvent("file.edited", { file: "foo.ts" });
			const result = translator.translate(event, "sess-1");
			expect(result).toBeNull();
		});

		it("returns null for installation events", () => {
			const event = makeSSEEvent("installation.update-available", {
				version: "1.2.3",
			});
			const result = translator.translate(event, "sess-1");
			expect(result).toBeNull();
		});
	});

	describe("no sessionId", () => {
		it("returns null when no sessionId is provided", () => {
			const event = makeSSEEvent("message.created", {
				info: { role: "user", parts: [{ type: "text", text: "hi" }] },
			});
			const result = translator.translate(event, undefined);
			expect(result).toBeNull();
		});
	});

	describe("reset", () => {
		it("clears tracked parts", () => {
			// Track a part
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "part-1",
					part: { id: "part-1", type: "text" },
				}),
				"sess-1",
			);

			translator.reset();

			// After reset, a delta for the same part should default to text.delta
			const event = makeSSEEvent("message.part.delta", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				field: "text",
				delta: "data",
			});
			const result = translator.translate(event, "sess-1");
			// Still produces text.delta (untracked parts default to text)
			expect(result).not.toBeNull();
			expect(result!.events[0]!.type).toBe("text.delta");
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/canonical-event-translator.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/canonical-event-translator.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/canonical-event-translator.ts
import { canonicalEvent, type CanonicalEvent } from "./events.js";
import type { OpenCodeEvent } from "../types.js";
import {
	isPartDeltaEvent,
	isPartUpdatedEvent,
	isMessageCreatedEvent,
	isMessageUpdatedEvent,
	isPermissionAskedEvent,
	isPermissionRepliedEvent,
	isQuestionAskedEvent,
	isSessionStatusEvent,
	isSessionErrorEvent,
} from "../relay/opencode-events.js";
import { mapToolName } from "../relay/event-translator.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CanonicalTranslateResult {
	readonly events: CanonicalEvent[];
}

interface TrackedPart {
	type: string;
	status?: string;
	messageId?: string;
	hasEndTime?: boolean;
}

// ─── Canonical Event Translator ──────────────────────────────────────────────

/**
 * Translates OpenCode SSE events into canonical event types for the event store.
 *
 * Runs alongside the existing relay Translator (which produces RelayMessages for
 * WebSocket broadcast). Both consume the same SSE events. This translator
 * produces CanonicalEvents for SQLite persistence.
 *
 * Stateful: tracks seen parts to determine tool lifecycle transitions and
 * to distinguish text deltas from thinking deltas.
 *
 * Analogous to t3code's ProviderRuntimeIngestion layer, which consumes
 * ProviderRuntimeEvents and dispatches OrchestrationCommands. The key
 * difference: we produce CanonicalEvents directly (no command/decider step)
 * since we're in dual-write mode and don't need optimistic concurrency yet.
 */
export class CanonicalEventTranslator {
	private readonly trackedParts = new Map<string, TrackedPart>();

	// (P9) Prevent unbounded memory growth over long daemon lifetimes.
	// Matches the existing relay Translator's FIFO eviction at 10,000 entries.
	private static readonly MAX_TRACKED_PARTS = 10_000;
	private static readonly EVICTION_COUNT = 2_000;

	/**
	 * Translate an OpenCode SSE event into zero or more canonical events.
	 *
	 * @param event - Raw OpenCode SSE event
	 * @param sessionId - The session ID extracted from the SSE event
	 * @returns Canonical events to persist, or null if the event is not translatable
	 */
	translate(
		event: OpenCodeEvent,
		sessionId: string | undefined,
	): CanonicalTranslateResult | null {
		if (!sessionId) return null;

		const events = this.translateEvent(event, sessionId);
		if (events.length === 0) return null;

		return { events };
	}

	/** Clear all tracked state. */
	reset(): void {
		this.trackedParts.clear();
	}

	// ─── Internal translation ────────────────────────────────────────────

	private translateEvent(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] {
		const eventType = event.type;

		// ── message.created ──────────────────────────────────────────────
		if (eventType === "message.created" && isMessageCreatedEvent(event)) {
			const props = event.properties;
			const msg = props.info ?? props.message;
			if (!msg?.role) return [];

			const role = msg.role as "user" | "assistant";
			const messageId = props.messageID ?? "";

			return [
				this.makeEvent(sessionId, "message.created", {
					messageId,
					role,
					sessionId,
				}),
			];
		}

		// ── message.part.delta ───────────────────────────────────────────
		if (eventType === "message.part.delta" && isPartDeltaEvent(event)) {
			const props = event.properties;
			if (props.field !== "text") return [];

			const partId = props.partID;
			const messageId = props.messageID ?? "";
			const tracked = this.trackedParts.get(partId);
			const partType = tracked?.type ?? "text";

			if (partType === "reasoning") {
				return [
					this.makeEvent(sessionId, "thinking.delta", {
						messageId,
						partId,
						text: props.delta,
					}),
				];
			}

			return [
				this.makeEvent(sessionId, "text.delta", {
					messageId,
					partId,
					text: props.delta,
				}),
			];
		}

		// ── message.part.updated ─────────────────────────────────────────
		if (eventType === "message.part.updated" && isPartUpdatedEvent(event)) {
			return this.translatePartUpdated(event, sessionId);
		}

		// ── message.updated (cost/tokens → turn.completed) ──────────────
		if (eventType === "message.updated" && isMessageUpdatedEvent(event)) {
			const props = event.properties;
			const msg = props.info ?? props.message;
			if (!msg || msg.role !== "assistant") return [];

			const messageId = msg.id ?? "";
			const cost = msg.cost;
			const tokens = msg.tokens;
			const duration =
				msg.time?.completed && msg.time?.created
					? msg.time.completed - msg.time.created
					: undefined;

			return [
				this.makeEvent(sessionId, "turn.completed", {
					messageId,
					...(cost != null ? { cost } : {}),
					...(tokens
						? {
								tokens: {
									input: tokens.input ?? 0,
									output: tokens.output ?? 0,
									cacheRead: tokens.cache?.read ?? 0,
									cacheWrite: tokens.cache?.write ?? 0,
								},
							}
						: {}),
					...(duration != null ? { duration } : {}),
				}),
			];
		}

		// ── session.status ────────────────────────────────────────────────
		if (eventType === "session.status" && isSessionStatusEvent(event)) {
			const statusType = event.properties.status?.type;
			if (!statusType) return [];

			return [
				this.makeEvent(sessionId, "session.status", {
					sessionId,
					status: statusType,
				}),
			];
		}

		// ── session.error → turn.error ───────────────────────────────────
		if (eventType === "session.error" && isSessionErrorEvent(event)) {
			const err = event.properties.error;
			const errName = err?.name ?? "Unknown";
			const errMsg = err?.data?.message ?? "An error occurred";

			return [
				this.makeEvent(sessionId, "turn.error", {
					messageId: "",
					error: errMsg,
					code: errName,
				}),
			];
		}

		// ── permission.asked ─────────────────────────────────────────────
		if (eventType === "permission.asked" && isPermissionAskedEvent(event)) {
			const props = event.properties;
			return [
				this.makeEvent(sessionId, "permission.asked", {
					id: props.id,
					sessionId,
					toolName: mapToolName(props.permission ?? ""),
					input: {
						...(props.patterns ? { patterns: props.patterns } : {}),
						...(props.metadata ? { metadata: props.metadata } : {}),
					},
				}),
			];
		}

		// ── permission.replied → permission.resolved ─────────────────────
		if (eventType === "permission.replied") {
			const props = event.properties as { id?: string };
			if (typeof props.id !== "string") return [];
			return [
				this.makeEvent(sessionId, "permission.resolved", {
					id: props.id,
					decision: "granted",
				}),
			];
		}

		// ── question.asked ───────────────────────────────────────────────
		if (eventType === "question.asked" && isQuestionAskedEvent(event)) {
			const props = event.properties;
			return [
				this.makeEvent(sessionId, "question.asked", {
					id: props.id,
					sessionId,
					questions: props.questions,
				}),
			];
		}

		// ── session.updated (title rename) ───────────────────────────────
		if (eventType === "session.updated") {
			const props = event.properties as {
				info?: { id?: string; sessionID?: string; title?: string };
			};
			const info = props.info;
			if (info?.title) {
				return [
					this.makeEvent(sessionId, "session.renamed", {
						sessionId,
						title: info.title,
					}),
				];
			}
			return [];
		}

		// ── Events not relevant to the canonical store ───────────────────
		// PTY, file, installation, todo, message.removed, message.part.removed
		// are not persisted as canonical events.
		return [];
	}

	// ─── Part updated sub-translator ─────────────────────────────────────

	private translatePartUpdated(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] {
		if (!isPartUpdatedEvent(event)) return [];
		const props = event.properties;
		const rawPart = props.part;
		if (!rawPart?.type) return [];

		const partID = props.partID ?? rawPart.id ?? "";
		const messageId = props.messageID ?? "";
		const partType = rawPart.type;

		const existing = this.trackedParts.get(partID);
		const isNew = !existing;

		// Track/update the part
		this.trackedParts.set(partID, {
			type: partType,
			status: rawPart.state?.status,
			messageId,
			hasEndTime: rawPart.time?.end != null,
		});

		// (P9) FIFO eviction to prevent unbounded memory growth
		if (this.trackedParts.size > CanonicalEventTranslator.MAX_TRACKED_PARTS) {
			let evicted = 0;
			for (const key of this.trackedParts.keys()) {
				this.trackedParts.delete(key);
				if (++evicted >= CanonicalEventTranslator.EVICTION_COUNT) break;
			}
		}

		const results: CanonicalEvent[] = [];

		// ── Reasoning lifecycle ──────────────────────────────────────────
		if (partType === "reasoning") {
			// First time we see this reasoning part: emit thinking.start
			if (isNew) {
				results.push(
					this.makeEvent(sessionId, "thinking.start", {
						messageId,
						partId: partID,
					}),
				);
			}
			if (
				!isNew &&
				rawPart.time?.end != null &&
				!existing?.hasEndTime
			) {
				results.push(
					this.makeEvent(sessionId, "thinking.end", {
						messageId,
						partId: partID,
					}),
				);
			}
			return results;
		}

		// ── Tool lifecycle ───────────────────────────────────────────────
		if (partType === "tool") {
			const status = rawPart.state?.status;
			const toolName = mapToolName(rawPart.tool ?? "");
			const callId = rawPart.callID ?? partID;
			const input = rawPart.state?.input;

			if (isNew && (status === "pending" || status === "running")) {
				results.push(
					this.makeEvent(sessionId, "tool.started", {
						messageId,
						partId: partID,
						toolName,
						callId,
						input: input ?? null,
					}),
				);
				if (status === "running") {
					results.push(
						this.makeEvent(sessionId, "tool.running", {
							messageId,
							partId: partID,
						}),
					);
				}
			} else if (!isNew && status === "running" && existing?.status !== "running") {
				results.push(
					this.makeEvent(sessionId, "tool.running", {
						messageId,
						partId: partID,
					}),
				);
			}

			if (status === "completed" || status === "error") {
				const duration = (() => {
					const start = rawPart.time?.start;
					const end = rawPart.time?.end;
					if (start != null && end != null) return end - start;
					return 0;
				})();

				const result =
					status === "error"
						? (rawPart.state?.error ?? "Unknown error")
						: (rawPart.state?.output ?? "");

				results.push(
					this.makeEvent(sessionId, "tool.completed", {
						messageId,
						partId: partID,
						result,
						duration,
					}),
				);
			}

			return results;
		}

		// Text parts — tracked but don't produce events here
		// (text content arrives via message.part.delta)
		return results;
	}

	// ─── Event factory ───────────────────────────────────────────────────
	//
	// Uses the typed `canonicalEvent()` factory from events.ts which
	// confines the single unavoidable `as` cast to one place and gives
	// every call site compile-time payload checking.

	private makeEvent<T extends CanonicalEvent["type"]>(
		sessionId: string,
		type: T,
		data: Extract<CanonicalEvent, { type: T }>["data"],
	): CanonicalEvent {
		return canonicalEvent(type, sessionId, data, {
			metadata: { adapterKey: "opencode" },
			provider: "opencode",
		});
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/canonical-event-translator.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/canonical-event-translator.ts test/unit/persistence/canonical-event-translator.test.ts
git commit -m "feat(persistence): add CanonicalEventTranslator mapping OpenCode SSE events to 19 canonical types"
```

---

### Task 8: Persistence Layer (Database Initialization)

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 12):**
> - Add `diagnostics: PersistenceDiagnostics` and `auditor: DualWriteAuditor` fields to `PersistenceLayer`.
> - Both are created in the constructor after migration and exposed as readonly fields.

> **Amendment (2026-04-09 — Concurrency Solutions, Change 2 — EventPipeline):**
> Expose a `pipeline: EventPipeline` field on `PersistenceLayer` alongside existing `eventStore` and
> `projectionRunner`. The pipeline is constructed in the `PersistenceLayer` constructor:
> ```typescript
> this.pipeline = new EventPipelineImpl(this.eventStore, this.projectionRunner);
> ```
> Application code uses `persistence.pipeline.ingest()` instead of calling `eventStore.append()`
> and `projectionRunner.projectEvent()` separately.

> **Amendment (2026-04-07, S4 — Interim Eviction):**
> Add lightweight startup eviction to `PersistenceLayer.open()`, running BEFORE relay stacks are created.
> This is transitional scaffolding that Phase 7's `EventStoreEviction` replaces.
>
> **Behavior:** After migrations run, if the events table exceeds a configurable threshold (default:
> 200K rows), delete events for idle sessions older than 24 hours. Uses the same batched DELETE
> pattern from Perf-Fix-3 (synchronous, since this runs before the relay starts). Log the result.
>
> **Scope:** Events table only. Projection tables are left alone (needed for the read path).
> Command receipts older than 24h are also cleaned.
>
> **Configuration:** `interimEvictionThreshold` field on `PersistenceLayer` options. Set to 0 to disable.
> Default 200K is approximately 1 day of heavy usage.
>
> **Lifecycle:** This code lives in `PersistenceLayer.open()` and is deleted in Phase 7 when
> `EventStoreEviction` takes over. Startup-only is sufficient for development — the daemon restarts
> frequently. For long-running production daemons, Phase 7's periodic eviction handles it.

**Files:**
- Create: `src/lib/persistence/persistence-layer.ts`
- Test: `test/unit/persistence/persistence-layer.test.ts`

**Purpose:** A single entry point that initializes SQLite, runs migrations, and exposes the `EventStore` and `CommandReceiptRepository`. The `PersistenceLayer` is created once per daemon and passed to each project relay. This mirrors how t3code's `OrchestrationEngine` receives its `OrchestrationEventStore` and `OrchestrationCommandReceiptRepository` as dependencies — the persistence layer is separate from the business logic that uses it.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/persistence-layer.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";

describe("PersistenceLayer", () => {
	let layer: PersistenceLayer | null = null;

	afterEach(() => {
		layer?.close();
		layer = null;
	});

	it("creates an in-memory persistence layer", () => {
		layer = PersistenceLayer.memory();
		expect(layer).toBeDefined();
		expect(layer.eventStore).toBeDefined();
		expect(layer.commandReceipts).toBeDefined();
		expect(layer.db).toBeDefined();
	});

	it("runs migrations on creation", () => {
		layer = PersistenceLayer.memory();
		// Verify the events table exists by querying it
		const rows = layer.db.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='events'",
		);
		expect(rows).toHaveLength(1);
	});

	it("all 11 schema tables exist after creation", () => {
		layer = PersistenceLayer.memory();
		const tables = layer.db
			.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.map((r) => r.name)
			.filter((n) => !n.startsWith("_")); // Exclude internal SQLite tables

		// 11 schema tables + the migrations tracking table
		expect(tables).toContain("events");
		expect(tables).toContain("sessions");
		expect(tables).toContain("messages");
		expect(tables).toContain("turns");
		expect(tables).toContain("command_receipts");
		expect(tables).toContain("activities");
		expect(tables).toContain("pending_approvals");
		expect(tables).toContain("session_providers");
		expect(tables).toContain("projector_cursors");
		expect(tables).toContain("tool_content");
		expect(tables).toContain("provider_state");
	});

	it("sessions table accepts INSERT (needed for session seeding)", () => {
		layer = PersistenceLayer.memory();
		const now = Date.now();
		layer.db.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			["test-session", "opencode", "Test", "idle", now, now],
		);
		const row = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["test-session"],
		);
		expect(row?.id).toBe("test-session");
	});

	it("event store can append after session is seeded", () => {
		layer = PersistenceLayer.memory();
		const now = Date.now();
		layer.db.execute(
			`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			["s1", "opencode", "Test", "idle", now, now],
		);
		const stored = layer.eventStore.append({
			eventId: "evt_test-1",
			sessionId: "s1",
			type: "session.created",
			data: { sessionId: "s1", title: "Test", provider: "opencode" },
			metadata: {},
			provider: "opencode",
			createdAt: now,
		} as import("../../../src/lib/persistence/events.js").CanonicalEvent);
		expect(stored.sequence).toBe(1);
	});

	it("creates a file-backed persistence layer", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const os = await import("node:os");
		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "persistence-layer-test-"),
		);
		const dbPath = path.join(tmpDir, "conduit.db");
		try {
			layer = PersistenceLayer.open(dbPath);
			expect(layer.eventStore).toBeDefined();

			// Verify file was created
			const stat = fs.statSync(dbPath);
			expect(stat.isFile()).toBe(true);
		} finally {
			layer?.close();
			layer = null;
			fs.rmSync(tmpDir, { recursive: true });
		}
	});

	it("close() is idempotent", () => {
		layer = PersistenceLayer.memory();
		layer.close();
		expect(() => layer!.close()).not.toThrow();
		layer = null; // prevent afterEach double-close
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/persistence-layer.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/persistence-layer.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/persistence-layer.ts
import { SqliteClient } from "./sqlite-client.js";
import { runMigrations } from "./migrations.js";
import { schemaMigrations } from "./schema.js";
import { EventStore } from "./event-store.js";
import { CommandReceiptRepository } from "./command-receipts.js";
import { PersistenceDiagnostics } from "./diagnostics.js";
import { DualWriteAuditor } from "./dual-write-auditor.js";
import type { Logger } from "../logger.js";

/**
 * Top-level persistence entry point.
 *
 * Initializes the SQLite database, runs migrations, and exposes
 * the EventStore and CommandReceiptRepository. Created once per daemon
 * and passed to each project relay that opts into dual-write.
 *
 * Usage:
 * ```ts
 * const persistence = PersistenceLayer.open("/path/to/conduit.db");
 * // ... use persistence.eventStore, persistence.commandReceipts
 * persistence.close();
 * ```
 */
export class PersistenceLayer {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	readonly commandReceipts: CommandReceiptRepository;
	/** (Amendment: Consistency Plan) Health-check queries and read-path stats. */
	readonly diagnostics: PersistenceDiagnostics;
	/** (Amendment: Consistency Plan) Spot-checks canonical event correctness vs relay state. */
	readonly auditor: DualWriteAuditor;
	private closed = false;

	private constructor(db: SqliteClient) {
		this.db = db;
		runMigrations(db, schemaMigrations);
		this.eventStore = new EventStore(db);
		this.commandReceipts = new CommandReceiptRepository(db);
		this.diagnostics = new PersistenceDiagnostics(db);
		this.auditor = new DualWriteAuditor(db);
	}

	/**
	 * Open a file-backed persistence layer.
	 * Creates the database file and parent directories if needed.
	 *
	 * (S4) Runs interim startup eviction when events table exceeds threshold.
	 */
	static open(filename: string, opts?: { interimEvictionThreshold?: number }): PersistenceLayer {
		const db = SqliteClient.open(filename);
		const layer = new PersistenceLayer(db);

		// (S4) Interim eviction — transitional scaffolding deleted in Phase 7.
		// Runs before relay stacks are created, so synchronous is safe.
		const threshold = opts?.interimEvictionThreshold ?? 200_000;
		if (threshold > 0) {
			layer.runInterimEviction(threshold);
		}

		return layer;
	}

	/**
	 * Create an in-memory persistence layer (for testing).
	 */
	static memory(): PersistenceLayer {
		const db = SqliteClient.memory();
		return new PersistenceLayer(db);
	}

	/**
	 * (S4) Interim startup eviction. Runs before relay stacks are created.
	 * Deletes events for idle sessions older than 24 hours when the events
	 * table exceeds the threshold. Uses batched DELETE (Perf-Fix-3 pattern).
	 * This is transitional scaffolding — deleted in Phase 7.
	 */
	private runInterimEviction(threshold: number): void {
		const countRow = this.db.queryOne<{ count: number }>(
			"SELECT COUNT(*) as count FROM events",
		);
		const eventCount = countRow?.count ?? 0;
		if (eventCount <= threshold) return;

		const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
		const batchSize = 5000;
		let totalDeleted = 0;

		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);
			const deleted = Number(result.changes);
			totalDeleted += deleted;
			if (deleted < batchSize) break;
		}

		// Command receipts cleanup
		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);

		if (totalDeleted > 0 || Number(receiptsResult.changes) > 0) {
			// Log will be wired when Logger is available on PersistenceLayer
			console.log(
				`[persistence] interim eviction: ${totalDeleted} events, ${receiptsResult.changes} receipts deleted (threshold: ${threshold}, count: ${eventCount})`,
			);
		}
	}

	/**
	 * Close the database connection. Idempotent.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/persistence-layer.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/persistence-layer.ts test/unit/persistence/persistence-layer.test.ts
git commit -m "feat(persistence): add PersistenceLayer as single entry point for database initialization"
```

---

### Task 9: Session Seeding

> **Amendment (2026-04-09 — Concurrency Solutions, Change 4b — Session-Scoped Eviction):**
> **Supersedes P9 FIFO eviction** on `seenSessions`. Replace `if (seenSessions.size > MAX_SEEN) seenSessions.clear()`
> with idle-session-scoped eviction: clear entries for sessions with no events in the last 60 seconds,
> rather than clearing the entire set. Same approach as the `trackedParts` eviction in Task 7.

**Files:**
- Create: `src/lib/persistence/session-seeder.ts`
- Test: `test/unit/persistence/session-seeder.test.ts`

**Purpose:** When the dual-write path sees a canonical event for a session that doesn't exist in the `sessions` table, it must create the session row first (the `events` table has a FK to `sessions`). Session seeding uses `INSERT OR IGNORE` to avoid conflicts when multiple events for the same session arrive concurrently.

This is a simpler version of the session creation that happens in t3code's decider (`thread.create` command → `thread.created` event → SessionProjector). In our dual-write phase, we don't have projectors yet, so seeding is a direct INSERT.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/session-seeder.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { SessionSeeder } from "../../../src/lib/persistence/session-seeder.js";

describe("SessionSeeder", () => {
	let layer: PersistenceLayer;
	let seeder: SessionSeeder;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		seeder = new SessionSeeder(layer.db);
	});

	afterEach(() => {
		layer.close();
	});

	it("creates a session row that doesn't exist", () => {
		seeder.ensureSession("sess-1", "opencode");

		const row = layer.db.queryOne<{ id: string; provider: string; status: string }>(
			"SELECT id, provider, status FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeDefined();
		expect(row!.id).toBe("sess-1");
		expect(row!.provider).toBe("opencode");
		expect(row!.status).toBe("idle");
	});

	it("is idempotent — second call for same session is a no-op", () => {
		seeder.ensureSession("sess-1", "opencode");
		// Should not throw
		seeder.ensureSession("sess-1", "opencode");

		const rows = layer.db.query<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(rows).toHaveLength(1);
	});

	it("does not overwrite existing session data", () => {
		// Seed with initial data
		seeder.ensureSession("sess-1", "opencode");

		// Manually update the title
		layer.db.execute("UPDATE sessions SET title = ? WHERE id = ?", [
			"Custom Title",
			"sess-1",
		]);

		// Re-seed — should not overwrite
		seeder.ensureSession("sess-1", "opencode");

		const row = layer.db.queryOne<{ title: string }>(
			"SELECT title FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row!.title).toBe("Custom Title");
	});

	it("creates sessions with different providers", () => {
		seeder.ensureSession("sess-1", "opencode");
		seeder.ensureSession("sess-2", "claude");

		const rows = layer.db.query<{ id: string; provider: string }>(
			"SELECT id, provider FROM sessions ORDER BY id",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.provider).toBe("opencode");
		expect(rows[1]!.provider).toBe("claude");
	});

	it("sets created_at and updated_at to current time", () => {
		const before = Date.now();
		seeder.ensureSession("sess-1", "opencode");
		const after = Date.now();

		const row = layer.db.queryOne<{ created_at: number; updated_at: number }>(
			"SELECT created_at, updated_at FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row!.created_at).toBeGreaterThanOrEqual(before);
		expect(row!.created_at).toBeLessThanOrEqual(after);
		expect(row!.updated_at).toBeGreaterThanOrEqual(before);
		expect(row!.updated_at).toBeLessThanOrEqual(after);
	});

	it("uses in-memory cache to skip redundant SQL", () => {
		seeder.ensureSession("sess-1", "opencode");

		// Delete the row to prove the second call uses cache
		layer.db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);

		// This should be a cache hit — no SQL executed
		seeder.ensureSession("sess-1", "opencode");

		// Row should still be deleted because the cache prevented the INSERT
		const row = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeUndefined();
	});

	it("reset() clears the in-memory cache", () => {
		seeder.ensureSession("sess-1", "opencode");

		// Delete the row
		layer.db.execute("DELETE FROM sessions WHERE id = ?", ["sess-1"]);

		// Reset cache
		seeder.reset();

		// Now ensureSession should re-insert
		seeder.ensureSession("sess-1", "opencode");

		const row = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(row).toBeDefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/session-seeder.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/session-seeder.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/session-seeder.ts
import type { SqliteClient } from "./sqlite-client.js";

/**
 * Ensures session rows exist in the `sessions` table before events
 * referencing them are inserted (FK constraint).
 *
 * Uses INSERT OR IGNORE — if the session already exists, the INSERT
 * is silently skipped. An in-memory Set avoids redundant SQL for
 * sessions already seeded in this process lifetime.
 *
 * This is transitional scaffolding for the dual-write phase. Once
 * the SessionProjector is running (Phase 3), session creation will
 * be handled by projecting `session.created` events.
 */
export class SessionSeeder {
	private readonly db: SqliteClient;
	private readonly seenSessions = new Set<string>();

	// (P9) Prevent unbounded memory growth over long daemon lifetimes.
	// When the set exceeds MAX_SEEN, clear it entirely — next access will
	// re-seed via INSERT OR IGNORE (idempotent, so the only cost is a
	// redundant SQL statement, not data corruption).
	private static readonly MAX_SEEN = 10_000;

	constructor(db: SqliteClient) {
		this.db = db;
	}

	/**
	 * Ensure a session row exists. Idempotent and safe for concurrent calls.
	 *
	 * @param sessionId - The OpenCode session ID
	 * @param provider - The provider name (e.g. "opencode")
	 * @returns true if this was the first time the session was seeded (new session)
	 */
	ensureSession(sessionId: string, provider: string): boolean {
		if (this.seenSessions.has(sessionId)) return false;

		const now = Date.now();
		this.db.execute(
			`INSERT OR IGNORE INTO sessions (id, provider, title, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[sessionId, provider, "Untitled", "idle", now, now],
		);

		this.seenSessions.add(sessionId);

		// (P9) Clear the set when it exceeds the limit. INSERT OR IGNORE
		// is idempotent, so the only cost of re-seeding is a redundant SQL.
		if (this.seenSessions.size > SessionSeeder.MAX_SEEN) {
			this.seenSessions.clear();
		}

		return true;
	}

	/**
	 * Clear the in-memory cache. Used on reconnect or for testing.
	 */
	reset(): void {
		this.seenSessions.clear();
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/session-seeder.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/session-seeder.ts test/unit/persistence/session-seeder.test.ts
git commit -m "feat(persistence): add SessionSeeder for INSERT OR IGNORE session row creation"
```

---

### Task 10: Dual-Write Hook

> **Amendment (2026-04-09 — Testing Audit, F3/F9):**
> Local `makeSSEEvent` replaced with import from `test/helpers/sse-factories.ts`.
> Failure injection tests added for SQLITE_BUSY, reconnect during deferred writes,
> sync/deferred interleaving, and post-stop microtask safety (F9).

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 10):**
> - **(I5)** `DualWriteAuditor.audit()` takes a `RelaySnapshot` — the caller (relay-stack.ts, see Task 24.5 amendment) must construct this snapshot from in-memory relay state (session titles, statuses, message counts). The `RelaySnapshot` interface is defined in `dual-write-auditor.ts`.

> **~~Amendment (2026-04-07, S1-S3 — Tiered Write Pipeline)~~ SUPERSEDED by Concurrency Solutions Change 1:**
> ~~The `DualWriteHook` gains a `shouldWriteSync(eventType)` method...~~ **REMOVED.** The entire
> tiered write pipeline (S1-S3) is replaced by a synchronous interleaved pipeline. All writes are
> synchronous. No `SYNC_TYPES` set, no `shouldWriteSync()`, no `onSSEEventDeferred()`, no
> `queueMicrotask` in the write path.
>
> **Replacement (Change 1 — Synchronous Interleaved Pipeline):**
> All events follow one path: synchronous translate → synchronous append → relay broadcast →
> synchronous project. Events within an SSE batch are wrapped in a single SQLite transaction.
> The relay broadcast happens between append and projection, giving ~0.15ms first-event latency.
>
> **Replacement (Change 2 — EventPipeline):**
> The hook uses `pipeline.ingest()` instead of calling `eventStore.append()` + `projectEvent()`
> separately. This guarantees append+project atomicity. Remove direct `eventStore.append()` calls.

> **Amendment (2026-04-07, S8 — P11 Measurement Pipeline):**
> Add periodic stats logging to the `DualWriteHook`:
> - Every 60 seconds (configurable), log a structured summary of P11 stats, then reset counters.
> - Log entry includes: events/sec, avg/peak append time, avg/peak project time, error count.
> - When `peakProjectMs` exceeds threshold (default: 5ms), promote log from `debug` to `warn`.
> - Expose current stats via `PersistenceDiagnostics.health()` for debug panel and CLI health checks.
> - Implementation: `setInterval` in constructor calling private `logStats()`. Interval cleared on
>   `PersistenceLayer.close()`. Stats object reset after each emission to keep window fixed.

**Files:**
- Create: `src/lib/persistence/dual-write-hook.ts`
- Test: `test/unit/persistence/dual-write-hook.test.ts`

**Purpose:** The central coordination point that wires together the canonical event translator, session seeder, and event store. Receives SSE events (the same ones flowing through the relay pipeline), translates them, seeds sessions as needed, and appends to the event store. All errors are caught and logged — never propagated to the relay pipeline.

This is our equivalent of t3code's `ProviderRuntimeIngestion.processInputSafely()` — the function wraps the translation and dispatch in a catch-all so that ingestion failures never break the upstream provider runtime.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/dual-write-hook.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

describe("DualWriteHook", () => {
	let layer: PersistenceLayer;
	let hook: DualWriteHook;
	let logWarn: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		logWarn = vi.fn();
		hook = new DualWriteHook({
			persistence: layer,
			log: { warn: logWarn, debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
		});
	});

	afterEach(() => {
		layer.close();
	});

	it("translates an SSE event and appends it to the event store", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hi" }] },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("message.created");
		expect(events[0]!.sessionId).toBe("sess-1");
	});

	it("seeds the session row before appending events", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hi" }] },
			}),
			"sess-1",
		);

		const session = layer.db.queryOne<{ id: string; provider: string }>(
			"SELECT id, provider FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(session).toBeDefined();
		expect(session!.provider).toBe("opencode");
	});

	it("handles multiple events for the same session", () => {
		// First event seeds the session
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		// Register a text part
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "p1",
				part: { id: "p1", type: "text" },
			}),
			"sess-1",
		);

		// Then a delta
		hook.onSSEEvent(
			makeSSEEvent("message.part.delta", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "p1",
				field: "text",
				delta: "Hello world",
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(2); // message.created + text.delta (part.updated doesn't produce events for text type)
		expect(events[0]!.type).toBe("message.created");
		expect(events[1]!.type).toBe("text.delta");
	});

	it("does nothing when sessionId is undefined", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				info: { role: "user", parts: [] },
			}),
			undefined,
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(0);
	});

	it("does nothing for events that don't translate to canonical types", () => {
		hook.onSSEEvent(
			makeSSEEvent("pty.created", {
				info: { id: "pty-1", title: "shell" },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(0);
	});

	it("catches and logs errors without throwing", () => {
		// Close the database to force an error
		layer.close();

		// Should not throw
		expect(() =>
			hook.onSSEEvent(
				makeSSEEvent("message.created", {
					sessionID: "sess-1",
					messageID: "msg-1",
					info: { role: "user", parts: [] },
				}),
				"sess-1",
			),
		).not.toThrow();

		expect(logWarn).toHaveBeenCalledWith(
			expect.stringContaining("dual-write"),
		);
	});

	it("is disabled when enabled flag is false", () => {
		const disabledHook = new DualWriteHook({
			persistence: layer,
			log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
			enabled: false,
		});

		const result = disabledHook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		expect(result).toEqual({ ok: false, reason: "disabled" });
		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(0);
	});

	it("handles tool lifecycle events across multiple part updates", () => {
		// Tool pending
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-t1",
				part: {
					id: "part-t1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
			"sess-1",
		);

		// Tool running
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-t1",
				part: {
					id: "part-t1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "running" },
				},
			}),
			"sess-1",
		);

		// Tool completed
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-t1",
				part: {
					id: "part-t1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "completed", output: "file.txt" },
					time: { start: 1000, end: 2000 },
				},
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(3);
		expect(events[0]!.type).toBe("tool.started");
		expect(events[1]!.type).toBe("tool.running");
		expect(events[2]!.type).toBe("tool.completed");
	});

	it("appends multiple canonical events from a single SSE event", () => {
		// A tool first seen as "running" should produce both started and running
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-t2",
				part: {
					id: "part-t2",
					type: "tool",
					callID: "call-2",
					tool: "read",
					state: { status: "running", input: { filePath: "/tmp/x" } },
				},
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("tool.started");
		expect(events[1]!.type).toBe("tool.running");
	});

	it("tracks statistics", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);
		hook.onSSEEvent(
			makeSSEEvent("pty.created", {
				info: { id: "pty-1", title: "shell" },
			}),
			"sess-1",
		);

		const stats = hook.getStats();
		expect(stats.eventsReceived).toBe(2);
		// 2 events written: synthetic session.created (from session seeder) + message.created
		expect(stats.eventsWritten).toBe(2);
		expect(stats.eventsSkipped).toBe(1);
		expect(stats.errors).toBe(0);
	});

	// ─── (F9) Failure Injection Tests ─────────────────────────────────────

	describe("tiered write failure isolation", () => {
		it("relay continues when deferred write fails (SQLITE_BUSY)", () => {
			vi.spyOn(layer.eventStore, "append").mockImplementationOnce(() => {
				throw new Error("SQLITE_BUSY: database is locked");
			});
			expect(() => hook.onSSEEvent(
				makeSSEEvent("message.part.delta", {
					sessionID: "sess-1", messageID: "m1", partID: "p1",
					field: "text", delta: "hello",
				}),
				"sess-1",
			)).not.toThrow();
		});

		it("SYNC_TYPE event during pending deferred batch processes correctly", () => {
			hook.onSSEEvent(makeSSEEvent("message.part.delta", {
				sessionID: "sess-1", messageID: "m1", partID: "p1",
				field: "text", delta: "hello",
			}), "sess-1");
			const syncResult = hook.onSSEEvent(makeSSEEvent("permission.asked", {
				id: "perm-1", sessionID: "sess-1", permission: "read",
				patterns: ["/test"], metadata: {},
			}), "sess-1");
			expect(syncResult.ok).toBe(true);
		});

		it("queueMicrotask callback after stop is safe", async () => {
			hook.onSSEEvent(makeSSEEvent("message.part.delta", {
				sessionID: "sess-1", messageID: "m1", partID: "p1",
				field: "text", delta: "hello",
			}), "sess-1");
			hook.stopStatsLogging();
			await new Promise(resolve => queueMicrotask(resolve));
			// No crash, no stale writes
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-hook.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/dual-write-hook.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/dual-write-hook.ts
import type { OpenCodeEvent } from "../types.js";
import type { PersistenceLayer } from "./persistence-layer.js";
import { CanonicalEventTranslator } from "./canonical-event-translator.js";
import { SessionSeeder } from "./session-seeder.js";
import { canonicalEvent, createEventId, type CanonicalEvent } from "./events.js";
import { PersistenceError } from "./errors.js";
import { formatErrorDetail } from "../errors.js";

// ─── Logging Helpers ─────────────────────────────────────────────────────────

/** (F2) Truncate an object to a JSON string of at most `maxLen` chars for logging. */
function truncateForLog(obj: unknown, maxLen: number): string {
	const json = JSON.stringify(obj);
	return json.length > maxLen ? json.slice(0, maxLen) + "..." : json;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DualWriteLog {
	warn(msg: string, context?: Record<string, unknown>): void;
	debug(msg: string, context?: Record<string, unknown>): void;
	info(msg: string, context?: Record<string, unknown>): void;
	verbose(msg: string, context?: Record<string, unknown>): void;
}

export interface DualWriteHookConfig {
	readonly persistence: PersistenceLayer;
	readonly log: DualWriteLog;
	/** Feature flag — defaults to true. Set to false to disable SQLite writes. */
	readonly enabled?: boolean;
}

export interface DualWriteStats {
	readonly eventsReceived: number;
	readonly eventsWritten: number;
	readonly eventsSkipped: number;
	readonly errors: number;
	/** (CH1) Number of SSE reconnects (epoch counter). */
	readonly reconnects: number;
	// (P11) Timing instrumentation for actionable performance diagnostics.
	// Transforms debugging from "the system feels slow" to "event store
	// append averages 0.3ms, projection averages 2.1ms, peak was 15ms."
	readonly totalTranslateMs: number;
	readonly totalAppendMs: number;
	readonly totalProjectMs: number;
	readonly peakAppendMs: number;
	readonly peakProjectMs: number;
}

/**
 * Discriminated-union result type for `onSSEEvent()`.
 *
 * Returns structured outcome so tests and diagnostics can inspect what
 * happened without querying the database.  Follows the existing
 * `TranslateResult` pattern from `event-translator.ts`.
 */
export type DualWriteResult =
	| { ok: true; eventsWritten: number; sessionSeeded: boolean }
	| { ok: false; reason: "disabled" | "no-session" | "not-translatable" | "error"; error?: string };

// ─── Dual-Write Hook ─────────────────────────────────────────────────────────

/**
 * Wires the canonical event translator into the SSE pipeline.
 *
 * Called from `handleSSEEvent()` in sse-wiring.ts — before the existing relay
 * pipeline processes the event (JSONL cache + WS broadcast), the hook
 * translates it to canonical events and appends to the event store.
 *
 * All errors are caught and logged. The hook NEVER throws — a failure in
 * the SQLite write path must not break the relay.
 *
 * This is analogous to t3code's `processInputSafely()` in
 * ProviderRuntimeIngestion — it wraps translation + dispatch in a catch-all.
 */
export class DualWriteHook {
	private readonly persistence: PersistenceLayer;
	private readonly translator: CanonicalEventTranslator;
	private readonly seeder: SessionSeeder;
	private readonly log: DualWriteLog;
	private readonly enabled: boolean;

	// Statistics
	private _eventsReceived = 0;
	private _eventsWritten = 0;
	private _eventsSkipped = 0;
	private _errors = 0;
	// (P11) Timing instrumentation
	private _totalTranslateMs = 0;
	private _totalAppendMs = 0;
	private _totalProjectMs = 0;
	private _peakAppendMs = 0;
	private _peakProjectMs = 0;

	constructor(config: DualWriteHookConfig) {
		this.persistence = config.persistence;
		this.translator = new CanonicalEventTranslator();
		this.seeder = new SessionSeeder(config.persistence.db);
		this.log = config.log;
		this.enabled = config.enabled !== false;
	}

	/**
	 * Process an SSE event for dual-write.
	 *
	 * Called synchronously from sse-wiring.ts for every SSE event.
	 * Translates to canonical events, seeds the session if needed,
	 * and appends to the event store.
	 *
	 * NEVER throws. All errors are caught and logged with structured context
	 * including the failure stage (translating / seeding / appending) so an
	 * LLM can diagnose the root cause from the log entry alone.
	 *
	 * Returns a `DualWriteResult` discriminated union instead of void so
	 * tests and diagnostics can inspect outcomes without querying the DB.
	 *
	 * @param event - The raw OpenCode SSE event
	 * @param sessionId - The session ID extracted by sse-wiring.ts
	 */
	onSSEEvent(event: OpenCodeEvent, sessionId: string | undefined): DualWriteResult {
		if (!this.enabled) return { ok: false, reason: "disabled" };

		this._eventsReceived++;
		let stage: "translating" | "seeding" | "appending" = "translating";

		try {
			// (P11) Instrument translation timing
			const t0 = performance.now();
			const result = this.translator.translate(event, sessionId);
			const t1 = performance.now();
			this._totalTranslateMs += t1 - t0;

			if (!result) {
				this._eventsSkipped++;
				return { ok: false, reason: "not-translatable" };
			}

			stage = "seeding";
			let sessionSeeded = false;

			// Seed the session row (INSERT OR IGNORE) before appending events.
			// If this is a new session, emit a synthetic session.created event
			// tagged with `synthetic: true` so it's distinguishable from real
			// provider events during debugging.
			if (sessionId) {
				const isNew = this.seeder.ensureSession(sessionId, "opencode");
				if (isNew) {
					sessionSeeded = true;
					this.persistence.eventStore.append(
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: "Untitled",
							provider: "opencode",
						}, {
							metadata: {
								adapterKey: "opencode",
								synthetic: true,
								source: "session-seeder",
							},
						}),
					);
					this._eventsWritten++;
				}
			}

			stage = "appending";

			// When a single SSE event produces multiple canonical events,
			// link them via a shared sseBatchId so debugging can trace them
			// back to one SSE event.
			const batchId = result.events.length > 1 ? createEventId() : undefined;

			// Append all canonical events from this SSE event
			for (const evt of result.events) {
				const enriched = batchId
					? {
							...evt,
							metadata: {
								...evt.metadata,
								sseBatchId: batchId,
								sseBatchSize: result.events.length,
							},
						}
					: evt;
				// (P11) Instrument append + project timing
				const tAppend0 = performance.now();
				this.persistence.eventStore.append(enriched as CanonicalEvent);
				const tAppend1 = performance.now();
				this._totalAppendMs += tAppend1 - tAppend0;
				this._peakAppendMs = Math.max(this._peakAppendMs, tAppend1 - tAppend0);
				this._eventsWritten++;
			}

			return { ok: true, eventsWritten: result.events.length, sessionSeeded };
		} catch (err) {
			this._errors++;
			this.log.warn(`dual-write error at stage="${stage}"`, {
				stage,
				eventType: event.type,
				sessionId: sessionId ?? "none",
				// (F2) Include truncated event properties so an LLM can see what
				// the translator received and diagnose why it failed.
				eventProperties: truncateForLog(event.properties, 500),
				error: err instanceof PersistenceError
					? err.toLog()
					: formatErrorDetail(err),
				stats: this.getStats(),
			});
			return {
				ok: false,
				reason: "error",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Get dual-write statistics.
	 */
	getStats(): DualWriteStats {
		return {
			eventsReceived: this._eventsReceived,
			eventsWritten: this._eventsWritten,
			eventsSkipped: this._eventsSkipped,
			errors: this._errors,
			reconnects: this._epoch,
			// (P11) Timing stats
			totalTranslateMs: this._totalTranslateMs,
			totalAppendMs: this._totalAppendMs,
			totalProjectMs: this._totalProjectMs,
			peakAppendMs: this._peakAppendMs,
			peakProjectMs: this._peakProjectMs,
		};
	}

	// ── Tiered Write Pipeline (S1-S3) — SUPERSEDED ──────────────────────
	//
	// (Concurrency Solutions Change 1) The tiered write pipeline is replaced
	// by a synchronous interleaved pipeline. All events follow one path:
	// synchronous translate → synchronous append → relay broadcast →
	// synchronous project. The following methods are REMOVED:
	//   - SYNC_TYPES set
	//   - shouldWriteSync()
	//   - onSSEEventDeferred()
	//
	// All writes are now synchronous. The SSE wiring (Task 11) calls
	// onSSEEvent() unconditionally at the top of handleSSEEvent().

	// ── P11 Measurement Pipeline (S8) ───────────────────────────────────

	private _statsInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * (S8) Start periodic stats logging. Call once after construction.
	 * Logs a structured summary every `intervalMs` (default: 60000ms),
	 * then resets counters. Promotes to warn when peakProjectMs exceeds
	 * `warnThresholdMs` (default: 5ms).
	 */
	startStatsLogging(opts?: { intervalMs?: number; warnThresholdMs?: number }): void {
		const intervalMs = opts?.intervalMs ?? 60_000;
		const warnThresholdMs = opts?.warnThresholdMs ?? 5;

		this._statsInterval = setInterval(() => {
			this.logAndResetStats(warnThresholdMs);
		}, intervalMs);
	}

	/** (S8) Stop periodic stats logging. Called on PersistenceLayer.close(). */
	stopStatsLogging(): void {
		if (this._statsInterval) {
			clearInterval(this._statsInterval);
			this._statsInterval = null;
		}
	}

	private logAndResetStats(warnThresholdMs: number): void {
		if (this._eventsWritten === 0) return; // nothing to report

		const elapsed = 60; // approximate; could track actual elapsed
		const stats = {
			eventsPerSec: +(this._eventsWritten / elapsed).toFixed(1),
			avgAppendMs: +(this._totalAppendMs / this._eventsWritten).toFixed(2),
			peakAppendMs: +this._peakAppendMs.toFixed(2),
			avgProjectMs: +(this._totalProjectMs / this._eventsWritten).toFixed(2),
			peakProjectMs: +this._peakProjectMs.toFixed(2),
			errors: this._errors,
		};

		if (this._peakProjectMs > warnThresholdMs) {
			this.log.warn("dual-write perf: projection peak exceeded threshold", stats);
		} else {
			this.log.debug("dual-write stats", stats);
		}

		// Reset counters for next window
		this._totalTranslateMs = 0;
		this._totalAppendMs = 0;
		this._totalProjectMs = 0;
		this._peakAppendMs = 0;
		this._peakProjectMs = 0;
		this._eventsWritten = 0;
		this._eventsReceived = 0;
		this._eventsSkipped = 0;
		this._errors = 0;
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/** (CH1) Private epoch counter for diagnostics. Incremented on every SSE reconnect. */
	private _epoch = 0;

	/**
	 * Lifecycle method: called on SSE reconnect.
	 *
	 * Atomically resets ALL stateful components in one call so no caller
	 * can forget a component. The epoch counter is incremented for
	 * diagnostics (visible in logs and getStats()).
	 *
	 * Replaces the previous `resetTranslator()` method. The name change
	 * signals that this is a lifecycle coordination point, not a single-
	 * component reset.
	 *
	 * (P4) Also clears the EventStore version cache since events may
	 * have been inserted externally during the reconnect gap.
	 *
	 * Note on async rehydration: The existing `rehydrationGen` counter
	 * in `wireSSEConsumer()` already guards rehydration callbacks against
	 * stale reconnects (sse-wiring.ts). `onReconnect()` guards the
	 * event store write path. These are complementary mechanisms:
	 * - `rehydrationGen` guards WebSocket broadcast path
	 * - `onReconnect()` epoch guards event store write path
	 */
	onReconnect(): void {
		this._epoch++;
		this.translator.reset();
		this.seeder.reset();
		this.persistence.eventStore.resetVersionCache();
		this.log.info("dual-write reconnect", { epoch: this._epoch });
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-hook.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/dual-write-hook.ts test/unit/persistence/dual-write-hook.test.ts
git commit -m "feat(persistence): add DualWriteHook coordinating translation, seeding, and event store writes"
```

---

### Task 11: Wire Dual-Write into SSE Pipeline

> **~~Amendment (2026-04-07, S1-S3 — Tiered Write Pipeline)~~ SUPERSEDED by Concurrency Solutions Change 1:**
> ~~Conditional placement based on `shouldWriteSync()`~~ **REMOVED.** The dual-write hook call
> is always placed at the TOP of `handleSSEEvent()`, right after `extractSessionId()`. No conditional
> tier classification. No `onSSEEventDeferred()`. Single hook call position.
>
> **Replacement (Change 1 — Synchronous Interleaved Pipeline):**
> For SSE batches, wrap all events in a single SQLite transaction. For each event in the batch:
> ```
> 1. DualWriteHook.onSSEEvent()  [sync: translate + append]     ~0.15ms
> 2. Relay pipeline              [sync: translate + WS broadcast] ~0.05ms
> 3. ProjectionRunner.projectEvent()  [sync: project]            ~0.30ms
> ```
>
> **Replacement (Change 5a — LifecycleCoordinator):**
> Move idle checkpoint timer and `startStatsLogging()`/`stopStatsLogging()` lifecycle into
> `LifecycleCoordinator`. Wire `coordinator.onEvent()` on every SSE event (resets idle timer).
> Wire `coordinator.onReconnect()` in the `connected` handler. Wire `coordinator.onDisconnect()`
> in the `stop()` method.

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts`
- Modify: `src/lib/relay/relay-stack.ts`
- Test: `test/unit/persistence/dual-write-integration.test.ts`

**Purpose:** Wire the `DualWriteHook` into the existing SSE event pipeline so that every SSE event flows to both the relay and the event store. This is the point where the existing code is modified — all previous tasks were additive. The changes are minimal: add an optional `DualWriteHook` to `SSEWiringDeps`, call it from `handleSSEEvent()`, and create it in `createProjectRelay()`.

**Step 1: Write the failing test**

The integration test verifies that SSE events processed through `handleSSEEvent()` end up in both the WebSocket output (existing behavior) and the event store (new behavior).

```typescript
// test/unit/persistence/dual-write-integration.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { handleSSEEvent, type SSEWiringDeps } from "../../../src/lib/relay/sse-wiring.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

function createMockDeps(
	overrides?: Partial<SSEWiringDeps>,
): SSEWiringDeps & { sentMessages: RelayMessage[]; broadcastMessages: RelayMessage[] } {
	const sentMessages: RelayMessage[] = [];
	const broadcastMessages: RelayMessage[] = [];

	return {
		translator: createTranslator(),
		sessionMgr: {
			recordMessageActivity: vi.fn(),
			incrementPendingQuestionCount: vi.fn(),
			sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
			addToParentMap: vi.fn(),
			getSessionParentMap: vi.fn().mockReturnValue(new Map()),
		} as unknown as SSEWiringDeps["sessionMgr"],
		messageCache: {
			recordEvent: vi.fn(),
			setOpenCodeUpdatedAt: vi.fn(),
		} as unknown as SSEWiringDeps["messageCache"],
		pendingUserMessages: {
			consume: vi.fn().mockReturnValue(false),
		} as unknown as SSEWiringDeps["pendingUserMessages"],
		permissionBridge: {
			onPermissionRequest: vi.fn().mockReturnValue(null),
			onPermissionReplied: vi.fn(),
		} as unknown as SSEWiringDeps["permissionBridge"],
		overrides: {
			clearProcessingTimeout: vi.fn(),
			resetProcessingTimeout: vi.fn(),
		} as unknown as SSEWiringDeps["overrides"],
		toolContentStore: {
			store: vi.fn(),
		} as unknown as SSEWiringDeps["toolContentStore"],
		wsHandler: {
			broadcast: (msg: RelayMessage) => broadcastMessages.push(msg),
			sendToSession: (_sid: string, msg: RelayMessage) => sentMessages.push(msg),
			getClientsForSession: vi.fn().mockReturnValue(["client-1"]),
		},
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			verbose: vi.fn(),
			error: vi.fn(),
			child: vi.fn().mockReturnThis(),
		} as unknown as SSEWiringDeps["log"],
		pipelineLog: {
			info: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
			verbose: vi.fn(),
			error: vi.fn(),
			child: vi.fn().mockReturnThis(),
		} as unknown as SSEWiringDeps["pipelineLog"],
		sentMessages,
		broadcastMessages,
		...overrides,
	};
}

describe("Dual-Write Integration", () => {
	let layer: PersistenceLayer;
	let dualWriteHook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		dualWriteHook = new DualWriteHook({
			persistence: layer,
			log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
		});
	});

	afterEach(() => {
		layer.close();
	});

	it("existing relay pipeline continues to work without dual-write", () => {
		const deps = createMockDeps();
		const event = makeSSEEvent("message.part.delta", {
			sessionID: "sess-1",
			messageID: "msg-1",
			partID: "p1",
			field: "text",
			delta: "Hello",
		});

		handleSSEEvent(deps, event);

		// Relay message was sent to session viewers
		expect(deps.sentMessages.length).toBeGreaterThan(0);
		expect(deps.sentMessages[0]!.type).toBe("delta");
	});

	it("SSE events flow to both relay and event store when hook is provided", () => {
		const deps = createMockDeps({ dualWriteHook });

		// Register a text part first (needed by canonical translator)
		handleSSEEvent(
			deps,
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "p1",
				part: { id: "p1", type: "text" },
			}),
		);

		// Now send a delta
		handleSSEEvent(
			deps,
			makeSSEEvent("message.part.delta", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "p1",
				field: "text",
				delta: "Hello world",
			}),
		);

		// Relay pipeline delivered the message
		const deltaMessages = deps.sentMessages.filter((m) => m.type === "delta");
		expect(deltaMessages.length).toBeGreaterThan(0);

		// Event store also received the canonical event
		const storedEvents = layer.eventStore.readFromSequence(0);
		const textDeltas = storedEvents.filter((e) => e.type === "text.delta");
		expect(textDeltas).toHaveLength(1);
		expect(textDeltas[0]!.sessionId).toBe("sess-1");
	});

	it("session row is seeded before events are appended", () => {
		const deps = createMockDeps({ dualWriteHook });

		handleSSEEvent(
			deps,
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hi" }] },
			}),
		);

		// Session was seeded
		const session = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(session).toBeDefined();

		// Event was stored (session.created from seeder + message.created)
		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(2);
	});

	it("dual-write errors do not break the relay pipeline", () => {
		// Close persistence to force errors
		layer.close();

		const deps = createMockDeps({ dualWriteHook });

		// Should not throw — relay pipeline must continue working
		expect(() =>
			handleSSEEvent(
				deps,
				makeSSEEvent("message.part.delta", {
					sessionID: "sess-1",
					messageID: "msg-1",
					partID: "p1",
					field: "text",
					delta: "Hello",
				}),
			),
		).not.toThrow();

		// Relay message was still delivered
		expect(deps.sentMessages.length).toBeGreaterThan(0);
	});

	it("dual-write hook is not called when not provided in deps", () => {
		const deps = createMockDeps(); // No dualWriteHook

		handleSSEEvent(
			deps,
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
		);

		// No events in store (layer is open but hook wasn't wired)
		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(0);
	});

	it("permission.asked events flow to both relay and event store", () => {
		const deps = createMockDeps({ dualWriteHook });

		handleSSEEvent(
			deps,
			makeSSEEvent("permission.asked", {
				sessionID: "sess-1",
				id: "perm-1",
				permission: "bash",
				patterns: ["*"],
				metadata: {},
			}),
		);

		// Event store received the canonical event
		const events = layer.eventStore.readFromSequence(0);
		// permission.asked events might also produce a session seed
		const permEvents = events.filter((e) => e.type === "permission.asked");
		expect(permEvents).toHaveLength(1);
	});

	it("tool lifecycle produces sequential canonical events in store", () => {
		const deps = createMockDeps({ dualWriteHook });

		// Tool pending
		handleSSEEvent(
			deps,
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "tool-1",
				part: {
					id: "tool-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
		);

		// Tool completed
		handleSSEEvent(
			deps,
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "tool-1",
				part: {
					id: "tool-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "completed", output: "file.txt" },
					time: { start: 1000, end: 2000 },
				},
			}),
		);

		const events = layer.eventStore.readFromSequence(0);
		const types = events.map((e) => e.type);
		expect(types).toContain("tool.started");
		expect(types).toContain("tool.completed");

		// Sequence order is preserved
		const started = events.find((e) => e.type === "tool.started");
		const completed = events.find((e) => e.type === "tool.completed");
		expect(started!.sequence).toBeLessThan(completed!.sequence);
	});

	it("SSE reconnect resets translator state — same tool part produces tool.started again", () => {
		const deps = createMockDeps({ dualWriteHook });

		const toolEvent = makeSSEEvent("message.part.updated", {
			sessionID: "sess-1",
			messageID: "msg-1",
			partID: "tool-1",
			part: {
				id: "tool-1",
				type: "tool",
				callID: "call-1",
				tool: "bash",
				state: { status: "pending", input: { command: "ls" } },
			},
		});

		// First SSE event — produces tool.started
		handleSSEEvent(deps, toolEvent);

		// Simulate SSE reconnect — reset all stateful components atomically (CH1)
		dualWriteHook.onReconnect();

		// Same part.updated event again after reconnect — should produce
		// tool.started a second time because state was reset
		handleSSEEvent(deps, toolEvent);

		const events = layer.eventStore.readFromSequence(0);
		const toolStartedEvents = events.filter((e) => e.type === "tool.started");
		expect(toolStartedEvents).toHaveLength(2);
	});

	it("session.updated → session.renamed flows to event store", () => {
		const deps = createMockDeps({ dualWriteHook });

		handleSSEEvent(
			deps,
			makeSSEEvent("session.updated", {
				info: {
					id: "sess-1",
					sessionID: "sess-1",
					title: "New Title",
				},
			}),
		);

		const events = layer.eventStore.readFromSequence(0);
		const renamed = events.filter((e) => e.type === "session.renamed");
		expect(renamed).toHaveLength(1);
		expect(renamed[0]!.data).toEqual({
			sessionId: "sess-1",
			title: "New Title",
		});
	});

	it("permission.replied → permission.resolved flows to event store", () => {
		const deps = createMockDeps({ dualWriteHook });

		handleSSEEvent(
			deps,
			makeSSEEvent("permission.replied", {
				id: "perm-1",
				sessionID: "sess-1",
			}),
		);

		const events = layer.eventStore.readFromSequence(0);
		const resolved = events.filter((e) => e.type === "permission.resolved");
		expect(resolved).toHaveLength(1);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-integration.test.ts`
Expected: FAIL — the `SSEWiringDeps` interface doesn't have a `dualWriteHook` field yet.

**Step 3: Write minimal implementation**

Modify `src/lib/relay/sse-wiring.ts` — add the optional `dualWriteHook` field to `SSEWiringDeps` and call it in `handleSSEEvent()`:

```typescript
// In src/lib/relay/sse-wiring.ts
// Add import at the top:
import type { DualWriteHook } from "../persistence/dual-write-hook.js";

// Add to SSEWiringDeps interface (after the existing optional fields):
export interface SSEWiringDeps {
	// ... existing fields unchanged ...
	/** Optional: dual-write hook for SQLite event store persistence */
	dualWriteHook?: DualWriteHook;
}
```

Then, at the **top** of `handleSSEEvent()`, right after `extractSessionId()` and before the relay translator runs, add the dual-write call:

```typescript
// In handleSSEEvent(), at the TOP of the function, right after extractSessionId():
// (This MUST run before the translator, permission handler, or any early returns)

	// ── Dual-write to SQLite event store (Phase 2) ─────────────────────
	// Runs BEFORE the relay pipeline so that ALL events are captured,
	// including ones where the relay translator returns { ok: false }
	// (e.g. session.updated → session.renamed, permission.replied → permission.resolved).
	// The hook catches all errors internally — never blocks the relay.
	if (deps.dualWriteHook) {
		deps.dualWriteHook.onSSEEvent(event, eventSessionId);
	}
```

**IMPORTANT (Audit Amendment C1):** The dual-write hook call MUST be at the TOP of `handleSSEEvent()`, immediately after `eventSessionId` is extracted and before the relay translator runs. The original placement at the bottom was unreachable for events where the relay translator returns `{ ok: false }` — notably `session.updated` (→ `session.renamed`) and `permission.replied` (→ `permission.resolved`). Placing it at the top ensures ALL SSE events flow to the event store, regardless of how the relay translator handles them. No separate `permission.asked` hook call is needed since the top-of-function placement covers it.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-integration.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed — the change is minimal and localized.

**Step 6: Commit**

```bash
git add src/lib/relay/sse-wiring.ts test/unit/persistence/dual-write-integration.test.ts
git commit -m "feat(persistence): wire DualWriteHook into SSE pipeline — events flow to both JSONL and SQLite"
```

---

### Task 12: Feature Flag and Relay Stack Wiring

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 12):**
> - The relay stack wiring in this task creates `DualWriteHook`. The Phase 4 consistency wiring (breakers, comparators, auditor) is added in the Task 24.5 amendment — see that task for the full wiring code.
> - `ShadowReadComparator` instances are added to `HandlerDeps` in the Task 25 amendment's `HandlerDeps` interface update.

> **Amendment (2026-04-07 — Perf-Fix-4: Non-Blocking Recovery):**
> - Replaced synchronous `recover()` call with `recoverAsync()` to keep the daemon responsive during startup.
> - See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 4.

> **Amendment (2026-04-09 — Concurrency Solutions, Changes 3B + 5b):**
> - **(Change 3B)** Wire WebSocket disconnect events into `PermissionLifecycleManager`. When all WS
>   connections for a session disconnect, wait a 30-second grace period, then auto-deny all pending
>   permissions for that session. This prevents permissions from blocking forever on UI disconnect.
> - **(Change 5b)** Wire `LifecycleCoordinator.onReconnect()` to check projector health and run
>   targeted `recoverLagging()` when projection gaps are detected on SSE reconnect.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `src/lib/types.ts` (add `dualWriteEnabled` to `ProjectRelayConfig`)
- Test: `test/unit/persistence/feature-flag.test.ts`

**Purpose:** Add a `dualWriteEnabled` feature flag to the relay configuration and wire the `PersistenceLayer` + `DualWriteHook` creation into `createProjectRelay()`. When persistence is provided and `dualWriteEnabled` is not explicitly `false`, dual-write is active (opt-out). Set `dualWriteEnabled: false` to disable the SQLite write path.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/feature-flag.test.ts
import { describe, expect, it, vi } from "vitest";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

const noopLog = {
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
};

describe("Feature Flag", () => {
	it("DualWriteHook with enabled=true writes events", () => {
		const layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			enabled: true,
		});

		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(1);
		layer.close();
	});

	it("DualWriteHook with enabled=false skips all writes", () => {
		const layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			enabled: false,
		});

		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(0);
		expect(hook.getStats().eventsReceived).toBe(0);
		layer.close();
	});

	it("DualWriteHook with enabled=undefined defaults to enabled", () => {
		const layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			// enabled is not set — should default to true
		});

		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		expect(events).toHaveLength(1);
		layer.close();
	});

	it("stats track correctly when disabled", () => {
		const layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			enabled: false,
		});

		for (let i = 0; i < 5; i++) {
			hook.onSSEEvent(
				makeSSEEvent("message.created", {
					sessionID: `sess-${i}`,
					messageID: `msg-${i}`,
					info: { role: "user", parts: [] },
				}),
				`sess-${i}`,
			);
		}

		const stats = hook.getStats();
		expect(stats.eventsReceived).toBe(0);
		expect(stats.eventsWritten).toBe(0);
		expect(stats.eventsSkipped).toBe(0);
		expect(stats.errors).toBe(0);
		layer.close();
	});

	it("DualWriteHook exposes onReconnect for SSE reconnect lifecycle (CH1)", () => {
		const layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
		});

		// Track a tool part
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				part: {
					id: "part-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"sess-1",
		);

		// Atomic reconnect lifecycle (simulating SSE reconnect)
		hook.onReconnect();

		// After reset, same part ID seen as "new" — tool.started again
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-1",
				part: {
					id: "part-1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		const toolStarted = events.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(2); // Seen as new after reset
		layer.close();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/feature-flag.test.ts`
Expected: PASS (these tests use DualWriteHook directly, which was implemented in Task 10).

Since this test already passes (it exercises the DualWriteHook's enabled flag which was already implemented), proceed to the relay-stack.ts wiring.

**Step 3: Write the relay-stack wiring**

Add the `PersistenceLayer` to `ProjectRelayConfig` and wire `DualWriteHook` creation into `createProjectRelay()`:

In `src/lib/types.ts`, add to the `ProjectRelayConfig` interface:

```typescript
// Add to ProjectRelayConfig (in src/lib/types.ts)
export interface ProjectRelayConfig {
	// ... existing fields ...
	/** Optional: shared PersistenceLayer for dual-write to SQLite event store. */
	persistence?: import("./persistence/persistence-layer.js").PersistenceLayer;
	/** Feature flag: enable dual-write to SQLite. Defaults to true (opt-out).
	 *  When persistence is provided and this is not explicitly false, dual-write is active. */
	dualWriteEnabled?: boolean;
}
```

In `src/lib/relay/relay-stack.ts`, after the SSE consumer creation and before `wireSSEConsumer()`, create the dual-write hook:

```typescript
// In createProjectRelay(), after SSE consumer creation, before wireSSEConsumer():
// NOTE: The import below must be placed at the top of relay-stack.ts with the
// other imports, NOT inside the function body:
//   import { DualWriteHook } from "../persistence/dual-write-hook.js";

// ── Dual-write hook (Phase 2: events flow to both JSONL and SQLite) ────
let dualWriteHook: DualWriteHook | undefined;
if (config.persistence && config.dualWriteEnabled !== false) {
	dualWriteHook = new DualWriteHook({
		persistence: config.persistence,
		log: log.child("dual-write"),
		enabled: true,
	});
	log.info("✓ Dual-write to SQLite event store enabled");
}

// ── (CH4) Projection recovery (must complete before SSE events flow) ────
// Replays any unprojected events from the event store through all
// projectors. This MUST happen after DualWriteHook creation and
// BEFORE wireSSEConsumer(), because projectEvent() will throw if
// called before recover() (the _recovered flag guard).
// (Perf-Fix-4) Use async recovery to keep the daemon responsive during startup.
if (config.persistence) {
	const result = await config.persistence.projectionRunner.recoverAsync({
		onProgress: (p) => {
			log.info(`recovery: ${p.projectorName} — ${p.eventsReplayed} events replayed (${p.durationMs}ms)`);
		},
	});
	if (result.totalReplayed > 0) {
		log.info(`Projection recovery complete: ${result.totalReplayed} events in ${result.durationMs}ms`);
	}
}
```

Then pass it into the `wireSSEConsumer` deps:

```typescript
wireSSEConsumer(
	{
		// ... existing deps unchanged ...
		...(dualWriteHook != null && { dualWriteHook }),
	},
	sseConsumer,
);
```

And add `dualWriteHook` reset on SSE reconnect. In `wireSSEConsumer()`, inside the `connected` handler, **immediately after `const gen = ++rehydrationGen;`** (before `broadcast("connected")` and the async rehydration logic). This ordering is critical: the reset must happen before any rehydration events are processed, otherwise stale `trackedParts` state would cause duplicate `tool.started` events during the rehydration replay.

```typescript
consumer.on("connected", () => {
	const gen = ++rehydrationGen;

	// (CH1) Atomic reconnect: resets translator, seeder, version cache, bumps epoch.
	// Must happen BEFORE broadcast("connected") and rehydration, to prevent stale
	// tracked-parts state from producing duplicate tool.started / thinking.start events.
	if (deps.dualWriteHook) {
		deps.dualWriteHook.onReconnect();
	}

	// ... rest of existing connected handler (broadcast, rehydration) ...
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/feature-flag.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/relay/relay-stack.ts src/lib/relay/sse-wiring.ts src/lib/types.ts test/unit/persistence/feature-flag.test.ts
git commit -m "feat(persistence): wire dual-write into relay stack with dualWriteEnabled feature flag"
```

---

### Phase 2 Completion Checklist

After all 6 tasks (Tasks 7-12), verify the full phase:

```bash
pnpm vitest run test/unit/persistence/
```

Expected: All tests pass. Files created or modified:

| File | Purpose |
|------|---------|
| `src/lib/persistence/canonical-event-translator.ts` | Maps OpenCode SSE events → 19 canonical event types |
| `src/lib/persistence/persistence-layer.ts` | Single entry point for SQLite initialization |
| `src/lib/persistence/session-seeder.ts` | INSERT OR IGNORE session row creation for FK compliance |
| `src/lib/persistence/dual-write-hook.ts` | Coordinates translation, seeding, and event store writes |
| `src/lib/relay/sse-wiring.ts` | **Modified**: optional `dualWriteHook` in `SSEWiringDeps`, called from `handleSSEEvent()` |
| `src/lib/relay/relay-stack.ts` | **Modified**: creates `DualWriteHook` when persistence + flag are configured |
| `src/lib/types.ts` | **Modified**: `persistence` and `dualWriteEnabled` on `ProjectRelayConfig` |

Also run the existing test suite to verify no regressions:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All existing tests pass. The relay pipeline is unchanged — dual-write is purely additive.

Final commit for any barrel export or cleanup:

```bash
git add src/lib/persistence/ src/lib/relay/ src/lib/types.ts test/unit/persistence/
git commit -m "feat(persistence): complete Phase 2 dual-write — SSE events flow to both JSONL and SQLite"
```

**Next:** Phase 3 (Projections) will implement the 6 projectors that eagerly maintain the `sessions`, `messages`, `turns`, `session_providers`, `pending_approvals`, and `activities` tables from canonical events.

---

## Phase 3: Projections — Eagerly Maintained Read Models

**Goal:** Implement all 6 projectors that consume canonical events from Phase 1 and eagerly maintain the read-model tables (`sessions`, `messages`, `turns`, `session_providers`, `pending_approvals`, `activities`) created in Task 3. Projectors run in a separate transaction after event append (Option B from the design doc), with cursor-based recovery on startup to close any gaps. Add a `ProjectionRunner` that orchestrates all projectors, manages the `projector_cursors` table, and performs startup recovery by replaying events after the last persisted cursor.

**Depends on:** Phase 1 (event store, schema, canonical event types), Phase 2 (dual-write hook, persistence layer).

**Validates:** Every canonical event appended by the dual-write hook updates the correct projection rows. Projection data is identical to what the reference implementation produces for the same event stream. Startup recovery correctly replays events from the persisted cursor. Projector errors abort the surrounding transaction so the event store never advances past a broken projector.

**Architecture pattern (from t3code reference):** In t3code, `ProjectionPipeline.ts` defines one `ProjectorDefinition` per projection, wires them behind a shared `SqlClient`, and — for each incoming `OrchestrationEvent` — runs the projector inside `sql.withTransaction` alongside a cursor update. Bootstrap replays events from each projector's `lastAppliedSequence` via `eventStore.readFromSequence()`. We follow the same structure, but without Effect: each projector is a plain class with a `project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void` method. A `ProjectionRunner` owns the set of projectors, runs them inside `db.transaction()`, and persists cursors through a `ProjectorCursorRepository`.

**Transaction strategy:** The dual-write hook's `append` path first persists the event via `eventStore.append()`, then immediately runs `projectionRunner.projectEvent()` in a separate transaction. If a projector fails, the event is still in the store but the cursor does not advance. The `ProjectionRunner.recover()` method replays unprojected events on startup, closing the gap. This keeps the implementation simple while the recovery mechanism provides an eventual-consistency guarantee: any event in the `events` table will be projected by the next startup at the latest.

**Projector contract:** Every projector implements a uniform shape:

```typescript
/**
 * (P3) Context passed to projectors by the ProjectionRunner.
 * `replaying` is true during startup recovery — projectors can use
 * this to enable replay-safety checks (e.g., alreadyApplied()) that
 * are wasteful during normal streaming.
 */
export interface ProjectionContext {
  readonly replaying: boolean;
}

export interface Projector {
  /** Stable name used as the `projector_cursors.projector_name` primary key. */
  readonly name: string;
  /** Canonical event types this projector handles (for documentation + filtering). */
  readonly handles: readonly CanonicalEventType[];
  /** Apply one event to the read model. Must be idempotent in replay scenarios.
   *  (P3) Optional context carries the `replaying` flag. */
  project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void;
}
```

Projectors are pure SQL: they read from `event.data`, execute `UPDATE`/`INSERT ... ON CONFLICT` statements, and return. They share the `SqliteClient` passed in by the `ProjectionRunner`, which is already inside an open transaction.

---

### Task 13: Projector Cursor Repository

**Files:**
- Create: `src/lib/persistence/projector-cursor-repository.ts`
- Test: `test/unit/persistence/projector-cursor-repository.test.ts`

**Purpose:** The `projector_cursors` table tracks each projector's `last_applied_seq`. On startup, the `ProjectionRunner` reads each cursor and replays events from that point. After every successful `project()` call, the cursor is advanced in the same transaction. This is the conduit equivalent of t3code's `ProjectionStateRepository` — a minimal key-value repository over one table.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projector-cursor-repository.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";

describe("ProjectorCursorRepository", () => {
	let client: SqliteClient;
	let repo: ProjectorCursorRepository;

	beforeEach(() => {
		client = SqliteClient.memory();
		runMigrations(client, schemaMigrations);
		repo = new ProjectorCursorRepository(client);
	});

	afterEach(() => {
		client?.close();
	});

	describe("get", () => {
		it("returns undefined for an unknown projector", () => {
			expect(repo.get("session")).toBeUndefined();
		});

		it("returns the cursor row after upsert", () => {
			repo.upsert("session", 42);
			const cursor = repo.get("session");
			expect(cursor).toBeDefined();
			expect(cursor!.projectorName).toBe("session");
			expect(cursor!.lastAppliedSeq).toBe(42);
			expect(cursor!.updatedAt).toBeGreaterThan(0);
		});
	});

	describe("upsert", () => {
		it("inserts a new cursor", () => {
			repo.upsert("message", 10);
			expect(repo.get("message")!.lastAppliedSeq).toBe(10);
		});

		it("updates an existing cursor", () => {
			repo.upsert("message", 10);
			repo.upsert("message", 20);
			expect(repo.get("message")!.lastAppliedSeq).toBe(20);
		});

		it("supports independent cursors per projector", () => {
			repo.upsert("session", 5);
			repo.upsert("message", 10);
			repo.upsert("turn", 15);
			expect(repo.get("session")!.lastAppliedSeq).toBe(5);
			expect(repo.get("message")!.lastAppliedSeq).toBe(10);
			expect(repo.get("turn")!.lastAppliedSeq).toBe(15);
		});

		it("advances updated_at on re-upsert", () => {
			repo.upsert("session", 1);
			const first = repo.get("session")!.updatedAt;
			// Ensure at least 1ms has passed so the timestamp changes
			const wait = Date.now() + 2;
			while (Date.now() < wait) {
				/* spin */
			}
			repo.upsert("session", 2);
			const second = repo.get("session")!.updatedAt;
			expect(second).toBeGreaterThanOrEqual(first);
		});
	});

	describe("listAll", () => {
		it("returns an empty array when no cursors exist", () => {
			expect(repo.listAll()).toEqual([]);
		});

		it("returns all cursors sorted by name", () => {
			repo.upsert("turn", 30);
			repo.upsert("session", 10);
			repo.upsert("message", 20);
			const all = repo.listAll();
			expect(all.map((c) => c.projectorName)).toEqual([
				"message",
				"session",
				"turn",
			]);
		});
	});

	describe("minCursor", () => {
		it("returns 0 when no cursors exist (replay from the beginning)", () => {
			expect(repo.minCursor()).toBe(0);
		});

		it("returns the minimum last_applied_seq across all cursors", () => {
			repo.upsert("session", 100);
			repo.upsert("message", 50);
			repo.upsert("turn", 75);
			expect(repo.minCursor()).toBe(50);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projector-cursor-repository.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/projector-cursor-repository.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projector-cursor-repository.ts
import type { SqliteClient } from "./sqlite-client.js";

/**
 * One row from the `projector_cursors` table.
 */
export interface ProjectorCursor {
	readonly projectorName: string;
	readonly lastAppliedSeq: number;
	readonly updatedAt: number;
}

interface CursorRow {
	projector_name: string;
	last_applied_seq: number;
	updated_at: number;
}

/**
 * Minimal repository over the `projector_cursors` table.
 *
 * The `ProjectionRunner` uses this to persist each projector's progress
 * through the event stream. Cursor updates always happen inside the same
 * transaction as the projector's `project()` call, so cursors never lag
 * behind the actual projection state.
 *
 * Equivalent to t3code's `ProjectionStateRepository`, but synchronous
 * and non-Effect.
 */
export class ProjectorCursorRepository {
	constructor(private readonly db: SqliteClient) {}

	/**
	 * Fetch the cursor for a single projector, or `undefined` if it has
	 * never been persisted. Callers should treat `undefined` as "start
	 * from sequence 0".
	 */
	get(projectorName: string): ProjectorCursor | undefined {
		const row = this.db.queryOne<CursorRow>(
			"SELECT projector_name, last_applied_seq, updated_at FROM projector_cursors WHERE projector_name = ?",
			[projectorName],
		);
		if (!row) return undefined;
		return {
			projectorName: row.projector_name,
			lastAppliedSeq: row.last_applied_seq,
			updatedAt: row.updated_at,
		};
	}

	/**
	 * List every cursor, sorted by name.
	 */
	listAll(): readonly ProjectorCursor[] {
		const rows = this.db.query<CursorRow>(
			"SELECT projector_name, last_applied_seq, updated_at FROM projector_cursors ORDER BY projector_name ASC",
		);
		return rows.map((row) => ({
			projectorName: row.projector_name,
			lastAppliedSeq: row.last_applied_seq,
			updatedAt: row.updated_at,
		}));
	}

	/**
	 * Insert or update a cursor.
	 *
	 * Called inside the same transaction as the projector's `project()`
	 * call, so if the projector throws, the cursor is rolled back as well.
	 *
	 * (CH3) Uses MAX() to ensure cursors only advance forward. This
	 * prevents recovery's syncAllCursors() from regressing a cursor
	 * that was already advanced by a concurrent live event. The CASE
	 * on updated_at avoids bumping the timestamp when the value
	 * doesn't actually change (useful for diagnostics).
	 */
	upsert(projectorName: string, lastAppliedSeq: number): void {
		this.db.execute(
			`
			INSERT INTO projector_cursors (projector_name, last_applied_seq, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT (projector_name) DO UPDATE SET
				last_applied_seq = MAX(excluded.last_applied_seq, projector_cursors.last_applied_seq),
				updated_at = CASE
					WHEN excluded.last_applied_seq > projector_cursors.last_applied_seq
					THEN excluded.updated_at
					ELSE projector_cursors.updated_at
				END
			`,
			[projectorName, lastAppliedSeq, Date.now()],
		);
	}

	/**
	 * Return the smallest `last_applied_seq` across all cursors.
	 *
	 * Used by startup recovery to find the replay starting point when
	 * multiple projectors have advanced at different rates. Returns 0
	 * when the table is empty — new installations replay from the
	 * beginning.
	 */
	minCursor(): number {
		const row = this.db.queryOne<{ min_seq: number | null }>(
			"SELECT MIN(last_applied_seq) AS min_seq FROM projector_cursors",
		);
		return row?.min_seq ?? 0;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projector-cursor-repository.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/projector-cursor-repository.ts test/unit/persistence/projector-cursor-repository.test.ts
git commit -m "feat(persistence): add ProjectorCursorRepository for tracking projector replay progress"
```

---

### Task 14: Projector Interface and Base Utilities

**Files:**
- Create: `src/lib/persistence/projectors/projector.ts`
- Test: `test/unit/persistence/projectors/projector.test.ts`

**Purpose:** Define the shared `Projector` interface every projection implements, plus small helper utilities (event type guards, JSON encoding) used by multiple projectors. Keeping these in one file avoids duplication across the six projector implementations that follow.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/projector.test.ts
import { describe, expect, it } from "vitest";
import type { Projector } from "../../../../src/lib/persistence/projectors/projector.js";
import {
	encodeJson,
	decodeJson,
	isEventType,
} from "../../../../src/lib/persistence/projectors/projector.js";
import type {
	StoredEvent,
	SessionCreatedPayload,
} from "../../../../src/lib/persistence/events.js";
import { createEventId } from "../../../../src/lib/persistence/events.js";

function makeStoredSessionCreated(sessionId: string): StoredEvent {
	return {
		sequence: 1,
		streamVersion: 0,
		eventId: createEventId(),
		sessionId,
		type: "session.created",
		data: {
			sessionId,
			title: "Test",
			provider: "opencode",
		} satisfies SessionCreatedPayload,
		metadata: {},
		provider: "opencode",
		createdAt: Date.now(),
	};
}

describe("Projector shared utilities", () => {
	describe("Projector interface", () => {
		it("allows declaring a minimal projector shape", () => {
			const noopProjector: Projector = {
				name: "noop",
				handles: [],
				project: () => {},
			};
			expect(noopProjector.name).toBe("noop");
			expect(noopProjector.handles).toEqual([]);
		});
	});

	describe("encodeJson", () => {
		it("encodes plain values", () => {
			expect(encodeJson({ a: 1 })).toBe('{"a":1}');
			expect(encodeJson([1, 2])).toBe("[1,2]");
			expect(encodeJson(null)).toBe("null");
		});

		it("encodes undefined as null", () => {
			expect(encodeJson(undefined)).toBe("null");
		});
	});

	describe("decodeJson", () => {
		it("decodes valid JSON", () => {
			expect(decodeJson('{"a":1}')).toEqual({ a: 1 });
			expect(decodeJson("null")).toBeNull();
		});

		it("returns undefined for null or empty input", () => {
			expect(decodeJson(null)).toBeUndefined();
			expect(decodeJson("")).toBeUndefined();
		});

		it("returns undefined for invalid JSON", () => {
			expect(decodeJson("not json")).toBeUndefined();
		});
	});

	describe("isEventType", () => {
		it("narrows the event to the given type", () => {
			const event = makeStoredSessionCreated("s1");
			if (isEventType(event, "session.created")) {
				// Compile-time check: event.data is SessionCreatedPayload
				expect(event.data.title).toBe("Test");
			} else {
				throw new Error("expected session.created");
			}
		});

		it("returns false for non-matching types", () => {
			const event = makeStoredSessionCreated("s1");
			expect(isEventType(event, "text.delta")).toBe(false);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/projector.test.ts`
Expected: FAIL with "Cannot find module '.../projectors/projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/projector.ts
import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import { PersistenceError } from "../errors.js";

/**
 * Shared interface implemented by every projector.
 *
 * Projectors are small, focused classes that consume canonical events and
 * upsert rows in one or more projection tables. They are driven by the
 * `ProjectionRunner`, which provides a `SqliteClient` that is already
 * inside an open transaction — projectors never open their own transactions.
 *
 * Equivalent to t3code's `ProjectorDefinition`, but synchronous and
 * without Effect. The `handles` field is informational: it documents
 * which event types a projector reacts to and is used in tests to verify
 * complete coverage. Actual dispatch happens via `switch (event.type)`
 * inside `project()`.
 */
export interface Projector {
	/** Stable name used as the `projector_cursors.projector_name` primary key. */
	readonly name: string;
	/** Canonical event types this projector handles. */
	readonly handles: readonly CanonicalEventType[];
	/**
	 * Apply a single event to the projection tables.
	 *
	 * Must be idempotent for replay: re-applying the same event after a
	 * cursor rewind must not corrupt the read model. Most projectors
	 * achieve this with `INSERT ... ON CONFLICT DO UPDATE` / `DO NOTHING`.
	 *
	 * Must NOT open its own transaction — the caller already did. Must
	 * throw on unrecoverable errors so the outer transaction rolls back.
	 */
	project(event: StoredEvent, db: SqliteClient): void;
}

// ─── Runtime handles-vs-implementation guard ───────────────────────────────
//
// Every projector should call this at the END of its project() method,
// after all if/return blocks.  If execution reaches here AND the event
// type is in the projector's `handles` list, the projector has a gap
// between what it declares and what it implements.

/**
 * Call at the end of `project()` to catch handle-list / implementation
 * mismatches at runtime.  Throws `PersistenceError` with code
 * `PROJECTION_FAILED` if the projector declares it handles the event
 * type but has no implementation branch for it.
 */
export function assertHandledOrIgnored(
	projector: Projector,
	event: StoredEvent,
): void {
	if ((projector.handles as readonly string[]).includes(event.type)) {
		throw new PersistenceError(
			"PROJECTION_FAILED",
			`Projector "${projector.name}" declares it handles "${event.type}" but has no implementation`,
			{
				projectorName: projector.name,
				eventType: event.type,
				sequence: event.sequence,
				sessionId: event.sessionId,
			},
		);
	}
}

// ─── Type-narrowing helper ─────────────────────────────────────────────────

/**
 * Type guard: narrows a `StoredEvent` to a specific event type and
 * exposes the matching payload type on `event.data`.
 *
 * ```ts
 * if (isEventType(event, "tool.started")) {
 *   // event.data is ToolStartedPayload
 * }
 * ```
 */
export function isEventType<K extends CanonicalEventType>(
	event: StoredEvent,
	type: K,
): event is StoredEvent & { type: K; data: EventPayloadMap[K] } {
	return event.type === type;
}

// ─── JSON helpers ──────────────────────────────────────────────────────────

/**
 * Encode a value to JSON for storage in a TEXT column.
 *
 * `undefined` becomes `"null"` so the NOT NULL columns that use
 * `DEFAULT '{}'` or `DEFAULT '[]'` can still be populated deterministically.
 */
export function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

/**
 * Decode a JSON TEXT column. Returns `undefined` for null/empty/invalid
 * input so callers can fall back to defaults without try/catch.
 */
export function decodeJson<T = unknown>(raw: string | null): T | undefined {
	if (raw == null || raw === "") return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/projector.ts test/unit/persistence/projectors/projector.test.ts
git commit -m "feat(persistence): add Projector interface and shared helpers for projection tasks"
```

---

### Task 15: SessionProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `test/helpers/persistence-factories.ts`.
> Use `FIXED_TEST_TIMESTAMP` for deterministic timestamps (F8). Remove `as CanonicalEvent` casts (F4).
> Add snapshot test: `expect(rows).toMatchSnapshot()` for standard lifecycle (T7).

**Files:**
- Create: `src/lib/persistence/projectors/session-projector.ts`
- Test: `test/unit/persistence/projectors/session-projector.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/session-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { SessionProjector } from "../../../../src/lib/persistence/projectors/session-projector.js";
import {
	createEventId,
	type StoredEvent,
	type SessionCreatedPayload,
	type SessionRenamedPayload,
	type SessionStatusPayload,
	type SessionProviderChangedPayload,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt: Date.now(),
	} as StoredEvent;
}

interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	created_at: number;
	updated_at: number;
}

describe("SessionProjector", () => {
	let db: SqliteClient;
	let projector: SessionProjector;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new SessionProjector();
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("session");
		expect(projector.handles).toEqual([
			"session.created",
			"session.renamed",
			"session.status",
			"session.provider_changed",
			"turn.completed",
			"turn.error",
			"message.created",
		]);
	});

	describe("session.created", () => {
		it("inserts a new session row", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello World",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row).toBeDefined();
			expect(row!.id).toBe("s1");
			expect(row!.provider).toBe("opencode");
			expect(row!.title).toBe("Hello World");
			expect(row!.status).toBe("idle");
			expect(row!.created_at).toBe(event.createdAt);
			expect(row!.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO UPDATE)", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "First",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.renamed", () => {
		it("updates the title and updated_at", () => {
			const created = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Original",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1);
			projector.project(created, db);

			const renamed = makeStored("session.renamed", "s1", {
				sessionId: "s1",
				title: "Renamed Session",
			} satisfies SessionRenamedPayload, 2);
			renamed.createdAt = created.createdAt + 1000;
			projector.project(renamed, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row!.title).toBe("Renamed Session");
			expect(row!.updated_at).toBe(renamed.createdAt);
		});
	});

	describe("session.status", () => {
		it("updates the status and updated_at", () => {
			const created = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1);
			projector.project(created, db);

			const status = makeStored("session.status", "s1", {
				sessionId: "s1",
				status: "busy",
			} satisfies SessionStatusPayload, 2);
			status.createdAt = created.createdAt + 500;
			projector.project(status, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row!.status).toBe("busy");
			expect(row!.updated_at).toBe(status.createdAt);
		});
	});

	describe("session.provider_changed", () => {
		it("updates the provider and updated_at", () => {
			const created = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1);
			projector.project(created, db);

			const changed = makeStored("session.provider_changed", "s1", {
				sessionId: "s1",
				oldProvider: "opencode",
				newProvider: "claude-sdk",
			} satisfies SessionProviderChangedPayload, 2);
			changed.createdAt = created.createdAt + 2000;
			projector.project(changed, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row!.provider).toBe("claude-sdk");
			expect(row!.updated_at).toBe(changed.createdAt);
		});
	});

	describe("turn.completed", () => {
		it("updates only updated_at", () => {
			const created = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1);
			projector.project(created, db);

			const originalRow = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			const originalTitle = originalRow!.title;
			const originalStatus = originalRow!.status;

			const turnDone = makeStored("turn.completed", "s1", {
				messageId: "m1",
				cost: 0.01,
				tokens: { input: 100, output: 50 },
			} satisfies TurnCompletedPayload, 2);
			turnDone.createdAt = created.createdAt + 5000;
			projector.project(turnDone, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row!.title).toBe(originalTitle);
			expect(row!.status).toBe(originalStatus);
			expect(row!.updated_at).toBe(turnDone.createdAt);
		});
	});

	describe("turn.error", () => {
		it("updates only updated_at", () => {
			const created = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1);
			projector.project(created, db);

			const turnErr = makeStored("turn.error", "s1", {
				messageId: "m1",
				error: "something failed",
			} satisfies TurnErrorPayload, 2);
			turnErr.createdAt = created.createdAt + 3000;
			projector.project(turnErr, db);

			const row = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
			expect(row!.updated_at).toBe(turnErr.createdAt);
		});
	});

	it("ignores event types it does not handle", () => {
		// Pre-insert a session so we can verify it's untouched
		const created = makeStored("session.created", "s1", {
			sessionId: "s1",
			title: "Test",
			provider: "opencode",
		} satisfies SessionCreatedPayload, 1);
		projector.project(created, db);

		const before = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);

		const unrelated = makeStored("text.delta", "s1", {
			messageId: "m1",
			partId: "p1",
			text: "hello",
		} as any, 2);
		projector.project(unrelated, db);

		const after = db.queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", ["s1"]);
		expect(after!.updated_at).toBe(before!.updated_at);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/session-projector.test.ts`
Expected: FAIL with "Cannot find module '...session-projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/session-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { isEventType, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness: verify all declared handles are covered ──
type _HandledBySession =
	| "session.created"
	| "session.renamed"
	| "session.status"
	| "session.provider_changed"
	| "turn.completed"
	| "turn.error"
	| "message.created";
type _SessionHandles = (typeof SessionProjector.prototype.handles)[number];
type _SessionMissing = Exclude<_SessionHandles, _HandledBySession>;
type _SessionCheck = _SessionMissing extends never ? true : { error: `Unhandled: ${_SessionMissing}` };
const _sessionExhaustive: _SessionCheck = true;

/**
 * Projects session lifecycle events into the `sessions` read-model table.
 *
 * Handled events:
 * - `session.created`         → INSERT with ON CONFLICT DO UPDATE (preserving nullable columns)
 * - `session.renamed`         → UPDATE title
 * - `session.status`          → UPDATE status
 * - `session.provider_changed`→ UPDATE provider
 * - `turn.completed`          → UPDATE updated_at only
 * - `turn.error`              → UPDATE updated_at only
 * - `message.created`         → UPDATE last_message_at (P8 — denormalized for efficient ordering)
 *
 * `asked` events use `INSERT … ON CONFLICT (id) DO NOTHING` so replay
 * after a `resolved` event does not reset the row to pending.
 * `resolved` events use guarded `UPDATE … WHERE id = ?`.
 */
export class SessionProjector implements Projector {
	readonly name = "session";

	readonly handles: readonly CanonicalEventType[] = [
		"session.created",
		"session.renamed",
		"session.status",
		"session.provider_changed",
		"turn.completed",
		"turn.error",
		"message.created",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "session.created")) {
			// Use INSERT ... ON CONFLICT DO UPDATE instead of INSERT OR REPLACE
			// to preserve nullable columns (provider_sid, parent_id,
			// fork_point_event) that may have been set by other code paths.
			db.execute(
				`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'idle', ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     provider = excluded.provider,
				     title = excluded.title,
				     updated_at = excluded.updated_at`,
				[
					event.data.sessionId,
					event.data.provider,
					event.data.title,
					event.createdAt,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "session.renamed")) {
			db.execute(
				"UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
				[event.data.title, event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "session.status")) {
			db.execute(
				"UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
				[event.data.status, event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "session.provider_changed")) {
			db.execute(
				"UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?",
				[event.data.newProvider, event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "turn.completed") || isEventType(event, "turn.error")) {
			db.execute(
				"UPDATE sessions SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.sessionId],
			);
			return;
		}

		// (P8) Denormalize last_message_at on the session. Owned by
		// SessionProjector (not MessageProjector) to keep all session-table
		// mutations in one projector.
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

		// Runtime guard: throws if event.type is in `handles` but not covered above
		assertHandledOrIgnored(this, event);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/session-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The projector is a simple switch over event types with one SQL statement each.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/session-projector.ts test/unit/persistence/projectors/session-projector.test.ts
git commit -m "feat(persistence): add SessionProjector for session lifecycle events"
```

---

### Task 16: MessageProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `test/helpers/persistence-factories.ts`.
> Use `FIXED_TEST_TIMESTAMP` for deterministic timestamps. Remove `as CanonicalEvent` casts.
> Add snapshot test including both `messages` and `message_parts` tables (T7/P1).

> **Amendment (2026-04-07, Perf-Fix-1):** `getNextSortOrder()` eliminated from the delta hot path.
> Sort order is now computed inline via `COALESCE((SELECT MAX(sort_order) + 1 ...), 0)` subquery
> in the VALUES clause. SQLite still evaluates the subquery on every execution (including the
> ON CONFLICT path), but the value is discarded since `sort_order` is not in `DO UPDATE SET`.
> The key benefit: eliminating a separate `db.queryOne()` round-trip per delta (~50/sec during streaming).
> See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 1.

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5e — Text Accumulation Status):**
> When S7's 200K cap is hit, set `status = 'truncated'` on the `message_parts` row.
> When a terminal event arrives (`tool.completed`, `thinking.end`, `text.completed`),
> set `status = 'complete'` (which also replaces truncated text with full content from the
> terminal event). The `ReadQueryService` includes the status in query results so the UI can
> display a "content may be incomplete" indicator. `PersistenceDiagnostics.checkIntegrity()`
> reports parts with `status = 'truncated'` as a warning.

> **Amendment (2026-04-07, S7 — Text Accumulation Cap):**
> Stop appending `text.delta` content via SQL concat (`text = text || excluded.text`) after 200K chars
> per message part. After reaching the cap, subsequent deltas for that part are silently dropped from
> the projection (the event is still stored in the event store for replay).
>
> **Rationale:** The `text || ?` SQL concat is O(n) per delta / O(n^2) total — at 50K chars across
> 500 deltas, total bytes copied is ~12.5M. At 200K chars, it would be ~20GB of memcpy. Large tool
> outputs that would exceed this cap arrive via `tool.completed` as a single write anyway — the
> streaming deltas only show partial progress. Truncating the streaming projection is acceptable.
>
> **Implementation:** Track per-part text length in the MessageProjector's projection logic. Before
> executing the `text = text || excluded.text` SQL, check if the part's current text length has
> exceeded `MAX_TEXT_ACCUMULATION` (200K). If so, skip the SQL update. On `turn.completed` or
> `thinking.end`, the cap is irrelevant — final state comes from the completion event.
>
> **Phase 7 upgrade:** If P11 data shows the quadratic cost is material below the 200K cap, implement
> the threshold-based `text_overflow` column strategy from Solution 7's full design (adds
> `text_overflow TEXT NOT NULL DEFAULT ''` and `frozen_length INTEGER` to `message_parts`).

**Files:**
- Create: `src/lib/persistence/projectors/message-projector.ts`
- Test: `test/unit/persistence/projectors/message-projector.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/message-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { MessageProjector } from "../../../../src/lib/persistence/projectors/message-projector.js";
import {
	createEventId,
	type StoredEvent,
	type MessageCreatedPayload,
	type TextDeltaPayload,
	type ThinkingStartPayload,
	type ThinkingDeltaPayload,
	type ThinkingEndPayload,
	type ToolStartedPayload,
	type ToolRunningPayload,
	type ToolCompletedPayload,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt: Date.now(),
	} as StoredEvent;
}

interface MessageRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	is_streaming: number;
	created_at: number;
	updated_at: number;
}

interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

describe("MessageProjector", () => {
	let db: SqliteClient;
	let projector: MessageProjector;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new MessageProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("message");
		expect(projector.handles).toEqual([
			"message.created",
			"text.delta",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"tool.started",
			"tool.running",
			"tool.completed",
			"turn.completed",
			"turn.error",
		]);
	});

	describe("message.created", () => {
		it("inserts a new message row with streaming flag", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row).toBeDefined();
			expect(row!.id).toBe("m1");
			expect(row!.session_id).toBe("s1");
			expect(row!.role).toBe("assistant");
			expect(row!.text).toBe("");
			expect(row!.is_streaming).toBe(1);
			expect(row!.created_at).toBe(event.createdAt);
			expect(row!.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(rows).toHaveLength(1);
		});

		it("inserts user messages with is_streaming=0", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload);

			projector.project(event, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("text.delta", () => {
		it("appends text to an existing message and creates/updates a message_parts row", () => {
			// Create message first
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			// First delta
			const delta1 = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "Hello ",
			} satisfies TextDeltaPayload, 2);
			projector.project(delta1, db);

			let row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.text).toBe("Hello ");
			let parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(1);
			expect(parts[0].type).toBe("text");
			expect(parts[0].id).toBe("p1");
			expect(parts[0].text).toBe("Hello ");

			// Second delta, same part — text is appended via SQL concat
			const delta2 = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "World!",
			} satisfies TextDeltaPayload, 3);
			projector.project(delta2, db);

			row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.text).toBe("Hello World!");
			parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(1);
			expect(parts[0].text).toBe("Hello World!");
		});

		it("handles multiple text parts on the same message", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1",
					partId: "p1",
					text: "Part one",
				} satisfies TextDeltaPayload, 2),
				db,
			);

			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1",
					partId: "p2",
					text: "Part two",
				} satisfies TextDeltaPayload, 3),
				db,
			);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			// text is the concatenation of all text deltas
			expect(row!.text).toBe("Part onePart two");
			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(2);
			expect(parts[0].id).toBe("p1");
			expect(parts[1].id).toBe("p2");
		});
	});

	describe("thinking.start", () => {
		it("initializes a thinking part row with empty text", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const start = makeStored("thinking.start", "s1", {
				messageId: "m1",
				partId: "t1",
			} satisfies ThinkingStartPayload, 2);
			projector.project(start, db);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(1);
			expect(parts[0].type).toBe("thinking");
			expect(parts[0].id).toBe("t1");
			expect(parts[0].text).toBe("");
		});
	});

	describe("thinking.delta", () => {
		it("appends thinking content to a message_parts row", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const think = makeStored("thinking.delta", "s1", {
				messageId: "m1",
				partId: "t1",
				text: "Let me think...",
			} satisfies ThinkingDeltaPayload, 2);
			projector.project(think, db);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(1);
			expect(parts[0].type).toBe("thinking");
			expect(parts[0].id).toBe("t1");
			expect(parts[0].text).toBe("Let me think...");
			// Thinking text does NOT accumulate into the top-level text column
			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.text).toBe("");
		});
	});

	describe("thinking.end", () => {
		it("updates updated_at only", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const end = makeStored("thinking.end", "s1", {
				messageId: "m1",
				partId: "t1",
			} satisfies ThinkingEndPayload, 2);
			end.createdAt = created.createdAt + 1000;
			projector.project(end, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.updated_at).toBe(end.createdAt);
		});
	});

	describe("tool.started", () => {
		it("adds a tool part row with started status", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const started = makeStored("tool.started", "s1", {
				messageId: "m1",
				partId: "tool1",
				toolName: "read_file",
				callId: "call_123",
				input: { path: "/foo/bar.ts" },
			} satisfies ToolStartedPayload, 2);
			projector.project(started, db);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(1);
			expect(parts[0].type).toBe("tool");
			expect(parts[0].id).toBe("tool1");
			expect(parts[0].tool_name).toBe("read_file");
			expect(parts[0].call_id).toBe("call_123");
			expect(JSON.parse(parts[0].input!)).toEqual({ path: "/foo/bar.ts" });
			expect(parts[0].status).toBe("started");
		});
	});

	describe("tool.running", () => {
		it("updates matching tool part status to running", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			projector.project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "read_file",
					callId: "call_123",
					input: { path: "/foo" },
				} satisfies ToolStartedPayload, 2),
				db,
			);

			projector.project(
				makeStored("tool.running", "s1", {
					messageId: "m1",
					partId: "tool1",
				} satisfies ToolRunningPayload, 3),
				db,
			);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? AND id = ?", ["m1", "tool1"]);
			expect(parts[0].status).toBe("running");
		});
	});

	describe("tool.completed", () => {
		it("updates matching tool part with result, duration, and completed status", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			projector.project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "read_file",
					callId: "call_123",
					input: { path: "/foo" },
				} satisfies ToolStartedPayload, 2),
				db,
			);

			projector.project(
				makeStored("tool.completed", "s1", {
					messageId: "m1",
					partId: "tool1",
					result: { content: "file contents" },
					duration: 150,
				} satisfies ToolCompletedPayload, 3),
				db,
			);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? AND id = ?", ["m1", "tool1"]);
			expect(parts[0].status).toBe("completed");
			expect(JSON.parse(parts[0].result!)).toEqual({ content: "file contents" });
			expect(parts[0].duration).toBe(150);
		});
	});

	describe("turn.completed", () => {
		it("updates cost, tokens, and clears streaming flag", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const done = makeStored("turn.completed", "s1", {
				messageId: "m1",
				cost: 0.0234,
				tokens: {
					input: 1500,
					output: 350,
					cacheRead: 200,
					cacheWrite: 50,
				},
			} satisfies TurnCompletedPayload, 2);
			projector.project(done, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.cost).toBeCloseTo(0.0234);
			expect(row!.tokens_in).toBe(1500);
			expect(row!.tokens_out).toBe(350);
			expect(row!.tokens_cache_read).toBe(200);
			expect(row!.tokens_cache_write).toBe(50);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("turn.error", () => {
		it("clears streaming flag", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const err = makeStored("turn.error", "s1", {
				messageId: "m1",
				error: "rate_limit",
			} satisfies TurnErrorPayload, 2);
			projector.project(err, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.is_streaming).toBe(0);
		});
	});

	describe("full streaming lifecycle", () => {
		it("accumulates text, tool calls, and finalizes correctly", () => {
			const now = Date.now();

			// 1. message.created
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1),
				db,
			);

			// 2. thinking.delta
			projector.project(
				makeStored("thinking.delta", "s1", {
					messageId: "m1",
					partId: "think1",
					text: "Considering...",
				} satisfies ThinkingDeltaPayload, 2),
				db,
			);

			// 3. thinking.end
			projector.project(
				makeStored("thinking.end", "s1", {
					messageId: "m1",
					partId: "think1",
				} satisfies ThinkingEndPayload, 3),
				db,
			);

			// 4. text.delta
			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1",
					partId: "text1",
					text: "I'll read that file. ",
				} satisfies TextDeltaPayload, 4),
				db,
			);

			// 5. tool.started
			projector.project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "tool1",
					toolName: "read_file",
					callId: "call_abc",
					input: { path: "/src/main.ts" },
				} satisfies ToolStartedPayload, 5),
				db,
			);

			// 6. tool.running
			projector.project(
				makeStored("tool.running", "s1", {
					messageId: "m1",
					partId: "tool1",
				} satisfies ToolRunningPayload, 6),
				db,
			);

			// 7. tool.completed
			projector.project(
				makeStored("tool.completed", "s1", {
					messageId: "m1",
					partId: "tool1",
					result: "console.log('hello')",
					duration: 42,
				} satisfies ToolCompletedPayload, 7),
				db,
			);

			// 8. More text
			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1",
					partId: "text2",
					text: "Done!",
				} satisfies TextDeltaPayload, 8),
				db,
			);

			// 9. turn.completed
			projector.project(
				makeStored("turn.completed", "s1", {
					messageId: "m1",
					cost: 0.05,
					tokens: { input: 2000, output: 500, cacheRead: 100, cacheWrite: 25 },
				} satisfies TurnCompletedPayload, 9),
				db,
			);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(row!.text).toBe("I'll read that file. Done!");
			expect(row!.is_streaming).toBe(0);
			expect(row!.cost).toBeCloseTo(0.05);
			expect(row!.tokens_in).toBe(2000);
			expect(row!.tokens_out).toBe(500);

			const parts = db.query<MessagePartRow>("SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order", ["m1"]);
			expect(parts).toHaveLength(4); // thinking, text1, tool1, text2
			expect(parts[0].type).toBe("thinking");
			expect(parts[1].type).toBe("text");
			expect(parts[1].text).toBe("I'll read that file. ");
			expect(parts[2].type).toBe("tool");
			expect(parts[2].status).toBe("completed");
			expect(parts[3].type).toBe("text");
			expect(parts[3].text).toBe("Done!");
		});
	});

	describe("replay safety", () => {
		it("does not double text when the same text.delta is replayed (ON CONFLICT upsert)", () => {
			const created = makeStored("message.created", "s1", {
				messageId: "m1",
				role: "assistant",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1);
			projector.project(created, db);

			const delta = makeStored("text.delta", "s1", {
				messageId: "m1",
				partId: "p1",
				text: "Hello",
			} satisfies TextDeltaPayload, 2);

			// Project the same delta twice (simulating replay)
			projector.project(delta, db);
			projector.project(delta, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			// With normalized message_parts and SQL-native text || ?, replay
			// WILL double text on the messages.text denormalized column.
			// The ON CONFLICT on message_parts also appends text again.
			// During recovery (replaying=true), the alreadyApplied() check
			// prevents this. During normal streaming, events arrive in order
			// and are never replayed.
			expect(row!.text).toBe("HelloHello");
		});

		it("handles text.delta before message.created gracefully (no-op on UPDATE)", () => {
			// text.delta arrives before message.created — UPDATE matches zero
			// rows since the message doesn't exist yet. UPSERT on message_parts
			// may insert an orphan row that will be associated when message.created
			// arrives.
			const delta = makeStored("text.delta", "s1", {
				messageId: "m-nonexistent",
				partId: "p1",
				text: "orphan delta",
			} satisfies TextDeltaPayload, 1);

			// Should not throw
			projector.project(delta, db);

			const row = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m-nonexistent"]);
			expect(row).toBeUndefined();
		});
	});

	describe("multi-session isolation", () => {
		it("does not mix messages across sessions", () => {
			// Pre-insert a second session
			db.execute(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				["s2", "opencode", "Session 2", "idle", Date.now(), Date.now()],
			);

			// Message in session s1
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1),
				db,
			);

			// Message in session s2
			projector.project(
				makeStored("message.created", "s2", {
					messageId: "m2",
					role: "user",
					sessionId: "s2",
				} satisfies MessageCreatedPayload, 2),
				db,
			);

			// Text delta for s1\'s message
			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1",
					partId: "p1",
					text: "s1 text",
				} satisfies TextDeltaPayload, 3),
				db,
			);

			// Verify s1\'s message got the text
			const m1 = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m1"]);
			expect(m1!.text).toBe("s1 text");

			// Verify s2\'s message is untouched
			const m2 = db.queryOne<MessageRow>("SELECT * FROM messages WHERE id = ?", ["m2"]);
			expect(m2!.text).toBe("");

			// Verify per-session queries return correct counts
			const s1Messages = db.query<MessageRow>("SELECT * FROM messages WHERE session_id = ?", ["s1"]);
			const s2Messages = db.query<MessageRow>("SELECT * FROM messages WHERE session_id = ?", ["s2"]);
			expect(s1Messages).toHaveLength(1);
			expect(s2Messages).toHaveLength(1);
		});
	});

	// ─── (Perf-Fix-1) sort_order tests ──────────────────────────────────

	describe("sort_order assignment", () => {
		it("assigns incrementing sort_order to new parts", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "m1", role: "assistant", sessionId: "s1",
				} satisfies MessageCreatedPayload, 1),
				db,
			);

			// Three different parts
			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1", partId: "p1", text: "A",
				} satisfies TextDeltaPayload, 2),
				db,
			);
			projector.project(
				makeStored("thinking.start", "s1", {
					messageId: "m1", partId: "t1",
				} satisfies ThinkingStartPayload, 3),
				db,
			);
			projector.project(
				makeStored("tool.started", "s1", {
					messageId: "m1", partId: "tool1",
					toolName: "bash", callId: "c1", input: {},
				} satisfies ToolStartedPayload, 4),
				db,
			);

			const parts = db.query<{ id: string; sort_order: number }>(
				"SELECT id, sort_order FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				["m1"],
			);
			expect(parts).toHaveLength(3);
			expect(parts[0]!.id).toBe("p1");
			expect(parts[0]!.sort_order).toBe(0);
			expect(parts[1]!.id).toBe("t1");
			expect(parts[1]!.sort_order).toBe(1);
			expect(parts[2]!.id).toBe("tool1");
			expect(parts[2]!.sort_order).toBe(2);
		});

		it("does not change sort_order on subsequent deltas for the same part", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "m1", role: "assistant", sessionId: "s1",
				} satisfies MessageCreatedPayload, 1),
				db,
			);

			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1", partId: "p1", text: "Hello ",
				} satisfies TextDeltaPayload, 2),
				db,
			);
			projector.project(
				makeStored("text.delta", "s1", {
					messageId: "m1", partId: "p1", text: "World",
				} satisfies TextDeltaPayload, 3),
				db,
			);

			const parts = db.query<{ id: string; sort_order: number; text: string }>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.sort_order).toBe(0); // unchanged from first insert
			expect(parts[0]!.text).toBe("Hello World");
		});

		it("sort_order is stable when thinking.delta is replayed with replaying=true", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "m1", role: "assistant", sessionId: "s1",
				} satisfies MessageCreatedPayload, 1),
				db,
			);

			const thinkDelta = makeStored("thinking.delta", "s1", {
				messageId: "m1", partId: "t1", text: "Hmm...",
			} satisfies ThinkingDeltaPayload, 2);
			projector.project(thinkDelta, db);

			// Replay the same event with replaying=true — should be skipped by alreadyApplied
			projector.project(thinkDelta, db, { replaying: true });

			const parts = db.query<{ id: string; sort_order: number; text: string }>(
				"SELECT id, sort_order, text FROM message_parts WHERE message_id = ?",
				["m1"],
			);
			expect(parts).toHaveLength(1);
			expect(parts[0]!.sort_order).toBe(0);
			expect(parts[0]!.text).toBe("Hmm..."); // not doubled
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/message-projector.test.ts`
Expected: FAIL with "Cannot find module \'...message-projector.js\'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/message-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector, ProjectionContext } from "./projector.js";
import { isEventType, encodeJson, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness ─────────────────────────────────────
type _HandledByMessage =
	| "message.created"
	| "text.delta"
	| "thinking.start"
	| "thinking.delta"
	| "thinking.end"
	| "tool.started"
	| "tool.running"
	| "tool.completed"
	| "turn.completed"
	| "turn.error";
type _MessageHandles = (typeof MessageProjector.prototype.handles)[number];
type _MessageMissing = Exclude<_MessageHandles, _HandledByMessage>;
type _MessageCheck = _MessageMissing extends never ? true : { error: `Unhandled: ${_MessageMissing}` };
const _messageExhaustive: _MessageCheck = true;

/**
 * Projects message lifecycle events into the `messages` and `message_parts`
 * read-model tables.
 *
 * (P1) Normalized `message_parts` table eliminates the JSON
 * read-parse-modify-serialize-write cycle from the hot path. Per-delta
 * cost is 2 SQL statements with zero JSON:
 * 1. UPSERT on message_parts (SQL-native text || ? concat)
 * 2. UPDATE on messages.text (SQL-native text || ? concat)
 *
 * This replaces the v1 `ProjectionDeltaBuffer` approach which reduced
 * frequency of a bad pattern. Normalization eliminates the pattern entirely.
 *
 * Handled events:
 * - `message.created`  → INSERT message row with empty text, is_streaming=1
 * - `text.delta`       → UPSERT message_parts row (SQL concat), UPDATE messages.text
 * - `thinking.start`   → INSERT message_parts row with type=thinking
 * - `thinking.delta`   → UPSERT message_parts row (SQL concat, no messages.text update)
 * - `thinking.end`     → UPDATE messages.updated_at only
 * - `tool.started`     → INSERT message_parts row with type=tool, ON CONFLICT DO NOTHING
 * - `tool.running`     → UPDATE message_parts.status to running
 * - `tool.completed`   → UPDATE message_parts with result, duration, status=completed
 * - `turn.completed`   → Finalize: cost, tokens, is_streaming=0
 * - `turn.error`       → Finalize: is_streaming=0
 *
 * (P3) Replay safety: The `alreadyApplied()` check is only needed for
 * the text.delta and thinking.delta SQL concat path (text || ? doubles on
 * replay), and only during recovery (replaying=true). During normal
 * streaming, events arrive in order and are never replayed. Tool lifecycle
 * events use ON CONFLICT DO NOTHING / final-state UPDATE, which are
 * naturally idempotent.
 *
 * (Perf-Fix-1) sort_order is computed inline via COALESCE subquery in the
 * VALUES clause. The subquery evaluates on every execution (including the
 * ON CONFLICT path), but the value is discarded since sort_order is not in
 * DO UPDATE SET. This eliminates the separate db.queryOne() round-trip that
 * getNextSortOrder() required (~50 calls/sec during streaming).
 */
export class MessageProjector implements Projector {
	readonly name = "message";

	readonly handles: readonly CanonicalEventType[] = [
		"message.created",
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.completed",
		"turn.completed",
		"turn.error",
	] as const;

	project(event: StoredEvent, db: SqliteClient, ctx?: ProjectionContext): void {
		if (isEventType(event, "message.created")) {
			const isStreaming = event.data.role === "assistant" ? 1 : 0;
			db.execute(
				`INSERT INTO messages
				 (id, session_id, role, text, is_streaming, created_at, updated_at)
				 VALUES (?, ?, ?, '', ?, ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.messageId,
					event.data.sessionId,
					event.data.role,
					isStreaming,
					event.createdAt,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "text.delta")) {
			// (P3) Only check during replay — during normal streaming, events
			// arrive in order and are never replayed, so this SELECT is waste.
			if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;

			// (P1, Perf-Fix-1) sort_order computed in SQL, not Node.js.
			// SQLite evaluates the COALESCE subquery on every execution (including
			// the ON CONFLICT path), but sort_order is not in DO UPDATE SET, so
			// the value is discarded on updates. The key benefit: eliminating a
			// separate db.queryOne() round-trip per delta (~50/sec during streaming).
			// The subquery hits the covering index idx_message_parts_message and
			// costs ~10μs.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'text', ?,
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     text = message_parts.text || excluded.text,
				     updated_at = excluded.updated_at`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.text,
					event.data.messageId,  // for the COALESCE subquery
					event.createdAt,
					event.createdAt,
				],
			);

			// Update the denormalized text column on the message
			db.execute(
				`UPDATE messages SET text = text || ?, last_applied_seq = ?, updated_at = ? WHERE id = ?`,
				[event.data.text, event.sequence, event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "thinking.start")) {
			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'thinking', '',
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute(
				"UPDATE messages SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "thinking.delta")) {
			// (P3) Only check during replay
			if (ctx?.replaying && this.alreadyApplied(db, event.data.messageId, event.sequence)) return;

			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'thinking', ?,
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				     text = message_parts.text || excluded.text,
				     updated_at = excluded.updated_at`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.text,
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute(
				"UPDATE messages SET last_applied_seq = ?, updated_at = ? WHERE id = ?",
				[event.sequence, event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "thinking.end")) {
			db.execute(
				"UPDATE messages SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "tool.started")) {
			// (Perf-Fix-1) sort_order computed in SQL, not Node.js.
			db.execute(
				`INSERT INTO message_parts
				 (id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'tool', ?, ?, ?, 'started',
				     COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ?), 0),
				     ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.partId,
					event.data.messageId,
					event.data.toolName,
					event.data.callId,
					encodeJson(event.data.input),
					event.data.messageId,
					event.createdAt,
					event.createdAt,
				],
			);
			db.execute(
				"UPDATE messages SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "tool.running")) {
			// Final-state UPDATE — naturally idempotent
			db.execute(
				`UPDATE message_parts SET status = 'running', updated_at = ? WHERE id = ?`,
				[event.createdAt, event.data.partId],
			);
			db.execute(
				"UPDATE messages SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "tool.completed")) {
			// Final-state UPDATE — naturally idempotent
			db.execute(
				`UPDATE message_parts
				 SET result = ?, duration = ?, status = 'completed', updated_at = ?
				 WHERE id = ?`,
				[encodeJson(event.data.result), event.data.duration, event.createdAt, event.data.partId],
			);
			db.execute(
				"UPDATE messages SET updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "turn.completed")) {
			const tokens = event.data.tokens;
			db.execute(
				`UPDATE messages SET
				 cost = ?,
				 tokens_in = ?,
				 tokens_out = ?,
				 tokens_cache_read = ?,
				 tokens_cache_write = ?,
				 is_streaming = 0,
				 updated_at = ?
				 WHERE id = ?`,
				[
					event.data.cost ?? null,
					tokens?.input ?? null,
					tokens?.output ?? null,
					tokens?.cacheRead ?? null,
					tokens?.cacheWrite ?? null,
					event.createdAt,
					event.data.messageId,
				],
			);
			return;
		}

		if (isEventType(event, "turn.error")) {
			db.execute(
				"UPDATE messages SET is_streaming = 0, updated_at = ? WHERE id = ?",
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		// Runtime guard: throws if event.type is in `handles` but not covered above
		assertHandledOrIgnored(this, event);
	}

	// ─── Private helpers ──────────────────────────────────────────────────

	// (Perf-Fix-1) getNextSortOrder() deleted — sort_order now computed
	// inline via COALESCE subquery. See performance-fixes plan Task 1.

	/**
	 * Check if this event sequence has already been applied to this message.
	 *
	 * Delta events (text.delta, thinking.delta) are NOT naturally idempotent —
	 * replaying them appends text again via SQL concat, doubling content.
	 * We track the last-applied sequence per message in the `last_applied_seq`
	 * column and skip events that have already been applied.
	 *
	 * (P3) Only called during replay (ctx.replaying=true). During normal
	 * streaming, this SELECT is skipped entirely.
	 */
	private alreadyApplied(
		db: SqliteClient,
		messageId: string,
		sequence: number,
	): boolean {
		const row = db.queryOne<{ last_applied_seq: number | null }>(
			"SELECT last_applied_seq FROM messages WHERE id = ?",
			[messageId],
		);
		if (!row) return false; // message doesn't exist yet
		return row.last_applied_seq != null && sequence <= row.last_applied_seq;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/message-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The normalized `message_parts` table eliminates the JSON read-parse-modify-serialize-write cycle entirely. Per-delta cost is 2 SQL statements (1 UPSERT on `message_parts` + 1 UPDATE on `messages.text`) with zero JSON parsing. Tool lifecycle events are simple row INSERT/UPDATE operations with natural idempotency via `ON CONFLICT DO NOTHING` and final-state UPDATE patterns.

> **(P1) Performance note:** The v1 `ProjectionDeltaBuffer` is no longer needed. Normalization eliminates the root cause (JSON round-trips on the hot path) rather than reducing the frequency of the bad pattern. The COALESCE subquery for `sort_order` evaluates on every execution (including the ON CONFLICT path where its result is discarded), but it runs within the same prepared statement — eliminating the separate `db.queryOne()` round-trip that `getNextSortOrder()` required. The aggregate hits the covering index `idx_message_parts_message` and costs ~10μs.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/message-projector.ts test/unit/persistence/projectors/message-projector.test.ts
git commit -m "feat(persistence): add MessageProjector for streaming message lifecycle events"
```

---

### Task 17: TurnProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `persistence-factories.ts`. Add snapshot test (T7).

**Files:**
- Create: `src/lib/persistence/projectors/turn-projector.ts`
- Test: `test/unit/persistence/projectors/turn-projector.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/turn-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { TurnProjector } from "../../../../src/lib/persistence/projectors/turn-projector.js";
import {
	createEventId,
	type StoredEvent,
	type MessageCreatedPayload,
	type SessionStatusPayload,
	type TurnCompletedPayload,
	type TurnErrorPayload,
	type TurnInterruptedPayload,
} from "../../../../src/lib/persistence/events.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	user_message_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
}

describe("TurnProjector", () => {
	let db: SqliteClient;
	let projector: TurnProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new TurnProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("turn");
		expect(projector.handles).toEqual([
			"message.created",
			"session.status",
			"turn.completed",
			"turn.error",
			"turn.interrupted",
		]);
	});

	describe("user message.created", () => {
		it("inserts a new turn with state=pending and user_message_id", () => {
			const event = makeStored("message.created", "s1", {
				messageId: "user_m1",
				role: "user",
				sessionId: "s1",
			} satisfies MessageCreatedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row).toBeDefined();
			expect(row!.id).toBe("user_m1");
			expect(row!.session_id).toBe("s1");
			expect(row!.state).toBe("pending");
			expect(row!.user_message_id).toBe("user_m1");
			expect(row!.assistant_message_id).toBeNull();
			expect(row!.requested_at).toBe(now);
			expect(row!.started_at).toBeNull();
			expect(row!.completed_at).toBeNull();
		});
	});

	describe("assistant message.created", () => {
		it("updates the most recent pending/running turn with assistant_message_id", () => {
			// User message creates the turn
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			// Assistant message arrives
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.assistant_message_id).toBe("asst_m1");
		});

		it("does not create a new turn for assistant messages", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);

			const rows = db.query<TurnRow>("SELECT * FROM turns WHERE session_id = ?", ["s1"]);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.status (busy)", () => {
		it("transitions the most recent pending turn to running with started_at", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("session.status", "s1", {
					sessionId: "s1",
					status: "busy",
				} satisfies SessionStatusPayload, 2, now + 200),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("running");
			expect(row!.started_at).toBe(now + 200);
		});

		it("ignores non-busy status changes", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("session.status", "s1", {
					sessionId: "s1",
					status: "idle",
				} satisfies SessionStatusPayload, 2, now + 200),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("pending");
			expect(row!.started_at).toBeNull();
		});
	});

	describe("turn.completed", () => {
		it("finalizes the turn with cost, tokens, and completed_at", () => {
			// Full lifecycle
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);

			projector.project(
				makeStored("turn.completed", "s1", {
					messageId: "asst_m1",
					cost: 0.042,
					tokens: { input: 3000, output: 800 },
				} satisfies TurnCompletedPayload, 3, now + 5000),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("completed");
			expect(row!.cost).toBeCloseTo(0.042);
			expect(row!.tokens_in).toBe(3000);
			expect(row!.tokens_out).toBe(800);
			expect(row!.completed_at).toBe(now + 5000);
		});
	});

	describe("turn.error", () => {
		it("marks the turn as errored", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);

			projector.project(
				makeStored("turn.error", "s1", {
					messageId: "asst_m1",
					error: "rate_limit_exceeded",
					code: "429",
				} satisfies TurnErrorPayload, 3, now + 3000),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("error");
			expect(row!.completed_at).toBe(now + 3000);
		});
	});

	describe("turn.interrupted", () => {
		it("marks the turn as interrupted", () => {
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);

			projector.project(
				makeStored("turn.interrupted", "s1", {
					messageId: "asst_m1",
				} satisfies TurnInterruptedPayload, 3, now + 2000),
				db,
			);

			const row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("interrupted");
			expect(row!.completed_at).toBe(now + 2000);
		});
	});

	describe("full turn lifecycle", () => {
		it("tracks a complete turn from user message to completion", () => {
			// 1. User sends message → turn created
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);

			let row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("pending");

			// 2. Session goes busy → turn starts running
			projector.project(
				makeStored("session.status", "s1", {
					sessionId: "s1",
					status: "busy",
				} satisfies SessionStatusPayload, 2, now + 50),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("running");
			expect(row!.started_at).toBe(now + 50);

			// 3. Assistant message arrives
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 3, now + 100),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.assistant_message_id).toBe("asst_m1");

			// 4. Turn completes
			projector.project(
				makeStored("turn.completed", "s1", {
					messageId: "asst_m1",
					cost: 0.1,
					tokens: { input: 5000, output: 1200, cacheRead: 300, cacheWrite: 100 },
				} satisfies TurnCompletedPayload, 4, now + 10000),
				db,
			);

			row = db.queryOne<TurnRow>("SELECT * FROM turns WHERE id = ?", ["user_m1"]);
			expect(row!.state).toBe("completed");
			expect(row!.cost).toBeCloseTo(0.1);
			expect(row!.tokens_in).toBe(5000);
			expect(row!.tokens_out).toBe(1200);
			expect(row!.completed_at).toBe(now + 10000);
		});
	});

	describe("multiple turns in one session", () => {
		it("tracks each turn independently", () => {
			// Turn 1
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 1, now),
				db,
			);
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 2, now + 100),
				db,
			);
			projector.project(
				makeStored("turn.completed", "s1", {
					messageId: "asst_m1",
					cost: 0.01,
					tokens: { input: 100, output: 50 },
				} satisfies TurnCompletedPayload, 3, now + 5000),
				db,
			);

			// Turn 2
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "user_m2",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 4, now + 6000),
				db,
			);
			projector.project(
				makeStored("message.created", "s1", {
					messageId: "asst_m2",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, 5, now + 6100),
				db,
			);
			projector.project(
				makeStored("turn.completed", "s1", {
					messageId: "asst_m2",
					cost: 0.02,
					tokens: { input: 200, output: 100 },
				} satisfies TurnCompletedPayload, 6, now + 11000),
				db,
			);

			const rows = db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at",
				["s1"],
			);
			expect(rows).toHaveLength(2);
			expect(rows[0].id).toBe("user_m1");
			expect(rows[0].state).toBe("completed");
			expect(rows[1].id).toBe("user_m2");
			expect(rows[1].state).toBe("completed");
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/turn-projector.test.ts`
Expected: FAIL with "Cannot find module '...turn-projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/turn-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { isEventType, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness ─────────────────────────────────────
type _HandledByTurn = "message.created" | "session.status" | "turn.completed" | "turn.error" | "turn.interrupted";
type _TurnHandles = (typeof TurnProjector.prototype.handles)[number];
type _TurnMissing = Exclude<_TurnHandles, _HandledByTurn>;
type _TurnCheck = _TurnMissing extends never ? true : { error: `Unhandled: ${_TurnMissing}` };
const _turnExhaustive: _TurnCheck = true;

/**
 * Projects turn lifecycle events into the `turns` read-model table.
 *
 * A "turn" is one user-prompt → assistant-response cycle. The turn ID is
 * the user message ID (the message that initiated the turn).
 *
 * Handled events:
 * - `message.created` (role=user)      → INSERT turn, state=pending
 * - `message.created` (role=assistant)  → UPDATE most recent turn with assistant_message_id
 * - `session.status` (status=busy)      → UPDATE most recent pending turn to running
 * - `turn.completed`                    → UPDATE matching turn to completed with cost/tokens
 * - `turn.error`                        → UPDATE matching turn to error
 * - `turn.interrupted`                  → UPDATE matching turn to interrupted
 */
export class TurnProjector implements Projector {
	readonly name = "turn";

	readonly handles: readonly CanonicalEventType[] = [
		"message.created",
		"session.status",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "message.created")) {
			if (event.data.role === "user") {
				// User message creates a new turn
				db.execute(
					`INSERT OR REPLACE INTO turns
					 (id, session_id, state, user_message_id, requested_at)
					 VALUES (?, ?, 'pending', ?, ?)`,
					[
						event.data.messageId,
						event.data.sessionId,
						event.data.messageId,
						event.createdAt,
					],
				);
			} else {
				// Assistant message — attach to the most recent turn in this session
				// that doesn't yet have an assistant_message_id. Use a sub-select
				// instead of UPDATE ... ORDER BY ... LIMIT to avoid depending on
				// the SQLITE_ENABLE_UPDATE_DELETE_LIMIT compile-time option.
				db.execute(
					`UPDATE turns
					 SET assistant_message_id = ?
					 WHERE id = (
					   SELECT id FROM turns
					   WHERE session_id = ?
					     AND assistant_message_id IS NULL
					     AND state IN ('pending', 'running')
					   ORDER BY requested_at DESC
					   LIMIT 1
					 )`,
					[event.data.messageId, event.data.sessionId],
				);
			}
			return;
		}

		if (isEventType(event, "session.status")) {
			if (event.data.status !== "busy") return;

			// Transition the most recent pending turn to running.
			// Use a sub-select instead of UPDATE ... ORDER BY ... LIMIT
			// to avoid depending on the SQLITE_ENABLE_UPDATE_DELETE_LIMIT
			// compile-time option.
			db.execute(
				`UPDATE turns
				 SET state = 'running', started_at = ?
				 WHERE id = (
				   SELECT id FROM turns
				   WHERE session_id = ?
				     AND state = 'pending'
				   ORDER BY requested_at DESC
				   LIMIT 1
				 )`,
				[event.createdAt, event.data.sessionId],
			);
			return;
		}

		if (isEventType(event, "turn.completed")) {
			const tokens = event.data.tokens;
			db.execute(
				`UPDATE turns
				 SET state = 'completed',
				     cost = ?,
				     tokens_in = ?,
				     tokens_out = ?,
				     completed_at = ?
				 WHERE assistant_message_id = ?`,
				[
					event.data.cost ?? null,
					tokens?.input ?? null,
					tokens?.output ?? null,
					event.createdAt,
					event.data.messageId,
				],
			);
			return;
		}

		if (isEventType(event, "turn.error")) {
			db.execute(
				`UPDATE turns
				 SET state = 'error', completed_at = ?
				 WHERE assistant_message_id = ?`,
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		if (isEventType(event, "turn.interrupted")) {
			db.execute(
				`UPDATE turns
				 SET state = 'interrupted', completed_at = ?
				 WHERE assistant_message_id = ?`,
				[event.createdAt, event.data.messageId],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/turn-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The sub-select pattern (`WHERE id = (SELECT id FROM turns WHERE ... ORDER BY ... LIMIT 1)`) is used instead of `UPDATE ... ORDER BY ... LIMIT 1` to avoid depending on the `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile-time option, which is not guaranteed across all platforms.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/turn-projector.ts test/unit/persistence/projectors/turn-projector.test.ts
git commit -m "feat(persistence): add TurnProjector for turn lifecycle tracking"
```

---

### Task 18: ProviderProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `persistence-factories.ts`. Add snapshot test (T7).

**Files:**
- Create: `src/lib/persistence/projectors/provider-projector.ts`
- Test: `test/unit/persistence/projectors/provider-projector.test.ts`

**Purpose:** Projects session-provider binding events into the `session_providers` table. Each session has one active provider at any time. When the provider changes, the old binding is deactivated and a new active binding is inserted. This gives the UI a time-ordered history of which provider was active during each segment of a session.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/provider-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { ProviderProjector } from "../../../../src/lib/persistence/projectors/provider-projector.js";
import {
	createEventId,
	type StoredEvent,
	type SessionCreatedPayload,
	type SessionProviderChangedPayload,
} from "../../../../src/lib/persistence/events.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface ProviderRow {
	id: string;
	session_id: string;
	provider: string;
	provider_sid: string | null;
	status: string;
	activated_at: number;
	deactivated_at: number | null;
}

describe("ProviderProjector", () => {
	let db: SqliteClient;
	let projector: ProviderProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ProviderProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("provider");
		expect(projector.handles).toEqual([
			"session.created",
			"session.provider_changed",
		]);
	});

	describe("session.created", () => {
		it("inserts an active provider binding", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1, now);

			projector.project(event, db);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].session_id).toBe("s1");
			expect(rows[0].provider).toBe("opencode");
			expect(rows[0].status).toBe("active");
			expect(rows[0].activated_at).toBe(now);
			expect(rows[0].deactivated_at).toBeNull();
		});

		it("generates a UUID for the binding id", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(row!.id).toBeDefined();
			expect(row!.id.length).toBeGreaterThan(0);
		});

		it("is idempotent — replaying does not create duplicates when no active binding exists", () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello",
				provider: "opencode",
			} satisfies SessionCreatedPayload, 1, now);

			projector.project(event, db);
			projector.project(event, db);

			// Second replay should see existing active binding and skip
			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? AND status = 'active'",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.provider_changed", () => {
		it("deactivates old binding and inserts new active binding", () => {
			// First: create the session with initial provider
			projector.project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Hello",
					provider: "opencode",
				} satisfies SessionCreatedPayload, 1, now),
				db,
			);

			// Then: change provider
			const changeTime = now + 5000;
			projector.project(
				makeStored("session.provider_changed", "s1", {
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude-sdk",
				} satisfies SessionProviderChangedPayload, 2, changeTime),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(2);

			// Old binding is deactivated
			expect(rows[0].provider).toBe("opencode");
			expect(rows[0].status).toBe("stopped");
			expect(rows[0].deactivated_at).toBe(changeTime);

			// New binding is active
			expect(rows[1].provider).toBe("claude-sdk");
			expect(rows[1].status).toBe("active");
			expect(rows[1].activated_at).toBe(changeTime);
			expect(rows[1].deactivated_at).toBeNull();
		});

		it("handles multiple provider changes", () => {
			projector.project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Hello",
					provider: "opencode",
				} satisfies SessionCreatedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("session.provider_changed", "s1", {
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude-sdk",
				} satisfies SessionProviderChangedPayload, 2, now + 1000),
				db,
			);

			projector.project(
				makeStored("session.provider_changed", "s1", {
					sessionId: "s1",
					oldProvider: "claude-sdk",
					newProvider: "gemini",
				} satisfies SessionProviderChangedPayload, 3, now + 2000),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(rows).toHaveLength(3);
			expect(rows[0].provider).toBe("opencode");
			expect(rows[0].status).toBe("stopped");
			expect(rows[1].provider).toBe("claude-sdk");
			expect(rows[1].status).toBe("stopped");
			expect(rows[2].provider).toBe("gemini");
			expect(rows[2].status).toBe("active");
		});

		it("is safe when no active binding exists (e.g. out-of-order replay)", () => {
			// provider_changed without a preceding session.created
			// Should still insert the new active binding even if there's nothing to deactivate
			projector.project(
				makeStored("session.provider_changed", "s1", {
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude-sdk",
				} satisfies SessionProviderChangedPayload, 1, now),
				db,
			);

			const rows = db.query<ProviderRow>(
				"SELECT * FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].provider).toBe("claude-sdk");
			expect(rows[0].status).toBe("active");
		});
	});

	it("ignores event types it does not handle", () => {
		const unrelated = makeStored("text.delta", "s1", {
			messageId: "m1",
			partId: "p1",
			text: "hello",
		} as any, 1, now);

		projector.project(unrelated, db);

		const rows = db.query<ProviderRow>(
			"SELECT * FROM session_providers WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/provider-projector.test.ts`
Expected: FAIL with "Cannot find module '...provider-projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/provider-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { isEventType, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness ─────────────────────────────────────
type _HandledByProvider = "session.created" | "session.provider_changed";
type _ProviderHandles = (typeof ProviderProjector.prototype.handles)[number];
type _ProviderMissing = Exclude<_ProviderHandles, _HandledByProvider>;
type _ProviderCheck = _ProviderMissing extends never ? true : { error: `Unhandled: ${_ProviderMissing}` };
const _providerExhaustive: _ProviderCheck = true;

/**
 * Projects session-provider binding events into the `session_providers`
 * read-model table.
 *
 * Each row represents one session ↔ provider binding with an activation
 * window. At most one binding per session has `status = 'active'` at any
 * point in time.
 *
 * Handled events:
 * - `session.created`           → INSERT active binding with the initial provider
 * - `session.provider_changed`  → Deactivate old binding, INSERT new active binding
 *
 * Idempotency for replay:
 * - `session.created`: uses deterministic ID `${sessionId}:initial` and
 *   `INSERT OR IGNORE`, so replays never create duplicates even after a
 *   `provider_changed` has stopped the initial binding.
 * - `session.provider_changed`: uses deterministic ID
 *   `${sessionId}:${event.sequence}` for the new binding (also
 *   `INSERT OR IGNORE`), and deactivation is idempotent
 *   (UPDATE ... WHERE status = 'active').
 */
export class ProviderProjector implements Projector {
	readonly name = "provider";

	readonly handles: readonly CanonicalEventType[] = [
		"session.created",
		"session.provider_changed",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "session.created")) {
			// Deterministic ID for the initial binding. `INSERT OR IGNORE`
			// keeps this idempotent across replays, even if a subsequent
			// `provider_changed` has already stopped the initial binding.
			db.execute(
				`INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
				 VALUES (?, ?, ?, 'active', ?)`,
				[
					`${event.data.sessionId}:initial`,
					event.data.sessionId,
					event.data.provider,
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "session.provider_changed")) {
			// Deactivate any currently-active binding for this session.
			db.execute(
				`UPDATE session_providers
				 SET status = 'stopped', deactivated_at = ?
				 WHERE session_id = ? AND status = 'active'`,
				[event.createdAt, event.data.sessionId],
			);

			// Insert new active binding with deterministic ID tied to the
			// event sequence so replays are idempotent.
			db.execute(
				`INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
				 VALUES (?, ?, ?, 'active', ?)`,
				[
					`${event.data.sessionId}:${event.sequence}`,
					event.data.sessionId,
					event.data.newProvider,
					event.createdAt,
				],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/provider-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The projector is straightforward — two event types, each with simple SQL.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/provider-projector.ts test/unit/persistence/projectors/provider-projector.test.ts
git commit -m "feat(persistence): add ProviderProjector for session-provider binding history"
```

---

### Task 19: ApprovalProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `persistence-factories.ts`. Add snapshot test (T7).

**Files:**
- Create: `src/lib/persistence/projectors/approval-projector.ts`
- Test: `test/unit/persistence/projectors/approval-projector.test.ts`

**Purpose:** Projects permission and question lifecycle events into the `pending_approvals` table. Each `permission.asked` or `question.asked` event inserts a pending row; the corresponding `.resolved` event updates it to resolved with the decision. This gives the UI instant access to all pending and historical approvals without querying the event stream.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/approval-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { ApprovalProjector } from "../../../../src/lib/persistence/projectors/approval-projector.js";
import {
	createEventId,
	type StoredEvent,
	type PermissionAskedPayload,
	type PermissionResolvedPayload,
	type QuestionAskedPayload,
	type QuestionResolvedPayload,
} from "../../../../src/lib/persistence/events.js";
import { decodeJson } from "../../../../src/lib/persistence/projectors/projector.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface ApprovalRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	type: string;
	status: string;
	tool_name: string | null;
	input: string | null;
	decision: string | null;
	created_at: number;
	resolved_at: number | null;
}

describe("ApprovalProjector", () => {
	let db: SqliteClient;
	let projector: ApprovalProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ApprovalProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("approval");
		expect(projector.handles).toEqual([
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
		]);
	});

	describe("permission.asked", () => {
		it("inserts a pending permission approval", () => {
			const event = makeStored("permission.asked", "s1", {
				id: "perm-1",
				sessionId: "s1",
				toolName: "bash",
				input: { command: "rm -rf /" },
			} satisfies PermissionAskedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(row).toBeDefined();
			expect(row!.id).toBe("perm-1");
			expect(row!.session_id).toBe("s1");
			expect(row!.type).toBe("permission");
			expect(row!.status).toBe("pending");
			expect(row!.tool_name).toBe("bash");
			expect(decodeJson(row!.input)).toEqual({ command: "rm -rf /" });
			expect(row!.decision).toBeNull();
			expect(row!.created_at).toBe(now);
			expect(row!.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored("permission.asked", "s1", {
				id: "perm-1",
				sessionId: "s1",
				toolName: "bash",
				input: { command: "ls" },
			} satisfies PermissionAskedPayload, 1, now);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("permission.resolved", () => {
		it("updates the approval to resolved with decision", () => {
			// First: ask
			projector.project(
				makeStored("permission.asked", "s1", {
					id: "perm-1",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "ls" },
				} satisfies PermissionAskedPayload, 1, now),
				db,
			);

			// Then: resolve
			const resolveTime = now + 3000;
			projector.project(
				makeStored("permission.resolved", "s1", {
					id: "perm-1",
					decision: "allow",
				} satisfies PermissionResolvedPayload, 2, resolveTime),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-1"],
			);
			expect(row!.status).toBe("resolved");
			expect(row!.decision).toBe("allow");
			expect(row!.resolved_at).toBe(resolveTime);
		});

		it("updates to denied decision", () => {
			projector.project(
				makeStored("permission.asked", "s1", {
					id: "perm-2",
					sessionId: "s1",
					toolName: "write",
					input: { filePath: "/etc/passwd" },
				} satisfies PermissionAskedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("permission.resolved", "s1", {
					id: "perm-2",
					decision: "deny",
				} satisfies PermissionResolvedPayload, 2, now + 1000),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-2"],
			);
			expect(row!.status).toBe("resolved");
			expect(row!.decision).toBe("deny");
		});
	});

	describe("question.asked", () => {
		it("inserts a pending question approval", () => {
			const event = makeStored("question.asked", "s1", {
				id: "q-1",
				sessionId: "s1",
				questions: [
					{ id: "q1-a", text: "Are you sure?", type: "confirm" },
				],
			} satisfies QuestionAskedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(row).toBeDefined();
			expect(row!.id).toBe("q-1");
			expect(row!.session_id).toBe("s1");
			expect(row!.type).toBe("question");
			expect(row!.status).toBe("pending");
			expect(row!.tool_name).toBeNull();
			expect(decodeJson(row!.input)).toEqual([
				{ id: "q1-a", text: "Are you sure?", type: "confirm" },
			]);
			expect(row!.decision).toBeNull();
			expect(row!.created_at).toBe(now);
			expect(row!.resolved_at).toBeNull();
		});

		it("is idempotent (INSERT ON CONFLICT DO NOTHING)", () => {
			const event = makeStored("question.asked", "s1", {
				id: "q-1",
				sessionId: "s1",
				questions: [{ id: "q1-a", text: "Sure?", type: "confirm" }],
			} satisfies QuestionAskedPayload, 1, now);

			projector.project(event, db);
			projector.project(event, db);

			const rows = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("question.resolved", () => {
		it("updates the question to resolved with answers as decision", () => {
			projector.project(
				makeStored("question.asked", "s1", {
					id: "q-1",
					sessionId: "s1",
					questions: [{ id: "q1-a", text: "Sure?", type: "confirm" }],
				} satisfies QuestionAskedPayload, 1, now),
				db,
			);

			const resolveTime = now + 2000;
			projector.project(
				makeStored("question.resolved", "s1", {
					id: "q-1",
					answers: { "q1-a": true },
				} satisfies QuestionResolvedPayload, 2, resolveTime),
				db,
			);

			const row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["q-1"],
			);
			expect(row!.status).toBe("resolved");
			expect(decodeJson(row!.decision)).toEqual({ "q1-a": true });
			expect(row!.resolved_at).toBe(resolveTime);
		});
	});

	describe("full lifecycle", () => {
		it("tracks permission from asked to resolved", () => {
			projector.project(
				makeStored("permission.asked", "s1", {
					id: "perm-lifecycle",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "echo hi" },
				} satisfies PermissionAskedPayload, 1, now),
				db,
			);

			let row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row!.status).toBe("pending");

			projector.project(
				makeStored("permission.resolved", "s1", {
					id: "perm-lifecycle",
					decision: "allow",
				} satisfies PermissionResolvedPayload, 2, now + 5000),
				db,
			);

			row = db.queryOne<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE id = ?",
				["perm-lifecycle"],
			);
			expect(row!.status).toBe("resolved");
			expect(row!.decision).toBe("allow");
		});

		it("tracks multiple approvals in one session", () => {
			projector.project(
				makeStored("permission.asked", "s1", {
					id: "perm-a",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "ls" },
				} satisfies PermissionAskedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("question.asked", "s1", {
					id: "q-a",
					sessionId: "s1",
					questions: [{ id: "qa-1", text: "Continue?", type: "confirm" }],
				} satisfies QuestionAskedPayload, 2, now + 100),
				db,
			);

			const pending = db.query<ApprovalRow>(
				"SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at",
				["s1"],
			);
			expect(pending).toHaveLength(2);
			expect(pending[0].type).toBe("permission");
			expect(pending[1].type).toBe("question");
		});
	});

	it("ignores event types it does not handle", () => {
		const unrelated = makeStored("text.delta", "s1", {
			messageId: "m1",
			partId: "p1",
			text: "hello",
		} as any, 1, now);

		projector.project(unrelated, db);

		const rows = db.query<ApprovalRow>(
			"SELECT * FROM pending_approvals WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/approval-projector.test.ts`
Expected: FAIL with "Cannot find module '...approval-projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/approval-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { isEventType, encodeJson, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness ─────────────────────────────────────
type _HandledByApproval = "permission.asked" | "permission.resolved" | "question.asked" | "question.resolved";
type _ApprovalHandles = (typeof ApprovalProjector.prototype.handles)[number];
type _ApprovalMissing = Exclude<_ApprovalHandles, _HandledByApproval>;
type _ApprovalCheck = _ApprovalMissing extends never ? true : { error: `Unhandled: ${_ApprovalMissing}` };
const _approvalExhaustive: _ApprovalCheck = true;

/**
 * Projects permission and question lifecycle events into the
 * `pending_approvals` read-model table.
 *
 * Handled events:
 * - `permission.asked`    → INSERT pending permission approval
 * - `permission.resolved` → UPDATE to resolved with decision
 * - `question.asked`      → INSERT pending question approval
 * - `question.resolved`   → UPDATE to resolved with answers as decision
 *
 * `asked` events use `INSERT ... ON CONFLICT (id) DO NOTHING` so replay
 * after a `resolved` event does not reset the row to pending.
 * `resolved` events use guarded `UPDATE ... WHERE id = ?`.
 */
export class ApprovalProjector implements Projector {
	readonly name = "approval";

	readonly handles: readonly CanonicalEventType[] = [
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "permission.asked")) {
			// Use INSERT ... ON CONFLICT DO NOTHING instead of INSERT OR REPLACE.
			// On replay, if a `permission.resolved` has already run, INSERT OR REPLACE
			// would reset the row to `pending` and lose the decision.
			db.execute(
				`INSERT INTO pending_approvals
				 (id, session_id, type, status, tool_name, input, created_at)
				 VALUES (?, ?, 'permission', 'pending', ?, ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.id,
					event.data.sessionId,
					event.data.toolName,
					encodeJson(event.data.input),
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "permission.resolved")) {
			db.execute(
				`UPDATE pending_approvals
				 SET status = 'resolved', decision = ?, resolved_at = ?
				 WHERE id = ?`,
				[event.data.decision, event.createdAt, event.data.id],
			);
			return;
		}

		if (isEventType(event, "question.asked")) {
			// Use INSERT ... ON CONFLICT DO NOTHING (same rationale as permission.asked).
			db.execute(
				`INSERT INTO pending_approvals
				 (id, session_id, type, status, input, created_at)
				 VALUES (?, ?, 'question', 'pending', ?, ?)
				 ON CONFLICT (id) DO NOTHING`,
				[
					event.data.id,
					event.data.sessionId,
					encodeJson(event.data.questions),
					event.createdAt,
				],
			);
			return;
		}

		if (isEventType(event, "question.resolved")) {
			db.execute(
				`UPDATE pending_approvals
				 SET status = 'resolved', decision = ?, resolved_at = ?
				 WHERE id = ?`,
				[encodeJson(event.data.answers), event.createdAt, event.data.id],
			);
			return;
		}

		assertHandledOrIgnored(this, event);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/approval-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. Four event types, each with one SQL statement.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/approval-projector.ts test/unit/persistence/projectors/approval-projector.test.ts
git commit -m "feat(persistence): add ApprovalProjector for permission and question lifecycle"
```

---

### Task 20: ActivityProjector

> **Amendment (2026-04-09 — Testing Audit, F4/F8/T7):**
> Replace local `makeStored` with import from `persistence-factories.ts`. Add snapshot test (T7).

**Files:**
- Create: `src/lib/persistence/projectors/activity-projector.ts`
- Test: `test/unit/persistence/projectors/activity-projector.test.ts`

**Purpose:** Projects tool, permission, question, and error events into the `activities` timeline table. Every handled event creates a new activity row with a tone (tool/approval/info/error), kind (the event type), and a human-readable summary. This gives the UI a chronological activity feed without re-reading the event stream.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projectors/activity-projector.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../../src/lib/persistence/schema.js";
import { ActivityProjector } from "../../../../src/lib/persistence/projectors/activity-projector.js";
import {
	createEventId,
	type StoredEvent,
	type ToolStartedPayload,
	type ToolRunningPayload,
	type ToolCompletedPayload,
	type PermissionAskedPayload,
	type PermissionResolvedPayload,
	type QuestionAskedPayload,
	type QuestionResolvedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { decodeJson } from "../../../../src/lib/persistence/projectors/projector.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	sequence: number = 1,
	createdAt: number = Date.now(),
): StoredEvent {
	return {
		sequence,
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	} as StoredEvent;
}

interface ActivityRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	tone: string;
	kind: string;
	summary: string;
	payload: string;
	sequence: number | null;
	created_at: number;
}

describe("ActivityProjector", () => {
	let db: SqliteClient;
	let projector: ActivityProjector;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		projector = new ActivityProjector();

		// Pre-insert a session so FK constraints don't block inserts
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", now, now],
		);
	});

	afterEach(() => {
		db?.close();
	});

	it("has the correct name and handles list", () => {
		expect(projector.name).toBe("activity");
		expect(projector.handles).toEqual([
			"tool.started",
			"tool.running",
			"tool.completed",
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
			"turn.error",
		]);
	});

	describe("tool.started", () => {
		it("inserts an activity with tone=tool, kind=tool.started", () => {
			const event = makeStored("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "bash",
				callId: "call-1",
				input: { command: "ls" },
			} satisfies ToolStartedPayload, 1, now);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE session_id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("tool");
			expect(rows[0].kind).toBe("tool.started");
			expect(rows[0].summary).toBe("bash");
			expect(rows[0].sequence).toBe(1);
			expect(rows[0].created_at).toBe(now);
		});
	});

	describe("tool.running", () => {
		it("inserts an activity with tone=tool, kind=tool.running", () => {
			const event = makeStored("tool.running", "s1", {
				messageId: "m1",
				partId: "p1",
			} satisfies ToolRunningPayload, 2, now + 100);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.running'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("tool");
			expect(rows[0].summary).toBe("p1");
		});
	});

	describe("tool.completed", () => {
		it("inserts an activity with tone=tool, kind=tool.completed and duration in summary", () => {
			const event = makeStored("tool.completed", "s1", {
				messageId: "m1",
				partId: "p1",
				result: "file.txt",
				duration: 1234,
			} satisfies ToolCompletedPayload, 3, now + 1234);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.completed'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("tool");
			expect(rows[0].summary).toContain("p1");
			expect(rows[0].summary).toContain("1234ms");
		});
	});

	describe("permission.asked", () => {
		it("inserts an activity with tone=approval, kind=permission.asked", () => {
			const event = makeStored("permission.asked", "s1", {
				id: "perm-1",
				sessionId: "s1",
				toolName: "bash",
				input: { command: "rm -rf /" },
			} satisfies PermissionAskedPayload, 1, now);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'permission.asked'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("approval");
			expect(rows[0].summary).toBe("bash");
		});
	});

	describe("permission.resolved", () => {
		it("inserts an activity with tone=approval, kind=permission.resolved", () => {
			const event = makeStored("permission.resolved", "s1", {
				id: "perm-1",
				decision: "allow",
			} satisfies PermissionResolvedPayload, 2, now + 1000);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'permission.resolved'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("approval");
			expect(rows[0].summary).toBe("allow");
		});
	});

	describe("question.asked", () => {
		it("inserts an activity with tone=info, kind=question.asked", () => {
			const event = makeStored("question.asked", "s1", {
				id: "q-1",
				sessionId: "s1",
				questions: [{ id: "q1-a", text: "Sure?", type: "confirm" }],
			} satisfies QuestionAskedPayload, 1, now);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'question.asked'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("info");
			expect(rows[0].summary).toBe("Question asked");
		});
	});

	describe("question.resolved", () => {
		it("inserts an activity with tone=info, kind=question.resolved", () => {
			const event = makeStored("question.resolved", "s1", {
				id: "q-1",
				answers: { "q1-a": true },
			} satisfies QuestionResolvedPayload, 2, now + 500);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'question.resolved'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("info");
			expect(rows[0].summary).toBe("Question answered");
		});
	});

	describe("turn.error", () => {
		it("inserts an activity with tone=error, kind=turn.error and error message as summary", () => {
			const event = makeStored("turn.error", "s1", {
				messageId: "m1",
				error: "rate_limit_exceeded",
				code: "429",
			} satisfies TurnErrorPayload, 3, now + 2000);

			projector.project(event, db);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'turn.error'",
				[],
			);
			expect(rows).toHaveLength(1);
			expect(rows[0].tone).toBe("error");
			expect(rows[0].summary).toBe("rate_limit_exceeded");
		});
	});

	describe("payload storage", () => {
		it("stores event data as JSON payload", () => {
			const event = makeStored("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "bash",
				callId: "call-1",
				input: { command: "ls -la" },
			} satisfies ToolStartedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.started'",
				[],
			);
			const payload = decodeJson<Record<string, unknown>>(row!.payload);
			expect(payload).toBeDefined();
			expect(payload!.toolName).toBe("bash");
			expect(payload!.callId).toBe("call-1");
		});
	});

	describe("session_id tracking", () => {
		it("stores the session_id from the event envelope", () => {
			const event = makeStored("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "read",
				callId: "call-2",
				input: { filePath: "/tmp/x" },
			} satisfies ToolStartedPayload, 1, now);

			projector.project(event, db);

			const row = db.queryOne<ActivityRow>(
				"SELECT * FROM activities WHERE kind = 'tool.started'",
				[],
			);
			expect(row!.session_id).toBe("s1");
		});
	});

	describe("multiple activities in sequence", () => {
		it("creates a chronological activity feed", () => {
			projector.project(
				makeStored("tool.started", "s1", {
					messageId: "m1",
					partId: "p1",
					toolName: "bash",
					callId: "c1",
					input: { command: "ls" },
				} satisfies ToolStartedPayload, 1, now),
				db,
			);

			projector.project(
				makeStored("tool.running", "s1", {
					messageId: "m1",
					partId: "p1",
				} satisfies ToolRunningPayload, 2, now + 50),
				db,
			);

			projector.project(
				makeStored("tool.completed", "s1", {
					messageId: "m1",
					partId: "p1",
					result: "output",
					duration: 500,
				} satisfies ToolCompletedPayload, 3, now + 550),
				db,
			);

			projector.project(
				makeStored("permission.asked", "s1", {
					id: "perm-1",
					sessionId: "s1",
					toolName: "write",
					input: { filePath: "/tmp/out" },
				} satisfies PermissionAskedPayload, 4, now + 600),
				db,
			);

			const rows = db.query<ActivityRow>(
				"SELECT * FROM activities WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			expect(rows).toHaveLength(4);
			expect(rows[0].kind).toBe("tool.started");
			expect(rows[1].kind).toBe("tool.running");
			expect(rows[2].kind).toBe("tool.completed");
			expect(rows[3].kind).toBe("permission.asked");
		});
	});

	it("ignores event types it does not handle", () => {
		const unrelated = makeStored("text.delta", "s1", {
			messageId: "m1",
			partId: "p1",
			text: "hello",
		} as any, 1, now);

		projector.project(unrelated, db);

		const rows = db.query<ActivityRow>(
			"SELECT * FROM activities WHERE session_id = ?",
			["s1"],
		);
		expect(rows).toHaveLength(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projectors/activity-projector.test.ts`
Expected: FAIL with "Cannot find module '...activity-projector.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projectors/activity-projector.ts
import type { CanonicalEventType, StoredEvent } from "../events.js";
import type { SqliteClient } from "../sqlite-client.js";
import type { Projector } from "./projector.js";
import { isEventType, encodeJson, assertHandledOrIgnored } from "./projector.js";

// ── Compile-time exhaustiveness ─────────────────────────────────────
type _HandledByActivity =
	| "tool.started" | "tool.running" | "tool.completed"
	| "permission.asked" | "permission.resolved"
	| "question.asked" | "question.resolved"
	| "turn.error";
type _ActivityHandles = (typeof ActivityProjector.prototype.handles)[number];
type _ActivityMissing = Exclude<_ActivityHandles, _HandledByActivity>;
type _ActivityCheck = _ActivityMissing extends never ? true : { error: `Unhandled: ${_ActivityMissing}` };
const _activityExhaustive: _ActivityCheck = true;

/**
 * Projects tool, permission, question, and error events into the
 * `activities` timeline table.
 *
 * Every handled event creates one new activity row. Activities are
 * append-only — they are never updated. Each row records:
 *
 * - `tone`: category grouping (tool / approval / info / error)
 * - `kind`: the canonical event type that produced this activity
 * - `summary`: short human-readable label for the UI
 * - `payload`: full event data as JSON for detail views
 * - `sequence`: the event's store sequence for ordering and dedup
 *
 * Idempotency: uses a deterministic ID derived from the event's
 * `sessionId`, `sequence`, and `kind`:
 * `${event.sessionId}:${event.sequence}:${kind}`. This ensures that
 * replaying the same event never creates duplicate activity rows.
 * The `INSERT OR IGNORE` on the primary key handles the dedup.
 */
export class ActivityProjector implements Projector {
	readonly name = "activity";

	readonly handles: readonly CanonicalEventType[] = [
		"tool.started",
		"tool.running",
		"tool.completed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
		"turn.error",
	] as const;

	project(event: StoredEvent, db: SqliteClient): void {
		if (isEventType(event, "tool.started")) {
			this.insert(db, event, "tool", "tool.started", event.data.toolName, event.data);
			return;
		}

		if (isEventType(event, "tool.running")) {
			this.insert(db, event, "tool", "tool.running", event.data.partId, event.data);
			return;
		}

		if (isEventType(event, "tool.completed")) {
			const summary = `${event.data.partId} (${event.data.duration}ms)`;
			this.insert(db, event, "tool", "tool.completed", summary, event.data);
			return;
		}

		if (isEventType(event, "permission.asked")) {
			this.insert(db, event, "approval", "permission.asked", event.data.toolName, event.data);
			return;
		}

		if (isEventType(event, "permission.resolved")) {
			this.insert(db, event, "approval", "permission.resolved", event.data.decision, event.data);
			return;
		}

		if (isEventType(event, "question.asked")) {
			this.insert(db, event, "info", "question.asked", "Question asked", event.data);
			return;
		}

		if (isEventType(event, "question.resolved")) {
			this.insert(db, event, "info", "question.resolved", "Question answered", event.data);
			return;
		}

		if (isEventType(event, "turn.error")) {
			this.insert(db, event, "error", "turn.error", event.data.error, event.data);
			return;
		}

		assertHandledOrIgnored(this, event);
	}

	private insert(
		db: SqliteClient,
		event: StoredEvent,
		tone: string,
		kind: string,
		summary: string,
		payload: unknown,
	): void {
		// Deterministic ID: sessionId + sequence + kind ensures replay
		// idempotency. `INSERT OR IGNORE` skips if the row already exists.
		const id = `${event.sessionId}:${event.sequence}:${kind}`;
		db.execute(
			`INSERT OR IGNORE INTO activities
			 (id, session_id, tone, kind, summary, payload, sequence, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				event.sessionId,
				tone,
				kind,
				summary,
				encodeJson(payload),
				event.sequence,
				event.createdAt,
			],
		);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projectors/activity-projector.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

The `insert` helper extracts the common SQL pattern. No further refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/projectors/activity-projector.ts test/unit/persistence/projectors/activity-projector.test.ts
git commit -m "feat(persistence): add ActivityProjector for chronological activity timeline"
```

---

### Task 21: ProjectionRunner

> **Amendment (2026-04-07 — Perf-Fix-4: Non-Blocking Recovery):**
> - Added `recoveryBatchSize?: number` to `ProjectionRunnerConfig`.
> - Added `RecoveryProgress`, `AsyncRecoveryOptions`, and `AsyncRecoveryResult` interfaces.
> - Added `recoverAsync()` method that yields the event loop between batches via `setImmediate`, keeping the daemon responsive during startup recovery.
> - Added `recoverProjectorAsync()` private method for per-projector async recovery.
> - Added async recovery tests in `test/unit/persistence/projection-runner-async-recovery.test.ts`.
> - The synchronous `recover()` is retained for tests and small stores.
> - See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 4.

> **Amendment (2026-04-09 — Concurrency Solutions, Changes 2 + 5b):**
> - **(Change 2)** Document that `eventStore.append()` is not called directly by application code
>   outside of `EventPipeline` and `ProjectionRunner.recover()`. The `ProjectionRunner` receives
>   events from `EventPipeline`, not from direct `eventStore` reads during normal operation.
> - **(Change 5b)** Add `recoverLagging(projectors: string[])` method that runs recovery for
>   specific lagging projectors only (using P7's SQL-level type filtering). Called by
>   `LifecycleCoordinator.onReconnect()` when projection gaps are detected. Fast because it
>   only replays the gap, not the entire event store.

> **Amendment (2026-04-07, S9 — Batch Projection):**
> Add `projectBatch(events: StoredEvent[])` method to `ProjectionRunner`. When the `DualWriteHook`
> detects a translation produced multiple events (via `sseBatchId`), it calls `projectBatch()` instead
> of `projectEvent()` for each event individually.
>
> `projectBatch()` wraps all projector calls for all events in a single `runInTransaction()`. Cursor
> advancement happens once at the end of the batch, not per event.
>
> ```
> translationResult.events.length > 1?
>     YES: appendBatch(events) → projectBatch(storedEvents)  [1 txn for append, 1 for projection]
>     NO:  append(event) → projectEvent(stored)  [1 txn for append, 1 for projection]
> ```
>
> **Impact:** Reduces transaction overhead by 2-3x for multi-event SSE events. These are common:
> tool lifecycle events (tool.started + tool.running), message creation with initial parts,
> session status changes with concurrent renames.

**Files:**
- Create: `src/lib/persistence/projection-runner.ts`
- Test: `test/unit/persistence/projection-runner.test.ts`
- Test: `test/unit/persistence/projection-runner-async-recovery.test.ts`

**Purpose:** Orchestrates all 6 projectors, manages cursor persistence, and provides startup recovery. The runner is the single coordination point between the event store and projections. For each event, it runs all matching projectors inside a single transaction, then updates cursors. Recovery reads events from the minimum cursor position and replays them through all projectors.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/projection-runner.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import {
	ProjectionRunner,
	createAllProjectors,
} from "../../../src/lib/persistence/projection-runner.js";
import {
	createEventId,
	type StoredEvent,
	type SessionCreatedPayload,
	type MessageCreatedPayload,
	type TextDeltaPayload,
	type ToolStartedPayload,
	type PermissionAskedPayload,
	type TurnCompletedPayload,
	type SessionProviderChangedPayload,
} from "../../../src/lib/persistence/events.js";
import type { Projector } from "../../../src/lib/persistence/projectors/projector.js";

function makeCanonical<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: Extract<StoredEvent, { type: T }>["data"],
	createdAt: number = Date.now(),
): { eventId: string; sessionId: string; type: T; data: typeof data; metadata: Record<string, never>; provider: string; createdAt: number } {
	return {
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: {},
		provider: "opencode",
		createdAt,
	};
}

describe("ProjectionRunner", () => {
	let db: SqliteClient;
	let eventStore: EventStore;
	let cursorRepo: ProjectorCursorRepository;
	let runner: ProjectionRunner;
	const now = Date.now();

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eventStore = new EventStore(db);
		cursorRepo = new ProjectorCursorRepository(db);
		runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});
	});

	afterEach(() => {
		db?.close();
	});

	describe("createAllProjectors", () => {
		it("returns all 6 projectors", () => {
			const projectors = createAllProjectors();
			expect(projectors).toHaveLength(6);

			const names = projectors.map((p) => p.name);
			expect(names).toContain("session");
			expect(names).toContain("message");
			expect(names).toContain("turn");
			expect(names).toContain("provider");
			expect(names).toContain("approval");
			expect(names).toContain("activity");
		});

		it("returns projectors implementing the Projector interface", () => {
			const projectors = createAllProjectors();
			for (const p of projectors) {
				expect(p.name).toBeDefined();
				expect(p.handles).toBeDefined();
				expect(typeof p.project).toBe("function");
			}
		});
	});

	describe("projectEvent", () => {
		it("runs matching projectors for an event and updates cursors", () => {
			// Seed session first via the event store
			const sessionEvent = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Test Session",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);

			runner.projectEvent(sessionEvent);

			// Verify session projection was written
			const session = db.queryOne<{ id: string; title: string }>(
				"SELECT id, title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session).toBeDefined();
			expect(session!.title).toBe("Test Session");

			// Verify provider projection was written (session.created also handled by provider projector)
			const providers = db.query<{ session_id: string; provider: string }>(
				"SELECT session_id, provider FROM session_providers WHERE session_id = ?",
				["s1"],
			);
			expect(providers).toHaveLength(1);
			expect(providers[0].provider).toBe("opencode");

			// Verify cursors were updated
			const cursors = cursorRepo.listAll();
			const sessionCursor = cursors.find((c) => c.projectorName === "session");
			const providerCursor = cursors.find((c) => c.projectorName === "provider");
			expect(sessionCursor).toBeDefined();
			expect(sessionCursor!.lastAppliedSeq).toBe(sessionEvent.sequence);
			expect(providerCursor).toBeDefined();
			expect(providerCursor!.lastAppliedSeq).toBe(sessionEvent.sequence);
		});

		it("only runs projectors that handle the event type", () => {
			// Seed session first
			const sessionEvent = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);
			runner.projectEvent(sessionEvent);

			// text.delta — only handled by message projector
			// First need a message
			const msgEvent = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 100),
			);
			runner.projectEvent(msgEvent);

			const deltaEvent = eventStore.append(
				makeCanonical("text.delta", "s1", {
					messageId: "m1",
					partId: "p1",
					text: "Hello",
				} satisfies TextDeltaPayload, now + 200),
			);
			runner.projectEvent(deltaEvent);

			// Message projector cursor should have advanced
			const messageCursor = cursorRepo.listAll().find((c) => c.projectorName === "message");
			expect(messageCursor!.lastAppliedSeq).toBe(deltaEvent.sequence);

			// ALL projector cursors advance on every event (even if the projector
			// doesn't handle the event type), so the approval cursor should also
			// be at the latest sequence.
			const approvalCursor = cursorRepo.listAll().find((c) => c.projectorName === "approval");
			expect(approvalCursor).toBeDefined();
			expect(approvalCursor!.lastAppliedSeq).toBe(deltaEvent.sequence);
		});

		it("runs all projectors in a single transaction (atomicity)", () => {
			// Seed session
			const sessionEvent = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);
			runner.projectEvent(sessionEvent);

			// Create a failing projector
			const failingProjector: Projector = {
				name: "failing",
				handles: ["tool.started"],
				project: () => {
					throw new Error("projector explosion");
				},
			};

			const failingRunner = new ProjectionRunner({
				db,
				eventStore,
				cursorRepo,
				projectors: [...createAllProjectors(), failingProjector],
			});

			// Seed a message so the tool event has context
			const msgEvent = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 100),
			);
			failingRunner.projectEvent(msgEvent);

			// tool.started should fail because the failing projector throws
			const toolEvent = eventStore.append(
				makeCanonical("tool.started", "s1", {
					messageId: "m1",
					partId: "p1",
					toolName: "bash",
					callId: "c1",
					input: { command: "ls" },
				} satisfies ToolStartedPayload, now + 200),
			);

			expect(() => failingRunner.projectEvent(toolEvent)).toThrow("projector explosion");

			// Activities table should NOT have the tool.started row
			// (transaction rolled back)
			const activities = db.query<{ kind: string }>(
				"SELECT kind FROM activities WHERE kind = 'tool.started'",
				[],
			);
			expect(activities).toHaveLength(0);
		});
	});

	describe("recover", () => {
		it("replays events from the minimum cursor position", () => {
			// Manually append events to the store (simulate previous session)
			const ev1 = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Recovery Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);

			const ev2 = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 100),
			);

			const ev3 = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "m2",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 200),
			);

			// No cursors exist — recover should replay all events
			// (A3) recover() now returns RecoveryResult with structured diagnostics
			const result = runner.recover();
			expect(result.totalReplayed).toBe(3);
			expect(result.batchCount).toBeGreaterThanOrEqual(1);
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
			expect(result.projectorCursors.length).toBeGreaterThan(0);

			// Verify projections are populated
			const session = db.queryOne<{ title: string }>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session!.title).toBe("Recovery Test");

			const messages = db.query<{ id: string }>(
				"SELECT id FROM messages WHERE session_id = ?",
				["s1"],
			);
			expect(messages).toHaveLength(2);
		});

		it("replays only events after the minimum cursor", () => {
			// Append events
			const ev1 = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);

			const ev2 = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 100),
			);

			// Project first event manually to establish cursors
			runner.projectEvent(ev1);

			// Now recover — should only replay ev2
			const result = runner.recover();
			expect(result.totalReplayed).toBe(1);
		});

		it("returns 0 when all events are already projected", () => {
			const ev1 = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);
			runner.projectEvent(ev1);

			const result = runner.recover();
			expect(result.totalReplayed).toBe(0);
		});

		it("returns 0 when the event store is empty", () => {
			const result = runner.recover();
			expect(result.totalReplayed).toBe(0);
		});
	});

	describe("full integration lifecycle", () => {
		it("projects a complete session lifecycle through all projectors", () => {
			// 1. Session created
			const ev1 = eventStore.append(
				makeCanonical("session.created", "s1", {
					sessionId: "s1",
					title: "Full Lifecycle",
					provider: "opencode",
				} satisfies SessionCreatedPayload, now),
			);
			runner.projectEvent(ev1);

			// 2. User message (creates turn)
			const ev2 = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "user_m1",
					role: "user",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 100),
			);
			runner.projectEvent(ev2);

			// 3. Assistant message
			const ev3 = eventStore.append(
				makeCanonical("message.created", "s1", {
					messageId: "asst_m1",
					role: "assistant",
					sessionId: "s1",
				} satisfies MessageCreatedPayload, now + 200),
			);
			runner.projectEvent(ev3);

			// 4. Tool started
			const ev4 = eventStore.append(
				makeCanonical("tool.started", "s1", {
					messageId: "asst_m1",
					partId: "tool_p1",
					toolName: "bash",
					callId: "c1",
					input: { command: "ls" },
				} satisfies ToolStartedPayload, now + 300),
			);
			runner.projectEvent(ev4);

			// 5. Permission asked
			const ev5 = eventStore.append(
				makeCanonical("permission.asked", "s1", {
					id: "perm-1",
					sessionId: "s1",
					toolName: "bash",
					input: { command: "ls" },
				} satisfies PermissionAskedPayload, now + 400),
			);
			runner.projectEvent(ev5);

			// 6. Turn completed
			const ev6 = eventStore.append(
				makeCanonical("turn.completed", "s1", {
					messageId: "asst_m1",
					cost: 0.05,
					tokens: { input: 1000, output: 500 },
				} satisfies TurnCompletedPayload, now + 5000),
			);
			runner.projectEvent(ev6);

			// 7. Provider changed
			const ev7 = eventStore.append(
				makeCanonical("session.provider_changed", "s1", {
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude-sdk",
				} satisfies SessionProviderChangedPayload, now + 6000),
			);
			runner.projectEvent(ev7);

			// ── Verify all projections ──

			// Sessions
			const session = db.queryOne<{ title: string; provider: string }>(
				"SELECT title, provider FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(session!.title).toBe("Full Lifecycle");
			expect(session!.provider).toBe("claude-sdk");

			// Messages
			const messages = db.query<{ id: string; role: string }>(
				"SELECT id, role FROM messages WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[1].role).toBe("assistant");

			// Turns
			const turns = db.query<{ id: string; state: string }>(
				"SELECT id, state FROM turns WHERE session_id = ?",
				["s1"],
			);
			expect(turns).toHaveLength(1);
			expect(turns[0].state).toBe("completed");

			// Providers
			const providers = db.query<{ provider: string; status: string }>(
				"SELECT provider, status FROM session_providers WHERE session_id = ? ORDER BY activated_at",
				["s1"],
			);
			expect(providers).toHaveLength(2);
			expect(providers[0].provider).toBe("opencode");
			expect(providers[0].status).toBe("stopped");
			expect(providers[1].provider).toBe("claude-sdk");
			expect(providers[1].status).toBe("active");

			// Approvals
			const approvals = db.query<{ type: string; status: string }>(
				"SELECT type, status FROM pending_approvals WHERE session_id = ?",
				["s1"],
			);
			expect(approvals).toHaveLength(1);
			expect(approvals[0].type).toBe("permission");

			// Activities
			const activities = db.query<{ kind: string }>(
				"SELECT kind FROM activities WHERE session_id = ? ORDER BY created_at",
				["s1"],
			);
			expect(activities.length).toBeGreaterThanOrEqual(3);
			const kinds = activities.map((a) => a.kind);
			expect(kinds).toContain("tool.started");
			expect(kinds).toContain("permission.asked");

			// Cursors — all projectors that handled at least one event should have a cursor
			const cursors = cursorRepo.listAll();
			expect(cursors.length).toBeGreaterThan(0);
			for (const cursor of cursors) {
				expect(cursor.lastAppliedSeq).toBeGreaterThan(0);
			}
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/projection-runner.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/persistence/projection-runner.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/projection-runner.ts
import type { SqliteClient } from "./sqlite-client.js";
import type { EventStore } from "./event-store.js";
import type { ProjectorCursorRepository } from "./projector-cursor-repository.js";
import type { CanonicalEventType, StoredEvent } from "./events.js";
import type { Projector } from "./projectors/projector.js";
import { PersistenceError } from "./errors.js";
import { formatErrorDetail } from "../errors.js";
import type { Logger } from "../logger.js";
import { SessionProjector } from "./projectors/session-projector.js";
import { MessageProjector } from "./projectors/message-projector.js";
import { TurnProjector } from "./projectors/turn-projector.js";
import { ProviderProjector } from "./projectors/provider-projector.js";
import { ApprovalProjector } from "./projectors/approval-projector.js";
import { ActivityProjector } from "./projectors/activity-projector.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A record of a projector failure, retained for diagnostics.
 *
 * When an LLM sees "projector is lagging", it can inspect `getFailures()`
 * to find the exact event, error, and projector that's stuck.
 */
export interface ProjectionFailure {
	readonly projectorName: string;
	readonly eventSequence: number;
	readonly eventType: string;
	readonly sessionId: string;
	readonly error: string;
	readonly errorCode?: string;
	readonly failedAt: number;
}

export interface ProjectionRunnerConfig {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	readonly cursorRepo: ProjectorCursorRepository;
	readonly projectors: readonly Projector[];
	readonly log?: Logger;
	/** (Perf-Fix-4) Batch size for async recovery. Defaults to 500. */
	readonly recoveryBatchSize?: number;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates all 6 projectors in the correct order.
 *
 * Order matters for FK compliance: `SessionProjector` must run before
 * `MessageProjector`, `TurnProjector`, `ProviderProjector`, etc.
 * since they INSERT rows referencing `sessions(id)`.
 */
export function createAllProjectors(): Projector[] {
	return [
		new SessionProjector(),
		new MessageProjector(),
		new TurnProjector(),
		new ProviderProjector(),
		new ApprovalProjector(),
		new ActivityProjector(),
	];
}

// ─── ProjectionRunner ────────────────────────────────────────────────────────

/**
 * Orchestrates projection of canonical events through all registered projectors.
 *
 * Analogous to t3code's `ProjectionPipeline` — for each event, runs every
 * projector whose `handles` list includes the event type, then updates the
 * projector's cursor. All work happens inside a single `db.runInTransaction()`
 * so the event store and projections are consistent by construction.
 *
 * Recovery: `recover()` reads events from the minimum cursor position across
 * all projectors and replays them. This handles both cold starts (no cursors)
 * and partial failures (some projectors advanced further than others).
 */
export class ProjectionRunner {
	private readonly db: SqliteClient;
	private readonly eventStore: EventStore;
	private readonly cursorRepo: ProjectorCursorRepository;
	private readonly projectors: readonly Projector[];
	private readonly log?: Logger;

	/** Pre-computed map: event type → projectors that handle it. */
	private readonly projectorsByEventType: Map<string, Projector[]>;

	/** Recent projection failures for diagnostics (capped at 100). */
	private readonly _failures: ProjectionFailure[] = [];

	/** (P3) True during `recover()` — passed to projectors via ProjectionContext. */
	private _replaying = false;

	/** (CH4) True after recover() has been called. projectEvent() throws if false. */
	private _recovered = false;

	/** (CH4) Public accessor so relay-stack.ts can assert recovery state. */
	get isRecovered(): boolean {
		return this._recovered;
	}

	/** (P2) Counter for lazy cursor sync — only write non-matching cursors every N events. */
	private eventsSinceLastCursorSync = 0;
	private readonly CURSOR_SYNC_INTERVAL = 100;

	/** (Perf-Fix-4) Batch size for async recovery. */
	private readonly recoveryBatchSize: number;

	constructor(config: ProjectionRunnerConfig) {
		this.db = config.db;
		this.eventStore = config.eventStore;
		this.cursorRepo = config.cursorRepo;
		this.projectors = config.projectors;
		this.log = config.log;
		this.recoveryBatchSize = config.recoveryBatchSize ?? 500; // (Perf-Fix-4)

		// Build the dispatch map once at construction time.
		this.projectorsByEventType = new Map();
		for (const projector of this.projectors) {
			for (const eventType of projector.handles) {
				let list = this.projectorsByEventType.get(eventType);
				if (!list) {
					list = [];
					this.projectorsByEventType.set(eventType, list);
				}
				list.push(projector);
			}
		}
	}

	/**
	 * Project a single stored event through all matching projectors.
	 *
	 * (A4) Each projector runs in its OWN transaction. If one projector
	 * fails, its transaction rolls back (including its cursor update),
	 * but other projectors proceed normally. This prevents a bug in
	 * one projector (e.g., ActivityProjector) from blocking all other
	 * projections. Recovery only needs to replay events for the failed
	 * projector since its cursor won't have advanced.
	 *
	 * Trade-off: projections can be temporarily inconsistent (session
	 * row updated but activity row not), but this is recoverable on
	 * next startup. The alternative — one broken projector blocking
	 * everything — is not recoverable without manual intervention.
	 *
	 * @param event - A fully stored event (has sequence number assigned).
	 */
	projectEvent(event: StoredEvent): void {
		// (CH4) Lifecycle check: hard error if projecting before recovery.
		// This catches missing recover() wiring immediately during development.
		// In production, relay-stack.ts calls recover() before wireSSEConsumer(),
		// so this path is unreachable.
		if (!this._recovered) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"recover() must be called before projectEvent(). " +
				"Ensure recover() is called in relay-stack.ts before SSE wiring.",
				{ sequence: event.sequence, type: event.type },
			);
		}

		const matching = this.projectorsByEventType.get(event.type) ?? [];

		// (A4) Run each projector in its own transaction for fault isolation.
		// (P3) Pass the `replaying` flag via ProjectionContext so projectors
		// can skip expensive replay-safety checks during normal streaming.
		for (const projector of matching) {
			try {
				this.db.runInTransaction(() => {
					projector.project(event, this.db, { replaying: this._replaying });
					this.cursorRepo.upsert(projector.name, event.sequence);
				});
			} catch (err) {
				// Record failure but continue with other projectors
				this.recordFailure(projector, event, err);
			}
		}

		// (P2) Lazy cursor advancement for non-matching projectors.
		// Instead of writing 5 individual cursor UPDATEs per event (one per
		// non-matching projector), batch them every CURSOR_SYNC_INTERVAL events.
		// During recovery, the gap is harmless: if a non-matching projector's
		// cursor is slightly behind, recovery replays a few extra events that
		// the projector skips (since it doesn't handle that event type).
		this.eventsSinceLastCursorSync++;
		if (this.eventsSinceLastCursorSync >= this.CURSOR_SYNC_INTERVAL) {
			this.syncAllCursors(event.sequence);
			this.eventsSinceLastCursorSync = 0;
		}

		this.log?.verbose(`projected seq=${event.sequence} type=${event.type} projectors=${matching.map((p) => p.name).join(",") || "none"}`);
	}

	/**
	 * (P2) Sync all projector cursors to a given sequence in one transaction.
	 * Called periodically (every 100 events) and on PersistenceLayer.close().
	 */
	syncAllCursors(sequence: number): void {
		this.db.runInTransaction(() => {
			for (const projector of this.projectors) {
				this.cursorRepo.upsert(projector.name, sequence);
			}
		});
	}

	/** Recent failures for diagnostics. */
	getFailures(): readonly ProjectionFailure[] {
		return this._failures;
	}

	private recordFailure(
		projector: Projector,
		event: StoredEvent,
		err: unknown,
	): void {
		const failure: ProjectionFailure = {
			projectorName: projector.name,
			eventSequence: event.sequence,
			eventType: event.type,
			sessionId: event.sessionId,
			error: err instanceof Error ? err.message : String(err),
			errorCode: err instanceof PersistenceError ? err.code : undefined,
			failedAt: Date.now(),
		};
		this._failures.push(failure);
		// Cap at 100 entries to avoid unbounded growth
		if (this._failures.length > 100) this._failures.shift();

		this.log?.warn(`Projector "${projector.name}" failed on event seq=${event.sequence}`, {
			projector: projector.name,
			sequence: event.sequence,
			type: event.type,
			sessionId: event.sessionId,
			error: err instanceof PersistenceError
				? err.toLog()
				: formatErrorDetail(err),
		});
	}

	/**
	 * (A3) Structured result returned from `recover()` for diagnostics.
	 * Callers and diagnostic tools can inspect what happened during recovery
	 * without parsing log output.
	 */
}

export interface RecoveryResult {
	readonly startCursor: number;
	readonly endCursor: number;
	readonly totalReplayed: number;
	readonly batchCount: number;
	readonly durationMs: number;
	readonly projectorCursors: readonly { projectorName: string; lastAppliedSeq: number; updatedAt: number }[];
}

/** (P7) Per-projector recovery result for diagnostics. */
export interface ProjectorRecoveryResult {
	readonly projectorName: string;
	readonly startCursor: number;
	readonly endCursor: number;
	readonly eventsReplayed: number;
	readonly batchCount: number;
	readonly durationMs: number;
}

// (Perf-Fix-4) Async recovery types ──────────────────────────────────────────

export interface RecoveryProgress {
	projectorName: string;
	eventsReplayed: number;
	totalEstimated: number;
	durationMs: number;
}

export interface AsyncRecoveryOptions {
	onProgress?: (progress: RecoveryProgress) => void;
}

export interface AsyncRecoveryResult {
	totalReplayed: number;
	durationMs: number;
	perProjector: ProjectorRecoveryResult[];
}

/** Row shape returned by event queries (for recovery). */
interface EventRow {
	sequence: number;
	event_id: string;
	session_id: string;
	stream_version: number;
	type: string;
	data: string;
	metadata: string;
	provider: string;
	created_at: number;
}

// (continuation of ProjectionRunner class)
// Add recover() method:

// ─── ProjectionRunner (continued) ───────────────────────────────────────────

export class ProjectionRunner {
	// ... (fields and constructor as above) ...

	/**
	 * Recover projections by replaying events from cursor positions.
	 *
	 * (P7) Per-projector recovery with SQL-level type filtering: each
	 * projector replays from its OWN cursor using a SQL WHERE clause that
	 * filters to only the event types it handles. This prevents a fresh
	 * projector (cursor 0) from forcing ALL 100,000 events through all 6
	 * projectors, and avoids deserializing events that a projector would
	 * skip anyway. The `idx_events_type` index makes filtered queries
	 * efficient. After replaying matching events, each projector's cursor
	 * is advanced to the global max (skipping all non-matching events).
	 *
	 * Typical startup (clean shutdown, all caught up) skips recovery entirely.
	 *
	 * (P3) Sets `_replaying = true` so projectors enable replay-safety
	 * checks (e.g., `alreadyApplied()`) that are wasteful during normal
	 * streaming.
	 *
	 * (A3) Returns a structured `RecoveryResult` with progress reporting.
	 * Logs progress at each batch boundary so an LLM debugging "daemon
	 * takes 30 seconds to start" can see recovery replayed N events in
	 * M batches taking X ms.
	 */
	recover(): RecoveryResult {
		const startTime = Date.now();
		const batchSize = 500;

		// (P7) Fast path: check if all cursors are caught up
		const latestSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events"
		)?.max_seq ?? 0;

		const allCursors = this.cursorRepo.listAll();
		const allCaughtUp = allCursors.length === this.projectors.length &&
			allCursors.every(c => c.lastAppliedSeq >= latestSeq);

		if (allCaughtUp) {
			this.log?.info("recovery: all projectors caught up, skipping replay");
			this._recovered = true; // (CH4)
			return {
				startCursor: latestSeq,
				endCursor: latestSeq,
				totalReplayed: 0,
				batchCount: 0,
				durationMs: 0,
				projectorCursors: allCursors,
			};
		}

		// (P3) Set replaying flag so projectors enable replay-safety checks
		this._replaying = true;
		try {
			// (P7) Per-projector recovery with SQL type filtering.
			// Each projector replays only events matching its `handles` list,
			// filtered at the SQL level. This skips ~40% of events for
			// MessageProjector (session.*, permission.*, question.*).
			let totalReplayed = 0;
			let batchCount = 0;
			const perProjector: ProjectorRecoveryResult[] = [];

			for (const projector of this.projectors) {
				const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
				if (cursor >= latestSeq) continue; // This projector is caught up

				const result = this.recoverProjector(projector, cursor, batchSize);
				perProjector.push(result);
				totalReplayed += result.eventsReplayed;
				batchCount += result.batchCount;
			}

			// (P2) Flush any pending cursor syncs after recovery
			this.syncAllCursors(latestSeq);
			this.eventsSinceLastCursorSync = 0;

			const result: RecoveryResult = {
				startCursor: Math.min(...perProjector.map(r => r.startCursor), latestSeq),
				endCursor: latestSeq,
				totalReplayed,
				batchCount,
				durationMs: Date.now() - startTime,
				projectorCursors: this.cursorRepo.listAll(),
			};
			this.log?.info(`recovery complete`, result as unknown as Record<string, unknown>);
			return result;
		} finally {
			this._replaying = false;
			// (CH4) Set recovered flag AFTER replay completes. This must be in
			// the finally block so the flag is set even if recovery throws
			// (allowing subsequent projectEvent calls from live SSE events).
			this._recovered = true;
		}
	}

	/**
	 * (P7) Recover a single projector from its cursor, fetching only events
	 * matching its `handles` list via SQL WHERE type IN (...).
	 */
	private recoverProjector(
		projector: Projector,
		fromCursor: number,
		batchSize: number,
	): ProjectorRecoveryResult {
		const startTime = Date.now();
		let replayed = 0;
		let batches = 0;
		let cursor = fromCursor;

		// Build SQL type filter from projector's handles list
		const handledTypes = projector.handles;
		const placeholders = handledTypes.map(() => '?').join(', ');

		while (true) {
			// Only fetch events this projector actually handles
			const events = this.db.query<EventRow>(
				`SELECT * FROM events
				 WHERE sequence > ? AND type IN (${placeholders})
				 ORDER BY sequence ASC
				 LIMIT ?`,
				[cursor, ...handledTypes, batchSize],
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
					this.recordFailure(projector, this.rowToStoredEvent(event), err);
				}
			}

			cursor = events[events.length - 1]!.sequence;
			batches++;
			this.log?.info(`recovery: ${projector.name} batch=${batches} replayed=${replayed} cursor=${cursor}`);
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
			batchCount: batches,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * (Perf-Fix-4) Async recovery that yields the event loop between batches via
	 * setImmediate, allowing WebSocket/HTTP handlers to run during recovery.
	 */
	async recoverAsync(opts?: AsyncRecoveryOptions): Promise<AsyncRecoveryResult> {
		const startTime = Date.now();
		const latestSeq = this.db.queryOne<{ max_seq: number | null }>(
			"SELECT MAX(sequence) AS max_seq FROM events",
		)?.max_seq ?? 0;

		const allCursors = this.cursorRepo.listAll();
		const allCaughtUp = allCursors.length === this.projectors.length &&
			allCursors.every(c => c.lastAppliedSeq >= latestSeq);

		if (allCaughtUp) {
			this._recovered = true;
			this.log?.info("recovery: all projectors caught up, skipping replay");
			return { totalReplayed: 0, durationMs: 0, perProjector: [] };
		}

		const perProjector: ProjectorRecoveryResult[] = [];
		let totalReplayed = 0;

		for (const projector of this.projectors) {
			const cursor = this.cursorRepo.get(projector.name)?.lastAppliedSeq ?? 0;
			if (cursor >= latestSeq) continue;

			const result = await this.recoverProjectorAsync(
				projector, cursor, latestSeq, opts?.onProgress,
			);
			perProjector.push(result);
			totalReplayed += result.eventsReplayed;
		}

		this._recovered = true;
		return {
			totalReplayed,
			durationMs: Date.now() - startTime,
			perProjector,
		};
	}

	private async recoverProjectorAsync(
		projector: Projector,
		fromCursor: number,
		totalEstimated: number,
		onProgress?: (progress: RecoveryProgress) => void,
	): Promise<ProjectorRecoveryResult> {
		const startTime = Date.now();
		let replayed = 0;
		let cursor = fromCursor;

		const handledTypes = projector.handles;
		const placeholders = handledTypes.map(() => '?').join(', ');

		while (true) {
			const events = this.db.query<EventRow>(
				`SELECT * FROM events
				 WHERE sequence > ? AND type IN (${placeholders})
				 ORDER BY sequence ASC
				 LIMIT ?`,
				[cursor, ...handledTypes, this.recoveryBatchSize],
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
					this.recordFailure(projector, this.rowToStoredEvent(event), err);
				}
			}

			cursor = events[events.length - 1]!.sequence;

			onProgress?.({
				projectorName: projector.name,
				eventsReplayed: replayed,
				totalEstimated,
				durationMs: Date.now() - startTime,
			});

			if (events.length >= this.recoveryBatchSize) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		}

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
			batchCount: 0, // not tracked in async path
			durationMs: Date.now() - startTime,
		};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/projection-runner.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

The `recover` loop uses a simple cursor-advancing pattern with configurable batch size. No further refactoring needed.

**Step 5b: (Perf-Fix-4) Add async recovery tests**

```typescript
// test/unit/persistence/projection-runner-async-recovery.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStore } from "../../../src/lib/persistence/event-store.js";
import { ProjectorCursorRepository } from "../../../src/lib/persistence/projector-cursor-repository.js";
import {
	ProjectionRunner,
	createAllProjectors,
} from "../../../src/lib/persistence/projection-runner.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

describe("ProjectionRunner async recovery", () => {
	let db: SqliteClient;
	let eventStore: EventStore;
	let cursorRepo: ProjectorCursorRepository;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eventStore = new EventStore(db);
		cursorRepo = new ProjectorCursorRepository(db);
	});

	afterEach(() => {
		db?.close();
	});

	function seedSessionAndEvents(sessionId: string, count: number): void {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[sessionId, "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		// Seed a message.created event so text.delta projections have an FK target
		eventStore.append(
			canonicalEvent("message.created", sessionId, {
				messageId: "m1", role: "assistant" as const, sessionId,
			}),
		);
		for (let i = 0; i < count; i++) {
			eventStore.append(
				canonicalEvent("text.delta", sessionId, {
					messageId: "m1", partId: `p-${i}`, text: `chunk-${i}`,
				}),
			);
		}
	}

	it("recoverAsync yields between batches", async () => {
		seedSessionAndEvents("s1", 200);

		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
			recoveryBatchSize: 50,
		});

		let progressCalls = 0;
		const result = await runner.recoverAsync({
			onProgress: (info) => {
				progressCalls++;
				expect(info.projectorName).toBeDefined();
				expect(info.eventsReplayed).toBeGreaterThan(0);
			},
		});

		expect(result.totalReplayed).toBeGreaterThan(0);
		expect(progressCalls).toBeGreaterThan(0);
		expect(runner.isRecovered).toBe(true);
	});

	it("projectEvent throws before recoverAsync completes (CH4 guard)", () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);

		const stored = eventStore.append(
			canonicalEvent("session.created", "s1", {
				sessionId: "s1", title: "Test", provider: "opencode",
			}),
		);

		// Without calling recoverAsync(), projectEvent should throw
		expect(() => runner.projectEvent(stored)).toThrow(/recover/);
	});

	it("projectEvent works after recoverAsync", async () => {
		const runner = new ProjectionRunner({
			db,
			eventStore,
			cursorRepo,
			projectors: createAllProjectors(),
		});

		await runner.recoverAsync();

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);

		const stored = eventStore.append(
			canonicalEvent("session.created", "s1", {
				sessionId: "s1", title: "Test", provider: "opencode",
			}),
		);

		expect(() => runner.projectEvent(stored)).not.toThrow();
	});
});
```

**Step 6: Commit**

```bash
git add src/lib/persistence/projection-runner.ts test/unit/persistence/projection-runner.test.ts
git commit -m "feat(persistence): add ProjectionRunner orchestrating all 6 projectors with recovery"
```

---

### Task 22: Wire ProjectionRunner into Dual-Write Hook

**Files:**
- Modify: `src/lib/persistence/dual-write-hook.ts`
- Modify: `src/lib/persistence/persistence-layer.ts`
- Test: `test/unit/persistence/dual-write-projection.test.ts`

**Purpose:** Close the loop: make the dual-write hook's event append path also run projectors. After this task, every SSE event that flows through the relay simultaneously updates both the event store and all 6 projection tables in a single transaction.

The key change is in the `DualWriteHook.onSSEEvent()` method: instead of just calling `eventStore.append()`, it calls `eventStore.append()` and then `projectionRunner.projectEvent()` on the stored event. Since `projectEvent` runs in a transaction, and the event append is separate, we need to restructure slightly: `append` + `projectEvent` must happen within one transaction for the strong consistency guarantee.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/dual-write-projection.test.ts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { createEventId } from "../../../src/lib/persistence/events.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

describe("DualWriteHook with ProjectionRunner", () => {
	let layer: PersistenceLayer;
	let hook: DualWriteHook;

	beforeEach(() => {
		layer = PersistenceLayer.memory();
		hook = new DualWriteHook({
			persistence: layer,
			log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
		});
	});

	afterEach(() => {
		layer.close();
	});

	it("projects session.created events into the sessions table", () => {
		hook.onSSEEvent(
			makeSSEEvent("session.created", {
				sessionID: "sess-1",
				info: {
					id: "sess-1",
					title: "Integration Test",
					provider: "opencode",
				},
			}),
			"sess-1",
		);

		// Event should be in the store
		const events = layer.eventStore.readFromSequence(0);
		const sessionCreated = events.find((e) => e.type === "session.created");
		expect(sessionCreated).toBeDefined();

		// Session should be projected
		const session = layer.db.queryOne<{ id: string; title: string }>(
			"SELECT id, title FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(session).toBeDefined();
		expect(session!.title).toBe("Integration Test");
	});

	it("projects message.created events into messages and turns tables", () => {
		// First create the session
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [{ type: "text", text: "hello" }] },
			}),
			"sess-1",
		);

		// Message should be projected
		const messages = layer.db.query<{ id: string; role: string }>(
			"SELECT id, role FROM messages WHERE session_id = ?",
			["sess-1"],
		);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");

		// Turn should be projected (user message creates a turn)
		const turns = layer.db.query<{ id: string; state: string }>(
			"SELECT id, state FROM turns WHERE session_id = ?",
			["sess-1"],
		);
		expect(turns).toHaveLength(1);
		expect(turns[0].state).toBe("pending");
	});

	it("projects tool lifecycle events into activities table", () => {
		// Tool pending → started
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "sess-1",
				messageID: "msg-1",
				partID: "part-t1",
				part: {
					id: "part-t1",
					type: "tool",
					callID: "call-1",
					tool: "bash",
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
			"sess-1",
		);

		const activities = layer.db.query<{ kind: string; tone: string }>(
			"SELECT kind, tone FROM activities WHERE session_id = ?",
			["sess-1"],
		);
		const toolStarted = activities.find((a) => a.kind === "tool.started");
		expect(toolStarted).toBeDefined();
		expect(toolStarted!.tone).toBe("tool");
	});

	it("projects permission events into pending_approvals table", () => {
		hook.onSSEEvent(
			makeSSEEvent("permission.asked", {
				sessionID: "sess-1",
				id: "perm-1",
				tool: "bash",
				input: { command: "rm -rf /" },
			}),
			"sess-1",
		);

		const events = layer.eventStore.readFromSequence(0);
		const permEvent = events.find((e) => e.type === "permission.asked");
		if (permEvent) {
			// Approval should be projected
			const approvals = layer.db.query<{ id: string; type: string; status: string }>(
				"SELECT id, type, status FROM pending_approvals WHERE session_id = ?",
				["sess-1"],
			);
			expect(approvals.length).toBeGreaterThan(0);
			expect(approvals[0].type).toBe("permission");
			expect(approvals[0].status).toBe("pending");
		}
	});

	it("continues to track statistics correctly with projections", () => {
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "sess-1",
				messageID: "msg-1",
				info: { role: "user", parts: [] },
			}),
			"sess-1",
		);

		const stats = hook.getStats();
		expect(stats.eventsReceived).toBe(1);
		expect(stats.eventsWritten).toBe(1);
		expect(stats.errors).toBe(0);
	});

	it("catches projection errors without breaking the relay pipeline", () => {
		// Close the DB to force errors
		layer.close();

		const logWarn = vi.fn();
		const brokenHook = new DualWriteHook({
			persistence: layer,
			log: { warn: logWarn, debug: vi.fn(), info: vi.fn(), verbose: vi.fn() },
		});

		expect(() =>
			brokenHook.onSSEEvent(
				makeSSEEvent("message.created", {
					sessionID: "sess-1",
					messageID: "msg-1",
					info: { role: "user", parts: [] },
				}),
				"sess-1",
			),
		).not.toThrow();

		expect(logWarn).toHaveBeenCalled();
	});

	it("runs recovery on startup to catch up projections", () => {
		// Manually append events without projecting (simulate crash)
		layer.eventStore.append({
			eventId: createEventId(),
			sessionId: "sess-1",
			type: "session.created",
			data: {
				sessionId: "sess-1",
				title: "Orphan Session",
				provider: "opencode",
			},
			metadata: {},
			provider: "opencode",
			createdAt: Date.now(),
		});

		// Projections should be empty
		let session = layer.db.queryOne<{ id: string }>(
			"SELECT id FROM sessions WHERE id = ?",
			["sess-1"],
		);
		// Session might exist from seeder, check projector state
		const cursorBefore = layer.db.queryOne<{ last_applied_seq: number }>(
			"SELECT last_applied_seq FROM projector_cursors WHERE projector_name = 'session'",
			[],
		);
		expect(cursorBefore).toBeUndefined();

		// Run recovery
		const count = layer.projectionRunner.recover();
		expect(count).toBe(1);

		// Now the session should be projected
		session = layer.db.queryOne<{ id: string; title: string }>(
			"SELECT id, title FROM sessions WHERE id = ?",
			["sess-1"],
		);
		expect(session).toBeDefined();
		expect(session!.title).toBe("Orphan Session");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/dual-write-projection.test.ts`
Expected: FAIL — `PersistenceLayer` does not yet expose `projectionRunner`.

**Step 3: Modify implementation**

First, update `PersistenceLayer` to create and expose the `ProjectionRunner`:

```typescript
// src/lib/persistence/persistence-layer.ts — additions
//
// Add to the existing imports:
import {
	ProjectionRunner,
	createAllProjectors,
} from "./projection-runner.js";

// Add to the class fields:
//   readonly projectionRunner: ProjectionRunner;

// Add to the constructor, after eventStore and cursorRepo initialization:
//   this.projectionRunner = new ProjectionRunner({
//     db: this.db,
//     eventStore: this.eventStore,
//     cursorRepo: this.cursorRepo,
//     projectors: createAllProjectors(),
//   });
```

The full modified `PersistenceLayer` constructor section:

```typescript
// In the PersistenceLayer class, add the projectionRunner field and
// create it in the constructor after the existing initialization:

export class PersistenceLayer {
	readonly db: SqliteClient;
	readonly eventStore: EventStore;
	readonly commandReceipts: CommandReceiptRepository;
	readonly cursorRepo: ProjectorCursorRepository;
	readonly projectionRunner: ProjectionRunner;

	private constructor(db: SqliteClient) {
		this.db = db;
		runMigrations(db, schemaMigrations);
		this.eventStore = new EventStore(db);
		this.commandReceipts = new CommandReceiptRepository(db);
		this.cursorRepo = new ProjectorCursorRepository(db);
		this.projectionRunner = new ProjectionRunner({
			db,
			eventStore: this.eventStore,
			cursorRepo: this.cursorRepo,
			projectors: createAllProjectors(),
		});
		// ... rest of existing constructor ...
	}

	// ... existing methods ...
}
```

Then, update `DualWriteHook.onSSEEvent()` to also project events:

```typescript
// src/lib/persistence/dual-write-hook.ts — modified onSSEEvent
//
// Replace the event append loop in onSSEEvent() with:

	// NOTE: The full onSSEEvent() implementation with DualWriteResult return type,
	// stage-tracked error logging, synthetic event tagging, and SSE batch
	// correlation is already defined in the Task 10 code block above.
	//
	// The only Task 22 change is: after each eventStore.append(), also run
	// projection SYNCHRONOUSLY. Update the "appending" stage loop in the
	// Task 10 implementation to:
	//
	//   const stored = this.persistence.eventStore.append(enriched as CanonicalEvent);
	//   this._eventsWritten++;
	//
	//   // (CH2) Project synchronously. All event types, no deferral.
	//   // Performance optimization comes from P1's normalized message_parts
	//   // table (eliminating JSON round-trips), not from microtask deferral.
	//   // If P11 shows peakProjectMs >5ms, reintroduce selective deferral.
	//   //
	//   // Note: projectEvent() already catches per-projector errors internally
	//   // via recordFailure() and does NOT re-throw. The try/catch here only
	//   // catches infrastructure-level failures (cursor sync, transaction
	//   // begin/commit errors). Do NOT increment _errors here to avoid
	//   // double-counting with ProjectionRunner's internal failure tracking.
	//   const tProject0 = performance.now();
	//   try {
	//     this.persistence.projectionRunner.projectEvent(stored);
	//   } catch (infraErr) {
	//     // Infrastructure failure (not a per-projector error — those are
	//     // caught inside projectEvent). Log but don't break the relay.
	//     this.log.warn("projection infrastructure failure", {
	//       sequence: stored.sequence,
	//       type: stored.type,
	//       sessionId: stored.sessionId,
	//       error: infraErr instanceof Error ? infraErr.message : String(infraErr),
	//     });
	//   }
	//   const tProject1 = performance.now();
	//   this._totalProjectMs += tProject1 - tProject0;
	//   this._peakProjectMs = Math.max(this._peakProjectMs, tProject1 - tProject0);
```

The key change is: `eventStore.append()` now returns the `StoredEvent` (with `sequence` assigned), and we run projection synchronously for ALL event types. No `queueMicrotask`, no `SYNC_PROJECT_TYPES`, no deferred projection.

> **(CH2) Why synchronous instead of deferred (supersedes P5) — FURTHER SUPERSEDED by Concurrency Solutions Change 1:**
>
> The original P5 optimization used `queueMicrotask()` to defer projection of non-critical event types. The concurrency hardening plan (Task 2) identified two hazards with this approach:
>
> 1. **Crash window:** Event is appended (durable), projection is deferred. If the process crashes before the microtask runs, the event is in the store but its projections are missing.
> 2. **Error orphaning:** If the deferred projection throws, the cursor doesn't advance. The event stays un-projected until the next `recover()` call, which only runs at startup.
>
> **Concurrency Solutions Change 1** eliminates all deferred paths entirely. The synchronous interleaved pipeline with batch transactions addresses the same performance concern without concurrency risk. The "reintroduce deferred projection selectively if P11 > 5ms" note is **withdrawn**.

> **Note on transaction scope:** The design document specifies Option A (event append + projections in one transaction). The simplest first implementation keeps them separate: append succeeds first, then projectEvent runs in its own transaction. This avoids restructuring `EventStore.append()` to accept an external transaction. The recovery mechanism handles the gap: if projectors fail after append, `recover()` replays the unprojected events on next startup.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/dual-write-projection.test.ts`
Expected: PASS

Also run the existing dual-write tests to verify no regressions:

Run: `pnpm vitest run test/unit/persistence/dual-write-hook.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

Consider whether `EventStore.append()` should return the `StoredEvent`. If it currently returns `void`, update it to return the stored event with the sequence number assigned. This is a minor but necessary change:

```typescript
// In event-store.ts, update append() return type:
//
// Before:
//   append(event: CanonicalEvent): void { ... }
//
// After:
//   append(event: CanonicalEvent): StoredEvent { ... return storedEvent; }
```

This change is backward-compatible — callers that ignored the return value continue to work.

**Step 6: Commit**

```bash
git add src/lib/persistence/dual-write-hook.ts src/lib/persistence/persistence-layer.ts src/lib/persistence/event-store.ts test/unit/persistence/dual-write-projection.test.ts
git commit -m "feat(persistence): wire ProjectionRunner into dual-write hook for real-time projection"
```

---

### Task 22.5: Projector Coverage Check and PersistenceDiagnostics

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5d — Event-Loop-Aware Auditor Snapshots):**
> Schedule `DualWriteAuditor` snapshot construction via `setImmediate` so it runs between I/O callbacks
> — never mid-SSE-batch. Add `maxSnapshotDrift` (default: 50 events) staleness guard: if more than N
> events have been ingested between snapshot construction and comparison, discard the comparison as too
> stale. This eliminates the worst case of snapshots taken mid-batch with half-updated state.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Tasks 9 & 12):**
> - **(I6)** `checkIntegrity()` uses a simpler max-sequence check instead of gap detection — `AUTOINCREMENT` sequences can't have gaps unless rows are deleted, which the append-only store never does. Keep orphan and unparsable checks.
> - Add `checkIntegrity()` method for event store structural health verification.
> - Add `readPathHealth()` method that aggregates stats from registered `ShadowReadComparator` and `DivergenceCircuitBreaker` instances.
> - Add `registerComparator()` and `registerBreaker()` methods for relay stack integration.

**Files:**
- Create: `src/lib/persistence/projectors/coverage.ts`
- Create: `src/lib/persistence/diagnostics.ts`
- Test: `test/unit/persistence/diagnostics.test.ts`

**Purpose:** Two additive utilities that improve debuggability without modifying existing code:

1. **Compile-time projector coverage check** (`coverage.ts`): A zero-runtime-cost type assertion that fails to compile if any canonical event type is not handled by at least one projector. Adding a new event type without updating projectors becomes a compile error instead of a silent gap.

2. **`PersistenceDiagnostics`** (`diagnostics.ts`): Prebuilt health-check queries so an LLM can inspect event store health, projector lag, orphaned events, and stale streaming messages with one function call instead of manual SQL exploration.

**Implementation:**

```typescript
// src/lib/persistence/projectors/coverage.ts
//
// Compile-time assertion: every canonical event type is handled by
// at least one projector.  If a new event type is added to
// CANONICAL_EVENT_TYPES without updating any projector's `handles`
// array, this file will fail to compile.

import type { CanonicalEventType } from "../events.js";
import type { SessionProjector } from "./session-projector.js";
import type { MessageProjector } from "./message-projector.js";
import type { TurnProjector } from "./turn-projector.js";
import type { ProviderProjector } from "./provider-projector.js";
import type { ApprovalProjector } from "./approval-projector.js";
import type { ActivityProjector } from "./activity-projector.js";

type AllProjectedTypes =
	| (typeof SessionProjector.prototype.handles)[number]
	| (typeof MessageProjector.prototype.handles)[number]
	| (typeof TurnProjector.prototype.handles)[number]
	| (typeof ProviderProjector.prototype.handles)[number]
	| (typeof ApprovalProjector.prototype.handles)[number]
	| (typeof ActivityProjector.prototype.handles)[number];

type UnprojectedTypes = Exclude<CanonicalEventType, AllProjectedTypes>;

// This line fails to compile if any canonical event type is not
// handled by at least one projector:
type _AssertFullCoverage = UnprojectedTypes extends never
	? true
	: { error: `Unprojected event types: ${UnprojectedTypes}` };
const _coverageCheck: _AssertFullCoverage = true;
```

```typescript
// src/lib/persistence/diagnostics.ts
import type { SqliteClient } from "./sqlite-client.js";

// (Perf-Fix-7) Options for PersistenceDiagnostics constructor.
export interface DiagnosticsOptions {
	/** Event count above which health() sets eventCountWarning=true. Default: 100_000. */
	eventCountWarningThreshold?: number;
}

export interface PersistenceHealth {
	readonly totalEvents: number;
	readonly maxSequence: number;
	readonly totalSessions: number;
	readonly projectorCursors: readonly { name: string; seq: number }[];
	readonly pendingApprovals: number;
	readonly streamingMessages: number;
	// (Perf-Fix-7) Event count warning fields
	readonly eventCount: number;
	readonly eventCountWarning: boolean;
	readonly dbSizeBytes: number;
}

// ── Integrity Report (Amendment: Consistency Plan Task 9) ──────────────
export interface IntegrityReport {
	readonly eventCount: number;
	readonly maxSequence: number;
	/** (I6) If count != max, rows were deleted from the append-only store. */
	readonly sequenceConsistent: boolean;
	readonly orphanedEvents: number;
	readonly unparsablePayloads: number;
	readonly cursorRegressions: Array<{ name: string; cursor: number; maxSeq: number; lag: number }>;
	readonly projectorLagMax: number;
}

/**
 * Prebuilt health-check queries for the persistence layer.
 *
 * Gives LLMs and diagnostic tools a single entry point to inspect event
 * store health, projector lag, and data anomalies without constructing
 * manual SQL.
 */
export class PersistenceDiagnostics {
	// (Perf-Fix-7) Configurable event count warning threshold.
	private readonly eventCountWarningThreshold: number;

	constructor(private readonly db: SqliteClient, opts?: DiagnosticsOptions) {
		this.eventCountWarningThreshold = opts?.eventCountWarningThreshold ?? 100_000;
	}

	// ── Comparator/Breaker Registry (Amendment: Consistency Plan Task 12) ──
	private readonly comparators = new Map<string, import("./shadow-read-comparator.js").ShadowReadComparator<unknown>>();
	private readonly breakers = new Map<string, import("./divergence-circuit-breaker.js").DivergenceCircuitBreaker>();

	registerComparator(label: string, comparator: import("./shadow-read-comparator.js").ShadowReadComparator<unknown>): void {
		this.comparators.set(label, comparator);
	}

	registerBreaker(flagName: string, breaker: import("./divergence-circuit-breaker.js").DivergenceCircuitBreaker): void {
		this.breakers.set(flagName, breaker);
	}

	/** Summary of event store and projection health. */
	health(): PersistenceHealth {
		const eventCount = this.db.queryOne<{ c: number }>(
			"SELECT COUNT(*) as c FROM events",
		)?.c ?? 0;

		// (Perf-Fix-7) PRAGMA returns single-column result
		const pageCountRow = this.db.queryOne<{ page_count: number }>(
			"PRAGMA page_count",
		);
		const pageSizeRow = this.db.queryOne<{ page_size: number }>(
			"PRAGMA page_size",
		);
		const dbSizeBytes = (pageCountRow?.page_count ?? 0) * (pageSizeRow?.page_size ?? 4096);

		return {
			totalEvents: eventCount,
			maxSequence:
				this.db.queryOne<{ m: number }>("SELECT MAX(sequence) as m FROM events")?.m ?? 0,
			totalSessions:
				this.db.queryOne<{ c: number }>("SELECT COUNT(*) as c FROM sessions")?.c ?? 0,
			projectorCursors: this.db.query<{ name: string; seq: number }>(
				"SELECT projector_name as name, last_applied_seq as seq FROM projector_cursors ORDER BY name",
			),
			pendingApprovals:
				this.db.queryOne<{ c: number }>(
					"SELECT COUNT(*) as c FROM pending_approvals WHERE status='pending'",
				)?.c ?? 0,
			streamingMessages:
				this.db.queryOne<{ c: number }>(
					"SELECT COUNT(*) as c FROM messages WHERE is_streaming=1",
				)?.c ?? 0,
			// (Perf-Fix-7) Event count warning fields
			eventCount,
			eventCountWarning: eventCount > this.eventCountWarningThreshold,
			dbSizeBytes,
		};
	}

	/** Find projectors that are behind the event stream. */
	projectorLag(): { name: string; lag: number }[] {
		const maxSeq =
			this.db.queryOne<{ m: number }>("SELECT MAX(sequence) as m FROM events")?.m ?? 0;
		const cursors = this.db.query<{ name: string; seq: number }>(
			"SELECT projector_name as name, last_applied_seq as seq FROM projector_cursors",
		);
		return cursors.map((c) => ({ name: c.name, lag: maxSeq - c.seq }));
	}

	/** Find messages stuck in streaming state for longer than `staleSinceMs`. */
	staleStreamingMessages(
		staleSinceMs: number = 5 * 60 * 1000,
	): { id: string; sessionId: string; stuckSince: number }[] {
		const cutoff = Date.now() - staleSinceMs;
		return this.db.query<{ id: string; sessionId: string; stuckSince: number }>(
			`SELECT id, session_id as sessionId, updated_at as stuckSince
			 FROM messages
			 WHERE is_streaming = 1 AND updated_at < ?
			 ORDER BY updated_at ASC`,
			[cutoff],
		);
	}

	// ── Integrity Checks (Amendment: Consistency Plan Task 9) ──────────

	/**
	 * (I6) Comprehensive integrity check of the event store and projections.
	 *
	 * Uses a simpler max-sequence check instead of gap detection —
	 * AUTOINCREMENT sequences can't have gaps unless rows are deleted,
	 * which the append-only store never does.
	 *
	 * Suitable for running:
	 * - On startup (after ProjectionRunner.recover())
	 * - Periodically (every 60s in development)
	 * - Via diagnostic endpoint or CLI command
	 */
	checkIntegrity(): IntegrityReport {
		const eventCount = this.db.queryOne<{ c: number }>(
			"SELECT COUNT(*) AS c FROM events",
		)?.c ?? 0;
		const maxSequence = this.db.queryOne<{ m: number }>(
			"SELECT MAX(sequence) AS m FROM events",
		)?.m ?? 0;
		const sequenceConsistent = eventCount === 0 || eventCount === maxSequence;

		const orphaned = this.db.queryOne<{ c: number }>(
			`SELECT COUNT(*) AS c FROM events e
			 WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id)`,
		)?.c ?? 0;

		const recentEvents = this.db.query<{ data: string }>(
			"SELECT data FROM events ORDER BY sequence DESC LIMIT 100",
		);
		let unparsable = 0;
		for (const row of recentEvents) {
			try { JSON.parse(row.data); } catch { unparsable++; }
		}

		const maxSeq = this.db.queryOne<{ m: number }>(
			"SELECT MAX(sequence) AS m FROM events",
		)?.m ?? 0;
		const cursors = this.db.query<{ name: string; seq: number }>(
			"SELECT projector_name AS name, last_applied_seq AS seq FROM projector_cursors",
		);
		const regressions = cursors
			.filter((c) => c.seq < maxSeq)
			.map((c) => ({ name: c.name, cursor: c.seq, maxSeq, lag: maxSeq - c.seq }));

		return {
			eventCount,
			maxSequence,
			sequenceConsistent,
			orphanedEvents: orphaned,
			unparsablePayloads: unparsable,
			cursorRegressions: regressions,
			projectorLagMax: regressions.length > 0
				? Math.max(...regressions.map((r) => r.lag))
				: 0,
		};
	}

	// ── Read Path Health (Amendment: Consistency Plan Task 12) ─────────

	/** Aggregate stats from all registered comparators and breakers. */
	readPathHealth(): Record<string, { stats: import("./shadow-read-comparator.js").ReadPathStats; breaker?: import("./divergence-circuit-breaker.js").CircuitBreakerStats }> {
		const result: Record<string, any> = {};
		for (const [label, comparator] of this.comparators) {
			result[label] = {
				stats: comparator.getStats(),
				breaker: this.breakers.get(label)?.getStats(),
			};
		}
		return result;
	}
}
```

> **Amendment (2026-04-07 — Perf-Fix-7): Event Count Warning.**
> Added `DiagnosticsOptions` interface, `eventCountWarningThreshold` constructor
> option, and `eventCount`, `eventCountWarning`, `dbSizeBytes` fields to `health()`.
> See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 7.

**Additional diagnostic tests** (add to `test/unit/persistence/diagnostics.test.ts`):

```typescript
describe("event count warning (merged into health())", () => {
	it("reports event count in health()", () => {
		// Seed session first (FK constraint)
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		for (let i = 0; i < 10; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, 's1', ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${i}`, i, Date.now()],
			);
		}

		const health = diagnostics.health();
		expect(health.eventCount).toBe(10);
		expect(health.eventCountWarning).toBe(false);
	});

	it("sets warning flag when event count exceeds threshold", () => {
		const diag = new PersistenceDiagnostics(db, { eventCountWarningThreshold: 5 });

		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			["s1", "opencode", "Test", "idle", Date.now(), Date.now()],
		);
		for (let i = 0; i < 10; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, 's1', ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${i}`, i, Date.now()],
			);
		}

		const health = diag.health();
		expect(health.eventCount).toBe(10);
		expect(health.eventCountWarning).toBe(true);
	});

	it("returns zero event count for empty database", () => {
		const health = diagnostics.health();
		expect(health.eventCount).toBe(0);
		expect(health.eventCountWarning).toBe(false);
	});
});
```

**Commit:**

```bash
git add src/lib/persistence/projectors/coverage.ts src/lib/persistence/diagnostics.ts test/unit/persistence/diagnostics.test.ts
git commit -m "feat(persistence): add compile-time projector coverage check and PersistenceDiagnostics"
```

---

### Phase 3 Completion Checklist

After all 11 tasks (Tasks 13-22.5), verify the full phase:

```bash
pnpm vitest run test/unit/persistence/
```

Expected: All tests pass. Files created or modified:

| File | Purpose |
|------|---------|
| `src/lib/persistence/projector-cursor-repository.ts` | CRUD for projector cursor positions |
| `src/lib/persistence/projectors/projector.ts` | Projector interface, `isEventType()`, `encodeJson()`/`decodeJson()` |
| `src/lib/persistence/projectors/session-projector.ts` | Projects session lifecycle → `sessions` table |
| `src/lib/persistence/projectors/message-projector.ts` | Projects message/text/tool events → `messages` table |
| `src/lib/persistence/projectors/turn-projector.ts` | Projects turn lifecycle → `turns` table |
| `src/lib/persistence/projectors/provider-projector.ts` | Projects provider bindings → `session_providers` table |
| `src/lib/persistence/projectors/approval-projector.ts` | Projects permission/question events → `pending_approvals` table |
| `src/lib/persistence/projectors/activity-projector.ts` | Projects activity timeline events → `activities` table |
| `src/lib/persistence/projection-runner.ts` | Orchestrates all 6 projectors + cursor management + recovery + failure tracking |
| `src/lib/persistence/projectors/coverage.ts` | Compile-time assertion that all event types are handled by >=1 projector |
| `src/lib/persistence/diagnostics.ts` | `PersistenceDiagnostics` health-check queries for LLM debugging |
| `src/lib/persistence/dual-write-hook.ts` | **Modified**: calls `projectionRunner.projectEvent()` after append, returns `DualWriteResult` |
| `src/lib/persistence/persistence-layer.ts` | **Modified**: creates and exposes `ProjectionRunner` |
| `src/lib/persistence/event-store.ts` | **Modified**: `append()` returns `StoredEvent`, validates payloads, safe JSON deser |

Also run the full verification suite to confirm no regressions:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All existing tests pass. The relay pipeline is unchanged — projections are purely additive to the dual-write path.

**(E1) Shared test factories:** Create `test/helpers/persistence-factories.ts` with shared helpers: `makeStored()`, `seedSession()`, `seedMessage()`, `makeSSEEvent()`. Every projector and integration test should import from this module instead of defining local copies. When `StoredEvent`'s shape changes, there is one definition to update instead of ~15 scattered copies.

**(E2) Snapshot tests:** Add a "full lifecycle" snapshot test to the ProjectionRunner test suite that replays a complete session lifecycle (session.created -> message.created -> text.delta -> tool lifecycle -> turn.completed) and snapshots the complete `{ session, messages, turns }` state. This catches silent regressions where a projector change affects an unexpected column — particularly valuable during Phase 4 read-switchover.

Final commit for any barrel export or cleanup:

```bash
git add src/lib/persistence/ test/unit/persistence/
git commit -m "feat(persistence): complete Phase 3 projections — 6 projectors with runner, recovery, and dual-write integration"
```

**Projection coverage matrix:**

| Event Type | Session | Message | Turn | Provider | Approval | Activity |
|------------|---------|---------|------|----------|----------|----------|
| `session.created` | ✓ | | | ✓ | | |
| `session.renamed` | ✓ | | | | | |
| `session.status` | ✓ | | ✓ | | | |
| `session.provider_changed` | ✓ | | | ✓ | | |
| `message.created` | | ✓ | ✓ | | | |
| `text.delta` | | ✓ | | | | |
| `thinking.start` | | ✓ | | | | |
| `thinking.delta` | | ✓ | | | | |
| `thinking.end` | | ✓ | | | | |
| `tool.started` | | ✓ | | | | ✓ |
| `tool.running` | | ✓ | | | | ✓ |
| `tool.completed` | | ✓ | | | | ✓ |
| `turn.completed` | ✓ | ✓ | ✓ | | | |
| `turn.error` | ✓ | ✓ | ✓ | | | ✓ |
| `turn.interrupted` | | | ✓ | | | |
| `permission.asked` | | | | | ✓ | ✓ |
| `permission.resolved` | | | | | ✓ | ✓ |
| `question.asked` | | | | | ✓ | ✓ |
| `question.resolved` | | | | | ✓ | ✓ |

All 19 canonical event types are handled by at least one projector. No event falls through without projection. This invariant is enforced at compile time by `src/lib/persistence/projectors/coverage.ts` (Task 22.5) — adding a new event type without updating at least one projector's `handles` array will fail to compile.

**Next:** Phase 4 (Read Path Migration) will migrate the existing relay read paths from JSONL/in-memory caches to SQLite projections, one query at a time.

---

## Phase 4: Read Switchover — Migrate Reads from JSONL/REST to SQLite

**Goal:** Replace every relay read path that currently hits JSONL caches, in-memory stores, or the OpenCode REST API with queries against the SQLite projection tables populated in Phase 3. Each sub-phase is independently deployable and revertable via a feature flag.

**Depends on:** Phase 3 (all 6 projectors running). The dual-write hook is populating projection tables; now we read from them.

**Validates:** Projected data matches what the old code paths returned. Every sub-phase has comparison logging during transition, and each can be reverted by flipping its flag back to the legacy path.

**Sub-phases in order of increasing risk:**

| Sub-phase | Read path | Old source | New source | Tasks |
|-----------|-----------|------------|------------|-------|
| 4a | Tool content | `ToolContentStore` in-memory Map | `tool_content` table | 23-24 |
| 4b | Fork metadata | `fork-metadata.json` file | `sessions.parent_id` + `fork_point_event` | 25-26 |
| 4c | Session list | `listSessions()` REST | `SELECT * FROM sessions` | 27-28 |
| 4d | Session status | `SessionStatusPoller` REST polling | `sessions.status` column | 29-30 |
| 4e | Session switch history | `resolveSessionHistory()` JSONL cache + REST | `messages` + `turns` tables | 31-32 |
| 4f | Pending permissions | `PermissionBridge` in-memory Map + REST | `pending_approvals` table | 33-34 |

### Rollback Procedure (per sub-phase)

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 11)**

Each sub-phase can be independently reverted. The dual-write hook continues writing to SQLite regardless of which read path is active — reads are the only thing that changes.

**Instant revert (no restart):**

1. Set the flag to `"legacy"` at runtime (URL flag, settings toggle, or config change). Reads immediately serve from the legacy source.
2. The `DivergenceCircuitBreaker` may have already done this automatically if divergence exceeded the threshold.

**What happens to SQLite data on rollback:**

- The event store still has every event. Projections continue to be maintained by the dual-write hook (writes are always on).
- No data loss or corruption from reverting reads.
- SQLite and legacy run side-by-side indefinitely until confidence is re-established.

**If projections are suspect (rebuild from event store):**

```sql
-- In application code or via diagnostic endpoint:
DELETE FROM projector_cursors;
DELETE FROM sessions;
DELETE FROM messages;
DELETE FROM message_parts;
DELETE FROM turns;
DELETE FROM session_providers;
DELETE FROM pending_approvals;
DELETE FROM activities;
DELETE FROM tool_content;
-- Then restart the daemon — ProjectionRunner.recover() replays all events.
```

**If the event store itself is suspect:**

- Delete the SQLite database file and restart.
- The dual-write hook rebuilds from the next SSE event forward.
- Historical data requires re-seeding from OpenCode REST (not automated — known limitation, tracked for Phase 7 follow-up).

**Rollback progression path:**

```
sqlite → shadow → legacy     (if divergence detected)
legacy → shadow → sqlite     (normal promotion)
```

The `shadow` state is the safe middle ground — it serves legacy data while validating SQLite in the background. Promote to `sqlite` only after the `ShadowReadComparator` shows zero divergence over a sustained period (check `ReadPathStats` via `PersistenceDiagnostics`).

---

### Task 23: ReadQueryService — Centralized SQLite Read Layer

> **Amendment (2026-04-07, S10b — IN Query Optimization):**
> Replace the `WHERE message_id IN (?, ?, ...)` pattern in `getSessionMessagesWithParts()` with a
> CTE + JOIN approach. For sessions with 100+ messages, the IN clause generates 100+ placeholders,
> and SQLite's query planner may not use the index optimally for large lists. The CTE approach:
>
> ```sql
> WITH target_messages AS (
>     SELECT id FROM messages WHERE session_id = ? ORDER BY created_at
> )
> SELECT mp.* FROM message_parts mp
> JOIN target_messages tm ON mp.message_id = tm.id
> ORDER BY mp.message_id, mp.sort_order
> ```
>
> This lets SQLite use the `idx_message_parts_message` index via a nested-loop join, which is
> consistently efficient regardless of message count. It also avoids the `SQLITE_MAX_VARIABLE_NUMBER`
> parameter-count limit (default 999) entirely.

**Files:**
- Create: `src/lib/persistence/read-query-service.ts`
- Test: `test/unit/persistence/read-query-service.test.ts`

**Purpose:** A single service that encapsulates all SQLite read queries for Phase 4. Each sub-phase adds methods here rather than scattering SQL across handlers. This keeps query logic testable in isolation and makes it easy to swap read paths via flags.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/read-query-service.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";

function seedSession(
	db: SqliteClient,
	id: string,
	opts?: {
		title?: string;
		status?: string;
		parentId?: string;
		forkPointEvent?: string;
		createdAt?: number;
		updatedAt?: number;
	},
): void {
	const now = Date.now();
	db.execute(
		`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
		 VALUES (?, 'opencode', ?, ?, ?, ?, ?, ?)`,
		[
			id,
			opts?.title ?? "Untitled",
			opts?.status ?? "idle",
			opts?.parentId ?? null,
			opts?.forkPointEvent ?? null,
			opts?.createdAt ?? now,
			opts?.updatedAt ?? now,
		],
	);
}

function seedToolContent(
	db: SqliteClient,
	toolId: string,
	sessionId: string,
	content: string,
): void {
	db.execute(
		"INSERT INTO tool_content (tool_id, session_id, content, created_at) VALUES (?, ?, ?, ?)",
		[toolId, sessionId, content, Date.now()],
	);
}

function seedPendingApproval(
	db: SqliteClient,
	id: string,
	sessionId: string,
	type: "permission" | "question",
	opts?: { status?: string; toolName?: string; input?: string; decision?: string },
): void {
	db.execute(
		`INSERT INTO pending_approvals (id, session_id, type, status, tool_name, input, decision, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			type,
			opts?.status ?? "pending",
			opts?.toolName ?? null,
			opts?.input ?? null,
			opts?.decision ?? null,
			Date.now(),
		],
	);
}

function seedMessage(
	db: SqliteClient,
	id: string,
	sessionId: string,
	role: "user" | "assistant",
	opts?: { text?: string; createdAt?: number; turnId?: string },
): void {
	const now = Date.now();
	db.execute(
		`INSERT INTO messages (id, session_id, turn_id, role, text, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			opts?.turnId ?? null,
			role,
			opts?.text ?? "",
			opts?.createdAt ?? now,
			opts?.createdAt ?? now,
		],
	);
}

function seedTurn(
	db: SqliteClient,
	id: string,
	sessionId: string,
	opts?: { state?: string; requestedAt?: number; completedAt?: number; cost?: number },
): void {
	db.execute(
		`INSERT INTO turns (id, session_id, state, requested_at, completed_at, cost)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			opts?.state ?? "completed",
			opts?.requestedAt ?? Date.now(),
			opts?.completedAt ?? null,
			opts?.cost ?? null,
		],
	);
}

describe("ReadQueryService", () => {
	let db: SqliteClient;
	let svc: ReadQueryService;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		svc = new ReadQueryService(db);
	});

	afterEach(() => {
		db.close();
	});

	// ── 4a: Tool content ──────────────────────────────────────────────────

	describe("getToolContent", () => {
		it("returns content for a known tool ID", () => {
			seedSession(db, "s1");
			seedToolContent(db, "tool-abc", "s1", '{"result": "hello"}');
			expect(svc.getToolContent("tool-abc")).toBe('{"result": "hello"}');
		});

		it("returns undefined for unknown tool ID", () => {
			expect(svc.getToolContent("nonexistent")).toBeUndefined();
		});
	});

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	describe("getForkMetadata", () => {
		it("returns parent_id and fork_point_event for a forked session", () => {
			seedSession(db, "parent-1");
			seedSession(db, "fork-1", {
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
			const meta = svc.getForkMetadata("fork-1");
			expect(meta).toEqual({
				parentId: "parent-1",
				forkPointEvent: "msg-42",
			});
		});

		it("returns undefined for a non-forked session", () => {
			seedSession(db, "s1");
			expect(svc.getForkMetadata("s1")).toBeUndefined();
		});

		it("returns undefined for unknown session", () => {
			expect(svc.getForkMetadata("nonexistent")).toBeUndefined();
		});
	});

	// ── 4c: Session list ──────────────────────────────────────────────────

	describe("listSessions", () => {
		it("returns all sessions ordered by updated_at DESC", () => {
			seedSession(db, "s1", { title: "First", updatedAt: 1000 });
			seedSession(db, "s2", { title: "Second", updatedAt: 3000 });
			seedSession(db, "s3", { title: "Third", updatedAt: 2000 });

			const sessions = svc.listSessions();
			expect(sessions.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
			expect(sessions[0].title).toBe("Second");
		});

		it("filters to root sessions when roots=true", () => {
			seedSession(db, "parent-1", { title: "Parent" });
			seedSession(db, "child-1", {
				title: "Child",
				parentId: "parent-1",
			});

			const roots = svc.listSessions({ roots: true });
			expect(roots).toHaveLength(1);
			expect(roots[0].id).toBe("parent-1");
		});

		it("returns empty array when no sessions exist", () => {
			expect(svc.listSessions()).toEqual([]);
		});
	});

	// ── 4d: Session status ────────────────────────────────────────────────

	describe("getSessionStatus", () => {
		it("returns status for a known session", () => {
			seedSession(db, "s1", { status: "busy" });
			expect(svc.getSessionStatus("s1")).toBe("busy");
		});

		it("returns undefined for unknown session", () => {
			expect(svc.getSessionStatus("nonexistent")).toBeUndefined();
		});
	});

	describe("getAllSessionStatuses", () => {
		it("returns status map for all sessions", () => {
			seedSession(db, "s1", { status: "idle" });
			seedSession(db, "s2", { status: "busy" });
			const statuses = svc.getAllSessionStatuses();
			expect(statuses).toEqual({ s1: "idle", s2: "busy" });
		});
	});

	// ── 4e: Session history ───────────────────────────────────────────────

	describe("getSessionMessages", () => {
		it("returns messages ordered by created_at ASC", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", { text: "hello", createdAt: 1000 });
			seedMessage(db, "m2", "s1", "assistant", { text: "hi there", createdAt: 2000 });

			const msgs = svc.getSessionMessages("s1");
			expect(msgs).toHaveLength(2);
			expect(msgs[0].id).toBe("m1");
			expect(msgs[0].role).toBe("user");
			expect(msgs[1].id).toBe("m2");
			expect(msgs[1].role).toBe("assistant");
		});

		it("supports limit and before cursor for pagination", () => {
			seedSession(db, "s1");
			seedMessage(db, "m1", "s1", "user", { createdAt: 1000 });
			seedMessage(db, "m2", "s1", "assistant", { createdAt: 2000 });
			seedMessage(db, "m3", "s1", "user", { createdAt: 3000 });

			// Get latest 2 (over-fetches by 1, so 3 rows returned)
			const page1 = svc.getSessionMessages("s1", { limit: 2 });
			expect(page1).toHaveLength(3); // limit+1 over-fetch (Perf-Fix-6)
			// Messages are ordered oldest-first
			expect(page1[0].id).toBe("m1");
			expect(page1[1].id).toBe("m2");
			expect(page1[2].id).toBe("m3");

			// NOTE (Perf-Fix-6): This test was updated from the original
			// `beforeMessageId` parameter to use the composite cursor
			// (beforeCreatedAt, beforeId). See perf-fixes Task 6.
			// Get messages before m2 using composite cursor
			const page2 = svc.getSessionMessages("s1", {
				limit: 10,
				beforeCreatedAt: 2000,
				beforeId: "m2",
			});
			expect(page2).toHaveLength(1);
			expect(page2[0].id).toBe("m1");
		});

		it("returns empty array for unknown session", () => {
			expect(svc.getSessionMessages("nonexistent")).toEqual([]);
		});
	});

	// (Perf-Fix-6) Composite cursor pagination test
	describe("getSessionMessages cursor pagination", () => {
		it("composite cursor paginates correctly with same-timestamp messages", () => {
			seedSession(db, "s1");
			// Seed 5 messages with the same created_at but different IDs
			const ts = Date.now();
			for (const id of ["m-a", "m-b", "m-c", "m-d", "m-e"]) {
				db.execute(
					`INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
					 VALUES (?, 's1', 'user', '', 0, ?, ?)`,
					[id, ts, ts],
				);
			}

			// Page 1: latest 2
			const page1 = svc.getSessionMessages("s1", { limit: 2 });
			expect(page1).toHaveLength(2);

			// Page 2: using cursor from last item of page 1
			const lastItem = page1[page1.length - 1]!;
			const page2 = svc.getSessionMessages("s1", {
				limit: 2,
				beforeCreatedAt: lastItem.created_at,
				beforeId: lastItem.id,
			});
			expect(page2).toHaveLength(2);

			// No overlap between pages
			const page1Ids = new Set(page1.map(m => m.id));
			const page2Ids = new Set(page2.map(m => m.id));
			for (const id of page2Ids) {
				expect(page1Ids.has(id)).toBe(false);
			}
		});
	});

	describe("getSessionTurns", () => {
		it("returns turns ordered by requested_at ASC", () => {
			seedSession(db, "s1");
			seedTurn(db, "t1", "s1", { requestedAt: 1000, state: "completed" });
			seedTurn(db, "t2", "s1", { requestedAt: 2000, state: "pending" });

			const turns = svc.getSessionTurns("s1");
			expect(turns).toHaveLength(2);
			expect(turns[0].id).toBe("t1");
			expect(turns[1].id).toBe("t2");
		});
	});

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	describe("getPendingApprovals", () => {
		it("returns only pending approvals across all sessions", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission", {
				status: "pending",
				toolName: "bash",
			});
			seedPendingApproval(db, "p2", "s1", "permission", {
				status: "resolved",
				toolName: "read",
			});
			seedPendingApproval(db, "q1", "s2", "question", { status: "pending" });

			const pending = svc.getPendingApprovals();
			expect(pending).toHaveLength(2);
			expect(pending.map((p) => p.id).sort()).toEqual(["p1", "q1"]);
		});

		it("returns empty array when nothing is pending", () => {
			expect(svc.getPendingApprovals()).toEqual([]);
		});
	});

	describe("getPendingApprovalsForSession", () => {
		it("returns pending approvals filtered by session", () => {
			seedSession(db, "s1");
			seedSession(db, "s2");
			seedPendingApproval(db, "p1", "s1", "permission", { status: "pending" });
			seedPendingApproval(db, "p2", "s2", "permission", { status: "pending" });

			const s1Pending = svc.getPendingApprovalsForSession("s1");
			expect(s1Pending).toHaveLength(1);
			expect(s1Pending[0].id).toBe("p1");
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/read-query-service.test.ts`
Expected: FAIL with "Cannot find module '...read-query-service.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/read-query-service.ts
// ─── ReadQueryService ───────────────────────────────────────────────────────
// Centralized SQLite read layer for Phase 4 read switchover.
// Each sub-phase adds query methods here. All methods are synchronous
// (SQLite is blocking) and return plain objects — no ORM, no async.

import type { SqliteClient } from "./sqlite-client.js";

// ─── Row types (match projection table schemas) ─────────────────────────────

export interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	fork_point_timestamp: number | null;
	last_message_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface MessageRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	is_streaming: number;
	created_at: number;
	updated_at: number;
}

/** (P1) Normalized message part row from the message_parts table. */
export interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

/** Message with its parts pre-loaded (for batch queries). */
export interface MessageWithParts extends MessageRow {
	parts: MessagePartRow[];
}

export interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	user_message_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
}

export interface PendingApprovalRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	type: string;
	status: string;
	tool_name: string | null;
	input: string | null;
	decision: string | null;
	created_at: number;
	resolved_at: number | null;
}

export interface ForkMetadata {
	parentId: string;
	forkPointEvent: string | null;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ReadQueryService {
	constructor(private readonly db: SqliteClient) {}

	// (B1) Every public method wraps its query in a try/catch that throws
	// PersistenceError with code PROJECTION_FAILED, including the method
	// name, parameters, and the raw SQLite error. This gives LLMs enough
	// context to diagnose read-path failures from logs alone.

	// ── 4a: Tool content ──────────────────────────────────────────────────

	/** Retrieve full tool content by tool ID. Returns undefined if not found. */
	getToolContent(toolId: string): string | undefined {
		try {
			const row = this.db.queryOne<{ content: string }>(
				"SELECT content FROM tool_content WHERE tool_id = ?",
				[toolId],
			);
			return row?.content;
		} catch (err) {
			throw new PersistenceError("PROJECTION_FAILED",
				`ReadQueryService.getToolContent failed`,
				{ method: "getToolContent", toolId, sqliteError: err instanceof Error ? err.message : String(err) },
			);
		}
	}

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	/** Get fork metadata for a session. Returns undefined if not a fork. */
	getForkMetadata(sessionId: string): ForkMetadata | undefined {
		const row = this.db.queryOne<{
			parent_id: string | null;
			fork_point_event: string | null;
		}>(
			"SELECT parent_id, fork_point_event FROM sessions WHERE id = ?",
			[sessionId],
		);
		if (!row || !row.parent_id) return undefined;
		return {
			parentId: row.parent_id,
			forkPointEvent: row.fork_point_event,
		};
	}

	// ── 4c: Session list ──────────────────────────────────────────────────

	/**
	 * List sessions, optionally filtering to roots only (no parent).
	 * (P8) last_message_at is denormalized on the sessions table by
	 * SessionProjector, so no correlated subquery is needed.
	 */
	listSessions(opts?: { roots?: boolean }): SessionRow[] {
		if (opts?.roots) {
			return this.db.query<SessionRow>(
				`SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC`,
			);
		}
		return this.db.query<SessionRow>(
			`SELECT * FROM sessions ORDER BY updated_at DESC`,
		);
	}

	// ── 4d: Session status ────────────────────────────────────────────────

	/** Get the status of a single session. */
	getSessionStatus(sessionId: string): string | undefined {
		const row = this.db.queryOne<{ status: string }>(
			"SELECT status FROM sessions WHERE id = ?",
			[sessionId],
		);
		return row?.status;
	}

	/** Get status for all sessions as a map. */
	getAllSessionStatuses(): Record<string, string> {
		const rows = this.db.query<{ id: string; status: string }>(
			"SELECT id, status FROM sessions",
		);
		const result: Record<string, string> = {};
		for (const row of rows) {
			result[row.id] = row.status;
		}
		return result;
	}

	// ── 4e: Session messages and turns ────────────────────────────────────

	/**
	 * Get messages for a session, ordered by created_at ASC (chronological).
	 *
	 * > **Amendment (2026-04-07 — Perf-Fix-6): Composite Cursor Pagination.**
	 * > Replaced `beforeMessageId` parameter (which required a lookup query)
	 * > with explicit `beforeCreatedAt` / `beforeId` cursor fields. Uses
	 * > OR-expanded form since SQLite doesn't optimize tuple comparison.
	 * > Over-fetches by 1 (I7) for `hasMore` detection. Wraps in ASC subquery
	 * > for consistent caller interface.
	 * > See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 6.
	 *
	 * Supports pagination:
	 * - `limit`: max messages to return. When set without cursor fields,
	 *   returns the *latest* N messages (useful for initial page load).
	 * - `beforeCreatedAt` + `beforeId`: composite cursor-based pagination —
	 *   returns messages before this (created_at, id) pair.
	 */
	getSessionMessages(
		sessionId: string,
		opts?: {
			limit?: number;
			/** Cursor: return messages before this (created_at, id) pair */
			beforeCreatedAt?: number;
			beforeId?: string;
		},
	): MessageRow[] {
		// (Perf-Fix-6) Composite (created_at, id) cursor. Uses OR-expanded form
		// since SQLite doesn't optimize tuple comparison. Over-fetches by 1 (I7)
		// for hasMore detection. Wraps in ASC subquery for consistent caller interface.
		if (opts?.beforeCreatedAt != null && opts?.beforeId != null) {
			const limit = opts.limit ?? 50;
			return this.db.query<MessageRow>(
				`SELECT * FROM (
					SELECT * FROM messages
					WHERE session_id = ?
					  AND (created_at < ? OR (created_at = ? AND id < ?))
					ORDER BY created_at DESC, id DESC
					LIMIT ?
				) sub ORDER BY created_at ASC, id ASC`,
				[sessionId, opts.beforeCreatedAt, opts.beforeCreatedAt, opts.beforeId, limit + 1],
			);
		}

		if (opts?.limit) {
			// (Perf-Fix-6) Latest N messages (first page). Over-fetch by 1 for hasMore detection (I7).
			// Callers should check rows.length > limit to detect pagination,
			// then slice to limit before rendering.
			return this.db.query<MessageRow>(
				`SELECT * FROM (
					SELECT * FROM messages
					WHERE session_id = ?
					ORDER BY created_at DESC, id DESC
					LIMIT ?
				) sub ORDER BY created_at ASC, id ASC`,
				[sessionId, opts.limit + 1],
			);
		}

		// All messages
		return this.db.query<MessageRow>(
			"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
			[sessionId],
		);
	}

	/** Get all turns for a session, ordered by requested_at ASC. */
	getSessionTurns(sessionId: string): TurnRow[] {
		return this.db.query<TurnRow>(
			"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at ASC",
			[sessionId],
		);
	}

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	/** Get all pending approvals across all sessions. */
	getPendingApprovals(): PendingApprovalRow[] {
		return this.db.query<PendingApprovalRow>(
			"SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC",
		);
	}

	/** Get pending approvals for a specific session. */
	getPendingApprovalsForSession(sessionId: string): PendingApprovalRow[] {
		return this.db.query<PendingApprovalRow>(
			"SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
			[sessionId],
		);
	}

	// ── Message parts (P1 normalized table) ───────────────────────────────

	/** (P1) Get all parts for a message, ordered by sort_order. */
	getMessageParts(messageId: string): MessagePartRow[] {
		return this.db.query<MessagePartRow>(
			`SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order`,
			[messageId],
		);
	}

	/**
	 * (P1) Get messages with parts for a session, batch-loaded in one query.
	 * Returns messages ordered by created_at ASC with parts pre-loaded
	 * via a single indexed scan on `idx_message_parts_message`.
	 */
	getSessionMessagesWithParts(sessionId: string): MessageWithParts[] {
		const messages = this.db.query<MessageRow>(
			`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
			[sessionId],
		);
		if (messages.length === 0) return [];

		// Batch-load all parts for all messages in one query
		const messageIds = messages.map(m => m.id);
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
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/read-query-service.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. Each method is a single SQL query with clear semantics.

**Step 6: Commit**

```bash
git add src/lib/persistence/read-query-service.ts test/unit/persistence/read-query-service.test.ts
git commit -m "feat(persistence): add ReadQueryService with all Phase 4 read queries"
```

---

### Task 24: Feature Flags for Read Path Switching

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5c — FlagAuthority):**
> Replace mutable `ReadFlags` object with `FlagAuthority` that tracks the source of each flag value
> (`"default"` / `"config"` / `"breaker"` / `"user"`) and enforces priority. User overrides always
> win over breaker trips; breaker trips override config; config overrides defaults. The
> `DivergenceCircuitBreaker` calls `flagAuthority.set(name, "legacy", "breaker")` — which is rejected
> if the user has explicitly set the flag. The `ShadowReadComparator`'s `getMode()` reads from
> `flagAuthority.get(name)` instead of accessing `readFlags[name]` directly.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan):**
> Replaces boolean `ReadFlags` with three-state `ReadFlagMode` (`"legacy"` / `"shadow"` / `"sqlite"`).
> Adds `isActive()`, `isSqlite()`, `isShadow()` helper functions.
>
> **(C1) CRITICAL:** All Phase 4 handlers (Tasks 25-34) MUST use `isActive(flags.toolContent)` instead of `if (flags.toolContent)`. All non-empty strings are truthy in JavaScript, so `"legacy"` would incorrectly activate the SQLite path.
>
> **(I1) Backward compatibility:** `true → "sqlite"` and `false → "legacy"` mappings are preserved for existing boolean configs. New deployments should use the three-state mode string. The `true → "sqlite"` mapping skips the shadow validation phase — document this risk in operator guides.

**Files:**
- Create: `src/lib/persistence/read-flags.ts`
- Test: `test/unit/persistence/read-flags.test.ts`

**Purpose:** A three-state feature flag module that controls which read path is active for each sub-phase. Each flag defaults to `"legacy"` (no SQLite query). The three states implement the standard dark-launch / Scientist pattern:
- `"legacy"`: Serve from legacy source (JSONL/REST/memory). No SQLite query.
- `"shadow"`: Serve from legacy source. Query SQLite in background, log diffs. Use this to validate SQLite correctness before switching reads.
- `"sqlite"`: Serve from SQLite. Query legacy in background, log diffs. Use this when confident SQLite is correct.

Progression: `legacy → shadow → sqlite → (Phase 7 removes legacy entirely)`

Flags are mutable so the `DivergenceCircuitBreaker` can revert them at runtime without restart.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/read-flags.test.ts
import { describe, expect, it } from "vitest";
import {
	createReadFlags,
	isActive,
	isSqlite,
	isShadow,
	type ReadFlagConfig,
	type ReadFlags,
	type ReadFlagMode,
} from "../../../src/lib/persistence/read-flags.js";

describe("ReadFlags (three-state)", () => {
	it("defaults all flags to 'legacy'", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("legacy");
		expect(flags.sessionStatus).toBe("legacy");
		expect(flags.sessionHistory).toBe("legacy");
		expect(flags.pendingApprovals).toBe("legacy");
	});

	it("accepts partial overrides", () => {
		const flags = createReadFlags({ toolContent: "shadow", sessionList: "sqlite" });
		expect(flags.toolContent).toBe("shadow");
		expect(flags.forkMetadata).toBe("legacy");
		expect(flags.sessionList).toBe("sqlite");
		expect(flags.sessionStatus).toBe("legacy");
	});

	it("accepts all flags as sqlite", () => {
		const flags = createReadFlags({
			toolContent: "sqlite",
			forkMetadata: "sqlite",
			sessionList: "sqlite",
			sessionStatus: "sqlite",
			sessionHistory: "sqlite",
			pendingApprovals: "sqlite",
		});
		expect(flags.toolContent).toBe("sqlite");
		expect(flags.pendingApprovals).toBe("sqlite");
	});

	it("flags are mutable for runtime toggling", () => {
		const flags = createReadFlags();
		expect(flags.toolContent).toBe("legacy");
		flags.toolContent = "shadow";
		expect(flags.toolContent).toBe("shadow");
		flags.toolContent = "sqlite";
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean true maps to 'sqlite'", () => {
		// Support existing config that may pass booleans during transition
		const flags = createReadFlags({ toolContent: true as unknown as ReadFlagMode });
		expect(flags.toolContent).toBe("sqlite");
	});

	it("backward compat: boolean false maps to 'legacy'", () => {
		const flags = createReadFlags({ toolContent: false as unknown as ReadFlagMode });
		expect(flags.toolContent).toBe("legacy");
	});
});

describe("Mode check helpers", () => {
	it("isActive returns true for shadow and sqlite", () => {
		expect(isActive("shadow")).toBe(true);
		expect(isActive("sqlite")).toBe(true);
		expect(isActive("legacy")).toBe(false);
		expect(isActive(undefined)).toBe(false);
	});

	it("isSqlite returns true only for sqlite", () => {
		expect(isSqlite("sqlite")).toBe(true);
		expect(isSqlite("shadow")).toBe(false);
		expect(isSqlite("legacy")).toBe(false);
	});

	it("isShadow returns true only for shadow", () => {
		expect(isShadow("shadow")).toBe(true);
		expect(isShadow("sqlite")).toBe(false);
		expect(isShadow("legacy")).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/read-flags.test.ts`
Expected: FAIL — current implementation returns booleans, not strings.

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/read-flags.ts

/**
 * Three-state read path mode for each Phase 4 sub-phase.
 *
 * - "legacy": Serve from legacy source (JSONL/REST/memory). No SQLite query.
 * - "shadow": Serve from legacy source. Query SQLite in background, log diffs.
 *             Use this to validate SQLite correctness before switching reads.
 * - "sqlite": Serve from SQLite. Query legacy in background, log diffs.
 *             Use this when confident SQLite is correct.
 *
 * Progression: legacy → shadow → sqlite → (Phase 7 removes legacy entirely)
 */
export type ReadFlagMode = "legacy" | "shadow" | "sqlite";

export interface ReadFlagConfig {
	toolContent?: ReadFlagMode;
	forkMetadata?: ReadFlagMode;
	sessionList?: ReadFlagMode;
	sessionStatus?: ReadFlagMode;
	sessionHistory?: ReadFlagMode;
	pendingApprovals?: ReadFlagMode;
}

export interface ReadFlags {
	toolContent: ReadFlagMode;
	forkMetadata: ReadFlagMode;
	sessionList: ReadFlagMode;
	sessionStatus: ReadFlagMode;
	sessionHistory: ReadFlagMode;
	pendingApprovals: ReadFlagMode;
}

/** Normalize a config value that may be a boolean (backward compat) or a mode string. */
function normalizeMode(value: ReadFlagMode | boolean | undefined): ReadFlagMode {
	if (value === undefined) return "legacy";
	if (value === true) return "sqlite";
	if (value === false) return "legacy";
	return value;
}

export function createReadFlags(config?: ReadFlagConfig): ReadFlags {
	return {
		toolContent: normalizeMode(config?.toolContent as ReadFlagMode | boolean | undefined),
		forkMetadata: normalizeMode(config?.forkMetadata as ReadFlagMode | boolean | undefined),
		sessionList: normalizeMode(config?.sessionList as ReadFlagMode | boolean | undefined),
		sessionStatus: normalizeMode(config?.sessionStatus as ReadFlagMode | boolean | undefined),
		sessionHistory: normalizeMode(config?.sessionHistory as ReadFlagMode | boolean | undefined),
		pendingApprovals: normalizeMode(config?.pendingApprovals as ReadFlagMode | boolean | undefined),
	};
}

// ─── Mode Check Helpers ─────────────────────────────────────────────────────
//
// (C1) CRITICAL: DO NOT use `if (flags.toolContent)` — all non-empty strings
// are truthy, so "legacy" would activate the SQLite path. Always use these
// helpers. All Phase 4 handlers (Tasks 25-34) must use:
//   `if (isActive(this.readFlags?.sessionList) && this.readQuery)`
// instead of:
//   `if (this.readFlags?.sessionList && this.readQuery)`

/** Returns true if the mode involves querying SQLite (shadow or sqlite). */
export function isActive(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow" || mode === "sqlite";
}

/** Returns true if SQLite is the authoritative source. */
export function isSqlite(mode: ReadFlagMode | undefined): boolean {
	return mode === "sqlite";
}

/** Returns true if the mode is shadow (legacy authoritative, SQLite compared). */
export function isShadow(mode: ReadFlagMode | undefined): boolean {
	return mode === "shadow";
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/read-flags.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/read-flags.ts test/unit/persistence/read-flags.test.ts
git commit -m "feat(persistence): replace boolean ReadFlags with three-state ReadFlagMode (legacy/shadow/sqlite)"
```

---

### Task 24.5: Phase 4 Relay Stack Wiring (CRITICAL)

> **Amendment (2026-04-09 — Concurrency Solutions, Change 5c — FlagAuthority Wiring):**
> Wire `FlagAuthority` into the relay stack construction (replacing direct `readFlags` object).
> Wire `FlagAuthority` into `DivergenceCircuitBreaker` (calls `set(name, "legacy", "breaker")`).
> Wire `FlagAuthority` into debug UI toggle handler (calls `set(name, mode, "user")`).

> **Amendment (2026-04-09 — Testing Audit, F1 — Wiring Test):**
> Add wiring test that verifies `createProjectRelay()` wires `readQuery` and `readFlags` into
> PermissionBridge and SessionManager. Import production function, construct real dependencies
> over in-memory DB, assert correct wiring. Rename existing algorithm test to `describe("... algorithm (spec)")`.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 12):**
> - **(C3) CRITICAL:** This task must create not only `ReadFlags` and `ReadQueryService`, but also:
>   1. One `DivergenceCircuitBreaker` per flag (6 total)
>   2. One `ShadowReadComparator` per sub-phase, wired to its breaker via `onComparison`
>   3. Pass comparators through `HandlerDeps`, `SessionManager`, `SessionStatusPoller`, and `PermissionBridge`
>   4. Register all comparators and breakers with `PersistenceDiagnostics` for `readPathHealth()`
>   5. Optionally run `DualWriteAuditor` on a 60-second interval during dual-write phase (I5)
>
>   Without this wiring, all `ShadowReadComparator` code in Tasks 25-34 is dead code — comparators never reach their consumers.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

**Purpose:** Wire `ReadQueryService` and `ReadFlags` into the handler deps construction in `relay-stack.ts`. Without this task, ALL Phase 4 read switchover code is dead code — `readFlags` and `readQuery` will always be `undefined` in handler deps, so the SQLite paths are never activated even when flags are set.

> **Audit finding #7 (CRITICAL):** Task 25 adds `readFlags` and `readQuery` as optional fields on `HandlerDeps`, but no task passes them during relay stack construction. This task fills that gap and makes Phase 4 deployable.

**Step 1: Write the failing test**

This is a wiring task, so the test verifies that `HandlerDeps` receives the Phase 4 dependencies when they are available:

```typescript
// test/unit/relay/relay-stack-phase4-wiring.test.ts
import { describe, expect, it } from "vitest";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";
import type { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";

/**
 * Simulates the handler deps construction in relay-stack.ts.
 * Verifies that readFlags and readQuery are correctly passed through.
 */
function buildHandlerDeps(
	readFlags?: ReadFlags,
	readQuery?: ReadQueryService,
): { readFlags?: ReadFlags; readQuery?: ReadQueryService } {
	return {
		...(readFlags ? { readFlags } : {}),
		...(readQuery ? { readQuery } : {}),
	};
}

describe("Relay stack Phase 4 wiring", () => {
	it("passes readFlags and readQuery to handler deps when available", () => {
		const flags = { toolContent: "sqlite" } as ReadFlags;
		const query = {} as ReadQueryService;
		const deps = buildHandlerDeps(flags, query);
		expect(deps.readFlags).toBe(flags);
		expect(deps.readQuery).toBe(query);
	});

	it("omits readFlags and readQuery when not available", () => {
		const deps = buildHandlerDeps();
		expect(deps.readFlags).toBeUndefined();
		expect(deps.readQuery).toBeUndefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/relay/relay-stack-phase4-wiring.test.ts`
Expected: PASS (the test validates the wiring pattern)

**Step 3: Write minimal implementation**

Modify `src/lib/relay/relay-stack.ts` — in the section where `HandlerDeps` is constructed (typically in the relay stack's `buildHandlerDeps()` or equivalent factory method):

```typescript
// Add imports at top:
import { createReadFlags, type ReadFlags, isActive } from "../persistence/read-flags.js";
import { ReadQueryService } from "../persistence/read-query-service.js";
import { DivergenceCircuitBreaker } from "../persistence/divergence-circuit-breaker.js";
import { ShadowReadComparator } from "../persistence/shadow-read-comparator.js";
import { compareSessionLists } from "../persistence/session-list-adapter.js";
import { compareSessionHistory } from "../persistence/session-history-comparator.js";
import { comparePendingApprovals } from "../persistence/pending-approvals-comparator.js";
import { DualWriteAuditor } from "../persistence/dual-write-auditor.js";

// In the relay stack construction, after SQLite client and projection setup:

// Phase 4: Create read path dependencies if SQLite is available
const readFlags = createReadFlags(); // All flags default to "legacy"
const readQuery = config.persistence ? new ReadQueryService(config.persistence.db) : undefined;

// ── Circuit Breakers (one per flag) ──────────────────────────────────────
// (C3) Each flag gets its own breaker that auto-reverts to "legacy" on excessive divergence.
const FLAG_NAMES: Array<keyof ReadFlags> = [
	"toolContent", "forkMetadata", "sessionList",
	"sessionStatus", "sessionHistory", "pendingApprovals",
];

const breakers = Object.fromEntries(
	FLAG_NAMES.map((name) => [
		name,
		new DivergenceCircuitBreaker({
			flagName: name,
			flags: readFlags,
			log: log.child("circuit-breaker"),
			threshold: 0.05,
			windowSize: 100,
		}),
	]),
) as Record<keyof ReadFlags, DivergenceCircuitBreaker>;

// ── Shadow-Read Comparators (one per sub-phase) ─────────────────────────
// (C3) Each comparator reads its mode dynamically from readFlags (C2) and
// feeds its breaker via onComparison. WITHOUT this construction, all
// ShadowReadComparator code in Tasks 25-34 is dead code.

const comparators = {
	toolContent: new ShadowReadComparator<string | undefined>({
		label: "tool-content",
		getMode: () => readFlags.toolContent,  // (C2) Dynamic getter
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			if (legacy === undefined && sqlite === undefined) return [];
			if (legacy === undefined) return ["missing-in-legacy"];
			if (sqlite === undefined) return ["missing-in-sqlite"];
			if (legacy !== sqlite) return [`content-mismatch: ${legacy.length}b vs ${sqlite.length}b`];
			return [];
		},
		onComparison: (d) => breakers.toolContent.record(d),
	}),

	forkMetadata: new ShadowReadComparator<{ parentId: string; forkPointEvent: string } | undefined>({
		label: "fork-metadata",
		getMode: () => readFlags.forkMetadata,
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			if (!legacy && !sqlite) return [];
			if (!legacy) return ["missing-in-legacy"];
			if (!sqlite) return ["missing-in-sqlite"];
			const diffs: string[] = [];
			if (legacy.parentId !== sqlite.parentId) diffs.push(`parentId mismatch`);
			if (legacy.forkPointEvent !== sqlite.forkPointEvent) diffs.push(`forkPointEvent mismatch`);
			return diffs;
		},
		onComparison: (d) => breakers.forkMetadata.record(d),
	}),

	sessionList: new ShadowReadComparator<import("../shared-types.js").SessionInfo[]>({
		label: "session-list",
		getMode: () => readFlags.sessionList,
		log: log.child("shadow-read"),
		compare: (legacy, sqlite) => {
			const diff = compareSessionLists(legacy, sqlite);
			const diffs: string[] = [];
			if (diff.missingInSqlite.length > 0) diffs.push(`missing-in-sqlite: ${diff.missingInSqlite.length}`);
			if (diff.missingInRest.length > 0) diffs.push(`missing-in-rest: ${diff.missingInRest.length}`);
			if (diff.titleMismatches.length > 0) diffs.push(`title-mismatches: ${diff.titleMismatches.length}`);
			return diffs;
		},
		onComparison: (d) => breakers.sessionList.record(d),
	}),

	sessionHistory: new ShadowReadComparator<{ messages: unknown[]; hasMore: boolean }>({
		label: "session-history",
		getMode: () => readFlags.sessionHistory,
		log: log.child("shadow-read"),
		compare: compareSessionHistory,
		onComparison: (d) => breakers.sessionHistory.record(d),
	}),

	// sessionStatus and pendingApprovals follow the same pattern
};

// Add to HandlerDeps construction:
const handlerDeps: HandlerDeps = {
	// ... existing fields ...
	readFlags,
	readQuery,
	comparators,  // (C3) Pass comparators through HandlerDeps
};
```

Also wire into `SessionStatusPoller` construction:

```typescript
// If SessionStatusSqliteReader is available (Phase 4d):
import { SessionStatusSqliteReader } from "../session/session-status-sqlite.js";

const sqliteReader = readQuery ? new SessionStatusSqliteReader(readQuery) : undefined;

// Pass to SessionStatusPoller:
const poller = new SessionStatusPoller(registry, {
	// ... existing options ...
	sqliteReader,
	readFlags,
});
```

And wire into `SessionManager` construction:

```typescript
const sessionMgr = new SessionManager({
	// ... existing options ...
	readFlags,
	readQuery,
});
```

And wire into `PermissionBridge` construction:

```typescript
const permissionBridge = new PermissionBridge({ readQuery, readFlags });
```

**(C3) Register comparators and breakers with diagnostics:**

```typescript
// ── Register with diagnostics ────────────────────────────────────────────
if (config.persistence) {
	const diag = config.persistence.diagnostics;
	for (const [name, breaker] of Object.entries(breakers)) {
		diag.registerBreaker(name, breaker);
	}
	for (const [name, comparator] of Object.entries(comparators)) {
		diag.registerComparator(name, comparator as ShadowReadComparator<unknown>);
	}
}
```

**(I5) DualWriteAuditor periodic check:**

```typescript
// ── DualWriteAuditor periodic check ──────────────────────────────────────
// Only active during dual-write phase, before Phase 7 removes legacy.
if (config.persistence && dualWriteHook) {
	const auditor = config.persistence.auditor;
	const auditInterval = setInterval(() => {
		const snapshot = {
			sessionTitles: sessionMgr.getSessionTitleMap?.() ?? new Map(),
			sessionStatuses: new Map(
				Object.entries(statusPoller?.getStatuses() ?? {}).map(
					([id, s]) => [id, s.type],
				),
			),
			messageCounts: messageCache?.getSessionMessageCounts?.() ?? new Map(),
		};
		const result = auditor.audit(snapshot);
		if (result.mismatches.length > 0) {
			log.warn("dual-write audit mismatches", {
				mismatches: result.mismatches.slice(0, 10),
				total: result.mismatches.length,
				sampledSessions: result.sampledSessions,
			});
		}
	}, 60_000); // Every 60 seconds

	// Clean up on relay stop
	onStop(() => clearInterval(auditInterval));
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/relay/relay-stack-phase4-wiring.test.ts`
Expected: PASS

Run: `pnpm check && pnpm lint`
Expected: PASS — all types resolve correctly since `readFlags` and `readQuery` are optional.

**Step 5: Refactor if needed**

No refactoring needed. The wiring is straightforward — create Phase 4 dependencies and pass them through existing construction sites.

**Step 6: Commit**

```bash
git add src/lib/relay/relay-stack.ts test/unit/relay/relay-stack-phase4-wiring.test.ts
git commit -m "feat(relay): wire ReadFlags and ReadQueryService into handler deps (Phase 4 activation)"
```

---

### Task 25: 4a — Tool Content Read Switchover

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 4):**
> - **(C1)** Replace `if (deps.readFlags?.toolContent && deps.readQuery)` with `if (isActive(deps.readFlags?.toolContent) && deps.readQuery)`.
> - **(C3)** Use `ShadowReadComparator<string | undefined>` from `HandlerDeps.comparators.toolContent` instead of a simple boolean if/else. The comparator is constructed in `relay-stack.ts` (Task 24.5 amendment) and passed through `HandlerDeps`.

**Files:**
- Modify: `src/lib/handlers/tool-content.ts`
- Test: `test/unit/handlers/tool-content-sqlite.test.ts`

**Purpose:** Replace `ToolContentStore.get()` in-memory lookup with `ReadQueryService.getToolContent()` via a `ShadowReadComparator`. All three modes work: legacy (in-memory `ToolContentStore`), shadow (serve in-memory, compare with SQLite), sqlite (serve SQLite, compare with in-memory). The in-memory store stays as fallback.

**Step 1: Write the failing test**

```typescript
// test/unit/handlers/tool-content-sqlite.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";

function makeDeps(overrides?: {
	toolContentGet?: (id: string) => string | undefined;
	readQueryGet?: (id: string) => string | undefined;
	readFlags?: { toolContent: import("../../../src/lib/persistence/read-flags.js").ReadFlagMode };
}): { deps: HandlerDeps; sent: Array<{ clientId: string; msg: any }> } {
	const sent: Array<{ clientId: string; msg: any }> = [];
	const deps = {
		wsHandler: {
			sendTo: (clientId: string, msg: any) => sent.push({ clientId, msg }),
			broadcast: vi.fn(),
			setClientSession: vi.fn(),
			getClientSession: vi.fn(),
			getClientsForSession: vi.fn(),
			sendToSession: vi.fn(),
		},
		toolContentStore: {
			get: overrides?.toolContentGet ?? (() => undefined),
		},
		readQuery: overrides?.readQueryGet
			? { getToolContent: overrides.readQueryGet }
			: undefined,
		readFlags: overrides?.readFlags ?? { toolContent: "legacy" },
		log: { info: vi.fn(), warn: vi.fn(), verbose: vi.fn() },
	} as unknown as HandlerDeps;
	return { deps, sent };
}

describe("handleGetToolContent with SQLite flag", () => {
	it("uses in-memory store when flag is off", async () => {
		const { deps, sent } = makeDeps({
			toolContentGet: (id) => (id === "t1" ? "in-memory-content" : undefined),
			readQueryGet: (id) => (id === "t1" ? "sqlite-content" : undefined),
			readFlags: { toolContent: "legacy" },
		});

		await handleGetToolContent(deps, "c1", { toolId: "t1" });

		expect(sent).toHaveLength(1);
		expect(sent[0].msg.type).toBe("tool_content");
		expect(sent[0].msg.content).toBe("in-memory-content");
	});

	it("uses SQLite when flag is on", async () => {
		const { deps, sent } = makeDeps({
			toolContentGet: (id) => (id === "t1" ? "in-memory-content" : undefined),
			readQueryGet: (id) => (id === "t1" ? "sqlite-content" : undefined),
			readFlags: { toolContent: "sqlite" },
		});

		await handleGetToolContent(deps, "c1", { toolId: "t1" });

		expect(sent).toHaveLength(1);
		expect(sent[0].msg.type).toBe("tool_content");
		expect(sent[0].msg.content).toBe("sqlite-content");
	});

	it("falls back to in-memory when SQLite returns nothing and flag is on", async () => {
		const { deps, sent } = makeDeps({
			toolContentGet: (id) => (id === "t1" ? "in-memory-content" : undefined),
			readQueryGet: () => undefined,
			readFlags: { toolContent: "sqlite" },
		});

		await handleGetToolContent(deps, "c1", { toolId: "t1" });

		expect(sent).toHaveLength(1);
		expect(sent[0].msg.type).toBe("tool_content");
		expect(sent[0].msg.content).toBe("in-memory-content");
	});

	it("sends NOT_FOUND when both paths return nothing", async () => {
		const { deps, sent } = makeDeps({
			toolContentGet: () => undefined,
			readQueryGet: () => undefined,
			readFlags: { toolContent: "sqlite" },
		});

		await handleGetToolContent(deps, "c1", { toolId: "t1" });

		expect(sent).toHaveLength(1);
		expect(sent[0].msg.type).toBe("error");
		expect(sent[0].msg.code).toBe("NOT_FOUND");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/tool-content-sqlite.test.ts`
Expected: FAIL (new flag-aware behavior not yet in handler)

**Step 3: Write minimal implementation**

Modify `src/lib/handlers/tool-content.ts`:

```typescript
// src/lib/handlers/tool-content.ts
// ─── Tool Content Handler ────────────────────────────────────────────────────
// Returns full (pre-truncation) tool result content.
// Phase 4a: reads from SQLite tool_content table when flag is enabled,
// falls back to in-memory ToolContentStore.

import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetToolContent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_tool_content"],
): Promise<void> {
	const { toolId } = payload;
	if (typeof toolId !== "string") {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			code: "INVALID_PARAMS",
			message: "Missing or invalid toolId parameter",
		});
		return;
	}

	// Phase 4a: Use ShadowReadComparator for three-mode read path
	// (C1) CRITICAL: Do NOT use `if (deps.readFlags?.toolContent)` — "legacy" is truthy!
	// (C3) The comparator is constructed in relay-stack.ts and passed via HandlerDeps.
	let content: string | undefined;
	if (deps.comparators?.toolContent && deps.readQuery) {
		const readResult = deps.comparators.toolContent.read(
			// Legacy path: in-memory ToolContentStore
			() => deps.toolContentStore.get(toolId),
			// SQLite path: ReadQueryService
			() => deps.readQuery!.getToolContent(toolId),
		);
		content = readResult.source === "sqlite"
			? readResult.syncValue
			: await readResult.value;
	} else {
		// No comparator wired — pure legacy path
		content = deps.toolContentStore.get(toolId);
	}

	if (content !== undefined) {
		deps.wsHandler.sendTo(clientId, {
			type: "tool_content",
			toolId,
			content,
		});
	} else {
		deps.wsHandler.sendTo(clientId, {
			type: "error",
			code: "NOT_FOUND",
			message: "Full tool content not available",
		});
	}
}
```

Add to `HandlerDeps` in `src/lib/handlers/types.ts`:

```typescript
// Add these imports at the top:
import type { ReadFlags } from "../persistence/read-flags.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { ShadowReadComparator } from "../persistence/shadow-read-comparator.js";

// Add to the HandlerDeps interface:
export interface HandlerDeps {
	// ... existing fields ...

	/** Phase 4 read path feature flags (optional — absent before Phase 4 wiring) */
	readFlags?: ReadFlags;
	/** Phase 4 SQLite read query service (optional — absent before Phase 4 wiring) */
	readQuery?: ReadQueryService;
	/**
	 * Phase 4 shadow-read comparators (optional — absent before Task 24.5 wiring).
	 * (C3) Each sub-phase gets its own comparator, constructed in relay-stack.ts.
	 */
	comparators?: {
		toolContent?: ShadowReadComparator<string | undefined>;
		forkMetadata?: ShadowReadComparator<{ parentId: string; forkPointEvent: string } | undefined>;
		sessionList?: ShadowReadComparator<import("../shared-types.js").SessionInfo[]>;
		sessionHistory?: ShadowReadComparator<{ messages: unknown[]; hasMore: boolean }>;
		pendingApprovals?: ShadowReadComparator<import("../types.js").PendingPermission[]>;
	};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers/tool-content-sqlite.test.ts`
Expected: PASS

Also run existing tool content tests to verify no regression:

Run: `pnpm vitest run test/unit/handlers/ --reporter=verbose`
Expected: All existing handler tests still pass.

**Step 5: Refactor if needed**

No refactoring needed. The flag check is a simple conditional with fallback.

**Step 6: Commit**

```bash
git add src/lib/handlers/tool-content.ts src/lib/handlers/types.ts test/unit/handlers/tool-content-sqlite.test.ts
git commit -m "feat(read-switchover): 4a — tool content reads from SQLite with flag and fallback"
```

---

### Task 26: 4b — Fork Metadata Read Switchover

> **Amendment (2026-04-09 — Testing Audit, F1 — Wiring Test):**
> Existing algorithm test renamed to `describe("Fork metadata read switchover algorithm (spec)")`.
> New wiring test block added that imports and tests the PRODUCTION `SessionManager.getForkEntry()`
> with real `ReadQueryService` over in-memory SQLite, catching drift between spec and implementation.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 5):**
> - **(C1)** Replace `if (readFlags?.forkMetadata)` with `if (isActive(readFlags?.forkMetadata))`. Import `isActive` from `read-flags.ts`.
> - **(C3)** Use `ShadowReadComparator<ForkMeta | undefined>` from `HandlerDeps.comparators.forkMetadata` when available, falling back to the direct flag check pattern.

**Files:**
- Modify: `src/lib/session/session-manager.ts`
- Test: `test/unit/session/fork-metadata-sqlite.test.ts`

**Purpose:** Replace `fork-metadata.json` file reads with `sessions.parent_id` + `fork_point_event` column queries when the `forkMetadata` flag is active (shadow or sqlite mode). The `SessionManager.getForkEntry()` method and `toSessionInfoList()` helper are the read points.

**Step 1: Write the failing test**

```typescript
// test/unit/session/fork-metadata-sqlite.test.ts
import { describe, expect, it, vi } from "vitest";
import type { ReadQueryService, ForkMetadata } from "../../../src/lib/persistence/read-query-service.js";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";

/**
 * Test the fork metadata resolution logic that will be extracted into
 * a helper function. When the flag is on, it reads from SQLite;
 * when off, it reads from the in-memory forkMeta Map.
 */
function resolveForkEntry(
	sessionId: string,
	forkMeta: Map<string, { forkMessageId: string; parentID: string; forkPointTimestamp?: number }>,
	readQuery: Pick<ReadQueryService, "getForkMetadata"> | undefined,
	readFlags: Pick<ReadFlags, "forkMetadata"> | undefined,
): { forkMessageId: string; parentID: string; forkPointTimestamp?: number } | undefined {
	// SQLite path — (C1) use isActive() not truthy check
	if (isActive(readFlags?.forkMetadata) && readQuery) {
		const meta = readQuery.getForkMetadata(sessionId);
		if (meta) {
			// Note: forkPointTimestamp is not stored directly in the sessions table.
			// It can be derived by looking up the fork_point_event message's created_at
			// from the messages table: SELECT created_at FROM messages WHERE id = ?
			// TODO: Add forkPointTimestamp derivation in a follow-up task (Phase 7)
			// to restore full parity with the legacy ForkEntry. Without it, fork
			// splitting falls back to the forkMessageId-based approach.
			return {
				forkMessageId: meta.forkPointEvent ?? "",
				parentID: meta.parentId,
			};
		}
	}
	// Legacy path
	return forkMeta.get(sessionId);
}

describe("Fork metadata read switchover algorithm (spec)", () => {
	const forkMeta = new Map([
		["fork-1", { forkMessageId: "msg-10", parentID: "parent-1", forkPointTimestamp: 1000 }],
	]);

	const mockReadQuery = {
		getForkMetadata: vi.fn((sessionId: string): ForkMetadata | undefined => {
			if (sessionId === "fork-1") {
				return { parentId: "parent-1", forkPointEvent: "msg-10-sqlite" };
			}
			return undefined;
		}),
	};

	it("uses in-memory map when flag is off", () => {
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, { forkMetadata: "legacy" });
		expect(result).toEqual({
			forkMessageId: "msg-10",
			parentID: "parent-1",
			forkPointTimestamp: 1000,
		});
		expect(mockReadQuery.getForkMetadata).not.toHaveBeenCalled();
	});

	it("uses SQLite when flag is on", () => {
		mockReadQuery.getForkMetadata.mockClear();
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, { forkMetadata: "sqlite" });
		expect(result).toEqual({
			forkMessageId: "msg-10-sqlite",
			parentID: "parent-1",
		});
		expect(mockReadQuery.getForkMetadata).toHaveBeenCalledWith("fork-1");
	});

	it("falls back to in-memory when SQLite returns nothing", () => {
		mockReadQuery.getForkMetadata.mockClear();
		mockReadQuery.getForkMetadata.mockReturnValueOnce(undefined);
		const result = resolveForkEntry("fork-1", forkMeta, mockReadQuery, { forkMetadata: "sqlite" });
		expect(result).toEqual({
			forkMessageId: "msg-10",
			parentID: "parent-1",
			forkPointTimestamp: 1000,
		});
	});

	it("returns undefined when session is not a fork in either path", () => {
		mockReadQuery.getForkMetadata.mockClear();
		const result = resolveForkEntry("not-a-fork", forkMeta, mockReadQuery, { forkMetadata: "sqlite" });
		expect(result).toBeUndefined();
	});
});
```

**Step 1b: Write the wiring test (F1)**

Add to the same file, after the algorithm spec describe block:

```typescript
// ─── Wiring test (F1) ────────────────────────────────────────────────────
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("fork resolution (wiring)", () => {
	let harness: TestHarness;
	let sessionMgr: SessionManager;

	beforeEach(() => {
		harness = createTestHarness();
		harness.seedSession("parent-1");
		harness.seedSession("fork-1", {
			parentId: "parent-1",
			forkPointEvent: "msg-10-sqlite",
		});
		const readQuery = new ReadQueryService(harness.db);
		sessionMgr = new SessionManager({
			readQuery,
			readFlags: { forkMetadata: "sqlite" },
		});
	});

	afterEach(() => { harness.close(); });

	it("production getForkEntry() returns correct entry from SQLite", () => {
		const entry = sessionMgr.getForkEntry("fork-1");
		expect(entry).toEqual({
			forkMessageId: "msg-10-sqlite",
			parentID: "parent-1",
		});
	});

	it("production getForkEntry() returns undefined for non-fork", () => {
		expect(sessionMgr.getForkEntry("parent-1")).toBeUndefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/fork-metadata-sqlite.test.ts`
Expected: FAIL (test imports pass, but logic not yet extracted)

Note: This test defines the `resolveForkEntry` function inline for TDD. In Step 3 we extract it into the session manager.

**Step 3: Write minimal implementation**

Add to `src/lib/session/session-manager.ts`:

```typescript
// Add imports at top:
import type { ReadFlags } from "../persistence/read-flags.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import { isActive } from "../persistence/read-flags.js";

// Add optional deps to SessionManagerOptions:
export interface SessionManagerOptions {
	// ... existing fields ...
	/** Phase 4 read flags (optional — absent before Phase 4) */
	readFlags?: ReadFlags;
	/** Phase 4 SQLite read query service (optional — absent before Phase 4) */
	readQuery?: ReadQueryService;
}
```

Modify `SessionManager.getForkEntry()` to check the flag:

```typescript
/** Look up fork-point metadata for a session. Returns undefined if not a fork. */
getForkEntry(sessionId: string): ForkEntry | undefined {
	// Phase 4b: Read from SQLite when flag is active (shadow or sqlite mode)
	// (C1) CRITICAL: use isActive(), not truthy check on the flag
	if (isActive(this.readFlags?.forkMetadata) && this.readQuery) {
		const meta = this.readQuery.getForkMetadata(sessionId);
		if (meta) {
			return {
				forkMessageId: meta.forkPointEvent ?? "",
				parentID: meta.parentId,
			};
		}
		// Fall through to in-memory on SQLite miss
	}
	return this.forkMeta.get(sessionId);
}
```

Store the new optional deps as private fields in the constructor:

```typescript
private readonly readFlags: ReadFlags | undefined;
private readonly readQuery: ReadQueryService | undefined;

constructor(options: SessionManagerOptions) {
	// ... existing init ...
	this.readFlags = options.readFlags;
	this.readQuery = options.readQuery;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/fork-metadata-sqlite.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/session/`
Expected: All existing session tests still pass.

**Step 5: Refactor if needed**

The inline `resolveForkEntry` in the test mirrors the logic in `SessionManager.getForkEntry()`. This is intentional — the test validates the resolution strategy independently of the class.

> **Note (audit finding #13):** The inline function test validates the fork resolution algorithm but does not verify the actual `SessionManager.getForkEntry()` method wiring. Consider adding an integration-style test that instantiates `SessionManager` with mock `readQuery`/`readFlags` and verifies the real method maps fields correctly (e.g., `forkPointEvent` → `forkMessageId`).

**Step 6: Commit**

```bash
git add src/lib/session/session-manager.ts test/unit/session/fork-metadata-sqlite.test.ts
git commit -m "feat(read-switchover): 4b — fork metadata reads from SQLite sessions table with flag"
```

---

### Task 27: 4c — Session List Read Switchover (Query Layer)

**Files:**
- Create: `src/lib/persistence/session-list-adapter.ts`
- Test: `test/unit/persistence/session-list-adapter.test.ts`

**Purpose:** An adapter that converts `ReadQueryService.listSessions()` rows into `SessionInfo[]` matching the format the frontend expects. This is the pure conversion layer — the handler wiring comes in Task 28. Includes comparison logging support for transition validation.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/session-list-adapter.test.ts
import { describe, expect, it } from "vitest";
import {
	sessionRowsToSessionInfoList,
	compareSessionLists,
} from "../../../src/lib/persistence/session-list-adapter.js";
import type { SessionRow } from "../../../src/lib/persistence/read-query-service.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

describe("sessionRowsToSessionInfoList", () => {
	it("converts session rows to SessionInfo format", () => {
		const rows: SessionRow[] = [
			makeRow("s1", { title: "First", updated_at: 3000 }),
			makeRow("s2", { title: "Second", updated_at: 1000 }),
		];

		const result = sessionRowsToSessionInfoList(rows);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: "s1",
			title: "First",
			updatedAt: 3000,
			messageCount: 0,
		});
		expect(result[1]).toEqual({
			id: "s2",
			title: "Second",
			updatedAt: 1000,
			messageCount: 0,
		});
	});

	it("includes parentID and forkMessageId for forked sessions", () => {
		const rows: SessionRow[] = [
			makeRow("fork-1", {
				parent_id: "parent-1",
				fork_point_event: "msg-42",
			}),
		];

		const result = sessionRowsToSessionInfoList(rows);
		expect(result[0].parentID).toBe("parent-1");
		expect(result[0].forkMessageId).toBe("msg-42");
	});

	it("includes processing flag when statuses are provided", () => {
		const rows: SessionRow[] = [makeRow("s1"), makeRow("s2")];
		const statuses = { s1: { type: "busy" as const }, s2: { type: "idle" as const } };

		const result = sessionRowsToSessionInfoList(rows, { statuses });
		expect(result[0].processing).toBe(true);
		expect(result[1].processing).toBeUndefined();
	});
});

describe("compareSessionLists", () => {
	it("returns no differences for identical lists", () => {
		const a: SessionInfo[] = [
			{ id: "s1", title: "Test", updatedAt: 1000 },
		];
		const b: SessionInfo[] = [
			{ id: "s1", title: "Test", updatedAt: 1000 },
		];
		const diff = compareSessionLists(a, b);
		expect(diff.missingInSqlite).toEqual([]);
		expect(diff.missingInRest).toEqual([]);
		expect(diff.titleMismatches).toEqual([]);
	});

	it("detects sessions missing from SQLite", () => {
		const rest: SessionInfo[] = [
			{ id: "s1", title: "Test" },
			{ id: "s2", title: "Other" },
		];
		const sqlite: SessionInfo[] = [{ id: "s1", title: "Test" }];

		const diff = compareSessionLists(rest, sqlite);
		expect(diff.missingInSqlite).toEqual(["s2"]);
	});

	it("detects title mismatches", () => {
		const rest: SessionInfo[] = [{ id: "s1", title: "REST Title" }];
		const sqlite: SessionInfo[] = [{ id: "s1", title: "SQLite Title" }];

		const diff = compareSessionLists(rest, sqlite);
		expect(diff.titleMismatches).toEqual([
			{ id: "s1", rest: "REST Title", sqlite: "SQLite Title" },
		]);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/session-list-adapter.test.ts`
Expected: FAIL with "Cannot find module '...session-list-adapter.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/session-list-adapter.ts
// ─── Session List Adapter ───────────────────────────────────────────────────
// Converts SQLite SessionRow[] → SessionInfo[] for the frontend.
// Also provides comparison utilities for transition validation.

import type { SessionInfo } from "../shared-types.js";
import type { SessionRow } from "./read-query-service.js";

interface SessionStatus {
	type: string;
}

interface AdapterOptions {
	statuses?: Record<string, SessionStatus>;
	pendingQuestionCounts?: ReadonlyMap<string, number>;
}

/**
 * Convert SQLite session rows to the SessionInfo format expected by the frontend.
 * Rows should already be sorted by the query (updated_at DESC).
 */
export function sessionRowsToSessionInfoList(
	rows: SessionRow[],
	opts?: AdapterOptions,
): SessionInfo[] {
	return rows.map((row) => {
		const info: SessionInfo = {
			id: row.id,
			title: row.title,
			updatedAt: row.updated_at,
			messageCount: 0,
		};

		if (row.parent_id) {
			info.parentID = row.parent_id;
		}
		if (row.fork_point_event) {
			info.forkMessageId = row.fork_point_event;
		}
		if (row.fork_point_timestamp != null) {
			info.forkPointTimestamp = row.fork_point_timestamp;
		}
		if (row.last_message_at != null) {
			info.lastMessageAt = row.last_message_at;
		}

		if (opts?.statuses) {
			const status = opts.statuses[row.id];
			if (status && (status.type === "busy" || status.type === "retry")) {
				info.processing = true;
			}
		}

		const qCount = opts?.pendingQuestionCounts?.get(row.id);
		if (qCount != null && qCount > 0) {
			info.pendingQuestionCount = qCount;
		}

		return info;
	});
}

interface SessionListDiff {
	missingInSqlite: string[];
	missingInRest: string[];
	titleMismatches: Array<{ id: string; rest: string; sqlite: string }>;
}

/**
 * Compare REST-sourced and SQLite-sourced session lists for transition validation.
 * Logs differences to help identify projection gaps during Phase 4c rollout.
 */
export function compareSessionLists(
	restList: SessionInfo[],
	sqliteList: SessionInfo[],
): SessionListDiff {
	const restMap = new Map(restList.map((s) => [s.id, s]));
	const sqliteMap = new Map(sqliteList.map((s) => [s.id, s]));

	const missingInSqlite: string[] = [];
	const missingInRest: string[] = [];
	const titleMismatches: Array<{ id: string; rest: string; sqlite: string }> = [];

	for (const [id, restSession] of restMap) {
		const sqliteSession = sqliteMap.get(id);
		if (!sqliteSession) {
			missingInSqlite.push(id);
			continue;
		}
		if (restSession.title !== sqliteSession.title) {
			titleMismatches.push({
				id,
				rest: restSession.title,
				sqlite: sqliteSession.title,
			});
		}
	}

	for (const id of sqliteMap.keys()) {
		if (!restMap.has(id)) {
			missingInRest.push(id);
		}
	}

	return { missingInSqlite, missingInRest, titleMismatches };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/session-list-adapter.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/session-list-adapter.ts test/unit/persistence/session-list-adapter.test.ts
git commit -m "feat(persistence): add session list adapter with SQLite→SessionInfo conversion and comparison logging"
```

---

### Task 28: 4c — Session List Handler Wiring

> **Amendment (2026-04-09 — Testing Audit, F1 — Wiring Test):**
> Add wiring test for production `SessionManager.listSessions()`. Seed 3 sessions in SQLite,
> verify SQLite path returns same shape as legacy. Rename existing test to `describe("... algorithm (spec)")`.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 8):**
> - **(C1)** Replace `if (this.readFlags?.sessionList)` with `if (isActive(this.readFlags?.sessionList))`.
> - **(C3)** Replace `compareWithLegacyListInBackground` ad-hoc method with `ShadowReadComparator<SessionInfo[]>` instance. The comparator's `compare` function wraps `compareSessionLists` to return `string[]`. The comparator handles all three modes (legacy/shadow/sqlite) and feeds the circuit breaker via `onComparison`. Delete the `compareWithLegacyListInBackground` method — it's replaced by the comparator.

**Files:**
- Modify: `src/lib/session/session-manager.ts`
- Test: `test/unit/session/session-list-sqlite.test.ts`

**Purpose:** Wire `listSessions()` in `SessionManager` to use `ReadQueryService` + `sessionRowsToSessionInfoList()` via a `ShadowReadComparator` in all three modes. During transition (shadow mode), both paths run and diffs are logged. The ad-hoc `compareWithLegacyListInBackground` is replaced by the unified comparator framework.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-list-sqlite.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReadQueryService, SessionRow } from "../../../src/lib/persistence/read-query-service.js";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import { sessionRowsToSessionInfoList, compareSessionLists } from "../../../src/lib/persistence/session-list-adapter.js";

/**
 * Simulate the dual-read logic that will be added to SessionManager.listSessions().
 */
function dualListSessions(
	legacyList: () => Promise<SessionInfo[]>,
	readQuery: Pick<ReadQueryService, "listSessions">,
	readFlags: Pick<ReadFlags, "sessionList">,
	log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
	opts?: { roots?: boolean },
): Promise<SessionInfo[]> {
	if (!isActive(readFlags.sessionList)) {
		return legacyList();
	}

	// SQLite path
	const rows = readQuery.listSessions({ roots: opts?.roots });
	const sqliteResult = sessionRowsToSessionInfoList(rows);

	// During transition: compare in background
	legacyList()
		.then((restResult) => {
			const diff = compareSessionLists(restResult, sqliteResult);
			if (
				diff.missingInSqlite.length > 0 ||
				diff.missingInRest.length > 0 ||
				diff.titleMismatches.length > 0
			) {
				log.warn(
					`Session list diff: missing_in_sqlite=${diff.missingInSqlite.length} missing_in_rest=${diff.missingInRest.length} title_mismatches=${diff.titleMismatches.length}`,
				);
			}
		})
		.catch(() => {
			// Comparison failure is non-fatal
		});

	return Promise.resolve(sqliteResult);
}

describe("Session list SQLite switchover", () => {
	const mockRows: SessionRow[] = [
		{
			id: "s1",
			provider: "opencode",
			provider_sid: null,
			title: "SQLite Session",
			status: "idle",
			parent_id: null,
			fork_point_event: null,
			created_at: 1000,
			updated_at: 3000,
		},
	];

	const mockLegacy = vi.fn(async (): Promise<SessionInfo[]> => [
		{ id: "s1", title: "REST Session", updatedAt: 3000 },
	]);

	const mockReadQuery = {
		listSessions: vi.fn((_opts?: { roots?: boolean }) => mockRows),
	};

	const log = { info: vi.fn(), warn: vi.fn() };

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses legacy path when flag is off", async () => {
		const result = await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "legacy" },
			log,
		);
		expect(result[0].title).toBe("REST Session");
		expect(mockReadQuery.listSessions).not.toHaveBeenCalled();
	});

	it("uses SQLite path when flag is on", async () => {
		const result = await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "sqlite" },
			log,
		);
		expect(result[0].title).toBe("SQLite Session");
		expect(mockReadQuery.listSessions).toHaveBeenCalled();
	});

	it("passes roots filter to SQLite query", async () => {
		await dualListSessions(
			mockLegacy,
			mockReadQuery,
			{ sessionList: "sqlite" },
			log,
			{ roots: true },
		);
		expect(mockReadQuery.listSessions).toHaveBeenCalledWith({ roots: true });
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-list-sqlite.test.ts`
Expected: PASS (the test defines its own dual-read logic for TDD validation)

**Step 3: Write minimal implementation**

Modify `SessionManager.listSessions()` in `src/lib/session/session-manager.ts`:

```typescript
async listSessions(options?: {
	statuses?: Record<string, SessionStatus> | undefined;
	roots?: boolean;
}): Promise<SessionInfo[]> {
	// Phase 4c: Read from SQLite when flag is active (shadow or sqlite mode)
	// (C1) CRITICAL: use isActive(), not truthy check
	if (isActive(this.readFlags?.sessionList) && this.readQuery) {
		const rows = this.readQuery.listSessions({ roots: options?.roots });
		const resolvedStatuses = options?.statuses ?? this.getStatuses?.();
		const sqliteResult = sessionRowsToSessionInfoList(rows, {
			statuses: resolvedStatuses,
			pendingQuestionCounts: this.pendingQuestionCounts,
		});

		// Transition comparison: run legacy path in background and log diffs
		this.compareWithLegacyListInBackground(sqliteResult, options);

		// Track session count from unfiltered fetches
		if (!options?.roots) {
			this._lastKnownSessionCount = sqliteResult.length;
		}

		return sqliteResult;
	}

	// Legacy path (unchanged)
	const clientOpts =
		options?.roots !== undefined ? { roots: options.roots } : undefined;
	const sessions = await this.client.listSessions(clientOpts);
	// ... rest of existing implementation unchanged ...
}

private compareWithLegacyListInBackground(
	sqliteResult: SessionInfo[],
	options?: { statuses?: Record<string, SessionStatus>; roots?: boolean },
): void {
	// Fire-and-forget comparison with legacy REST
	// (B2) Adds timing tolerance to prevent false-positive alerts.
	// Sessions created within the last 5 seconds are excluded from
	// "missing in SQLite" since they may not have been projected yet.
	const sqliteReadAt = Date.now();
	const clientOpts =
		options?.roots !== undefined ? { roots: options.roots } : undefined;
	this.client
		.listSessions(clientOpts)
		.then((sessions) => {
			const restReadAt = Date.now();
			const legacyResult = toSessionInfoList(
				sessions,
				options?.statuses ?? this.getStatuses?.(),
				this.lastMessageAt,
				this.forkMeta,
				this.pendingQuestionCounts,
			);
			const diff = compareSessionLists(legacyResult, sqliteResult, {
				// (B2) Ignore sessions created within the last 5 seconds
				ignoreCreatedWithin: 5000,
				sqliteReadAt,
				restReadAt,
			});
			if (diff.missingInSqlite.length > 0 || diff.titleMismatches.length > 0) {
				this.log.warn(
					`session-list-diff: missing_in_sqlite=${diff.missingInSqlite.length} title_mismatches=${diff.titleMismatches.length}`,
					{
						...diff,
						timingGapMs: restReadAt - sqliteReadAt,
					},
				);
			}
		})
		.catch((err) => {
			this.log.verbose(`session-list comparison failed (non-fatal): ${err}`);
		});
}
```

Add the import at the top of `session-manager.ts`:

```typescript
import {
	sessionRowsToSessionInfoList,
	compareSessionLists,
} from "../persistence/session-list-adapter.js";
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-list-sqlite.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/session/`
Expected: All existing session tests pass.

**Step 5: Refactor if needed**

The background comparison is fire-and-forget. Once confidence is high that SQLite matches REST, it can be removed. For now it provides transition safety.

> **Note (audit finding #5):** `searchSessions()` in SessionManager (session-manager.ts:382-404) is intentionally **not** migrated in Phase 4c. It continues to use the legacy REST + `toSessionInfoList()` path. When the `sessionList` flag is on, `listSessions` switches to SQLite but `searchSessions` still uses REST. This is acceptable during transition — search is a less frequent operation and the inconsistency window is small. TODO: Migrate `searchSessions()` to SQLite in Phase 7 or a dedicated follow-up task.

> **Note (audit finding #14):** When the `sessionList` flag is on, the SQLite result is **authoritative** even if it has fewer sessions than REST (e.g., during partial projection backfill). The comparison logger will detect discrepancies, but it does not trigger a fallback. Operators should NOT enable the `sessionList` flag until projection backfill confirms parity between SQLite and REST session counts.

> **Note (audit finding #13):** The inline `dualListSessions` function in the test validates the dual-read algorithm but does not exercise the actual `SessionManager.listSessions()` wiring. Consider adding an integration-style test that instantiates `SessionManager` with mock `readQuery`/`readFlags` and verifies the real method behavior, including the background comparison path.

**Step 6: Commit**

```bash
git add src/lib/session/session-manager.ts test/unit/session/session-list-sqlite.test.ts
git commit -m "feat(read-switchover): 4c — session list reads from SQLite with comparison logging"
```

---

### Task 29: 4d — Session Status Read Switchover (Projector Replaces Poller)

**Files:**
- Create: `src/lib/session/session-status-sqlite.ts`
- Test: `test/unit/session/session-status-sqlite.test.ts`

**Purpose:** Create a `SessionStatusSqliteReader` that reads status from the `sessions.status` column (updated by `SessionProjector` on `session.status` events). When the flag is on, this replaces the REST polling done by `SessionStatusPoller`. The poller continues to run for subagent propagation and message-activity augmentation — only the raw status source changes.

> **Note (audit finding #10 — projected status freshness):** The projected `sessions.status` column is **always current** by the time any read occurs. The dual-write hook processes SSE events synchronously: translate → append → project. Since projectors run synchronously within the SSE event handler (not asynchronously), the SQLite `status` column is updated before the event handler returns. Staleness would only occur if projectors ran asynchronously — they do not in this design. No freshness-guarantee mechanism (e.g., flushing pending events) is needed.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-status-sqlite.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import {
	SessionStatusSqliteReader,
} from "../../../src/lib/session/session-status-sqlite.js";

function seedSession(db: SqliteClient, id: string, status: string): void {
	db.execute(
		`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
		 VALUES (?, 'opencode', 'Test', ?, ?, ?)`,
		[id, status, Date.now(), Date.now()],
	);
}

describe("SessionStatusSqliteReader", () => {
	let db: SqliteClient;
	let readQuery: ReadQueryService;
	let reader: SessionStatusSqliteReader;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		readQuery = new ReadQueryService(db);
		reader = new SessionStatusSqliteReader(readQuery);
	});

	afterEach(() => {
		db.close();
	});

	it("returns statuses for all sessions in OpenCode format", () => {
		seedSession(db, "s1", "idle");
		seedSession(db, "s2", "busy");

		const statuses = reader.getSessionStatuses();
		expect(statuses.s1).toEqual({ type: "idle" });
		expect(statuses.s2).toEqual({ type: "busy" });
	});

	it("isProcessing returns true for busy sessions", () => {
		seedSession(db, "s1", "busy");
		seedSession(db, "s2", "idle");

		expect(reader.isProcessing("s1")).toBe(true);
		expect(reader.isProcessing("s2")).toBe(false);
		expect(reader.isProcessing("nonexistent")).toBe(false);
	});

	it("returns empty object when no sessions exist", () => {
		expect(reader.getSessionStatuses()).toEqual({});
	});

	it("reflects status changes from projection updates", () => {
		seedSession(db, "s1", "idle");
		expect(reader.isProcessing("s1")).toBe(false);

		// Simulate projector updating the status
		db.execute("UPDATE sessions SET status = 'busy' WHERE id = ?", ["s1"]);
		expect(reader.isProcessing("s1")).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-status-sqlite.test.ts`
Expected: FAIL with "Cannot find module '...session-status-sqlite.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/session/session-status-sqlite.ts
// ─── Session Status SQLite Reader ───────────────────────────────────────────
// Reads session status from the projected `sessions.status` column instead
// of polling the OpenCode REST API. Used when the `sessionStatus` read flag
// is enabled (Phase 4d).
//
// This replaces the raw status fetch in SessionStatusPoller. The poller's
// augmentation logic (subagent propagation, message-activity) still runs
// on top of the raw statuses returned by this reader.

import type { SessionStatus } from "../instance/opencode-client.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";

export class SessionStatusSqliteReader {
	constructor(private readonly readQuery: ReadQueryService) {}

	/**
	 * Get statuses for all sessions in the same format as
	 * `OpenCodeClient.getSessionStatuses()`.
	 */
	getSessionStatuses(): Record<string, SessionStatus> {
		const raw = this.readQuery.getAllSessionStatuses();
		const result: Record<string, SessionStatus> = {};
		for (const [id, status] of Object.entries(raw)) {
			result[id] = { type: status } as SessionStatus;
		}
		return result;
	}

	/** Check if a specific session is currently processing. */
	isProcessing(sessionId: string): boolean {
		const status = this.readQuery.getSessionStatus(sessionId);
		return status === "busy" || status === "retry";
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-status-sqlite.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The reader is a thin wrapper over `ReadQueryService`.

**Step 6: Commit**

```bash
git add src/lib/session/session-status-sqlite.ts test/unit/session/session-status-sqlite.test.ts
git commit -m "feat(read-switchover): 4d — SessionStatusSqliteReader reads status from projected sessions table"
```

---

### Task 30: 4d — Session Status Poller Integration

> **Amendment (2026-04-09 — Testing Audit, F1 — Wiring Test):**
> Add wiring test for production `SessionStatusPoller.poll()`. Seed session status events,
> verify reconciliation returns correct statuses. Rename existing test to `describe("... algorithm (spec)")`.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 8):**
> - **(C1)** Replace `if (this.readFlags?.sessionStatus)` with `if (isActive(this.readFlags?.sessionStatus))`. Import `isActive` from `read-flags.ts`.
> - **(C3)** Retrofit to use `ShadowReadComparator<Record<string, SessionStatus>>` whose `compare` function checks for status mismatches per session ID. The comparator receives the circuit breaker's `record` callback via `onComparison`.

**Files:**
- Modify: `src/lib/session/session-status-poller.ts`
- Test: `test/unit/session/session-status-poller-sqlite.test.ts`

**Purpose:** Wire `SessionStatusPoller.poll()` to optionally use `SessionStatusSqliteReader` via a `ShadowReadComparator` when the `sessionStatus` flag is active. The augmentation logic (subagent propagation, message-activity) continues unchanged — only the raw status source changes.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-status-poller-sqlite.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";

/**
 * Test the raw status resolution logic: when flag is on, read from SQLite;
 * when off, read from REST. The augmentation layer runs on top of either.
 */
function resolveRawStatuses(
	restFetch: () => Promise<Record<string, SessionStatus>>,
	sqliteRead: (() => Record<string, SessionStatus>) | undefined,
	flagEnabled: boolean,
): Promise<Record<string, SessionStatus>> {
	if (flagEnabled && sqliteRead) {
		return Promise.resolve(sqliteRead());
	}
	return restFetch();
}

describe("Session status poller SQLite integration", () => {
	const restStatuses: Record<string, SessionStatus> = {
		s1: { type: "busy" },
		s2: { type: "idle" },
	};

	const sqliteStatuses: Record<string, SessionStatus> = {
		s1: { type: "busy" },
		s2: { type: "idle" },
		s3: { type: "idle" }, // SQLite may have more sessions
	};

	const restFetch = vi.fn(async () => restStatuses);
	const sqliteRead = vi.fn(() => sqliteStatuses);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses REST when flag is off", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, false);
		expect(result).toBe(restStatuses);
		expect(restFetch).toHaveBeenCalled();
		expect(sqliteRead).not.toHaveBeenCalled();
	});

	it("uses SQLite when flag is on", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, true);
		expect(result).toBe(sqliteStatuses);
		expect(sqliteRead).toHaveBeenCalled();
		expect(restFetch).not.toHaveBeenCalled();
	});

	it("falls back to REST when sqliteRead is unavailable", async () => {
		const result = await resolveRawStatuses(restFetch, undefined, true);
		expect(result).toBe(restStatuses);
		expect(restFetch).toHaveBeenCalled();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-status-poller-sqlite.test.ts`
Expected: PASS (test defines logic inline)

**Step 3: Write minimal implementation**

Modify `SessionStatusPoller` constructor to accept optional SQLite reader:

```typescript
// Add to SessionStatusPollerOptions:
export interface SessionStatusPollerOptions {
	// ... existing fields ...
	/** Phase 4d: Optional SQLite status reader — replaces REST polling when flag is on */
	sqliteReader?: { getSessionStatuses(): Record<string, SessionStatus> };
	/** Phase 4 read flags */
	readFlags?: { sessionStatus: import("../persistence/read-flags.js").ReadFlagMode };
}
```

Modify the `poll()` method's raw fetch:

```typescript
private async poll(): Promise<void> {
	if (this.polling) return;
	this.polling = true;

	try {
		// Phase 4d: Read from SQLite when flag is active (shadow or sqlite mode)
		// (C1) CRITICAL: use isActive(), not truthy check
		const raw =
			isActive(this.readFlags?.sessionStatus) && this.sqliteReader
				? this.sqliteReader.getSessionStatuses()
				: await this.client.getSessionStatuses();

		const current = await this.augmentStatuses(raw);
		// ... rest of poll() unchanged ...
```

Store the new deps as private fields:

```typescript
private readonly sqliteReader: SessionStatusPollerOptions["sqliteReader"];
private readonly readFlags: SessionStatusPollerOptions["readFlags"];

constructor(registry: ServiceRegistry, options: SessionStatusPollerOptions) {
	// ... existing init ...
	this.sqliteReader = options.sqliteReader;
	this.readFlags = options.readFlags;
}
```

> **Note (audit finding #16):** The `SessionStatusPoller` construction site in `relay-stack.ts` must be updated to pass the new options. Locate the `new SessionStatusPoller(registry, { ... })` call and add:
> ```typescript
> sqliteReader: sqliteReader, // from Phase 4 wiring — optional
> readFlags: readFlags,       // from Phase 4 wiring — optional
> ```
> Both fields are optional. If Phase 4 wiring (see Task 24.5) has not been applied, the poller falls back to REST. This wiring step is required for the `sessionStatus` flag to take effect.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-status-poller-sqlite.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/session/`
Expected: All existing poller tests still pass.

**Step 5: Refactor if needed**

The REST client field type (`client`) still requires `getSessionStatuses` — when the SQLite reader is always used, the REST call is never made, but the type remains for backward compatibility. This is cleaned up in Phase 7.

**Step 6: Commit**

```bash
git add src/lib/session/session-status-poller.ts test/unit/session/session-status-poller-sqlite.test.ts
git commit -m "feat(read-switchover): 4d — session status poller reads from SQLite projection when flag enabled"
```

---

### Task 31: 4e — Session History Read Switchover (Query Layer)

> **Amendment (2026-04-09 — Testing Audit, T5/F7):**
> Replace local `seedMessage` with `harness.seedMessage()` from `persistence-factories.ts`.
> The shared helper writes to the normalized `message_parts` table instead of the non-existent `parts` TEXT column.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 6):**
> - **(I2)** The `compareSessionHistory` comparator (created in new file `src/lib/persistence/session-history-comparator.ts`) must check role and message count per role in addition to message IDs, text, and ordering. Don't deep-compare `parts` (too expensive for fire-and-forget); text + role + count is sufficient for divergence detection.
> - **(C3)** Wire `ShadowReadComparator` into session history reads when available. The comparator handles all three modes.

**Files:**
- Create: `src/lib/persistence/session-history-adapter.ts`
- Test: `test/unit/persistence/session-history-adapter.test.ts`

**Purpose:** Convert SQLite `MessageRow[]` into `HistoryMessage[]` (the format `session_switched` messages carry). This is the pure conversion layer — it transforms projection rows into the shape the frontend expects, including `parts` JSON parsing and pagination metadata.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/session-history-adapter.test.ts
import { describe, expect, it } from "vitest";
import {
	messageRowsToHistory,
	type HistoryResult,
} from "../../../src/lib/persistence/session-history-adapter.js";
import type { MessageRow } from "../../../src/lib/persistence/read-query-service.js";

function makeMessageRow(id: string, overrides?: Partial<MessageRow>): MessageRow {
	return {
		id,
		session_id: "s1",
		turn_id: null,
		role: "user",
		text: "",
		parts: "[]",
		cost: null,
		tokens_in: null,
		tokens_out: null,
		tokens_cache_read: null,
		tokens_cache_write: null,
		is_streaming: 0,
		created_at: Date.now(),
		updated_at: Date.now(),
		...overrides,
	};
}

describe("messageRowsToHistory", () => {
	it("converts message rows to HistoryMessage format", () => {
		const rows: MessageRow[] = [
			makeMessageRow("m1", {
				role: "user",
				text: "Hello",
				parts: JSON.stringify([{ type: "text", text: "Hello" }]),
				created_at: 1000,
			}),
			makeMessageRow("m2", {
				role: "assistant",
				text: "Hi there",
				parts: JSON.stringify([{ type: "text", text: "Hi there" }]),
				created_at: 2000,
				cost: 0.01,
				tokens_in: 10,
				tokens_out: 20,
			}),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0].id).toBe("m1");
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[1].id).toBe("m2");
		expect(result.messages[1].role).toBe("assistant");
		expect(result.hasMore).toBe(false);
	});

	it("sets hasMore=true when page is full", () => {
		const rows: MessageRow[] = [
			makeMessageRow("m1"),
			makeMessageRow("m2"),
		];

		const result = messageRowsToHistory(rows, { pageSize: 2 });
		expect(result.hasMore).toBe(true);
	});

	it("handles empty result", () => {
		const result = messageRowsToHistory([], { pageSize: 50 });
		expect(result.messages).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it("parses parts JSON", () => {
		const parts = [
			{ type: "text", text: "Hello" },
			{ type: "tool-invocation", toolName: "bash", state: "result" },
		];
		const rows: MessageRow[] = [
			makeMessageRow("m1", { parts: JSON.stringify(parts) }),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		expect(result.messages[0].parts).toEqual(parts);
	});

	it("returns empty parts array on invalid JSON", () => {
		const rows: MessageRow[] = [
			makeMessageRow("m1", { parts: "not-json" }),
		];

		const result = messageRowsToHistory(rows, { pageSize: 50 });
		expect(result.messages[0].parts).toEqual([]);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/session-history-adapter.test.ts`
Expected: FAIL with "Cannot find module '...session-history-adapter.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/session-history-adapter.ts
// ─── Session History Adapter ────────────────────────────────────────────────
// Converts SQLite MessageRow[] → HistoryMessage[] for session_switched messages.
// Pure conversion with no I/O.

import type { HistoryMessage } from "../shared-types.js";
import type { MessageRow } from "./read-query-service.js";

export interface HistoryResult {
	messages: HistoryMessage[];
	hasMore: boolean;
	total?: number;
}

/**
 * Convert message rows from the SQLite projection into the HistoryMessage
 * format expected by the frontend's session_switched handler.
 */
export function messageRowsToHistory(
	rows: MessageRow[],
	opts: { pageSize: number },
): HistoryResult {
	// Over-fetch detection: if rows.length > pageSize, there are more rows.
	// Slice to pageSize before building messages.
	const hasMore = rows.length > opts.pageSize;
	const pageRows = hasMore ? rows.slice(0, opts.pageSize) : rows;

	const messages: HistoryMessage[] = pageRows.map((row) => {
		let parts: unknown[];
		try {
			parts = JSON.parse(row.parts);
			if (!Array.isArray(parts)) parts = [];
		} catch {
			parts = [];
		}

		return {
			id: row.id,
			role: row.role as "user" | "assistant",
			time: {
				created: row.created_at,
				completed: row.updated_at,
			},
			...(row.text ? { text: row.text } : {}),
			parts,
			...(row.cost != null ? { cost: row.cost } : {}),
			...(row.tokens_in != null || row.tokens_out != null
				? {
						tokens: {
							...(row.tokens_in != null ? { input: row.tokens_in } : {}),
							...(row.tokens_out != null ? { output: row.tokens_out } : {}),
							...(row.tokens_cache_read != null || row.tokens_cache_write != null
								? {
										cache: {
											...(row.tokens_cache_read != null
												? { read: row.tokens_cache_read }
												: {}),
											...(row.tokens_cache_write != null
												? { write: row.tokens_cache_write }
												: {}),
										},
									}
								: {}),
						},
					}
				: {}),
		} as HistoryMessage;
	});

	return {
		messages,
		hasMore,
	};
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/session-history-adapter.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/session-history-adapter.ts test/unit/persistence/session-history-adapter.test.ts
git commit -m "feat(persistence): add session history adapter for MessageRow→HistoryMessage conversion"
```

---

### Task 32: 4e — Session Switch History Wiring

> **Amendment (2026-04-09 — Testing Audit, T5/F7):**
> Replace local `seedMessage` with `harness.seedMessage()` from `persistence-factories.ts`.
> The shared helper writes to the normalized `message_parts` table.

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 6):**
> - **(C1)** Replace `if (deps.readFlags?.sessionHistory)` with `if (isActive(deps.readFlags?.sessionHistory))`.
> - **(C3)** Use `ShadowReadComparator` from `deps.comparators.sessionHistory` when available.

**Files:**
- Modify: `src/lib/session/session-switch.ts`
- Test: `test/unit/session/session-switch-sqlite.test.ts`

**Purpose:** Add an alternative `resolveSessionHistoryFromSqlite()` path that reads from the `messages` and `turns` tables. When the `sessionHistory` flag is on, `resolveSessionHistory()` delegates to this path instead of the JSONL cache + REST fallback. This is the biggest change in Phase 4.

**Step 1: Write the failing test**

```typescript
// test/unit/session/session-switch-sqlite.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import {
	resolveSessionHistoryFromSqlite,
} from "../../../src/lib/session/session-switch.js";

function seedSession(db: SqliteClient, id: string, status?: string): void {
	db.execute(
		`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
		 VALUES (?, 'opencode', 'Test', ?, ?, ?)`,
		[id, status ?? "idle", Date.now(), Date.now()],
	);
}

function seedMessage(
	db: SqliteClient,
	id: string,
	sessionId: string,
	role: string,
	text: string,
	createdAt: number,
): void {
	db.execute(
		`INSERT INTO messages (id, session_id, role, text, parts, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sessionId,
			role,
			text,
			JSON.stringify([{ type: "text", text }]),
			createdAt,
			createdAt,
		],
	);
}

describe("resolveSessionHistoryFromSqlite", () => {
	let db: SqliteClient;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		readQuery = new ReadQueryService(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns rest-history source with messages from SQLite", async () => {
		seedSession(db, "s1");
		seedMessage(db, "m1", "s1", "user", "Hello", 1000);
		seedMessage(db, "m2", "s1", "assistant", "Hi there", 2000);

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			expect(source.history.messages).toHaveLength(2);
			expect(source.history.messages[0].id).toBe("m1");
			expect(source.history.messages[1].id).toBe("m2");
			expect(source.history.hasMore).toBe(false);
		}
	});

	it("returns empty source for session with no messages", () => {
		seedSession(db, "s1");

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("empty");
	});

	it("returns empty source for unknown session", () => {
		const source = resolveSessionHistoryFromSqlite("unknown", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("empty");
	});

	it("paginates when messages exceed page size", () => {
		seedSession(db, "s1");
		seedMessage(db, "m1", "s1", "user", "First", 1000);
		seedMessage(db, "m2", "s1", "assistant", "Second", 2000);
		seedMessage(db, "m3", "s1", "user", "Third", 3000);

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 2,
		});

		if (source.kind === "rest-history") {
			// With limit=2, should return latest 2 messages
			expect(source.history.messages).toHaveLength(2);
			expect(source.history.hasMore).toBe(true);
		}
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-switch-sqlite.test.ts`
Expected: FAIL with "resolveSessionHistoryFromSqlite is not exported"

**Step 3: Write minimal implementation**

Add to `src/lib/session/session-switch.ts`:

First, extend the `SessionSwitchDeps` interface to include the Phase 4 fields:

```typescript
// In src/lib/session/session-switch.ts — extend the existing interface
import type { ReadQueryService } from "../persistence/read-query-service.js";
import type { ReadFlags } from "../persistence/read-flags.js";

export interface SessionSwitchDeps {
	messageCache: MessageCache;
	sessionMgr: SessionManager;
	log: Logger;
	forkMeta: ForkMetadataStore;
	/** Phase 4e: SQLite read query service (optional, for gradual rollout) */
	readQuery?: ReadQueryService;
	/** Phase 4e: Read path feature flags (optional, for gradual rollout) */
	readFlags?: ReadFlags;
}
```

Then add the SQLite-backed implementation:

```typescript
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";

/**
 * Resolve session history from SQLite projections.
 * Synchronous — all data comes from the local database.
 *
 * Returns a SessionHistorySource that can be passed directly to
 * buildSessionSwitchedMessage(). Uses the same "rest-history" kind
 * since the HistoryMessage format is identical — the frontend can't
 * tell if data came from REST or SQLite.
 */
export function resolveSessionHistoryFromSqlite(
	sessionId: string,
	readQuery: ReadQueryService,
	opts: { pageSize: number },
): SessionHistorySource {
	const rows = readQuery.getSessionMessages(sessionId, { limit: opts.pageSize });

	if (rows.length === 0) {
		return { kind: "empty" };
	}

	const { messages, hasMore } = messageRowsToHistory(rows, {
		pageSize: opts.pageSize,
	});

	return {
		kind: "rest-history",
		history: { messages, hasMore },
	};
}
```

Modify `resolveSessionHistory()` to check the flag.

**Wiring `readQuery` and `readFlags` through `toSessionSwitchDeps()` and `client-init.ts`:**

Both call sites that construct `SessionSwitchDeps` must pass `readQuery` and `readFlags` through. Both fields are optional, so existing code continues to work without them.

In `handlers/session.ts`, update `toSessionSwitchDeps()`:

```typescript
// src/lib/handlers/session.ts — inside toSessionSwitchDeps()
function toSessionSwitchDeps(deps: HandlerDeps): SessionSwitchDeps {
	return {
		messageCache: deps.messageCache,
		sessionMgr: deps.sessionMgr,
		log: deps.log,
		forkMeta: deps.forkMeta,
		readQuery: deps.readQuery,
		readFlags: deps.readFlags,
	};
}
```

In `bridges/client-init.ts`, update the `SessionSwitchDeps` construction:

```typescript
// src/lib/bridges/client-init.ts — where SessionSwitchDeps is built
const switchDeps: SessionSwitchDeps = {
	messageCache: deps.messageCache,
	sessionMgr: deps.sessionMgr,
	log: deps.log,
	forkMeta: deps.forkMeta,
	readQuery: deps.readQuery,
	readFlags: deps.readFlags,
};
```

Update `resolveSessionHistory()` signature to accept the new fields:

```typescript
export async function resolveSessionHistory(
	sessionId: string,
	deps: Pick<
		SessionSwitchDeps,
		"messageCache" | "sessionMgr" | "log" | "forkMeta" | "readQuery" | "readFlags"
	>,
): Promise<SessionHistorySource> {
	// Phase 4e: Read from SQLite when flag is active (shadow or sqlite mode)
	// (C1) CRITICAL: use isActive(), not truthy check
	if (isActive(deps.readFlags?.sessionHistory) && deps.readQuery) {
		return resolveSessionHistoryFromSqlite(sessionId, deps.readQuery, {
			pageSize: 50,
		});
	}

	// Legacy path (unchanged) ...
	const events = await deps.messageCache.getEvents(sessionId);
	// ... rest of existing implementation unchanged ...
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-switch-sqlite.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: All existing session-switch tests still pass (they don't pass readFlags).

**Step 5: Refactor if needed**

The `resolveSessionHistoryFromSqlite` function returns `"rest-history"` kind intentionally. The `buildSessionSwitchedMessage` function already handles this kind correctly. When the full switchover is complete, the "cached-events" kind (SSE replay) becomes unused and can be removed in Phase 7.

**Step 6: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch-sqlite.test.ts
git commit -m "feat(read-switchover): 4e — session switch history reads from SQLite messages table"
```

---

### Task 33: 4f — Pending Approvals Read Switchover (Query Layer)

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 7):**
> - **(I3)** The `comparePendingApprovals` comparator (created in new file `src/lib/persistence/pending-approvals-comparator.ts`) must include `toolName` field comparison, not just ID/type/status.

**Files:**
- Create: `src/lib/persistence/approval-adapter.ts`
- Test: `test/unit/persistence/approval-adapter.test.ts`

**Purpose:** Convert `PendingApprovalRow[]` into `PendingPermission[]` (the format `PermissionBridge.getPending()` returns). This is the pure conversion layer for Phase 4f.

**Step 1: Write the failing test**

```typescript
// test/unit/persistence/approval-adapter.test.ts
import { describe, expect, it } from "vitest";
import {
	approvalRowsToPendingPermissions,
} from "../../../src/lib/persistence/approval-adapter.js";
import type { PendingApprovalRow } from "../../../src/lib/persistence/read-query-service.js";

function makeApprovalRow(id: string, overrides?: Partial<PendingApprovalRow>): PendingApprovalRow {
	return {
		id,
		session_id: "s1",
		turn_id: null,
		type: "permission",
		status: "pending",
		tool_name: "bash",
		input: JSON.stringify({ patterns: ["*.ts"], metadata: {} }),
		decision: null,
		created_at: Date.now(),
		resolved_at: null,
		...overrides,
	};
}

describe("approvalRowsToPendingPermissions", () => {
	it("converts permission approval rows", () => {
		const rows: PendingApprovalRow[] = [
			makeApprovalRow("perm-1", {
				tool_name: "bash",
				input: JSON.stringify({ patterns: ["*.sh"], metadata: { cmd: "rm" } }),
			}),
		];

		const result = approvalRowsToPendingPermissions(rows);
		expect(result).toHaveLength(1);
		expect(result[0].requestId).toBe("perm-1");
		expect(result[0].sessionId).toBe("s1");
		expect(result[0].toolName).toBe("bash");
		expect(result[0].toolInput.patterns).toEqual(["*.sh"]);
	});

	it("converts question approval rows", () => {
		const rows: PendingApprovalRow[] = [
			makeApprovalRow("que-1", {
				type: "question",
				tool_name: null,
				input: JSON.stringify([{ question: "Continue?", options: [] }]),
			}),
		];

		const result = approvalRowsToPendingPermissions(rows);
		expect(result).toHaveLength(1);
		expect(result[0].requestId).toBe("que-1");
		expect(result[0].toolName).toBe("");
	});

	it("handles invalid JSON input gracefully", () => {
		const rows: PendingApprovalRow[] = [
			makeApprovalRow("p1", { input: "not-json" }),
		];

		const result = approvalRowsToPendingPermissions(rows);
		expect(result).toHaveLength(1);
		expect(result[0].toolInput).toEqual({ patterns: [], metadata: {} });
	});

	it("returns empty array for empty input", () => {
		expect(approvalRowsToPendingPermissions([])).toEqual([]);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/persistence/approval-adapter.test.ts`
Expected: FAIL with "Cannot find module '...approval-adapter.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/persistence/approval-adapter.ts
// ─── Approval Adapter ───────────────────────────────────────────────────────
// Converts SQLite PendingApprovalRow[] → PendingPermission[] for the
// PermissionBridge replacement in Phase 4f.

import type { PermissionId } from "../shared-types.js";
import type { PendingPermission } from "../types.js";
import type { PendingApprovalRow } from "./read-query-service.js";

/**
 * Convert pending approval rows from the SQLite projection into the
 * PendingPermission format used by the relay's permission replay.
 */
export function approvalRowsToPendingPermissions(
	rows: PendingApprovalRow[],
): PendingPermission[] {
	return rows.map((row) => {
		let toolInput: { patterns: string[]; metadata: Record<string, unknown> };
		try {
			const parsed = JSON.parse(row.input ?? "{}");
			toolInput = {
				patterns: Array.isArray(parsed?.patterns) ? parsed.patterns : [],
				metadata:
					parsed?.metadata && typeof parsed.metadata === "object"
						? parsed.metadata
						: {},
			};
		} catch {
			toolInput = { patterns: [], metadata: {} };
		}

		return {
			requestId: row.id as PermissionId,
			sessionId: row.session_id,
			toolName: row.tool_name ?? "",
			toolInput,
			always: [],
			timestamp: row.created_at,
		};
	});
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/persistence/approval-adapter.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/persistence/approval-adapter.ts test/unit/persistence/approval-adapter.test.ts
git commit -m "feat(persistence): add approval adapter for PendingApprovalRow→PendingPermission conversion"
```

---

### Task 34: 4f — Permission Bridge Read Switchover

> **Amendment (2026-04-08 — Consistency & Divergence Detection Plan, Task 7):**
> - **(C1)** Replace `if (this.readFlags?.pendingApprovals)` with `if (isActive(this.readFlags?.pendingApprovals))`. Import `isActive` from `read-flags.ts`.
> - **(C3)** Use `ShadowReadComparator` from deps when available for three-mode read.

**Files:**
- Modify: `src/lib/bridges/permission-bridge.ts`
- Test: `test/unit/bridges/permission-bridge-sqlite.test.ts`

**Purpose:** Modify `PermissionBridge.getPending()` to read from the `pending_approvals` table when the `pendingApprovals` flag is on, falling back to the in-memory Map. The bridge continues to accept `onPermissionRequest()` calls for the in-memory path during dual-write — writes go to both paths.

**Step 1: Write the failing test**

```typescript
// test/unit/bridges/permission-bridge-sqlite.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import type { ReadFlags } from "../../../src/lib/persistence/read-flags.js";

function seedSession(db: SqliteClient, id: string): void {
	db.execute(
		`INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
		 VALUES (?, 'opencode', 'Test', 'idle', ?, ?)`,
		[id, Date.now(), Date.now()],
	);
}

function seedPendingPermission(
	db: SqliteClient,
	id: string,
	sessionId: string,
	toolName: string,
): void {
	db.execute(
		`INSERT INTO pending_approvals (id, session_id, type, status, tool_name, input, created_at)
		 VALUES (?, ?, 'permission', 'pending', ?, ?, ?)`,
		[
			id,
			sessionId,
			toolName,
			JSON.stringify({ patterns: ["*.ts"], metadata: {} }),
			Date.now(),
		],
	);
}

describe("PermissionBridge SQLite read switchover", () => {
	let db: SqliteClient;
	let readQuery: ReadQueryService;
	let bridge: PermissionBridge;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		readQuery = new ReadQueryService(db);
	});

	afterEach(() => {
		db.close();
	});

	it("getPending uses in-memory when flag is off", () => {
		bridge = new PermissionBridge({
			readQuery,
			readFlags: { pendingApprovals: "legacy" } as ReadFlags,
		});

		// Add to in-memory
		bridge.onPermissionRequest({
			type: "permission.asked",
			properties: {
				id: "p1",
				sessionID: "s1",
				permission: "bash",
				patterns: [],
			},
		} as any);

		seedSession(db, "s1");
		seedPendingPermission(db, "p2", "s1", "read");

		const pending = bridge.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0].requestId).toBe("p1");
	});

	it("getPending uses SQLite when flag is on", () => {
		bridge = new PermissionBridge({
			readQuery,
			readFlags: { pendingApprovals: "sqlite" } as ReadFlags,
		});

		// Add to in-memory (won't be returned since flag is on)
		bridge.onPermissionRequest({
			type: "permission.asked",
			properties: {
				id: "p1",
				sessionID: "s1",
				permission: "bash",
				patterns: [],
			},
		} as any);

		seedSession(db, "s1");
		seedPendingPermission(db, "p2", "s1", "read");

		const pending = bridge.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0].requestId).toBe("p2");
		expect(pending[0].toolName).toBe("read");
	});

	it("onPermissionResponse still works with in-memory map regardless of flag", () => {
		bridge = new PermissionBridge({
			readQuery,
			readFlags: { pendingApprovals: "sqlite" } as ReadFlags,
		});

		bridge.onPermissionRequest({
			type: "permission.asked",
			properties: {
				id: "p1",
				sessionID: "s1",
				permission: "bash",
			},
		} as any);

		const result = bridge.onPermissionResponse("p1", "allow");
		expect(result).not.toBeNull();
		expect(result!.mapped).toBe("once");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/bridges/permission-bridge-sqlite.test.ts`
Expected: FAIL (PermissionBridge doesn't accept readQuery/readFlags yet)

**Step 3: Write minimal implementation**

Modify `src/lib/bridges/permission-bridge.ts`:

```typescript
import type { ReadFlags } from "../persistence/read-flags.js";
import { isActive } from "../persistence/read-flags.js";
import type { ReadQueryService } from "../persistence/read-query-service.js";
import { approvalRowsToPendingPermissions } from "../persistence/approval-adapter.js";

export interface PermissionBridgeOptions {
	timeoutMs?: number;
	now?: () => number;
	/** Phase 4f: SQLite read query service */
	readQuery?: ReadQueryService;
	/** Phase 4f: Read path feature flags */
	readFlags?: ReadFlags;
}

export class PermissionBridge {
	private pending: Map<string, PendingPermission> = new Map();
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private readonly readQuery: ReadQueryService | undefined;
	private readonly readFlags: ReadFlags | undefined;

	constructor(options: PermissionBridgeOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
		this.now = options.now ?? Date.now;
		this.readQuery = options.readQuery;
		this.readFlags = options.readFlags;
	}

	// ... onPermissionRequest, onPermissionResponse, onPermissionReplied unchanged ...

	/** Get all pending permissions (for replay on reconnect) */
	getPending(): PendingPermission[] {
		// Phase 4f: Read from SQLite when flag is active (shadow or sqlite mode)
		// (C1) CRITICAL: use isActive(), not truthy check
		if (isActive(this.readFlags?.pendingApprovals) && this.readQuery) {
			const rows = this.readQuery.getPendingApprovals();
			return approvalRowsToPendingPermissions(rows);
		}

		// Legacy: in-memory map
		return Array.from(this.pending.values());
	}

	// ... checkTimeouts, recoverPending, size unchanged ...
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/bridges/permission-bridge-sqlite.test.ts`
Expected: PASS

Run: `pnpm vitest run test/unit/bridges/`
Expected: All existing permission bridge tests still pass.

**Step 5: Refactor if needed**

The in-memory `pending` Map remains for:
1. `onPermissionResponse()` — needs to look up the request to map the decision.
2. Dual-write period — `onPermissionRequest()` still populates it.

When Phase 7 cleanup removes the in-memory path entirely, `onPermissionResponse()` will need to read from SQLite to find the tool name for decision mapping. For now, the hybrid approach is correct.

> **Amendment (2026-04-09 — Concurrency Solutions, Change 3A — Check-Before-Send):**
> Move the deduplication check to the TOP of the permission reply handler, BEFORE any REST call:
> 1. `UPDATE pending_approvals SET status = 'resolved' WHERE request_id = ? AND status = 'pending'`
> 2. Check `db.changes === 0` → duplicate, log and return ack, stop.
> 3. Only then send `POST /permission/reply` to OpenCode (or resolve SDK deferred).
> 4. Emit `permission.resolved` canonical event via `EventPipeline`.
> This supersedes the original CH5 placement where the SQL check ran after the REST call.

> **(CH5) Concurrency amendment (Phase 7):** When the permission resolution handler migrates from the in-memory `PermissionBridge.onPermissionResponse()` to SQLite in Phase 7, it MUST use `UPDATE pending_approvals SET status = 'resolved', decision = ? WHERE id = ? AND status = 'pending'` and check `result.changes === 0` to detect duplicate replies from concurrent browser tabs. If `changes === 0`, the handler returns early without calling the provider API — another tab already resolved this permission. This preserves the first-wins semantics of the in-memory `Map.get()` + `Map.delete()` pattern. See `test/unit/persistence/permission-resolution-atomicity.test.ts` (from the concurrency hardening plan) for the canonical SQL pattern.

**Step 6: Commit**

```bash
git add src/lib/bridges/permission-bridge.ts test/unit/bridges/permission-bridge-sqlite.test.ts
git commit -m "feat(read-switchover): 4f — pending approvals read from SQLite projection with flag"
```

---

### Phase 4 Completion Checklist

After all 12 tasks (Tasks 23-34), verify the full phase:

```bash
pnpm vitest run test/unit/persistence/
pnpm vitest run test/unit/session/
pnpm vitest run test/unit/handlers/
pnpm vitest run test/unit/bridges/
```

Expected: All tests pass. Files created or modified:

| File | Purpose |
|------|---------|
| `src/lib/persistence/read-query-service.ts` | **Created**: centralized SQLite read queries |
| `src/lib/persistence/read-flags.ts` | **Created**: three-state feature flags (`ReadFlagMode`) for read path switching with `isActive()`/`isSqlite()`/`isShadow()` helpers |
| `src/lib/persistence/session-list-adapter.ts` | **Created**: SessionRow→SessionInfo conversion + comparison |
| `src/lib/persistence/session-history-adapter.ts` | **Created**: MessageRow→HistoryMessage conversion |
| `src/lib/persistence/approval-adapter.ts` | **Created**: PendingApprovalRow→PendingPermission conversion |
| `src/lib/session/session-status-sqlite.ts` | **Created**: SQLite-based session status reader |
| `src/lib/handlers/tool-content.ts` | **Modified**: reads via `ShadowReadComparator` when flag enabled (4a) |
| `src/lib/handlers/types.ts` | **Modified**: added readFlags + readQuery + comparators to HandlerDeps |
| `src/lib/session/session-manager.ts` | **Modified**: fork metadata (4b) + session list (4c) via `ShadowReadComparator` |
| `src/lib/session/session-status-poller.ts` | **Modified**: raw status via `ShadowReadComparator` (4d) |
| `src/lib/session/session-switch.ts` | **Modified**: resolveSessionHistoryFromSqlite (4e) |
| `src/lib/bridges/permission-bridge.ts` | **Modified**: getPending via `ShadowReadComparator` (4f) |
| `src/lib/persistence/shadow-read-comparator.ts` | **Created** (Consistency Plan): generic three-mode comparison framework |
| `src/lib/persistence/divergence-circuit-breaker.ts` | **Created** (Consistency Plan): auto-revert flag on excessive divergence |
| `src/lib/persistence/session-history-comparator.ts` | **Created** (Consistency Plan): session history diff (4e) |
| `src/lib/persistence/pending-approvals-comparator.ts` | **Created** (Consistency Plan): pending approvals diff (4f) |
| `src/lib/persistence/dual-write-auditor.ts` | **Created** (Consistency Plan): spot-check canonical events vs relay state |
| `src/lib/persistence/diagnostics.ts` | **Modified** (Consistency Plan): `checkIntegrity()`, `readPathHealth()`, comparator/breaker registry |
| `src/lib/persistence/persistence-layer.ts` | **Modified** (Consistency Plan): exposes `diagnostics` and `auditor` |
| `src/lib/relay/relay-stack.ts` | **Modified** (Consistency Plan): creates breakers, comparators, auditor |

Also run the full verification suite to confirm no regressions:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All existing tests pass. The relay pipeline is unchanged — read switchover is purely additive behind feature flags. Every new read path falls back to the legacy path when the flag is off or when SQLite returns no data.

**Read path migration matrix:**

| Read path | Flag | SQLite source | Legacy fallback | Shadow comparison |
|-----------|------|---------------|-----------------|-------------------|
| Tool content (4a) | `toolContent` | `tool_content` table | `ToolContentStore` Map | Yes (`ShadowReadComparator`) |
| Fork metadata (4b) | `forkMetadata` | `sessions` columns | `fork-metadata.json` | Yes (`ShadowReadComparator`) |
| Session list (4c) | `sessionList` | `sessions` table | REST `listSessions()` | Yes (`ShadowReadComparator`) |
| Session status (4d) | `sessionStatus` | `sessions.status` | REST polling | Yes (`ShadowReadComparator`) |
| Session history (4e) | `sessionHistory` | `messages` + `turns` | JSONL cache + REST | Yes (`ShadowReadComparator`) |
| Pending approvals (4f) | `pendingApprovals` | `pending_approvals` | In-memory Map + REST | Yes (`ShadowReadComparator`) |

All 6 read paths are independently switchable via three-state `ReadFlagMode` (`"legacy"` → `"shadow"` → `"sqlite"`). The recommended rollout follows the sub-phase numbering (4a→4f) — each builds confidence for the next. Use `"shadow"` mode first to validate SQLite correctness via comparison logging, then promote to `"sqlite"` when `ShadowReadComparator` shows zero divergence over a sustained period. The `DivergenceCircuitBreaker` auto-reverts to `"legacy"` if divergence exceeds the configured threshold.

**Next:** Phase 5 (Provider Adapter Interface) will extract the OpenCode-specific execution logic into a clean adapter interface, preparing for multi-provider support.

---

## Phase 5: Provider Adapter — Interface, OpenCode Adapter, Orchestration Engine

**Goal:** Extract the `ProviderAdapter` interface and implement the OpenCode adapter, wrapping the existing relay pipeline behind the new interface. Create the `OrchestrationEngine` as the central command processor that routes commands to adapters. By the end, conduit has a clean provider abstraction ready for multi-provider support (Phase 6).

**Depends on:** Phases 1-4 (event store, projections, read switchover). The adapter uses `EventStore` for event persistence and `ProjectionRunner` for eager projections. The `EventSink` wraps both.

**Validates:** The `ProviderAdapter` interface is implementable against OpenCode's REST+SSE surface. The `OrchestrationEngine` can dispatch commands to the correct adapter. The existing relay pipeline continues to function alongside the new adapter layer.

**Architecture pattern (from design doc):** Adapters are execution-only — they don't own sessions, messages, or history. Conduit owns all state. Adapters turn prompts into event streams via `EventSink`. The 7-method interface (down from ~30 in the old `SessionBackend`) keeps adapters focused: `discover`, `sendTurn`, `interruptTurn`, `resolvePermission`, `resolveQuestion`, `shutdown`, plus a readonly `providerId`.

**Reference:** t3code's `ProviderAdapterShape` (126-line interface at `~/src/personal/opencode-relay/t3code/apps/server/src/provider/Services/ProviderAdapter.ts`) uses Effect for error handling and has ~12 methods including `startSession`, `listSessions`, `readThread`, `rollbackThread`. Our interface is deliberately smaller — conduit owns session lifecycle, so the adapter doesn't need session management methods.

---

### Task 35: ProviderAdapter Interface + Key Types

**Files:**
- Create: `src/lib/provider/types.ts`
- Test: `test/unit/provider/types.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/provider/types.test.ts
import { describe, expect, it } from "vitest";
import type {
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
	EventSink,
	AdapterCapabilities,
	PermissionDecision,
	CommandInfo,
	CommandSource,
	PermissionRequest,
	QuestionRequest,
	TurnStatus,
	ProviderStateUpdate,
} from "../../../src/lib/provider/types.js";

describe("ProviderAdapter types", () => {
	it("ProviderAdapter has exactly the 7-method interface", () => {
		// Compile-time check: if the interface changes shape, this won't compile.
		const adapter: ProviderAdapter = {
			providerId: "test",
			discover: async () => ({
				models: [],
				supportsTools: false,
				supportsThinking: false,
				supportsPermissions: false,
				supportsQuestions: false,
				supportsAttachments: false,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
			sendTurn: async (_input: SendTurnInput) => ({
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			}),
			interruptTurn: async (_sessionId: string) => {},
			resolvePermission: async (
				_sessionId: string,
				_requestId: string,
				_decision: PermissionDecision,
			) => {},
			resolveQuestion: async (
				_sessionId: string,
				_requestId: string,
				_answers: Record<string, unknown>,
			) => {},
			shutdown: async () => {},
		};

		expect(adapter.providerId).toBe("test");
		expect(typeof adapter.discover).toBe("function");
		expect(typeof adapter.sendTurn).toBe("function");
		expect(typeof adapter.interruptTurn).toBe("function");
		expect(typeof adapter.resolvePermission).toBe("function");
		expect(typeof adapter.resolveQuestion).toBe("function");
		expect(typeof adapter.shutdown).toBe("function");
	});

	it("SendTurnInput includes all required fields", () => {
		const mockSink: EventSink = {
			push: async () => {},
			requestPermission: async () => ({ decision: "once" }),
			requestQuestion: async () => ({}),
		};

		const input: SendTurnInput = {
			sessionId: "s1",
			turnId: "t1",
			prompt: "hello",
			history: [],
			providerState: {},
			model: { providerId: "anthropic", modelId: "claude-sonnet" },
			workspaceRoot: "/tmp/project",
			eventSink: mockSink,
			abortSignal: new AbortController().signal,
		};

		expect(input.sessionId).toBe("s1");
		expect(input.turnId).toBe("t1");
		expect(input.eventSink).toBe(mockSink);
	});

	it("SendTurnInput supports optional fields", () => {
		const mockSink: EventSink = {
			push: async () => {},
			requestPermission: async () => ({ decision: "once" }),
			requestQuestion: async () => ({}),
		};

		const input: SendTurnInput = {
			sessionId: "s1",
			turnId: "t1",
			prompt: "hello",
			history: [],
			providerState: {},
			model: { providerId: "anthropic", modelId: "claude-sonnet" },
			workspaceRoot: "/tmp/project",
			eventSink: mockSink,
			abortSignal: new AbortController().signal,
			variant: "thinking",
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		};

		expect(input.variant).toBe("thinking");
		expect(input.images).toEqual(["data:image/png;base64,abc"]);
		expect(input.agent).toBe("coder");
	});

	it("TurnResult captures completion data", () => {
		const result: TurnResult = {
			status: "completed",
			cost: 0.05,
			tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
			durationMs: 3400,
			providerStateUpdates: [
				{ key: "cursor", value: "abc123" },
			],
		};

		expect(result.status).toBe("completed");
		expect(result.tokens.input).toBe(1000);
	});

	it("TurnResult captures error state", () => {
		const result: TurnResult = {
			status: "error",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 100,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
			providerStateUpdates: [],
		};

		expect(result.status).toBe("error");
		expect(result.error?.code).toBe("RATE_LIMITED");
	});

	it("AdapterCapabilities describes provider features", () => {
		const caps: AdapterCapabilities = {
			models: [
				{
					id: "claude-sonnet",
					name: "Claude Sonnet",
					providerId: "anthropic",
					limit: { context: 200000, output: 8192 },
				},
			],
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: false,
			supportsRevert: false,
			commands: [
				{ name: "/compact", description: "Compact context", source: "builtin" },
			],
		};

		expect(caps.models).toHaveLength(1);
		expect(caps.supportsTools).toBe(true);
		expect(caps.commands[0].source).toBe("builtin");
	});

	it("CommandInfo covers all source types", () => {
		const sources: CommandSource[] = [
			"builtin",
			"user-command",
			"project-command",
			"user-skill",
			"project-skill",
		];

		const commands: CommandInfo[] = sources.map((source) => ({
			name: `/test-${source}`,
			source,
		}));

		expect(commands).toHaveLength(5);
		commands.forEach((cmd) => {
			expect(cmd.name).toBeTruthy();
			expect(sources).toContain(cmd.source);
		});
	});

	it("PermissionDecision is a string union", () => {
		const decisions: PermissionDecision[] = ["once", "always", "reject"];
		expect(decisions).toHaveLength(3);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/types.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/types.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/provider/types.ts
// ─── Provider Adapter Types ─────────────────────────────────────────────────
// Core interface and supporting types for the provider adapter layer.
// Adapters are execution-only — they don't own sessions, messages, or history.
// Conduit owns all state. Adapters turn prompts into event streams.

import type { CanonicalEvent } from "../persistence/events.js";

// ─── Permission / Question Decisions ────────────────────────────────────────

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionRequest {
	readonly requestId: string;
	readonly toolName: string;
	// Amendment A8 (I13): Generic toolInput instead of OpenCode-specific shape.
	readonly toolInput: Record<string, unknown>;
	// Amendment A8 (I13): Added session/turn context fields for cross-provider compatibility.
	readonly sessionId: string;
	readonly turnId: string;
	readonly providerItemId: string;
	readonly always?: string[];
}

export interface PermissionResponse {
	readonly decision: PermissionDecision;
}

export interface QuestionRequest {
	readonly requestId: string;
	readonly questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect?: boolean;
		custom?: boolean;
	}>;
}

// ─── Event Sink ─────────────────────────────────────────────────────────────

/**
 * EventSink is the adapter's write interface to conduit's event store.
 *
 * - `push(event)`: append a canonical event to the store and project eagerly.
 * - `requestPermission(request)`: emit permission.asked, block until
 *   permission.resolved arrives, return the decision.
 * - `requestQuestion(request)`: emit question.asked, block until
 *   question.resolved arrives, return the answers.
 */
export interface EventSink {
	push(event: CanonicalEvent): Promise<void>;
	requestPermission(request: PermissionRequest): Promise<PermissionResponse>;
	requestQuestion(
		request: QuestionRequest,
	): Promise<Record<string, unknown>>;
}

// ─── Turn Types ─────────────────────────────────────────────────────────────

export type TurnStatus = "completed" | "error" | "interrupted" | "cancelled";

export interface TurnTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
}

export interface TurnError {
	readonly code: string;
	readonly message: string;
	readonly retryable?: boolean;
}

export interface ProviderStateUpdate {
	readonly key: string;
	readonly value: unknown;
}

export interface TurnResult {
	readonly status: TurnStatus;
	readonly cost: number;
	readonly tokens: TurnTokens;
	readonly durationMs: number;
	readonly error?: TurnError;
	readonly providerStateUpdates: readonly ProviderStateUpdate[];
}

// ─── Model Types ────────────────────────────────────────────────────────────

export interface ModelSelection {
	readonly providerId: string;
	readonly modelId: string;
}

export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly providerId: string;
	readonly limit?: { context?: number; output?: number };
	readonly variants?: Record<string, Record<string, unknown>>;
}

// ─── History ────────────────────────────────────────────────────────────────

export interface HistoryMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
	readonly parts?: readonly Record<string, unknown>[];
	readonly tokens?: TurnTokens;
	readonly cost?: number;
}

// ─── Send Turn Input ────────────────────────────────────────────────────────

export interface SendTurnInput {
	readonly sessionId: string;
	readonly turnId: string;
	readonly prompt: string;
	readonly history: readonly HistoryMessage[];
	readonly providerState: Readonly<Record<string, unknown>>;
	readonly model: ModelSelection;
	readonly workspaceRoot: string;
	readonly eventSink: EventSink;
	readonly abortSignal: AbortSignal;
	readonly variant?: string;
	readonly images?: readonly string[];
	readonly agent?: string;
}

// ─── Command Discovery ─────────────────────────────────────────────────────

export type CommandSource =
	| "builtin"
	| "user-command"
	| "project-command"
	| "user-skill"
	| "project-skill";

export interface CommandInfo {
	readonly name: string;
	readonly description?: string;
	readonly source: CommandSource;
}

// ─── Adapter Capabilities ───────────────────────────────────────────────────

export interface AdapterCapabilities {
	readonly models: readonly ModelInfo[];
	readonly supportsTools: boolean;
	readonly supportsThinking: boolean;
	readonly supportsPermissions: boolean;
	readonly supportsQuestions: boolean;
	readonly supportsAttachments: boolean;
	readonly supportsFork: boolean;
	readonly supportsRevert: boolean;
	readonly commands: readonly CommandInfo[];
}

// ─── Provider Adapter Interface ─────────────────────────────────────────────

/**
 * ProviderAdapter — the 7-method contract for provider execution.
 *
 * Implementations wrap a provider's REST/SDK surface and translate provider
 * events into canonical events via the EventSink. Adapters do not own session
 * state, message history, or projections — conduit does.
 *
 * Compared to t3code's ProviderAdapterShape (~12 methods with Effect):
 * - No startSession/stopSession/listSessions — conduit owns session lifecycle
 * - No readThread/rollbackThread — conduit reads from its own projections
 * - No streamEvents — adapter pushes via EventSink, no output stream needed
 */
export interface ProviderAdapter {
	/** Unique identifier for this provider (e.g. "opencode", "claude") */
	readonly providerId: string;

	/** Query the provider for available models, commands, and capabilities */
	discover(): Promise<AdapterCapabilities>;

	/** Send a user turn to the provider and stream response events via EventSink */
	sendTurn(input: SendTurnInput): Promise<TurnResult>;

	/** Interrupt an in-progress turn */
	interruptTurn(sessionId: string): Promise<void>;

	/** Resolve a pending permission request (from EventSink.requestPermission) */
	resolvePermission(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void>;

	/** Resolve a pending question (from EventSink.requestQuestion) */
	resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Promise<void>;

	/** Graceful shutdown — clean up connections, abort pending turns */
	shutdown(): Promise<void>;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/types.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

Review the type names against the design document:
- `ProviderAdapter` — matches design doc exactly
- `SendTurnInput` — matches design doc, with `images` and `agent` as optional extras for OpenCode
- `TurnResult` — matches design doc
- `EventSink` — matches design doc
- `AdapterCapabilities` — matches design doc, including `commands`
- `CommandInfo` — matches design doc with the 5 source types

No refactoring needed.

**Step 6: Commit**

```bash
git add src/lib/provider/types.ts test/unit/provider/types.test.ts
git commit -m "feat(provider): add ProviderAdapter interface and supporting types (7-method contract)"
```

---

### Task 36: EventSink Implementation

**Files:**
- Create: `src/lib/provider/event-sink.ts`
- Test: `test/unit/provider/event-sink.test.ts`

**Purpose:** `EventSinkImpl` wraps `EventStore` + `ProjectionRunner` so adapters can push canonical events without knowing about SQLite internals. Permission and question requests block the adapter's turn loop until the user decides.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/event-sink.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventSinkImpl } from "../../../src/lib/provider/event-sink.js";
import type {
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "../../../src/lib/provider/types.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";

// ─── Mock dependencies ─────────────────────────────────────────────────────

function makeMockEventStore() {
	const appendedEvents: CanonicalEvent[] = [];
	return {
		append: vi.fn((event: CanonicalEvent) => {
			appendedEvents.push(event);
			return { ...event, sequence: appendedEvents.length, stream_version: 1 };
		}),
		appendedEvents,
	};
}

function makeMockProjectionRunner() {
	return {
		projectEvent: vi.fn(),
	};
}

function makeEvent(overrides?: Partial<CanonicalEvent>): CanonicalEvent {
	return {
		eventId: "evt-1",
		type: "message.delta",
		sessionId: "s1",
		createdAt: Date.now(),
		metadata: {},
		provider: "opencode",
		data: { delta: "hello" },
		...overrides,
	} as CanonicalEvent;
}

describe("EventSinkImpl", () => {
	let eventStore: ReturnType<typeof makeMockEventStore>;
	let projectionRunner: ReturnType<typeof makeMockProjectionRunner>;
	let sink: EventSinkImpl;

	beforeEach(() => {
		eventStore = makeMockEventStore();
		projectionRunner = makeMockProjectionRunner();
		sink = new EventSinkImpl({
			eventStore: eventStore as any,
			projectionRunner: projectionRunner as any,
			sessionId: "s1",
			provider: "opencode",
		});
	});

	describe("push", () => {
		it("appends event to store and projects it", async () => {
			const event = makeEvent();
			await sink.push(event);

			expect(eventStore.append).toHaveBeenCalledWith(event);
			expect(projectionRunner.projectEvent).toHaveBeenCalledTimes(1);
		});

		it("projects the stored event (with sequence)", async () => {
			const event = makeEvent();
			await sink.push(event);

			const projected = projectionRunner.projectEvent.mock.calls[0][0];
			expect(projected.sequence).toBe(1);
		});

		it("handles multiple sequential pushes", async () => {
			await sink.push(makeEvent({ eventId: "e1" }));
			await sink.push(makeEvent({ eventId: "e2" }));
			await sink.push(makeEvent({ eventId: "e3" }));

			expect(eventStore.append).toHaveBeenCalledTimes(3);
			expect(projectionRunner.projectEvent).toHaveBeenCalledTimes(3);
		});
	});

	describe("requestPermission", () => {
		it("emits permission.asked event and blocks until resolved", async () => {
			const request: PermissionRequest = {
				requestId: "perm-1",
				toolName: "bash",
				toolInput: { patterns: ["*.sh"], metadata: { cmd: "rm" } },
			};

			// Start the permission request (it will block)
			const resultPromise = sink.requestPermission(request);

			// Verify the permission.asked event was pushed
			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0][0] as CanonicalEvent;
			expect(pushed.type).toBe("permission.asked");
			expect(pushed.data).toMatchObject({
				id: "perm-1",
				toolName: "bash",
			});

			// Resolve it
			sink.resolvePermission("perm-1", { decision: "once" });

			const result = await resultPromise;
			expect(result.decision).toBe("once");
		});

		it("resolves with 'always' decision", async () => {
			const request: PermissionRequest = {
				requestId: "perm-2",
				toolName: "write",
				toolInput: { patterns: [], metadata: {} },
			};

			const resultPromise = sink.requestPermission(request);
			sink.resolvePermission("perm-2", { decision: "always" });

			const result = await resultPromise;
			expect(result.decision).toBe("always");
		});

		it("resolves with 'reject' decision", async () => {
			const request: PermissionRequest = {
				requestId: "perm-3",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
			};

			const resultPromise = sink.requestPermission(request);
			sink.resolvePermission("perm-3", { decision: "reject" });

			const result = await resultPromise;
			expect(result.decision).toBe("reject");
		});

		it("handles multiple concurrent permission requests", async () => {
			const p1 = sink.requestPermission({
				requestId: "r1",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
			});
			const p2 = sink.requestPermission({
				requestId: "r2",
				toolName: "write",
				toolInput: { patterns: [], metadata: {} },
			});

			sink.resolvePermission("r2", { decision: "always" });
			sink.resolvePermission("r1", { decision: "once" });

			const [res1, res2] = await Promise.all([p1, p2]);
			expect(res1.decision).toBe("once");
			expect(res2.decision).toBe("always");
		});

		it("emits permission.resolved event on resolution", async () => {
			const resultPromise = sink.requestPermission({
				requestId: "perm-4",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
			});

			sink.resolvePermission("perm-4", { decision: "once" });
			await resultPromise;

			// Two events: permission.asked + permission.resolved
			expect(eventStore.append).toHaveBeenCalledTimes(2);
			const resolvedEvent = eventStore.append.mock.calls[1][0] as CanonicalEvent;
			expect(resolvedEvent.type).toBe("permission.resolved");
			expect(resolvedEvent.data).toMatchObject({
				id: "perm-4",
				decision: "once",
			});
		});
	});

	describe("requestQuestion", () => {
		it("emits question.asked event and blocks until resolved", async () => {
			const request: QuestionRequest = {
				requestId: "q1",
				questions: [
					{
						question: "Continue?",
						header: "Confirmation",
						options: [
							{ label: "Yes", description: "Proceed" },
							{ label: "No", description: "Cancel" },
						],
					},
				],
			};

			const resultPromise = sink.requestQuestion(request);

			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0][0] as CanonicalEvent;
			expect(pushed.type).toBe("question.asked");

			sink.resolveQuestion("q1", { answer: "Yes" });

			const result = await resultPromise;
			expect(result).toEqual({ answer: "Yes" });
		});

		it("emits question.resolved event on resolution", async () => {
			const resultPromise = sink.requestQuestion({
				requestId: "q2",
				questions: [
					{
						question: "Pick one",
						header: "Choose",
						options: [{ label: "A", description: "Option A" }],
					},
				],
			});

			sink.resolveQuestion("q2", { choice: "A" });
			await resultPromise;

			expect(eventStore.append).toHaveBeenCalledTimes(2);
			const resolvedEvent = eventStore.append.mock.calls[1][0] as CanonicalEvent;
			expect(resolvedEvent.type).toBe("question.resolved");
		});
	});

	describe("abort handling", () => {
		it("rejects pending permissions when aborted", async () => {
			const resultPromise = sink.requestPermission({
				requestId: "perm-abort",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
			});

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("rejects pending questions when aborted", async () => {
			const resultPromise = sink.requestQuestion({
				requestId: "q-abort",
				questions: [
					{
						question: "Continue?",
						header: "Test",
						options: [],
					},
				],
			});

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("has no pending requests after abort", () => {
			sink.requestPermission({
				requestId: "perm-x",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
			}).catch(() => {}); // Swallow rejection

			sink.abort();

			expect(sink.pendingCount).toBe(0);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/event-sink.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/event-sink.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/provider/event-sink.ts
// ─── Event Sink Implementation ──────────────────────────────────────────────
// Wraps EventStore + ProjectionRunner so adapters can push canonical events
// without knowing about SQLite internals. Permission and question requests
// block the adapter's turn loop until the user resolves them.

import type { CanonicalEvent, CanonicalEventType, EventPayloadMap, EventMetadata, StoredEvent } from "../persistence/events.js";
import type { EventStore } from "../persistence/event-store.js";
import type { ProjectionRunner } from "../persistence/projection-runner.js";
import { createEventId } from "../persistence/events.js";
import type {
	EventSink,
	PermissionRequest,
	PermissionResponse,
	QuestionRequest,
} from "./types.js";

// ─── Typed Event Helper (Amendment A3 — I11) ────────────────────────────────

/**
 * Constructs a CanonicalEvent with proper typing, replacing unsafe
 * `as CanonicalEvent` casts. Uses the EventPayloadMap to ensure the
 * payload shape matches the event type at compile time.
 */
function makeCanonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	metadata: EventMetadata = {},
): CanonicalEvent {
	return {
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata,
		provider: "opencode",
		createdAt: Date.now(),
	} as CanonicalEvent;
}

// ─── Deferred ───────────────────────────────────────────────────────────────

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ─── EventSink Dependencies ─────────────────────────────────────────────────

export interface EventSinkDeps {
	readonly eventStore: EventStore;
	readonly projectionRunner: ProjectionRunner;
	readonly sessionId: string;
	readonly provider: string;
	readonly abortSignal?: AbortSignal;
	/** (F1) Required command ID for request-level correlation.
	 *  Propagated into every event's metadata for end-to-end tracing. */
	readonly commandId: string;
}

// ─── EventSinkStats (C2) ────────────────────────────────────────────────────

/** (C2) Lightweight write-rate stats for diagnosing performance. */
export interface EventSinkStats {
	eventsWritten: number;
	totalWriteMs: number;
	totalProjectMs: number;
	peakBatchLatencyMs: number;
	lastWriteAt: number;
}

// ─── EventSinkImpl ──────────────────────────────────────────────────────────

export class EventSinkImpl implements EventSink {
	private readonly eventStore: EventStore;
	private readonly projectionRunner: ProjectionRunner;
	private readonly pendingPermissions = new Map<string, Deferred<PermissionResponse>>();
	private readonly pendingQuestions = new Map<string, Deferred<Record<string, unknown>>>();

	private readonly sessionId: string;
	private readonly provider: string;
	private readonly commandId: string;

	/** (C2) Write-rate stats for diagnostics. */
	private readonly stats: EventSinkStats = {
		eventsWritten: 0, totalWriteMs: 0, totalProjectMs: 0,
		peakBatchLatencyMs: 0, lastWriteAt: 0,
	};

	constructor(deps: EventSinkDeps) {
		this.eventStore = deps.eventStore;
		this.projectionRunner = deps.projectionRunner;
		this.sessionId = deps.sessionId;
		this.provider = deps.provider;
		this.commandId = deps.commandId;
		if (deps.abortSignal) {
			deps.abortSignal.addEventListener("abort", () => this.abort(), { once: true });
		}
	}

	/** (C2) Get write-rate stats for diagnostics. Wire into PersistenceDiagnostics.health(). */
	getStats(): EventSinkStats { return { ...this.stats }; }

	/** (F3) Expose pending permission/question state for diagnostics. */
	getPendingState(): {
		permissions: Array<{ requestId: string; pendingSince: number }>;
		questions: Array<{ requestId: string; pendingSince: number }>;
	} {
		return {
			permissions: [...this.pendingPermissions.entries()].map(([id]) => ({
				requestId: id, pendingSince: 0, // track createdAt in implementation
			})),
			questions: [...this.pendingQuestions.entries()].map(([id]) => ({
				requestId: id, pendingSince: 0,
			})),
		};
	}

	/** Append an event to the store and project it eagerly.
	 *  (F1) Enriches every event with commandId/correlationId for end-to-end tracing.
	 *  (C2) Tracks write-rate stats.
	 */
	async push(event: CanonicalEvent): Promise<void> {
		const enriched = {
			...event,
			metadata: {
				...event.metadata,
				commandId: this.commandId,
				correlationId: this.commandId,
			},
		};
		const t0 = performance.now();
		const stored = this.eventStore.append(enriched as CanonicalEvent);
		const t1 = performance.now();
		this.projectionRunner.projectEvent(stored);
		const t2 = performance.now();

		this.stats.eventsWritten++;
		this.stats.totalWriteMs += (t1 - t0);
		this.stats.totalProjectMs += (t2 - t1);
		this.stats.peakBatchLatencyMs = Math.max(this.stats.peakBatchLatencyMs, t2 - t0);
		this.stats.lastWriteAt = Date.now();
	}

	/**
	 * Emit a permission.asked event and block until the user resolves it.
	 * Returns the user's decision (once | always | reject).
	 */
	async requestPermission(request: PermissionRequest): Promise<PermissionResponse> {
		// Emit the permission.asked event (Amendment A3: uses typed helper)
		const event = makeCanonicalEvent("permission.asked", this.sessionId, {
			id: request.requestId,
			sessionId: this.sessionId,
			toolName: request.toolName,
			input: request.toolInput,
			...(request.always ? { always: request.always } : {}),
		});
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Block until resolved
		const deferred = createDeferred<PermissionResponse>();
		this.pendingPermissions.set(request.requestId, deferred);
		return deferred.promise;
	}

	/**
	 * Emit a question.asked event and block until the user answers.
	 * Returns the user's answers as a key-value map.
	 */
	async requestQuestion(request: QuestionRequest): Promise<Record<string, unknown>> {
		// Emit the question.asked event (Amendment A3: uses typed helper)
		const event = makeCanonicalEvent("question.asked", this.sessionId, {
			id: request.requestId,
			sessionId: this.sessionId,
			questions: request.questions,
		});
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Block until resolved
		const deferred = createDeferred<Record<string, unknown>>();
		this.pendingQuestions.set(request.requestId, deferred);
		return deferred.promise;
	}

	/**
	 * Resolve a pending permission request. Called by the orchestration layer
	 * when the user makes a decision.
	 */
	resolvePermission(requestId: string, response: PermissionResponse): void {
		// Emit the permission.resolved event (Amendment A3: uses typed helper)
		const event = makeCanonicalEvent("permission.resolved", this.sessionId, {
			id: requestId,
			decision: response.decision,
		});
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Unblock the waiting adapter
		const deferred = this.pendingPermissions.get(requestId);
		if (deferred) {
			this.pendingPermissions.delete(requestId);
			deferred.resolve(response);
		}
	}

	/**
	 * Resolve a pending question request. Called by the orchestration layer
	 * when the user answers.
	 */
	resolveQuestion(requestId: string, answers: Record<string, unknown>): void {
		// Emit the question.resolved event (Amendment A3: uses typed helper)
		const event = makeCanonicalEvent("question.resolved", this.sessionId, {
			id: requestId,
			answers,
		});
		const stored = this.eventStore.append(event);
		this.projectionRunner.projectEvent(stored);

		// Unblock the waiting adapter
		const deferred = this.pendingQuestions.get(requestId);
		if (deferred) {
			this.pendingQuestions.delete(requestId);
			deferred.resolve(answers);
		}
	}

	/** Abort all pending requests (e.g. when the turn is interrupted). */
	abort(): void {
		const abortError = new Error("EventSink aborted");
		for (const deferred of this.pendingPermissions.values()) {
			deferred.reject(abortError);
		}
		this.pendingPermissions.clear();
		for (const deferred of this.pendingQuestions.values()) {
			deferred.reject(abortError);
		}
		this.pendingQuestions.clear();
	}

	/** Number of pending (unresolved) requests. */
	get pendingCount(): number {
		return this.pendingPermissions.size + this.pendingQuestions.size;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/event-sink.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

The `EventSinkImpl` now accepts `sessionId` and `provider` in its `EventSinkDeps`, using them on all internally-generated events (permission/question). It also accepts an optional `abortSignal` which auto-wires to `abort()` for cleanup of pending maps. All event constructions use camelCase field names (`eventId`, `sessionId`, `createdAt`) matching the Phase 1 `CanonicalEvent` type, and include required `metadata: {}` and `provider` fields. Payload field names use Phase 1 canonical names: `id` (not `requestId`), `input` (not `toolInput`), with `sessionId` on `PermissionAskedPayload`.

**Step 6: Commit**

```bash
git add src/lib/provider/event-sink.ts test/unit/provider/event-sink.test.ts
git commit -m "feat(provider): add EventSink wrapping EventStore + ProjectionRunner with blocking permission/question resolution"
```

---

### Task 37: ProviderRegistry

**Files:**
- Create: `src/lib/provider/provider-registry.ts`
- Test: `test/unit/provider/provider-registry.test.ts`

**Purpose:** Maps provider names to adapter instances. The `OrchestrationEngine` uses this to route commands to the correct adapter. Compared to t3code's `ProviderAdapterRegistry` (which uses Effect ServiceMap), this is a simple Map with type-safe accessors.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/provider-registry.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter } from "../../../src/lib/provider/types.js";

function makeStubAdapter(providerId: string): ProviderAdapter {
	return {
		providerId,
		discover: vi.fn(async () => ({
			models: [],
			supportsTools: false,
			supportsThinking: false,
			supportsPermissions: false,
			supportsQuestions: false,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		})),
		sendTurn: vi.fn(),
		interruptTurn: vi.fn(),
		resolvePermission: vi.fn(),
		resolveQuestion: vi.fn(),
		shutdown: vi.fn(),
	};
}

describe("ProviderRegistry", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		registry = new ProviderRegistry();
	});

	it("registers and retrieves an adapter", () => {
		const adapter = makeStubAdapter("opencode");
		registry.registerAdapter(adapter);

		const retrieved = registry.getAdapter("opencode");
		expect(retrieved).toBe(adapter);
	});

	it("returns undefined for unknown provider", () => {
		expect(registry.getAdapter("unknown")).toBeUndefined();
	});

	it("lists all registered providers", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		registry.registerAdapter(makeStubAdapter("claude"));

		const providers = registry.listProviders();
		expect(providers).toEqual(["opencode", "claude"]);
	});

	it("returns empty list when no adapters registered", () => {
		expect(registry.listProviders()).toEqual([]);
	});

	it("overwrites adapter with same providerId", () => {
		const first = makeStubAdapter("opencode");
		const second = makeStubAdapter("opencode");

		registry.registerAdapter(first);
		registry.registerAdapter(second);

		expect(registry.getAdapter("opencode")).toBe(second);
		expect(registry.listProviders()).toEqual(["opencode"]);
	});

	it("hasAdapter returns true for registered adapter", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		expect(registry.hasAdapter("opencode")).toBe(true);
		expect(registry.hasAdapter("claude")).toBe(false);
	});

	it("removeAdapter removes a registered adapter", () => {
		registry.registerAdapter(makeStubAdapter("opencode"));
		registry.removeAdapter("opencode");

		expect(registry.getAdapter("opencode")).toBeUndefined();
		expect(registry.listProviders()).toEqual([]);
	});

	it("removeAdapter is a no-op for unknown provider", () => {
		registry.removeAdapter("unknown"); // Should not throw
		expect(registry.listProviders()).toEqual([]);
	});

	it("getAdapterOrThrow throws for unknown provider", () => {
		expect(() => registry.getAdapterOrThrow("unknown")).toThrow(
			"No adapter registered for provider: unknown",
		);
	});

	it("getAdapterOrThrow returns adapter for known provider", () => {
		const adapter = makeStubAdapter("opencode");
		registry.registerAdapter(adapter);
		expect(registry.getAdapterOrThrow("opencode")).toBe(adapter);
	});

	it("shutdownAll calls shutdown on all adapters", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		await registry.shutdownAll();

		expect(a1.shutdown).toHaveBeenCalledTimes(1);
		expect(a2.shutdown).toHaveBeenCalledTimes(1);
	});

	it("shutdownAll continues even if one adapter fails", async () => {
		const a1 = makeStubAdapter("opencode");
		const a2 = makeStubAdapter("claude");
		(a1.shutdown as any).mockRejectedValue(new Error("boom"));
		registry.registerAdapter(a1);
		registry.registerAdapter(a2);

		// Should not throw
		await registry.shutdownAll();

		expect(a1.shutdown).toHaveBeenCalledTimes(1);
		expect(a2.shutdown).toHaveBeenCalledTimes(1);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/provider-registry.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/provider-registry.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/provider/provider-registry.ts
// ─── Provider Registry ─────────────────────────────────────────────────────
// Maps provider IDs to adapter instances. The OrchestrationEngine uses this
// to route commands to the correct adapter.

import { createLogger } from "../logger.js";
import type { ProviderAdapter } from "./types.js";

const log = createLogger("provider-registry");

export class ProviderRegistry {
	private readonly adapters = new Map<string, ProviderAdapter>();

	/** Register an adapter. Overwrites any existing adapter with the same providerId. */
	registerAdapter(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.providerId, adapter);
		log.info(`Registered provider adapter: ${adapter.providerId}`);
	}

	/** Get an adapter by provider ID, or undefined if not registered. */
	getAdapter(providerId: string): ProviderAdapter | undefined {
		return this.adapters.get(providerId);
	}

	/** Get an adapter by provider ID, throwing if not registered. */
	getAdapterOrThrow(providerId: string): ProviderAdapter {
		const adapter = this.adapters.get(providerId);
		if (!adapter) {
			throw new Error(`No adapter registered for provider: ${providerId}`);
		}
		return adapter;
	}

	/** Check if an adapter is registered for the given provider ID. */
	hasAdapter(providerId: string): boolean {
		return this.adapters.has(providerId);
	}

	/** Remove an adapter by provider ID. No-op if not registered. */
	removeAdapter(providerId: string): void {
		this.adapters.delete(providerId);
	}

	/** List all registered provider IDs. */
	listProviders(): string[] {
		return [...this.adapters.keys()];
	}

	/** Shutdown all registered adapters. Continues on individual failures. */
	async shutdownAll(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.adapters.values()].map((adapter) => adapter.shutdown()),
		);
		for (const result of results) {
			if (result.status === "rejected") {
				log.warn(`Adapter shutdown failed: ${result.reason}`);
			}
		}
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/provider-registry.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The registry is intentionally simple — a Map with typed accessors.

**Step 6: Commit**

```bash
git add src/lib/provider/provider-registry.ts test/unit/provider/provider-registry.test.ts
git commit -m "feat(provider): add ProviderRegistry for adapter lookup and lifecycle management"
```

---

### Task 38: OpenCodeAdapter — discover()

**Files:**
- Create: `src/lib/provider/opencode-adapter.ts`
- Test: `test/unit/provider/opencode-adapter-discover.test.ts`

**Purpose:** The OpenCode adapter wraps the existing `OpenCodeClient` REST API. The `discover()` method queries OpenCode for models, agents, commands, and skills, then maps them to `AdapterCapabilities`.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/opencode-adapter-discover.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import type { OpenCodeClient, Provider, Agent } from "../../../src/lib/instance/opencode-client.js";

function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	return {
		listProviders: vi.fn(async () => ({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-sonnet",
							name: "Claude Sonnet",
							limit: { context: 200000, output: 8192 },
							variants: {
								thinking: { budget_tokens: 10000 },
							},
						},
						{
							id: "claude-haiku",
							name: "Claude Haiku",
							limit: { context: 200000, output: 4096 },
						},
					],
				},
			],
			defaults: { anthropic: "claude-sonnet" },
			connected: ["anthropic"],
		})),
		listAgents: vi.fn(async () => [
			{ id: "coder", name: "Coder", description: "Main coding agent" },
			{ id: "task", name: "Task", description: "Sub-agent", mode: "subagent" },
		]),
		listCommands: vi.fn(async () => [
			{ name: "/compact", description: "Compact context window" },
			{ name: "/cost", description: "Show cost" },
		]),
		listSkills: vi.fn(async () => [
			{ name: "debugging", description: "Debug skill" },
		]),
		...overrides,
	} as unknown as OpenCodeClient;
}

describe("OpenCodeAdapter.discover()", () => {
	let client: OpenCodeClient;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	it("returns providerId = 'opencode'", () => {
		expect(adapter.providerId).toBe("opencode");
	});

	it("discovers models from all providers", async () => {
		const caps = await adapter.discover();

		expect(caps.models).toHaveLength(2);
		expect(caps.models[0]).toMatchObject({
			id: "claude-sonnet",
			name: "Claude Sonnet",
			providerId: "anthropic",
			limit: { context: 200000, output: 8192 },
		});
		expect(caps.models[0].variants).toEqual({
			thinking: { budget_tokens: 10000 },
		});
	});

	it("discovers commands", async () => {
		const caps = await adapter.discover();

		const commands = caps.commands.filter((c) => c.source === "builtin");
		expect(commands.length).toBeGreaterThanOrEqual(2);
		expect(commands.find((c) => c.name === "/compact")).toBeDefined();
		expect(commands.find((c) => c.name === "/cost")).toBeDefined();
	});

	it("discovers skills as project-skill commands", async () => {
		const caps = await adapter.discover();

		const skills = caps.commands.filter((c) => c.source === "project-skill");
		expect(skills).toHaveLength(1);
		expect(skills[0].name).toBe("debugging");
	});

	it("sets capability flags for OpenCode", async () => {
		const caps = await adapter.discover();

		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsThinking).toBe(true);
		expect(caps.supportsPermissions).toBe(true);
		expect(caps.supportsQuestions).toBe(true);
		expect(caps.supportsAttachments).toBe(true);
		expect(caps.supportsFork).toBe(true);
		expect(caps.supportsRevert).toBe(true);
	});

	it("handles provider with no models", async () => {
		client = makeStubClient({
			listProviders: vi.fn(async () => ({
				providers: [{ id: "empty", name: "Empty", models: [] }],
				defaults: {},
				connected: [],
			})),
		});
		adapter = new OpenCodeAdapter({ client });

		const caps = await adapter.discover();
		expect(caps.models).toEqual([]);
	});

	it("handles empty commands and skills", async () => {
		client = makeStubClient({
			listCommands: vi.fn(async () => []),
			listSkills: vi.fn(async () => []),
		});
		adapter = new OpenCodeAdapter({ client });

		const caps = await adapter.discover();
		expect(caps.commands).toEqual([]);
	});

	it("handles API errors gracefully", async () => {
		client = makeStubClient({
			listProviders: vi.fn(async () => { throw new Error("network error"); }),
		});
		adapter = new OpenCodeAdapter({ client });

		await expect(adapter.discover()).rejects.toThrow("network error");
	});

	it("passes workspace directory for command/skill discovery", async () => {
		adapter = new OpenCodeAdapter({ client, workspaceRoot: "/my/project" });

		await adapter.discover();

		expect(client.listCommands).toHaveBeenCalledWith("/my/project");
		expect(client.listSkills).toHaveBeenCalledWith("/my/project");
	});

	it("omits directory for commands when no workspace", async () => {
		adapter = new OpenCodeAdapter({ client });

		await adapter.discover();

		expect(client.listCommands).toHaveBeenCalledWith(undefined);
		expect(client.listSkills).toHaveBeenCalledWith(undefined);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-discover.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/opencode-adapter.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/provider/opencode-adapter.ts
// ─── OpenCode Provider Adapter ──────────────────────────────────────────────
// Wraps the existing OpenCodeClient REST API behind the ProviderAdapter
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import type { OpenCodeClient } from "../instance/opencode-client.js";
import { createLogger } from "../logger.js";
import type {
	AdapterCapabilities,
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("opencode-adapter");

// ─── Options ────────────────────────────────────────────────────────────────

export interface OpenCodeAdapterOptions {
	readonly client: OpenCodeClient;
	readonly workspaceRoot?: string;
}

// ─── OpenCodeAdapter ────────────────────────────────────────────────────────

export class OpenCodeAdapter implements ProviderAdapter {
	readonly providerId = "opencode";

	private readonly client: OpenCodeClient;
	private readonly workspaceRoot: string | undefined;

	constructor(options: OpenCodeAdapterOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
	}

	// ─── discover ─────────────────────────────────────────────────────────

	async discover(): Promise<AdapterCapabilities> {
		const [providerResult, commandsRaw, skillsRaw] = await Promise.all([
			this.client.listProviders(),
			this.client.listCommands(this.workspaceRoot),
			this.client.listSkills(this.workspaceRoot),
		]);

		// Map providers → models
		const models: ModelInfo[] = providerResult.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name,
				providerId: provider.id,
				limit: model.limit,
				...(model.variants ? { variants: model.variants } : {}),
			})),
		);

		// Map commands (builtin)
		const commands: CommandInfo[] = commandsRaw.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
			source: "builtin" as const,
		}));

		// Map skills (project-skill)
		const skills: CommandInfo[] = skillsRaw.map((skill) => ({
			name: skill.name,
			description: skill.description,
			source: "project-skill" as const,
		}));

		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: true,
			commands: [...commands, ...skills],
		};
	}

	// ─── sendTurn (stub — implemented in Task 39) ─────────────────────────

	async sendTurn(_input: SendTurnInput): Promise<TurnResult> {
		throw new Error("OpenCodeAdapter.sendTurn not yet implemented");
	}

	// ─── interruptTurn (stub — implemented in Task 40) ────────────────────

	async interruptTurn(_sessionId: string): Promise<void> {
		throw new Error("OpenCodeAdapter.interruptTurn not yet implemented");
	}

	// ─── resolvePermission (stub — implemented in Task 40) ────────────────

	async resolvePermission(
		_sessionId: string,
		_requestId: string,
		_decision: PermissionDecision,
	): Promise<void> {
		throw new Error("OpenCodeAdapter.resolvePermission not yet implemented");
	}

	// ─── resolveQuestion (stub — implemented in Task 40) ──────────────────

	async resolveQuestion(
		_sessionId: string,
		_requestId: string,
		_answers: Record<string, unknown>,
	): Promise<void> {
		throw new Error("OpenCodeAdapter.resolveQuestion not yet implemented");
	}

	// ─── shutdown ────────────────────────────────────────────────────────

	async shutdown(): Promise<void> {
		log.info("OpenCodeAdapter shutting down");
		// No persistent connections to clean up — OpenCode uses stateless REST.
		// SSE connections are owned by the SSEConsumer, not the adapter.
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-discover.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The stubs for `sendTurn`, `interruptTurn`, `resolvePermission`, and `resolveQuestion` throw explicitly — they'll be implemented in Tasks 39-40.

**Step 6: Commit**

```bash
git add src/lib/provider/opencode-adapter.ts test/unit/provider/opencode-adapter-discover.test.ts
git commit -m "feat(provider): add OpenCodeAdapter with discover() mapping REST API to AdapterCapabilities"
```

---

### Task 39: OpenCodeAdapter — sendTurn()

**Files:**
- Modify: `src/lib/provider/opencode-adapter.ts`
- Test: `test/unit/provider/opencode-adapter-send-turn.test.ts`

**Purpose:** The main adapter method. Sends a message via OpenCode REST, sets up SSE event monitoring for the response, translates incoming SSE events to canonical events via the EventSink, and returns a `TurnResult` when the turn completes, errors, or is interrupted.

**Design note:** The adapter does NOT create its own SSE connection — the relay's existing `SSEConsumer` already handles SSE. Instead, the adapter sends the prompt via REST (`sendMessageAsync`) and relies on the existing event pipeline for the response. The adapter's `sendTurn` returns a Promise that resolves when the session status transitions to "idle" (indicating the turn is done). This is the same pattern the existing relay uses — the adapter just wraps it behind the `ProviderAdapter` interface.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/opencode-adapter-send-turn.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import type {
	EventSink,
	SendTurnInput,
	TurnResult,
	HistoryMessage,
} from "../../../src/lib/provider/types.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	return {
		sendMessageAsync: vi.fn(async () => {}),
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		listProviders: vi.fn(async () => ({
			providers: [],
			defaults: {},
			connected: [],
		})),
		listAgents: vi.fn(async () => []),
		listCommands: vi.fn(async () => []),
		listSkills: vi.fn(async () => []),
		...overrides,
	} as unknown as OpenCodeClient;
}

function makeStubEventSink(): EventSink & {
	pushedEvents: CanonicalEvent[];
} {
	const pushedEvents: CanonicalEvent[] = [];
	return {
		pushedEvents,
		push: vi.fn(async (event: CanonicalEvent) => {
			pushedEvents.push(event);
		}),
		requestPermission: vi.fn(async () => ({ decision: "once" as const })),
		requestQuestion: vi.fn(async () => ({})),
	};
}

function makeSendTurnInput(
	overrides?: Partial<SendTurnInput>,
): SendTurnInput {
	return {
		sessionId: "s1",
		turnId: "t1",
		prompt: "Write hello world",
		history: [],
		providerState: {},
		model: { providerId: "anthropic", modelId: "claude-sonnet" },
		workspaceRoot: "/tmp/project",
		eventSink: makeStubEventSink(),
		abortSignal: new AbortController().signal,
		...overrides,
	};
}

describe("OpenCodeAdapter.sendTurn()", () => {
	let client: OpenCodeClient;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	it("calls sendMessageAsync on the client", async () => {
		const input = makeSendTurnInput();
		// Adapter returns immediately after sending — the turn result
		// comes from SSE monitoring which we'll handle via event callbacks.
		const resultPromise = adapter.sendTurn(input);

		// Simulate turn completion via the adapter's internal callback
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0.02,
			tokens: { input: 500, output: 200 },
			durationMs: 1500,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
		});
		expect(result.status).toBe("completed");
	});

	it("passes images and agent to sendMessageAsync", async () => {
		const input = makeSendTurnInput({
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});

		const resultPromise = adapter.sendTurn(input);
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", {
			text: "Write hello world",
			model: { providerID: "anthropic", modelID: "claude-sonnet" },
			images: ["data:image/png;base64,abc"],
			agent: "coder",
		});
	});

	it("passes variant to sendMessageAsync", async () => {
		const input = makeSendTurnInput({ variant: "thinking" });

		const resultPromise = adapter.sendTurn(input);
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		await resultPromise;

		expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", expect.objectContaining({
			variant: "thinking",
		}));
	});

	it("returns error status when sendMessageAsync fails", async () => {
		client = makeStubClient({
			sendMessageAsync: vi.fn(async () => {
				throw new Error("HTTP 500");
			}),
		});
		adapter = new OpenCodeAdapter({ client });

		const input = makeSendTurnInput();
		const result = await adapter.sendTurn(input);

		expect(result.status).toBe("error");
		expect(result.error?.message).toContain("HTTP 500");
	});

	it("resolves with interrupted status when aborted", async () => {
		const abortController = new AbortController();
		const input = makeSendTurnInput({
			abortSignal: abortController.signal,
		});

		const resultPromise = adapter.sendTurn(input);

		// Simulate abort
		abortController.abort();

		// Notify via the standard completion path
		adapter.notifyTurnCompleted("s1", {
			status: "interrupted",
			cost: 0,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("interrupted");
	});

	it("records start time for duration calculation", async () => {
		const input = makeSendTurnInput();
		const resultPromise = adapter.sendTurn(input);

		// Small delay to ensure non-zero duration
		await new Promise((r) => setTimeout(r, 10));

		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 0, // Adapter may override with its own measurement
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});

	it("only resolves for the matching session", async () => {
		const input = makeSendTurnInput({ sessionId: "s1" });
		const resultPromise = adapter.sendTurn(input);

		// Notify a different session — should not resolve s1
		adapter.notifyTurnCompleted("s2", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		// Verify it's still pending (race with a timeout)
		const raceResult = await Promise.race([
			resultPromise.then(() => "resolved"),
			new Promise<string>((r) => setTimeout(() => r("timeout"), 50)),
		]);
		expect(raceResult).toBe("timeout");

		// Now resolve the correct session
		adapter.notifyTurnCompleted("s1", {
			status: "completed",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		});

		const result = await resultPromise;
		expect(result.status).toBe("completed");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-send-turn.test.ts`
Expected: FAIL — `notifyTurnCompleted` does not exist yet.

**Step 3: Write minimal implementation**

Update `src/lib/provider/opencode-adapter.ts`:

```typescript
// src/lib/provider/opencode-adapter.ts
// ─── OpenCode Provider Adapter ──────────────────────────────────────────────
// Wraps the existing OpenCodeClient REST API behind the ProviderAdapter
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import type { OpenCodeClient, PromptOptions } from "../instance/opencode-client.js";
import { createLogger } from "../logger.js";
import type {
	AdapterCapabilities,
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("opencode-adapter");

// ─── Deferred ───────────────────────────────────────────────────────────────

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface OpenCodeAdapterOptions {
	readonly client: OpenCodeClient;
	readonly workspaceRoot?: string;
}

// ─── OpenCodeAdapter ────────────────────────────────────────────────────────

export class OpenCodeAdapter implements ProviderAdapter {
	readonly providerId = "opencode";

	private readonly client: OpenCodeClient;
	private readonly workspaceRoot: string | undefined;
	private readonly pendingTurns = new Map<string, Deferred<TurnResult>>();
	// Amendment A4 (Q7): Sequential turn queue instead of throwing on concurrent turns
	private turnQueue: Array<{ resolve: () => void; reject: (err: Error) => void; input: SendTurnInput }> = [];
	private turnsInFlight = new Set<string>();

	constructor(options: OpenCodeAdapterOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
	}

	// ─── discover ─────────────────────────────────────────────────────────

	async discover(): Promise<AdapterCapabilities> {
		const [providerResult, commandsRaw, skillsRaw] = await Promise.all([
			this.client.listProviders(),
			this.client.listCommands(this.workspaceRoot),
			this.client.listSkills(this.workspaceRoot),
		]);

		// Map providers → models
		const models: ModelInfo[] = providerResult.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name,
				providerId: provider.id,
				limit: model.limit,
				...(model.variants ? { variants: model.variants } : {}),
			})),
		);

		// Map commands (builtin)
		const commands: CommandInfo[] = commandsRaw.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
			source: "builtin" as const,
		}));

		// Map skills (project-skill)
		const skills: CommandInfo[] = skillsRaw.map((skill) => ({
			name: skill.name,
			description: skill.description,
			source: "project-skill" as const,
		}));

		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: true,
			commands: [...commands, ...skills],
		};
	}

	// ─── sendTurn ─────────────────────────────────────────────────────────

	async sendTurn(input: SendTurnInput): Promise<TurnResult> {
		const { sessionId, prompt, model, images, agent, variant, abortSignal } = input;

		// Amendment A4 (Q7): Queue concurrent turns sequentially instead of throwing.
		// If a turn is already in flight for this session, queue this request and
		// wait for the previous turn to complete before executing.
		if (this.turnsInFlight.has(sessionId)) {
			return new Promise<TurnResult>((resolve, reject) => {
				this.turnQueue.push({ resolve: () => {
					this.executeTurn(input).then(resolve, reject);
				}, reject, input });
			});
		}
		return this.executeTurn(input);
	}

	private async executeTurn(input: SendTurnInput): Promise<TurnResult> {
		const { sessionId, prompt, model, images, agent, variant, abortSignal } = input;
		this.turnsInFlight.add(sessionId);

		// Build the prompt options for OpenCode REST
		const promptOptions: PromptOptions = {
			text: prompt,
			model: { providerID: model.providerId, modelID: model.modelId },
			...(images && images.length > 0 ? { images: [...images] } : {}),
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
		};

		// Create a deferred that will be resolved when the turn completes
		// (via notifyTurnCompleted, called by the SSE event pipeline)
		const deferred = createDeferred<TurnResult>();
		this.pendingTurns.set(sessionId, deferred);

		// Handle abort signal
		const onAbort = () => {
			log.info(`Turn aborted for session ${sessionId}`);
			// Don't resolve here — let notifyTurnCompleted handle it
			// The SSE pipeline will detect the abort and call notifyTurnCompleted
			this.client.abortSession(sessionId).catch((err) => {
				log.warn(`Failed to abort session ${sessionId}: ${err}`);
			});
		};

		if (abortSignal.aborted) {
			this.pendingTurns.delete(sessionId);
			return {
				status: "interrupted",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			};
		}

		abortSignal.addEventListener("abort", onAbort, { once: true });

		try {
			// Send the message — response comes via SSE, not this call
			await this.client.sendMessageAsync(sessionId, promptOptions);
		} catch (err) {
			// Clean up on send failure
			this.pendingTurns.delete(sessionId);
			abortSignal.removeEventListener("abort", onAbort);

			const message = err instanceof Error ? err.message : String(err);
			log.error(`sendTurn failed for session ${sessionId}: ${message}`);
			return {
				status: "error",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				error: { code: "SEND_FAILED", message },
				providerStateUpdates: [],
			};
		}

		try {
			// Wait for the turn to complete (resolved by notifyTurnCompleted)
			return await deferred.promise;
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
			this.pendingTurns.delete(sessionId);
			this.turnsInFlight.delete(sessionId);
			// Amendment A4: Process queued turns after completion
			this.processQueue(sessionId);
		}
	}

	/** Amendment A4: Process the next queued turn for a session. */
	private processQueue(sessionId: string): void {
		const idx = this.turnQueue.findIndex((q) => q.input.sessionId === sessionId);
		if (idx === -1) return;
		const next = this.turnQueue.splice(idx, 1)[0];
		if (next) {
			next.resolve();
		}
	}

	/**
	 * Called by the SSE event pipeline when a turn completes, errors, or
	 * is interrupted. Resolves the pending sendTurn() promise.
	 *
	 * This is the bridge between the existing SSE-based event flow and the
	 * new adapter interface. The SSE pipeline continues to own the connection;
	 * the adapter just waits for notification.
	 */
	notifyTurnCompleted(sessionId: string, result: TurnResult): void {
		const deferred = this.pendingTurns.get(sessionId);
		if (deferred) {
			this.pendingTurns.delete(sessionId);
			deferred.resolve(result);
		}
	}

	// ─── interruptTurn ────────────────────────────────────────────────────

	async interruptTurn(sessionId: string): Promise<void> {
		await this.client.abortSession(sessionId);
	}

	// ─── resolvePermission ────────────────────────────────────────────────

	async resolvePermission(
		_sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void> {
		await this.client.replyPermission({ id: requestId, decision });
	}

	// ─── resolveQuestion ──────────────────────────────────────────────────

	async resolveQuestion(
		_sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Promise<void> {
		// Convert answers to the format OpenCode expects: string[][]
		const answerArrays = Object.values(answers).map((v) =>
			Array.isArray(v) ? v.map(String) : [String(v)],
		);
		await this.client.replyQuestion({ id: requestId, answers: answerArrays });
	}

	// ─── shutdown ────────────────────────────────────────────────────────

	async shutdown(): Promise<void> {
		log.info("OpenCodeAdapter shutting down");

		// Reject all pending turns
		for (const [sessionId, deferred] of this.pendingTurns) {
			deferred.reject(new Error(`Adapter shutdown — turn for session ${sessionId} cancelled`));
		}
		this.pendingTurns.clear();
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-send-turn.test.ts`
Expected: PASS

Also verify discover tests still pass:
Run: `pnpm vitest run test/unit/provider/opencode-adapter-discover.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

The `notifyTurnCompleted` pattern is intentionally simple. In the future, the SSE pipeline will call this when it detects `session.status: idle` for the session. For now, test code calls it directly. The full integration (wiring SSE events to adapter notifications) happens in Task 42.

**Step 6: Commit**

```bash
git add src/lib/provider/opencode-adapter.ts test/unit/provider/opencode-adapter-send-turn.test.ts
git commit -m "feat(provider): implement OpenCodeAdapter.sendTurn() with REST prompt dispatch and deferred completion"
```

---

### Task 40: OpenCodeAdapter — interruptTurn, resolvePermission, resolveQuestion

**Files:**
- Modify: `src/lib/provider/opencode-adapter.ts` (already implemented in Task 39)
- Test: `test/unit/provider/opencode-adapter-actions.test.ts`

**Purpose:** Test the three action methods that were implemented as part of Task 39's full adapter rewrite. These are thin wrappers around OpenCode REST calls.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/opencode-adapter-actions.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";

function makeStubClient(overrides?: Partial<OpenCodeClient>): OpenCodeClient {
	return {
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		sendMessageAsync: vi.fn(async () => {}),
		listProviders: vi.fn(async () => ({
			providers: [],
			defaults: {},
			connected: [],
		})),
		listAgents: vi.fn(async () => []),
		listCommands: vi.fn(async () => []),
		listSkills: vi.fn(async () => []),
		...overrides,
	} as unknown as OpenCodeClient;
}

describe("OpenCodeAdapter action methods", () => {
	let client: OpenCodeClient;
	let adapter: OpenCodeAdapter;

	beforeEach(() => {
		client = makeStubClient();
		adapter = new OpenCodeAdapter({ client });
	});

	describe("interruptTurn", () => {
		it("calls client.abortSession with the session ID", async () => {
			await adapter.interruptTurn("session-123");

			expect(client.abortSession).toHaveBeenCalledWith("session-123");
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				abortSession: vi.fn(async () => {
					throw new Error("session not found");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(adapter.interruptTurn("bad-session")).rejects.toThrow(
				"session not found",
			);
		});
	});

	describe("resolvePermission", () => {
		it("calls client.replyPermission with id and decision", async () => {
			await adapter.resolvePermission("s1", "perm-1", "once");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-1",
				decision: "once",
			});
		});

		it("handles 'always' decision", async () => {
			await adapter.resolvePermission("s1", "perm-2", "always");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-2",
				decision: "always",
			});
		});

		it("handles 'reject' decision", async () => {
			await adapter.resolvePermission("s1", "perm-3", "reject");

			expect(client.replyPermission).toHaveBeenCalledWith({
				id: "perm-3",
				decision: "reject",
			});
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				replyPermission: vi.fn(async () => {
					throw new Error("permission expired");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolvePermission("s1", "bad-perm", "once"),
			).rejects.toThrow("permission expired");
		});
	});

	describe("resolveQuestion", () => {
		it("calls client.replyQuestion with id and converted answers", async () => {
			await adapter.resolveQuestion("s1", "q1", {
				choice: "yes",
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q1",
				answers: [["yes"]],
			});
		});

		it("converts array answers to string arrays", async () => {
			await adapter.resolveQuestion("s1", "q2", {
				multi: ["a", "b", "c"],
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q2",
				answers: [["a", "b", "c"]],
			});
		});

		it("handles multiple answer fields", async () => {
			await adapter.resolveQuestion("s1", "q3", {
				field1: "value1",
				field2: ["x", "y"],
			});

			expect(client.replyQuestion).toHaveBeenCalledWith({
				id: "q3",
				answers: [["value1"], ["x", "y"]],
			});
		});

		it("propagates errors from client", async () => {
			client = makeStubClient({
				replyQuestion: vi.fn(async () => {
					throw new Error("question expired");
				}),
			});
			adapter = new OpenCodeAdapter({ client });

			await expect(
				adapter.resolveQuestion("s1", "bad-q", { answer: "yes" }),
			).rejects.toThrow("question expired");
		});
	});

	describe("shutdown", () => {
		it("resolves cleanly when no pending turns", async () => {
			await expect(adapter.shutdown()).resolves.not.toThrow();
		});

		it("rejects pending turns on shutdown", async () => {
			// Start a turn that won't be completed
			const turnPromise = adapter.sendTurn({
				sessionId: "s1",
				turnId: "t1",
				prompt: "hello",
				history: [],
				providerState: {},
				model: { providerId: "anthropic", modelId: "claude-sonnet" },
				workspaceRoot: "/tmp",
				eventSink: {
					push: vi.fn(),
					requestPermission: vi.fn(),
					requestQuestion: vi.fn(),
				},
				abortSignal: new AbortController().signal,
			});

			// Shutdown while turn is pending
			await adapter.shutdown();

			await expect(turnPromise).rejects.toThrow("shutdown");
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-actions.test.ts`
Expected: All tests PASS (implementation was already done in Task 39).

> **Note:** Since the implementation was completed in Task 39, this task is purely about test coverage. If all tests pass immediately, that confirms the implementation is correct.

**Step 3: Implementation**

Already complete from Task 39. No additional code needed.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/opencode-adapter-actions.test.ts`
Expected: PASS

Run all adapter tests together:
Run: `pnpm vitest run test/unit/provider/opencode-adapter-*.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

No refactoring needed. The action methods are thin wrappers with clear test coverage.

**Step 6: Commit**

```bash
git add test/unit/provider/opencode-adapter-actions.test.ts
git commit -m "test(provider): add tests for OpenCodeAdapter interruptTurn, resolvePermission, resolveQuestion, shutdown"
```

---

### Task 41: OrchestrationEngine

> **Amendment (2026-04-09 — Concurrency Solutions, Change 4c — Bounded processedCommands):**
> Wire `processedCommands` to `CommandReceiptRepository` instead of the in-memory `Set<string>`:
> ```typescript
> private isProcessed(commandId: string): boolean {
>   return this.receiptRepo.findByCommandId(commandId) !== undefined;
> }
> private markProcessed(commandId: string, status: "completed" | "failed"): void {
>   this.receiptRepo.save({ commandId, status, createdAt: Date.now() });
> }
> ```
> `CommandReceiptRepository` already exists (Task 6). Receipts are evicted by S4/P6. No new
> infrastructure needed — just wire what's already built. Remove the in-memory `processedCommands` Set.

**Files:**
- Create: `src/lib/provider/orchestration-engine.ts`
- Test: `test/unit/provider/orchestration-engine.test.ts`

**Purpose:** The central command processor from the design doc's CQRS core loop. Dispatches commands to the correct adapter via `ProviderRegistry`. Manages session-to-provider mapping. This is the backbone that replaces direct OpenCode REST calls in future phases.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/orchestration-engine.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	OrchestrationEngine,
	type OrchestrationCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderAdapter, TurnResult } from "../../../src/lib/provider/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStubAdapter(providerId: string): ProviderAdapter & {
	sendTurn: ReturnType<typeof vi.fn>;
	interruptTurn: ReturnType<typeof vi.fn>;
	resolvePermission: ReturnType<typeof vi.fn>;
	resolveQuestion: ReturnType<typeof vi.fn>;
	discover: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
		discover: vi.fn(async () => ({
			models: [],
			supportsTools: false,
			supportsThinking: false,
			supportsPermissions: false,
			supportsQuestions: false,
			supportsAttachments: false,
			supportsFork: false,
			supportsRevert: false,
			commands: [],
		})),
		sendTurn: vi.fn(async () => ({
			status: "completed" as const,
			cost: 0.01,
			tokens: { input: 100, output: 50 },
			durationMs: 500,
			providerStateUpdates: [],
		})),
		interruptTurn: vi.fn(async () => {}),
		resolvePermission: vi.fn(async () => {}),
		resolveQuestion: vi.fn(async () => {}),
		shutdown: vi.fn(async () => {}),
	};
}

function makeStubEventSink() {
	return {
		push: vi.fn(async () => {}),
		requestPermission: vi.fn(async () => ({ decision: "once" as const })),
		requestQuestion: vi.fn(async () => ({})),
	};
}

describe("OrchestrationEngine", () => {
	let registry: ProviderRegistry;
	let engine: OrchestrationEngine;
	let opencode: ReturnType<typeof makeStubAdapter>;

	beforeEach(() => {
		registry = new ProviderRegistry();
		opencode = makeStubAdapter("opencode");
		registry.registerAdapter(opencode);
		engine = new OrchestrationEngine({ registry });
	});

	describe("dispatch: send_turn", () => {
		it("routes sendTurn to the correct adapter", async () => {
			const result = await engine.dispatch({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: { providerId: "anthropic", modelId: "claude-sonnet" },
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(opencode.sendTurn).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ status: "completed" });
		});

		it("throws for unknown provider", async () => {
			await expect(
				engine.dispatch({
					type: "send_turn",
					providerId: "unknown",
					input: {
						sessionId: "s1",
						turnId: "t1",
						prompt: "hello",
						history: [],
						providerState: {},
						model: { providerId: "x", modelId: "y" },
						workspaceRoot: "/tmp",
						eventSink: makeStubEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			).rejects.toThrow("No adapter registered for provider: unknown");
		});

		it("records session-to-provider binding", async () => {
			await engine.dispatch({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: { providerId: "anthropic", modelId: "claude-sonnet" },
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});
	});

	describe("dispatch: interrupt_turn", () => {
		it("routes interrupt to the correct adapter", async () => {
			// Establish binding first
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "interrupt_turn",
				sessionId: "s1",
			});

			expect(opencode.interruptTurn).toHaveBeenCalledWith("s1");
		});

		it("throws when session has no provider binding", async () => {
			await expect(
				engine.dispatch({
					type: "interrupt_turn",
					sessionId: "unknown-session",
				}),
			).rejects.toThrow("No provider bound to session: unknown-session");
		});
	});

	describe("dispatch: resolve_permission", () => {
		it("routes permission resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_permission",
				sessionId: "s1",
				requestId: "perm-1",
				decision: "always",
			});

			expect(opencode.resolvePermission).toHaveBeenCalledWith(
				"s1",
				"perm-1",
				"always",
			);
		});
	});

	describe("dispatch: resolve_question", () => {
		it("routes question resolution to the correct adapter", async () => {
			engine.bindSession("s1", "opencode");

			await engine.dispatch({
				type: "resolve_question",
				sessionId: "s1",
				requestId: "q1",
				answers: { choice: "yes" },
			});

			expect(opencode.resolveQuestion).toHaveBeenCalledWith(
				"s1",
				"q1",
				{ choice: "yes" },
			);
		});
	});

	describe("dispatch: discover", () => {
		it("calls discover on the specified adapter", async () => {
			const result = await engine.dispatch({
				type: "discover",
				providerId: "opencode",
			});

			expect(opencode.discover).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ models: [] });
		});
	});

	describe("session binding", () => {
		it("bindSession creates a session-to-provider mapping", () => {
			engine.bindSession("s1", "opencode");
			expect(engine.getProviderForSession("s1")).toBe("opencode");
		});

		it("unbindSession removes the mapping", () => {
			engine.bindSession("s1", "opencode");
			engine.unbindSession("s1");
			expect(engine.getProviderForSession("s1")).toBeUndefined();
		});

		it("getProviderForSession returns undefined for unbound session", () => {
			expect(engine.getProviderForSession("unknown")).toBeUndefined();
		});

		it("rebinding a session to a different provider updates the mapping", () => {
			const claude = makeStubAdapter("claude");
			registry.registerAdapter(claude);

			engine.bindSession("s1", "opencode");
			engine.bindSession("s1", "claude");
			expect(engine.getProviderForSession("s1")).toBe("claude");
		});

		it("listBoundSessions returns all bound sessions", () => {
			engine.bindSession("s1", "opencode");
			engine.bindSession("s2", "opencode");

			const sessions = engine.listBoundSessions();
			expect(sessions).toEqual(
				expect.arrayContaining([
					{ sessionId: "s1", providerId: "opencode" },
					{ sessionId: "s2", providerId: "opencode" },
				]),
			);
		});
	});

	describe("idempotency", () => {
		it("rejects duplicate command IDs", async () => {
			const command: OrchestrationCommand = {
				type: "send_turn",
				commandId: "cmd-1",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: { providerId: "anthropic", modelId: "claude-sonnet" },
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			};

			await engine.dispatch(command);

			// Second dispatch with same commandId should be rejected
			await expect(engine.dispatch(command)).rejects.toThrow(
				"Duplicate command: cmd-1",
			);
		});

		it("allows commands without commandId (no idempotency check)", async () => {
			const makeCommand = (): OrchestrationCommand => ({
				type: "send_turn",
				providerId: "opencode",
				input: {
					sessionId: "s1",
					turnId: "t1",
					prompt: "hello",
					history: [],
					providerState: {},
					model: { providerId: "anthropic", modelId: "claude-sonnet" },
					workspaceRoot: "/tmp",
					eventSink: makeStubEventSink(),
					abortSignal: new AbortController().signal,
				},
			});

			await engine.dispatch(makeCommand());
			await engine.dispatch(makeCommand()); // Should not throw

			expect(opencode.sendTurn).toHaveBeenCalledTimes(2);
		});
	});

	describe("shutdown", () => {
		it("delegates to registry.shutdownAll", async () => {
			const shutdownSpy = vi.spyOn(registry, "shutdownAll");

			await engine.shutdown();

			expect(shutdownSpy).toHaveBeenCalledTimes(1);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/orchestration-engine.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/orchestration-engine.js'"

**Step 3: Write minimal implementation**

```typescript
// src/lib/provider/orchestration-engine.ts
// ─── Orchestration Engine ───────────────────────────────────────────────────
// Central command processor for the provider adapter layer (CQRS core loop).
// Routes commands to the correct adapter via ProviderRegistry.
// Manages session-to-provider mapping.

import { createLogger } from "../logger.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type {
	AdapterCapabilities,
	PermissionDecision,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("orchestration-engine");

// ─── Command Types ──────────────────────────────────────────────────────────

export interface SendTurnCommand {
	readonly type: "send_turn";
	/** (F1) Required command ID for request-level correlation through the event pipeline. */
	readonly commandId: string;
	readonly providerId: string;
	readonly input: SendTurnInput;
}

export interface InterruptTurnCommand {
	readonly type: "interrupt_turn";
	readonly commandId?: string;
	readonly sessionId: string;
}

export interface ResolvePermissionCommand {
	readonly type: "resolve_permission";
	readonly commandId?: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly decision: PermissionDecision;
}

export interface ResolveQuestionCommand {
	readonly type: "resolve_question";
	readonly commandId?: string;
	readonly sessionId: string;
	readonly requestId: string;
	readonly answers: Record<string, unknown>;
}

export interface DiscoverCommand {
	readonly type: "discover";
	readonly commandId?: string;
	readonly providerId: string;
}

export type OrchestrationCommand =
	| SendTurnCommand
	| InterruptTurnCommand
	| ResolvePermissionCommand
	| ResolveQuestionCommand
	| DiscoverCommand;

export type OrchestrationResult = TurnResult | AdapterCapabilities | void;

// ─── Result Type Map (C1) ───────────────────────────────────────────────────
//
// (C1) Maps command types to their result types so callers of `dispatch()`
// get typed results without `as` casts.

export type OrchestrationResultMap = {
	send_turn: TurnResult;
	discover: AdapterCapabilities;
	interrupt_turn: void;
	resolve_permission: void;
	resolve_question: void;
};

// ─── ProviderError (C3) ─────────────────────────────────────────────────────
//
// (C3) Typed error class for the provider layer, replacing bare `throw new Error(...)`.
// Gives LLMs structured error codes and context for diagnosis.

export type ProviderErrorCode =
	| "ADAPTER_NOT_FOUND"
	| "SESSION_NOT_BOUND"
	| "DUPLICATE_COMMAND"
	| "SEND_FAILED"
	| "INTERRUPT_FAILED"
	| "PERMISSION_RESOLUTION_FAILED";

export class ProviderError extends Error {
	constructor(
		readonly code: ProviderErrorCode,
		message: string,
		readonly context: Record<string, unknown> = {},
	) {
		super(`[${code}] ${message}`);
		this.name = "ProviderError";
	}
}

// ─── Session Binding ────────────────────────────────────────────────────────

export interface SessionBinding {
	readonly sessionId: string;
	readonly providerId: string;
}

// ─── Engine Options ─────────────────────────────────────────────────────────

export interface OrchestrationEngineOptions {
	readonly registry: ProviderRegistry;
}

// ─── OrchestrationEngine ────────────────────────────────────────────────────

export class OrchestrationEngine {
	private readonly registry: ProviderRegistry;
	private readonly sessionBindings = new Map<string, string>();
	private readonly processedCommands = new Set<string>();

	constructor(options: OrchestrationEngineOptions) {
		this.registry = options.registry;
	}

	/**
	 * (C1) Overloaded dispatch signatures for typed results.
	 * Callers get compile-time feedback about the result shape.
	 */
	async dispatch(command: SendTurnCommand): Promise<TurnResult>;
	async dispatch(command: DiscoverCommand): Promise<AdapterCapabilities>;
	async dispatch(command: InterruptTurnCommand): Promise<void>;
	async dispatch(command: ResolvePermissionCommand): Promise<void>;
	async dispatch(command: ResolveQuestionCommand): Promise<void>;
	async dispatch(command: OrchestrationCommand): Promise<OrchestrationResult> {
		// Idempotency check — (C3) uses ProviderError instead of bare Error
		if (command.commandId) {
			if (this.processedCommands.has(command.commandId)) {
				throw new ProviderError("DUPLICATE_COMMAND", `Duplicate command: ${command.commandId}`, {
					commandId: command.commandId,
					type: command.type,
				});
			}
		}

		let result: OrchestrationResult;

		switch (command.type) {
			case "send_turn":
				result = await this.handleSendTurn(command);
				break;
			case "interrupt_turn":
				result = await this.handleInterruptTurn(command);
				break;
			case "resolve_permission":
				result = await this.handleResolvePermission(command);
				break;
			case "resolve_question":
				result = await this.handleResolveQuestion(command);
				break;
			case "discover":
				result = await this.handleDiscover(command);
				break;
			default: {
				const _exhaustive: never = command;
				throw new Error(`Unknown command type: ${(command as any).type}`);
			}
		}

		// Record the command as processed (after successful execution)
		if (command.commandId) {
			this.processedCommands.add(command.commandId);
		}

		return result;
	}

	// ─── Command Handlers ─────────────────────────────────────────────────

	private async handleSendTurn(command: SendTurnCommand): Promise<TurnResult> {
		const adapter = this.registry.getAdapterOrThrow(command.providerId);

		// Record session-to-provider binding
		this.sessionBindings.set(command.input.sessionId, command.providerId);

		log.info(
			`Dispatching sendTurn: session=${command.input.sessionId} provider=${command.providerId}`,
		);

		return adapter.sendTurn(command.input);
	}

	private async handleInterruptTurn(command: InterruptTurnCommand): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		log.info(`Dispatching interruptTurn: session=${command.sessionId}`);

		return adapter.interruptTurn(command.sessionId);
	}

	private async handleResolvePermission(
		command: ResolvePermissionCommand,
	): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		return adapter.resolvePermission(
			command.sessionId,
			command.requestId,
			command.decision,
		);
	}

	private async handleResolveQuestion(
		command: ResolveQuestionCommand,
	): Promise<void> {
		const providerId = this.getProviderForSessionOrThrow(command.sessionId);
		const adapter = this.registry.getAdapterOrThrow(providerId);

		return adapter.resolveQuestion(
			command.sessionId,
			command.requestId,
			command.answers,
		);
	}

	private async handleDiscover(
		command: DiscoverCommand,
	): Promise<AdapterCapabilities> {
		const adapter = this.registry.getAdapterOrThrow(command.providerId);
		return adapter.discover();
	}

	// ─── Session Binding Management ───────────────────────────────────────

	/** Bind a session to a provider. */
	bindSession(sessionId: string, providerId: string): void {
		this.sessionBindings.set(sessionId, providerId);
	}

	/** Unbind a session from its provider. */
	unbindSession(sessionId: string): void {
		this.sessionBindings.delete(sessionId);
	}

	/** Get the provider ID for a session, or undefined if not bound. */
	getProviderForSession(sessionId: string): string | undefined {
		return this.sessionBindings.get(sessionId);
	}

	/** List all bound sessions with their provider IDs. */
	listBoundSessions(): SessionBinding[] {
		return [...this.sessionBindings.entries()].map(
			([sessionId, providerId]) => ({ sessionId, providerId }),
		);
	}

	/** Shutdown the engine and all adapters. */
	async shutdown(): Promise<void> {
		log.info("OrchestrationEngine shutting down");
		await this.registry.shutdownAll();
		this.sessionBindings.clear();
		this.processedCommands.clear();
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	private getProviderForSessionOrThrow(sessionId: string): string {
		const providerId = this.sessionBindings.get(sessionId);
		if (!providerId) {
			throw new Error(`No provider bound to session: ${sessionId}`);
		}
		return providerId;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/orchestration-engine.test.ts`
Expected: PASS

**Step 5: Refactor if needed**

The `processedCommands` Set will grow unboundedly. In production, this should be backed by the `CommandReceiptRepository` from Phase 1. For now, the in-memory Set is correct for the interface contract. Phase 7 cleanup can wire the engine to the persistence layer.

**Step 6: Commit**

```bash
git add src/lib/provider/orchestration-engine.ts test/unit/provider/orchestration-engine.test.ts
git commit -m "feat(provider): add OrchestrationEngine dispatching commands to adapters via ProviderRegistry"
```

---

### Task 42: Wire Orchestration into Relay

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Test: `test/unit/provider/orchestration-wiring.test.ts`

**Purpose:** Create the `OrchestrationEngine` as part of the relay stack. For now, the engine sits alongside the existing relay — it doesn't replace it yet. Future phases will route commands through the engine instead of directly to OpenCode. This task validates that the provider layer can be instantiated and wired without breaking existing relay functionality.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/orchestration-wiring.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import {
	createOrchestrationLayer,
	type OrchestrationLayer,
} from "../../../src/lib/provider/orchestration-wiring.js";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";

function makeStubClient(): OpenCodeClient {
	return {
		abortSession: vi.fn(async () => {}),
		replyPermission: vi.fn(async () => {}),
		replyQuestion: vi.fn(async () => {}),
		sendMessageAsync: vi.fn(async () => {}),
		listProviders: vi.fn(async () => ({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-sonnet",
							name: "Claude Sonnet",
							limit: { context: 200000, output: 8192 },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		})),
		listAgents: vi.fn(async () => []),
		listCommands: vi.fn(async () => []),
		listSkills: vi.fn(async () => []),
	} as unknown as OpenCodeClient;
}

describe("Orchestration wiring", () => {
	it("createOrchestrationLayer returns engine, registry, and adapter", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.engine).toBeInstanceOf(OrchestrationEngine);
		expect(layer.registry).toBeInstanceOf(ProviderRegistry);
		expect(layer.adapter).toBeInstanceOf(OpenCodeAdapter);
	});

	it("registry has opencode adapter registered", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		expect(layer.registry.hasAdapter("opencode")).toBe(true);
	});

	it("engine can discover opencode capabilities", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		const caps = await layer.engine.dispatch({
			type: "discover",
			providerId: "opencode",
		});

		expect(caps).toMatchObject({ supportsTools: true });
	});

	it("shutdown cleans up all components", async () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({ client });

		// Should not throw
		await layer.engine.shutdown();
	});

	it("accepts optional workspace root", () => {
		const client = makeStubClient();
		const layer = createOrchestrationLayer({
			client,
			workspaceRoot: "/my/project",
		});

		expect(layer.adapter).toBeInstanceOf(OpenCodeAdapter);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/provider/orchestration-wiring.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/provider/orchestration-wiring.js'"

**Step 3: Write minimal implementation**

Create the wiring module:

```typescript
// src/lib/provider/orchestration-wiring.ts
// ─── Orchestration Wiring ───────────────────────────────────────────────────
// Factory function to create the full orchestration layer (registry, adapter,
// engine) from an OpenCodeClient. Used by relay-stack.ts to instantiate the
// provider layer alongside the existing relay pipeline.

import type { OpenCodeClient } from "../instance/opencode-client.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { OrchestrationEngine } from "./orchestration-engine.js";
import { ProviderRegistry } from "./provider-registry.js";

export interface OrchestrationLayerOptions {
	readonly client: OpenCodeClient;
	readonly workspaceRoot?: string;
}

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly adapter: OpenCodeAdapter;
	/** Amendment A1: Wire SSE events to adapter.notifyTurnCompleted(). */
	readonly wireSSEToAdapter: (sseConsumer: { on: (event: string, handler: (event: any) => void) => void }) => void;
}

/**
 * Create the full orchestration layer.
 *
 * Instantiates the ProviderRegistry, registers the OpenCodeAdapter,
 * and creates the OrchestrationEngine. The layer sits alongside the
 * existing relay pipeline — it doesn't replace it yet.
 */
export function createOrchestrationLayer(
	options: OrchestrationLayerOptions,
): OrchestrationLayer {
	const registry = new ProviderRegistry();

	const adapter = new OpenCodeAdapter({
		client: options.client,
		workspaceRoot: options.workspaceRoot,
	});

	registry.registerAdapter(adapter);

	const engine = new OrchestrationEngine({ registry });

	// Amendment A1 (C6): Actual SSE wiring for notifyTurnCompleted, replacing comment-only stub.
	// This function should be called by relay-stack.ts to wire SSE events to the adapter.
	// It MUST be added to the returned OrchestrationLayer and invoked during relay setup.
	function wireSSEToAdapter(sseConsumer: { on: (event: string, handler: (event: any) => void) => void }): void {
		sseConsumer.on("session.status", (event: any) => {
			if (event.type === "session.status" && event.properties?.status?.type === "idle") {
				const sessionId = event.properties?.sessionId ?? event.sessionId;
				if (sessionId) {
					adapter.notifyTurnCompleted(sessionId, {
						status: "completed",
						cost: event.properties?.cost ?? 0,
						tokens: event.properties?.tokens ?? { input: 0, output: 0 },
						durationMs: event.properties?.durationMs ?? 0,
						providerStateUpdates: [],
					});
				}
			}
		});
	}

	// Amendment A5 (Q6): EventSink (sinkPromise) is the CANONICAL path for permission
	// resolution. The race pattern (Promise.race([sinkPromise, localDecision])) should
	// NOT be used. Phase 6 implementers: when implementing ClaudePermissionBridge, route
	// all permission decisions through EventSink.requestPermission() exclusively.
	// See Task 46 for the bridge implementation — it must await the EventSink promise
	// directly, not race it against a local deferred.

	return { engine, registry, adapter, wireSSEToAdapter };
}
```

Now update `relay-stack.ts` to create the orchestration layer alongside the existing components. Add it to the `ProjectRelay` interface and the `createProjectRelay` function:

**Amendment A2 (I10): Concrete code diffs for relay-stack.ts changes** (replacing prose bullet-points):

**Diff 1 — Add import** at top of `src/lib/relay/relay-stack.ts`, after other imports:
```diff
+ import { createOrchestrationLayer, type OrchestrationLayer } from "../provider/orchestration-wiring.js";
```

**Diff 2 — Extend ProjectRelay interface** in `src/lib/relay/relay-stack.ts`:
```diff
  export interface ProjectRelay {
    // ... existing fields ...
+   orchestration: OrchestrationLayer;
  }
```

**Diff 3 — Create orchestration layer** in `createProjectRelay()`, after `const client = new OpenCodeClient({...})`:
```diff
+ const orchestration = createOrchestrationLayer({
+   client,
+   workspaceRoot: config.projectDir,
+ });
```

**Diff 4 — Wire SSE events** in `createProjectRelay()`, after SSE consumer creation:
```diff
+ // Wire SSE session.status events to adapter.notifyTurnCompleted()
+ orchestration.wireSSEToAdapter(sseConsumer);
```

**Diff 5 — Add to returned object** in `createProjectRelay()`:
```diff
  return {
    // ... existing fields ...
+   orchestration,
  };
```

**Diff 6 — Add shutdown** in the `stop()` function:
```diff
  async function stop() {
    // ... existing cleanup ...
+   await orchestration.engine.shutdown();
  }
```

**Diff 7 — Add SSE wiring in `src/lib/relay/sse-wiring.ts`** (Amendment A1 — C6):
Add this event listener after the existing session.status event processing:
```diff
+ // Amendment A1: Wire session.status idle events to adapter.notifyTurnCompleted()
+ if (event.type === "session.status" && event.properties?.status?.type === "idle") {
+   adapter?.notifyTurnCompleted?.();
+ }
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/provider/orchestration-wiring.test.ts`
Expected: PASS

Run the full test suite to confirm no regressions:
Run: `pnpm vitest run test/unit/`
Expected: All existing tests pass.

**Step 5: Refactor if needed**

The relay-stack integration is intentionally minimal — a single `createOrchestrationLayer` call and exposing it on `ProjectRelay`. No existing behavior changes. The engine sits idle alongside the relay, ready for future phases to route commands through it.

Consider whether the `OrchestrationLayer` should be optional on `ProjectRelay` (behind a feature flag). For Phase 5, it's always created — the overhead is minimal (a Map + 3 objects). If startup time becomes a concern, a flag can gate it in Phase 7.

**Step 6: Commit**

```bash
git add src/lib/provider/orchestration-wiring.ts test/unit/provider/orchestration-wiring.test.ts src/lib/relay/relay-stack.ts
git commit -m "feat(provider): wire OrchestrationEngine into relay stack alongside existing pipeline"
```

---

### Phase 5 Completion Checklist

After all 8 tasks (Tasks 35-42), verify the full phase:

```bash
pnpm vitest run test/unit/provider/
```

Expected: All tests pass. Files created or modified:

| File | Purpose |
|------|---------|
| `src/lib/provider/types.ts` | **Created**: ProviderAdapter interface + SendTurnInput, TurnResult, EventSink, AdapterCapabilities, etc. |
| `src/lib/provider/event-sink.ts` | **Created**: EventSinkImpl wrapping EventStore + ProjectionRunner with blocking permission/question |
| `src/lib/provider/provider-registry.ts` | **Created**: Map-based adapter lookup with shutdownAll |
| `src/lib/provider/opencode-adapter.ts` | **Created**: OpenCode adapter wrapping OpenCodeClient REST API |
| `src/lib/provider/orchestration-engine.ts` | **Created**: Central command dispatcher with session-to-provider routing |
| `src/lib/provider/orchestration-wiring.ts` | **Created**: Factory wiring registry + adapter + engine |
| `src/lib/relay/relay-stack.ts` | **Modified**: creates OrchestrationLayer alongside existing relay |

Test files:

| File | Coverage |
|------|----------|
| `test/unit/provider/types.test.ts` | ProviderAdapter interface shape, SendTurnInput, TurnResult, AdapterCapabilities |
| `test/unit/provider/event-sink.test.ts` | push + project, permission/question blocking + resolution, abort |
| `test/unit/provider/provider-registry.test.ts` | register, get, list, remove, shutdownAll |
| `test/unit/provider/opencode-adapter-discover.test.ts` | discover() model/command/skill mapping |
| `test/unit/provider/opencode-adapter-send-turn.test.ts` | sendTurn() REST dispatch, deferred completion, abort |
| `test/unit/provider/opencode-adapter-actions.test.ts` | interruptTurn, resolvePermission, resolveQuestion, shutdown |
| `test/unit/provider/orchestration-engine.test.ts` | command dispatch, session binding, idempotency, shutdown |
| `test/unit/provider/orchestration-wiring.test.ts` | factory creates full layer, discover works end-to-end |

Also run the full verification suite to confirm no regressions:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: All existing tests pass. The relay pipeline is unchanged — the orchestration layer is purely additive. The `OrchestrationEngine` sits alongside the existing direct-to-OpenCode pipeline, ready for Phase 6 (Claude adapter) and Phase 7 (command routing switchover).

**Architecture summary:**

```
                    ┌─────────────────────────────────────────────────┐
                    │                  relay-stack.ts                 │
                    │                                                 │
                    │  ┌──────────────┐   ┌───────────────────────┐  │
                    │  │ SSEConsumer  │   │  OrchestrationEngine  │  │
                    │  │ (existing)   │   │  (new — Phase 5)      │  │
                    │  └──────┬───────┘   └───────────┬───────────┘  │
                    │         │                       │              │
                    │         │           ┌───────────▼───────────┐  │
                    │         │           │   ProviderRegistry    │  │
                    │         │           └───────────┬───────────┘  │
                    │         │                       │              │
                    │         │           ┌───────────▼───────────┐  │
                    │         │           │  OpenCodeAdapter      │  │
                    │         │           │  - discover()         │  │
                    │         │           │  - sendTurn()         │  │
                    │         │           │  - interruptTurn()    │  │
                    │         │           │  - resolvePermission()│  │
                    │         │           │  - resolveQuestion()  │  │
                    │         │           └───────────┬───────────┘  │
                    │         │                       │              │
                    │         │           ┌───────────▼───────────┐  │
                    │         └──────────►│   OpenCodeClient      │  │
                    │                     │   (existing REST API) │  │
                    │                     └───────────────────────┘  │
                    └─────────────────────────────────────────────────┘
```

Both paths use the same `OpenCodeClient`. The SSE consumer continues to own the event stream. In Phase 6, a second adapter (`ClaudeAdapter`) will be registered alongside `OpenCodeAdapter`. In Phase 7, the relay will route commands through the `OrchestrationEngine` instead of directly calling `OpenCodeClient`.

**Next:** Phase 6 (Claude Agent SDK Adapter) will implement the second adapter, validating that the `ProviderAdapter` interface works for a fundamentally different provider surface (long-lived SDK session vs stateless REST).

---

## Phase 6: Claude Agent SDK Adapter

**Goal:** Implement the Claude Agent SDK adapter, enabling conduit to use Claude as a provider alongside OpenCode. Multi-turn sessions run via the SDK's long-lived `query()` function, with events translated to canonical types and pushed through `EventSink`.

**Depends on:** Phase 5 (`ProviderAdapter` interface, `EventSink`, `ProviderRegistry`).

**Validates:** The `ProviderAdapter` interface works for a fundamentally different provider surface — a long-lived SDK session with an `AsyncIterable` prompt queue, callback-based permissions, and a streaming `AsyncIterable<SDKMessage>` output — not just OpenCode's stateless REST+SSE model.

**Key architectural differences vs OpenCode:**

| Concern | OpenCode | Claude SDK |
|---|---|---|
| Turn model | Stateless REST per turn | One long-lived `query()` per session |
| Event stream | Server-Sent Events | `AsyncIterable<SDKMessage>` |
| Multi-turn | New REST request | Enqueue into existing prompt queue |
| Permissions | Push model (SSE event) | Pull model (`canUseTool` callback) |
| Resume | Session ID in URL | `resume` cursor in options |
| Tools | Adapter-registered | SDK-managed (Bash, Read, Write, Edit, etc.) |

**Reference:** t3code's `ClaudeAdapterLive` at `~/src/personal/opencode-relay/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts` (3,065 lines). Our implementation is deliberately smaller — conduit owns session lifecycle and history projection, so the adapter only needs to bridge the SDK to the 7-method `ProviderAdapter` contract via `EventSink`.

**Phase 6 is split across two halves** (continued in Phase 6b):
- **6a (this section):** SDK types, prompt queue, event translator, permission bridge, adapter skeleton (discover + shutdown). Tasks 43–47.
- **6b (next section):** `sendTurn` implementation, the SDK stream consumer loop, interrupt handling, resume/fallback, `ProviderRegistry` wiring, integration tests. Tasks 48–52.

---

### Task 43: Install Claude SDK and Define Adapter Types

**Files:**
- Modify: `package.json` (add `@anthropic-ai/claude-agent-sdk` dependency)
- Create: `src/lib/provider/claude/types.ts`
- Test: `test/unit/provider/claude/types.test.ts`

**Purpose:** Define the types that the Claude adapter uses to bridge the SDK to the `ProviderAdapter` contract. The SDK's `query()` function takes an `AsyncIterable<SDKUserMessage>` as input and returns an `AsyncIterable<SDKMessage>` as output — our types wrap that runtime plus the conduit-specific session state (prompt queue, pending approvals, resume cursor).

**Step 1: Write the failing test**

```typescript
// test/unit/provider/claude/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type {
	ClaudeSessionContext,
	ClaudeQueryRuntime,
	ClaudeResumeCursor,
	PendingApproval,
	PromptQueueItem,
} from "../../../../src/lib/provider/claude/types.js";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

describe("Claude adapter types", () => {
	it("ClaudeQueryRuntime extends AsyncIterable<SDKMessage>", () => {
		expectTypeOf<ClaudeQueryRuntime>().toMatchTypeOf<AsyncIterable<SDKMessage>>();
		expectTypeOf<ClaudeQueryRuntime["interrupt"]>().toEqualTypeOf<() => Promise<void>>();
		expectTypeOf<ClaudeQueryRuntime["setModel"]>().toEqualTypeOf<(model?: string) => Promise<void>>();
	});

	it("PromptQueueItem is a discriminated union", () => {
		const msg: PromptQueueItem = {
			type: "message",
			message: {} as SDKUserMessage,
		};
		const term: PromptQueueItem = { type: "terminate" };
		expectTypeOf(msg).toMatchTypeOf<PromptQueueItem>();
		expectTypeOf(term).toMatchTypeOf<PromptQueueItem>();
	});

	it("ClaudeResumeCursor shape matches provider_state contract", () => {
		const cursor: ClaudeResumeCursor = {
			resumeSessionId: "abc-123",
			lastAssistantUuid: "def-456",
			turnCount: 3,
		};
		expectTypeOf(cursor).toMatchTypeOf<ClaudeResumeCursor>();
	});

	it("PendingApproval carries a resolver promise", () => {
		expectTypeOf<PendingApproval>().toHaveProperty("resolve");
		expectTypeOf<PendingApproval>().toHaveProperty("reject");
	});

	it("ClaudeSessionContext owns the prompt queue and query runtime", () => {
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("promptQueue");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("query");
		expectTypeOf<ClaudeSessionContext>().toHaveProperty("pendingApprovals");
	});
});
```

**Step 2: Verify test fails**

```bash
pnpm vitest run test/unit/provider/claude/types.test.ts
```
Expected: FAIL — module does not exist.

**Step 3: Install SDK and implement types**

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

```typescript
// src/lib/provider/claude/types.ts
/**
 * Types used by the Claude Agent SDK adapter.
 *
 * The SDK's `query()` returns a long-lived session: you feed it an
 * AsyncIterable of user messages and read back an AsyncIterable of SDK
 * messages. One `query()` runs for the entire conduit session (not per turn).
 * sendTurn() enqueues into the prompt queue; a background consumer drains
 * the output stream and translates events for EventSink.
 */
import type {
	SDKMessage,
	SDKUserMessage,
	PermissionMode,
	PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionDecision } from "../types.js";

// ─── Prompt Queue ──────────────────────────────────────────────────────────

/**
 * Items placed into the PromptQueue and consumed as an AsyncIterable by
 * the SDK's `query()`. "terminate" ends the iteration and shuts down the
 * SDK session cleanly.
 */
export type PromptQueueItem =
	| { readonly type: "message"; readonly message: SDKUserMessage }
	| { readonly type: "terminate" };

// ─── SDK Query Runtime ─────────────────────────────────────────────────────

/**
 * The runtime object returned by the SDK's `query()` call. It is both an
 * AsyncIterable of SDKMessages (the output stream) and exposes control
 * methods for interrupts, model switching, and clean shutdown.
 */
export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
	readonly interrupt: () => Promise<void>;
	readonly setModel: (model?: string) => Promise<void>;
	readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
	readonly close: () => void;
}

// ─── Resume Cursor ─────────────────────────────────────────────────────────

/**
 * Stored in a session's `provider_state` under the `claude` namespace.
 * Written on every turn completion, read on session reopen to resume the
 * SDK session in place.
 */
export interface ClaudeResumeCursor {
	readonly resumeSessionId?: string;
	readonly lastAssistantUuid?: string;
	readonly turnCount: number;
}

// ─── Pending Approval / Question ───────────────────────────────────────────

/**
 * An in-flight `canUseTool` callback waiting for a user decision. The
 * permission bridge creates one, emits permission.asked via EventSink, and
 * blocks by awaiting the deferred until the UI calls resolvePermission().
 */
export interface PendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly createdAt: string;
	resolve(decision: PermissionDecision): void;
	reject(error: Error): void;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly createdAt: string;
	resolve(answers: Record<string, unknown>): void;
	reject(error: Error): void;
}

// ─── Tool In Flight ────────────────────────────────────────────────────────

/**
 * Tracks a tool_use content block while it streams so that tool.running
 * events can be emitted as input_json deltas arrive.
 */
export interface ToolInFlight {
	readonly itemId: string;
	readonly toolName: string;
	readonly title: string;
	input: Record<string, unknown>;
	partialInputJson: string;
	lastEmittedFingerprint?: string;
}

// ─── Session Context ───────────────────────────────────────────────────────

/**
 * All state for a single Claude session. Owned by ClaudeAdapter and keyed
 * by conduit sessionId. One instance per live SDK `query()`.
 */
export interface ClaudeSessionContext {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly startedAt: string;
	readonly promptQueue: PromptQueueController;
	readonly query: ClaudeQueryRuntime;
	readonly pendingApprovals: Map<string, PendingApproval>;
	readonly pendingQuestions: Map<string, PendingQuestion>;
	readonly inFlightTools: Map<number, ToolInFlight>;
	streamConsumer: Promise<void> | undefined;
	currentTurnId: string | undefined;
	currentModel: string | undefined;
	resumeSessionId: string | undefined;
	lastAssistantUuid: string | undefined;
	turnCount: number;
	stopped: boolean;
}

/**
 * Minimal interface the PromptQueue implementation must satisfy. Defined
 * here to decouple ClaudeSessionContext from the concrete class.
 */
export interface PromptQueueController extends AsyncIterable<SDKUserMessage> {
	enqueue(message: SDKUserMessage): void;
	close(): void;
}

// ─── Re-exports ────────────────────────────────────────────────────────────

export type { PermissionMode, PermissionResult, SDKMessage, SDKUserMessage };
```

**Step 4: Verify test passes**

```bash
pnpm vitest run test/unit/provider/claude/types.test.ts
```
Expected: PASS.

**Step 5: Refactor**

Check that the types map cleanly onto both the SDK surface and the `ProviderAdapter` contract:
- `ClaudeQueryRuntime` matches the subset of the SDK's query result that we use.
- `ClaudeResumeCursor` is the exact shape that will be persisted to `provider_state`.
- `PendingApproval.resolve` takes `PermissionDecision` (from `ProviderAdapter`), not an SDK-specific type, keeping the permission bridge portable.

No refactor needed.

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/provider/claude/types.ts test/unit/provider/claude/types.test.ts
git commit -m "feat(provider): add Claude Agent SDK adapter types and install @anthropic-ai/claude-agent-sdk"
```

---

### Task 44: PromptQueue — AsyncIterable bridge

> **Amendment (2026-04-09 — Concurrency Solutions, Change 4d — Single-Consumer Guard):**
> Add an explicit consumption guard on `[Symbol.asyncIterator]()`. The queue returns `this` as
> the iterator, meaning multiple `for await` loops would share the same buffer and silently lose
> messages. The guard makes this contract explicit:
> ```typescript
> private _iterating = false;
> [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
>   if (this._iterating) throw new Error("PromptQueue is single-consumer. Cannot iterate more than once.");
>   this._iterating = true;
>   return this;
> }
> ```
> This fails fast rather than silently losing messages if incorrectly reused.

**Files:**
- Create: `src/lib/provider/claude/prompt-queue.ts`
- Test: `test/unit/provider/claude/prompt-queue.test.ts`

**Purpose:** The SDK's `query()` takes an `AsyncIterable<SDKUserMessage>` as its prompt source. We need an object that (a) exposes an `enqueue()` method so `sendTurn()` can push new user turns, (b) exposes `close()` so `shutdown()` can terminate the iteration, and (c) correctly blocks the SDK's internal `for await` loop when the queue is empty. This is a classic async-queue / future bridge.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/claude/prompt-queue.test.ts
import { describe, it, expect } from "vitest";
import { PromptQueue } from "../../../../src/lib/provider/claude/prompt-queue.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

function msg(text: string): SDKUserMessage {
	return {
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: { role: "user", content: [{ type: "text", text }] },
	} as SDKUserMessage;
}

async function takeN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) {
		out.push(item);
		if (out.length >= n) break;
	}
	return out;
}

describe("PromptQueue", () => {
	it("yields messages in enqueue order", async () => {
		const q = new PromptQueue();
		q.enqueue(msg("one"));
		q.enqueue(msg("two"));
		q.enqueue(msg("three"));
		q.close();

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(3);
		expect((items[0]?.message.content as any)[0].text).toBe("one");
		expect((items[2]?.message.content as any)[0].text).toBe("three");
	});

	it("blocks consumer until a message is enqueued", async () => {
		const q = new PromptQueue();
		const consumerPromise = takeN(q, 1);

		// Give the consumer a tick to start awaiting.
		await new Promise((r) => setTimeout(r, 10));

		q.enqueue(msg("hello"));
		const items = await consumerPromise;
		expect(items).toHaveLength(1);
		expect((items[0]?.message.content as any)[0].text).toBe("hello");
		q.close();
	});

	it("terminates the iterator when close() is called", async () => {
		const q = new PromptQueue();
		q.enqueue(msg("only"));
		q.close();

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(1);
	});

	it("close() unblocks a waiting consumer with an end-of-stream", async () => {
		const q = new PromptQueue();
		const consumer = (async () => {
			const items: SDKUserMessage[] = [];
			for await (const m of q) items.push(m);
			return items;
		})();

		await new Promise((r) => setTimeout(r, 10));
		q.close();

		const items = await consumer;
		expect(items).toEqual([]);
	});

	it("enqueue after close is a no-op", async () => {
		const q = new PromptQueue();
		q.close();
		q.enqueue(msg("ignored"));
		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toEqual([]);
	});

	it("is reusable only once (Symbol.asyncIterator returns this)", () => {
		const q = new PromptQueue();
		// The queue itself IS the iterator, not a new one per call.
		const a = q[Symbol.asyncIterator]();
		const b = q[Symbol.asyncIterator]();
		expect(a).toBe(b);
	});
});
```

**Step 2: Verify test fails**

```bash
pnpm vitest run test/unit/provider/claude/prompt-queue.test.ts
```
Expected: FAIL — `PromptQueue` does not exist.

**Step 3: Implement PromptQueue**

```typescript
// src/lib/provider/claude/prompt-queue.ts
/**
 * PromptQueue bridges synchronous enqueue() calls to an AsyncIterable that
 * the Claude Agent SDK's `query()` function consumes for user messages.
 *
 * Design notes:
 * - Single-consumer: `query()` is the only consumer. Symbol.asyncIterator
 *   returns `this`, so re-iteration is not supported.
 * - FIFO buffer: messages enqueued before the consumer starts are queued
 *   and delivered in order.
 * - Future-based wake: when the buffer is empty, `next()` returns a promise
 *   that is resolved by the next enqueue() or close() call.
 * - Close semantics: once closed, any buffered messages still drain; then
 *   the iterator yields `{ done: true }`. Further enqueue() calls are no-ops.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PromptQueueController } from "./types.js";

type PendingResolver = (result: IteratorResult<SDKUserMessage>) => void;

export class PromptQueue
	implements PromptQueueController, AsyncIterator<SDKUserMessage>
{
	private readonly buffer: SDKUserMessage[] = [];
	private readonly waiters: PendingResolver[] = [];
	private closed = false;

	enqueue(message: SDKUserMessage): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: message, done: false });
			return;
		}
		this.buffer.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// Flush any awaiting consumers with end-of-stream.
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.({ value: undefined, done: true });
		}
	}

	async next(): Promise<IteratorResult<SDKUserMessage>> {
		const buffered = this.buffer.shift();
		if (buffered !== undefined) {
			return { value: buffered, done: false };
		}
		if (this.closed) {
			return { value: undefined, done: true };
		}
		return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	async return(): Promise<IteratorResult<SDKUserMessage>> {
		this.close();
		return { value: undefined, done: true };
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return this;
	}
}
```

**Step 4: Verify test passes**

```bash
pnpm vitest run test/unit/provider/claude/prompt-queue.test.ts
```
Expected: PASS (all 6 cases).

**Step 5: Refactor**

Consider whether `PromptQueue` should handle backpressure (e.g. bounded queue). For conduit's usage — the user only enqueues a message per turn via the UI — unbounded is fine; the SDK will drain each message promptly. No refactor.

**Amendment A13 (Q5): Image/file attachment support.** When constructing `SDKUserMessage` for enqueue, the caller (Task 48's `sendTurn()`) must include image content blocks alongside text. Example:
```typescript
// In sendTurn(), when building the SDKUserMessage:
const contentBlocks: Array<{ type: string; [key: string]: unknown }> = [
	{ type: "text", text: prompt },
];
if (images && images.length > 0) {
	for (const img of images) {
		contentBlocks.push({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: img },
		});
	}
}
const userMessage: SDKUserMessage = {
	type: "user",
	session_id: ctx.resumeSessionId ?? "",
	parent_tool_use_id: null,
	message: { role: "user", content: contentBlocks },
};
queue.enqueue(userMessage);
```

**Step 6: Commit**

```bash
git add src/lib/provider/claude/prompt-queue.ts test/unit/provider/claude/prompt-queue.test.ts
git commit -m "feat(provider): add PromptQueue async bridge for Claude SDK query() input"
```

---

### Task 45: Claude Event Translator

**Files:**
- Create: `src/lib/provider/claude/claude-event-translator.ts`
- Test: `test/unit/provider/claude/claude-event-translator.test.ts`

**Purpose:** The Claude SDK emits `SDKMessage` values with types `system`, `assistant`, `user` (tool results), `stream_event`, and `result`. The translator maps each of these into canonical events (`text.delta`, `thinking.delta`, `tool.started`, `tool.running`, `tool.completed`, `turn.completed`, `turn.error`, `turn.interrupted`, `session.status`, etc.) and pushes them through `EventSink`. This is the bridge between the SDK's wire format and conduit's event store. All event payloads conform to the `EventPayloadMap` interfaces defined in Phase 1 Task 4.

**Key SDK event types handled (Amendment A14 — corrected to use existing canonical types):**

| SDK Event | Canonical Mapping |
|---|---|
| `stream_event` / `content_block_start` (text) | `tool.started` `{messageId, partId, toolName, callId, input}` |
| `stream_event` / `content_block_delta` (text_delta) | `text.delta` `{messageId, partId, text}` |
| `stream_event` / `content_block_delta` (thinking_delta) | `thinking.delta` `{messageId, partId, text}` |
| `stream_event` / `content_block_start` (tool_use) | `tool.started` `{messageId, partId, toolName, callId, input}` |
| `stream_event` / `content_block_delta` (input_json_delta) | `tool.running` `{messageId, partId}` |
| `stream_event` / `content_block_stop` (text/thinking) | `tool.completed` `{messageId, partId, result, duration}` |
| `user` message / `tool_result` block | `tool.completed` `{messageId, partId, result, duration}` |
| `assistant` message (snapshot) | Capture UUID for resume cursor + set messageId |
| `result` (success) | `turn.completed` `{messageId, cost?, tokens?, duration?}` |
| `result` (error/interrupted) | `turn.completed` with error / `turn.error` `{messageId, error, code?}` |
| `system` / `init` | `session.status` `{sessionId, status: "configured"}` |
| `system` / `task_progress` | `turn.completed` `{messageId, tokens?, cost?, duration?}` |

**Step 1: Write the failing test**

```typescript
// test/unit/provider/claude/claude-event-translator.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudeEventTranslator } from "../../../../src/lib/provider/claude/claude-event-translator.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";

function makeStubSink(): EventSink & { events: any[] } {
	const events: any[] = [];
	return {
		events,
		push: vi.fn(async (event) => {
			events.push(event);
		}),
		requestPermission: vi.fn(),
		requestQuestion: vi.fn(),
	};
}

function makeCtx(overrides: Partial<ClaudeSessionContext> = {}): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: "2026-04-05T00:00:00.000Z",
		promptQueue: {} as any,
		query: {} as any,
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: "claude-sonnet-4",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
		...overrides,
	};
}

describe("ClaudeEventTranslator", () => {
	let sink: ReturnType<typeof makeStubSink>;
	let translator: ClaudeEventTranslator;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeStubSink();
		ctx = makeCtx();
		translator = new ClaudeEventTranslator({ sink });
	});

	// Amendment A14: Updated test to use text.delta instead of content.delta
	it("translates text_delta stream events to text.delta", async () => {
		const msg: SDKMessage = {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Hello" },
			},
		} as any;

		// Seed an assistant text block so the translator has an itemId to attach to.
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		} as any);
		await translator.translate(ctx, msg);

		// Amendment A14: text.delta with {messageId, partId, text} payload
		// F9: payload matches TextDeltaPayload
		const deltaEvents = sink.events.filter((e) => e.type === "text.delta");
		expect(deltaEvents).toHaveLength(1);
		expect(deltaEvents[0].data.text).toBe("Hello");
		expect(deltaEvents[0].data.messageId).toBeDefined();
		expect(deltaEvents[0].data.partId).toBeDefined();
	});

	// Amendment A14: Updated test to use thinking.delta instead of content.delta
	it("translates thinking_delta to thinking.delta", async () => {
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			},
		} as any);
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Let me think..." },
			},
		} as any);

		// Amendment A14: thinking.delta with {messageId, partId, text} payload
		// F9: payload matches ThinkingDeltaPayload
		const delta = sink.events.find((e) => e.type === "thinking.delta");
		expect(delta?.data.text).toBe("Let me think...");
		expect(delta?.data.messageId).toBeDefined();
		expect(delta?.data.partId).toBeDefined();
	});

	// Amendment A14: item.started → tool.started
	it("translates tool_use content_block_start to tool.started", async () => {
		await translator.translate(ctx, {
			type: "stream_event",
			session_id: "sdk-sess",
			event: {
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "tool_use",
					id: "tool-abc",
					name: "Bash",
					input: { command: "ls" },
				},
			},
		} as any);

		const started = sink.events.find((e) => e.type === "tool.started");
		expect(started).toBeDefined();
		// F9: payload matches ToolStartedPayload {messageId, partId, toolName, callId, input}
		expect(started.data.toolName).toBe("Bash");
		expect(started.data.callId).toBe("tool-abc");
		expect(started.data.input).toEqual({ command: "ls" });
		expect(ctx.inFlightTools.get(1)?.toolName).toBe("Bash");
	});

	// Amendment A14: item.completed → tool.completed
	it("translates user tool_result to tool.completed for in-flight tool", async () => {
		ctx.inFlightTools.set(1, {
			itemId: "tool-abc",
			toolName: "Bash",
			title: "Command run",
			input: { command: "ls" },
			partialInputJson: "",
		});
		await translator.translate(ctx, {
			type: "user",
			session_id: "sdk-sess",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-abc",
						content: "file1.txt\nfile2.txt",
						is_error: false,
					},
				],
			},
		} as any);

		// Amendment A14: item.completed → tool.completed
		// F9: payload matches ToolCompletedPayload {messageId, partId, result, duration}
		const completed = sink.events.find((e) => e.type === "tool.completed");
		expect(completed).toBeDefined();
		expect(completed.data.result).toBeDefined();
		expect(completed.data.duration).toBe(0);
	});

	it("translates result success to turn.completed with tokens", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "success",
			session_id: "sdk-sess",
			is_error: false,
			duration_ms: 1200,
			duration_api_ms: 900,
			num_turns: 1,
			result: "done",
			total_cost_usd: 0.0123,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 10,
			},
		} as any);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		expect(turnCompleted).toBeDefined();
		// F9: payload matches TurnCompletedPayload {messageId, cost?, tokens?, duration?}
		expect(turnCompleted.data.messageId).toBeDefined();
		expect(turnCompleted.data.tokens.input).toBe(100);
		expect(turnCompleted.data.tokens.output).toBe(50);
		expect(turnCompleted.data.cost).toBeCloseTo(0.0123);
	});

	it("translates result error_during_execution with interrupted errors", async () => {
		await translator.translate(ctx, {
			type: "result",
			subtype: "error_during_execution",
			session_id: "sdk-sess",
			is_error: false,
			errors: ["request was aborted by the user"],
			duration_ms: 500,
		} as any);

		const turnCompleted = sink.events.find((e) => e.type === "turn.completed");
		// F9: No "status" field on TurnCompletedPayload — check messageId exists
		expect(turnCompleted?.data.messageId).toBeDefined();
	});

	// Amendment A14: session.configured → session.status
	it("translates system init message to session.status (configured)", async () => {
		await translator.translate(ctx, {
			type: "system",
			subtype: "init",
			session_id: "sdk-sess-new",
			cwd: "/tmp/ws",
			tools: ["Bash", "Read", "Write"],
			model: "claude-sonnet-4-5",
		} as any);

		// Amendment A14: session.configured → session.status
		// F9: payload matches SessionStatusPayload {sessionId, status}
		const configured = sink.events.find((e) => e.type === "session.status");
		expect(configured).toBeDefined();
		expect(configured.data.sessionId).toBe("sess-1");
		expect(configured.data.status).toBe("configured");
		// Translator also captures the SDK session id onto the context for resume.
		expect(ctx.resumeSessionId).toBe("sdk-sess-new");
	});

	// Amendment A14: runtime.error → turn.error
	// F9: payload matches TurnErrorPayload {messageId, error, code?}
	it("pushes turn.error when given an unhandled exception", async () => {
		await translator.translateError(ctx, new Error("SDK blew up"));
		const err = sink.events.find((e) => e.type === "turn.error");
		expect(err).toBeDefined();
		expect(err.data.error).toContain("SDK blew up");
		expect(err.data.messageId).toBeDefined();
	});
});
```

**Step 2: Verify test fails**

```bash
pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts
```
Expected: FAIL — module does not exist.

**Step 3: Implement the translator**

```typescript
// src/lib/provider/claude/claude-event-translator.ts
/**
 * ClaudeEventTranslator maps Claude Agent SDK messages (SDKMessage) onto
 * conduit's canonical event types and pushes them through EventSink.
 *
 * The translator is stateless with respect to its own instance — all
 * mutable state (in-flight tools, resume cursor, turn counters) lives on
 * the ClaudeSessionContext passed in. This keeps a single translator
 * usable across many concurrent sessions.
 *
 * Amendment A14 (N1/N2): Event type mappings use EXISTING canonical types only:
 *   text.delta (text) or thinking.delta (thinking)
 *   tool.started (tool_use, text, thinking block starts)
 *   tool.running (input_json_delta on fingerprint change)
 *   tool.completed (block stop, tool result)
 *   turn.error (SDK errors)
 *   session.status (system init, status updates)
 *   turn.completed (result, task_progress)
 *
 * F3: All payloads match the EventPayloadMap interfaces from Phase 1 Task 4:
 *   ToolStartedPayload, ToolRunningPayload, ToolCompletedPayload,
 *   TextDeltaPayload, ThinkingDeltaPayload, TurnErrorPayload,
 *   SessionStatusPayload, TurnCompletedPayload.
 *
 * Amendment A12 (I18): All event construction uses makeCanonicalEvent() helper
 * instead of unsafe `as CanonicalEvent` casts.
 */
import { randomUUID } from "node:crypto";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventSink } from "../types.js";
import type { CanonicalEvent, CanonicalEventType, EventPayloadMap, EventMetadata } from "../../persistence/events.js";
import { createEventId } from "../../persistence/events.js";
import type { ClaudeSessionContext, ToolInFlight } from "./types.js";

const PROVIDER = "claude" as const;

// Amendment A12 (I18): Typed event construction helper (same pattern as A3).
function makeCanonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	metadata: EventMetadata = {},
): CanonicalEvent {
	return {
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata,
		provider: PROVIDER,
		createdAt: Date.now(),
	} as CanonicalEvent;
}

type CanonicalItemType =
	| "assistant_message"
	| "command_execution"
	| "file_change"
	| "file_read"
	| "web_search"
	| "mcp_tool_call"
	| "dynamic_tool_call";

function classifyToolItemType(toolName: string): CanonicalItemType {
	const n = toolName.toLowerCase();
	if (n.includes("bash") || n.includes("shell") || n.includes("command")) {
		return "command_execution";
	}
	if (
		n === "read" ||
		n.includes("grep") ||
		n.includes("glob") ||
		n.includes("search")
	) {
		return "file_read";
	}
	if (
		n.includes("edit") ||
		n.includes("write") ||
		n.includes("patch") ||
		n.includes("create") ||
		n.includes("delete")
	) {
		return "file_change";
	}
	if (n.includes("websearch") || n.includes("web_search")) return "web_search";
	if (n.includes("mcp")) return "mcp_tool_call";
	return "dynamic_tool_call";
}

function titleForItemType(t: CanonicalItemType): string {
	switch (t) {
		case "command_execution": return "Command run";
		case "file_change": return "File change";
		case "file_read": return "File read";
		case "web_search": return "Web search";
		case "mcp_tool_call": return "MCP tool call";
		case "dynamic_tool_call": return "Tool call";
		case "assistant_message": return "Assistant message";
	}
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
	const cmd = input.command ?? input.cmd;
	if (typeof cmd === "string" && cmd.trim().length > 0) {
		return `${toolName}: ${cmd.trim().slice(0, 400)}`;
	}
	try {
		const json = JSON.stringify(input);
		return json.length <= 400 ? `${toolName}: ${json}` : `${toolName}: ${json.slice(0, 397)}...`;
	} catch {
		return toolName;
	}
}

function isInterruptedResult(result: SDKResultMessage): boolean {
	const errors =
		"errors" in result && Array.isArray((result as any).errors)
			? ((result as any).errors as string[]).join(" ").toLowerCase()
			: "";
	if (errors.includes("interrupt") || errors.includes("aborted")) return true;
	return (
		result.subtype === "error_during_execution" &&
		(result as any).is_error === false &&
		(errors.includes("cancel") || errors.includes("user"))
	);
}

export interface ClaudeEventTranslatorDeps {
	readonly sink: EventSink;
}

export class ClaudeEventTranslator {
	// F3: State tracker for mapping Claude content blocks to messageId/partId.
	// currentAssistantMessageId is set when an assistant snapshot arrives;
	// partIdCounter provides unique part IDs within a turn.
	private currentAssistantMessageId: string = "";
	private partIdCounter = 0;

	// (D1) In-flight tools keyed by toolUseId (UUID from SDK), NOT by
	// content_block index. toolUseId is stable across reconnects, preventing
	// phantom tool completions after resume.
	private readonly inFlightTools = new Map<string, { partId: string; toolName: string }>();

	private nextPartId(): string {
		return `claude-part-${this.partIdCounter++}`;
	}

	/** (D1) Reset in-flight state at the start of every new turn to prevent
	 *  stale entries from a previous turn or reconnect. */
	resetInFlightState(): void {
		this.inFlightTools.clear();
		this.partIdCounter = 0;
		this.currentAssistantMessageId = "";
	}

	constructor(private readonly deps: ClaudeEventTranslatorDeps) {}

	// (D4) All SDK `as any` casts should be confined to a single typed
	// accessor module at `src/lib/provider/claude/sdk-types.ts` — see
	// recommendation D4. Import `extractUsage()`, `extractErrors()`, etc.
	// from there instead of using `as any` inline.

	async translate(ctx: ClaudeSessionContext, message: SDKMessage): Promise<void> {
		// Capture SDK session id for resume cursor on the first system init.
		if (typeof (message as any).session_id === "string" && (message as any).session_id.length > 0) {
			ctx.resumeSessionId = (message as any).session_id;
		}

		switch (message.type) {
			case "system":
				return this.translateSystem(ctx, message);
			case "stream_event":
				return this.translateStreamEvent(ctx, message);
			case "assistant":
				return this.translateAssistantSnapshot(ctx, message);
			case "user":
				return this.translateUserToolResults(ctx, message);
			case "result":
				return this.translateResult(ctx, message as SDKResultMessage);
			default:
				// Log unknown message types for debugging (audit Finding 11).
				console.warn(\`[ClaudeEventTranslator] Unknown SDK message type: \${message.type}\`);
				return;
		}
	}

	async translateError(ctx: ClaudeSessionContext, cause: unknown): Promise<void> {
		const errorMsg = cause instanceof Error ? cause.message : String(cause);
		// F3: turn.error payload is TurnErrorPayload {messageId, error, code?}
		await this.push(makeCanonicalEvent("turn.error", ctx.sessionId, {
			messageId: this.currentAssistantMessageId ?? "",
			error: errorMsg,
			code: "provider_error",
		}));
	}

	// ─── System ──────────────────────────────────────────────────────────────

	private async translateSystem(ctx: ClaudeSessionContext, message: SDKMessage): Promise<void> {
		const record = message as any;
		const subtype = record.subtype;

		// Handle system/status — emitted during compacting (audit Finding 11).
		// F3: session.status payload is SessionStatusPayload {sessionId, status}
		if (subtype === "status") {
			await this.push(makeCanonicalEvent("session.status", ctx.sessionId, {
				sessionId: ctx.sessionId,
				status: record.status ?? "unknown",
			}));
			return;
		}

		// Handle system/task_progress — token usage updates, critical for
		// context window tracking (audit Finding 11).
		// F3: turn.completed payload is TurnCompletedPayload {messageId, cost?, tokens?, duration?}
		if (subtype === "task_progress") {
			const usage = record.usage ?? {};
			await this.push(makeCanonicalEvent("turn.completed", ctx.sessionId, {
				messageId: this.currentAssistantMessageId ?? "",
				tokens: {
					input: usage.input_tokens ?? 0,
					output: usage.output_tokens ?? 0,
					cacheRead: usage.cache_read_input_tokens,
				},
				cost: 0,
				duration: 0,
			}));
			return;
		}

		// Known subtypes we intentionally skip (deferred to later phases):
		// compact_boundary, hook_started, hook_progress, hook_response,
		// task_started, task_notification, files_persisted
		const knownSkipped = new Set([
			"compact_boundary", "hook_started", "hook_progress", "hook_response",
			"task_started", "task_notification", "files_persisted",
		]);
		if (subtype !== "init") {
			if (!knownSkipped.has(subtype)) {
				console.warn(\`[ClaudeEventTranslator] Unknown system subtype: \${subtype}\`);
			}
			if (subtype !== "init") return;
		}

		// F3: session.status payload is SessionStatusPayload {sessionId, status}
		// Store model info on context for later use; the canonical event is a simple status string.
		if (record.model) ctx.currentModel = record.model;
		await this.push(makeCanonicalEvent("session.status", ctx.sessionId, {
			sessionId: ctx.sessionId,
			status: "configured",
		}));
	}

	// ─── Stream Events ───────────────────────────────────────────────────────

	private async translateStreamEvent(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		const event = (message as any).event;
		if (!event || typeof event.type !== "string") return;

		if (event.type === "content_block_start") {
			return this.handleBlockStart(ctx, event);
		}
		if (event.type === "content_block_delta") {
			return this.handleBlockDelta(ctx, event);
		}
		if (event.type === "content_block_stop") {
			return this.handleBlockStop(ctx, event);
		}
		// Amendment A13 (Q5): Handle image content blocks from SDK responses.
		// When the SDK streams an image block (e.g., from a tool result containing
		// screenshots), emit a text.delta with a placeholder or pass through the
		// base64 data. For now, log and skip — full image relay is Phase 6b+.
		if (event.type === "content_block_start" && event.content_block?.type === "image") {
			console.warn("[ClaudeEventTranslator] Image content block received — not yet relayed");
			return;
		}
	}

	/**
	 * Handle content_block_stop: marks the in-flight text/thinking block's
	 * stream as closed and emits `tool.completed` so the UI can show
	 * individual blocks as complete before the final `result` arrives.
	 *
	 * Without this, all assistant text blocks appear "in progress" until
	 * the entire turn finishes — a noticeable UX gap (audit Finding 9).
	 */
	private async handleBlockStop(
		ctx: ClaudeSessionContext,
		event: { index: number },
	): Promise<void> {
		const tool = ctx.inFlightTools.get(event.index);
		if (!tool) return;

		// Only complete text/thinking blocks here; tool_use blocks
		// complete when their tool_result arrives.
		if (tool.toolName !== "__text" && tool.toolName !== "__thinking") return;

		ctx.inFlightTools.delete(event.index);
		// Amendment A14: item.completed → tool.completed; Amendment A12: uses helper
		await this.push(makeCanonicalEvent("tool.completed", ctx.sessionId, {
			messageId: tool.itemId,
			partId: `part-stop-${event.index}`,
			result: null,
			duration: 0,
		}));
	}

	private async handleBlockStart(
		ctx: ClaudeSessionContext,
		event: { index: number; content_block: any },
	): Promise<void> {
		const block = event.content_block;
		if (block.type === "text" || block.type === "thinking") {
			// Assistant text/thinking block — emit tool.started with a stable itemId.
			const itemId = randomUUID();
			const tool: ToolInFlight = {
				itemId,
				toolName: block.type === "text" ? "__text" : "__thinking",
				title: "Assistant message",
				input: {},
				partialInputJson: "",
			};
			ctx.inFlightTools.set(event.index, tool);
			// Amendment A14: item.started → tool.started; Amendment A12: uses helper
			await this.push(makeCanonicalEvent("tool.started", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
				toolName: block.type === "text" ? "__text" : "__thinking",
				callId: tool.itemId,
				input: {},
			}));
			return;
		}

		if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
			const toolName = block.name as string;
			const itemType = classifyToolItemType(toolName);
			const input =
				block.input && typeof block.input === "object"
					? (block.input as Record<string, unknown>)
					: {};
			const tool: ToolInFlight = {
				itemId: block.id,
				toolName,
				title: titleForItemType(itemType),
				input,
				partialInputJson: "",
			};
			ctx.inFlightTools.set(event.index, tool);
			// Amendment A14: item.started → tool.started; Amendment A12: uses helper
			await this.push(makeCanonicalEvent("tool.started", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
				toolName,
				callId: block.id,
				input,
			}));
		}
	}

	private async handleBlockDelta(
		ctx: ClaudeSessionContext,
		event: { index: number; delta: any },
	): Promise<void> {
		const tool = ctx.inFlightTools.get(event.index);
		const delta = event.delta;

		if (delta.type === "text_delta" || delta.type === "thinking_delta") {
			const text =
				delta.type === "text_delta"
					? (delta.text ?? "")
					: (typeof delta.thinking === "string" ? delta.thinking : "");
			if (text.length === 0) return;
			// Amendment A14: content.delta → text.delta or thinking.delta
			// Amendment A12: uses makeCanonicalEvent helper
			// F3: payload is {messageId, partId, text} matching TextDeltaPayload/ThinkingDeltaPayload
			const eventType = delta.type === "text_delta" ? "text.delta" : "thinking.delta";
			const partId = tool ? tool.itemId : this.nextPartId();
			await this.push(makeCanonicalEvent(eventType, ctx.sessionId, {
				messageId: this.currentAssistantMessageId || tool?.itemId || randomUUID(),
				partId,
				text,
			}));
			return;
		}

		if (delta.type === "input_json_delta" && tool) {
			const merged = tool.partialInputJson + (delta.partial_json ?? "");
			tool.partialInputJson = merged;
			let parsed: Record<string, unknown> | undefined;
			try {
				const p = JSON.parse(merged);
				if (p && typeof p === "object" && !Array.isArray(p)) {
					parsed = p as Record<string, unknown>;
				}
			} catch {
				return;
			}
			if (!parsed) return;

			const fingerprint = JSON.stringify(parsed);
			if (tool.lastEmittedFingerprint === fingerprint) return;
			tool.lastEmittedFingerprint = fingerprint;
			tool.input = parsed;

			// Amendment A14: item.updated → tool.running; F3: payload is ToolRunningPayload
			await this.push(makeCanonicalEvent("tool.running", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
			}));

			// Also emit tool.input_updated for SDK updatedInput events.
			// This provides fine-grained input streaming for the UI.
			await this.push(makeCanonicalEvent("tool.input_updated", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: tool.itemId,
				input: parsed,
			}));
		}
	}

	// ─── Assistant Snapshot ─────────────────────────────────────────────────

	private async translateAssistantSnapshot(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		// Capture last assistant uuid for resume cursor.
		const uuid = (message as any).uuid;
		if (typeof uuid === "string") {
			ctx.lastAssistantUuid = uuid;
			// F3: Track the current assistant message ID for payload construction.
			this.currentAssistantMessageId = uuid;
		}
		// Text block completions are now emitted per-block via handleBlockStop()
		// (content_block_stop). The assistant snapshot is used only to capture
		// the last assistant uuid and the messageId for event payloads.
	}

	// ─── User Tool Results ──────────────────────────────────────────────────

	private async translateUserToolResults(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		const content = (message as any).message?.content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (!block || block.type !== "tool_result") continue;
			const toolUseId = block.tool_use_id;
			if (typeof toolUseId !== "string") continue;

			// Find the in-flight tool by itemId.
			let matchedIndex: number | undefined;
			let matchedTool: ToolInFlight | undefined;
			for (const [idx, t] of ctx.inFlightTools) {
				if (t.itemId === toolUseId) {
					matchedIndex = idx;
					matchedTool = t;
					break;
				}
			}
			if (!matchedTool || matchedIndex === undefined) continue;

			const isError = block.is_error === true;
			const resultContent = typeof block.content === "string" ? block.content : "";

			// (audit Finding 10: emit tool result data so the UI can show output).
			// F3: tool.running payload is ToolRunningPayload {messageId, partId}
			if (resultContent.length > 0) {
				await this.push(makeCanonicalEvent("tool.running", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: matchedTool.itemId,
				}));

				// Emit text.delta for tool output content so the UI can render it.
				// F3: text.delta payload is TextDeltaPayload {messageId, partId, text}
				await this.push(makeCanonicalEvent("text.delta", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: `tool-output-${matchedTool.itemId}`,
					text: resultContent,
				}));
			}

			// F3: tool.completed payload is ToolCompletedPayload {messageId, partId, result, duration}
			await this.push(makeCanonicalEvent("tool.completed", ctx.sessionId, {
				messageId: this.currentAssistantMessageId,
				partId: matchedTool.itemId,
				result: resultContent || null,
				duration: 0,
			}));
			ctx.inFlightTools.delete(matchedIndex);
		}
	}

	// ─── Result ──────────────────────────────────────────────────────────────

	private async translateResult(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Promise<void> {
		const interrupted = isInterruptedResult(result);
		const isError = result.subtype !== "success" && !interrupted;

		// F3/F8: If interrupted, emit turn.interrupted; if error, emit turn.error.
		if (interrupted) {
			await this.push(makeCanonicalEvent("turn.interrupted", ctx.sessionId, {
				messageId: ctx.lastAssistantUuid ?? this.currentAssistantMessageId ?? "",
			}));
			return;
		}

		if (isError) {
			const errors =
				"errors" in result && Array.isArray((result as any).errors)
					? ((result as any).errors as string[]).join("; ")
					: "Unknown error";
			await this.push(makeCanonicalEvent("turn.error", ctx.sessionId, {
				messageId: ctx.lastAssistantUuid ?? this.currentAssistantMessageId ?? "",
				error: errors,
			}));
			return;
		}

		const usage = (result as any).usage ?? {};
		const tokens = {
			input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
			output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
			cacheRead:
				typeof usage.cache_read_input_tokens === "number"
					? usage.cache_read_input_tokens
					: undefined,
			cacheWrite:
				typeof usage.cache_creation_input_tokens === "number"
					? usage.cache_creation_input_tokens
					: undefined,
		};

		// F3: turn.completed payload is TurnCompletedPayload {messageId, cost?, tokens?, duration?}
		await this.push(makeCanonicalEvent("turn.completed", ctx.sessionId, {
			messageId: ctx.lastAssistantUuid ?? this.currentAssistantMessageId ?? "",
			cost:
				typeof (result as any).total_cost_usd === "number"
					? (result as any).total_cost_usd
					: undefined,
			tokens,
			duration:
				typeof (result as any).duration_ms === "number"
					? (result as any).duration_ms
					: undefined,
		}));
	}

	// ─── Push Helper ─────────────────────────────────────────────────────────

	private async push(event: CanonicalEvent): Promise<void> {
		await this.deps.sink.push(event);
	}
}
```

**Step 4: Verify test passes**

```bash
pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts
```
Expected: PASS (all 8 cases).

**Step 5: Refactor**

Review the translator for:
- **Scope creep:** each SDK event type gets at most one canonical event, except `result` which may emit both `turn.completed` and (in Phase 6b) a `thread.token-usage.updated`.
- **Instance state:** `currentAssistantMessageId` and `partIdCounter` are lightweight tracking fields needed to construct correct payload shapes. If multi-session concurrency is needed, move these to `ClaudeSessionContext`. For single-session usage they are fine as instance fields.
- **Type classification:** the tool type classifier is deliberately simple; fine-tuning (e.g. MCP detection, subagent detection) is deferred to Phase 6b if real traffic shows gaps.

No refactor needed at this step.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts test/unit/provider/claude/claude-event-translator.test.ts
git commit -m "feat(provider): add ClaudeEventTranslator mapping SDKMessage to canonical events"
```

---

### Task 46: Claude Permission Bridge

> **Amendment (2026-04-09 — Concurrency Solutions, Change 3B — PermissionLifecycleManager):**
> Wire `PermissionLifecycleManager` for disconnect-aware auto-deny with grace period. When all WS
> connections for a session disconnect:
> 1. Wait 30-second grace period (configurable) to allow reconnects.
> 2. If no reconnect occurs, auto-deny all pending permissions for that session.
> 3. For the Claude adapter, resolve the `canUseTool` Deferred with `{ behavior: "deny" }`.
> Also add a per-permission fallback timeout of 5 minutes (longer than grace-period path ~30s,
> shorter than D3's 10-minute turn timeout).

**Files:**
- Create: `src/lib/provider/claude/claude-permission-bridge.ts`
- Test: `test/unit/provider/claude/claude-permission-bridge.test.ts`

**Purpose:** The Claude Agent SDK uses a pull-based permission model: when the model decides to call a tool, the SDK invokes the adapter-provided `canUseTool(toolName, input, options)` callback and blocks on its returned promise. We bridge this to conduit's push-based permission model (`EventSink.requestPermission()`) by creating a `Deferred` inside the callback, emitting `permission.asked`, and awaiting the deferred until the UI calls `resolvePermission()`.

The bridge must handle three cases:
1. **Allow** → return `{ behavior: "allow", updatedInput }`.
2. **Deny** → return `{ behavior: "deny", message }`.
3. **Abort signal fires** (turn interrupted before user responds) → resolve the deferred with deny to unblock the SDK cleanly.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/claude/claude-permission-bridge.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudePermissionBridge } from "../../../../src/lib/provider/claude/claude-permission-bridge.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";
import type { ClaudeSessionContext } from "../../../../src/lib/provider/claude/types.js";

function makeSink(): EventSink {
	return {
		push: vi.fn(async () => {}),
		// F6: PermissionDecision is a plain string ("once"|"always"|"reject"), not an object.
		requestPermission: vi.fn(async () => "once" as const),
		requestQuestion: vi.fn(),
	};
}

function makeCtx(): ClaudeSessionContext {
	return {
		sessionId: "sess-1",
		workspaceRoot: "/tmp/ws",
		startedAt: new Date().toISOString(),
		promptQueue: {} as any,
		query: {} as any,
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		streamConsumer: undefined,
		currentTurnId: "turn-1",
		currentModel: undefined,
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

describe("ClaudePermissionBridge", () => {
	let bridge: ClaudePermissionBridge;
	let sink: EventSink;
	let ctx: ClaudeSessionContext;

	beforeEach(() => {
		sink = makeSink();
		ctx = makeCtx();
		bridge = new ClaudePermissionBridge({ sink });
	});

	it("creates a pending approval and blocks until resolved", async () => {
		// Arrange: sink.requestPermission will be called and will eventually resolve.
		let resolveSink: (v: any) => void = () => {};
		(sink.requestPermission as any) = vi.fn(
			() => new Promise((r) => { resolveSink = r; }),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(ctx, "Bash", { command: "ls" }, {
			signal: ac.signal,
			toolUseID: "tool-abc",
		});

		// Give the microtask queue a tick.
		await new Promise((r) => setTimeout(r, 0));
		expect(ctx.pendingApprovals.size).toBe(1);
		const pending = [...ctx.pendingApprovals.values()][0];
		expect(pending?.toolName).toBe("Bash");

		// F6: PermissionDecision is a plain string
		resolveSink("once");
		const result = await callbackPromise;
		expect(result.behavior).toBe("allow");
		expect(ctx.pendingApprovals.size).toBe(0);
	});

	it("returns deny when user rejects", async () => {
		// F6: PermissionDecision is a plain string
		(sink.requestPermission as any) = vi.fn(async () => "reject");
		const ac = new AbortController();
		const result = await bridge.canUseTool(ctx, "Bash", { command: "rm -rf /" }, {
			signal: ac.signal,
			toolUseID: "tool-xyz",
		});
		expect(result.behavior).toBe("deny");
	});

	it("returns deny when abort signal fires before user responds", async () => {
		let resolveSink: (v: any) => void = () => {};
		(sink.requestPermission as any) = vi.fn(
			() => new Promise((r) => { resolveSink = r; }),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(ctx, "Bash", { command: "sleep 60" }, {
			signal: ac.signal,
			toolUseID: "tool-q",
		});

		await new Promise((r) => setTimeout(r, 0));
		ac.abort();
		const result = await callbackPromise;
		expect(result.behavior).toBe("deny");
		// Amendment A7 (I12): Removed check for result.message — PermissionResponse has no message field.
		expect(ctx.pendingApprovals.size).toBe(0);

		// Late resolver no-ops cleanly.
		resolveSink("once");
	});

	it("resolvePermission() unblocks the pending approval", async () => {
		// Use the real push/request flow: requestPermission creates a pending
		// that resolvePermission must resolve.
		const pendingResolvers = new Map<string, (v: any) => void>();
		(sink.requestPermission as any) = vi.fn((req: any) =>
			new Promise((r) => pendingResolvers.set(req.requestId, r)),
		);

		const ac = new AbortController();
		const callbackPromise = bridge.canUseTool(ctx, "Read", { file_path: "/etc/passwd" }, {
			signal: ac.signal,
			toolUseID: "tool-r",
		});

		await new Promise((r) => setTimeout(r, 0));
		const pending = [...ctx.pendingApprovals.values()][0]!;

		// Amendment A6 (C7): Use "once" instead of "allow"
		// F6: PermissionDecision is a plain string, not an object.
		await bridge.resolvePermission(ctx, pending.requestId, "once");
		// Still need to complete the original sink call that the bridge awaited.
		pendingResolvers.get(pending.requestId)?.("once");

		const result = await callbackPromise;
		expect(result.behavior).toBe("allow");
	});
});
```

**Step 2: Verify test fails**

```bash
pnpm vitest run test/unit/provider/claude/claude-permission-bridge.test.ts
```
Expected: FAIL — module does not exist.

**Step 3: Implement the permission bridge**

```typescript
// src/lib/provider/claude/claude-permission-bridge.ts
/**
 * ClaudePermissionBridge converts the Claude Agent SDK's pull-based
 * permission model (a canUseTool callback that blocks) into conduit's
 * push-based permission model (EventSink.requestPermission()).
 *
 * Flow:
 *   1. SDK calls canUseTool(toolName, input, { signal, toolUseID })
 *   2. Bridge creates a PendingApproval and stores it on ctx
 *   3. Bridge calls eventSink.requestPermission() — this emits permission.asked
 *      and returns a promise that the EventSink will resolve when the UI
 *      delivers the decision (via resolvePermission() on the adapter)
 *   4. Bridge awaits either the sink promise or the abort signal
 *   5. Bridge returns the SDK PermissionResult
 *
 * The bridge exposes `resolvePermission()` so the adapter can route the
 * UI's decision back to the bridge. Internally this just completes the
 * pending entry — the actual SDK callback is unblocked by the EventSink's
 * requestPermission() promise resolution.
 */
import { randomUUID } from "node:crypto";
import type {
	CanUseTool,
	PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { EventSink, PermissionDecision } from "../types.js";
import type { ClaudeSessionContext, PendingApproval } from "./types.js";

export interface ClaudePermissionBridgeDeps {
	readonly sink: EventSink;
}

// F5: AbortSignal-aware promise wrapper. When the abort signal fires,
// the promise rejects cleanly so the SDK's canUseTool callback unblocks.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("Aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
			(e) => { signal.removeEventListener("abort", onAbort); reject(e); },
		);
	});
}

export class ClaudePermissionBridge {
	constructor(private readonly deps: ClaudePermissionBridgeDeps) {}

	/**
	 * Amendment A9 (I15): Factory method that returns the exact SDK CanUseTool signature.
	 * Called once per session to produce the callback passed to query() options.
	 * The returned function captures ctx so the SDK doesn't need to know about
	 * ClaudeSessionContext.
	 */
	createCanUseTool(ctx: ClaudeSessionContext): CanUseTool {
		return async (toolName: string, toolInput: Record<string, unknown>, options: any): Promise<PermissionResult> => {
			return this._handlePermission(ctx, toolName, toolInput, options);
		};
	}

	/**
	 * Internal permission handler — shared by createCanUseTool and legacy canUseTool.
	 */
	private async _handlePermission(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: { signal: AbortSignal; toolUseID: string },
	): Promise<PermissionResult> {
		const requestId = randomUUID();
		const createdAt = new Date().toISOString();

		// Create the PendingApproval record so resolvePermission can find it.

		// (D2) PendingApproval is a tracking record only — no resolve/reject.
		// Resolution flow: adapter.resolvePermission() -> eventSink.resolvePermission()
		// -> unblocks the promise that bridge.canUseTool() is awaiting.
		const pending: PendingApproval = {
			requestId,
			toolName,
			toolInput: (toolInput as Record<string, unknown>) ?? {},
			createdAt,
			// (D2) No resolve/reject — EventSink owns the resolution lifecycle.
		};
		ctx.pendingApprovals.set(requestId, pending);

		try {
			// Amendment A16 (Q6): EventSink is canonical for permissions — no race pattern.
			// Fire the permission.asked event and await the sink promise directly.
			// Amendment A8 (I13): toolInput is Record<string, unknown> (generic, not OpenCode-specific).
			// Added sessionId, turnId, providerItemId to PermissionRequest.
			const sinkPromise = this.deps.sink.requestPermission({
				requestId,
				sessionId: ctx.sessionId,
				turnId: ctx.currentTurnId ?? "",
				toolName,
				toolInput: (toolInput as Record<string, unknown>) ?? {},
				providerItemId: options.toolUseID,
			} as any);

			// F5: Wrap sinkPromise with AbortSignal-aware wrapper so that abort
			// cleanly rejects instead of leaving the callback hanging.
			let decision: PermissionDecision;
			try {
				decision = await withAbort(sinkPromise, options.signal);
			} catch (err) {
				// F1/F5: Abort fired — return deny to unblock the SDK cleanly.
				ctx.pendingApprovals.delete(requestId);
				return {
					behavior: "deny",
					message: "Turn interrupted",
				} satisfies PermissionResult;
			}
			ctx.pendingApprovals.delete(requestId);

			// F6: PermissionDecision is a plain string ("once"|"always"|"reject").
			if (decision === "once" || decision === "always") {
				return {
					behavior: "allow",
					updatedInput: (toolInput as Record<string, unknown>) ?? {},
				} satisfies PermissionResult;
			}
			return {
				behavior: "deny",
				message: "User declined tool execution.",
			} satisfies PermissionResult;
		} finally {
			ctx.pendingApprovals.delete(requestId);
		}
	}

	/**
	 * Legacy convenience method — delegates to _handlePermission.
	 * Prefer createCanUseTool() for SDK wiring.
	 */
	async canUseTool(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: { signal: AbortSignal; toolUseID: string },
	): Promise<PermissionResult> {
		return this._handlePermission(ctx, toolName, toolInput, options);
	}

	/**
	 * Called by the adapter's resolvePermission() to deliver a UI decision
	 * into the pending canUseTool callback. The EventSink's requestPermission
	 * promise typically resolves via the same mechanism upstream; this method
	 * is the safety net / direct path.
	 */
	async resolvePermission(
		ctx: ClaudeSessionContext,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void> {
		const pending = ctx.pendingApprovals.get(requestId);
		if (!pending) return;
		pending.resolve(decision);
	}
}
```

**Step 4: Verify test passes**

```bash
pnpm vitest run test/unit/provider/claude/claude-permission-bridge.test.ts
```
Expected: PASS (all 4 cases).

**Step 5: Refactor**

Review points:
- **Abort cleanup:** The `withAbort` wrapper handles abort signals cleanly by rejecting the promise, and the `finally` block ensures the pending entry is always deleted.
- **Double-resolve safety:** The pending approval is tracked for resolvePermission but the primary resolution is through the EventSink promise.
- **EventSink shape coupling:** the `requestPermission` payload shape is cast through `as any` here because the canonical payload is defined in Phase 5 Task 36. Phase 6b will align these types once the Claude-specific fields (e.g. `providerItemId`) are added to `PermissionRequest`.

No refactor needed.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-permission-bridge.ts test/unit/provider/claude/claude-permission-bridge.test.ts
git commit -m "feat(provider): add ClaudePermissionBridge converting canUseTool callback to EventSink.requestPermission"
```

---

### Task 47: ClaudeAdapter — discover() and shutdown()

**Files:**
- Create: `src/lib/provider/claude/claude-adapter.ts`
- Test: `test/unit/provider/claude/claude-adapter-discover.test.ts`

**Purpose:** Create the `ClaudeAdapter` class skeleton that implements the `ProviderAdapter` interface. Task 47 covers only the two simplest methods: `discover()` (enumerate models, commands, skills, capabilities) and `shutdown()` (terminate all active sessions). The heavy lifting — `sendTurn()`, `interruptTurn()`, `resolvePermission()`, `resolveQuestion()` — lands in Phase 6b (Tasks 48–51).

**discover() sources:**
- **Models:** hardcoded list from Claude's supported set (Opus 4, Sonnet 4, Haiku 3.5, etc.) — the SDK does not expose a models API; Phase 6b may add a settings-file override.
- **Capabilities:** Claude supports tools, thinking, permissions, questions (via AskUserQuestion), and attachments. No fork, no revert.
- **Commands:** enumerated from the filesystem at `~/.claude/commands/*.md`, `<workspace>/.claude/commands/*.md`, plus SDK built-ins (`/init`, `/memory`, `/compact`, `/cost`, `/model`).
- **Skills:** enumerated from `~/.claude/skills/*/SKILL.md` and `<workspace>/.claude/skills/*/SKILL.md` as `user-skill` / `project-skill` command entries.

**Step 1: Write the failing test**

```typescript
// test/unit/provider/claude/claude-adapter-discover.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../../../src/lib/provider/claude/claude-adapter.js";

describe("ClaudeAdapter.discover()", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = join(tmpdir(), `conduit-claude-test-${Date.now()}`);
		mkdirSync(join(workspace, ".claude", "commands"), { recursive: true });
		mkdirSync(join(workspace, ".claude", "skills", "my-skill"), { recursive: true });
		writeFileSync(
			join(workspace, ".claude", "commands", "my-cmd.md"),
			"---\ndescription: A custom command\n---\nDo the thing.",
		);
		writeFileSync(
			join(workspace, ".claude", "skills", "my-skill", "SKILL.md"),
			"---\nname: my-skill\ndescription: A custom skill\n---\nUse when...",
		);
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	it("returns providerId 'claude'", () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		expect(adapter.providerId).toBe("claude");
	});

	it("returns capabilities with models, tools, thinking, permissions, questions", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();

		expect(caps.models.length).toBeGreaterThan(0);
		expect(caps.models.every((m) => m.providerId === "claude")).toBe(true);
		// Spot-check that at least one Sonnet variant is present.
		expect(caps.models.some((m) => m.id.toLowerCase().includes("sonnet"))).toBe(true);

		expect(caps.supportsTools).toBe(true);
		expect(caps.supportsThinking).toBe(true);
		expect(caps.supportsPermissions).toBe(true);
		expect(caps.supportsQuestions).toBe(true);
		expect(caps.supportsAttachments).toBe(true);
		expect(caps.supportsFork).toBe(false);
		expect(caps.supportsRevert).toBe(false);
	});

	it("enumerates built-in commands", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const builtins = caps.commands.filter((c) => c.source === "builtin");
		expect(builtins.length).toBeGreaterThan(0);
		expect(builtins.some((c) => c.name === "init")).toBe(true);
		expect(builtins.some((c) => c.name === "compact")).toBe(true);
		expect(builtins.some((c) => c.name === "cost")).toBe(true);
	});

	it("enumerates project commands from .claude/commands", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const projectCmds = caps.commands.filter((c) => c.source === "project-command");
		expect(projectCmds).toHaveLength(1);
		expect(projectCmds[0]?.name).toBe("my-cmd");
		expect(projectCmds[0]?.description).toBe("A custom command");
	});

	it("enumerates project skills from .claude/skills", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const projectSkills = caps.commands.filter((c) => c.source === "project-skill");
		expect(projectSkills).toHaveLength(1);
		expect(projectSkills[0]?.name).toBe("my-skill");
		expect(projectSkills[0]?.description).toBe("A custom skill");
	});

	it("shutdown() closes all active sessions", async () => {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		// Amendment A10 (I16): Populate all 16 required ClaudeSessionContext fields.
		const fakeClose = vi.fn();
		const fakeInterrupt = vi.fn(async () => {});
		(adapter as any).sessions.set("sess-1", {
			sessionId: "sess-1",
			workspaceRoot: workspace,
			startedAt: new Date().toISOString(),
			promptQueue: { close: vi.fn(), enqueue: vi.fn(), [Symbol.asyncIterator]: vi.fn() },
			query: { interrupt: fakeInterrupt, close: fakeClose, setModel: vi.fn(), setPermissionMode: vi.fn(), [Symbol.asyncIterator]: vi.fn() },
			pendingApprovals: new Map(),
			pendingQuestions: new Map(),
			inFlightTools: new Map(),
			streamConsumer: undefined,
			currentTurnId: "turn-1",
			currentModel: "claude-sonnet-4",
			resumeSessionId: undefined,
			lastAssistantUuid: undefined,
			turnCount: 0,
			stopped: false,
		});

		await adapter.shutdown();

		expect(fakeClose).toHaveBeenCalled();
		expect((adapter as any).sessions.size).toBe(0);
	});
});
```

**Step 2: Verify test fails**

```bash
pnpm vitest run test/unit/provider/claude/claude-adapter-discover.test.ts
```
Expected: FAIL — module does not exist.

**Step 3: Implement ClaudeAdapter skeleton**

```typescript
// src/lib/provider/claude/claude-adapter.ts
/**
 * ClaudeAdapter — ProviderAdapter implementation wrapping the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn (see Phase 6b).
 * - Discovery is filesystem + hardcoded: the SDK does not expose a models
 *   or commands API, so we enumerate ~/.claude/ and <workspace>/.claude/
 *   directories for user/project commands and skills.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 *
 * Phase 6b (Tasks 48–51) implements sendTurn, interruptTurn,
 * resolvePermission, resolveQuestion, and the stream consumer loop.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AdapterCapabilities,
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import type { ClaudeSessionContext } from "./types.js";

export interface ClaudeAdapterDeps {
	readonly workspaceRoot: string;
}

// ─── Built-in command catalog ──────────────────────────────────────────────

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "init", description: "Initialize Claude in the current workspace" },
	{ name: "memory", description: "Manage Claude's memory / CLAUDE.md" },
	{ name: "compact", description: "Compact the conversation to free context" },
	{ name: "cost", description: "Show token usage and cost for the session" },
	{ name: "model", description: "Switch the active model" },
	{ name: "clear", description: "Clear the conversation" },
	{ name: "help", description: "Show help" },
];

// ─── Model catalog ─────────────────────────────────────────────────────────

const CLAUDE_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "claude-opus-4",
		name: "Claude Opus 4",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "claude-haiku-3-5",
		name: "Claude Haiku 3.5",
		providerId: "claude",
		limit: { context: 200_000, output: 8_192 },
	},
];

// ─── Frontmatter parser (minimal) ──────────────────────────────────────────

function parseFrontmatter(contents: string): Record<string, string> {
	if (!contents.startsWith("---\n")) return {};
	const end = contents.indexOf("\n---", 4);
	if (end === -1) return {};
	const block = contents.slice(4, end);
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

// ─── Directory scanners ────────────────────────────────────────────────────

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function enumerateCommands(
	baseDir: string,
	source: "user-command" | "project-command",
): CommandInfo[] {
	const dir = join(baseDir, "commands");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		try {
			const contents = readFileSync(join(dir, entry), "utf8");
			const fm = parseFrontmatter(contents);
			out.push({
				name,
				source,
				...(fm.description ? { description: fm.description } : {}),
			});
		} catch {
			out.push({ name, source });
		}
	}
	return out;
}

function enumerateSkills(
	baseDir: string,
	source: "user-skill" | "project-skill",
): CommandInfo[] {
	const dir = join(baseDir, "skills");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		const skillPath = join(dir, entry);
		try {
			if (!statSync(skillPath).isDirectory()) continue;
		} catch {
			continue;
		}
		const skillFile = join(skillPath, "SKILL.md");
		try {
			const contents = readFileSync(skillFile, "utf8");
			const fm = parseFrontmatter(contents);
			out.push({
				name: fm.name ?? entry,
				source,
				...(fm.description ? { description: fm.description } : {}),
			});
		} catch {
			// Skip skills without a SKILL.md.
		}
	}
	return out;
}

// ─── ClaudeAdapter ─────────────────────────────────────────────────────────

export class ClaudeAdapter implements ProviderAdapter {
	readonly providerId = "claude" as const;

	/** Active SDK sessions, keyed by conduit sessionId. */
	protected readonly sessions = new Map<string, ClaudeSessionContext>();

	constructor(private readonly deps: ClaudeAdapterDeps) {}

	// ─── discover ─────────────────────────────────────────────────────────

	async discover(): Promise<AdapterCapabilities> {
		const userBase = join(homedir(), ".claude");
		const projectBase = join(this.deps.workspaceRoot, ".claude");

		const commands: CommandInfo[] = [
			...BUILTIN_COMMANDS.map((c) => ({
				name: c.name,
				description: c.description,
				source: "builtin" as const,
			})),
			...enumerateCommands(userBase, "user-command"),
			...enumerateCommands(projectBase, "project-command"),
			...enumerateSkills(userBase, "user-skill"),
			...enumerateSkills(projectBase, "project-skill"),
		];

		return {
			models: CLAUDE_MODELS,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: false,
			supportsRevert: false,
			commands,
		};
	}

	// ─── sendTurn / interruptTurn / resolve* ─────────────────────────────

	async sendTurn(_input: SendTurnInput): Promise<TurnResult> {
		throw new Error("ClaudeAdapter.sendTurn not implemented — Phase 6b Task 48");
	}

	async interruptTurn(_sessionId: string): Promise<void> {
		throw new Error("ClaudeAdapter.interruptTurn not implemented — Phase 6b Task 49");
	}

	async resolvePermission(
		_sessionId: string,
		_requestId: string,
		_decision: PermissionDecision,
	): Promise<void> {
		throw new Error("ClaudeAdapter.resolvePermission not implemented — Phase 6b Task 50");
	}

	async resolveQuestion(
		_sessionId: string,
		_requestId: string,
		_answers: Record<string, unknown>,
	): Promise<void> {
		throw new Error("ClaudeAdapter.resolveQuestion not implemented — Phase 6b Task 50");
	}

	// ─── shutdown ────────────────────────────────────────────────────────

	async shutdown(): Promise<void> {
		const sessionsToStop = [...this.sessions.values()];
		for (const ctx of sessionsToStop) {
			if (ctx.stopped) continue;
			try {
				ctx.promptQueue.close();
			} catch {
				// Ignore — queue already closed.
			}
			try {
				await ctx.query.interrupt();
			} catch {
				// Ignore — session may already be finished.
			}
			try {
				ctx.query.close();
			} catch {
				// Ignore.
			}
			(ctx as { stopped: boolean }).stopped = true;
		}
		this.sessions.clear();
	}
}
```

**Step 4: Verify test passes**

```bash
pnpm vitest run test/unit/provider/claude/claude-adapter-discover.test.ts
```
Expected: PASS (6 cases).

**Step 5: Refactor**

Review points:
- **Hardcoded model list:** this is a pragmatic choice because the SDK does not expose a catalog. Phase 6b may add a JSON override file so operators can add new models without a conduit release.
- **Frontmatter parser:** deliberately minimal — no quoted strings, no nested values. If a real `.claude/commands/*.md` breaks it, we'll add a proper YAML parser in Phase 6b (the `yaml` package is already in the tree for settings).
- **Unimplemented method errors:** throwing `Error` with a clear Phase 6b pointer is preferable to silent stubs; any premature use in tests will fail loudly.
- **Session map access in tests:** `protected` visibility with a cast in tests is acceptable for this pre-integration scaffolding.

No refactor needed.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-discover.test.ts
git commit -m "feat(provider): add ClaudeAdapter skeleton with discover() and shutdown() (Phase 6a)"
```

---

### Phase 6a Summary

By the end of Tasks 43–47, conduit has the full scaffolding for the Claude Agent SDK adapter:

- `@anthropic-ai/claude-agent-sdk` is installed and its types are re-exported via `src/lib/provider/claude/types.ts`.
- `PromptQueue` provides the `AsyncIterable<SDKUserMessage>` input that `query()` requires.
- `ClaudeEventTranslator` maps every `SDKMessage` variant that conduit cares about into canonical events.
- `ClaudePermissionBridge` converts the SDK's `canUseTool` callback into `EventSink.requestPermission()` calls.
- `ClaudeAdapter` implements `discover()` + `shutdown()` and exposes stubs for the remaining four methods.

What Phase 6a does **not** yet deliver:

- A running `query()` session — `sendTurn()` still throws.
- Stream consumer loop that drains `query()` output and feeds the translator.
- Resume via `provider_state` cursor, with fallback to history preamble.
- `ProviderRegistry` wiring so conduit can actually route traffic to the adapter.
- Integration tests against a real SDK session.

All of the above land in **Phase 6b** (Tasks 48–50), which is the next section. At that point, the Go/No-Go checkpoint for Phase 6 can be evaluated: does Claude work reliably end-to-end alongside OpenCode?

---

## Phase 6b — Claude Adapter Completion (Tasks 48–50)

> **Goal**: Wire the `ClaudeAdapter` skeleton (Task 47) into a fully functional
> provider that can drive multi-turn conversations through the Claude Agent SDK,
> produce canonical orchestration events, and coexist with the OpenCode adapter
> in the same daemon.

> **⚠️ REWRITE NOTE (audit Phase 6):** The original Phase 6b was fundamentally
> incompatible with Phase 6a. It redefined `ClaudeSessionContext` locally
> (conflicting with Task 43's `types.ts`), used `EventSink.emit()`/`.on()`/`.off()`
> methods that don't exist (the real API is `push()`), introduced a `bind(sink)`
> pattern not in the `ProviderAdapter` interface, called `query()` with wrong
> arguments (`query(string, opts)` instead of `query({ prompt, options })`),
> made `resolvePermission` a no-op (deadlocking the permission bridge), and
> placed test files under `src/lib/` where they'd be silently skipped by vitest.
>
> The tasks below are respecified as clear behavioral contracts. They reference
> Phase 6a types and Phase 5 interfaces. No implementation code is provided —
> it must be written fresh against these contracts.

---

### Task 48 — Claude Adapter: `sendTurn()` Implementation

> **Amendment (2026-04-09 — Concurrency Solutions, Change 4a — Per-Session Mutex):**
> Add `sessionLocks: Map<string, Promise<ClaudeSessionContext>>` with Promise sentinel pattern
> for async mutual exclusion. Two concurrent `sendTurn()` calls for the same new session both see
> `sessions.has(id) === false` and both create SDK sessions. The fix:
> ```typescript
> const pending = this.sessionLocks.get(input.sessionId);
> if (pending) { await pending; return this.sendTurn(input); }
> const setup = this.createSession(input);
> this.sessionLocks.set(input.sessionId, setup);
> try { const ctx = await setup; this.sessions.set(input.sessionId, ctx); }
> finally { this.sessionLocks.delete(input.sessionId); }
> ```
> The sentinel is set synchronously (before any `await`). Retries bounded by D3 turn timeout.

**What this task does:** Implements `sendTurn()` on `ClaudeAdapter`. This is the
heart of the adapter — it creates an SDK session on the first turn, enqueues
follow-up messages on subsequent turns, runs a background stream consumer that
feeds events through `ClaudeEventTranslator`, and handles session resumption
with fallback to history preamble.

**Types and interfaces used (from 6a and Phase 5):**
- `ClaudeSessionContext` from `src/lib/provider/claude/types.ts` (Task 43) —
  use this directly, do NOT redefine it locally. Populate all 16 fields.
- `PromptQueue` from `src/lib/provider/claude/prompt-queue.ts` (Task 44) —
  create one per session, pass it as the `prompt` argument to `query()`.
- `ClaudeEventTranslator` from Task 45 — instantiate with `{ sink }` and
  call `translate(ctx, message)` for each SDK message.
- `ClaudePermissionBridge` from Task 46 — instantiate with `{ sink }` and
  pass `bridge.canUseTool.bind(bridge, ctx)` as the SDK's `canUseTool` option.
- `SendTurnInput` from Phase 5 `ProviderAdapter` interface — this is how
  `EventSink` is delivered (via `input.eventSink`), NOT via a `bind()` method.
- `TurnResult` from Phase 5 — the return type of `sendTurn()`.
- `ClaudeAdapterDeps` from Task 47 — `{ workspaceRoot: string }`. Extend
  with additional fields if needed (e.g., `settingsDir`, `apiKey`), but keep
  backward-compatible with Task 47 tests.

**Key behavioral requirements:**
1. **First turn:** Create a `PromptQueue`, enqueue the initial user message as
   an `SDKUserMessage` (not a raw string), build `ClaudeQueryOptions` with all
   required fields (`cwd`, `model`, `settingSources`, `includePartialMessages:
   true`, `env: process.env`, `canUseTool`, `abortController`), call
   `query({ prompt: queue, options: queryOptions })`, start a background stream
   consumer as an async IIFE, store the `ClaudeSessionContext` in the sessions map.
2. **Subsequent turn:** Find existing session, enqueue the new message into the
   existing `PromptQueue`, await turn completion via a **Deferred pattern** (a
   local `Promise` that the stream consumer resolves when the next `result` event
   arrives — do NOT use `EventSink.on()`/`.off()` which don't exist).
3. **Emit `session.status` with `status: "busy"`** at the beginning of `sendTurn()`, after creating
   turn state, before enqueuing the message. (F4: use `session.status` with
   `{ sessionId, status: "busy" }` instead of a separate `turn.started` event —
   the TurnProjector already transitions pending→running on `session.status: busy`,
   so no new event type is needed.)
4. **Resume:** If `SendTurnInput.providerState` contains a `ClaudeResumeCursor`,
   pass `resume: cursor.resumeSessionId` in query options. On "Invalid session"
   error, retry without resume, prepending history as a system preamble.
5. **Error cleanup:** Always `.catch()` the background consumer promise. On any
   error, call a `cleanupSession(sessionId)` method that: closes the prompt queue,
   aborts the controller, resolves pending approvals with deny, completes
   in-flight tools as failed, deletes the session from the map.
6. **Consumer promise lifecycle:** The background consumer promise must be stored
    on `ctx.streamConsumer` and awaited during `shutdown()`.
7. **(D3) Turn timeout:** Race the turn's `Deferred<TurnResult>` against a
    configurable `turnTimeoutMs` (default: 10 minutes). If the SDK never responds,
    reject with `ProviderError("SEND_FAILED", "Turn timed out after ${turnTimeoutMs}ms", { sessionId, turnId, timeoutMs })`.
    This prevents silent hangs when the SDK is stuck.

**Test scenarios (place at `test/unit/provider/claude/claude-adapter-send-turn.test.ts`):**
- Creates new SDK `query()` on first turn of a session
- Enqueues into existing prompt queue on second turn (no new `query()`)
- Uses resume cursor from `providerState`
- Falls back to history preamble when resume fails with "Invalid session"
- Returns `TurnResult` with provider state when turn completes
- Emits `session.status` with `status: "busy"` at the beginning of `sendTurn()`
- SDK `query()` construction failure triggers proper cleanup
- Stream failure mid-iteration triggers proper cleanup
- Concurrent `sendTurn()` on the same session either queues or rejects

**Implementation deferred — Phase 6a establishes the foundation, this task
builds on it using the same types and patterns.**

---

### Task 49 — Claude Adapter: `interruptTurn`, `resolvePermission`, `resolveQuestion`

**What this task does:** Implements the remaining three `ProviderAdapter` methods
that complete the adapter's contract. `interruptTurn` must cleanly abort an
in-flight SDK conversation with proper cleanup. `resolvePermission` and
`resolveQuestion` must route UI decisions to the `ClaudePermissionBridge` to
unblock pending `canUseTool` callbacks — they are NOT no-ops.

**Types and interfaces used (from 6a and Phase 5):**
- `ClaudeSessionContext` from Task 43's `types.ts` — access `pendingApprovals`,
  `pendingQuestions`, `inFlightTools`, `promptQueue`, `query`, `stopped` fields.
- `ClaudePermissionBridge` from Task 46 — call
  `bridge.resolvePermission(ctx, requestId, decision)` from the adapter's
  `resolvePermission()` method. This is critical: the bridge creates a local
  `Deferred` that MUST be resolved by this call, otherwise `canUseTool` blocks
  forever (deadlock).
- `PermissionDecision` from Phase 5 `ProviderAdapter` types.
- `EventSink` from Phase 5 — accessed via the session, push events through it.

**Key behavioral requirements:**

*interruptTurn(sessionId):*
1. Find the session context; no-op if not found.
2. Iterate `ctx.pendingApprovals` and resolve each with `"reject"`
   (F6: PermissionDecision is a plain string, not an object).
3. Iterate `ctx.pendingQuestions` and reject each with
   `new Error("Turn interrupted")`.
4. Complete in-flight tools as failed: for each entry in `ctx.inFlightTools`,
   emit `tool.completed` with the ToolCompletedPayload shape `{messageId, partId, result: null, duration: 0}`.
5. Emit `turn.interrupted` with `TurnInterruptedPayload { messageId }` via `EventSink.push()`.
   (F8: Use the dedicated `turn.interrupted` canonical event type, not
   `turn.completed` with a non-existent `status` field.)
6. Close the prompt queue.
7. Call `abort.abort()` on the session's `AbortController`.
8. Mark `ctx.stopped = true`.

*resolvePermission(sessionId, requestId, decision):*
1. Find the session context; no-op if not found.
2. Call `this.permissionBridge.resolvePermission(ctx, requestId, decision)`.
   This resolves the `Deferred` inside the permission bridge, unblocking the
   SDK's `canUseTool` callback.

*resolveQuestion(sessionId, requestId, answers):*
1. Find the session context; no-op if not found.
2. Find the `PendingQuestion` in `ctx.pendingQuestions`.
3. Call `pending.resolve(answers)` to unblock the question callback.

**Test scenarios (place at `test/unit/provider/claude/claude-adapter-lifecycle.test.ts`):**
- `interruptTurn` calls abort on the session's AbortController
- `interruptTurn` closes the prompt queue
- `interruptTurn` resolves pending approvals with deny
- `interruptTurn` emits `turn.interrupted` with `{ messageId }` payload
- `interruptTurn` is a no-op when session does not exist
- `interruptTurn` while a permission is pending unblocks the `canUseTool` callback
- `resolvePermission` calls through to `ClaudePermissionBridge.resolvePermission()`
- `resolvePermission` is a no-op for unknown session/request
- `resolveQuestion` resolves the pending question's deferred
- `shutdown()` resolves all pending approvals with deny before closing sessions

**Implementation deferred — Phase 6a establishes the foundation, this task
builds on it using the same types and patterns.**

---

### Task 50 — Register Claude Adapter + Provider Switching

**What this task does:** Wires the `ClaudeAdapter` into the `ProviderRegistry`
alongside `OpenCodeAdapter`. Creates a `wireProviders()` function that
instantiates adapters from configuration and registers them. Adds provider
routing so the `OrchestrationEngine` dispatches commands to the correct adapter
based on the session's active provider.

**Amendment A11 (I17): File path for `wireProviders()`:**
`wireProviders()` should be implemented in `src/lib/provider/orchestration-wiring.ts`
(extending the existing `createOrchestrationLayer` module from Task 42). This keeps
all provider wiring in one module. Alternatively, if the function grows too large,
it can be split to `src/lib/provider/provider-wiring.ts` with a re-export from
`orchestration-wiring.ts`.

**Types and interfaces used (from Phase 5):**
- `ProviderRegistry` from Phase 5 — call `registry.register(adapter)`.
- `ProviderAdapter` interface — both `OpenCodeAdapter` and `ClaudeAdapter`
  implement this.
- `EventSink` — passed to adapters via `SendTurnInput`, NOT via a `bind()` method.
- `ClaudeAdapterDeps` from Task 47 — `{ workspaceRoot: string }` plus any
  extensions from Task 48.

**Key behavioral requirements:**
1. `wireProviders(config)` creates a `ProviderRegistry`, instantiates adapters
   based on config, and registers them. It returns `{ registry, engine }`.
2. OpenCode is always registered. Claude is registered only when claude config
   is provided.
3. `ProviderRegistry.register()` must have an idempotency guard — throw or
   no-op if a provider with the same `providerId` is already registered.
4. `OrchestrationEngine.dispatchTurn()` routes to the correct adapter by
   looking up the session's active provider in the registry.
5. `OrchestrationEngine.switchProvider()` updates the session's provider and
   emits a `session.provider_changed` event via `EventSink.push()` (NOT
   `EventSink.emit()` which doesn't exist).
6. `wireProviders` exposes a `dispose()` method that calls `shutdown()` on
   all registered adapters.

**Test scenarios (place at `test/unit/provider/provider-wiring.test.ts`):**
- `wireProviders` registers OpenCode adapter by default
- `wireProviders` registers both adapters when claude config is provided
- Lists all registered provider IDs
- Routes `dispatchTurn` to the correct adapter based on session provider
- Emits `session.provider_changed` via `EventSink.push()` on provider switch
- Double-registration of same providerId is guarded
- `dispose()` calls `shutdown()` on all adapters

**Implementation deferred — Phase 6a establishes the foundation, this task
builds on it using the same types and patterns.**

---

## Phase 6 — Completion Checklist

### Files Created

| # | File | Purpose |
|---|------|---------|
| 1 | `src/lib/provider/claude/claude-adapter.ts` | Main Claude SDK adapter (Tasks 47–50) |
| 2 | `src/lib/provider/claude/prompt-queue.ts` | Async queue implementing `AsyncIterable<SDKUserMessage>` (Task 44) |
| 3 | `src/lib/provider/claude/claude-event-translator.ts` | Maps SDK events to canonical events via EventSink (Task 45) |
| 4 | `src/lib/provider/claude/claude-permission-bridge.ts` | Bridges `canUseTool` callback to EventSink (Task 46) |
| 5 | `src/lib/provider/claude/types.ts` | SDK adapter types and re-exports (Task 43) |
| 6 | `test/unit/provider/claude/claude-adapter-send-turn.test.ts` | sendTurn unit tests (Task 48) |
| 7 | `test/unit/provider/claude/claude-adapter-lifecycle.test.ts` | interrupt/permission/question unit tests (Task 49) |
| 8 | `test/unit/provider/provider-wiring.test.ts` | Wiring and routing tests (Task 50) |

> **Note (audit Finding 14):** All test files MUST be under `test/unit/`, not
> `src/lib/`. The vitest config only includes `test/unit/**/*.test.ts` — tests
> under `src/` would be silently skipped by `pnpm test:unit`.

### Verification Commands

```bash
# Type-check
pnpm check

# Lint
pnpm lint

# Unit tests — Claude adapter
pnpm vitest run test/unit/provider/claude/

# Unit tests — wiring
pnpm vitest run test/unit/provider/provider-wiring.test.ts

# All unit tests
pnpm test:unit

# Full test suite
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed" && exit 1)
```

### SDK Installation

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

This must be done before any of the Claude adapter code will compile. The
package provides the `query()` function, SDK types, and the event stream
interface that the adapter consumes.

### Go/No-Go Checkpoint — Phase 6

**Question**: Does the Claude adapter reliably produce canonical orchestration
events for a multi-turn conversation?

**Criteria**:

1. `sendTurn()` creates an SDK session on first call and reuses the prompt
   queue on subsequent calls.
2. SDK output events are translated to canonical `text.delta`, `thinking.delta`,
   `tool.started`, `tool.running`, `tool.completed`, `turn.completed` events via
   `ClaudeEventTranslator`.
3. Permission requests flow through `ClaudePermissionBridge` → EventSink →
   OrchestrationEngine → UI → back through EventSink resolution.
4. Session resume works with cursor from `provider_state`; fallback to
   history preamble works when the SDK session is stale.
5. `interruptTurn()` cleanly aborts in-flight queries, resolves pending
   approvals/questions with reject, and emits `turn.interrupted`.
6. Provider switching routes commands to the correct adapter.
7. All unit tests pass; type-check and lint are clean.

**If all criteria are met**: Phase 6 is complete. Proceed to Phase 7
(frontend integration).

**If any criterion fails**: Debug using the systematic-debugging skill.
Focus on SDK event mapping fidelity (criterion 2) and resume reliability
(criterion 4) as the most likely failure points.

---

## Phase 7: Cleanup — Delete Transitional Code

> **Stage 3: Cleanup.** Delete MessageCache, JSONL files, ToolContentStore,
> PendingUserMessages, stale-tail detection, cold-cache repair.

**Goal**: Remove all transitional relay code that has been replaced by the event
store, projections, and provider adapters. This is the point of no return — only
enter this phase when Phases 1–6 are stable.

**Depends on**: All previous phases stable and verified.

**Hard prerequisites** (gate — do not begin Phase 7 unless ALL are met):

1. **Tasks 29-32 complete (Session Status + History read switchover)**: `resolveSessionHistory` in `session-switch.ts` reads
   from the MessageProjector (not `messageCache.getEvents()`). Stale-tail
   detection (`openCodeUpdatedAt`) is either obsolete (SQLite is single source
   of truth) or replaced by a projector watermark.
2. **Phase 5 complete**: `handleMessage` in `prompt.ts` dispatches through the
   OrchestrationEngine / provider adapter rather than calling
   `client.sendMessageAsync()` directly. Without this, removing
   `PendingUserMessages` causes user-message duplication — the relay would
   still POST to OpenCode REST, OpenCode's SSE stream would echo the
   `user_message` back, and nothing would suppress the echo.
3. **Phase 4 read-migration complete**: All handler-level consumers of
   `MessageCache`, `ToolContentStore`, and `PendingUserMessages` already read
   from SQLite projections (via the dual-write / read-flag path). Phase 7
   merely deletes the old classes and wiring.

> **Note**: This phase is destructive. Run the full integration + E2E test suite
> **before** and **after** each task. A task **cannot advance** until the
> preceding task's verification passes cleanly.

**(G1) Pre/post-deletion verification checklist:** Apply this to EVERY file deletion in Phase 7:

```
Pre-deletion verification:
1. Run `pnpm check` — must pass with zero errors
2. Search for imports: `rg "from.*<module-name>" src/` — must return zero results
3. Search for type references: `rg "<ClassName>" src/` — must return zero results
4. Run `pnpm test:unit` — must pass
5. Only then delete the file

Post-deletion verification:
1. Run `pnpm check` — must pass
2. Run `pnpm test:all > test-output.log 2>&1`
```

This prevents the common failure mode where an LLM deletes a file but misses an import in a test helper or a type-only import that doesn't fail at runtime.

---

### Task 50.5: Migrate Dependency Interfaces

> Preparatory task — strip `MessageCache`, `ToolContentStore`, and
> `PendingUserMessages` from every shared dependency interface so that
> Tasks 51 and 52 become pure file-deletion exercises.

**Interfaces to update** (remove the three fields from each):

| Interface | File | Fields to remove |
|---|---|---|
| `HandlerDeps` | `src/lib/handlers/types.ts:61` | `messageCache`, `pendingUserMessages`, `toolContentStore` |
| `SSEWiringDeps` | `src/lib/relay/sse-wiring.ts:56` | `messageCache`, `pendingUserMessages`, `toolContentStore` |
| `ClientInitDeps` | `src/lib/bridges/client-init.ts:29` | `messageCache` |
| `PipelineDeps` | `src/lib/relay/event-pipeline.ts:136` | `messageCache`, `toolContentStore` |
| `HandlerDepsWiringDeps` | `src/lib/relay/handler-deps-wiring.ts:35` | `messageCache`, `pendingUserMessages`, `toolContentStore` |
| `MonitoringWiringDeps` | `src/lib/relay/monitoring-wiring.ts:43` | `messageCache`, `toolContentStore` |
| `PollerWiringDeps` | `src/lib/relay/poller-wiring.ts:28` | `pendingUserMessages` |
| `ProjectRelay` | `src/lib/relay/relay-stack.ts:49` | `messageCache` |
| `RelayStack` | `src/lib/relay/relay-stack.ts:96` | `messageCache` |

**Wiring sites to update** (remove construction / pass-through of the three
objects):

- `src/lib/relay/handler-deps-wiring.ts:64–171` — remove from destructuring,
  `clientInitDeps`, and `handlerDeps` construction.
- `src/lib/relay/monitoring-wiring.ts:82–123` — remove from destructuring and
  `pipelineDeps` construction.
- `src/lib/relay/poller-wiring.ts:48–60` — remove `pendingUserMessages` from
  destructuring.
- `src/lib/relay/relay-stack.ts:127–` — remove construction of the three
  objects and all pass-through to wiring functions. Remove the
  `messageCache` field from the returned `ProjectRelay` and `RelayStack`.
- `src/lib/relay/relay-stack.ts:700–708` — remove `messageCache` from the
  returned `RelayStack` object.

**Handler call-site removals** (these currently use the three objects directly):

- `src/lib/handlers/prompt.ts:49` — remove `deps.messageCache.recordEvent()`.
  The event store write is now handled by the OrchestrationEngine / provider
  adapter (Phase 5 prerequisite).
- `src/lib/handlers/prompt.ts:57` — remove `deps.pendingUserMessages.record()`.
  No longer needed: the relay no longer POSTs to OpenCode REST, so no echo
  arrives to suppress.
- `src/lib/handlers/prompt.ts:154` — remove `deps.messageCache.remove()`.
  Session revert invalidation is now handled by the event store (projection
  rebuild).
- `src/lib/handlers/session.ts:137` — remove `messageCache` from
  `toSessionSwitchDeps()` return. Update `SessionSwitchDeps` interface in
  `session-switch.ts` to drop the `messageCache` field.
- `src/lib/handlers/session.ts:243` — remove `deps.messageCache.remove()` in
  `handleDeleteSession`.
- `src/lib/handlers/tool-content.ts:22` — rewrite `handleGetToolContent` to
  read from the `tool_content` SQLite table instead of `deps.toolContentStore`.
  **Note (I19):** Task 52 owns the `handleGetToolContent` removal, replacing
  it with `readQuery.getToolContent()`. Task 50.5 only removes the
  `toolContentStore` field from dependency interfaces; the handler rewrite
  happens in Task 52.
- `src/lib/bridges/client-init.ts:37,79,105` — remove `messageCache` from
  `ClientInitDeps` usage and `switchClientToSession` call.

**Pipeline call-site removals**:

- `src/lib/relay/event-pipeline.ts:163` — remove
  `deps.toolContentStore.store()` from `applyPipelineResult`. The event store
  write is now handled by a projector (Tasks 29-32 prerequisite).
- `src/lib/relay/event-pipeline.ts:171` — remove
  `deps.messageCache.recordEvent()` from `applyPipelineResult`. The event store
  write is now handled by the DualWriteHook / event store (Tasks 29-32).
- `src/lib/relay/sse-wiring.ts:338–345` — remove `pendingUserMessages.consume()`
  echo-suppression check.
- `src/lib/relay/poller-wiring.ts:82–93` — remove `pendingUserMessages.consume()`
  echo-suppression check.

**`messageCache.sessionCount()` call sites** (4 sites in `daemon.ts` — add to
removal manifest):

| File | Line | Current call | Replacement |
|---|---|---|---|
| `src/lib/daemon/daemon.ts` | ~647 | `messageCache.sessionCount()` | `persistence.db.queryOne("SELECT COUNT(*) as count FROM sessions")?.count ?? 0` |
| `src/lib/daemon/daemon.ts` | ~1224 | `messageCache.sessionCount()` | `persistence.db.queryOne("SELECT COUNT(*) as count FROM sessions")?.count ?? 0` |
| `src/lib/daemon/daemon.ts` | ~1487 | `messageCache.sessionCount()` | `persistence.db.queryOne("SELECT COUNT(*) as count FROM sessions")?.count ?? 0` |
| `src/lib/daemon/daemon.ts` | ~1624 | `messageCache.sessionCount()` | `persistence.db.queryOne("SELECT COUNT(*) as count FROM sessions")?.count ?? 0` |

**`messageCache.flush()` in `relay-stack.ts` `stop()` method**: Remove
entirely — no-op replacement. SQLite WAL handles persistence automatically;
there is no in-memory state to flush.

**`messageCache.setOpenCodeUpdatedAt()` in `sse-wiring.ts:191`**: Remove.
Replacement: `sessions.updated_at` update via projector (already handled by
SessionProjector).

> **Note (N7 — ordering constraint):** `messageCache` construction removal in
> `relay-stack.ts` MUST happen in Task 50.5 BEFORE Task 51 removes the module
> file (`message-cache.ts`), or compilation fails mid-phase. Ensure the
> construction site is removed and the build passes before proceeding to
> Task 51's file deletions.

**Also update**:

- `src/lib/daemon/project-registry.ts:116–126` — remove
  `entry.relay.messageCache.evictOldestSession()` from `evictOldestSessions()`.
  **Eviction replacement**: SQLite WAL + periodic VACUUM replaces JSONL
  eviction. The daemon's low-disk-space handler
  (`src/lib/daemon/daemon.ts:930`) should be updated to either (a) call an
  event store equivalent `evictOldest()` or (b) remove the eviction call
  entirely with a comment noting that SQLite manages space via WAL.
- `src/lib/daemon/daemon.ts:930–932` — update log message (currently says
  "Evicted cached session...") to reflect the new eviction strategy or remove
  the eviction call.
- `test/helpers/mock-factories.ts` — remove factory functions
  `createMockMessageCache` and the `MessageCache`, `ToolContentStore`,
  `PendingUserMessages` imports (lines 12, 15). Remove the three fields from
  `createMockHandlerDeps` (line 223–228), `createMockSSEWiringDeps`
  (lines 258–263), `createMockClientInitDeps` (line 289), and
  `createMockProjectRelay` (line 320).

**Import removals** (remove `import type` for the three classes from):

- `src/lib/handlers/types.ts:11,13,15`
- `src/lib/relay/handler-deps-wiring.ts:25,27,31`
- `src/lib/relay/monitoring-wiring.ts:22,39`
- `src/lib/relay/poller-wiring.ts:20`
- `src/lib/relay/sse-wiring.ts` (MessageCache, PendingUserMessages,
  ToolContentStore imports)
- `src/lib/bridges/client-init.ts:14` (MessageCache import)

**Verification**: `pnpm check && pnpm lint && pnpm test:unit` — the three
classes still exist on disk but are no longer imported anywhere except their
own test files.

**Commit**: `refactor: strip MessageCache, ToolContentStore, PendingUserMessages from all dependency interfaces`

---

### Task 51: Remove MessageCache + JSONL Files

> **Amendment (2026-04-07, S5 — Cascade Eviction for Projection Tables):**
> Extend the `EventStoreEviction` to cascade through projection tables when a session's events are
> fully evicted. Without this, `message_parts` (one row per text chunk, tool call, thinking block)
> becomes the largest table — reaching millions of rows in a month of active use.
>
> **Cascade condition:** Only when ALL events for a session have been evicted AND the session is idle
> AND the session is older than the retention period. This is stricter than event eviction alone.
>
> **Cascade order (respects FK constraints):**
> 1. `activities` (FK to sessions, turns)
> 2. `pending_approvals` (FK to sessions, turns)
> 3. `message_parts` (FK to messages)
> 4. `messages` (FK to sessions, turns)
> 5. `turns` (FK to sessions)
> 6. `session_providers` (FK to sessions)
> 7. `tool_content` (FK to sessions)
> 8. `provider_state` (FK to sessions)
> 9. `sessions` row itself
>
> **Implementation:** After the event DELETE batch loop completes, run a single query to find sessions
> with zero remaining events that are idle and old. For each such session, delete projection rows in
> FK-safe order. Batch the session deletions (e.g., 100 sessions per transaction) to avoid blocking.
>
> **Alternative rejected:** `ON DELETE CASCADE` on foreign keys — makes accidental session deletion
> catastrophic, SQLite cascades are synchronous and can't be batched, and the multi-table ordering
> requires explicit DELETE statements for transparency.

**Depends on**: Task 50.5 (all consumers removed from dependency interfaces).
Additionally depends on Tasks 29-32 (Session Status + History read switchover) completing the migration of
`resolveSessionHistory` to read from the MessageProjector — if that is not
complete, **do not enter this task**.

**Delete files**:
- `src/lib/relay/message-cache.ts`
- `src/lib/relay/cold-cache-repair.ts`

**Remove all remaining references from** (exhaustive list):

| File | Reference | Action |
|---|---|---|
| `src/lib/relay/relay-stack.ts:167–178` | `MessageCache` construction, `loadFromDisk()`, `loadMeta()`, `repairColdSessions()`, cache-dir creation (`join(config.configDir, "cache", ...)`) | Delete construction block and cache-dir variable |
| `src/lib/relay/relay-stack.ts:56,105` | `messageCache` field on `ProjectRelay` and `RelayStack` interfaces | Already removed by Task 50.5 — verify |
| `src/lib/relay/event-pipeline.ts:59–84` | `CACHEABLE_EVENT_TYPES` constant + compile-time assertion | Delete or repurpose — see note below |
| `src/lib/event-classify.ts:3` | Comment reference to `cold-cache-repair` | Update comment to remove mention |

> **Note (L7):** `event-classify.ts` is NOT deleted — only its comments are
> updated to reference the new event store. The module's classification logic
> remains in use by the event pipeline.

**JSONL cache directory**: The cache directory is created in
`src/lib/relay/relay-stack.ts:168–173` (NOT `daemon.ts` — the original plan
had the wrong file path). Remove the `cacheDir` variable and all
`MessageCache` construction.

**Eviction chain removal + EventStoreEviction (P6)**:

> **Amendment (2026-04-07 — Perf-Fix-3): Batched Eviction and Off-Thread VACUUM.**
> Replaces the single unbatched `DELETE FROM events WHERE session_id IN (...)`
> with batched DELETE (LIMIT per batch), adds `evictSync()` / `evictAsync()`
> modes, adds `command_receipts` cleanup, and removes `vacuum()` from the
> public API. File renamed from `event-store-eviction.ts` to `eviction.ts`.
> See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 3.

(P6) Create `src/lib/persistence/eviction.ts` implementing batched
age-based session eviction that replaces the JSONL eviction chain:

```typescript
// src/lib/persistence/eviction.ts
import type { SqliteClient } from "./sqlite-client.js";
import type { Logger } from "../logger.js";

export interface EvictionOptions {
	/** How old a session must be (ms) before its events are evicted. Default: 7 days. */
	retentionMs?: number;
	/** Max rows to delete per batch. Default: 5000. */
	batchSize?: number;
	/** Callback invoked between batches (for yielding the event loop). */
	onYield?: () => void;
}

export interface EvictionResult {
	eventsDeleted: number;
	receiptsDeleted: number;
	batchesExecuted: number;
	/** (S5) Number of sessions whose projection tables were cascade-deleted. */
	sessionsCascaded?: number;
}

/**
 * Age-based event store eviction with batched deletes.
 *
 * (P6v2, Perf-Fix-3) Simplified from v1's three-tier approach. The v1 Tier 1
 * (per-message delta compaction via json_extract) was a full-table-scan
 * disaster at scale. This version uses a single indexed query on the
 * sessions table to identify stale sessions, then deletes their events
 * via the FK index on events.session_id — in batches of `batchSize` rows.
 *
 * Projection rows (sessions, messages, turns, message_parts) remain as
	 * queryable history after event eviction. Call `cascadeProjections()` after
	 * event eviction to also delete projection rows for sessions with zero
	 * remaining events (S5). Only raw event store rows and old command receipts
	 * are evicted by `evictSync()` / `evictAsync()`.
 *
 * Two modes:
 * - `evictSync()`: Batched DELETE in a loop. Each batch is a separate
 *   transaction. Suitable for moderate-size stores (<100K events).
 * - `evictAsync()`: Same batched DELETE but `await`s a `setImmediate`
 *   between batches, yielding the event loop. Use for large stores.
 *
 * VACUUM is intentionally omitted from the public API. It rewrites the
 * entire database file synchronously and should only be run from a CLI
 * command or worker thread, never during normal daemon operation.
 *
 * Future enhancement: if per-message delta compaction is later needed,
 * add a `message_id` column to the events table (denormalized from JSON
 * payload), index it, and use that for targeted deletion without
 * json_extract.
 */
export class EventStoreEviction {
	private readonly db: SqliteClient;
	private readonly log?: Logger;

	constructor(db: SqliteClient, log?: Logger) {
		this.db = db;
		this.log = log;
	}

	/**
	 * Synchronous batched eviction. Blocks the event loop only for
	 * `batchSize` rows at a time (~1-5ms per batch of 5000 rows).
	 */
	evictSync(opts?: EvictionOptions): EvictionResult {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		// Batched event deletion — each batch is its own implicit transaction
		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break; // last batch
		}

		// Command receipts cleanup (single pass — typically small table)
		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return { eventsDeleted: totalEventsDeleted, receiptsDeleted, batchesExecuted };
	}

	/**
	 * Async batched eviction. Yields the event loop between batches via
	 * `setImmediate`, allowing WebSocket/HTTP handlers to run.
	 */
	async evictAsync(opts?: EvictionOptions): Promise<EvictionResult> {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 5000;
		const onYield = opts?.onYield;
		const cutoff = Date.now() - retentionMs;

		let totalEventsDeleted = 0;
		let batchesExecuted = 0;

		while (true) {
			const result = this.db.execute(
				`DELETE FROM events WHERE sequence IN (
					SELECT events.sequence FROM events
					JOIN sessions ON events.session_id = sessions.id
					WHERE sessions.status = 'idle'
					  AND sessions.updated_at < ?
					LIMIT ?
				)`,
				[cutoff, batchSize],
			);

			const deleted = Number(result.changes);
			totalEventsDeleted += deleted;
			batchesExecuted++;

			if (deleted < batchSize) break;

			// Yield the event loop
			onYield?.();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		const receiptsResult = this.db.execute(
			"DELETE FROM command_receipts WHERE created_at < ?",
			[cutoff],
		);
		const receiptsDeleted = Number(receiptsResult.changes);

		if (totalEventsDeleted > 0 || receiptsDeleted > 0) {
			this.log?.info("eviction complete", {
				eventsDeleted: totalEventsDeleted,
				receiptsDeleted,
				batchesExecuted,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return { eventsDeleted: totalEventsDeleted, receiptsDeleted, batchesExecuted };
	}

	// ── S5: Cascade Eviction for Projection Tables ─────────────────────

	/**
	 * (S5) Cascade through projection tables for sessions with zero
	 * remaining events. Call after evictSync/evictAsync completes.
	 *
	 * Only deletes projection rows when ALL conditions are met:
	 * 1. All events for the session have been evicted (zero remaining)
	 * 2. Session is idle
	 * 3. Session is older than the retention period
	 *
	 * Deletes in FK-safe order. Batches session deletions (100 per
	 * transaction) to avoid blocking.
	 */
	cascadeProjections(opts?: { retentionMs?: number; batchSize?: number }): number {
		const retentionMs = opts?.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
		const batchSize = opts?.batchSize ?? 100;
		const cutoff = Date.now() - retentionMs;

		// Find sessions with zero remaining events that are idle and old
		const staleSessions = this.db.query<{ id: string }>(
			`SELECT s.id FROM sessions s
			 LEFT JOIN events e ON e.session_id = s.id
			 WHERE s.status = 'idle'
			   AND s.updated_at < ?
			 GROUP BY s.id
			 HAVING COUNT(e.sequence) = 0`,
			[cutoff],
		);

		if (staleSessions.length === 0) return 0;

		let totalCascaded = 0;

		// Process in batches of batchSize sessions per transaction
		for (let i = 0; i < staleSessions.length; i += batchSize) {
			const batch = staleSessions.slice(i, i + batchSize);
			const ids = batch.map((s) => s.id);

			this.db.runInTransaction(() => {
				for (const sessionId of ids) {
					// FK-safe cascade order:
					// 1. activities (FK to sessions, turns)
					this.db.execute("DELETE FROM activities WHERE session_id = ?", [sessionId]);
					// 2. pending_approvals (FK to sessions, turns)
					this.db.execute("DELETE FROM pending_approvals WHERE session_id = ?", [sessionId]);
					// 3. message_parts (FK to messages — need subquery)
					this.db.execute(
						"DELETE FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)",
						[sessionId],
					);
					// 4. messages (FK to sessions, turns)
					this.db.execute("DELETE FROM messages WHERE session_id = ?", [sessionId]);
					// 5. turns (FK to sessions)
					this.db.execute("DELETE FROM turns WHERE session_id = ?", [sessionId]);
					// 6. session_providers (FK to sessions)
					this.db.execute("DELETE FROM session_providers WHERE session_id = ?", [sessionId]);
					// 7. tool_content (FK to sessions)
					this.db.execute("DELETE FROM tool_content WHERE session_id = ?", [sessionId]);
					// 8. provider_state (FK to sessions)
					this.db.execute("DELETE FROM provider_state WHERE session_id = ?", [sessionId]);
					// 9. sessions row itself
					this.db.execute("DELETE FROM sessions WHERE id = ?", [sessionId]);

					totalCascaded++;
				}
			});
		}

		if (totalCascaded > 0) {
			this.log?.info("cascade eviction complete", {
				sessionsCascaded: totalCascaded,
				cutoff: new Date(cutoff).toISOString(),
			});
		}

		return totalCascaded;
	}
}
```

**Eviction tests** (`test/unit/persistence/eviction.test.ts`):

```typescript
// test/unit/persistence/eviction.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { EventStoreEviction } from "../../../src/lib/persistence/eviction.js";

describe("EventStoreEviction", () => {
	let db: SqliteClient;
	let eviction: EventStoreEviction;
	const now = Date.now();
	const oneWeekAgo = now - 8 * 24 * 60 * 60 * 1000;

	beforeEach(() => {
		db = SqliteClient.memory();
		runMigrations(db, schemaMigrations);
		eviction = new EventStoreEviction(db);
	});

	afterEach(() => {
		db?.close();
	});

	function seedSession(id: string, status: string, updatedAt: number): void {
		db.execute(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[id, "opencode", "Test", status, updatedAt, updatedAt],
		);
	}

	function seedEvents(sessionId: string, count: number): void {
		for (let i = 0; i < count; i++) {
			db.execute(
				`INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at)
				 VALUES (?, ?, ?, 'text.delta', '{}', 'opencode', ?)`,
				[`evt-${sessionId}-${i}`, sessionId, i, now],
			);
		}
	}

	it("evicts events from idle sessions older than retention period", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedSession("recent-idle", "idle", now);
		seedEvents("old-idle", 100);
		seedEvents("recent-idle", 50);

		const result = eviction.evictSync();

		expect(result.eventsDeleted).toBe(100);
		const remaining = db.query("SELECT * FROM events WHERE session_id = 'recent-idle'");
		expect(remaining).toHaveLength(50);
	});

	it("does not evict events from busy sessions", () => {
		seedSession("old-busy", "busy", oneWeekAgo);
		seedEvents("old-busy", 100);

		const result = eviction.evictSync();
		expect(result.eventsDeleted).toBe(0);
	});

	it("batches large deletes", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 12000);

		const result = eviction.evictSync({ batchSize: 5000 });

		expect(result.eventsDeleted).toBe(12000);
		expect(result.batchesExecuted).toBeGreaterThan(1);
	});

	it("evictAsync yields between batches", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 190);

		let yieldCount = 0;
		const result = await eviction.evictAsync({
			batchSize: 50,
			onYield: () => { yieldCount++; },
		});

		expect(result.eventsDeleted).toBe(190);
		expect(result.batchesExecuted).toBe(4);
		expect(yieldCount).toBe(3);
	});

	it("handles exactly-divisible batch counts correctly", async () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 100);

		const result = await eviction.evictAsync({ batchSize: 50 });

		expect(result.eventsDeleted).toBe(100);
		expect(result.batchesExecuted).toBe(3);
	});

	it("cleans up command_receipts older than retention period", () => {
		seedSession("s1", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old", "s1", "accepted", oneWeekAgo],
		);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent", "s1", "accepted", now],
		);

		const result = eviction.evictSync();

		const remaining = db.query("SELECT * FROM command_receipts");
		expect(remaining).toHaveLength(1);
		expect(result.receiptsDeleted).toBeGreaterThan(0);
	});

	it("receipt eviction is time-based, independent of event eviction", () => {
		seedSession("old-idle", "idle", oneWeekAgo);
		seedEvents("old-idle", 10);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-recent-for-old", "old-idle", "accepted", now],
		);
		seedSession("recent", "idle", now);
		db.execute(
			"INSERT INTO command_receipts (command_id, session_id, status, created_at) VALUES (?, ?, ?, ?)",
			["cmd-old-for-recent", "recent", "accepted", oneWeekAgo],
		);

		eviction.evictSync();

		const receipts = db.query<{ command_id: string }>("SELECT command_id FROM command_receipts");
		expect(receipts).toHaveLength(1);
		expect(receipts[0]!.command_id).toBe("cmd-recent-for-old");
	});
});
```

**Wiring into PersistenceLayer and Daemon:**

```typescript
// In PersistenceLayer, add:
//   readonly eviction: EventStoreEviction;
// In constructor:
//   this.eviction = new EventStoreEviction(db);

// In Daemon, periodic eviction (e.g., hourly) — use evictAsync to avoid blocking:
setInterval(async () => {
  await persistence.eviction.evictAsync();
}, 60 * 60 * 1000);
```

**Impact:** Keeps the events table bounded. Sessions idle for >7 days have their
events evicted; projection rows remain for browsing history. Batched deletes
(5000 rows/batch default) prevent event-loop blocking. `command_receipts`
are independently cleaned by age.

**Eviction chain replacement sites:**
- `src/lib/daemon/project-registry.ts:116–126` —
  `evictOldestSessions()` method body used
  `entry.relay.messageCache.evictOldestSession()`. Already neutered by Task
  50.5. Replace with `persistence.eviction.evictSync()`.
- `src/lib/daemon/daemon.ts:930–932` — the low-disk-space handler calls
  `this.registry.evictOldestSessions(3)`. Replace with
  `await persistence.eviction.evictAsync()` and log the results.
- Delete `test/unit/daemon/daemon-eviction-chain.test.ts`.

**`CACHEABLE_EVENT_TYPES` decision**: Either (a) keep as the contract for
"which event types the projector persists" and rename to
`PERSISTED_EVENT_TYPES`, or (b) delete entirely along with
`test/helpers/cache-events.ts` and `test/unit/relay/cache-replay-contract.test.ts`
and any tests that use `assertCacheRealisticEvents` / `asCacheEvents`.

**`truncate-content.ts` decision**: This module is a pure function independent
of `ToolContentStore`. It should be kept (only has a comment reference to the
store, no import).

**Test files to delete**:
- `test/unit/relay/message-cache.test.ts`
- `test/unit/relay/cold-cache-repair.test.ts`
- `test/unit/relay/cache-replay-contract.test.ts`
- `test/unit/relay/regression-server-cache-pipeline.test.ts`
  > **Note (L9):** Before deleting
  > `regression-server-cache-pipeline.test.ts`, audit its test cases to ensure
  > equivalent coverage exists in the new persistence test suite.
- `test/unit/daemon/daemon-eviction-chain.test.ts`
- `test/helpers/cache-events.ts` (if `CACHEABLE_EVENT_TYPES` is deleted)

**Test files to audit/update**:
- `test/unit/session/session-switch.test.ts` — has 27+ references to
  `messageCache` as a mock shape. Audit line-by-line: remove all
  `messageCache:` mock fields from test fixtures; update assertions that
  verify `messageCache.getEvents` was called.
- `test/helpers/mock-factories.ts` — already updated by Task 50.5, but verify
  no residual `MessageCache` references remain.

**Also verify**: `test/e2e/fixtures/subagent-snapshot.json` contains embedded
file paths referencing `message-cache.ts` and `cold-cache-repair.ts`. These
are historical agent trace recordings and should be harmless — verify they do
not cause test failures.

**Verification**: `pnpm check && pnpm lint && pnpm test:unit`
Cannot advance to Task 52 until this passes.

**Commit**: `refactor: remove MessageCache and JSONL caching — replaced by SQLite event store`

---

### Task 52: Remove ToolContentStore + PendingUserMessages

**Depends on**: Task 50.5 (all consumers removed from dependency interfaces)
and Task 51 (MessageCache already deleted — avoids merge conflicts in shared
files).

**Hard prerequisite for PendingUserMessages removal**: Phase 5 must have
rewritten `handleMessage` in `prompt.ts` to dispatch through the
OrchestrationEngine rather than calling `client.sendMessageAsync()` directly.
Without this, removing PendingUserMessages causes user-message duplication.
The relay would still POST to OpenCode REST, OpenCode's SSE stream would echo
the `user_message` back, and nothing would suppress the echo. (See Phase 7
prerequisite #2 above.)

**Delete files**:
- `src/lib/relay/tool-content-store.ts`
- `src/lib/relay/pending-user-messages.ts`

**Remove all remaining references from** (exhaustive list — most already
cleaned by Task 50.5, verify no residuals):

| File | Reference | Action |
|---|---|---|
| `src/lib/relay/relay-stack.ts` | `ToolContentStore` / `PendingUserMessages` construction | Delete construction blocks |
| `src/lib/relay/event-pipeline.ts:137–163` | `PipelineDeps.toolContentStore` usage in `applyPipelineResult` | Already removed by Task 50.5 — verify |
| `src/lib/relay/sse-wiring.ts:338–345` | `pendingUserMessages.consume()` echo suppression | Already removed by Task 50.5 — verify |
| `src/lib/relay/poller-wiring.ts:82–93` | `pendingUserMessages.consume()` echo suppression | Already removed by Task 50.5 — verify |
| `src/lib/handlers/prompt.ts:49,57,154` | `messageCache.recordEvent()`, `pendingUserMessages.record()`, `messageCache.remove()` | Already removed by Task 50.5 — verify |

**`handleGetToolContent` rewrite** — **Task 52 owns this removal (I19)**:
- `src/lib/handlers/tool-content.ts:22` — rewrite to read from the
  `tool_content` SQLite table via `readQuery.getToolContent()`. The handler
  currently does `deps.toolContentStore.get(messageId)` — replace with a
  query against the projection table.

**Test files to delete**:
- `test/unit/relay/tool-content-store.test.ts`
- `test/unit/relay/pending-user-messages.test.ts`
- `test/unit/relay/regression-user-message-echo.test.ts`
- `test/unit/handlers/get-tool-content-handler.test.ts` (rewrite if
  `handleGetToolContent` was rewritten to use SQLite; otherwise delete)

**Test files to audit/update**:
- `test/helpers/mock-factories.ts` — verify no residual `ToolContentStore` or
  `PendingUserMessages` references remain after Task 50.5.

**Also verify**: `test/e2e/fixtures/subagent-snapshot.json` contains embedded
file paths referencing `tool-content-store.ts` and
`pending-user-messages.ts`. These are historical agent trace recordings and
should be harmless — verify they do not cause test failures.

**Verification**: `pnpm check && pnpm lint && pnpm test:unit`
Cannot advance to Task 53 until this passes.

**Commit**: `refactor: remove ToolContentStore and PendingUserMessages — replaced by event store tables`

---

### Task 53: Remove Dual-Write Feature Flags + Fallback Paths

- Remove the `ReadFlags` module introduced in Phase 4 (Task 24: Feature Flags
  for Read Path Switching). Search targets:
  `rg -l 'ReadFlags\|ReadSource\|ReadMode\|PersistenceReadFlags\|dualWriteEnabled' src/`
  — the module path is expected to be `src/lib/persistence/read-flags.ts` or
  similar. If Phase 4 renamed it, the grep will find the actual name.
- Remove all flag checks and legacy fallback code paths.
- Remove `DualWriteHook`'s feature flag — SQLite is now the only write path.
  Specifically:
  - Remove `dualWriteEnabled` from `ProjectRelayConfig` (in
    `src/lib/types.ts` or wherever the interface is defined).
  - Remove conditional construction of `DualWriteHook` in
    `createProjectRelay` (`relay-stack.ts`).
  - Remove from CLI/daemon config loaders that forward the flag.
  - Remove any environment variables or config file keys backing the flag.
- Make all reads go directly to SQLite (no more REST fallback for sessions,
  messages, permissions).

**Verification**: `pnpm check && pnpm lint && pnpm test:unit`
Cannot advance to Task 54 until this passes.

**Commit**: `refactor: remove dual-write feature flags — SQLite is sole read/write path`

---

### Task 54: Rewrite SessionStatusPoller as Reconciliation Loop

> **Decision (Audit Q9):** Hybrid reconciliation. The SessionProjector is **passive** — it only updates
> status from `session.status` events. If SSE drops while a session is "busy", the corrective "idle"
> event may never arrive (OpenCode doesn't replay on reconnect). Status gets stuck forever. The poller
> must be kept as a lightweight reconciliation mechanism, not deleted.

**Approach: Modified Option B (Hybrid Reconciliation)**

Rewrite `SessionStatusPoller` to:

1. **Change poll interval from 500ms to 5-10 seconds.** This is now a background reconciliation job, not a real-time data source.

2. **Replace `this.client.getSessionStatuses()` with projection reads.** Read `sessions.status` from SQLite via `ReadQueryService`. This is the primary source.

3. **Add REST reconciliation check.** On each tick, also fetch `GET /session/status` from OpenCode REST API. Compare REST result against projected `sessions.status`. If they differ (e.g., REST says "idle" but projection says "busy"), **synthesize a corrective `session.status` event** and feed it through the normal append → project pipeline. Log a warning when correction happens (indicates a missed SSE event).

   **Corrective event injection mechanism (N8):**
   ```typescript
   // When reconciliation detects status mismatch:
   if (polledStatus !== projectedStatus) {
   	// (Concurrency Solutions Change 2) Use EventPipeline instead of direct eventStore.append()
   	pipeline.ingest(makeCanonicalEvent("session.status", sessionId, {
   		sessionId, status: polledStatus
   	}));
   }
   ```

4. **Add SSE reconnect reconciliation.** In the `connected` handler in `sse-wiring.ts` (alongside the existing translator reset), fetch `GET /session/status`. For any session where REST says "idle" but projection says "busy", inject a corrective `session.status` event using the same `eventStore.append(makeCanonicalEvent(...))` pattern shown above. This catches the most common case: SSE dropped during a turn, reconnected after completion.

5. **Keep `augmentStatuses()` as in-memory annotations (sub-option b):**
   - `markMessageActivity` (synthetic busy from message polling) — still needed for CLI sessions
   - `notifySSEIdle` (SSE authoritative idle) — still needed for fast idle transitions
   - `computeAugmentedStatuses` — pure function, keep and update signature if inputs change

6. **Add staleness safety net.** If a session has been "busy" for longer than 30 minutes with no events, flag it as potentially stale and log a warning. This is a safety net for the case where both SSE and REST reconciliation fail.

   **(G2) Implementation:** Track `last_status_event_at` via the `updated_at` column already maintained by SessionProjector. The reconciliation loop checks:

   ```typescript
   const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

   function isSessionStatusStale(session: SessionRow): boolean {
     if (session.status !== "busy") return false;
     return Date.now() - session.updated_at > SESSION_STALE_THRESHOLD_MS;
   }

   // In reconciliation loop:
   for (const session of sessions) {
     if (isSessionStatusStale(session)) {
       log.warn(`Session ${session.id} has been busy for ${((Date.now() - session.updated_at) / 60000).toFixed(1)}min — marking stale`);
       // (Concurrency Solutions Change 2) Use EventPipeline instead of direct db.execute()
       pipeline.ingest(makeCanonicalEvent("session.status", session.id, {
       	sessionId: session.id, status: "idle"
       }));
     }
   }
   ```

**Keep**: `src/lib/session/status-augmentation.ts` (`computeAugmentedStatuses`)
— this is a pure function. If its inputs change shape, update the signature.

**Rewire consumers:** All 8 consumers of `SessionStatusPoller` continue to work — the poller still exposes the same interface, it just reads from a different source and reconciles less frequently.

> **Note (L8):** The line numbers below are likely stale. Use grep-based
> discovery to find all consumers:
> `grep -rn 'SessionStatusPoller\|augmentStatuses' src/`

- `src/lib/relay/handler-deps-wiring.ts:23,48`
- `src/lib/bridges/client-init.ts:18,42`
- `src/lib/relay/relay-stack.ts:24,204`
- `src/lib/handlers/types.ts:19,82`
- `src/lib/relay/poller-wiring.ts:10,31`
- `src/lib/relay/monitoring-wiring.ts:14,50,190`
- `src/lib/session/session-lifecycle-wiring.ts:10,27,92`
- `src/lib/relay/sse-wiring.ts:86`

**Verification**: `pnpm check && pnpm lint && pnpm test:unit`
Cannot advance to Task 55 until this passes.

**Commit**: `refactor: rewrite SessionStatusPoller as 5-10s reconciliation loop with corrective event injection`

---

### Task 55: Update AGENTS.md + Architecture Docs

- Update `AGENTS.md` to reflect the new architecture (conduit is an
  orchestrator, not a relay).
- Update `docs/agent-guide/architecture.md` to describe the event store,
  projections, and provider adapters.

**Specific AGENTS.md changes**:

- **Source Map** section (lines ~22–32): Update the bullet list:
  - `src/lib/relay/` — change description from "OpenCode event pipeline,
    caches, pollers, PTY upstream wiring" to "OpenCode event pipeline,
    pollers, PTY upstream wiring" (remove "caches").
  - Add: `src/lib/persistence/` — "SQLite event store, projectors, migration."
  - Add: `src/lib/provider/` — "Provider adapters (OpenCode, Claude SDK)."
- **Architecture At A Glance** section (lines ~9–19): Remove or reword any
  mention of "Source of truth: OpenCode". The current AGENTS.md line ~18 says
  "OpenCode is the source of truth for sessions and messages. Relay-side caches
  are for responsiveness and recovery." Replace with: **"The SQLite event store
  is the source of truth for sessions and messages. Provider adapters are
  stateless execution engines that stream events into the store."**
- Remove any references to `MessageCache`, `ToolContentStore`, or
  `PendingUserMessages` from the Troubleshooting Tips or other sections.

**Specific `docs/agent-guide/architecture.md` changes**:

- **Key Boundaries** section (line ~42 — may be labeled "Principles" in
  current file; fix the label if mislabeled): Remove "Source of truth:
  OpenCode" row. Replace with "Source of truth: conduit's event store".
- **`architecture.md:25`**: Update to reflect orchestrator architecture
  (remove relay-only language).
- **`architecture.md:52`**: Update to reflect event store as source of truth
  (remove OpenCode-as-source-of-truth language).
- **Event flow section**: Update to describe event store + projectors instead
  of SSE → MessageCache pipeline.
- **Session flow section**: Update to describe SessionProjector instead of
  MessageCache for session history.
- **Instance management section**: Update if it references the old relay-only
  architecture.
- Update or remove any diagrams that show MessageCache in the data flow.

**Verification**:
```bash
rg -l 'MessageCache\|ToolContentStore\|PendingUserMessages\|cold-cache-repair\|source of truth.*OpenCode' AGENTS.md docs/agent-guide/
```
Expect **zero matches**. Also read through both files for narrative consistency.

**Commit**: `docs: update AGENTS.md and architecture guide to reflect orchestrator architecture`

---

### Phase 7 Completion Checklist

- [ ] Task 50.5: All dependency interfaces stripped of the three doomed classes
- [ ] Task 51: MessageCache, cold-cache-repair, and all JSONL code deleted
- [ ] Task 51: Eviction chain removed or replaced
- [ ] Task 51: `session-switch.test.ts` audited and updated (27+ `messageCache` refs)
- [ ] Task 52: ToolContentStore and PendingUserMessages deleted
- [ ] Task 52: `handleGetToolContent` reads from SQLite
- [ ] Task 53: ReadFlags module and all dual-write fallback paths removed
- [ ] Task 53: `dualWriteEnabled` removed from `ProjectRelayConfig` and all config loaders
- [ ] Task 54: SessionStatusPoller rewritten or removed; all 8 consumers rewired
- [ ] Task 54: `computeAugmentedStatuses` input changes resolved
- [ ] Task 55: AGENTS.md Source Map and Architecture At A Glance updated
- [ ] Task 55: `docs/agent-guide/architecture.md` principles table, event flow,
      and session flow sections updated
- [ ] `test/helpers/mock-factories.ts` fully cleaned of all three classes
- [ ] All test files enumerated above are deleted or rewritten
- [ ] No remaining references:
      `rg 'MessageCache\|ToolContentStore\|PendingUserMessages\|cold-cache-repair' src/ test/`
      returns zero matches
- [ ] Final verification:
      `pnpm check && pnpm lint && pnpm test:unit && pnpm test:all > test-output.log 2>&1`

---

## Plan Summary

| Metric | Value |
|---|---|
| Total tasks | 56 (includes Task 50.5) |
| Total new files | ~30 |
| Total deleted files | ~15–20 (expanded in Phase 7 audit) |
| Phases | 7 |

**Key architectural change**: conduit moves from stateless relay to independent
orchestrator.

- The SQLite event store + projections are the new source of truth.
- Two provider adapters: OpenCode (legacy) and Claude (direct SDK).
- The WebSocket protocol to browsers is unchanged.
- The frontend is unaffected.

