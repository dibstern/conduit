# Per-Session Chat State Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace the module-level `chatState` singleton with a `SvelteMap<sessionId, SessionChatState>`, route every per-session server event by `sessionId`, and derive all UI reads from the current session's slot. Eliminate the stale-activity-indicator bug (bounce bar + sidebar dot showing "active" on a completed, inactive session after navigation).

**Architecture:** Hard-cut refactor. Server broadens fanout so every project client receives every per-session event for the project (Phase 0b). Server tags each per-session event with `sessionId` (Phase 0). Frontend routes each event into its own slot in a keyed map (Phase 3); components read either `currentChat()` (for the current session) or `getSessionPhase(id)` (for sidebar rows). Bundles fixes for two adjacent latent bugs: `handleStatus("idle")` failing to clear a stuck `streaming` phase (F2), and `patchMissingDone` missing the Claude SDK timeout signal in its guard (F3).

**Tech Stack:** TypeScript, Svelte 5 (`$state`, `$derived`, `SvelteMap`, `SvelteSet`), Vitest, Playwright, pnpm.

**Design doc:** [`docs/plans/2026-04-19-session-chat-state-per-session-design.md`](./2026-04-19-session-chat-state-per-session-design.md)

**Audit synthesis:** [`docs/plans/2026-04-19-session-chat-state-per-session-audit.md`](./2026-04-19-session-chat-state-per-session-audit.md) — resolved via amendments reflected throughout this document.

**Design decisions resolved before execution (Ask-User answers):**

| # | Decision | Resolution |
|---|---|---|
| Q1 | System errors with no session context | **New `system_error` variant** (no `sessionId`); `error` variant requires `sessionId`. |
| Q2 | `EMPTY_STATE` sentinel | Plain frozen POJO (no `$state` proxy). |
| Q3 | Server fanout model | Project-scoped firehose (see Phase 0b). |
| Q4 | Live-event-during-replay batching | Preserve per-session `liveEventBuffer` on `SessionChatState`. |
| Q5 | Re-visit replay semantics | Clear slot messages first, then replay. |
| Q6 | `session.processing` vs local phase | Server flag wins (OR disjunction). |
| Q7 | Component template idiom | `const chat = $derived(currentChat())` at top of component. |
| Q8 | `_pendingHistoryQueuedFallback` / `_scrollRequestPending` | Per-state boolean fields on `SessionChatState`. |
| Q9 | Phase 9 bandwidth regression test | **Add** — enforce event-rate threshold in contract tests. |
| Q10 | Mock-mode manual QA | **Add** — script that replays canned transcripts for contributors without LLM billing. |

**Reference existing code:**

- Frontend state: `src/lib/frontend/stores/chat.svelte.ts` (1192 lines)
- Dispatcher: `src/lib/frontend/stores/ws-dispatch.ts` (940 lines)
- Relay message types: `src/lib/shared-types.ts:269-474`
- Errors helper: `src/lib/errors.ts` (`RelayError.toMessage()`)
- Sidebar item: `src/lib/frontend/components/session/SessionItem.svelte:74-78`
- Bounce bar: `src/lib/frontend/components/input/InputArea.svelte:468-479`
- Session switch (server): `src/lib/session/session-switch.ts`
- Overrides: `src/lib/session/session-overrides.ts`
- WS subscription (server): `src/lib/server/ws-handler.ts` (`getViewers`)
- Event pipeline filter: `src/lib/relay/event-pipeline.ts:111-123`

---

## Verification Commands

Use these after each task completes (or the narrowest applicable subset per @AGENTS.md `Verification` section):

```bash
pnpm check
pnpm lint
pnpm test:unit
# Full suite (only when touching cross-layer wiring):
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

For a single file: `pnpm vitest run <path>` (e.g. `pnpm vitest run test/unit/stores/chat-phase.test.ts`).

---

## Phase 0 — Server: Tag every per-session event with `sessionId`

**Why first:** Frontend routing in Phase 3 depends on every `PerSessionEvent` carrying a `sessionId`. Landing this phase first keeps later commits green; without it, routing falls through to a "missing sessionId" dev assertion.

**Emitter audit** (from Phase 0 audit — grep `type: "...",` across `src/lib/`):

| File | Events emitted (that need `sessionId`) |
|---|---|
| `src/lib/relay/event-pipeline.ts` | `delta`, `thinking_*`, `tool_*`, `result`, `done`, `status`, `error` |
| `src/lib/relay/event-translator.ts` | `delta`, `thinking_*`, `tool_*`, `user_message`, `result`, `done`, 12+ sub-translators |
| `src/lib/relay/sse-wiring.ts` | caller for translator outputs — re-stamp here |
| `src/lib/relay/message-poller.ts` | synthesized `delta`, `done` |
| `src/lib/relay/monitoring-wiring.ts` | `status`, `done` |
| `src/lib/relay/effect-executor.ts` | `status`, `done` |
| `src/lib/errors.ts` (`RelayError.toMessage`) | `error` — requires refactor (see Task 0.4) |
| `src/lib/handlers/prompt.ts` | `error`, `status` |
| `src/lib/handlers/permissions.ts` | `ask_user`, `ask_user_resolved`, `ask_user_error` |
| `src/lib/handlers/tool-content.ts` | `tool_content`, `error` |
| `src/lib/session/session-switch.ts` | `status`, synthetic `done` (patchMissingDone) |
| `src/lib/server/client-init.ts` | `error` |
| `src/lib/server/handler-deps-wiring.ts` | `error` |
| `src/lib/server/ws-handler.ts` | `sendToSession` helper — central enforcement point (Task 0.3) |

**Audit list (events that must carry `sessionId`):**

| Event type | Current state | Action |
|---|---|---|
| `delta`, `thinking_*`, `tool_*`, `tool_content`, `done`, `status`, `user_message`, `part_removed`, `message_removed`, `ask_user`, `ask_user_error` | missing | add `sessionId: string` |
| `ask_user_resolved` | optional | make required |
| `error` | missing | add `sessionId: string` (session-scoped) — see Task 0.2 + 0.4 |
| `result`, `permission_request`, `history_page` | present ✓ | no change |
| `session_switched` | `id` field ✓ | no change (already keyed) |

**New event variant:** `system_error` (replaces `error` for session-less system failures — see Task 0.2).

### Task 0.1: Define `PerSessionEvent` / `GlobalEvent` type split

**Files:**
- Modify: `src/lib/shared-types.ts:269-474`

**Step 1: Write the failing test**

Create: `test/unit/shared-types/per-session-event.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { PerSessionEvent, RelayMessage } from "../../../src/lib/shared-types.js";

describe("PerSessionEvent discrimination", () => {
  it("accepts delta with sessionId", () => {
    const tagged: PerSessionEvent = {
      type: "delta",
      text: "hi",
      sessionId: "s1",
    };
    expect(tagged.sessionId).toBe("s1");
  });

  it("excludes session_list from PerSessionEvent", () => {
    const list: RelayMessage = { type: "session_list", sessions: [], roots: true };
    // @ts-expect-error — session_list is a GlobalEvent
    const mis: PerSessionEvent = list;
    void mis;
  });
});
```

Run: `pnpm vitest run test/unit/shared-types/per-session-event.test.ts`
Expected: FAIL — types not exported.

**Step 2: Add the types**

In `src/lib/shared-types.ts`, after the `RelayMessage` union, add:

```ts
/** Events that mutate per-session frontend state. Every such event carries
 *  a `sessionId: string` field and is routed by the frontend dispatcher
 *  into `sessionChatStates.get(sessionId)`. */
export type PerSessionEvent = Extract<RelayMessage, { sessionId: string }>;

/** Events that do NOT mutate per-session state (project-global, PTY,
 *  model/agent metadata, UI banners, system-level errors, etc.). */
export type GlobalEvent = Exclude<RelayMessage, { sessionId: string }>;
```

**Step 3:** Run test → PASS.

**Step 4: Commit**

```bash
git add src/lib/shared-types.ts test/unit/shared-types/per-session-event.test.ts
git commit -m "types: introduce PerSessionEvent / GlobalEvent discrimination"
```

### Task 0.2: Add `sessionId` to per-session event variants; introduce `system_error`

**Files:**
- Modify: `src/lib/shared-types.ts:269-474`

**Step 1: Extend the test**

In `test/unit/shared-types/per-session-event.test.ts`:

```ts
it("every per-session event requires sessionId at the type level", () => {
  const events: PerSessionEvent[] = [
    { type: "delta", text: "x", sessionId: "s" },
    { type: "thinking_start", sessionId: "s" },
    { type: "thinking_delta", text: "x", sessionId: "s" },
    { type: "thinking_stop", sessionId: "s" },
    { type: "tool_start", id: "t", name: "Read", sessionId: "s" },
    { type: "tool_executing", id: "t", name: "Read", input: undefined, sessionId: "s" },
    { type: "tool_result", id: "t", content: "", is_error: false, sessionId: "s" },
    { type: "tool_content", toolId: "t", content: "", sessionId: "s" },
    { type: "done", code: 0, sessionId: "s" },
    { type: "status", status: "idle", sessionId: "s" },
    { type: "error", code: "X", message: "m", sessionId: "s" },
    { type: "user_message", text: "x", sessionId: "s" },
    { type: "part_removed", partId: "p", messageId: "m", sessionId: "s" },
    { type: "message_removed", messageId: "m", sessionId: "s" },
    { type: "ask_user", toolId: "t", questions: [], sessionId: "s" },
    { type: "ask_user_resolved", toolId: "t", sessionId: "s" },
    { type: "ask_user_error", toolId: "t", message: "m", sessionId: "s" },
  ];
  expect(events.every((e) => e.sessionId === "s")).toBe(true);
});

