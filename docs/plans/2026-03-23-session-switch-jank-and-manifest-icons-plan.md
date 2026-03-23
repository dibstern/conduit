# Session Switch Jank & Manifest Icon Fix — Implementation Plan (v2, post-audit)

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Fix manifest icon 404s in production builds and eliminate main-thread jank during session switches by chunking replay, batching array mutations, and deferring markdown rendering.

**Architecture:** Two independent fixes. (1) A Vite plugin that strips `/static/` prefix from manifest icon paths at build time. (2) A three-layer refactor of `replayEvents()`: async chunked processing with yielding, batched array mutations via a module-level staging array, and deferred markdown rendering. `handleMessage` stays synchronous — replay is fire-and-forget with `.catch()`.

**Tech Stack:** TypeScript, Vite, Svelte 5 ($state runes), marked + DOMPurify

**Important TypeScript constraints:**
- `exactOptionalPropertyTypes: true` — can't assign `undefined` to optional properties; use spread-omit pattern instead
- `strict: true` — no implicit any, strict null checks

**Key architectural decision:** `handleMessage` STAYS SYNCHRONOUS. `replayEvents()` is called fire-and-forget (not awaited) to avoid concurrent message processing. This means:
- Live WS messages can arrive during replay. Since replay covers the full session, these are redundant — the batch commit overwrites them. This is acceptable.
- Code after `replayEvents()` in `session_switched` runs before replay finishes (fine — `inputText` sync is independent).
- Tests must `await vi.runAllTimersAsync()` to drain the replay promise before asserting.

---

## Changes NOT Being Made

| Item | Why skipped |
|------|-------------|
| Making `handleMessage` async | Creates concurrent message processing hazards and breaks error handling in `ws.svelte.ts:289-293` try/catch. Fire-and-forget avoids both. |
| Web Worker for markdown | Addressed by Layer C (deferred rendering) + existing server-side pre-rendering (C3). |
| Queue for live events during replay | Replay covers full session history. Live events are redundant. Batch commit overwriting live mutations is harmless. |

---

## Task 1: Vite Plugin — Fix Manifest Icon Paths

**Files:**
- Modify: `vite.config.ts`
- Create: `test/build/manifest-icons.test.ts`

### Step 1: Write the Vite plugin

In `vite.config.ts`, add a new plugin function before `export default defineConfig`:

```typescript
/**
 * Rewrite icon `src` paths inside manifest.webmanifest at build time.
 *
 * Vite's publicDir copies file CONTENTS to the build root (no hashing,
 * no /static/ prefix). But the source manifest references icons as
 * /static/apple-touch-icon.png etc. Vite treats .webmanifest as opaque
 * — it hashes the reference to the manifest but never rewrites its
 * internal JSON. This plugin strips the /static/ prefix so icon paths
 * resolve to where publicDir actually puts the files.
 *
 * Note: The unhashed publicDir copy at dist/frontend/manifest.webmanifest
 * is written AFTER generateBundle and is NOT rewritten. Only the hashed
 * copy under assets/ (the one index.html links to) is fixed.
 */
function manifestIconPlugin(): Plugin {
  return {
    name: "manifest-icon-rewrite",
    enforce: "post",
    generateBundle(_options, bundle) {
      const manifestKey = Object.keys(bundle).find((k) =>
        k.endsWith(".webmanifest"),
      );
      if (!manifestKey) return;
      const asset = bundle[manifestKey];
      if (!asset || asset.type !== "asset") return;

      try {
        const source = typeof asset.source === "string"
          ? asset.source
          : new TextDecoder().decode(asset.source);
        const manifest = JSON.parse(source);

        if (Array.isArray(manifest.icons)) {
          let changed = false;
          for (const icon of manifest.icons) {
            if (typeof icon.src === "string" && icon.src.startsWith("/static/")) {
              icon.src = icon.src.replace(/^\/static\//, "/");
              changed = true;
            }
          }
          if (changed) {
            asset.source = JSON.stringify(manifest, null, "\t");
          }
        }
      } catch {
        // Malformed JSON — leave unchanged
      }
    },
  };
}
```

Then add it to the plugins array:

```typescript
plugins: [svelte(), tailwindcss(), serviceWorkerPlugin(), manifestIconPlugin()],
```

### Step 2: Write a build integration test

Create `test/build/manifest-icons.test.ts`:

```typescript
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Manifest icon paths in build output", () => {
  // This test requires a build to exist. Run `pnpm build` before running.
  const distDir = join(import.meta.dirname, "../../dist/frontend");

  it("manifest icon src values do not reference /static/", () => {
    // Find the hashed manifest in assets/
    const assetsDir = join(distDir, "assets");
    const manifestFile = readdirSync(assetsDir).find((f) =>
      f.endsWith(".webmanifest"),
    );
    expect(manifestFile, "No .webmanifest found in dist/frontend/assets/").toBeTruthy();

    const manifest = JSON.parse(
      readFileSync(join(assetsDir, manifestFile!), "utf-8"),
    );
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      expect(icon.src).not.toMatch(/^\/static\//);
      expect(icon.src).toMatch(/^\//); // absolute path from root
    }
  });

  it("manifest icon files exist in build output", () => {
    const assetsDir = join(distDir, "assets");
    const manifestFile = readdirSync(assetsDir).find((f) =>
      f.endsWith(".webmanifest"),
    );
    const manifest = JSON.parse(
      readFileSync(join(assetsDir, manifestFile!), "utf-8"),
    );

    for (const icon of manifest.icons) {
      const iconPath = join(distDir, icon.src);
      expect(() => readFileSync(iconPath), `Icon not found: ${icon.src}`).not.toThrow();
    }
  });
});
```

### Step 3: Build and verify

Run: `pnpm build && pnpm vitest run test/build/manifest-icons.test.ts`
Expected: Build succeeds, tests pass

### Step 4: Run type check

Run: `pnpm check`
Expected: PASS

### Step 5: Commit

```bash
git add vite.config.ts test/build/manifest-icons.test.ts
git commit -m "fix: rewrite manifest icon paths at build time via Vite plugin

Vite's publicDir copies static/ contents to build root without the
static/ prefix, but leaves manifest.webmanifest internal icon src
values untouched. The new plugin strips /static/ prefix from icon
paths in generateBundle, fixing 404s in production."
```

---

## Task 2: Replay Batch Infrastructure in chat.svelte.ts

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts`
- Create: `test/unit/stores/replay-batch.test.ts`

This task adds `beginReplayBatch`/`commitReplayBatch`/`discardReplayBatch` and internal `getMessages`/`setMessages` helpers. During replay, all mutation functions route through a mutable working array instead of `chatState.messages`.

### Step 1: Write the failing test

Create `test/unit/stores/replay-batch.test.ts` with the same localStorage/DOMPurify mocks as existing store tests:

```typescript
// ─── Replay Batch: Array Mutation Batching ───────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  let store: Record<string, string> = {};
  const mock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((_: number) => null),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock, writable: true, configurable: true,
  });
});

vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

