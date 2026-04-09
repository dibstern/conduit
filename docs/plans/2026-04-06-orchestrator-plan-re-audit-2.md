# Orchestrator Implementation Plan — Second Re-Audit Synthesis

**Plan:** `docs/plans/2026-04-05-orchestrator-implementation-plan.md`  
**Date:** 2026-04-06 (second re-audit)  
**Scope:** All 7 phases, 55+ tasks  
**Auditors dispatched:** 7 (one per phase, running in parallel)  
**Individual reports:** `docs/plans/audits/orchestrator-plan-phase{1-7}.md`

---

## Executive Summary

**The core issue is systemic: amendments were recorded in the plan header (lines 31-107) but almost none were applied to the inline plan code.** An implementer following the plan's code snippets will reproduce every previously-identified bug. This affects 30+ of the 33 prior Amend Plan findings across all phases.

Additionally, a new **critical finding** in Phase 6 reveals that the Claude event translator uses 7 event type names that don't exist in the canonical event vocabulary from Phase 1, hidden by `as CanonicalEvent` casts.

**Findings by action:**
- **Amend Plan:** 39 findings (must be fixed before execution)
- **Ask User:** 1 finding (design decision)
- **Accept:** ~38 findings (informational)

---

## Systemic Issue: Amendments Not Applied Inline

The first re-audit (2026-04-06) identified 33 Amend Plan findings and 11 Ask User findings. User decisions Q1-Q11 were recorded, and amendment tables were added to the plan header. **However, the inline code snippets — which implementers copy — were NOT updated.** This is the single largest risk.

Affected phases and counts of unapplied amendments:
- Phase 1: 6 unapplied (Q2 schema, Q8 event types, I8 schema, L1-L3)
- Phase 2: 2 unapplied (I2 tests, stale prose)  
- Phase 3: 2 unapplied (I3 eventId, I5 placeholders)
- Phase 4: 7 unapplied (C3-C5, I6-I9 — all 7 prior findings)
- Phase 5: 5 unapplied (C6, I10, I11, Q6, Q7)
- Phase 6: 11 unapplied (C7, I12-I18, Q5, Q6, Q8 — only I14 was applied)
- Phase 7: 6 unapplied (C8-C10, Q10, I19, I21)

**Recommendation:** Before any implementation begins, all amendment table entries must be applied to their inline code targets.

---

## New Findings (not in prior audit)

### Critical

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **N1** | 6 | 45 | **Claude translator uses 7 non-existent event type names** (`content.delta`, `item.started`, `item.updated`, `item.completed`, `runtime.error`, `session.configured`, `session.token_usage`). Only `turn.completed` and `session.status` match `CANONICAL_EVENT_TYPES`. The `as CanonicalEvent` casts hide this — events will be rejected by `rowToStoredEvent()` at runtime. Requires defining a mapping from Claude event semantics → existing canonical types. |
| **N2** | 6 | 45 | **Claude translator payload shapes are incompatible.** Even if event type names are fixed, payloads use `{streamKind, delta}` instead of canonical `{messageId, partId, text}`. The translator must map Claude's content blocks → canonical message/part model. |

### Important

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **N3** | 3 | 16 | **`thinking.start` and `tool.started` handlers push parts without dedup check** — replaying these events creates duplicate parts (unlike `text.delta` which checks for existing part by ID). |
| **N4** | 4 | — | **`handler-deps-wiring.ts` not updated for Phase 4 deps** — new deps like `readQuery` and `readFlags` need wiring into handler dependency injection. |
| **N5** | 4 | — | **`SessionSwitchDeps` interface not extended** with readQuery/readFlags. Dead code path for SQLite session history. |
| **N6** | 5 | 42 | **Q7 contradiction:** User decided concurrent `sendTurn()` should queue sequentially, but inline code **throws an error** ("Turn already in progress"). |
| **N7** | 7 | 50.5 | **relay-stack.ts construction removal ordering** — messageCache construction removal must be in Task 50.5 before Task 51 removes the module, or compilation fails. |
| **N8** | 7 | 54 | **Corrective event injection mechanism is unspecified** — Task 54 hybrid reconciliation mentions injecting events to fix stale state but doesn't specify how. |

