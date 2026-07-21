# Agent & Model Visibility Settings Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** A "Agents & Models" settings tab that hides selected agents/models from the input-area dropdowns, persisted globally in `~/.conduit/settings.jsonc`.

**Architecture:** Server stores hide-lists in `RelaySettings` (hide-list semantics: new discoveries appear by default). Full lists keep flowing to clients; hidden keys ride alongside (`GetModelsResponse.hiddenModels`, `GetAgentsResponse.hiddenAgents`) and a new `visibility_info` broadcast pushes live updates. Filtering is presentation-only via `$derived` in the two selectors, with a never-brick guard. Design doc: `docs/plans/2026-07-22-agent-model-visibility-settings-design.md`.

**Two deliberate refinements vs the design doc** (same intent, fewer edge cases):
1. Live updates use a new tiny broadcast `visibility_info { hiddenModels, hiddenAgents }` instead of rebroadcasting `model_list`/`agent_list`. `agent_list` is per-client provider-scoped, so a global rebroadcast would be wrong; `visibility_info` is scope-free.
2. Agent keys use `"<scopeId>/<agentId>"` (`AgentInfo.id`, the stable identifier used for `activeAgentId`) rather than agent *name*.

**Key formats:** model `"<providerId>/<modelId>"`, agent `"<scopeId>/<agentId>"` where scopeId is `"opencode" | "claude"` (`discoveryState.agentProviderScope.id`).

**Tech Stack:** TypeScript, Effect (`@effect/rpc`, `effect/Schema`), Svelte 5 runes, vitest.

**Conventions for the executor:**
- Repo commands: `pnpm vitest run <file>` for a single test file; `bash -o pipefail -c 'pnpm check 2>&1 | tail -c 500'` for typecheck. Always byte-cap command output.
- The repo pre-commit hook runs build/typecheck/lint/test. The working tree may contain unrelated in-flight changes from other sessions — do NOT stash or touch them. If the hook fails on files you did not touch, commit with `--no-verify` and note it; if it fails on your files, fix them.
- `git add` only the files listed in each task. Never `git add -A`.

---

### Task 1: RelaySettings persistence

**Files:**
- Modify: `src/lib/relay/relay-settings.ts`
- Test: `test/unit/relay/relay-settings.test.ts`

**Step 1: Write the failing tests**

Append a new describe block inside the top-level `describe("relay-settings", ...)` in `test/unit/relay/relay-settings.test.ts`:

```ts
describe("hidden entries persistence", () => {
	it("saves and loads hiddenModels and hiddenAgents", () => {
		saveRelaySettings(
			{
				hiddenModels: ["openai/gpt-4o", "claude/claude-haiku-4"],
				hiddenAgents: ["opencode/plan"],
			},
			tempDir,
		);
		const settings = loadRelaySettings(tempDir);
		expect(settings.hiddenModels).toEqual([
			"openai/gpt-4o",
			"claude/claude-haiku-4",
		]);
		expect(settings.hiddenAgents).toEqual(["opencode/plan"]);
	});

	it("replaces (not merges) hidden lists on save", () => {
		saveRelaySettings({ hiddenModels: ["a/b", "c/d"] }, tempDir);
		saveRelaySettings({ hiddenModels: ["e/f"] }, tempDir);
		expect(loadRelaySettings(tempDir).hiddenModels).toEqual(["e/f"]);
	});

	it("clears a hidden list when saving an empty array", () => {
		saveRelaySettings({ hiddenAgents: ["opencode/plan"] }, tempDir);
		saveRelaySettings({ hiddenAgents: [] }, tempDir);
		expect(loadRelaySettings(tempDir).hiddenAgents).toEqual([]);
	});

	it("preserves hidden lists when saving unrelated fields", () => {
		saveRelaySettings({ hiddenModels: ["a/b"] }, tempDir);
		saveRelaySettings({ defaultModel: "openai/gpt-4o" }, tempDir);
		const settings = loadRelaySettings(tempDir);
		expect(settings.hiddenModels).toEqual(["a/b"]);
		expect(settings.defaultModel).toBe("openai/gpt-4o");
	});

	it("preserves defaultModel/defaultVariants when saving hidden lists", () => {
		saveRelaySettings(
			{ defaultModel: "openai/gpt-4o", defaultVariants: { "openai/gpt-4o": "high" } },
			tempDir,
		);
		saveRelaySettings({ hiddenModels: ["a/b"] }, tempDir);
		const settings = loadRelaySettings(tempDir);
		expect(settings.defaultModel).toBe("openai/gpt-4o");
		expect(settings.defaultVariants).toEqual({ "openai/gpt-4o": "high" });
		expect(settings.hiddenModels).toEqual(["a/b"]);
	});

	it("returns undefined hidden lists when never saved", () => {
		saveRelaySettings({ defaultModel: "a/b" }, tempDir);
		const settings = loadRelaySettings(tempDir);
		expect(settings.hiddenModels).toBeUndefined();
		expect(settings.hiddenAgents).toBeUndefined();
	});
});
```

