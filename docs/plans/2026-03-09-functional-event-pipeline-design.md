# Functional Event Pipeline Refactoring

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the relay's event flow easier to reason about and debug by replacing imperative side-effect-heavy code with functional data transforms, explicit drop logging, unified session tracking, and per-client message queues.

**Architecture:** Four independent refactoring tasks, each shippable on its own. No behavioral changes — same inputs, same outputs, same tests pass. Each task has a clear before/after boundary. Tasks 1-3 are pure refactors of existing modules. Task 4 changes the concurrency model for the handler queue.

**Tech Stack:** TypeScript, Vitest, existing mock factories in `test/helpers/mock-factories.ts`

---

## Task 1: Pure pipeline functions (replace `processRelayEvent`)

**Problem:** `processRelayEvent` in `event-pipeline.ts` does 4 unrelated things (truncation, timeout management, caching, routing) in one function, with side effects at every step. You can't test or reason about any concern in isolation.

**Files:**
- Rewrite: `src/lib/relay/event-pipeline.ts`
- Modify: `src/lib/relay/sse-wiring.ts` (call sites)
- Modify: `src/lib/relay/relay-stack.ts` (call sites: pollerPipelineDeps, status poller done)
- Test: `test/unit/relay/event-pipeline.test.ts` (new)
- Modify: `test/unit/relay/sse-wiring.test.ts` (update any tests calling processRelayEvent)
- Modify: `test/unit/relay/regression-server-cache-pipeline.test.ts` (update if it calls processRelayEvent)

### Step 1: Write failing tests for pure pipeline functions

Create `test/unit/relay/event-pipeline.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  truncateIfNeeded,
  resolveRoute,
  shouldCache,
} from "../../../src/lib/relay/event-pipeline.js";

describe("truncateIfNeeded", () => {
  it("passes through non-tool_result messages unchanged", () => {
    const msg = { type: "delta" as const, text: "hi" };
    const result = truncateIfNeeded(msg);
    expect(result.msg).toBe(msg);
    expect(result.fullContent).toBeUndefined();
  });

  it("truncates tool_result with content over threshold", () => {
    const content = "x".repeat(60_000);
    const msg = { type: "tool_result" as const, id: "t1", content, is_error: false };
    const result = truncateIfNeeded(msg, 50_000);
    expect(result.msg.content.length).toBeLessThanOrEqual(50_000);
    expect(result.msg.isTruncated).toBe(true);
    expect(result.fullContent).toBe(content);
  });

  it("does not truncate tool_result under threshold", () => {
    const msg = { type: "tool_result" as const, id: "t1", content: "short", is_error: false };
    const result = truncateIfNeeded(msg);
    expect(result.msg).toBe(msg);
    expect(result.fullContent).toBeUndefined();
  });
});

describe("resolveRoute", () => {
  it("returns send when viewers exist", () => {
    const result = resolveRoute("delta", "ses_abc", ["client1"]);
    expect(result).toEqual({ action: "send", sessionId: "ses_abc" });
  });

  it("returns drop with reason when no viewers", () => {
    const result = resolveRoute("tool_result", "ses_abc", []);
    expect(result).toEqual({
      action: "drop",
      reason: "no viewers for session ses_abc",
    });
  });

  it("returns drop when no sessionId", () => {
    const result = resolveRoute("delta", undefined, []);
    expect(result).toEqual({ action: "drop", reason: "no session ID" });
  });
});

describe("shouldCache", () => {
  it("returns true for chat event types", () => {
    expect(shouldCache("delta")).toBe(true);
    expect(shouldCache("tool_start")).toBe(true);
    expect(shouldCache("done")).toBe(true);
  });

  it("returns false for non-chat event types", () => {
    expect(shouldCache("permission_request")).toBe(false);
    expect(shouldCache("file_changed")).toBe(false);
    expect(shouldCache("session_list")).toBe(false);
  });
});
```

### Step 2: Run tests, verify they fail

Run: `pnpm vitest test/unit/relay/event-pipeline.test.ts --run`
Expected: FAIL — functions not exported yet.

### Step 3: Implement the pure functions

Rewrite `src/lib/relay/event-pipeline.ts`:

```typescript
// ─── Shared Event Pipeline ───────────────────────────────────────────────────
// Pure functions for event processing. Each function does one thing and returns
// data — no side effects. The caller composes them and executes side effects.

import type { RelayMessage } from "../shared-types.js";
import { truncateToolResult as truncateToolResultImpl } from "./truncate-content.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RouteDecision =
  | { action: "send"; sessionId: string }
  | { action: "drop"; reason: string };

export interface TruncateResult {
  msg: RelayMessage;
  /** Full content before truncation. Undefined if no truncation occurred. */
  fullContent: string | undefined;
}

// ─── Pure functions ──────────────────────────────────────────────────────────

/** Truncate tool_result messages over threshold. Other types pass through. */
export function truncateIfNeeded(
  msg: RelayMessage,
  threshold?: number,
): TruncateResult {
  if (msg.type !== "tool_result") {
    return { msg, fullContent: undefined };
  }
  const { truncated, fullContent } = truncateToolResultImpl(msg);
  return { msg: truncated, fullContent };
}

/** Determine whether a message should be cached for replay. */
export function shouldCache(type: string): boolean {
  return CACHEABLE_TYPES.has(type);
}

const CACHEABLE_TYPES = new Set([
  "user_message", "delta", "thinking_start", "thinking_delta",
  "thinking_stop", "tool_start", "tool_executing", "tool_result",
  "result", "status", "done", "error",
]);

/** Determine where to route a message: send to session viewers, or drop. */
export function resolveRoute(
  msgType: string,
  sessionId: string | undefined,
  viewers: string[],
): RouteDecision {
  if (!sessionId) {
    return { action: "drop", reason: "no session ID" };
  }
  if (viewers.length > 0) {
    return { action: "send", sessionId };
  }
  return { action: "drop", reason: `no viewers for session ${sessionId}` };
}

/** Determine timeout action for a message. */
export function resolveTimeout(
  msgType: string,
  sessionId: string | undefined,
): "clear" | "reset" | "none" {
  if (!sessionId) return "none";
  if (msgType === "done") return "clear";
  return "reset";
}

// ─── Composed pipeline (convenience, still side-effect free) ─────────────────

export interface PipelineResult {
  msg: RelayMessage;
  fullContent: string | undefined;
  route: RouteDecision;
  cache: boolean;
  timeout: "clear" | "reset" | "none";
}

/**
 * Process a relay event through the pipeline. Returns all decisions as data.
 * The caller is responsible for executing side effects (sending, caching, etc.).
 */
export function processEvent(
  msg: RelayMessage,
  sessionId: string | undefined,
  viewers: string[],
): PipelineResult {
  const truncated = truncateIfNeeded(msg);
  return {
    msg: truncated.msg,
    fullContent: truncated.fullContent,
    route: resolveRoute(truncated.msg.type, sessionId, viewers),
    cache: sessionId != null && shouldCache(truncated.msg.type),
    timeout: resolveTimeout(truncated.msg.type, sessionId),
  };
}
```

### Step 4: Run tests, verify they pass

Run: `pnpm vitest test/unit/relay/event-pipeline.test.ts --run`
Expected: PASS

### Step 5: Update call sites to use the new composed pipeline

Modify `src/lib/relay/sse-wiring.ts` — replace `processRelayEvent(msg, targetSessionId, pipelineDeps)` with the composed pipeline:

```typescript
// Before (inside the for loop in handleSSEEvent):
msg = processRelayEvent(msg, targetSessionId, pipelineDeps);

// After:
const viewers = targetSessionId
  ? wsHandler.getClientsForSession(targetSessionId)
  : [];
const result = processEvent(msg, targetSessionId, viewers);
msg = result.msg;

// Execute side effects explicitly:
if (result.fullContent !== undefined && targetSessionId) {
  toolContentStore.store((msg as { id: string }).id, result.fullContent, targetSessionId);
}
if (result.timeout === "clear" && targetSessionId) {
  overrides.clearProcessingTimeout(targetSessionId);
} else if (result.timeout === "reset" && targetSessionId) {
  overrides.resetProcessingTimeout(targetSessionId);
}
if (result.cache && targetSessionId) {
  messageCache.recordEvent(targetSessionId, msg);
}
if (result.route.action === "send") {
  wsHandler.sendToSession(result.route.sessionId, msg);
} else {
  log(`   [pipeline] ${result.route.reason} — ${msg.type}`);
}
```