### Low Priority

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **N9** | 2 | 11 | **Integration test expects 1 stored event but should be 2** (session seed + message.created). |
| **N10** | 2 | 10 | **`permission.replied` test must include `sessionID`** in properties or extractSessionId() returns undefined. |
| **N11** | 7 | — | **Frontend `ws-dispatch.ts` comment references `CACHEABLE_EVENT_TYPES`** — needs update if removed. |

---

## Prior Findings Verification Summary

### Properly Fixed (confirmed applied inline)

| ID | Phase | Description |
|---|-------|-------------|
| C2 | 3 | Recovery loop off-by-one — corrected to `cursor = events[last].sequence` |
| I4 | 3 | Phase 3 intro now says "separate transaction (Option B)" |
| C11 | 7 | Task 53 now references "Task 24" specifically |
| Q9 | 7 | Task 54 describes hybrid reconciliation |
| Q11 | 7 | "Phase 4e" references replaced with task numbers |
| I14 | 6 | `session.provider_changed` added to canonical types |
| C1 | 2 | Hook placement corrected to TOP of function (code correct, stale prose at line 4689) |
| I1 | 2 | Stats test expectation corrected to `eventsWritten: 2` |
| Q1 | 2 | Opt-out behavior correctly described |

### NOT Fixed (amendment recorded but inline code unchanged)

**Phase 1 (6):** Q2 schema (`is_inherited`), Q8 event type (`tool.input_updated`), I8 schema (`always` column), L1 (`as string` cast), L2 (runtime validation), L3 (engine constraint)

**Phase 2 (2):** I2 (integration tests for session.updated/permission.replied), stale "at the END" prose

**Phase 3 (2):** I3 (missing eventId in test), I5 (placeholder fields)

**Phase 4 (7):** C3 (sqliteClient → persistence.db), C4 (PermissionBridge wiring), C5 (toSessionSwitchDeps), I6 (forkPointTimestamp/lastMessageAt), I7 (pagination over-fetch), I8 (always column), I9 (composite cursor)

**Phase 5 (5):** C6 (notifyTurnCompleted implementation), I10 (prose → code), I11 (as CanonicalEvent casts), Q6 (remove race), Q7 (sequential queue)

**Phase 6 (11):** C7 (PermissionDecision values), I12 (decision.message), I13 (toolInput generic), I15 (canUseTool factory), I16 (test fixture), I17 (wireProviders path), I18 (as CanonicalEvent), Q5 (image attachments), Q6 (remove race), Q7 (partial), Q8 (tool.input_updated)

**Phase 7 (6):** C8 (sessionCount call sites), C9 (flush dangling ref), C10 (setOpenCodeUpdatedAt), Q10 (event-store eviction), I19 (handleGetToolContent ownership), I21 (architecture.md lines)

---

## Go/No-Go Assessment

| Phase | Status | Blocking Items |
|-------|--------|----------------|
| **Phase 1** | ❌ Blocked | 3 schema columns missing from inline code (is_inherited, always, tool.input_updated) |
| **Phase 2** | ❌ Blocked | 2 missing integration tests, stale contradictory prose |
| **Phase 3** | ❌ Blocked | Missing eventId in test, placeholder field list, replay dedup gaps |
| **Phase 4** | ❌ Blocked | 7 unapplied amendments + 2 new wiring gaps |
| **Phase 5** | ❌ Blocked | notifyTurnCompleted never implemented, Q7 contradiction, prose not code |
| **Phase 6** | ❌ Blocked | 11 unapplied amendments + 2 critical new findings (event vocabulary mismatch) |
| **Phase 7** | ❌ Blocked | 3 critical dangling references, unspecified reconciliation mechanism |

**All phases blocked.** The primary action is mechanical: apply the 33 amendment-table entries to their inline code targets. The 2 critical new Phase 6 findings (N1, N2) require design work to map Claude events → canonical vocabulary.

