# Resilience & Maintainability Findings

> Produced 2026-03-24 from two independent code analyses of the conduit relay codebase.
> Findings are ordered by impact. Work through top-to-bottom.
>
> **Updated 2026-03-24:** Reviewed against `feature/turn-epoch-resilience` merge to main.
> The ChatPhase refactor on main replaced `chatState.streaming`/`.processing`/`.replaying`
> booleans with a discriminated union + phase transition functions — addressing the Svelte 5
> reactive boundary concern from the original analysis (not listed below since it was lower
> priority than the 12 findings included). All 12 findings below remain valid. See note on #3.

---

## CRITICAL — Prevents bugs now

### 1. Race condition in fire-and-forget history conversion

**Files:** `src/lib/frontend/stores/ws-dispatch.ts:301-307`, `:407-415`

When two rapid `session_switched` messages arrive, the second `clearMessages()` runs synchronously, but the first's async `convertHistoryAsync` `.then()` callback can still execute — writing stale history from the wrong session into the new session's message list.

The `replayGeneration` mechanism protects the replay path (`replayEvents`) but not the history conversion path. The `.then()` callback checks `if (chatMsgs)` but never re-verifies that the generation hasn't changed.

The same issue exists in the `history_page` handler at line 407.

**Fix:** Snapshot generation before the async fire-and-forget, re-check in `.then()`:
```ts
const gen = replayGeneration;
convertHistoryAsync(historyMsgs, renderMarkdown).then((chatMsgs) => {
    if (chatMsgs && gen === replayGeneration) {
        prependMessages(chatMsgs);
        seedRegistryFromMessages(chatMsgs);
        // ...
    }
});
```

**Scope:** Two call sites in `ws-dispatch.ts` (`session_switched` history path and `history_page` handler).

---

### 2. Unsafe `as` cast bypasses discriminated union narrowing

**File:** `src/lib/relay/event-pipeline.ts:151`

```ts
deps.toolContentStore.store(
    (result.msg as { id: string }).id,   // unsafe cast
    result.fullContent,
    sessionId,
);
```

`result.msg` is `RelayMessage` (a discriminated union). The cast to `{ id: string }` bypasses TypeScript's union narrowing. Only `tool_result` variants have an `id` field. The guard is `result.fullContent !== undefined`, which happens to correlate with `tool_result` today but isn't enforced by the type system.

**Fix:** Add a discriminated union guard:
```ts
if (result.fullContent !== undefined && sessionId && result.msg.type === "tool_result") {
    deps.toolContentStore.store(result.msg.id, result.fullContent, sessionId);
}
```

**Scope:** Single site.

---

## HIGH — Prevents future bugs

### 3. Duplicated dispatch logic between `handleMessage()` and `replayEvents()`

**File:** `src/lib/frontend/stores/ws-dispatch.ts:195-547` (handleMessage), `:559-676` (replayEvents)

Both functions have switch statements dispatching the same event types to the same handlers, with subtle differences. The replay switch handles ~12 types; `handleMessage` handles 40+. The selection of which types are "replayable" is implicit knowledge. Adding a new cacheable event type (e.g. `code_action`) requires updating both switches, with no compile-time or test enforcement that they stay in sync.

Specific divergences:
- `replayEvents` omits `tool_content`
- `user_message` has different semantics (queued flag handling)
- `error` routes to `handleError` vs `handleChatError`
- No `result` deduplication in replay path

**Fix:** Extract a shared `dispatchChatEvent(event, { isReplay })` function for all cache-eligible event types. The `CACHEABLE_EVENT_TYPES` constant in `event-pipeline.ts:57` already defines which types enter the cache — use it to drive exhaustiveness.

> **Post-merge note:** The `feature/turn-epoch-resilience` merge replaced the `wasStreaming` snapshot pattern with `shouldClearQueuedOnContent()` in both switches, reducing one divergence. But the structural duplication (two parallel switch statements) remains — this finding is still valid.

**Scope:** `ws-dispatch.ts` refactor. No backend changes.

---

### 4. `OpenCodeEvent` typed as `{ type: string; properties: Record<string, unknown> }`

**File:** `src/lib/types.ts:32-35`