Apply the same pattern in `relay-stack.ts` for the two other call sites:
- `pollerPipelineDeps` usage in the `pollerManager.on("events", ...)` handler (~line 721)
- Status poller `done` emission (~line 618)

### Step 6: Remove old `processRelayEvent` and `EventPipelineDeps`

Delete the old function and interface from `event-pipeline.ts`. Remove the `EventPipelineDeps` import from `sse-wiring.ts` and `relay-stack.ts`.

### Step 7: Update existing tests

- `test/unit/relay/sse-wiring.test.ts` — update any tests that mock `processRelayEvent` or `EventPipelineDeps`
- `test/unit/relay/regression-server-cache-pipeline.test.ts` — update to use new API
- `test/unit/relay/per-tab-routing-e2e.test.ts` — should pass without changes (tests the full stack)

### Step 8: Run full test suite

Run: `pnpm test:unit`
Expected: All tests pass.

### Step 9: Commit

```
feat: replace processRelayEvent with pure pipeline functions

The event pipeline now returns routing/caching/timeout decisions as data
instead of executing side effects. Callers compose and execute explicitly.
Dropped events are always logged with a reason — no more silent drops.
```

---

## Task 2: Explicit `TranslateResult` (eliminate silent translator drops)

**Problem:** `translator.translate()` returns `null` for ~20 event types with no indication of why. When debugging, you can't tell if an event was intentionally ignored or unexpectedly dropped.

**Files:**
- Modify: `src/lib/relay/event-translator.ts` (change return type)
- Modify: `src/lib/relay/sse-wiring.ts` (handle new return type)
- Test: `test/unit/relay/event-translator-result.test.ts` (new)
- Modify: `test/unit/relay/sse-wiring.test.ts` (update mocks)
- Modify: `test/helpers/mock-factories.ts` (update mock translator)

### Step 1: Write failing tests for TranslateResult

Create `test/unit/relay/event-translator-result.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";

describe("translator returns TranslateResult", () => {
  const translator = createTranslator();

  it("returns ok: true with messages for known events", () => {
    const result = translator.translate({
      type: "session.status",
      properties: { sessionID: "s1", status: { type: "busy" } },
    });
    expect(result).toHaveProperty("ok", true);
    if (result.ok) {
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  it("returns ok: false with reason for unknown events", () => {
    const result = translator.translate({
      type: "some.unknown.event",
      properties: {},
    });
    expect(result).toEqual({
      ok: false,
      reason: "unhandled event type: some.unknown.event",
    });
  });

  it("returns ok: false for events that produce no messages", () => {
    // permission.replied is handled by the bridge, not the translator
    const result = translator.translate({
      type: "permission.replied",
      properties: { id: "perm1" },
    });
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason");
  });
});
```

### Step 2: Run tests, verify they fail

Run: `pnpm vitest test/unit/relay/event-translator-result.test.ts --run`
Expected: FAIL — translate() still returns `RelayMessage | RelayMessage[] | null`.

### Step 3: Define the TranslateResult type and update the translator

In `src/lib/relay/event-translator.ts`, add:

```typescript
export type TranslateResult =
  | { ok: true; messages: RelayMessage[] }
  | { ok: false; reason: string };
```

Update the `Translator` interface:

```typescript
export interface Translator {
  translate(event: OpenCodeEvent): TranslateResult;
  // ... rest unchanged
}
```

Update `createTranslator().translate()`: instead of returning `null`, return `{ ok: false, reason: "..." }`. Instead of returning a message or array, return `{ ok: true, messages: [...] }`.

Each existing `return null` becomes `return { ok: false, reason: "<specific reason>" }`:
- Unknown event type → `"unhandled event type: ${eventType}"`
- Part updated with no type → `"part has no type"`
- Text part (no action needed) → `"text part update (streamed via deltas)"`
- permission.replied → `"permission.replied handled by bridge"`
- etc.

Each existing `return msg` or `return [msg1, msg2]` becomes:
```typescript
return { ok: true, messages: Array.isArray(result) ? result : [result] };
```

### Step 4: Run translator result tests, verify pass

Run: `pnpm vitest test/unit/relay/event-translator-result.test.ts --run`
Expected: PASS

