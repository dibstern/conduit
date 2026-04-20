# Per-Session Chat State Design

**Date:** 2026-04-19 (amended 2026-04-20 — Loop 2 findings applied)
**Goal:** Eliminate a class of stale-activity-indicator bugs by making chat state per-session by construction. Replace the module-level `chatState` singleton with a two-tier per-session store (unbounded Activity + LRU-capped Messages), route every incoming event by `sessionId`, and derive all UI reads from the current session's slot.
**Approach:** Land in two PRs. A **preceding server PR** ships Phase 0b (broaden `/p/<slug>` fanout to a project-scoped firehose with per-session ordering + session_list-first guarantees) and Task 1 (add `sessionId` to every `PerSessionEvent`, widen `patchMissingDone`, plumb sessionId through `RelayError.toMessage`, add `session_deleted` relay variant, add `system_error`). Once the server PR is deployed, a **main frontend PR** lands as 7 reviewable commits. Each commit compiles and passes the existing suite. No backward-compatibility shims.

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
  replayGeneration: number;                  // renamed from module-level `deferredGeneration` (same semantics: monotonic abort counter for stale resolvers); moves to per-session in this refactor
  doneMessageIds: SvelteSet<string>;
  seenMessageIds: SvelteSet<string>;
  liveEventBuffer: PerSessionEvent[] | null; // deltas received while Tier 2 is evicted or mid-replay; type-narrowed to per-session variants only
  eventsHasMore: boolean;                    // per-session "more events available" flag (supersedes module-level eventsHasMoreSessions Set)
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

Also add to `session.svelte.ts` (introduced in Main Task 1):

```ts
// sessionState gains an id-keyed SvelteMap maintained alongside the existing
// rootSessions / allSessions arrays. Used by the dispatcher's unknown-session
// guard (O(1) membership check) and by clearSessionChatState's diff path.
sessionState.sessions = new SvelteMap<string, SessionInfo>();
```

**Why split by weight.** Running many subagents (most hidden from the sidebar) pushes total session count well above 20. A single LRU-capped map forces the policy "never evict non-idle," which fails when all N slots are non-idle. The split eliminates the corner case: the bounded tier holds only re-fetchable data; the unbounded tier is cheap enough to hold forever.

**Why dedup Sets stay in Tier 1.** After a Tier 2 eviction + re-entry, server history rehydrates `messages[]`, then `liveEventBuffer` drains. If `doneMessageIds` / `seenMessageIds` had been evicted, a live delta that arrived during the eviction window could be applied twice (once via history replay, once via drain). Keeping dedup in Tier 1 prevents this.

**messageId collision note.** `messageId` values are generator-unique (Claude SDK emits `msg_…` UUIDs; Opencode likewise; client-synthesized ones use crypto-random IDs). Per-session dedup is therefore strictly safer than the current global Set even in the ~0-probability collision case — today's global Set would suppress session B's delta if A saw the same id; per-session Sets correctly process both.

**Reactivity contract.** `SvelteMap.get(id)` subscribes a caller to the key's presence; it does **not** deep-track mutations on the stored value. Reactivity on inner fields works only because each stored value is a `$state`-backed proxy — template reads like `currentChat().phase` pass through the proxy's get-trap and subscribe fine-grained. Consumers that iterate `.entries()` or `.values()` expecting deep reactivity on values will silently miss updates. Task 1 lands an explicit invariant test (see Tests) asserting that `$derived(currentChat().phase)` re-runs when a handler mutates the stored proxy's `phase` field.

### Access patterns

```ts
// Factories return plain POJOs. The getOrCreate* functions wrap them in $state
// at insertion time. This avoids the "factory returns $state" + "getOrCreate
// wraps again" double-wrap ambiguity.
function createEmptySessionActivity(): SessionActivity {
  return {
    phase: "idle",
    turnEpoch: 0,
    currentMessageId: null,
    replayGeneration: 0,
    doneMessageIds: new SvelteSet(),
    seenMessageIds: new SvelteSet(),
    liveEventBuffer: null,
    eventsHasMore: false,
    renderTimer: null,
    thinkingStartTime: 0,
  };
}

function createEmptySessionMessages(): SessionMessages {
  return {
    messages: [],
    currentAssistantText: "",
    loadLifecycle: "empty",
    contextPercent: 0,
    historyHasMore: false,
    historyMessageCount: 0,
    historyLoading: false,
    toolRegistry: createToolRegistry(),  // existing factory in src/lib/frontend/stores/tool-registry.ts
  };
}

// Set of Activity-tier keys. Used by composeChatState's get-trap for routing.
// Derived at module-init from the Activity factory's return shape — drift-
// protected by the session-chat-state-shape.test.ts which asserts the union
// of activity + messages keys equals SessionChatState's keys.
const ACTIVITY_KEYS: ReadonlySet<keyof SessionActivity> = new Set(
  Object.keys(createEmptySessionActivity()) as (keyof SessionActivity)[]
);

// Read-only view. Routes field reads to the right tier's $state proxy,
// preserving fine-grained reactivity on each access (no caching).
function composeChatState(
  activity: SessionActivity,
  messages: SessionMessages
): SessionChatState {
  return new Proxy({} as SessionChatState, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      return ACTIVITY_KEYS.has(key as keyof SessionActivity)
        ? (activity as Record<string, unknown>)[key]
        : (messages as Record<string, unknown>)[key];
    },
    set() {
      throw new Error(
        "currentChat() is read-only. Mutate state via handlers (activity, messages) parameters."
      );
    },
    has(_t, key) {
      if (typeof key !== "string") return false;
      return ACTIVITY_KEYS.has(key as keyof SessionActivity) || key in messages;
    },
    ownKeys() {
      return [...ACTIVITY_KEYS, ...Object.keys(createEmptySessionMessages())];
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key !== "string") return undefined;
      const source = ACTIVITY_KEYS.has(key as keyof SessionActivity) ? activity : messages;
      const value = (source as Record<string, unknown>)[key];
      if (value === undefined) return undefined;
      return { value, writable: false, enumerable: true, configurable: true };
    },
  });
}

// Sentinel for chat-view consumers when no session is active. Plain frozen
// POJO — NOT $state. Strict-mode TypeError fires on any write attempt in
// both dev and prod. Dev wraps EMPTY_STATE in an additional Proxy that
// throws with a clearer message ("attempted to mutate EMPTY_STATE —
// currentId is null. This is a routing bug in <caller>.").
//
// EMPTY_MESSAGES.toolRegistry's methods are replaced with throwing stubs
// (Object.freeze does not stop method calls — a handler that called
// EMPTY_MESSAGES.toolRegistry.register(tool) would mutate the sentinel's
// registry silently otherwise).
const EMPTY_ACTIVITY_RAW = createEmptySessionActivity();
const EMPTY_MESSAGES_RAW = createEmptySessionMessages();
const throwingStub = () => { throw new Error("EMPTY_MESSAGES.toolRegistry is read-only"); };
for (const methodName of Object.keys(EMPTY_MESSAGES_RAW.toolRegistry) as (keyof ToolRegistry)[]) {
  if (typeof EMPTY_MESSAGES_RAW.toolRegistry[methodName] === "function") {
    (EMPTY_MESSAGES_RAW.toolRegistry as Record<string, unknown>)[methodName] = throwingStub;
  }
}
const EMPTY_ACTIVITY: SessionActivity = Object.freeze(EMPTY_ACTIVITY_RAW);
const EMPTY_MESSAGES: SessionMessages = Object.freeze(EMPTY_MESSAGES_RAW);
const EMPTY_STATE: SessionChatState = composeChatState(EMPTY_ACTIVITY, EMPTY_MESSAGES);

// Read API — chat-view components
const _currentChat = $derived.by((): SessionChatState => {
  const id = sessionState.currentId;
  if (id == null) return EMPTY_STATE;
  const activity = sessionActivity.get(id);
  if (!activity) return EMPTY_STATE;
  const messages = sessionMessages.get(id) ?? EMPTY_MESSAGES;
  return composeChatState(activity, messages);
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
    ensureLRUCap();  // evicts least-recently-used Tier 2 slot (never the current one) if > cap
  }
  touchLRU(id);
  return m;
}

// Convenience: allocate both tiers + touch LRU. Handlers use this.
export function getOrCreateSessionSlot(id: string): { activity: SessionActivity; messages: SessionMessages } {
  return { activity: getOrCreateSessionActivity(id), messages: getOrCreateSessionMessages(id) };
}

// Teardown — called on `session_deleted` relay event and when handleSessionList
// detects a previously-known sessionId has disappeared. Clears BOTH tiers.
// Distinct from `ensureLRUCap()` which only touches Tier 2 under memory pressure.
export function clearSessionChatState(id: string): void {
  const activity = sessionActivity.get(id);
  if (activity) {
    // Bump generation on the OLD activity proxy so in-flight resolvers that
    // captured this reference short-circuit before writing to a detached slot.
    activity.replayGeneration++;
    if (activity.renderTimer) { clearTimeout(activity.renderTimer); }
  }
  sessionActivity.delete(id);
  sessionMessages.delete(id);
}
```

