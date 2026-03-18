# Variant Persistence & Flow Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist per-model variant (thinking level) preferences across relay restarts, and fix 5 gaps in the variant data flow.

**Architecture:** Add `defaultVariants: Record<string, string>` to `RelaySettings`, use load-merge-save pattern for all settings writes. Fix variant wiring in `handleSwitchModel`, `handleSetDefaultModel`, `handleGetModels`, `client-init`, and `prompt`.

**Tech Stack:** TypeScript, Vitest (TDD), `settings.jsonc` file persistence

---

### Task 1: Extend `RelaySettings` type and add helper

**Files:**
- Modify: `src/lib/relay/relay-settings.ts:12-14` (RelaySettings interface)
- Modify: `src/lib/relay/relay-settings.ts:51-61` (saveRelaySettings — must load-merge-save)
- Test: `test/unit/relay/relay-settings.test.ts`

**Step 1: Write the failing tests**

Add to `test/unit/relay/relay-settings.test.ts` inside the existing `describe("relay-settings")` block:

```typescript
describe("defaultVariants persistence", () => {
	it("saves and loads defaultVariants", () => {
		saveRelaySettings(
			{
				defaultModel: "anthropic/claude-opus-4-6",
				defaultVariants: { "anthropic/claude-opus-4-6": "high" },
			},
			tempDir,
		);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultVariants).toEqual({
			"anthropic/claude-opus-4-6": "high",
		});
	});

	it("preserves defaultVariants when saving only defaultModel", () => {
		saveRelaySettings(
			{
				defaultModel: "anthropic/claude-opus-4-6",
				defaultVariants: { "anthropic/claude-opus-4-6": "high" },
			},
			tempDir,
		);
		// Second save with only defaultModel — should merge, not overwrite
		saveRelaySettings({ defaultModel: "openai/gpt-4o" }, tempDir);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultModel).toBe("openai/gpt-4o");
		expect(settings.defaultVariants).toEqual({
			"anthropic/claude-opus-4-6": "high",
		});
	});

	it("merges new defaultVariants entries with existing", () => {
		saveRelaySettings(
			{
				defaultVariants: { "anthropic/claude-opus-4-6": "high" },
			},
			tempDir,
		);
		saveRelaySettings(
			{
				defaultVariants: { "openai/gpt-4o": "medium" },
			},
			tempDir,
		);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultVariants).toEqual({
			"anthropic/claude-opus-4-6": "high",
			"openai/gpt-4o": "medium",
		});
	});

	it("overwrites variant for same model key", () => {
		saveRelaySettings(
			{
				defaultVariants: { "anthropic/claude-opus-4-6": "high" },
			},
			tempDir,
		);
		saveRelaySettings(
			{
				defaultVariants: { "anthropic/claude-opus-4-6": "low" },
			},
			tempDir,
		);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultVariants?.["anthropic/claude-opus-4-6"]).toBe("low");
	});

	it("returns empty object for missing defaultVariants field", () => {
		saveRelaySettings({ defaultModel: "anthropic/claude-opus-4-6" }, tempDir);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultVariants).toBeUndefined();
	});

	it("round-trip: persisted variant survives restart", () => {
		saveRelaySettings(
			{
				defaultModel: "anthropic/claude-opus-4-6",
				defaultVariants: { "anthropic/claude-opus-4-6": "high" },
			},
			tempDir,
		);
		const loaded = loadRelaySettings(tempDir);
		const modelKey = loaded.defaultModel ?? "";
		expect(loaded.defaultVariants?.[modelKey]).toBe("high");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/relay/relay-settings.test.ts`
Expected: Tests fail because `defaultVariants` not in type, and `saveRelaySettings` overwrites instead of merging.

**Step 3: Implement**

In `src/lib/relay/relay-settings.ts`:

1. Add `defaultVariants` to the interface:
```typescript
export interface RelaySettings {
	defaultModel?: string;
	defaultVariants?: Record<string, string>;
}
```

