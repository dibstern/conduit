# Unified Message Rendering — Plan Audit Synthesis

**Plan:** `docs/plans/2026-03-17-unified-message-rendering.md`
**Auditors dispatched:** 5 (Tasks 1-5)
**Reports received:** 3 (Tasks 3, 4, 5 — Tasks 1 and 2 auditors failed to write reports)

---

## Amend Plan (12 findings)

### Critical (will cause bugs at runtime)

**T3-F11: Race between `clearMessages()` resetting `hasMore=true` and IntersectionObserver**
Same race condition the plan is trying to fix. `clearMessages()` sets `historyState.hasMore = true`. Between that and the events/history branch setting it correctly, the observer can fire a spurious `load_more_history`. Fix: set `hasMore = false` in `clearMessages()` instead of `true`, or set `loading = true` immediately after `clearMessages()` in the handler.

**T5-F1: `chatState.processing` is always `false` when `applyHistoryQueuedFlag` runs**
`clearMessages()` resets `processing = false`. The `status:processing` message arrives as a separate WS message AFTER `session_switched` is fully handled. So `applyHistoryQueuedFlag(chatMsgs, chatState.processing, ...)` always returns unmodified. Fix: move queued-flag application into `handleStatus` so it fires when `processing` transitions to `true`, not at prepend time.

**T3-F3: Auto-scroll `$effect` fights scroll preservation on prepend**
MessageList's existing auto-scroll `$effect` (line 62) fires on `chatState.messages.length` change and calls `scrollToBottom()`. When history is prepended, this effect fires and jumps to bottom, defeating the scroll preservation. Fix: add a guard that skips `scrollToBottom()` when a prepend is detected.

### Important (will cause subtle bugs)

**T3-F2: `historyState.messageCount` not updated for `session_switched` REST fallback**
Only the `history_page` handler increments `messageCount`. The initial REST load via `session_switched` doesn't, so subsequent `load_more_history` sends `offset: 0` → duplicate pages. Fix: also increment in the `session_switched` REST branch.

**T3-F4: `$effect` timing for scroll height capture is fragile**
Two-`$effect` pattern (capture `scrollHeight` in one, restore in another via `tick()`) has Svelte 5 timing concerns. Setting `$state` in one `$effect` to trigger another can cause ordering issues. Fix: use `$effect.pre` for capture (runs before DOM) + `$effect` with `tick()` for restoration.

**T3-F5: `firstUuid` prepend detection false-triggers on message removal**
`handleMessageRemoved` / `handlePartRemoved` can change `messages[0].uuid` without being a prepend. Fix: combine firstUuid change with message count increase check.

**T5-F2: Loss of `$derived` reactivity for queued flag**
Old HistoryView used `$derived` which reactively re-applied the queued flag when `processing` changed. Plan's one-shot approach loses this. Fix: addressed by T5-F1 fix (move to `handleStatus`).

**T4-F1: `HistoryView.stories.ts` not deleted — will break `pnpm check`**
Storybook file imports `HistoryView.svelte`. After deletion, broken import fails build. Fix: add to deletion list.

### Minor (won't cause bugs, cleanup)

**T3-F6: Two contradictory offset strategies in plan snippets**
Plan first uses `historyOffset`, then pivots to `historyState.messageCount`. Implementer may include both. Fix: provide single clean snippet.

**T3-F7: Task 3 modifies files not listed in its file list**
Task 3 also modifies `chat.svelte.ts` and `ws-dispatch.ts`. Fix: update file list.

**T3-F9: Duplicate unused `chatState` import in HistoryLoader**
Fix: remove unused import.

**T3-F10: "Beginning of session" marker for empty sessions**
Empty sessions (neither events nor history) leave `hasMore = true` → marker never shows without observer round-trip. Fix: set `hasMore = false` for empty sessions.

---

## Amend Plan — Cleanup (4 findings from Task 4)

**T4-F2:** `history_reset` type in `shared-types.ts` becomes dead code → remove
**T4-F3:** 3 stale HistoryView comments in `chat.svelte.ts` → update
**T4-F5:** Stale JSDoc in `shared-types.ts:313` → update
**T5-F3:** No test for REST-fallback queued flag timing → add test

---

## Ask User (0 findings)

None.

---

## Accept (8 findings)

T3-F1 (`limit: 50` silently ignored — matches existing behavior), T3-F8 (sentinelEl timing — guarded), T4-F4/F6/F7/F8/F9/F10 (stale comments, cosmetic, redundant mentions), T5-F4 (history_page correctly omits queued flag), T5-F5 (queuedFlagsCleared reset correct).

---

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| T3-F11 (Critical) | Task 1 | `clearMessages()` now resets `historyState.hasMore = false` (not `true`). Observer is disarmed by default. |
| T5-F1 (Critical) | Task 5 | Replaced one-shot `applyHistoryQueuedFlag` with reactive `applyQueuedFlagInPlace()` called from `handleStatus`. |
| T3-F3 (Critical) | Task 3 | Added `awaitingPrepend` guard to auto-scroll `$effect` to skip `scrollToBottom()` during prepend. |
| T3-F2 | Task 2 | Added `historyState.messageCount = msg.history.messages.length` to `session_switched` REST branch. |
| T3-F4 | Task 3 | Changed scroll capture to use `$effect.pre` (runs before DOM update) instead of regular `$effect`. |
| T3-F5 | Task 3 | Prepend detection now requires BOTH `firstUuid` change AND message count increase. |
| T4-F1 | Task 4 | Added `HistoryView.stories.ts` to deletion list. |
| T3-F6 | Task 3 | Removed contradictory `historyOffset` approach. Single clean HistoryLoader snippet. |
| T3-F7 | Task 1, 3 | Moved `messageCount` to Task 1's `historyState` definition. Updated Task 3 file list. |
| T3-F9 | Task 3 | Removed unused `chatState` import from HistoryLoader. |
| T3-F10 | Task 1 | Handled by `hasMore = false` default — empty sessions show "Beginning of session" immediately. |
| T4-F2 | Task 4 | Added step to remove `history_reset` from `RelayMessage` type in `shared-types.ts`. |
| T4-F3 | Task 4 | Added step to update 3 stale HistoryView comments in `chat.svelte.ts`. |
| T4-F5 | Task 4 | Added step to update stale JSDoc on `session_switched.history` in `shared-types.ts`. |
| T5-F2 | Task 5 | Addressed by T5-F1 fix — `handleStatus` provides reactive queued-flag application. |
| T5-F3 | Task 5 | Added tests for REST-fallback queued flag timing (apply + clear). |

## Verdict

All 12 Amend Plan findings resolved. Ready for re-audit.
