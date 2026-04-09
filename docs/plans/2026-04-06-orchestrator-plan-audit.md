# Orchestrator Implementation Plan — Full Re-Audit Synthesis

**Plan:** `docs/plans/2026-04-05-orchestrator-implementation-plan.md`  
**Date:** 2026-04-06  
**Scope:** All 7 phases, 55+ tasks  
**Auditors dispatched:** 7 (one per phase, running in parallel)  
**Individual reports:** `docs/plans/audits/orchestrator-plan-phase{1-7}.md`

---

## Executive Summary

The plan has been substantially improved since its initial audit. Many prior findings have been correctly addressed. However, the re-audit identified **critical issues** in Phases 2, 3, 4, 5, 6, and 7 that would cause compilation failures, silent data loss, or blocked execution at runtime. The plan requires amendments before implementation can begin.

**Findings by action:**
- **Amend Plan:** 33 findings (must be fixed before execution)
- **Ask User:** 11 findings (design decisions required)
- **Accept:** ~40 findings (informational, no action needed)

---

## Amend Plan Findings

### Critical (will block compilation or cause data loss)

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **C1** | 2 | 11 | **Dual-write hook unreachable for key events.** `handleSSEEvent()` places the hook call at the END, but `session.updated` and `permission.replied` trigger early returns (relay translator returns `ok: false`). `session.renamed` and `permission.resolved` canonical events are **silently never written** to SQLite. Fix: Move hook call to TOP of function, right after `extractSessionId()`. |
| **C2** | 3 | 21 | **Recovery loop off-by-one.** `ProjectionRunner.recover()` sets `cursor = events[last].sequence + 1`, but `readFromSequence()` uses exclusive lower bound (`WHERE sequence > ?`). This means `readFromSequence(lastSeq + 1)` skips the event at `lastSeq + 1`. Fix: `cursor = events[last].sequence`. Triggers with >500 events, silently skips 1 event per batch boundary. |
| **C3** | 4 | 24.5 | **`sqliteClient` has no defined origin.** Task 24.5 references `sqliteClient` but `relay-stack.ts` doesn't create one and `ProjectRelayConfig` has no such field. The plan doesn't specify which Phase 1-3 task provides this. |
| **C4** | 4 | 24.5 | **PermissionBridge constructor wiring missing.** `relay-stack.ts` constructs `new PermissionBridge()` with no args. Task 24.5 doesn't wire `readQuery`/`readFlags` into it. `getPending()` never activates the SQLite path. |
| **C5** | 4 | 32 | **SessionSwitchDeps wiring identified but never implemented.** The plan's own finding says `toSessionSwitchDeps()` and `client-init.ts` need updating, but no task contains the actual code changes. Session history SQLite path is dead code. |
| **C6** | 5 | 42 | **`notifyTurnCompleted` never wired.** Task 42 has a code *comment* explaining how to wire SSE idle → `adapter.notifyTurnCompleted()`, but no actual implementation code. Without this, `sendTurn()` blocks forever waiting for turn completion. |
| **C7** | 6 | 46 | **`PermissionDecision` value mismatch.** Bridge uses `"allow"`/`"deny"` but Phase 5 defines the type as `"once"`/`"always"`/`"reject"`. Will fail type checking. |
| **C8** | 7 | 50.5 | **4 `relay?.messageCache.sessionCount()` call sites in `daemon.ts` not addressed.** Removing `messageCache` from `ProjectRelay` without updating lines 647, 1224, 1487, 1624 will fail type-checking. |
| **C9** | 7 | 50.5 | **`messageCache.flush()` in relay-stack.ts `stop()` method becomes dangling reference** after removing construction. |
| **C10** | 7 | 50.5 | **`sse-wiring.ts:191` calls `messageCache.setOpenCodeUpdatedAt()` directly** — not listed in removal manifest. |
| **C11** | 7 | 53 | **ReadFlags cross-reference is a literal TODO placeholder:** "Task [reference the Phase 4 task that introduces ReadFlags]". |