**Step 2: Run tests, verify the new ones fail**

Run: `pnpm vitest run test/unit/relay/relay-settings.test.ts 2>&1 | tail -c 1500`
Expected: existing tests PASS; new tests FAIL (TS error / undefined fields).

**Step 3: Implement**

In `src/lib/relay/relay-settings.ts`:

```ts
export interface RelaySettings {
	defaultModel?: string;
	defaultVariants?: Record<string, string>;
	/** Model keys ("<providerId>/<modelId>") hidden from the model dropdown. */
	hiddenModels?: string[];
	/** Agent keys ("<scopeId>/<agentId>") hidden from the agent dropdown. */
	hiddenAgents?: string[];
}
```

In `saveRelaySettings`, after the `defaultVariants` merge block (replace semantics — a provided array wins wholesale, including empty):

```ts
if (settings.hiddenModels !== undefined) {
	merged.hiddenModels = [...settings.hiddenModels];
}
if (settings.hiddenAgents !== undefined) {
	merged.hiddenAgents = [...settings.hiddenAgents];
}
```

**Step 4: Run tests, verify pass**

Run: `pnpm vitest run test/unit/relay/relay-settings.test.ts 2>&1 | tail -c 800`
Expected: all PASS.

**Step 5: Commit**

```bash
git add src/lib/relay/relay-settings.ts test/unit/relay/relay-settings.test.ts
git commit -m "feat(relay): persist hiddenModels/hiddenAgents in relay settings"
```

**Coverage rationale:** round-trip, replace-not-merge, empty-array-clears, cross-field preservation both directions, absent-field default. Regression: the full existing `relay-settings.test.ts` suite runs in the same file.

---

### Task 2: Contracts and shared types

**Files:**
- Modify: `src/lib/contracts/ws-rpc.ts` (`GetModelsResponseSchema` ~line 163, `GetAgentsResponseSchema` ~line 268, tagged-request section ~line 654, request list ~line 977, `WsRpcGroup` ~line 1027)
- Modify: `src/lib/frontend/transport/ws-rpc.ts` (hand-maintained re-export barrel — `ws-rpc-client.ts` imports response types from here, NOT from contracts)
- Modify: `src/lib/shared-types.ts` (push schemas ~line 778, message-type list ~line 1159, `RelayMessage` union ~line 1361)
- Test: `test/unit/schema/relay-message.test.ts` (decode assertion — see Step 3a)

`pnpm check` alone is NOT sufficient here: the `RelayMessageSchema` union has no compile-time link to the message-type string list, and the frontend boundary (`effect-boundary.ts:52-65`) throws `ProtocolDecodeError` at runtime for a known type missing from the schema union. Step 3a's test closes that gap.

**Step 1: Extend response schemas** in `src/lib/contracts/ws-rpc.ts`:

```ts
export const GetModelsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	providers: Schema.Array(ProviderInfoSchema),
	active: Schema.optional(ModelSelectionSchema),
	variant: Schema.optional(VariantInfoSchema),
	contextWindow: Schema.optional(ContextWindowInfoSchema),
	permissionMode: Schema.optional(SessionPermissionModeSchema),
	hiddenModels: Schema.optional(Schema.Array(Schema.String)),
});
```

```ts
export const GetAgentsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	providerScope: AgentProviderScopeSchema,
	agents: Schema.Array(AgentInfoSchema),
	activeAgentId: Schema.optional(Schema.String),
	hiddenAgents: Schema.optional(Schema.Array(Schema.String)),
});
```

**Step 2: Add the RPC request.** Next to `SetDefaultModel` (~line 654), add:

```ts
export const SetHiddenEntriesResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	hiddenModels: Schema.Array(Schema.String),
	hiddenAgents: Schema.Array(Schema.String),
});

export class SetHiddenEntries extends Schema.TaggedRequest<SetHiddenEntries>()(
	"SetHiddenEntries",
	{
		failure: WsRpcError,
		success: SetHiddenEntriesResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			hiddenModels: Schema.optional(Schema.Array(Schema.String)),
			hiddenAgents: Schema.optional(Schema.Array(Schema.String)),
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}
```

Export the type alongside the other response types (~line 380):

```ts
export type SetHiddenEntriesResponse = typeof SetHiddenEntriesResponseSchema.Type;
```

Register `SetHiddenEntries` in BOTH the request list (~line 977–985 block, next to `SetDefaultModel`) and `WsRpcGroup` (`Rpc.fromTaggedRequest(SetHiddenEntries)` next to the `SetDefaultModel` entry ~line 1036). Mirror exactly how `SetDefaultModel` appears in each place.

**Step 2a: Update the frontend transport barrel.** `src/lib/frontend/transport/ws-rpc.ts` is an explicit re-export list that `ws-rpc-client.ts` imports from. Add `SetHiddenEntriesResponse` (and `SetHiddenEntries` if the barrel re-exports request classes — mirror exactly what it does for `SetDefaultModel`/`SetDefaultModelResponse`).

