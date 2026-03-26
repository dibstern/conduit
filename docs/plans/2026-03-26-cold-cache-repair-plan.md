# Cold Cache Repair — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Prevent truncated messages after conduit restarts by surgically repairing cold cache data and flushing on graceful stop.

**Architecture:** A pure `repairColdSession()` function truncates incomplete assistant turns from cached events. `MessageCache` calls it after loading from disk on startup. `relay.stop()` flushes pending writes before teardown.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Pure repair function — tests

**Files:**
- Create: `test/unit/relay/cold-cache-repair.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { repairColdSession } from "../../../src/lib/relay/cold-cache-repair.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("repairColdSession", () => {
  it("returns unchanged for empty events", () => {
    const { repaired, changed } = repairColdSession([]);
    expect(repaired).toEqual([]);
    expect(changed).toBe(false);
  });

  it("returns unchanged when last event is done", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "world" },
      { type: "done", code: 0 },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });

  it("returns unchanged when last event is result", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "world" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 1000, sessionId: "s1" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });

  it("returns unchanged when last event is error", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "world" },
      { type: "error", code: "STREAM_ERR", message: "fail" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });

  it("truncates trailing deltas after last done", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "done", code: 0 },
      { type: "user_message", text: "next question" },
      { type: "delta", text: "partial" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual([
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "done", code: 0 },
      { type: "user_message", text: "next question" },
    ]);
    expect(changed).toBe(true);
  });

  it("truncates trailing tool events after last result", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 1000, sessionId: "s1" },
      { type: "user_message", text: "next" },
      { type: "tool_start", id: "t1", name: "Read" },
      { type: "tool_executing", id: "t1", name: "Read", input: undefined },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual([
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 1000, sessionId: "s1" },
      { type: "user_message", text: "next" },
    ]);
    expect(changed).toBe(true);
  });

  it("preserves user_message after terminal but removes streaming events", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "q1" },
      { type: "delta", text: "a1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q2" },
      { type: "delta", text: "partial-a2" },
      { type: "thinking_start" },
      { type: "thinking_delta", text: "hmm" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual([
      { type: "user_message", text: "q1" },
      { type: "delta", text: "a1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q2" },
    ]);
    expect(changed).toBe(true);
  });

  it("keeps only user_messages when no terminal events exist", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "partial" },
      { type: "tool_start", id: "t1", name: "Read" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual([
      { type: "user_message", text: "hello" },
    ]);
    expect(changed).toBe(true);
  });

  it("returns empty when no terminal events and no user_messages", () => {
    const events: RelayMessage[] = [
      { type: "delta", text: "orphan" },
      { type: "thinking_start" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual([]);
    expect(changed).toBe(true);
  });

  it("handles done before result ordering", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "done", code: 0 },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 1000, sessionId: "s1" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });

  it("handles multiple complete turns with no trailing events", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "q1" },
      { type: "delta", text: "a1" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 500, sessionId: "s1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q2" },
      { type: "delta", text: "a2" },
      { type: "result", usage: { input: 15, output: 25, cache_read: 0, cache_creation: 0 }, cost: 0.02, duration: 600, sessionId: "s1" },
      { type: "done", code: 0 },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });

  it("user_message alone (no terminal, no streaming) is preserved", () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "just sent" },
    ];
    const { repaired, changed } = repairColdSession(events);
    expect(repaired).toEqual(events);
    expect(changed).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/cold-cache-repair.test.ts`
Expected: FAIL with "Cannot find module '../../../src/lib/relay/cold-cache-repair.js'"

---

### Task 2: Pure repair function — implementation

**Files:**
- Create: `src/lib/relay/cold-cache-repair.ts`

**Step 1: Implement the repair function**

