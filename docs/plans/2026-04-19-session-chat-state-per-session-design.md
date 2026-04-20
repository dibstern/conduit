# Per-Session Chat State Design

**Date:** 2026-04-19 (amended 2026-04-20 per audit findings)
**Goal:** Eliminate a class of stale-activity-indicator bugs by making chat state per-session by construction. Replace the module-level `chatState` singleton with a two-tier per-session store (unbounded Activity + LRU-capped Messages), route every incoming event by `sessionId`, and derive all UI reads from the current session's slot.
**Approach:** Land in two PRs. A **preceding server PR** ships Phase 0b (broaden `/p/<slug>` fanout to a project-scoped firehose) and Task 1 (add `sessionId` to every `PerSessionEvent`, widen the `patchMissingDone` guard, plumb sessionId through `RelayError.toMessage`). Once the server PR is deployed, a **main frontend PR** lands as 7 reviewable commits. Each commit compiles and passes the existing suite. No backward-compatibility shims.

## Triggering Bug

When the user navigates away from a completed, inactive Claude Agent SDK session and then back to it, the input-area bounce bar and the sidebar activity dot both show the session as active even though it is not.

Root cause is a mismatch between state semantics and state shape: the frontend's `chatState.phase` is semantically "the processing phase of the **current** session" but structurally a module-level global. The optimistic cache (`stashSessionMessages` / `restoreCachedMessages`) preserves messages + turn epoch + current message id across session switches but does **not** preserve phase, leaking whichever phase was last written into the next session's view until the server round-trip reconciles. A secondary bug — `handleStatus("idle")` only clears `processing`, not `streaming` — lets a stuck `streaming` phase survive reconciliation entirely.

See the investigation notes below for full fragility analysis (sections **Root Cause** and **Why Not Caught**).

## Design

### Core data model — two tiers

Split the store by data weight, matching how Discord / Slack / Teams handle per-channel state in clients with many rooms.

```ts
// chat.svelte.ts

// Tier 1 — Activity. Unbounded. Small scalars + small Sets, ≪ 1 KB per session.
// Sidebar row, bounce bar, and every "is this session live" read come from here.
// Never evicted — background subagents (hidden rows) keep accurate activity forever.
// Dedup Sets live here too so a Tier 2 eviction does not cause delta duplication
// when the session is re-entered and its message history is re-hydrated.
type SessionActivity = {
  phase: ChatPhase;                          // idle | processing | streaming
  turnEpoch: number;
  currentMessageId: string | null;
  replayGeneration: number;
  doneMessageIds: SvelteSet<string>;
  seenMessageIds: SvelteSet<string>;
  liveEventBuffer: RelayMessage[] | null;    // deltas received while Tier 2 is evicted or mid-replay
  renderTimer: ReturnType<typeof setTimeout> | null;
  thinkingStartTime: number;
};

// Tier 2 — Messages. LRU-capped (default 20, configurable). Holds only data
// that is safely reconstructable from the server's event log. Eviction is
// free of correctness cost: the next `view_session` replays history, and
// SessionActivity.liveEventBuffer drains any deltas received meanwhile.
type SessionMessages = {
  messages: ChatMessage[];
  currentAssistantText: string;
  loadLifecycle: LoadLifecycle;              // empty | loading | committed | ready
  contextPercent: number;
  historyHasMore: boolean;
  historyMessageCount: number;
  historyLoading: boolean;                   // supersedes module-level historyState.loading
  toolRegistry: ToolRegistry;
};

const sessionActivity = new SvelteMap<string, SessionActivity>();
const sessionMessages = new SvelteMap<string, SessionMessages>();  // LRU-bumped on touch

// Composite read shape for the chat view. NEVER instantiated as storage.
type SessionChatState = SessionActivity & SessionMessages;
```

**Why split by weight.** Running many subagents (most hidden from the sidebar) pushes total session count well above 20. A single LRU-capped map forces the policy "never evict non-idle," which fails when all N slots are non-idle. The split eliminates the corner case: the bounded tier holds only re-fetchable data; the unbounded tier is cheap enough to hold forever.

**Why dedup Sets stay in Tier 1.** After a Tier 2 eviction + re-entry, server history rehydrates `messages[]`, then `liveEventBuffer` drains. If `doneMessageIds` / `seenMessageIds` had been evicted, a live delta that arrived during the eviction window could be applied twice (once via history replay, once via drain). Keeping dedup in Tier 1 prevents this.

**Reactivity contract.** `SvelteMap.get(id)` subscribes a caller to the key's presence; it does **not** deep-track mutations on the stored value. Reactivity on inner fields works only because each stored value is a `$state`-backed proxy — template reads like `currentChat().phase` pass through the proxy's get-trap and subscribe fine-grained. Consumers that iterate `.entries()` or `.values()` expecting deep reactivity on values will silently miss updates. Task 2 lands an explicit invariant test (see Tests) asserting that `$derived(currentChat().phase)` re-runs when a handler mutates the stored proxy's `phase` field.

### Access patterns

