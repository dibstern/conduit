# Dual Claude Provider Labels Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Show both OpenCode and Claude SDK models in the model selector with distinct labels ("Anthropic - opencode" and "Anthropic - claude") so users can choose which backend handles the request.

**Architecture:** The `handleGetModels()` handler already merges Claude SDK models into the provider list. We rename the label from `"Claude (In-Process)"` to `"Anthropic - claude"` and conditionally rename OpenCode's `"anthropic"` provider to `"Anthropic - opencode"` when the SDK is active. No dedup — both model sets coexist. Routing is already correct via `isClaudeProvider()`.

**Tech Stack:** TypeScript, Vitest, conduit handlers

---

### Task 1: Write failing tests for provider renaming

**Files:**
- Modify: `test/unit/handlers/handlers-model.test.ts` (append after line 428)

**Step 1: Write the failing tests**

Append this describe block at the end of the test file (before the final closing, which is currently at line 429):

```typescript
// ─── handleGetModels — Claude provider labeling ──────────────────────────────

describe("handleGetModels — Claude provider labeling", () => {
	it("labels SDK provider as 'Anthropic - claude'", async () => {
		const engine = {
			dispatch: vi.fn().mockResolvedValue({
				models: [
					{ id: "claude-sonnet-4", name: "Claude Sonnet 4", providerId: "claude" },
				],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
			getProviderForSession: vi.fn(),
			bindSession: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as NonNullable<HandlerDeps["orchestrationEngine"]>;
		const deps = createMockHandlerDeps({ orchestrationEngine: engine });
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [{ id: "claude-opus-4-1", name: "Claude Opus 4.1" }],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});

		await handleGetModels(deps, "c1", {});

		const call = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.find((c) => (c[1] as { type: string }).type === "model_list");
		const payload = call![1] as {
			type: string;
			providers: Array<{ id: string; name: string; models: Array<{ id: string }> }>;
		};

		const claudeProvider = payload.providers.find((p) => p.id === "claude");
		expect(claudeProvider).toBeDefined();
		expect(claudeProvider!.name).toBe("Anthropic - claude");
	});

	it("renames 'anthropic' to 'Anthropic - opencode' when SDK has models", async () => {
		const engine = {
			dispatch: vi.fn().mockResolvedValue({
				models: [
					{ id: "claude-sonnet-4", name: "Claude Sonnet 4", providerId: "claude" },
				],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
			getProviderForSession: vi.fn(),
			bindSession: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as NonNullable<HandlerDeps["orchestrationEngine"]>;
		const deps = createMockHandlerDeps({ orchestrationEngine: engine });
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [{ id: "claude-opus-4-1", name: "Claude Opus 4.1" }],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});

		await handleGetModels(deps, "c1", {});

		const call = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.find((c) => (c[1] as { type: string }).type === "model_list");
		const payload = call![1] as {
			type: string;
			providers: Array<{ id: string; name: string }>;
		};

		const anthropicProvider = payload.providers.find((p) => p.id === "anthropic");
		expect(anthropicProvider).toBeDefined();
		expect(anthropicProvider!.name).toBe("Anthropic - opencode");
	});

	it("keeps 'Anthropic' name unchanged when SDK has no models", async () => {
		const engine = {
			dispatch: vi.fn().mockResolvedValue({
				models: [],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
			getProviderForSession: vi.fn(),
			bindSession: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as NonNullable<HandlerDeps["orchestrationEngine"]>;
		const deps = createMockHandlerDeps({ orchestrationEngine: engine });
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [{ id: "claude-opus-4-1", name: "Claude Opus 4.1" }],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});

		await handleGetModels(deps, "c1", {});

		const call = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.find((c) => (c[1] as { type: string }).type === "model_list");
		const payload = call![1] as {
			type: string;
			providers: Array<{ id: string; name: string }>;
		};

		const anthropicProvider = payload.providers.find((p) => p.id === "anthropic");
		expect(anthropicProvider!.name).toBe("Anthropic");
	});

	it("both provider groups retain their models (no dedup)", async () => {
		const engine = {
			dispatch: vi.fn().mockResolvedValue({
				models: [
					{ id: "claude-sonnet-4", name: "Claude Sonnet 4", providerId: "claude" },
					{ id: "claude-opus-4", name: "Claude Opus 4", providerId: "claude" },
				],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
			getProviderForSession: vi.fn(),
			bindSession: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as NonNullable<HandlerDeps["orchestrationEngine"]>;
		const deps = createMockHandlerDeps({ orchestrationEngine: engine });
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{ id: "claude-sonnet-4", name: "Claude Sonnet 4" },
						{ id: "claude-opus-4-1", name: "Claude Opus 4.1" },
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});

		await handleGetModels(deps, "c1", {});

		const call = vi
			.mocked(deps.wsHandler.sendTo)
			.mock.calls.find((c) => (c[1] as { type: string }).type === "model_list");
		const payload = call![1] as {
			type: string;
			providers: Array<{ id: string; models: Array<{ id: string }> }>;
		};

		// OpenCode anthropic keeps ALL its models
		const anthropic = payload.providers.find((p) => p.id === "anthropic");
		expect(anthropic!.models.map((m) => m.id)).toEqual(
			expect.arrayContaining(["claude-sonnet-4", "claude-opus-4-1"]),
		);

		// SDK claude has its own models
		const claude = payload.providers.find((p) => p.id === "claude");
		expect(claude!.models.map((m) => m.id)).toEqual(
			expect.arrayContaining(["claude-sonnet-4", "claude-opus-4"]),
		);
	});
});
```

