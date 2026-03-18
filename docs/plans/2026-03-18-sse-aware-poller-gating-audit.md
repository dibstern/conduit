# SSE-Aware Monitoring Reducer — Plan Audit Synthesis

**Date:** 2026-03-18
**Plan:** `docs/plans/2026-03-18-sse-aware-poller-gating-plan.md`
**Auditors dispatched:** 8 (covering all 14 tasks)

---

## Amend Plan (14 findings)

### Critical Bugs

1. **Task 12: `changed` event fires only on status changes, not every poll cycle.**
   The reducer is wired to `statusPoller.on("changed")`, but `changed` only fires when statuses *differ*. A session stuck in `busy-grace` with unchanged busy status will never trigger the reducer again — grace period can never expire, poller will never start.
   → **Fix:** Task 11 must change `SessionStatusPoller` to emit statuses on every poll cycle (rename to a `poll-cycle` event), OR add a separate interval that calls `evaluateAll` unconditionally.

2. **Task 5: Safety cap double-counts new pollers.**
   `existingPollers` counts sessions already in `busy-polling` phase (which includes sessions that just transitioned), and `startEffects.length` counts the same transitions again. Cap triggers at half threshold.
   → **Fix:** Count only sessions that were ALREADY in `busy-polling` in the previous state (not the new state), then add new `start-poller` effects.

3. **Task 5: Revert phase uses hardcoded `busySince: 0`.**
   When safety cap drops a start-poller, it reverts the phase to `{ phase: "busy-grace", busySince: 0 }`. This means grace is always expired on the next cycle, causing immediate re-escalation — infinite loop.
   → **Fix:** Preserve original `busySince` from the current state, or use a dedicated `busy-capped` phase.

4. **Tasks 10-11: Compilation breaks before Task 12.**
   Task 10 removes `emitDone` from MessagePollerManager and Task 11 removes `became_busy`/`became_idle` events, but relay-stack.ts still references them until Task 12. `pnpm check` will fail.
   → **Fix:** Reorder tasks so relay-stack wiring (Task 12) happens BEFORE simplifying MessagePollerManager (Task 10) and SessionStatusPoller (Task 11). Or merge Tasks 10-12 into a single task.

### Code Issues

5. **Task 4: Unused `SSECoverage` import in implementation.**
   The code imports `SSECoverage` type but only uses it implicitly via `deriveSSECoverage`. Biome `noUnusedImports` will fail `pnpm lint`.
   → **Fix:** Remove `SSECoverage` from the import, or use it as a type annotation on the `sse` variable.

6. **Task 4: Dead `no-sse-history` reason.**
   Declared in `POLLER_START_REASONS` but never produced by `evaluateSession`. Unreachable dead code.
   → **Fix:** Either remove from the reasons array or produce it in the appropriate transition (e.g., grace expired with `never-seen` SSE could use it instead of `sse-grace-expired`).

7. **Task 5: Safety cap priority ordering not implemented.**
   Design doc says to prefer parents over subagents, prefer `sse-disconnected` over `sse-grace-expired`. Implementation just keeps "the first N" by arbitrary Map iteration order.
   → **Fix:** Sort `startEffects` by priority before truncating, or defer sorting to a follow-up.

8. **Task 6-8: Echo entries never consumed.**
   `classifyPollerBatch` uses `has()` to identify echoes but `consumeIfPending()` is only called on non-echo events. Echo entries linger for 30s TTL and could falsely suppress later identical messages.
   → **Fix:** The executor must call `consume()` on suppressed echoes, not `consumeIfPending()` on passed-through events.

9. **Task 9: Missing `.catch()` on `start-poller` async call.**
   Existing code has explicit `.catch()` when `client.getMessages()` fails. Plan omits it.
   → **Fix:** Add `.catch()` with warning log to the `start-poller` executor.

10. **Task 9: `sendPushForEvent` not in deps interface.**
    The `notify-idle` executor needs to call `sendPushForEvent` but it's not listed in `MonitoringEffectDeps`.
    → **Fix:** Add `sendPushForEvent` import or include it in deps.

### Missing Details

11. **Task 4: Missing test cases** — grace expiry boundary (`===` threshold should stay in grace) and `busy-grace` + grace expired + SSE stale.

12. **Task 10-11: Missing test enumerations** — plan should list specific test blocks to delete/update for `emitDone`, capacity tests, and `notifySSEIdle` test refactoring.

13. **Task 12: Missing `pollerGatingConfig` and `effectDeps` construction** — pseudocode uses them but no step creates them.

14. **Task 13: Missing `message-poller.test.ts`** — `emitDone` test block at line 881-909 needs deletion.

---

## Ask User (4 findings)

1. **Task 5: What phase for safety-cap-dropped sessions?**
   When the cap drops a `start-poller` effect, what phase should the session revert to? Options:
   - New `busy-capped` phase (explicit, prevents retry loop)
   - Reset `busy-grace` with fresh `busySince` (retries after new grace period)
   - Keep `busy-sse-covered` and hope SSE recovers (incorrect if SSE is down)

2. **Task 5: Should deleted busy sessions (non-polling) emit `notify-idle`?**
   Sessions deleted while in `busy-grace` or `busy-sse-covered` silently disappear. Should they emit a `notify-idle` so browser clients get a `done` event?