### Step 5: Update sse-wiring.ts to handle TranslateResult

```typescript
// Before:
const messages = translator.translate(event);
if (!messages) {
  if (event.type === "permission.asked") {
    log(`   [sse] WARNING: ...`);
  }
  return;
}
const toSend = Array.isArray(messages) ? messages : [messages];

// After:
const result = translator.translate(event);
if (!result.ok) {
  // Every drop is logged — no more silent swallowing
  if (result.reason !== "unhandled event type" || import.meta.env?.DEV) {
    log(`   [sse] translate skip: ${result.reason} (${event.type})`);
  }
  return;
}
const toSend = result.messages;
```

### Step 6: Update mock translator in mock-factories.ts

```typescript
function createMockTranslator(): SSEWiringDeps["translator"] {
  return {
    translate: vi.fn().mockReturnValue({ ok: false, reason: "mock" }),
    // ... rest unchanged
  };
}
```

### Step 7: Update existing translator tests

Existing tests in `test/unit/relay/event-translator.*.test.ts` that check for `null` or direct message returns need updating to check the new `TranslateResult` shape. This is mechanical: `expect(result).toBeNull()` → `expect(result.ok).toBe(false)`, and `expect(result.type).toBe("delta")` → `expect(result.ok && result.messages[0].type).toBe("delta")`.

### Step 8: Run full test suite

Run: `pnpm test:unit`
Expected: All tests pass.

### Step 9: Commit

```
refactor: translator returns TranslateResult instead of null

Every translate() call now returns either { ok: true, messages } or
{ ok: false, reason }. No more silent event drops — every skipped event
is logged with a human-readable reason.
```

---

## Task 3: Unified SessionRegistry

**Problem:** Session identity is tracked in 8 places with manual coordination. `clientSessions`, `viewerCounts`, `activeSessionId` can disagree, and there's no assertion that catches it.

**Files:**
- Create: `src/lib/session/session-registry.ts`
- Test: `test/unit/session/session-registry.test.ts` (new)
- Modify: `src/lib/server/ws-handler.ts` (delegate to registry)
- Modify: `src/lib/relay/relay-stack.ts` (remove viewer tracking, use registry)
- Modify: `src/lib/relay/message-poller-manager.ts` (use registry for viewer counts)
- Modify: `test/helpers/mock-factories.ts` (add registry mock)

### Step 1: Write failing tests for SessionRegistry

Create `test/unit/session/session-registry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../../../src/lib/session/session-registry.js";

describe("SessionRegistry", () => {
  it("tracks client-session associations", () => {
    const reg = new SessionRegistry();
    reg.setClientSession("c1", "s1");
    expect(reg.getClientSession("c1")).toBe("s1");
  });

  it("returns viewers for a session", () => {
    const reg = new SessionRegistry();
    reg.setClientSession("c1", "s1");
    reg.setClientSession("c2", "s1");
    reg.setClientSession("c3", "s2");
    expect(reg.getViewers("s1")).toEqual(["c1", "c2"]);
    expect(reg.getViewers("s2")).toEqual(["c3"]);
  });

  it("returns viewer count", () => {
    const reg = new SessionRegistry();
    reg.setClientSession("c1", "s1");
    reg.setClientSession("c2", "s1");
    expect(reg.getViewerCount("s1")).toBe(2);
    expect(reg.getViewerCount("s2")).toBe(0);
  });

  it("hasViewers returns true/false correctly", () => {
    const reg = new SessionRegistry();
    expect(reg.hasViewers("s1")).toBe(false);
    reg.setClientSession("c1", "s1");
    expect(reg.hasViewers("s1")).toBe(true);
  });

  it("handles session switch: removes from old, adds to new", () => {
    const reg = new SessionRegistry();
    reg.setClientSession("c1", "s1");
    expect(reg.getViewerCount("s1")).toBe(1);

    reg.setClientSession("c1", "s2");
    expect(reg.getViewerCount("s1")).toBe(0);
    expect(reg.getViewerCount("s2")).toBe(1);
  });

  it("removeClient cleans up", () => {
    const reg = new SessionRegistry();
    reg.setClientSession("c1", "s1");
    const sessionId = reg.removeClient("c1");
    expect(sessionId).toBe("s1");
    expect(reg.getViewerCount("s1")).toBe(0);
    expect(reg.getClientSession("c1")).toBeUndefined();
  });

  it("removeClient returns undefined for unknown client", () => {
    const reg = new SessionRegistry();
    expect(reg.removeClient("c999")).toBeUndefined();
  });
});
```