2. Change `saveRelaySettings` to load-merge-save:
```typescript
export function saveRelaySettings(
	settings: RelaySettings,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	mkdirSync(dir, { recursive: true });

	// Load-merge-save: preserve existing fields not present in the new settings
	const existing = loadRelaySettings(configDir);
	const merged: RelaySettings = { ...existing };

	// Merge top-level fields (only overwrite if explicitly provided)
	if (settings.defaultModel !== undefined) {
		merged.defaultModel = settings.defaultModel;
	}

	// Merge defaultVariants map (shallow merge of entries)
	if (settings.defaultVariants) {
		merged.defaultVariants = {
			...existing.defaultVariants,
			...settings.defaultVariants,
		};
	}

	const tmpPath = join(dir, `.${SETTINGS_FILE}.tmp`);
	const finalPath = join(dir, SETTINGS_FILE);
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/relay/relay-settings.test.ts`
Expected: All tests pass including new ones.

**Step 5: Verify existing save tests still pass**

The existing `saveRelaySettings` tests pass because the merge behavior is backward-compatible — saving `{ defaultModel: "x" }` still results in `defaultModel: "x"`.

**Step 6: Commit**

```
feat: add defaultVariants to RelaySettings with load-merge-save
```

---

### Task 2: Load persisted variant on startup

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:172-177` (startup wiring)

**Step 1: No test needed** — startup wiring is integration-level. The relay-settings tests cover persistence, and the handler tests (Task 3+) cover runtime behavior.

**Step 2: Implement**

In `src/lib/relay/relay-stack.ts`, after line 177 where defaultModel is loaded:

```typescript
// Load persisted default model from relay settings
const relaySettings = loadRelaySettings(config.configDir);
const defaultModel = parseDefaultModel(relaySettings.defaultModel);
if (defaultModel) {
	overrides.setDefaultModel(defaultModel);
	log(`   ✓ Default model from settings: ${relaySettings.defaultModel}`);

	// Load persisted variant for the default model
	const modelKey = relaySettings.defaultModel;
	const defaultVariant = modelKey
		? relaySettings.defaultVariants?.[modelKey] ?? ""
		: "";
	if (defaultVariant) {
		overrides.defaultVariant = defaultVariant;
		log(`   ✓ Default variant from settings: ${defaultVariant}`);
	}
}
```

**Step 3: Commit**

```
feat: load persisted variant on relay startup
```

---

### Task 3: Unit tests for `handleSwitchVariant`

**Files:**
- Test: `test/unit/handlers/handlers-model.test.ts`
- Reference: `test/helpers/mock-factories.ts` (for `createMockHandlerDeps`)

**Step 1: Write the failing tests**

Add to `test/unit/handlers/handlers-model.test.ts`:

```typescript
import {
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
	handleGetModels,
} from "../../../src/lib/handlers/model.js";

describe("handleSwitchVariant", () => {
	it("stores variant per-session and broadcasts variant_info", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		deps.overrides.model = { providerID: "anthropic", modelID: "claude-opus-4-6" };
		await handleSwitchVariant(deps, "c1", { variant: "high" });
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "high");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});

	it("persists variant to settings.jsonc", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		// Need to mock getModel to return the active model for the session
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "high" });
		// Check that saveRelaySettings was called — we'll need to spy on it
		// This test validates the persistence behavior added in this task
	});

	it("broadcasts to all clients when no session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		vi.mocked(deps.sessionMgr.getActiveSessionId).mockReturnValue(undefined);
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "low" });
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("low");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "variant_info", variant: "low" }),
		);
	});

	it("handles empty variant (reset to default)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "" });
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
	});
});
```

**Step 2: Run tests to verify they pass** (these test existing behavior — they should pass)

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`

Note: Some of these tests are for the **existing** behavior (pre-persistence). The persistence-specific assertions will be added in Task 4 after we modify the handler.

**Step 3: Commit**

```
test: add unit tests for handleSwitchVariant handler
```

---

### Task 4: Add variant persistence to `handleSwitchVariant`

**Files:**
- Modify: `src/lib/handlers/model.ts:138-188` (handleSwitchVariant)
- Modify: `src/lib/handlers/model.ts:4` (add `loadRelaySettings` import)

**Step 1: Write the failing test** (add to the `handleSwitchVariant` describe block from Task 3)