- **Chat view** (MessageList, InputArea, bounce bar, context bar, UserMessage): reads `currentChat()`. Reactivity tracks `sessionState.currentId` + both tier proxies' inner fields. Switching session re-derives cleanly.
- **Sidebar row** (SessionItem): reads `getSessionPhase(session.id)` only. Each row subscribes only to its session's Activity slot. A delta for session B updates only B's row dot; A's row is untouched. Tier 2 eviction is invisible to sidebar rendering.
- **Empty sentinel**: `EMPTY_STATE` is a `composeChatState`-wrapped view over two frozen POJOs. Returned when `currentId` is null or the slot is absent. Mutation attempts throw via strict-mode `TypeError` in both dev and prod; dev additionally wraps in a Proxy with a clearer error message. `toolRegistry` methods are replaced with throwing stubs so accidental `EMPTY_MESSAGES.toolRegistry.register(tool)` doesn't silently mutate.

### Event routing by sessionId (A2 — concurrent sessions)

The frontend receives events for every session in the current project and routes each to its own slot.

**`view_session` semantics.** Viewer bookkeeping no longer controls event delivery (Phase 0b firehose replaces per-viewer fanout). The message still triggers:
1. History backfill to the requesting client (via `switchClientToSession`).
2. A cross-client `notification_event / session_viewed` broadcast that clears "done-unviewed" indicators on other clients.
3. Session metadata send (fire-and-forget).

Viewer association within the server (`switchClientToSession`) remains in place as UI-state bookkeeping — event delivery no longer depends on it, but future features (presence, analytics) may. See §Known Debt for the eventual rename/split proposal.

Draft sync is handled by a separate message (`input_sync`), unaffected by this refactor.

**Prerequisite — Phase 0b (preceding PR).** Today `applyPipelineResult` (`src/lib/relay/event-pipeline.ts:111-123`) routes per-session events via `wsHandler.sendToSession(sessionId, msg)`, which only delivers to clients that called `view_session` (`ws-handler.ts:197-206`). Phase 0b broadens the per-project relay at `/p/<slug>` to a **project-scoped firehose** that delivers every per-session event to every connected client for that project.

Phase 0b invariants the server must preserve:
- **Per-session ordering preserved under broadcast.** Events for session X arrive at every client in the same order the server produced them. Cross-session ordering is not constrained (events for X and Y may interleave differently across clients).
- **`session_list` first after connection.** Before the server streams any `PerSessionEvent` on `/p/<slug>`, it emits the initial `session_list` / project-bootstrap messages. This eliminates the startup race where a client receives an event for a session it hasn't yet learned about. If the server cannot satisfy this (e.g., event fires during bootstrap), events must be queued server-side until `session_list` has been dispatched.

Without Phase 0b, Task 4 silently drops all cross-session events or hits the unknown-session guard.

**Rollback compat.** The frontend PR strictly depends on the server PR. If the server PR is rolled back, the frontend dispatcher will throw / increment telemetry on every per-session event (missing `sessionId`). This is accepted — the frontend PR should not ship ahead of or without the server PR. Deployment order is enforced by merging the server PR first and verifying rollout before merging the frontend PR.

**Server changes — Task 1 (preceding PR).** Every `RelayMessage` variant that mutates per-session state carries a required `sessionId: string` field. Use the `Extract` form for type narrowing (an intersection `RelayMessage & { sessionId: string }` widens rather than narrows under structural typing):

```ts
type PerSessionEvent = Extract<RelayMessage, { sessionId: string }>;
type GlobalEvent    = Exclude<RelayMessage, { sessionId: string }>;
```

Event types that must gain `sessionId: string` (exhaustive list, derived from `src/lib/shared-types.ts:269-474` + all emission sites):

- Already required: `permission_request`, `result`.
- Already optional (promote to required): `ask_user_resolved`, `history_page`, `provider_session_reloaded`.
- Must be added: `delta`, `thinking_start`, `thinking_delta`, `thinking_stop`, `tool_start`, `tool_executing`, `tool_result`, `tool_content`, `done`, `error`, `status`, `user_message`, `part_removed`, `message_removed`, `ask_user`, `ask_user_error`, `permission_resolved`.
- Session-keyed via a different field today — normalize to `sessionId`: `session_switched` (currently `id`), `session_forked` (currently `session.id`). `history_page` already uses `sessionId`.
- **New `session_deleted` variant** — emitted by the server when a session is removed. Carries `sessionId: string`. Wired to `clearSessionChatState` on the client.
- **New `system_error` variant** for errors that are genuinely session-less (HANDLER_ERROR, INSTANCE_ERROR paths in `handleChatError`). Session-scoped errors keep using `error` with `sessionId` via widened `RelayError.toMessage(sessionId: string)`.

**Notification event classification.** `notification_event` carries `sessionId` but is NOT a `PerSessionEvent` in this refactor's sense — its handler dispatches to the notification reducer, not to a chat-state slot. It stays in the `GlobalEvent` branch of the dispatcher despite carrying `sessionId`. Promote its field to required (for reducer routing), but don't include it in `PerSessionEvent`'s `Extract` union.

To keep the type-level `Extract` clean, either (a) annotate `notification_event` with a brand-tag such that `Extract<RelayMessage, { sessionId: string }>` excludes it by construction, or (b) define `PerSessionEvent = Extract<RelayMessage, { sessionId: string, _kind: "chat" }>` with a `_kind` discriminator, or (c) declare a union of event type-string literals and `Extract` over those. Pick (c) in the type declaration (least invasive):

```ts
type PerSessionEventType =
  | "delta" | "thinking_start" | "thinking_delta" | "thinking_stop"
  | "tool_start" | "tool_executing" | "tool_result" | "tool_content"
  | "result" | "done" | "error" | "status" | "user_message"
  | "part_removed" | "message_removed"
  | "ask_user" | "ask_user_resolved" | "ask_user_error"
  | "permission_request" | "permission_resolved"
  | "session_switched" | "session_forked" | "history_page"
  | "provider_session_reloaded" | "session_deleted";
type PerSessionEvent = Extract<RelayMessage, { type: PerSessionEventType; sessionId: string }>;
type GlobalEvent = Exclude<RelayMessage, { type: PerSessionEventType }>;
```

