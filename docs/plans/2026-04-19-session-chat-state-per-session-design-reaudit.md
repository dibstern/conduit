# Per-Session Chat State Design — Re-audit (Loop 2)

**Plan:** `docs/plans/2026-04-19-session-chat-state-per-session-design.md` (rev 2026-04-20)
**Date:** 2026-04-20
**Auditors:** 8 parallel `plan-task-auditor` subagents, one per top-level change in the revised plan.
**Per-task reports:** `docs/plans/audits/2026-04-19-session-chat-state-per-session-design-reaudit-{server-pr,main-task-1..7}.md`
**Previous loop:** `docs/plans/2026-04-19-session-chat-state-per-session-design-audit.md`

## Outcome

Loop 1 findings are substantially resolved — all 72 prior Amend-Plan findings either fully resolved (62) or partially (10, which re-surfaced as concrete follow-ups in the new findings). The two-tier structural redesign validated cleanly by every auditor; no one questioned the split.

However the rewrite introduced **46 new Amend-Plan findings and 8 Ask-User findings**. These are NOT a repeat of Loop 1 — they're concrete mechanical details that the amendments didn't quite close. Major themes:

1. **References to symbols that don't exist in the codebase** (would fail TypeScript / runtime on implementation).
2. **Under-specified Proxy/composition details** — `composeChatState` routing, Proxy invariant traps.
3. **Commit-boundary compile failures** — Tasks delete fields before dependent migrations land.
4. **Dispatcher snippet inaccuracies** — unconditional calls with parameters variants don't have.
5. **Other replay paths missed** — `convertHistoryAsync`, history pagination.

**Recommendation:** one more amend-pass (Loop 3 of max 3). Findings are tractable — no structural rethink needed. After Loop 3 we either hand off to execution (if clean) or present remaining Amend items to the user per the fixer guardrail.

### Counts per task

| Task | Amend Plan | Ask User | Accept | Report |
|------|-----------:|---------:|-------:|--------|
| Server PR (Phase 0b + Task 1) | 10 | 2 | 3 | [server-pr](audits/2026-04-19-session-chat-state-per-session-design-reaudit-server-pr.md) |
| Main Task 1 — two-tier API | 10 | 1 | 3 | [main-task-1](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-1.md) |
| Main Task 2 — flip handlers | 6 | 1 | 1 | [main-task-2](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-2.md) |
| Main Task 3 — flip replay path (NEW) | 8 | 2 | 1 | [main-task-3](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-3.md) |
| Main Task 4 — dispatcher + F2 | 5 | 2 | 2 | [main-task-4](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-4.md) |
| Main Task 5 — delete globals | 5 | 0 | 1 | [main-task-5](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-5.md) |
| Main Task 6 — flip components | 1 | 0 | 4 | [main-task-6](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-6.md) |
| Main Task 7 — delete dead code | 1 | 0 | 2 | [main-task-7](audits/2026-04-19-session-chat-state-per-session-design-reaudit-main-task-7.md) |
| **Totals** | **46** | **8** | **17** | — |

---

## New themes in Loop 2

### Theme α — References to non-existent symbols

These will fail TypeScript/runtime on implementation:

- **`sessionState.sessions.has(eventSessionId)`** (Task 4 dispatcher snippet, plan line ~221). Grep `session.svelte.ts:20-27` — the store has `rootSessions` / `allSessions` arrays, NOT a `sessions` Map. Guard rewrites to use `findSession(id)` or a new map must be added in Task 1.
- **`session_deleted` relay event** (Task 5 teardown wiring). Not emitted anywhere in `src/`. Either the server PR adds the variant + emission, or Task 5 relies solely on the `handleSessionList` drop path.
- **`createEmptyToolRegistry()`** (Task 1 `EMPTY_MESSAGES` definition). Only `createToolRegistry()` exists in `tool-registry.ts`. Either rename in the plan or add the new factory.

### Theme β — `composeChatState` under-specified

The revised plan introduces `composeChatState(activity, messages)` returning a read-only Proxy, but omits critical details:

- **Key-routing strategy:** How does the Proxy's get-trap know which keys belong to Activity (e.g., `phase`) vs Messages (e.g., `messages`)? Must either (a) maintain a static key-set per tier, (b) check `key in activity` first then fall through to messages, or (c) enumerate both tiers' keys at module init. Ambiguity allows drift.
- **Proxy invariants:** `has`, `ownKeys`, `getOwnPropertyDescriptor` traps are not specified. Svelte's `$inspect` (in `UserMessage.svelte:22-33`) iterates its target's own keys via Svelte's internal introspection; a Proxy over `{}` with no `ownKeys` trap returns `[]`, so `$inspect` logs nothing useful. Need traps.
- **Reactivity preservation:** The outer Proxy MUST pass reads through to the inner `$state` proxies each call, not cache `activity` / `messages` references that break fine-grained subscription. Plan should spell this out.