```ts
const EMPTY_ACTIVITY: SessionActivity = Object.freeze({
  phase: "idle",
  turnEpoch: 0,
  currentMessageId: null,
  replayGeneration: 0,
  doneMessageIds: new SvelteSet(),
  seenMessageIds: new SvelteSet(),
  liveEventBuffer: null,
  renderTimer: null,
  thinkingStartTime: 0,
}) as SessionActivity;

const EMPTY_MESSAGES: SessionMessages = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  currentAssistantText: "",
  loadLifecycle: "empty",
  contextPercent: 0,
  historyHasMore: false,
  historyMessageCount: 0,
  historyLoading: false,
  toolRegistry: createEmptyToolRegistry(),
}) as SessionMessages;

// Sentinel for chat-view consumers when no session is active. Plain frozen
// POJO — NOT $state. Strict-mode TypeError fires on any write attempt, in
// both dev and prod. Dev wraps EMPTY_STATE in an additional Proxy that
// throws with a clearer message ("attempted to mutate EMPTY_STATE —
// currentId is null. This is a routing bug in <caller>."). Prod relies on
// the freeze + telemetry to catch the error.
const EMPTY_STATE: SessionChatState = { ...EMPTY_ACTIVITY, ...EMPTY_MESSAGES };

// Read API — chat-view components
const _currentChat = $derived.by((): SessionChatState => {
  const id = sessionState.currentId;
  if (id == null) return EMPTY_STATE;
  const activity = sessionActivity.get(id);
  if (!activity) return EMPTY_STATE;
  const messages = sessionMessages.get(id) ?? EMPTY_MESSAGES;
  return composeChatState(activity, messages); // read-only Proxy over the two tiers
});
export function currentChat(): SessionChatState { return _currentChat; }

// Read API — sidebar row (per-row, independent subscription)
export function getSessionPhase(id: string): ChatPhase {
  return sessionActivity.get(id)?.phase ?? "idle";
}

// Write API — handlers. Hard-fail on empty sessionId; every caller has a
// concrete id by contract (dispatcher uses event.sessionId, view paths
// use sessionState.currentId after UI action). An empty id is always a bug.
export function getOrCreateSessionActivity(id: string): SessionActivity {
  if (id === "") throw new Error("getOrCreateSessionActivity: empty sessionId");
  let a = sessionActivity.get(id);
  if (!a) { a = $state(createEmptySessionActivity()); sessionActivity.set(id, a); }
  return a;
}

export function getOrCreateSessionMessages(id: string): SessionMessages {
  if (id === "") throw new Error("getOrCreateSessionMessages: empty sessionId");
  let m = sessionMessages.get(id);
  if (!m) {
    m = $state(createEmptySessionMessages());
    sessionMessages.set(id, m);
    ensureLRUCap();  // evicts least-recently-used if > cap
  }
  touchLRU(id);
  return m;
}

// Convenience: allocate both tiers + touch LRU. Handlers use this.
export function getOrCreateSessionSlot(id: string): { activity: SessionActivity; messages: SessionMessages } {
  return { activity: getOrCreateSessionActivity(id), messages: getOrCreateSessionMessages(id) };
}

// Teardown — called on session_deleted and when handleSessionList drops a row.
export function clearSessionChatState(id: string): void {
  sessionActivity.delete(id);
  sessionMessages.delete(id);
}
```

`composeChatState(activity, messages)` returns a `Proxy` with a read-only `get` trap that routes field reads to the right tier (activity keys → activity proxy, messages keys → messages proxy). Writes throw. The proxy preserves fine-grained reactivity because inner reads pass through the underlying `$state` proxies on each access.

- **Chat view** (MessageList, InputArea, bounce bar, context bar, UserMessage): reads `currentChat()`. Reactivity tracks `sessionState.currentId` + both tier proxies' inner fields. Switching session re-derives cleanly.
- **Sidebar row** (SessionItem): reads `getSessionPhase(session.id)` only. Each row subscribes only to its session's Activity slot. A delta for session B updates only B's row dot; A's row is untouched. Tier 2 eviction is invisible to sidebar rendering.
- **Empty sentinel**: `EMPTY_STATE` is a plain frozen POJO (not `$state`). Returned when `currentId` is null or the slot is absent. Mutation attempts throw via strict-mode `TypeError` in both dev and prod; dev additionally wraps in a Proxy with a clearer error message.

### Event routing by sessionId (A2 — concurrent sessions)

The frontend receives events for every session in the current project and routes each to its own slot. Scope change: `view_session` becomes a pure UI hint ("show me this session's history + draft") and no longer controls subscription.

**Prerequisite — Phase 0b (preceding PR).** Today `applyPipelineResult` (`src/lib/relay/event-pipeline.ts:111-123`) routes per-session events via `wsHandler.sendToSession(sessionId, msg)`, which only delivers to clients that called `view_session` (`ws-handler.ts:197-206`). Phase 0b broadens the per-project relay at `/p/<slug>` to a **project-scoped firehose** that delivers every per-session event to every connected client for that project. Without Phase 0b, Task 4 silently drops all cross-session events.

**Server changes — Task 1 (preceding PR).** Every `RelayMessage` variant that mutates per-session state carries a required `sessionId: string` field. Use the `Extract` form for type narrowing (an intersection `RelayMessage & { sessionId: string }` widens rather than narrows under structural typing):

```ts
type PerSessionEvent = Extract<RelayMessage, { sessionId: string }>;
type GlobalEvent    = Exclude<RelayMessage, { sessionId: string }>;
```

Event types that must gain `sessionId: string` (exhaustive list, derived from `src/lib/shared-types.ts:269-474` + all emission sites):