**Emitter-side injection — single post-translation tag strategy.** Translator functions in `src/lib/relay/event-translator.ts:101-468` are pure and do not take `sessionId`. Rather than thread `sessionId` into every translator signature, tag at the call site after translation:

- `src/lib/relay/sse-wiring.ts:313-335` — map translator results through `tagWithSessionId(eventSessionId)` before dispatch. Replace `translateMessageUpdated`'s fallback `sessionId: props.sessionID ?? ""` with fail-fast + log-and-skip when `sessionID` is absent.
- `src/lib/provider/relay-event-sink.ts` — in `push()`, after `translateCanonicalEvent(event)` returns, map per-session variants through `{ ...m, sessionId: deps.sessionId }` before iterating `send()`.
- `src/lib/relay/message-poller.ts:318, 598-601` — attach `sessionId: this.activeSessionId!` at construction; guard against null `activeSessionId` explicitly.
- `src/lib/handlers/prompt.ts:73` — `activeId` is already in scope; attach directly.
- `src/lib/handlers/tool-content.ts:15-34` — tool invocation already carries session; attach at emission.
- `src/lib/session/session-switch.ts:170-174, 337-340` — synthesized `done` and `status` events get `sessionId` inline.
- `src/lib/errors.ts:97-115` — `RelayError.toMessage(sessionId: string)` signature widened; call sites that emit session-scoped errors pass it. Session-less errors use the new `system_error` variant.
- **Cache replay:** when reconstructing `session_switched.events: RelayMessage[]` from cached events, backfill `sessionId` on each per-session variant (cache predates this contract).

**Dispatcher.**

```ts
// src/lib/frontend/stores/ws-dispatch.ts
function dispatchEvent(event: RelayMessage, ctx: DispatchContext) {
  if (isPerSessionEvent(event)) {
    routePerSession(event, ctx);
    return;
  }
  // Existing switch for GlobalEvent variants. notification_event goes here
  // even though it carries sessionId — its handler routes to the notification
  // reducer, not to a chat-state slot.
  dispatchGlobalEvent(event, ctx);
}

function routePerSession(event: PerSessionEvent, ctx: DispatchContext) {
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) {
    if (isDev()) throw new Error(`routePerSession: missing sessionId on ${event.type}`);
    ctx.telemetry.counter("per_session_event_missing_sessionid", { type: event.type });
    return;
  }
  // Unknown-session guard. Under Phase 0b's session_list-first invariant, this
  // should never fire for legitimate events; if it does, it's a stale ghost.
  if (!sessionState.sessions.has(event.sessionId)) {
    ctx.telemetry.counter("per_session_event_unknown_session", { type: event.type });
    return;
  }
  const { activity, messages } = getOrCreateSessionSlot(event.sessionId);

  // advanceTurnIfNewMessage ONLY for events with a messageId field.
  // Many PerSessionEvent variants (status, error, done, ask_user, etc.)
  // have no messageId — gate explicitly.
  if ("messageId" in event && event.messageId != null) {
    advanceTurnIfNewMessage(activity, event.messageId);
  }

  switch (event.type) {
    case "delta":        handleDelta(activity, messages, event); break;
    case "done":         handleDone(activity, messages, event); break;
    case "status":       handleStatus(activity, messages, event); break;
    case "thinking_start": handleThinkingStart(activity, messages, event); break;
    // ... exhaustive. Default case is a never-narrowing exhaustiveness assertion:
    // default: { const _exhaust: never = event; void _exhaust; ctx.telemetry.counter("unhandled_per_session_event", { type: (event as PerSessionEvent).type }); }
  }
}
```

Dev-mode detection uses the repo's established pattern `(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true` (see `chat.svelte.ts:198` and `docs/PROGRESS.md:770` for the tsconfig rationale). In prod the assertion does not throw — it increments a telemetry counter and returns. Silent dropping is unacceptable; the counter is monitored as a SEV.

Every per-session handler takes `(activity: SessionActivity, messages: SessionMessages, event)` as explicit first arguments. No handler reads `currentChat()` or any module-level chat state — routing is structural.

**Live-event buffering — retained, moved per-session.** The existing `liveEventBuffer` exists because live events arriving for session X during replay of X had no place to go. Under the new shape, buffering is preserved on `SessionActivity.liveEventBuffer`:

- Dispatcher accumulates live deltas in `activity.liveEventBuffer` when the buffer is non-null (set to `[]` by the replay entry point at start; nulled post-drain). The boolean gate is `activity.liveEventBuffer !== null`, not `replayGeneration`.
- `replayGeneration` is a separate monotonic abort counter used by async resolvers (`convertHistoryAsync`, history paginators) to short-circuit commits whose captured generation no longer matches.
- Drain order: after `commitReplayFinal` has populated `messages.messages[]` AND after `phaseEndReplay`, the drain loop re-enters `dispatchChatEvent(bufferedEvent, { isReplay: false })`. Dedup Sets (`activity.seenMessageIds` / `activity.doneMessageIds`) are already populated by the committed replay, so duplicate deltas from the buffer are suppressed.
- During drain, newly-arriving live events do NOT race: the buffer is held at `[]` (not nulled) until drain completes, so incoming events push into the same buffer and are drained in the same pass. Only after the drain loop empties the buffer does the code null it.
- Tier 2 eviction does not drop the buffer (it lives in Tier 1). When the user re-enters an evicted session, `view_session` replays history, then the buffer drains.

**Mid-replay session switches.** Handlers invoked during replay must write into the slot for the **session being replayed**, not `currentChat()`. The `replayEvents(sessionId, ...)` entry point resolves `const slot = getOrCreateSessionSlot(sessionId)` once and threads `slot` through every dispatch; it does NOT use `dispatchToCurrent` or `currentChat()`. This prevents rapid session switches from cross-contaminating slots mid-stream.

The slot-capture-at-start rule means a replay 1 in flight for session X continues to apply events to X's slot even if the user has switched to Y. When the user switches back to X, they see X's accumulated state. No cross-session bleed.

**Concurrent `replayEvents(X)` for the same session.** If a second call occurs while replay 1 is in flight, the second call returns early after bumping `activity.replayGeneration` (aborting any in-flight resolver on replay 1). Replay 1's remaining `await`-resolved commits short-circuit via the generation-mismatch check. The buffer is held across this transition — live events continue to accumulate and will be drained by whichever replay finishes last. For the rapid-switch-away-and-back scenario, replay 1 completes normally under its captured slot (slot-capture rule); the user sees the final state on re-entry.

**Other async commit paths need the same slot-capture discipline.** `convertHistoryAsync` at `ws-dispatch.ts:459-469` (cache-miss session_switched branch) and `ws-dispatch.ts:572-580` (history_page pagination) today snapshot `gen = replayGeneration` and commit only if equal. Under the new shape both must capture the per-session slot at start and snapshot `slot.activity.replayGeneration`, committing prepend/seed/historyState writes to the captured slot's `messages` (not `currentChat()`).

### Reconciled fixes bundled with the refactor

Three latent bugs discovered during investigation are fixed as part of this refactor, because they would otherwise re-surface under the new shape:

- **F2 — `handleStatus("idle")` only clears `processing`, not `streaming`.** Fixed by treating a server-`idle` signal as a full phase reset for the session, including cleanup of any mid-stream state that the server is telling us has ended. **Lands in Task 4 (dispatcher flip), NOT Task 3.** Rationale: during Task 3 the adapter still routes by `currentId`, so a `status:idle` event for session B arriving while `currentId=A` would clear A's streaming — a new transient cross-session bleed. Once Task 4 routes by `event.sessionId`, the cross-session bleed is structurally impossible and F2 becomes safe to land.

  Concrete F2 behavior (`handleStatus(activity, messages, event)` with `event.status === "idle"`):
  1. If a live in-flight message is pending (`activity.currentMessageId != null`), finalize it: append a synthetic `done` for that id via `handleDone` helper path so the message lands in `messages.messages[]` as terminal.
  2. Set `activity.phase = "idle"`.
  3. Clear `activity.currentMessageId = null`, `messages.currentAssistantText = ""`, `activity.thinkingStartTime = 0`.
  4. Drain `activity.liveEventBuffer` if non-null (treat as "server says this turn is done; flush anything we buffered").
  5. `activity.seenMessageIds` / `activity.doneMessageIds` remain — they are cross-turn dedup, not per-turn state.

- **F3 — `patchMissingDone` guard omits the Claude SDK timeout signal.** `patchMissingDone` at `src/lib/session/session-switch.ts:160-175` currently checks only `statusPoller?.isProcessing(sessionId)`. The fix:
  1. Widen the signature to accept `overrides: SessionSwitchDeps["overrides"]` as a third parameter.
  2. Update the single call site at `session-switch.ts:314` to pass `deps.overrides`.
  3. Widen the guard to `statusPoller?.isProcessing(sessionId) || overrides?.hasActiveProcessingTimeout(sessionId)`, matching the outgoing-status disjunction at `session-switch.ts:334-336`.
  4. Add `sessionId` to the inline synthetic `{ type: "done", code: 0 }` at `session-switch.ts:172` and to the `status` sends at `session-switch.ts:337-340`. Under the new contract these events require the field.

  `SessionSwitchDeps.overrides` at `session-switch.ts:71-73` already declares `hasActiveProcessingTimeout`, so no interface change is needed beyond the parameter list widening.

- **Module-level Sets (`seenMessageIds`, `doneMessageIds`) accumulate across sessions.** Fixed structurally by moving them into `SessionActivity`.

### Eviction policy

LRU cap **20 entries on Tier 2 (Messages)**. Tier 1 (Activity) is unbounded.

Two distinct operations, intentionally not unified:
- **`ensureLRUCap()`** — called from `getOrCreateSessionMessages` on insertion. Evicts least-recently-used Tier 2 entries if the cap is exceeded. Never touches Tier 1. Never evicts the entry for `sessionState.currentId` (active session is always MRU).
- **`clearSessionChatState(id)`** — called on `session_deleted` relay event and from `handleSessionList` when a previously-known sessionId disappears. Clears BOTH tiers. Bumps the (about-to-be-deleted) activity's `replayGeneration` to short-circuit any in-flight async resolver that captured the old reference.

Evicted Tier 2 entries are rebuilt from the server event log on next `view_session`:
- `view_session` triggers server-side history backfill (`handleViewSession`).
- Client populates Tier 2 from the received `session_switched.events`.
- Any deltas in `activity.liveEventBuffer` (accumulated while Tier 2 was evicted) drain into `messages.messages[]` post-hydration.

`handleSessionList` (the frontend listener for the session-list message) gains diff logic: snapshot the prior ids (keys of `sessionState.sessions`), apply the incoming list, then invoke `clearSessionChatState(id)` for any id present in the prior snapshot but absent from the incoming list. **Guard:** skip the diff if the incoming list is a filtered/search payload (today the session list message may be used to deliver search results — clearing non-matching sessions from chat state would be incorrect). The guard uses a payload flag or a separate message type; implementation detail to be confirmed against `src/lib/handlers/session.ts`.

**No "all slots non-idle" corner case.** The original single-map design needed the rule "never evict non-idle" to avoid dropping live state. The two-tier split removes live state from the LRU — live state is in Tier 1, which is unbounded. The memory cost of Tier 1 per session is a handful of scalars + two small Sets (≪ 1 KB); scaling to hundreds of background subagents is fine.

### View-layer changes

