# Claude Commands + Active-Provider Agents Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Surface Claude SDK-sourced commands and agents in conduit's existing command and agent pickers, but only when Claude is the active provider for the current session. Keep OpenCode commands and agents visible only for OpenCode sessions. Do not union provider lists in the UI.

**Architecture:** Extends the probe from PR 1 (`2026-05-11-claude-capabilities-probe.md`) to also capture `init.commands` and `init.agents` from `initializationResult()`. `ClaudeAdapter.discover()` unions SDK commands with its existing filesystem-scanned Claude commands and exposes SDK agents. `handleGetCommands`, `handleGetAgents`, and `client-init.ts` choose the command/agent source from the active session's provider binding. The frontend keeps the existing command insertion and `switch_agent` behavior because the lists are already provider-scoped.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`SlashCommand`, `AgentInfo` from initialization result), Svelte 5, Vitest.

**Depends on:** `2026-05-11-claude-capabilities-probe.md` (PR 1). PR 2 is independent.

---

## Decisions

- **Active provider only.** If the active session is Claude, show Claude commands/agents. If the active session is OpenCode or unbound, show OpenCode commands/agents. This matches t3code's composer command behavior: provider commands come from the selected provider only, and selection inserts plain text.
- **Active model filtering for Claude agents.** SDK agents with no `model` field are shown for every Claude model. SDK agents with a `model` field are shown only when that value matches the active Claude model id or model family (`opus`, `sonnet`, `haiku`).
- **No `providerId` on wire shapes.** `CommandInfo` and `AgentInfo` do not need provider tags because the list is already scoped. Do not add provider icons or provider section headers in this PR.
- **Command selection inserts text only.** Selecting a Claude command inserts `/<name> ` into the composer. It does not switch provider context. The active provider is already Claude when Claude commands are visible.
- **`switch_agent` stays id-only.** Since only active-provider agents are visible, `switch_agent { agentId }` is unambiguous. Add stale-agent clearing when the active provider/model changes and the stored agent is no longer present in the active list.
- **Manual verification does not require named slugs.** Automated tests must cover Claude/OpenCode active-provider behavior with mocks. Manual smoke is optional and records whichever local project slugs are available at execution time.

## What competitors do

| Repo | Commands | Agents |
|---|---|---|
| **t3code** | Shows provider slash commands from `selectedProviderStatus?.slashCommands` only; selecting inserts `/${name} `. No provider switching. | Does not surface Claude SDK agents. OpenCode-style agent choice is a model option for the selected provider/model. |
| **claude-relay** | Unions SDK slash commands with filesystem skills/commands for Claude. | Does not surface `init.agents`. |
| **conduit today** | `ClaudeAdapter.discover()` scans Claude filesystem commands/skills, but `handleGetCommands` only calls OpenCode. | `handleGetAgents` and `client-init.ts` only call OpenCode `app.agents()`. |

---

## Tasks

### Task 1: Extend `ProbeResult` with SDK commands and agents

**Files:**
- Modify: `src/lib/provider/claude/claude-capabilities-probe.ts`
- Modify: `src/lib/provider/types.ts` if an adapter-internal Claude agent shape is needed
- Modify: `test/unit/provider/claude/claude-capabilities-probe.test.ts`

**Step 1: Add internal types**

Keep public WebSocket `CommandInfo` / `AgentInfo` unchanged. For adapter internals, add or reuse these shapes:

```typescript
export type CommandSource =
	| "builtin"
	| "user-command"
	| "project-command"
	| "user-skill"
	| "project-skill"
	| "claude-sdk";

export interface ProviderAgentInfo {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}
```

Then extend `ProbeResult`:

```typescript
export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
	readonly subscriptionType?: string; // added by PR 2 if it lands first
	readonly commands: ReadonlyArray<CommandInfo>; // adapter-internal, includes source
	readonly agents: ReadonlyArray<ProviderAgentInfo>;
}
```

**Step 2: Write failing probe tests**

Add tests that prove:

- `init.commands` maps to adapter commands with `source: "claude-sdk"`.
- SDK `argumentHint` maps to wire `args` later; if the adapter-internal command type does not have `args`, preserve it in a local field or test the final handler in Task 4.
- `init.agents` maps `name` to both `id` and `name`, preserves `description`, and preserves optional `model`.
- Missing `commands` / `agents` returns empty arrays.

Example:

```typescript
it("captures slash commands from init", async () => {
	const queryFactory = vi.fn().mockReturnValue({
		initializationResult: async () => ({
			models: [],
			commands: [
				{ name: "init", description: "Init Claude", argumentHint: "[path]" },
			],
		}),
	});
	const result = await probeClaudeCapabilities({ queryFactory });
	expect(result.commands).toEqual([
		{
			name: "init",
			description: "Init Claude",
			args: "[path]",
			source: "claude-sdk",
		},
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
			model: "opus",
		},
		{ id: "test-runner", name: "test-runner", description: "Runs tests" },
	]);
});
```

Run:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
```

Expected: FAIL.

**Step 3: Implement probe mapping**

Map SDK fields defensively:

```typescript
const commands: CommandInfo[] = (init.commands ?? []).map((c) => ({
	name: c.name,
	...(c.description ? { description: c.description } : {}),
	...(c.argumentHint ? { args: c.argumentHint } : {}),
	source: "claude-sdk",
}));

const agents: ProviderAgentInfo[] = (init.agents ?? []).map((a) => ({
	id: a.name,
	name: a.name,
	...(a.description ? { description: a.description } : {}),
	...(a.model ? { model: a.model } : {}),
}));
```

**Step 4: Verify and commit**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
git add src/lib/provider/claude/claude-capabilities-probe.ts src/lib/provider/types.ts test/unit/provider/claude/claude-capabilities-probe.test.ts
git commit -m "feat(claude): capture SDK commands and agents in probe"
```

---

### Task 2: Surface agents through adapter capabilities

**Files:**
- Modify: `src/lib/provider/types.ts`
- Modify: `src/lib/provider/claude/claude-adapter.ts`
- Modify: `test/unit/provider/claude/claude-adapter-discover.test.ts`

**Step 1: Extend `AdapterCapabilities`**

```typescript
export interface AdapterCapabilities {
	readonly models: readonly ModelInfo[];
	// existing fields...
	readonly commands: readonly CommandInfo[];
	readonly agents?: readonly ProviderAgentInfo[];
}
```

Do not modify `src/lib/shared-types.ts` for `providerId`; it is not needed.

**Step 2: Add Claude discover coverage**

Use the PR 1 probe test override to return a Claude agent and assert `ClaudeAdapter.discover()` includes it:

```typescript
it("returns SDK agents from Claude discover", async () => {
	resetCapabilityCacheForTesting();
	__setProbeOverrideForTesting(async () => ({
		models: [],
		commands: [],
		agents: [{ id: "Explore", name: "Explore", description: "Codebase explorer" }],
	}));
	try {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		expect(caps.agents).toEqual([
			{ id: "Explore", name: "Explore", description: "Codebase explorer" },
		]);
	} finally {
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	}
});
```

Run and confirm FAIL:

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
```

**Step 3: Implement**

In `ClaudeAdapter.discover()`, read `probe.agents` and return them in `AdapterCapabilities`.

**Step 4: Verify and commit**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
git add src/lib/provider/types.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-discover.test.ts
git commit -m "feat(claude): expose SDK agents through discover"
```

---

### Task 3: Union SDK commands into ClaudeAdapter.discover()

**Files:**
- Modify: `src/lib/provider/claude/claude-adapter.ts`
- Modify: `src/lib/provider/types.ts` if `CommandSource` needs `"claude-sdk"`
- Modify: `test/unit/provider/claude/claude-adapter-discover.test.ts`

`ClaudeAdapter.discover()` already returns filesystem commands from builtins, `~/.claude/commands`, project `.claude/commands`, and skills. Add SDK commands from the probe. Deduplicate by `name`, with filesystem commands winning over SDK commands.

**Step 1: Write failing test**

```typescript
it("unions SDK-sourced commands with filesystem commands, deduping by name", async () => {
	resetCapabilityCacheForTesting();
	__setProbeOverrideForTesting(async () => ({
		models: [],
		agents: [],
		commands: [
			{ name: "init", description: "SDK init", source: "claude-sdk" },
			{ name: "new-command", description: "from SDK", source: "claude-sdk" },
		],
	}));
	try {
		const adapter = new ClaudeAdapter({ workspaceRoot: workspace });
		const caps = await adapter.discover();
		const names = caps.commands.map((c) => c.name);
		expect(names).toContain("new-command");
		expect(names.filter((n) => n === "init")).toHaveLength(1);
	} finally {
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	}
});
```

**Step 2: Implement**

```typescript
const seen = new Set(fsCommands.map((c) => c.name));
const commands = [
	...fsCommands,
	...sdkCommands.filter((c) => !seen.has(c.name)),
];
```

