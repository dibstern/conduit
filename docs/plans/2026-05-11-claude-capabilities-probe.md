# Claude Capabilities Probe Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Replace ClaudeAdapter's lazy "first-session-forever-cache" model discovery with an ephemeral, TTL-bounded probe that asks the local `claude` binary for its current model list every 5 minutes without persisting anything to disk.

**Architecture:** A new `claude-capabilities-probe.ts` module spawns a Claude Agent SDK query with `persistSession: false`, `maxTurns: 0`, and `settingSources: []`, awaits `query.initializationResult()` to receive the SDK's live model list, then aborts before any Anthropic API call is made. The result is wrapped in a process-local `TTLCache` (5-minute TTL with in-flight deduplication) that is shared across all `ClaudeAdapter` instances. `ClaudeAdapter.discover()` reads from this cache; a minimal hardcoded fallback only applies if the binary is unreachable. Nothing is written to SQLite, `~/.claude/projects/`, or any other persistent store.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`query`, `initializationResult`, `AbortController`), Vitest, conduit's existing `ProviderAdapter` contract.

---

## What the SDK exposes — context window investigation result

Before writing this plan, I audited the SDK's `sdk.d.ts` (v0.2.132) for any way to retrieve per-model context windows or output-token limits without making a real API call. **Findings:**

| API surface | Field | Notes |
|---|---|---|
| `ModelInfo` (from `supportedModels()` / `initializationResult().models`) | **NO `contextWindow`, NO `maxOutputTokens`** | Only has `value`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`. |
| `ModelUsage` (from `result.usage` after a turn) | `contextWindow`, `maxOutputTokens` | Available — but only after a real Anthropic API call completes. Defeats the "no wasted probe" goal. |
| `query.getContextUsage()` | `maxTokens`, `rawMaxTokens`, `totalTokens`, `model` | Returns data for the **currently-selected model only**. Getting all-model coverage = one probe spawn per model. Premium 1M context for Sonnet would still report 200k without a beta header. |

**Conclusion: SDK does not expose per-model context windows in any discovery API that can run pre-turn for all models at once.** This plan therefore keeps the hardcoded family-based `inferLimits()` map (matching what t3code does) — 200k context for all current Claude models, output tokens by family.

**What the SDK DOES expose for free that we capture in this PR:**

- `supportedEffortLevels: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]` per model — mapped into conduit's existing `ModelInfo.variants` field so the **existing** `ModelVariant.svelte` effort dropdown lights up for Claude models with zero new UI code.

Conduit already has an effort picker (`src/lib/frontend/components/model/ModelVariant.svelte`) that reads `ModelInfo.variants` and emits `switch_variant` WebSocket messages. The picker has worked for OpenCode since launch. It does not show for Claude today because three pieces of the wiring are missing:

| Gap | Location | This-PR fix |
|---|---|---|
| Probe doesn't populate `variants` for Claude models | `claude-capabilities-probe.ts` (new) | Map `sdk.supportedEffortLevels` → `variants: Object.fromEntries(...)` |
| `switch_variant` handler is OpenCode-only | `src/lib/handlers/model.ts:354-367` | Branch on `providerId === "claude"` → look up variants from cached probe via `orchestrationEngine.dispatch({type:"discover", providerId:"claude"})` |
| `ClaudeAdapter.sendTurn` doesn't apply `effort` to Claude SDK sessions | `src/lib/provider/claude/claude-adapter.ts:305-405` | Read `input.variant`, pass it as `options.effort` when a query is created, and restart/resume the SDK query before the next turn when the effort changes for an already-active conduit session |

Result: an end-to-end effort picker for Claude that uses the dropdown the user already sees today for OpenCode. Important lifecycle detail: the Claude SDK `Query` control surface has `setModel(...)`, `setPermissionMode(...)`, and `setMaxThinkingTokens(...)`, but **no `setEffort(...)`**. So effort is a query-creation option. A mid-session effort change must close the current SDK query and create a new one with the stored `resumeSessionId`, not enqueue into the old query.

The four other SDK capability booleans (`supportsEffort`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`) are NOT plumbed in this PR — no existing UI consumes them, and adding new dropdowns/toggles is a separate design conversation. They remain available on the SDK ModelInfo for future work.

---

## Background: what we're replacing

The current `claude-adapter.ts` has these pieces from a prior change:

- `dynamicModels?: ReadonlyArray<ModelInfo>` field on the adapter instance
- `refreshModels(query)` method called fire-and-forget on first `sendTurn()`
- `FALLBACK_MODELS` array (3 alias entries) used until `dynamicModels` populates
- `inferLimits()` helper that maps model id → output-token limit by regex

The problem: `dynamicModels` is cached forever once set, with no validation. If the user updates their local `claude` binary, conduit keeps showing stale models until the daemon restarts. This is the cache-validation trap.

This plan deletes the lazy-cache logic and replaces it with a deterministic TTL probe. `FALLBACK_MODELS` shrinks; `inferLimits()` stays (the SDK does not surface context/output limits, so we still infer by family).

## What the probe spawns

The SDK call uses options proven by competitor analysis:

| Option | Value | Effect |
|---|---|---|
| `prompt` | `"."` (single dot, never sent) | Required by SDK, content irrelevant — aborted before submission |
| `persistSession` | `false` | SDK skips writes to `~/.claude/projects/<hash>/` |
| `maxTurns` | `0` | SDK refuses to send any turn to Anthropic API |
| `settingSources` | `[]` | No user/project/local settings loaded → no log noise |
| `abortController` | new instance | Aborted in `finally` regardless of outcome |
| `allowedTools` | `[]` | Nothing to invoke even if turns were allowed |
| `stderr` | `() => {}` | Swallow stderr noise |

`q.initializationResult()` returns `SDKControlInitializeResponse` which contains `models`, `commands`, `agents`, `account`, etc. — we use `models` only in this plan.

---

## Tasks

### Task 1: Create the TTL cache primitive

