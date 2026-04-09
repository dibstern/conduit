# Audit Synthesis: Orchestrator Concurrency Hardening

> Dispatched 5 auditors across 5 tasks.

## Amend Plan (8)

| Task | Finding | Issue | Fix |
|------|---------|-------|-----|
| 1 | F1, F6 | `onSSEEventWithEpoch()` has no current callers; plan doesn't document `rehydrationGen` interaction | Add documentation note explaining epoch vs rehydrationGen coverage |
| 1 | F11, F12 | Two test files in the orchestrator plan still call `resetTranslator()` | Add to Files section: update Task 11 and Task 12 tests |
| 2 | F3 | try/catch around `projectEvent()` is redundant — `projectEvent()` already catches per-projector errors | Fix comment to say "catches infrastructure failures", remove double-counting risk |
| 2 | F5 | Error resilience test closes entire DB — should test a specific projector failure | Add a projector-failure test case |
| 3 | F3 | No integration-level test through `ProjectionRunner.recover()` → `syncAllCursors()` | Add ProjectionRunner-level test |
| 4 | F1 | `recover()` has no production call site in either plan | Add explicit `recover()` call in relay-stack wiring |
| 4 | F2 | Warning message lacks actionable guidance | Improve message text |
| 5 | F2 | "Add to Task 34 notes" is vague — doesn't name file or clarify Phase 7 scope | Specify exact file and insertion point |

## Ask User (2)

| Task | Finding | Question |
|------|---------|----------|
| 1 | F4 | Is `onSSEEventWithEpoch()` forward-looking (for future rehydration→event-store integration) or purely defensive? If forward-looking, drop it until the integration exists. |
| 4 | F3 | Should pre-recovery `projectEvent()` be a hard error or a warning? |

## Accept (16)

Minor/informational findings across all 5 tasks — no action needed.