### Important (will cause incorrect behavior or test failures)

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **I1** | 2 | 10 | **Statistics test wrong expectation.** Test expects `eventsWritten: 1` but implementation produces 2 (synthetic `session.created` + `message.created`). |
| **I2** | 2 | 11 | **No integration tests for `session.updated`/`permission.replied` paths** — exactly the paths broken by C1. |
| **I3** | 3 | 22 | **Recovery test missing `eventId` field.** Task 22 recovery test calls `eventStore.append()` with bare object missing required `eventId`. Will hit SQLite `NOT NULL` constraint. |
| **I4** | 3 | intro | **Phase 3 intro claims "same SQLite transaction"** but implementation uses separate transactions (Option B). Misleading documentation. |
| **I5** | 3 | 22 | **PersistenceLayer modifications use `// ... existing fields ...` placeholders.** The `cursorRepo` field addition is not shown concretely. |
| **I6** | 4 | 27 | **SQLite adapter drops `forkPointTimestamp` and `lastMessageAt` override.** Legacy path uses these for ordering and fork splitting. SQLite adapter omits both → ordering differences and fork rendering degradation. |
| **I7** | 4 | 23 | **Pagination `hasMore` gives false positives.** `hasMore = rows.length >= pageSize` is true when exactly `pageSize` rows exist. Fix: over-fetch by 1. |
| **I8** | 4 | 34 | **`always` field lost in approval adapter.** `pending_approvals` table has no `always` column → SQLite-sourced permissions have empty `always` arrays, degrading "Allow Always" UX. |
| **I9** | 4 | 31 | **Cursor pagination skips duplicate timestamps.** `WHERE created_at < ?` skips messages sharing a timestamp with the cursor. Needs composite cursor (created_at, id). |
| **I10** | 5 | 42 | **relay-stack.ts modifications are prose, not code** — unlike every other task. Ambiguous about shutdown ordering, RelayStack interface changes, exact insertion points. |
| **I11** | 5 | 36 | **`as CanonicalEvent` unsafe assertions in EventSinkImpl** — bypasses discriminated union type checking. Extra `always` field on `PermissionAskedPayload` not in Phase 1 spec. |
| **I12** | 6 | 46 | **`PermissionResponse` has no `message` field** but bridge accesses `decision.message`. |
| **I13** | 6 | 46 | **`PermissionRequest.toolInput` is OpenCode-specific** — typed as `{ patterns: string[]; metadata: Record<string, unknown> }` but Claude needs `Record<string, unknown>`. Missing `sessionId`, `turnId`, `providerItemId` fields. |
| **I14** | 6 | 45 | **`session.provider_changed` not in canonical event type list** but translator emits it. |
| **I15** | 6 | 46 | **Bridge's `canUseTool` prepends `ctx`** — should be a factory method returning exact SDK signature. |
| **I16** | 6 | 47 | **Test injects fake session missing 9/16 required `ClaudeSessionContext` fields.** |
| **I17** | 6 | 50 | **No file path specified for `wireProviders()`.** |
| **I18** | 6 | all | **`as CanonicalEvent` used throughout translator** — loses discriminated union type safety. |
| **I19** | 7 | 50.5 | **`handleGetToolContent` rewrite ownership ambiguous** between Task 50.5 and Task 52. Neither specifies the SQLite read API. |
| **I20** | 7 | 55 | **AGENTS.md replacement wording not specified** for line 18 ("OpenCode is the source of truth..."). |
| **I21** | 7 | 55 | **Mislabels "Key Boundaries" as "Principles"** and misses `architecture.md:25` and `:52`. |

### Low Priority (code quality improvements)

