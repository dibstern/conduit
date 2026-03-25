# Resilience & Maintainability Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Implement all 12 findings from the resilience analysis, grouped into 7 plans.

**Architecture:** Each plan targets an independent concern. Plans are sequenced to avoid merge conflicts on shared files. Plans A-B are small critical fixes; C-F are medium refactors; G is a large decomposition.

**Execution order:** A → B → C → D → E → F → G

---

## Sequencing & Overlap Management

The 12 findings touch overlapping files. This plan sequences work to avoid conflicts:

| Plan | Findings | Key Files | Dependencies |
|------|----------|-----------|--------------|
| **A** | #1, #6, #7 | ws-dispatch.ts, relay-stack.ts, sse-wiring.ts | None (go first) |
| **B** | #2 | event-pipeline.ts | None |
| **C** | #4, #10 | types.ts, opencode-events.ts, event-translator.ts, event-pipeline.ts | B first (same file) |
| **D** | #5, #8 | handlers/types.ts, handlers/index.ts, relay-stack.ts | A#6 first (same file region) |
| **E** | #3 | ws-dispatch.ts | A#1 first (same file) |
| **F** | #11, #12 | history-logic.ts, tool-registry.ts, sse-wiring.ts, relay-stack.ts | A first (same files) |
| **G** | #9 | relay-stack.ts | D and A#6 first (they modify relay-stack) |

---

## Plan A: Async Race Guards

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate three race conditions where fire-and-forget async operations can write stale data.

**Architecture:** Add generation counters / post-await guards to three async patterns.

---

### Task A1: Guard history `.then()` callbacks with generation check (Finding #1)

> **Audit note (A-1):** Write a focused test BEFORE the fix. Existing tests cover mid-conversion aborts (convertHistoryAsync returning null) but NOT the case where conversion completes and `.then()` fires after a session switch. Add a test in `test/unit/stores/race-history-conversion.test.ts` that: (1) sends `session_switched` with history, (2) sends a second `session_switched` immediately, (3) resolves both async conversions, (4) asserts only the second session's messages are present. Same pattern for `history_page`.

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Create: `test/unit/stores/race-history-conversion.test.ts` (test the stale-write window)
- Test: `test/unit/stores/regression-session-switch-history.test.ts` (verify existing race tests still pass)

**Step 1: Fix `session_switched` history path**

In the `session_switched` handler (around line 298), snapshot `replayGeneration` before the async call and re-check in `.then()`:

```ts
const gen = replayGeneration; // snapshot before async
convertHistoryAsync(historyMsgs, renderMarkdown)
    .then((chatMsgs) => {
        if (chatMsgs && gen === replayGeneration) {
            prependMessages(chatMsgs);
            seedRegistryFromMessages(chatMsgs);
            historyState.hasMore = hasMore;
            historyState.messageCount = msgCount;
        }
    })
```

**Step 2: Fix `history_page` handler**

Same pattern in the `history_page` handler (around line 407). The `historyState.loading = false` reset must happen unconditionally:

```ts
const gen = replayGeneration;
convertHistoryAsync(rawMessages, renderMarkdown)
    .then((chatMsgs) => {
        if (chatMsgs && gen === replayGeneration) {
            prependMessages(chatMsgs);
            seedRegistryFromMessages(chatMsgs);
            historyState.hasMore = hasMore;
            historyState.messageCount += rawMessages.length;
        }
        historyState.loading = false; // ALWAYS reset
    })
```

**Step 3: Verify**

```bash
pnpm test:unit test/unit/stores/regression-session-switch-history.test.ts
pnpm test:unit test/unit/stores/async-history-conversion.test.ts
```

---

### Task A2: Guard post-await `startPolling` with deletion check (Finding #6)

> **Audit note (A-1):** Write a test BEFORE the fix. Create `test/unit/relay/race-session-lifecycle.test.ts` that simulates interleaved create-delete events and verifies `startPolling` is NOT called for deleted sessions.

> **Audit note (A-2):** Clean up `deletedSessions` immediately after the guard check to prevent unbounded growth. The set only needs to survive the `rebuildTranslatorFromHistory` await window.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (session_lifecycle handler, around line 406)
- Create: `test/unit/relay/race-session-lifecycle.test.ts`

**Step 1: Add a `deletedSessions` Set**