Every consumer must use type guards or unsafe `as` casts to access properties. The translator at `event-translator.ts:557` does string comparisons on `event.type` with no exhaustiveness checking. New OpenCode event types are silently dropped with "unhandled event type" — no compile-time flag.

The typed event interfaces already exist in `opencode-events.ts` (`PartDeltaEvent`, `PartUpdatedEvent`, `SessionStatusEvent`, etc.) — they just aren't composed into a union.

**Fix:** Compose existing typed events into a discriminated union:
```ts
type OpenCodeEvent =
    | PartDeltaEvent
    | PartUpdatedEvent
    | PartRemovedEvent
    | SessionStatusEvent
    | SessionErrorEvent
    | MessageCreatedEvent
    | MessageUpdatedEvent
    | MessageRemovedEvent
    | PermissionAskedEvent
    | PermissionRepliedEvent
    | QuestionAskedEvent
    | { type: string; properties: Record<string, unknown> }; // catch-all for unknown
```

Use `satisfies never` in the translator's default case so new event types added to the union produce compile errors.

**Scope:** `types.ts`, `opencode-events.ts`, `event-translator.ts`. Cascading type improvements in `sse-wiring.ts`.

---

### 5. `HandlerDeps` has ~15 optional fields that are required at runtime

**Files:** `src/lib/handlers/types.ts:23-92`, `src/lib/relay/relay-stack.ts:445-491`

Fields like `registry`, `getInstances`, `addInstance`, `pollerManager` are typed as optional but crash at runtime if absent. `relay-stack.ts:445-491` conditionally spreads them from config. Adding a handler that uses `deps.getProjects` produces no compile error if the wiring in relay-stack omits it.

**Fix:** Split into required base + capability interfaces:
```ts
interface HandlerCoreDeps { wsHandler; client; sessionMgr; messageCache; log; /* ... */ }
interface InstanceCapabilities { getInstances; addInstance; removeInstance; /* ... */ }
type InstanceHandlerDeps = HandlerCoreDeps & InstanceCapabilities;
```

Each handler declares what it needs. Compiler enforces wiring completeness at the relay-stack call site.

**Scope:** `handlers/types.ts`, individual handler files, `relay-stack.ts` wiring.

---

### 6. Session create-delete race leaks pollers

**File:** `src/lib/relay/relay-stack.ts:406-437`

```ts
sessionMgr.on("session_lifecycle", async (ev) => {
    const sid = ev.sessionId;
    translator.reset(sid);
    if (ev.type === "created") {
        const existingMessages = await rebuildTranslatorFromHistory(...);
        // After await: session may have been deleted
        if (existingMessages) {
            pollerManager.startPolling(sid, existingMessages);  // orphan poller
        }
    }
```

After the `await`, a rapid create-delete sequence means the delete handler's `pollerManager.stopPolling(sid)` ran *before* this `startPolling` call — creating an orphaned poller that never stops.

**Fix:** Guard after the await:
```ts
if (existingMessages && sessionMgr.hasSession(sid)) {
    pollerManager.startPolling(sid, existingMessages);
}
```

Or track a set of "deleted during init" session IDs.

**Scope:** Single site in `relay-stack.ts`. May need a `hasSession()` method on `SessionManager`.

---

### 7. SSE reconnect rehydration can double-broadcast questions

**File:** `src/lib/relay/sse-wiring.ts:403-516`

On SSE reconnect, two independent fire-and-forget async chains rehydrate permissions and questions. Rapid reconnect can overlap runs. The permission path deduplicates via `PermissionBridge.recoverPending`, but the question path has no deduplication — a rapid reconnect sends duplicate `ask_user` messages to clients.

**Fix:** Track a rehydration generation counter:
```ts
let rehydrationGen = 0;
consumer.on("connected", () => {
    const gen = ++rehydrationGen;
    deps.listPendingQuestions?.()
        .then((questions) => {
            if (gen !== rehydrationGen) return; // superseded
            // ...
        });
});
```

**Scope:** Single site in `sse-wiring.ts`.

---

## MEDIUM — Improves developer experience

### 8. Adding a new browser-to-server message requires 5+ file changes

