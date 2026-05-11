# Claude Subscription Detection + 1M Context Window Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Detect the user's Claude subscription tier (Max / Pro / Free / Enterprise / Team) from the SDK probe, and add a per-session 1M-context-window option for Sonnet 4 / 4.5 models. Premium-plan users (Max / Enterprise / Team) get 1M as the default; everyone else can still opt into 1M manually. When the user picks 1M, the `claude-adapter` passes the `context-1m-2025-08-07` beta header to the SDK.

**Architecture:** Extends the probe + TTL cache shipped in PR 1 (`2026-05-11-claude-capabilities-probe.md`). The probe now reads `init.account?.subscriptionType` alongside the model list. A hardcoded per-family `CONTEXT_WINDOW_OPTIONS_BY_FAMILY` map declares which models offer a 1M context option (Sonnet 4/4.5 today). A new `adjustModelsForSubscription()` flips the option's `isDefault` flag for premium tiers. Each `ModelInfo` gains a `contextWindowOptions?: ContextWindowOption[]` field. A new `ContextWindowSelector.svelte` Svelte component renders the dropdown next to `ModelVariant.svelte`. A new `switch_context_window` WebSocket message + `handleSwitchContextWindow` handler updates the per-session override (in `session-overrides`). On each `sendTurn`, `claude-adapter.ts` reads the per-session context-window override and, if `"1m"`, adds `betas: ["context-1m-2025-08-07"]` to the SDK options.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`betas` option at `sdk.d.ts:1285`, `AccountInfo.subscriptionType` at `sdk.d.ts:23`), Svelte 5, Vitest.

**Depends on:** `2026-05-11-claude-capabilities-probe.md` (PR 1). All probe / cache / effort plumbing is assumed in place. This PR adds NEW fields to existing types; it does not refactor PR 1's work.

---

## Why this PR exists in this shape

Two findings from PR 1's investigation drove the split:

- **SDK does not expose context windows per model in any free pre-turn API.** We accept hardcoding the option list per family, just like t3code does. New context-window options ship as code changes, not data discovery.
- **SDK DOES expose `subscriptionType`** via `init.account?.subscriptionType` (free, captured by the same probe). t3code uses it; we copy their pattern verbatim.

t3code's reference implementation (`apps/server/src/provider/Layers/ClaudeProvider.ts`) — already audited in PR 1 — defines the canonical set of premium subscription types and the "flip 1M to default" transformation. We port that directly.

## Why a separate dropdown (not a unified picker)

User decision: context window and effort are independent concerns and get separate UI controls. t3code does the same (`reasoningEffortLevels` and `contextWindowOptions` are sibling fields on its `ModelCapabilities`).

In conduit:

- `ModelVariant.svelte` continues to render the effort dropdown (effort levels remain in `ModelInfo.variants`).
- A new `ContextWindowSelector.svelte` renders next to it, reading from `ModelInfo.contextWindowOptions`.
- A new session override field `contextWindow` stores the selection per session.

## Premium subscription set

Copied verbatim from t3code's `ClaudeProvider.ts`:

```typescript
const PREMIUM_SUBSCRIPTION_TYPES = new Set([
  "max", "maxplan", "max5", "max20", "enterprise", "team",
]);
```

`subscriptionType` is normalized (`lowercase`, strip `[\s_-]`) before lookup. `pro` and `free` are NOT premium → 200k stays the default but 1M is still selectable.

## Context window options by model family

Hardcoded. Source: Anthropic docs (`docs.anthropic.com/en/docs/about-claude/models/overview`) and the SDK's beta-feature note at `sdk.d.ts:1281`.

```typescript
const CONTEXT_WINDOW_OPTIONS_BY_FAMILY: Record<string, ContextWindowOption[]> = {
  sonnet: [
    { value: "200k", label: "200K", isDefault: true },
    { value: "1m", label: "1M (beta)" },
  ],
  // Opus and Haiku get no options field — single 200k window, no UI dropdown
};
```

If a model id doesn't match any family entry, `contextWindowOptions` is omitted → the frontend hides the dropdown for that model. Same convention as the effort dropdown.

---

## Tasks

### Task 1: Extend `ProbeResult` with `subscriptionType` and per-model `contextWindowOptions`

