# Cache Staleness Fix — Audit Synthesis

Dispatched 3 auditors across 3 tasks.

## Amend Plan (10)

### Task 1

1. **Test `result` events missing required fields** — `{ type: "result", cost: 0.01 }` won't compile; needs `usage`, `duration`, `sessionId`.
   → Fix test data to include all required fields or omit `result` events from test data.

2. **"Cache matches" test will fail** — `delta` events in test data lack `messageId`, so `countUniqueMessages` returns 1 not 2.
   → Add `messageId` to delta events in test data, or adjust the mock return value.

3. **`messageId` is optional on SSE-path events** — SSE events may lack `messageId`, causing undercounting.
   → Document as a conservative heuristic; consider fallback counting `user_message` + `result` events when no `messageId` found.

4. **Wrong wiring sites** — Plan says relay-stack but deps are constructed in `session.ts:toSessionSwitchDeps()` and `client-init.ts`.
   → Update Step 5 to reference correct files.

5. **Unsafe type assertion in tests** — `(deps as Record<string, unknown>).client` bypasses type safety.
   → Use `createMinimalDeps` overrides parameter with properly typed `client`.

6. **`resolveSessionHistory` signature change affects all callers** — existing tests need `client` in deps.
   → Note that existing tests hit graceful degradation path; verify they still pass.

7. **Missing test for user-message-only sessions** — realistic edge case untested.
   → Add at least one test for single user message with no assistant response.

### Task 2

8. **Missing test for undefined `statusPoller`** — valid runtime scenario per optional type.
   → Add test case verifying `done` is injected when `statusPoller` is undefined.

### Task 3

9. **`vi` not imported** — Plan claims it's at line 15 but it's not in the import list.
   → Explicitly add `vi` to the vitest import.

10. **Dynamic `import()` unnecessary** — Use static top-level import instead.
    → Replace with `import { resolveSessionHistory } from "..."`.

11. **`countUniqueMessages` count not independently verified** — test could pass even if count logic is wrong.
    → Add `expect(countUniqueMessages(events)).toBe(2)` assertion.

## Ask User (1)

12. **Task 3 mixes abstraction levels** — The regression test file tests the SSE→cache pipeline, but the replacement test calls `resolveSessionHistory` directly. Task 1 already adds comprehensive `resolveSessionHistory` tests in `session-switch.test.ts`.
    → **Decision needed:** Should the regression test stay in `regression-server-cache-pipeline.test.ts` (mixing abstractions), move to `session-switch.test.ts` (cleaner separation), or be rewritten as a pure pipeline-level test that asserts cache contents + `countUniqueMessages` output without calling `resolveSessionHistory`?

## Accept (6)

- Task 1: `result` has `sessionId` not `messageId` — already handled correctly
- Task 1: TOCTOU race is standard and harmless
- Task 2: False-idle race on daemon restart — pre-existing, mitigated by live status message
- Task 2: Frontend replay confirmed to depend on `done` for tool finalization
- Task 2: `{ type: "done", code: 0 }` matches `RelayMessage` union exactly
- Task 3: Inline mock deps acceptable for focused regression test
- Task 3: `makePartDelta` hardcoding `messageID: "msg1"` fine for single-turn test

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| 1. Test `result` events missing fields | Task 1 | Removed `result` events from test data entirely — they don't carry `messageId` and don't contribute to the count |
| 2. "Cache matches" test count mismatch | Task 1 | Added `messageId: "msg_asst1"` to delta in test data; count now correctly = 2 |
| 3. `messageId` optionality | Background | Added "messageId field on relay events" section documenting the heuristic |
| 4. Wrong wiring sites | Task 1 | Step 5 → Step 6, now references `session.ts:toSessionSwitchDeps()` and `client-init.ts` |
| 5. Unsafe type assertions | Task 1 | Tests use `createMinimalDeps` overrides with properly typed `client` |
| 6. Existing callers need `client` | Task 1 | Added NOTE about existing tests hitting graceful degradation path |
| 7. Missing user-message-only test | Task 1 | Added "uses cache for user-message-only session" test |
| 8. Missing undefined statusPoller test | Task 2 | Added "appends synthetic done when statusPoller is undefined" test |
| 9. `vi` not imported | Task 3 | Explicit instruction to add `vi` to vitest import |
| 10. Dynamic import unnecessary | Task 3 | Replaced with static top-level import |
| 11. Count not independently verified | Task 3 | Added `expect(countUniqueMessages(events!)).toBe(2)` assertion |
| 12. Task 3 abstraction mixing (Ask User) | Task 3 | User chose Option 1: keep end-to-end in regression file, minimize mocking (use real cache) |
| — | Task 1 | `countUniqueMessages` uses `"messageId" in e` for type-safe access instead of `as Record<string, unknown>` |
