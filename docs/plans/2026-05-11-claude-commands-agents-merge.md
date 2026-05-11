# Claude Commands + Agents Merge Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Surface Claude's SDK-sourced commands (slash_commands + skills) and subagents in conduit's existing UI dropdowns, unioned with OpenCode's lists. Each entry is tagged with `providerId` so the dropdown can render a small provider icon (or group entries into provider sections).

**Architecture:** Extends the probe from PR 1 (`2026-05-11-claude-capabilities-probe.md`) to also surface `commands` and `agents` from `initializationResult()`. `ClaudeAdapter.discover()` already returns a `commands` field built from filesystem scanning of `~/.claude/commands`, `~/.claude/skills`, etc.; this PR adds SDK-sourced commands+skills (claude-relay's `mergeSkills` pattern) and a new SDK-sourced `agents` array. The wire-shape `CommandInfo` and `AgentInfo` types gain an optional `providerId` field. The backend `handleGetCommands` and `handleGetAgents` handlers dispatch the Claude probe in parallel with OpenCode's existing REST calls and union the results, tagging each entry by source. The frontend dropdowns render a provider icon (small badge) next to each entry.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`SlashCommand`, `AgentInfo` types), Svelte 5, Vitest.

**Depends on:** `2026-05-11-claude-capabilities-probe.md` (PR 1). PR 2 is independent (can land before or after this PR).

---

## What competitors do

| Repo | Commands | Agents |
|---|---|---|
| **claude-relay** | Yes — `discoverSkillDirs()` walks `~/.claude/skills` + `<cwd>/.claude/skills`, `mergeSkills(sdkSkills, fsSkills)` unions them; `slash_commands.concat(skillNames)` sent to UI | **NO discovery** — does not read `init.agents` or call `supportedAgents()` |
| **t3code** | Only 3 hardcoded composer slash commands (`model`, `plan`, `default`); no SDK command discovery | **NO discovery** — does not read `init.agents` either |
| **conduit (today)** | `ClaudeAdapter.discover()` builds a list from filesystem (`~/.claude/commands`, `~/.claude/skills`, project equivalents) — but `handleGetCommands` never calls Claude's `discover()`; only `client.app.commands()` for OpenCode runs, so Claude commands never reach the UI | `discoveryState.agents` is populated only from `client.app.agents()` (OpenCode); no Claude path exists despite the SDK exposing `init.agents` |

**Implication for this plan:**
- **Commands:** copy claude-relay's union pattern (SDK + filesystem) into `ClaudeAdapter.discover()`, then make `handleGetCommands` union OpenCode and Claude results.
- **Agents:** greenfield — neither competitor surfaces SDK agents. Conduit already has the agent-list UI infrastructure (`AgentSelector.svelte`, `handleSwitchAgent`, session-override storage). This PR plugs in the Claude agent source.

## UI decisions (locked-in)

- **Union, not provider-scoped.** Show OpenCode and Claude entries together in each dropdown. The user shouldn't have to switch providers to see the full list.
- **Provider icon on each entry.** A tiny colored badge or icon (e.g. anthropic logo for Claude, opencode logo for OpenCode) next to the name. Section headers (grouping by provider) are equally acceptable and may be simpler to implement — pick whichever fits the existing dropdown style best when implementing Task 6.
- **Same UX for commands, skills, and agents.** Consistent treatment across all three dropdowns.

## Required type extensions (wire shapes)

In `src/lib/shared-types.ts`, both `CommandInfo` and `AgentInfo` gain an optional `providerId` field:

```typescript
export interface CommandInfo {
	name: string;
	description?: string;
	args?: string;
	providerId?: string; // ← new
}

export interface AgentInfo {
	id: string;
	name: string;
	description?: string;
	providerId?: string; // ← new
}
```

Field is optional for backward compat with older daemon emitters; handlers in this PR always populate it.

## Required AdapterCapabilities extension

`src/lib/provider/types.ts`'s `AdapterCapabilities` needs an `agents` field so adapters can surface their agent list through the existing `discover()` pathway:

```typescript
export interface AdapterCapabilities {
	readonly models: readonly ModelInfo[];
	readonly supportsTools: boolean;
	readonly supportsThinking: boolean;
	readonly supportsPermissions: boolean;
	readonly supportsQuestions: boolean;
	readonly supportsAttachments: boolean;
	readonly supportsFork: boolean;
	readonly supportsRevert: boolean;
	readonly commands: readonly CommandInfo[];
	readonly agents?: readonly AgentInfo[]; // ← new
}
```