**Files:**
- Modify: `src/lib/provider/claude/claude-capabilities-probe.ts` (existing from PR 1)
- Modify: `src/lib/provider/types.ts` (extend `ModelInfo`)
- Modify: existing probe tests in `test/unit/provider/claude/claude-capabilities-probe.test.ts`

**Step 1: Add `ContextWindowOption` + extend `ModelInfo`**

Open `src/lib/provider/types.ts` and locate the existing `ModelInfo` interface. Add:

```typescript
/** A user-selectable context-window option, e.g. 200k vs 1m. */
export interface ContextWindowOption {
	readonly value: string;
	readonly label: string;
	readonly isDefault?: boolean;
}

export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly providerId: string;
	readonly limit?: { context?: number; output?: number };
	readonly variants?: Record<string, Record<string, unknown>>;
	/**
	 * Optional per-model context-window selector entries. When present and
	 * non-empty, the UI renders a dropdown alongside the effort picker. The
	 * entry marked `isDefault: true` is selected when the user has no
	 * persisted override.
	 */
	readonly contextWindowOptions?: readonly ContextWindowOption[];
}
```

**Step 2: Write the failing tests**

Add to `test/unit/provider/claude/claude-capabilities-probe.test.ts` (inside the existing `describe`):

```typescript
it("captures subscriptionType from init.account", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
			account: { subscriptionType: "Max" },
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.subscriptionType).toBe("Max");
});

it("leaves subscriptionType undefined when account is absent", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.subscriptionType).toBeUndefined();
});

it("adds contextWindowOptions for Sonnet family", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [
				{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" },
				{ value: "claude-opus-4-7", displayName: "Opus 4.7" },
				{ value: "claude-haiku-4-7", displayName: "Haiku 4.7" },
			],
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	const sonnet = result.models.find((m) => m.id === "claude-sonnet-4-7");
	const opus = result.models.find((m) => m.id === "claude-opus-4-7");
	const haiku = result.models.find((m) => m.id === "claude-haiku-4-7");
	expect(sonnet?.contextWindowOptions).toEqual([
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M (beta)" },
	]);
	expect(opus?.contextWindowOptions).toBeUndefined();
	expect(haiku?.contextWindowOptions).toBeUndefined();
});

it("flips 1m default for premium subscriptions", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
			account: { subscriptionType: "max" },
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	const sonnet = result.models[0];
	expect(sonnet?.contextWindowOptions).toEqual([
		{ value: "200k", label: "200K" },
		{ value: "1m", label: "1M (beta)", isDefault: true },
	]);
});

it("keeps 200k default for non-premium subscriptions", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
			account: { subscriptionType: "Pro" },
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.models[0]?.contextWindowOptions?.[0]).toMatchObject({
		value: "200k",
		isDefault: true,
	});
	expect(result.models[0]?.contextWindowOptions?.[1]).toMatchObject({
		value: "1m",
	});
	expect(result.models[0]?.contextWindowOptions?.[1]?.isDefault).toBeUndefined();
});

it.each(["max", "maxplan", "max5", "max20", "enterprise", "team", "MAX", "Max Plan"])(
	"recognises %s as premium",
	async (sub) => {
		const queryFactory = vi.fn().mockReturnValue({
			initializationResult: async () => ({
				models: [{ value: "claude-sonnet-4-7", displayName: "Sonnet 4.7" }],
				account: { subscriptionType: sub },
			}),
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		const onem = result.models[0]?.contextWindowOptions?.find(
			(o) => o.value === "1m",
		);
		expect(onem?.isDefault).toBe(true);
	},
);
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: all the new tests FAIL (subscriptionType field not on ProbeResult; contextWindowOptions not on ModelInfo result).

**Step 3: Implement — modify `claude-capabilities-probe.ts`**

Inside the existing file:

1. Update `ProbeResult`:
   ```typescript
   export interface ProbeResult {
   	readonly models: ReadonlyArray<ModelInfo>;
   	readonly subscriptionType?: string;
   }
   ```

2. Add the family map + helpers near the existing `OUTPUT_LIMIT_BY_FAMILY`:

   ```typescript
   const CONTEXT_WINDOW_OPTIONS_BY_FAMILY: Record<
   	string,
   	ReadonlyArray<ContextWindowOption>
   > = {
   	sonnet: [
   		{ value: "200k", label: "200K", isDefault: true },
   		{ value: "1m", label: "1M (beta)" },
   	],
   };

   function familyFor(modelId: string): "opus" | "sonnet" | "haiku" | undefined {
   	if (/^(?:claude-)?opus/i.test(modelId)) return "opus";
   	if (/^(?:claude-)?sonnet/i.test(modelId)) return "sonnet";
   	if (/^(?:claude-)?haiku/i.test(modelId)) return "haiku";
   	return undefined;
   }

   function contextWindowOptionsFor(
   	modelId: string,
   ): ReadonlyArray<ContextWindowOption> | undefined {
   	const fam = familyFor(modelId);
   	if (!fam) return undefined;
   	return CONTEXT_WINDOW_OPTIONS_BY_FAMILY[fam];
   }

   const PREMIUM_SUBSCRIPTION_TYPES = new Set([
   	"max",
   	"maxplan",
   	"max5",
   	"max20",
   	"enterprise",
   	"team",
   ]);

   function isPremium(subscriptionType: string | undefined): boolean {
   	if (!subscriptionType) return false;
   	const normalized = subscriptionType.toLowerCase().replace(/[\s_-]+/g, "");
   	return PREMIUM_SUBSCRIPTION_TYPES.has(normalized);
   }

   function adjustForSubscription(
   	options: ReadonlyArray<ContextWindowOption> | undefined,
   	subscriptionType: string | undefined,
   ): ReadonlyArray<ContextWindowOption> | undefined {
   	if (!options) return undefined;
   	if (!isPremium(subscriptionType)) return options;
   	return options.map((opt) =>
   		opt.value === "1m"
   			? { value: opt.value, label: opt.label, isDefault: true }
   			: { value: opt.value, label: opt.label },
   	);
   }
   ```

3. Update `sdkModelToConduit` to take `subscriptionType` and include `contextWindowOptions`:

   ```typescript
   function sdkModelToConduit(
   	sdk: SDKModelInfoSubset,
   	subscriptionType: string | undefined,
   ): ModelInfo {
   	const limit = inferLimits(sdk.value);
   	const variants = effortLevelsToVariants(sdk.supportedEffortLevels);
   	const contextWindowOptions = adjustForSubscription(
   		contextWindowOptionsFor(sdk.value),
   		subscriptionType,
   	);
   	return {
   		id: sdk.value,
   		name: sdk.displayName,
   		providerId: "claude",
   		...(limit ? { limit } : {}),
   		...(variants ? { variants } : {}),
   		...(contextWindowOptions ? { contextWindowOptions } : {}),
   	};
   }
   ```

4. Update `probeClaudeCapabilities` to read account and pass subscription through:

   ```typescript
   const init = await q.initializationResult();
   const subscriptionType = init.account?.subscriptionType;
   const models = (init.models ?? []).map((sdk) =>
   	sdkModelToConduit(sdk, subscriptionType),
   );
   return {
   	models,
   	...(subscriptionType ? { subscriptionType } : {}),
   };
   ```

Add `ContextWindowOption` to the type imports at the top of the file.

**Step 4: Run tests to verify they pass**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: PASS (all previous + new tests).

**Step 5: Commit**

```bash
git add src/lib/provider/types.ts src/lib/provider/claude/claude-capabilities-probe.ts test/unit/provider/claude/claude-capabilities-probe.test.ts
git commit -m "feat(claude): capture subscriptionType + add 1M context option for Sonnet"
```

---

### Task 2: Forward `contextWindowOptions` through model_list payload

**Files:**
- Modify: `src/lib/handlers/model.ts:80-97` (Claude merge block)
- Modify: `src/lib/bridges/client-init.ts:352-362` (mirrored block)
- Modify: `src/lib/shared-types.ts` if the `model_list` WS message has a hand-written shape (verify before adding)

**Step 1: Write the failing test**

Add to (or create) `test/unit/handlers/model-context-window.test.ts`:

```typescript
it("includes contextWindowOptions on Claude entries in model_list", async () => {
	// Mock orchestration engine to return Claude caps with options.
	const claudeCaps = {
		models: [
			{
				id: "claude-sonnet-4-7",
				name: "Sonnet 4.7",
				providerId: "claude",
				contextWindowOptions: [
					{ value: "200k", label: "200K", isDefault: true },
					{ value: "1m", label: "1M (beta)" },
				],
			},
		],
		// ...other AdapterCapabilities fields...
	};
	// ...invoke handleGetModels with the existing handler test harness...

	const claudeProvider = /* extracted from wsHandler.sendTo */;
	const sonnet = claudeProvider.models.find((m) => m.id === "claude-sonnet-4-7");
	expect(sonnet.contextWindowOptions).toEqual([
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M (beta)" },
	]);
});
```

(Re-use the harness conventions from PR 1's `model-variants-claude.test.ts` once it lands.)

**Step 2: Modify `model.ts` Claude merge block**

In the existing block (lines 86-96 prior to PR 1, with `variants` spread added by PR 1):

```typescript
				providers.push({
					id: "claude",
					name: "Anthropic - claude",
					configured: true,
					models: engineResult.right.models.map((m) => ({
						id: m.id,
						name: m.name,
						provider: "claude",
						...(m.limit ? { limit: m.limit } : {}),
						...(m.variants && Object.keys(m.variants).length > 0
							? { variants: Object.keys(m.variants) }
							: {}),
						...(m.contextWindowOptions && m.contextWindowOptions.length > 0
							? { contextWindowOptions: m.contextWindowOptions }
							: {}),
					})),
				});
