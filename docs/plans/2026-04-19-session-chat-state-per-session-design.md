# Per-Session Chat State Design

**Date:** 2026-04-19
**Goal:** Eliminate a class of stale-activity-indicator bugs by making chat state per-session by construction. Replace the module-level `chatState` singleton with a `SvelteMap<sessionId, SessionChatState>`, route every incoming event by `sessionId`, and derive all UI reads from the current session's slot.
**Approach:** Hard-cut refactor within a single PR, organized into reviewable commits. Server adds `sessionId` to every per-session event before the frontend lands. No backward-compatibility shims.

## Triggering Bug

When the user navigates away from a completed, inactive Claude Agent SDK session and then back to it, the input-area bounce bar and the sidebar activity dot both show the session as active even though it is not.

Root cause is a mismatch between state semantics and state shape: the frontend's `chatState.phase` is semantically "the processing phase of the **current** session" but structurally a module-level global. The optimistic cache (`stashSessionMessages` / `restoreCachedMessages`) preserves messages + turn epoch + current message id across session switches but does **not** preserve phase, leaking whichever phase was last written into the next session's view until the server round-trip reconciles. A secondary bug — `handleStatus("idle")` only clears `processing`, not `streaming` — lets a stuck `streaming` phase survive reconciliation entirely.

See the investigation notes below for full fragility analysis (sections **Root Cause** and **Why Not Caught**).

## Design

### Core data model

```ts
// chat.svelte.ts
type SessionChatState = {
  messages: ChatMessage[];
  phase: ChatPhase;                 // idle | processing | streaming
  loadLifecycle: LoadLifecycle;     // empty | loading | committed | ready
  currentAssistantText: string;
  turnEpoch: number;
  currentMessageId: string | null;
  doneMessageIds: SvelteSet<string>;
  seenMessageIds: SvelteSet<string>;
  contextPercent: number;
  historyHasMore: boolean;
  historyMessageCount: number;
  toolRegistry: ToolRegistry;
  // Non-reactive internals (per-session)
  renderTimer: ReturnType<typeof setTimeout> | null;
  thinkingStartTime: number;
  replayGeneration: number;
};

const sessionChatStates = new SvelteMap<string, SessionChatState>();
```

All state that was previously a module-level global moves into this map: `chatState.*`, the `seenMessageIds` and `doneMessageIds` sets, the `liveEventBuffer`, `uiState.contextPercent`, and the `registry` singleton. Each entry is a `$state` object so inner-field mutations (`state.messages.push(...)`, `state.phase = "streaming"`) propagate via Svelte 5 reactivity without requiring map re-lookup.

### Access patterns

```ts
const _currentChat = $derived(
  sessionChatStates.get(sessionState.currentId ?? "") ?? EMPTY_STATE
);
export function currentChat(): SessionChatState { return _currentChat; }

export function getOrCreateSessionState(id: string): SessionChatState {
  let s = sessionChatStates.get(id);
  if (!s) {
    s = createEmptySessionChatState();
    sessionChatStates.set(id, s);
  }
  return s;
}

export function getSessionPhase(id: string): ChatPhase {
  return sessionChatStates.get(id)?.phase ?? "idle";
}
```

- **Chat view** (MessageList, InputArea, bounce bar, context bar): reads `currentChat()`. Reactivity tracks `sessionState.currentId` + the current slot's inner fields. Switching session re-derives cleanly.
- **Sidebar row** (SessionItem): reads `getSessionPhase(session.id)`. Each row subscribes only to its own slot. A delta for session B updates only B's row dot; A's row is untouched.
- **Empty sentinel**: `EMPTY_STATE` is a frozen `$state` returned when `currentId` is null or the slot is absent. Never mutated. Components always receive a valid `SessionChatState` shape — no defensive chaining.

### Event routing by sessionId (A2 — concurrent sessions)

The frontend receives events for every session in the current project and routes each to its own slot. Scope change: `view_session` becomes a pure UI hint ("show me this session's history + draft") and no longer controls subscription. Subscription is **project-scoped firehose** — the existing per-project relay stack at `/p/<slug>` already delivers all project activity.

**Server changes (prerequisite).** Every `RelayMessage` variant that mutates per-session state carries a `sessionId: string` field. A discriminated branch separates per-session events from genuinely global events:

```ts
type PerSessionEvent = RelayMessage & { sessionId: string };
type GlobalEvent    = RelayMessage & { sessionId?: never };
```

Event types that must gain `sessionId` (audit list, to be exhausted in the server PR): `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`, `tool_start`, `tool_executing`, `tool_result`, `result`, `done`, `error`, `status`, `user_message`, `part_removed`, `message_removed`.