```typescript
// ─── Cold Cache Repair ───────────────────────────────────────────────────────
// Repairs session event caches loaded from disk after a process restart.
// Removes streaming events from incomplete assistant turns while preserving
// all complete turns and user messages.
//
// Pure function — no I/O, no side effects. Deterministic.

import type { RelayMessage } from "../types.js";

/** Event types that mark a completed assistant turn. */
const TERMINAL_TYPES: ReadonlySet<RelayMessage["type"]> = new Set([
  "done",
  "result",
  "error",
]);

/**
 * Repair a cold session's cached events by removing incomplete assistant turns.
 *
 * Walks the events to find the last terminal event (done/result/error).
 * Keeps everything up to and including that terminal, plus any user_message
 * events after it. Discards streaming events (delta, tool_*, thinking_*)
 * that follow the terminal — these are from an interrupted assistant turn.
 *
 * If no terminal events exist, keeps only user_message events.
 *
 * @returns The repaired events and whether any change was made.
 */
export function repairColdSession(
  events: readonly RelayMessage[],
): { repaired: RelayMessage[]; changed: boolean } {
  if (events.length === 0) {
    return { repaired: [], changed: false };
  }

  // Find last terminal event
  let lastTerminalIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (TERMINAL_TYPES.has(events[i].type)) {
      lastTerminalIdx = i;
      break;
    }
  }

  // If last event is already terminal, cache is complete
  if (lastTerminalIdx === events.length - 1) {
    return { repaired: events as RelayMessage[], changed: false };
  }

  // Build repaired array: everything up to terminal + user_messages after
  const repaired: RelayMessage[] =
    lastTerminalIdx >= 0 ? events.slice(0, lastTerminalIdx + 1) : [];

  // Scan events after the terminal (or from start if no terminal)
  const scanStart = lastTerminalIdx + 1;
  for (let i = scanStart; i < events.length; i++) {
    if (events[i].type === "user_message") {
      repaired.push(events[i]);
    }
  }

  // Determine if anything changed
  const changed = repaired.length !== events.length;

  return { repaired, changed };
}
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/cold-cache-repair.test.ts`
Expected: All 12 tests PASS

**Step 3: Commit**

```bash
git add src/lib/relay/cold-cache-repair.ts test/unit/relay/cold-cache-repair.test.ts
git commit -m "feat: add pure repairColdSession function with tests"
```

---

### Task 3: MessageCache integration — tests

**Files:**
- Modify: `test/unit/relay/message-cache.test.ts`

**Step 1: Add integration tests for repairColdSessions**

Add `statSync` to the existing `node:fs` import at the top of the file.

Append to the existing test file:

```typescript
// ─── repairColdSessions ─────────────────────────────────────────────────────

describe("repairColdSessions", () => {
  it("truncates incomplete turn from loaded JSONL and rewrites file", async () => {
    // Simulate a JSONL file with an incomplete assistant turn
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "done", code: 0 },
      { type: "user_message", text: "next" },
      { type: "delta", text: "partial" }, // incomplete turn
    ];
    const jsonlContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(testDir, "ses_test.jsonl"), jsonlContent);

    const cache = new MessageCache(testDir);
    await cache.loadFromDisk();
    await cache.repairColdSessions();

    // In-memory should be repaired
    const loaded = await cache.getEvents("ses_test");
    expect(loaded).toHaveLength(4); // incomplete delta removed
    expect(loaded![3]).toEqual({ type: "user_message", text: "next" });

    // JSONL file should be rewritten
    const fileContent = readFileSync(join(testDir, "ses_test.jsonl"), "utf8");
    const fileEvents = fileContent.trim().split("\n").map((l) => JSON.parse(l));
    expect(fileEvents).toHaveLength(4);
  });

  it("does not rewrite JSONL for complete sessions", async () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "response" },
      { type: "done", code: 0 },
    ];
    const jsonlContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const filePath = join(testDir, "ses_complete.jsonl");
    writeFileSync(filePath, jsonlContent);
    const mtimeBefore = statSync(filePath).mtimeMs;

    const cache = new MessageCache(testDir);
    await cache.loadFromDisk();
    await cache.repairColdSessions();

    // File should not be touched
    const mtimeAfter = statSync(filePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    const loaded = await cache.getEvents("ses_complete");
    expect(loaded).toHaveLength(3);
  });

  it("repairs session with no terminal events to user_messages only", async () => {
    const events: RelayMessage[] = [
      { type: "user_message", text: "hello" },
      { type: "delta", text: "partial" },
    ];
    const jsonlContent = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(testDir, "ses_no_terminal.jsonl"), jsonlContent);

    const cache = new MessageCache(testDir);
    await cache.loadFromDisk();
    await cache.repairColdSessions();

    // In-memory should be repaired
    const loaded = await cache.getEvents("ses_no_terminal");
    expect(loaded).toHaveLength(1);
    expect(loaded![0]).toEqual({ type: "user_message", text: "hello" });

    // JSONL file should be rewritten with only user_message
    const fileContent = readFileSync(join(testDir, "ses_no_terminal.jsonl"), "utf8");
    const fileEvents = fileContent.trim().split("\n").map((l) => JSON.parse(l));
    expect(fileEvents).toHaveLength(1);
    expect(fileEvents[0]).toEqual({ type: "user_message", text: "hello" });
  });
});
```