```

**Step 3: Apply the identical change to `bridges/client-init.ts`**

Add the same `contextWindowOptions` spread in the Claude merge block around lines 352-362.

**Step 4: Run tests**

```bash
pnpm test:unit -- test/unit/handlers test/unit/bridges
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/handlers/model.ts src/lib/bridges/client-init.ts test/unit/handlers/model-context-window.test.ts
git commit -m "feat(handlers): forward Claude contextWindowOptions in model_list payload"
```

---

### Task 3: Per-session context-window override + WebSocket plumbing

**Files:**
- Modify: `src/lib/session/session-overrides.ts` (add `contextWindow` field + getter/setter)
- Modify: `src/lib/effect/session-overrides-state.ts` (Effect-layer twin of above)
- Modify: `src/lib/handlers/payloads.ts` (add `switch_context_window` payload type)
- Modify: `src/lib/handlers/payload-schemas.ts` (add Effect Schema)
- Modify: `src/lib/handlers/index.ts` (register handler)
- Create: `src/lib/handlers/context-window.ts` (the new handler, modeled on `switch_variant`)
- Modify: `src/lib/shared-types.ts` (add `context_window_info` WS message and `switch_context_window` to `RelayMessage` union)
- Test: `test/unit/handlers/switch-context-window.test.ts`

**Step 1: Write the failing test**

`test/unit/handlers/switch-context-window.test.ts`:

```typescript
it("persists contextWindow per session and echoes context_window_info", async () => {
	// Active session model is claude-sonnet-4-7.
	// ...set up the Effect handler harness used in switch-variant.test.ts...

	await runHandleSwitchContextWindow({ contextWindow: "1m", clientId: "test" });

	expect(overrides.getContextWindow("session-id")).toBe("1m");
	const msg = /* captured wsHandler.sendToSession call */;
	expect(msg.type).toBe("context_window_info");
	expect(msg.contextWindow).toBe("1m");
	expect(msg.options).toEqual([
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M (beta)" },
	]);
});