Adding a message type (e.g. `get_status`) requires changes in:
1. `handlers/payloads.ts` — payload type
2. `handlers/*.ts` — handler function
3. `handlers/index.ts` — import + registration in `MESSAGE_HANDLERS`
4. `shared-types.ts` — response variant in `RelayMessage`
5. `ws-dispatch.ts` — frontend dispatch case
6. Frontend send function

None are enforced by the compiler. `MESSAGE_HANDLERS` is `Record<string, ...>` so missing handlers aren't caught.

**Fix:** Type `MESSAGE_HANDLERS` as `Record<keyof PayloadMap, MessageHandler>`. Consider a `defineHandler()` pattern that bundles payload type + handler + registration.

**Scope:** `handlers/index.ts`, `handlers/types.ts`.

---

### 9. `relay-stack.ts` is an 1100-line god function

`createProjectRelay()` (lines 165-842) instantiates ~20 components with closures capturing shared scope. Every new component must be threaded through this function. Subsystems like monitoring wiring (lines 629-685) and PTY wiring are self-contained but embedded.

**Fix:** Extract subsystem wiring into focused modules: `monitoring-wiring.ts`, `pty-wiring.ts`, `poller-wiring.ts`. Each exports a setup function with an explicit interface. `relay-stack.ts` orchestrates lifecycle but delegates wiring.

**Scope:** Large refactor of `relay-stack.ts`. Low risk if done module-by-module.

---

### 10. `CACHEABLE_EVENT_TYPES` and `LLM_CONTENT_START_TYPES` disconnected from `RelayMessage`

**Files:** `event-pipeline.ts:57`, `ws-dispatch.ts:125`

Adding a new `RelayMessage` variant doesn't force a decision about cacheability or content-start classification. These invariants are enforced by developer memory only.

**Fix:** Type-level assertion:
```ts
type _Assert = CacheableEventType extends RelayMessage["type"] ? true : never;
```
And require every new `RelayMessage` variant to be explicitly placed in either `CACHEABLE` or `NON_CACHEABLE`.

**Scope:** `event-pipeline.ts`, `shared-types.ts`.

---

### 11. History and live paths produce `ToolMessage` differently

**Files:** `history-logic.ts:189-221`, `tool-registry.ts`

History conversion creates `ToolMessage` with pre-populated `result`/`input`/`metadata`. Live path starts as `status: "pending"` and progressively enriches. Same type, different semantic guarantees. Adding a new field requires updating both paths independently.

**Fix:** Single canonical factory `createToolMessage(source, data)` used by both paths. Ensures all required fields are present regardless of origin.

**Scope:** `history-logic.ts`, `tool-registry.ts`. New shared utility.

---

### 12. Notification policy duplicated across 3 event paths

**Files:** `sse-wiring.ts:384`, `relay-stack.ts:749`, `relay-stack.ts:600`

SSE path, message poller, and status poller each inline their own notification/broadcast logic with slightly different subagent handling. Only the status poller uses the extracted `resolveNotifications()` pure function.

**Fix:** Route all three paths through `resolveNotifications()`.

**Scope:** `sse-wiring.ts`, `relay-stack.ts`. The pure function already exists in `notification-policy.ts`.

---

## Priority Matrix

| # | Severity | Type | Effort | Risk if unfixed |
|---|----------|------|--------|-----------------|
| 1 | CRITICAL | Race condition | Small (2 sites) | Stale session data shown to user |
| 2 | CRITICAL | Type safety | Trivial (1 line) | Runtime crash on future change |
| 3 | HIGH | Duplication | Medium (refactor) | Bug on every new event type |
| 4 | HIGH | Type safety | Medium (union type) | Silent event drops |
| 5 | HIGH | Type safety | Medium (interface split) | Runtime crash on new handlers |
| 6 | HIGH | Race condition | Small (1 guard) | Orphaned pollers leak resources |
| 7 | HIGH | Race condition | Small (generation counter) | Duplicate UI prompts |
| 8 | MEDIUM | DX friction | Small (type change) | Missing handlers found late |
| 9 | MEDIUM | DX friction | Large (extract modules) | Cognitive overload |
| 10 | MEDIUM | Type safety | Small (assertion) | Subtle cache/replay bugs |
| 11 | MEDIUM | Duplication | Medium (factory fn) | Missing fields in one path |
| 12 | MEDIUM | Duplication | Small (route through fn) | Inconsistent notifications |