Before the `sessionMgr.on("session_lifecycle", ...)` registration, add:

```ts
const deletedSessions = new Set<string>();
```

**Step 2: Update the handler**

In the `"created"` branch, clear stale flag and guard after await:

```ts
if (ev.type === "created") {
    deletedSessions.delete(sid); // clear stale flag from recycled IDs
    const existingMessages = await rebuildTranslatorFromHistory(
        translator, (id) => client.getMessages(id), sid, sessionLog,
    );
    if (deletedSessions.has(sid)) {
        sessionLog.debug(`Skipping poller start for ${sid.slice(0, 12)} — deleted during init`);
        deletedSessions.delete(sid); // clean up — only needed for the await window
        return;
    }
    if (existingMessages) {
        pollerManager.startPolling(sid, existingMessages);
    }
} else {
    deletedSessions.add(sid);
    pollerManager.stopPolling(sid);
    // ... rest of delete cleanup unchanged
    // Clean up after stop completes — the set only guards the create→await→start window
    deletedSessions.delete(sid);
}
```

NOTE: `deletedSessions.delete(sid)` in the delete branch happens synchronously after `stopPolling`. Since the create branch's `await` hasn't resolved yet, the set entry survives long enough for the guard. The delete at the end prevents unbounded growth.

**Step 3: Verify**

```bash
pnpm check && pnpm test:unit
```

---

### Task A3: Generation counter for SSE rehydration (Finding #7)

> **Audit note (A-1):** Write a test BEFORE the fix. Create `test/unit/relay/race-sse-rehydration.test.ts` that fires `connected` twice rapidly, resolves both question deferreds, and verifies questions are broadcast only once.

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts` (`wireSSEConsumer` function, around line 397)
- Create: `test/unit/relay/race-sse-rehydration.test.ts`

**Step 1: Add counter before the `connected` handler registration**

```ts
let rehydrationGen = 0;
```

**Step 2: Increment in connected handler, guard in `.then()` callbacks**

```ts
consumer.on("connected", () => {
    const gen = ++rehydrationGen;
    // ... existing broadcast code ...

    // In permissions .then() (around line 415):
    .then((pendingPermissions) => {
        if (gen !== rehydrationGen) return; // superseded
        // ... existing rehydration code ...
    })

    // In questions .then() (around line 467):
    .then((pendingQuestions) => {
        if (gen !== rehydrationGen) return; // superseded
        // ... existing rehydration code ...
    })
});
```

**Step 3: Verify**

```bash
pnpm test:unit test/unit/relay/sse-wiring.test.ts && pnpm check
```

---

### Task A4: Full verification

```bash
pnpm check && pnpm lint && pnpm test:unit
```

---

## Plan B: Unsafe Cast Fix

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace unsafe `as` cast with discriminated union narrowing in event pipeline.

**Architecture:** Add type guard before accessing `msg.id` so TypeScript verifies the field exists.

---

### Task B1: Add type guard and regression test

**Files:**
- Modify: `src/lib/relay/event-pipeline.ts` (around line 149)
- Modify: `test/unit/relay/event-pipeline.test.ts`

**Step 1: Add regression test**

In the `applyPipelineResult` describe block, add:

```ts
it("does not store fullContent when msg is not a tool_result", () => {
    const deps = makeDeps();
    const result: PipelineResult = {
        msg: { type: "delta", text: "hi" },
        fullContent: "some content that somehow got set",
        route: { action: "send", sessionId: "ses_abc" },
        cache: true,
        timeout: "reset",
        source: "sse",
    };
    applyPipelineResult(result, "ses_abc", deps);
    expect(deps.toolContentStore.store).not.toHaveBeenCalled();
});
```

**Step 2: Fix the cast**

Change:
```ts
if (result.fullContent !== undefined && sessionId) {
    deps.toolContentStore.store(
        (result.msg as { id: string }).id,
        result.fullContent,
        sessionId,
    );
}
```

To:
```ts
if (
    result.fullContent !== undefined &&
    sessionId &&
    result.msg.type === "tool_result"
) {
    deps.toolContentStore.store(
        result.msg.id,
        result.fullContent,
        sessionId,
    );
}
```

**Step 3: Verify**

```bash
pnpm check && pnpm lint && pnpm test:unit test/unit/relay/event-pipeline.test.ts
```

---

## Plan C: Event Type Safety

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make OpenCode event types a discriminated union and connect relay message type constants to the RelayMessage type.

**Architecture:** Compose existing typed events from opencode-events.ts into a union. Add exhaustiveness checking in the translator. Add compile-time assertions for CACHEABLE_EVENT_TYPES.

**Depends on:** Plan B (both touch event-pipeline.ts).

---

### Task C1: Compose `KnownOpenCodeEvent` union and break circular import

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/relay/opencode-events.ts`

