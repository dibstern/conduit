# Testability & Error-Prevention Refactoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate unsafe casts, remove duplicated logic, and decompose god objects to make the codebase more testable and harder to accidentally break.

**Architecture:** Five independent PRs (1–4 can land in any order; PR 5 depends on PR 2). Each PR is self-contained with its own tests and verification.

**Tech Stack:** TypeScript (strict mode), Vitest, Svelte 5, Node.js

**Design doc:** `docs/plans/2026-03-06-testability-refactoring-design.md`

---

## PR 1: Unsafe Error Catching → `formatErrorDetail()`

Replace 28 `(err as Error).message` casts with the existing safe `formatErrorDetail(err)` from `src/lib/errors.ts`.

---

### Task 1.1: Replace casts in `daemon.ts`

**Files:**
- Modify: `src/lib/daemon.ts` (lines 5, 291, 338, 353, 639, 719, 1038)

**Step 1: Add import**

Add `formatErrorDetail` to the imports. It lives in `./errors.js`. Add this line after the existing imports (around line 48):

```typescript
import { formatErrorDetail } from "./errors.js";
```

**Step 2: Replace all 6 casts**

| Line | Before | After |
|------|--------|-------|
| 291 | `(err as Error).message` | `formatErrorDetail(err)` |
| 338 | `(err as Error).message` | `formatErrorDetail(err)` |
| 353 | `(err as Error).message` | `formatErrorDetail(err)` |
| 639 | `(err as Error).message` | `formatErrorDetail(err)` |
| 719 | `(err as Error).message` | `formatErrorDetail(err)` |
| 1038 | `(err as Error).message` | `formatErrorDetail(err)` |

**Step 3: Run tests**

Run: `pnpm test:unit`
Expected: All pass

**Step 4: Commit**

```bash
git add src/lib/daemon.ts
git commit -m "refactor: replace unsafe error casts with formatErrorDetail in daemon.ts"
```

---

### Task 1.2: Replace casts in `daemon-ipc.ts`

**Files:**
- Modify: `src/lib/daemon-ipc.ts` (lines 6, 122, 131, 227, 237, 246, 255, 279)

**Step 1: Add import**

```typescript
import { formatErrorDetail } from "./errors.js";
```

**Step 2: Replace all 7 casts**

Each is `{ ok: false, error: (err as Error).message }` → `{ ok: false, error: formatErrorDetail(err) }` at lines 122, 131, 227, 237, 246, 255, 279.

**Step 3: Run tests**

Run: `pnpm test:unit`
Expected: All pass

**Step 4: Commit**

```bash
git add src/lib/daemon-ipc.ts
git commit -m "refactor: replace unsafe error casts with formatErrorDetail in daemon-ipc.ts"
```

---

### Task 1.3: Replace casts in `handlers/instance.ts`

**Files:**
- Modify: `src/lib/handlers/instance.ts` (lines 6, 80, 107, 133, 159, 201, 243)

**Step 1: Add import**

```typescript
import { formatErrorDetail } from "../errors.js";
```

**Step 2: Replace all 6 casts**

Each is `sendError(deps, clientId, (err as Error).message)` → `sendError(deps, clientId, formatErrorDetail(err))` at lines 80, 107, 133, 159, 201, 243.