**Files:**
- Create: `src/lib/provider/claude/ttl-cache.ts`
- Test: `test/unit/provider/claude/ttl-cache.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/provider/claude/ttl-cache.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TTLCache } from "../../../../src/lib/provider/claude/ttl-cache.js";

describe("TTLCache", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("invokes lookup on first call", async () => {
		const lookup = vi.fn().mockResolvedValue("v1");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("returns cached value within TTL without re-invoking lookup", async () => {
		const lookup = vi.fn().mockResolvedValue("v1");
		const cache = new TTLCache(1000, lookup);
		await cache.get();
		vi.advanceTimersByTime(999);
		await expect(cache.get()).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("re-invokes lookup after TTL elapses", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValueOnce("v1")
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).resolves.toBe("v1");
		vi.advanceTimersByTime(1001);
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("deduplicates concurrent in-flight lookups", async () => {
		let resolveLookup: (v: string) => void = () => {};
		const lookup = vi.fn().mockImplementation(
			() =>
				new Promise<string>((r) => {
					resolveLookup = r;
				}),
		);
		const cache = new TTLCache(1000, lookup);
		const a = cache.get();
		const b = cache.get();
		const c = cache.get();
		resolveLookup("v1");
		await expect(a).resolves.toBe("v1");
		await expect(b).resolves.toBe("v1");
		await expect(c).resolves.toBe("v1");
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("does not cache failed lookups (next call retries)", async () => {
		const lookup = vi
			.fn()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await expect(cache.get()).rejects.toThrow("boom");
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});

	it("invalidate() forces next call to re-invoke lookup", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValueOnce("v1")
			.mockResolvedValueOnce("v2");
		const cache = new TTLCache(1000, lookup);
		await cache.get();
		cache.invalidate();
		await expect(cache.get()).resolves.toBe("v2");
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/provider/claude/ttl-cache.test.ts
```

Expected: FAIL with "Cannot find module '.../ttl-cache.js'".

**Step 3: Write minimal implementation**

Create `src/lib/provider/claude/ttl-cache.ts`:

```typescript
// src/lib/provider/claude/ttl-cache.ts
/**
 * Tiny TTL-bounded async cache with in-flight deduplication.
 *
 * Used to wrap an expensive lookup (e.g. SDK capability probe) so that
 * many callers within the TTL window share one result, but the cache
 * automatically refreshes after the TTL expires.
 *
 * Failed lookups are NOT cached — the next call retries. This avoids
 * pinning a transient error in the cache until TTL elapses.
 */
export class TTLCache<T> {
	private value: T | undefined;
	private expiresAt = 0;
	private inFlight: Promise<T> | undefined;

	constructor(
		private readonly ttlMs: number,
		private readonly lookup: () => Promise<T>,
	) {}

	async get(): Promise<T> {
		if (this.value !== undefined && Date.now() < this.expiresAt) {
			return this.value;
		}
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.lookup()
			.then((v) => {
				this.value = v;
				this.expiresAt = Date.now() + this.ttlMs;
				return v;
			})
			.finally(() => {
				this.inFlight = undefined;
			});
		return this.inFlight;
	}

	invalidate(): void {
		this.value = undefined;
		this.expiresAt = 0;
	}
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/provider/claude/ttl-cache.test.ts
```

Expected: PASS (6 tests).

**Step 5: Refactor (none needed)**

Skip — class is minimal and tests pass.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/ttl-cache.ts test/unit/provider/claude/ttl-cache.test.ts
git commit -m "feat(claude): add TTLCache with in-flight dedup for capability probe"
```

---

### Task 2: Create the capability probe function

**Files:**
- Create: `src/lib/provider/claude/claude-capabilities-probe.ts`
- Test: `test/unit/provider/claude/claude-capabilities-probe.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/provider/claude/claude-capabilities-probe.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { probeClaudeCapabilities } from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";

describe("probeClaudeCapabilities", () => {
	function makeFakeQuery(opts: {
		initResult?: {
			models?: Array<{ value: string; displayName: string }>;
		};
		throwOnInit?: Error;
	}) {
		return vi.fn().mockReturnValue({
			initializationResult: vi.fn().mockImplementation(async () => {
				if (opts.throwOnInit) throw opts.throwOnInit;
				return opts.initResult ?? { models: [] };
			}),
		});
	}

	it("returns models mapped to conduit ModelInfo on success", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{ value: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
					{ value: "claude-sonnet-4-7", displayName: "Claude Sonnet 4.7" },
				],
			},
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models).toHaveLength(2);
		expect(result.models[0]).toMatchObject({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			providerId: "claude",
		});
		expect(result.models[0]?.limit).toEqual({
			context: 200_000,
			output: 32_000,
		});
		expect(result.models[1]?.limit).toEqual({
			context: 200_000,
			output: 64_000,
		});
	});

	it("maps SDK supportedEffortLevels into ModelInfo.variants", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [
					{
						value: "claude-opus-4-7",
						displayName: "Claude Opus 4.7",
						supportedEffortLevels: ["low", "medium", "high", "max"],
					},
					{
						value: "claude-haiku-4-7",
						displayName: "Claude Haiku 4.7",
						supportedEffortLevels: [],
					},
				],
			},
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models[0]?.variants).toEqual({
			low: {},
			medium: {},
			high: {},
			max: {},
		});
		// Empty effort list → no variants record (UI hides dropdown when empty).
		expect(result.models[1]?.variants).toBeUndefined();
	});

	it("omits variants when SDK omits supportedEffortLevels", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-opus-4-7", displayName: "Opus 4.7" }],
			},
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models[0]?.variants).toBeUndefined();
	});

	it("calls query() with persistSession:false, maxTurns:0, settingSources:[]", async () => {
		const queryFactory = makeFakeQuery({ initResult: { models: [] } });
		await probeClaudeCapabilities({ queryFactory });
		expect(queryFactory).toHaveBeenCalledTimes(1);
		const callArg = queryFactory.mock.calls[0]?.[0] as {
			options: Record<string, unknown>;
		};
		expect(callArg.options.persistSession).toBe(false);
		expect(callArg.options.maxTurns).toBe(0);
		expect(callArg.options.settingSources).toEqual([]);
		expect(callArg.options.abortController).toBeInstanceOf(AbortController);
	});

	it("aborts the controller in finally on success", async () => {
		let capturedController: AbortController | undefined;
		const queryFactory = vi.fn().mockImplementation((arg: {
			options: { abortController: AbortController };
		}) => {
			capturedController = arg.options.abortController;
			return {
				initializationResult: async () => ({ models: [] }),
			};
		});
		await probeClaudeCapabilities({ queryFactory });
		expect(capturedController?.signal.aborted).toBe(true);
	});

	it("aborts the controller in finally on initializationResult() error", async () => {
		let capturedController: AbortController | undefined;
		const queryFactory = vi.fn().mockImplementation((arg: {
			options: { abortController: AbortController };
		}) => {
			capturedController = arg.options.abortController;
			return {
				initializationResult: async () => {
					throw new Error("boom");
				},
			};
		});
		await expect(probeClaudeCapabilities({ queryFactory })).rejects.toThrow(
			"boom",
		);
		expect(capturedController?.signal.aborted).toBe(true);
	});

	it("returns empty models when init returns no models field", async () => {
		const queryFactory = makeFakeQuery({ initResult: {} });
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models).toEqual([]);
	});

	it("infers limits for known Haiku family", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "claude-haiku-4-7", displayName: "Haiku 4.7" }],
			},
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models[0]?.limit).toEqual({
			context: 200_000,
			output: 8_192,
		});
	});

	it("omits limit when model id matches no known family", async () => {
		const queryFactory = makeFakeQuery({
			initResult: {
				models: [{ value: "mystery-model", displayName: "Mystery" }],
			},
		});
		const result = await probeClaudeCapabilities({ queryFactory });
		expect(result.models[0]?.limit).toBeUndefined();
	});
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: FAIL with "Cannot find module '.../claude-capabilities-probe.js'".

