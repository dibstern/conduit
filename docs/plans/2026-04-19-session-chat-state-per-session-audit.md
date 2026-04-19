# Per-Session Chat State Plan — Audit Synthesis

**Date:** 2026-04-19
**Plan:** [`2026-04-19-session-chat-state-per-session-plan.md`](./2026-04-19-session-chat-state-per-session-plan.md)
**Design:** [`2026-04-19-session-chat-state-per-session-design.md`](./2026-04-19-session-chat-state-per-session-design.md)
**Auditors:** 9 parallel per-phase audits.
**Individual reports:** `docs/plans/audits/per-session-chat-state-phase-0.md` … `-phase-8.md`

**Bottom line:** Plan has the right shape but several blocking gaps. Triggering-bug fix is **not achievable** without a new server-side fanout phase (currently per-session events are filtered by viewer subscription). Phase 1's `EMPTY_STATE` snippet doesn't compile. Phases 2, 3, 5 omit handlers / globals that the refactor must touch. Substantial amendment required before execution.

---

## Critical — Blocks Plan Execution

### C1. **Phase 3 / Design:** Server filters per-session events by viewer subscription today

- **Source:** Phase 3 auditor; confirmed paths `src/lib/server/ws-handler.ts:198` (`getViewers(sessionId)`) and `src/lib/relay/event-pipeline.ts:111-123`.
- **Impact:** A client viewing session A never receives B's deltas under current server behavior. The plan's client-side routing-by-`sessionId` is a no-op for the triggering bug without a new phase broadening server fanout (A2's design premise).
- **Action — Amend Plan:** Add a new **Phase 0b** (server fanout broadening) between Phase 0 and Phase 1. Options:
  - Drop `view_session`-based subscription; broadcast all per-session events to all clients of the project relay.
  - Or: explicit subscribe-list protocol (client subscribes to `{currentId}` + any session with `processing=true` in the latest `session_list`).
  - Preferred per design doc: project-scoped firehose.
- **Ask User:** project-scoped firehose OR subscribe-list? (Already presented during brainstorming — user chose A2 which implied firehose. Re-confirm with explicit phase in plan.)

### C2. **Phase 1:** `Object.freeze($state(...))` throws at module load

- **Source:** Phase 1 auditor; Svelte 5 `$state` proxy's `defineProperty` trap rejects `writable: false`.
- **Impact:** Task 1.2's `EMPTY_STATE = Object.freeze(createEmptySessionChatState())` crashes at import time. Entire frontend fails to boot.
- **Action — Amend Plan:** `EMPTY_STATE` must be a plain frozen object (no `$state`), OR a non-frozen sentinel enforced by convention + a test. Plan should pick one.
- **Ask User:** Plain frozen POJO (no reactivity — fine since it's a constant) vs. a live-but-unmutated `$state` with test-enforced immutability?

### C3. **Phase 0:** Emission sites massively undercounted

- **Source:** Phase 0 auditor; plan names 3 files, grep shows 14+ files / 40+ sites (event-translator.ts, message-poller.ts, monitoring-wiring.ts, effect-executor.ts, errors.ts, handlers/*, client-init.ts, sse-wiring.ts).
- **Impact:** Task 0.3–0.6 as written leave the majority of emission sites unchanged; TypeScript will flag hundreds of errors when Task 0.2 adds `sessionId: string` to event variants.
- **Action — Amend Plan:** Replace Task 0.3–0.6's "grep and thread" instruction with an explicit per-file task list derived from the audit. Enumerate the 14 files.

### C4. **Phase 0:** `RelayError.toMessage()` is called from 7+ sites and constructs `type: "error"` without sessionId

- **Source:** Phase 0 auditor; callers: `prompt.ts`, `client-init.ts`, `handler-deps-wiring.ts`, and others.
- **Impact:** After Task 0.2 makes `error.sessionId: string` required, every `toMessage()` call breaks compilation.
- **Action — Amend Plan:** Add an explicit task threading `sessionId` into `RelayError.toMessage(sessionId?)`. Decide how to handle system-level errors that have no session context.
- **Ask User:** For system-level errors (PARSE_ERROR, UNKNOWN_MESSAGE_TYPE, RATE_LIMITED, INSTANCE_ERROR, INIT_FAILED): (a) keep `error` variant and permit `sessionId: string | null`, (b) introduce a new `system_error` variant without `sessionId`, or (c) always tag with a sentinel sessionId like `"__system__"`. **(b)** is cleanest type-theoretically but needs a frontend handler.

### C5. **Phase 2:** Missing handlers — several module-level globals and dispatch-level mutators not in the flip list

- **Source:** Phase 2 + Phase 3 auditors.
- Omissions:
  - `advanceTurnIfNewMessage` — called from dispatch level, mutates `phase`, `turnEpoch`, the `seenMessageIds` / `doneMessageIds` module sets. Must be per-session.
  - `handleToolContentResponse` — `ws-dispatch.ts:825`, writes directly to `chatState.messages`.
  - `replayBatch` / `replayBuffers` / `eventsHasMoreSessions` — module-level caches used by `getMessages`/`setMessages`.
  - `ensureSentDuringEpochOnLastUnrespondedUser` — called from `handleStatus`.
  - `registerClearMessagesHook` + module `replayGeneration` counter.
- **Impact:** After Tasks 2.12, 2.13 "delete globals" step, these functions still reference dead globals → build breaks, or silently writes to the wrong place.
- **Action — Amend Plan:** Expand Task 2.11 / 2.12 and add explicit tasks for each listed function.

### C6. **Phase 5:** `_scrollRequestPending` cannot remain a global after Phase 3

- **Source:** Phase 5 auditor.
- **Plan error:** Task 5.4 says "keep scroll-request global — it's a pure UI affordance tied to the visible chat area." But after Phase 3 routes events per session, `handleError` for background session B would set the flag, and the next content-change on the visible session A wrongly consumes it.
- **Action — Amend Plan:** Move `_scrollRequestPending` into `SessionChatState`. `consumeScrollRequest()` reads from `currentChat()`.

### C7. **Phase 3:** Deleting live-event buffering regresses a data-loss hazard

- **Source:** Phase 3 auditor.
- **Impact:** The `liveEventBuffer` exists because a live delta arriving during an async replay of the same session currently goes into the buffer and is drained after replay commits via `commitReplayFinal`. Removing it without replacement causes the live event to bypass `replayBatch` and append ahead of the cached tail in `state.messages`.
- **Action — Amend Plan:** Either (a) preserve per-session buffering (move `liveEventBuffer` into `SessionChatState`), or (b) redesign replay to commit events one at a time so there's no batch to interleave with. Choose before Phase 3.
- **Ask User:** Option (a) — preserve buffering, per-session — or (b) redesign replay?

### C8. **Phase 2/5:** Contradictory `_pendingHistoryQueuedFallback` / `_scrollRequestPending` treatment across tasks

- **Source:** Phase 2 + Phase 5 auditors.
- Task 2.10 says `requestScrollOnNextContent` becomes per-session; Task 5.4 says keep it global. Same split appears for `_pendingHistoryQueuedFallback`. WeakSet vs per-state field was noted as ambiguous.
- **Action — Amend Plan:** Pick one strategy, stated consistently in both phases. Recommend per-state boolean fields on `SessionChatState` for both.

---

## High — Actionable Before Execution

### H1. **Phase 2:** `state.messages = [...state.messages, x]` bypasses `replayBatch`

- **Source:** Phase 2 auditor.
- `getMessages()` / `setMessages()` today route through `replayBatch` during replay. Phase 2's snippet replaces `setMessages(...)` with direct `state.messages = [...]`, silently breaking replay batching.
- **Action — Amend Plan:** Keep `getMessages(state)` / `setMessages(state, msgs)` helpers (taking state). Handler snippets use those, not direct `state.messages =`.

### H2. **Phase 0:** `event-translator.ts` emits 12+ untagged events in sub-translators

- **Source:** Phase 0 auditor.
- Sub-translators return messages without `sessionId`; `sse-wiring.ts` has `sessionId` in scope but doesn't re-stamp.
- **Action — Amend Plan:** Add explicit task — either thread sessionId through each translator function OR re-stamp in the caller (`sendToSession` wrapper).
- **Recommendation:** Re-stamp in `wsHandler.sendToSession(clientId, msg, sessionId)` to centralize enforcement. TS utility that strips `sessionId` from callers and adds it at send.

### H3. **Phase 5:** `evictCachedMessages` is orphan; no session-removal path created

- **Source:** Phase 5 auditor.
- Plan says "one caller, ws-dispatch.ts session delete" — actually zero callers in the current code.
- **Action — Amend Plan:** Either add an explicit `session_removed` handler that calls `sessionChatStates.delete(id)`, or remove the orphaned API from the plan (and verify no session-removal cleanup is actually required).

### H4. **Phase 5:** `historyState` singleton still read by MessageList/HistoryLoader after plan completes

- **Source:** Phase 5 auditor.
- Plan moves `historyHasMore` / `historyMessageCount` into `SessionChatState` (Task 1.1) but never deletes the module-level `historyState = $state({...})` export. Components still read it.
- **Action — Amend Plan:** Add task: delete `historyState` module export and migrate readers to `currentChat().history*`.

### H5. **Phase 5:** Re-visit replay semantics unspecified

- **Source:** Phase 5 auditor.
- When `switchToSession(existingId)` hits a cached slot, does the incoming replay via `session_switched.events` (a) clear first, (b) merge, or (c) skip?
- **Action — Amend Plan:** Specify in Task 5.2.
- **Ask User:** Default to "clear + replay" (simple, discards stale state), or "skip replay if slot populated + reconcile via status" (less work, fragile)?

### H6. **Phase 6:** Task enumeration weak; Task 6.4 is a handwave

- **Source:** Phase 6 auditor.
- Files that read `chatState`: `MessageList.svelte`, `UserMessage.svelte`, `HistoryLoader.svelte`, `ChatLayout.svelte`, `MessageList.stories.ts` — only MessageList listed in Task 6.1.
- **Action — Amend Plan:** Explicit tasks for each file.

### H7. **Phase 6 / 7 / 8:** `data-testid="bounce-bar"` edit duplicated across phases

- **Source:** Phases 6, 7, 8 auditors.
- Plan places it in Task 8.3. But Tasks 6.2 (InputArea), 7.6 (new bounce-bar test) also reference it.
- **Action — Amend Plan:** Move the DOM edit to Task 6.2 where InputArea is already being modified. Delete the reference from Task 8.3.

### H8. **Phase 7:** Triggering-bug UI tests missing; tests are state-only

- **Source:** Phase 7 auditor.
- Pure-state tests don't witness the bug's visible symptom. Plan needs component tests for InputArea bounce bar + SessionItem sidebar dot that simulate the full switch sequence and assert DOM.
- **Action — Amend Plan:** Add Tasks 7.6 (InputArea bounce bar component test) and 7.7 (SessionItem sidebar dot component test) using `@testing-library/svelte` pattern from `test/unit/components/attention-banner.test.ts` (verify path).

### H9. **Phase 7:** Task 7.1 tests bypass `switchToSession` and `session_switched` flow

- **Source:** Phase 7 auditor.
- Tests mutate `sessionState.currentId` directly. That's not the code path with the bug. Full flow requires `switchToSession(id, mockWsSend)` AND a mocked `session_switched` response dispatched through `handleMessage`.
- **Action — Amend Plan:** Rewrite test snippets to use the full WS round-trip harness. Mirror idioms from `regression-session-switch-history.test.ts`.

### H10. **Phase 8:** E2E harness details wrong / unspecified

- **Source:** Phase 8 auditor.
- Hardcoded `/p/test-project` → real fixture slug is `e2e-replay` (`test/e2e/replay-fixture.ts:40-63`).
- Hardcoded `[data-session-id="A"]` → real IDs are `sess_01JTEST...`.
- "Complete a turn" is unspecified — no helper for running 2 sessions in replay mode.
- Config: 12 `playwright-*.config.ts` files exist; new spec's config unnamed.
- SDK mismatch: bug described as Claude SDK, replay harness is OpenCode-only.
- **Action — Amend Plan:** Rewrite E2E task with real slugs, fixture helper references, specific config file, and documentation of SDK coverage via unit tests (Task 4.1 covers F3).

### H11. **Phase 0:** TS discrimination doesn't structurally enforce emission

- **Source:** Phase 0 auditor.
- `Extract<RelayMessage, {sessionId: string}>` narrows on reader side; emitters constructing a bare object literal still compile.
- **Action — Amend Plan:** Add a `wsHandler.sendToSession(clientId, event, sessionId)` helper that stamps `sessionId` onto any `PerSessionEvent`-without-sessionId before send. Callers pass their raw event + sessionId separately. Centralizes enforcement.

### H12. **Phase 4:** `Pick<SessionSwitchDeps["overrides"], K>` won't typecheck

- **Source:** Phase 4 auditor.
- `SessionSwitchDeps.overrides` is itself `overrides?`, making `Pick<...>` pick from `undefined`.
- **Action — Amend Plan:** Use `Pick<NonNullable<SessionSwitchDeps["overrides"]>, "hasActiveProcessingTimeout">` or inline the shape.

### H13. **Phase 4:** Test coverage gaps

- **Source:** Phase 4 auditor.
- Missing cases: both guards active; `isLastTurnActive === false`; `source.kind === "rest-history"` / `"empty"`.
- **Action — Amend Plan:** Add the 3 missing cases.

### H14. **Phase 3:** `advanceTurnIfNewMessage` runs before routing

- **Source:** Phase 3 auditor.
- Currently called at dispatch level and mutates "the current session's" turn. Post-routing, it mutates the event's session's turn. Must be moved inside `routePerSession` or made session-aware.
- **Action — Amend Plan:** Specify placement in Task 3.1.

---

## Ask User — Decisions Required Before Plan Finalizes

1. **System errors (C4):** `sessionId: string | null` on `error` variant, OR introduce `system_error` variant without sessionId, OR sentinel `"__system__"`?
2. **EMPTY_STATE (C2):** Plain frozen POJO vs live `$state` with test-enforced immutability?
3. **Server fanout (C1):** Project-scoped firehose OR subscribe-list protocol? (Re-confirm A2.)
4. **Replay batching during live deltas (C7):** Preserve per-session `liveEventBuffer`, OR redesign replay to commit per-event (no batch)?
5. **Re-visit replay semantics (H5):** "Clear + replay" vs "skip replay if populated"?
6. **`session.processing` precedence (Phase 6):** Server-flag OR local phase wins when they disagree? (Current code: server-flag OR local-non-idle → processing. Confirm.)
7. **Component template idiom (Phase 6):** Inline `currentChat().messages` OR snapshot `const chat = $derived(currentChat())` — pick one canonical.
8. **`_pendingHistoryQueuedFallback` / `_scrollRequestPending` (C6/C8):** Per-state boolean OR WeakSet<SessionChatState>?
9. **Phase 9 bandwidth regression test:** Add a perf test enforcing event-rate threshold, or leave as manual measurement?
10. **Mock-mode manual QA (Phase 9):** Add a mock-LLM path for contributors without API billing?

---

## Accept — Informational, No Plan Change

- Phase 4 synthesized `done` event correctly carries `sessionId` (requires Phase 0 first — ordering correct).
- SvelteMap `.get` subscribes to the key; later `.set` triggers re-derivation. Phase 1 pattern is reactively sound for the derivation path.
- `.session-processing-dot` class selector verified correct.
- `session.id` is non-optional in `SessionInfo`.
- "Task 6.6" is a typo in the plan (no such task).

---

## Fixer Worklist (grouped by phase)

### Phase 0

- [Amend] Replace Tasks 0.3–0.6 with explicit per-file task list (14 files).
- [Amend] Add task for `RelayError.toMessage()` sessionId threading + resolution of system-error design.
- [Amend] Add task for `event-translator.ts` sessionId threading (or re-stamp-in-sender pattern).
- [Amend] Add `sendToSession(sessionId, event)` helper to centralize stamping (H11).
- [Amend] Expand Task 0.7 to cover error paths, translator, poller synthesis, rehydration, patchMissingDone.
- [Ask] C4 system error design decision.

### Phase 0b (NEW)

- [Amend] Add new phase: server fanout broadening. Drop `view_session`-scoped subscription; deliver all per-session events for project to all project clients. Add `data_testid`-style smoke test.
- [Ask] C1 fanout model decision.

### Phase 1

- [Amend] Fix `EMPTY_STATE` — use plain frozen POJO or remove freeze.
- [Ask] C2 sentinel strategy.
- [Amend] Add test: mutating inner state fields triggers `$derived(currentChat())` re-eval; `EMPTY_STATE.messages.push(...)` error case.

### Phase 2

- [Amend] Add `advanceTurnIfNewMessage`, `handleToolContentResponse`, `replayBatch`/`replayBuffers`/`eventsHasMoreSessions`, `ensureSentDuringEpochOnLastUnrespondedUser`, `registerClearMessagesHook` to the flip list (C5).
- [Amend] Preserve `getMessages(state)` / `setMessages(state, msgs)` (H1).
- [Amend] Per-state boolean fields for `_pendingHistoryQueuedFallback` and related (C8).
- [Amend] Task 2.1 arity test expand to per-handler "mutates stateA not stateB" assertions.

### Phase 3

- [Amend] Enumerate all 17 PerSessionEvent variants in routing.
- [Amend] Preserve per-session buffering OR redesign replay (C7).
- [Amend] Place `advanceTurnIfNewMessage` inside `routePerSession` (H14).
- [Amend] Per-state replay + deferred generation counters; concurrency test covers interleave.

### Phase 4

- [Amend] Fix `NonNullable<...>` typing (H12).
- [Amend] Add 3 test cases (H13).
- [Amend] Consider `sessionIsProcessing(sessionId, deps)` DRY helper.

### Phase 5

- [Amend] Move `_scrollRequestPending` into `SessionChatState` (C6).
- [Amend] Remove or repurpose orphaned `evictCachedMessages` (H3).
- [Amend] Delete `historyState` module singleton (H4).
- [Amend] Delete `_pendingHistoryQueuedFallback` module var declaration.
- [Amend] Specify re-visit replay semantics (H5).
- [Ask] H5 semantics choice.
- [Amend] Touch `session_switched` WS handler (calls `clearMessages()` + `updateContextPercent(0)`).
- [Amend] Migrate tests that import `stashSessionMessages` / `restoreCachedMessages` / `contextPercent` (enumerate).

### Phase 6

- [Amend] Explicit tasks for each file reading `chatState` (H6).
- [Amend] Move `data-testid="bounce-bar"` edit from Task 8.3 to Task 6.2 (H7).
- [Ask] Server-flag precedence; canonical template idiom.
- [Amend] Rewrite `MessageList.stories.ts` direct-write (currently mutates `chatState.messages`).

### Phase 7

- [Amend] Add Task 7.6 (InputArea bounce bar component test) and Task 7.7 (SessionItem sidebar dot component test) (H8).
- [Amend] Task 7.1 rewrite to use full `switchToSession` + `session_switched` flow (H9).
- [Amend] Enumerate all 17 variant cases in routing test.
- [Amend] Fix `vi.runAllTimersAsync?.()` optional chaining; add mocking scaffolding; spell out concurrency test details.
- [Amend] Fill in placeholder event arrays with concrete payloads.

### Phase 8

- [Amend] Correct E2E harness details (fixture slug, session-id pattern, config file) (H10).
- [Amend] Move testid DOM edit to Phase 6 (H7).
- [Amend] Expand E2E to 3–4 scenario variants (idle/processing/streaming/rapid).
- [Amend] Document SDK coverage (F3 unit, E2E agnostic).
- [Ask] Stories population strategy; mock-mode manual QA; bandwidth regression test.

### Phase 9

- [Ask] Bandwidth + mock-mode decisions feed back into test additions.

---

## Routing Decision

**Findings distribution:**
- **Amend Plan:** 45+ across all phases. Several structurally blocking.
- **Ask User:** 10 decision points.
- **Accept:** 5 informational.

**Next step:** Hand off to `plan-audit-fixer`. Fixer collects Ask User questions, presents to user, waits for answers, then amends plan in place. Re-audit after amendments.

---

## Amendments Applied (2026-04-19)

User decisions recorded at top of amended plan. Amendments made in-place to `2026-04-19-session-chat-state-per-session-plan.md`:

| Finding | Resolution |
|---|---|
| **C1** server fanout | Added new **Phase 0b — Project-scoped firehose** (Tasks 0b.1–0b.6). Drops `view_session` subscription filtering. |
| **C2** `EMPTY_STATE` freeze | Task 1.2 now uses plain frozen POJO (no `$state` proxy). Added test for frozen-mutation throw. |
| **C3** emission sites | Task 0 now has an emitter audit table (14 files); Tasks 0.6a–0.6j are one commit per file. |
| **C4** `RelayError.toMessage` | New Task 0.4 threads `sessionId`; introduces `toSystemMessage()`. `system_error` variant added in Task 0.2. |
| **C5** missing handlers | Phase 2 handler list expanded to include `advanceTurnIfNewMessage`, `handleToolContentResponse`, `ensureSentDuringEpochOnLastUnrespondedUser`, `registerClearMessagesHook`, + all replay/dedup helpers. |
| **C6** `_scrollRequestPending` | Task 5.4 now moves it onto `SessionChatState`, not keep-global. |
| **C7** live-event buffering | Task 3.3 preserves buffering per-session (onto `state.liveEventBuffer`); routing checks `replayBatch` before dispatching. |
| **C8** `_pendingHistoryQueuedFallback` | Per-state boolean field on `SessionChatState` (Q8). Task 5.6 deletes module decl. |
| **H1** `setMessages/getMessages` | Task 2.2 correction — helpers preserved, take state arg, route through `state.replayBatch`. |
| **H2** `event-translator.ts` | New Task 0.5 — stamp sessionId in `sse-wiring.ts` caller, not sub-translators. |
| **H3** orphan `evictCachedMessages` | Task 5.7 repurposes as `evictSessionState(id)` wired to `delete_session` handler. |
| **H4** `historyState` singleton | Task 5.5 deletes the module export. |
| **H5** re-visit replay semantics | Task 5.2 specifies "clear-then-replay" on `session_switched` for existing slot (Q5). |
| **H6** Phase 6 enumeration | Task 6.4 split into 6.4a–6.4d, one file each. |
| **H7** testid duplication | Bounce-bar `data-testid` edit moved to Task 6.2; removed from Phase 8. |
| **H8** component regression tests | Tasks 6.2 + 7.6 (InputArea bounce bar) and 6.3 + 7.7 (SessionItem dot) added. |
| **H9** Task 7.1 WS flow | Rewritten to use `switchToSession` + `handleMessage(session_switched)` full flow. |
| **H10** E2E harness | Task 8.3 rewritten with `e2e-replay` slug, `setupReplayProject` helper, `sess_*` ID patterns, `playwright-replay.config.ts`, 4 scenario variants (a/b/c/d). SDK coverage note added. |
| **H11** emission enforcement | Task 0.3 centralizes stamping via `wsHandler.sendToSession(clientId, sessionId, event)`. |
| **H12** `NonNullable<...>` typing | Task 4.1 `patchMissingDone` signature uses `NonNullable<SessionSwitchDeps["overrides"]>`. |
| **H13** Phase 4 test cases | Task 4.1 expanded to 6 cases (added: both-active, last-turn-inactive, rest/empty sources). |
| **H14** `advanceTurnIfNewMessage` | Placed inside `routePerSession` so it mutates the event's session, not current. |

**Ask User answers applied:**

| # | Question | Answer | Plan reference |
|---|---|---|---|
| Q1 | System errors | New `system_error` variant | Task 0.2 |
| Q2 | `EMPTY_STATE` | Plain frozen POJO | Task 1.2 |
| Q3 | Fanout | Project-scoped firehose | Phase 0b |
| Q4 | Buffering | Preserve per-session | Task 3.3 |
| Q5 | Re-visit replay | Clear + replay | Task 5.2 |
| Q6 | `session.processing` precedence | Server flag wins (OR) | Task 6.3 |
| Q7 | Template idiom | `const chat = $derived(currentChat())` snapshot | Tasks 6.1–6.4 |
| Q8 | Per-state booleans | Per-state fields | Task 1.1 |
| Q9 | Bandwidth test | Add | Task 9.4 |
| Q10 | Mock-mode QA | Add | Task 9.3 |
