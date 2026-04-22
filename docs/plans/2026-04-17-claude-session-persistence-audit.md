# Audit Synthesis: Claude Session Message Persistence

**Plan:** `docs/plans/2026-04-17-claude-session-persistence.md`
**Auditors dispatched:** 5 (one per task)
**Reports received:** 3 of 5 (Tasks 1 and 3 ran out of context; findings reconstructed from output + cross-auditor overlap)

---

## Amend Plan (4)

### 1. CRITICAL: `projectionRunner.recover()` never called in production — projections DOA
**Source:** Tasks 1, 3, 4, 5 (all auditors investigating same issue)
**Category:** Implicit Assumptions / Missing Wiring
**Detail:** `ProjectionRunner.projectEvent()` has a lifecycle guard (line 215): if `_recovered` is false, it throws `PersistenceError`. `recover()` is NEVER called in production code — only in test files via `recover()` or `markRecovered()`. DualWriteHook catches the throw (line 149 try/catch), so events store but `messages` table is never populated. Our fix adds the same try/catch in RelayEventSink, which means events store but `messages` table stays empty. Session-switch reads from `messages` table → still returns empty. **Fix is DOA without addressing this.**
**Evidence:** `grep -rn "projectionRunner.*recover\|markRecovered" src/ --include="*.ts"` returns zero hits outside projection-runner.ts itself. Test files call it; production never does.
**Recommendation:** Add a new step in Task 3 (relay-stack.ts): call `config.persistence.projectionRunner.recover()` during startup, before DualWriteHook and handler-deps are created. This fixes BOTH the new Claude path AND the existing (silently broken) OpenCode SSE projection path.

### 2. Wrap ENTIRE persistence block in try/catch (not just projectEvent)
**Source:** Task 5, Finding 6
**Category:** Incorrect Code
**Detail:** Plan's Task 1 code wraps only `projectionRunner.projectEvent()` in try/catch, leaving `ensureSession()` and `eventStore.append()` unguarded. If either throws (disk full, DB locked), exception propagates into Claude SDK streaming pipeline, potentially crashing the turn AND blocking the WebSocket send.
**Recommendation:** Amend Task 1 Step 4 to wrap the entire `if (persist)` block in try/catch:
```typescript
if (persist) {
    try {
        persist.ensureSession(sessionId);
        const stored = persist.eventStore.append(event);
        persist.projectionRunner.projectEvent(stored);
    } catch {
        // Non-fatal — same pattern as dual-write-hook.ts
    }
}
```

### 3. Line number references off in Task 2
**Source:** Task 2, Findings 1-2
**Category:** Implicit Assumptions
**Detail:** (a) Import insertion says "after line 8" but ReadQueryService is on line 9. (b) HandlerDeps spread insertion says "after line 171" which is inside the orchestration spread — should be "after line 172".
**Recommendation:** Fix line numbers in Task 2 text. Non-blocking (code descriptions are correct), but avoids implementer confusion.

### 4. Test mock provider mismatch
**Source:** Task 5, Finding 5
**Category:** Insufficient Test Coverage
**Detail:** `makeEvent` helper in existing test file uses `provider: "opencode"` while real Claude events use `provider: "claude"`. Plan's new tests inherit this. Not a bug (mocks are internally consistent) but if an integration test is added, it should use `provider: "claude"`.
**Recommendation:** Update the new tests in Task 1 to create events with `provider: "claude"` for accuracy.

---

## Ask User (1)

### 5. Should plan include integration test for full persistence chain?
**Source:** Task 5, Finding 1
**Category:** Insufficient Test Coverage
**Detail:** The 3 unit tests in Task 1 use mock `eventStore`/`projectionRunner` and verify mock calls. No test wires real `PersistenceLayer.memory()` + `EventStore` + `ProjectionRunner` + `createRelayEventSink`, pushes events, and verifies `resolveSessionHistoryFromSqlite()` returns messages. Patterns exist at `dual-write-integration.test.ts` and `session-switch-sqlite.test.ts`.
**Recommendation:** Add a Task 1.5 with a real SQLite integration test. This would catch the `recover()` issue, provider mismatches, and projection failures — making it the single most valuable test.

---

## Accept (7)

- Task 2: Optional field won't break test mocks or existing handlers
- Task 2: Import paths verified correct; `RelayEventSinkPersist` properly exported
- Task 2: Spread pattern matches codebase convention (`!= null` checks)
- Task 2: Sequential task dependency (Task 1 before Task 2) is correct
- Task 4: Conditional spread syntax is correct and idiomatic
- Task 4: wiring chain is complete (relay-stack → handler-deps → prompt → sink)
- Task 5: OpenCode SSE regression risk is covered by existing `dual-write-integration.test.ts`

---

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| 1. projectionRunner.recover() never called | Task 3 | Added Step 2: call `config.persistence.projectionRunner.recover()` at startup |
| 2. Wrap entire persist block in try/catch | Task 1, Step 4 | Changed try/catch to wrap ensureSession + append + projectEvent |
| 3. Line numbers off in Task 2 | Task 2 | Fixed "after line 8" → "after line 9", "after line 171" → "after line 172" |
| 4. Test mock provider mismatch | Noted | Integration test (new Task 5) uses real events; unit tests are mock-internal-only |
| 5. Add integration test (Ask User → Yes) | New Task 5 | Added real SQLite integration test verifying full chain + session provider |
| — | Task 5→6 | Renumbered old Task 5 to Task 6 |
| — | Task 1 | Added 4th unit test: "eventStore.append throws → WS still works" |

## Routing

**All findings resolved. Handing back to subagent-plan-audit for re-audit.**
