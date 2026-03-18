# Event Pipeline Debuggability v2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate remaining debuggability and testability problems found in the architecture audit — duplicate side-effect code, untestable status transitions, scattered session resolution, dead code, and silent error swallowing.

**Architecture:** Extract shared functions from copy-pasted patterns. Extract status transition logic into a pure function. Consolidate session resolution into a single helper. Delete dead code. Add `warn()` logging to silent catch blocks.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Extract `applyPipelineResult` — eliminate 3× copy-paste

The `PipelineResult` side-effect application is duplicated at 3 call sites with identical (or subset) logic. Extract into a single function.

**Files:**
- Modify: `src/lib/relay/event-pipeline.ts` — add `applyPipelineResult` and `PipelineDeps` type
- Modify: `src/lib/relay/sse-wiring.ts:261-288` — replace inline side-effects with `applyPipelineResult` call
- Modify: `src/lib/relay/relay-stack.ts:604-618` — replace status poller done side-effects
- Modify: `src/lib/relay/relay-stack.ts:696-721` — replace poller events side-effects
- Modify: `test/unit/relay/event-pipeline.test.ts` — add tests for `applyPipelineResult`

**Step 1: Add `PipelineDeps` and `applyPipelineResult` to `event-pipeline.ts`**

Add after the `processEvent` function:

```typescript
/** Dependencies for applying pipeline side effects. */
export interface PipelineDeps {
  toolContentStore: { store(id: string, content: string, sessionId: string): void };
  overrides: {
    clearProcessingTimeout(sessionId: string): void;
    resetProcessingTimeout(sessionId: string): void;
  };
  messageCache: { recordEvent(sessionId: string, msg: RelayMessage): void };
  wsHandler: { sendToSession(sessionId: string, msg: RelayMessage): void };
  log: (...args: unknown[]) => void;
}

/**
 * Apply pipeline side effects based on PipelineResult decisions.
 * This is the single place where pipeline decisions become actions.
 */
export function applyPipelineResult(
  result: PipelineResult,
  sessionId: string | undefined,
  deps: PipelineDeps,
): void {
  if (result.fullContent !== undefined && sessionId) {
    deps.toolContentStore.store(
      (result.msg as { id: string }).id,
      result.fullContent,
      sessionId,
    );
  }
  if (result.timeout === "clear" && sessionId) {
    deps.overrides.clearProcessingTimeout(sessionId);
  } else if (result.timeout === "reset" && sessionId) {
    deps.overrides.resetProcessingTimeout(sessionId);
  }
  if (result.cache && sessionId) {
    deps.messageCache.recordEvent(sessionId, result.msg);
  }
  if (result.route.action === "send") {
    deps.wsHandler.sendToSession(result.route.sessionId, result.msg);
  } else {
    deps.log(`   [pipeline] ${result.route.reason} — ${result.msg.type}`);
  }
}
```

**Step 2: Add tests for `applyPipelineResult` in `test/unit/relay/event-pipeline.test.ts`**

Add a new describe block:

```typescript
import { applyPipelineResult, type PipelineDeps, type PipelineResult } from "...";

describe("applyPipelineResult", () => {
  function mockDeps(): PipelineDeps {
    return {
      toolContentStore: { store: vi.fn() },
      overrides: { clearProcessingTimeout: vi.fn(), resetProcessingTimeout: vi.fn() },
      messageCache: { recordEvent: vi.fn() },
      wsHandler: { sendToSession: vi.fn() },
      log: vi.fn(),
    };
  }

  it("stores full content when truncated", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "tool_result", id: "t1", content: "short", is_error: false },
      fullContent: "very long content",
      route: { action: "send", sessionId: "s1" },
      cache: true,
      timeout: "reset",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.toolContentStore.store).toHaveBeenCalledWith("t1", "very long content", "s1");
  });

  it("clears timeout for done events", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "done", code: 0 },
      fullContent: undefined,
      route: { action: "send", sessionId: "s1" },
      cache: true,
      timeout: "clear",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith("s1");
    expect(deps.overrides.resetProcessingTimeout).not.toHaveBeenCalled();
  });

  it("resets timeout for normal events", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "delta", text: "hi" },
      fullContent: undefined,
      route: { action: "send", sessionId: "s1" },
      cache: true,
      timeout: "reset",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledWith("s1");
  });

  it("caches cacheable events", () => {
    const deps = mockDeps();
    const msg = { type: "delta" as const, text: "hi" };
    const result: PipelineResult = {
      msg, fullContent: undefined,
      route: { action: "send", sessionId: "s1" },
      cache: true, timeout: "reset",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.messageCache.recordEvent).toHaveBeenCalledWith("s1", msg);
  });

  it("does not cache non-cacheable events", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "file_changed", path: "x", changeType: "edited" },
      fullContent: undefined,
      route: { action: "send", sessionId: "s1" },
      cache: false, timeout: "reset",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
  });

  it("sends to session when route is send", () => {
    const deps = mockDeps();
    const msg = { type: "delta" as const, text: "hi" };
    const result: PipelineResult = {
      msg, fullContent: undefined,
      route: { action: "send", sessionId: "s1" },
      cache: true, timeout: "reset",
    };
    applyPipelineResult(result, "s1", deps);
    expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("s1", msg);
  });

  it("logs drop reason when route is drop", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "delta", text: "hi" },
      fullContent: undefined,
      route: { action: "drop", reason: "no viewers" },
      cache: false, timeout: "none",
    };
    applyPipelineResult(result, undefined, deps);
    expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  it("skips fullContent store when no sessionId", () => {
    const deps = mockDeps();
    const result: PipelineResult = {
      msg: { type: "tool_result", id: "t1", content: "x", is_error: false },
      fullContent: "full",
      route: { action: "drop", reason: "no session ID" },
      cache: false, timeout: "none",
    };
    applyPipelineResult(result, undefined, deps);
    expect(deps.toolContentStore.store).not.toHaveBeenCalled();
  });
});
```

**Step 3: Replace the 3 call sites**

In `sse-wiring.ts`, replace lines 261-288 with:
```typescript
const viewers = targetSessionId
  ? wsHandler.getClientsForSession(targetSessionId)
  : [];
const pipeResult = processEvent(msg, targetSessionId, viewers);
msg = pipeResult.msg;
applyPipelineResult(pipeResult, targetSessionId, {
  toolContentStore, overrides, messageCache, wsHandler, log,
});
```

In `relay-stack.ts` status poller done (lines 604-618), replace with:
```typescript
const doneViewers = wsHandler.getClientsForSession(sessionId);
const doneResult = processEvent({ type: "done", code: 0 }, sessionId, doneViewers);
applyPipelineResult(doneResult, sessionId, pipelineDeps);
```

Where `pipelineDeps` is defined once near the top of the relay wiring:
```typescript
const pipelineDeps: PipelineDeps = { toolContentStore, overrides, messageCache, wsHandler, log };
```

In `relay-stack.ts` poller events handler (lines 696-721), replace the for-loop body with:
```typescript
for (const msg of events) {
  const pollerViewers = polledSessionId
    ? wsHandler.getClientsForSession(polledSessionId) : [];
  const pollerResult = processEvent(msg, polledSessionId, pollerViewers);
  applyPipelineResult(pollerResult, polledSessionId, pipelineDeps);
}
```

**Step 4: Run tests**

```bash
pnpm vitest test/unit/relay/event-pipeline.test.ts --run
pnpm vitest test/unit/relay/sse-wiring.test.ts --run
pnpm test:unit
```

---

### Task 2: Extract `computeStatusTransitions` — make status logic testable

Extract the 100-line status poller "changed" handler from relay-stack.ts into a pure function that returns transition decisions.

**Files:**
- Create: `src/lib/relay/status-transitions.ts`
- Create: `test/unit/relay/status-transitions.test.ts`
- Modify: `src/lib/relay/relay-stack.ts:569-669` — call the extracted function

**Step 1: Create `src/lib/relay/status-transitions.ts`**