**Dispatcher.** `ws-dispatch.ts` routes every per-session event to its target state:

```ts
function dispatchChatEvent(event: PerSessionEvent, ctx: DispatchContext) {
  const state = getOrCreateSessionState(event.sessionId);
  switch (event.type) {
    case "delta":        handleDelta(state, event); break;
    case "done":         handleDone(state, event);  break;
    case "status":       handleStatus(state, event); break;
    // ... etc
  }
}
```

Every handler takes `state: SessionChatState` as explicit first argument. No handler reads `currentChat()` or any module-level chat state — routing is structural.

**Consequence: live-event buffering dies.** The current `startBufferingLiveEvents` / `drainLiveEventBuffer` / `liveEventBuffer` machinery exists because live events arriving for the current session during replay of that same session had no slot to write to. With per-session state, a replay writes into session X's slot while live events for Y (or for X post-replay) write into their own slot. Delete the buffering code entirely.

### Reconciled fixes bundled with the refactor

Three latent bugs discovered during investigation are fixed as part of this refactor, because they would otherwise re-surface under the new shape:

- **F2 — `handleStatus("idle")` only clears `processing`.** Fixed by clearing any non-idle phase when the server signals idle for that session.
- **F3 — `patchMissingDone` guard omits the Claude SDK timeout signal.** Fixed by checking both `statusPoller.isProcessing(sessionId)` and `overrides.hasActiveProcessingTimeout(sessionId)`, matching the outgoing status computation's disjunction.
- **Module-level Sets (`seenMessageIds`, `doneMessageIds`) accumulate across sessions.** Fixed structurally by moving them into `SessionChatState`.

### Eviction policy

LRU cap at 20 entries (up from the current 10-entry message cache because the map now also holds live-receiving backgrounds). Eviction rule: **never evict a session whose phase is not `idle`** — doing so would drop live state. Evicted entries are lazily reconstructable from server events when the session is next viewed.

### View-layer changes

- `InputArea.svelte` bounce bar: `{#if isProcessing()}` unchanged at the call site; `isProcessing()` internal becomes `currentChat().phase !== "idle"`.
- `SessionItem.svelte` dot:

  ```ts
  const isProcessing = $derived(
    session.processing ||
    getSessionPhase(session.id) !== "idle"
  );
  ```

  No special case for `session.id === currentId`. The map read is already scoped to this row's session.
- `MessageList.svelte` and all other chat-area readers: `chatState.X` → `currentChat().X`.
- `uiState.contextPercent` reads migrate to `currentChat().contextPercent`; the write path (`updateContextFromTokens`) writes into the state bound to the event's sessionId.

## Migration

Single PR, structured as reviewable commits. Each commit compiles and passes the existing test suite.

1. **Server: add `sessionId` to every `PerSessionEvent`.** Types + emission sites. Landed in a preceding PR or as the first commit of this PR. Mechanical.
2. **Frontend: add new API, gated.** Introduce `sessionChatStates`, `createEmptySessionChatState`, per-session handler signatures, and `EMPTY_STATE`. Old `chatState` still exported and used everywhere. New code is dead.
3. **Frontend: flip handlers.** Rewrite every handler in `chat.svelte.ts` to take `state: SessionChatState` first. Wire via a temporary `dispatchToCurrent` adapter that routes everything to `currentChat()`. Behavior identical.
4. **Frontend: flip dispatcher.** `ws-dispatch.ts` reads `event.sessionId` and routes via `getOrCreateSessionState`. `dispatchToCurrent` adapter deleted. Requires step 1 landed. Dev-mode assertion `if (!event.sessionId) throw` added.
5. **Frontend: delete globals.** Remove `chatState` module export, module-level Sets, buffering code, `uiState.contextPercent`, `stashSessionMessages`, `restoreCachedMessages`. The LRU in `sessionChatStates` replaces the stash/restore cache. Rename `evictCachedMessages` to operate on the new map.
6. **Frontend: flip components.** Codemod-style replacement of `chatState.X` with `currentChat().X`. Sidebar row uses `getSessionPhase(session.id)`. Storybook stub updates in lockstep.
7. **Delete dead code.** Remove any shim residuals. Net LOC should be negative.

## Tests

**New invariant tests (must pass before merge):**