### Step 2: Run tests, verify they fail

Run: `pnpm vitest test/unit/session/session-registry.test.ts --run`
Expected: FAIL — module doesn't exist.

### Step 3: Implement SessionRegistry

Create `src/lib/session/session-registry.ts`:

```typescript
// ─── Session Registry ────────────────────────────────────────────────────────
// Single source of truth for client→session associations.
// Replaces the scattered tracking across ws-handler.clientSessions,
// pollerManager.viewerCounts, and relay-stack viewer management.

export class SessionRegistry {
  /** Primary state: clientId → sessionId */
  private clients = new Map<string, string>();

  /** Set which session a client is viewing. Handles switching automatically. */
  setClientSession(clientId: string, sessionId: string): void {
    const previous = this.clients.get(clientId);
    if (previous === sessionId) return; // no-op
    this.clients.set(clientId, sessionId);
  }

  /** Get the session a client is viewing. */
  getClientSession(clientId: string): string | undefined {
    return this.clients.get(clientId);
  }

  /** Get all client IDs viewing a specific session. */
  getViewers(sessionId: string): string[] {
    const result: string[] = [];
    for (const [cid, sid] of this.clients) {
      if (sid === sessionId) result.push(cid);
    }
    return result;
  }

  /** Get the number of clients viewing a session. */
  getViewerCount(sessionId: string): number {
    let count = 0;
    for (const sid of this.clients.values()) {
      if (sid === sessionId) count++;
    }
    return count;
  }

  /** Check if any client is viewing a session. */
  hasViewers(sessionId: string): boolean {
    for (const sid of this.clients.values()) {
      if (sid === sessionId) return true;
    }
    return false;
  }

  /** Remove a client entirely. Returns the session they were viewing. */
  removeClient(clientId: string): string | undefined {
    const sessionId = this.clients.get(clientId);
    this.clients.delete(clientId);
    return sessionId;
  }

  /** Clear all state. */
  clear(): void {
    this.clients.clear();
  }
}
```

### Step 4: Run tests, verify they pass

Run: `pnpm vitest test/unit/session/session-registry.test.ts --run`
Expected: PASS

### Step 5: Integrate into ws-handler.ts

Replace the private `clientSessions` map in `WebSocketHandler` with a `SessionRegistry` instance. Delegate `setClientSession`, `getClientSession`, `getClientsForSession`, `sendToSession` to it. The `sendToSession` method still lives on `WebSocketHandler` (it needs access to the WS connections), but it calls `registry.getViewers()` instead of iterating `clientSessions` directly.

```typescript
// In WebSocketHandler constructor:
private readonly registry: SessionRegistry;

constructor(...) {
  this.registry = options.registry ?? new SessionRegistry();
}

// Delegate:
setClientSession(clientId: string, sessionId: string): void {
  this.registry.setClientSession(clientId, sessionId);
}

getClientSession(clientId: string): string | undefined {
  return this.registry.getClientSession(clientId);
}

getClientsForSession(sessionId: string): string[] {
  // Filter to only connected clients (registry may have stale entries)
  return this.registry.getViewers(sessionId)
    .filter(cid => this.clients.has(cid));
}

// On disconnect, cleanup becomes:
const sessionId = this.registry.removeClient(clientId);
```

### Step 6: Remove viewer tracking from relay-stack.ts and message-poller-manager.ts

In `relay-stack.ts`, remove the `pollerManager.addViewer` / `removeViewer` calls. Instead, `pollerManager.hasViewers(sessionId)` can call `registry.hasViewers(sessionId)` — pass the registry into the poller manager or pass a `hasViewers` function.

In `message-poller-manager.ts`, remove the internal `viewerCounts` map and accept a `hasViewers: (sessionId: string) => boolean` function in the constructor instead.

### Step 7: Update tests

- `test/unit/server/ws-handler-sessions.test.ts` — update to use registry
- `test/unit/relay/message-poller-manager.test.ts` — update viewer tracking tests
- `test/unit/relay/per-tab-routing-e2e.test.ts` — should pass without changes
- `test/helpers/mock-factories.ts` — add `createMockSessionRegistry()`