- Already required: `permission_request`, `result`.
- Already optional (promote to required): `ask_user_resolved`, `notification_event`, `history_page`, `provider_session_reloaded`.
- Must be added: `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`, `tool_start`, `tool_executing`, `tool_result`, `tool_content`, `done`, `error`, `status`, `user_message`, `part_removed`, `message_removed`, `ask_user`, `ask_user_error`, `permission_resolved`.
- Session-keyed via a different field today — normalize to `sessionId`: `session_switched` (currently `id`), `session_forked` (currently `session.id`). `history_page` already uses `sessionId`.
- New `system_error` variant for errors that are genuinely session-less (HANDLER_ERROR, INSTANCE_ERROR paths in `handleChatError`). Plan Task 0.4 plumbs `sessionId` through `RelayError.toMessage(sessionId)` for the session-scoped path.

**Emitter-side injection — single post-translation tag strategy.** Translator functions in `src/lib/relay/event-translator.ts:101-468` are pure and do not take `sessionId`. Rather than thread `sessionId` into every translator signature, tag at the call site after translation:

- `src/lib/relay/sse-wiring.ts:313-335` — map translator results through `tagWithSessionId(eventSessionId)` before dispatch. Replace `translateMessageUpdated`'s fallback `sessionId: props.sessionID ?? ""` with fail-fast + log-and-skip when `sessionID` is absent.
- `src/lib/provider/relay-event-sink.ts` — in `push()`, after `translateCanonicalEvent(event)` returns, map per-session variants through `{ ...m, sessionId: deps.sessionId }` before iterating `send()`.
- `src/lib/relay/message-poller.ts:318, 598-601` — attach `sessionId: this.activeSessionId!` at construction; guard against null `activeSessionId` explicitly.
- `src/lib/handlers/prompt.ts:73` — `activeId` is already in scope; attach directly.
- `src/lib/handlers/tool-content.ts:15-34` — tool invocation already carries session; attach at emission.
- `src/lib/session/session-switch.ts:170-174, 337-340` — synthesized `done` and `status` events get `sessionId` inline.
- `src/lib/errors.ts:97-115` — `RelayError.toMessage(sessionId: string)` signature widened; call sites that emit session-scoped errors pass it.
- **Cache replay:** when reconstructing `session_switched.events: RelayMessage[]` from cached events, backfill `sessionId` on each per-session variant (cache predates this contract).

**Dispatcher.**

```ts
// src/lib/frontend/stores/ws-dispatch.ts
function dispatchEvent(event: RelayMessage, ctx: DispatchContext) {
  if (isPerSessionEvent(event)) {
    routePerSession(event, ctx);
    return;
  }
  // Existing switch for GlobalEvent variants (session_list, project_init, pty_*, etc.)
  dispatchGlobalEvent(event, ctx);
}

function routePerSession(event: PerSessionEvent, ctx: DispatchContext) {
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
    if (isDev()) throw new Error(`routePerSession: missing sessionId on ${event.type}`);
    ctx.telemetry.counter("per_session_event_missing_sessionid", { type: event.type });
    return;
  }
  // Drop ghost events for sessions the client no longer knows about.
  // Prevents allocation of a phantom slot that would pulse in the sidebar.
  if (!sessionState.sessions.has(event.sessionId)) {
    ctx.telemetry.counter("per_session_event_unknown_session", { type: event.type });
    return;
  }
  const { activity, messages } = getOrCreateSessionSlot(event.sessionId);
  advanceTurnIfNewMessage(activity, event.messageId);  // scoped to event's session, not current
  switch (event.type) {
    case "delta":        handleDelta(activity, messages, event); break;
    case "done":         handleDone(activity, messages, event); break;
    case "status":       handleStatus(activity, messages, event); break;
    case "thinking_start": handleThinkingStart(activity, messages, event); break;
    // ... exhaustive; default case is a never-narrowing exhaustiveness assertion
  }
}
```

Dev-mode detection uses the repo's established pattern `(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true` (see `chat.svelte.ts:198` and `docs/PROGRESS.md:770` for the tsconfig rationale). In prod the assertion does not throw — it increments a telemetry counter and returns. Silent dropping is unacceptable; the counter is monitored as a SEV.

Every per-session handler takes `(activity: SessionActivity, messages: SessionMessages, event)` as explicit first arguments. No handler reads `currentChat()` or any module-level chat state — routing is structural.

**Live-event buffering — retained, moved per-session.** The existing `liveEventBuffer` exists because live events arriving for session X during replay of X had no place to go. Under the new shape, buffering is preserved on `SessionActivity.liveEventBuffer`:

- Dispatcher routes live deltas to `activity.liveEventBuffer` while a replay for that session is in flight (`replayGeneration` bumped).
- `replayEvents(sessionId, ...)` captures the Activity + Messages slots at start and applies buffered deltas at end.
- Tier 2 eviction does not drop the buffer (it lives in Tier 1). When the user re-enters an evicted session, `view_session` replays history, then the buffer drains.

**Mid-replay session switches.** Handlers invoked during replay must write into the slot for the **session being replayed**, not `currentChat()`. The `replayEvents(sessionId, ...)` entry point resolves `const slot = getOrCreateSessionSlot(sessionId)` once and threads `slot` through every dispatch; it does NOT use `dispatchToCurrent` or `currentChat()`. This prevents rapid session switches from cross-contaminating slots mid-stream. Per-slot `replayGeneration` protects against stale promise resolutions — a resolver that sees `slot.activity.replayGeneration` differ from the captured value short-circuits.

### Reconciled fixes bundled with the refactor

Three latent bugs discovered during investigation are fixed as part of this refactor, because they would otherwise re-surface under the new shape:

- **F2 — `handleStatus("idle")` only clears `processing`, not `streaming`.** Fixed by clearing any non-idle phase when the server signals idle for that session. **Lands in Task 4 (dispatcher flip), NOT Task 3.** Rationale: during Task 3 the adapter still routes by `currentId`, so a `status:idle` event for session B arriving while `currentId=A` would clear A's streaming — a new transient cross-session bleed. Once Task 4 routes by `event.sessionId`, the cross-session bleed is structurally impossible and F2 becomes safe to land.
- **F3 — `patchMissingDone` guard omits the Claude SDK timeout signal.** `patchMissingDone` at `src/lib/session/session-switch.ts:160-175` currently checks only `statusPoller?.isProcessing(sessionId)`. The fix:
  1. Widen the signature to accept `overrides: SessionSwitchDeps["overrides"]` as a third parameter.
  2. Update the single call site at `session-switch.ts:314` to pass `deps.overrides`.
  3. Widen the guard to `statusPoller?.isProcessing(sessionId) || overrides?.hasActiveProcessingTimeout(sessionId)`, matching the outgoing-status disjunction at `session-switch.ts:334-336`.
  4. Add `sessionId` to the inline synthetic `{ type: "done", code: 0 }` at `session-switch.ts:172` and to the `status` sends at `session-switch.ts:337-340`. Under the new contract these events require the field.

  `SessionSwitchDeps.overrides` at `session-switch.ts:71-73` already declares `hasActiveProcessingTimeout`, so no interface change is needed beyond the parameter list widening.
- **Module-level Sets (`seenMessageIds`, `doneMessageIds`) accumulate across sessions.** Fixed structurally by moving them into `SessionActivity`.

### Eviction policy

LRU cap **20 entries on Tier 2 (Messages)**. Tier 1 (Activity) is unbounded.

- Active `currentId` is the MRU entry; LRU never evicts it.
- Any other Tier 2 slot is evictable regardless of phase. Eviction drops `messages[]`, `currentAssistantText`, `toolRegistry`, `contextPercent`, `historyHasMore`, `historyMessageCount`, `historyLoading`, `loadLifecycle` — all safely rebuildable from the server event log.
- `SessionActivity.liveEventBuffer` continues to accumulate deltas for sessions whose Tier 2 is evicted. When the user re-enters, `view_session` rehydrates Tier 2 from server history and drains the buffer into `messages[]`.
- `clearSessionChatState(id)` deletes from both tiers. Called from `session_deleted` listener and from `handleSessionList` when a previously-known session disappears from the list.

**No "all slots non-idle" corner case.** The original single-map design needed the rule "never evict non-idle" to avoid dropping live state. The two-tier split removes live state from the LRU — live state is in Tier 1, which is unbounded. The memory cost of Tier 1 per session is a handful of scalars + two small Sets (≪ 1 KB); scaling to hundreds of background subagents is fine.

### View-layer changes

- **`InputArea.svelte` bounce bar**: `{#if isProcessing()}` unchanged at the call site. `isProcessing()` internal becomes `currentChat().phase !== "idle"`.
- **`SessionItem.svelte` dot**:
  ```ts
  const isProcessing = $derived(
    session.processing ||
    getSessionPhase(session.id) !== "idle"
  );
  ```
  OR is intentional — either signal suffices. If the LRU has dropped Tier 2 but the server says `processing`, the row still pulses. If the per-session phase has updated before the server flag, the row still pulses. No special case for `session.id === currentId`. The map read is scoped to this row's session.
  Delete the `import { isProcessing as chatIsProcessing }` import (used in the OLD OR); replace with `import { getSessionPhase } from "../../stores/chat.svelte.js"`.
- **`MessageList.svelte` and all chat-area readers**: `chatState.X` → `currentChat().X`. Local `const` bindings (e.g., `const _len = chatState.messages.length`) rewrite on the RHS only: `const _len = currentChat().messages.length`. Inside `$derived(...)`, replace with the call form: `$derived(currentChat().phase)` — do NOT hoist `currentChat()` to a const outside the derived; each derived must re-call to pick up `currentId` changes. `untrack(() => isProcessing())` guards continue to work since `untrack` disables reactivity regardless of implementation.
- **`UserMessage.svelte`**: reads `chatState.turnEpoch`, `chatState.currentMessageId`, `chatState.phase` at lines 9, 19, 27, 29, 30. Migrate all to `currentChat().X`. The `$inspect` debug logger at lines 22-33 is kept (migrated to read `currentChat().X`) — it remains load-bearing for in-dev shimmer tracing.
- **`HistoryLoader.svelte`**: reads and writes `historyState.hasMore` / `historyState.loading` / `historyState.messageCount` at lines 35-92. Migrate to `currentChat().historyHasMore` / `historyLoading` / `historyMessageCount`. `historyState` module export is deleted in Task 5.
- **`ChatLayout.svelte:49`**: `import { chatState, clearMessages }` — delete `chatState` from the import (unused after codemod; `clearMessages` stays).
- **`MessageList.svelte:47-49`**: `() => chatState.loadLifecycle` getter passed to `createScrollController` rewrites to `() => currentChat().loadLifecycle` — keep the arrow; do NOT inline.
- **`uiState.contextPercent` reads migrate to `currentChat().contextPercent`**. Readers: `InputArea.svelte:107,465` (2 sites), `InfoPanels.svelte:28-38,217-224` (derive-chain — verify source). Writers: `updateContextPercent` helper at `ui.svelte.ts:314-316` is deleted; the write path (`updateContextFromTokens`) writes into `messages.contextPercent` on the event's sessionId directly.
- **Storybook**: `MessageList.stories.ts` rewrites `chatState.messages` → `currentChat().messages` with a test sessionId. `InputArea.stories.ts:40,60,66,72` rewrites `uiState.contextPercent = N` to `getOrCreateSessionMessages(testId).contextPercent = N`; `phaseToIdle()`/`phaseToProcessing()` calls gain the test sessionId argument.