it("system_error does NOT require sessionId", () => {
  const e: RelayMessage = { type: "system_error", code: "PARSE_ERROR", message: "x" };
  // @ts-expect-error — system_error is a GlobalEvent
  const mis: PerSessionEvent = e;
  void mis;
});
```

Run: FAIL.

**Step 2: Modify `shared-types.ts`**

Add `sessionId: string` (non-optional) to each of the 17 listed variants. `ask_user_resolved` changes `sessionId?: string` → `sessionId: string`.

Example — `delta`:

```ts
| { type: "delta"; sessionId: string; text: string; messageId?: string }
```

Introduce `system_error` variant (adjacent to `error`):

```ts
| {
    /** Session-scoped error — always routed to a session's state. */
    type: "error";
    sessionId: string;
    code: string;
    message: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  }
| {
    /** System-level error with no session context (parse failure, unknown
     *  message type, rate limit, instance error, init failure). Frontend
     *  handles via a global toast/banner, never per-session state. */
    type: "system_error";
    code: string;
    message: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  }
```

**Step 3:** Run the test → PASS. `pnpm check` → expect many errors in emission sites (fixed in Tasks 0.3–0.9).

**Step 4: Commit**

```bash
git add src/lib/shared-types.ts test/unit/shared-types/per-session-event.test.ts
git commit -m "types: require sessionId on per-session events, add system_error"
```

### Task 0.3: Centralize enforcement — `wsHandler.sendToSession(clientId, sessionId, event)`

**Why:** Typescript discrimination narrows on the reader side but bare object literals typed as `RelayMessage` still compile. A central sender that stamps `sessionId` prevents accidental bypass.

**Files:**
- Modify: `src/lib/server/ws-handler.ts`

**Step 1: Test**

Create: `test/unit/server/send-to-session.test.ts`

```ts
it("stamps sessionId onto per-session events", () => {
  const handler = makeWsHandler();
  const sent: unknown[] = [];
  handler._testOnlyCapture(sent.push.bind(sent));
  handler.sendToSession("client-1", "s1", { type: "delta", text: "x" });
  expect(sent[0]).toMatchObject({ type: "delta", text: "x", sessionId: "s1" });
});

it("rejects global events (type error, runtime no-op)", () => {
  const handler = makeWsHandler();
  // @ts-expect-error — session_list is a GlobalEvent; cannot sendToSession
  handler.sendToSession("client-1", "s1", { type: "session_list", sessions: [], roots: true });
});
```

**Step 2: Implement**

```ts
// ws-handler.ts
type PerSessionEventUntagged = Omit<PerSessionEvent, "sessionId">;