- **`InputArea.svelte` bounce bar**: `{#if isProcessing()}` unchanged at the call site. `isProcessing()` internal becomes `currentChat().phase !== "idle"`. (`InputArea.svelte:229` reads `isProcessing()` inside a call to `addUserMessage`; it auto-migrates via Task 2's handler flip — no direct Task 6 change at that line, listed in the file catalog for reviewer orientation only.)
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
- **`UserMessage.svelte`**: reads `chatState.turnEpoch`, `chatState.currentMessageId`, `chatState.phase` at lines 9, 19, 27, 29, 30. Migrate all to `currentChat().X`. The `$inspect` debug logger at lines 22-33 is kept (migrated to read `currentChat().X`). Note: `$inspect` correctly subscribes to reads through `composeChatState`'s Proxy because the Proxy implements `ownKeys` + `getOwnPropertyDescriptor` (see `composeChatState` spec in §Access patterns).
- **`HistoryLoader.svelte`**: reads and writes `historyState.hasMore` / `historyState.loading` / `historyState.messageCount` at lines 35-92. Migrate to `currentChat().historyHasMore` / `historyLoading` / `historyMessageCount`. Module-level `historyState` export is deleted in Main Task 6 (after components migrate, not before — see commit ordering note).
- **`ChatLayout.svelte:49`**: `import { chatState, clearMessages }` — delete `chatState` from the import (unused after codemod; `clearMessages` stays).
- **`MessageList.svelte:47-49`**: `() => chatState.loadLifecycle` getter passed to `createScrollController` rewrites to `() => currentChat().loadLifecycle` — keep the arrow; do NOT inline.
- **`uiState.contextPercent` reads migrate to `currentChat().contextPercent`**. Readers: `InputArea.svelte:107,465` (2 sites). `InfoPanels.svelte:28-38,217-224` derives its own `contextPercent` from a prop (`contextData`) — NOT from `uiState.contextPercent` — so no migration required there. Writers: `updateContextPercent` helper at `ui.svelte.ts:314-316` is deleted; the write path (`updateContextFromTokens`) writes into `messages.contextPercent` on the event's sessionId directly.
- **Storybook**: `MessageList.stories.ts` rewrites `chatState.messages` → `currentChat().messages` with a test sessionId. `InputArea.stories.ts:40,60,66,72` rewrites `uiState.contextPercent = N` to `getOrCreateSessionMessages(testId).contextPercent = N`; `phaseToIdle()`/`phaseToProcessing()` calls gain the test sessionId argument.

## Migration

Land in two PRs.

### Preceding server PR (Phase 0b + Task 1)

**Phase 0b — broaden project relay fanout.** `src/lib/relay/event-pipeline.ts` and `src/lib/server/ws-handler.ts`: change per-session-event fanout from `sendToSession(sessionId, msg)` (viewer-gated) to a project-scoped broadcast. Every client connected to `/p/<slug>` receives every per-session event for that project. `view_session` no longer gates delivery — it remains for history backfill, `session_viewed` broadcast, and metadata. Server invariants to preserve:
- Per-session event ordering is preserved under broadcast (X's events arrive in order at every client).
- `session_list` (or the project-bootstrap payload containing it) is always emitted before any per-session event on a new `/p/<slug>` connection. If a per-session event would fire before bootstrap completes, queue it server-side until `session_list` has been sent.

**Task 1 — add `sessionId` to every `PerSessionEvent` + F3 fix + RelayError plumbing + session_deleted + system_error.**

1. Type changes in `src/lib/shared-types.ts`: promote `sessionId` to required on the variants listed in §Event routing. Declare the `PerSessionEventType` union and `PerSessionEvent = Extract<RelayMessage, { type: PerSessionEventType; sessionId: string }>` + `GlobalEvent = Exclude<RelayMessage, { type: PerSessionEventType }>`. Add `session_deleted` and `system_error` variants.
2. Post-translation tag at emission sites: `sse-wiring.ts`, `relay-event-sink.ts`, `message-poller.ts`, `prompt.ts`, `tool-content.ts`, `session-switch.ts` (2 inline synthesizers), `event-translator.ts:446` fallback removed.
3. F3 fix: widen `patchMissingDone` signature + guard + update call site + attach `sessionId` to synthesized events. Details in §Reconciled fixes.
4. `RelayError.toMessage(sessionId: string)` — signature widening; update all callers to pass sessionId for session-scoped errors. Session-less errors (HANDLER_ERROR, INSTANCE_ERROR) use new `system_error` variant emitted via `wsHandler.broadcast()`.
5. Emit `session_deleted` from the server when a session is removed (replaces / complements the existing session-list broadcast as a signal to tear down client-side chat state).
6. Cache replay: `session-switch.ts` backfills `sessionId` onto cached events before emission.

**Server PR tests:**
- `test/unit/relay/per-session-event-has-sessionid.test.ts` — contract test exercising each emission site and asserting `sessionId` presence on every `PerSessionEvent` variant.
- `test/unit/relay/phase-0b-ordering.test.ts` — asserts per-session delta order is preserved under the project-scoped broadcast.
- `test/unit/relay/phase-0b-session-list-first.test.ts` — asserts `session_list` is emitted before any per-session event on a fresh `/p/<slug>` connection; a per-session event that would fire during bootstrap is queued until after `session_list`.
- `test/unit/session/patchMissingDone-claude-sdk.test.ts` — covers F3 (poller idle + processingTimeout active → patch skipped).
- `test/unit/session/synthesized-status-sessionid.test.ts` — asserts the synthesized `status` events at `session-switch.ts:337-340` carry the correct sessionId (not just any sessionId). Guards F2 correctness at the emitter.

### Main frontend PR (7 reviewable commits)

Each commit compiles and passes the existing test suite.

**1. Frontend: add new two-tier API, gated.**

- Introduce `sessionActivity`, `sessionMessages` maps; `SessionActivity`, `SessionMessages`, `SessionChatState` types; `createEmptySessionActivity`, `createEmptySessionMessages` factories (each returns a plain POJO — `$state` wrapping happens in `getOrCreateSessionActivity`/`getOrCreateSessionMessages` at insertion time, not inside the factory); `ACTIVITY_KEYS` const; `EMPTY_ACTIVITY`, `EMPTY_MESSAGES` (frozen POJOs with `toolRegistry` methods replaced by throwing stubs); `EMPTY_STATE` (`composeChatState`-wrapped view); `composeChatState(a, m)` read-only Proxy with full trap set (`get`/`set`/`has`/`ownKeys`/`getOwnPropertyDescriptor`); `getOrCreateSessionActivity`, `getOrCreateSessionMessages`, `getOrCreateSessionSlot`, `getSessionPhase`, `clearSessionChatState`, `currentChat()` `$derived`, LRU helpers (`touchLRU`, `ensureLRUCap`).
- Add `sessions: SvelteMap<string, SessionInfo>` to `sessionState` in `session.svelte.ts`, maintained alongside existing `rootSessions`/`allSessions` arrays. Used by the dispatcher's unknown-session guard and by `handleSessionList`'s diff path.
- Import `SvelteMap`, `SvelteSet` from `svelte/reactivity` (first use in `src/`).
- Old `chatState` still exported and used everywhere. New code is dead — no production call site invokes it.
- Old module-level globals (`registry`, `seenMessageIds`, `doneMessageIds`, `renderTimer`, `thinkingStartTime`, `deferredGeneration`) remain unchanged for now.
- **Tests landed in this commit:**
  - `test/unit/stores/session-chat-state-shape.test.ts` — asserts the union of `ACTIVITY_KEYS` and `Object.keys(createEmptySessionMessages())` exactly equals `keyof SessionChatState` (drift check — catches the case where a field is added to only one tier).
  - `test/unit/stores/session-chat-state-reactivity.test.ts` — mutates `getOrCreateSessionActivity(id).phase`; asserts a `$derived(currentChat().phase)` observer re-runs. If this fails, the SvelteMap-reactivity assumption is wrong and Task 2 cannot ship.
  - `test/unit/stores/compose-chat-state-proxy.test.ts` — asserts Proxy trap behavior: (a) `get` routes to the correct tier; (b) `$inspect(currentChat())` iterates keys correctly via `ownKeys`; (c) `"phase" in currentChat()` returns true; (d) `set` throws.
  - `test/unit/stores/empty-state-frozen.test.ts` — asserts `EMPTY_STATE` mutations throw in both dev and prod modes; `EMPTY_MESSAGES.toolRegistry.register()` throws (methods stubbed).
  - `test/unit/stores/handler-signatures.test.ts` — asserts the adapter generic preserves type narrowing and routes through `getOrCreateSessionSlot(currentId)`.

**2. Frontend: flip handlers (in-`chat.svelte.ts` + `ws-dispatch.ts`).**

- Rewrite every handler to take `(activity: SessionActivity, messages: SessionMessages, event)` as the leading arguments (some only need one tier — typed accordingly).
- Rename module-level `deferredGeneration` → the per-session `activity.replayGeneration` is the canonical counter. The module variable is removed in Task 3 (when replay state moves fully per-slot); Task 2 only introduces the per-session field. Document the rename in the commit message.
- Full handler list (cross-reference plan-of-record §"Expanded handler list"): `handleDelta`, `handleDone`, `handleStatus`, `handleThinkingStart`, `handleThinkingDelta`, `handleThinkingStop`, `handleToolStart`, `handleToolExecuting`, `handleToolResult`, `handleResult`, `handleError`, `handlePartRemoved`, `handleMessageRemoved`, `handleUserMessage`, plus non-`handle*` functions: `advanceTurnIfNewMessage`, `addUserMessage`, `ensureSentDuringEpochOnLastUnrespondedUser`, `flushAndFinalizeAssistant`, `flushAssistantRender`, `updateContextFromTokens`, `applyToolCreate`, `applyToolUpdate`, `setMessages`, `getMessages`, `requestScrollOnNextContent`, `consumeScrollRequest`, `cancelDeferredMarkdown`, `renderDeferredMarkdown`, `flushPendingRender`, phase helpers (`phaseToIdle`, `phaseToProcessing`, `phaseToStreaming`, `phaseToStartReplay`, `phaseToEndReplay`, `phaseToReset`), `prependMessages`, `seedRegistryFromMessages`, `addSystemMessage`, `beginReplayBatch`, `commitReplayFinal`, `discardReplayBatch`, `consumeReplayBuffer`, `getReplayBuffer`, `isEventsHasMore`.
- `getMessages`/`setMessages` become `(messages: SessionMessages) => ChatMessage[]` / `(messages: SessionMessages, value: ChatMessage[]) => void`. Every intra-module caller (`applyToolCreate`, `applyToolUpdate`, `handleDone`'s `registry.finalizeAll(getMessages(messages))`, `flushAssistantRender`) receives `messages` from its handler's parameters.
- Also flip `handleToolContentResponse` in `ws-dispatch.ts:825-843` (writes to `chatState.messages` directly today).
- `handleInputSyncReceived` (`chat.svelte.ts:162-179`) is **NOT** flipped — it writes to the cross-tab `inputSyncState`, which is inherently not per-session.
- `registerClearMessagesHook` signature widens to `(fn: (sessionId: string | null) => void) => void`. The caller at `chat.svelte.ts:1006` (`onClearMessages?.()`) passes `sessionState.currentId` (may be null during teardown). Hook body in Task 2 is signature-only plumbing — no behavior change until Task 3.
- Handler signatures use narrowed message types preserved via generic: `dispatchToCurrent<T extends PerSessionEvent>(fn: (activity, messages, msg: T) => void, msg: T)`.
- Wire through a temporary `dispatchToCurrent` adapter that routes to `getOrCreateSessionSlot(sessionState.currentId)`. **Adapter null-currentId policy** (matches Task 4's dispatcher policy): dev throws; prod increments `per_session_event_null_current_id` telemetry counter and returns. No EMPTY_STATE writes. The prod counter is monitored — it should be empirically zero because the server's session_list-first invariant (Phase 0b) ensures `currentId` is set before events arrive.
- **Dual-write `contextPercent`** during this commit: `handleResult`/`updateContextFromTokens` writes both `messages.contextPercent` AND legacy `uiState.contextPercent`. Stripped in Task 6.
- Module-level Sets (`seenMessageIds`, `doneMessageIds`) move to `SessionActivity` in this commit (handlers use `activity.seenMessageIds` etc.). Module exports stay for backward compat within this commit; Task 6 deletes them.
  - **`clearMessages` teardown:** in addition to calling module `seenMessageIds.clear()` / `doneMessageIds.clear()` (dead-but-present shells), additionally clear the CURRENT session's per-session Sets via `const a = getOrCreateSessionActivity(sessionState.currentId); a.seenMessageIds.clear(); a.doneMessageIds.clear();` (guarded on null `currentId`). Without this, re-entering the same session after `clearMessages` would carry over prior-turn messageIds.
- `replayBatch`, `replayBuffers`, `eventsHasMoreSessions`, `renderTimer`, `thinkingStartTime` stay module-scoped in this commit; move to `SessionActivity` in Task 3's replay-path flip to avoid mid-replay races during Task 2.
- **Test migration in the same commit:** 20+ test files import handlers directly (enumerated below). Every such test migrates to the new signature.
- **F2 is NOT applied in this commit** — see Task 4.
- **Tests landed in this commit:**
  - `test/unit/stores/handler-tier-contract.test.ts` — for each handler, dispatch one event via the adapter, assert only declared tier fields changed. Catches silent tier leaks (e.g., a handler that should only write Activity accidentally touching Messages).

**3. Frontend: flip replay path + buffer to per-slot.**

- Move `replayBatch`, `replayBuffers`, `liveEventBuffer`, `renderTimer`, `thinkingStartTime`, `replayGeneration`, `eventsHasMoreSessions` onto `SessionActivity` (as `replayBatch`, `replayBuffer`, `liveEventBuffer`, `renderTimer`, `thinkingStartTime`, `replayGeneration`, `eventsHasMore`). Delete the module-level `deferredGeneration` (replaced by `activity.replayGeneration`).
- `replayEvents(sessionId, ...)` captures `const slot = getOrCreateSessionSlot(sessionId)` at start; snapshots `const gen = slot.activity.replayGeneration`; threads `slot` through all internal dispatches; does NOT use `currentChat()` or `dispatchToCurrent`. At each async commit step, verifies `sessionActivity.get(sessionId) === slot.activity && slot.activity.replayGeneration === gen` — if not, aborts without committing (ghost-write guard).
- **Apply the same slot-capture + generation-snapshot pattern to `convertHistoryAsync` (`ws-dispatch.ts:459-469`, cache-miss `session_switched` branch) and to `ws-dispatch.ts:572-580` (history_page pagination).** Both must capture the target slot at start and commit only to that slot.
- `getMessages()` / the shared `dispatchChatEvent` at `ws-dispatch.ts:312` (used for TodoWrite lookup during replay) threads the captured slot rather than reading `currentChat()`.
- **Live-event buffer semantics** (per §Event routing, Live-event buffering):
  - Dispatcher accumulates live deltas in `activity.liveEventBuffer` when `liveEventBuffer !== null`. The flag is set to `[]` by `startBufferingLiveEvents(activity)` at replay start; nulled by `drainLiveEventBuffer(activity)` only AFTER the drain loop empties the buffer.
  - During drain, new live events push into the same `[]` buffer and are drained in the same pass. No null-before-drain race.
  - Drain loop re-enters `dispatchChatEvent(buffered, { isReplay: false })` AFTER `commitReplayFinal` and `phaseEndReplay`; dedup Sets are populated before drain so duplicate deltas suppress.
  - Buffer type is `PerSessionEvent[] | null` (not `RelayMessage[]`) — type system blocks accidental GlobalEvent pushes.
- **Concurrent `replayEvents(X)`:** a second call while replay 1 is in flight bumps `slot.activity.replayGeneration` and returns early. Replay 1's remaining async resolvers observe the generation mismatch and short-circuit. Replay 1 is NOT restarted — the second call is a signal that the history the client has is potentially stale, but cancelling replay 1 AND replay 2 would leave the client with neither.
- `registerClearMessagesHook` callback body: receives `sessionId: string | null`. If non-null, looks up `sessionActivity.get(sessionId)`; if present, sets `a.liveEventBuffer = null` and increments `a.replayGeneration`. No-op if slot already deleted.
- **Tests landed in this commit:**
  - `test/unit/stores/replay-per-slot-migration.test.ts` — asserts slot captured at start persists across mid-replay `currentId` change; replay's committed events appear in captured slot's messages, not `currentChat()`; `activity.liveEventBuffer` buffers+drains correctly; `clearSessionChatState(id)` mid-replay short-circuits via generation check.
  - `test/unit/stores/concurrent-replay-same-session.test.ts` — two `replayEvents(X)` calls, second aborts via generation bump; first continues; no cross-pollution; buffer preserved across the transition.
  - `test/unit/stores/convert-history-async-per-slot.test.ts` — cache-miss `session_switched` commits to captured slot, not `currentChat()`.

**4. Frontend: flip dispatcher + F2 fix.**

- `ws-dispatch.ts` implements the two-tier `dispatchEvent` with `routePerSession(event)` (see §Event routing). `dispatchToCurrent` adapter deleted.
- Dev-mode assertion on missing/empty `sessionId` using repo's `(import.meta as { env?: { DEV?: boolean } }).env?.DEV` pattern. Prod: telemetry counter `per_session_event_missing_sessionid`, no throw.
- `advanceTurnIfNewMessage` is gated with `"messageId" in event && event.messageId != null` — many PerSessionEvent variants (status, error, done, ask_user, etc.) have no `messageId` field and must not invoke it.
- `notification_event` handling: despite carrying `sessionId`, routed to `dispatchGlobalEvent` (notification reducer), NOT `routePerSession`. The `PerSessionEventType` union defined in Task 1 excludes it by construction.
- Unknown-session guard: drop events for sessionIds not in `sessionState.sessions` (the new map); telemetry counter `per_session_event_unknown_session` increments. Under Phase 0b's session_list-first invariant this should be empirically zero.
- **F2 fix applies here:** `handleStatus(activity, messages, event)` with `event.status === "idle"` performs the full cleanup sequence described in §Reconciled fixes: finalize in-flight message (if any) via synthesized `done`, set `activity.phase = "idle"`, clear `activity.currentMessageId`, `messages.currentAssistantText`, `activity.thinkingStartTime`, drain `activity.liveEventBuffer` if non-null. Safe now because routing is by `event.sessionId` — an idle for session B can no longer reach A's slot.
- Requires preceding server PR landed (Phase 0b + Task 1).
- **Tests landed in this commit:**
  - `test/unit/stores/session-chat-state-routing.test.ts` — dispatch a delta for B while `currentId=A`; assert B's slot mutates, A's slot untouched, `currentChat()` untouched.
  - `test/unit/stores/concurrent-session-dispatch.test.ts` — interleaved deltas for A/B/C; each slot independent; specific scenarios:
    - live event for X arrives during X's own replay → buffered, drained post-commit.
    - live event for X arrives during Y's replay → applied directly to X's slot (Y's buffer untouched).
    - `notification_event` for B while `currentId=A` → notification reducer receives it; no chat-slot mutation.
    - prod missing-sessionId → counter increments, no throw.
    - unknown-session → counter increments, event dropped.
    - exhaustive-switch-default on new variant → counter `unhandled_per_session_event` increments, no throw.
  - `test/unit/stores/status-idle-clears-streaming.test.ts` — covers F2 cleanup sequence (in-flight finalization, phase reset, buffer drain, state fields cleared).
  - `test/unit/stores/regression-phase-no-leak.test.ts` — switch A(streaming) → B(idle) → A asserts `currentChat().phase` reflects A's actual state at every tick; switch mid-turn asserts no bleed.

**5. Frontend: flip components + stories.**

(Swapped position with the old "delete globals" task because deleting the module-level `uiState.contextPercent` / `historyState` / `updateContextPercent` before components migrate would break compilation.)

- Codemod `chatState.X` → `currentChat().X` across all `.svelte` files and `*.stories.ts`.
- Explicit component list: `MessageList.svelte` (lines 47-49, 89, 92, 110-112, 123, 180, 189, 225, 233), `InputArea.svelte` (lines 107, 465; line 229 is `isProcessing()` call — auto-migrates), `SessionItem.svelte` (lines 7, 75-78 — delete import, replace dot logic), `UserMessage.svelte` (lines 9, 19, 22-33 `$inspect` migrate, 27, 29, 30), `ChatLayout.svelte` (line 49 import cleanup), `HistoryLoader.svelte` (lines 35-92 — `historyState.*` → `currentChat().X`), `MessageList.stories.ts`, `InputArea.stories.ts` (lines 40, 60, 66, 72).
- `InfoPanels.svelte` derives `contextPercent` from a prop (`contextData`) — **not** from `uiState.contextPercent` — so no migration required there.
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

**6. Frontend: delete globals + wire teardown.**

- Remove `chatState` module export; delete module-level `seenMessageIds`, `doneMessageIds`, `liveEventBuffer` globals (Task 2 moved dedup sets per-session; Task 3 moved buffer per-session — deletion is safe here); delete `stashSessionMessages`, `restoreCachedMessages` (the two-tier store replaces the stash/restore cache); delete the module-level `registry` singleton (`chat.svelte.ts:200`) — per-session `messages.toolRegistry` replaces it.
- `evictCachedMessages` is NOT renamed — it is DELETED. The two operations it conflated (LRU and teardown) are now `ensureLRUCap()` (LRU, Tier 2 only) and `clearSessionChatState(id)` (teardown, both tiers). No single "evict" operation exists.
- Delete `uiState.contextPercent` field and `updateContextPercent` helper; all callers now write only `messages.contextPercent`. Callers that were dual-writing in Task 2 are simplified in this commit.
- Delete the module-level `historyState` object; its fields now live on `SessionMessages`. `HistoryLoader.svelte` was migrated in Task 5, so the deletion is safe.
- Wire `clearSessionChatState` to:
  - `session_deleted` relay event listener (new variant introduced in server PR Task 1).
  - Inside `handleSessionList` via diff logic: snapshot `Array.from(sessionState.sessions.keys())` before applying the incoming list; after applying, compute removed ids and call `clearSessionChatState(id)` for each. **Guard:** skip the diff if the incoming list is a filtered/search payload (check `isFilteredPayload` or equivalent flag on the message; implementation resolves against `src/lib/handlers/session.ts:242-270` structure).
- Slot factory defaults: `contextPercent: 0`, `historyHasMore: false`, `historyMessageCount: 0`, `historyLoading: false`, `phase: "idle"` — mirrors `ui.svelte.ts:74` and `session.svelte.ts:354` init behavior.
- **Test migration:** `test/unit/stores/turn-epoch-queued-pipeline.test.ts:55-56,424-429` imports stash/restore directly — migrate or delete those assertions. `test/unit/stores/chat-store.test.ts:687,697,746,753` references `doneMessageIds` — verify assertions still work against the per-session Sets.
- **Tests landed in this commit:**
  - `test/unit/stores/session-slot-eviction.test.ts` — LRU cap on Tier 2; never evicts current; evicted session re-entered lazily reconstructs from server events + buffer drain; slot-identity check short-circuits stale resolver on mid-replay eviction.
  - `test/unit/stores/ghost-session-cleanup.test.ts` — `clearSessionChatState` wired to `session_deleted` event AND to `handleSessionList` drop path; both tiers cleared; sidebar row disappears; search-payload non-eviction (filtered list does not trigger clears); active-session teardown falls back to `EMPTY_STATE`; mid-replay teardown aborts replay via generation bump.

**7. Delete dead code.**

- Remove any shim residuals: `dispatchToCurrent` (already deleted in Task 4, verify clean), orphaned comments, `@deprecated` markers, unused imports in `session.svelte.ts:12-13` (stash/restore call sites), `.stories.ts` mocks of the old `chatState`.
- `CHAT_EVENT_TYPES` constant at `ws-dispatch.ts:368` is **still in use** as the gate for `activity.liveEventBuffer` drain — do NOT remove. Only remove if some later PR eliminates per-session buffering entirely.
- "Net non-test LOC should be roughly flat or negative, excluding the new invariant test files." Heuristic gate for reviewer attention, not a hard merge block.
- `tsc` + lint are the safety net: any stale import fails the typecheck. Per-commit invariant "each commit compiles" means Task 7 cannot land with broken references.

## Tests

**New invariant tests (must pass before merge):**

- `test/unit/stores/session-chat-state-shape.test.ts` — drift check: factories produce exactly `keyof SessionChatState`. (Task 1.)
- `test/unit/stores/session-chat-state-reactivity.test.ts` — mutation through SvelteMap value triggers derived re-run. (Task 1.)
- `test/unit/stores/compose-chat-state-proxy.test.ts` — Proxy trap behavior: get routes correctly; ownKeys iteration works; `in` operator correct; writes throw. (Task 1.)
- `test/unit/stores/empty-state-frozen.test.ts` — `EMPTY_STATE` mutations throw; `EMPTY_MESSAGES.toolRegistry` method calls throw. (Task 1.)
- `test/unit/stores/handler-signatures.test.ts` — adapter preserves type narrowing; routes through `getOrCreateSessionSlot(currentId)`. (Task 1.)
- `test/unit/stores/handler-tier-contract.test.ts` — each handler touches only its declared tier fields. (Task 2.)
- `test/unit/stores/replay-per-slot-migration.test.ts` — slot captured at replay start; buffer drains correctly; clearSessionChatState short-circuits via generation. (Task 3.)
- `test/unit/stores/concurrent-replay-same-session.test.ts` — second replayEvents(X) aborts first; buffer preserved. (Task 3.)
- `test/unit/stores/convert-history-async-per-slot.test.ts` — cache-miss session_switched commits to captured slot. (Task 3.)
- `test/unit/stores/session-chat-state-routing.test.ts` — dispatcher routes by event.sessionId; untouched slots stay untouched. (Task 4.)
- `test/unit/stores/concurrent-session-dispatch.test.ts` — scenarios: live-during-own-replay, live-during-other-replay, notification_event non-routing, missing-sessionId prod drop, unknown-session drop, exhaustive-switch-default. (Task 4.)
- `test/unit/stores/status-idle-clears-streaming.test.ts` — F2 full cleanup. (Task 4.)
- `test/unit/stores/regression-phase-no-leak.test.ts` — A→B→A phase assertion. (Task 4.)
- `test/unit/stores/session-slot-eviction.test.ts` — LRU, reconstruct-after-evict, slot-identity protection. (Task 6.)
- `test/unit/stores/ghost-session-cleanup.test.ts` — teardown via both paths; search-payload guard; active-session teardown; mid-replay teardown. (Task 6.)
- `test/unit/components/per-session-component-isolation.test.ts` — no cross-session re-render. (Task 5.)
- `test/unit/relay/per-session-event-has-sessionid.test.ts` — emitter contract. (Server PR.)
- `test/unit/relay/phase-0b-ordering.test.ts` — broadcast preserves per-session delta order. (Server PR.)
- `test/unit/relay/phase-0b-session-list-first.test.ts` — session_list always emitted first on new connection. (Server PR.)
- `test/unit/session/patchMissingDone-claude-sdk.test.ts` — F3 coverage. (Server PR.)
- `test/unit/session/synthesized-status-sessionid.test.ts` — F2 emitter correctness: synthesized status events at session-switch.ts:337-340 carry correct sessionId. (Server PR.)

**Migrated tests.** Every existing test that reads or writes `chatState.X` migrates to the per-session shape. Files: `chat-phase.test.ts`, `chat-store.test.ts`, `regression-mid-stream-switch.test.ts`, `regression-session-switch-history.test.ts`, `turn-epoch-queued-pipeline.test.ts`, `thinking-invariants.test.ts`, `chat-thinking-done.test.ts`, `ws-message-dispatch.test.ts`, `dispatch-coverage.test.ts`, `replay-batch.test.ts`, `replay-paging.test.ts`, `chunked-replay.test.ts`, `async-history-conversion.test.ts`, `race-history-conversion.test.ts`, `deferred-markdown.test.ts`, `regression-dual-render-duplication.test.ts`, `regression-queued-replay.test.ts`, `scroll-lifecycle-integration.test.ts`, `dispatch-notifications.test.ts`, `dispatch-notification-reducer.test.ts`, `history-loader.test.ts`. Each migrates in the same commit that flips the symbols it imports.

**Storybook.** Multi-session sidebar story with three sessions and varied phases; only non-idle sessions pulse. Regression story mirroring the triggering bug (switch away then back with both sessions idle).

**E2E.** Playwright test: open project with two sessions (one active, one idle), navigate away from the idle session and back, assert bounce bar not visible on the idle session's view and that the idle session's sidebar dot is not pulsing.

## Risks

| Risk | Mitigation |
|------|------------|
| Server event emitted without `sessionId` → silent routing drop | Exhaustive `Extract<RelayMessage, { type: PerSessionEventType; sessionId: string }>` narrowing; contract test exercises every emitter; runtime dev assertion throws; prod telemetry counter monitored as SEV. |
| Project-scoped firehose bandwidth spike after Phase 0b | Measure event rate per client before/after. Subscribe-list protocol held as fallback if a high-activity project shows regression. |
| SvelteMap reactivity gotchas (missed notification on deep mutation) | Reactivity invariant test in Task 1 gates everything downstream. Dev-time lint: discourage `.entries()`/`.values()` iteration on the activity/messages maps. |
| `composeChatState` Proxy breaks `$inspect` / other introspection | Proxy trap spec mandates `ownKeys` + `getOwnPropertyDescriptor`; `compose-chat-state-proxy.test.ts` verifies `$inspect` iteration. |
| Tier 2 eviction drops messages for a session that re-enters | `view_session` rehydrates from server event log; `SessionActivity.liveEventBuffer` drains post-rehydration. Covered by `session-slot-eviction.test.ts`. |
| Ghost slot for a deleted session (pulsing row with no SessionInfo row) | `clearSessionChatState` wired to `session_deleted` event + `handleSessionList` drop path with search-payload guard; unknown-session guard in `routePerSession` drops phantom events with telemetry. |
| Mid-replay session switch cross-contaminates slots | `replayEvents(sessionId)` captures slot at start, threads through all dispatches; per-slot `replayGeneration` + slot-identity check short-circuits stale resolvers. Covered by `replay-per-slot-migration.test.ts`. |
| Frontend PR ships without server PR (rollback window) | Rollback policy: if server PR is reverted, frontend PR must also revert. Frontend does NOT include a transitional fallback — strict dependency. Captured in the deploy runbook for this change. |
| Phase 0b ordering violation (per-session events out of order) | `phase-0b-ordering.test.ts` in the server PR. Monitoring a dev-mode assertion in the frontend dispatcher: if a `delta` for messageId M arrives after a `done` for M, log telemetry. |
| Startup race (events before session_list) | Server invariant: `session_list` first. Server-side queue holds any per-session event that fires during bootstrap until `session_list` is sent. `phase-0b-session-list-first.test.ts` asserts the invariant. Frontend's unknown-session guard is a belt-and-suspenders defense. |
| Multiple tool registries (one per session) raise memory | Registries are small (tool metadata only); live in Tier 2, so LRU eviction disposes them. |
| Two-tier split adds surface area (two maps, composite Proxy) | Offset by removing buffering code complexity and the LRU phase-preservation rule. Monitoring test coverage (reactivity invariant, drift check, composition Proxy) catches regressions. |
| Hard-cut codemod touches many files, hurts bisect granularity | 7 reviewable commits in the main PR; each compiles and passes tests. Preceding server PR is mechanical and independently bisectable. |

## Non-Goals

- Todo store, permissions store, file-tree store — have the same singleton smell but are separate follow-ups.
- Multi-user / multi-tab synchronization beyond the existing `input_sync` mechanism.
- Persistence layer changes (SQLite projectors, event store) — unchanged.
- Provider adapter changes beyond `sessionId` tagging on emitted events.
- UI redesign — this is state-plumbing only.
- Renaming `view_session` to a more accurate name. See §Known Debt.

## Known Debt After This Refactor

- `permissions.svelte.ts`, `todo.svelte.ts`, `file-tree.svelte.ts` retain the same "global that is semantically per-session" shape. Each is a candidate for the same treatment. Out of scope here, tracked as follow-up.
- **`view_session` name / semantics.** After Phase 0b, `view_session` no longer controls event delivery but still triggers history fetch, cross-client `session_viewed` broadcast, and metadata send. The name conflates several responsibilities. A follow-up could either (a) rename to `get_session_history` if draft/presence ever decouple, or (b) split into `set_viewing(sessionId)` (UI-state) + `get_session_history(sessionId)` (data fetch). Not addressed in this refactor to keep PR scope tight.

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

## Appendix C: Amendment history

- **Loop 1 (2026-04-20):** 72 Amend-Plan findings resolved. Key changes: two-tier data model (Activity + Messages), `Extract<RelayMessage, …>` typing, Phase 0b prerequisite, F2 moved to Task 4, exhaustive event list, emitter-side tag strategy, ghost-slot cleanup, mid-replay race prevention, frozen-POJO sentinel, per-session `historyState`.
- **Loop 2 (2026-04-20):** 46 Amend + 8 Ask-User findings resolved. Key changes: `composeChatState` Proxy spec with full trap set; `$state` factory pattern corrected (POJO in, `$state` wrap in getOrCreate); `createToolRegistry` reference fixed; `sessions` SvelteMap added to sessionState; dispatcher snippet fixes (messageId gate, notification_event classified as Global); F2 expanded to full cleanup sequence; `evictSessionSlot` concept deleted; commit ordering swap (components before globals deletion); `handleSessionList` diff logic with search-payload guard; `convertHistoryAsync` + pagination slot-capture; buffer-hold during drain; concurrent-replay semantics; `replayGeneration` rename disambiguated; `view_session` semantics accurately described; Phase 0b ordering invariants added; test enumeration expanded.
