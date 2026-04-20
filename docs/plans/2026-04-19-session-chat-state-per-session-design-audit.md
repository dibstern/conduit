# Per-Session Chat State Design — Audit Synthesis

**Plan:** `docs/plans/2026-04-19-session-chat-state-per-session-design.md`
**Date:** 2026-04-20
**Auditors:** 7 parallel `plan-task-auditor` subagents, one per migration task.
**Per-task reports:** `docs/plans/audits/2026-04-19-session-chat-state-per-session-design-task-{1..7}.md`

## Outcome

**The plan cannot proceed to execution as written.** 7 auditors produced **72 Amend-Plan findings, 9 Ask-User findings, and 21 Accept findings** across the 7 migration tasks. The design doc is internally inconsistent in several places and omits required wiring that would produce silent correctness regressions if mechanically followed. Handing off to `plan-audit-fixer`.

### Counts per task

| Task | Amend Plan | Ask User | Accept | Report |
|------|-----------:|---------:|-------:|--------|
| 1 — Server: add `sessionId` | 18 | 1 | 4 | [task-1](audits/2026-04-19-session-chat-state-per-session-design-task-1.md) |
| 2 — Frontend: add new API, gated | 10 | 2 | 3 | [task-2](audits/2026-04-19-session-chat-state-per-session-design-task-2.md) |
| 3 — Frontend: flip handlers | 14 | 1 | 2 | [task-3](audits/2026-04-19-session-chat-state-per-session-design-task-3.md) |
| 4 — Frontend: flip dispatcher | 10 | 1 | 2 | [task-4](audits/2026-04-19-session-chat-state-per-session-design-task-4.md) |
| 5 — Frontend: delete globals | 9 | 1 | 5 | [task-5](audits/2026-04-19-session-chat-state-per-session-design-task-5.md) |
| 6 — Frontend: flip components | 11 | 2 | 2 | [task-6](audits/2026-04-19-session-chat-state-per-session-design-task-6.md) |
| 7 — Delete dead code | 0 | 1 | 3 | [task-7](audits/2026-04-19-session-chat-state-per-session-design-task-7.md) |
| **Totals** | **72** | **9** | **21** | — |

---

## Cross-cutting themes (must fix before execution)

These issues appear across multiple task audits — fixing them requires coordinated amendments.

### Theme A — Discriminated-union typing is wrong (Tasks 1, 2, 4)

The design doc (lines 77–80) proposes:
```ts
type PerSessionEvent = RelayMessage & { sessionId: string };
type GlobalEvent    = RelayMessage & { sessionId?: never };
```
Under TypeScript's structural typing, `A & { sessionId: string }` **widens** each variant to include the field rather than **narrowing** the union to variants that already had it. Without `sessionId?: never` on every global variant, `PerSessionEvent` and `GlobalEvent` overlap and provide zero protection.

**Ground truth:** `src/lib/shared-types.ts:269-474` — only two variants currently declare `sessionId: string` (`permission_request`, `result`); no variant declares `sessionId?: never`.

**Fix:** Use `type PerSessionEvent = Extract<RelayMessage, { sessionId: string }>` (plan-of-record already uses this form per Task 4 audit §5). Or inline the union enumeration. Requires Task 1 amendment to also specify which RelayMessage variants gain the field — see Theme B.

### Theme B — Audit list of events needing `sessionId` is incomplete (Task 1)

The plan enumerates 14 event types. Missing:
- `tool_content` (emitted per-tool, always session-scoped) — `shared-types.ts:295`
- `ask_user`, `ask_user_resolved`, `ask_user_error` — `shared-types.ts:308-314`
- `permission_request`, `permission_resolved` — decide per-session vs global
- `session_switched`, `history_page`, `session_forked` — already session-keyed via `id`/nested id, not `sessionId` — must normalize or explicitly carve out of `PerSessionEvent`
- `error` events emitted via `RelayError.toMessage()` at `src/lib/errors.ts:97-115` (no `sessionId` field today)

**Fix:** Exhaustive list + per-variant typing.

### Theme C — Design ↔ plan-of-record contradiction on live-event buffering (Tasks 4, 5)