- `test/unit/stores/regression-phase-no-leak.test.ts` — switch A(streaming) → B(idle) → A asserts `currentChat().phase` reflects A's actual state at every tick; switch mid-turn asserts no bleed.
- `test/unit/stores/session-chat-state-routing.test.ts` — dispatch a delta for B while `currentId=A`; assert B's slot mutates, A's slot untouched, `currentChat()` untouched.
- `test/unit/stores/status-idle-clears-streaming.test.ts` — covers F2.
- `test/unit/stores/patchMissingDone-claude-sdk.test.ts` — covers F3 (server-side test).
- `test/unit/stores/session-map-eviction.test.ts` — LRU evicts oldest idle; never evicts non-idle.
- `test/unit/stores/concurrent-session-dispatch.test.ts` — interleaved deltas for A/B/C; each slot independent; per-session `replayGeneration` counters don't cross-contaminate.

**Migrated tests.** Every existing test that reads or writes `chatState.X` migrates to the per-session shape. No chat test retains module-global mutation.

**Storybook.** Add a multi-session sidebar story covering three sessions with varied phases; verify only the non-idle sessions pulse. Regression story mirroring the triggering bug (switch away then back with both sessions idle).

**E2E.** Playwright test: open project with two sessions (one active, one idle), navigate away from the idle session and back, assert bounce bar not visible on the idle session's view and that the idle session's sidebar dot is not pulsing.

## Risks

| Risk | Mitigation |
|------|------------|
| Server event emitted without `sessionId` → silent routing drop | TS exhaustive check on `PerSessionEvent` union; runtime dev assertion (`throw`) + prod telemetry counter. CI runs dev assertions on. |
| Project-scoped firehose bandwidth spike | Measure event rate per client before/after. Subscribe-list protocol held as fallback if a high-activity project shows regression. |
| SvelteMap reactivity gotchas (stale closure, missed notification) | Unit tests per reactivity pattern; Storybook visual checks. |
| Eviction drops state mid-turn for a backgrounded session | Structural rule: never evict non-idle. Covered by eviction test. |
| Multiple tool registries (one per session) raise memory | Registries are small (tool metadata only); eviction disposes registries along with their session. |
| Hard-cut codemod touches many files, hurts bisect granularity | Structured as 7 reviewable commits, each compiling and passing tests. |

## Non-Goals

- Todo store, permissions store, file-tree store — have the same singleton smell but are separate follow-ups.
- Multi-user / multi-tab synchronization beyond the existing `input_sync` mechanism.
- Persistence layer changes (SQLite projectors, event store) — unchanged.
- Provider adapter changes beyond `sessionId` tagging on emitted events.
- UI redesign — this is state-plumbing only.

## Known Debt After This Refactor

`permissions.svelte.ts`, `todo.svelte.ts`, `file-tree.svelte.ts` retain the same "global that is semantically per-session" shape. Each is a candidate for the same treatment. Out of scope here, tracked as follow-up.

---

## Appendix A: Root Cause (investigation notes)

Three "is processing" signals, all global:

1. `session.processing` — server flag per SessionInfo row.
2. `chatState.phase` — module-level global in `chat.svelte.ts`.
3. Server `status` message — per view, not per session.

**Bounce bar** (`InputArea.svelte:469`): `{#if isProcessing()}` → reads `chatState.phase`. Global.

**Sidebar dot** (`SessionItem.svelte:75-78`): `session.processing || (currentId===mine && chatIsProcessing())`. Second branch reads the same global.

Fragility points:

- **F1 — Optimistic restore skips phase.** `switchToSession` → `stashSessionMessages` / `restoreCachedMessages` persist messages, turn epoch, and current message id but not phase. The 50–500 ms window between optimistic restore and server reconciliation shows a stale bounce bar and stale sidebar dot.
- **F2 — `handleStatus("idle")` only clears `processing`.** `chat.svelte.ts:789`: if phase is `streaming` (common when cached events end mid-delta with no `done`), server's idle signal cannot clear it.
- **F3 — `patchMissingDone` asymmetric with outgoing status computation.** Server-side guard checks only `statusPoller.isProcessing(sessionId)`; outgoing status checks both the poller and `overrides.hasActiveProcessingTimeout(sessionId)`. Claude SDK turn in flight can slip through the patch guard.
- **F4 — Phase semantics say "current session's phase" but structure says "global."** No type-level constraint tying phase to `sessionState.currentId`.

## Appendix B: Why Not Caught

- **W1** — Vitest per-test module isolation masks global leaks; tests never exercise the full A → B → A cycle with phase assertions.
- **W2** — No invariant test asserts "phase matches current session's reality."
- **W3** — SessionItem stories drive `active` as a static prop; no story drives phase through a switch sequence.
- **W4** — Optimistic restore window (50–500 ms) is short; Playwright assertions land post-reconcile.
- **W5** — TypeScript has no way to say "phase belongs to a specific session," so no compiler pressure exists.
- **W6** — F2 (streaming-not-cleared) is the rarer variant; the common processing-cleared path IS handled, giving false confidence.
