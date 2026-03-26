# Audit Synthesis: Mock SSE/REST Decoupling

Dispatched 3 auditors across Tasks 1-3 (Task 4 is verification-only).

## Amend Plan (8)

### 1. Wrong event count in Task 1 and Task 3 tests (Critical)
- **Source:** Task 1 Finding #1, Task 3 Findings #1-#3
- The shared FIXTURE puts ALL 5 post-prompt SSE events into segment 1 (the `POST /permission/perm_1/reply` is NOT a segment boundary). Task 1's new test and Task 3's updated "streams SSE events" test both assert 3 events. Should be 5.
- **Fix:** Change all `expect(batchEvents.length).toBe(3)` to `toBe(5)` and add assertions for events [3] and [4].

### 2. Segment interleaving race (Critical)
- **Source:** Task 2 Finding #5
- When `promptsFired === 1`, `emitSegment(0)` and `emitSegment(1)` both fire-and-forget async IIFEs. Events from segments 0 and 1 interleave non-deterministically.
- **Fix:** Concatenate segments 0+1 into a single array before emitting, or `await` segment 0 before starting segment 1.

### 3. `setExactResponse` still creates `sseBatch: []`
- **Source:** Task 1 Finding #3, Task 2 Finding #1
- `setExactResponse` at line 221 constructs `QueuedRestResponse` with `sseBatch: []`. Neither task explicitly calls out updating this method.
- **Fix:** Add explicit step to remove `sseBatch: []` from `setExactResponse`.

### 4. `ensureFallback` creates objects with `sseBatch: []`
- **Source:** Task 2 Finding #2
- `ensureFallback` at line 444 constructs `{ status, responseBody, sseBatch: [] }`.
- **Fix:** Add explicit step to remove `sseBatch: []` from `ensureFallback`.

### 5. `resetQueues()` drops `statusOverride` preservation and connected-client logic
- **Source:** Task 1 Finding #4, Task 2 Finding #4
- Current `resetQueues()` preserves `statusOverride` between tests and keeps `promptFired=true` when SSE clients are connected. Plan's replacement unconditionally resets everything.
- **Fix:** Preserve `statusOverride` (cleared when next prompt_async fires). Conditionally preserve `promptsFired` when `sseClients.size > 0`.

### 6. Non-compiling intermediate commit
- **Source:** Task 1 Finding #2
- Task 1 removes `sseBatch` from `QueuedRestResponse` but Task 2 hasn't updated all references yet. Code won't compile between commits.
- **Fix:** Restructure so Task 1 adds new fields alongside old ones. Task 2 removes old fields. Every commit compiles.

### 7. `injectSSEEvents` plan contradiction
- **Source:** Task 2 Finding #9
- Plan says "keep injectSSEEvents and emitTestEvent unchanged" then shows a changed implementation.
- **Fix:** Clarify: `emitSseBatch` is removed; `injectSSEEvents` is updated to inline the emission logic (the shown code IS the update). Make the plan text consistent.

### 8. `promptFired` references in removed blocks
- **Source:** Task 2 Finding #10
- Step 5 says to remove all `sseBatch` blocks, but those blocks also reference `this.promptFired` (now renamed to `promptsFired`). Need to note these go away entirely.
- **Fix:** Note in Step 5 that the removed blocks contain `this.promptFired` references that are no longer needed.

## Ask User (3)

### 1. `resetQueues()` conditional preservation
Should `resetQueues()` conditionally preserve `promptsFired` when SSE clients are connected?
- **Resolution:** Yes. Match the pattern from current code. Integration tests depend on this.

### 2. `flushPendingSse()` unit test
Should a unit test be added for `flushPendingSse()` with the new segment model?
- **Resolution:** Yes, add a simple test. It's a public method tests depend on.

### 3. Permission reply REST endpoint test
Should there be a test verifying the permission reply REST queue works after the refactor?
- **Resolution:** No separate test needed. Generic REST dequeue tests cover the pattern.

## Accept (11)

- Task 1 #5: `includes("/prompt_async")` is loose but consistent with existing code
- Task 1 #6: Pre-prompt coverage handled by Task 2's multi-turn test
- Task 1 #7: Array access properly guarded with null check
- Task 1 #8: Zero-prompt recordings acknowledged in risk analysis
- Task 2 #6: `sseSegments` undefined guard exists in `emitSegment`
- Task 2 #7: `session.idle` vs `session.status` event types consistent
- Task 2 #8: 5ms delay cap matches existing behavior
- Task 2 #12: No-prompt-async edge case acknowledged
- Task 2 #13: `resetQueues` + `buildQueues` interaction is correct
- Task 3 #4: Event ordering within segment is guaranteed
- Task 3 #7: Timing margins in tests are comfortable

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| Wrong event count (3→5) in Task 1 test | Task 1 Step 1 | Fixed assertion to expect 5 events with full assertions for all 5 |
| Wrong event count (3→5) in Task 3 test | Task 3 Step 1 | Fixed assertion to expect 5 events, increased wait to 200ms |
| Segment interleaving race | Task 2 Steps 3-4 | Renamed `emitSegment` to `emitEvents`, concatenate segments 0+1 into single array before emitting |
| Non-compiling intermediate commit | Task 1 | Added note that Tasks 1+2 are atomic; removed Task 1 commit; single commit at end of Task 3 |
| `setExactResponse` sseBatch reference | Task 2 Step 5 | Explicitly listed as site to update |
| `ensureFallback` sseBatch reference | Task 2 Step 5 | Explicitly listed as site to update |
| `resetQueues()` drops preservation | Task 2 Step 7 | Preserved `statusOverride` and conditional `promptsFired` when SSE clients connected |
| `injectSSEEvents` contradiction | Task 2 Step 9 | Clarified: `emitSseBatch` removed, `injectSSEEvents` updated to use `emitEvents` |
| `promptFired` references in removed blocks | Task 2 Step 5 | Noted that removed blocks contain `this.promptFired` references |
| Missing `flushPendingSse` test | Task 3 Step 3 | Added unit test for `flushPendingSse()` |
| `resetQueues()` conditional preservation (Ask User) | Task 2 Step 7 | Resolved: yes, preserve for integration tests |
| `flushPendingSse` unit test (Ask User) | Task 3 Step 3 | Resolved: yes, added |
| Permission reply REST test (Ask User) | — | Resolved: no separate test needed, generic REST tests cover it |