**Step 3: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/handlers/instance.ts
git commit -m "refactor: replace unsafe error casts with formatErrorDetail in instance handlers"
```

---

### Task 1.4: Replace casts in remaining 5 files

**Files:**
- Modify: `src/lib/instance-manager.ts` (line 562) — import from `./errors.js`
- Modify: `src/lib/message-cache.ts` (lines 241, 252) — import from `./errors.js`
- Modify: `src/bin/cli-core.ts` (lines 201, 615) — import from `../lib/errors.js`
- Modify: `src/bin/cli-commands.ts` (line 66) — import from `../lib/errors.js`
- Modify: `src/lib/sse-backoff.ts` (lines 198, 244, 297) — import from `./errors.js`

**Step 1: Add imports to each file**

**Step 2: Replace casts**

`instance-manager.ts:562`:
```
Before: error: `Restart failed: ${(err as Error).message}`
After:  error: `Restart failed: ${formatErrorDetail(err)}`
```

`message-cache.ts:241,252`:
```
Before: { ok: false, error: (err as Error).message }
After:  { ok: false, error: formatErrorDetail(err) }
```

`cli-core.ts:201`:
```
Before: stderr.write(`Failed to stop daemon: ${(err as Error).message}\n`)
After:  stderr.write(`Failed to stop daemon: ${formatErrorDetail(err)}\n`)
```

`cli-core.ts:615`:
```
Before: const message = (err as Error).message;
After:  const message = formatErrorDetail(err);
```

`cli-commands.ts:66`:
```
Before: const message = (err as Error).message;
After:  const message = formatErrorDetail(err);
```

`sse-backoff.ts:198,244,297`:
```
Before: { ok: false, error: `JSON parse error: ${(e as Error).message}` }
After:  { ok: false, error: `JSON parse error: ${formatErrorDetail(e)}` }
```

**Step 3: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/instance-manager.ts src/lib/message-cache.ts src/bin/cli-core.ts src/bin/cli-commands.ts src/lib/sse-backoff.ts
git commit -m "refactor: replace remaining unsafe error casts with formatErrorDetail"
```

---

### Task 1.5: Verify zero `as Error` casts remain

**Step 1: Search for remaining casts**

Run: `grep -rn "as Error)" src/ --include="*.ts" | grep -v node_modules | grep -v ".d.ts"`

Expected: Zero results (or only the `ws-router.ts:162` type guard which is `as ErrorResult`, not `as Error`).

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass

---

## PR 2: Frontend Store Type Safety

---