it("rejects an unsupported context window for the active model", async () => {
	// Active model is claude-haiku-4-7 (no contextWindowOptions).
	await runHandleSwitchContextWindow({ contextWindow: "1m", clientId: "test" });
	// Either no-op or send an error — assert chosen behaviour.
	expect(overrides.getContextWindow("session-id")).toBe(""); // unchanged
});
```

**Step 2: Add `contextWindow` to session overrides**

In `src/lib/session/session-overrides.ts`, mirror the existing `variant` field exactly: add `setContextWindow(sessionId, value)`, `getContextWindow(sessionId): string`, and persist alongside other per-session settings. Default = empty string (= use the model's default option).

In `src/lib/effect/session-overrides-state.ts`, add the equivalent Effect-layer functions.

**Step 3: Register the handler**

In `src/lib/handlers/payloads.ts`:

```typescript
	switch_context_window: { contextWindow: string };
```

In `src/lib/handlers/payload-schemas.ts`:

```typescript
	switch_context_window: Schema.Struct({
		contextWindow: Schema.String,
	}),
```

In `src/lib/handlers/index.ts` register:

```typescript
	switch_context_window: handleSwitchContextWindowImpl,
```

Create `src/lib/handlers/context-window.ts`. Model it directly on `handleSwitchVariantImpl` (the Claude-aware version from PR 1's Task 7), but:

- Calls `overrides.setContextWindow(sessionId, payload.contextWindow)` instead of `setVariant`.
- Looks up the active model's `contextWindowOptions` from the orchestration engine's Claude probe.
- Validates `payload.contextWindow` is in the options list; if not, no-op (or send an error event — the test asserts whichever behaviour you implement).
- Sends `{ type: "context_window_info", contextWindow, options }` back to the session.

**Step 4: Add `context_window_info` to `shared-types.ts`**

Add to the `RelayMessage` union:

```typescript
	| {
			type: "context_window_info";
			contextWindow: string;
			options: ReadonlyArray<ContextWindowOption>;
	  }