**Step 2: Run to verify tests fail**

Run: `pnpm vitest run test/unit/relay/message-cache.test.ts`
Expected: FAIL — `cache.repairColdSessions is not a function`

---

### Task 4: MessageCache integration — implementation

**Files:**
- Modify: `src/lib/relay/message-cache.ts`

**Step 1: Add import and repairColdSessions method**

Add import at top of file:

```typescript
import { repairColdSession } from "./cold-cache-repair.js";
```

Add method to `MessageCache` class, after the `loadFromDisk()` method:

```typescript
/**
 * Repair all sessions loaded from disk by removing incomplete assistant turns.
 * Called once after loadFromDisk() during relay startup.
 *
 * Uses the existing rewriteFile() and flush() mechanisms — no direct I/O.
 */
async repairColdSessions(): Promise<void> {
  let repairedCount = 0;
  for (const [sessionId, session] of this.sessions) {
    const { repaired, changed } = repairColdSession(session.events);
    if (changed) {
      session.events = repaired;
      // Recalculate approx bytes from repaired events
      session.approxBytes = repaired.reduce(
        (sum, e) => sum + JSON.stringify(e).length * 2,
        0,
      );
      this.rewriteFile(sessionId, repaired);
      repairedCount++;
    }
  }
  if (repairedCount > 0) {
    await this.flush();
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/message-cache.test.ts`
Expected: All tests PASS (existing + new)

**Step 3: Commit**

```bash
git add src/lib/relay/message-cache.ts src/lib/relay/cold-cache-repair.ts test/unit/relay/message-cache.test.ts
git commit -m "feat: integrate cold cache repair into MessageCache startup"
```

---

### Task 5: Relay stack wiring — repair on startup + flush on stop

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

**Step 1: Add repair call after loadFromDisk()**

In `createProjectRelay()`, change:

```typescript
await messageCache.loadFromDisk();
```

to:

```typescript
await messageCache.loadFromDisk();
await messageCache.repairColdSessions();
```

This is at approximately line 172.

**Step 2: Reorder stop() — disconnect event sources first, then flush**

In the `stop()` method of the returned `ProjectRelay` object, reorder to
stop event sources before flushing, ensuring no new events arrive after
the final flush:

```typescript
async stop() {
    // 1. Stop event sources (prevents new events from being cached)
    await sseConsumer.disconnect();
    pollerManager.stopAll();
    statusPoller.stop();
    // 2. Flush all pending cache writes to disk
    await messageCache.flush();
    // 3. Clean up remaining resources
    clearInterval(timeoutTimer);
    clearInterval(rateLimitCleanupTimer);
    overrides.dispose();
    ptyManager.closeAll();
    wsHandler.close();
},
```

**Step 3: Run full verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass. The type checker confirms the new method exists on
MessageCache. Existing tests remain green.

**Step 4: Commit**

```bash
git add src/lib/relay/relay-stack.ts
git commit -m "fix: repair cold cache on startup and flush on graceful stop"
```

---

### Task 6: Regression tests — staleness check catches repaired cache

**Files:**
- Modify: `test/unit/session/session-switch.test.ts`

**Step 1: Add regression tests**

Add tests that verify the end-to-end scenarios: after repair, the staleness
check correctly detects missing turns and falls back to REST. Also tests
the edge case where repair removes all streaming events and the case where
repair doesn't change the staleness outcome.

Note: all `result` events must include full `UsageInfo` fields
(`cache_read`, `cache_creation`) to pass type checking.