**Step 3: Write minimal implementation**

Create `src/lib/provider/claude/claude-capabilities-probe.ts`:

```typescript
// src/lib/provider/claude/claude-capabilities-probe.ts
/**
 * Claude capability probe.
 *
 * Spawns a Claude Agent SDK query with:
 *   - persistSession: false  → no writes to ~/.claude/projects/
 *   - maxTurns: 0            → no API call possible
 *   - settingSources: []     → no settings/log noise
 *   - abortController        → killed in finally (success and failure)
 *
 * The "." prompt is required by the SDK but never sent: abort fires
 * before any turn is submitted. Cost = subprocess spawn + init handshake
 * (~100-500ms). Zero API tokens. Nothing persists to disk.
 *
 * Used by the TTL cache in claude-adapter to surface live model lists
 * from the local `claude` binary every 5 minutes.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "../types.js";
import type { Query, Options as SDKOptions, SDKUserMessage } from "./types.js";

// Output-token limits by model family (SDK does not surface these).
const OUTPUT_LIMIT_BY_FAMILY: ReadonlyArray<[pattern: RegExp, output: number]> =
	[
		[/^(?:claude-)?opus/i, 32_000],
		[/^(?:claude-)?sonnet/i, 64_000],
		[/^(?:claude-)?haiku/i, 8_192],
	];

function inferLimits(
	modelId: string,
): { context: number; output: number } | undefined {
	for (const [re, output] of OUTPUT_LIMIT_BY_FAMILY) {
		if (re.test(modelId)) return { context: 200_000, output };
	}
	return undefined;
}

interface SDKModelInfoSubset {
	readonly value: string;
	readonly displayName: string;
	readonly supportedEffortLevels?: readonly string[];
}

/**
 * SDK `supportedEffortLevels: string[]` → conduit's `variants` record.
 * Each effort level becomes a variant key. Empty/absent list = undefined
 * variants (the ModelVariant.svelte dropdown hides when variants is empty).
 */
function effortLevelsToVariants(
	levels: readonly string[] | undefined,
): Record<string, Record<string, unknown>> | undefined {
	if (!levels || levels.length === 0) return undefined;
	return Object.fromEntries(levels.map((level) => [level, {}]));
}

function sdkModelToConduit(sdk: SDKModelInfoSubset): ModelInfo {
	const limit = inferLimits(sdk.value);
	const variants = effortLevelsToVariants(sdk.supportedEffortLevels);
	return {
		id: sdk.value,
		name: sdk.displayName,
		providerId: "claude",
		...(limit ? { limit } : {}),
		...(variants ? { variants } : {}),
	};
}

export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
}

export interface ProbeDeps {
	/** Injectable factory for the SDK's query() function. Defaults to the real SDK. */
	readonly queryFactory?: (params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Query;
}

/** Single-message AsyncIterable for the SDK's prompt argument. */
async function* singleMessage(): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: { role: "user", content: [{ type: "text", text: "." }] },
		parent_tool_use_id: null,
	} as unknown as SDKUserMessage;
}

export async function probeClaudeCapabilities(
	deps: ProbeDeps = {},
): Promise<ProbeResult> {
	const queryFactory =
		deps.queryFactory ??
		(sdkQuery as NonNullable<ProbeDeps["queryFactory"]>);
	const abortController = new AbortController();
	try {
		const q = queryFactory({
			prompt: singleMessage(),
			options: {
				persistSession: false,
				maxTurns: 0,
				settingSources: [],
				abortController,
				allowedTools: [],
				stderr: () => {},
			} as unknown as SDKOptions,
		});
		const init = await q.initializationResult();
		const models = (init.models ?? []).map(sdkModelToConduit);
		return { models };
	} finally {
		if (!abortController.signal.aborted) abortController.abort();
	}
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: PASS (7 tests).

**Step 5: Refactor (none needed)**

Skip — code is minimal.

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-capabilities-probe.ts test/unit/provider/claude/claude-capabilities-probe.test.ts
git commit -m "feat(claude): add capability probe via SDK initializationResult"
```

---

### Task 3: Add cached probe module-level singleton

**Files:**
- Modify: `src/lib/provider/claude/claude-capabilities-probe.ts` (append cache helper)
- Test: `test/unit/provider/claude/claude-capabilities-probe-cached.test.ts`

Rationale for module-level cache: a daemon hosts many projects, each with its own `ClaudeAdapter` instance. The probe queries the local `claude` binary which is shared across all projects. A per-instance cache would spawn one probe per project per TTL window — wasteful. Module-level cache means one probe per TTL window total.

**Step 1: Write the failing test**

Create `test/unit/provider/claude/claude-capabilities-probe-cached.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCachedClaudeCapabilities,
	resetCapabilityCacheForTesting,
	__setProbeOverrideForTesting,
} from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";

describe("getCachedClaudeCapabilities", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetCapabilityCacheForTesting();
	});
	afterEach(() => {
		vi.useRealTimers();
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	});

	it("invokes the probe once and caches for 5 minutes", async () => {
		const probe = vi.fn().mockResolvedValue({
			models: [
				{ id: "claude-opus-4-7", name: "Opus 4.7", providerId: "claude" },
			],
		});
		__setProbeOverrideForTesting(probe);

		const r1 = await getCachedClaudeCapabilities();
		expect(r1.models).toHaveLength(1);
		expect(probe).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(4 * 60 * 1000); // 4 min
		const r2 = await getCachedClaudeCapabilities();
		expect(r2.models).toHaveLength(1);
		expect(probe).toHaveBeenCalledTimes(1); // still cached

		vi.advanceTimersByTime(2 * 60 * 1000); // total 6 min
		await getCachedClaudeCapabilities();
		expect(probe).toHaveBeenCalledTimes(2); // re-probed after TTL
	});

	it("does not cache probe failures", async () => {
		const probe = vi
			.fn()
			.mockRejectedValueOnce(new Error("binary missing"))
			.mockResolvedValueOnce({ models: [] });
		__setProbeOverrideForTesting(probe);

		await expect(getCachedClaudeCapabilities()).rejects.toThrow(
			"binary missing",
		);
		const r2 = await getCachedClaudeCapabilities();
		expect(r2.models).toEqual([]);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("concurrent calls share one probe invocation", async () => {
		let resolve: (v: { models: [] }) => void = () => {};
		const probe = vi.fn().mockImplementation(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		__setProbeOverrideForTesting(probe);

		const calls = [
			getCachedClaudeCapabilities(),
			getCachedClaudeCapabilities(),
			getCachedClaudeCapabilities(),
		];
		resolve({ models: [] });
		const results = await Promise.all(calls);
		expect(results).toHaveLength(3);
		expect(probe).toHaveBeenCalledTimes(1);
	});
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe-cached.test.ts
```

