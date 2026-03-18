# Model Default Fixes & Variant/Thinking-Level Support

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two bugs in default model persistence and add thinking-level (variant) support so the relay can set high/max thinking for models like Claude Opus 4.6.

**Architecture:** The relay currently strips model variant data from the OpenCode provider API response and has no mechanism to pass a `variant` field to OpenCode's `prompt_async` endpoint. We add variant names to the model list, variant state to session overrides, a variant selector UI next to the model selector, and pass the selected variant through to prompts.

**Tech Stack:** TypeScript, Svelte 5, Vitest, WebSocket messages

---

## Part A: Fix Default Model Persistence Bugs

### Task 1: Fix `parseDefaultModel` — strip provider prefix from modelID

**Files:**
- Modify: `src/lib/relay/relay-settings.ts:73`
- Test: `test/unit/relay/relay-settings.test.ts:78-83`

**Step 1: Update the failing test expectation**

The existing test at line 79 codifies the bug. Fix it to expect the stripped modelID:

```ts
it("splits provider/model string into ModelOverride", () => {
    expect(parseDefaultModel("anthropic/claude-opus-4-6")).toEqual({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/relay/relay-settings.test.ts --reporter=verbose`
Expected: FAIL — modelID is `"anthropic/claude-opus-4-6"` but expected `"claude-opus-4-6"`

**Step 3: Fix `parseDefaultModel` in relay-settings.ts**

Change line 73 from:
```ts
return { providerID: value.slice(0, slashIdx), modelID: value };
```
to:
```ts
return { providerID: value.slice(0, slashIdx), modelID: value.slice(slashIdx + 1) };
```

**Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- test/unit/relay/relay-settings.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
fix: parseDefaultModel now strips provider prefix from modelID
```

---

### Task 2: Fix `handleSetDefaultModel` — save as `provider/model` format

**Files:**
- Modify: `src/lib/handlers/model.ts:113`
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Add a test that verifies the saved format includes provider prefix**

Add to `handlers-model.test.ts`:

```ts
it("saves default model in provider/model format", async () => {
    const savedSettings: Array<Record<string, unknown>> = [];
    // We need to mock saveRelaySettings. Since the handler imports it directly,
    // we need to use vi.mock or verify the override was set correctly.
    // The simplest verification: check that overrides.setDefaultModel receives
    // the correct ModelOverride shape.
    const deps = createMockHandlerDeps();
    await handleSetDefaultModel(deps, "client-1", {
        provider: "anthropic",
        model: "claude-opus-4-6",
    });
    expect(deps.overrides.setDefaultModel).toHaveBeenCalledWith({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
    });
});
```

Also update the existing test at line 11 — the current test sends `model: "anthropic/claude-opus-4-6"` which is wrong (the frontend sends just the model ID without provider prefix). Change it to send `model: "claude-opus-4-6"` and expect the override to be `{ providerID: "anthropic", modelID: "claude-opus-4-6" }`.

**Step 2: Fix `handleSetDefaultModel` in model.ts**

Change line 113 from:
```ts
saveRelaySettings({ defaultModel: model }, deps.config.configDir);
```
to:
```ts
saveRelaySettings({ defaultModel: `${provider}/${model}` }, deps.config.configDir);
```

**Step 3: Run tests**

Run: `pnpm test:unit -- test/unit/handlers/handlers-model.test.ts --reporter=verbose`
Expected: PASS

**Step 4: Commit**

```
fix: save default model in provider/model format for correct round-trip
```

---

## Part B: Add Variant/Thinking-Level Support

### Task 3: Extend types to include variants

**Files:**
- Modify: `src/lib/shared-types.ts` (ModelInfo)
- Modify: `src/lib/instance/opencode-client.ts` (Provider, PromptOptions)
- Modify: `src/lib/handlers/payloads.ts` (new message type)

**Step 1: Add `variants` to `ModelInfo` in shared-types.ts**

```ts
export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    cost?: { input?: number; output?: number };
    variants?: string[];  // Available thinking-level names, e.g. ["low", "medium", "high", "max"]
}
```

**Step 2: Add `variants` to `Provider` model type in opencode-client.ts**

Update the `Provider` interface:
```ts
export interface Provider {
    id: string;
    name: string;
    models?: Array<{ id: string; name: string; variants?: Record<string, unknown> }>;
}
```

**Step 3: Add `variant` to `PromptOptions` in opencode-client.ts**

```ts
export interface PromptOptions {
    text: string;
    images?: string[];
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
}
```

**Step 4: Add `switch_variant` to PayloadMap in payloads.ts**

```ts
switch_variant: { variant: string };
```

**Step 5: Add variant messages to `RelayMessage` in shared-types.ts**

Add to the union:
```ts
| { type: "variant_info"; variant: string; variants: string[] }
```

**Step 6: Commit**

```
feat: add variant/thinking-level types to shared types and payloads
```

---

### Task 4: Pass variant data through the model list pipeline

**Files:**
- Modify: `src/lib/handlers/model.ts` (handleGetModels)
- Modify: `src/lib/bridges/client-init.ts` (provider mapping)
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Write test for variant data in model_list**

Add to `handlers-model.test.ts`:

```ts
import { handleGetModels } from "../../../src/lib/handlers/model.js";