```typescript
describe("resolveSessionHistory — repaired cold cache regression", () => {
  it("falls back to REST when repair removed an incomplete assistant turn", async () => {
    // After repair: 2 complete turns + 1 user_message with no response
    // countUniqueMessages: 3 user_messages + 2 messageIds = 5
    // REST has: 3 user + 3 assistant = 6 messages (the 3rd assistant was truncated)
    const repairedEvents: RelayMessage[] = [
      { type: "user_message", text: "q1" },
      { type: "delta", text: "a1", messageId: "msg_1" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 500, sessionId: "s1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q2" },
      { type: "delta", text: "a2", messageId: "msg_2" },
      { type: "result", usage: { input: 15, output: 25, cache_read: 0, cache_creation: 0 }, cost: 0.02, duration: 600, sessionId: "s1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q3" },
      // repair removed: delta "partial-a3" with messageId "msg_3"
    ];

    const deps: Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "client"> = {
      messageCache: {
        getEvents: vi.fn().mockResolvedValue(repairedEvents),
      },
      client: {
        getMessages: vi.fn().mockResolvedValue([]),
        getMessageCount: vi.fn().mockResolvedValue(6),
      },
      sessionMgr: {
        loadPreRenderedHistory: vi.fn().mockResolvedValue({
          messages: [{ id: "m1", role: "user" as const, parts: [] }],
          hasMore: false,
        }),
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const source = await resolveSessionHistory("ses_repaired", deps);

    // countUniqueMessages: 3 user_messages + 2 messageIds (msg_1, msg_2) = 5
    // actualCount: 6
    // 5 < 6 → stale → falls back to REST
    expect(source.kind).toBe("rest-history");
  });

  it("falls back to REST when repair removed ALL streaming events (only user_messages remain)", async () => {
    // Scenario: first assistant turn was interrupted before any terminal event.
    // Repair keeps only user_messages.
    // countUniqueMessages: 2 user_messages + 0 messageIds = 2
    // REST has: 2 user + 2 assistant = 4 messages
    const repairedEvents: RelayMessage[] = [
      { type: "user_message", text: "q1" },
      // repair removed: delta "partial-a1" (no terminal ever arrived)
      { type: "user_message", text: "q2" },
      // repair removed: delta "partial-a2"
    ];

    const deps: Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "client"> = {
      messageCache: {
        getEvents: vi.fn().mockResolvedValue(repairedEvents),
      },
      client: {
        getMessages: vi.fn().mockResolvedValue([]),
        getMessageCount: vi.fn().mockResolvedValue(4),
      },
      sessionMgr: {
        loadPreRenderedHistory: vi.fn().mockResolvedValue({
          messages: [{ id: "m1", role: "user" as const, parts: [] }],
          hasMore: false,
        }),
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const source = await resolveSessionHistory("ses_all_removed", deps);

    // countUniqueMessages: 2, actualCount: 4 → 2 < 4 → REST fallback
    expect(source.kind).toBe("rest-history");
  });

  it("serves cache when repair removed events without messageId (staleness check still passes)", async () => {
    // Scenario: incomplete turn's deltas had no messageId. Repair removes them
    // but the count doesn't change because they weren't counted anyway.
    // This is the "safe" case — the removed events didn't contribute to the count.
    const repairedEvents: RelayMessage[] = [
      { type: "user_message", text: "q1" },
      { type: "delta", text: "a1", messageId: "msg_1" },
      { type: "result", usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 }, cost: 0.01, duration: 500, sessionId: "s1" },
      { type: "done", code: 0 },
      { type: "user_message", text: "q2" },
      // repair removed: delta without messageId — these don't affect countUniqueMessages
    ];

    const deps: Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log" | "client"> = {
      messageCache: {
        getEvents: vi.fn().mockResolvedValue(repairedEvents),
      },
      client: {
        getMessages: vi.fn().mockResolvedValue([]),
        // REST has 2 user + 1 assistant (complete) + 1 assistant (was incomplete, removed by repair)
        // But the incomplete assistant message is still being processed by OpenCode
        // and hasn't appeared in the REST message list yet (edge case: crash mid-stream
        // before the message was even persisted in OpenCode).
        // In this case, REST reports 3 messages, cache has 3: staleness check passes.
        getMessageCount: vi.fn().mockResolvedValue(3),
      },
      sessionMgr: {
        loadPreRenderedHistory: vi.fn().mockResolvedValue({
          messages: [],
          hasMore: false,
        }),
      },
      log: { info: vi.fn(), warn: vi.fn() },
    };

    const source = await resolveSessionHistory("ses_safe_pass", deps);

    // countUniqueMessages: 2 user_messages + 1 messageId (msg_1) = 3
    // actualCount: 3
    // 3 >= 3 → passes → serves cache (this is correct — the incomplete data was removed)
    expect(source.kind).toBe("cached-events");
  });
});
```

**Step 2: Run to verify tests pass**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add test/unit/session/session-switch.test.ts
git commit -m "test: add regression tests for cold cache repair triggering REST fallback"
```

---

### Task 7: Final verification

**Step 1: Run full verification suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass with zero new warnings.

**Step 2: Verify no existing tests broke**

Run: `pnpm vitest run test/unit/relay/cache-replay-contract.test.ts test/unit/relay/regression-server-cache-pipeline.test.ts`
Expected: PASS — these cache-related tests should be unaffected since the repair only runs on startup, not during live operation.