Expected: FAIL (exports do not exist).

**Step 3: Implement — append to `claude-capabilities-probe.ts`**

Append at the bottom of `src/lib/provider/claude/claude-capabilities-probe.ts`:

```typescript
// ─── Cached entry point ───────────────────────────────────────────────────

import { TTLCache } from "./ttl-cache.js";

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

let probeOverride: (() => Promise<ProbeResult>) | undefined;
let cache: TTLCache<ProbeResult> | undefined;

function makeCache(): TTLCache<ProbeResult> {
	return new TTLCache<ProbeResult>(CAPABILITY_CACHE_TTL_MS, () =>
		probeOverride ? probeOverride() : probeClaudeCapabilities(),
	);
}

/**
 * Module-level cached capability lookup.
 *
 * One probe spawn per 5-minute window across all `ClaudeAdapter` instances
 * in the daemon. The cache is in-memory only — dies with the process.
 *
 * Failures are not cached: the next call retries the probe.
 */
export async function getCachedClaudeCapabilities(): Promise<ProbeResult> {
	if (!cache) cache = makeCache();
	return cache.get();
}

/** Test-only: clear the cached value so tests start fresh. */
export function resetCapabilityCacheForTesting(): void {
	cache = undefined;
}

/** Test-only: replace the underlying probe with a fake. Pass undefined to clear. */
export function __setProbeOverrideForTesting(
	fn: (() => Promise<ProbeResult>) | undefined,
): void {
	probeOverride = fn;
	cache = undefined; // reset cache so the new probe is used
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe-cached.test.ts
```

Expected: PASS (3 tests).

**Step 5: Refactor — verify imports are correctly placed**

Move `import { TTLCache } from "./ttl-cache.js";` to the top of the file with the other imports (TypeScript allows mid-file imports but convention groups them). Run tests again to confirm still passing.

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe-cached.test.ts test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: PASS (10 tests total).

**Step 6: Commit**

```bash
git add src/lib/provider/claude/claude-capabilities-probe.ts test/unit/provider/claude/claude-capabilities-probe-cached.test.ts
git commit -m "feat(claude): wrap capability probe in 5-minute TTL cache"
```

---

### Task 4: Wire probe into ClaudeAdapter.discover()

**Files:**
- Modify: `src/lib/provider/claude/claude-adapter.ts` (lines 11-14 header, 67-119 model logic, 239-300 dynamicModels/refreshModels, 269-280 discover return, 413-416 first-session trigger)
- Modify: `test/unit/provider/claude/claude-adapter-discover.test.ts` (add probe integration test)

**Step 1: Write the failing test**

Add this test block to the END of `test/unit/provider/claude/claude-adapter-discover.test.ts`, inside the existing `describe("ClaudeAdapter.discover()", ...)`:

```typescript
	describe("with capability probe", () => {
		beforeEach(() => {
			// Reset and override the module-level probe so tests are deterministic.
			// Imports must be added at the top of the file.
		});

		it("returns models from the probe when available", async () => {
			const { __setProbeOverrideForTesting, resetCapabilityCacheForTesting } =
				await import(
					"../../../../src/lib/provider/claude/claude-capabilities-probe.js"
				);
			resetCapabilityCacheForTesting();
			__setProbeOverrideForTesting(async () => ({
				models: [
					{
						id: "claude-opus-4-7",
						name: "Claude Opus 4.7",
						providerId: "claude" as const,
						limit: { context: 200_000, output: 32_000 },
					},
				],
			}));
			try {
				const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
				const caps = await adapter.discover();
				expect(caps.models).toHaveLength(1);
				expect(caps.models[0]?.id).toBe("claude-opus-4-7");
			} finally {
				__setProbeOverrideForTesting(undefined);
				resetCapabilityCacheForTesting();
			}
		});

		it("falls back to a minimal model list when the probe fails", async () => {
			const { __setProbeOverrideForTesting, resetCapabilityCacheForTesting } =
				await import(
					"../../../../src/lib/provider/claude/claude-capabilities-probe.js"
				);
			resetCapabilityCacheForTesting();
			__setProbeOverrideForTesting(async () => {
				throw new Error("claude binary not found");
			});
			try {
				const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
				const caps = await adapter.discover();
				// Fallback list should be non-empty and Claude-flavored.
				expect(caps.models.length).toBeGreaterThan(0);
				expect(caps.models.every((m) => m.providerId === "claude")).toBe(true);
			} finally {
				__setProbeOverrideForTesting(undefined);
				resetCapabilityCacheForTesting();
			}
		});

		it("returns the same probe result across two adapter instances", async () => {
			const probe = vi.fn().mockResolvedValue({
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Sonnet 4.7",
						providerId: "claude" as const,
					},
				],
			});
			const { __setProbeOverrideForTesting, resetCapabilityCacheForTesting } =
				await import(
					"../../../../src/lib/provider/claude/claude-capabilities-probe.js"
				);
			resetCapabilityCacheForTesting();
			__setProbeOverrideForTesting(probe);
			try {
				const a1 = new ClaudeAdapter({ workspaceRoot: workspace });
				const a2 = new ClaudeAdapter({ workspaceRoot: workspace });
				await a1.discover();
				await a2.discover();
				expect(probe).toHaveBeenCalledTimes(1); // shared cache
			} finally {
				__setProbeOverrideForTesting(undefined);
				resetCapabilityCacheForTesting();
			}
		});
	});
```

Also add `vi` to the existing test imports at the top of the file:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
```

Expected: FAIL on the new tests (probe not yet wired into discover).

**Step 3: Modify `claude-adapter.ts` — section A (imports + drop old constants)**

Open `src/lib/provider/claude/claude-adapter.ts`.

Replace the file's top-of-file Architectural notes block (lines 2-17) with:

```typescript
/**
 * ClaudeAdapter -- ProviderAdapter implementation wrapping the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn.
 * - First sendTurn() creates an EffectPromptQueue (backed by Effect Queue)
 *   + calls query() + starts a background stream consumer. Subsequent
 *   turns enqueue into the existing queue.
 * - Discovery: discover() reads the live model list from a 5-minute TTL
 *   cache shared across adapter instances (see claude-capabilities-probe.ts).
 *   The probe spawns a throwaway SDK query, reads initializationResult(),
 *   and aborts before any API call. Nothing persists to disk. A small
 *   FALLBACK_MODELS list is returned only if the probe fails (offline /
 *   binary missing). Commands and skills are enumerated from ~/.claude/
 *   and <workspace>/.claude/.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 */
