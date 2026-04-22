# Tool Input Rendering Plan — Audit Synthesis

**Date:** 2026-04-22
**Plan:** `docs/plans/2026-04-22-tool-input-rendering-plan.md`
**Auditors dispatched:** 8 (covering all 17 tasks)
**Auditors with structured reports:** 3 of 8 (Tasks 1-2, Tasks 9-10, Task 11)
**Supplemental analysis:** Controller reviewed gaps from auditors that exhausted research turns without producing findings (Tasks 3-8, 12-17).

---

## Amend Plan (9 findings)

### Tasks 9-10 (Phase 2 — Buffering + Deletion)

**AP-1: Task 9 test `makeCtx()` missing required `ClaudeSessionContext` fields.**
The plan's `makeCtx()` returns 5 fields, but `ClaudeSessionContext` requires ~16 fields including `workspaceRoot`, `startedAt`, `promptQueue`, `query`, `pendingApprovals`, `pendingQuestions`, `eventSink`, `streamConsumer`, `currentTurnId`, `turnCount`, `stopped`. The test will fail TypeScript checking.
**Fix:** Match the pattern in `test/unit/provider/claude/claude-event-translator.test.ts:30-62`.

**AP-2: Task 9 `handleBlockStop` calls `normalizeToolInput` which depends on Tasks 4+6.**
The plan says Phase 2 "can land in parallel with Phase 1" (from design doc) but the implementation code hard-codes `normalizeToolInput(tool.toolName, finalInput)`. If Task 9 is attempted before Tasks 4+6, it won't compile.
**Fix:** Add explicit prerequisite note: "Tasks 4+6 must land before Task 9."

**AP-3: Stream interruption leaves `pendingStart: true` tool in `inFlightTools`.**
`claude-adapter.ts` `cleanupSession` emits `tool.completed` for every in-flight tool. After buffering, a `pendingStart: true` tool gets `tool.completed` without a preceding `tool.started`. Downstream consumers may behave unexpectedly.
**Fix:** In Task 9, add handling in `cleanupSession`: if `tool.pendingStart`, emit `tool.started` first (with partial input) before `tool.completed`. Add a test case for stream-interruption-during-buffering.

**AP-4: Task 10 misses 4 additional files referencing `tool.input_updated`.**
Codebase grep confirms these files also reference the deleted type:
1. `src/lib/provider/claude/event-type-guard.ts:26` — `CLAUDE_PRODUCED_TYPES` (**compile blocker**)
2. `test/unit/provider/claude/claude-event-translator.test.ts:375-413` — test assertions
3. `test/unit/persistence/events.test.ts:27` — reference
4. `test/unit/pipeline/__snapshots__/exhaustiveness-guards.test.ts.snap:19` — snapshot
**Fix:** Add all 4 to Task 10's deletion list. The `event-type-guard.ts` omission is the most critical.

**AP-5: Task 9 test coverage insufficient.**
Only 2 test cases (2-chunk delta and no-delta). Missing: (a) non-empty initial input overridden by deltas, (b) multiple concurrent tool_use blocks at different indices, (c) multi-chunk input where intermediate `JSON.parse` fails on partial JSON.
**Fix:** Add these 3 test cases.

### Task 11 (Phase 2 — Tool Registry)

**AP-6: Title-body contradiction — no code change despite title saying "delete running→running merge, add `updateMetadata`".**
The task title says "delete running→running merge, add updateMetadata." The Files section says `Modify: tool-registry.ts:121-152`. But the body only creates tests that PASS against current code — no source modification. This contradicts the design doc (lines 114, 244, 260, 319) which mandates deletion + replacement.
**Fix:** Add steps to: (1) delete the `running→running` branch in `executing()`, (2) add `updateMetadata(id, metadata)` method to ToolRegistry interface and implementation, (3) update `handleToolExecuting` in `chat.svelte.ts` (or `ws-dispatch.ts`) to route metadata-only updates through the new method.

**AP-7: Missing `updateMetadata` method breaks OpenCode metadata flow.**
Without `updateMetadata`, deleting the `running→running` branch means OpenCode's second `tool_executing` for a Task tool hits `canTransition("running", "running")` which returns `false`. The executing call would be rejected.
**Fix:** Included in AP-6 fix.