---

## Amendments Applied (2026-04-06)

All 39 Amend Plan findings + 2 user decisions have been applied inline to the plan by 4 parallel fixer agents. Additionally, 2 critical new findings (N1/N2) were resolved per user decision to map Claude events → existing canonical types.

### Phase 1 (6 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| Q2 (is_inherited) | Added `is_inherited INTEGER NOT NULL DEFAULT 0` to `messages` table |
| Q8 (tool.input_updated) | Added event type, payload interface, payload map entry, updated test count 19→20 |
| I8 (always column) | Added `always TEXT` to `pending_approvals` table |
| L1 (as string cast) | Replaced with guarded `if (firstKey !== undefined)` check |
| L2 (runtime validation) | Added runtime check: `row.status === "accepted" || row.status === "rejected" ? row.status : "rejected"` |
| L3 (engine constraint) | Added note about `--experimental-sqlite` flag and `>=22.13.0` consideration |

### Phase 2 (5 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| I2 (missing tests) | Added `session.updated → session.renamed` and `permission.replied → permission.resolved` integration tests |
| Stale prose | Changed "at the END" → "at the top" |
| DualWriteHook docstring | Changed "after relay pipeline" → "before relay pipeline" |
| Session seed test | Changed `toHaveLength(1)` → `toHaveLength(2)` |
| I1 verification | Confirmed `eventsWritten: 2` already correct |

### Phase 3 (3 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| I3 (eventId) | Added `createEventId` import and `eventId: createEventId()` to recovery test |
| I5 (placeholders) | Replaced `// ... existing fields ...` with complete PersistenceLayer field list including `cursorRepo` |
| N3 (replay dedup) | Added dedup checks in `thinking.start` and `tool.started` handlers (find existing part, return early if exists) |

### Phase 4 (7 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| C3 (sqliteClient) | Replaced with `config.persistence.db` |
| C4 (PermissionBridge) | Added explicit `new PermissionBridge({ readQuery, readFlags })` wiring |
| C5 (toSessionSwitchDeps) | Added concrete implementation code with interface extension, client-init.ts changes |
| I6 (forkPointTimestamp) | Added `fork_point_timestamp` and `last_message_at` to session list query + mapping |
| I7 (pagination) | Changed to over-fetch by 1 (`LIMIT opts.limit + 1`) + `rows.length > opts.pageSize` |
| I9 (composite cursor) | Changed to `WHERE (created_at < ? OR (created_at = ? AND id < ?))` |
| N5 (SessionSwitchDeps) | Added explicit interface definition with `readQuery` and `readFlags` |

### Phase 5 (5 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| C6 (notifyTurnCompleted) | Replaced comment stub with actual `wireSSEToAdapter()` implementation |
| I10 (prose → code) | Converted bullet-points to 7 concrete code diffs with file paths |
| I11 (as CanonicalEvent) | Added `makeCanonicalEvent<K>()` typed helper, replaced all 4 casts in EventSinkImpl |
| Q7 (sequential queue) | Replaced `throw new Error` with queue mechanism + `processQueue()` |
| Q6 (EventSink canonical) | Added documentation declaring EventSink as canonical path with Phase 6 warning |

### Phase 6 (11 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| C7 (PermissionDecision) | Changed `"allow"/"deny"` → `"once"/"always"/"reject"` |
| I12 (decision.message) | Removed — replaced with static string |
| I13 (toolInput generic) | Changed to `Record<string, unknown>`, added `sessionId/turnId/providerItemId` |
| I15 (canUseTool) | Changed to `createCanUseTool(ctx)` factory method returning SDK signature |
| I16 (test fixture) | Populated all 16 required `ClaudeSessionContext` fields |
| I17 (wireProviders path) | Added `src/lib/provider/orchestration-wiring.ts` |
| I18 (as CanonicalEvent) | Added typed helper, replaced all ~12 casts in Claude translator |
| Q5 (image attachments) | Added image content block handling in PromptQueue and translator |
| Q6 (remove race) | Removed `Promise.race` pattern — EventSink awaited directly |
| Q8 (tool.input_updated) | Added `tool.input_updated` emission in `input_json_delta` handler |
| **N1/N2 (CRITICAL)** | **Remapped all 7 event types:** `content.delta`→`text.delta`, `item.started`→`tool.started`, `item.updated`→`tool.running`, `item.completed`→`tool.completed`, `runtime.error`→`turn.error`, `session.configured`→`session.status`, `session.token_usage`→`turn.completed`. Updated all payload shapes + tests. |