```

Replace the imports block + model catalog (current lines 18-119) with:

```typescript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logger.js";
import { canonicalEvent } from "../../persistence/events.js";
import { createDeferred, type Deferred } from "../deferred.js";
import type {
	AdapterCapabilities,
	CommandInfo,
	EventSink,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import { getCachedClaudeCapabilities } from "./claude-capabilities-probe.js";
import {
	ClaudeEventTranslator,
	isInterruptedResult,
} from "./claude-event-translator.js";
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import { EffectPromptQueue } from "./effect-prompt-queue.js";
import type {
	ClaudeSessionContext,
	Query,
	Options as SDKOptions,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

const log = createLogger("claude-adapter");

// ─── Built-in command catalog ──────────────────────────────────────────────

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "init", description: "Initialize Claude in the current workspace" },
	{ name: "memory", description: "Manage Claude's memory / CLAUDE.md" },
	{ name: "compact", description: "Compact the conversation to free context" },
	{ name: "cost", description: "Show token usage and cost for the session" },
	{ name: "model", description: "Switch the active model" },
	{ name: "clear", description: "Clear the conversation" },
	{ name: "help", description: "Show help" },
];

// ─── Fallback model catalog ────────────────────────────────────────────────

/**
 * Used only when the SDK capability probe fails (offline, claude binary
 * missing). The probe is the source of truth in normal operation.
 */
const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "opus",
		name: "Claude Opus (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "sonnet",
		name: "Claude Sonnet (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "haiku",
		name: "Claude Haiku (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 8_192 },
	},
];
```

**Step 4: Modify `claude-adapter.ts` — section B (drop dynamicModels field + refreshModels)**

Find and DELETE this field (currently lines 239-240):

```typescript
	/** Cached model list from SDK's query.supportedModels(). */
	private dynamicModels: ReadonlyArray<ModelInfo> | undefined;
```

Find and DELETE the entire `refreshModels` method block (currently lines 282-300, including the `// ─── refreshModels ──...` comment line):

```typescript
	// ─── refreshModels ────────────────────────────────────────────────────

	private refreshModels(query: Query): void {
		query
			.supportedModels()
			.then((sdkModels) => {
				if (sdkModels.length > 0) {
					this.dynamicModels = sdkModels.map(sdkModelToConduit);
					log.info(
						`Cached ${sdkModels.length} models from SDK: ${sdkModels.map((m) => m.value).join(", ")}`,
					);
				}
			})
			.catch((err) => {
				log.warn(
					`Failed to fetch supportedModels from SDK: ${err instanceof Error ? err.message : err}`,
				);
			});
	}
```

Also DELETE the `sdkModelToConduit` helper (around line 108-119) and the `inferLimits` + `OUTPUT_LIMIT_BY_FAMILY` block (around lines 91-106) — these moved to `claude-capabilities-probe.ts`.

Find and DELETE the fire-and-forget call inside `createSessionAndSendTurn` (currently lines 413-416):

```typescript
			// 6b. Fetch live model list on first session (fire-and-forget)
			if (!this.dynamicModels) {
				this.refreshModels(query);
			}
```

**Step 5: Modify `claude-adapter.ts` — section C (update discover() to use cache)**

Replace the body of `discover()` (currently lines 253-280) with:

```typescript
	async discover(): Promise<AdapterCapabilities> {
		const userBase = join(homedir(), ".claude");
		const projectBase = join(this.deps.workspaceRoot, ".claude");

		const commands: CommandInfo[] = [
			...BUILTIN_COMMANDS.map((c) => ({
				name: c.name,
				description: c.description,
				source: "builtin" as const,
			})),
			...enumerateCommands(userBase, "user-command"),
			...enumerateCommands(projectBase, "project-command"),
			...enumerateSkills(userBase, "user-skill"),
			...enumerateSkills(projectBase, "project-skill"),
		];

		// Try the SDK capability probe (5-min TTL cache). Fall back to a
		// minimal hardcoded list if the probe fails (offline / binary missing).
		let models: ReadonlyArray<ModelInfo>;
		try {
			const probe = await getCachedClaudeCapabilities();
			models = probe.models.length > 0 ? probe.models : FALLBACK_MODELS;
		} catch (err) {
			log.warn(
				`Capability probe failed; using fallback model list: ${err instanceof Error ? err.message : err}`,
			);
			models = FALLBACK_MODELS;
		}

		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: false,
			supportsRevert: false,
			commands,
		};
	}
```

**Step 6: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
```

Expected: PASS (all existing tests + 3 new probe integration tests).

**Step 7: Run typecheck**

```bash
pnpm check
```

Expected: clean. If errors point at unused imports, remove them.

**Step 8: Commit**

```bash
git add src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-discover.test.ts
git commit -m "refactor(claude): replace lazy model cache with TTL probe in discover()"
```

---

### Task 5: Regression check — broader test suites

**Files:**
- Verify: `test/unit/provider/claude/claude-adapter-lifecycle.test.ts`
- Verify: `test/unit/provider/claude/claude-adapter-send-turn.test.ts`

Adapter changes touched class fields and `createSessionAndSendTurn`. Run sibling test files to confirm no behavioral regression.

**Step 1: Run lifecycle tests**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-lifecycle.test.ts
```

Expected: PASS (no test count change vs main).

**Step 2: Run send-turn tests**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: PASS. If failures reference `dynamicModels`, `refreshModels`, or `sdkModelToConduit`, the deletion in Task 4 was incomplete — re-check and remove stragglers. If failures reference test mocks that included `refreshModels` setup, update those mocks to skip that setup.

**Step 3: If failures occur, fix and commit separately**

For each failure:
1. Read the failing assertion message
2. Decide if behavior was intentionally changed (e.g. test asserted `dynamicModels` was populated — replace with assertion that `getCachedClaudeCapabilities` was called)
3. Update the test
4. Re-run

```bash
git add test/unit/provider/claude/
git commit -m "test(claude): update lifecycle/send-turn tests for new discover() flow"
```

If no failures: skip this commit.

---

### Task 6: Verify model.ts + client-init.ts handlers forward `variants`

**Files:**
- Verify only: `src/lib/handlers/model.ts` (lines 56-67, Claude merge block lines 80-97)
- Verify only: `src/lib/bridges/client-init.ts` (lines 320-367)

The probe now populates `ModelInfo.variants` for Claude models. The handler and bridge already forward `variants` for OpenCode (`...(m.variants && Object.keys(m.variants).length > 0 && { variants: Object.keys(m.variants) })` at model.ts:62-66, and identical at client-init.ts:322-330). The Claude merge block in both files does NOT currently forward `variants` — we have to add it.

**Step 1: Search for any other consumer of the dropped types**

```bash
grep -rn "dynamicModels\|refreshModels\|sdkModelToConduit" src/ test/
```