sendToSession(clientId: string, sessionId: string, event: PerSessionEventUntagged): void {
  const tagged = { ...event, sessionId } as PerSessionEvent;
  this.sendTo(clientId, tagged);
}
```

**Step 3:** Run test → PASS. Commit.

```bash
git commit -m "server: add wsHandler.sendToSession centralizing sessionId stamping"
```

### Task 0.4: Thread `sessionId` through `RelayError.toMessage(sessionId)`

**Files:**
- Modify: `src/lib/errors.ts`
- Modify: 7+ callers (prompt.ts, client-init.ts, handler-deps-wiring.ts — grep `toMessage(`)

**Step 1: Test**

Create: `test/unit/errors/relay-error-session-id.test.ts`

```ts
it("toMessage tags sessionId on returned error", () => {
  const err = new RelayError("CODE", "msg", 500);
  expect(err.toMessage("s1")).toMatchObject({
    type: "error",
    sessionId: "s1",
    code: "CODE",
    message: "msg",
  });
});

it("toSystemMessage returns a system_error without sessionId", () => {
  const err = new RelayError("PARSE_ERROR", "bad json");
  expect(err.toSystemMessage()).toMatchObject({
    type: "system_error",
    code: "PARSE_ERROR",
  });
  expect((err.toSystemMessage() as Record<string, unknown>).sessionId).toBeUndefined();
});
```

**Step 2: Change signatures**

In `errors.ts`:

```ts
toMessage(sessionId: string): Extract<RelayMessage, { type: "error" }> {
  return { type: "error", sessionId, code: this.code, message: this.message, ... };
}

toSystemMessage(): Extract<RelayMessage, { type: "system_error" }> {
  return { type: "system_error", code: this.code, message: this.message, ... };
}
```

**Step 3: Migrate each caller**

For each of the 7+ callers, decide: does the error have session context? If yes → `toMessage(sessionId)`. If no (parse/init/rate-limit/unknown-type/instance) → `toSystemMessage()`.

Audit caller list (verify via `grep -rn 'toMessage(' src/lib/`):
- `src/lib/handlers/prompt.ts` — per-session (has `activeId`)
- `src/lib/server/client-init.ts` — mixed; early init errors → `toSystemMessage()`; session-scoped → `toMessage(sessionId)`
- `src/lib/server/handler-deps-wiring.ts` — context-dependent
- `src/lib/handlers/tool-content.ts` — tool not found → has toolId; look up sessionId; fallback `toSystemMessage()`
- `src/lib/relay/event-pipeline.ts` — per-session
- `src/lib/relay/monitoring-wiring.ts` — per-session

**Step 4: Run test + `pnpm check`** → PASS.

**Step 5: Commit**

```bash
git commit -m "errors: thread sessionId through RelayError.toMessage; add toSystemMessage"
```

### Task 0.5: `event-translator.ts` — stamp sessionId in sub-translator caller

**Files:**
- Modify: `src/lib/relay/event-translator.ts`
- Modify: `src/lib/relay/sse-wiring.ts` (caller)

**Approach:** Rather than thread sessionId through every sub-translator (invasive), have `sse-wiring.ts` stamp `sessionId` onto each translated message before calling `wsHandler.sendToSession`. This leaves sub-translators stateless.

**Step 1: Test**

```ts
// test/unit/relay/translator-sessionid.test.ts
it("sse-wiring stamps sessionId on all translator outputs", () => {
  const stamped = translateAndStamp(rawSseEvents, "s1");
  for (const msg of stamped) {
    if (isPerSessionType(msg.type)) {
      expect(msg.sessionId).toBe("s1");
    }
  }
});
```

**Step 2: Implement** a `translateAndStamp(rawEvents, sessionId)` helper in sse-wiring.ts. Call `sendToSession` for per-session types; `sendToClient` for global.

**Step 3:** Run test + commit.

```bash
git commit -m "relay: sse-wiring stamps sessionId on all translator outputs"
```

### Task 0.6: Remaining emission sites — mechanical sessionId threading

**Files (one task per file; one commit per file):**

- 0.6a: `src/lib/relay/event-pipeline.ts`
- 0.6b: `src/lib/relay/message-poller.ts`
- 0.6c: `src/lib/relay/monitoring-wiring.ts`
- 0.6d: `src/lib/relay/effect-executor.ts`
- 0.6e: `src/lib/handlers/prompt.ts`
- 0.6f: `src/lib/handlers/permissions.ts`
- 0.6g: `src/lib/handlers/tool-content.ts`
- 0.6h: `src/lib/session/session-switch.ts` (status + synthetic done)
- 0.6i: `src/lib/server/client-init.ts`
- 0.6j: `src/lib/server/handler-deps-wiring.ts`

**Pattern per file:**

1. Grep for `type: "<eventname>"` where `<eventname>` is a per-session type.
2. For each site: if the enclosing scope has `sessionId` → switch to `wsHandler.sendToSession(clientId, sessionId, { type: "...", ... })`. If not → lift sessionId from arguments or use the appropriate system path.
3. Run `pnpm check` after each file — should be locally green.
4. Commit.

Example commit per file:

```bash
git commit -m "relay: tag event-pipeline emissions with sessionId"
```

### Task 0.7: Expanded contract test — all per-session paths tagged

**Files:**
- Create: `test/contract/per-session-event-tagging.test.ts`

**Step 1: Tests covering every emission path**

```ts
describe("contract: every per-session emission path carries sessionId", () => {
  it("normal turn cycle (user → delta → tool → done)", async () => {
    const harness = await makeRelayHarness();
    harness.runTurn("s-1", "hello");
    assertAllPerSessionTagged(harness.drainAllEmitted(), "s-1");
  });

  it("error path (RelayError.toMessage)", async () => {
    const harness = await makeRelayHarness();
    harness.injectError("s-1", "EXEC_FAILED");
    const msgs = harness.drainAllEmitted();
    const err = msgs.find((m) => m.type === "error");
    expect(err?.sessionId).toBe("s-1");
  });

  it("system error path (toSystemMessage) uses system_error", async () => {
    const harness = await makeRelayHarness();
    harness.injectMalformedWsFrame();
    const msgs = harness.drainAllEmitted();
    const sys = msgs.find((m) => m.type === "system_error");
    expect(sys).toBeDefined();
  });

  it("message poller synthesized deltas carry sessionId", async () => {
    const harness = await makeRelayHarness();
    harness.simulatePollerResynthesis("s-1");
    assertAllPerSessionTagged(harness.drainAllEmitted(), "s-1");
  });

  it("sse translator rehydration path", async () => {
    const harness = await makeRelayHarness();
    harness.simulateSseReconnect("s-1");
    assertAllPerSessionTagged(harness.drainAllEmitted(), "s-1");
  });

  it("patchMissingDone synthetic done carries sessionId", () => {
    const patched = patchMissingDone(
      { kind: "cached-events", events: [{ type: "delta", text: "x", sessionId: "s-1" }], hasMore: false },
      { isProcessing: () => false },
      "s-1",
      { hasActiveProcessingTimeout: () => false },
    );
    expect(patched.kind === "cached-events" && patched.events[patched.events.length - 1]?.sessionId).toBe("s-1");
  });
});
```

Where `assertAllPerSessionTagged(msgs, expectedId)` asserts every message whose type is in the PerSessionEvent set has `sessionId === expectedId`.

**Step 2:** Run + commit.

```bash
git commit -m "test: contract coverage of every per-session emission path"
```

---

## Phase 0b — Server: Broaden fanout to project-scoped firehose

**Why:** Client-side routing (Phase 3) is a no-op if the server still filters per-session events to the viewers of that session (`ws-handler.ts:getViewers`, `event-pipeline.ts:111-123`). To route per-session on the client, every project client must receive every per-session event for the project.

**Decision (Q3):** Project-scoped firehose — drop `view_session`-based subscription filtering. `view_session` becomes a pure UI hint (history + draft delivery) with no subscription side-effect.

### Task 0b.1: Identify all viewer-filter sites

Grep `getViewers` and `hasViewer` across `src/lib/server/` and `src/lib/relay/`. Expected sites:
- `src/lib/server/ws-handler.ts`
- `src/lib/relay/event-pipeline.ts:111-123`

List the emission call sites that consult viewer filtering before `sendTo`.

### Task 0b.2: Test the new fanout behavior

**Files:**
- Create: `test/unit/server/project-firehose.test.ts`

```ts
describe("project-scoped firehose delivers all per-session events to all project clients", () => {
  it("client viewing A receives delta for B in same project", async () => {
    const harness = await makeServerHarness();
    const clientA = harness.addClient({ project: "p1", view: "A" });
    const clientB = harness.addClient({ project: "p1", view: "B" });

    harness.emitForSession("p1", "A", { type: "delta", text: "a-1" });
    harness.emitForSession("p1", "B", { type: "delta", text: "b-1" });

    // Both clients see both events (sessionId-tagged).
    expect(clientA.received.filter((e) => e.type === "delta")).toHaveLength(2);
    expect(clientB.received.filter((e) => e.type === "delta")).toHaveLength(2);
  });

  it("client in different project does NOT receive events", async () => {
    const harness = await makeServerHarness();
    const clientA = harness.addClient({ project: "p1", view: "A" });
    const clientOther = harness.addClient({ project: "p2", view: "X" });

    harness.emitForSession("p1", "A", { type: "delta", text: "a-1" });

    expect(clientA.received).toHaveLength(1);
    expect(clientOther.received).toHaveLength(0);
  });
});
```

### Task 0b.3: Implement the fanout change

**Files:**
- Modify: `src/lib/server/ws-handler.ts`
- Modify: `src/lib/relay/event-pipeline.ts:111-123`

Replace viewer-filtered per-session broadcasts with project-client broadcasts. `sendToSession(clientId, sessionId, event)` remains the per-client stamping helper; a new `broadcastToProject(projectSlug, sessionId, event)` iterates all clients of the project relay and calls `sendToSession` for each.

### Task 0b.4: Remove `view_session` subscription side-effects

`view_session` continues to trigger server-side history + draft delivery (`session_switched` reply) but no longer adds/removes any viewer subscription. Confirm the message flow is: UI-hint-only.

### Task 0b.5: Telemetry for bandwidth baseline (Q9 setup)

**Files:**
- Modify: `src/lib/server/ws-handler.ts`

Add a per-client counter: `eventsSentPerSecond`. Emit to logs every N seconds. Baseline measured in Task 9.4.

### Task 0b.6: Commit

```bash
git commit -m "server: project-scoped firehose for per-session events"
```

---

## Phase 1 — Frontend: introduce the per-session state model (dead code)

At the end of this phase: new types and factories exist, tests exercise them, nothing else uses them yet. Build is green.

### Task 1.1: `SessionChatState` type + `createEmptySessionChatState`

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:40-66`

**Step 1: Write the failing test** (`test/unit/stores/session-chat-state-factory.test.ts`)

```ts
describe("createEmptySessionChatState", () => {
  it("returns an idle state with empty everything", () => {
    const s = createEmptySessionChatState();
    expect(s.phase).toBe("idle");
    expect(s.loadLifecycle).toBe("empty");
    expect(s.messages).toEqual([]);
    expect(s.turnEpoch).toBe(0);
    expect(s.currentMessageId).toBeNull();
    expect(s.currentAssistantText).toBe("");
    expect(s.contextPercent).toBe(0);
    expect(s.historyHasMore).toBe(false);
    expect(s.historyMessageCount).toBe(0);
    expect(s.doneMessageIds.size).toBe(0);
    expect(s.seenMessageIds.size).toBe(0);
    expect(s.renderTimer).toBeNull();
    expect(s.thinkingStartTime).toBe(0);
    expect(s.replayGeneration).toBe(0);
    expect(s.deferredGeneration).toBe(0);
    expect(s.liveEventBuffer).toBeNull();
    expect(s.replayBatch).toBeNull();
    expect(s.replayBuffer).toBeUndefined();
    expect(s.eventsHasMore).toBe(false);
    expect(s.pendingHistoryQueuedFallback).toBe(false);
    expect(s.scrollRequestPending).toBe(false);
    expect(s.toolRegistry).toBeDefined();
  });

  it("two factory calls return independent states", () => {
    const a = createEmptySessionChatState();
    const b = createEmptySessionChatState();
    a.phase = "processing";
    expect(b.phase).toBe("idle");
    a.messages.push({ type: "system", uuid: "u", text: "hi", variant: "info" });
    expect(b.messages).toEqual([]);
  });

  it("mutating inner fields triggers reactivity", () => {
    const s = createEmptySessionChatState();
    let observed: ChatPhase = "idle";
    const cleanup = $effect.root(() => {
      $effect(() => { observed = s.phase; });
    });
    s.phase = "processing";
    // Svelte microtask flush:
    flushSync();
    expect(observed).toBe("processing");
    cleanup();
  });
});
```

**Step 2: Add type + factory**

```ts
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { createToolRegistry, type ToolRegistry } from "./tool-registry.js";

export type SessionChatState = {
  messages: ChatMessage[];
  phase: ChatPhase;
  loadLifecycle: LoadLifecycle;
  currentAssistantText: string;
  turnEpoch: number;
  currentMessageId: string | null;
  doneMessageIds: SvelteSet<string>;
  seenMessageIds: SvelteSet<string>;
  contextPercent: number;
  historyHasMore: boolean;
  historyMessageCount: number;
  // Per-state replacements for old module-level flags (Q8 = per-state boolean):
  pendingHistoryQueuedFallback: boolean;
  scrollRequestPending: boolean;
  // Per-state replacements for old module-level caches:
  replayBatch: ChatMessage[] | null;
  replayBuffer: ChatMessage[] | undefined;
  eventsHasMore: boolean;
  liveEventBuffer: PerSessionEvent[] | null;
  // Generation counters (per-session, so rapid switches don't cross):
  replayGeneration: number;
  deferredGeneration: number;
  // Tool registry:
  toolRegistry: ToolRegistry;
  // Non-reactive internals (safe to put in $state — written only from handlers):
  renderTimer: ReturnType<typeof setTimeout> | null;
  thinkingStartTime: number;
};

export function createEmptySessionChatState(): SessionChatState {
  const registryLog = createFrontendLogger("ToolRegistry", {
    onError(...args: unknown[]) {
      if (import.meta.env.DEV)
        throw new Error(["[ToolRegistry]", ...args].map(String).join(" "));
    },
  });
  return $state({
    messages: [],
    phase: "idle",
    loadLifecycle: "empty",
    currentAssistantText: "",
    turnEpoch: 0,
    currentMessageId: null,
    doneMessageIds: new SvelteSet<string>(),
    seenMessageIds: new SvelteSet<string>(),
    contextPercent: 0,
    historyHasMore: false,
    historyMessageCount: 0,
    pendingHistoryQueuedFallback: false,
    scrollRequestPending: false,
    replayBatch: null,
    replayBuffer: undefined,
    eventsHasMore: false,
    liveEventBuffer: null,
    replayGeneration: 0,
    deferredGeneration: 0,
    toolRegistry: createToolRegistry({ log: registryLog }),
    renderTimer: null,
    thinkingStartTime: 0,
  });
}
```

**Step 3: Test PASS. Commit.**

```bash
git commit -m "stores: add SessionChatState type and factory (dead code)"
```

### Task 1.2: `sessionChatStates` map + accessors + `EMPTY_STATE` (plain frozen POJO)

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts`

**Step 1: Test** (`test/unit/stores/session-chat-states-map.test.ts`)

```ts
describe("sessionChatStates map", () => {
  beforeEach(() => {
    sessionChatStates.clear();
    sessionState.currentId = null;
  });

  it("getOrCreateSessionState creates on first access", () => {
    const s = getOrCreateSessionState("s1");
    expect(s.phase).toBe("idle");
    expect(sessionChatStates.has("s1")).toBe(true);
  });

  it("repeat access returns same slot", () => {
    const a = getOrCreateSessionState("s1");
    const b = getOrCreateSessionState("s1");
    expect(a).toBe(b);
  });

  it("getSessionPhase returns 'idle' for unknown session", () => {
    expect(getSessionPhase("unknown")).toBe("idle");
  });

  it("getSessionPhase reflects slot phase", () => {
    const s = getOrCreateSessionState("s1");
    s.phase = "streaming";
    expect(getSessionPhase("s1")).toBe("streaming");
  });

  it("currentChat returns EMPTY_STATE when currentId is null", () => {
    sessionState.currentId = null;
    expect(currentChat()).toBe(EMPTY_STATE);
  });

  it("currentChat returns slot for currentId", () => {
    sessionState.currentId = "s1";
    const slot = getOrCreateSessionState("s1");
    expect(currentChat()).toBe(slot);
  });

  it("EMPTY_STATE is frozen and has no proxy", () => {
    expect(Object.isFrozen(EMPTY_STATE)).toBe(true);
    expect(EMPTY_STATE.phase).toBe("idle");
    expect(EMPTY_STATE.messages).toEqual([]);
    expect(() => EMPTY_STATE.messages.push({} as ChatMessage)).toThrow();
  });
});
```

**Step 2: Add exports — note the frozen POJO pattern for `EMPTY_STATE`**

```ts
import { SvelteMap } from "svelte/reactivity";
import { sessionState } from "./session.svelte.js";

export const sessionChatStates = new SvelteMap<string, SessionChatState>();

/** Plain frozen POJO (NOT a `$state` proxy — Object.freeze on a proxy
 *  throws `state_descriptors_fixed` at module load). EMPTY_STATE is a
 *  constant, never mutated. Readers that hit EMPTY_STATE are in a null-
 *  current-session state; any write path must go through
 *  getOrCreateSessionState() instead. */
export const EMPTY_STATE: SessionChatState = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  phase: "idle",
  loadLifecycle: "empty",
  currentAssistantText: "",
  turnEpoch: 0,
  currentMessageId: null,
  doneMessageIds: new SvelteSet<string>(),
  seenMessageIds: new SvelteSet<string>(),
  contextPercent: 0,
  historyHasMore: false,
  historyMessageCount: 0,
  pendingHistoryQueuedFallback: false,
  scrollRequestPending: false,
  replayBatch: null,
  replayBuffer: undefined,
  eventsHasMore: false,
  liveEventBuffer: null,
  replayGeneration: 0,
  deferredGeneration: 0,
  toolRegistry: createSentinelToolRegistry(),
  renderTimer: null,
  thinkingStartTime: 0,
}) as SessionChatState;