## Migration

Land in two PRs.

### Preceding server PR (Phase 0b + Task 1)

**Phase 0b — broaden project relay fanout.** `src/lib/relay/event-pipeline.ts` and `src/lib/server/ws-handler.ts`: change per-session-event fanout from `sendToSession(sessionId, msg)` (viewer-gated) to a project-scoped broadcast. Every client connected to `/p/<slug>` receives every per-session event for that project. `view_session` no longer gates delivery — it remains only for fetching history. This PR is mechanical server-side.

**Task 1 — add `sessionId` to every `PerSessionEvent` + F3 fix + RelayError plumbing.**

1. Type changes in `src/lib/shared-types.ts`: promote `sessionId` to required on the 17 variants listed above. Add `sessionId?: never` on GlobalEvent variants that don't carry it (so `Extract<RelayMessage, { sessionId: string }>` narrows correctly).
2. Post-translation tag at emission sites: `sse-wiring.ts`, `relay-event-sink.ts`, `message-poller.ts`, `prompt.ts`, `tool-content.ts`, `session-switch.ts` (2 inline synthesizers), `event-translator.ts:446` fallback removed.
3. F3 fix: widen `patchMissingDone` signature + guard + update call site + attach `sessionId` to synthesized events. Details in §Reconciled fixes.
4. `RelayError.toMessage(sessionId: string)` — signature widening; update all callers to pass sessionId for session-scoped errors. Introduce `system_error` variant for legitimately session-less errors (HANDLER_ERROR, INSTANCE_ERROR) emitted via `wsHandler.broadcast()`.
5. Cache replay: `session-switch.ts` backfills `sessionId` onto cached events before emission.

**Server PR tests:**
- `test/unit/relay/per-session-event-has-sessionid.test.ts` — contract test exercising each emission site and asserting `sessionId` presence on every `PerSessionEvent` variant.
- `test/unit/session/patchMissingDone-claude-sdk.test.ts` — covers F3 (poller idle + processingTimeout active → patch skipped).

### Main frontend PR (7 reviewable commits)

Each commit compiles and passes the existing test suite.

**1. Frontend: add new two-tier API, gated.**

- Introduce `sessionActivity`, `sessionMessages` maps; `SessionActivity`, `SessionMessages`, `SessionChatState` types; `createEmptySessionActivity`, `createEmptySessionMessages` factories (each returns a `$state(...)` proxy); `EMPTY_ACTIVITY`, `EMPTY_MESSAGES`, `EMPTY_STATE` (plain frozen POJOs); `composeChatState(a, m)` read-only Proxy; `getOrCreateSessionActivity`, `getOrCreateSessionMessages`, `getOrCreateSessionSlot`, `getSessionPhase`, `clearSessionChatState`, `currentChat()` `$derived`, LRU (`touchLRU`, `ensureLRUCap`).
- Import `SvelteMap`, `SvelteSet` from `svelte/reactivity` (first use in `src/`).
- Old `chatState` still exported and used everywhere. New code is dead — no production call site invokes it.
- Old module-level globals (`registry`, `seenMessageIds`, `doneMessageIds`, `renderTimer`, `thinkingStartTime`, `deferredGeneration`) remain unchanged.
- **Tests landed in this commit:**
  - `test/unit/stores/session-chat-state-shape.test.ts` — asserts `createEmptySessionActivity()`+`createEmptySessionMessages()` together produce every field of `SessionChatState` (drift check).
  - `test/unit/stores/session-chat-state-reactivity.test.ts` — mutates `getOrCreateSessionActivity(id).phase`; asserts a `$derived(currentChat().phase)` observer re-runs. If this fails, the SvelteMap-reactivity assumption is wrong and Task 3 cannot ship.
  - `test/unit/stores/empty-state-frozen.test.ts` — asserts `EMPTY_STATE.phase = "streaming"` throws; asserts `EMPTY_STATE.messages.push(x)` throws; asserts dev Proxy emits the clearer error message.
  - Rename disambiguation: if `replayGeneration` is a rename of the existing `deferredGeneration`, document in the commit message; if distinct, document the new concept.

**2. Frontend: flip handlers (in-`chat.svelte.ts` + `ws-dispatch.ts`).**

