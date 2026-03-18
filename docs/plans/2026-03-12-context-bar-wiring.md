# Context Bar Wiring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing context bar UI to live data so the mini-bar and info panels display real context window usage, token counts, and cost.

**Architecture:** The OpenCode `/provider` API already returns `limit.context` and `limit.output` per model. The relay strips this at the handler layer. Per-turn usage data (`result` messages) already flows to the frontend but only populates inline result bars. The fix threads model limits through the shared types, creates a `usageState` store to accumulate per-session usage, and wires both the context mini-bar and InfoPanels to derive from this store + model metadata.

**Tech Stack:** TypeScript, Svelte 5 ($state/$derived), existing relay handler and store patterns.

---

## Root Cause Summary

1. `updateContextPercent()` (`ui.svelte.ts:319`) is defined but has zero runtime call sites.
2. `<InfoPanels />` is rendered without props (`ChatLayout.svelte:420`).
3. `handleGetModels()` (`model.ts:25-33`) strips `limit` and `cost` from the provider API response.
4. No store accumulates per-session usage from `result` messages.

## Design Decisions

- **InfoPanels reads from stores directly** (not props). This matches how InputArea reads `uiState.contextPercent` directly. Props remain optional for stories/tests but the runtime path uses stores.
- **New `usageState` store** accumulates cost/tokens per session, resets on session switch.
- **Context percent is derived** from `usageState.inputTokens` / active model's `limit.context`.
- **`cost` passthrough** is included since it's already typed in `ModelInfo` but never populated.

---

### Task 1: Pass `limit` and `cost` through the model handler

**Files:**
- Modify: `src/lib/instance/opencode-client.ts:68-76` (Provider interface)
- Modify: `src/lib/shared-types.ts:113-119` (ModelInfo interface)
- Modify: `src/lib/handlers/model.ts:25-33` (handleGetModels mapping)
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Write the failing test**

Add a test to `test/unit/handlers/handlers-model.test.ts` that asserts `model_list` providers include `limit` and `cost` when present in the raw provider data.

```ts
it("includes limit and cost in model_list", async () => {
  mockClient.listProviders.mockResolvedValue({
    providers: [{
      id: "anthropic", name: "Anthropic",
      models: [{
        id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200000, output: 16384 },
      }],
    }],
    defaults: {},
    connected: ["anthropic"],
  });
  await handleGetModels(deps, "c1", {});
  const sent = mockWs.sendTo.mock.calls.find(
    (c) => (c[1] as { type: string }).type === "model_list",
  );
  expect(sent).toBeDefined();
  const model = (sent![1] as { providers: Array<{ models: Array<Record<string, unknown>> }> })
    .providers[0].models[0];
  expect(model.limit).toEqual({ context: 200000, output: 16384 });
  expect(model.cost).toEqual({ input: 3, output: 15 });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts --reporter=verbose`
Expected: FAIL — `limit` and `cost` are not present on the model object.

**Step 3: Update types and handler**

In `src/lib/instance/opencode-client.ts`, add `limit` and `cost` to the `Provider` model type:

```ts
export interface Provider {
  id: string;
  name: string;
  models?: Array<{
    id: string;
    name: string;
    variants?: Record<string, Record<string, unknown>>;
    cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
    limit?: { context?: number; output?: number };
  }>;
}
```

In `src/lib/shared-types.ts`, add `limit` to `ModelInfo`:

```ts
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  variants?: string[];
}
```

In `src/lib/handlers/model.ts`, pass `limit` and `cost` through in the `handleGetModels` mapping (lines 25-33):

```ts
models: (p.models ?? []).map((m) => ({
  id: m.id,
  name: m.name || m.id,
  provider: p.id || p.name || "",
  ...(m.cost && { cost: { input: m.cost.input, output: m.cost.output } }),
  ...(m.limit && { limit: { context: m.limit.context, output: m.limit.output } }),
  ...(m.variants &&
    Object.keys(m.variants).length > 0 && {
      variants: Object.keys(m.variants),
    }),
})),
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
feat: pass model limit and cost through to frontend
```

---

### Task 2: Create usage store

**Files:**
- Create: `src/lib/frontend/stores/usage.svelte.ts`
- Test: `test/unit/stores/usage-store.test.ts`

**Step 1: Write the failing test**