**Step 1: In `types.ts`, rename `OpenCodeEvent` interface → `BaseOpenCodeEvent`**

```ts
/** Structural base for all OpenCode SSE events. */
export interface BaseOpenCodeEvent {
    type: string;
    properties: Record<string, unknown>;
}
```

**Step 2: In `opencode-events.ts`, change import and extends**

```ts
import type { BaseOpenCodeEvent, PartType, ToolStatus } from "../types.js";
```

Change all 18-19 `extends OpenCodeEvent` to `extends BaseOpenCodeEvent`.

**Step 3: In `opencode-events.ts`, add the union**

```ts
export type KnownOpenCodeEvent =
  | PartDeltaEvent | PartUpdatedEvent | PartRemovedEvent
  | SessionStatusEvent | SessionErrorEvent
  | PermissionAskedEvent | PermissionRepliedEvent | QuestionAskedEvent
  | MessageCreatedEvent | MessageUpdatedEvent | MessageRemovedEvent
  | PtyCreatedEvent | PtyExitedEvent | PtyDeletedEvent
  | FileEditedEvent | FileWatcherUpdatedEvent
  | InstallationUpdateEvent | TodoUpdatedEvent;

export type KnownOpenCodeEventType = KnownOpenCodeEvent["type"];
```

**Step 4: In `types.ts`, define the final union**

```ts
import type { KnownOpenCodeEvent } from "./relay/opencode-events.js";

export type OpenCodeEvent = KnownOpenCodeEvent | BaseOpenCodeEvent;
```

**Step 5: Verify** — `pnpm check`

---

### Task C2: Compile-time exhaustiveness assertion in translator

**Files:**
- Modify: `src/lib/relay/event-translator.ts`

Add a type-level assertion at file scope (no runtime change):

```ts
import type { KnownOpenCodeEventType } from "./opencode-events.js";

type _HandledByTranslator =
    | "message.part.delta" | "message.part.updated" | "message.part.removed"
    | "message.created" | "message.updated" | "message.removed"
    | "session.status" | "session.error"
    | "permission.asked" | "question.asked"
    | "pty.created" | "pty.exited" | "pty.deleted"
    | "file.edited" | "file.watcher.updated"
    | "installation.update-available" | "todo.updated";

type _HandledByBridge = "permission.replied";

type _MissingTypes = Exclude<KnownOpenCodeEventType, _HandledByTranslator | _HandledByBridge>;
// If this errors, a new KnownOpenCodeEventType was added but not handled.
type _AssertAllHandled = _MissingTypes extends never ? true : { error: "Unhandled event type(s)"; types: _MissingTypes };
const _exhaustiveCheck: _AssertAllHandled = true;
```

**Verify:** `pnpm check`

---

### Task C3: Type-level assertion for `CACHEABLE_EVENT_TYPES` (Finding #10)

**Files:**
- Modify: `src/lib/relay/event-pipeline.ts`

**Step 1: Tighten `CACHEABLE_TYPES` and `NOTIFICATION_EVENT_TYPES`**

Change from `ReadonlySet<string>` to `ReadonlySet<RelayMessage["type"]>`:

```ts
const CACHEABLE_TYPES: ReadonlySet<RelayMessage["type"]> = new Set(CACHEABLE_EVENT_TYPES);

export const NOTIFICATION_EVENT_TYPES: ReadonlySet<RelayMessage["type"]> = new Set([
    "done", "error",
]);
```

**Step 2: Add compile-time assertion**

```ts
type _AssertCacheableSubset =
    (typeof CACHEABLE_EVENT_TYPES)[number] extends RelayMessage["type"]
        ? true
        : { error: "CACHEABLE_EVENT_TYPES has invalid types" };
const _assertCacheableTypes: _AssertCacheableSubset = true;
```