Expected output: empty (the symbols were file-local). If matches show up, those callers also need updating.

**Step 2: Write the failing test**

Create `test/unit/handlers/model-variants-claude.test.ts`. Open `test/unit/handlers/` first and copy the test scaffolding pattern from any neighbouring `*.test.ts` (Effect-based fixtures, mock services). The assertion below is what matters:

```typescript
// Inside whatever describe/it boilerplate matches existing handler tests:
it("includes variants in claude provider entries in model_list", async () => {
	// Set up: orchestration engine returns Claude caps with variants.
	const claudeCaps = {
		models: [
			{
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7",
				providerId: "claude",
				variants: { low: {}, medium: {}, high: {}, max: {} },
			},
		],
		supportsTools: true,
		commands: [],
		supportsThinking: true,
		supportsPermissions: true,
		supportsQuestions: true,
		supportsAttachments: true,
		supportsFork: false,
		supportsRevert: false,
	};
	// ...invoke handleGetModels with engine.dispatch returning claudeCaps...

	const modelListMsg = /* captured wsHandler.sendTo call */;
	const claudeProvider = modelListMsg.providers.find((p) => p.id === "claude");
	const opus = claudeProvider.models.find((m) => m.id === "claude-opus-4-7");
	expect(opus.variants).toEqual(["low", "medium", "high", "max"]);
});
```

**Step 3: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/handlers/model-variants-claude.test.ts
```

Expected: FAIL — the Claude merge block currently doesn't forward `variants`.

**Step 4: Modify `src/lib/handlers/model.ts`**

Find the Claude merge block (around lines 86-96). Add the same `variants` spread that the OpenCode block already uses:

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
					})),
				});
```

**Step 5: Modify `src/lib/bridges/client-init.ts`**

Apply the identical change to the Claude merge block around lines 352-362 of `client-init.ts`. Use the same `variants` spread.

**Step 6: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/handlers/model-variants-claude.test.ts
```

Expected: PASS.

**Step 7: Run broader handler tests for regression**

```bash
pnpm test:unit -- test/unit/handlers test/unit/bridges
```

Expected: all existing tests PASS. Adding `variants` is additive — existing assertions on `id`/`name`/`limit` keep working.

**Step 8: Commit**

```bash
git add src/lib/handlers/model.ts src/lib/bridges/client-init.ts test/unit/handlers/model-variants-claude.test.ts
git commit -m "feat(handlers): forward Claude model variants in model_list payload"
```

---

### Task 7: Make `switch_variant` handler Claude-aware

**Files:**
- Modify: `src/lib/handlers/model.ts:320-395` (the `handleSwitchVariantImpl` Effect function)

The current handler (lines 354-372) looks up available variants by calling OpenCode's REST endpoint `client.provider.list()`. For a Claude model selection this returns nothing — so after the user picks an effort the `variant_info` echo carries `availableVariants: []`, breaking the frontend's idea of what variants exist for the model.

Fix: branch on the active model's provider. For Claude, fetch variants from the orchestration engine's cached probe via `engine.dispatch({type:"discover", providerId:"claude"})`. For OpenCode, keep the existing path.

**Step 1: Write the failing test**

Add to (or create) `test/unit/handlers/switch-variant.test.ts` (look at the existing handler test scaffolding for the Effect harness pattern):

```typescript
it("returns Claude variants when active model is Claude", async () => {
	// Active session model is claude-opus-4-7. Engine probe returns
	// variants { low, medium, high, max }.
	const wsMessages: unknown[] = [];
	// ...wire wsHandler, overrides, mocked orchestrationEngine.dispatch ...

	await runHandleSwitchVariant({ variant: "high", clientId: "test" });

	const variantInfo = wsMessages.find(
		(m) => (m as { type?: unknown }).type === "variant_info",
	) as { variant: string; variants: string[] };
	expect(variantInfo.variant).toBe("high");
	expect(variantInfo.variants).toEqual(["low", "medium", "high", "max"]);
});

