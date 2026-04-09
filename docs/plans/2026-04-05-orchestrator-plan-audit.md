# Orchestrator Implementation Plan — Audit Synthesis

**Plan:** `docs/plans/2026-04-05-orchestrator-implementation-plan.md`
**Date:** 2026-04-05
**Auditors:** 7 parallel subagents (one per phase)
**Individual reports:** `docs/plans/audits/orchestrator-plan-phase{1-7}.md`

---

## Aggregate Counts

| Action | Count |
|--------|-------|
| **Amend Plan** | ~58 |
| **Ask User** | 5 |
| **Accept** | ~30 |

---

## Amend Plan Findings (grouped by severity)

### Critical — Will Not Compile or Will Fail Tests

| # | Phase | Task | Finding | Fix |
|---|-------|------|---------|-----|
| 1 | P1 | 1 | WAL mode test asserts `"wal"` but `:memory:` databases return `"memory"` — test always fails | Only set WAL for file-backed DBs; fix test assertion |
| 2 | P1 | 1 | `ReadonlyArray<unknown>` incompatible with `StatementSync` API expecting `SQLInputValue` | Change param type to `ReadonlyArray<SQLInputValue>` |
| 3 | P2 | 12 | Static `import` inside function body is a syntax error | Move to top-level import |
| 4 | P2 | 11 | `permission.asked` integration test has no `sessionID` — translator returns null, test expects 1 event | Add `sessionID: "sess-1"` to test event properties |
| 5 | P3 | 21 | `makeCanonical()` test helper omits required `eventId` — SQL NOT NULL violation | Add `eventId: createEventId()` |
| 6 | P3 | 17 | `UPDATE ... ORDER BY ... LIMIT` requires non-standard SQLite compile flag | Use sub-select alternative |
| 7 | P3 | 21 | Tests reference `cursor.lastSequence` but interface defines `lastAppliedSeq` (4 locations) | Fix field name to `lastAppliedSeq` |
| 8 | P5 | 36 | EventSinkImpl uses snake_case field names (`event_id`, `session_id`, `timestamp`) but `CanonicalEvent` uses camelCase (`eventId`, `sessionId`, `createdAt`) — all fields `undefined` at runtime | Fix field names throughout EventSinkImpl |
| 9 | P5 | 36 | EventSinkImpl emits events with `session_id: ""` — no session context, violates FK constraints | Add `sessionId` and `provider` to `EventSinkDeps` |
| 10 | P5 | 36 | `PermissionAskedPayload` field mismatch: plan uses `requestId`/`toolInput` but spec defines `id`/`input` | Fix to match Phase 1 payload interfaces |
| 11 | P6 | 43-50 | Wrong SDK package name: `@anthropic-ai/claude-code` should be `@anthropic-ai/claude-agent-sdk` | Fix all imports and install command |
| 12 | P6 | 48-50 | Phase 6b redefines `ClaudeSessionContext`, uses `bind(sink)` pattern, and `emit`/`on`/`off` methods — all incompatible with 6a's types and `ProviderAdapter` interface | **Rewrite Phase 6b** to use 6a types and Phase 5's `EventSink.push()` API |
| 13 | P6 | 48 | `query()` called with wrong signature — passes string instead of `AsyncIterable<SDKUserMessage>` | Use `PromptQueue` from Task 44 as designed |
| 14 | P6 | 48-50 | Test files placed in `src/lib/provider/claude/__tests__/` — not matched by vitest config | Move to `test/unit/provider/claude/` |

### Critical — Will Compile But Behavior Breaks