`AgentInfo` here refers to the adapter-internal shape — for simplicity, reuse `shared-types.ts`'s `AgentInfo` (it already has the right fields). Add an export-from re-export if the import graph requires it.

---

## Tasks

### Task 1: Extend `ProbeResult` with SDK-sourced commands + agents

**Files:**
- Modify: `src/lib/provider/claude/claude-capabilities-probe.ts` (from PR 1)
- Modify: tests in `test/unit/provider/claude/claude-capabilities-probe.test.ts`

**Step 1: Write the failing tests**

Add inside the existing `describe`:

```typescript
it("captures slash_commands from init", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [],
			commands: [
				{ name: "init", description: "Init claude" },
				{ name: "compact", description: "Compact context" },
			],
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.commands).toEqual([
		{ name: "init", description: "Init claude", providerId: "claude" },
		{ name: "compact", description: "Compact context", providerId: "claude" },
	]);
});

it("captures agents from init", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [],
			agents: [
				{ name: "code-reviewer", description: "Reviews code", model: "opus" },
				{ name: "test-runner", description: "Runs tests" },
			],
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.agents).toEqual([
		{
			id: "code-reviewer",
			name: "code-reviewer",
			description: "Reviews code",
			providerId: "claude",
		},
		{
			id: "test-runner",
			name: "test-runner",
			description: "Runs tests",
			providerId: "claude",
		},
	]);
});

it("returns empty arrays when init omits commands/agents", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({ models: [] }),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.commands ?? []).toEqual([]);
	expect(result.agents ?? []).toEqual([]);
});
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: FAIL on the new tests.

**Step 2: Implement**

Update `ProbeResult` in `claude-capabilities-probe.ts`:

```typescript
import type {
	AgentInfo,
	CommandInfo,
} from "../../shared-types.js";
import type { ContextWindowOption, ModelInfo } from "../types.js";

export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
	readonly subscriptionType?: string; // added by PR 2 if it lands first
	readonly commands: ReadonlyArray<CommandInfo>;
	readonly agents: ReadonlyArray<AgentInfo>;
}
```

In the probe function, after reading `init`, map:

```typescript
const commands: CommandInfo[] = (init.commands ?? []).map((c) => ({
	name: c.name,
	...(c.description ? { description: c.description } : {}),
	providerId: "claude",
}));

const agents: AgentInfo[] = (init.agents ?? []).map((a) => ({
	id: a.name, // SDK uses `name` as the identifier; mirror it to conduit's `id`
	name: a.name,
	...(a.description ? { description: a.description } : {}),
	providerId: "claude",
}));

return {
	models,
	...(subscriptionType ? { subscriptionType } : {}),
	commands,
	agents,
};
```

**Step 3: Run tests**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/provider/claude/claude-capabilities-probe.ts test/unit/provider/claude/claude-capabilities-probe.test.ts
git commit -m "feat(claude): surface SDK commands + agents from capability probe"
```

---

### Task 2: Add `providerId` to wire-shape `CommandInfo` and `AgentInfo`

**Files:**
- Modify: `src/lib/shared-types.ts` (around lines 94-98 for `AgentInfo`, 116-120 for `CommandInfo`)
- Verify: the Effect Schema at `shared-types.ts:406` (`CommandInfoSchema`) gets the same field

**Step 1: Add the optional fields**

Apply the patch shown in the **Required type extensions** section at the top of this plan.

**Step 2: Update `CommandInfoSchema`**

Locate it (around line 406) and add `providerId: Schema.optional(Schema.String)` to the struct. Run `pnpm check` to verify the Effect Schema compiles.

**Step 3: Search for explicit shape assertions in tests**

```bash
grep -rn "type: \"command_list\"\|type: \"agent_list\"" src/ test/
```

For each match in a test, check if the test pins the exact shape (e.g. `toEqual([{ name: "x", description: "y" }])`). If so, the test passes today because `providerId` is optional and absent — no change needed unless the test would now have stale expectations.

**Step 4: Typecheck**

```bash
pnpm check
```

Expected: clean.