**Step 3: Add the push message** in `src/lib/shared-types.ts`. After `AgentListSchema` (~line 788):

```ts
const VisibilityInfoSchema = Schema.Struct({
	type: Schema.Literal("visibility_info"),
	hiddenModels: Schema.Array(Schema.String),
	hiddenAgents: Schema.Array(Schema.String),
});
```

Then wire it everywhere the sibling messages appear (find each by searching for `"agent_list"` in the file):
- Add `VisibilityInfoSchema` to the schema union that includes `AgentListSchema`.
- Add `"visibility_info"` to the message-type string list (~line 1159, next to `"agent_list"`).
- Add to the `RelayMessage` TS union (~line 1361):

```ts
| { type: "visibility_info"; hiddenModels: string[]; hiddenAgents: string[] }
```

CRITICAL: `VisibilityInfoSchema` must be added to the `RelayMessageSchema` runtime union — forgetting it still passes `pnpm check` but makes every client throw `ProtocolDecodeError` on the first broadcast.

**Step 3a: Add a decode regression test.** In `test/unit/schema/relay-message.test.ts` (follow the file's existing decode-assertion pattern for a sibling message like `agent_list`), add:

```ts
it("decodes visibility_info messages", () => {
	// Use the file's existing idiom (see its agent_list case):
	// const result = Schema.decodeUnknownEither(RelayMessageSchema)({
	// 	type: "visibility_info",
	// 	hiddenModels: ["a/b"],
	// 	hiddenAgents: ["c/d"],
	// });
	// expect(Either.isRight(result)).toBe(true);
});
```

**Step 4: Typecheck + schema test**

Run: `bash -o pipefail -c 'pnpm check 2>&1 | tail -c 800'`
Run: `pnpm vitest run test/unit/schema/relay-message.test.ts 2>&1 | tail -c 800`
Expected: clean / PASS. (If `shared-types.ts` has an exhaustive frontend dispatch switch, Task 4 adds the case; a temporary unhandled-message-type error here is acceptable only if `pnpm check` still passes — otherwise add a no-op dispatch case now and replace it in Task 4.)

**Step 5: Commit**

```bash
git add src/lib/contracts/ws-rpc.ts src/lib/frontend/transport/ws-rpc.ts src/lib/shared-types.ts test/unit/schema/relay-message.test.ts
git commit -m "feat(contracts): SetHiddenEntries rpc + visibility_info push message"
```

---

### Task 3: Server handler + RPC wiring

**Files:**
- Create: `src/lib/handlers/visibility.ts`
- Modify: `src/lib/server/ws-rpc.ts` (`GetModels` handler ~line 696, `GetAgents` handler ~line 174, new `SetHiddenEntries` entry next to `SetDefaultModel` ~line 539)
- Modify: `test/unit/server/ws-rpc-agents.test.ts` (its `toEqual` on the full GetAgents response at ~line 32 breaks when `hiddenAgents` is added — update expectations)
- Test: `test/unit/handlers/visibility.test.ts`

**Test isolation warning:** `makeMockConfig` in `test/helpers/mock-factories.ts` defaults `configDir` to `undefined`, which makes `getHiddenEntries` read the developer's REAL `~/.conduit/settings.jsonc`. Every test touching these handlers must stub `ConfigTag` with a tempdir `configDir`.

**Step 1: Write the failing test**

Create `test/unit/handlers/visibility.test.ts`. Mirror the layer-stubbing pattern from `test/unit/handlers/model-overrides-effect.test.ts` (read it first for the exact `ConfigTag`/`WebSocketHandlerTag`/`LoggerTag` stub helpers this repo uses — reuse its helpers/factories rather than inventing new ones). The behaviors to assert:

```ts
// Shape (adapt stubs to the repo pattern):
describe("setHiddenEntriesForRelay", () => {
	it("persists provided lists to relay settings and broadcasts visibility_info", async () => {
		// run setHiddenEntriesForRelay({ clientId: "c1", hiddenModels: ["a/b"], hiddenAgents: ["opencode/plan"] })
		// with ConfigTag stubbed to a tempDir
		// expect loadRelaySettings(tempDir) => { hiddenModels: ["a/b"], hiddenAgents: ["opencode/plan"] }
		// expect wsHandler.broadcast called with
		//   { type: "visibility_info", hiddenModels: ["a/b"], hiddenAgents: ["opencode/plan"] }
		// expect the returned value to equal { hiddenModels: ["a/b"], hiddenAgents: ["opencode/plan"] }
	});

	it("leaves the omitted list untouched", async () => {
		// pre-seed tempDir with saveRelaySettings({ hiddenAgents: ["claude/researcher"] })
		// call with only { hiddenModels: ["x/y"] }
		// expect persisted hiddenAgents still ["claude/researcher"], and the broadcast/result
		// to carry hiddenAgents: ["claude/researcher"] (merged view, not [])
	});
});

describe("getHiddenEntries", () => {
	it("returns empty arrays when nothing persisted", () => {
		// expect { hiddenModels: [], hiddenAgents: [] } for a fresh tempDir
	});
});
```

**Step 2: Run test, verify it fails**

Run: `pnpm vitest run test/unit/handlers/visibility.test.ts 2>&1 | tail -c 800`
Expected: FAIL (module not found).

**Step 3: Implement `src/lib/handlers/visibility.ts`**

Copy import paths for `ConfigTag`, `LoggerTag`, `WebSocketHandlerTag`, and the relay-settings functions from the top of `src/lib/handlers/model.ts` (it already imports all of them).

```ts
// ─── Visibility Handlers ─────────────────────────────────────────────────────
// Global hide-lists for the agent/model dropdowns. Persisted in relay settings.

import { Effect } from "effect";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";
// + ConfigTag / LoggerTag / WebSocketHandlerTag imports, same paths as model.ts

export interface HiddenEntries {
	readonly hiddenModels: string[];
	readonly hiddenAgents: string[];
}

/** Read the persisted hide-lists (empty arrays when unset). */
export function getHiddenEntries(configDir?: string): HiddenEntries {
	const settings = loadRelaySettings(configDir);
	return {
		hiddenModels: settings.hiddenModels ?? [],
		hiddenAgents: settings.hiddenAgents ?? [],
	};
}

export interface SetHiddenEntriesInput {
	readonly clientId: string;
	readonly hiddenModels?: readonly string[] | undefined;
	readonly hiddenAgents?: readonly string[] | undefined;
}

export const setHiddenEntriesForRelay = (input: SetHiddenEntriesInput) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		// Effect.try, NOT Effect.sync: an fs throw must surface as a typed failure
		// that the RPC entry's Effect.catchAll can convert to WsRpcError (an
		// Effect.sync throw becomes an uncatchable defect). This mirrors
		// saveRelaySettingsEffect in src/lib/handlers/model.ts:41-48 — reuse or
		// extract that helper if it fits.
		yield* Effect.try(() =>
			saveRelaySettings(
				{
					...(input.hiddenModels !== undefined
						? { hiddenModels: [...input.hiddenModels] }
						: {}),
					...(input.hiddenAgents !== undefined
						? { hiddenAgents: [...input.hiddenAgents] }
						: {}),
				},
				config.configDir,
			),
		);

		const entries = getHiddenEntries(config.configDir);
		wsHandler.broadcast({ type: "visibility_info", ...entries });
		log.info(
			`client=${input.clientId} Hidden entries updated: ${entries.hiddenModels.length} models, ${entries.hiddenAgents.length} agents`,
		);
		return entries;
	});
```

(If `saveRelaySettings` typing rejects the spread-built object, pass explicit fields; keep replace semantics from Task 1.)

**Step 4: Run test, verify pass**

Run: `pnpm vitest run test/unit/handlers/visibility.test.ts 2>&1 | tail -c 800`
Expected: PASS.

**Step 5: Wire into `src/lib/server/ws-rpc.ts`**

Import `getHiddenEntries, setHiddenEntriesForRelay` from `../handlers/visibility.js` and `ConfigTag` from `../domain/relay/Services/services.js` (no handler in this file reads `ConfigTag` directly yet — these wraps are the first — but it IS in the layer environment, used transitively via `SetDefaultModel`).

- `GetModels` handler (~line 696): wrap so the response gains `hiddenModels`:

```ts
GetModels: (request) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const response = yield* getModelsResponse({
			projectSlug: request.projectSlug,
			...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
		});
		return {
			...response,
			hiddenModels: getHiddenEntries(config.configDir).hiddenModels,
		};
	}).pipe(
		Effect.catchAll((error) =>
			Effect.fail(new WsRpcError({ message: `GetModels failed: ${String(error)}` })),
		),
	),
```

- `GetAgents` handler (~line 174): same pattern — spread the existing result and add `hiddenAgents: getHiddenEntries(config.configDir).hiddenAgents`.
- Add the RPC entry next to `SetDefaultModel` (~line 539):

```ts
SetHiddenEntries: (request) =>
	setHiddenEntriesForRelay({
		clientId: request.originId ?? "rpc",
		hiddenModels: request.hiddenModels,
		hiddenAgents: request.hiddenAgents,
	}).pipe(
		Effect.map((entries) => ({
			projectSlug: request.projectSlug,
			hiddenModels: entries.hiddenModels,
			hiddenAgents: entries.hiddenAgents,
		})),
		Effect.catchAll((error) =>
			Effect.fail(
				new WsRpcError({ message: `SetHiddenEntries failed: ${String(error)}` }),
			),
		),
	),
```

**Step 6: Typecheck + regression**

The tests that actually cover the edited handlers are `ws-rpc-agents.test.ts` and `ws-rpc-models.test.ts`. Update `test/unit/server/ws-rpc-agents.test.ts` first: its full-response `toEqual` (~line 32) must now expect `hiddenAgents: []` — and give the stubbed `ConfigTag` a tempdir `configDir` (`makeMockConfig({ configDir })`) so the assertion doesn't depend on the developer's real settings file. `ws-rpc-models.test.ts` uses per-field assertions (lines ~83-127) and needs NO expectation change from `hiddenModels` — just re-run it.

Run: `bash -o pipefail -c 'pnpm check 2>&1 | tail -c 800'`
Run: `pnpm vitest run test/unit/server/ws-rpc-agents.test.ts test/unit/server/ws-rpc-models.test.ts 2>&1 | tail -c 800`
Expected: clean / PASS.

**Step 7: Commit**

```bash
git add src/lib/handlers/visibility.ts src/lib/server/ws-rpc.ts test/unit/handlers/visibility.test.ts test/unit/server/ws-rpc-agents.test.ts test/unit/server/ws-rpc-models.test.ts
git commit -m "feat(server): SetHiddenEntries rpc handler with visibility_info broadcast"
```

**Coverage rationale:** persist+broadcast+return, partial-update semantics, empty default, fs-failure surfaced as WsRpcError (via Effect.try). Regression: `ws-rpc-agents`/`ws-rpc-models` re-run because they cover the edited GetAgents/GetModels handlers.

---

### Task 4: Frontend store — hidden state + filtered getters

**Files:**
- Modify: `src/lib/frontend/stores/discovery.svelte.ts`
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` (~line 873, next to the `agent_list`/`model_list` cases)
- Test: `test/unit/stores/discovery-visibility.test.ts` (before writing, `ls test/unit/stores` and mirror an existing test there that imports a `.svelte.ts` store — follow its import/reset conventions exactly)

**Step 1: Write the failing tests**

Behaviors (use plain `AgentInfo`/`ProviderInfo` fixtures; reset state between tests via `clearDiscoveryState()`):

```ts
describe("visibility filtering", () => {
	// getVisibleAgents()
	it("filters agents whose <scopeId>/<agentId> key is hidden", () => {
		// scope {id:"opencode"}, agents [build, plan]; hiddenAgents=["opencode/plan"]
		// expect getVisibleAgents() => [build]
	});
	it("never-brick: returns all agents when every agent is hidden", () => {
		// hiddenAgents covers both agents => expect both returned
	});
	it("ignores hidden keys from a different scope", () => {
		// hiddenAgents=["claude/plan"], scope opencode => plan stays visible
	});
	it("returns all agents when scope is null", () => {
		// agentProviderScope = null => no filtering (keys are scope-qualified)
	});

	// getVisibleProviderGroups()
	it("filters hidden models within a provider group", () => {
		// provider "openai" models [gpt-4o, gpt-4o-mini]; hiddenModels=["openai/gpt-4o-mini"]
		// expect group models => [gpt-4o]
	});
	it("drops a provider group whose models are all hidden", () => {
		// two providers; all of provider B's models hidden => only A's group returned
	});
	it("never-brick: returns unfiltered groups when all models everywhere are hidden", () => {
		// hide every model of every provider => expect original groups
	});
	it("handleVisibilityInfo updates state and clearDiscoveryState resets it", () => {
		// handleVisibilityInfo({type:"visibility_info", hiddenModels:["a/b"], hiddenAgents:["c/d"]})
		// expect discoveryState.hiddenModels/hiddenAgents set; after clearDiscoveryState() both []
	});

	// RPC-reply paths (applyGetModelsResponse / applyGetAgentsResponse)
	it("applyGetModelsResponse with hiddenModels populates state", () => {
		// response including hiddenModels: ["openai/gpt-4o"] => discoveryState.hiddenModels === ["openai/gpt-4o"]
	});
	it("applyGetAgentsResponse with hiddenAgents populates state", () => {
		// response including hiddenAgents: ["opencode/plan"] => discoveryState.hiddenAgents === ["opencode/plan"]
	});
	it("responses omitting hidden fields leave existing hidden state untouched", () => {
		// pre-set discoveryState.hiddenModels/hiddenAgents, then apply responses WITHOUT the
		// optional fields (old-server shape) => state unchanged (the `if (response.hiddenX)` guards)
	});
});
```

**Step 2: Run tests, verify fail**

Run: `pnpm vitest run test/unit/stores/discovery-visibility.test.ts 2>&1 | tail -c 800`
Expected: FAIL (getters missing).

**Step 3: Implement in `discovery.svelte.ts`**

State (add to the `$state` object and to `clearDiscoveryState`):

```ts
hiddenModels: [] as string[],
hiddenAgents: [] as string[],
```

Getters (place next to `getProviderGroups`):

```ts
/** Agents visible in the dropdown after applying the global hide-list.
 *  Never-brick: if filtering would leave zero agents, show all. */
export function getVisibleAgents(): AgentInfo[] {
	const scopeId = discoveryState.agentProviderScope?.id;
	if (!scopeId || discoveryState.hiddenAgents.length === 0) {
		return discoveryState.agents;
	}
	const hidden = new Set(discoveryState.hiddenAgents);
	const visible = discoveryState.agents.filter(
		(a) => !hidden.has(`${scopeId}/${a.id}`),
	);
	return visible.length > 0 ? visible : discoveryState.agents;
}

/** Provider groups visible in the dropdown after applying the global hide-list.
 *  Groups with zero visible models are dropped.
 *  Never-brick: if filtering would leave zero models overall, show all. */
export function getVisibleProviderGroups(): ProviderGroup[] {
	const all = getProviderGroups();
	if (discoveryState.hiddenModels.length === 0) return all;
	const hidden = new Set(discoveryState.hiddenModels);
	const filtered = all
		.map((g) => ({
			provider: g.provider,
			models: g.models.filter((m) => !hidden.has(`${g.provider.id}/${m.id}`)),
		}))
		.filter((g) => g.models.length > 0);
	return filtered.length > 0 ? filtered : all;
}
```

Handler + response application:

```ts
export function handleVisibilityInfo(
	msg: Extract<RelayMessage, { type: "visibility_info" }>,
): void {
	discoveryState.hiddenModels = [...msg.hiddenModels];
	discoveryState.hiddenAgents = [...msg.hiddenAgents];
}
```

In `applyGetModelsResponse`, after the `handleModelList` call:

```ts
if (response.hiddenModels) {
	discoveryState.hiddenModels = [...response.hiddenModels];
}
```

In `applyGetAgentsResponse`, after the `handleAgentList` call:

```ts
if (response.hiddenAgents) {
	discoveryState.hiddenAgents = [...response.hiddenAgents];
}
```

In `clearDiscoveryState`: `discoveryState.hiddenModels = []; discoveryState.hiddenAgents = [];`

**Step 4: Wire dispatch** — in `src/lib/frontend/stores/ws-dispatch.ts`, import `handleVisibilityInfo` and add a case next to `model_list` (~line 876):

```ts
case "visibility_info":
	handleVisibilityInfo(msg);
	break;
```

(Match the exact switch style used by the neighboring cases.)

**Step 5: Run tests, verify pass**

Run: `pnpm vitest run test/unit/stores/discovery-visibility.test.ts 2>&1 | tail -c 800`

**Step 6: Commit**

```bash
git add src/lib/frontend/stores/discovery.svelte.ts src/lib/frontend/stores/ws-dispatch.ts test/unit/stores/discovery-visibility.test.ts
git commit -m "feat(frontend): hidden agent/model state with filtered getters"
```

**Coverage rationale:** filter hit, cross-scope miss, null-scope, per-group filtering, group drop, both never-brick guards, live-update handler, reset. Regression: existing `getProviderGroups` behavior is untouched (new getters wrap it); Task 7 runs the full frontend unit suite.

---

### Task 5: Selectors use filtered getters + RPC client

**Files:**
- Modify: `src/lib/frontend/components/model/AgentSelector.svelte` (line 35)
- Modify: `src/lib/frontend/components/model/ModelSelector.svelte` (line 43)
- Modify: `src/lib/frontend/transport/ws-rpc-client.ts`

**Step 1: AgentSelector.** Replace line 35 and the stale comment:

```ts
/** Visible agents — global hide-list applied (server filters subagents). */
const visibleAgents = $derived(getVisibleAgents());
```

Add `getVisibleAgents` to the existing `discovery.svelte.js` import. Existing `shouldHide` (≤1 visible) and `effectiveAgent` fallback logic stay as-is — they now operate on the filtered list, which is the intent.

**Step 2: ModelSelector.** Replace line 43:

```ts
/** Provider groups with the global hide-list applied. */
const allGroups = $derived(getVisibleProviderGroups());
```

Swap `getProviderGroups` → `getVisibleProviderGroups` in the import.

**Step 3: RPC client.** In `src/lib/frontend/transport/ws-rpc-client.ts`, mirror the `SetDefaultModel` plumbing exactly (input type, `callSetHiddenEntries` following the RESPONSE-RETURNING helper shape of `callGetModels`/`callSetDefaultModel` — NOT `callSetLogLevel`, which yields without `return` and discards the response — exported async wrapper next to `getModelsRpc` at ~line 1027):

```ts
export interface SetHiddenEntriesRpcInput {
	projectSlug: string;
	hiddenModels?: string[];
	hiddenAgents?: string[];
	originId?: string;
}

const callSetHiddenEntries = (input: SetHiddenEntriesRpcInput) =>
	Effect.scoped(
		Effect.gen(function* () {
			const client = yield* RpcClient.make(WsRpcGroup);
			return yield* client.SetHiddenEntries(input);
		}),
	).pipe(
		Effect.provide(RpcClient.layerProtocolSocket()),
		Effect.provide(Socket.layerWebSocket(makeWsRpcUrl(input.projectSlug))),
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
		Effect.provide(RpcSerialization.layerJson),
	);

export async function setHiddenEntriesRpc(
	input: SetHiddenEntriesRpcInput,
): Promise<SetHiddenEntriesResponse> {
	return await runTransportEffect(callSetHiddenEntries(input));
}
```

(Import `SetHiddenEntriesResponse` from `./ws-rpc.js` — the transport barrel updated in Task 2 Step 2a — exactly where the other response types are imported. If existing input types in this file are declared differently — e.g. derived from the request payload — follow that convention instead.)

**Step 4: Typecheck**

Run: `bash -o pipefail -c 'pnpm check 2>&1 | tail -c 800'`
Expected: clean.

**Step 5: Commit**

```bash
git add src/lib/frontend/components/model/AgentSelector.svelte src/lib/frontend/components/model/ModelSelector.svelte src/lib/frontend/transport/ws-rpc-client.ts
git commit -m "feat(frontend): apply visibility filters in selectors, add setHiddenEntries rpc"
```

**Regression note:** with nothing hidden (default), `getVisibleAgents`/`getVisibleProviderGroups` short-circuit to the unfiltered lists — dropdown behavior is byte-identical, which Task 7's visual acceptance run confirms.

---

### Task 6: Settings tab UI

**Files:**
- Modify: `src/lib/frontend/components/overlays/SettingsPanel.svelte`

No new unit test — this is declarative markup over already-tested store getters + one RPC call; verification is `pnpm check` + the Task 7 acceptance/visual pass and a manual click-through.

**Step 1: Add the tab.** In the tab array (~line 319) insert after "Theme":

```ts
{ id: "visibility", label: "Agents & Models" },
```

**Step 2: Script additions.** Imports: `discoveryState` from `../../stores/discovery.svelte.js`; `getAgentsRpc, getModelsRpc, setHiddenEntriesRpc` added to the existing `ws-rpc-client.js` import; `applyGetModelsResponse, applyGetAgentsResponse` from the discovery store.

```ts
// ─── Agents & Models visibility ─────────────────────────────────────────
const hiddenModelSet = $derived(new Set(discoveryState.hiddenModels));
const hiddenAgentSet = $derived(new Set(discoveryState.hiddenAgents));
const agentScopeId = $derived(discoveryState.agentProviderScope?.id ?? null);

/** Lazy-load lists when the tab opens with empty discovery state. */
$effect(() => {
	if (activeTab !== "visibility" || !visible) return;
	const slug = getCurrentSlug();
	if (!slug) return;
	if (discoveryState.providers.length === 0) {
		getModelsRpc({ projectSlug: slug }).then(applyGetModelsResponse).catch(() => {});
	}
	if (discoveryState.agents.length === 0) {
		getAgentsRpc({ projectSlug: slug }).then(applyGetAgentsResponse).catch(() => {});
	}
});

// No busy-guard by design (user decision): every call sends the ABSOLUTE hidden
// lists computed from current state, so rapid toggles are last-write-wins safe;
// a guard would silently drop input and desync the toggles.
async function persistHidden(update: {
	hiddenModels?: string[];
	hiddenAgents?: string[];
}): Promise<void> {
	const slug = getCurrentSlug();
	if (!slug) return;
	const prevModels = discoveryState.hiddenModels;
	const prevAgents = discoveryState.hiddenAgents;
	// Optimistic update; the visibility_info broadcast confirms it.
	if (update.hiddenModels) discoveryState.hiddenModels = update.hiddenModels;
	if (update.hiddenAgents) discoveryState.hiddenAgents = update.hiddenAgents;
	try {
		await setHiddenEntriesRpc({ projectSlug: slug, ...update });
	} catch {
		discoveryState.hiddenModels = prevModels;
		discoveryState.hiddenAgents = prevAgents;
		// NOTE: showToast's 2nd arg is an options object; valid variants are "default" | "warn".
		showToast("Failed to save visibility settings", { variant: "warn" });
	}
}

function toggleModel(providerId: string, modelId: string): void {
	const key = `${providerId}/${modelId}`;
	const next = new Set(discoveryState.hiddenModels);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	void persistHidden({ hiddenModels: [...next] });
}

function toggleProviderAll(providerId: string, hide: boolean): void {
	const provider = discoveryState.providers.find((p) => p.id === providerId);
	if (!provider) return;
	const next = new Set(discoveryState.hiddenModels);
	for (const m of provider.models) {
		const key = `${providerId}/${m.id}`;
		if (hide) next.add(key);
		else next.delete(key);
	}
	void persistHidden({ hiddenModels: [...next] });
}

function toggleAgent(agentId: string): void {
	if (!agentScopeId) return;
	const key = `${agentScopeId}/${agentId}`;
	const next = new Set(discoveryState.hiddenAgents);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	void persistHidden({ hiddenAgents: [...next] });
}
```

(`showToast` is already imported in this file. Match the file's `$effect`/handler style; if `getCurrentSlug` is already imported, don't duplicate.)

**Step 3: Tab content markup.** Add a `{:else if activeTab === "visibility"}` branch following the Appearance section's visual language (section headers `text-xs font-semibold uppercase tracking-widest text-text-muted`, rows in `bg-bg-surface border border-border rounded-[10px]`).

**Use `ToggleSetting` rows, not native checkboxes** (user decision — visual consistency with the rest of the panel). `ToggleSetting` is already imported in this file; read `src/lib/frontend/components/shared/ToggleSetting.svelte` first and reuse its `label`/`checked`/`onchange`/`class` props, omitting `icon`/`description` for compact rows. Adapt the sketch below accordingly — replace each `<label><input type="checkbox">…</label>` row with a compact `ToggleSetting` (e.g. `class="px-2 py-1 gap-3 font-brand"` tuned to match the panel):

```svelte
{:else if activeTab === "visibility"}
	<div class="space-y-4">
		<div class="px-1 text-xs text-text-muted font-brand">
			Unchecked items are hidden from the input-area dropdowns. New models and
			agents appear automatically.
		</div>

		<!-- Models -->
		{#each discoveryState.providers.filter((p) => p.models.length > 0) as provider (provider.id)}
			{@const allHidden = provider.models.every((m) => hiddenModelSet.has(`${provider.id}/${m.id}`))}
			<div>
				<div class="flex items-center justify-between px-1 mb-2">
					<div class="text-xs font-semibold uppercase tracking-widest text-text-muted font-brand">{provider.name}</div>
					<button
						class="text-xs text-text-muted hover:text-text cursor-pointer border-none bg-transparent font-brand"
						onclick={() => toggleProviderAll(provider.id, !allHidden)}
					>
						{allHidden ? "Show all" : "Hide all"}
					</button>
				</div>
				<div class="space-y-1 bg-bg-surface border border-border rounded-[10px] px-4 py-2">
					{#each provider.models as model (model.id)}
						<ToggleSetting
							label={model.name || model.id}
							checked={!hiddenModelSet.has(`${provider.id}/${model.id}`)}
							onchange={() => toggleModel(provider.id, model.id)}
							class="py-1.5 gap-3 font-brand"
						/>
					{/each}
				</div>
			</div>
		{/each}

		<!-- Agents (current provider scope only) -->
		{#if agentScopeId && discoveryState.agents.length > 0}
			<div>
				<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">
					{discoveryState.agentProviderScope?.name} agents
				</div>
				<div class="space-y-1 bg-bg-surface border border-border rounded-[10px] px-4 py-2">
					{#each discoveryState.agents as agent (agent.id)}
						<ToggleSetting
							label={agent.name || agent.id}
							checked={!hiddenAgentSet.has(`${agentScopeId}/${agent.id}`)}
							onchange={() => toggleAgent(agent.id)}
							class="py-1.5 gap-3 font-brand"
						/>
					{/each}
				</div>
			</div>
		{/if}
	</div>
```

**Step 4: Typecheck + manual verification**

Run: `bash -o pipefail -c 'pnpm check 2>&1 | tail -c 800'`

Manual check against local conduit at `http://localhost:2633/`: open Settings → Agents & Models; uncheck a model → model dropdown no longer lists it; check it back → reappears; uncheck all models of one provider → provider group disappears from dropdown; confirm `~/.conduit/settings.jsonc` contains the keys; reload the page → hidden state persists. Use the `playwright-cli` skill if a browser is needed.

**Step 5: Commit**

```bash
git add src/lib/frontend/components/overlays/SettingsPanel.svelte
git commit -m "feat(frontend): Agents & Models visibility tab in settings panel"
```

---

### Task 7: Full verification

**Step 1: Standard gate**

```bash
bash -o pipefail -c 'pnpm check 2>&1 | tail -c 500'
bash -o pipefail -c 'pnpm lint 2>&1 | tail -c 1000'
bash -o pipefail -c 'pnpm test:unit 2>&1 | tail -c 2000'
```

Expected: all green. **Caveat:** the tree may hold unrelated in-flight changes from other sessions; if failures are exclusively in files this plan never touched, report them as pre-existing and do not fix or stash them.

**Step 2: Visual acceptance gate** (required — this touches input-area dropdown code):

```bash
bash -o pipefail -c 'pnpm acceptance:visual 2>&1 | tail -c 2000'
```

Expected: green against existing baselines — with nothing hidden the dropdowns render identically, so **no baseline recapture should be needed**. If a visual diff appears in composer/dropdown scenarios, that is a regression in Task 5's short-circuit path — fix it; do not recapture baselines.

**Step 3: Commit anything outstanding, then summarize** — files touched, tests run, and the manual click-through result from Task 6.

---

## Regression surface (why this won't break related functionality)

- `relay-settings.ts`: only additive fields; full existing test file re-run in Task 1 guards `defaultModel`/`defaultVariants` merge behavior.
- RPC handler table (`server/ws-rpc.ts`): existing `ws-rpc-default-model` / `ws-rpc-model-switch` tests re-run in Task 3.
- Dropdowns: new getters wrap (not modify) `getProviderGroups`/`discoveryState.agents`, short-circuit when nothing is hidden, and Task 7's visual acceptance run proves the default rendering is unchanged.
- Schemas: `hiddenModels`/`hiddenAgents` response fields and the push message are optional/additive — old clients/messages remain valid; `pnpm check` enforces union exhaustiveness.