```typescript
// ─── Status Transition Detection ─────────────────────────────────────────────
// Pure function that computes session status transitions (idle↔busy).
// Extracted from relay-stack.ts for testability.

import type { SessionStatus } from "../instance/opencode-client.js";

export interface StatusTransitions {
  /** Sessions that just became busy (need "processing" status sent). */
  becameBusy: string[];
  /** Sessions that just became idle (need "done" sent through pipeline). */
  becameIdle: string[];
  /** Updated set of busy sessions (replaces previousBusy). */
  currentBusy: Set<string>;
}

/**
 * Compare previous busy sessions with current statuses to detect transitions.
 */
export function computeStatusTransitions(
  previousBusy: ReadonlySet<string>,
  statuses: Record<string, SessionStatus | undefined>,
): StatusTransitions {
  const currentBusy = new Set<string>();
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (status?.type === "busy" || status?.type === "retry") {
      currentBusy.add(sessionId);
    }
  }

  const becameBusy: string[] = [];
  for (const sessionId of currentBusy) {
    if (!previousBusy.has(sessionId)) {
      becameBusy.push(sessionId);
    }
  }

  const becameIdle: string[] = [];
  for (const sessionId of previousBusy) {
    if (!currentBusy.has(sessionId)) {
      becameIdle.push(sessionId);
    }
  }

  return { becameBusy, becameIdle, currentBusy };
}

export interface PollerDecision {
  /** Pollers to stop (session went idle, no viewers). */
  toStop: string[];
  /** Pollers to clear activity only (session went idle, has viewers). */
  toClearActivity: string[];
  /** Sessions that need a new poller started. */
  toStart: string[];
}

/**
 * Decide which pollers to start/stop based on current statuses.
 */
export function computePollerDecisions(
  statuses: Record<string, SessionStatus | undefined>,
  pollingSessionIds: string[],
  hasViewers: (sessionId: string) => boolean,
  isPolling: (sessionId: string) => boolean,
): PollerDecision {
  const toStop: string[] = [];
  const toClearActivity: string[] = [];
  const toStart: string[] = [];

  for (const polledId of pollingSessionIds) {
    const status = statuses[polledId];
    const isBusy = status?.type === "busy" || status?.type === "retry";
    if (!isBusy) {
      if (hasViewers(polledId)) {
        toClearActivity.push(polledId);
      } else {
        toStop.push(polledId);
      }
    }
  }

  for (const [sessionId, status] of Object.entries(statuses)) {
    const isBusy = status?.type === "busy" || status?.type === "retry";
    if (isBusy && !isPolling(sessionId)) {
      toStart.push(sessionId);
    }
  }

  return { toStop, toClearActivity, toStart };
}
```

**Step 2: Create `test/unit/relay/status-transitions.test.ts`**