### Task 2.1: Remove redundant casts in `handleThinkingDelta` and `handleThinkingStop`

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts`

**Step 1: Fix `handleThinkingDelta` (lines 122–128)**

The `if (m.type === "thinking")` check already narrows `m` to `ThinkingMessage`. Remove redundant casts.

Before:
```typescript
if (m.type === "thinking" && !(m as ThinkingMessage).done) {
    messages[i] = {
        ...(m as ThinkingMessage),
        text: (m as ThinkingMessage).text + text,
    };
```

After:
```typescript
if (m.type === "thinking" && !m.done) {
    messages[i] = {
        ...m,
        text: m.text + text,
    };
```

**Step 2: Fix `handleThinkingStop` (lines 144–146)**

Before:
```typescript
if (m.type === "thinking" && !(m as ThinkingMessage).done) {
    messages[i] = {
        ...(m as ThinkingMessage),
```

After:
```typescript
if (m.type === "thinking" && !m.done) {
    messages[i] = {
        ...m,
```

**Step 3: Run tests**

Run: `pnpm test:unit`
Expected: All pass — if it compiles, the narrowing is correct.

**Step 4: Commit**

```bash
git add src/lib/public/stores/chat.svelte.ts
git commit -m "refactor: remove redundant thinking message casts in chat store"
```

---

### Task 2.2: Remove redundant casts in assistant/user message patterns

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts`

**Step 1: Fix `handleToolStart` (lines 179–181)**

After `m.type === "assistant"`, `m` is `AssistantMessage`. Remove casts:
```typescript
// Before
if (m.type === "assistant" && !(m as AssistantMessage).finalized) {
    messages[i] = { ...(m as AssistantMessage), finalized: true };
// After
if (m.type === "assistant" && !m.finalized) {
    messages[i] = { ...m, finalized: true };
```

**Step 2: Fix `handleDone` (lines 309–311)** — same pattern as above.

**Step 3: Fix `flushAssistantRender` (lines 457–459)** — same pattern as above.

**Step 4: Fix `clearQueuedFlags` (line 371)**

After `m.type === "user"`, `m` is `UserMessage`:
```typescript
// Before
if (m.type === "user" && (m as UserMessage).queued) {
// After
if (m.type === "user" && m.queued) {
```

**Step 5: Fix `handlePartRemoved` (line 431)**

After `m.type !== "tool"` is false (in the `||` branch), `m` is `ToolMessage`:
```typescript
// Before
(m) => m.type !== "tool" || (m as ToolMessage).id !== partId,
// After
(m) => m.type !== "tool" || m.id !== partId,
```

**Step 6: Fix `handleResult` (lines 267–274)**

After `lastMsg?.type === "result"`, `lastMsg` is `ResultMessage`. All 7 casts are redundant:
```typescript
// Before
messages[messages.length - 1] = {
    ...(lastMsg as ResultMessage),
    cost: cost ?? (lastMsg as ResultMessage).cost,
    duration: duration || (lastMsg as ResultMessage).duration,
    inputTokens: usage?.input ?? (lastMsg as ResultMessage).inputTokens,
    outputTokens: usage?.output ?? (lastMsg as ResultMessage).outputTokens,
    cacheRead: usage?.cache_read ?? (lastMsg as ResultMessage).cacheRead,
    cacheWrite: usage?.cache_creation ?? (lastMsg as ResultMessage).cacheWrite,
};
// After
messages[messages.length - 1] = {
    ...lastMsg,
    cost: cost ?? lastMsg.cost,
    duration: duration || lastMsg.duration,
    inputTokens: usage?.input ?? lastMsg.inputTokens,
    outputTokens: usage?.output ?? lastMsg.outputTokens,
    cacheRead: usage?.cache_read ?? lastMsg.cacheRead,
    cacheWrite: usage?.cache_creation ?? lastMsg.cacheWrite,
};
```

**Step 7: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/public/stores/chat.svelte.ts
git commit -m "refactor: remove redundant assistant/user/result message casts"
```

---

### Task 2.3: Add `findMessage` helper for type-safe array search

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts`
- Test: `test/unit/chat-store.test.ts` (add test for `findMessage`)

**Step 1: Write the failing test**

Add a test block to the chat store tests:

```typescript
describe("findMessage", () => {
    test("returns index and narrowed message for matching type", () => {
        const messages: ChatMessage[] = [
            { type: "user", uuid: "1", text: "hi" },
            { type: "tool", uuid: "2", id: "t1", name: "bash", status: "running" },
        ];
        const result = findMessage(messages, "tool", (m) => m.id === "t1");
        expect(result).toBeDefined();
        expect(result!.index).toBe(1);
        expect(result!.message.id).toBe("t1");
    });

    test("returns undefined when no match", () => {
        const messages: ChatMessage[] = [
            { type: "user", uuid: "1", text: "hi" },
        ];
        expect(findMessage(messages, "tool", () => true)).toBeUndefined();
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/chat-store.test.ts`
Expected: FAIL — `findMessage` is not exported

**Step 3: Implement `findMessage`**

Add near the top of `chat.svelte.ts` (after imports, before `chatState`):

```typescript
export function findMessage<T extends ChatMessage["type"]>(
    messages: ChatMessage[],
    type: T,
    predicate: (m: Extract<ChatMessage, { type: T }>) => boolean,
): { index: number; message: Extract<ChatMessage, { type: T }> } | undefined {
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!;
        if (m.type === type && predicate(m as Extract<ChatMessage, { type: T }>)) {
            return { index: i, message: m as Extract<ChatMessage, { type: T }> };
        }
    }
    return undefined;
}
```

Note: The single `as` inside `findMessage` is justified — it's the centralized narrowing point, replacing 6+ scattered casts.

**Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- test/unit/chat-store.test.ts`
Expected: PASS

**Step 5: Replace `findIndex` + cast patterns**

In `handleToolExecuting`:
```typescript
// Before
const idx = messages.findIndex((m) => m.type === "tool" && m.uuid === uuid);
if (idx >= 0) {
    messages[idx] = { ...(messages[idx] as ToolMessage), status: "running", input: toolInput };

// After
const found = findMessage(messages, "tool", (m) => m.uuid === uuid);
if (found) {
    messages[found.index] = { ...found.message, status: "running", input: toolInput };
```

Apply same pattern to `handleToolResult` and `handleToolContentResponse` (in `ws.svelte.ts`).

**Step 6: Replace `.find()` + cast patterns in `ws.svelte.ts`**

For the `tool_result` cases in `handleMessage` and `replayEvents` where `.find()` is used:
```typescript
// Before
const toolMsg = chatState.messages.find(
    (m) => m.type === "tool" && (m as ToolMessage).id === msg.id,
) as ToolMessage | undefined;

// After — use a type-narrowing predicate
const toolMsg = chatState.messages.find(
    (m): m is ToolMessage => m.type === "tool" && m.id === msg.id,
);
```

**Step 7: Fix `handleMessageRemoved` (line 442)**

```typescript
// Before
(m as AssistantMessage | ToolMessage).messageId !== messageId,

// After — use "in" narrowing
!("messageId" in m) || m.messageId !== messageId,
```

Note: After `"messageId" in m` is true, TypeScript narrows `m` to the variants that have `messageId` (AssistantMessage | ToolMessage). The second branch can access `.messageId` directly.

**Step 8: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/public/stores/chat.svelte.ts src/lib/public/stores/ws.svelte.ts test/unit/chat-store.test.ts
git commit -m "refactor: add findMessage helper, eliminate index-based casts in stores"
```

---

### Task 2.4: Unify `replayEvents` with `handleMessage`

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts`

**Step 1: Add `replaying` flag to `chatState`**

If `chatState` doesn't already have a `replaying` flag (it does — `chatState.replaying` is set in `replayEvents`), use it.

**Step 2: Refactor `replayEvents` to delegate to `handleMessage`**

```typescript
function replayEvents(events: RelayMessage[]): void {
    chatState.replaying = true;
    for (const event of events) {
        handleMessage(event);
    }
    flushPendingRender();
    chatState.replaying = false;
}
```

**Step 3: Guard side effects in `handleMessage` with `chatState.replaying`**

In the `handleMessage` switch, any case that triggers notifications, banners, or URL changes should check `if (!chatState.replaying)` before firing those side effects. Review each case for:
- `triggerNotifications()` — skip during replay
- `showBanner()` / `showToast()` — skip during replay
- `replaceRoute()` — skip during replay (session_switched case needs careful review)

**Step 4: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/public/stores/ws.svelte.ts
git commit -m "refactor: unify replayEvents with handleMessage dispatch"
```

---

## PR 3: Pipeline + Test Helper Deduplication

---

### Task 3.1: Extract shared event pipeline function

**Files:**
- Create: `src/lib/event-pipeline.ts`
- Modify: `src/lib/sse-wiring.ts`
- Modify: `src/lib/relay-stack.ts`
- Test: `test/unit/event-pipeline.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, vi } from "vitest";
import { processRelayEvent } from "../../src/lib/event-pipeline.js";

describe("processRelayEvent", () => {
    function makeDeps() {
        return {
            toolContentStore: { store: vi.fn() },
            overrides: {
                resetProcessingTimeout: vi.fn(),
                clearProcessingTimeout: vi.fn(),
            },
            messageCache: { recordEvent: vi.fn() },
            wsHandler: {
                getClientsForSession: vi.fn(() => []),
                sendToSession: vi.fn(),
            },
        };
    }

    test("truncates tool_result and stores full content", () => {
        const deps = makeDeps();
        const msg = { type: "tool_result" as const, id: "t1", content: "x".repeat(50_000) };
        processRelayEvent(msg, "sess-1", deps as any);
        expect(deps.toolContentStore.store).toHaveBeenCalledWith("t1", expect.any(String), "sess-1");
    });

    test("clears processing timeout on done", () => {
        const deps = makeDeps();
        processRelayEvent({ type: "done" } as any, "sess-1", deps as any);
        expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith("sess-1");
    });

    test("resets processing timeout on non-done events", () => {
        const deps = makeDeps();
        processRelayEvent({ type: "delta", text: "hi" } as any, "sess-1", deps as any);
        expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledWith("sess-1");
    });

    test("records cacheable events", () => {
        const deps = makeDeps();
        processRelayEvent({ type: "delta", text: "hi" } as any, "sess-1", deps as any);
        expect(deps.messageCache.recordEvent).toHaveBeenCalled();
    });

    test("sends to session viewers", () => {
        const deps = makeDeps();
        deps.wsHandler.getClientsForSession.mockReturnValue(["client1"]);
        processRelayEvent({ type: "delta", text: "hi" } as any, "sess-1", deps as any);
        expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({ type: "delta" }));
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/event-pipeline.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `event-pipeline.ts`**

Extract the shared logic from `relay-stack.ts:578-608` and `sse-wiring.ts:206-256`:

```typescript
// src/lib/event-pipeline.ts
import type { RelayMessage } from "./shared-types.js";
import { truncateToolResult, isCacheable } from "./sse-wiring.js";

export interface EventPipelineDeps {
    toolContentStore: { store(id: string, content: string, sessionId: string): void };
    overrides: {
        resetProcessingTimeout(sessionId: string): void;
        clearProcessingTimeout(sessionId: string): void;
    };
    messageCache: { recordEvent(sessionId: string, msg: RelayMessage): void };
    wsHandler: {
        getClientsForSession(sessionId: string): string[];
        sendToSession(sessionId: string, msg: RelayMessage): void;
    };
}

export function processRelayEvent(
    msg: RelayMessage,
    sessionId: string | undefined,
    deps: EventPipelineDeps,
): RelayMessage {
    // 1. Truncate large tool_result content
    if (msg.type === "tool_result") {
        const { truncated, fullContent } = truncateToolResult(msg);
        if (fullContent !== undefined && sessionId) {
            deps.toolContentStore.store(msg.id, fullContent, sessionId);
        }
        msg = truncated;
    }

    // 2. Manage processing timeout
    if (msg.type === "done" && sessionId) {
        deps.overrides.clearProcessingTimeout(sessionId);
    } else if (sessionId) {
        deps.overrides.resetProcessingTimeout(sessionId);
    }

    // 3. Record to cache
    if (sessionId && isCacheable(msg)) {
        deps.messageCache.recordEvent(sessionId, msg);
    }

    // 4. Route to session viewers
    if (sessionId) {
        const hasViewers = deps.wsHandler.getClientsForSession(sessionId).length > 0;
        if (hasViewers) {
            deps.wsHandler.sendToSession(sessionId, msg);
        }
    }

    return msg;
}
```

Note: `truncateToolResult` and `isCacheable` need to be exported from `sse-wiring.ts` if they aren't already. Check before implementing.

**Step 4: Wire into relay-stack.ts and sse-wiring.ts**

Replace the duplicated code in both files with calls to `processRelayEvent()`.

**Step 5: Run tests and commit**

Run: `pnpm test:unit && pnpm test`

```bash
git add src/lib/event-pipeline.ts src/lib/relay-stack.ts src/lib/sse-wiring.ts test/unit/event-pipeline.test.ts
git commit -m "refactor: extract shared event pipeline, eliminate SSE/poller duplication"
```

---

### Task 3.2: Extract shared test helpers

**Files:**
- Create: `test/helpers/opencode-utils.ts`
- Modify: `test/integration/helpers/relay-harness.ts`
- Modify: `test/e2e/helpers/e2e-harness.ts`

**Step 1: Create shared helper**

```typescript
// test/helpers/opencode-utils.ts
import WebSocket from "ws";

const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://localhost:4096";

export async function isOpenCodeRunning(url?: string): Promise<boolean> {
    try {
        const res = await fetch(`${url ?? OPENCODE_URL}/path`, {
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

export async function switchModelViaWs(
    relayPort: number,
    modelId: string,
    providerId: string,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error("Timeout switching model"));
        }, 5000);
        ws.on("open", () => {
            ws.send(JSON.stringify({ type: "switch_model", modelId, providerId }));
            setTimeout(() => {
                clearTimeout(timer);
                ws.close();
                resolve();
            }, 300);
        });
        ws.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
```

**Step 2: Update relay-harness.ts**

Replace the local `isOpenCodeRunning` and `switchModelViaWs` with imports from the shared helper.

**Step 3: Update e2e-harness.ts**

Replace the local `isOpenCodeRunning` with import. Replace `switchToFreeModel` body to wrap the shared `switchModelViaWs`:

```typescript
import { isOpenCodeRunning, switchModelViaWs } from "../../helpers/opencode-utils.js";

async function switchToFreeModel(relayPort: number): Promise<void> {
    if (!E2E_MODEL || !E2E_PROVIDER) return;
    await switchModelViaWs(relayPort, E2E_MODEL, E2E_PROVIDER);
}
```

**Step 4: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add test/helpers/opencode-utils.ts test/integration/helpers/relay-harness.ts test/e2e/helpers/e2e-harness.ts
git commit -m "refactor: extract shared test helpers to test/helpers/opencode-utils.ts"
```

---

## PR 4: `daemon.ts` Decomposition

---

### Task 4.1: Extract `CrashCounter`

**Files:**
- Create: `src/lib/crash-counter.ts`
- Modify: `src/lib/daemon.ts`
- Create: `test/unit/crash-counter.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "vitest";
import { CrashCounter } from "../../src/lib/crash-counter.js";

describe("CrashCounter", () => {
    test("shouldGiveUp returns false when under threshold", () => {
        const counter = new CrashCounter();
        counter.record();
        counter.record();
        expect(counter.shouldGiveUp()).toBe(false);
    });

    test("shouldGiveUp returns true after MAX_CRASHES within window", () => {
        const counter = new CrashCounter({ maxCrashes: 3, windowMs: 60_000 });
        counter.record();
        counter.record();
        counter.record();
        expect(counter.shouldGiveUp()).toBe(true);
    });

    test("shouldGiveUp returns false after reset", () => {
        const counter = new CrashCounter({ maxCrashes: 3, windowMs: 60_000 });
        counter.record();
        counter.record();
        counter.record();
        counter.reset();
        expect(counter.shouldGiveUp()).toBe(false);
    });

    test("old crashes outside window are ignored", () => {
        const counter = new CrashCounter({ maxCrashes: 3, windowMs: 1000 });
        // Simulate old crashes by manipulating timestamps
        const timestamps = counter.getTimestamps();
        timestamps.push(Date.now() - 2000, Date.now() - 2000, Date.now() - 2000);
        expect(counter.shouldGiveUp()).toBe(false);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/crash-counter.test.ts`

**Step 3: Implement CrashCounter**

Extract lines 1145–1180 from `daemon.ts` into `src/lib/crash-counter.ts`:

```typescript
// src/lib/crash-counter.ts
const DEFAULT_CRASH_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASHES = 3;

export interface CrashCounterOptions {
    maxCrashes?: number;
    windowMs?: number;
}

export class CrashCounter {
    private readonly maxCrashes: number;
    private readonly windowMs: number;
    private timestamps: number[] = [];

    constructor(options?: CrashCounterOptions) {
        this.maxCrashes = options?.maxCrashes ?? DEFAULT_MAX_CRASHES;
        this.windowMs = options?.windowMs ?? DEFAULT_CRASH_WINDOW_MS;
    }

    record(): void {
        this.timestamps.push(Date.now());
    }

    shouldGiveUp(): boolean {
        const now = Date.now();
        const recent = this.timestamps.filter((t) => now - t < this.windowMs);
        return recent.length >= this.maxCrashes;
    }

    reset(): void {
        this.timestamps = [];
    }

    getTimestamps(): number[] {
        return this.timestamps;
    }
}
```

**Step 4: Update daemon.ts to import and use CrashCounter**

Replace the inline crash counter methods with `this.crashCounter = new CrashCounter()` and delegate calls.

**Step 5: Run tests and commit**

Run: `pnpm test:unit`

```bash
git add src/lib/crash-counter.ts src/lib/daemon.ts test/unit/crash-counter.test.ts
git commit -m "refactor: extract CrashCounter from daemon.ts"
```

---

### Task 4.2: Extract PID/socket file management

**Files:**
- Create: `src/lib/pid-manager.ts`
- Modify: `src/lib/daemon.ts`
- Create: `test/unit/pid-manager.test.ts`

**Step 1: Write tests for PidManager**

Test `writePidFile`, `removePidFile`, `removeSocketFile`, `cleanupStale` using temp directories.

**Step 2: Implement PidManager**

Extract lines 1077–1113 from `daemon.ts`. Free functions that take `configDir` as a parameter:

```typescript
export function writePidFile(configDir: string): void
export function removePidFile(configDir: string): void
export function removeSocketFile(configDir: string): void
export function cleanupStale(configDir: string): void
```

**Step 3: Update daemon.ts imports and commit**

---

### Task 4.3: Extract signal handlers

**Files:**
- Create: `src/lib/signal-handlers.ts`
- Modify: `src/lib/daemon.ts`

Extract lines 1115–1143. Simple functions:

```typescript
export function installSignalHandlers(onShutdown: () => Promise<void>): void
export function removeSignalHandlers(): void
```

---

### Task 4.4: Extract daemon utility functions

**Files:**
- Create: `src/lib/daemon-utils.ts`
- Modify: `src/lib/daemon.ts`

Extract `probeOpenCode`, `findFreePort`, `buildConfig` (lines 767–829) as pure free functions.

---

### Task 4.5: Extract ProjectManager

**Files:**
- Create: `src/lib/project-manager.ts`
- Modify: `src/lib/daemon.ts`
- Create: `test/unit/project-manager.test.ts`

This is the most complex extraction. Define a `ProjectManagerDeps` interface:

```typescript
export interface ProjectManagerDeps {
    instanceManager: InstanceManager;
    httpServer: HttpServer | null;
    pushManager: PushNotificationManager | null;
    configDir: string;
    log: (...args: unknown[]) => void;
    saveDaemonConfig: (config: DaemonConfig) => void;
    createRelay: (config: ProjectRelayConfig) => Promise<ProjectRelay>;
}
```

Extract `addProject`, `removeProject`, `getProjects`, `getInstances`, `discoverProjects` into a `ProjectManager` class that receives deps via constructor.

---

### Task 4.6: Final verification

**Step 1: Count daemon.ts lines**

Run: `wc -l src/lib/daemon.ts`
Expected: < 850

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass

---

## PR 5: `ws.svelte.ts` + `http-router.ts` Decomposition

---

### Task 5.1: Extract `ws-send.svelte.ts`

**Files:**
- Create: `src/lib/public/stores/ws-send.svelte.ts`
- Modify: `src/lib/public/stores/ws.svelte.ts`

Move rate limiter, offline queue, `wsSend()`, and drain logic (~130 lines) to new file. `ws.svelte.ts` imports and re-exports `wsSend`.

---

### Task 5.2: Extract `ws-dispatch.ts`

**Files:**
- Create: `src/lib/public/stores/ws-dispatch.ts`
- Modify: `src/lib/public/stores/ws.svelte.ts`

Move `handleMessage()` switch statement and the unified `replayEvents()` (from PR 2c) to new file. This file imports from all 13 store modules — the coupling moves but is now isolated to a pure dispatch table.

---

### Task 5.3: Convert `http-router.ts` to route table

**Files:**
- Modify: `src/lib/http-router.ts`

Convert the `if` chain in `handleRequest` to a declarative route table array. Each entry is `{ method, path, handler }`. A small matching loop replaces the sequential `if` blocks.

---

### Task 5.4: Extract static file serving

**Files:**
- Create: `src/lib/static-files.ts`
- Modify: `src/lib/http-router.ts`

Move `getCacheControl()`, `serveStaticFile()`, `tryServeStatic()` (~88 lines) to a standalone module.

---

### Task 5.5: Final verification

**Step 1: Count ws.svelte.ts lines**

Run: `wc -l src/lib/public/stores/ws.svelte.ts`
Expected: < 450

**Step 2: Run full test suite**

Run: `pnpm test`
Expected: All pass
