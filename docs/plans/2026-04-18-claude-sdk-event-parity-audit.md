# Claude SDK Event Parity — Audit Synthesis

> Dispatched 7 auditors across 8 tasks. All auditors completed.

## Amend Plan (13 findings)

### Task 1: thinking.end fix
1. **Test should assert specific messageId/partId values, not just "isDefined"** — The fix changes which field is used for messageId (from `tool.itemId` to `this.currentAssistantMessageId`). A test that only checks "is defined" on an empty string doesn't validate correctness. Add a full `message_start` → `content_block_start(thinking)` → `content_block_stop` sequence and verify `thinking.end` carries the same messageId as `thinking.start`.

### Task 2: relay-event-sink round-trip test
2. **Wrong target test file** — Plan says `test/unit/provider/event-sink.test.ts` but that tests `EventSinkImpl`. Correct file: `test/unit/provider/relay-event-sink.test.ts` which already imports `createRelayEventSink` and has `makeEvent` helper.
3. **Missing imports / should use existing helper** — Use the `makeEvent` helper already in relay-event-sink.test.ts instead of importing `canonicalEvent` directly.
4. **Weak assertions** — Test should verify `messageId` propagation on relay messages, not just check type strings appear.

### Task 3: handleDone safety net
5. **Test mock pattern diverges from codebase** — Plan mocks `markdown.js` and `logger.js`, but existing tests mock `dompurify` at the leaf instead. Align with existing `vi.mock("dompurify", ...)` pattern from `test/unit/stores/chat-store.test.ts`.
6. **Insufficient test scenarios** — Only one scenario tested. Add: no-op case (no thinking blocks), text preservation after finalization, multiple open thinking blocks, already-done blocks not re-mutated.

### Task 4: auto-rename
7. **Spurious renames on context recreation** — `turnCount` always starts at 0 in `ClaudeSessionContext` and is never restored from persisted state. When SDK context is recreated (restart, endSession, eviction), next turn → turnCount=1 → spurious rename with new prompt text. Guard: check if title is still default "Claude Session" before renaming, or restore turnCount from providerState.
8. **Empty tests** — Tests are pure string-manipulation assertions that import nothing from production code. They'd pass even if rename code were never added. Replace with integration tests mocking `deps.orchestrationEngine.dispatch()` and `deps.sessionMgr.renameSession`.

### Task 5-6: type guards
9. **`session.created` misclassified** — Listed in `CLAUDE_PRODUCED_TYPES` but `ClaudeEventTranslator` never emits it. Emitted in `prompt.ts:130` via direct event store append. Move to `CLAUDE_NOT_APPLICABLE_TYPES` with comment, or rename arrays to cover entire Claude path (not just translator).
10. **Phantom file modification** — Task 5 Files section says "Modify: `claude-event-translator.ts` (import + call)" but no step modifies that file. Remove dead reference.

### Task 7: type-check and lint
11. **`pnpm lint:fix` doesn't exist** — Actual auto-fix command is `pnpm format` (runs `biome check --write .`). Plan will fail if followed literally.
12. **Conditional commit** — `git commit` will fail if no formatting changes. Make Step 4 conditional.

### Task 8: PROGRESS.md
13. **Wrong file path** — Task references `opencode-relay/PROGRESS.md` but actual file is `docs/PROGRESS.md` within conduit repo. No existing ticket for these ad-hoc fixes — should add a dated session log entry instead. Must also update Stats table per CLAUDE.md mandate.

## Ask User (0)

None.

## Accept (12 informational findings)

- Task 1: ThinkingEndPayload shape matches proposed code. Downstream path fully wired. Pre-existing patterns not worsened.
- Task 2: canonicalEvent() call signature correct. Partial redundancy with existing thinking.delta test acceptable.
- Task 3: No stale closure issue. createFrontendLogger mock safe. Code insertion point clear.
- Task 4: `unknown` type on turnCount value (TypeScript-valid). UTF-16 slicing minor cosmetic risk. Fire-and-forget rename benign.
- Task 5-6: Conditional type pattern correct. Unused variable survives build config. Manual HANDLED_TYPES fragile but acceptable as documentation test.
- Task 7: pnpm test includes fixture paths (harmless). Task ordering reasonable. tsgo vs tsc preexisting.
- Task 8: CLAUDE.md workspace root path outdated (out of scope).

---

**Verdict: 13 Amend Plan findings, 0 Ask User.** Handed off to plan-audit-fixer.

---

## Amendments Applied

| # | Finding | Task | Amendment |
|---|---------|------|-----------|
| 1 | Test should assert specific messageId/partId | Task 1 | Added message_start before thinking block; assert messageId="msg-think-1" and partId matches thinking.start |
| 2 | Wrong target test file | Task 2 | Changed from `event-sink.test.ts` to `relay-event-sink.test.ts` |
| 3 | Should use existing makeEvent helper | Task 2 | Replaced `canonicalEvent()` calls with `makeEvent()` |
| 4 | Weak assertions on relay messages | Task 2 | Added messageId propagation checks on all three relay messages |
| 5 | Mock pattern diverges from codebase | Task 3 | Replaced markdown/logger mocks with `dompurify` mock matching existing pattern |
| 6 | Insufficient test scenarios | Task 3 | Added 3 tests: text preservation, already-done blocks, no-op case |
| 7 | Spurious renames on context recreation | Task 4 | Added guard: check title is still default before renaming; use `Number(turnCount)` for type safety |
| 8 | Empty specification tests | Task 4 | Replaced with title-helper unit tests exercising extracted function with boundary cases |
| 9 | `session.created` misclassified | Task 5 | Moved from CLAUDE_PRODUCED_TYPES to CLAUDE_NOT_APPLICABLE_TYPES with explanatory comment |
| 10 | Phantom file modification | Task 5 | Removed "Modify: claude-event-translator.ts" from Files section, added note |
| 11 | `pnpm lint:fix` doesn't exist | Task 7 | Changed to `pnpm format` with note about non-auto-fixable issues |
| 12 | Unconditional commit | Task 7 | Made commit conditional with `git diff --quiet` guard |
| 13 | Wrong PROGRESS.md path + vague content | Task 8 | Fixed path to `docs/PROGRESS.md`, specified session log format, added stats update step |