### Theme γ — `$state` factory wrapping described twice (double-wrap risk)

The plan specifies two `$state` wrapping steps:
1. Plan §Access patterns (~line 133): `a = $state(createEmptySessionActivity())` inside `getOrCreateSessionActivity`.
2. Plan §Migration Task 1 (~line 311): "`createEmptySessionActivity`, `createEmptySessionMessages` factories (each returns a `$state(...)` proxy)".

If both are applied literally, `$state($state({...}))` is double-wrapped. Svelte 5 likely no-ops the outer `$state` on an existing proxy, but the intent is ambiguous. Pick one: either the factory returns a `$state` proxy (and `getOrCreate*` passes it through), or the factory returns a POJO (and `getOrCreate*` wraps it). The audit's prior Amend for this (Loop 1 Task 2 §15) specified the factory pattern; Loop 2 found the ambiguity survived into both sections.

### Theme δ — Dispatcher snippet has concrete errors

The `routePerSession` pseudocode in plan §Event routing has two bugs:

- **`advanceTurnIfNewMessage(activity, event.messageId)` called unconditionally.** Many PerSessionEvent variants have no `messageId` field: `status`, `error`, `done`, `ask_user`, `ask_user_resolved`, etc. Current dispatcher gates on `"messageId" in event` — the snippet must replicate.
- **`notification_event` classification.** Plan §"Event types that must gain `sessionId`" lists `notification_event` (already optional, promote to required). But its handler at `ws-dispatch.ts:671-710` dispatches to the notification reducer, not a chat slot. Under `routePerSession`'s switch, there's no case for it → falls through to the `never` exhaustiveness default → compile error or runtime throw. `notification_event` should be classified as `GlobalEvent` despite carrying `sessionId` (the sessionId is routing metadata for the reducer, not a chat-slot key).

### Theme ε — F2 fix too narrow

The plan's Task 4 F2 fix sets only `activity.phase = "idle"` when a server-idle status arrives. But when a streaming session goes idle mid-stream (the exact case F2 addresses), the following Activity fields may be dirty and need cleanup:

- `currentMessageId` — points to an unfinished assistant message
- `currentAssistantText` (in Messages tier) — mid-delta buffer
- `thinkingStartTime` — non-zero
- `seenMessageIds` — may contain the in-flight messageId
- `liveEventBuffer` — if replay was in flight, buffered deltas orphaned

Plan needs to specify the finalization behavior. Likely: same behavior as a synthesized `done` event for the current message, then phase → idle.

### Theme ζ — Commit-boundary compile failures

Task 5 deletes `uiState.contextPercent`, `updateContextPercent`, and module `historyState`. Task 6 migrates component readers. Per "each commit compiles" invariant, Task 5 breaks the build if landed before Task 6.

**Resolution options:**
- Include component migrations in Task 5 (merge Task 5+6).
- Move field deletions from Task 5 to Task 6 (Task 5 only removes the non-component call sites + renames helpers).
- Accept a transitional commit where readers cast around the missing field (ugly).

Similarly: `handleSessionList` (Task 5 drop-path trigger) lacks diff logic today at `session.svelte.ts:242-270` — just unconditional array overwrite. Need a snapshot/diff to detect disappeared ids. **Critical edge:** search-payload responses to the session list may have fewer entries than the unfiltered state — if diff-then-clear is naive, filtering wipes all non-matching slots. Spec must guard on `isSearchPayload` or similar.

### Theme η — Other replay paths need per-session migration

Task 3 migrates `replayEvents` to capture a slot at start. But `replayGeneration` / async commit patterns are used elsewhere too:

- `convertHistoryAsync` at `ws-dispatch.ts:459-469` (cache-miss `session_switched` branch) — snapshots `gen = replayGeneration`, commits only if still equal. Must capture per-session slot.
- `ws-dispatch.ts:572-580` (history_page pagination) — same pattern.

Both must snapshot `slot.activity.replayGeneration` and commit to the captured slot's `messages`, not `currentChat()`.

Also missed from Task 3's migration list: **`eventsHasMoreSessions: Set<string>`** at `chat.svelte.ts:318` — a per-session flag stored as a module global. Should move into `SessionActivity.eventsHasMore: boolean`.