```

Add `switch_context_window` to client → server messages.

**Step 5: Run tests**

```bash
pnpm test:unit -- test/unit/handlers/switch-context-window.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/session/session-overrides.ts src/lib/effect/session-overrides-state.ts src/lib/handlers/payloads.ts src/lib/handlers/payload-schemas.ts src/lib/handlers/index.ts src/lib/handlers/context-window.ts src/lib/shared-types.ts test/unit/handlers/switch-context-window.test.ts
git commit -m "feat(handlers): add switch_context_window + context_window_info messages"
```

---

### Task 4: Pass selected context window to SDK via `betas` header

**Files:**
- Modify: `src/lib/provider/types.ts` (extend `SendTurnInput` with `contextWindow?: string`)
- Modify: `src/lib/handlers/prompt.ts` (populate `contextWindow` from session override, around line 248)
- Modify: `src/lib/provider/claude/claude-adapter.ts:395-404` (build SDK options with `betas`)
- Test: `test/unit/provider/claude/claude-adapter-send-turn.test.ts` (add coverage)

**Step 1: Add `contextWindow` to `SendTurnInput`**

In `src/lib/provider/types.ts`, after the existing `variant?: string` field:

```typescript
	readonly contextWindow?: string;
```

**Step 2: Populate from session overrides in `prompt.ts`**

Mirror the existing `variant` pattern (lines 108-109 and 248):

```typescript
const contextWindow = overrides.getContextWindow(activeId);
// ...later, in the SendTurnInput construction:
		...(contextWindow ? { contextWindow } : {}),
```

**Step 3: Write the failing test in `claude-adapter-send-turn.test.ts`**

```typescript
it("passes betas: ['context-1m-2025-08-07'] when contextWindow is '1m'", async () => {
	const capturedOptions: unknown[] = [];
	const fakeQuery = makeFakeQueryFactory({
		onCall: (params) => capturedOptions.push(params.options),
	});
	const adapter = new ClaudeAdapter({
		workspaceRoot: tmpWorkspace,
		queryFactory: fakeQuery,
	});

	await adapter.sendTurn({
		// ...minimum SendTurnInput with...
		contextWindow: "1m",
	});

	const opts = capturedOptions[0] as { betas?: string[] };
	expect(opts.betas).toContain("context-1m-2025-08-07");
});

it("omits betas when contextWindow is '200k' or absent", async () => {
	const capturedOptions: unknown[] = [];
	const fakeQuery = makeFakeQueryFactory({
		onCall: (params) => capturedOptions.push(params.options),
	});
	const adapter = new ClaudeAdapter({
		workspaceRoot: tmpWorkspace,
		queryFactory: fakeQuery,
	});

	await adapter.sendTurn({ /* no contextWindow */ });
	await adapter.sendTurn({ contextWindow: "200k" });

	for (const opts of capturedOptions as Array<{ betas?: string[] }>) {
		expect(opts.betas ?? []).not.toContain("context-1m-2025-08-07");
	}
});
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: FAIL on the new tests.