```typescript
it("persists variant to defaultVariants in settings", async () => {
	const deps = createMockHandlerDeps();
	vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
	vi.mocked(deps.overrides.getModel).mockReturnValue({
		providerID: "anthropic",
		modelID: "claude-opus-4-6",
	});
	vi.mocked(deps.client.listProviders).mockResolvedValue({
		providers: [],
		defaults: {},
		connected: [],
	});
	await handleSwitchVariant(deps, "c1", { variant: "high" });
	// saveRelaySettings is a module-level function — spy on it
	// We verify by checking the import's mock
});
```

We need to mock `saveRelaySettings`. Use `vi.mock` at the top of the test file:

```typescript
vi.mock("../../../src/lib/relay/relay-settings.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/lib/relay/relay-settings.js")>();
	return {
		...original,
		saveRelaySettings: vi.fn(),
		loadRelaySettings: vi.fn().mockReturnValue({}),
	};
});
```

Then import and assert:
```typescript
import { saveRelaySettings, loadRelaySettings } from "../../../src/lib/relay/relay-settings.js";

// In the test:
expect(saveRelaySettings).toHaveBeenCalledWith(
	{ defaultVariants: { "anthropic/claude-opus-4-6": "high" } },
	deps.config.configDir,
);
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`
Expected: FAIL — `handleSwitchVariant` doesn't call `saveRelaySettings` yet.

**Step 3: Implement**

In `src/lib/handlers/model.ts`, modify `handleSwitchVariant`:

1. Change the import at line 4:
```typescript
import { loadRelaySettings, saveRelaySettings } from "../relay/relay-settings.js";
```

2. After line 148 (after storing variant), use per-session model lookup (fix Gap #5) and persist:
```typescript
export async function handleSwitchVariant(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_variant"],
): Promise<void> {
	const { variant } = payload;
	const sessionId = resolveSession(deps, clientId);
	if (sessionId) {
		deps.overrides.setVariant(sessionId, variant);
	} else {
		deps.overrides.setVariant(variant);
	}

	// Resolve active model — per-session first (Gap #5 fix), then global fallback
	const activeModel = sessionId
		? deps.overrides.getModel(sessionId)
		: deps.overrides.model;

	// Persist variant preference for this model
	if (activeModel) {
		const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
		saveRelaySettings(
			{ defaultVariants: { [modelKey]: variant } },
			deps.config.configDir,
		);
	}

	// Broadcast variant_info to all clients viewing this session
	let availableVariants: string[] = [];
	if (activeModel) {
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find(
					(mod) => mod.id === activeModel.modelID,
				);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch (err) {
			deps.log(
				`   [model] Failed to fetch variant list: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	if (sessionId) {
		deps.wsHandler.sendToSession(sessionId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
		});
	} else {
		deps.wsHandler.broadcast({
			type: "variant_info",
			variant,
			variants: availableVariants,
		});
	}
	deps.log(
		`   [model] client=${clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}`,
	);
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`

**Step 5: Commit**

```
feat: persist variant preference per-model in handleSwitchVariant
```

---

### Task 5: Add variant restore on model switch

**Files:**
- Modify: `src/lib/handlers/model.ts:71-104` (handleSwitchModel)
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("handleSwitchModel", () => {
	it("sends variant_info after switching model", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [
						{
							id: "gpt-4o",
							name: "GPT-4o",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "openai/gpt-4o": "high" },
		});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o",
			providerId: "openai",
		});
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "high");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});

	it("clears variant when new model has no variants", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ id: "gpt-4o-mini", name: "GPT-4o Mini" }],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o-mini",
			providerId: "openai",
		});
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "",
				variants: [],
			}),
		);
	});

	it("validates persisted variant against available list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, medium: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		// Persisted variant "max" no longer available
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "max" },
		});
		await handleSwitchModel(deps, "c1", {
			modelId: "claude-opus-4-6",
			providerId: "anthropic",
		});
		// Should fall back to "" since "max" is not in available variants
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
	});

	it("still sends model_info as before", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o",
			providerId: "openai",
		});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "model_info",
				model: "gpt-4o",
				provider: "openai",
			}),
		);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`
Expected: FAIL — `handleSwitchModel` doesn't send `variant_info` or call `setVariant`.

**Step 3: Implement**

Modify `handleSwitchModel` in `src/lib/handlers/model.ts`:

```typescript
export async function handleSwitchModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_model"],
): Promise<void> {
	const { modelId, providerId } = payload;
	if (modelId && providerId) {
		const clientSession = deps.wsHandler.getClientSession(clientId);
		if (clientSession) {
			deps.overrides.setModel(clientSession, {
				providerID: providerId,
				modelID: modelId,
			});
		} else {
			deps.overrides.setModel({ providerID: providerId, modelID: modelId });
		}
		if (clientSession) {
			deps.wsHandler.sendToSession(clientSession, {
				type: "model_info",
				model: modelId,
				provider: providerId,
			});
		} else {
			deps.wsHandler.broadcast({
				type: "model_info",
				model: modelId,
				provider: providerId,
			});
		}
		deps.log(
			`   [model] client=${clientId} session=${resolveSessionForLog(deps, clientId)} Switched to: ${modelId} (${providerId})`,
		);

		// Restore persisted variant for the new model and send variant_info
		const modelKey = `${providerId}/${modelId}`;
		let availableVariants: string[] = [];
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find((mod) => mod.id === modelId);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch {
			// Silently ignore — variant info is best-effort
		}

		// Look up persisted variant, validate against available list
		const settings = loadRelaySettings(deps.config.configDir);
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";

		// Set variant for the session
		if (clientSession) {
			deps.overrides.setVariant(clientSession, validVariant);
			deps.wsHandler.sendToSession(clientSession, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
			});
		} else {
			deps.overrides.setVariant(validVariant);
			deps.wsHandler.broadcast({
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
			});
		}
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`

**Step 5: Commit**

```
feat: restore persisted variant on model switch with validation
```

---

### Task 6: Add variant_info to `handleSetDefaultModel` and `handleGetModels`

**Files:**
- Modify: `src/lib/handlers/model.ts:106-136` (handleSetDefaultModel)
- Modify: `src/lib/handlers/model.ts:9-69` (handleGetModels)
- Test: `test/unit/handlers/handlers-model.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("handleSetDefaultModel — variant wiring", () => {
	it("broadcasts variant_info after setting default model", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "high" },
		});
		await handleSetDefaultModel(deps, "c1", {
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});
});

describe("handleGetModels — variant wiring", () => {
	it("sends variant_info after model_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.overrides.getVariant).mockReturnValue("high");
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		vi.mocked(deps.client.listProviders).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		vi.mocked(deps.client.getSession).mockResolvedValue({
			id: "ses-1",
			modelID: "claude-opus-4-6",
			providerID: "anthropic",
		});
		await handleGetModels(deps, "c1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"c1",
			expect.objectContaining({
				type: "variant_info",
			}),
		);
	});
});
```

**Step 2: Run tests to verify they fail**

Expected: FAIL — neither handler sends `variant_info`.

**Step 3: Implement**

In `handleSetDefaultModel`, after the existing broadcasts (line 134), add variant_info:

```typescript
// Send variant_info for the new default model
try {
	const providerResult = await deps.client.listProviders();
	let availableVariants: string[] = [];
	for (const p of providerResult.providers) {
		const m = (p.models ?? []).find((mod) => mod.id === model);
		if (m?.variants) {
			availableVariants = Object.keys(m.variants);
			break;
		}
	}
	const settings = loadRelaySettings(deps.config.configDir);
	const modelKey = `${provider}/${model}`;
	const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
	const validVariant =
		persistedVariant && availableVariants.includes(persistedVariant)
			? persistedVariant
			: "";
	overrides.defaultVariant = validVariant;
	deps.wsHandler.broadcast({
		type: "variant_info",
		variant: validVariant,
		variants: availableVariants,
	});
} catch {
	// variant_info is best-effort
}
```

In `handleGetModels`, after the `model_list` send and model_info logic, add variant_info:

```typescript
// Send variant_info for the current model
const resolvedSessionId = resolveSession(deps, clientId);
const currentVariant = resolvedSessionId
	? deps.overrides.getVariant(resolvedSessionId)
	: deps.overrides.variant;
const activeModelForVariant = resolvedSessionId
	? deps.overrides.getModel(resolvedSessionId)
	: deps.overrides.model;
let variantList: string[] = [];
if (activeModelForVariant) {
	for (const p of providers) {
		const m = p.models.find((mod) => mod.id === activeModelForVariant.modelID);
		if (m?.variants) {
			variantList = m.variants;
			break;
		}
	}
}
deps.wsHandler.sendTo(clientId, {
	type: "variant_info",
	variant: currentVariant ?? "",
	variants: variantList,
});
```