- Rewrite every handler to take `(activity: SessionActivity, messages: SessionMessages, event)` as the leading arguments (some only need one tier — typed accordingly).
- Full handler list (cross-reference v2 plan §"Expanded handler list"): `handleDelta`, `handleDone`, `handleStatus`, `handleThinkingStart`, `handleThinkingDelta`, `handleThinkingStop`, `handleToolStart`, `handleToolExecuting`, `handleToolResult`, `handleResult`, `handleError`, `handlePartRemoved`, `handleMessageRemoved`, `handleUserMessage`, plus non-`handle*` functions: `advanceTurnIfNewMessage`, `addUserMessage`, `ensureSentDuringEpochOnLastUnrespondedUser`, `flushAndFinalizeAssistant`, `flushAssistantRender`, `updateContextFromTokens`, `applyToolCreate`, `applyToolUpdate`, `setMessages`, `getMessages`, `requestScrollOnNextContent`, `consumeScrollRequest`, `cancelDeferredMarkdown`, `renderDeferredMarkdown`, `flushPendingRender`, phase helpers (`phaseToIdle`, `phaseToProcessing`, `phaseToStreaming`, `phaseToStartReplay`, `phaseToEndReplay`, `phaseToReset`), `prependMessages`, `seedRegistryFromMessages`, `addSystemMessage`, `beginReplayBatch`, `commitReplayFinal`, `discardReplayBatch`, `consumeReplayBuffer`, `getReplayBuffer`, `isEventsHasMore`.
- Also flip `handleToolContentResponse` in `ws-dispatch.ts:825-843` (writes to `chatState.messages` directly today).
- `handleInputSyncReceived` (`chat.svelte.ts:162-179`) is **NOT** flipped — it writes to the cross-tab `inputSyncState`, which is inherently not per-session.
- `registerClearMessagesHook` (`chat.svelte.ts:292`): stays module-scoped. It fires on "some slot was cleared" and nulls the appropriate per-slot buffer — hook body receives the sessionId being cleared.
- Handler signatures use narrowed message types preserved via generic: `dispatchToCurrent<T extends PerSessionEvent>(fn: (activity, messages, msg: T) => void, msg: T)`.
- Wire through a temporary `dispatchToCurrent` adapter that routes to `getOrCreateSessionSlot(sessionState.currentId)`. The adapter early-returns on null `currentId` with a dev warning (no EMPTY_STATE writes).
- **Dual-write `contextPercent`** during this commit: `handleResult`/`updateContextFromTokens` writes both `messages.contextPercent` AND legacy `uiState.contextPercent`. Stripped in Task 5.
- Module-level Sets (`seenMessageIds`, `doneMessageIds`) move to `SessionActivity` in this commit (handlers use `activity.seenMessageIds` etc.). Module exports stay for the old code path; Task 5 deletes them.
- `replayBatch`, `replayBuffers`, `eventsHasMoreSessions`, `renderTimer`, `thinkingStartTime`, `deferredGeneration` stay module-scoped in this commit; move to `SessionActivity` in Task 4's replay-path flip (see Task 4 below) to avoid mid-replay races during Task 3.
- **Test migration in the same commit:** 20+ test files import handlers directly (enumerated in task-3 audit §8). Every such test migrates to the new signature. See Tests § below for the full list.
- **F2 is NOT applied in this commit** — see Task 4.

**3. Frontend: flip replay path + buffer to per-slot.**

(Was "Migration step 3" in the original plan; renumbered to accommodate the replay work.)

- Move `replayBatch`, `replayBuffers`, `liveEventBuffer`, `renderTimer`, `thinkingStartTime`, `replayGeneration` onto `SessionActivity`.
- `replayEvents(sessionId, ...)` captures `const slot = getOrCreateSessionSlot(sessionId)` at start and threads `slot` through all internal dispatches; does NOT use `currentChat()` or `dispatchToCurrent`.
- Live-event buffer: dispatcher accumulates deltas in `activity.liveEventBuffer` while `activity.replayGeneration` is active; `replayEvents` drains at end.
- `registerClearMessagesHook` callback: clears the per-session `activity.liveEventBuffer` and bumps `activity.replayGeneration`.

**4. Frontend: flip dispatcher + F2 fix.**

- `ws-dispatch.ts` implements the two-tier `dispatchEvent` with `routePerSession(event)` (see §Event routing). `dispatchToCurrent` adapter deleted.
- Dev-mode assertion on missing/empty `sessionId` using repo's `(import.meta as { env?: { DEV?: boolean } }).env?.DEV` pattern. Prod: telemetry counter, no throw.
- Unknown-session guard: drop events for sessionIds not in `sessionState.sessions`; telemetry counter increments.
- **F2 fix applies here:** `handleStatus(activity, messages, event)` with `event.status === "idle"` sets `activity.phase = "idle"` unconditionally. Safe now because routing is by `event.sessionId` — an idle for session B can no longer reach A's slot.
- Requires preceding server PR landed (Phase 0b + Task 1).

**5. Frontend: delete globals + wire teardown.**

- Remove `chatState` module export; delete module-level `seenMessageIds`, `doneMessageIds`, `liveEventBuffer` globals; delete `stashSessionMessages`, `restoreCachedMessages` (replaced by the LRU); rename `evictCachedMessages` → `evictSessionSlot` operating on both tiers.
- Delete `uiState.contextPercent` field and `updateContextPercent` helper; all callers (`ws-dispatch.ts:103,436`, `session.svelte.ts:16,354`, `chat.svelte.ts:20,680`) were dual-writing and now write only `messages.contextPercent`.
- Delete the module-level `historyState` object; migrate `historyLoading`, `historyHasMore`, `historyMessageCount` to `SessionMessages`. Callers in `HistoryLoader.svelte` and `MessageList.svelte:225,233` migrate to `currentChat().X`.
- Wire `clearSessionChatState` to a new frontend listener: on `session_deleted` relay event, and inside `handleSessionList` when a previously-known sessionId is no longer in the list. Guards against ghost slots.
- New slot factory defaults `contextPercent: 0`, `historyHasMore: false`, `historyMessageCount: 0`, `historyLoading: false` (mirrors `ui.svelte.ts:74` and `session.svelte.ts:354` init behavior).
- **Test migration:** `test/unit/stores/turn-epoch-queued-pipeline.test.ts:55-56,424-429` imports stash/restore directly — migrate or delete those assertions. `test/unit/stores/chat-store.test.ts:687,697,746,753` references `doneMessageIds` — verify assertions still work against the per-session Sets.