```typescript
import { describe, expect, it } from "vitest";
import {
  computeStatusTransitions,
  computePollerDecisions,
} from "../../../src/lib/relay/status-transitions.js";

describe("computeStatusTransitions", () => {
  it("detects newly busy sessions", () => {
    const result = computeStatusTransitions(
      new Set(),
      { s1: { type: "busy" }, s2: { type: "idle" } },
    );
    expect(result.becameBusy).toEqual(["s1"]);
    expect(result.becameIdle).toEqual([]);
  });

  it("detects sessions that became idle", () => {
    const result = computeStatusTransitions(
      new Set(["s1", "s2"]),
      { s1: { type: "idle" }, s2: { type: "busy" } },
    );
    expect(result.becameBusy).toEqual([]);
    expect(result.becameIdle).toEqual(["s1"]);
  });

  it("treats retry as busy", () => {
    const result = computeStatusTransitions(
      new Set(),
      { s1: { type: "retry" } },
    );
    expect(result.becameBusy).toEqual(["s1"]);
    expect(result.currentBusy.has("s1")).toBe(true);
  });

  it("no transitions when nothing changed", () => {
    const result = computeStatusTransitions(
      new Set(["s1"]),
      { s1: { type: "busy" } },
    );
    expect(result.becameBusy).toEqual([]);
    expect(result.becameIdle).toEqual([]);
  });

  it("handles empty statuses", () => {
    const result = computeStatusTransitions(new Set(["s1"]), {});
    expect(result.becameIdle).toEqual(["s1"]);
    expect(result.currentBusy.size).toBe(0);
  });

  it("handles undefined status values", () => {
    const result = computeStatusTransitions(
      new Set(),
      { s1: undefined },
    );
    expect(result.becameBusy).toEqual([]);
  });
});

describe("computePollerDecisions", () => {
  it("stops pollers for idle sessions without viewers", () => {
    const result = computePollerDecisions(
      { s1: { type: "idle" } },
      ["s1"],
      () => false,
      () => true,
    );
    expect(result.toStop).toEqual(["s1"]);
    expect(result.toClearActivity).toEqual([]);
  });

  it("clears activity for idle sessions WITH viewers", () => {
    const result = computePollerDecisions(
      { s1: { type: "idle" } },
      ["s1"],
      (sid) => sid === "s1",
      () => true,
    );
    expect(result.toStop).toEqual([]);
    expect(result.toClearActivity).toEqual(["s1"]);
  });

  it("starts pollers for busy sessions not yet polling", () => {
    const result = computePollerDecisions(
      { s1: { type: "busy" }, s2: { type: "busy" } },
      [],
      () => false,
      () => false,
    );
    expect(result.toStart.sort()).toEqual(["s1", "s2"]);
  });

  it("does not start poller for session already polling", () => {
    const result = computePollerDecisions(
      { s1: { type: "busy" } },
      ["s1"],
      () => false,
      (sid) => sid === "s1",
    );
    expect(result.toStart).toEqual([]);
  });
});
```

**Step 3: Update `relay-stack.ts` to use extracted functions**

Import and replace the "changed" handler body (lines 582-669) with calls to the pure functions, keeping only the side-effect execution in the closure:

```typescript
import { computeStatusTransitions, computePollerDecisions } from "./status-transitions.js";

// ... in the statusPoller.on("changed") handler:

const transitions = computeStatusTransitions(previousBusySessions, statuses);

// Sessions that just became busy → send processing status
for (const sessionId of transitions.becameBusy) {
  wsHandler.sendToSession(sessionId, { type: "status", status: "processing" });
}

// Sessions that just became idle → send done through pipeline
for (const sessionId of transitions.becameIdle) {
  const doneViewers = wsHandler.getClientsForSession(sessionId);
  const doneResult = processEvent({ type: "done", code: 0 }, sessionId, doneViewers);
  applyPipelineResult(doneResult, sessionId, pipelineDeps);
}

previousBusySessions = transitions.currentBusy;

// Poller lifecycle
const pollerDecisions = computePollerDecisions(
  statuses,
  pollerManager.getPollingSessionIds(),
  (sid) => pollerManager.hasViewers(sid),
  (sid) => pollerManager.isPolling(sid),
);

for (const polledId of pollerDecisions.toClearActivity) {
  statusPoller.clearMessageActivity(polledId);
}
for (const polledId of pollerDecisions.toStop) {
  pollerManager.emitDone(polledId);
  pollerManager.stopPolling(polledId);
  statusPoller.clearMessageActivity(polledId);
  overrides.clearProcessingTimeout(polledId);
}
for (const sessionId of pollerDecisions.toStart) {
  client
    .getMessages(sessionId)
    .then((msgs) => pollerManager.startPolling(sessionId, msgs))
    .catch((err) =>
      log(`   [status-poller] Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`),
    );
}
```

**Step 4: Run tests**

```bash
pnpm vitest test/unit/relay/status-transitions.test.ts --run
pnpm test:unit
```

---

### Task 3: Deduplicate CACHEABLE_TYPES

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts` — delete `CACHEABLE_TYPES` and `isCacheable`, import `shouldCache` from event-pipeline
- Modify: `test/unit/relay/sse-wiring.test.ts` — update `isCacheable` tests to test `shouldCache` from event-pipeline
- Modify: `test/unit/relay/regression-server-cache-pipeline.test.ts` — import `shouldCache` instead of inline set

**Step 1: Delete from sse-wiring.ts**

Remove lines 50-73 (the `CACHEABLE_TYPES` set, `isCacheable` function, and the comment block above them).

**Step 2: Update sse-wiring.test.ts**

Change import and test:
```typescript
// Before:
import { isCacheable } from "../../../src/lib/relay/sse-wiring.js";
describe("isCacheable", () => { ... });