import {
  chatState,
  clearMessages,
  handleDelta,
  handleDone,
  handleError,
  handleToolStart,
  handleToolExecuting,
  handleToolResult,
  handleThinkingStart,
  addUserMessage,
  beginReplayBatch,
  commitReplayBatch,
  discardReplayBatch,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

beforeEach(() => {
  clearMessages();
  vi.useFakeTimers();
});

afterEach(() => {
  discardReplayBatch();
  vi.useRealTimers();
});

describe("Replay batch: mutations accumulate without updating chatState", () => {
  it("handleDelta during batch does not update chatState.messages", () => {
    beginReplayBatch();
    handleDelta({ type: "delta", text: "hello" } as any);
    expect(chatState.messages).toHaveLength(0);
  });

  it("commitReplayBatch flushes accumulated messages to chatState", () => {
    beginReplayBatch();
    handleDelta({ type: "delta", text: "hello" } as any);
    vi.advanceTimersByTime(100);
    handleDone({ type: "done", code: 0 } as any);
    commitReplayBatch();
    expect(chatState.messages.length).toBeGreaterThan(0);
    const assistant = chatState.messages.find((m) => m.type === "assistant");
    expect(assistant).toBeDefined();
  });

  it("multiple events accumulate in batch with single commitReplayBatch", () => {
    beginReplayBatch();
    addUserMessage("question 1");
    handleDelta({ type: "delta", text: "answer 1" } as any);
    vi.advanceTimersByTime(100);
    handleDone({ type: "done", code: 0 } as any);
    addUserMessage("question 2");
    expect(chatState.messages).toHaveLength(0);
    commitReplayBatch();
    expect(chatState.messages.length).toBeGreaterThanOrEqual(3);
  });

  it("discardReplayBatch throws away accumulated mutations", () => {
    beginReplayBatch();
    addUserMessage("will be discarded");
    handleDelta({ type: "delta", text: "also discarded" } as any);
    discardReplayBatch();
    expect(chatState.messages).toHaveLength(0);
  });

  it("without batch, mutations update chatState.messages immediately", () => {
    addUserMessage("immediate");
    expect(chatState.messages).toHaveLength(1);
  });

  it("handleError during batch accumulates system message in batch", () => {
    beginReplayBatch();
    handleError({ type: "error", code: "SOMETHING", message: "fail" } as any);
    expect(chatState.messages).toHaveLength(0);
    commitReplayBatch();
    const systemMsg = chatState.messages.find((m) => m.type === "system");
    expect(systemMsg).toBeDefined();
  });

  it("clearMessages during active batch discards batch and resets state", () => {
    beginReplayBatch();
    addUserMessage("will be discarded");
    handleDelta({ type: "delta", text: "also in batch" } as any);
    expect(chatState.messages).toHaveLength(0);
    clearMessages();
    expect(chatState.messages).toHaveLength(0);
    // Subsequent mutations go directly to chatState.messages (no batch)
    addUserMessage("after clear");
    expect(chatState.messages).toHaveLength(1);
  });
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/stores/replay-batch.test.ts`
Expected: FAIL — exports don't exist

### Step 3: Implement batch infrastructure in chat.svelte.ts

Add after the `doneMessageIds` declaration (~line 135):

```typescript
// ─── Replay Batch ───────────────────────────────────────────────────────────
let replayBatch: ChatMessage[] | null = null;

export function beginReplayBatch(): void {
  replayBatch = [...chatState.messages];
}

export function commitReplayBatch(): void {
  if (replayBatch !== null) {
    chatState.messages = replayBatch;
    replayBatch = null;
  }
}

export function discardReplayBatch(): void {
  replayBatch = null;
}

export function getMessages(): ChatMessage[] {
  return replayBatch ?? chatState.messages;
}

function setMessages(msgs: ChatMessage[]): void {
  if (replayBatch !== null) {
    replayBatch = msgs;
  } else {
    chatState.messages = msgs;
  }
}
```

### Step 4: Refactor ALL mutation sites to use getMessages/setMessages

**Complete list** (every `chatState.messages` read/write in mutation functions):

- `applyToolCreate` (line ~116): `setMessages([...getMessages(), tool])`
- `applyToolUpdate` (line ~121): `const messages = [...getMessages()]; ... setMessages(messages);`
- `handleDelta` (line ~163): `setMessages([...getMessages(), assistantMsg]);`
- `handleThinkingStart` (line ~189): `setMessages([...getMessages(), thinkingMsg]);`
- `handleThinkingDelta`: use `getMessages()`/`setMessages()`
- `handleThinkingStop`: use `getMessages()`/`setMessages()`
- `handleToolStart` (lines ~258-267): `const messages = [...getMessages()]; ... setMessages(messages);`
- **`handleDone` (line ~392-423)**: use `getMessages()`/`setMessages()`. **CRITICAL: line ~413 `registry.finalizeAll(chatState.messages)` must become `registry.finalizeAll(getMessages())`**, and the following `const messages = [...chatState.messages]` on line ~415 must become `[...getMessages()]`.
- `handleResult`: use `getMessages()`/`setMessages()`
- `addUserMessage` (lines ~510-532): use `getMessages()`/`setMessages()`
- **`addSystemMessage`** (line ~567): `setMessages([...getMessages(), msg])` — this is called by `handleError` during replay.
- `prependMessages` (line ~539): `setMessages([...msgs, ...getMessages()])`
- `flushAssistantRender` (lines ~695-706): `const messages = [...getMessages()]; ... setMessages(messages);`
- `clearQueuedFlags`: use `getMessages()`/`setMessages()`
- `applyQueuedFlagInPlace`: use `getMessages()`/`setMessages()`

**`clearMessages` must NOT use setMessages** — it resets everything including the batch:

```typescript
export function clearMessages(): void {
  replayBatch = null;
  chatState.replaying = false; // safety: clear stale flag on session switch
  chatState.messages = [];
  // ... rest unchanged
}
```

**DO NOT change ws-dispatch.ts in this task** — the `tool_result` TodoWrite detection that reads `chatState.messages` in ws-dispatch.ts is handled in Task 3.

### Step 5: Run the test

Run: `pnpm vitest run test/unit/stores/replay-batch.test.ts`
Expected: PASS

### Step 6: Run full store tests

Run: `pnpm vitest run test/unit/stores/`
Expected: PASS

### Step 7: Run type check

Run: `pnpm check`
Expected: PASS

### Step 8: Commit

```bash
git add src/lib/frontend/stores/chat.svelte.ts test/unit/stores/replay-batch.test.ts
git commit -m "perf: add replay batch infrastructure for O(N) array mutations

Add beginReplayBatch/commitReplayBatch/discardReplayBatch and internal
getMessages/setMessages helpers. During replay, all chat mutations
accumulate in a mutable working array. clearMessages discards any
in-progress batch and also clears chatState.replaying as a safety net."
```

---

## Task 3: Async Chunked replayEvents (Fire-and-Forget)

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Modify: `test/unit/stores/regression-session-switch-history.test.ts`
- Modify: `test/unit/stores/regression-mid-stream-switch.test.ts`
- Modify: `test/unit/stores/regression-dual-render-duplication.test.ts`
- Modify: `test/unit/stores/regression-queued-replay.test.ts`
- Create: `test/unit/stores/chunked-replay.test.ts`

**Key decision: `handleMessage` stays synchronous.** `replayEvents()` is fire-and-forget with `.catch()`. This avoids concurrent message processing and preserves the existing try/catch in `ws.svelte.ts`.

### Step 1: Profile chunk size

Before implementing, measure actual replay performance to calibrate `REPLAY_CHUNK_SIZE`:

```typescript
// Temporary profiling — add to replayEvents temporarily
console.time("replay");
// ... existing synchronous loop ...
console.timeEnd("replay");
console.log(`Events: ${events.length}`);
```

Switch between sessions with varying history sizes in the browser. Record:
- Events count vs replay time
- Find the threshold where replay exceeds 50ms (Chrome violation threshold)
- Calculate events-per-ms rate

Use this data to set `REPLAY_CHUNK_SIZE` to approximately `(events-per-ms * 16ms)` — targeting 16ms per chunk (one frame budget). Document the measurement in a code comment.

### Step 2: Write the failing test

Create `test/unit/stores/chunked-replay.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  let store: Record<string, string> = {};
  const mock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((_: number) => null),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock, writable: true, configurable: true,
  });
});

vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

import {
  chatState,
  clearMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { replayEvents } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

beforeEach(() => {
  clearMessages();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeConversation(turns: number): RelayMessage[] {
  const events: RelayMessage[] = [];
  for (let i = 0; i < turns; i++) {
    events.push({ type: "user_message", text: `q${i}` } as any);
    events.push({ type: "delta", text: `a${i}` } as any);
    events.push({ type: "done", code: 0 } as any);
  }
  return events;
}

async function drainReplay(promise: Promise<void>): Promise<void> {
  await vi.runAllTimersAsync();
  await promise;
}

describe("Chunked replay", () => {
  it("replayEvents returns a promise", () => {
    const result = replayEvents(makeConversation(1));
    expect(result).toBeInstanceOf(Promise);
    return drainReplay(result);
  });

  it("replaying flag is true during replay, false after", async () => {
    const promise = replayEvents(makeConversation(3));
    expect(chatState.replaying).toBe(true);
    await drainReplay(promise);
    expect(chatState.replaying).toBe(false);
  });

  it("all events are processed after replay completes", async () => {
    const promise = replayEvents(makeConversation(5));
    await drainReplay(promise);
    const userMsgs = chatState.messages.filter((m) => m.type === "user");
    const assistantMsgs = chatState.messages.filter((m) => m.type === "assistant");
    expect(userMsgs).toHaveLength(5);
    expect(assistantMsgs).toHaveLength(5);
  });

  it("rapid replay aborts the first replay", async () => {
    // Start first replay — clearMessages is a required prerequisite
    const promise1 = replayEvents(makeConversation(10));
    // Second session switch: clearMessages then new replay
    clearMessages();
    const promise2 = replayEvents(makeConversation(2));
    await vi.runAllTimersAsync();
    await Promise.all([promise1, promise2]);
    const userMsgs = chatState.messages.filter((m) => m.type === "user");
    expect(userMsgs).toHaveLength(2);
  });

  it("replaying is cleared on abort (not left stale)", async () => {
    const promise1 = replayEvents(makeConversation(10));
    clearMessages(); // clears replaying flag
    expect(chatState.replaying).toBe(false);
    // Start and complete second replay
    const promise2 = replayEvents(makeConversation(1));
    await vi.runAllTimersAsync();
    await Promise.all([promise1, promise2]);
    expect(chatState.replaying).toBe(false);
  });
});
```

### Step 3: Implement async chunked replayEvents

In `ws-dispatch.ts`:

```typescript
// Add to imports from chat.svelte.js:
import {
  // ... existing imports ...
  beginReplayBatch,
  commitReplayBatch,
  discardReplayBatch,
  getMessages,
} from "./chat.svelte.js";

// ─── Replay Infrastructure ──────────────────────────────────────────────────
let replayGeneration = 0;

/**
 * Chunk size for event replay. Calibrated by profiling: ~N events process
 * in <16ms with batched mutations (one frame budget). Measured on [date]
 * with [session size] events. Adjust if profiling shows different results.
 */
const REPLAY_CHUNK_SIZE = 80; // TODO: update after Step 1 profiling

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function replayEvents(events: RelayMessage[]): Promise<void> {
  chatState.replaying = true;
  const generation = ++replayGeneration;

  beginReplayBatch();

  let llmActive = false;

  for (let i = 0; i < events.length; i++) {
    // Abort: a newer replay or clearMessages happened
    if (generation !== replayGeneration) {
      discardReplayBatch();
      // Don't set replaying=false here — clearMessages already did,
      // or the new replay set it to true.
      return;
    }

    const event = events[i]!;

    if (isLlmContentStart(event.type)) llmActive = true;
    else if (event.type === "done") llmActive = false;
    else if (event.type === "error" && event.code !== "RETRY") llmActive = false;

    switch (event.type) {
      case "user_message":
        addUserMessage(event.text, undefined, llmActive);
        break;
      case "delta":
        handleDelta(event);
        break;
      case "done":
        handleDone(event);
        break;
      case "tool_start":
        handleToolStart(event);
        break;
      case "tool_executing":
        handleToolExecuting(event);
        break;
      case "tool_result":
        handleToolResult(event);
        {
          // TodoWrite detection — uses getMessages() to read from batch
          const msgs = getMessages();
          const toolMsg = msgs.find(
            (m): m is ToolMessage => m.type === "tool" && m.id === event.id,
          );
          if (toolMsg?.name === "TodoWrite" && !event.is_error && event.content) {
            updateTodosFromToolResult(event.content);
          }
        }
        break;
      case "result":
        handleResult(event);
        break;
      case "thinking_start":
        handleThinkingStart(event);
        break;
      case "thinking_delta":
        handleThinkingDelta(event);
        break;
      case "thinking_stop":
        handleThinkingStop(event);
        break;
      case "status":
        handleStatus(event);
        break;
      case "error":
        handleError(event);
        break;
    }

    if (isLlmContentStart(event.type)) clearQueuedFlags();

    // Yield between chunks
    if ((i + 1) % REPLAY_CHUNK_SIZE === 0) {
      commitReplayBatch();
      await yieldToEventLoop();
      if (generation !== replayGeneration) {
        // Aborted during yield — batch already committed,
        // new replay or clearMessages will handle state.
        return;
      }
      beginReplayBatch();
    }
  }

  flushPendingRender();
  commitReplayBatch();
  chatState.replaying = false;
}
```

Also add to `clearMessages()` in chat.svelte.ts — increment `replayGeneration` so in-flight replays abort:

Wait — `replayGeneration` is in ws-dispatch.ts, not chat.svelte.ts. Instead, `clearMessages` already sets `replayBatch = null` and `chatState.replaying = false`. The generation check in the loop will see the mismatch on the next iteration (the batch was discarded, but the generation check catches the abort). Actually, the generation only changes when a NEW `replayEvents` call happens. If just `clearMessages` is called (without starting a new replay), the generation stays the same and the in-flight replay continues with a discarded batch...

**Fix:** Export a `bumpReplayGeneration` function from ws-dispatch.ts, and call it from `clearMessages`. Or simpler: move `replayGeneration` into chat.svelte.ts alongside the batch infrastructure.

Actually, the simplest approach: in `clearMessages`, the batch is set to null. The next iteration of the replay loop calls `getMessages()` which returns `chatState.messages` (empty after clear). Then `setMessages` writes to `chatState.messages` directly. The generation check doesn't detect the abort, but the replay will proceed writing to `chatState.messages` directly — which will be overwritten by whatever comes next (new replay's `clearMessages`).

The cleaner fix is to export a function from ws-dispatch.ts:

```typescript
// In ws-dispatch.ts:
export function abortReplay(): void {
  replayGeneration++;
}
```

And call it from `clearMessages` in chat.svelte.ts:

```typescript
// Import at top of chat.svelte.ts:
import { abortReplay } from "./ws-dispatch.js";

// In clearMessages:
export function clearMessages(): void {
  replayBatch = null;
  chatState.replaying = false;
  abortReplay(); // cancel in-flight async replays
  chatState.messages = [];
  // ... rest unchanged
}
```

**Circular import check:** chat.svelte.ts → ws-dispatch.js. ws-dispatch.ts already imports from chat.svelte.js. This creates a circular dependency. To avoid it, use a different approach:

**Better approach:** Use a callback pattern. In chat.svelte.ts, add a registerable abort callback:

```typescript
let onClearMessages: (() => void) | null = null;

export function registerClearMessagesHook(fn: () => void): void {
  onClearMessages = fn;
}

export function clearMessages(): void {
  replayBatch = null;
  chatState.replaying = false;
  onClearMessages?.(); // abort in-flight replays
  chatState.messages = [];
  // ...
}
```

In ws-dispatch.ts:
```typescript
import { registerClearMessagesHook } from "./chat.svelte.js";

registerClearMessagesHook(() => { replayGeneration++; });
```

### Step 4: Update session_switched handler to fire-and-forget

In the `session_switched` case, change:

```typescript
if (msg.events) {
  // Fire-and-forget: handleMessage stays synchronous.
  // Errors are caught and logged — not propagated.
  replayEvents(msg.events).catch((err) => {
    console.warn("[ws] Replay error:", err);
  });
}
```

### Step 5: Update ALL 4 existing test files

Every test that calls `handleMessage` with `session_switched` + `events` or calls `replayEvents` directly needs updating.

**Pattern for all affected tests:**

```typescript
// Before:
handleMessage({ type: "session_switched", id: "s1", events: [...] });
expect(chatState.messages).toHaveLength(3);

// After:
handleMessage({ type: "session_switched", id: "s1", events: [...] });
await vi.runAllTimersAsync(); // drain replay promise
expect(chatState.messages).toHaveLength(3);
```

Each test function must become `async`.

**Files and approximate call counts:**
1. `regression-session-switch-history.test.ts` — ~15 calls
2. `regression-mid-stream-switch.test.ts` — ~8 calls
3. `regression-dual-render-duplication.test.ts` — ~5 calls
4. `regression-queued-replay.test.ts` — ~10 calls (uses `replayValidated` wrapper — make it async: `async function replayValidated(events) { replayEvents(events); await vi.runAllTimersAsync(); }`)

**Also update stale comments:** `regression-session-switch-history.test.ts:289` says "We can't easily test the mid-replay state since it's synchronous" — update to note replay is now async.

### Step 6: Run all tests

Run: `pnpm vitest run test/unit/stores/ && pnpm check`
Expected: PASS

### Step 7: Commit

```bash
git add src/lib/frontend/stores/ws-dispatch.ts src/lib/frontend/stores/chat.svelte.ts \
  test/unit/stores/chunked-replay.test.ts \
  test/unit/stores/regression-session-switch-history.test.ts \
  test/unit/stores/regression-mid-stream-switch.test.ts \
  test/unit/stores/regression-dual-render-duplication.test.ts \
  test/unit/stores/regression-queued-replay.test.ts
git commit -m "perf: async chunked replayEvents with fire-and-forget dispatch

replayEvents() is now async — processes events in chunks, yielding via
setTimeout(0) between chunks. handleMessage stays synchronous; replay
is fire-and-forget with .catch(). Generation counter aborts stale
replays. clearMessages bumps generation via registered hook to cancel
in-flight replays. Updated 4 test files for async replay."
```

---

## Task 4: Deferred Markdown Rendering During Replay

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts`
- Modify: `src/lib/frontend/types.ts` (or wherever AssistantMessage is defined)
- Create: `test/unit/stores/deferred-markdown.test.ts`

### Step 1: Add `needsRender` to AssistantMessage type

Find the `AssistantMessage` interface and add:

```typescript
needsRender?: boolean;
```

### Step 2: Write the failing test

Create `test/unit/stores/deferred-markdown.test.ts` — same localStorage/DOMPurify mock pattern, plus mock for renderMarkdown:

```typescript
const renderMarkdownSpy = vi.fn((text: string) => `<p>${text}</p>`);
vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
  renderMarkdown: (...args: unknown[]) => renderMarkdownSpy(...args as [string]),
}));

// ... imports ...

describe("Deferred markdown during replay", () => {
  it("flushAssistantRender skips renderMarkdown during replay", () => {
    chatState.replaying = true;
    beginReplayBatch();
    handleDelta({ type: "delta", text: "**bold**" } as any);
    vi.advanceTimersByTime(100);
    handleDone({ type: "done", code: 0 } as any);
    commitReplayBatch();
    expect(renderMarkdownSpy).not.toHaveBeenCalled();
    const assistant = chatState.messages.find((m) => m.type === "assistant");
    expect(assistant).toBeDefined();
    if (assistant?.type === "assistant") {
      expect(assistant.rawText).toBe("**bold**");
      expect(assistant.html).toBe("**bold**"); // raw text fallback
    }
    chatState.replaying = false;
  });

  it("renderDeferredMarkdown renders unrendered messages", async () => {
    chatState.replaying = true;
    beginReplayBatch();
    handleDelta({ type: "delta", text: "**bold**" } as any);
    vi.advanceTimersByTime(100);
    handleDone({ type: "done", code: 0 } as any);
    commitReplayBatch();
    chatState.replaying = false;
    renderDeferredMarkdown();
    await vi.runAllTimersAsync();
    expect(renderMarkdownSpy).toHaveBeenCalledWith("**bold**");
    const assistant = chatState.messages.find((m) => m.type === "assistant");
    if (assistant?.type === "assistant") {
      expect(assistant.html).toBe("<p>**bold**</p>");
    }
  });

  it("normal path still calls renderMarkdown immediately", () => {
    handleDelta({ type: "delta", text: "hello" } as any);
    vi.advanceTimersByTime(100);
    expect(renderMarkdownSpy).toHaveBeenCalledWith("hello");
  });

  it("calling renderDeferredMarkdown twice is idempotent", async () => {
    chatState.replaying = true;
    beginReplayBatch();
    handleDelta({ type: "delta", text: "**a**" } as any);
    vi.advanceTimersByTime(100);
    handleDone({ type: "done", code: 0 } as any);
    commitReplayBatch();
    chatState.replaying = false;
    renderDeferredMarkdown();
    renderDeferredMarkdown();
    await vi.runAllTimersAsync();
    expect(renderMarkdownSpy).toHaveBeenCalledTimes(1);
  });
});
```

### Step 3: Implement deferred markdown

Modify `flushAssistantRender` in chat.svelte.ts:

```typescript
function flushAssistantRender(): void {
  if (!chatState.currentAssistantText) return;

  // During replay, skip expensive markdown rendering — store raw text.
  // renderDeferredMarkdown() handles rendering in idle time after replay.
  const html = chatState.replaying
    ? chatState.currentAssistantText
    : renderMarkdown(chatState.currentAssistantText);

  const messages = [...getMessages()];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === "assistant" && !m.finalized) {
      const base = { ...m, rawText: chatState.currentAssistantText, html };
      messages[i] = chatState.replaying ? { ...base, needsRender: true } : base;
      setMessages(messages);
      return;
    }
  }
}
```

Run `pnpm check` to verify the conditional spread compiles. If it doesn't, use:
```typescript
messages[i] = chatState.replaying
  ? { ...m, rawText: chatState.currentAssistantText, html, needsRender: true }
  : { ...m, rawText: chatState.currentAssistantText, html };
```

Add `renderDeferredMarkdown` with generation guard and per-batch re-scan:

```typescript
let deferredGeneration = 0;

export function cancelDeferredMarkdown(): void {
  deferredGeneration++;
}

export function renderDeferredMarkdown(): void {
  const generation = ++deferredGeneration;
  const BATCH_SIZE = 5;

  function processBatch(): void {
    if (generation !== deferredGeneration) return; // aborted

    const updated = [...chatState.messages];
    let rendered = 0;
    for (let i = 0; i < updated.length && rendered < BATCH_SIZE; i++) {
      const m = updated[i]!;
      if (m.type === "assistant" && m.needsRender) {
        const { needsRender: _, ...rest } = m;
        updated[i] = { ...rest, html: renderMarkdown(m.rawText) };
        rendered++;
      }
    }
    if (rendered > 0) {
      chatState.messages = updated;
    }

    // Continue if more unrendered messages remain
    const hasMore = updated.some(
      (m) => m.type === "assistant" && (m as AssistantMessage).needsRender,
    );
    if (hasMore) {
      setTimeout(processBatch, 0);
    }
  }

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => processBatch());
  } else {
    setTimeout(processBatch, 0);
  }
}
```

Update `clearMessages` to cancel deferred renders:

```typescript
export function clearMessages(): void {
  replayBatch = null;
  chatState.replaying = false;
  onClearMessages?.();
  cancelDeferredMarkdown(); // abort in-flight deferred renders
  chatState.messages = [];
  // ... rest unchanged
}
```

### Step 4: Wire into replayEvents

In `ws-dispatch.ts`, at the end of `replayEvents` (after `chatState.replaying = false`):

```typescript
chatState.replaying = false;
renderDeferredMarkdown(); // progressive markdown enhancement
```

### Step 5: Run tests

Run: `pnpm vitest run test/unit/stores/deferred-markdown.test.ts && pnpm vitest run test/unit/stores/ && pnpm check`
Expected: PASS

### Step 6: Commit

```bash
git add src/lib/frontend/stores/chat.svelte.ts src/lib/frontend/stores/ws-dispatch.ts \
  src/lib/frontend/types.ts test/unit/stores/deferred-markdown.test.ts
git commit -m "perf: defer markdown rendering during event replay

flushAssistantRender skips renderMarkdown when replaying — stores raw
text and sets needsRender flag. After replay, renderDeferredMarkdown
processes messages in batches of 5 via requestIdleCallback/setTimeout.
Generation guard prevents stale renders after session switch. Per-batch
re-scan avoids stale index bugs."
```

---

## Task 5: Async History Conversion for REST Path

**Files:**
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Create: `test/unit/stores/async-history-conversion.test.ts`

**Note on abort mechanism:** `replayGeneration` is reused for history conversion abort. This is safe because `historyState.loading` prevents concurrent history page loads (the `HistoryLoader` component checks it before requesting). A session switch bumps the generation via `clearMessages` → `abortReplay()`, correctly aborting any in-flight history conversion. This safety invariant must be documented in a code comment.

### Step 1: Write the failing test

Create `test/unit/stores/async-history-conversion.test.ts`:

```typescript
// Tests for convertHistoryAsync — chunked history conversion with abort

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ... same localStorage/DOMPurify mocks ...

import {
  chatState,
  clearMessages,
  historyState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ id: `p-${i}`, type: "text" as const, text: `text ${i}` }],
  }));
}

beforeEach(() => {
  clearMessages();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Async history conversion", () => {
  it("small history produces same result as direct conversion", async () => {
    const messages = makeHistory(10);
    const directResult = historyToChatMessages(messages);

    handleMessage({
      type: "session_switched",
      id: "s1",
      history: { messages, hasMore: false },
    } as any);
    await vi.runAllTimersAsync();

    expect(chatState.messages.length).toBe(directResult.length);
  });

  it("large history produces same result as direct conversion", async () => {
    const messages = makeHistory(200);
    const directResult = historyToChatMessages(messages);

    handleMessage({
      type: "session_switched",
      id: "s1",
      history: { messages, hasMore: true },
    } as any);
    await vi.runAllTimersAsync();

    expect(chatState.messages.length).toBe(directResult.length);
    expect(historyState.hasMore).toBe(true);
  });

  it("history_page sets loading=false even on abort", async () => {
    historyState.loading = true;
    handleMessage({
      type: "history_page",
      messages: makeHistory(200),
      hasMore: true,
    } as any);
    // Immediately switch sessions (aborts history conversion)
    handleMessage({ type: "session_switched", id: "s2" } as any);
    await vi.runAllTimersAsync();
    expect(historyState.loading).toBe(false);
  });
});
```

### Step 2: Implement convertHistoryAsync

In `ws-dispatch.ts`:

```typescript
/**
 * Convert history messages in yielding chunks.
 * historyToChatMessages stays synchronous (pure, well-tested).
 * This wrapper yields between chunks to avoid blocking the main thread.
 *
 * Uses replayGeneration for abort detection. This is safe because
 * historyState.loading prevents concurrent history_page loads, and
 * session switches bump generation via clearMessages → abortReplay().
 */
async function convertHistoryAsync(
  messages: HistoryMessage[],
  render: (text: string) => string,
): Promise<ChatMessage[] | null> {
  const CHUNK = 50;
  const gen = replayGeneration; // snapshot
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK);
    const converted = historyToChatMessages(slice, render);
    result.push(...converted);

    if (i + CHUNK < messages.length) {
      await yieldToEventLoop();
      if (gen !== replayGeneration) return null; // aborted
    }
  }

  return result;
}
```

### Step 3: Update session_switched REST fallback

```typescript
} else if (msg.history) {
  // Fire-and-forget async conversion
  const historyMsgs = msg.history.messages;
  const hasMore = msg.history.hasMore;
  const msgCount = historyMsgs.length;
  convertHistoryAsync(historyMsgs, renderMarkdown).then((chatMsgs) => {
    if (chatMsgs) {
      prependMessages(chatMsgs);
      historyState.hasMore = hasMore;
      historyState.messageCount = msgCount;
    }
  }).catch((err) => {
    console.warn("[ws] History conversion error:", err);
  });
}
```

### Step 4: Update history_page handler

```typescript
case "history_page": {
  const historyMsg = msg as Extract<RelayMessage, { type: "history_page" }>;
  const rawMessages = historyMsg.messages ?? [];
  const hasMore = historyMsg.hasMore ?? false;
  convertHistoryAsync(rawMessages, renderMarkdown).then((chatMsgs) => {
    if (chatMsgs) {
      prependMessages(chatMsgs);
      historyState.hasMore = hasMore;
      historyState.messageCount += rawMessages.length;
    }
    historyState.loading = false; // always reset, even on abort
  }).catch((err) => {
    console.warn("[ws] History page conversion error:", err);
    historyState.loading = false;
  });
  break;
}
```

**IMPORTANT:** `historyState.loading = false` must be set in both the success and abort/error paths. In the abort case (`chatMsgs === null`), the `.then()` still runs — `historyState.loading = false` is outside the `if (chatMsgs)` block.

### Step 5: Update affected history_page tests

Tests in `regression-session-switch-history.test.ts` and `regression-dual-render-duplication.test.ts` that call `handleMessage({ type: "history_page", ... })` and assert immediately need `await vi.runAllTimersAsync()` before assertions.

### Step 6: Run tests

Run: `pnpm vitest run test/unit/stores/ && pnpm check`
Expected: PASS

### Step 7: Commit

```bash
git add src/lib/frontend/stores/ws-dispatch.ts \
  test/unit/stores/async-history-conversion.test.ts \
  test/unit/stores/regression-session-switch-history.test.ts \
  test/unit/stores/regression-dual-render-duplication.test.ts
git commit -m "perf: async chunked history conversion for REST fallback path

historyToChatMessages calls in session_switched and history_page now go
through convertHistoryAsync, processing messages in chunks of 50 with
yields. Fire-and-forget from handleMessage. historyState.loading always
reset even on abort/error."
```

---

## Task 6: Full Verification

### Step 1: Run all unit tests

Run: `pnpm test:unit`
Expected: PASS

### Step 2: Run type check and lint

Run: `pnpm check && pnpm lint`
Expected: PASS

### Step 3: Build and verify manifest

Run: `pnpm build && pnpm vitest run test/build/manifest-icons.test.ts`
Expected: PASS, manifest icons resolve correctly

### Step 4: Manual verification

1. Open conduit in browser
2. Switch between sessions with large histories
3. Verify: no `[Violation]` messages in console
4. Verify: no manifest icon errors in console
5. Verify: messages appear progressively (raw text → rendered markdown)
6. Verify: rapid session switching doesn't corrupt state

### Step 5: Commit any remaining fixes

```bash
git add -u
git commit -m "test: final verification and cleanup"
```