**Step 4: Modify the SDK options builder in `claude-adapter.ts`**

Inside `createSessionAndSendTurn`, replace the existing SDK options block (now also includes the `effort` spread from PR 1):

```typescript
			const options: SDKOptions = {
				cwd: input.workspaceRoot,
				abortController,
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
				canUseTool: bridge.createCanUseTool(ctx),
				...(input.model ? { model: input.model.modelId } : {}),
				...(resumeSessionId ? { resume: resumeSessionId } : {}),
				...(input.agent ? { agent: input.agent } : {}),
				...(input.variant
					? { effort: input.variant as NonNullable<SDKOptions["effort"]> }
					: {}),
				...(input.contextWindow === "1m"
					? {
							betas: ["context-1m-2025-08-07"] as NonNullable<
								SDKOptions["betas"]
							>,
						}
					: {}),
			};
```

The literal `"context-1m-2025-08-07"` is what the SDK documents at `sdk.d.ts:1281`. If Anthropic ever rolls out a new beta header, that constant moves into a `const` near the top of the file with a comment pointing at the SDK doc location.

**Step 5: Run tests to verify pass**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/provider/types.ts src/lib/handlers/prompt.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-send-turn.test.ts
git commit -m "feat(claude): wire 1M context window via betas header"
```

---

### Task 5: Frontend — `ContextWindowSelector.svelte`

**Files:**
- Create: `src/lib/frontend/components/model/ContextWindowSelector.svelte`
- Modify: `src/lib/frontend/stores/discovery.svelte.ts` (state for current + available options)
- Modify: parent that renders `ModelVariant.svelte` to also render `ContextWindowSelector.svelte` (find via `grep -l "ModelVariant" src/lib/frontend`)

**Step 1: Add state to `discovery.svelte.ts`**

Mirror the existing variant state:

```typescript
	currentContextWindow: "" as string,
	availableContextWindowOptions: [] as ReadonlyArray<ContextWindowOption>,
```

Add an `Extract<RelayMessage, { type: "context_window_info" }>` handler:

```typescript
export function handleContextWindowInfo(
	msg: Extract<RelayMessage, { type: "context_window_info" }>,
): void {
	discoveryState.currentContextWindow = msg.contextWindow ?? "";
	discoveryState.availableContextWindowOptions = msg.options ?? [];
}
```

Add a `getActiveContextWindowOptions()` helper, mirroring `getActiveModelVariants()`.

In `clearDiscoveryState()`, reset the two new fields.

**Step 2: Wire `context_window_info` into the WS dispatcher**

Find the dispatcher that currently handles `variant_info` (likely `src/lib/frontend/stores/ws.svelte.ts` or similar — search for `handleVariantInfo`) and add a parallel branch calling `handleContextWindowInfo`.

**Step 3: Write the component**

Create `src/lib/frontend/components/model/ContextWindowSelector.svelte`. Copy `ModelVariant.svelte` and adapt:

- Read `discoveryState.availableContextWindowOptions` and `discoveryState.currentContextWindow`.
- Each option is `{ value, label, isDefault }` — show `label` in the dropdown, send `value` on selection.
- WebSocket send: `wsSend({ type: "switch_context_window", contextWindow: option.value })`.
- Update local state optimistically: `discoveryState.currentContextWindow = option.value`.
- Render only when `availableContextWindowOptions.length > 0`.
- Visual: same badge style as `ModelVariant.svelte`; place it adjacent (no Ctrl+T shortcut — keep that for effort).
- Tooltip: "Context window ({currentLabel})".

**Step 4: Render alongside `ModelVariant.svelte`**

Find the existing usage of `ModelVariant.svelte` (likely under `components/model/` or `components/input/`):

```bash
grep -rn "ModelVariant" src/lib/frontend/components
```

In that parent, add an import + render `<ContextWindowSelector />` right after `<ModelVariant />`. No mutual exclusion needed (they're independent dropdowns) but if both have open-dropdown state, pass a shared `onOpen` callback to close one when the other opens (mirroring the existing pattern between `ModelVariant` and the model picker).

**Step 5: Add a Storybook story for the new component**

Create `src/lib/frontend/components/model/ContextWindowSelector.stories.ts`, mirroring `ModelVariant`'s story file. Show empty, 200k default, 1m default (premium tier), and 1m selected variants.

**Step 6: Manual smoke check**

Run the dev server, open conduit at `http://localhost:2633/`, select a Sonnet 4/4.5 model in a Claude project, confirm the context-window dropdown appears with "200K" default and "1M (beta)" as the second option. Pick 1M, send a prompt, confirm the daemon log shows `betas: [context-1m-2025-08-07]` (add a temporary log line in `claude-adapter.ts` if needed and remove before commit).