**6. Frontend: flip components + stories.**

- Codemod `chatState.X` → `currentChat().X` across all `.svelte` files and `*.stories.ts`.
- Explicit component list: `MessageList.svelte` (lines 47-49, 89, 92, 110-112, 123, 180, 189, 225, 233), `InputArea.svelte` (lines 107, 465, 229), `SessionItem.svelte` (lines 7, 75-78 — delete import, replace dot logic), `UserMessage.svelte` (lines 9, 19, 22-33 `$inspect`, 27, 29, 30), `ChatLayout.svelte` (line 49 import cleanup), `HistoryLoader.svelte` (lines 35-92 — `historyState.*` → `currentChat().X`), `MessageList.stories.ts`, `InputArea.stories.ts` (lines 40, 60, 66, 72).
- Codemod pitfalls (verified absent in `.svelte` files but called out):
  - Aliasing (`const cs = chatState`): zero instances.
  - Destructuring (`{ phase } = chatState`): zero instances.
  - RHS-of-const bindings like `const _len = chatState.messages.length`: rewrite RHS only.
  - `$derived(chatState.X)` → `$derived(currentChat().X)` — the call form; do NOT hoist.
  - Getter arrows `() => chatState.X` → `() => currentChat().X` — keep the arrow.
- **Tests landed in this commit:**
  - `test/unit/components/per-session-component-isolation.test.ts` — for each migrated component (InputArea, SessionItem, MessageList, UserMessage, HistoryLoader), mount with `currentId=A`, mutate B's slot, assert no re-render.
  - Multi-session sidebar Storybook story covering three sessions with varied phases; verify only the non-idle sessions pulse.
  - Regression Storybook story mirroring the triggering bug (switch away then back with both sessions idle).

**7. Delete dead code.**

- Remove any shim residuals: `dispatchToCurrent` (already deleted in Task 4, verify clean), `CHAT_EVENT_TYPES` constant if orphaned, unused imports in `session.svelte.ts:12-13`, `.stories.ts` mocks of the old `chatState`, `@deprecated` comments referencing old state.
- "Net LOC should be roughly flat or negative, excluding new test files." Heuristic gate for reviewer attention, not a hard merge block.
- `tsc` + lint are the safety net: any stale import fails the typecheck. Per-step invariant "each commit compiles" means Task 7 cannot land with broken references.

## Tests

**New invariant tests (must pass before merge):**

- `test/unit/stores/session-chat-state-shape.test.ts` — drift check: every `SessionChatState` field populated by factory defaults. (Task 2 of main PR.)
- `test/unit/stores/session-chat-state-reactivity.test.ts` — mutate `getOrCreateSessionActivity(id).phase`; assert `$derived(currentChat().phase)` observer re-runs. (Task 2.)
- `test/unit/stores/empty-state-frozen.test.ts` — `EMPTY_STATE` mutation throws in both dev and prod modes. (Task 2.)
- `test/unit/stores/handler-signatures.test.ts` — dispatches each handler through the adapter with `currentId=A`; asserts only A's slots mutate; EMPTY_STATE untouched. (Task 2 of main PR.)
- `test/unit/stores/regression-phase-no-leak.test.ts` — switch A(streaming) → B(idle) → A asserts `currentChat().phase` reflects A's actual state at every tick; switch mid-turn asserts no bleed.
- `test/unit/stores/session-chat-state-routing.test.ts` — dispatch a delta for B while `currentId=A`; assert B's slot mutates, A's slot untouched, `currentChat()` untouched. (Task 4.)
- `test/unit/stores/status-idle-clears-streaming.test.ts` — covers F2; lands with Task 4.
- `test/unit/stores/concurrent-session-dispatch.test.ts` — interleaved deltas for A/B/C; each slot independent; per-session `replayGeneration` counters don't cross-contaminate; live-during-own-replay; ghost-session guard; prod silent-drop telemetry; missing-sessionId prod behavior. (Task 4.)
- `test/unit/stores/session-slot-eviction.test.ts` — LRU cap on Tier 2; never evicts current; evicted session re-entered lazily reconstructs from server events + buffer drain; mid-replay slot-identity check short-circuits stale resolver. (Task 5.)
- `test/unit/stores/ghost-session-cleanup.test.ts` — `clearSessionChatState` wired to `session_deleted` and `handleSessionList` drop path; both tiers cleared; sidebar row disappears. (Task 5.)
- `test/unit/components/per-session-component-isolation.test.ts` — per-component isolation check against missed migrations. (Task 6.)
- `test/unit/relay/per-session-event-has-sessionid.test.ts` — emitter contract test. (Server PR.)
- `test/unit/session/patchMissingDone-claude-sdk.test.ts` — F3 coverage. (Server PR.)