Create `test/unit/stores/usage-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  usageState,
  accumulateResult,
  clearUsageState,
} from "../../src/lib/frontend/stores/usage.svelte.js";

describe("usage store", () => {
  beforeEach(() => {
    clearUsageState();
  });

  it("starts with zero values", () => {
    expect(usageState.totalCost).toBe(0);
    expect(usageState.totalInputTokens).toBe(0);
    expect(usageState.totalOutputTokens).toBe(0);
    expect(usageState.turns).toBe(0);
  });

  it("accumulates result data", () => {
    accumulateResult({ cost: 0.05, inputTokens: 1000, outputTokens: 500, cacheRead: 200, cacheWrite: 100 });
    expect(usageState.totalCost).toBe(0.05);
    expect(usageState.totalInputTokens).toBe(1000);
    expect(usageState.totalOutputTokens).toBe(500);
    expect(usageState.totalCacheRead).toBe(200);
    expect(usageState.totalCacheWrite).toBe(100);
    expect(usageState.turns).toBe(1);
  });

  it("accumulates across multiple results", () => {
    accumulateResult({ cost: 0.05, inputTokens: 1000, outputTokens: 500 });
    accumulateResult({ cost: 0.03, inputTokens: 2000, outputTokens: 800 });
    expect(usageState.totalCost).toBeCloseTo(0.08);
    expect(usageState.totalInputTokens).toBe(3000);
    expect(usageState.totalOutputTokens).toBe(1300);
    expect(usageState.turns).toBe(2);
  });

  it("clearUsageState resets everything", () => {
    accumulateResult({ cost: 0.05, inputTokens: 1000, outputTokens: 500 });
    clearUsageState();
    expect(usageState.totalCost).toBe(0);
    expect(usageState.totalInputTokens).toBe(0);
    expect(usageState.turns).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/usage-store.test.ts --reporter=verbose`
Expected: FAIL — module not found.

**Step 3: Implement the store**

Create `src/lib/frontend/stores/usage.svelte.ts`:

```ts
// ─── Usage Store ─────────────────────────────────────────────────────────────
// Accumulates per-session usage from result messages.
// Resets on session switch. Drives InfoPanels and context mini-bar.

export const usageState = $state({
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  turns: 0,
});

export interface ResultAccumulation {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Accumulate a single result turn's data. */
export function accumulateResult(data: ResultAccumulation): void {
  usageState.totalCost += data.cost ?? 0;
  usageState.totalInputTokens += data.inputTokens ?? 0;
  usageState.totalOutputTokens += data.outputTokens ?? 0;
  usageState.totalCacheRead += data.cacheRead ?? 0;
  usageState.totalCacheWrite += data.cacheWrite ?? 0;
  usageState.turns += 1;
}

/** Clear all usage state (for session switch). */
export function clearUsageState(): void {
  usageState.totalCost = 0;
  usageState.totalInputTokens = 0;
  usageState.totalOutputTokens = 0;
  usageState.totalCacheRead = 0;
  usageState.totalCacheWrite = 0;
  usageState.turns = 0;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/stores/usage-store.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
feat: add usage store for per-session token/cost accumulation
```

---

### Task 3: Wire `handleResult` to accumulate usage + update context percent

**Files:**
- Modify: `src/lib/frontend/stores/chat.svelte.ts` (handleResult)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (or chat.svelte.ts — wherever the wiring fits)
- Test: `test/unit/stores/usage-store.test.ts` (extend)

**Step 1: Write the failing test**

Extend the usage store test to verify that importing and calling `accumulateResult` from `handleResult` works. Or more precisely, write an integration-style test in the chat store tests that verifies `handleResult` updates `usageState`.

Since `handleResult` is in `chat.svelte.ts`, the simplest approach is to call `accumulateResult` at the end of `handleResult`. Add a test:

```ts
it("handleResult also accumulates usage", () => {
  clearUsageState();
  handleResult({
    type: "result",
    usage: { input: 5000, output: 2000, cache_read: 500, cache_creation: 100 },
    cost: 0.10,
    duration: 3.5,
    sessionId: "ses_123",
  });
  expect(usageState.totalInputTokens).toBe(5000);
  expect(usageState.totalOutputTokens).toBe(2000);
  expect(usageState.totalCost).toBeCloseTo(0.10);
  expect(usageState.turns).toBe(1);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/stores/usage-store.test.ts --reporter=verbose`
Expected: FAIL — `handleResult` doesn't update `usageState`.

**Step 3: Add `accumulateResult` call to `handleResult`**

In `src/lib/frontend/stores/chat.svelte.ts`, import `accumulateResult` and call it inside `handleResult`. The call should happen only for NEW result messages (not dedup updates). Add it at the point where a new `ResultMessage` is appended (around line 348, before the array assignment):

```ts
import { accumulateResult } from "./usage.svelte.js";

// Inside handleResult, in the "new result" branch (after the dedup guard):
accumulateResult({
  cost,
  inputTokens: usage?.input,
  outputTokens: usage?.output,
  cacheRead: usage?.cache_read,
  cacheWrite: usage?.cache_creation,
});
```

**Important:** Do NOT accumulate in the dedup branch (when `lastMsg?.type === "result"` and we update in place). Only accumulate on the first result for a turn.

**Step 4: Also update `contextPercent` via the active model's limit**

In the same `handleResult` function (or in a separate derived effect), compute context percent. The simplest approach: after accumulating, compute the percent from the discovery store's active model limit:

```ts
import { getActiveModel } from "./discovery.svelte.js";
import { updateContextPercent } from "./ui.svelte.js";

// After accumulateResult call:
const model = getActiveModel();
const windowSize = model?.limit?.context;
if (windowSize && windowSize > 0) {
  const percent = Math.min(100, Math.round((usageState.totalInputTokens / windowSize) * 100));
  updateContextPercent(percent);
}
```

**Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/stores/usage-store.test.ts --reporter=verbose`
Expected: PASS

**Step 6: Commit**

```
feat: wire handleResult to accumulate usage and update context percent
```

---

### Task 4: Wire InfoPanels to read from stores

**Files:**
- Modify: `src/lib/frontend/components/overlays/InfoPanels.svelte`
- Test: existing stories verify visual output

**Step 1: Import stores and derive data**

In `InfoPanels.svelte`, import the usage store and discovery store. Derive `usageData` and `contextData` from stores when props are not provided:

```ts
import { usageState } from "../../stores/usage.svelte.js";
import { getActiveModel } from "../../stores/discovery.svelte.js";

// Keep existing props for stories/tests, but fall back to stores:
const effectiveUsageData = $derived(usageData ?? {
  cost: usageState.totalCost,
  inputTokens: usageState.totalInputTokens,
  outputTokens: usageState.totalOutputTokens,
  cacheRead: usageState.totalCacheRead,
  cacheWrite: usageState.totalCacheWrite,
  turns: usageState.turns,
});

const activeModel = $derived(getActiveModel());

const effectiveContextData = $derived(contextData ?? {
  usedTokens: usageState.totalInputTokens,
  windowSize: activeModel?.limit?.context,
  maxOutput: activeModel?.limit?.output,
  model: activeModel?.name ?? activeModel?.id,
  cost: usageState.totalCost,
  turns: usageState.turns,
});
```

**Step 2: Replace template references**

Replace all `usageData?.` references with `effectiveUsageData?.` and `contextData?.` with `effectiveContextData?.`. Update the `contextPercent` derived to use `effectiveContextData`.

**Step 3: Run type check and stories**

Run: `pnpm check`
Run: `pnpm storybook` (manual verification that stories still work with explicit props)

**Step 4: Commit**

```
feat: wire InfoPanels to read from usage and discovery stores
```

---

### Task 5: Clear usage on session switch

**Files:**
- Modify: `src/lib/frontend/components/layout/ChatLayout.svelte` (resetProjectUI path)

**Step 1: Add clearUsageState to the session-switch cleanup**

In `ChatLayout.svelte`, the `$effect` at line 230 calls `resetProjectUI()`, `clearMessages()`, etc. on project switch. Add `clearUsageState()` to this sequence:

```ts
import { clearUsageState } from "../../stores/usage.svelte.js";

// Inside the untrack() block (around line 244-253):
clearUsageState();
```

Also add `clearUsageState()` inside `resetProjectUI()` in `ui.svelte.ts` for belt-and-suspenders safety (or just call it from ChatLayout — pick one canonical location).

**Step 2: Also clear on session switch within a project**

When a user switches sessions within the same project (via `view_session`), the messages are cleared. Usage should also be cleared. Check `ws-dispatch.ts` for the `session_switched` handler — if `clearMessages()` is called there, also call `clearUsageState()`.

**Step 3: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

**Step 4: Commit**

```
feat: clear usage state on session and project switch
```

---

### Task 6: Full verification

**Step 1: Run full verification suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 2: Manual smoke test**

1. Open the relay UI in a browser
2. Start a conversation — after the first assistant response, the context mini-bar should appear in the input area
3. Click the context indicator in the header — the context panel should show real token counts, window size, model name, cost
4. Switch sessions — usage should reset to 0
5. Switch back — new messages should accumulate fresh

**Step 3: Commit any fixes from verification**

---

## Files Changed Summary

| File | Change |
|------|--------|
| `src/lib/instance/opencode-client.ts` | Add `cost`, `limit` to Provider model type |
| `src/lib/shared-types.ts` | Add `limit` to `ModelInfo` |
| `src/lib/handlers/model.ts` | Pass `cost` and `limit` through in handler |
| `src/lib/frontend/stores/usage.svelte.ts` | **New** — accumulates per-session usage |
| `src/lib/frontend/stores/chat.svelte.ts` | Call `accumulateResult` + `updateContextPercent` in `handleResult` |
| `src/lib/frontend/components/overlays/InfoPanels.svelte` | Derive data from stores when props not provided |
| `src/lib/frontend/components/layout/ChatLayout.svelte` | Clear usage on project switch |
| `test/unit/handlers/handlers-model.test.ts` | Test limit/cost passthrough |
| `test/unit/stores/usage-store.test.ts` | **New** — tests for usage store |