export function getOrCreateSessionState(id: string): SessionChatState {
  let s = sessionChatStates.get(id);
  if (!s) {
    s = createEmptySessionChatState();
    sessionChatStates.set(id, s);
    evictOldestIdleIfOverCap();
  }
  return s;
}

export function getSessionPhase(id: string): ChatPhase {
  return sessionChatStates.get(id)?.phase ?? "idle";
}

const _currentChat = $derived(
  sessionChatStates.get(sessionState.currentId ?? "") ?? EMPTY_STATE,
);
export function currentChat(): SessionChatState {
  return _currentChat;
}
```

**Step 3:** Run → PASS. Commit.

```bash
git commit -m "stores: sessionChatStates map + plain-POJO EMPTY_STATE sentinel"
```

### Task 1.3: LRU eviction helper

Same as original plan. Unchanged. Covered in Task 1.2's `getOrCreateSessionState` call to `evictOldestIdleIfOverCap()`. See original plan for eviction test scaffold.

```bash
git commit -m "stores: LRU eviction of idle sessions"
```

---

## Phase 2 — Flip handlers to take `state: SessionChatState` first

**Expanded handler list** (from Phase 2 audit):

- `handleDelta`, `handleThinkingStart`/`Delta`/`Stop`, `handleToolStart`/`Executing`/`Result`, `handleResult`, `handleDone`, `handleStatus`, `handleError`, `handlePartRemoved`, `handleMessageRemoved`, `addUserMessage`
- **Plus (missing from v1 plan):** `advanceTurnIfNewMessage`, `handleToolContentResponse`, `ensureSentDuringEpochOnLastUnrespondedUser`, `registerClearMessagesHook`
- **Internal helpers also flipped:** `flushAndFinalizeAssistant`, `flushAssistantRender`, `updateContextFromTokens`, `applyToolCreate`, `applyToolUpdate`, `setMessages`, `getMessages`, `beginReplayBatch`, `commitReplayFinal`, `consumeReplayBuffer`, `getReplayBuffer`, `isEventsHasMore`, `discardReplayBatch`, `cancelDeferredMarkdown`, `renderDeferredMarkdown`, `flushPendingRender`, `prependMessages`, `seedRegistryFromMessages`, `addSystemMessage`, `requestScrollOnNextContent`, `consumeScrollRequest`
- **Phase helpers flipped:** `phaseToIdle`, `phaseToProcessing`, `phaseToStreaming`, `phaseStartReplay`, `phaseEndReplay`, `phaseReset`

### Task 2.1: Handler-signature invariant test

**Files:**
- Create: `test/unit/stores/handler-signatures.test.ts`

Same as original plan, but expanded list:

```ts
const STATE_FIRST_HANDLER_NAMES = [
  "handleDelta", "handleThinkingStart", "handleThinkingDelta", "handleThinkingStop",
  "handleToolStart", "handleToolExecuting", "handleToolResult", "handleToolContentResponse",
  "handleResult", "handleDone", "handleStatus", "handleError",
  "handlePartRemoved", "handleMessageRemoved",
  "addUserMessage", "advanceTurnIfNewMessage",
  // Helpers also taking state first:
  "flushAndFinalizeAssistant", "flushAssistantRender",
  "setMessages", "getMessages",
  "beginReplayBatch", "commitReplayFinal",
  "phaseToIdle", "phaseToProcessing", "phaseToStreaming",
  "phaseStartReplay", "phaseEndReplay",
  "requestScrollOnNextContent", "consumeScrollRequest",
  "cancelDeferredMarkdown", "renderDeferredMarkdown",
] as const;

it(`${name} has arity >= 1 and accepts state as first param`, () => { ... });
```

Also: a dynamic test per handler that calls it with two distinct states and asserts mutations land on the right state:

```ts
describe("each handler mutates only the passed state", () => {
  it("handleDelta writes to passed state only", () => {
    const a = createEmptySessionChatState();
    const b = createEmptySessionChatState();
    handleDelta(a, { type: "delta", text: "hi", sessionId: "a" });
    expect(a.messages.length).toBe(1);
    expect(b.messages.length).toBe(0);
  });
  // ... repeat for each handler
});
```

### Task 2.2 – 2.15: Flip each handler (one commit per handler)

For each handler, follow the pattern from v1 plan Task 2.2 (write failing test → update signature → migrate tests → commit). New tasks added:

- **Task 2.13:** Flip `advanceTurnIfNewMessage(state, messageId)`. Today it mutates module-level `seenMessageIds`, `doneMessageIds`, `turnEpoch`, `currentMessageId`. All move to `state.*`.
- **Task 2.14:** Flip `handleToolContentResponse(state, msg)` in `ws-dispatch.ts:825`. Writes directly to `chatState.messages` today.
- **Task 2.15:** Flip `ensureSentDuringEpochOnLastUnrespondedUser(state)` and delete module-level `_pendingHistoryQueuedFallback` — the flag becomes `state.pendingHistoryQueuedFallback` boolean field (Q8 resolution).

### Task 2.7 detail — `handleStatus` (bundle F2 fix)

Unchanged from v1 plan, except the signature takes `state`:

```ts
export function handleStatus(
  state: SessionChatState,
  msg: Extract<RelayMessage, { type: "status" }>,
): void {
  if (msg.status === "processing") {
    if (state.phase !== "streaming") phaseToProcessing(state);
    if (state.pendingHistoryQueuedFallback) {
      state.pendingHistoryQueuedFallback = false;
      ensureSentDuringEpochOnLastUnrespondedUser(state);
    }
  } else if (msg.status === "idle") {
    // F2: clear ANY non-idle phase.
    if (state.phase !== "idle") phaseToIdle(state);
  }
}
```

### Task 2.2 correction — `setMessages`/`getMessages` preserved

Do NOT replace `setMessages(state, msgs)` with direct `state.messages = [...]`. `setMessages` still routes through `state.replayBatch` when non-null (during replay) — that invariant must be preserved:

```ts
export function getMessages(state: SessionChatState): ChatMessage[] {
  return state.replayBatch ?? state.messages;
}

export function setMessages(state: SessionChatState, msgs: ChatMessage[]): void {
  if (state.replayBatch !== null) state.replayBatch = msgs;
  else state.messages = msgs;
}
```

All handler snippets in Phase 2 use `getMessages(state)` and `setMessages(state, ...)` rather than `state.messages` directly.

### Task 2.16: Temporary `dispatchToCurrent` adapter

Same as v1 plan. Adapter wired into `ws-dispatch.ts` so behavior is unchanged during Phase 2 transition.

```ts
function dispatchToCurrent<T extends PerSessionEvent>(
  fn: (state: SessionChatState, msg: T) => void,
  msg: T,
): void {
  const id = sessionState.currentId;
  if (!id) return;
  const state = getOrCreateSessionState(id);
  fn(state, msg);
}
```

Cast narrowing at call sites uses the type of the specific handler's message param (e.g., `Extract<RelayMessage, { type: "delta" }>`).

---

## Phase 3 — Flip dispatcher to route by `event.sessionId`

### Task 3.1: Route every per-session variant by sessionId

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`