**AP-8: Proposed tests duplicate existing coverage.**
`test/unit/stores/tool-registry.test.ts:156-177` already tests the running→running metadata merge scenario. The completed-tool-rejected and duplicate-start cases are also covered at lines 112-119 and 179-191.
**Fix:** Place new tests in the existing file. Add genuinely new coverage for post-deletion behavior (executing on running → reject; updateMetadata happy path and reject cases).

**AP-9: Test file path mismatch.**
Existing tests are at `test/unit/stores/tool-registry.test.ts`. Plan creates `test/unit/frontend/tool-registry-single-start.test.ts` — different directory for the same module.
**Fix:** Use the existing test file path.

---

## Accept (10+ findings — informational, no plan changes needed)

| # | Tasks | Category | Issue |
|---|-------|----------|-------|
| A-1 | 1-2 | Test Coverage | `session.status` with `status: "error"` not in shape test's SILENT_CASES |
| A-2 | 1-2 | Fragile Code | `UntaggedRelayMessage` loose type doesn't catch typos in `{ type: "done" }` |
| A-3 | 1-2 | Missing Wiring | `translateCanonicalEvent` confirmed module-private, single caller |
| A-4 | 1-2 | Implicit Assumptions | Public API test approach is sound |
| A-5 | 9-10 | Incorrect Code | `callId: tool.itemId` confirmed correct (same as original `block.id`) |
| A-6 | 9-10 | State Issues | Dual write `tool.input` + `tool.bufferedInput` is intentional |
| A-7 | 9-10 | Implicit Assumptions | `resetInFlightState()` doesn't clear ctx.inFlightTools (pre-existing) |
| A-8 | 9-10 | Fragile Code | Test non-null assertion `toolStarted[0]!` — minor quality issue |
| A-9 | 11 | Implicit Assumptions | OpenCode event-translator vs message-poller have different dedup strategies |
| A-10 | 6-7 | Missing Wiring | All 3 `tool.started` emit sites confirmed covered by Tasks 6+7 |

---

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| AP-1 | 9 | Replaced `makeCtx()` with full `ClaudeSessionContext` shape matching existing test pattern (16 fields) |
| AP-2 | Plan header | Added explicit intra-plan dependency note: "Tasks 4+6 must land before Task 9" |
| AP-3 | 9 | Added Step 3b: handle `pendingStart` tools in `cleanupSession` on stream interruption; added test case |
| AP-4 | 10 | Added 4 missing deletion targets: `event-type-guard.ts`, `claude-event-translator.test.ts`, `events.test.ts`, snapshot file |
| AP-5 | 9 | Added Step 3c: 3 additional test cases (initial input override, concurrent blocks, partial JSON) |
| AP-6 | 11 | Rewrote task to include actual code changes: delete running→running branch, add `updateMetadata()` method |
| AP-7 | 11 | Included in AP-6: `updateMetadata()` preserves OpenCode's metadata-later flow |
| AP-8 | 11 | Changed test location to existing `test/unit/stores/tool-registry.test.ts`; added new post-deletion test cases |
| AP-9 | 11 | Fixed test path from `test/unit/frontend/` to `test/unit/stores/` |

---

## Incomplete Audits (supplemental controller notes)

Auditors for Tasks 3-5, 6-7, 8, 12-14, 15-17 exhausted research turns without producing structured findings. Controller notes on likely issues:

- **Tasks 6-7:** `makeCanonicalEvent` metadata change adds `schemaVersion: 2` to ALL Claude events (not just tool events). Harmless but unnecessary. Consider passing schemaVersion only at tool.started emit sites.
- **Tasks 12-14:** Circular import risk between `index.ts` ↔ individual summarizer files (each imports from the other). ES module resolution handles this in practice but it's fragile. Consider moving `registerSummarizer` + `SUMMARIZERS` to a separate `registry.ts` to break the cycle.
- **Tasks 15-17:** Legacy un-normalized inputs from historical SQLite events will pass through new summarizers that expect `CanonicalToolInput` shape. The `as never` cast hides this. The design doc specifies a shim fallback (line 217) but the plan doesn't implement it. Risk: historical sessions may render tool cards with no subtitle until events are replayed through the upcast path.