**Step 3: Verify and commit**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
git add src/lib/provider/types.ts src/lib/provider/claude/claude-adapter.ts test/unit/provider/claude/claude-adapter-discover.test.ts
git commit -m "feat(claude): union SDK and filesystem commands"
```

---

### Task 4: Return active-provider commands from `handleGetCommands`

**Files:**
- Modify: `src/lib/handlers/settings.ts`
- Modify: `test/unit/handlers/get-commands-active-provider.test.ts`

The handler must not return a cross-provider union. It should inspect the client session and provider binding:

```typescript
const activeSessionId = wsHandler.getClientSession(clientId);
const engineOption = yield* Effect.serviceOption(OrchestrationEngineTag);
const activeProviderId =
	activeSessionId && engineOption._tag === "Some"
		? engineOption.value.getProviderForSession(activeSessionId)
		: undefined;
```

Behavior:

- `activeProviderId === "claude"`: dispatch `discover` for Claude, map adapter commands to wire commands (`name`, optional `description`, optional `args`), send only Claude commands.
- Otherwise: keep existing OpenCode `client.app.commands()` behavior.
- If Claude discovery fails: log warning and send `commands: []` for Claude, not OpenCode commands. Falling back to OpenCode while the active provider is Claude would make command selection lie.

**Step 1: Write failing tests**

Tests must cover:

- Claude-bound active session emits only Claude commands.
- OpenCode-bound active session emits only OpenCode commands.
- Unbound/no active session preserves existing OpenCode behavior.
- Claude discovery failure sends an empty list and logs warning.

**Step 2: Implement**

Use `Effect.serviceOption(OrchestrationEngineTag)` so tests without the orchestration layer still pass.

**Step 3: Verify and commit**

```bash
pnpm test:unit -- test/unit/handlers/get-commands-active-provider.test.ts
pnpm test:unit -- test/unit/handlers
git add src/lib/handlers/settings.ts test/unit/handlers/get-commands-active-provider.test.ts
git commit -m "feat(handlers): return active provider commands"
```

---

### Task 5: Return active-provider/model agents from `handleGetAgents`

**Files:**
- Modify: `src/lib/handlers/agent.ts`
- Modify: `src/lib/session/session-overrides.ts`
- Modify: `test/unit/handlers/get-agents-active-provider.test.ts`
- Modify: `test/unit/session/session-overrides.test.ts` if present

**Step 1: Add stale-agent clearing**

Add:

```typescript
clearAgent(sessionId: string): void {
	const state = this.sessions.get(sessionId);
	if (state) delete state.agent;
}
```

**Step 2: Add Claude model filter helper**

In `agent.ts` or a small provider helper:

```typescript
function claudeAgentMatchesModel(
	agent: ProviderAgentInfo,
	modelId: string | undefined,
): boolean {
	if (!agent.model) return true;
	if (!modelId) return true;
	const normalizedAgentModel = agent.model.toLowerCase();
	const normalizedModelId = modelId.toLowerCase();
	return (
		normalizedModelId === normalizedAgentModel ||
		normalizedModelId.includes(normalizedAgentModel)
	);
}
```

This handles SDK values like `"opus"` against model ids like `"claude-opus-4-7"`.

**Step 3: Write failing tests**

Tests must cover:

- Claude-bound active session emits only Claude agents.
- Claude agents with `model: "opus"` are hidden for active Sonnet model and shown for active Opus model.
- OpenCode-bound active session emits only filtered OpenCode agents.
- Unbound/no active session preserves existing OpenCode behavior.
- If the stored session agent is not in the active list, `clearAgent(activeSessionId)` is called and `activeAgentId` is omitted.

**Step 4: Implement handler**

Behavior:

- Determine active session id from `wsHandler.getClientSession(clientId)`.
- Determine active provider id from `OrchestrationEngineTag.getProviderForSession(activeSessionId)`.
- For Claude: dispatch `discover`, filter `caps.agents ?? []` by active model from `overrides.getModel(activeSessionId)?.modelID`, strip adapter-only `model`, and send `{ type: "agent_list", agents, activeAgentId }`.
- For OpenCode/unbound: keep existing `client.app.agents()` + `filterAgents(...)`.
- In both paths, clear stale active agent when it is not present in the emitted list.

**Step 5: Verify and commit**

```bash
pnpm test:unit -- test/unit/handlers/get-agents-active-provider.test.ts
pnpm test:unit -- test/unit/handlers test/unit/session
git add src/lib/handlers/agent.ts src/lib/session/session-overrides.ts test/unit/handlers/get-agents-active-provider.test.ts
git commit -m "feat(handlers): return active provider agents"
```

---

### Task 6: Mirror active-provider agents in client init

**Files:**
- Modify: `src/lib/bridges/client-init.ts`
- Modify: relevant `client-init` tests

The initial WebSocket payload currently sends OpenCode agents unconditionally. Replace that with the same active-provider logic from Task 5:

- Use `deps.orchestrationEngine?.getProviderForSession(activeId)`.
- If Claude: `deps.orchestrationEngine.dispatch({ type: "discover", providerId: "claude" })`, filter agents by active model override, clear stale agent if needed, send Claude-only list.
- Else: existing OpenCode path.

Prefer extracting a shared helper from Task 5 if it keeps handler and init behavior identical without coupling the bridge to Effect services.

**Verification:**

```bash
pnpm test:unit -- test/unit/bridges
git add src/lib/bridges/client-init.ts test/unit/bridges
git commit -m "feat(client-init): send active provider agents"
```

---

### Task 7: Frontend refresh behavior

**Files:**
- Modify only if needed after inspection:
  - `src/lib/frontend/components/layout/ChatLayout.svelte`
  - command palette component that consumes `discoveryState.commands`
  - `src/lib/frontend/components/model/AgentSelector.svelte`
  - frontend store tests

No provider icons or provider badges are required. The existing components should render whatever `command_list` and `agent_list` the backend sends.

Inspect frontend flow and add tests or wiring only if missing:

- On active session switch, request both `get_commands` and `get_agents`.
- On active model/provider change, request `get_agents` again so Claude model filtering updates.
- If `agent_list.activeAgentId` is absent after a refresh, clear local selected-agent display.
- Command selection remains plain text insertion; no provider switching.

Expected likely result: backend changes are enough for commands; agent refresh may need one extra `get_agents` call after model change.

**Verification:**

```bash
pnpm test:unit -- test/unit/frontend
git add src/lib/frontend
git commit -m "feat(frontend): refresh active provider commands and agents"
```

Skip the commit if no frontend changes are needed.

---

### Task 8: Regression + verification gate

**Step 1: Focused tests**

```bash
pnpm test:unit -- test/unit/provider/claude/claude-capabilities-probe.test.ts
pnpm test:unit -- test/unit/provider/claude/claude-adapter-discover.test.ts
pnpm test:unit -- test/unit/handlers/get-commands-active-provider.test.ts
pnpm test:unit -- test/unit/handlers/get-agents-active-provider.test.ts
pnpm test:unit -- test/unit/bridges
```

Expected: PASS.

**Step 2: Full project gate**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Expected: clean, except documented pre-existing infrastructure flakes if any.

**Step 3: Optional manual smoke**

Manual smoke is optional and must not require hardcoded slugs in the plan. If live projects are available locally, record the actual slugs used in the PR notes and check:

- Claude-bound session: command palette shows Claude commands only; agent selector shows Claude agents compatible with the active Claude model.
- OpenCode-bound session: command palette and agent selector show OpenCode entries only.
- Switching model in Claude refreshes the agent list when agent metadata has model constraints.
- Selecting a command only inserts text.
- Selecting an agent sends the existing id-only `switch_agent` payload.

**Step 4: Final commit if anything trailed**

```bash
git add src/lib/provider src/lib/handlers src/lib/session src/lib/bridges src/lib/frontend test/unit
git commit -m "chore: verify active provider commands and agents"
```

---

## Out of scope

- Cross-provider union lists.
- Provider icons, provider badges, or provider section headers.
- Switching provider context from command selection.
- Changing the `switch_agent` wire payload to include provider id.
- Subagent invocation internals during a Claude turn. This PR only exposes selectable agent metadata.
- MCP server status and output style discovery.

## Risk register

| Risk | Mitigation |
|---|---|
| Active Claude session falls back to OpenCode commands after Claude discovery failure | Do not fallback across providers. Send an empty Claude list and log warning. |
| Duplicate command names between SDK and filesystem commands | Deduplicate inside `ClaudeAdapter.discover()`, filesystem wins. |
| Duplicate agent names across providers | Not a problem because only one provider's list is shown. |
| Stored OpenCode agent remains after switching to Claude | Task 5 clears stale agent overrides when the active list does not contain the stored id. |
| SDK agent `model` value is a family name instead of full id | `claudeAgentMatchesModel(...)` supports both exact match and substring family match. |
| No active session/provider binding during early client init | Preserve current OpenCode behavior for unbound sessions. |