**Step 1: Test** (`test/unit/stores/session-chat-state-routing.test.ts`)

Enumerate all 17 per-session event variants in the test; for each, dispatch with `sessionId: "B"` while `currentId = "A"` and assert B's slot mutates, A's slot untouched.

```ts
const allVariants: PerSessionEvent[] = [
  { type: "delta", text: "x", sessionId: "B" },
  { type: "thinking_start", sessionId: "B" },
  { type: "thinking_delta", text: "x", sessionId: "B" },
  { type: "thinking_stop", sessionId: "B" },
  { type: "tool_start", id: "t", name: "Read", sessionId: "B" },
  { type: "tool_executing", id: "t", name: "Read", input: undefined, sessionId: "B" },
  { type: "tool_result", id: "t", content: "", is_error: false, sessionId: "B" },
  { type: "tool_content", toolId: "t", content: "", sessionId: "B" },
  { type: "done", code: 0, sessionId: "B" },
  { type: "status", status: "idle", sessionId: "B" },
  { type: "error", code: "X", message: "m", sessionId: "B" },
  { type: "user_message", text: "u", sessionId: "B" },
  { type: "part_removed", partId: "p", messageId: "m", sessionId: "B" },
  { type: "message_removed", messageId: "m", sessionId: "B" },
  { type: "ask_user", toolId: "t", questions: [], sessionId: "B" },
  { type: "ask_user_resolved", toolId: "t", sessionId: "B" },
  { type: "ask_user_error", toolId: "t", message: "m", sessionId: "B" },
];

for (const v of allVariants) {
  it(`${v.type} routes to B when currentId=A`, async () => {
    sessionChatStates.clear();
    sessionState.currentId = "A";
    const A = getOrCreateSessionState("A");
    const aSnapshot = JSON.stringify($state.snapshot(A));
    handleMessage(v);
    await vi.runAllTimersAsync();
    expect(JSON.stringify($state.snapshot(A))).toBe(aSnapshot);
    expect(sessionChatStates.has("B")).toBe(true);
  });
}
```

**Step 2: Implement `routePerSession`**

```ts
function routePerSession<T extends PerSessionEvent>(
  fn: (state: SessionChatState, msg: T) => void,
  msg: T,
): void {
  if (!msg.sessionId) {
    if (import.meta.env.DEV) {
      throw new Error(
        `[ws-dispatch] per-session event ${msg.type} missing sessionId`,
      );
    }
    log.warn("dropping per-session event without sessionId:", msg.type);
    return;
  }
  const state = getOrCreateSessionState(msg.sessionId);
  fn(state, msg);
}
```

**Critical: `advanceTurnIfNewMessage` inside `routePerSession`.** Today it runs at dispatch level and mutates "the current session's" turn. Post-routing, it must mutate the **event's session**. Place the call immediately after `getOrCreateSessionState` and before `fn`:

```ts
function routePerSession<T extends PerSessionEvent>(
  fn: (state: SessionChatState, msg: T) => void,
  msg: T,
): void {
  // ... sessionId guard ...
  const state = getOrCreateSessionState(msg.sessionId);
  if ("messageId" in msg && typeof msg.messageId === "string") {
    advanceTurnIfNewMessage(state, msg.messageId);
  }
  fn(state, msg);
}
```

**Step 3:** Swap every `dispatchToCurrent(handler, msg)` in the big `switch` statement for `routePerSession(handler, msg)`. Delete `dispatchToCurrent` adapter.

**Step 4:** Commit.

```bash
git commit -m "dispatch: route per-session events by event.sessionId"
```

### Task 3.2: Per-session replay + deferred-markdown generation counters

Move both from module scope into `SessionChatState` (`replayGeneration`, `deferredGeneration`). `replayEvents(events, sessionId, hasMore)` uses `state.replayGeneration`. `renderDeferredMarkdown(state)` uses `state.deferredGeneration`. Aborts never cross sessions.

`renderDeferredMarkdown` must also be rewritten to read/write `state.messages` (not `chatState.messages`).

### Task 3.3: Preserve per-session live-event buffering

**Decision (Q4):** Preserve buffering; move `liveEventBuffer` onto `SessionChatState`. Maintain the existing invariant: while `state.replayBatch !== null`, live events for that session are appended to `state.liveEventBuffer`. When `commitReplayFinal(state, ...)` runs, it commits the batch THEN drains the buffer, preserving cache-tail-then-live ordering.

**Dispatcher change in `routePerSession`:**

```ts
const state = getOrCreateSessionState(msg.sessionId);
// If this session is mid-replay, buffer the live event instead of
// dispatching immediately — preserves cache-tail-then-live ordering.
if (state.replayBatch !== null && state.loadLifecycle === "loading") {
  if (!state.liveEventBuffer) state.liveEventBuffer = [];
  state.liveEventBuffer.push(msg);
  return;
}
fn(state, msg);
```

Test `concurrent-session-dispatch.test.ts` expanded to cover:

- Live delta arrives for A during A's replay: buffered, then drained after commit.
- Live delta arrives for B during A's replay: dispatched immediately to B (B not mid-replay).
- Rapid double-switch aborts A's replay; live events queued for A during the abort don't leak into the restart.

### Task 3.4: Remove module-level `liveEventBuffer`, `startBufferingLiveEvents`, `drainLiveEventBuffer`

Replaced by per-state fields + inline buffer-push in `routePerSession`.

```bash
git commit -m "dispatch: per-session live-event buffering preserved on SessionChatState"
```

---

## Phase 4 — Server-side **F3** fix: `patchMissingDone` guard

### Task 4.1: Test + fix — 6 cases

**Files:**
- Create: `test/unit/session/patch-missing-done-claude-sdk.test.ts`

Six test cases:

```ts
describe("patchMissingDone (F3)", () => {
  const events = [{ type: "delta", text: "partial", sessionId: "s1" }];
  const source = { kind: "cached-events" as const, events, hasMore: false };

  it("skips patch when Claude SDK timeout is active", () => {
    const result = patchMissingDone(source,
      { isProcessing: () => false },
      "s1",
      { hasActiveProcessingTimeout: () => true });
    expect(result).toBe(source);
  });

  it("skips patch when OpenCode poller reports processing", () => {
    const result = patchMissingDone(source,
      { isProcessing: () => true },
      "s1",
      { hasActiveProcessingTimeout: () => false });
    expect(result).toBe(source);
  });

  it("skips patch when BOTH signals report processing", () => {
    const result = patchMissingDone(source,
      { isProcessing: () => true },
      "s1",
      { hasActiveProcessingTimeout: () => true });
    expect(result).toBe(source);
  });

  it("patches when both signals say idle AND last turn active", () => {
    const result = patchMissingDone(source,
      { isProcessing: () => false },
      "s1",
      { hasActiveProcessingTimeout: () => false });
    expect(result).not.toBe(source);
    if (result.kind === "cached-events") {
      const last = result.events[result.events.length - 1];
      expect(last?.type).toBe("done");
      expect(last?.sessionId).toBe("s1");
    }
  });

  it("does not patch when last turn is NOT active (has done)", () => {
    const src = { kind: "cached-events" as const,
      events: [...events, { type: "done", code: 0, sessionId: "s1" }], hasMore: false };
    const result = patchMissingDone(src,
      { isProcessing: () => false }, "s1",
      { hasActiveProcessingTimeout: () => false });
    expect(result).toBe(src);
  });

  it("returns source unchanged for rest-history or empty kinds", () => {
    const rest = { kind: "rest-history" as const, history: { messages: [], hasMore: false } };
    expect(patchMissingDone(rest, { isProcessing: () => false }, "s1",
      { hasActiveProcessingTimeout: () => false })).toBe(rest);
    const empty = { kind: "empty" as const };
    expect(patchMissingDone(empty, { isProcessing: () => false }, "s1",
      { hasActiveProcessingTimeout: () => false })).toBe(empty);
  });
});
```

**Fix:**

```ts
export function patchMissingDone(
  source: SessionHistorySource,
  statusPoller: SessionSwitchDeps["statusPoller"],
  sessionId: string,
  overrides: Pick<NonNullable<SessionSwitchDeps["overrides"]>, "hasActiveProcessingTimeout">,
): SessionHistorySource {
  if (source.kind !== "cached-events") return source;
  if (statusPoller?.isProcessing(sessionId)) return source;
  if (overrides.hasActiveProcessingTimeout(sessionId)) return source;
  if (!isLastTurnActive(source.events)) return source;
  return {
    kind: "cached-events",
    events: [...source.events, { type: "done", code: 0, sessionId }],
    hasMore: source.hasMore,
  };
}
```

Note `overrides` is **required** (not optional). Caller in `switchClientToSession` always has it. Typing uses `NonNullable<...>` to resolve `SessionSwitchDeps.overrides?` optionality.

### Task 4.2: Optional cleanup — extract `sessionIsProcessing(sessionId, deps)` helper

The OR-chain appears in two places (`patchMissingDone` guard + outgoing status computation at `session-switch.ts:334-336`). Extract a shared helper and use it in both. Low priority — include if diff stays small.

```bash
git commit -m "session: patchMissingDone checks Claude SDK timeout (fixes F3)"
```

---

## Phase 5 — Delete the frontend globals

### Task 5.1: Remove `chatState` module export

Same as v1 plan — migrate every `chatState.X` read to `currentChat().X` (or `chat.X` if the component has `const chat = $derived(currentChat())` per Q7).