3. **Task 6: Subagent notification scope change.**
   Plan suppresses ALL notification types for subagent sessions. Existing code only suppresses `done` from subagents — subagent `error` events currently get push notifications. Keep existing behavior or apply broader suppression?

4. **Task 6: Push notification type scope.**
   Plan gates push on `isNotificationWorthy()` (done, error only). Existing code via `sendPushForEvent()` also pushes `permission_request` and `ask_user`. Narrowing this loses push for permission/question events from polled sessions.

---

## Accept (11 findings)

- `busySince` preservation across transitions: correct
- `retry` status handling: correct
- Exhaustiveness check: correct
- `as const` assertions: unnecessary but harmless
- `rebuildTranslatorFromHistory` preserved correctly in session_lifecycle
- Deletion cleanup timing gap (≤500ms) is acceptable
- Async overlap on `monitoringState` is pre-existing pattern
- `registry.hasViewers` vs `pollerManager.hasViewers`: correctly uses registry
- `status-transitions.test.ts` tests only removed functions — safe to delete entirely
- `Pick<>` types all verified against actual method signatures
- `PipelineDeps` type compatibility confirmed

---

## Amendments Applied

All 14 Amend Plan findings and all 4 Ask User findings (answered by the user) have been resolved.

| # | Finding | Source | Amendment |
|---|---------|--------|-----------|
| **Critical Bugs** | | | |
| 1 | `changed` event fires only on status changes | Task 12 (now 12) | Task 12 Step 2: changed `poll()` to always emit statuses on every cycle, removing `hasChanged` gate. Design doc Section 7 and Appendix updated. |
| 2 | Safety cap double-counts new pollers | Task 5 | Replaced cap logic: count sessions in PREVIOUS state that remain `busy-polling`, then add new `start-poller` effects. |
| 3 | Revert phase uses hardcoded `busySince: 0` | Task 5 | Added `busy-capped` phase. Dropped starts set `busy-capped` preserving original `busySince` and setting `cappedAt: now`. |
| 4 | Compilation breaks (Tasks 10-11 before 12) | Tasks 10-12 | Reordered: Task 10 = Wire Reducer (old 12), Task 11 = Simplify PollerManager (old 10), Task 12 = Simplify StatusPoller (old 11). |
| **Code Issues** | | | |
| 5 | Unused `SSECoverage` import | Task 4 | Split import; annotated `const sse: SSECoverage = deriveSSECoverage(...)`. |
| 6 | Dead `no-sse-history` reason | Task 4 | Used `no-sse-history` for `sse.kind === "never-seen"` in busy-grace expiry. `sse-grace-expired` kept for `sse.kind === "stale"`. Updated test and design doc transition table. |
| 7 | Safety cap priority ordering not implemented | Task 5 | Acknowledged — deferred to follow-up (arbitrary iteration order kept for now; safety cap is a circuit breaker, not normal operation). |
| 8 | Echo entries never consumed | Tasks 6-8 | Removed `has()` addition. Echo suppression stays inline with `consume()` in executor loop. `classifyPollerBatch` simplified to only classify content activity. |
| 9 | Missing `.catch()` on start-poller | Task 9 | Added `.catch()` with warning log to `client.getMessages()` call in start-poller executor. |
| 10 | `sendPushForEvent` not in deps | Task 9 | Added `sendPushForEvent` to `MonitoringEffectDeps` interface. Updated design doc Section 7. |
| **Missing Details** | | | |
| 11 | Missing test cases (grace boundary, stale SSE) | Task 4 | Added test for grace expiry exact boundary (`>` not `>=`) and `busy-grace + grace expired + SSE stale`. |
| 12 | Missing test block enumerations | Tasks 11-12 | Listed specific test blocks to delete: `message-poller-manager.test.ts:158-167`, `:59/:78/:91`, `message-poller.test.ts:881-909`. Added `notifySSEIdle` refactoring note. |
| 13 | Missing config/deps construction | Task 10 | Added Step 2 with explicit `pollerGatingConfig` and `effectDeps` construction code. Updated design doc pseudocode. |
| 14 | Missing `message-poller.test.ts` in cleanup | Task 13 | Added `message-poller.test.ts` to file list with line range for `emitDone` block deletion. |
| **Ask User (answered)** | | | |
| AU-1 | Phase for safety-cap-dropped sessions | Task 1, 4, 5 | New `busy-capped` phase added to `SessionMonitorPhase`, with transitions in `evaluateSession` and promotion logic in `evaluateAll`. Design doc Sections 1, 5, 6 updated. |
| AU-2 | Deleted busy sessions emit `notify-idle` | Task 5 | `evaluateAll` now emits `notify-idle` for ANY deleted busy-phase session, plus `stop-poller` if it was `busy-polling`. |
| AU-3 | Subagent notification scope | Task 6 | Only suppress `done` for subagent sessions, not all types. Subagent errors still fire push. Updated tests, implementation, and design doc Section 10. |
| AU-4 | Push notification type scope | Task 6, 9 | Use `sendPushForEvent` (done, error, permission_request, ask_user) instead of `isNotificationWorthy` (done, error only). Added to deps interface. |
| **Verification** | | | |
| P | Fix vitest grep command | Task 14 | Replaced `--grep "relay"` with `test/unit/relay/ test/unit/session/`. |