| # | Phase | Task | Finding | Fix |
|---|-------|------|---------|-----|
| 15 | P2 | 7 | `session.created` canonical event is never emitted — Phase 3 SessionProjector depends on it | Emit `session.created` event when session first seen |
| 16 | P4 | 31-32 | Token format mismatch: produces `cacheRead`/`cacheWrite` but `HistoryMessage` expects `cache: { read, write }` | Fix nested token structure |
| 17 | P4 | 31-32 | Time field mismatch: produces `time.updated` but spec expects `time.completed` | Fix field name |
| 18 | P4 | 28 | `compareWithLegacyListInBackground` passes `[]` instead of actual `sqliteResult` | Pass `sqliteResult` as parameter |
| 19 | P4 | 23-34 | No relay-stack wiring — `ReadFlags`/`ReadQueryService` never passed to handler deps, making ALL Phase 4 dead code | Add explicit wiring task |
| 20 | P4 | 32 | `toSessionSwitchDeps()` and `client-init.ts` not updated to pass `readQuery`/`readFlags` | Update both call sites |
| 21 | P5 | 42 | `notifyTurnCompleted` never wired — `sendTurn()` blocks forever in production | Wire SSE events to `notifyTurnCompleted()` |
| 22 | P5 | 39 | Concurrent `sendTurn()` for same session silently clobbers first turn's Deferred | Add guard: throw if turn already in progress |
| 23 | P6 | 49 | `resolvePermission` is a no-op — contradicts Task 46's bridge which needs explicit resolution, causing deadlock | Must call through to `ClaudePermissionBridge.resolvePermission()` |
| 24 | P6 | 48 | Session context map leaks on errors — no cleanup, no abort signal propagation | Add `cleanup(sessionId)` method called from all error paths |
| 25 | P7 | 51-52 | Plans list only 3 files per class but actual dependency graph spans 10+ source files + dozens of tests | Enumerate ALL call sites and their replacements |
| 26 | P7 | 52 | Removing `PendingUserMessages` will cause duplicate user messages — `prompt.ts` still sends via REST which echoes back | Design decision needed (see Ask User #3) |

### Moderate — Correctness/Consistency Risks

| # | Phase | Task | Finding | Fix |
|---|-------|------|---------|-----|
| 27 | P1 | 3,6 | `result_sequence NOT NULL` forces sentinel `0` for rejected commands | Make nullable or document sentinel |
| 28 | P1 | 5 | `rowToStoredEvent` casts unvalidated string to `CanonicalEventType` — silent corruption | Add runtime validation against `CANONICAL_EVENT_TYPES` |
| 29 | P2 | 7 | Feature flag defaults contradict: outer guard opt-out, inner enabled opt-in | Use consistent defaults |
| 30 | P2 | 7 | Tool name casing inconsistency: `"Bash"` in tool events, `"bash"` in permissions | Standardize via `mapToolName` |
| 31 | P3 | 21 | Projector cursors only advance for matching event types — slow recovery for rare-event projectors | Advance ALL cursors on every event |
| 32 | P3 | 18 | ProviderProjector `session.created` generates random UUID — not idempotent on replay after provider change | Use deterministic ID or check all bindings |
| 33 | P3 | 20 | ActivityProjector uses `randomUUID()` with no dedup — every replay duplicates activities | Add sequence-based dedup or deterministic IDs |
| 34 | P3 | 22 | Event append and projection NOT in same transaction — contradicts stated Option A guarantee | Fix docs or implement true same-transaction |
| 35 | P3 | 15 | `INSERT OR REPLACE` destroys `provider_sid`, `parent_id`, `fork_point_event` on replay | Use `ON CONFLICT DO UPDATE` |
| 36 | P3 | 16 | `INSERT OR REPLACE` destroys accumulated parts/text on message replay | Use `ON CONFLICT DO NOTHING` |
| 37 | P3 | 19 | `INSERT OR REPLACE` resets resolved approval to pending on replay | Use `ON CONFLICT DO NOTHING` |
| 38 | P4 | 26 | `forkPointTimestamp` lost in fork metadata conversion — degrades fork splitting UX | Store or derive from event timestamp |
| 39 | P5 | 36 | EventSink pending maps leak if never resolved and abort never called | Wire AbortSignal to auto-cleanup |
| 40 | P6 | 45 | Missing `content_block_stop` handling — blocks appear "in progress" until turn ends | Add per-block completion |
| 41 | P6 | 45 | Missing `item.updated`/`content.delta` for tool results — output never shown in UI | Add tool result event emissions |
| 42 | P6 | 45 | Missing SDK event types: `tool_progress`, `system/status`, `system/task_progress` | Add at minimum status and progress handlers |
| 43 | P6 | 49 | `interruptTurn` doesn't clean up pending approvals, tools, or emit turn.interrupted | Full cleanup like t3code's `stopSessionInternal` |
| 44 | P7 | 54 | `SessionStatusPoller` has no "legacy path" — entire poller is REST. Task is ambiguous | Clarify: delete/rewrite/keep + list all consumers |

---

## Ask User Findings

| # | Phase | Task | Question |
|---|-------|------|----------|
| 1 | P1 | 1 | **Node engine version:** `package.json` allows `>=20.19.0` but `node:sqlite` requires `>=22.5.0`. Should the engine constraint be updated? |
| 2 | P1 | 5 | **Unbounded `readBySession`:** Should a `limit` parameter be added for consistency with `readFromSequence`? |
| 3 | P2 | 7 | **Missing `thinking.start` canonical event:** Is it intentional that there's no `thinking.start` in the 18 canonical types? The existing relay emits `thinking_start`. |
| 4 | P4 | 29 | **Projected status staleness:** How much lag is acceptable when reading session status from projections instead of REST polling? |
| 5 | P7 | 52 | **PendingUserMessages removal:** `prompt.ts` still sends user messages via REST which echoes back via SSE. Does Phase 7 assume `handleMessage` is rewritten to write directly to the event store? If not, removing echo suppression causes duplicate messages. |

---

## Phase-Specific Severity Assessment

| Phase | Assessment | Key Risk |
|-------|-----------|----------|
| **Phase 1** | Solid — 2 compile errors (WAL test, param types), easy fixes | Low risk after amendments |
| **Phase 2** | Good structure, 4 concrete bugs, missing `session.created` emission | Medium risk — missing event breaks Phase 3 |
| **Phase 3** | Well-designed, 3 critical test bugs, replay idempotency gaps in 3 projectors | Medium risk — replay safety needs work |
| **Phase 4** | Dead code without wiring task. 3 data format mismatches | **High risk** — needs a relay-stack wiring task |
| **Phase 5** | Sound architecture, but EventSinkImpl field names are wrong throughout | Medium-high risk — 6 findings in EventSink |
| **Phase 6** | **6a is solid. 6b needs substantial rewrite.** Incompatible types, wrong SDK API, no-op resolve, missing cleanup | **High risk** — Phase 6b should be rewritten |
| **Phase 7** | **Significantly under-specified.** Lists ~9 files but actual impact spans 40+ | **High risk** — needs full dependency enumeration |

---

## Recommended Fix Priority

1. **Rewrite Phase 6b (Tasks 48-50)** to align with 6a's types and Phase 5's interfaces
2. **Add Phase 4 wiring task** connecting ReadFlags/ReadQueryService to relay-stack
3. **Fix EventSinkImpl** field names, session context, and payload shapes (Phase 5)
4. **Fix Phase 3 replay safety** — change all `INSERT OR REPLACE` to `ON CONFLICT DO NOTHING/UPDATE`, use deterministic IDs
5. **Expand Phase 7** to enumerate all call sites (or add a pre-cleanup migration task)
6. **Fix Phase 1 compile errors** (WAL test, SQLInputValue types)
7. **Emit `session.created` event** in Phase 2 translator
8. **Fix Phase 4 data format mismatches** (token structure, time field)

---

## Amendments Applied (2026-04-05)

All 58 Amend Plan findings and all 5 Ask User findings have been resolved. Plan grew from 18,348 → 18,657 lines.

### User Decisions on Ask User Findings

| # | Phase | Question | Decision |
|---|-------|----------|----------|
| 1 | P1 | Update Node engine to `>=22.5.0`? | **Yes** — added Task 1 prerequisite step |
| 2 | P1 | Add `limit` to `readBySession`? | **Yes** — added with `DEFAULT_READ_LIMIT` |
| 3 | P2 | Add `thinking.start` canonical event? | **Yes** — added as 19th type across Phases 1-3 |
| 4 | P4 | Projected status staleness tolerance? | **N/A** — clarified no staleness exists (projections run synchronously in SSE handler tick) |
| 5 | P7 | Rewrite `handleMessage` before removing `PendingUserMessages`? | **Yes** — made explicit Phase 7 prerequisite |

### Key Structural Changes

- **Added Task 24.5** — Phase 4 Relay Stack Wiring (prevents all Phase 4 from being dead code)
- **Added Task 50.5** — Migrate Dependency Interfaces (makes Phase 7 a pure deletion exercise)
- **Added `thinking.start` canonical event** — now 19 types across Phase 1 events, Phase 2 translator, Phase 3 MessageProjector
- **Rewrote Phase 6b** — replaced incompatible Tasks 48-50 with aligned specifications using 6a types and Phase 5 interfaces
- **Rewrote Task 54** — clarified SessionStatusPoller has no "legacy path"; presented concrete options A/B
- **Expanded Task 51, 52** — enumerated all 10+ source files and 6+ test files per class
- **Replaced all `INSERT OR REPLACE` with `ON CONFLICT DO NOTHING/UPDATE`** — projector replay safety
- **Deterministic projector IDs** — ProviderProjector uses `${sessionId}:initial`, ActivityProjector uses `${sessionId}:${sequence}:${kind}`
- **Fixed EventSinkImpl field names throughout Phase 5** — snake_case → camelCase alignment with Phase 1 types
- **Fixed Phase 4 data format mismatches** — `cache: {read, write}` nested tokens, `time.completed` not `time.updated`
- **Wired `notifyTurnCompleted`** — Task 42 now subscribes to SSE session.status events

### Plan Counts (Post-Amendment)

- **Total tasks:** 56 (was 55 — Task 50.5 added)
- **Total lines:** 18,657 (was 18,348 — +309 lines of amendments)
- **Amendments applied:** 58 Amend Plan + 5 Ask User = 63 fixes

### Ready for Re-Audit

The plan is ready for re-audit via `subagent-plan-audit` to verify all fixes are correct and no regressions were introduced.