**Step 5: Commit**

```bash
git add src/lib/shared-types.ts
git commit -m "feat(shared): add optional providerId on CommandInfo and AgentInfo"
```

---

### Task 3: Extend `AdapterCapabilities` with `agents`

**Files:**
- Modify: `src/lib/provider/types.ts` (around line 157-167)
- Modify: `src/lib/provider/opencode-adapter.ts` (existing `discover()` to also include agents)
- Modify: `src/lib/provider/orchestration-engine.ts:254-266` (handler signature already returns `AdapterCapabilities` — no change)

**Step 1: Extend `AdapterCapabilities`**

```typescript
export interface AdapterCapabilities {
	readonly models: readonly ModelInfo[];
	// ... existing fields ...
	readonly commands: readonly CommandInfo[];
	readonly agents?: readonly AgentInfo[];
}
```

Add `AgentInfo` to the type imports if not already present.

**Step 2: Populate `agents` in `OpenCodeAdapter.discover()`**

Find the `discover()` method in `opencode-adapter.ts` (around line 30-90 based on file structure). Add an `agents` field to the returned `AdapterCapabilities`, mapping `client.app.agents()` results to conduit's `AgentInfo` shape (this mirrors the existing logic in `handleGetAgents` — refactor it out to the adapter so the handler doesn't have to call the same endpoint twice).

```typescript
const rawAgents = yield* Effect.tryPromise(() => client.app.agents());
const agents: AgentInfo[] = rawAgents
	.filter((a) => /* same filter as filterAgents() in handlers/agent.ts */)
	.map((a) => ({
		id: a.id,
		name: a.name ?? a.id,
		...(a.description ? { description: a.description } : {}),
		providerId: "opencode",
	}));

return {
	models,
	supportsTools: true,
	// ...
	commands,
	agents,
};
```

If the existing `filterAgents` helper lives only in `src/lib/handlers/agent.ts`, move it (or export it) so both call sites use the same logic. Add a quick test in `test/unit/provider/opencode-adapter.test.ts` (or create a small fixture file) that confirms agents propagate through `discover()`.

**Step 3: Populate `agents` in `ClaudeAdapter.discover()`**

In `src/lib/provider/claude/claude-adapter.ts`, locate the existing `discover()` method (rewritten by PR 1). Add agents from the cached probe:

```typescript
let agents: ReadonlyArray<AgentInfo> = [];
try {
	const probe = await getCachedClaudeCapabilities();
	models = probe.models.length > 0 ? probe.models : FALLBACK_MODELS;
	agents = probe.agents;
} catch (err) {
	// ... existing fallback handling ...
}

return {
	models,
	// ... existing fields ...
	commands,
	agents,
};
```

**Step 4: Test**

Add to `test/unit/provider/claude/claude-adapter-discover.test.ts`:

```typescript
it("forwards probe agents through discover()", async () => {
	const { __setProbeOverrideForTesting, resetCapabilityCacheForTesting } =
		await import(
			"../../../../src/lib/provider/claude/claude-capabilities-probe.js"
		);
	resetCapabilityCacheForTesting();
	__setProbeOverrideForTesting(async () => ({
		models: [],
		commands: [],
		agents: [
			{
				id: "Explore",
				name: "Explore",
				description: "Codebase explorer",
				providerId: "claude" as const,
			},
		],
	}));
	try {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		expect(caps.agents).toHaveLength(1);
		expect(caps.agents?.[0]?.id).toBe("Explore");
	} finally {
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	}
});
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/provider/types.ts src/lib/provider/opencode-adapter.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider/
git commit -m "feat(adapters): surface agents through AdapterCapabilities for both providers"
```

---

### Task 4: Union SDK-sourced commands into `ClaudeAdapter.discover()`

**Files:**
- Modify: `src/lib/provider/claude/claude-adapter.ts:253-280` (the `discover()` body — already rewritten in PR 1)

The probe now returns `commands` from `init.commands` (Task 1). Today's `ClaudeAdapter.discover()` builds commands from the filesystem only (BUILTIN_COMMANDS + `enumerateCommands` + `enumerateSkills`). We union the two sources using claude-relay's mergeSkills pattern.

**Step 1: Write the failing test**

Add to `test/unit/provider/claude/claude-adapter-discover.test.ts`:

```typescript
it("unions SDK-sourced commands with filesystem commands, dedup by name", async () => {
	const { __setProbeOverrideForTesting, resetCapabilityCacheForTesting } =
		await import(
			"../../../../src/lib/provider/claude/claude-capabilities-probe.js"
		);
	resetCapabilityCacheForTesting();
	__setProbeOverrideForTesting(async () => ({
		models: [],
		agents: [],
		commands: [
			{ name: "init", description: "SDK init", providerId: "claude" as const },
			{ name: "new-command", description: "from SDK", providerId: "claude" as const },
		],
	}));
	try {
		// `workspace` (from outer setup) has a project command `my-cmd`.
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const names = caps.commands.map((c) => c.name);
		// FS commands present: my-cmd, my-skill, builtins
		expect(names).toContain("my-cmd");
		expect(names).toContain("my-skill");
		// SDK commands present
		expect(names).toContain("new-command");
		// Deduplication: "init" exists as BUILTIN and now also from SDK — should appear once
		expect(names.filter((n) => n === "init")).toHaveLength(1);
	} finally {
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	}
});
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
```

Expected: FAIL (SDK commands not yet unioned).

**Step 2: Implement the union**

In `claude-adapter.ts`, modify `discover()` to merge the probe's commands with the filesystem list. Dedup by `name`. Filesystem wins on conflict (keeps the existing description if both exist):

```typescript
async discover(): Promise<AdapterCapabilities> {
	const userBase = join(homedir(), ".claude");
	const projectBase = join(this.deps.workspaceRoot, ".claude");

	const fsCommands: CommandInfo[] = [
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

	let models: ReadonlyArray<ModelInfo>;
	let sdkCommands: ReadonlyArray<CommandInfo> = [];
	let agents: ReadonlyArray<AgentInfo> = [];
	try {
		const probe = await getCachedClaudeCapabilities();
		models = probe.models.length > 0 ? probe.models : FALLBACK_MODELS;
		sdkCommands = probe.commands;
		agents = probe.agents;
	} catch (err) {
		log.warn(`Capability probe failed; using fallback: ${err instanceof Error ? err.message : err}`);
		models = FALLBACK_MODELS;
	}

	// Dedup by name; filesystem entries (which carry the `source` distinction)
	// win when both sources name the same command.
	const seen = new Set(fsCommands.map((c) => c.name));
	const commands: CommandInfo[] = [
		...fsCommands,
		...sdkCommands.filter((c) => !seen.has(c.name)),
	];

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
		agents,
	};
}
```

> **Note on `source`:** the adapter-internal `CommandInfo` (in `src/lib/provider/types.ts:149`) has a required `source: CommandSource` field. SDK-derived commands don't have a meaningful source value in that enum. Either: (a) add a new `"claude-sdk"` member to `CommandSource`, or (b) tag SDK commands with `source: "builtin"` for backward-compat. Option (a) is cleaner — make that change in this task and add `"claude-sdk"` to the `CommandSource` union in `src/lib/provider/types.ts`.

**Step 3: Update the probe's command mapper to set `source: "claude-sdk"`**