**Step 7: Commit**

```bash
git add src/lib/frontend
git commit -m "feat(frontend): add ContextWindowSelector for Claude 1M opt-in"
```

---

### Task 6: Regression + verification gate

**Step 1: Run the typecheck / lint / unit / full test suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Expected: clean (modulo the pre-existing EADDRINUSE flake).

**Step 2: Check that the existing effort dropdown still works**

Run the visual / e2e tests that cover variant selection — at minimum:

```bash
pnpm test:unit -- test/unit/handlers/switch-variant.test.ts
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: PASS.

**Step 3: Final commit (if anything trailed)**

```bash
git add -A
git commit -m "chore: lint/format cleanup after context-window work"
```

---

## Out of scope (do NOT include in this PR)

- **PR 3: SDK-sourced commands + agents with provider tagging** — `docs/plans/2026-05-11-claude-commands-agents-merge.md`.
- **Auto-PR workflow** to refresh hardcoded context-window options from LiteLLM.
- **Other beta headers** beyond `context-1m-2025-08-07`. The SDK's `betas` field is generic, but only the 1M context flag is in scope here.
- **Subscription tier indicator in UI** (e.g. a "Max Plan" badge somewhere). The `subscriptionType` is captured by the probe but not yet surfaced visually. Trivial follow-up if/when desired.
- **Adjusting model output limits based on subscription** — not exposed by SDK; no useful tier-dependent variation today.
- **Streaming the `betas` header for Opus / Haiku models** when the user has 1M selected but switches model — the per-model `contextWindowOptions` only offers 1M for Sonnet, so the UI prevents this case at the dropdown level. The adapter additionally ignores `contextWindow: "1m"` for non-Sonnet models (validate at SDK options builder if defensive coding feels warranted; default behaviour is to pass the header and let the SDK return an error if applied to an incompatible model).

## Risk register

| Risk | Mitigation |
|---|---|
| `init.account` is missing or shaped differently across SDK versions | Probe reads `init.account?.subscriptionType` defensively; missing or unrecognised values fall through to non-premium defaults (200k stays default). Tests cover the absent-account case. |
| User upgrades plan but TTL cache hasn't expired | 5-min cache window. Worst-case wait. Documented elsewhere in PR 1's risk register. |
| User on a premium plan but on a model that doesn't offer 1M (e.g. Opus, Haiku) | `contextWindowOptions` is undefined for those families → UI hides the dropdown entirely. No "default 1M but model doesn't support it" failure mode. |
| User switches between Claude and OpenCode mid-session | `contextWindow` override is Claude-only — OpenCode adapter ignores `SendTurnInput.contextWindow`. The frontend `ContextWindowSelector.svelte` hides itself unless the active model exposes `contextWindowOptions`, which OpenCode models do not. |
| Anthropic ships a new context-window option (e.g. 500K) | Hardcoded `CONTEXT_WINDOW_OPTIONS_BY_FAMILY` needs a code change. The PR that lands the new option also needs to either add a new SDK beta header constant or rename the existing one. Same maintenance footprint as the model-list family map. |
| `betas` header rejected by some Anthropic API backends (e.g. Bedrock, Vertex) | SDK doc says `betas` is supported on Anthropic first-party only. If the user is authenticated via Bedrock/Vertex (`init.account?.apiProvider !== "firstParty"`), the 1M option should be hidden. **Follow-up:** factor `apiProvider` into `contextWindowOptionsFor` similarly to `subscriptionType`. Out of scope for the first cut; document the limitation. |
| Concurrent `switch_context_window` requests race the `discover()` lookup | Same dispatch-cached pattern as PR 1's `switch_variant` handler — `discover()` reads from the TTL cache, no race risk. |