**Step 3: Update `shouldCache` and `isNotificationWorthy` signatures**

```ts
export function shouldCache(type: RelayMessage["type"]): type is CacheableEventType {
    return CACHEABLE_TYPES.has(type);
}

export function isNotificationWorthy(type: RelayMessage["type"]): boolean {
    return NOTIFICATION_EVENT_TYPES.has(type);
}
```

**Step 4: Verify** — `pnpm check && pnpm lint && pnpm test:unit`

---

### Task C4: Runtime exhaustiveness test

**Files:**
- Create: `test/unit/relay/event-type-safety.test.ts`

Write a test that verifies the translator handles or explicitly skips every `KnownOpenCodeEventType`. Unknown events should fall through to the catch-all.

**Verify:** `pnpm test:unit test/unit/relay/event-type-safety.test.ts`

---

## Plan D: Handler Architecture

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make handler dependency requirements and handler registration compile-time checked.

**Architecture:** Type `MESSAGE_HANDLERS` against `PayloadMap` keys. Split `HandlerDeps` into capability interfaces.

**Depends on:** Plan A (finding #6 also touches relay-stack.ts).

---

### Task D1: Type `MESSAGE_HANDLERS` exhaustively (Finding #8)

**Files:**
- Modify: `src/lib/handlers/index.ts` (line 154)

Change:
```ts
export const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
```
To:
```ts
export const MESSAGE_HANDLERS: Record<keyof PayloadMap, MessageHandler> = {
```

Update `dispatchMessage` lookup to widen for runtime unknowns:
```ts
const fn = (MESSAGE_HANDLERS as Record<string, MessageHandler | undefined>)[handler];
```

**Verify:** `pnpm check` — temporarily comment out one entry to confirm the compiler catches it, then restore.

---

### Task D2: Promote always-present deps to required (Finding #5 — part 1)

> **Audit note (D-1):** Also update `test/helpers/mock-factories.ts:createMockHandlerDeps()` to provide default values for the newly-required fields. This mock is used by 100+ tests and will break without updates.

**Files:**
- Modify: `src/lib/handlers/types.ts`
- Modify: `src/lib/handlers/session.ts` (remove unnecessary `?.`)
- Modify: `test/helpers/mock-factories.ts` (update `createMockHandlerDeps()` with default mocks for `statusPoller`, `registry`, `pollerManager`, `forkMeta`)

Make `statusPoller`, `registry`, `pollerManager`, `forkMeta` required (non-optional). These are always provided at the `relay-stack.ts` wiring site.

Clean up optional chaining (`deps.statusPoller?.` → `deps.statusPoller.`) in handler files that use them.

**Verify:** `pnpm check && pnpm lint && pnpm test:unit`

---

### Task D3: Extract `InstanceManagementDeps` capability interface (Finding #5 — part 2)

**Files:**
- Modify: `src/lib/handlers/types.ts`
- Modify: `src/lib/handlers/instance.ts`
- Modify: `src/lib/relay/relay-stack.ts` (handler deps wiring)

Create `InstanceManagementDeps` grouping `getInstances`, `addInstance`, `removeInstance`, `startInstance`, `stopInstance`, `updateInstance`, `persistConfig`. Replace 7 optional fields with `instanceMgmt?: InstanceManagementDeps`.

Update handler guards from per-function checks to single `if (!deps.instanceMgmt) return`.

> **Audit note (D-2):** Also update helper functions `broadcastInstanceList()` and `broadcastProjectList()` in `instance.ts` — they access `deps.getInstances` and `deps.getProjects` directly and must switch to `deps.instanceMgmt?.getInstances` / `deps.projectMgmt?.getProjects`.

---

### Task D4: Extract `ProjectManagementDeps` and `ScanDeps` (Finding #5 — part 3)

> **Audit note (D-3):** `removeProject` on `HandlerDeps` is dead code — no handler uses it (only `deps.config.removeProject` in settings.ts). Exclude it from `ProjectManagementDeps`.

Same pattern for project management (`getProjects`, `setProjectInstance`) and scan (`triggerScan`).

**Verify after D2-D4:** `pnpm check && pnpm lint && pnpm test:unit`

---

## Plan E: Dispatch Deduplication

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Extract a shared dispatch function for cache-eligible events, eliminating the parallel switch statements.

**Architecture:** Create `dispatchChatEvent(event, context)` that both `handleMessage` and `replayEvents` delegate to for chat events.

**Depends on:** Plan A (finding #1 touches ws-dispatch.ts).

---

### Task E1: Define `DispatchContext` and `dispatchChatEvent`

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`

```ts
interface DispatchContext {
  isReplay: boolean;
  isQueued: boolean;
}

function dispatchChatEvent(event: RelayMessage, ctx: DispatchContext): boolean {
  switch (event.type) {
    case "user_message": addUserMessage(event.text, undefined, ctx.isQueued); return true;
    case "delta": handleDelta(event); return true;
    case "thinking_start": handleThinkingStart(event); return true;
    case "thinking_delta": handleThinkingDelta(event); return true;
    case "thinking_stop": handleThinkingStop(event); return true;
    case "tool_start": handleToolStart(event); return true;
    case "tool_executing": handleToolExecuting(event); return true;
    case "tool_result":
      handleToolResult(event);
      // TodoWrite side-effect
      { const toolMsg = getMessages().find(
          (m): m is ToolMessage => m.type === "tool" && m.id === event.id,
        );
        if (toolMsg?.name === "TodoWrite" && !event.is_error && event.content)
          updateTodosFromToolResult(event.content);
      }
      return true;
    case "result": handleResult(event); return true;
    case "done":
      handleDone(event);
      if (!ctx.isReplay) {
        const sess = findSession(sessionState.currentId ?? "");
        if (!sess?.parentID) triggerNotifications(event);
      }
      return true;
    case "status": handleStatus(event); return true;
    case "error":
      if (ctx.isReplay) handleError(event);
      else { handleChatError(event); triggerNotifications(event); }
      return true;
    default: return false;
  }
}
```

Key design: returns `boolean` so `handleMessage` falls through to non-chat events. `getMessages()` works for both replay (batch buffer) and live (`chatState.messages`).

---

### Task E2: Rewrite `handleMessage` to delegate chat events

Replace the 12 chat-event cases in `handleMessage` with:
```ts
const ctx: DispatchContext = { isReplay: false, isQueued: isProcessing() };
if (dispatchChatEvent(msg, ctx)) {
    if (isLlmContentStart(msg.type) && shouldClearQueuedOnContent()) clearQueuedFlags();
    return;
}
```

Non-chat events (sessions, PTY, discovery, etc.) remain in the switch.

---

### Task E3: Rewrite `replayEvents` to delegate chat events

Replace the replay switch with:
```ts
const ctx: DispatchContext = { isReplay: true, isQueued: llmActive };
dispatchChatEvent(event, ctx);
if (isLlmContentStart(event.type) && shouldClearQueuedOnContent()) clearQueuedFlags();
```

---

### Task E4: Dispatch coverage test

Create `test/unit/stores/dispatch-coverage.test.ts` verifying every `CACHEABLE_EVENT_TYPE` has a fixture and is handled by `replayEvents` without error.

**Verify:** `pnpm check && pnpm lint && pnpm test:unit`

---

## Plan F: Duplication Reduction

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate two sources of duplicated logic: ToolMessage construction and notification routing.

**Architecture:** Extract a ToolMessage factory for finding #11. Route all notification paths through `resolveNotifications()` for finding #12.

---

### Task F1: Extract `createToolMessage` factory (Finding #11)

**Files:**
- Create: `src/lib/frontend/utils/tool-message-factory.ts`
- Create: `test/unit/frontend/tool-message-factory.test.ts`
- Modify: `src/lib/frontend/utils/history-logic.ts` (replace inline construction)
- Modify: `src/lib/frontend/stores/tool-registry.ts` (`start()` and `seedFromHistory()`)

The factory accepts `ToolMessageInit` (required: uuid, id, name, status; optional: result, isError, input, metadata, messageId, isTruncated, fullContentLength). Both history-logic and tool-registry call it instead of inline construction.

NOTE: Mutation spreads in `executing()` and `complete()` stay as-is — the factory is for initial construction only.

---

### Task F2: Route SSE notification path through `resolveNotifications()` (Finding #12)

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts` (replace inline notification logic with `resolveNotifications()`)
- Modify: `src/lib/relay/sse-wiring.ts` types (`SSEWiringDeps` — add `getSessionParentMap?`)
- Modify: `src/lib/relay/relay-stack.ts` (wire `getSessionParentMap` into SSE deps)

Replace the inline `isNotificationWorthy` + broadcast pattern with:
```ts
const isSubagent = targetSessionId != null
    && (deps.getSessionParentMap?.().has(targetSessionId) ?? false);
const notification = resolveNotifications(msg, pipeResult.route, isSubagent, targetSessionId);
```

---

### Task F3: Route message poller notification path through `resolveNotifications()`

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` (message poller `events` handler)

Same pattern as F2. Remove `isNotificationWorthy` import from relay-stack.ts.

---

### Task F4: Notification parity contract test

Create `test/unit/relay/notification-parity.test.ts` verifying all three paths produce identical decisions for: root done, root error, subagent done, subagent error, non-notifiable events.

**Verify:** `pnpm check && pnpm lint && pnpm test:unit`

---

## Plan G: relay-stack Decomposition

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Break `relay-stack.ts` into focused wiring modules, each with an explicit interface.

**Architecture:** Extract 5 wiring subsystems into separate modules. `createProjectRelay()` becomes a ~150-line orchestrator.

**Depends on:** Plans A and D (they modify relay-stack.ts).

---

### Task G1: Extract `handler-deps-wiring.ts`

> **Audit note (G-2):** `clientInitDeps` (constructed at lines 319-352) is used by the `client_connected` handler. Either construct it inside `wireHandlerDeps()` from the available inputs, or add the required fields to `HandlerDepsWiringInputs`.

> **Audit note (G-3):** The implementing agent MUST read `createProjectRelay()` and thread ALL closure variables as explicit parameters. Expect 15-20 inputs per extracted module. The interfaces shown here are abbreviated — the full input types must be derived from the actual closure captures.

**What moves:** HandlerDeps construction (~45 lines), ClientMessageQueue setup (~10 lines), `wsHandler.on("message", ...)` listener (~35 lines), RateLimiter instantiation, `client_connected`/`client_disconnected` listeners (~22 lines), `clientInitDeps` construction.

**Interface:**
```ts
export function wireHandlerDeps(inputs: HandlerDepsWiringInputs): {
    handlerDeps: HandlerDeps;
    clientQueue: ClientMessageQueue;
    rateLimiter: RateLimiter;
};
```

---

### Task G2: Extract `monitoring-wiring.ts`

**What moves:** PipelineDeps construction, effectDeps construction, `statusPoller.on("changed", ...)` handler (~120 lines).

**Interface:**
```ts
export function wireMonitoring(inputs: MonitoringWiringInputs): {
    pipelineDeps: PipelineDeps;
    getMonitoringState: () => MonitoringState;
    setMonitoringState: (state: MonitoringState) => void;
};
```

---

### Task G3: Extract `poller-wiring.ts`

**What moves:** `pollerManager.on("events", ...)` handler + SSE→poller bridge (~85 lines). Receives `pipelineDeps` from G2.

NOTE: After Plan F3, this code uses `resolveNotifications()` instead of inline `isNotificationWorthy`. The extracted module must reflect the post-F3 code shape.

---

### Task G4: Extract `session-lifecycle-wiring.ts`

> **Audit note (G-1):** This module ALSO reads/writes `monitoringState` (deleting sessions on delete event). The `SessionLifecycleWiringInputs` must include `getMonitoringState` and `setMonitoringState` from G2's output.

**What moves:** `sessionMgr.on("broadcast", ...)` and `sessionMgr.on("session_lifecycle", ...)` handlers (~50 lines).

---

### Task G5: Extract `timer-wiring.ts`

**What moves:** Permission timeout interval + rate limiter cleanup interval (~35 lines). Returns timer handles for `stop()` cleanup.

---

### Task G6: Final orchestrator update

Verify `createProjectRelay()` is under 200 lines. All delegation calls use explicit interfaces — no closure captures. Verify `stop()` clears all interval handles returned by extracted modules.

**Verify:**
```bash
pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration
```

---

## Verification Summary

After each plan, run:
```bash
pnpm check && pnpm lint && pnpm test:unit
```

After Plan G (final), additionally run:
```bash
pnpm test:integration
```