**Affected files** (exhaustive grep):
- `src/lib/frontend/stores/chat.svelte.ts` (internal)
- `src/lib/frontend/stores/ws-dispatch.ts` (already migrated in Phase 3)
- `src/lib/frontend/components/chat/MessageList.svelte`
- `src/lib/frontend/components/chat/UserMessage.svelte`
- `src/lib/frontend/components/chat/HistoryLoader.svelte`
- `src/lib/frontend/components/chat/MessageList.stories.ts` (direct writes — rewrite to use `getOrCreateSessionState`)
- `src/lib/frontend/components/layout/ChatLayout.svelte` (dead import — remove)
- Test files: `test/unit/stores/turn-epoch-queued-pipeline.test.ts` and any other importing `chatState`

Deletion of the `chatState` `$state({...})` block at `chat.svelte.ts:49-66` — all fields now live on `SessionChatState`.

```bash
git commit -m "stores: remove module-level chatState (use currentChat() per session)"
```

### Task 5.2: Remove `stashSessionMessages` / `restoreCachedMessages` / cache; specify re-visit replay semantics

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:1025-1090`
- Modify: `src/lib/frontend/stores/session.svelte.ts:336-360`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (`session_switched` handler)
- Update tests: `test/unit/stores/turn-epoch-queued-pipeline.test.ts` (imports stash/restore — refactor)

**Re-visit replay semantics (Q5):** Clear slot messages first, then replay. On `session_switched` for an existing slot:

```ts
// ws-dispatch.ts session_switched case:
const state = getOrCreateSessionState(msg.id);
// Clear slot before replay — server is source of truth.
state.messages = [];
state.turnEpoch = 0;
state.currentMessageId = null;
state.currentAssistantText = "";
state.phase = "idle";
state.loadLifecycle = "empty";
state.doneMessageIds.clear();
state.seenMessageIds.clear();
state.contextPercent = 0;
state.historyHasMore = false;
state.historyMessageCount = 0;
// Do NOT clear toolRegistry — let replay repopulate via handlers.
state.toolRegistry.clear();

if (msg.events) {
  replayEvents(state, msg.events, msg.eventsHasMore ?? false);
} else if (msg.history) {
  state.pendingHistoryQueuedFallback = true;
  // ... REST history path ...
}
```

**Delete `stashSessionMessages`, `restoreCachedMessages`, `sessionMessageCache`, `CachedSession` type.** The `sessionChatStates` map IS the cache; the per-session slot persists across switches naturally.

`switchToSession` simplifies:

```ts
export function switchToSession(
  sessionId: string,
  sendWs: (data: Record<string, unknown>) => void,
): void {
  _switchingFromId = sessionState.currentId;
  sessionState.currentId = sessionId;
  getOrCreateSessionState(sessionId); // ensure slot exists for derivation
  const slug = getCurrentSlug();
  if (slug) navigate(`/p/${slug}/s/${sessionId}`);
  sendWs({ type: "view_session", sessionId });
}
```

```bash
git commit -m "stores: remove stash/restore cache; clear-then-replay on session_switched"
```

### Task 5.3: Move `uiState.contextPercent` to per-session

**Files:**
- Modify: `src/lib/frontend/stores/ui.svelte.ts` (remove `contextPercent`, `updateContextPercent`)
- Modify: `src/lib/frontend/stores/chat.svelte.ts` (`updateContextFromTokens(state, usage)`)
- Modify readers (grep `contextPercent|updateContextPercent` across `src/lib/frontend/` AND test files):
  - `test/unit/stores/ui-store.test.ts`
  - `test/unit/stores/dispatch-notification-reducer.test.ts`
  - `src/lib/frontend/components/input/InputArea.stories.ts`
  - `src/lib/frontend/components/chat/MessageList.svelte` (context bar)
  - `src/lib/frontend/components/layout/ChatLayout.svelte`
  - Possibly `src/lib/frontend/components/chat/InfoPanels.svelte`
- `resetProjectUI` removes the `uiState.contextPercent = 0` line (slot reset handles it).

Test: dispatching a `result` for session B updates B's `contextPercent` and leaves A's alone.

```bash
git commit -m "ui: make contextPercent per-session"
```

### Task 5.4: Move `_scrollRequestPending` into `SessionChatState` (correction from v1 plan)

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts`

**The v1 plan's "keep scroll-request global" decision was wrong.** After Phase 3's per-session routing, an error for background session B would set a global flag that the visible session A then consumes — wrong session gets the scroll.

Replace the module-level `_scrollRequestPending` with `state.scrollRequestPending: boolean`. `requestScrollOnNextContent(state)` and `consumeScrollRequest(state)` take state. Component call site (`MessageList.svelte` content-change `$effect`) reads `currentChat().scrollRequestPending` (the visible session — correct by construction).

Test:

```ts
it("scroll request for B does not fire on A's content change", () => {
  sessionState.currentId = "A";
  const A = getOrCreateSessionState("A");
  const B = getOrCreateSessionState("B");
  requestScrollOnNextContent(B);
  expect(consumeScrollRequest(A)).toBe(false);
  expect(consumeScrollRequest(B)).toBe(true);
});
```

### Task 5.5: Delete `historyState` module singleton

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:148-157` (delete the `export const historyState = $state({ ... })`)
- Migrate readers: `MessageList.svelte`, `HistoryLoader.svelte` → `chat.historyHasMore`, `chat.historyMessageCount` via the component's `const chat = $derived(currentChat())` snapshot.

Already covered by Task 1.1 (fields are on `SessionChatState`); this task deletes the dead singleton.

```bash
git commit -m "stores: delete historyState module singleton"
```

### Task 5.6: Delete `_pendingHistoryQueuedFallback` module declaration

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts:753`

Remove the module-level `let _pendingHistoryQueuedFallback = false;` declaration. Its per-session replacement is already on `state.pendingHistoryQueuedFallback` (Task 1.1).

Also migrate `markPendingHistoryQueuedFallback(state)` to take state.

```bash
git commit -m "stores: delete _pendingHistoryQueuedFallback module var"
```

### Task 5.7: Repurpose `evictCachedMessages` as `evictSessionState`

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (session-delete handler)

Confirmed via grep: `evictCachedMessages` currently has zero callers in `src/lib/`. Replace with:

```ts
export function evictSessionState(id: string): void {
  sessionChatStates.delete(id);
}
```

Call it from the `delete_session` response handler in `ws-dispatch.ts` to drop the slot for a deleted session.

```bash
git commit -m "stores: evictSessionState on session deletion"
```

### Task 5.8: Delete remaining module-level timers

`let renderTimer` → `state.renderTimer`. `let thinkingStartTime` → `state.thinkingStartTime`. Already on `SessionChatState` (Task 1.1); this task removes the module declarations.

```bash
git commit -m "stores: move remaining per-session timers onto SessionChatState"
```

---

## Phase 6 — Flip component readers

### Task 6.1: `MessageList.svelte`

**Step 1: Rewrite imports + add `const chat = $derived(currentChat())` snapshot (Q7)**

```svelte
<script lang="ts">
  import { currentChat, isProcessing, consumeScrollRequest } from "../../stores/chat.svelte.js";
  // ...
  const chat = $derived(currentChat());
  // Uses: chat.messages, chat.phase, chat.loadLifecycle, chat.historyHasMore, etc.
</script>
```

All template reads become `chat.X` (not `chatState.X`, not `currentChat().X`).

**Step 2: Add component test** (`test/unit/components/message-list-multi-session.test.ts`):

```ts
it("switching currentId re-renders with new session's messages", async () => {
  const A = getOrCreateSessionState("A");
  A.messages = [mkUserMsg("from A")];
  const B = getOrCreateSessionState("B");
  B.messages = [mkUserMsg("from B")];
  sessionState.currentId = "A";
  const { getByText, queryByText } = render(MessageList);
  expect(getByText("from A")).toBeInTheDocument();
  sessionState.currentId = "B";
  await flushSync();
  expect(queryByText("from A")).toBeNull();
  expect(getByText("from B")).toBeInTheDocument();
});
```

### Task 6.2: `InputArea.svelte` — bounce bar + testid

**Files:**
- Modify: `src/lib/frontend/components/input/InputArea.svelte:468-479`