Design doc asserts:
- Line 100: "live-event buffering dies. ... Delete the buffering code entirely."
- Line 138 (migration step 5): "Remove ... buffering code"

But the companion plan-of-record (`2026-04-19-session-chat-state-per-session-plan.md` Task 3.3, lines 1034-1064) **preserves** buffering by moving `liveEventBuffer` onto `SessionChatState`. Deleting the buffer as step 5 claims would reintroduce the cache-tail-then-live ordering bug (live `thinking_stop` mid-replay finalizing the thinking message, dropping cached `thinking_deltas`).

**Fix:** Design doc must be corrected — live-event buffering is **retained per-session** on `SessionChatState.liveEventBuffer`, not deleted. Update lines 100 and 138.

### Theme D — Firehose claim is false until Phase 0b lands (Task 4)

Design doc line 73: "Subscription is project-scoped firehose — the existing per-project relay stack at `/p/<slug>` already delivers all project activity."

**Ground truth:** `src/lib/relay/event-pipeline.ts:111-123,147,166` routes via `wsHandler.sendToSession(sessionId, msg)`, which iterates `registry.getViewers(sessionId)` (ws-handler.ts:197-206). Only clients that called `view_session` receive the event. Cross-session events are dropped today.

**Fix:** Design doc must reference **Phase 0b (server fanout broadening)** as an explicit prerequisite. Migration step 4 must declare it as a dependency.

### Theme E — SvelteMap does not deep-track stored `$state` values (Task 2)

Design doc line 43: "Each entry is a `$state` object so inner-field mutations propagate via Svelte 5 reactivity without requiring map re-lookup."

**Ground truth:** Svelte 5 docs explicitly say "values in a reactive map are _not_ made deeply reactive." Any `$derived` that reads via `sessionChatStates.get(id)` re-runs only when the key changes or `set`/`delete` fires — NOT when inner fields of a stored value mutate.

Field-level reactivity DOES work **only if** a consumer holds a direct reference to the stored `$state` proxy and reads its fields; `$derived(currentChat().phase)` works because `currentChat()` returns the stable proxy reference until `currentId` changes and `.phase` read passes through the proxy's get-trap.

**Fix:** Design doc must (a) correct the claim, (b) specify the access pattern (read through `currentChat().X`, not iterate `entries()` expecting deep reactivity), (c) mandate a test in Task 2 that asserts this invariant before Task 3 lands.

### Theme F — "Frozen `$state`" sentinel is contradictory (Task 2)

Design doc line 69: "`EMPTY_STATE` is a frozen `$state` ..." No `$state.frozen` primitive exists in Svelte 5. `Object.freeze` on a `$state` Proxy either throws on writes via the proxy or silently allows writes.