// After:
import { shouldCache } from "../../../src/lib/relay/event-pipeline.js";
describe("shouldCache", () => {
  // same tests but call shouldCache(type) instead of isCacheable({ type })
});
```

**Step 3: Update regression test**

Replace the inline `CACHEABLE_TYPES` set (lines 33-46) with:
```typescript
import { shouldCache } from "../../../src/lib/relay/event-pipeline.js";
// In processEvent function:
if (recordId && shouldCache(msg.type)) {
```

**Step 4: Run tests**

```bash
pnpm vitest test/unit/relay/sse-wiring.test.ts --run
pnpm vitest test/unit/relay/regression-server-cache-pipeline.test.ts --run
pnpm test:unit
```

---

### Task 4: Extract `resolveSession` helper — eliminate 14× fallback pattern

**Files:**
- Create: `src/lib/handlers/resolve-session.ts`
- Create: `test/unit/handlers/resolve-session.test.ts`
- Modify: All handler files that use the `getClientSession ?? getActiveSessionId` pattern

**Step 1: Create `src/lib/handlers/resolve-session.ts`**

```typescript
// ─── Session Resolution ──────────────────────────────────────────────────────
// Single helper for resolving which session a client message targets.
// Replaces the scattered `getClientSession(clientId) ?? getActiveSessionId()`
// pattern that appears 14 times across handler files.

import type { HandlerDeps } from "./types.js";

/**
 * Resolve the session ID for a client's message.
 * Prefers the per-client session (from SessionRegistry via wsHandler),
 * falls back to the global active session (from SessionManager).
 */
export function resolveSession(deps: HandlerDeps, clientId: string): string | undefined {
  return (
    deps.wsHandler.getClientSession(clientId) ??
    deps.sessionMgr.getActiveSessionId()
  );
}

/**
 * Resolve session for logging contexts where undefined should display as "?".
 */
export function resolveSessionForLog(deps: HandlerDeps, clientId: string): string {
  return resolveSession(deps, clientId) ?? "?";
}
```

**Step 2: Create test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { resolveSession, resolveSessionForLog } from "../../../src/lib/handlers/resolve-session.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("resolveSession", () => {
  it("returns client session when available", () => {
    const deps = createMockHandlerDeps();
    vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses_client");
    expect(resolveSession(deps, "c1")).toBe("ses_client");
  });

  it("falls back to active session when client has none", () => {
    const deps = createMockHandlerDeps();
    vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
    vi.mocked(deps.sessionMgr.getActiveSessionId).mockReturnValue("ses_active");
    expect(resolveSession(deps, "c1")).toBe("ses_active");
  });

  it("returns undefined when neither exists", () => {
    const deps = createMockHandlerDeps();
    vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
    vi.mocked(deps.sessionMgr.getActiveSessionId).mockReturnValue(null);
    expect(resolveSession(deps, "c1")).toBeUndefined();
  });
});

describe("resolveSessionForLog", () => {
  it("returns '?' when no session", () => {
    const deps = createMockHandlerDeps();
    vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
    vi.mocked(deps.sessionMgr.getActiveSessionId).mockReturnValue(null);
    expect(resolveSessionForLog(deps, "c1")).toBe("?");
  });
});
```

**Step 3: Replace all 14 call sites**

In each file, add `import { resolveSession } from "./resolve-session.js"` (or `resolveSessionForLog` for logging contexts), then replace:

```typescript
// Before:
const activeId = deps.wsHandler.getClientSession(clientId) ?? deps.sessionMgr.getActiveSessionId();

// After:
const activeId = resolveSession(deps, clientId);
```

For logging-only uses (where `?? "?"` follows):
```typescript
// Before:
const sid = deps.wsHandler.getClientSession(clientId) ?? deps.sessionMgr.getActiveSessionId() ?? "?";

// After:
const sid = resolveSessionForLog(deps, clientId);
```

Files to update:
- `src/lib/handlers/prompt.ts` — 3 locations (lines 13-15, 90-91, 114-115)
- `src/lib/handlers/model.ts` — 3 locations (lines 36-37, 102, 135-136)
- `src/lib/handlers/session.ts` — 2 locations (lines 252-253, 276-277)
- `src/lib/handlers/permissions.ts` — 3 locations (lines 18-19, 66-67, 130-131)
- `src/lib/handlers/terminal.ts` — 1 location (lines 11-12)
- `src/lib/handlers/index.ts` — 1 location (line 194)
- `src/lib/handlers/agent.ts` — 1 location (line 76)

**Step 4: Run tests**

```bash
pnpm vitest test/unit/handlers/resolve-session.test.ts --run
pnpm test:unit
```

---

### Task 5: Delete dead QuestionBridge class

The `QuestionBridge` class is dead production code (replaced by direct API calls). The standalone `mapQuestionFields` function IS used. The 500-line test file tests only the dead class.

**Files:**
- Modify: `src/lib/bridges/question-bridge.ts` — remove `QuestionBridge` class, keep `mapQuestionFields` and `convertAnswers`
- Delete: `test/unit/bridges/question-bridge.pbt.test.ts` — tests for dead class

**Step 1: Check what to keep**

Keep exports: `mapQuestionFields`, `convertAnswers`, `QuestionBridgeOptions` (if `mapQuestionFields` uses it — check).

Actually, `mapQuestionFields` is a standalone function that doesn't depend on the class. `convertAnswers` is only used inside the class. So:
- Keep: `mapQuestionFields`
- Delete: `QuestionBridge` class, `QuestionBridgeOptions` interface, `PendingQuestion` interface, `convertAnswers` function
- Delete: `test/unit/bridges/question-bridge.pbt.test.ts`

But first verify `convertAnswers` isn't imported elsewhere. If it is, keep it.

**Step 2: Run tests**

```bash
pnpm test:unit
```

---

### Task 6: Add logging to silent catch blocks

Add `deps.log()` or `log()` calls to the 10 silent catch blocks. Don't change control flow — just make failures visible.

**Files:**
- Modify: `src/lib/handlers/session.ts` — 4 locations (lines 48, 66, 107, 142)
- Modify: `src/lib/handlers/model.ts` — 1 location (line 158)
- Modify: `src/lib/relay/relay-stack.ts` — 2 locations (lines 330, 1033)
- Modify: `src/lib/session/session-manager.ts` — 1 location (line 279)

**Pattern:**

```typescript
// Before:
} catch {
  /* non-fatal */
}

// After:
} catch (err) {
  deps.log(`   [session] Failed to load history: ${err instanceof Error ? err.message : err}`);
}
```

For relay-stack.ts line 330:
```typescript
} catch (err) {
  log(`   [relay] Config API unavailable: ${err instanceof Error ? err.message : err}`);
}
```

For relay-stack.ts line 1033 (shutdown):
```typescript
} catch (err) {
  // Best-effort shutdown — log but don't fail
  console.error(`[relay] Error stopping relay: ${err instanceof Error ? err.message : err}`);
}
```

For session-manager.ts line 279:
```typescript
} catch (err) {
  this.log?.(`   [session] Failed to fetch messages for sort: ${err instanceof Error ? err.message : err}`);
}
```

**Step 1: Apply all changes**
**Step 2: Run tests**

```bash
pnpm test:unit
```

---

## Parallelization

- **Wave 1 (parallel)**: Tasks 1, 2, 4 — zero file overlap
- **Wave 2**: Task 3 — depends on Task 1 (imports from event-pipeline.ts)
- **Wave 3**: Tasks 5, 6 — independent cleanup, can run in parallel

Task 1 and 2 share `relay-stack.ts` but modify different sections (Task 1: pipeline call sites; Task 2: status poller handler). They should merge cleanly.