Note: You need to add `import type { HandlerDeps } from "../../../src/lib/handlers/types.js";` at the top of the test file (line 2 area).

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`
Expected: 2 FAIL — "Anthropic - claude" tests fail because current label is "Claude (In-Process)", and "Anthropic - opencode" rename doesn't exist yet. The "no models" and "no dedup" tests should pass (current code already keeps all models and doesn't rename when SDK models are empty).

**Step 3: Commit failing tests**

```bash
git add test/unit/handlers/handlers-model.test.ts
git commit -m "test: add failing tests for dual Claude provider labels"
```

---

### Task 2: Implement provider renaming

**Files:**
- Modify: `src/lib/handlers/model.ts:38-61`

**Step 1: Update the orchestration block**

Replace lines 38-61 in `src/lib/handlers/model.ts` (the `if (deps.orchestrationEngine)` block) with:

```typescript
	// Merge Claude in-process models when the orchestration engine is available.
	// Both sets are shown so users can choose which backend handles the request:
	//   "Anthropic - opencode" → routes via OpenCode REST API
	//   "Anthropic - claude"  → routes via in-process Claude Agent SDK
	if (deps.orchestrationEngine) {
		try {
			const claudeCaps = await deps.orchestrationEngine.dispatch({
				type: "discover",
				providerId: "claude",
			});
			if (claudeCaps.models.length > 0) {
				// Rename "anthropic" provider to distinguish from SDK models
				for (const p of providers) {
					if (p.id === "anthropic") {
						p.name = "Anthropic - opencode";
					}
				}

				providers.push({
					id: "claude",
					name: "Anthropic - claude",
					configured: true,
					models: claudeCaps.models.map((m) => ({
						id: m.id,
						name: m.name,
						provider: "claude",
						...(m.limit ? { limit: m.limit } : {}),
					})),
				});
			}
		} catch {
			// Claude adapter may not be available — skip silently
		}
	}
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/handlers-model.test.ts`
Expected: ALL PASS (15 existing + 4 new = 19 tests)

**Step 3: Run full test suite and type-check**

Run: `pnpm test && pnpm check`
Expected: All pass (pre-existing chat-layout-ws failures are unrelated)

**Step 4: Commit**

```bash
git add src/lib/handlers/model.ts test/unit/handlers/handlers-model.test.ts
git commit -m "feat: label Claude providers as 'Anthropic - opencode' and 'Anthropic - claude'"
```

---

## Verification

1. `pnpm vitest run test/unit/handlers/handlers-model.test.ts` — 19 tests pass
2. `pnpm test` — full suite passes (minus pre-existing chat-layout-ws failures)
3. `pnpm check` — type-check clean
4. Manual: model selector shows "Anthropic - opencode" and "Anthropic - claude" groups
5. Selecting from "Anthropic - claude" routes through SDK (`provider: "claude"`)
6. Selecting from "Anthropic - opencode" routes through OpenCode (`provider: "anthropic"`)