### Theme θ — `replayGeneration` vs `deferredGeneration` name ambiguity persists

Loop 1 flagged this as Task 2 §13. The revised plan acknowledges "if `replayGeneration` is a rename of the existing `deferredGeneration`, document in the commit message; if distinct, document the new concept" (Task 1). But Task 2, Task 3, and the data-model both use `replayGeneration` as though it's canonical without stating the rename. Plus Task 3 says the dispatcher buffers while "`activity.replayGeneration` is active," but the current impl (`ws-dispatch.ts:368`) uses `liveEventBuffer !== null` as the sentinel. "Active" is ambiguous — `replayGeneration` is a monotonic abort counter, not a boolean.

Plan must:
1. Decide rename vs new concept.
2. Specify dispatcher gating as `activity.liveEventBuffer !== null` (not `replayGeneration`).
3. Clarify `replayGeneration`'s role is abort-signaling for stale resolver commits.

### Theme ι — `evictSessionSlot` semantics collide with LRU policy

Plan Task 5 says `evictSessionSlot` operates "on both tiers." But the eviction policy mandates Tier 1 (Activity) is unbounded. LRU must not touch Tier 1.

**Recommended fix:** delete `evictSessionSlot` as a concept. `ensureLRUCap()` handles Tier 2 LRU only. `clearSessionChatState(id)` handles both-tier teardown (session_deleted, handleSessionList drop). Two distinct operations, distinct names.

### Theme κ — `clearMessages` teardown semantics

Task 2 moves dedup sets into `SessionActivity`, but `clearMessages` at `chat.svelte.ts:1014-1015` still calls `doneMessageIds.clear()` / `seenMessageIds.clear()` on the module-scoped Sets. Plan says "module exports stay for the old code path; Task 5 deletes them." But module Set `.clear()` during Task 2-4 is a no-op for per-session state — if the same session is re-entered after `clearMessages`, dedup carries over prior-turn messageIds.

`clearMessages` must additionally clear the **current session's** `activity.seenMessageIds` / `activity.doneMessageIds` (via `getOrCreateSessionActivity(sessionState.currentId)`).

### Theme λ — `registerClearMessagesHook` signature under-specified

Task 2 says hook body "receives the sessionId being cleared." Today at `chat.svelte.ts:292` the hook is `(fn: () => void) => void` — no arg. Changing it to `(fn: (sessionId) => void) => void` requires:
- `clearMessages()` caller (`chat.svelte.ts:1006`) passes `sessionState.currentId` — nullable.
- Hook type `string | null` or `clearMessages` guards on null before invoking hook.

Plan should pick one.

### Theme μ — Task 2 null-`currentId` adapter policy conflicts with Task 4's

Task 2 says the adapter "early-returns on null currentId with a dev warning (no EMPTY_STATE writes)."
Task 4 says silent dropping is "unacceptable; the counter is monitored as a SEV."

Two different drop policies across adjacent commits. Also: legitimate early-session-load transient events (e.g., server emits a delta before the frontend has finished `handleSessionList` and set `currentId`) would be dropped without trace in Task 2.

### Theme ν — `EMPTY_MESSAGES.toolRegistry` closure over mutable state

`EMPTY_MESSAGES` wraps `createToolRegistry()` / `createEmptyToolRegistry()` in `Object.freeze`. Method calls on the returned registry still close over mutable internal state — `Object.freeze` doesn't stop that. An errant handler that calls `EMPTY_MESSAGES.toolRegistry.register(tool)` mutates the sentinel's registry silently (no throw).

Mitigation options:
- Null-out the registry methods on EMPTY_MESSAGES (`register: () => { throw new Error("..."); }`).
- Make EMPTY_MESSAGES a Proxy whose get-trap returns a throwing stub for any function field.
- Accept the risk (registry mutation is rare; tests cover).

### Theme ξ — Test coverage gaps

Loop 2 identified several specific test scenarios the plan doesn't enumerate:

- **Per-handler tier-contract test:** each handler, dispatch one event, assert only declared tier fields changed. (Catches silent tier leaks.)
- **Replay-per-slot migration test:** slot captured at start persists across mid-replay `currentId` change; `activity.liveEventBuffer` buffers+drains correctly; clearMessages bumps per-session generation+buffer.
- **Concurrent-replay same-session:** two `replayEvents(X)` calls concurrently — second aborts first cleanly, no cross-pollution.
- **Task 4 test scenarios:** live-during-replay-different-session, startup-race drop/buffer, F2 finalization cleanup, `notification_event` non-routing.
- **`ghost-session-cleanup.test.ts` scope:** search-payload non-eviction, active-session teardown (EMPTY_STATE fallback), mid-replay teardown.
- **Server PR:** Phase 0b broadcast semantics test (client not viewing B still receives B's events; cross-project isolation).

---

## Ask User (8 items)

Tactical decisions; none are structural. Fixer should present these before Loop 3 amendment.

1. **Phase 0b — `view_session` semantics after firehose:** Today `view_session` triggers delivery + history backfill. Under firehose, delivery is automatic. Does `view_session` still trigger history backfill (needed for Tier 2 hydration on re-entry)? Proposed: yes — it becomes a pure "give me this session's history" request.
2. **Phase 0b — within-session ordering guarantee:** Today `sendToSession` sends per-session in order. Under broadcast, does the server still guarantee per-session ordering (not cross-session)? Frontend relies on delta-order correctness per session.
3. **Phase 0b — rollback compat window:** If the frontend PR merges and the server PR gets rolled back, the frontend dispatcher throws on every event (missing sessionId). Do we accept this (frontend depends on server PR) or should the frontend include a transitional fallback that also reads old-shape events?
4. **Task 2 — advanceTurnIfNewMessage cross-session semantics:** Currently the function's dedup is global (seenMessageIds is module-level). Per-session is strictly better, but: is any handler or test relying on the global behavior (e.g., a messageId synthesized identically in two sessions colliding to suppress a dupe)? Assumed No unless you say otherwise.
5. **Task 3 — buffer-race-during-drain policy:** When a live event arrives during `drainLiveEventBuffer`, do we (a) null buffer first and let incoming events race the drain (current impl), or (b) hold buffer at `[]` during drain and push new events into the drain pass? (b) is safer per-session; (a) matches legacy behavior.
6. **Task 3 — concurrent `replayEvents` for same session:** Should a second call (rapid switch during replay) guard early, OR should it null the previous buffer and start fresh? Pick a behavior.
7. **Task 4 — startup race:** PerSessionEvents may arrive before `session_list` populates `sessionState`. The unknown-session guard would drop legitimate events. Options: (a) buffer events pre-session-list and replay after, (b) require server to emit session_list first (ordering guarantee), (c) drop silently (accept), (d) allocate the slot anyway and reconcile when session_list arrives.
8. **Task 4 — server-side `status` sessionId correctness test:** Should the server PR add a test that synthesized `status` events at `session-switch.ts:337-340` carry the right sessionId (not just a sessionId)? Guards F2 correctness at the emitter.

---

## Accept (17 items)

Summary of informational findings worth noting, not blocking:

- All prior Loop 1 Accept findings persist.
- `InfoPanels.svelte` contextPercent is a different derivation (from prop), not `uiState.contextPercent` — no migration needed.
- `$inspect` reactivity with `currentChat().X` reads is sound.
- Task 6 file enumeration is complete — grep verifies no missed `.svelte` sites.
- Per-component isolation test spec is sufficient.
- Storybook migration coverage is adequate.
- Net LOC phrasing clearly resolved.
- `dispatchToCurrent` deletion confirmed in Task 4.

---

## Routing decision

**Hand back to `plan-audit-fixer` for Loop 3.** 46 Amend-Plan findings and 8 Ask-User remain; none are structural. Per the fixer guardrail, Loop 3 is the last patch-pass before findings must be presented to the user wholesale.

Expected Loop 3 work:
1. User resolves 8 Ask-User items.
2. Fixer applies ~46 concrete Amend-Plan items (mostly renames, explicit specifications, Proxy trap definitions, commit-boundary corrections).
3. Re-audit. If clean → execution. If further Amend findings → present to user per guardrail.

---

## Loop 3 Amendments Applied (2026-04-20)

User answered all 8 Ask-User questions; plan rewritten in place. See revised plan at `docs/plans/2026-04-19-session-chat-state-per-session-design.md` (Appendix C summarizes changes).

### User decisions

| Q | Question | Decision |
|---|----------|----------|
| 1 | `view_session` rename | Keep name; fix plan's mischaracterization of its semantics; track rename in §Known Debt |
| 2 | Per-session delta order preserved under broadcast | Yes — invariant documented; `phase-0b-ordering.test.ts` added |
| 3 | Rollback compat window | Accept (a) — frontend strictly depends on server PR; captured in deploy runbook + Risks table |
| 4 | Cross-session messageId collisions | No special handling; per-session dedup is strictly safer even in the ~0-probability collision case; note added to §Core data model |
| 5 | Buffer-race during drain | (b) hold buffer during drain — documented in §Event routing Live-event buffering |
| 6 | Concurrent replay same session | (a) second call aborts via generation bump; first continues under captured slot; safe per Task 3 slot-capture rule. Rapid-switch-mid-replay scenario walked through in §Event routing. |
| 7 | Startup race | (b) — server emits `session_list` first (industry-standard pattern); server-side queue holds events during bootstrap; frontend unknown-session guard is a belt-and-suspenders defense |
| 8 | Server-side status sessionId correctness test | Yes — `synthesized-status-sessionid.test.ts` added to server PR |

### Amendment themes → actions

| Theme | Finding(s) | Action in revised plan |
|-------|------------|------------------------|
| α — Non-existent symbol references | `sessionState.sessions.has`, `session_deleted`, `createEmptyToolRegistry` | `sessions: SvelteMap` added to sessionState (Main Task 1); `session_deleted` relay variant added in server PR Task 1 with emission spec; `createToolRegistry` (existing) used — typo corrected |
| β — `composeChatState` under-specified | Key routing, Proxy traps | Full spec written: `ACTIVITY_KEYS` const for routing; all five Proxy traps (`get`, `set`, `has`, `ownKeys`, `getOwnPropertyDescriptor`) specified with semantics; new test `compose-chat-state-proxy.test.ts` |
| γ — `$state` factory double-wrap | | Factories return POJOs; `$state` wrap happens in `getOrCreate*` at insertion time only. Explicitly documented to prevent future drift. |
| δ — Dispatcher snippet bugs | messageId gate, notification_event | `advanceTurnIfNewMessage` gated on `"messageId" in event && event.messageId != null`; `notification_event` routed to GlobalEvent branch despite carrying sessionId; `PerSessionEventType` union excludes it by construction |
| ε — F2 too narrow | | Expanded to full 5-step cleanup sequence: finalize in-flight message, reset phase, clear currentMessageId + currentAssistantText + thinkingStartTime, drain liveEventBuffer |
| ζ — Commit-boundary compile breaks | Task 5/6 ordering, handleSessionList diff | Tasks 5 and 6 swapped: components migrate first (new Task 5), field deletions second (new Task 6). `handleSessionList` diff logic spelled out with search-payload guard. |
| η — Other replay paths missed | convertHistoryAsync, history_page, eventsHasMoreSessions | Task 3 expanded to cover both async commit paths with slot-capture + generation snapshot. `eventsHasMoreSessions` Set migrated to `SessionActivity.eventsHasMore: boolean` |
| θ — `replayGeneration` name | | Canonical per-session counter is `activity.replayGeneration`; module `deferredGeneration` renamed in Task 2, deleted in Task 3. Commit-message documentation required. |
| ι — `evictSessionSlot` wrong | | Concept DELETED. Task 6 uses `ensureLRUCap` (Tier 2 LRU only) + `clearSessionChatState` (both-tier teardown). Separate operations, separate names. |
| κ — `clearMessages` teardown | | Task 2 spec: `clearMessages` additionally clears current session's per-session Sets via `getOrCreateSessionActivity(sessionState.currentId)` |
| λ — `registerClearMessagesHook` signature | | Widened to `(fn: (sessionId: string \| null) => void) => void`; caller passes `sessionState.currentId`; hook body spec documented |
| μ — Adapter null-policy mismatch | | Task 2 adapter policy now matches Task 4 dispatcher: dev throw + prod counter `per_session_event_null_current_id`, no silent drop |
| ν — EMPTY_MESSAGES.toolRegistry methods | | Methods replaced with throwing stubs at module init (freeze doesn't stop function calls); tested in `empty-state-frozen.test.ts` |
| ξ — Test coverage gaps | | Enumerated per-task: handler-tier-contract, replay-per-slot-migration, concurrent-replay-same-session, convert-history-async-per-slot, concurrent-session-dispatch (6 scenarios), ghost-session-cleanup (4 scenarios), compose-chat-state-proxy, phase-0b-ordering, phase-0b-session-list-first, synthesized-status-sessionid |
| Q6 clarification | rapid-switch-mid-replay | Explicit walkthrough added to §Event routing showing slot-capture rule makes the scenario benign |

### Handing back to subagent-plan-audit for re-audit (Loop 3, final)

Per the fixer guardrail (max 3 loops), this is the final amend-pass. If Loop 3's re-audit returns clean, the plan moves to execution. If Loop 3 returns more Amend findings, they will be presented to the user wholesale rather than auto-patched — a signal that structural issues may remain.