| # | Phase | Task | Finding |
|---|-------|------|---------|
| **L1** | 1 | 1 | `as string` cast on `Map.keys().next().value` — should use guarded access. |
| **L2** | 1 | 6 | `as "accepted" | "rejected"` cast lacks runtime validation (inconsistent with event store approach). |
| **L3** | 1 | 1 | Engine `>=22.5.0` includes versions requiring `--experimental-sqlite` flag (pre-22.13.0). Consider `>=22.13.0`. |
| **L4** | 4 | various | Tests test inline functions, not production code (Tasks 26, 28, 30). |
| **L5** | 4 | 24 | No test for flag=true + readQuery=undefined edge case. |
| **L6** | 6 | 44 | Test fixture uses `session_id: ""` — document how first message gets session ID. |
| **L7** | 7 | 51 | Should note `event-classify.ts` stays — only comment update needed. |
| **L8** | 7 | 54 | 8-consumer line references are stale; use grep-based approach. |
| **L9** | 7 | 51 | Audit `regression-server-cache-pipeline.test.ts` before deleting. |

---

## Ask User Findings

| # | Phase | Task | Question |
|---|-------|------|----------|
| **Q1** | 2 | 12 | **`dualWriteEnabled` default:** Prose says "opt-out" but wiring code is "opt-in". Which is intended? |
| **Q2** | 4 | 27 | **Fork session inherited messages:** Does Phase 3 `MessageProjector` copy parent messages into fork session rows? If not, SQLite history shows only post-fork messages. |
| **Q3** | 4 | 24 | **No runtime flag toggle mechanism.** Plan claims flags are togglable at runtime but no API/command/env mechanism exists. Intended for later? |
| **Q4** | 4 | 24.5 | **`sqliteClient` has no defined origin** (also Critical C3 — needs both fix and design decision). |
| **Q5** | 6 | 45 | **Should v1 support image attachments** via SDK user messages? |
| **Q6** | 6 | 46 | **Bridge's `Promise.race([sinkPromise, localDecision])` double-wires resolution.** Which path is canonical? |
| **Q7** | 6 | 48 | **Concurrent `sendTurn` behavior ambiguous** — should it queue, reject, or cancel the previous turn? |
| **Q8** | 6 | 49 | **`updatedInput` support** — should the adapter handle tool input updates? |
| **Q9** | 7 | 54 | **Option A vs. Option B for SessionStatusPoller** — rewrite or remove? Design decision needed. |
| **Q10** | 7 | various | **"Phase 4e" prerequisite** used but never formally defined — add explicit task numbers. |
| **Q11** | 7 | 51 | **Daemon's low-disk-space handler:** remove entirely when eviction is removed, or replace with event-store eviction? |

---

## Accept Summary

~40 findings across all phases were classified as Accept. These are informational observations, minor style preferences, or issues that are technically correct as-is. See individual phase audit reports for details.

---

## Go/No-Go Assessment

| Phase | Status | Blockers |
|-------|--------|----------|
| **Phase 1** | ✅ Ready | 3 low-priority amendments (won't block execution) |
| **Phase 2** | ❌ Blocked | C1 (dual-write hook placement), I1-I2 (test bugs), Q1 (default behavior) |
| **Phase 3** | ❌ Blocked | C2 (off-by-one in recovery), I3 (missing eventId), I4-I5 (docs/placeholders) |
| **Phase 4** | ❌ Blocked | C3-C5 (wiring gaps), I6-I9 (data loss/degradation), Q2-Q4 (design decisions) |
| **Phase 5** | ❌ Blocked | C6 (sendTurn blocks forever), I10-I11 (prose instructions, type safety) |
| **Phase 6** | ❌ Blocked | C7 (type mismatch), I12-I18 (multiple API/type issues), Q5-Q8 (design decisions) |
| **Phase 7** | ❌ Blocked | C8-C11 (dangling references, TODO placeholder), Q9-Q11 (design decisions) |

**Recommendation:** Hand off to `plan-audit-fixer` to resolve all Amend Plan findings, then re-audit. Ask User findings should be batched and resolved before Phase 2+ implementation begins.