**Fix:** Replace with a plain frozen POJO typed as `SessionChatState` (or drop the sentinel and return `SessionChatState | null` — see Ask User #3 below).

### Theme G — Empty-string `sessionId`/`currentId` collision (Tasks 2, 4)

Design doc line 49: `sessionChatStates.get(sessionState.currentId ?? "") ?? EMPTY_STATE`. Pairs with Task 4's `getOrCreateSessionState(event.sessionId)`. The empty string `""` is a valid key; if any code path writes to `""` (ghost event, dev-mode-off path, test setup, broken server message), `currentChat()` silently returns that bogus slot instead of the sentinel.

**Fix:** Branch explicitly on null; assert `id !== ""` in `getOrCreateSessionState`.

### Theme H — F2 (streaming-idle clear) contradicts existing defensive code (Task 3)

Design doc §Reconciled fixes F2 (line 106): "clearing any non-idle phase when the server signals idle for that session."

**Ground truth:** `chat.svelte.ts:781-792` explicitly preserves `streaming` on idle: "Don't clear `streaming` — that phase is data-driven (delta events are actively arriving) and should only be cleared by a done/error." Applying F2 naively (per plan-of-record Task 2.7) clears streaming unconditionally — could cut a live stream short when a stale/misrouted `status:idle` arrives.

**Worse during Task 3 specifically:** while the adapter still routes everything to `currentChat()`, a `status:idle` event for session B arriving while currentId=A would clear A's streaming — a **new transient bug** introduced in the Task 3 commit.

**Fix:** Either (a) adopt F2 only AFTER Task 4 routes by `event.sessionId` (move F2 fix to Task 4's commit), or (b) implement F2 differently (clear streaming only when no delta has arrived within N ms).

### Theme I — F3 fix is under-specified (Task 1)

Plan says: "checking both `statusPoller.isProcessing(sessionId)` and `overrides.hasActiveProcessingTimeout(sessionId)`."

**Ground truth:** `patchMissingDone` at `src/lib/session/session-switch.ts:160-164` accepts only `statusPoller`. Making the fix needs: (a) third parameter `overrides`; (b) update call site at line 314 to pass `deps.overrides`; (c) widen guard to disjunction; (d) the inline `{ type: "done" }` at line 172 and the `{ type: "status" }` sends at 337-340 also need `sessionId` under the new contract. `SessionSwitchDeps.overrides` already declares `hasActiveProcessingTimeout` at line 71-73, so no interface change needed.

**Fix:** Task 1 must enumerate (a)-(d) explicitly.

### Theme J — `uiState.contextPercent` cross-store migration is undocumented (Tasks 3, 5, 6)

`contextPercent` today lives in `ui.svelte.ts` (separate store). Its writer is `updateContextPercent` (`ui.svelte.ts:314-316`), called from `chat.svelte.ts:680`, `ws-dispatch.ts:103,436`, `session.svelte.ts:16,354`. Readers: `InputArea.svelte:107,465`, `InfoPanels.svelte:28-38,217-224`, `InputArea.stories.ts:40,60,66,72`.

Migration step 5 says "Remove `uiState.contextPercent`" — but Tasks 3 and 6 don't document the dual-write or the component read migration.

**Fix:** Specify a dual-write strategy for Task 3 (write both `state.contextPercent` AND `uiState.contextPercent` until module field removed); enumerate all reader/writer sites in Task 5 and 6.

### Theme K — `historyState` pagination fields need to migrate (Tasks 5, 6)

`stashSessionMessages` (`chat.svelte.ts:1051-1068`) preserves `historyState.hasMore` and `historyState.messageCount`. Design's `SessionChatState` (lines 31-32) lists `historyHasMore` and `historyMessageCount` but the migration tasks don't state how `historyState` (read/written in `HistoryLoader.svelte:35-92`, `MessageList.svelte:225,233`) is migrated or kept.

**Fix:** Clarify — is `historyState` per-session or global? If per-session, HistoryLoader migrates too; if global, the pagination fields are duplicated and one source must win. (See Ask User #6.)

### Theme L — Ghost slots for deleted sessions + all-slots-non-idle (Tasks 4, 5)

Two related gaps:
1. `getOrCreateSessionState(event.sessionId)` will allocate a slot for any sessionId the server references, including a session the client just deleted. Eviction rule "never evict non-idle" keeps the ghost pulsing forever.
2. If the user has >20 sessions all non-idle, the LRU cannot evict anything and the map grows unbounded.

**Fix:** (a) Add a `clearSessionChatState(sessionId)` hook wired to `session_deleted` / `handleSessionList` drop path. (b) Decide the all-non-idle policy (see Ask User #4).

### Theme M — Mid-replay session-switch race (Task 3)

Today, `replayBatch` is module-scoped (`chat.svelte.ts:297`), so mid-replay session switches don't cross-contaminate the buffer. If `replayBatch` moves to `SessionChatState` (per plan-of-record Task 3.2) and handlers route through `currentChat()`, a rapid switch during replay makes handlers write into the **new** session's slot mid-stream.

**Fix:** Specify that during replay, handlers receive the `state` for the session being replayed (captured at `replayEvents` start), NOT `currentChat()`. Use a `forState(state, ...)` variant for replay paths.

### Theme N — Emitter-side sessionId injection is under-specified (Task 1)

Translator functions in `event-translator.ts:101-468` are pure and don't take `sessionId`. `relay-event-sink.ts:228-375` has `deps.sessionId` in scope but `translateCanonicalEvent` is a free function. `message-poller.ts:318,600` and `handlers/prompt.ts:73` each have their own emission path. The plan doesn't say where sessionId is injected (per translator, post-translation, in `push()` wrapper?).

**Fix:** Choose and spell out a single injection strategy (recommended: post-translation tag in callers). Also flag `event-translator.ts:446`'s `sessionId: props.sessionID ?? ""` fallback — under the new contract this will pass TypeScript but fail runtime assertions.

### Theme O — Handler/test migration is broader than "chat.svelte.ts" (Tasks 3, 5, 6)

- `handleToolContentResponse` lives in `ws-dispatch.ts:825-843`, not `chat.svelte.ts` — must be part of the handler flip.
- `registerClearMessagesHook` interaction with per-slot `replayGeneration` needs to be decided.
- 20+ tests import handlers directly (enumerated in Task 3 audit §8) and must migrate in the same commit or violate "each commit compiles and passes the existing test suite."
- Components missing from Task 6's migration list: `UserMessage.svelte` (4 reads + `$inspect`), `ChatLayout.svelte` (unused import), `HistoryLoader.svelte` (historyState).
- Storybook: `InputArea.stories.ts` (4 contextPercent writes + phaseTo* calls without sessionId) is not mentioned — only `MessageList.stories.ts` appears called out.

**Fix:** Enumerate every handler, test file, component, and story that requires migration. Cross-reference plan-of-record's expanded list or inline the full list.

---

## Ask User (9 items)

Decisions required before the plan is final.

1. **Task 1 (6.2):** Should Task 1 (server sessionId additions) land in a preceding PR or as the first commit of the main PR? Either works; must pick.
2. **Task 2 (3):** Hard-fail or silent no-op on empty-string sessionId in `getOrCreateSessionState`?
3. **Task 2 (4):** Should mutating `EMPTY_STATE` be a loud dev-mode error (recommended) or a silent no-op?
4. **Task 2 (9):** Should `currentChat()` return `SessionChatState | null` instead of a sentinel? Trades null-guards everywhere for explicit "no session" signal.
5. **Task 3 (6):** Should F2 fix land in Task 3 (handler flip commit) or Task 4 (dispatcher flip commit)? Currently bundled with Task 3, but during Task 3 the adapter still routes by `currentId` so idle events for session B can clear A's streaming — a new transient bug.
6. **Task 6 (3):** Is `historyState` (loading/hasMore/messageCount) per-session or global? Affects HistoryLoader migration.
7. **Task 6 (13):** Keep or delete the `$inspect` debug logger in `UserMessage.svelte:22-33`?
8. **Task 5 (all-non-idle):** What happens when all 20 LRU slots are non-idle? Options: grow unbounded (log warn), evict non-idle oldest (risks dropping live replay), refuse new slot (breaks switch).
9. **Task 7 (2):** Is "Net LOC should be negative" a hard merge gate or a heuristic? Excluding the 6 new invariant test files is a reasonable carve-out.

---

## Accept (21 items) — informational, no action needed

Pulled from the per-task reports; not reproduced here. See individual report "Accept" findings.

High-signal ones worth remembering:
- `$derived` at module scope is established in `chat.svelte.ts:73-81` — Task 2 pattern is precedent-supported.
- `sessionState.currentId` is reactive via `session.svelte.ts:20-27` $state.
- `ToolRegistry`, `LoadLifecycle`, `ChatPhase` all exist and importable.
- Root `tsconfig.json:24` includes both `src/` and `test/` — deleted symbols break test compile (Task 7 safety net).
- Lazy reconstruction path after eviction: `session.svelte.ts:336-360` → `view_session` → `handleViewSession` at `handlers/session.ts:178-212`. Confirmed intact.

---

## Key absolute paths cited across audits

Code the fixer will need to read:
- `src/lib/shared-types.ts:269-474` — RelayMessage union
- `src/lib/relay/event-translator.ts:101-468,446` — translator functions + empty-string fallback
- `src/lib/relay/event-pipeline.ts:111-123` — viewer-gated fanout
- `src/lib/relay/sse-wiring.ts:313-335` — post-translation routing context
- `src/lib/relay/message-poller.ts:318,598-601` — emission sites lacking sessionId
- `src/lib/provider/relay-event-sink.ts:80-122,228-375` — Claude SDK emission path
- `src/lib/handlers/prompt.ts:73,100-106` — user_message + error emission
- `src/lib/handlers/tool-content.ts:15-34` — tool_content emission
- `src/lib/errors.ts:97-115` — RelayError.toMessage
- `src/lib/server/ws-handler.ts:197-206` — sendToSession + getViewers
- `src/lib/session/session-switch.ts:160-175,314,333-340` — patchMissingDone + status send
- `src/lib/session/session-overrides.ts:71-73,224-227` — SessionSwitchDeps.overrides
- `src/lib/frontend/stores/chat.svelte.ts:190-1192` — entire module (handlers, Sets, state)
- `src/lib/frontend/stores/ws-dispatch.ts:137-843` — dispatcher, buffering, clearMessages hook, handleToolContentResponse
- `src/lib/frontend/stores/session.svelte.ts:12-360` — stash/restore/evict callers
- `src/lib/frontend/stores/ui.svelte.ts:74,314-316` — contextPercent
- `src/lib/frontend/components/chat/{MessageList,UserMessage,HistoryLoader}.svelte`
- `src/lib/frontend/components/input/InputArea.{svelte,stories.ts}`
- `src/lib/frontend/components/session/SessionItem.svelte:7,75-78`
- `src/lib/frontend/components/layout/ChatLayout.svelte:49`

Companion plan-of-record that resolves many of these issues but doesn't feed back into the design doc:
- `docs/plans/2026-04-19-session-chat-state-per-session-plan.md`

---

## Routing decision

**Hand off to `plan-audit-fixer`** with this synthesis. Amend-Plan and Ask-User findings outnumber Accepts by a large margin and include multiple load-bearing correctness issues (typing, buffering contradiction, firehose claim, SvelteMap reactivity, F2 timing). The plan cannot proceed to execution until these are resolved.

---

## Amendments Applied (2026-04-20)

User answered all 9 Ask-User questions; plan rewritten in place. See revised plan at `docs/plans/2026-04-19-session-chat-state-per-session-design.md` (Appendix C summarizes changes).

### User decisions

| Q | Question | Decision |
|---|----------|----------|
| 1 | Task 1 ordering | 1A — preceding PR (bundled with Phase 0b) |
| 2 | Empty-string sessionId policy | 2A — hard-fail (throw) |
| 3 | EMPTY_STATE mutation | 3A — loud error in dev AND prod (via `Object.freeze` + dev Proxy for better message) |
| 4 | `currentChat()` return type | 4A — keep sentinel `SessionChatState`, freeze-protected |
| 5 | F2 timing | 5B — defer F2 to Task 4 (dispatcher flip), where cross-session bleed is structurally impossible |
| 6 | `historyState` scope | 6A — per-session (Discord/Slack pattern) |
| 7 | `$inspect` in UserMessage | 7A — migrate, keep |
| 8 | All-slots-non-idle policy | **Two-tier structural redesign**: split by data weight. Activity (unbounded, small) + Messages (LRU-capped, heavy). Eliminates the corner case entirely. |
| 9 | Task 7 LOC gate | 9B+9C — heuristic only, reworded to exclude new test files |

### Amendments applied by theme

| Theme | Finding(s) | Amendment in revised plan |
|-------|------------|---------------------------|
| A — Discriminated union typing | Task 1 §2.1-2.3, Task 2 §14, Task 4 §5 | Switched to `Extract<RelayMessage, { sessionId: string }>` / `Exclude<...>`. §"Event routing by sessionId" documents the correct form and requires `sessionId?: never` on GlobalEvent variants. |
| B — Exhaustive event list | Task 1 §1.1-1.8 | Expanded to include `tool_content`, `ask_user`, `ask_user_resolved`, `ask_user_error`, `permission_request`, `permission_resolved`, `session_switched`, `session_forked`, `error` path via widened `RelayError.toMessage`, new `system_error` variant. |
| C — Buffering contradiction | Task 4 §2 | Design now states: live-event buffering is RETAINED on `SessionActivity.liveEventBuffer`. Task 5 text no longer deletes the buffer. |
| D — Firehose claim | Task 4 §1 | Phase 0b added as explicit prerequisite server change; bundled with Task 1 in a preceding PR. §"Event routing by sessionId" references Phase 0b. |
| E — SvelteMap reactivity | Task 2 §1, 14 | §"Reactivity contract" spells out the access pattern (read through stored `$state` proxy; never iterate `.entries()` expecting deep reactivity) and mandates `session-chat-state-reactivity.test.ts` in Task 2. |
| F — Frozen `$state` | Task 2 §2 | Replaced with plain frozen POJO `EMPTY_STATE`; `empty-state-frozen.test.ts` asserts strict-mode throws. |
| G — Empty-string collision | Task 2 §3, 11; Task 4 §3 | `getOrCreateSessionActivity`/`getOrCreateSessionMessages` hard-fail on `id === ""`; `currentChat()` branches on `id == null` explicitly instead of `.get(currentId ?? "")`. |
| H — F2 contradicts defensive code | Task 3 §5, 6, 14 | F2 moved from Task 3 to Task 4 (dispatcher flip commit). Under per-event routing, idle for session B cannot reach A's slot, so the defensive "don't clear streaming" rationale becomes obsolete safely. |
| I — F3 under-specified | Task 1 §3.1 | §"Reconciled fixes" enumerates four concrete sub-steps (signature widening, call-site update, disjunction, synthetic-event `sessionId` attachment). |
| J — `contextPercent` cross-store | Task 3 §9; Task 5; Task 6 §15 | Task 3 dual-writes `messages.contextPercent` AND `uiState.contextPercent`. Task 5 deletes `uiState.contextPercent` + `updateContextPercent`. Task 6 migrates component reads. |
| K — `historyState` migration | Task 5 (implicit); Task 6 §3 | `historyHasMore`, `historyMessageCount`, `historyLoading` added to `SessionMessages` (Tier 2). `HistoryLoader.svelte` + `MessageList.svelte` migrations called out explicitly in Task 6. Module-level `historyState` deleted in Task 5. |
| L — Ghost slots + all-non-idle | Task 4 §4; Task 5 all-non-idle | `clearSessionChatState` wired to `session_deleted` and `handleSessionList` drop path. Unknown-session guard in `routePerSession`. All-non-idle corner case dissolved by two-tier split (live state is in unbounded Tier 1; LRU bounds only the re-fetchable Tier 2). |
| M — Mid-replay race | Task 3 §16 | New Task 3 "flip replay path" captures `slot = getOrCreateSessionSlot(sessionId)` at `replayEvents` start and threads it through; does NOT read `currentChat()`. Per-slot `replayGeneration` short-circuits stale resolvers. |
| N — Emitter sessionId injection | Task 1 §4.1-4.5 | Single post-translation tag strategy spelled out per emission site (sse-wiring, relay-event-sink, message-poller, prompt, tool-content, session-switch, errors, cache replay). `event-translator.ts:446` fallback removed. |
| O — Broader migration scope | Task 3 §1-3, 8; Task 5; Task 6 §1-4 | Task 3 lists every handler (including non-`handle*` functions and `handleToolContentResponse` in ws-dispatch). Task 3 requires test migration in the same commit (20+ files enumerated). Task 6 adds `UserMessage.svelte`, `ChatLayout.svelte`, `HistoryLoader.svelte`, `InputArea.stories.ts`. |
| Q8 structural — Two-tier model | user decision | §"Core data model — two tiers" splits `SessionActivity` (unbounded) and `SessionMessages` (LRU). Sidebar reads Activity (never-evicted). Chat view reads composite via read-only Proxy. Dedup Sets in Tier 1 to survive Tier 2 evictions. Eviction policy simplified — no "never evict non-idle" rule needed. |

### Handing back to subagent-plan-audit for re-audit

Plan has been substantively revised. Re-audit will re-dispatch task auditors against the amended plan to verify findings are resolved and no new issues were introduced by the rewrite.
