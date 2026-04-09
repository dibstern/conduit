# Consistency & Divergence Detection — Plan Audit Synthesis

> Audited: `docs/plans/2026-04-08-consistency-divergence-detection.md`
> Auditors dispatched: 3 (Tasks 1-3, Tasks 4-7, Tasks 8-12)
> Reports: `docs/plans/audits/consistency-divergence-tasks-{1-3,4-7}.md`

## Summary

**4 Critical**, **2 Important**, **4 Accept** findings. All Critical and Important findings have been **resolved inline** in the plan.

## Critical Findings (all resolved)

| ID | Task | Finding | Resolution |
|----|------|---------|------------|
| C1 | 1 | **Truthy string bug**: `if (flags.toolContent)` is truthy for `"legacy"` (non-empty string). All parent plan Phase 4 handlers would unconditionally take the SQLite path. | Added `isActive(mode)`, `isSqlite(mode)`, `isShadow(mode)` helpers to `read-flags.ts`. Documented that all parent plan Tasks 25-34 must use these instead of truthy checks. |
| C2 | 2 | **Stale mode capture**: `ShadowReadComparator` stored `mode` as a readonly config field. Circuit breaker trips are invisible to the comparator. | Changed `mode` to `getMode: () => ReadFlagMode` getter. Comparator reads mode dynamically on every `.read()` call. All test code updated. |
| C3 | 4-7,12 | **Dead code — no wiring**: Comparators defined but never constructed or passed to handlers. Task 12 only created breakers, not comparators. | Expanded Task 12 with explicit per-sub-phase comparator construction, `HandlerDeps.comparators` field, and wiring into SessionManager/Poller. |
| C4 | 2 | **Uncaught sqliteFn() throw**: In shadow mode, a throwing `sqliteFn()` crashes the request handler. | Wrapped `sqliteFn()` in try/catch in shadow mode. Logs error, increments `comparisonErrors`, returns legacy result. |

## Important Findings (all resolved)

| ID | Task | Finding | Resolution |
|----|------|---------|------------|
| I2 | 6 | Session history comparator only checked `text` on latest message. Missing role distribution check. | Added role-count comparison (`role-count-user`, `role-count-assistant` diffs). Intentionally skips deep `parts` comparison (too expensive for fire-and-forget). |
| I3 | 7 | Pending approvals comparator skipped `toolName` field. | Added `toolName` mismatch detection. |

## Accept Findings (no action needed)

| ID | Task | Finding | Notes |
|----|------|---------|-------|
| A1 | 1 | `true → "sqlite"` backward compat bypasses shadow. | Intentional — for existing boolean configs. New deployments use mode strings. |
| A2 | 4-7 | Tests use `setTimeout(r, 10)` for background comparison assertions. | Fragile but acceptable for unit tests. Background comparisons are fire-and-forget by design. |
| A3 | 9 | Sequence gap detection unnecessary — AUTOINCREMENT can't gap without DELETE. | Replaced with simpler `eventCount === maxSequence` consistency check (I6). |
| A4 | 10 | `DualWriteAuditor.audit()` caller not shown. | Resolved in expanded Task 12 — periodic timer builds `RelaySnapshot` from relay state. |

## Parent Plan Amendments Required

The following changes to `docs/plans/2026-04-05-orchestrator-implementation-plan.md` are **required** when this plan is executed:

1. **Tasks 25-34**: Replace all `if (this.readFlags?.sessionList && ...)` checks with `if (isActive(this.readFlags?.sessionList) && ...)`. Import `isActive` from `read-flags.ts`.
2. **Task 24**: `ReadFlags` interface changes from `boolean` fields to `ReadFlagMode` fields. All code that passes `true`/`false` must pass `"sqlite"`/`"legacy"` instead.
3. **Task 24.5**: HandlerDeps interface gains a `comparators` field.
4. **Task 28**: `compareWithLegacyListInBackground` is removed — replaced by `ShadowReadComparator`.