Note: In `handleGetModels`, we already have the `providers` array built with variant names extracted. We can reuse it — `m.variants` will be `string[]` (already mapped from `Object.keys`).

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`

**Step 5: Commit**

```
feat: send variant_info from handleSetDefaultModel and handleGetModels
```

---

### Task 7: Fix client-init per-session variant (Gap #1) and optional chaining (Gap #3)

**Files:**
- Modify: `src/lib/bridges/client-init.ts:255-256` (variant lookup)
- Modify: `src/lib/handlers/prompt.ts:42-43` (optional chaining cleanup)
- Test: `test/unit/bridges/client-init.test.ts` (if exists, add test; otherwise skip test — client-init is heavily covered by existing tests)

**Step 1: Check if client-init tests exist**

Run: `ls test/unit/bridges/`
Look for `client-init.test.ts`.

**Step 2: Implement fixes**

In `src/lib/bridges/client-init.ts`, change lines 255-256:

From:
```typescript
const currentVariant = overrides.getVariant?.() ?? "";
const activeModelId = overrides.model?.modelID;
```

To:
```typescript
const currentVariant = activeId
	? overrides.getVariant(activeId)
	: overrides.getVariant();
const activeModelId = activeId
	? overrides.getModel(activeId)?.modelID
	: overrides.model?.modelID;
```

In `src/lib/handlers/prompt.ts`, change lines 42-43:

From:
```typescript
const variant =
	deps.overrides.getVariant?.(activeId) ?? deps.overrides.variant ?? "";
```

To:
```typescript
const variant = activeId
	? deps.overrides.getVariant(activeId)
	: (deps.overrides.variant ?? "");
```

**Step 3: Run full test suite**

Run: `pnpm vitest run`
Expected: All tests pass.

**Step 4: Commit**

```
fix: use per-session variant in client-init and remove unnecessary optional chaining
```

---

### Task 8: Fix `handleSetDefaultModel` to use load-merge-save

**Files:**
- Modify: `src/lib/handlers/model.ts:117` (save call in handleSetDefaultModel)

**Step 1: Write failing test** (add to existing `handleSetDefaultModel` describe block)

```typescript
it("preserves existing defaultVariants when saving default model", async () => {
	const deps = createMockHandlerDeps();
	vi.mocked(loadRelaySettings).mockReturnValue({
		defaultVariants: { "anthropic/claude-opus-4-6": "high" },
	});
	vi.mocked(deps.client.listProviders).mockResolvedValue({
		providers: [],
		defaults: {},
		connected: [],
	});
	await handleSetDefaultModel(deps, "c1", {
		provider: "openai",
		model: "gpt-4o",
	});
	// saveRelaySettings should be called with defaultModel — and our
	// load-merge-save implementation preserves existing defaultVariants
	expect(saveRelaySettings).toHaveBeenCalledWith(
		expect.objectContaining({ defaultModel: "openai/gpt-4o" }),
		deps.config.configDir,
	);
});
```

This test validates that the save call pattern works with the load-merge-save `saveRelaySettings`. No code change needed here since Task 1 already made `saveRelaySettings` merge. But verify the call site is correct.

**Step 2: Verify and commit**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`

```
test: verify handleSetDefaultModel preserves defaultVariants
```

---

### Task 9: Full verification

**Step 1: Run all unit tests**

Run: `pnpm vitest run`
Expected: All pass.

**Step 2: Run type checker**

Run: `pnpm tsc --noEmit`
Expected: Clean.

**Step 3: Run build**

Run: `pnpm build`
Expected: Clean.

**Step 4: Run linter**

Run: `pnpm biome check src test`
Expected: Clean.

**Step 5: Run E2E tests** (if applicable)

Run: `pnpm playwright test test/e2e/specs/variant-selector.spec.ts --config test/e2e/playwright-variant.config.ts`
Expected: All pass.

**Step 6: Final commit** (if any fixups needed)

```
fix: address lint/type issues from variant persistence changes
```