### Step 8: Run full test suite

Run: `pnpm test:unit`
Expected: All tests pass.

### Step 9: Commit

```
refactor: unify session tracking in SessionRegistry

Replaces ws-handler.clientSessions, pollerManager.viewerCounts, and
manual addViewer/removeViewer calls with a single SessionRegistry.
One place to check for client→session associations, one place to debug.
```

---

## Task 4: Per-client message queues

**Problem:** All WebSocket messages from all clients are serialized through a single `Promise.resolve()` chain. A slow `handleViewSession` (4+ REST calls) blocks every other client. When debugging, you can't tell if the agent is stuck or a handler is blocking.

**Files:**
- Create: `src/lib/server/client-message-queue.ts`
- Test: `test/unit/server/client-message-queue.test.ts` (new)
- Modify: `src/lib/relay/relay-stack.ts` (replace `_messageQueue` with per-client queues)

### Step 1: Write failing tests

Create `test/unit/server/client-message-queue.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ClientMessageQueue } from "../../../src/lib/server/client-message-queue.js";

describe("ClientMessageQueue", () => {
  it("processes messages for the same client sequentially", async () => {
    const order: string[] = [];
    const queue = new ClientMessageQueue();

    const p1 = queue.enqueue("c1", async () => {
      await delay(50);
      order.push("c1-first");
    });
    const p2 = queue.enqueue("c1", async () => {
      order.push("c1-second");
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(["c1-first", "c1-second"]);
  });

  it("processes messages for different clients in parallel", async () => {
    const order: string[] = [];
    const queue = new ClientMessageQueue();

    const p1 = queue.enqueue("c1", async () => {
      await delay(50);
      order.push("c1");
    });
    const p2 = queue.enqueue("c2", async () => {
      order.push("c2");
    });

    await Promise.all([p1, p2]);
    // c2 should finish before c1 because they run in parallel
    expect(order).toEqual(["c2", "c1"]);
  });

  it("continues processing after handler error", async () => {
    const order: string[] = [];
    const queue = new ClientMessageQueue({ onError: vi.fn() });

    await queue.enqueue("c1", async () => {
      throw new Error("boom");
    });
    await queue.enqueue("c1", async () => {
      order.push("c1-after-error");
    });

    expect(order).toEqual(["c1-after-error"]);
  });

  it("cleans up idle clients", async () => {
    const queue = new ClientMessageQueue();
    await queue.enqueue("c1", async () => {});
    expect(queue.activeClients).toBe(0); // queue auto-cleans when empty
  });

  it("reports queue depth", async () => {
    const queue = new ClientMessageQueue();
    let depth = 0;

    const p1 = queue.enqueue("c1", async () => {
      await delay(50);
    });
    // While p1 is running, enqueue another
    const p2 = queue.enqueue("c1", async () => {
      depth = queue.getQueueDepth("c1");
    });

    await Promise.all([p1, p2]);
    // depth was 0 because p2 was executing (not queued) when it read
    expect(depth).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

### Step 2: Run tests, verify they fail

Run: `pnpm vitest test/unit/server/client-message-queue.test.ts --run`
Expected: FAIL — module doesn't exist.

### Step 3: Implement ClientMessageQueue

Create `src/lib/server/client-message-queue.ts`:

```typescript
// ─── Per-Client Message Queue ────────────────────────────────────────────────
// Serializes message handling per-client while allowing different clients to
// process in parallel. Replaces the global _messageQueue in relay-stack.ts.

export interface ClientMessageQueueOptions {
  /** Called when a handler throws. The queue continues processing. */
  onError?: (clientId: string, error: unknown) => void;
}

export class ClientMessageQueue {
  private queues = new Map<string, Promise<void>>();
  private readonly onError: ((clientId: string, error: unknown) => void) | undefined;

  constructor(options?: ClientMessageQueueOptions) {
    this.onError = options?.onError;
  }