it("falls back to OpenCode lookup when active model is opencode", async () => {
	// Regression: existing OpenCode path still works.
	// ...wire client.provider.list() returning a variants record for the
	// active OpenCode model ...

	await runHandleSwitchVariant({ variant: "v2", clientId: "test" });

	const variantInfo = /* capture */;
	expect(variantInfo.variants.length).toBeGreaterThan(0);
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/handlers/switch-variant.test.ts
```

Expected: FAIL on the Claude branch.

**Step 3: Modify the handler**

Inside `handleSwitchVariantImpl` in `src/lib/handlers/model.ts`, replace lines 353-373 (the `availableVariants` lookup block) with:

```typescript
		// Resolve available variants for the active model. For Claude we read
		// from the orchestration engine's cached probe; for OpenCode we keep
		// using client.provider.list().
		let availableVariants: string[] = [];
		if (activeModel) {
			if (activeModel.providerID === "claude") {
				const engineOption = yield* Effect.serviceOption(
					OrchestrationEngineTag,
				);
				if (engineOption._tag === "Some") {
					const capsResult = yield* Effect.either(
						Effect.tryPromise(() =>
							engineOption.value.dispatch({
								type: "discover",
								providerId: "claude",
							}),
						),
					);
					if (capsResult._tag === "Right") {
						const m = capsResult.right.models.find(
							(mod) => mod.id === activeModel.modelID,
						);
						if (m?.variants) availableVariants = Object.keys(m.variants);
					} else {
						log.warn(
							`Failed to fetch Claude variant list: ${capsResult.left instanceof Error ? capsResult.left.message : capsResult.left}`,
						);
					}
				}
			} else {
				const provListResult = yield* Effect.either(
					Effect.tryPromise(() => client.provider.list()),
				);
				if (provListResult._tag === "Right") {
					for (const p of provListResult.right.providers) {
						const m = (p.models ?? []).find(
							(mod) => mod.id === activeModel.modelID,
						);
						if (m?.variants) {
							availableVariants = Object.keys(m.variants);
							break;
						}
					}
				} else {
					log.warn(
						`Failed to fetch variant list: ${provListResult.left instanceof Error ? provListResult.left.message : provListResult.left}`,
					);
				}
			}
		}
```

Make sure `OrchestrationEngineTag` is imported alongside the other tag imports at the top of the file.

**Step 4: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/handlers/switch-variant.test.ts
```

Expected: PASS (both new cases).

**Step 5: Regression — run all handler tests**

```bash
pnpm test:unit -- test/unit/handlers
```

Expected: PASS. The OpenCode branch is byte-identical to today's behaviour.

**Step 6: Commit**

```bash
git add src/lib/handlers/model.ts test/unit/handlers/switch-variant.test.ts
git commit -m "feat(handlers): support Claude variants in switch_variant handler"
```

---

### Task 8: Apply session variant through SDK `options.effort`, including mid-session changes

**Files:**
- Modify: `src/lib/provider/claude/types.ts` (track the active query's effective effort)
- Modify: `src/lib/provider/claude/claude-adapter.ts:305-456` (`sendTurn`, `createSessionAndSendTurn`, `enqueueTurn`)
- Test: `test/unit/provider/claude/claude-adapter-send-turn.test.ts` (add creation + restart/resume coverage)

`SendTurnInput.variant?: string` already exists (`src/lib/provider/types.ts:135`) and `prompt.ts:248` already populates it from `overrides.getVariant(activeId)`. Today's adapter ignores it. Fix two paths:

- On SDK query creation, pass the selected variant as `options.effort`.
- On a later turn for an already-active conduit session, if the selected variant changed, close the current SDK query and create a replacement query with the latest `resumeSessionId`, then send the turn through the new query.

Do **not** call a nonexistent SDK mutator. The SDK `Query` type exposes `setModel(...)`, `setPermissionMode(...)`, and `setMaxThinkingTokens(...)`, but no `setEffort(...)`. t3code also only sets normal `options.effort` at query creation; its only per-turn effort-like mode is `ultrathink`, which is prompt text, not SDK `options.effort`. Conduit should support real dropdown changes by restart/resume.

The SDK option is documented at `sdk.d.ts` (`effort?: EffortLevel`).

**Step 1: Write the failing test**

Open `test/unit/provider/claude/claude-adapter-send-turn.test.ts` and add a new `it` block (the existing test setup already supplies an injectable `queryFactory`):

```typescript
it("forwards SendTurnInput.variant as SDK options.effort", async () => {
	const capturedOptions: unknown[] = [];
	const fakeQuery = makeFakeQueryFactory({
		onCall: (params) => capturedOptions.push(params.options),
	});
	const adapter = new ClaudeAdapter({
		workspaceRoot: tmpWorkspace,
		queryFactory: fakeQuery,
	});

	await adapter.sendTurn({
		// ... fill in the minimum SendTurnInput fields the existing tests use ...
		variant: "high",
	});

	expect(capturedOptions).toHaveLength(1);
	expect((capturedOptions[0] as { effort?: string }).effort).toBe("high");
});

it("omits SDK options.effort when no variant is supplied", async () => {
	const capturedOptions: unknown[] = [];
	const fakeQuery = makeFakeQueryFactory({
		onCall: (params) => capturedOptions.push(params.options),
	});
	const adapter = new ClaudeAdapter({
		workspaceRoot: tmpWorkspace,
		queryFactory: fakeQuery,
	});

	await adapter.sendTurn({
		// ...minimum SendTurnInput WITHOUT a variant ...
	});

	expect(capturedOptions).toHaveLength(1);
	expect((capturedOptions[0] as { effort?: string }).effort).toBeUndefined();
});

it("restarts and resumes the Claude query when effort changes mid-session", async () => {
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
		variant: "low",
	});
	// Complete the first fake query with a result that carries session_id
	// "sdk-session-1", matching the existing fake-query result helper.

	await adapter.sendTurn({
		// ...same conduit session, next user turn...
		variant: "high",
	});

	expect(capturedOptions).toHaveLength(2);
	expect((capturedOptions[0] as { effort?: string }).effort).toBe("low");
	expect((capturedOptions[1] as { effort?: string; resume?: string }).effort).toBe(
		"high",
	);
	expect((capturedOptions[1] as { resume?: string }).resume).toBe("sdk-session-1");
});

it("does not restart the Claude query when effort is unchanged", async () => {
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
		variant: "high",
	});
	await adapter.sendTurn({
		// ...same conduit session, next user turn...
		variant: "high",
	});

	expect(capturedOptions).toHaveLength(1);
});

it("restarts and clears SDK effort when the user returns to default effort", async () => {
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
		variant: "high",
	});
	await adapter.sendTurn({
		// ...same conduit session, next user turn, no variant...
	});

	expect(capturedOptions).toHaveLength(2);
	expect((capturedOptions[1] as { effort?: string }).effort).toBeUndefined();
});
```

Re-use whatever `makeFakeQueryFactory` / fixture helper the file already has. If none exists, look at one of the other `claude-adapter-*.test.ts` files for the existing pattern.

**Step 2: Run test to verify it fails**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: FAIL on the new variant test (existing tests still pass).

**Step 3: Modify `claude/types.ts`**

In `ClaudeSessionContext`, add the active query's normalized effort:

```typescript
	currentEffort: NonNullable<SDKOptions["effort"]> | undefined;
```

If importing `SDKOptions` into the type file creates an awkward dependency, use a local string union matching SDK-derived effort values:

```typescript
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
```

**Step 4: Add a small normalizer in `claude-adapter.ts`**

```typescript
function effortFromVariant(
	variant: string | undefined,
): NonNullable<SDKOptions["effort"]> | undefined {
	if (!variant) return undefined;
	return variant as NonNullable<SDKOptions["effort"]>;
}
```

The cast is needed because `input.variant` is `string` while `SDKOptions["effort"]` is `EffortLevel | number`. The dropdown only surfaces SDK-derived effort levels (Task 2 maps `supportedEffortLevels` into the variants record), so the runtime value is always one of the valid SDK strings. This is a documented narrowing, not a guess.

**Step 5: Modify query creation in `claude-adapter.ts`**

Find the SDK options builder inside `createSessionAndSendTurn` (around line 395-404):

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
			};
```

Before building the options, compute:

```typescript
const effort = effortFromVariant(input.variant);
```

Then replace the options block with:

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
				...(effort ? { effort } : {}),
			};
```

When creating `ClaudeSessionContext`, set `currentEffort: effort`.

**Step 6: Restart/resume when the effort changes**

In `sendTurn`, before `return this.enqueueTurn(existingCtx, input)`, compare the active query's effort with the requested effort:

```typescript
const requestedEffort = effortFromVariant(input.variant);
if (existingCtx.currentEffort !== requestedEffort) {
	return this.restartSessionForEffortChange(existingCtx, input, requestedEffort);
}
return this.enqueueTurn(existingCtx, input);
```

Add a helper that preserves the resume cursor, closes the old query, removes it from the session map, and creates a replacement query:

```typescript
private async restartSessionForEffortChange(
	ctx: ClaudeSessionContext,
	input: SendTurnInput,
	_effort: NonNullable<SDKOptions["effort"]> | undefined,
): Promise<TurnResult> {
	const resumeSessionId = ctx.resumeSessionId;

	try {
		ctx.promptQueue.close();
	} catch {}
	try {
		ctx.query.close();
	} catch {}

	(ctx as { stopped: boolean }).stopped = true;
	this.sessions.delete(ctx.sessionId);

	return this.createSessionAndSendTurn({
		...input,
		providerState: {
			...input.providerState,
			...(resumeSessionId ? { resumeSessionId } : {}),
		},
	});
}
```

This helper runs only between turns. Do not use `cleanupSession(...)` here: it emits interruption/failed-tool behavior intended for abort/end-session paths, not a normal configuration change between completed turns.

**Step 7: Run test to verify it passes**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-send-turn.test.ts
```

Expected: PASS (existing + new tests).

**Step 8: Typecheck**

```bash
pnpm check
```

Expected: clean.

**Step 9: Commit**

```bash
git add src/lib/provider/claude/types.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-send-turn.test.ts
git commit -m "feat(claude): pass session variant through to SDK options.effort"
```

---

### Task 9: Full verification gate

**Step 1: Typecheck**

```bash
pnpm check
```

Expected: clean exit.

**Step 2: Lint**

```bash
pnpm lint
```

Expected: clean exit.

**Step 3: Unit tests**

```bash
pnpm test:unit
```

Expected: PASS. Compare test count vs main branch — should be **roughly +21 tests**: TTLCache 6, probe 8 (6 original + maps-variants + omits-variants), cached probe 3, adapter-discover 3, model-variants-claude 1, switch-variant 2 (Claude + OpenCode regression), adapter-send-turn 2 (variant→effort + omit) ≈ 25, minus zero existing tests deleted. If tests are missing, you skipped or accidentally disabled some.

**Step 4: Full test suite (logged)**

```bash
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Expected: pass apart from any pre-existing `EADDRINUSE` port-conflict flake that already exists on main (mentioned in conversation history).

Search the log for any new failures that mention the changed files:

```bash
grep -i "claude-adapter\|capabilities-probe\|ttl-cache" test-output.log | head -50
```

Expected: only PASS / OK / DONE lines, no FAIL.

**Step 5: Final commit (if anything trailed)**

If lint or check auto-formatted anything:

```bash
git status --short
git add src/lib/provider/claude src/lib/provider src/lib/handlers src/lib/bridges src/lib/frontend test/unit
git commit -m "chore: lint/format cleanup after probe refactor"
```

---

## Out of scope (do NOT include in this PR)

This plan is **PR 1 of 3**. Subsequent PRs build on the probe/cache/effort foundation laid here:

- **PR 2: Subscription detection + 1M context window** — see `docs/plans/2026-05-11-claude-subscription-1m-context.md`. Reads `init.account?.subscriptionType` from the probe, adds a separate context-window dropdown in the UI, and applies 1M by switching the effective Claude SDK model id to the t3code-style `"<model>[1m]"` suffix.
- **PR 3: SDK-sourced commands + agents for the active provider/model** — see `docs/plans/2026-05-11-claude-commands-agents-merge.md`. Surfaces Claude SDK commands and agents when Claude is the active provider, while keeping OpenCode commands/agents scoped to OpenCode sessions. Uses the existing probe result populated in this PR (`init.commands`, `init.agents`).

Other items kept out:

- **UI for fast-mode / auto-mode / adaptive-thinking toggles** — conduit has no existing control surface for these. The effort dropdown IS in scope and works via the existing `ModelVariant.svelte`. Other SDK capability flags are left on the SDK side until a design exists.
- **Auto-PR workflow to refresh hardcoded context-window limits from LiteLLM** — separate plan, kept out of this PR (covered by Plan C's adjacent work or a fourth dedicated plan).
- Per-model context window probe via `getContextUsage()` (one extra spawn per model) — current hardcoded family map is adequate; revisit if/when Anthropic ships materially different context limits within the Claude family.
- Refresh button in UI — explicitly out of scope per user requirement that the cache TTL is sufficient.
- Migrating `TTLCache` to Effect `Cache.make` — the existing Effect migration plan covers this conversion.

## Hand-off to PR 2

The probe (Task 2 of this plan) returns a `ProbeResult` with `models` only today. PR 2 extends `ProbeResult` and `getCachedClaudeCapabilities` to also surface `subscriptionType: string | undefined` and `contextWindowOptions` per model. To make PR 2's diff minimal, leave `ProbeResult` as an `export`-ed interface and place its definition near the top of `claude-capabilities-probe.ts` — PR 2 will add fields, not refactor the type's location.

## Risk register

| Risk | Mitigation |
|---|---|
| Probe spawn delay slows first `discover()` call | Cache shared across calls; only first call after daemon start or TTL expiry pays the cost. Probe is ~100-500ms — acceptable. |
| `claude` binary missing → probe errors → fallback list shown | `discover()` catches probe errors and returns `FALLBACK_MODELS`. Log warning so user can diagnose. |
| SDK changes `initializationResult()` shape | Test mocks the shape used today; if SDK changes, tests + probe both need updating. Caught at typecheck time because `init.models` is typed. |
| Concurrent `discover()` calls during cache miss spawn multiple probes | `TTLCache.inFlight` field deduplicates concurrent lookups (covered by test in Task 1). |
| Probe leaks subprocess on abort failure | `finally` block aborts the controller; SDK kills its child process on abort. If the SDK ever fails to honor abort, we'd see lingering processes — would require an SDK bug report. |
| Module-level cache survives daemon restart on a test rerun | `resetCapabilityCacheForTesting()` is exported and used in `beforeEach`/`afterEach`. Forgetting it would leak state across tests. |
| SDK adds new effort level not in conduit's variant cycle | `ModelVariant.svelte` reads variants from the data, not from a hardcoded list — new levels appear automatically in the dropdown. The Ctrl+T cycle comment ("low → medium → high → max") in `ModelVariant.svelte` is mildly stale and can be cleaned up in a follow-up if it bothers anyone. |
| User had Claude-incompatible variant (e.g. OpenCode `"thinking"`) persisted in `relaySettings.defaultVariants` and switches to a Claude model | `claude-adapter.ts` casts `input.variant` to `EffortLevel`. Mitigation: Task 7 validates the selected variant against the active Claude model's variants before storing it; Task 8 only applies non-empty variants from that path and restarts/resumes when the effective effort changes. If a stale value still leaks through, the SDK error path becomes a normal `turn.error` event. |
| Effort changes while a Claude turn is actively running | The UI already blocks duplicate sends through the processing timeout/turn state. The adapter restart helper in Task 8 is designed for the next user turn after the previous result has resolved. Do not use it as an interrupt mechanism. |
| `prompt.ts` populates `SendTurnInput.variant` for the Claude session but the user's selected variant was made when no model was active (default) | `overrides.defaultVariant` is used in that case (line 374-376 of `bridges/client-init.ts`). Existing behaviour; not changed by this PR. |
| Switch-variant handler's Claude branch dispatches `discover` synchronously inside a hot path | `discover` reads the TTL cache — no probe spawn unless cache miss (max once per 5 min). Worst case 100-500ms wait once per cache window; acceptable for a UI click. |
