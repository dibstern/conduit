# Session Switch Jank & Manifest Icons — Audit Synthesis

Dispatched 6 auditors across 6 tasks. Individual reports in `docs/plans/audits/session-switch-jank-task-{1-6}.md`.

## Amend Plan (16 findings)

### Cross-cutting: handleMessage must stay synchronous (Tasks 3, 5, 6)
Multiple auditors flagged the unresolved `handleMessage` async/sync decision. Making `handleMessage` async creates concurrent message processing hazards (live events interleave with replay during yields). **Decision: keep `handleMessage` synchronous. Fire-and-forget `replayEvents()` with `.catch()`.** This avoids:
- Concurrent message processing
- Unhandled promise rejections at `ws.svelte.ts:289-293`
- The entire class of "live messages during replay" bugs

But introduces: the replay completes after `handleMessage` returns. Code after `replayEvents()` in the `session_switched` case runs before replay finishes. The `inputText` sync is independent (fine), but tests must await replay completion.

### Task 1: Vite plugin uses wrong approach
- **T1-F1**: PublicDir files are NOT content-hashed. Only `apple-touch-icon.png` has a hashed copy (referenced from HTML). The other two icons only exist at the build root. Plugin should simply strip `/static/` prefix → `icon.src.replace(/^\/static\//, "/")`.
- **T1-F2**: Hash-stripping regex fails on base64url chars (moot with simpler approach).
- **T1-F4**: Dead code in imageMap (moot with simpler approach).

### Task 2: Missing mutation sites
- **T2-F1**: `addSystemMessage` not refactored — called by `handleError` during replay, bypasses batch.
- **T2-F2**: `registry.finalizeAll(chatState.messages)` in `handleDone` reads stale pre-batch array. Must use `getMessages()`.
- **T2-F3**: ws-dispatch.ts `findMessage`/`tool_result` change is premature — belongs in Task 3. Remove from Task 2.
- **T2-F6**: Missing test for `handleError`/`addSystemMessage` during batch.
- **T2-F7**: Missing test for `clearMessages` called mid-batch.

### Task 3: Abort path bugs + test breakage
- **T3-F11/F12**: `chatState.replaying` never cleared on abort (generation mismatch returns without setting false). Fix: add `chatState.replaying = false` to `clearMessages()`.
- **T3-F4/F5**: 4 test files (~50 tests) will definitely break. Must update in Task 3, not defer to Task 6.
- **T3-F8**: Rapid-replay test should document `clearMessages` as required prerequisite.

### Task 4: Session-switch-during-deferred-render + typing bugs
- **T4-F1 (Critical)**: Stale deferred renders corrupt new session's messages. Need generation guard + abort on `clearMessages()`.
- **T4-F2**: `needsRender: undefined` violates `exactOptionalPropertyTypes`. Must use spread-omit pattern.
- **T4-F3**: Conditional spread `...(!chatState.replaying ? {} : { needsRender: true })` needs compile verification.
- **T4-F6**: No test for double-call idempotency of `renderDeferredMarkdown`.
- **T4-F8**: Pre-computed indices go stale if messages change between batches. Must re-scan per batch.

### Task 5: Wrong abort mechanism + missing tests
- **T5-F1**: `replayGeneration` is semantically wrong for `history_page` loads. Mitigation: `historyState.loading` prevents concurrent loads. Plan must document this invariant explicitly.
- **T5-F2**: Existing `history_page` tests will break (same async issue as Task 3).
- **T5-F3**: Zero tests for `convertHistoryAsync`. Need equivalence, abort, and loading-state tests.
- **T5-F4**: Task 5 assumes `handleMessage` is async — must use fire-and-forget approach instead.

### Task 6: Underestimated test breakage
- **T6-F1-5**: Plan must enumerate all 4 affected test files with specific guidance, not just "if tests fail". Replace misleading `vi.advanceTimersByTime()` claim.

## Ask User (3 findings)

- **T1-F6**: No automated test for Vite plugin. Is manual build verification sufficient?
- **T3-F9**: `REPLAY_CHUNK_SIZE = 80` — is this calibrated? Should we profile or just pick a reasonable default?
- **T6-F10**: Live messages arriving during async replay — with fire-and-forget, live `delta`/`status` events hit `chatState.messages` directly while replay batch is in-flight. The batch commit overwrites any live mutations. Need decision: is this acceptable (replay covers full session so live events are redundant), or do we need a queue?

## Accept (14 findings)

- T1-F3: PublicDir manifest root copy not rewritten (hashed copy is what matters)
- T1-F5: Verification step doesn't check file existence
- T2-F4: handlePartRemoved/handleMessageRemoved bypass batch (live-only, safe)
- T2-F5: clearMessages discards batch correctly
- T2-F8: No interleaved batch/live test (no concurrency in sync Task 2)
- T2-F9: Streaming state fields work alongside batch
- T2-F10: findMessage works with batch arrays
- T2-F11: No exactOptionalPropertyTypes violations in batch infrastructure
- T3-F3: Post-replay operations ordering is correct under both approaches
- T3-F6: Exporting getMessages creates minor asymmetry (not a bug)
- T3-F7: Exact-multiple chunk boundary is correct
- T3-F10: setTimeout(0) yield is standard
- T4-F4: requestIdleCallback untested (falls through to setTimeout in Node)
- T4-F5: C1 guard works correctly with raw text
- T4-F7: Already-rendered messages filtered correctly
- T4-F9: Test mock interception works correctly
- T5-F6: Chunk size magic numbers (minor, add comments)
- T6-F8: cache-replay-contract.test.ts only references replayEvents in comments

Handing off to plan-audit-fixer to resolve Amend Plan and Ask User findings.