### Phase 7 (12 edits)
| Finding | Amendment Applied |
|---------|-------------------|
| C8 (sessionCount) | Added 4 daemon.ts call sites with SQLite replacement query |
| C9 (flush) | Added `messageCache.flush()` removal with no-op replacement |
| C10 (setOpenCodeUpdatedAt) | Added removal with SessionProjector replacement |
| I19 (handleGetToolContent) | Clarified Task 52 owns removal, using `readQuery.getToolContent()` |
| I20 (AGENTS.md wording) | Specified replacement text |
| I21 (section label + lines) | Fixed label, added `architecture.md:25` and `:52` |
| N7 (ordering) | Added note about construction removal before module deletion |
| N8 (corrective events) | Added code example for event injection mechanism |
| L7 (event-classify.ts) | Added note that file stays, only comments updated |
| L8 (grep discovery) | Replaced stale line numbers with grep command |
| L9 (regression test) | Added audit note before deletion |
| Q11 (Phase 4e) | Verified no remaining references in Phase 7 |

---

## Phase 6 Re-Audit (Post-Fix Round 2)

Re-audit found 7 Amend Plan + 2 Ask User + 3 Accept findings. All resolved:

### User Decisions
- **Abort timeout:** Add AbortSignal-aware wrapper (`withAbort<T>()`) — clean cancellation when abort fires
- **PermissionDecision type:** Plain string (`"once"|"always"|"reject"`) everywhere — no object wrapper

### Amendments Applied (9 fixes)
| Fix | Description |
|-----|-------------|
| F1 | Fixed `onAbort`: `{decision: "deny", message: "..."}` → `"reject"` (plain string) |
| F2 | Removed all 10 `as CanonicalEventType` casts — literal string types used instead |
| F3 | Fixed ALL payload shapes to match EventPayloadMap: tool.started, tool.running, tool.completed, text.delta, thinking.delta, turn.error, session.status, turn.completed, turn.interrupted |
| F4 | `turn.started` → `session.status` with `{sessionId, status: "busy"}` (no new event type needed) |
| F5 | Added `withAbort<T>()` helper for AbortSignal-aware promise wrapping |
| F6 | PermissionDecision as plain string everywhere — removed all object wrappers, fixed sink mocks |
| F7 | Removed dead Deferred pattern code (resolveLocal/rejectLocal/localDecision) |
| F8 | Updated all stale prose: event names, mapping table, docstrings, JSDoc comments |
| F9 | Updated all test assertions to match new payload fields |

### Report
- Full report: `docs/plans/audits/orchestrator-plan-phase6-reaudit.md`

---

## Final Go/No-Go Assessment

| Phase | Status | Notes |
|-------|--------|-------|
| **Phase 1** | ✅ Ready | All schema + event type amendments applied |
| **Phase 2** | ✅ Ready | Tests added, prose fixed, docstrings corrected |
| **Phase 3** | ✅ Ready | eventId fixed, placeholders replaced, replay dedup added |
| **Phase 4** | ✅ Ready | All 7 prior + 2 new wiring gaps addressed |
| **Phase 5** | ✅ Ready | notifyTurnCompleted implemented, queue mechanism added, casts replaced |
| **Phase 6** | ✅ Ready | Event vocabulary mapped, payloads fixed, abort handling added, types cleaned |
| **Phase 7** | ✅ Ready | All dangling references addressed, mechanisms specified |

**All 7 phases ready for execution.** Total amendments applied: 48 (39 initial + 9 re-audit).