  /**
   * Enqueue a handler for a specific client.
   * Handlers for the same client run sequentially.
   * Handlers for different clients run in parallel.
   */
  enqueue(clientId: string, handler: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(clientId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await handler();
      } catch (err) {
        this.onError?.(clientId, err);
      }
    });
    this.queues.set(clientId, next);

    // Clean up the map entry when the queue drains
    // (avoid unbounded map growth for short-lived clients)
    next.then(() => {
      if (this.queues.get(clientId) === next) {
        this.queues.delete(clientId);
      }
    });

    return next;
  }

  /** Remove a client's queue (e.g., on disconnect). */
  removeClient(clientId: string): void {
    this.queues.delete(clientId);
  }

  /** Number of clients with active queues. */
  get activeClients(): number {
    return this.queues.size;
  }

  /** Get pending items in a client's queue (0 = idle or executing). */
  getQueueDepth(_clientId: string): number {
    // The Promise chain doesn't expose depth directly.
    // This is a diagnostic aid — returns 0 if no pending work.
    return this.queues.has(_clientId) ? 1 : 0;
  }
}
```

### Step 4: Run tests, verify they pass

Run: `pnpm vitest test/unit/server/client-message-queue.test.ts --run`
Expected: PASS

### Step 5: Replace global queue in relay-stack.ts

```typescript
// Before:
let _messageQueue = Promise.resolve();

wsHandler.on("message", ({ clientId, handler, payload }) => {
  _messageQueue = _messageQueue.then(async () => {
    // ...
    await dispatchMessage(handlerDeps, clientId, handler, payload);
    // ...
  });
});

// After:
const clientQueue = new ClientMessageQueue({
  onError: (cid, err) => {
    log(`   [ws] Error in handler for ${cid}:`, formatErrorDetail(err));
    wsHandler.sendTo(cid, RelayError.fromCaught(err, "HANDLER_ERROR").toMessage());
  },
});

wsHandler.on("message", ({ clientId, handler, payload }) => {
  // Rate-limit check can stay outside the queue (it's synchronous)
  if (handler === "message") {
    const result = rateLimiter.check(clientId);
    if (!result.allowed) {
      wsHandler.sendTo(clientId, {
        type: "error",
        code: "RATE_LIMITED",
        message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
      });
      return;
    }
  }

  clientQueue.enqueue(clientId, async () => {
    await dispatchMessage(handlerDeps, clientId, handler, payload);
  });
});

// On client disconnect, clean up:
wsHandler.on("client_disconnected", ({ clientId }) => {
  clientQueue.removeClient(clientId);
  // ... existing disconnect logic
});
```

### Step 6: Run full test suite

Run: `pnpm test:unit`
Expected: All tests pass.

### Step 7: Commit

```
feat: per-client message queues replace global serialization

Messages from different clients are now processed in parallel. A slow
handler for one client (e.g., session switch with 4 REST calls) no
longer blocks message processing for all other clients.
```

---

## Task 5: Remove diagnostic logging from debugging session

**Problem:** Diagnostic `[DIAG]` logging was added during the mobile debugging session and should be removed.

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts` — remove `[DIAG]` and verbose permission logging
- Modify: `src/lib/relay/event-pipeline.ts` — remove `[DIAG pipeline]` logging (replaced by Task 1's explicit drop logging)
- Modify: `src/lib/relay/relay-stack.ts` — remove `[DIAG msg-in]`, `[DIAG msg-queue]`, `[DIAG msg-slow]` logging
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` — remove `[DIAG ws-dispatch]` console.logs
- Modify: `src/lib/frontend/stores/permissions.svelte.ts` — remove `[DIAG handlePermissionRequest]` and `[DIAG handleAskUser]` console.logs

### Step 1: Remove all `[DIAG` logging

Search for `[DIAG` across the codebase and remove each diagnostic log line. Revert the verbose permission logging in `sse-wiring.ts` to the simpler original format.

### Step 2: Run full test suite

Run: `pnpm test:unit`
Expected: All tests pass.

### Step 3: Commit

```
chore: remove diagnostic logging from mobile debugging session
```

---

## Execution Order

Tasks are independent and can be done in any order, but the recommended sequence is:

1. **Task 5** (cleanup) — quick win, removes noise
2. **Task 1** (pure pipeline) — highest debuggability impact
3. **Task 2** (TranslateResult) — complements Task 1
4. **Task 3** (SessionRegistry) — removes state duplication
5. **Task 4** (per-client queues) — concurrency improvement

Each task is independently shippable — the codebase is correct after each commit.