Back in `claude-capabilities-probe.ts` (Task 1's mapper):

```typescript
const commands: CommandInfo[] = (init.commands ?? []).map((c) => ({
	name: c.name,
	...(c.description ? { description: c.description } : {}),
	source: "claude-sdk" as const,
	providerId: "claude",
}));
```

The adapter-internal `CommandInfo` has `source`; the wire-shape `CommandInfo` does not. Map adapter→wire in the handler.

**Step 4: Run tests**

```bash
pnpm test:unit -- test/unit/provider/claude/
```

Expected: PASS (new tests + all previous).

**Step 5: Commit**

```bash
git add src/lib/provider/types.ts src/lib/provider/claude/claude-adapter.ts src/lib/provider/claude/claude-capabilities-probe.ts test/unit/provider/claude/
git commit -m "feat(claude): union SDK and filesystem commands in discover()"
```

---

### Task 5: Union commands across providers in `handleGetCommands`

**Files:**
- Modify: `src/lib/handlers/settings.ts:18-28` (the existing `handleGetCommands`)
- Test: create or modify a relevant handler test

The current handler emits OpenCode commands only:

```typescript
const commands = yield* Effect.tryPromise(() => client.app.commands());
wsHandler.sendTo(clientId, { type: "command_list", commands });
```

Replace with a unioned list. Each entry carries `providerId` so the frontend can tag.

**Step 1: Write the failing test**

`test/unit/handlers/get-commands-merged.test.ts`:

```typescript
it("emits unioned commands from OpenCode and Claude, each tagged with providerId", async () => {
	// Mock OpenCode app.commands() to return one OpenCode command.
	// Mock orchestration engine to return Claude caps with one Claude command.
	// ...invoke handleGetCommands via existing harness...

	const msg = /* captured sendTo */;
	expect(msg.type).toBe("command_list");
	const oc = msg.commands.find((c) => c.providerId === "opencode");
	const cl = msg.commands.find((c) => c.providerId === "claude");
	expect(oc).toBeDefined();
	expect(cl).toBeDefined();
});

it("falls back to OpenCode-only when Claude orchestration engine is absent", async () => {
	// No engine available.
	// ...invoke handleGetCommands...
	const msg = /* captured sendTo */;
	expect(msg.commands.every((c) => c.providerId === "opencode")).toBe(true);
});
```

Run:

```bash
pnpm test:unit -- test/unit/handlers/get-commands-merged.test.ts
```

Expected: FAIL.

**Step 2: Update the handler**

```typescript
export const handleGetCommands = (
	clientId: string,
	_payload: PayloadMap["get_commands"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		// OpenCode commands (existing behaviour, now tagged).
		const ocRaw = yield* Effect.tryPromise(() => client.app.commands());
		const opencodeCommands: CommandInfo[] = ocRaw.map((c) => ({
			name: c.name,
			...(c.description ? { description: c.description } : {}),
			...(c.args ? { args: c.args } : {}),
			providerId: "opencode",
		}));

		// Claude commands (best-effort).
		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		let claudeCommands: CommandInfo[] = [];
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
				claudeCommands = capsResult.right.commands
					// `commands` here is adapter-internal CommandInfo (has `source`);
					// strip the internal field for the wire shape.
					.map((c) => ({
						name: c.name,
						...(c.description ? { description: c.description } : {}),
						providerId: "claude",
					}));
			} else {
				log.warn(
					`Claude command discovery failed: ${capsResult.left instanceof Error ? capsResult.left.message : capsResult.left}`,
				);
			}
		}

		const commands: CommandInfo[] = [
			...opencodeCommands,
			...claudeCommands,
		];

		wsHandler.sendTo(clientId, { type: "command_list", commands });
	});
```

**Step 3: Run tests**

```bash
pnpm test:unit -- test/unit/handlers/get-commands-merged.test.ts
pnpm test:unit -- test/unit/handlers
```

Expected: PASS (new + existing).

**Step 4: Commit**

```bash
git add src/lib/handlers/settings.ts test/unit/handlers/get-commands-merged.test.ts
git commit -m "feat(handlers): union OpenCode and Claude commands in get_commands"
```

---

### Task 6: Union agents across providers in `handleGetAgents`

**Files:**
- Modify: `src/lib/handlers/agent.ts:58-69` (existing `handleGetAgents`)
- Modify: `src/lib/bridges/client-init.ts` (mirrors agent fetch for initial payload — search for `app.agents` or `agents:` to locate)
- Test: `test/unit/handlers/get-agents-merged.test.ts`

The existing handler:

```typescript
const rawAgents = yield* Effect.tryPromise(() => client.app.agents());
const agents = filterAgents(rawAgents);
wsHandler.sendTo(clientId, { type: "agent_list", agents });
```

Replace with a union (mirroring Task 5's structure):

**Step 1: Write the failing test**

`test/unit/handlers/get-agents-merged.test.ts`:

```typescript
it("emits unioned agents from OpenCode and Claude, each tagged with providerId", async () => {
	// Mock OpenCode app.agents().
	// Mock orchestration engine to return Claude caps with agents.
	// ...invoke handleGetAgents...

	const msg = /* captured sendTo */;
	expect(msg.type).toBe("agent_list");
	const oc = msg.agents.find((a) => a.providerId === "opencode");
	const cl = msg.agents.find((a) => a.providerId === "claude");
	expect(oc).toBeDefined();
	expect(cl).toBeDefined();
});
```

Run, confirm FAIL.

**Step 2: Update the handler**

```typescript
export const handleGetAgents = (
	clientId: string,
	_payload: PayloadMap["get_agents"],
) =>
	Effect.gen(function* () {
		const client = yield* OpenCodeAPITag;
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;

		const ocRaw = yield* Effect.tryPromise(() => client.app.agents());
		const opencodeAgents: AgentInfo[] = filterAgents(ocRaw).map((a) => ({
			...a,
			providerId: "opencode",
		}));

		const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
		let claudeAgents: AgentInfo[] = [];
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
				claudeAgents = (capsResult.right.agents ?? []).map((a) => ({
					...a,
					providerId: "claude",
				}));
			} else {
				log.warn(
					`Claude agent discovery failed: ${capsResult.left instanceof Error ? capsResult.left.message : capsResult.left}`,
				);
			}
		}

		const agents: AgentInfo[] = [...opencodeAgents, ...claudeAgents];
		wsHandler.sendTo(clientId, { type: "agent_list", agents });
	});
```

**Step 3: Update `client-init.ts`'s initial agent payload**

Search for the agent fetch in `bridges/client-init.ts` and apply the same union (parallel to the model_list block). Use the orchestration engine when available; fall back to OpenCode-only otherwise.

**Step 4: Run tests**

```bash
pnpm test:unit -- test/unit/handlers/get-agents-merged.test.ts
pnpm test:unit -- test/unit/handlers test/unit/bridges
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/handlers/agent.ts src/lib/bridges/client-init.ts test/unit/handlers/get-agents-merged.test.ts
git commit -m "feat(handlers): union OpenCode and Claude agents in get_agents"
```

---

### Task 7: Frontend — render provider icon on each entry

**Files:**
- Modify: `src/lib/frontend/components/model/AgentSelector.svelte`
- Modify: command dropdown component (locate via `grep -rn "discoveryState.commands" src/lib/frontend`) — likely a composer command palette
- Modify: any skill picker if separate
- Create or modify: small icon component (e.g. `src/lib/frontend/components/shared/ProviderIcon.svelte`) that renders a tiny badge for `"opencode"` vs `"claude"`

**Step 1: Create `ProviderIcon.svelte`**

```svelte
<!-- src/lib/frontend/components/shared/ProviderIcon.svelte -->
<script lang="ts">
	let { providerId, size = 12 }: { providerId?: string; size?: number } = $props();
</script>

{#if providerId === "claude"}
	<!-- Anthropic / Claude badge -->
	<span
		class="inline-flex items-center justify-center rounded-sm bg-[#d97757] text-white text-[8px] font-bold leading-none"
		style="width: {size}px; height: {size}px;"
		title="Claude"
	>
		C
	</span>
{:else if providerId === "opencode"}
	<!-- OpenCode badge -->
	<span
		class="inline-flex items-center justify-center rounded-sm bg-text-muted text-bg text-[8px] font-bold leading-none"
		style="width: {size}px; height: {size}px;"
		title="OpenCode"
	>
		O
	</span>
{/if}
```

(Replace placeholder colors with whatever fits conduit's theme tokens; raid `tailwind.config` for canonical brand colors. The exact glyph is a placeholder — use real logos if available, otherwise the letter approach is acceptable for an MVP.)

**Step 2: Render the badge in `AgentSelector.svelte`**

Locate the existing agent button rendering loop. Add `<ProviderIcon providerId={agent.providerId} />` before or after the agent name. Make sure the layout flexes correctly.

**Step 3: Render the badge in the command dropdown**

Find the component that renders `discoveryState.commands` — likely a slash-command palette in the composer area. Apply the same `<ProviderIcon>` treatment.

**Step 4: Storybook coverage**

Update `AgentSelector.stories.ts` (already exists) to include scenarios with `providerId: "opencode"`, `providerId: "claude"`, and a mix. Same for any command-palette stories.

**Step 5: Manual smoke check**

Start the dev server. Open conduit. Confirm:
- Agent dropdown shows both Claude and OpenCode entries with appropriate icons.
- Command dropdown / palette shows the unioned list with icons.
- Order: OpenCode first, Claude second (or whatever order the handlers emit — both Task 5 and Task 6 emit OpenCode first; sort can be tweaked but is consistent).

**Step 6: Commit**

```bash
git add src/lib/frontend
git commit -m "feat(frontend): show provider icon on agent/command entries"
```

---

### Task 8: Regression + verification gate

**Step 1: Full check / lint / unit / e2e**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Expected: clean (modulo the pre-existing EADDRINUSE flake).

**Step 2: Manual regression checks**

- Pick a Claude project, open the command palette / agent dropdown: confirm Claude entries appear with the Claude icon.
- Pick an OpenCode project, same: confirm OpenCode entries appear with the OpenCode icon.
- Switch projects mid-session: confirm both lists refresh appropriately and icons reflect the source.
- Click a Claude agent to activate it: confirm `switch_agent` still works (no regression — the agent's id is unchanged, only the metadata grew).

**Step 3: Final commit (if anything trailed)**

```bash
git add -A
git commit -m "chore: lint/format cleanup after commands/agents merge"
```

---

## Out of scope (do NOT include in this PR)

- **Section-header grouping** in the dropdowns (e.g. "OpenCode" header above OpenCode entries). The icon-per-entry approach was chosen as the simpler MVP. Sections can be added later if the dropdown gets crowded.
- **Switching the agent's underlying provider when activated.** Today, `switch_agent` only stores the agentId — it doesn't route the next turn through a particular provider. Cross-provider agent execution is a separate (and probably bigger) project.
- **Subagent invocation from chat** (i.e. `Task` tool usage). The SDK's `supportedAgents()` returns the same data as `init.agents`; this PR only surfaces them in the picker. Whether Claude internally hands off to a subagent during a turn is governed by the SDK, not conduit.
- **MCP server status** — `mcpServerStatus()` from the SDK could be surfaced similarly. Not in this PR.
- **Output styles** (`init.output_style`, `init.available_output_styles`). Similar pattern, separate scope.

## Risk register

| Risk | Mitigation |
|---|---|
| SDK's `init.commands` and conduit's filesystem-scanned commands overlap | Dedup-by-name in `discover()` (Task 4). Filesystem wins on conflict. Acceptable behaviour because filesystem entries are user-authored and SDK builtins are generic — user intent takes precedence. |
| SDK's `init.agents` returns subagents Anthropic ships internally (e.g. `Explore`) that conduit's `filterAgents` logic in OpenCode would have hidden | The Claude path bypasses `filterAgents` because it has different semantics. Result: SDK agents Anthropic exposes are all shown. If this is too noisy, add a Claude-side filter list (e.g. hide `Task`, hide names containing certain prefixes) modeled on `HIDDEN_AGENT_NAMES` in `handlers/agent.ts`. Out of scope for the first cut. |
| `providerId` on `CommandInfo` / `AgentInfo` is optional, so older clients reading new daemons could miss the tag | Optional field — older frontends ignore it silently. Daemon ≥ this PR always populates it. No version skew failure. |
| Adapter-internal `CommandInfo.source` vs wire-shape `CommandInfo` (no `source`) mismatch | The handler explicitly maps adapter→wire and drops `source`. Test coverage in Task 5 asserts the shape. |
| Filesystem `enumerateSkills` already adds a `project-skill` source; SDK's `init.skills` field would double-count | claude-relay's `mergeSkills` dedups by name. Conduit's existing FS scan covers `.claude/skills/*/SKILL.md`. The SDK's `init.commands` is slash_commands (e.g. `/init`, `/compact`), NOT skills. So name collision between FS skills and SDK slash_commands is rare in practice but still possible — dedup-by-name in Task 4 handles it. |
| Synchronously dispatching `discover` on each `get_commands` / `get_agents` request blocks the handler | `discover()` reads the TTL cache from PR 1 — no probe spawn unless cache miss (max once per 5 min). Worst case: ~500ms wait once per 5 min window. Acceptable for a discovery request. |
| `AgentInfo.id` for Claude SDK agents maps from `init.agents[].name` | SDK `AgentInfo` has no separate id field. Names like `code-reviewer` are valid identifiers. Tested in Task 1. |
| User-defined Claude subagents (in `.claude/agents/`) are NOT covered by `init.agents` | The SDK is responsible for surfacing user-defined subagents via `init.agents` — if it doesn't, that's an SDK gap to file. Conduit can't fix it client-side without re-parsing `.claude/agents/`. Out of scope. |