describe("handleGetModels", () => {
    it("includes variant names in model_list", async () => {
        const sentMessages: unknown[] = [];
        const deps = createMockHandlerDeps({
            wsHandler: {
                ...createMockHandlerDeps().wsHandler,
                sendTo: vi.fn((_, msg) => sentMessages.push(msg)),
                getClientSession: vi.fn().mockReturnValue(null),
            } as unknown as HandlerDeps["wsHandler"],
            client: {
                ...createMockHandlerDeps().client,
                listProviders: vi.fn().mockResolvedValue({
                    providers: [{
                        id: "anthropic",
                        name: "Anthropic",
                        models: [{
                            id: "claude-opus-4-6",
                            name: "Claude Opus 4.6",
                            variants: { low: {}, medium: {}, high: {}, max: {} },
                        }],
                    }],
                    defaults: { anthropic: "claude-opus-4-6" },
                    connected: ["anthropic"],
                }),
            } as unknown as HandlerDeps["client"],
        });
        await handleGetModels(deps, "client-1", {});
        const modelList = sentMessages.find((m: any) => m.type === "model_list") as any;
        expect(modelList.providers[0].models[0].variants).toEqual(["low", "medium", "high", "max"]);
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/handlers/handlers-model.test.ts --reporter=verbose`

**Step 3: Update `handleGetModels` in model.ts to include variant names**

In the models mapping (line 20-24), add variant extraction:
```ts
models: (p.models ?? []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: p.id || p.name || "",
    variants: m.variants ? Object.keys(m.variants) : undefined,
})),
```

Apply the same change in `client-init.ts` (line 240-244).

**Step 4: Update `Provider` type in opencode-client.ts**

The `Object.values()` conversion for models (line 399-401) preserves extra fields since it uses spread. But the type needs updating:
```ts
models?: Array<{ id: string; name: string; variants?: Record<string, unknown> }>;
```

**Step 5: Run tests**

Run: `pnpm test:unit -- test/unit/handlers/handlers-model.test.ts --reporter=verbose`
Expected: PASS

**Step 6: Commit**

```
feat: pass variant names through model list to frontend
```

---

### Task 5: Add variant state to SessionOverrides

**Files:**
- Modify: `src/lib/session/session-overrides.ts`
- Test: `test/unit/session/session-overrides.test.ts`

**Step 1: Write tests for variant state**

Add a new describe block to `session-overrides.test.ts`:

```ts
describe("Per-Session Variant", () => {
    it("returns undefined when no variant is set", () => {
        const overrides = new SessionOverrides();
        expect(overrides.getVariant("s1")).toBeUndefined();
    });

    it("sets and gets variant for a session", () => {
        const overrides = new SessionOverrides();
        overrides.setVariant("s1", "high");
        expect(overrides.getVariant("s1")).toBe("high");
    });

    it("clears variant when set to undefined", () => {
        const overrides = new SessionOverrides();
        overrides.setVariant("s1", "high");
        overrides.setVariant("s1", undefined);
        expect(overrides.getVariant("s1")).toBeUndefined();
    });

    it("clearSession removes variant", () => {
        const overrides = new SessionOverrides();
        overrides.setVariant("s1", "max");
        overrides.clearSession("s1");
        expect(overrides.getVariant("s1")).toBeUndefined();
    });

    it("uses default variant when no per-session variant is set", () => {
        const overrides = new SessionOverrides();
        overrides.defaultVariant = "high";
        expect(overrides.getVariant("s1")).toBe("high");
    });

    it("per-session variant takes priority over default", () => {
        const overrides = new SessionOverrides();
        overrides.defaultVariant = "high";
        overrides.setVariant("s1", "max");
        expect(overrides.getVariant("s1")).toBe("max");
    });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- test/unit/session/session-overrides.test.ts --reporter=verbose`

**Step 3: Add variant state to SessionOverrides**

In `session-overrides.ts`:

Add `variant?: string` to the `SessionState` interface.

Add `defaultVariant: string | undefined = undefined;` to the class.

Add methods:
```ts
setVariant(sessionId: string, variant: string | undefined): void {
    this.getOrCreate(sessionId).variant = variant;
}

getVariant(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.variant ?? this.defaultVariant;
}
```

Also add backward-compatible shim:
```ts
/** @deprecated — use getVariant(sessionId) */
get variant(): string | undefined {
    return this.sessions.get(SessionOverrides.GLOBAL)?.variant ?? this.defaultVariant;
}
```

**Step 4: Run tests**

Run: `pnpm test:unit -- test/unit/session/session-overrides.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```
feat: add per-session variant state to SessionOverrides
```

---

### Task 6: Add variant handler and prompt integration

**Files:**
- Modify: `src/lib/handlers/model.ts` (new handler + variant info in model_info)
- Modify: `src/lib/handlers/index.ts` (register handler)
- Modify: `src/lib/handlers/prompt.ts` (include variant in prompt)
- Modify: `src/lib/instance/opencode-client.ts` (send variant in API call)
- Modify: `src/lib/server/ws-router.ts` (register message type)
- Modify: `test/helpers/mock-factories.ts` (add variant mocks)
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Write test for switch_variant handler**

```ts
describe("handleSwitchVariant", () => {
    it("sets variant and broadcasts variant_info", async () => {
        const broadcasts: unknown[] = [];
        const deps = createMockHandlerDeps({
            wsHandler: {
                ...createMockHandlerDeps().wsHandler,
                broadcast: vi.fn((msg) => broadcasts.push(msg)),
                getClientSession: vi.fn().mockReturnValue("session-1"),
                sendToSession: vi.fn((_, msg) => broadcasts.push(msg)),
            } as unknown as HandlerDeps["wsHandler"],
        });
        await handleSwitchVariant(deps, "client-1", { variant: "high" });
        expect(deps.overrides.setVariant).toHaveBeenCalledWith("session-1", "high");
    });
});
```

**Step 2: Implement `handleSwitchVariant` in model.ts**

```ts
export async function handleSwitchVariant(
    deps: HandlerDeps,
    clientId: string,
    payload: PayloadMap["switch_variant"],
): Promise<void> {
    const { variant } = payload;
    const clientSession = deps.wsHandler.getClientSession(clientId);
    const sessionId = clientSession ?? deps.sessionMgr.getActiveSessionId() ?? "";
    if (sessionId) {
        // Empty string means "clear variant" (use default)
        deps.overrides.setVariant(sessionId, variant || undefined);
        deps.log(`   [variant] client=${clientId} session=${sessionId} Set variant: ${variant || "(default)"}`);
    }
}
```

**Step 3: Register handler in index.ts**

Add `switch_variant: handleSwitchVariant as MessageHandler` to the dispatch table.

**Step 4: Register message type in ws-router.ts**

Add `"switch_variant"` to the valid message types set.

**Step 5: Update mock-factories.ts**

Add `setVariant: vi.fn()` and `getVariant: vi.fn().mockReturnValue(undefined)` and `defaultVariant: undefined` to `createMockOverrides()`.

**Step 6: Update prompt.ts to include variant**

In `handleMessage` (prompt.ts), after line 57:
```ts
const sessionId = activeId;
const variant = deps.overrides.getVariant(sessionId);
if (variant) prompt.variant = variant;
```

**Step 7: Update `sendMessageAsync` in opencode-client.ts**

After line 330:
```ts
if (prompt.variant) body["variant"] = prompt.variant;
```

**Step 8: Run tests**

Run: `pnpm test:unit -- --reporter=verbose`
Expected: PASS

**Step 9: Commit**

```
feat: add variant handler and pass variant through to OpenCode prompts
```

---

### Task 7: Add variant info to model_info flow

**Files:**
- Modify: `src/lib/handlers/model.ts` (handleGetModels, handleSwitchModel)
- Modify: `src/lib/bridges/client-init.ts`

**Step 1: Send variant_info on client connect**

In `handleGetModels` (model.ts), after sending `model_info`, also send `variant_info` with the current variant and available variants for the active model.

In `client-init.ts`, after sending `model_info` (around line 270-274), send `variant_info`:

```ts
// Send variant info to new client
const currentVariant = overrides.getVariant(activeSessionId ?? "_global");
if (currentVariant || modelVariants) {
    wsHandler.sendTo(clientId, {
        type: "variant_info",
        variant: currentVariant ?? "",
        variants: [], // Will be populated from the model list
    });
}
```

Since the variant list depends on which model is active, look up the model in the providers and extract its variant names.

**Step 2: On switch_model, clear variant if new model doesn't support it**

In `handleSwitchModel`, after setting the model, check if the current variant is still valid for the new model. If not, clear it.

**Step 3: Run tests**

Run: `pnpm test:unit -- --reporter=verbose`

**Step 4: Commit**

```
feat: send variant_info on connect and model switch
```

---

### Task 8: Frontend — variant store and message handling

**Files:**
- Modify: `src/lib/frontend/stores/discovery.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts`
- Test: `test/unit/stores/discovery.test.ts` (if exists, else skip test)

**Step 1: Add variant state to discoveryState**

```ts
export const discoveryState = $state({
    // ... existing fields ...
    currentVariant: "" as string,
    availableVariants: [] as string[],
});
```

**Step 2: Add `handleVariantInfo` message handler**

```ts
export function handleVariantInfo(
    msg: Extract<RelayMessage, { type: "variant_info" }>,
): void {
    discoveryState.currentVariant = msg.variant ?? "";
    discoveryState.availableVariants = msg.variants ?? [];
}
```

**Step 3: Add helper functions**

```ts
/** Get available variants for the active model from the model list. */
export function getActiveModelVariants(): string[] {
    const model = getActiveModel();
    return model?.variants ?? [];
}
```

**Step 4: Wire up in ws-dispatch.ts**

Add case for `"variant_info"` in the message dispatch switch.

**Step 5: Commit**

```
feat: frontend variant state management and message handling
```

---

### Task 9: Frontend — variant selector UI

**Files:**
- Modify: `src/lib/frontend/components/features/ModelSelector.svelte`

**Step 1: Add variant display and cycle button**

Add a variant indicator next to the model name in the button area. Clicking it cycles through available variants. Shows the current variant name (e.g., "high") in a styled badge.

The cycle logic matches OpenCode Web's `ctrl+t`:
- No variant → first variant → second → ... → last → no variant (loop)

```svelte
{#if variants.length > 0}
    <button
        class="variant-btn ..."
        title="Cycle thinking level (Ctrl+T)"
        onclick={cycleVariant}
    >
        {currentVariant || "default"}
    </button>
{/if}
```

**Step 2: Add keyboard shortcut**

Listen for `Ctrl+T` to cycle variant (matching OpenCode Web's keybinding).

**Step 3: Send `switch_variant` message on change**

```ts
function cycleVariant(e: MouseEvent) {
    e.stopPropagation();
    const variants = getActiveModelVariants();
    if (variants.length === 0) return;
    const current = discoveryState.currentVariant;
    if (!current) {
        sendVariant(variants[0]);
        return;
    }
    const idx = variants.indexOf(current);
    if (idx === -1 || idx === variants.length - 1) {
        sendVariant("");  // clear → use default
        return;
    }
    sendVariant(variants[idx + 1]);
}

function sendVariant(variant: string) {
    wsSend({ type: "switch_variant", variant });
    discoveryState.currentVariant = variant;  // optimistic update
}
```

**Step 4: Commit**

```
feat: variant/thinking-level selector UI with Ctrl+T cycle
```

---

### Task 10: Full integration verification

**Step 1: Run all unit tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 2: Run type checking**

Run: `pnpm tsc --noEmit`
Expected: No errors

**Step 3: Build frontend**

Run: `pnpm build:frontend`
Expected: Success

**Step 4: Final commit**

```
chore: verify all tests pass with model defaults fix and variant support
```