**Step 1: Add `data-testid="bounce-bar"` to the bounce bar container** (moved from v1 plan's Task 8.3 per audit finding H7):

```svelte
{#if isProcessing()}
  <div data-testid="bounce-bar" class="..." style="--bounce-width: 0.3;">
    <div class="h-full rounded-full bg-accent animate-bounce-bar" style="width: calc(var(--bounce-width) * 100%);"></div>
  </div>
{/if}
```

**Step 2: Confirm `isProcessing()` now routes via `currentChat().phase !== "idle"`.** Read the implementation in `chat.svelte.ts`; template requires no change — the indirection is in the helper.

**Step 3: Add component test** (`test/unit/components/input-area-bounce-bar.test.ts`):

```ts
it("bounce bar visible when current session's phase is non-idle", async () => {
  const A = getOrCreateSessionState("A");
  A.phase = "streaming";
  sessionState.currentId = "A";
  const { getByTestId } = render(InputArea);
  expect(getByTestId("bounce-bar")).toBeInTheDocument();
});

it("bounce bar invisible when current session is idle, regardless of other sessions", async () => {
  const A = getOrCreateSessionState("A");
  const B = getOrCreateSessionState("B");
  B.phase = "streaming";
  sessionState.currentId = "A"; // A is idle, B is streaming
  const { queryByTestId } = render(InputArea);
  expect(queryByTestId("bounce-bar")).toBeNull();
});

it("bounce bar hides when current session transitions from streaming to idle", async () => {
  const A = getOrCreateSessionState("A");
  A.phase = "streaming";
  sessionState.currentId = "A";
  const { queryByTestId } = render(InputArea);
  expect(queryByTestId("bounce-bar")).toBeInTheDocument();
  A.phase = "idle";
  await flushSync();
  expect(queryByTestId("bounce-bar")).toBeNull();
});
```

### Task 6.3: `SessionItem.svelte` — sidebar dot

**Step 1:**

```svelte
<script lang="ts">
  import { getSessionPhase } from "../../stores/chat.svelte.js";
  // ...
  const isProcessing = $derived(
    session.processing || getSessionPhase(session.id) !== "idle",
  );
</script>
```

Keep `session.processing` disjunction per Q6 (server flag wins).

**Step 2: Component tests** (`test/unit/components/session-item-processing.test.ts`):

```ts
it("row for B pulses when B's phase is non-idle regardless of currentId", () => {
  sessionState.currentId = "A";
  const B = getOrCreateSessionState("B");
  B.phase = "streaming";
  const { container } = render(SessionItem, { props: { session: mkSession("B"), active: false } });
  expect(container.querySelector(".session-processing-dot")).toBeInTheDocument();
});

it("row for B does NOT pulse when A is non-idle but B is idle", () => {
  sessionState.currentId = "A";
  getOrCreateSessionState("A").phase = "streaming";
  getOrCreateSessionState("B");
  const { container } = render(SessionItem, { props: { session: mkSession("B"), active: false } });
  expect(container.querySelector(".session-processing-dot")).toBeNull();
});

it("server flag overrides local idle state (Q6 precedence)", () => {
  const A = getOrCreateSessionState("A");
  A.phase = "idle";
  const { container } = render(SessionItem, {
    props: { session: { ...mkSession("A"), processing: true }, active: false },
  });
  expect(container.querySelector(".session-processing-dot")).toBeInTheDocument();
});
```

### Task 6.4: Remaining readers (explicit enumeration)

One commit per file:

- **6.4a:** `src/lib/frontend/components/chat/UserMessage.svelte` — reads `chatState.turnEpoch`. Replace via `const chat = $derived(currentChat()); chat.turnEpoch`.
- **6.4b:** `src/lib/frontend/components/chat/HistoryLoader.svelte` — reads `chatState.loadLifecycle`, `historyState.*`. Replace via snapshot.
- **6.4c:** `src/lib/frontend/components/layout/ChatLayout.svelte` — dead import (grep confirms no actual read). Just remove the import line.
- **6.4d:** `src/lib/frontend/components/chat/MessageList.stories.ts` — direct writes `chatState.messages = [...]`. Rewrite to use `getOrCreateSessionState("story-session"); sessionState.currentId = "story-session"; state.messages = [...]`.

---

## Phase 7 — Invariant tests

### Task 7.1: `regression-phase-no-leak.test.ts` — full WS round-trip

**Files:**
- Create: `test/unit/stores/regression-phase-no-leak.test.ts`

**Use the full `switchToSession` + `session_switched` response flow, not raw currentId mutation.**

```ts
describe("phase does not leak across session switches", () => {
  it("switch A(streaming)→B(idle)→A shows correct phase at every step", async () => {
    const mockWs = vi.fn();

    // Seed A as streaming.
    sessionState.currentId = "A";
    const A = getOrCreateSessionState("A");
    A.phase = "streaming";
    expect(isProcessing()).toBe(true);

    // Switch to B via full flow: optimistic currentId + view_session + server response.
    switchToSession("B", mockWs);
    // Optimistic gap:
    expect(sessionState.currentId).toBe("B");
    expect(isProcessing()).toBe(false); // B's slot is idle (just created)
    // Server responds with session_switched for B — empty session.
    handleMessage({ type: "session_switched", id: "B" });
    await vi.runAllTimersAsync();
    expect(isProcessing()).toBe(false);

    // Switch back to A via full flow.
    switchToSession("A", mockWs);
    // A's slot still has streaming phase.
    expect(isProcessing()).toBe(true);
    // Server responds for A with idle events (done at tail).
    handleMessage({
      type: "session_switched",
      id: "A",
      events: [
        { type: "delta", text: "hi", sessionId: "A" },
        { type: "done", code: 0, sessionId: "A" },
      ],
    });
    await vi.runAllTimersAsync();
    // After clear+replay (Q5): A's phase ends idle.
    expect(isProcessing()).toBe(false);
  });

  it("triggering bug regression: completed inactive session stays inactive on return", async () => {
    const mockWs = vi.fn();
    sessionState.currentId = "A";
    const A = getOrCreateSessionState("A");
    A.phase = "idle"; // completed
    const B = getOrCreateSessionState("B");
    B.phase = "streaming"; // active elsewhere

    // Navigate to B and back — phase must not leak B's streaming into A.
    switchToSession("B", mockWs);
    handleMessage({ type: "session_switched", id: "B" });
    await vi.runAllTimersAsync();

    switchToSession("A", mockWs);
    handleMessage({ type: "session_switched", id: "A",
      events: [{ type: "done", code: 0, sessionId: "A" }] });
    await vi.runAllTimersAsync();

    expect(isProcessing()).toBe(false);
    expect(isStreaming()).toBe(false);
    expect(currentChat().phase).toBe("idle");
    expect(currentChat().loadLifecycle).not.toBe("loading");
  });
});
```

Snippets use standard test mocks: `vi.hoisted(() => ... localStorage ...)`, `vi.mock("dompurify", ...)`, `vi.useFakeTimers()`, unconditional `await vi.runAllTimersAsync()`.

### Task 7.2: Routing coverage — every variant (from Phase 3)

Already sketched in Phase 3 Task 3.1. Consolidate here: enumerate all 17 per-session variants; for each assert slot routing is correct.

### Task 7.3: Concurrent-session dispatch — concrete payloads

```ts
it("interleaved deltas for A, B, C — slots stay independent", async () => {
  sessionChatStates.clear();
  const events: PerSessionEvent[] = [
    { type: "user_message", text: "q-a", sessionId: "A" },
    { type: "user_message", text: "q-b", sessionId: "B" },
    { type: "delta", text: "a-", sessionId: "A" },
    { type: "delta", text: "b-", sessionId: "B" },
    { type: "user_message", text: "q-c", sessionId: "C" },
    { type: "delta", text: "a1", sessionId: "A" },
    { type: "delta", text: "c-", sessionId: "C" },
    { type: "done", code: 0, sessionId: "A" },
    { type: "done", code: 0, sessionId: "B" },
    { type: "done", code: 0, sessionId: "C" },
  ];
  for (const e of events) handleMessage(e);
  await vi.runAllTimersAsync();
  expect(sessionChatStates.get("A")?.phase).toBe("idle");
  expect(sessionChatStates.get("B")?.phase).toBe("idle");
  expect(sessionChatStates.get("C")?.phase).toBe("idle");
  // Each slot only contains its own messages.
  const aMsgs = sessionChatStates.get("A")?.messages ?? [];
  expect(aMsgs.every((m) => m.type !== "assistant" || /a/.test((m as AssistantMessage).rawText))).toBe(true);
});

it("live delta during replay: buffers then drains in correct order", async () => {
  sessionChatStates.clear();
  // Start replay of A with 2 events; simulate live event arriving between replay start and commit.
  const p = replayEvents(getOrCreateSessionState("A"),
    [{ type: "delta", text: "cached-", sessionId: "A" }],
    "A",
    false,
  );
  // Live event arrives while replay is still in the batch.
  handleMessage({ type: "delta", text: "live", sessionId: "A" });
  await p;
  await vi.runAllTimersAsync();
  const A = sessionChatStates.get("A")!;
  const assistantText = (A.messages[A.messages.length - 1] as AssistantMessage).rawText;
  expect(assistantText).toBe("cached-live"); // cached first, live second
});
```

### Task 7.4: F2 integration coverage

`test/integration/status-idle-streaming.test.ts` — full pipeline from SSE → event-pipeline → frontend dispatcher → `handleStatus`:

```ts
it("status:idle for session X clears X's streaming phase end-to-end", async () => {
  const harness = await makeRelayHarness();
  await harness.simulateMidStreamInterruption("s1");
  // Session ends mid-stream with no done. Server eventually emits status:idle.
  harness.emitStatus("s1", "idle");
  await harness.flush();
  expect(sessionChatStates.get("s1")?.phase).toBe("idle");
});
```

### Task 7.5: Eviction concurrency

```ts
it("eviction never drops a session actively receiving deltas", async () => {
  // Fill map to cap with idle sessions.
  for (let i = 0; i < SESSION_CHAT_MAP_CAP; i++) {
    const s = getOrCreateSessionState(`s${i}`);
    s.phase = "idle";
  }
  // Start streaming on s0.
  sessionChatStates.get("s0")!.phase = "streaming";
  // Create one more — triggers eviction.
  getOrCreateSessionState("new");
  expect(sessionChatStates.has("s0")).toBe(true); // survives
  // Oldest idle (s1) evicted instead.
  expect(sessionChatStates.has("s1")).toBe(false);
});
```

### Task 7.6: InputArea bounce bar component regression

Already spelled out in Task 6.2. Move the "completed inactive → return" scenario here:

```ts
it("bounce bar never visible on return to a completed session (triggering bug)", async () => {
  const mockWs = vi.fn();
  sessionState.currentId = "A";
  const A = getOrCreateSessionState("A");
  A.phase = "idle";
  const B = getOrCreateSessionState("B");
  B.phase = "streaming";
  const { queryByTestId, rerender } = render(InputArea);
  expect(queryByTestId("bounce-bar")).toBeNull();

  switchToSession("B", mockWs);
  await rerender({});
  expect(queryByTestId("bounce-bar")).toBeInTheDocument();

  switchToSession("A", mockWs);
  handleMessage({ type: "session_switched", id: "A",
    events: [{ type: "done", code: 0, sessionId: "A" }] });
  await rerender({});
  expect(queryByTestId("bounce-bar")).toBeNull();
});
```

### Task 7.7: SessionItem dot component regression

Mirror of 7.6 for sidebar dot:

```ts
it("sidebar dot for returned session reflects idle state", async () => {
  sessionState.currentId = "B"; // user viewing B
  const A = getOrCreateSessionState("A");
  A.phase = "idle";
  const B = getOrCreateSessionState("B");
  B.phase = "streaming";

  const { container } = render(SessionItem, { props: { session: mkSession("A"), active: false } });
  expect(container.querySelector(".session-processing-dot")).toBeNull();
});
```

---

## Phase 8 — Storybook + E2E

### Task 8.1: Multi-session sidebar story

**Files:**
- Create: `src/lib/frontend/components/session/SessionList.multi-session.stories.ts`

Stub `sessionChatStates` in story setup:

```ts
export const MultiPhase: Story = {
  play: async () => {
    sessionChatStates.clear();
    getOrCreateSessionState("s-idle").phase = "idle";
    getOrCreateSessionState("s-proc").phase = "processing";
    getOrCreateSessionState("s-stream").phase = "streaming";
    sessionState.allSessions = [
      mkSession("s-idle"), mkSession("s-proc"), mkSession("s-stream"),
    ];
    sessionState.currentId = "s-idle";
  },
};
```

### Task 8.2: Regression story — navigate-away-and-back

Storybook `play()` function that simulates the switch sequence with visual snapshots at each step. Use repo's visual-snapshot harness (check `src/lib/frontend/components/**/*.stories.ts` for existing snapshot pattern).

### Task 8.3: E2E Playwright — corrected harness

**Files:**
- Create: `test/e2e/session-activity-indicators.spec.ts`
- Config: use existing `playwright-replay.config.ts` (the replay-based config that doesn't need a real LLM)

Use the replay fixture at `test/e2e/replay-fixture.ts`:

```ts
import { test, expect } from "@playwright/test";
import { setupReplayProject } from "./replay-fixture.js"; // slug: "e2e-replay"

test.describe("Session activity indicators — triggering bug", () => {
  test.beforeEach(async ({ page }) => {
    await setupReplayProject(page, {
      sessions: [
        { id: "sess_idle_a", transcript: "fixtures/completed-turn.json" },
        { id: "sess_idle_b", transcript: "fixtures/completed-turn.json" },
      ],
    });
  });

  test("(a) idle→idle switch: returned session shows no bounce bar", async ({ page }) => {
    await page.goto("/p/e2e-replay/s/sess_idle_a");
    await page.click('[data-session-id="sess_idle_b"]');
    await page.click('[data-session-id="sess_idle_a"]');
    await expect(page.locator('[data-testid="bounce-bar"]')).toHaveCount(0);
    await expect(
      page.locator('[data-session-id="sess_idle_a"] .session-processing-dot'),
    ).toHaveCount(0);
  });

  test("(b) processing→idle switch: returned idle session stays idle", async ({ page }) => {
    // Set up B with a mid-stream (incomplete) transcript.
    await setupReplayProject(page, {
      sessions: [
        { id: "sess_idle_a", transcript: "fixtures/completed-turn.json" },
        { id: "sess_streaming_b", transcript: "fixtures/mid-stream.json" },
      ],
    });
    await page.goto("/p/e2e-replay/s/sess_idle_a");
    await page.click('[data-session-id="sess_streaming_b"]');
    await expect(page.locator('[data-testid="bounce-bar"]')).toBeVisible();
    await page.click('[data-session-id="sess_idle_a"]');
    await expect(page.locator('[data-testid="bounce-bar"]')).toHaveCount(0);
  });

  test("(c) sidebar dot for background session pulses during its activity", async ({ page }) => {
    await page.goto("/p/e2e-replay/s/sess_idle_a");
    await page.click('[data-session-id="sess_streaming_b"]');
    // While viewing B, B's dot should pulse; A's should not.
    await expect(
      page.locator('[data-session-id="sess_streaming_b"] .session-processing-dot'),
    ).toBeVisible();
    await expect(
      page.locator('[data-session-id="sess_idle_a"] .session-processing-dot'),
    ).toHaveCount(0);
  });

  test("(d) rapid switches: final state matches last-viewed session", async ({ page }) => {
    await page.goto("/p/e2e-replay/s/sess_idle_a");
    for (let i = 0; i < 5; i++) {
      await page.click('[data-session-id="sess_idle_b"]');
      await page.click('[data-session-id="sess_idle_a"]');
    }
    await expect(page.locator('[data-testid="bounce-bar"]')).toHaveCount(0);
  });
});
```

**SDK coverage note:** The replay harness is OpenCode-based. F3 (Claude SDK timeout) is covered by the unit tests in Task 4.1. The E2E asserts UI symptoms that are SDK-agnostic.

---

## Phase 9 — Final verification

### Task 9.1: Full green run

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
pnpm test:e2e -- --config=playwright-replay.config.ts session-activity-indicators
```

### Task 9.2: Manual QA (live LLM)

1. Start daemon: `pnpm dev`.
2. Two sessions. Turn in A. Wait idle.
3. Navigate to B. Turn in B. Wait idle.
4. Navigate back to A. Observe: no bounce bar, no pulsing dot for A.
5. Start a turn in A. Navigate to B mid-stream. Observe A's sidebar dot pulses.
6. Navigate back to A while still processing. Observe bounce bar visible; on `done`, disappears.

### Task 9.3: Manual QA (mock-mode, no LLM billing required)

**Files:**
- Create: `scripts/manual-qa-mock-mode.ts`

```ts
#!/usr/bin/env tsx
// Replays canned session transcripts against a running daemon for manual UI QA
// without requiring LLM API keys/billing.
//
// Usage: pnpm exec tsx scripts/manual-qa-mock-mode.ts
//
// 1. Starts daemon in replay mode (env DAEMON_MODE=replay)
// 2. Creates 2 synthetic sessions with the fixtures used by E2E
// 3. Opens http://localhost:2633/p/mock in default browser
// 4. Prints the same 6-step checklist from Task 9.2 for visual verification
```

Add to `package.json`: `"manual-qa:mock": "tsx scripts/manual-qa-mock-mode.ts"`.

### Task 9.4: Bandwidth regression test (Q9)

**Files:**
- Create: `test/contract/bandwidth-baseline.test.ts`

```ts
describe("project-firehose bandwidth stays within threshold", () => {
  it("single idle project emits <= N events/sec per client", async () => {
    const harness = await makeServerHarness();
    const client = harness.addClient({ project: "p1", view: "A" });
    harness.tickSeconds(10); // no activity
    const rate = client.received.length / 10;
    expect(rate).toBeLessThan(1); // <1 event/sec idle baseline
  });

  it("project with N concurrent active sessions scales linearly (ballpark)", async () => {
    const harness = await makeServerHarness();
    const client = harness.addClient({ project: "p1", view: "A" });
    harness.startSyntheticActivity({ sessions: 5, eventsPerSecond: 10 });
    harness.tickSeconds(5);
    const rate = client.received.length / 5;
    // 5 sessions × 10 events/sec = 50 events/sec upper bound; allow 2x headroom.
    expect(rate).toBeLessThan(100);
  });
});
```

Threshold values tuned in first run; CI failure means the fanout broadened in an unexpected way.

### Task 9.5: Ship

```bash
git push origin feature/per-session-chat-state
gh pr create --title "per-session chat state refactor" --body "$(cat <<'EOF'
## Summary
- Replace module-level chatState singleton with keyed SvelteMap per sessionId.
- Server: project-scoped firehose; every per-session event carries sessionId.
- Fix: bounce bar and sidebar dot no longer show as active on inactive sessions after navigation.
- Bundles F2 (status:idle clears streaming) and F3 (patchMissingDone checks Claude SDK timeout) fixes.

## Test plan
- [x] pnpm check
- [x] pnpm lint
- [x] pnpm test:unit
- [x] pnpm test:all
- [x] pnpm test:e2e session-activity-indicators
- [x] Manual QA (live LLM) per Task 9.2
- [x] Manual QA (mock mode) per Task 9.3
EOF
)"
```

---

## Related skills

- @superpowers:test-driven-development — every task follows write-test-first.
- @superpowers:systematic-debugging — applied when tracing the triggering bug and F2/F3.
- @superpowers:verification-before-completion — required before claiming each phase done.
- @superpowers:executing-plans — run this plan.

## Rollback

- **Phase 0 / 0b** rollback: server commits only; frontend unaffected.
- **Phases 1–5** rollback: commit-by-commit revert. Each is isolated.
- **Phase 6** rollback: components only.
- **Phase 9.4 bandwidth test** threshold: if flaky, relax to warn-only before removing.

Per-session firehose bandwidth is the primary operational risk. If Task 9.4 or real-world telemetry regresses significantly, follow up with a subscribe-list protocol (A3 fallback — tracked as follow-up design, not this plan).