**Migrated tests.** Every existing test that reads or writes `chatState.X` migrates to the per-session shape. Files enumerated from task-3 audit §8: `chat-phase.test.ts`, `chat-store.test.ts`, `regression-mid-stream-switch.test.ts`, `regression-session-switch-history.test.ts`, `turn-epoch-queued-pipeline.test.ts`, `thinking-invariants.test.ts`, `chat-thinking-done.test.ts`, `ws-message-dispatch.test.ts`, `dispatch-coverage.test.ts`, `replay-batch.test.ts`, `replay-paging.test.ts`, `chunked-replay.test.ts`, `async-history-conversion.test.ts`, `race-history-conversion.test.ts`, `deferred-markdown.test.ts`, `regression-dual-render-duplication.test.ts`, `regression-queued-replay.test.ts`, `scroll-lifecycle-integration.test.ts`, `dispatch-notifications.test.ts`, `dispatch-notification-reducer.test.ts`, `history-loader.test.ts`. Each migrates in the same commit that flips the symbols it imports. No chat test retains module-global mutation.

**Storybook.** Multi-session sidebar story with three sessions and varied phases; only non-idle sessions pulse. Regression story mirroring the triggering bug (switch away then back with both sessions idle).

**E2E.** Playwright test: open project with two sessions (one active, one idle), navigate away from the idle session and back, assert bounce bar not visible on the idle session's view and that the idle session's sidebar dot is not pulsing.

## Risks

| Risk | Mitigation |
|------|------------|
| Server event emitted without `sessionId` → silent routing drop | Exhaustive `Extract<RelayMessage, { sessionId: string }>` narrowing; contract test exercises every emitter; runtime dev assertion throws; prod telemetry counter monitored as SEV. |
| Project-scoped firehose bandwidth spike after Phase 0b | Measure event rate per client before/after. Subscribe-list protocol held as fallback if a high-activity project shows regression. |
| SvelteMap reactivity gotchas (stale closure, missed notification on deep mutation) | Reactivity invariant test in Task 2 gates everything downstream. Dev-time lint: discourage `.entries()`/`.values()` iteration on the activity/messages maps. |
| Tier 2 eviction drops messages for a session that re-enters | `view_session` rehydrates from server event log; `SessionActivity.liveEventBuffer` drains post-rehydration. Covered by `session-slot-eviction.test.ts`. |
| Ghost slot for a deleted session (pulsing row with no SessionInfo row) | `clearSessionChatState` wired to `session_deleted` + `handleSessionList` drop path; unknown-session guard in `routePerSession` drops phantom events with telemetry. |
| Mid-replay session switch cross-contaminates slots | `replayEvents(sessionId)` captures slot at start, threads through all dispatches; per-slot `replayGeneration` short-circuits stale resolvers. Covered by `concurrent-session-dispatch.test.ts`. |
| Multiple tool registries (one per session) raise memory | Registries are small (tool metadata only); live in Tier 2, so LRU eviction disposes them. |
| Two-tier split adds surface area (two maps, composite Proxy) | Offset by removing buffering code and LRU phase-preservation rule; net complexity is roughly flat. Monitoring test coverage (reactivity invariant, drift check, composition Proxy) catches regressions. |
| Hard-cut codemod touches many files, hurts bisect granularity | 7 reviewable commits in the main PR; each compiles and passes tests. Preceding server PR is mechanical and independently bisectable. |

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

## Appendix C: Amendments from 2026-04-20 audit

This plan was audited by 7 parallel `plan-task-auditor` subagents on 2026-04-20 (synthesis: `docs/plans/2026-04-19-session-chat-state-per-session-design-audit.md`). 72 Amend-Plan findings, 9 Ask-User findings, 21 Accept findings. All Amend-Plan and Ask-User findings have been resolved in this revision. Key structural changes:

- **Two-tier data model** (Activity unbounded + Messages LRU) replaces the single-map approach, eliminating the "all slots non-idle" corner case for subagent-heavy workloads.
- **Preceding server PR** carries Phase 0b (firehose fanout) + Task 1 (sessionId contract) + F3; main PR is frontend-only.
- **`PerSessionEvent` typing** switched from structural intersection (broken — widens) to `Extract<RelayMessage, { sessionId: string }>` (correct narrowing) with `sessionId?: never` annotations on GlobalEvent variants.
- **Live-event buffering retained** on `SessionActivity.liveEventBuffer` (not deleted — design self-contradiction with the companion plan-of-record resolved in favor of retention).
- **F2 timing moved to Task 4** (dispatcher flip commit) to avoid a new transient cross-session bleed during Task 3.
- **F3 fully specified**: signature widening, call-site update, synthetic-event `sessionId` attachment.
- **Exhaustive event list** — added `tool_content`, `ask_user*`, `permission_*`, `session_switched`, `session_forked`, `error` (via widened `RelayError.toMessage`), `system_error`.
- **`contextPercent` dual-write strategy** during Task 3; deletion of `uiState.contextPercent` + `updateContextPercent` in Task 5.
- **`historyState` fully migrated** to per-session Tier 2 (matches Discord/Slack/Teams practice for per-channel pagination).
- **Ghost-slot cleanup** via `clearSessionChatState` wired to `session_deleted` and `handleSessionList` drop path.
- **Mid-replay race** prevented by capturing slot at `replayEvents` start, not reading `currentChat()`.
- **Sentinel design**: plain frozen POJO `EMPTY_STATE`, not `$state`. Strict-mode throw in dev and prod; dev Proxy for clearer messages.
- **Empty-string sessionId hard-fails** in `getOrCreateSession*`.
- **Component migration scope expanded**: `UserMessage.svelte`, `ChatLayout.svelte`, `HistoryLoader.svelte`, `InputArea.stories.ts` added to Task 6.
- **Test migration in lockstep**: 20+ test files enumerated, each migrates in the commit that flips its imports.
- **Task 7 LOC phrasing** reworded to heuristic, excluding new test files.
